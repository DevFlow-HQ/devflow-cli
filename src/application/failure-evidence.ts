import { z } from "zod";
import type { FailureEvidenceRecord } from "../run/store/store.js";
import type { RunFailureView } from "./projection-port.js";

const effects = z.enum(["none", "partial", "unknown"]);
const agentCode = z.enum([
  "session-unusable",
  "prompt-render-failed",
  "prompt-refused",
  "not-started",
]);
const receiptCode = z.enum([
  "receipt-missing",
  "receipt-not-file",
  "receipt-symlink",
  "receipt-too-large",
  "receipt-invalid-utf8",
  "receipt-blank",
]);
const harnessCode = z.enum(["turn-failed", "turn-not-started", "turn-lost"]);
const lostDetails = z.object({
  unknown: z.enum(["acceptance", "completion", "interruption"]),
});
const receiptDetails = z.object({
  outputName: z.string().min(1),
  sizeLimit: z.number().int().positive().optional(),
});
const commandCode = z.enum([
  "spawn-failed",
  "executable-missing",
  "timed-out",
  "killed",
]);
const timedOutDetails = z.object({
  timeLimitMs: z.number().int().positive(),
});
import {
  MAY_HAVE_CHANGED_FILES,
  UNKNOWN_FAILURE_EXPLANATION,
} from "./resting-cause.js";

/** The narrowed code and its derived words, before the possible-effects sentence. */
type Narrowed = Pick<
  RunFailureView,
  "source" | "code" | "details" | "explanation" | "nextStep"
>;

/** Unknown persisted codes and malformed details never break a client's read. */
export function failureView(
  runId: string,
  evidence: FailureEvidenceRecord | undefined,
  harness?: string,
): RunFailureView {
  const possibleEffects =
    effects.safeParse(evidence?.possibleEffects).data ?? "unknown";
  const narrowed = (evidence === undefined
    ? undefined
    : narrow(evidence, harness)) ?? {
    source: "unknown",
    code: "unknown",
    explanation: UNKNOWN_FAILURE_EXPLANATION,
    nextStep: "Resume the Run to try again, or delete it.",
  };
  const { source, code, details, nextStep } = narrowed;
  const explanation =
    possibleEffects === "none"
      ? narrowed.explanation
      : `${narrowed.explanation} ${MAY_HAVE_CHANGED_FILES}`;
  return {
    source,
    code,
    possibleEffects,
    explanation,
    nextStep,
    ...(details === undefined ? {} : { details }),
    ...(evidence?.phase === undefined ? {} : { phase: evidence.phase }),
    ...(evidence?.category === undefined
      ? {}
      : { category: evidence.category }),
    ...(evidence?.nativeCode === undefined
      ? {}
      : { nativeCode: evidence.nativeCode }),
    ...(evidence?.diagnosticId === undefined
      ? {}
      : {
          diagnostic: {
            runId,
            diagnosticId: evidence.diagnosticId,
            type: "diagnostic",
          },
        }),
  };
}

function narrow(
  evidence: FailureEvidenceRecord,
  harness: string | undefined,
): Narrowed | undefined {
  switch (evidence.source) {
    case "receipt":
      return receiptFailure(evidence);
    case "command":
      return commandFailure(evidence);
    case "agent":
      return agentFailure(evidence);
    case "harness":
      return harnessFailure(evidence, harness);
    default:
      return undefined;
  }
}

function agentFailure(evidence: FailureEvidenceRecord): Narrowed | undefined {
  const parsed = agentCode.safeParse(evidence.code);
  if (!parsed.success) return undefined;
  const code = parsed.data;
  if (code === "session-unusable")
    return {
      source: "agent",
      code,
      explanation: "This Step's agent conversation can no longer continue.",
      nextStep: "Delete the Run or start a new one.",
    };
  return {
    source: "agent",
    code,
    explanation:
      code === "prompt-refused"
        ? "Secant did not send the prompt because it starts with a word the Harness reserves."
        : "Secant could not prepare the prompt and did not send it.",
    nextStep: "Fix the Bundle prompt or choose another Harness.",
  };
}

function harnessFailure(
  evidence: FailureEvidenceRecord,
  harness: string | undefined,
): Narrowed | undefined {
  const parsedCode = harnessCode.safeParse(evidence.code);
  const lost = lostDetails.safeParse(storedDetails(evidence));
  if (!parsedCode.success || (parsedCode.data === "turn-lost" && !lost.success))
    return undefined;
  const code = parsedCode.data;
  const name =
    harness === "codex"
      ? "Codex"
      : harness === "claude-code"
        ? "Claude Code"
        : "The Harness";
  if (code === "turn-lost" && lost.success) {
    const unknownHalf = {
      acceptance: "whether it accepted the Turn",
      completion: "whether the Turn finished",
      interruption: "whether the Turn stopped after the interrupt",
    }[lost.data.unknown];
    return {
      source: "harness",
      code,
      details: lost.data,
      explanation: `${name} exited or lost contact. Secant does not know ${unknownHalf}.`,
      nextStep: "Resume the Run to continue.",
    };
  }
  if (evidence.category === "authentication")
    return {
      source: "harness",
      code,
      explanation: `${name} is not signed in.`,
      nextStep: `Log in through ${name} itself, then resume the Run.`,
    };
  return {
    source: "harness",
    code,
    explanation: `${name} reported an error. Open the details section for the cause.`,
    nextStep: "Open the details section for the cause.",
  };
}

/** Bounded scalar details as stored, or undefined when absent or malformed. */
function storedDetails(evidence: FailureEvidenceRecord): unknown {
  if (
    evidence.details === undefined ||
    new TextEncoder().encode(evidence.details).byteLength > 4096
  )
    return undefined;
  try {
    return JSON.parse(evidence.details);
  } catch {
    return undefined;
  }
}

function receiptFailure(evidence: FailureEvidenceRecord): Narrowed | undefined {
  const parsedCode = receiptCode.safeParse(evidence.code);
  const parsedDetails = receiptDetails.safeParse(storedDetails(evidence));
  if (
    !parsedCode.success ||
    !parsedDetails.success ||
    (parsedCode.data === "receipt-too-large" &&
      parsedDetails.data.sizeLimit === undefined)
  )
    return undefined;
  const code = parsedCode.data;
  const details = parsedDetails.data;
  const output = `The required output "${details.outputName}"`;
  let explanation: string;
  switch (code) {
    case "receipt-missing":
      explanation = `${output} was not written.`;
      break;
    case "receipt-not-file":
      explanation = `${output} is not a regular file.`;
      break;
    case "receipt-symlink":
      explanation = `${output} is a symbolic link.`;
      break;
    case "receipt-too-large":
      explanation = `${output} exceeds the ${details.sizeLimit}-byte limit.`;
      break;
    case "receipt-invalid-utf8":
      explanation = `${output} is not valid UTF-8 text.`;
      break;
    case "receipt-blank":
      explanation = `${output} is empty.`;
      break;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
  return {
    source: "receipt",
    code,
    details,
    explanation,
    nextStep: "Resume the Run to try the Step again.",
  };
}

/** A Command's wording (spec #527 decision 22). A spawn-time ENOENT reads like a
 *  program missing at resolution; a timeout states its bound when its details
 *  are readable and still reads as a timeout when they are not. */
function commandFailure(evidence: FailureEvidenceRecord): Narrowed | undefined {
  const parsedCode = commandCode.safeParse(evidence.code);
  if (!parsedCode.success) return undefined;
  const code = parsedCode.data;
  switch (code) {
    case "spawn-failed":
    case "executable-missing":
      return code === "executable-missing" || evidence.nativeCode === "ENOENT"
        ? {
            source: "command",
            code,
            explanation: "The Command's program was not found.",
            nextStep:
              "Install the program or fix its path, then resume the Run.",
          }
        : {
            source: "command",
            code,
            explanation: "The Command's program could not be started.",
            nextStep: "Install or fix the program, then resume the Run.",
          };
    case "timed-out": {
      const details = timedOutDetails.safeParse(storedDetails(evidence));
      return {
        source: "command",
        code,
        ...(details.success ? { details: details.data } : {}),
        explanation: details.success
          ? `The Command ran past its ${timeLimit(details.data.timeLimitMs)} time limit and was stopped.`
          : "The Command ran past its time limit and was stopped.",
        nextStep:
          "Resume the Run to try again. Open the details section for its last output.",
      };
    }
    case "killed":
      return {
        source: "command",
        code,
        explanation: "A signal stopped the Command before it finished.",
        nextStep: "Resume the Run to run the Command again.",
      };
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/** A time limit as the largest whole unit that states it exactly. */
function timeLimit(ms: number): string {
  for (const [unit, size] of [
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ] as const) {
    if (ms % size === 0) return `${ms / size}-${unit}`;
  }
  return `${ms}-millisecond`;
}
