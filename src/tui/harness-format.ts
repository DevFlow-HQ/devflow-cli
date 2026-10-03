import type {
  HarnessCapabilityState,
  HarnessDiscoveryView,
  HarnessFocus,
  HarnessObservationView,
  HarnessQualificationState,
  HarnessQualificationView,
  HarnessSummary,
} from "../application/projection-port.js";

// Worded, colour-independent Harness status shared by Start a Run and the
// Harness catalog. The words mirror headless rendering up to capitalisation.

export function isQualified(
  qualification: HarnessQualificationView,
): qualification is Extract<
  HarnessQualificationView,
  { state: "qualified" | "qualified-with-limits" }
> {
  return (
    qualification.state === "qualified" ||
    qualification.state === "qualified-with-limits"
  );
}

export function qualificationObservation(
  qualification: HarnessQualificationView,
): HarnessObservationView | undefined {
  return isQualified(qualification) ? qualification.observation : undefined;
}

function qualificationWord(qualification: HarnessQualificationView): string {
  return qualificationLabel(qualification.state);
}

export function qualificationLabel(state: HarnessQualificationState): string {
  return titleCase(state);
}

export function capabilityLabel(state: HarnessCapabilityState): string {
  return titleCase(state);
}

export function discoveryLabel(discovery: HarnessDiscoveryView): string {
  if (discovery.state === "found") {
    return `found via ${discovery.description}`;
  }
  if (discovery.state === "unsupported-shim") {
    return `unsupported shim ${discovery.path}`;
  }
  return `not found; searched ${discovery.searched.join(", ")}`;
}

export function harnessRowStatus(harness: HarnessSummary): string {
  if (harness.discovery.state === "not-found") {
    return "Unavailable · not found on PATH";
  }
  if (harness.discovery.state === "unsupported-shim") {
    return "Unavailable · unsupported shim";
  }
  return qualificationWord(harness.qualification);
}

/**
 * Whether Start a Run is still checking the chosen Harness's models: no focus
 * snapshot yet, or one still `not-checked`. An opened focus always publishes one
 * settled result (a failed check settles `not-ready`), so this always ends.
 */
export function isCheckingModels(
  focus: HarnessFocus | undefined,
): focus is
  undefined | (HarnessFocus & { qualification: { state: "not-checked" } }) {
  return focus === undefined || focus.qualification.state === "not-checked";
}

/** Start a Run's status for the chosen Harness: the checking words until its
 *  focus settles, then the words its catalog row uses. */
export function harnessFocusStatus(focus: HarnessFocus | undefined): string {
  if (isCheckingModels(focus)) return "Checking models…";
  return harnessRowStatus(focus);
}

export const FREE_TEXT_MODEL_ENTRY = "Free-text model entry";

/**
 * The Harness catalog row's model line: what a qualified Harness observed or
 * suggests, or nothing when it offers no model selection. An unqualified Harness
 * has not shown its models yet, whatever its registration declares.
 */
export function harnessModelLine(
  qualification: HarnessQualificationView,
  declaration: HarnessFocus["modelDeclaration"],
): string | undefined {
  if (!isQualified(qualification)) return "Models not yet observed";
  if (declaration === undefined) return undefined;
  if (declaration.kind === "free-text") return FREE_TEXT_MODEL_ENTRY;
  const count = declaration.models.length;
  const models = count === 1 ? "model" : "models";
  return declaration.kind === "suggested"
    ? `${count} suggested ${models}`
    : `${count} ${models} observed`;
}

/** A model's name for a person: its label and exact name, or the name alone
 *  when the Harness gives no other label. Headless `render.ts` uses the same
 *  words for models and efforts. */
export function modelName(entry: {
  readonly model: string;
  readonly label?: string;
}): string {
  return entry.label === undefined || entry.label === entry.model
    ? entry.model
    : `${entry.label} · ${entry.model}`;
}

/** A model's efforts in words, the default marked in text rather than colour. */
export function effortsLine(
  efforts: readonly string[],
  defaultEffort?: string,
): string {
  if (efforts.length === 0) return "No effort setting";
  return `Efforts · ${efforts
    .map((effort) =>
      effort === defaultEffort ? `${effort} (default)` : effort,
    )
    .join(", ")}`;
}

function titleCase(value: string): string {
  const words = value.replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
