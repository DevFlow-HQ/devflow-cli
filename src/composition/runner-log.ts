import type { ProcessAdapterOptions } from "../process/process.js";
import {
  runSecantInvocation,
  type OperationalLog,
  type OperationalRecord,
} from "./operational-log.js";
import { processObserver } from "./process-observer.js";
import type { WiringOverrides } from "./wiring.js";

// A standalone runner program's operational log (#326, spec #313 story 54).
// Runtime conformance and terminal lifecycle are test programs, not clients, but
// a maintainer reading a failed job's artifact needs their scenario and stage
// lifecycle beside the child facts. Each runs as one Secant invocation of the
// `runner` client under the same sink, and its breadcrumbs become records here,
// field by field, as every other observer's facts do.

/** One scenario or stage lifecycle step a runner program reports. Names are the
 *  program's own scenario and stage labels; `elapsedMs` is the runner's own
 *  measure since the matching start. */
export type RunnerBreadcrumb =
  | { readonly kind: "scenario-start"; readonly scenario: string }
  | {
      readonly kind: "scenario-end";
      readonly scenario: string;
      readonly status: "passed" | "failed";
      readonly elapsedMs: number;
    }
  | {
      readonly kind: "stage-start";
      readonly scenario: string;
      readonly stage: string;
    }
  | {
      readonly kind: "stage-end";
      readonly scenario: string;
      readonly stage: string;
      readonly status: "passed" | "failed";
      readonly elapsedMs: number;
    };

/** A runner program's view of its Secant invocation's log. */
export interface RunnerLog {
  breadcrumb(breadcrumb: RunnerBreadcrumb): void;
  /** The Process factory options that report each child fact to this log. */
  readonly processOptions: ProcessAdapterOptions;
}

/** Runs `program` as one Secant invocation of the `runner` client, writing to
 *  the sink `logSink` names. The runner chooses the folder: it reads the
 *  inherited log folder itself, since its own temp folders are removed. */
export function runRunnerInvocation(
  program: string,
  logSink: NonNullable<WiringOverrides["logSink"]>,
  body: (log: RunnerLog) => Promise<number>,
): Promise<number> {
  return runSecantInvocation("runner", { logSink }, (log) =>
    body(runnerLog(log, program)),
  );
}

function runnerLog(log: OperationalLog, program: string): RunnerLog {
  return {
    breadcrumb: (breadcrumb) =>
      log.record(breadcrumbRecord(program, breadcrumb)),
    processOptions: processObserver(log),
  };
}

function breadcrumbRecord(
  program: string,
  breadcrumb: RunnerBreadcrumb,
): OperationalRecord {
  const record: Record<string, string | number> = {
    program,
    scenario: breadcrumb.scenario,
  };
  if (breadcrumb.kind === "stage-start" || breadcrumb.kind === "stage-end") {
    record.stage = breadcrumb.stage;
  }
  if (breadcrumb.kind === "scenario-end" || breadcrumb.kind === "stage-end") {
    record.status = breadcrumb.status;
    record.elapsedMs = Math.round(breadcrumb.elapsedMs);
  }
  return { event: `runner-${breadcrumb.kind}`, ...record };
}
