import { translateCause } from "../harness/harness.js";
import type {
  ExecutionObserver,
  StoreWrite,
} from "../run/execution/execution.js";
import type { OperationalLog, OperationalRecord } from "./operational-log.js";
import type { LogClock } from "./wiring.js";

// The Run, Step Attempt, and Turn lifecycle in the operational log (#320, spec
// #313 stories 13–15, 20, 22, 29). Run execution and the Application report typed
// lifecycle facts; this maps each to an allowlisted record, copying its fields one
// by one. Elapsed time is measured here, on the log's monotonic clock: each start
// is paired with its settlement in this Secant invocation, so a settlement whose
// start an earlier Secant invocation saw (a gate answered after a reopen) carries
// none. A start with no settlement stands for the last observed stage. Run
// execution's Run Store writes are detail checkpoints (#325), unpaired: each
// start precedes its write and each end follows it, with no elapsed time.

/** The one observer both Run execution and the Application report through. */
export function runLifecycleObserver(
  log: Pick<OperationalLog, "record">,
  clock: LogClock,
): ExecutionObserver {
  const started = new Map<string, number>();
  const start = (key: string): void => {
    started.set(key, clock.monotonic());
  };
  const elapsed = (key: string): { elapsedMs?: number } => {
    const at = started.get(key);
    if (at === undefined) return {};
    started.delete(key);
    return { elapsedMs: Math.round(clock.monotonic() - at) };
  };
  const write = (record: OperationalRecord): void => log.record(record);

  return (event) => {
    const { runId } = event;
    // A store write reads no clock, so with detail off every other record's
    // elapsed time is unchanged.
    if (event.kind === "store-write-start") {
      write({ event: event.kind, runId, ...storeWriteFields(event) });
      return;
    }
    if (event.kind === "store-write-end") {
      write({
        event: event.kind,
        runId,
        ...storeWriteFields(event),
        status: event.status,
      });
      return;
    }
    if (event.kind === "turn-event-refused") {
      write({
        event: event.kind,
        runId,
        attemptId: event.attemptId,
        turnId: event.turnId,
        session: event.session,
        eventKind: event.eventKind,
        reason: event.refusal.reason,
        ...(event.refusal.reason === "unrecordable"
          ? { cause: event.refusal.safeCause }
          : {}),
      });
      return;
    }
    const run = `run:${runId}`;
    switch (event.kind) {
      case "run-start":
        start(run);
        write({ event: event.kind, runId });
        return;
      case "run-end":
        write({
          event: event.kind,
          runId,
          outcome: event.outcome,
          ...elapsed(run),
        });
        return;
      case "run-unwind":
        write({ event: event.kind, runId, ...elapsed(run) });
        return;
    }
    const { attemptId } = event;
    const attempt = `attempt:${runId}:${attemptId}`;
    switch (event.kind) {
      case "attempt-start":
        start(attempt);
        write({ event: event.kind, runId, attemptId });
        return;
      // A pause is no settlement: the Attempt stays open until the Application
      // settles it.
      case "attempt-pause":
        write({ event: event.kind, runId, attemptId });
        return;
      case "attempt-end":
        write({
          event: event.kind,
          runId,
          attemptId,
          outcome: event.outcome,
          ...elapsed(attempt),
        });
        return;
      case "attempt-unwind":
        write({ event: event.kind, runId, attemptId, ...elapsed(attempt) });
        return;
    }
    const { turnId, session } = event;
    const turn = `turn:${runId}:${turnId}`;
    if (event.kind === "turn-start") {
      start(turn);
      write({ event: event.kind, runId, attemptId, turnId, session });
      return;
    }
    const { failure } = event;
    write({
      event: event.kind,
      runId,
      attemptId,
      turnId,
      session,
      result: event.result,
      ...(failure !== undefined
        ? {
            phase: failure.phase,
            category: failure.category,
            possibleEffects: failure.possibleEffects,
            ...(failure.nativeCode !== undefined
              ? { nativeCode: failure.nativeCode }
              : {}),
            ...(failure.cause !== undefined
              ? { cause: translateCause(failure.cause) }
              : {}),
          }
        : {}),
      ...elapsed(turn),
    });
  };
}

/** A store write's kind and ids, copied one by one. */
function storeWriteFields(write: StoreWrite): Readonly<Record<string, string>> {
  switch (write.write) {
    case "run-state":
      return { write: write.write, state: write.state };
    case "attempt-publish":
      return {
        write: write.write,
        attemptId: write.attemptId,
        ...(write.state !== undefined ? { state: write.state } : {}),
      };
    case "pending-gate":
      return { write: write.write, attemptId: write.attemptId };
    case "materialization-conflict":
      return { write: write.write };
    case "turn-admission":
    case "turn-settlement":
      return {
        write: write.write,
        attemptId: write.attemptId,
        turnId: write.turnId,
      };
  }
}
