import type {
  ObserverEnd,
  OperationSnapshot,
  Problem,
  ProjectionPort,
} from "../application/projection-port.js";

/** Await a submitted Operation's settled outcome. A Run settles asynchronously
 *  now (execution spawns), so the outcome may still be `pending` on the opened
 *  snapshot; when it is, the settled outcome arrives as the operation stream's
 *  first durable update (no sleep, no poll). A synchronous Operation is already
 *  settled and returns at once. Losing the stream never loses the Operation (#306):
 *  an `observer-lagged` end reopens the same receipt, and any other end is reported
 *  as a Problem with unknown effects rather than as the still-pending snapshot. */
export async function settledOperation(
  port: ProjectionPort,
  operationId: string,
  remediation = "Run `secant run show <run-id>` to read whether the Operation took effect.",
): Promise<OperationSnapshot> {
  for (;;) {
    const view = port.openProjection({ family: "operation", operationId });
    try {
      if (view.snapshot.outcome.status !== "pending") return view.snapshot;
      let end: ObserverEnd | undefined;
      for await (const update of view.updates) {
        if (
          update.kind === "durable" &&
          update.snapshot.outcome.status !== "pending"
        ) {
          return update.snapshot;
        }
        if (update.kind === "closed") {
          end = update.reason;
          break;
        }
      }
      // Only a lagged stream reopens; any other end, or a stream that simply
      // finished, is reported rather than reopened without bound.
      if (end !== "observer-lagged") {
        return {
          family: "operation",
          operationId,
          outcome: {
            status: "not-applied",
            problem: operationObservationEnded(operationId, end, remediation),
          },
        };
      }
    } finally {
      view.close();
    }
  }
}

function operationObservationEnded(
  operationId: string,
  reason: ObserverEnd | undefined,
  remediation: string,
): Problem {
  return {
    code: "operation-observation-ended",
    explanation: `Secant stopped reporting Operation ${operationId} before it settled (${reason ?? "stream ended"}).`,
    remediation,
    possibleEffects: "unknown",
  };
}
