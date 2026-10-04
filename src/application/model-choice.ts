import { z } from "zod";
import type { Catalog } from "../catalog/catalog.js";
import type {
  HarnessDefaults,
  HarnessProfile,
  ModelChoice,
  ModelDeclaration,
} from "../harness/harness.js";
import {
  effortChoiceRequired,
  effortLocked,
  modelChoiceRequired,
  requestedEffortUnavailable,
  requestedModelUnavailable,
} from "./problems.js";
import type { HarnessChoice, Problem } from "./projection-port.js";

// The Run's Model choice above the Harness Seam (ADR 0034): the one preselection
// order both clients launch from, and the resolution of a launch draft's
// requested model and effort against the qualified Harness. The Adapter declares
// its fallback; this Module only orders the sources and never invents a value.

type EffortLock = NonNullable<
  Exclude<HarnessDefaults, { kind: "unavailable" }>["effortLock"]
>;

/** The last choice, then the Harness-reported default, then its fallback. */
type PreselectionSource =
  | { readonly kind: "last-choice" }
  | { readonly kind: "reported" }
  | { readonly kind: "fallback"; readonly reason: string };

export interface Preselection {
  readonly choice: ModelChoice;
  readonly source: PreselectionSource;
  readonly effortLock?: EffortLock;
}

/** Where a resolved launch Model choice came from: the draft named a model or an
 *  effort, or it took the preselection whole. */
export type ModelChoiceSource =
  PreselectionSource | { readonly kind: "requested" };

const savedChoice = z.strictObject({
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
});

function preferenceKey(harnessId: string): string {
  return `last-model-choice:${harnessId}`;
}

/** Save only after the Run write commits. A storage failure keeps that Run
 * choice active and returns the notice both launch and mid-Run callers report. */
export function saveLastModelChoice(
  catalog: Catalog,
  harnessId: string,
  choice: ModelChoice,
): string | undefined {
  try {
    catalog.setPreference(preferenceKey(harnessId), JSON.stringify(choice));
    return undefined;
  } catch {
    return "Your Model choice is active for this Run, but Secant could not save it as your last choice. Try choosing it again on your next launch.";
  }
}

/** Read anew for each focus or assessment; qualification alone is cached.
 * Catalog checks row shape. Application checks the encoded choice and its meaning. */
export function preselectModelChoice(params: {
  readonly catalog: Catalog;
  readonly harness: HarnessChoice;
  readonly profile: HarnessProfile;
  readonly defaults: HarnessDefaults;
}): {
  readonly preselection?: Preselection;
  readonly preferenceNotice?: string;
} {
  const { defaults } = params;
  const effortLock =
    defaults.kind === "unavailable" ? undefined : defaults.effortLock;
  let preferenceNotice: string | undefined;
  try {
    const encoded = params.catalog.getPreference(
      preferenceKey(params.harness.id),
    );
    if (encoded !== undefined) {
      const choice = savedChoice.parse(JSON.parse(encoded));
      const declaration =
        params.profile.modelSelection.at === "unavailable"
          ? undefined
          : params.profile.modelSelection.declaration;
      const modelAvailable =
        declaration?.kind !== "list" ||
        declaration.models.some((entry) => entry.model === choice.model);
      const effort = resolveEffort({
        harness: params.harness,
        model: choice.model,
        declaration,
        requestedEffort: choice.effort,
        preselected: choice,
      });
      if (modelAvailable && effort.ok) {
        return {
          preselection: applyEffortLock(
            {
              choice:
                effort.effort === undefined
                  ? { model: choice.model }
                  : { model: choice.model, effort: effort.effort },
              source: { kind: "last-choice" },
            },
            effortLock,
          ),
        };
      }
      preferenceNotice = modelAvailable
        ? `Your last choice was skipped. ${!effort.ok ? effort.problem.explanation : "The saved effort is unavailable."}`
        : `Your last choice was skipped because ${choice.model} is no longer offered by ${params.harness.name}.`;
    }
  } catch {
    preferenceNotice =
      "Secant could not read your last Model choice. Using the Harness defaults; you can still choose a model.";
  }
  const preselection: Preselection | undefined =
    defaults.kind === "unavailable"
      ? undefined
      : applyEffortLock(
          {
            choice: defaults.choice,
            source:
              defaults.kind === "reported"
                ? { kind: "reported" }
                : { kind: "fallback", reason: defaults.reason },
          },
          effortLock,
        );
  return {
    ...(preselection === undefined ? {} : { preselection }),
    ...(preferenceNotice === undefined ? {} : { preferenceNotice }),
  };
}

function applyEffortLock(
  preselection: Preselection,
  effortLock: EffortLock | undefined,
): Preselection {
  return effortLock === undefined
    ? preselection
    : {
        ...preselection,
        choice: { model: preselection.choice.model, effort: effortLock.effort },
        effortLock,
      };
}

type ModelChoiceResolution =
  | {
      readonly ok: true;
      readonly choice: ModelChoice;
      readonly source: ModelChoiceSource;
      readonly preferenceNotice?: string;
      readonly effortLock?: EffortLock;
    }
  | { readonly ok: false; readonly problem: Problem };

/** Resolve a launch draft's requested model and effort into one Model choice:
 *  an omitted model is the preselected one; an omitted effort is the preselected
 *  effort when the model offers it, else the model's own default, and none for a
 *  model with no effort setting. The model is checked against a `list`
 *  declaration and the effort against the efforts the model offers. */
export function resolveModelChoice(params: {
  readonly catalog: Catalog;
  readonly harness: HarnessChoice;
  readonly profile: HarnessProfile;
  readonly defaults: HarnessDefaults;
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
}): ModelChoiceResolution {
  const { harness, requestedModel, requestedEffort } = params;
  const { preselection, preferenceNotice } = preselectModelChoice(params);
  const effortLock = preselection?.effortLock;
  if (
    effortLock !== undefined &&
    requestedEffort !== undefined &&
    requestedEffort !== effortLock.effort
  )
    return { ok: false, problem: effortLocked(effortLock.source) };
  const model = requestedModel ?? preselection?.choice.model;
  if (model === undefined) {
    return {
      ok: false,
      problem: modelChoiceRequired(
        harness,
        params.defaults.kind === "unavailable"
          ? params.defaults.reason
          : undefined,
      ),
    };
  }
  const declaration =
    params.profile.modelSelection.at === "unavailable"
      ? undefined
      : params.profile.modelSelection.declaration;
  if (
    declaration?.kind === "list" &&
    !declaration.models.some((entry) => entry.model === model)
  ) {
    return {
      ok: false,
      problem: requestedModelUnavailable(
        harness,
        model,
        declaration.models.map((entry) => entry.model),
      ),
    };
  }
  // A draft naming neither half reached here only through a preselection.
  const source: ModelChoiceSource =
    preselection !== undefined &&
    requestedModel === undefined &&
    requestedEffort === undefined
      ? preselection.source
      : { kind: "requested" };
  const effort = resolveEffort({
    harness,
    model,
    declaration,
    requestedEffort: effortLock?.effort ?? requestedEffort,
    preselected: preselection?.choice,
  });
  if (!effort.ok) return effort;
  return {
    ok: true,
    choice:
      effort.effort === undefined
        ? { model }
        : { model, effort: effort.effort },
    source,
    ...(effortLock === undefined ? {} : { effortLock }),
    ...(preferenceNotice === undefined ? {} : { preferenceNotice }),
  };
}

function resolveEffort(params: {
  readonly harness: HarnessChoice;
  readonly model: string;
  readonly declaration: ModelDeclaration | undefined;
  readonly requestedEffort: string | undefined;
  readonly preselected: ModelChoice | undefined;
}):
  | { readonly ok: true; readonly effort?: string }
  | { readonly ok: false; readonly problem: Problem } {
  const { harness, model, declaration, requestedEffort, preselected } = params;
  const entry =
    declaration === undefined || declaration.kind === "free-text"
      ? undefined
      : declaration.models.find((candidate) => candidate.model === model);
  // A Harness that selects no model declares no efforts either, so nothing can
  // be checked: a requested effort passes through, and the preselected effort
  // stays with the preselected model only.
  const offered =
    declaration === undefined
      ? undefined
      : (entry?.efforts ??
        (declaration.kind === "list" ? [] : declaration.efforts));
  if (requestedEffort !== undefined) {
    if (offered !== undefined && !offered.includes(requestedEffort)) {
      return {
        ok: false,
        problem: requestedEffortUnavailable(
          harness,
          model,
          requestedEffort,
          offered,
        ),
      };
    }
    return { ok: true, effort: requestedEffort };
  }
  const effort = preselected?.effort;
  if (offered === undefined) {
    return model === preselected?.model && effort !== undefined
      ? { ok: true, effort }
      : { ok: true };
  }
  if (offered.length === 0) return { ok: true };
  if (effort !== undefined && offered.includes(effort)) {
    return { ok: true, effort };
  }
  if (entry?.defaultEffort !== undefined) {
    return { ok: true, effort: entry.defaultEffort };
  }
  return { ok: false, problem: effortChoiceRequired(harness, model, offered) };
}
