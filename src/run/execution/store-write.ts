import type { ExecutionObserver, StoreWrite } from "./execution.js";

/** Runs one of execution's own Run Store writes between its start and end
 *  events (#325) and returns the owner's result unchanged. A write that throws
 *  reports only its start, which names the last stage reached. */
export function observedWrite<R extends { readonly ok: boolean }>(
  observe: ExecutionObserver,
  runId: string,
  write: StoreWrite,
  commit: () => R,
): R {
  observe({ kind: "store-write-start", runId, ...write });
  const result = commit();
  observe({
    kind: "store-write-end",
    runId,
    ...write,
    status: result.ok ? "committed" : "refused",
  });
  return result;
}
