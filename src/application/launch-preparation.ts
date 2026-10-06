import { inspectBundle, generateExecutionSummary } from "../bundle/bundle.js";
import type { Budgets } from "../bundle/bundle.js";
import type { Catalog, CatalogEntry } from "../catalog/catalog.js";
import type { AuthoredManifest, Platform } from "../workflow/workflow.js";
import type { ProcessAdapter } from "../process/process.js";
import { assessPreflight, bundleSnapshotCorrupt } from "./preflight.js";
import { selectPlatform } from "./select-platform.js";
import type { ApplicationHarnessRegistration } from "./harness-registry.js";
import type { ApplicationHarnessQualification } from "./harness-registry.js";
import { selectRunEntry } from "./run-projection.js";
import { originView } from "./bundle-catalog.js";
import {
  bundleBytesCorrupt,
  bundleBytesMissing,
  bundleTrustRequired,
  harnessQualificationUnavailable,
  trustDigestMismatch,
  workspaceNotApproved,
} from "./problems.js";
import { resolveModelChoice, type ModelChoiceSource } from "./model-choice.js";
import type { ModelChoice } from "../harness/harness.js";
import type { UpdateStream } from "./update-stream.js";
import { problemCodes, type ApplicationObserver } from "./observer.js";
import type {
  ActionOffer,
  ExecutionSummary,
  HarnessChoice,
  LaunchPreparationDraftView,
  LaunchPreparationSnapshot,
  LaunchRunInput,
  OpenedProjection,
  Problem,
} from "./projection-port.js";

// `launch-preparation` (#189): the read-only assessment of one complete launch
// draft. It reruns the ordered creation-free checks a launch runs today (through
// `evaluate`, the same evaluator `submitLaunch` refuses from, so both clients
// create Runs under identical rules) and, for an otherwise-ready Agent-bearing
// draft, additionally qualifies only the selected Harness through the process
// cache to resolve the Run's Model choice (ADR 0034): the draft's model and effort
// where named, else the preselection, checked against the Harness's declaration.
// The `launch-run` Offer carries that resolved choice, so both clients launch
// exactly what the assessment showed. It creates no Run, Session, Turn, Trust
// grant, or durable draft, and releases the prepared Harness immediately
// (composition's qualify path closes it). Changing any draft field opens a new
// Projection — the selector is the draft.

import type { SubscriptionLifecycle } from "./subscription-lifecycle.js";

import { engineProblem } from "./engine-range.js";

export interface LaunchPreparationDeps {
  readonly engineVersion: string;
  readonly subscriptions: Pick<SubscriptionLifecycle, "open">;
  readonly catalog: Catalog;
  readonly budgets: Budgets;
  readonly process: ProcessAdapter;
  readonly hostPlatform?: Platform;
  readonly supportsInteractiveTurns: boolean;
  readonly harnessRegistry: readonly ApplicationHarnessRegistration[];
  /** The canonical launch Workspace path (Application already canonicalised it). */
  readonly launchWorkspacePath: string;
  /** The process-scoped Harness qualification path the `harness-catalog` owns, so
   *  assessment and inspection share one cached result per semantic id. */
  readonly qualify: (
    id: string,
  ) => Promise<ApplicationHarnessQualification | undefined>;
  /** Reports the launch-preparation, Preflight, and model-check stages. */
  readonly observe: ApplicationObserver;
}

/** The resolved facts a passing (or partially passing) evaluation carries, so
 *  `submitLaunch` can create the Run without re-resolving them. Absent when the
 *  Bundle could not be resolved or its bytes are gone/corrupt. */
interface LaunchDraftResolution {
  readonly entry: CatalogEntry;
  readonly manifest: AuthoredManifest;
  readonly selectedHarness?: HarnessChoice["id"];
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
  /** Whether launching will record a new Trust grant (the digest was untrusted
   *  and the draft acknowledges it). */
  readonly needsGrant: boolean;
}

interface LaunchDraftEvaluation {
  /** Ordered findings in launch order; empty exactly when the draft is launchable
   *  (before the additional model qualification the assessment layers on). */
  readonly findings: readonly Problem[];
  readonly resolution?: LaunchDraftResolution;
}

export interface LaunchPreparation {
  /** The synchronous authoritative checks, shared with `submitLaunch`. */
  evaluate(input: LaunchRunInput): LaunchDraftEvaluation;
  /** Open the live assessment Projection over one draft. */
  open(draft: LaunchRunInput): OpenedProjection<LaunchPreparationSnapshot>;
}

export function createLaunchPreparation(
  deps: LaunchPreparationDeps,
): LaunchPreparation {
  // Both readers settle this one stage, so a launch and its assessment leave the
  // same records; the start is written before the synchronous Process probes.
  function evaluate(input: LaunchRunInput): LaunchDraftEvaluation {
    deps.observe({ kind: "launch-preparation-start" });
    const evaluation = evaluateDraft(input);
    deps.observe({
      kind: "launch-preparation-settle",
      codes: problemCodes(evaluation.findings),
    });
    return evaluation;
  }

  function evaluateDraft(input: LaunchRunInput): LaunchDraftEvaluation {
    const findings: Problem[] = [];
    const selected = selectRunEntry(
      deps.catalog,
      input.bundle.id,
      input.bundle.version,
    );
    if ("problem" in selected) return { findings: [selected.problem] };
    const entry = selected.entry;

    // Workspace approval is checked at a launch's start (before the bytes), so it
    // is collected first here to preserve the first-fail order `submitLaunch` reads.
    if (
      deps.catalog.getWorkspaceApproval(deps.launchWorkspacePath) === undefined
    ) {
      findings.push(workspaceNotApproved(deps.launchWorkspacePath));
    }

    const bytes = deps.catalog.readManagedBytes(entry.digest);
    if (bytes === undefined) {
      findings.push(bundleBytesMissing({ digest: entry.digest }));
      return { findings };
    }
    const inputRules =
      deps.harnessRegistry.find((entry) => entry.choice.id === input.harness)
        ?.inputRules ?? [];
    const inspected = inspectBundle(bytes, deps.budgets, inputRules, true);
    if (!inspected.ok) {
      findings.push(
        ("engineUnsupported" in inspected
          ? engineProblem(inspected.engineUnsupported, deps.engineVersion)
          : undefined) ??
          bundleBytesCorrupt({ digest: entry.digest }, inspected.finding.code),
      );
      return { findings };
    }
    const manifest = inspected.inspection.manifest;
    // A pinned Snapshot that no longer composes is corrupt, the same class as
    // missing/invalid bytes: a single hard-stop `bundle` finding, not a fault the
    // remaining checks accumulate atop (a corrupt routing cannot be assessed).
    if (
      inspected.inspection.composition.some(
        (finding) =>
          finding.severity === "error" &&
          finding.code !== "harness-input-reserved",
      )
    ) {
      findings.push(bundleSnapshotCorrupt(entry.digest));
      return { findings };
    }

    const pre = assessPreflight(
      {
        manifest,
        engine: inspected.inspection.engine,
        engineVersion: deps.engineVersion,
        composition: inspected.inspection.composition,
        workspacePath: deps.launchWorkspacePath,
        launchInputs: input.launchInputs,
        hostPlatform: deps.hostPlatform,
        digest: entry.digest,
        supportsInteractiveTurns: deps.supportsInteractiveTurns,
        harnessSelection: input.harness,
        requestedModel: input.requestedModel,
        requestedEffort: input.requestedEffort,
        harnessRegistry: deps.harnessRegistry,
      },
      deps.process,
      deps.observe,
    );
    findings.push(...pre.findings);
    // An unsupported engine cannot authorize this Bundle, so do not ask for Trust.
    if (pre.findings.some((finding) => finding.code === "engine-unsupported")) {
      return { findings };
    }

    // Trust mirrors `submitLaunch` exactly, minus the grant write: an untrusted
    // digest needs a matching acknowledgement; a missing one is `bundle-trust-
    // required`, a mismatching one `trust-digest-mismatch`.
    const grant = deps.catalog.getTrustGrant(
      entry.digest,
      entry.installationGeneration,
    );
    const needsGrant = grant === undefined;
    if (needsGrant) {
      if (input.trustDigest === undefined) {
        findings.push(
          bundleTrustRequired(manifest, entry.digest, deps.hostPlatform),
        );
      } else if (input.trustDigest !== entry.digest) {
        findings.push(trustDigestMismatch(entry.digest, input.trustDigest));
      }
    }

    return {
      findings,
      resolution: {
        entry,
        manifest,
        needsGrant,
        ...(pre.selectedHarness !== undefined
          ? { selectedHarness: pre.selectedHarness }
          : {}),
        ...(pre.requestedModel !== undefined
          ? { requestedModel: pre.requestedModel }
          : {}),
        ...(pre.requestedEffort !== undefined
          ? { requestedEffort: pre.requestedEffort }
          : {}),
      },
    };
  }

  function open(
    draft: LaunchRunInput,
  ): OpenedProjection<LaunchPreparationSnapshot> {
    const updates = deps.subscriptions.open<LaunchPreparationSnapshot>();
    const evaluation = evaluate(draft);
    const resolution = evaluation.resolution;
    const syncFindings = evaluation.findings;

    // Qualify only when the draft is otherwise ready and needs a Harness.
    // Qualification spawns the real Harness, so it never runs to add a Model-choice
    // finding to a draft already not-ready for other reasons — those findings are
    // printed at once and the choice is resolved once they are fixed.
    const harness =
      syncFindings.length === 0 ? resolution?.selectedHarness : undefined;
    if (harness === undefined || resolution === undefined) {
      const status = syncFindings.length > 0 ? "not-ready" : "ready";
      return settled(
        snapshot(status, syncFindings, resolution, draft, undefined),
        updates,
      );
    }

    // A qualification error must never read as ready: an unexpected throw becomes a
    // harness finding, the same not-ready outcome a `{ok:false}` result produces.
    void (async () => {
      deps.observe({ kind: "model-check-start", harness });
      let assessed: TModelAssessment;
      try {
        assessed = assessModelChoice(
          harness,
          resolution,
          await deps.qualify(harness),
        );
      } catch (error) {
        assessed = assessModelChoice(harness, resolution, {
          ok: false,
          failure: {
            phase: "prepare",
            category: "qualification-exception",
            possibleEffects: "none",
            diagnostics:
              error instanceof Error
                ? error.message
                : "Harness qualification failed unexpectedly.",
          },
        });
      }
      deps.observe({
        kind: "model-check-settle",
        harness,
        ...("problem" in assessed ? { code: assessed.problem.code } : {}),
      });
      updates.push({
        kind: "durable",
        snapshot:
          "problem" in assessed
            ? snapshot(
                "not-ready",
                [assessed.problem],
                resolution,
                draft,
                undefined,
              )
            : snapshot("ready", [], resolution, draft, assessed),
      });
    })();

    return settled(
      snapshot("assessing", syncFindings, resolution, draft, undefined),
      updates,
    );
  }

  function assessModelChoice(
    harnessId: HarnessChoice["id"],
    resolution: LaunchDraftResolution,
    qualification: ApplicationHarnessQualification | undefined,
  ): TModelAssessment {
    const choice = deps.harnessRegistry.find(
      (registration) => registration.choice.id === harnessId,
    )?.choice;
    // `evaluate` already validated the Harness against the registry, so neither
    // an unregistered id nor a missing qualification is reachable.
    if (choice === undefined || qualification === undefined) {
      throw new Error(
        `launch-preparation: Harness ${harnessId} is not registered.`,
      );
    }
    if (!qualification.ok) {
      return {
        problem: harnessQualificationUnavailable(choice, qualification.failure),
      };
    }
    const resolved = resolveModelChoice({
      catalog: deps.catalog,
      harness: choice,
      profile: qualification.profile,
      defaults: qualification.defaults,
      ...(resolution.requestedModel !== undefined
        ? { requestedModel: resolution.requestedModel }
        : {}),
      ...(resolution.requestedEffort !== undefined
        ? { requestedEffort: resolution.requestedEffort }
        : {}),
    });
    return resolved.ok
      ? {
          choice: resolved.choice,
          source: resolved.source,
          ...(resolved.preferenceNotice === undefined
            ? {}
            : { preferenceNotice: resolved.preferenceNotice }),
          ...(resolved.effortLock === undefined
            ? {}
            : { effortLock: resolved.effortLock }),
        }
      : { problem: resolved.problem };
  }

  function snapshot(
    status: LaunchPreparationSnapshot["status"],
    findings: readonly Problem[],
    resolution: LaunchDraftResolution | undefined,
    draft: LaunchRunInput,
    modelChoice: TResolvedModelChoice | undefined,
  ): LaunchPreparationSnapshot {
    const offers: ActionOffer[] =
      status === "ready" && resolution !== undefined
        ? [
            {
              action: "launch-run",
              draft: launchDraft(draft, modelChoice?.choice),
              trustRequired: resolution.needsGrant,
              consequence:
                "Create and start a Run for this draft; launch rechecks every requirement.",
            },
          ]
        : [];
    return {
      family: "launch-preparation",
      status,
      draft: draftView(draft, resolution, modelChoice),
      findings,
      ...(resolution !== undefined
        ? { executionSummary: executionSummaryFor(resolution) }
        : {}),
      actionOffers: offers,
    };
  }

  function executionSummaryFor(
    resolution: LaunchDraftResolution,
  ): ExecutionSummary {
    const { manifest, entry } = resolution;
    const platform = selectPlatform(
      manifest.platforms ?? [],
      deps.hostPlatform,
    );
    const core = generateExecutionSummary(manifest, entry.digest, platform);
    return { ...core, origin: originView(entry.origin) };
  }

  return { evaluate, open };
}

interface TResolvedModelChoice {
  readonly preferenceNotice?: string;
  readonly effortLock?: { readonly effort: string; readonly source: string };
  readonly choice: ModelChoice;
  readonly source: ModelChoiceSource;
}

type TModelAssessment = TResolvedModelChoice | { readonly problem: Problem };

/** The draft the `launch-run` Offer carries: the assessed draft with its resolved
 *  Model choice in place of whatever model and effort it named. */
function launchDraft(
  draft: LaunchRunInput,
  choice: ModelChoice | undefined,
): LaunchRunInput {
  if (choice === undefined) return draft;
  const { requestedModel: _model, requestedEffort: _effort, ...rest } = draft;
  return {
    ...rest,
    requestedModel: choice.model,
    ...(choice.effort !== undefined ? { requestedEffort: choice.effort } : {}),
  };
}

function draftView(
  draft: LaunchRunInput,
  resolution: LaunchDraftResolution | undefined,
  modelChoice: TResolvedModelChoice | undefined,
): LaunchPreparationDraftView {
  const bundle =
    resolution !== undefined
      ? {
          id: resolution.manifest.bundle.id,
          version: resolution.manifest.bundle.version,
          digest: resolution.entry.digest,
          name: resolution.manifest.bundle.name,
        }
      : {
          id: draft.bundle.id,
          ...(draft.bundle.version !== undefined
            ? { version: draft.bundle.version }
            : {}),
        };
  return {
    bundle,
    ...(draft.harness !== undefined ? { harness: draft.harness } : {}),
    ...(draft.requestedModel !== undefined
      ? { requestedModel: draft.requestedModel }
      : {}),
    ...(draft.requestedEffort !== undefined
      ? { requestedEffort: draft.requestedEffort }
      : {}),
    ...(modelChoice !== undefined
      ? {
          modelChoice: {
            model: modelChoice.choice.model,
            ...(modelChoice.choice.effort !== undefined
              ? { effort: modelChoice.choice.effort }
              : {}),
            source: modelChoice.source,
            ...(modelChoice.effortLock === undefined
              ? {}
              : { effortLock: { ...modelChoice.effortLock } }),
          },
        }
      : {}),
    ...(modelChoice?.preferenceNotice === undefined
      ? {}
      : { preferenceNotice: modelChoice.preferenceNotice }),
    launchInputs: draft.launchInputs,
    ...(draft.trustDigest !== undefined
      ? { trustDigest: draft.trustDigest }
      : {}),
  };
}

function settled(
  snapshot: LaunchPreparationSnapshot,
  updates: UpdateStream<LaunchPreparationSnapshot>,
): OpenedProjection<LaunchPreparationSnapshot> {
  return {
    snapshot,
    catchUp: "fresh",
    updates,
    close() {
      updates.close();
    },
  };
}
