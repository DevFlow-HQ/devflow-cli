import type { HarnessFailure, HarnessProfile, ModelChoice } from "./harness.js";

/** Check one Turn's requested model against the profile identically for every
 *  Adapter (ADR 0034): a model a declared `list` does not admit is a typed
 *  `not-started` failure raised before admission, never a substitution. A
 *  suggested or free-text declaration, a profile that cannot select a model, and a
 *  Turn with no request admit it. */
export function modelChoiceRefusal(
  profile: HarnessProfile,
  choice: ModelChoice | undefined,
): HarnessFailure | undefined {
  const selection = profile.modelSelection;
  if (
    choice === undefined ||
    selection.at === "unavailable" ||
    selection.declaration.kind !== "list" ||
    selection.declaration.models.some((entry) => entry.model === choice.model)
  ) {
    return undefined;
  }
  return {
    phase: "turn",
    category: "model-unavailable",
    possibleEffects: "none",
    diagnostics: `${profile.harness} does not offer the requested model '${choice.model}'. Available models: ${selection.declaration.models.map((entry) => entry.model).join(", ")}.`,
  };
}
