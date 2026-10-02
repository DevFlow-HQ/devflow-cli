import {
  translateCause,
  type CleanupReport,
  type HarnessAdapter,
  type HarnessFailure,
  type HarnessPhaseObserver,
  type PreparedHarness,
  type SafeCause,
} from "../harness/harness.js";
import type { SelectedHarnessId } from "../run/store/store.js";
import type { OperationalLog, OperationalRecord } from "./operational-log.js";

type Recorder = Pick<OperationalLog, "record">;

// The Harness half of the operational log (#322, spec #313): each Adapter's
// native-phase facts, and the `CleanupReport` and Turn usage that ADR 0041
// assigns to this log. Each record is built here from an allowlist; a failure
// keeps only its typed fields and a translated cause, never `partialOutput`,
// `diagnostics`, `retryEvidence`, or a report's `detail` (stderr may be appended
// there), and a Session's availability keeps only its state, never a recovery
// coordinate or an unusable reason.

// The records, each built field by field below:
// - `harness-phase-start`: harness, phase, and the Session key when bound to one;
// - `harness-phase-end`: those, plus status (ok, failed, abandoned), elapsedMs, and
//   on failure the failure fields;
// - `harness-cleanup`: harness, status (clean, unclean), each Session's key and
//   availability state, and on failure the failure fields;
// - `harness-usage`: harness, Session key, the estimate label, and the summary.
// The failure fields are `failurePhase` (the failure's own `FailurePhase`, distinct
// from the native `phase`), category, possibleEffects, nativeCode, and cause.

/** The record fields of an optional Session key. */
function sessionField(
  session: string | undefined,
): Readonly<Record<string, string>> {
  return session === undefined ? {} : { session };
}

/** The phase observer composition passes into `harness`'s Adapter. */
export function harnessPhaseRecorder(
  harness: SelectedHarnessId,
  log: Recorder,
): HarnessPhaseObserver {
  return (fact) => {
    const session = sessionField(fact.session);
    if (fact.kind === "phase-start") {
      log.record({
        event: "harness-phase-start",
        harness,
        phase: fact.phase,
        ...session,
      });
      return;
    }
    log.record({
      event: "harness-phase-end",
      harness,
      phase: fact.phase,
      ...session,
      status: fact.outcome,
      elapsedMs: fact.elapsedMs,
      ...(fact.outcome === "failed" ? failureFields(fact.failure) : {}),
    });
  };
}

/** `adapter` with every Harness it prepares recording its `CleanupReport` on
 *  its first close and each completed Turn's usage. Every close site, qualify,
 *  Run, and interactive driver alike, closes through this one wrapper. */
export function recordingHarness(
  adapter: HarnessAdapter,
  harness: SelectedHarnessId,
  log: Recorder,
): HarnessAdapter {
  return {
    async prepare(options) {
      const prepared = await adapter.prepare(options);
      if (!prepared.ok) return prepared;
      return {
        ok: true,
        harness: recordingPrepared(prepared.harness, harness, log),
      };
    },
  };
}

function recordingPrepared(
  prepared: PreparedHarness,
  harness: SelectedHarnessId,
  log: Recorder,
): PreparedHarness {
  let closing: Promise<CleanupReport> | undefined;
  return {
    profile: prepared.profile,
    startTurn(request) {
      const turn = prepared.startTurn(request);
      void turn.result().then(
        (result) => {
          if (result.kind !== "completed") return;
          const usage = result.detail.usage;
          if (usage === undefined) return;
          log.record({
            event: "harness-usage",
            harness,
            session: request.session,
            estimate: usage.estimate,
            summary: usage.summary,
          });
        },
        // The Turn's owner observes its result; a rejection is not this
        // recorder's to report.
        () => undefined,
      );
      return turn;
    },
    close() {
      // `close` is idempotent and returns the same report, so the report is
      // recorded once however many sites close the Harness.
      closing ??= prepared.close().then((report) => {
        log.record(cleanupRecord(report, harness));
        return report;
      });
      return closing;
    },
  };
}

function cleanupRecord(
  report: CleanupReport,
  harness: SelectedHarnessId,
): OperationalRecord {
  return {
    event: "harness-cleanup",
    harness,
    status: report.clean ? "clean" : "unclean",
    sessions: (report.sessions ?? []).map((entry) => ({
      session: entry.session,
      availability: entry.availability.state,
    })),
    ...(report.failure === undefined ? {} : failureFields(report.failure)),
  };
}

function failureFields(
  failure: HarnessFailure,
): Readonly<Record<string, string | SafeCause>> {
  return {
    failurePhase: failure.phase,
    category: failure.category,
    possibleEffects: failure.possibleEffects,
    ...(failure.nativeCode === undefined
      ? {}
      : { nativeCode: failure.nativeCode }),
    ...(failure.cause === undefined
      ? {}
      : { cause: translateCause(failure.cause) }),
  };
}
