// One timed native phase, private to the Harness Module (#322). Both native
// Adapters open a span where a phase starts and settle it once where it ends;
// the span emits the start and end facts the optional phase observer receives,
// measuring elapsed time on the monotonic clock.

import type {
  CleanupReport,
  HarnessFailure,
  HarnessPhase,
  HarnessPhaseFact,
  HarnessPhaseObserver,
} from "./harness.js";

/** An open phase. Only its first settlement is reported. */
export interface PhaseSpan {
  ok(): void;
  failed(failure: HarnessFailure): void;
  abandoned(): void;
}

/** Report `phase` started, for `session` when the phase is bound to one, and
 *  return the span that settles it. With no observer, nothing is reported. */
export function startPhase(
  observer: HarnessPhaseObserver | undefined,
  phase: HarnessPhase,
  session?: string,
): PhaseSpan {
  const key = session === undefined ? { phase } : { phase, session };
  const started = performance.now();
  report(observer, { kind: "phase-start", ...key });
  let settled = false;
  const end = (
    outcome:
      | { readonly outcome: "ok" | "abandoned" }
      | { readonly outcome: "failed"; readonly failure: HarnessFailure },
  ) => {
    if (settled) return;
    settled = true;
    report(observer, {
      kind: "phase-end",
      ...key,
      elapsedMs: Math.round(performance.now() - started),
      ...outcome,
    });
  };
  return {
    ok: () => end({ outcome: "ok" }),
    failed: (failure) => end({ outcome: "failed", failure }),
    abandoned: () => end({ outcome: "abandoned" }),
  };
}

/** Settle a cleanup span from the report `close` returns: `failed` with the
 *  report's failure when it carries one, `ok` otherwise. */
export function settleCleanup(span: PhaseSpan, report: CleanupReport): void {
  if (report.failure === undefined) span.ok();
  else span.failed(report.failure);
}

/** Deliver one fact, ignoring an observer that throws. */
function report(
  observer: HarnessPhaseObserver | undefined,
  fact: HarnessPhaseFact,
): void {
  try {
    observer?.(fact);
  } catch {
    // Observation never changes a Harness outcome.
  }
}
