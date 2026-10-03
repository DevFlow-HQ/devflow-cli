import type {
  HarnessDefaults,
  HarnessProfile,
  ModelChoice,
  ModelDeclaration,
} from "../harness/harness.js";
import {
  effortChoiceRequired,
  modelChoiceRequired,
  requestedEffortUnavailable,
  requestedModelUnavailable,
} from "./problems.js";
import type { HarnessChoice, Problem } from "./projection-port.js";

// The Run's Model choice above the Harness Seam (ADR 0034): the one preselection
// order both clients launch from, and the resolution of a launch draft's
// requested model and effort against the qualified Harness. The Adapter declares
// its fallback; this Module only orders the sources and never invents a value.

/** Where a preselected Model choice came from. The order is the Harness-reported
 *  default, then the Adapter-declared fallback with its reason; the last choice
 *  (#343) joins it in front. */
type PreselectionSource =
  | { readonly kind: "reported" }
  | { readonly kind: "fallback"; readonly reason: string };

export interface Preselection {
  readonly choice: ModelChoice;
  readonly source: PreselectionSource;
}

/** Where a resolved launch Model choice came from: the draft named a model or an
 *  effort, or it took the preselection whole. */
export type ModelChoiceSource =
  PreselectionSource | { readonly kind: "requested" };

/** The Model choice to preselect for a Harness, or undefined when it reports
 *  nothing to start from (the defaults' `reason` says why). */
export function preselectModelChoice(
  defaults: HarnessDefaults,
): Preselection | undefined {
  if (defaults.kind === "reported") {
    return { choice: defaults.choice, source: { kind: "reported" } };
  }
  if (defaults.kind === "fallback") {
    return {
      choice: defaults.choice,
      source: { kind: "fallback", reason: defaults.reason },
    };
  }
  return undefined;
}

type ModelChoiceResolution =
  | {
      readonly ok: true;
      readonly choice: ModelChoice;
      readonly source: ModelChoiceSource;
    }
  | { readonly ok: false; readonly problem: Problem };

/** Resolve a launch draft's requested model and effort into one Model choice:
 *  an omitted model is the preselected one; an omitted effort is the preselected
 *  effort when the model offers it, else the model's own default, and none for a
 *  model with no effort setting. The model is checked against a `list`
 *  declaration and the effort against the efforts the model offers. */
export function resolveModelChoice(params: {
  readonly harness: HarnessChoice;
  readonly profile: HarnessProfile;
  readonly defaults: HarnessDefaults;
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
}): ModelChoiceResolution {
  const { harness, requestedModel, requestedEffort } = params;
  const preselection = preselectModelChoice(params.defaults);
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
    requestedEffort,
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
