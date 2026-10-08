import type {
  OperationOutcome,
  ProjectionPort,
  RunView,
} from "../../src/application/projection-port.js";

/** Await the same Application settlement call used by both clients. */
export async function awaitSettled(
  port: ProjectionPort,
  operationId: string,
): Promise<OperationOutcome> {
  return (await port.settledOperation(operationId)).outcome;
}

/** Follow an open `run` Projection until `pick` returns a value for the snapshot at
 *  open or a later durable update, and return it. Throws when the stream closes
 *  first, so a test that awaits a pushed fact fails rather than passing vacuously. */
export async function followRun<T>(
  port: ProjectionPort,
  runId: string,
  pick: (run: RunView) => T | undefined,
): Promise<T> {
  const view = port.openProjection({ family: "run", runId });
  try {
    const picked = (result: typeof view.snapshot.result) =>
      result.found ? pick(result.run) : undefined;
    const atOpen = picked(view.snapshot.result);
    if (atOpen !== undefined) return atOpen;
    for await (const update of view.updates) {
      if (update.kind !== "durable") continue;
      const found = picked(update.snapshot.result);
      if (found !== undefined) return found;
    }
    throw new Error(
      `run ${runId}: the Projection closed before the awaited fact`,
    );
  } finally {
    view.close();
  }
}

/** Await the Run's next rest after an interactive send. A send settles `applied` at
 *  the Turn's durable admission while the Turn is still live (#290), so a suite that
 *  reads the Turn's result follows the open `run` Projection until the Run leaves
 *  `running` — the Turn's own outcome arrives there, not on the Operation. */
export function awaitRunRest(
  port: ProjectionPort,
  runId: string,
): Promise<RunView> {
  return followRun(port, runId, (run) =>
    run.state !== "running" ? run : undefined,
  );
}
