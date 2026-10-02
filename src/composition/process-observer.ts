import type { ChildFact, ProcessAdapterOptions } from "../process/process.js";
import type { OperationalLog, OperationalRecord } from "./operational-log.js";

// The Process Module's observer (#321, spec #313 stories 18–19): each child fact
// becomes one operational-log record, its fields copied one by one. A fact holds
// only its role, PID, status or signal, native code, and elapsed time, so nothing
// here can carry an argument, environment value, or output. `childPid` sits
// beside the invocation-start `pid`, which is the Secant process's own. Process
// measures elapsed time itself: a synchronous start has no PID to pair on here.

/** The Process factory options that report every child fact to `log`. */
export function processObserver(
  log: Pick<OperationalLog, "record">,
): ProcessAdapterOptions {
  return { observeChild: (fact) => log.record(childRecord(fact)) };
}

function childRecord(fact: ChildFact): OperationalRecord {
  const record: Record<string, string | number> = {
    event: `child-${fact.kind}`,
    childRole: fact.role,
  };
  if ("pid" in fact && fact.pid !== undefined) record.childPid = fact.pid;
  if (fact.kind === "spawn-error" && fact.code !== undefined) {
    record.code = fact.code;
  }
  if (fact.kind === "exit" || fact.kind === "reap") {
    if (fact.status !== undefined) record.exitStatus = fact.status;
    if (fact.signal !== undefined) record.signal = fact.signal;
  }
  if ("elapsedMs" in fact) record.elapsedMs = Math.round(fact.elapsedMs);
  return { event: `child-${fact.kind}`, ...record };
}
