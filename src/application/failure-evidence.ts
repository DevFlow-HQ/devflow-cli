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
import {
  MAY_HAVE_CHANGED_FILES,
  UNKNOWN_FAILURE_EXPLANATION,
} from "./resting-cause.js";

/** Unknown persisted codes and malformed details never break a client's read. */
export function failureView(
  runId: string,
  evidence: FailureEvidenceRecord | undefined,
  harness?: string,
): RunFailureView {
  const possibleEffects =
    effects.safeParse(evidence?.possibleEffects).data ?? "unknown";
  let explanation = UNKNOWN_FAILURE_EXPLANATION;
  let nextStep = "Resume the Run to try again, or delete it.";
  let code: RunFailureView["code"] = "unknown";
  let source: RunFailureView["source"] = "unknown";
  let details: RunFailureView["details"];
  let raw: unknown;
  try {
    raw =
      evidence?.details !== undefined &&
      new TextEncoder().encode(evidence.details).byteLength <= 4096
        ? JSON.parse(evidence.details)
        : undefined;
  } catch {
    raw = undefined;
  }
  if (evidence?.source === "receipt") {
    const parsedCode = receiptCode.safeParse(evidence.code);
    const parsedDetails = receiptDetails.safeParse(raw);
    if (
      parsedCode.success &&
      parsedDetails.success &&
      (parsedCode.data !== "receipt-too-large" ||
        parsedDetails.data.sizeLimit !== undefined)
    ) {
      code = parsedCode.data;
      source = "receipt";
      details = parsedDetails.data;
      const output = `The required output "${parsedDetails.data.outputName}"`;
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
          explanation = `${output} exceeds the ${parsedDetails.data.sizeLimit}-byte limit.`;
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
      nextStep = "Resume the Run to try the Step again.";
    }
  }
  if (evidence?.source === "agent") {
    const parsed = agentCode.safeParse(evidence.code);
    if (parsed.success) {
      source = "agent";
      code = parsed.data;
      if (code === "session-unusable") {
        explanation = "This Step's agent conversation can no longer continue.";
        nextStep = "Delete the Run or start a new one.";
      } else {
        explanation =
          code === "prompt-refused"
            ? "Secant did not send the prompt because it starts with a word the Harness reserves."
            : "Secant could not prepare the prompt and did not send it.";
        nextStep = "Fix the Bundle prompt or choose another Harness.";
      }
    }
  }
  if (evidence?.source === "harness") {
    const parsedCode = harnessCode.safeParse(evidence.code);
    const lost = lostDetails.safeParse(raw);
    if (
      parsedCode.success &&
      (parsedCode.data !== "turn-lost" || lost.success)
    ) {
      source = "harness";
      code = parsedCode.data;
      const name =
        harness === "codex"
          ? "Codex"
          : harness === "claude-code"
            ? "Claude Code"
            : "The Harness";
      if (code === "turn-lost" && lost.success) {
        details = lost.data;
        const unknownHalf = {
          acceptance: "whether it accepted the Turn",
          completion: "whether the Turn finished",
          interruption: "whether the Turn stopped after the interrupt",
        }[lost.data.unknown];
        explanation = `${name} exited or lost contact. Secant does not know ${unknownHalf}.`;
        nextStep = "Resume the Run to continue.";
      } else if (evidence.category === "authentication") {
        explanation = `${name} is not signed in.`;
        nextStep = `Log in through ${name} itself, then resume the Run.`;
      } else {
        explanation = `${name} reported an error. Open the details section for the cause.`;
        nextStep = "Open the details section for the cause.";
      }
    }
  }
  if (possibleEffects !== "none") explanation += ` ${MAY_HAVE_CHANGED_FILES}`;
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
