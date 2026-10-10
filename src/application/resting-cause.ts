import type { RestingCauseRecord } from "../run/store/store.js";
import type { RunRestingCauseView } from "./projection-port.js";

// The Projection's read of a stored Resting cause (ADR 0041, spec #527
// decisions 11 and 22). The Store keeps the code as its writer gave it; this
// narrows it tolerantly and derives the plain words clients show, so no
// wording is ever stored.

export const MAY_HAVE_CHANGED_FILES =
  "It may have changed files before it stopped.";

export const UNKNOWN_FAILURE_EXPLANATION =
  "This Step failed for unknown reasons.";

type KnownCode = Exclude<RunRestingCauseView["code"], "unknown">;

const KNOWN: Readonly<
  Record<KnownCode, Omit<RunRestingCauseView, "code" | "diagnostic">>
> = {
  "execution-fault": {
    explanation: `Secant hit an internal error. ${MAY_HAVE_CHANGED_FILES}`,
    nextStep:
      "Resume the Run to try again. If it happens again, open the details section for the cause.",
    possibleEffects: "unknown",
  },
  "secant-stopped": {
    explanation: `Secant stopped while this Step was running, so whether the Step finished is unknown. ${MAY_HAVE_CHANGED_FILES}`,
    nextStep: "Resume the Run to continue.",
    possibleEffects: "unknown",
  },
};

const UNKNOWN: RunRestingCauseView = {
  code: "unknown",
  explanation: UNKNOWN_FAILURE_EXPLANATION,
  nextStep: "Resume the Run to try again, or delete it.",
};

/** The view of why a `halted` or `failed` Run rests; `cause` is absent for a
 *  rest recorded without one, including every rest before M11. */
export function restingCauseView(
  runId: string,
  cause: RestingCauseRecord | undefined,
): RunRestingCauseView {
  if (cause === undefined) return UNKNOWN;
  // An unknown code, from a newer Secant, still keeps its diagnostic.
  return {
    ...(isKnown(cause.code)
      ? { code: cause.code, ...KNOWN[cause.code] }
      : UNKNOWN),
    ...(cause.diagnosticId !== undefined
      ? {
          diagnostic: {
            runId,
            diagnosticId: cause.diagnosticId,
            type: "diagnostic" as const,
          },
        }
      : {}),
  };
}

function isKnown(code: string): code is KnownCode {
  return Object.hasOwn(KNOWN, code);
}
