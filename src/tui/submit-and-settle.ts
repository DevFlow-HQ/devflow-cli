import { createSignal, type Accessor } from "solid-js";
import type {
  OperationSnapshot,
  ObserverEnd,
  Problem,
  ProjectionPort,
  Submission,
} from "../application/projection-port.js";

// The one submit-and-settle helper the TUI's write seams share (A23): submit an
// Operation, surface a not-admitted refusal, then follow its outcome to
// settlement over the operation stream. The answer seam (run-view) and the three
// Run Actions (run-actions-view) ran three near-identical copies, each with its
// own `*NotSettled` Problem; this is their single owner. A Run settles
// asynchronously now (execution spawns; cancel-as-abort aborts a live Run), so a
// seam that read the opened snapshot and refused a still-`pending` outcome was
// wrong post-#98 — this follows the stream instead of inventing a refusal.

/** A submitted Operation as a write seam observes it: `pending` until it settles,
 *  then `applied` or `refused` (a not-admitted or not-applied Problem). */
export type SettleOutcome =
  | { readonly kind: "pending" }
  | {
      readonly kind: "applied";
      readonly modelChoiceChange?: OperationSnapshot["modelChoiceChange"];
    }
  | { readonly kind: "refused"; readonly problem: Problem };

/**
 * Submit `submission` and return a reactive outcome that starts `pending` and
 * settles once the Operation resolves. A synchronous Operation (approve-workspace,
 * delete, a cancel of a Run not live in this process) is already settled on the
 * opened snapshot; an async one (launch/resume/answer driving execution, or a
 * cancel-as-abort of a live Run) settles on the operation stream's first durable
 * update — no sleep, no poll. Recoverable observer loss reopens the same receipt;
 * shutdown or subject loss reports unknown effects. Call from an event handler; the
 * Projection closes itself once settled, so no reactive owner is required.
 */
export function submitAndSettle(
  port: ProjectionPort,
  submission: Submission,
): Accessor<SettleOutcome> {
  const [outcome, setOutcome] = createSignal<SettleOutcome>({
    kind: "pending",
  });
  const admission = port.submit(submission);
  if (!admission.admitted) {
    setOutcome({ kind: "refused", problem: admission.problem });
    return outcome;
  }
  const settle = (snapshot: OperationSnapshot): boolean => {
    const op = snapshot.outcome;
    if (op.status === "applied") {
      setOutcome({
        kind: "applied",
        ...(snapshot.modelChoiceChange === undefined
          ? {}
          : { modelChoiceChange: snapshot.modelChoiceChange }),
      });
      return true;
    }
    if (op.status === "not-applied") {
      setOutcome({ kind: "refused", problem: op.problem });
      return true;
    }
    return false;
  };
  void (async () => {
    let settled = false;
    while (!settled) {
      const opened = port.openProjection({
        family: "operation",
        operationId: admission.operationId,
      });
      if (settle(opened.snapshot)) {
        opened.close();
        break;
      }
      let end: ObserverEnd | undefined;
      for await (const update of opened.updates) {
        if (update.kind === "durable" && settle(update.snapshot)) {
          settled = true;
          break;
        }
        if (update.kind === "closed") {
          end = update.reason;
          break;
        }
      }
      opened.close();
      if (settled) break;
      // Keep the existing temporary-disconnection recovery and lag recovery;
      // terminal loss must never reopen into a shutting-down Application.
      if (end !== "observer-lagged" && end !== "temporarily-unavailable") {
        setOutcome({
          kind: "refused",
          problem: {
            code: "operation-observation-ended",
            explanation: `Secant stopped reporting Operation ${admission.operationId} before it settled (${end ?? "stream ended"}).`,
            remediation:
              "Reconnect to the Run to read whether the Operation took effect.",
            possibleEffects: "unknown",
          },
        });
        break;
      }
    }
  })();
  return outcome;
}
