import type {
  ExecutionEvent,
  TurnFailureFacts,
} from "../run/execution/execution.js";
import type {
  HarnessQualificationView,
  Problem,
  Submission,
} from "./projection-port.js";

// The Application observer (#319, #320, spec #313): the semantic stages the
// Application alone observes, before a Run exists and as it rests Runs or
// settles Attempts, reported so a refused launch, a "not ready" Harness, and every Operation leave
// evidence. Composition turns each event into an operational-log record, the
// sink picks its level, and a cause is translated when it is written; the
// Application never depends on the logger.
//
// Events carry only semantic values: Operation ids and kinds, Harness ids,
// Qualification states, Problem codes, and typed failure fields. No Submission or
// launch input, Turn text, Problem prose, diagnostics, or retry evidence crosses.
// A start with no settlement stands for the last stage Application reached.

/** Problem codes in the order the stage found them; empty when it passed. */
type ProblemCodes = readonly string[];

/** The codes a stage settlement reports; never the Problems' prose or details. */
export function problemCodes(problems: readonly Problem[]): ProblemCodes {
  return problems.map((problem) => problem.code);
}

/** One of Preflight's ordered checks, named for the detail checkpoint each
 *  reports (#325). */
export type PreflightCheck =
  | "composition"
  | "interactive"
  | "harness"
  | "inputs"
  | "workspace-prerequisites"
  | "commands";

export type ApplicationEvent =
  /** The same `attempt-end` Run execution reports, for the Step Attempts the
   *  Application settles: an answered authored gate, an ended interactive Step
   *  (#320). */
  | Extract<ExecutionEvent, { kind: "attempt-end" }>
  /** A rest committed by Application itself, outside a Routing walk. */
  | {
      readonly kind: "run-rest";
      readonly runId: string;
      readonly outcome: "cancelled" | "failed" | "halted" | "blocked";
    }
  /** An uncached qualification began; a cached read qualifies nothing. */
  | { readonly kind: "qualification-start"; readonly harness: string }
  | {
      readonly kind: "qualification-result";
      readonly harness: string;
      readonly qualification: Exclude<
        HarnessQualificationView["state"],
        "not-checked"
      >;
      readonly failure?: TurnFailureFacts;
    }
  /** The creation-free launch checks, shared by a launch and its assessment. */
  | { readonly kind: "launch-preparation-start" }
  | { readonly kind: "launch-preparation-settle"; readonly codes: ProblemCodes }
  | { readonly kind: "preflight-start" }
  | { readonly kind: "preflight-settle"; readonly codes: ProblemCodes }
  /** One Preflight check, a detail checkpoint: the start precedes its
   *  synchronous probes, so a hang names the check. A short-circuited check
   *  reports nothing. */
  | { readonly kind: "preflight-check-start"; readonly check: PreflightCheck }
  | {
      readonly kind: "preflight-check-settle";
      readonly check: PreflightCheck;
      readonly codes: ProblemCodes;
    }
  /** The assessment's requested-model check against the selected Harness. */
  | { readonly kind: "model-check-start"; readonly harness: string }
  | {
      readonly kind: "model-check-settle";
      readonly harness: string;
      readonly code?: string;
    }
  /** Every submission: admitted, a replay of an admitted id, or refused. */
  | {
      readonly kind: "operation-admission";
      readonly operationId: string;
      readonly operation: Submission["operation"];
      readonly runId?: string;
      readonly admission: "admitted" | "replayed" | "not-admitted";
      readonly code?: string;
    }
  /** An admitted Operation's one settlement. */
  | {
      readonly kind: "operation-outcome";
      readonly operationId: string;
      readonly operation: Submission["operation"];
      readonly runId?: string;
      readonly outcome: "applied" | "not-applied";
      readonly code?: string;
    };

/** Receives each event synchronously: a start before the work it names, a
 *  settlement or result once that work is done. The Module guards delivery, so
 *  an observer never throws into its caller. */
export type ApplicationObserver = (event: ApplicationEvent) => void;

/** The default when a caller wires no observer: reports nowhere. */
const NO_APPLICATION_OBSERVER: ApplicationObserver = () => {};

/** Resolve and guard the observer once for all Application event delivery. */
export function guardedApplicationObserver(
  observer: ApplicationObserver | undefined,
): ApplicationObserver {
  if (observer === undefined) return NO_APPLICATION_OBSERVER;
  return (event) => {
    try {
      observer(event);
    } catch {
      // Observation never changes an Application outcome.
    }
  };
}
