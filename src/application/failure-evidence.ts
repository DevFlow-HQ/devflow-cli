import { z } from "zod";
import type { FailureEvidenceRecord } from "../run/store/store.js";
import type { RunFailureView } from "./projection-port.js";

const effects = z.enum(["none", "partial", "unknown"]);
const receiptCode = z.enum([
  "receipt-missing",
  "receipt-not-file",
  "receipt-symlink",
  "receipt-too-large",
  "receipt-invalid-utf8",
  "receipt-blank",
]);
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
): RunFailureView {
  const possibleEffects =
    effects.safeParse(evidence?.possibleEffects).data ?? "unknown";
  let explanation = UNKNOWN_FAILURE_EXPLANATION;
  let nextStep = "Resume the Run to try again, or delete it.";
  let code: RunFailureView["code"] = "unknown";
  let source: RunFailureView["source"] = "unknown";
  let details: RunFailureView["details"];
  if (evidence?.source === "receipt") {
    const parsedCode = receiptCode.safeParse(evidence.code);
    let raw: unknown;
    try {
      raw =
        evidence.details !== undefined &&
        new TextEncoder().encode(evidence.details).byteLength <= 4096
          ? JSON.parse(evidence.details)
          : undefined;
    } catch {
      raw = undefined;
    }
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
