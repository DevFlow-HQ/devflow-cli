import type {
  ApplicationEvent,
  ApplicationObserver,
} from "../application/application.js";
import { translateCause } from "../harness/harness.js";
import type { ExecutionObserver } from "../run/execution/execution.js";
import type { OperationalLog, OperationalRecord } from "./operational-log.js";
import type { LogClock } from "./wiring.js";

// The Application's facts in the operational log (#319, spec #313 stories 10–12,
// 22, 23): Harness qualification, launch preparation and Preflight with each of
// its checks as a detail checkpoint (#325), and Operation admission and
// outcome. Each event maps to an allowlisted record, its fields copied one by
// one and its cause translated here. Elapsed time is measured on
// the log's monotonic clock by pairing each start with its settlement in this
// Secant invocation. The Attempt outcomes the Application settles go to the Run
// lifecycle observer (#320), which holds those Attempts' starts.

type PreRunEvent = Exclude<ApplicationEvent, { kind: "attempt-end" }>;

/** The stage an event opens or settles, keyed so a settlement finds its start,
 *  or undefined for an event that opens no stage.
 *  Harness and Operation stages are keyed by their ids; launch preparation and
 *  Preflight are synchronous, so their names alone pair them, and a new start
 *  drops one that threw before settling. Concurrent model checks of one Harness
 *  await one cached qualification and settle in start order, so each key holds a
 *  queue. A replayed or refused admission settles nothing and opens no stage. */
function stageOf(
  event: PreRunEvent,
):
  | { readonly key: string; readonly opens: boolean; readonly sync?: true }
  | undefined {
  switch (event.kind) {
    case "qualification-start":
    case "qualification-result":
      return {
        key: `qualification:${event.harness}`,
        opens: event.kind === "qualification-start",
      };
    case "model-check-start":
    case "model-check-settle":
      return {
        key: `model-check:${event.harness}`,
        opens: event.kind === "model-check-start",
      };
    case "launch-preparation-start":
    case "launch-preparation-settle":
      return {
        key: "launch-preparation",
        opens: event.kind === "launch-preparation-start",
        sync: true,
      };
    case "preflight-start":
    case "preflight-settle":
      return {
        key: "preflight",
        opens: event.kind === "preflight-start",
        sync: true,
      };
    // A detail checkpoint reads no clock, so with detail off every other
    // record's elapsed time is unchanged.
    case "preflight-check-start":
    case "preflight-check-settle":
      return undefined;
    case "operation-admission":
      return event.admission === "admitted"
        ? { key: `operation:${event.operationId}`, opens: true }
        : undefined;
    case "operation-outcome":
      return { key: `operation:${event.operationId}`, opens: false };
  }
}

function recordOf(event: PreRunEvent): OperationalRecord {
  switch (event.kind) {
    case "qualification-start":
    case "model-check-start":
      return { event: event.kind, harness: event.harness };
    case "qualification-result": {
      const { failure } = event;
      return {
        event: event.kind,
        harness: event.harness,
        status: event.qualification,
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
      };
    }
    case "model-check-settle":
      return {
        event: event.kind,
        harness: event.harness,
        status: event.code === undefined ? "passed" : "refused",
        ...(event.code !== undefined ? { code: event.code } : {}),
      };
    case "launch-preparation-start":
    case "preflight-start":
      return { event: event.kind };
    case "launch-preparation-settle":
    case "preflight-settle":
      return settled(event.kind, event.codes);
    case "preflight-check-start":
      return { event: event.kind, check: event.check };
    case "preflight-check-settle":
      return settled(event.kind, event.codes, { check: event.check });
    case "operation-admission":
      return {
        event: event.kind,
        operationId: event.operationId,
        operation: event.operation,
        status: event.admission,
        ...(event.code !== undefined ? { code: event.code } : {}),
      };
    case "operation-outcome":
      return {
        event: event.kind,
        operationId: event.operationId,
        operation: event.operation,
        status: event.outcome,
        ...(event.code !== undefined ? { code: event.code } : {}),
      };
  }
}

/** A synchronous stage's settlement, after any naming `fields`: passed, or
 *  refused with its codes. */
function settled(
  event: string,
  codes: readonly string[],
  fields: Readonly<Record<string, string>> = {},
): OperationalRecord {
  return codes.length === 0
    ? { event, ...fields, status: "passed" }
    : { event, ...fields, status: "refused", codes: [...codes] };
}

/** The Application observer for one Secant invocation's log. */
export function applicationObserver(
  log: Pick<OperationalLog, "record">,
  clock: LogClock,
  lifecycle: ExecutionObserver,
): ApplicationObserver {
  const started = new Map<string, number[]>();
  return (event) => {
    if (event.kind === "attempt-end") {
      lifecycle(event);
      return;
    }
    const record = recordOf(event);
    const stage = stageOf(event);
    if (stage === undefined) {
      log.record(record);
      return;
    }
    const queue = started.get(stage.key) ?? [];
    if (stage.opens) {
      if (stage.sync) queue.length = 0;
      queue.push(clock.monotonic());
      started.set(stage.key, queue);
      log.record(record);
      return;
    }
    const start = queue.shift();
    if (queue.length === 0) started.delete(stage.key);
    log.record(
      start === undefined
        ? record
        : { ...record, elapsedMs: Math.round(clock.monotonic() - start) },
    );
  };
}
