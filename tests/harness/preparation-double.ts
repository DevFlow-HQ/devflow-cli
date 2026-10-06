import {
  translateCause,
  type createCodexAdapter,
  type HarnessAdapter,
  type HarnessFailure,
  type PreparationCleanupReport,
  type PrepareOptions,
  type PrepareResult,
  type SafeCause,
} from "../../src/harness/harness.js";

type Clock = NonNullable<
  Parameters<typeof createCodexAdapter>[0]["preparationClock"]
>;

/** The fake's invocation lifetime. Scripted pending work can outlive its report;
 * it still settles through cancellation rather than handing off success. */
export function ownPreparations(
  adapter: Pick<HarnessAdapter, "prepare">,
  clock: Clock = {
    now: () => performance.now(),
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  },
): HarnessAdapter {
  const pending = new Set<{
    readonly abort: AbortController;
    readonly result: Promise<PrepareResult>;
  }>();
  const failures: HarnessFailure[] = [];
  let closing: Promise<PreparationCleanupReport> | undefined;
  let beforeObservation = () => {};
  const cancelled = (): PrepareResult => ({
    ok: false,
    failure: {
      phase: "prepare",
      category: "preparation-cancelled",
      possibleEffects: "none",
    },
  });
  return {
    prepare(options: PrepareOptions) {
      if (closing !== undefined)
        return Promise.resolve({
          ok: false,
          failure: {
            phase: "prepare",
            category: "preparation-closed",
            possibleEffects: "none",
          },
        });
      const abort = new AbortController();
      const cancel = () => abort.abort();
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) abort.abort();
      const acquired = Promise.withResolvers<PrepareResult>();
      const scope = { abort, result: acquired.promise };
      pending.add(scope);
      const result = async () => {
        try {
          if (abort.signal.aborted) return cancelled();
          const prepared = await adapter.prepare({
            ...options,
            signal: abort.signal,
          });
          beforeObservation();
          if (!prepared.ok) {
            if (
              prepared.failure.category !== "preparation-cancelled" &&
              prepared.failure.category !== "preparation-closed"
            )
              failures.push(prepared.failure);
            return prepared;
          }
          if (!abort.signal.aborted) return prepared;
          await prepared.harness.close();
          return cancelled();
        } catch (cause) {
          beforeObservation();
          failures.push({
            phase: "prepare",
            category: "prepare-exception",
            possibleEffects: "none",
            cause,
          });
          throw cause;
        } finally {
          beforeObservation();
          pending.delete(scope);
          options.signal?.removeEventListener("abort", cancel);
        }
      };
      void result().then(acquired.resolve, acquired.reject);
      return acquired.promise;
    },
    close(options = {}) {
      if (closing !== undefined) return closing;
      const finished = Promise.withResolvers<PreparationCleanupReport>();
      closing = finished.promise;
      for (const scope of pending) scope.abort.abort();
      const deadline = options.deadline ?? clock.now() + 5000;
      let captured = false;
      let cancelTimer: (() => void) | undefined;
      const capture = () => {
        if (captured) return;
        captured = true;
        beforeObservation = () => {};
        cancelTimer?.();
        const preparations: PreparationCleanupReport["preparations"][number][] =
          failures.map((failure, index) => {
            const { cause, ...fields } = failure;
            return Object.freeze({
              preparation: index + 1,
              startupFailure: Object.freeze({
                ...fields,
                ...(cause === undefined
                  ? {}
                  : { cause: freezeCause(translateCause(cause)) }),
              }),
              cleanupFailures: Object.freeze([]),
              unresolved: Object.freeze([]),
            });
          });
        for (let index = 0; index < pending.size; index++)
          preparations.push(
            Object.freeze({
              preparation: failures.length + index + 1,
              cleanupFailures: Object.freeze([]),
              unresolved: Object.freeze([
                { kind: "preparation-pending" as const },
              ]),
            }),
          );
        finished.resolve(
          Object.freeze({
            status: pending.size > 0 ? "unresolved" : "closed",
            preparations: Object.freeze(preparations),
          }),
        );
      };
      beforeObservation = () => {
        if (clock.now() >= deadline) capture();
      };
      if (deadline <= clock.now() || pending.size === 0) capture();
      else {
        cancelTimer = clock.schedule(capture, deadline - clock.now());
        void Promise.allSettled(
          Array.from(pending, (scope) => scope.result),
        ).then(capture);
      }
      return closing;
    },
  };
}

function freezeCause(cause: SafeCause): SafeCause {
  if (cause.cause !== undefined) freezeCause(cause.cause);
  return Object.freeze(cause);
}
