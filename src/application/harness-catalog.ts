import type { Catalog } from "../catalog/catalog.js";
import type {
  HarnessDefaults,
  HarnessProfile,
  ModelDeclaration,
  ModelEntry,
} from "../harness/harness.js";
import type {
  ApplicationHarnessQualification,
  ApplicationHarnessRegistration,
} from "./harness-registry.js";
import {
  harnessDiagnosticMissing,
  harnessNotFound,
  harnessQualificationUnavailable,
} from "./problems.js";
import type {
  HarnessCapabilityView,
  HarnessCatalogSnapshot,
  HarnessDiscoveryView,
  HarnessFocus,
  HarnessDiagnosticReference,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
  HarnessQualificationView,
  HarnessSummary,
  HarnessDefaultsView,
  ModelEntryView,
  OpenedProjection,
  Problem,
  ResourceRead,
} from "./projection-port.js";
import type { UpdateStream } from "./update-stream.js";
import type { ApplicationEvent, ApplicationObserver } from "./observer.js";

import { preselectModelChoice } from "./model-choice.js";
import type { SubscriptionLifecycle } from "./subscription-lifecycle.js";

interface HeldQualification {
  readonly checkedAt: string;
  readonly result: ApplicationHarnessQualification;
}

export interface HarnessCatalog {
  openList(): OpenedProjection<HarnessCatalogSnapshot>;
  openFocus(
    selection: HarnessFocusSelector,
  ): OpenedProjection<HarnessFocusSnapshot>;
  readDiagnostic(reference: HarnessDiagnosticReference): ResourceRead;
  /** Qualify one registered Harness through the process cache (#189): the same
   *  bounded qualify path a focus uses (prepare then immediate close in
   *  composition), reused by `launch-preparation` to check a requested model
   *  against the Harness's declared model list. A repeated call reuses the held
   *  result. Returns undefined for an unregistered id. */
  qualify(id: string): Promise<ApplicationHarnessQualification | undefined>;
  /** Read the held result without starting qualification. */
  qualification(id: string): ApplicationHarnessQualification | undefined;
}

/** The read-only Harness catalog owns the process-scoped qualification cache and
 * translates evidence-bearing Harness profiles into the client vocabulary. */
export function createHarnessCatalog(
  registrations: readonly ApplicationHarnessRegistration[],
  now: () => Date,
  subscriptions: Pick<SubscriptionLifecycle, "open">,
  observe: ApplicationObserver,
  catalog: Catalog,
  onQualified: (harness: string) => void,
): HarnessCatalog {
  const held = new Map<string, HeldQualification>();
  const qualifications = new Map<string, Promise<HeldQualification>>();
  const listObservers = new Set<UpdateStream<HarnessCatalogSnapshot>>();

  const listSnapshot = (): HarnessCatalogSnapshot => ({
    family: "harness-catalog",
    view: "list",
    harnesses: registrations.map((registration) =>
      summaryOf(registration, held.get(registration.choice.id)),
    ),
  });

  const registrationFor = (
    id: string,
  ): ApplicationHarnessRegistration | undefined =>
    registrations.find((registration) => registration.choice.id === id);

  const qualifyRegistration = (
    registration: ApplicationHarnessRegistration,
  ): Promise<HeldQualification> => {
    const existing = qualifications.get(registration.choice.id);
    if (existing !== undefined) return existing;

    const harness = registration.choice.id;
    // Written before the qualification spawns, so a hang names this stage.
    observe({ kind: "qualification-start", harness });
    const pending = registration
      .qualify()
      .catch((error): ApplicationHarnessQualification => ({
        ok: false,
        failure: {
          phase: "prepare",
          category: "qualification-exception",
          possibleEffects: "none",
          diagnostics:
            error instanceof Error
              ? error.message
              : "Harness qualification failed unexpectedly.",
          cause: error,
        },
      }))
      .then((result) => {
        const qualification = { checkedAt: now().toISOString(), result };
        held.set(registration.choice.id, qualification);
        observe(qualificationResult(harness, result));
        onQualified(harness);
        for (const observer of listObservers) {
          observer.push({ kind: "durable", snapshot: listSnapshot() });
        }
        return qualification;
      });
    qualifications.set(registration.choice.id, pending);
    return pending;
  };

  return {
    openList(): OpenedProjection<HarnessCatalogSnapshot> {
      const updates = subscriptions.open<HarnessCatalogSnapshot>((updates) => {
        listObservers.add(updates);
        return () => {
          listObservers.delete(updates);
        };
      });
      return {
        snapshot: listSnapshot(),
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    },
    openFocus(
      selection: HarnessFocusSelector,
    ): OpenedProjection<HarnessFocusSnapshot> {
      let subscribed = true;
      const updates = subscriptions.open<HarnessFocusSnapshot>(() => () => {
        subscribed = false;
      });
      const registration = registrationFor(selection.id);
      if (registration === undefined) {
        return openedFocus(
          updates,
          problemSnapshot(selection, harnessNotFound(selection.id)),
        );
      }

      const cached = held.get(registration.choice.id);
      if (cached !== undefined) {
        return openedFocus(
          updates,
          focusSnapshot(selection, registration, cached, catalog),
        );
      }

      void qualifyRegistration(registration).then((qualification) => {
        if (!subscribed) return;
        updates.push({
          kind: "durable",
          snapshot: focusSnapshot(
            selection,
            registration,
            qualification,
            catalog,
          ),
        });
      });
      return openedFocus(
        updates,
        focusSnapshot(selection, registration, undefined, catalog),
      );
    },
    async qualify(
      id: string,
    ): Promise<ApplicationHarnessQualification | undefined> {
      const registration = registrationFor(id);
      if (registration === undefined) {
        if (!held.has(id)) {
          held.set(id, {
            checkedAt: now().toISOString(),
            result: {
              ok: false,
              failure: {
                phase: "prepare",
                category: "harness-not-registered",
                possibleEffects: "none",
              },
            },
          });
          onQualified(id);
        }
        return undefined;
      }
      const cached = held.get(id);
      if (cached !== undefined) return cached.result;
      return (await qualifyRegistration(registration)).result;
    },
    qualification(id) {
      return held.get(id)?.result;
    },
    readDiagnostic(reference: HarnessDiagnosticReference): ResourceRead {
      const qualification = held.get(reference.harnessId);
      if (
        qualification === undefined ||
        qualification.checkedAt !== reference.checkedAt ||
        qualification.result.ok ||
        qualification.result.failure.diagnostics === undefined
      ) {
        return {
          found: false,
          problem: harnessDiagnosticMissing(reference),
        };
      }
      return {
        found: true,
        type: "diagnostic",
        content: qualification.result.failure.diagnostics,
      };
    },
  };
}

function openedFocus(
  updates: UpdateStream<HarnessFocusSnapshot>,
  snapshot: HarnessFocusSnapshot,
): OpenedProjection<HarnessFocusSnapshot> {
  return {
    snapshot,
    catchUp: "fresh",
    updates,
    close() {
      updates.close();
    },
  };
}

function problemSnapshot(
  selection: HarnessFocusSelector,
  problem: Problem,
): HarnessFocusSnapshot {
  return {
    family: "harness-catalog",
    view: "focus",
    selection,
    result: { found: false, problem },
  };
}

function focusSnapshot(
  selection: HarnessFocusSelector,
  registration: ApplicationHarnessRegistration,
  held: HeldQualification | undefined,
  catalog: Catalog,
): HarnessFocusSnapshot {
  return {
    family: "harness-catalog",
    view: "focus",
    selection,
    result: { found: true, harness: focusOf(registration, held, catalog) },
  };
}

function summaryOf(
  registration: ApplicationHarnessRegistration,
  held: HeldQualification | undefined,
): HarnessSummary {
  return {
    id: registration.choice.id,
    name: registration.choice.name,
    discovery: discoveryView(registration.discover()),
    qualification: qualificationView(held),
  };
}

function focusOf(
  registration: ApplicationHarnessRegistration,
  held: HeldQualification | undefined,
  catalog: Catalog,
): HarnessFocus {
  const summary = summaryOf(registration, held);
  if (held === undefined) {
    return {
      ...summary,
      capabilities: uncheckedCapabilities(),
      displayFactLimits: [],
    };
  }
  if (!held.result.ok) {
    const failure = held.result.failure;
    return {
      ...summary,
      capabilities: uncheckedCapabilities(),
      displayFactLimits: [],
      ...(failure.category === "authentication"
        ? {
            authenticationInstructions: `Log in separately through ${registration.choice.name}; Secant does not transport credentials.`,
          }
        : {}),
      unavailable: harnessQualificationUnavailable(
        registration.choice,
        failure,
      ),
      ...(failure.diagnostics === undefined
        ? {}
        : {
            diagnosticReference: {
              type: "harness-diagnostic",
              harnessId: registration.choice.id,
              checkedAt: held.checkedAt,
            },
          }),
    };
  }

  const { profile, defaults } = held.result;
  return {
    ...summary,
    ...(profile.modelSelection.at === "unavailable"
      ? {}
      : modelViews(profile.modelSelection.declaration)),
    harnessDefaults: defaultsView(defaults),
    ...preselectionView(catalog, registration.choice, profile, defaults),
    capabilities: capabilitiesOf(profile),
    displayFactLimits: [...(profile.displayFactLimits ?? [])],
    configurationPosture: profile.configurationPosture,
  };
}

/** The frozen `supportedModels` beside the additive `modelDeclaration` (#341):
 * the frozen view keeps its names-only `list` and reads a `suggested` declaration,
 * which admits any model, as free text. */
function modelViews(
  declaration: ModelDeclaration,
): Pick<HarnessFocus, "supportedModels" | "modelDeclaration"> {
  const models =
    declaration.kind === "free-text" ? [] : declaration.models.map(entryView);
  return {
    supportedModels:
      declaration.kind === "list"
        ? { kind: "list", models: models.map((entry) => entry.model) }
        : { kind: "free-text" },
    modelDeclaration:
      declaration.kind === "list"
        ? { kind: "list", models }
        : declaration.kind === "suggested"
          ? { kind: "suggested", models, efforts: [...declaration.efforts] }
          : { kind: "free-text", efforts: [...declaration.efforts] },
  };
}

function entryView(entry: ModelEntry): ModelEntryView {
  return {
    model: entry.model,
    label: entry.label,
    efforts: [...entry.efforts],
    ...(entry.defaultEffort === undefined
      ? {}
      : { defaultEffort: entry.defaultEffort }),
  };
}

/** The Application's preselection over the qualified defaults (ADR 0034), so a
 *  client choosing a Harness shows what a launch starts from without deriving it. */
function preselectionView(
  catalog: Catalog,
  harness: ApplicationHarnessRegistration["choice"],
  profile: HarnessProfile,
  defaults: HarnessDefaults,
): Pick<HarnessFocus, "preselection" | "preferenceNotice"> {
  const { preselection, preferenceNotice } = preselectModelChoice({
    catalog,
    harness,
    profile,
    defaults,
  });
  return {
    ...(preselection === undefined ? {} : { preselection }),
    ...(preferenceNotice === undefined ? {} : { preferenceNotice }),
  };
}

function defaultsView(defaults: HarnessDefaults): HarnessDefaultsView {
  if (defaults.kind === "unavailable") {
    return { kind: "unavailable", reason: defaults.reason };
  }
  const choice = {
    model: defaults.choice.model,
    ...(defaults.choice.effort === undefined
      ? {}
      : { effort: defaults.choice.effort }),
  };
  const effortLock =
    defaults.effortLock === undefined
      ? {}
      : {
          effortLock: {
            effort: defaults.effortLock.effort,
            source: defaults.effortLock.source,
          },
        };
  return defaults.kind === "reported"
    ? { kind: "reported", choice, ...effortLock }
    : { kind: "fallback", choice, reason: defaults.reason, ...effortLock };
}

function discoveryView(
  discovery: ReturnType<ApplicationHarnessRegistration["discover"]>,
): HarnessDiscoveryView {
  if (discovery.kind === "found") {
    return {
      state: "found",
      source: discovery.source,
      description: discovery.description,
    };
  }
  if (discovery.kind === "unsupported-shim") {
    return {
      state: "unsupported-shim",
      name: discovery.name,
      path: discovery.path,
      executableEnvironmentVariable: discovery.executableEnvironmentVariable,
    };
  }
  return {
    state: "not-found",
    searched: discovery.searched,
    executableEnvironmentVariable: discovery.executableEnvironmentVariable,
  };
}

/** The result event: the Qualification state the Projection derives, plus a
 *  failure's typed fields. Diagnostics and retry evidence stay behind. */
function qualificationResult(
  harness: string,
  result: ApplicationHarnessQualification,
): ApplicationEvent {
  if (result.ok) {
    return {
      kind: "qualification-result",
      harness,
      qualification: qualifiedState(result.profile),
    };
  }
  const { phase, category, possibleEffects, nativeCode, cause } =
    result.failure;
  return {
    kind: "qualification-result",
    harness,
    qualification: "not-ready",
    failure: {
      phase,
      category,
      possibleEffects,
      ...(nativeCode !== undefined ? { nativeCode } : {}),
      ...(cause !== undefined ? { cause } : {}),
    },
  };
}

function qualificationView(
  held: HeldQualification | undefined,
): HarnessQualificationView {
  if (held === undefined) return { state: "not-checked" };
  if (!held.result.ok) return { state: "not-ready", checkedAt: held.checkedAt };
  return {
    state: qualifiedState(held.result.profile),
    observation: {
      executable: held.result.profile.executable,
      executableVersion: held.result.profile.executableVersion,
      platform: held.result.profile.platform,
      checkedAt: held.checkedAt,
    },
  };
}

function qualifiedState(
  profile: HarnessProfile,
): "qualified" | "qualified-with-limits" {
  return (profile.displayFactLimits?.length ?? 0) === 0 &&
    capabilitiesOf(profile).every(
      (capability) => capability.state === "available",
    )
    ? "qualified"
    : "qualified-with-limits";
}

const CAPABILITY_DEFINITIONS = [
  {
    capability: "session-recovery",
    name: "Session recovery",
    description: "Resume a Harness Session after process loss.",
  },
  {
    capability: "same-turn-steering",
    name: "Same-Turn steering",
    description: "Send guidance while the current Turn is still working.",
  },
  {
    capability: "turn-interruption",
    name: "Turn interruption",
    description: "Stop the current Turn and its native work.",
  },
  {
    capability: "tool-approvals",
    name: "Tool approvals",
    description: "Review tool actions raised by the Harness.",
  },
  {
    capability: "structured-questions",
    name: "Structured questions",
    description: "Answer structured questions raised by the Harness.",
  },
  {
    capability: "effective-model",
    name: "Effective model",
    description: "Observe the model that actually served a Turn.",
  },
] as const;

function uncheckedCapabilities(): readonly HarnessCapabilityView[] {
  return CAPABILITY_DEFINITIONS.map((definition) => ({
    ...definition,
    state: "not-checked",
  }));
}

function capabilitiesOf(
  profile: HarnessProfile,
): readonly HarnessCapabilityView[] {
  return [
    capability(
      CAPABILITY_DEFINITIONS[0],
      profile.recovery.mode === "native-reattach"
        ? "available"
        : profile.recovery.mode === "load-with-replay"
          ? "available-with-limits"
          : "unavailable",
      profile.recovery.mode === "load-with-replay"
        ? profile.recovery.evidence
        : undefined,
    ),
    capability(
      CAPABILITY_DEFINITIONS[1],
      profile.steer.available ? "available" : "unavailable",
    ),
    capability(
      CAPABILITY_DEFINITIONS[2],
      profile.interruption.mode === "active-turn"
        ? "available"
        : profile.interruption.mode === "process-only"
          ? "available-with-limits"
          : "unavailable",
      profile.interruption.mode === "process-only"
        ? profile.interruption.evidence
        : undefined,
    ),
    capability(
      CAPABILITY_DEFINITIONS[3],
      profile.approvals.available ? "available" : "unavailable",
    ),
    capability(
      CAPABILITY_DEFINITIONS[4],
      profile.clarifications.available ? "available" : "unavailable",
    ),
    capability(
      CAPABILITY_DEFINITIONS[5],
      profile.modelObservation.available ? "available" : "unavailable",
    ),
  ];
}

function capability(
  definition: (typeof CAPABILITY_DEFINITIONS)[number],
  state: HarnessCapabilityView["state"],
  limits?: string,
): HarnessCapabilityView {
  return {
    ...definition,
    state,
    ...(limits === undefined ? {} : { limits }),
  };
}
