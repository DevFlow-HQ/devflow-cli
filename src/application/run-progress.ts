import { waitingAgentTurn } from "../run/store/store.js";
import type {
  AttemptLogEntry,
  GateAnswerRecord,
  PendingGateRecord,
  RunOwner,
  TurnRecord,
} from "../run/store/store.js";
import { attemptIteration, attemptStepId } from "../run/execution/execution.js";
import {
  flattenSteps,
  MAX_REVIEW_CHECKPOINT_INTERVAL,
  type RepeatGroup,
  type RoutingNode,
  type Step,
} from "../workflow/workflow.js";
import type {
  RunCheckpointView,
  RunPendingGateView,
  RunStateName,
  RunStepProgress,
  RunStepStatus,
  RunTimelineEvent,
} from "./projection-port.js";

// Run progress (#384): which authored Step and Iteration each stored Attempt
// belongs to, and from that the current Step, the Repeat Iterations, and the one
// interaction the Run waits on — an authored Human Gate, a derived Review
// checkpoint, or a held Step. The `run` Projection and the Application controls
// that admit Gate answers, human Turns, and held-Step adoption all read this one
// derivation. It reads the Run's stored facts through a read-only owner and owns
// no lifetime, tracking, abort, or observation.

/** The stored Run facts progress reads. The caller owns the owner's lifetime. */
type RunProgressSource = Pick<
  RunOwner,
  | "attemptLog"
  | "gateAnswers"
  | "pendingGate"
  | "turns"
  | "currentVersion"
  | "readArtifact"
>;

/** Why a `blocked` Run holds its current Step for the human, with no gate or
 *  checkpoint (#122, #354): an interactive-agent Step between Turns, or an Agent
 *  Step whose open Attempt an Interrupt left waiting — execution's Attempt-level
 *  basis, on that Step. Its single-derivation rule is run-control's. */
export type HoldBasis =
  | { readonly kind: "interactive"; readonly step: RunStepProgress }
  | {
      readonly kind: "follow-up";
      readonly step: RunStepProgress;
      readonly turn: TurnRecord;
    };

/** One completed Repeat-group Iteration on the timeline, with the log index of the
 *  Attempt that completed it, so an equal-instant sort keeps the mark beside that
 *  Attempt rather than after the next Step's events (#289). */
export interface IterationMark {
  readonly event: RunTimelineEvent;
  readonly logIndex: number;
}

interface DerivedRun {
  /** The effective state, including the `blocked` a checkpoint pause derives from
   *  the attempt log here (execution also stores `blocked` durably, so a killed Run
   *  reconciles blocked; this derivation supplies the checkpoint facts). */
  readonly state: RunStateName;
  readonly statuses: RunStepProgress[];
  readonly position: number;
  /** One mark per completed Iteration of every Repeat group. */
  readonly iterationEvents: readonly IterationMark[];
  /** The Review checkpoint facts, present only when the state derives to `blocked`
   *  at a derived Review checkpoint. */
  readonly checkpoint?: RunCheckpointView;
  /** The checkpointed group's completed Iterations: the reset point a checkpoint
   *  answer records (`iterationsAtGrant`), present exactly with `checkpoint`. */
  readonly checkpointIterations?: number;
  /** The authored Human Gate facts, present only when the state is `blocked` at an
   *  authored `human-gate` Step (#108). A blocked Run derives exactly one of
   *  `checkpoint` or `pendingGate`. */
  readonly pendingGate?: RunPendingGateView;
  /** The interrupted Agent Turn waiting on the current Step, whatever the state. */
  readonly waitingTurn?: TurnRecord;
  /** Why a `blocked` Run holds its current Step for the human. */
  readonly hold?: HoldBasis;
}

/** One (Step, Iteration) instance's attributed Attempts. Execution runs an
 *  instance's retries until one succeeds, so it has at most one success. */
interface Instance {
  succeeded?: SucceededAttempt;
  endsStage: boolean;
}

/** A succeeded Attempt and its place in the log. */
interface SucceededAttempt {
  readonly entry: AttemptLogEntry;
  readonly logIndex: number;
}

/** Each stored Attempt attributed to its authored Step and Iteration by its id
 *  (Run execution's codec). A reconciliation marker names no Step, so it is no
 *  Step's Attempt — neither a success nor evidence of progress. */
interface Attribution {
  /** Whether any Attempt names this Step, in any Iteration. */
  attempted(stepId: string): boolean;
  /** Whether any Attempt names this Step instance. */
  started(stepId: string, iteration: number): boolean;
  succeeded(stepId: string, iteration: number): SucceededAttempt | undefined;
  endsStage(stepId: string, iteration: number): boolean;
}

function attribute(log: readonly AttemptLogEntry[]): Attribution {
  const instances = new Map<string, Map<number, Instance>>();
  log.forEach((entry, logIndex) => {
    const stepId = attemptStepId(entry.attemptId);
    const iteration = attemptIteration(entry.attemptId);
    if (stepId === undefined || iteration === undefined) return;
    const byIteration = instances.get(stepId) ?? new Map<number, Instance>();
    instances.set(stepId, byIteration);
    const instance = byIteration.get(iteration) ?? { endsStage: false };
    byIteration.set(iteration, instance);
    if (entry.outcome === "succeeded" && instance.succeeded === undefined) {
      instance.succeeded = { entry, logIndex };
    }
    if (entry.endsStage === true) instance.endsStage = true;
  });
  const instance = (stepId: string, iteration: number) =>
    instances.get(stepId)?.get(iteration);
  return {
    attempted: (stepId) => instances.has(stepId),
    started: (stepId, iteration) => instance(stepId, iteration) !== undefined,
    succeeded: (stepId, iteration) => instance(stepId, iteration)?.succeeded,
    endsStage: (stepId, iteration) =>
      instance(stepId, iteration)?.endsStage === true,
  };
}

/** A Repeat group's completed Iterations: execution runs them in order from zero,
 *  so they are the prefix in which every span Step succeeded. Each names the last
 *  span Step's succeeding Attempt, the one that completed it. */
function completedIterations(
  span: readonly Step[],
  attribution: Attribution,
): SucceededAttempt[] {
  const completed: SucceededAttempt[] = [];
  for (let iteration = 0; ; iteration++) {
    let last: SucceededAttempt | undefined;
    for (const step of span) {
      last = attribution.succeeded(step.id, iteration);
      if (last === undefined) return completed;
    }
    // An empty span (Composition rejects one) completes nothing.
    if (last === undefined) return completed;
    completed.push(last);
  }
}

/**
 * Derive per-Step progress, the effective Run state, the per-Iteration timeline,
 * and the interaction the Run waits on, from the Routing and the stored Attempts
 * (ADR 0020, #84, #384). Every Attempt id names its Step and Iteration, so a Step
 * succeeded exactly when its instance has a succeeded Attempt, and a Repeat group's
 * Iterations are its own Steps' instances — a later node's Attempts are never
 * another Iteration. Execution walks nodes in order and leaves one only once it
 * completes, so the current Step is the first incomplete one. The `blocked`
 * checkpoint facts are re-derived here from the group's Attempts, the `until`
 * Verdict binding, and the group's own Gate answers; execution also stores
 * `blocked` durably (a killed Run reconciles blocked).
 */
export function deriveRun(
  routing: readonly RoutingNode[],
  state: string,
  runId: string,
  run: RunProgressSource | undefined,
): DerivedRun {
  const log = run?.attemptLog() ?? [];
  const attribution = attribute(log);
  const pending = run?.pendingGate();
  const waiting = run !== undefined ? waitingAgentTurn(run) : undefined;
  const waitingStepId =
    waiting === undefined ? undefined : attemptStepId(waiting.attemptId);
  const iterations = new Map(
    routing.flatMap((node) =>
      "repeat" in node
        ? [[node, completedIterations(node.repeat.steps, attribution)] as const]
        : [],
    ),
  );
  const walked = walk({
    routing,
    state,
    runId,
    attribution,
    iterations,
    pending,
    waitingStepId,
    gateAnswers: run?.gateAnswers() ?? [],
    verdict: (name) => {
      const versionId = run?.currentVersion(name);
      if (run === undefined || versionId === undefined) return undefined;
      const bytes = run.readArtifact(versionId, name);
      return {
        versionId,
        value:
          bytes === undefined ? undefined : new TextDecoder().decode(bytes),
      };
    },
  });
  const iterationEvents = [...iterations.values()].flatMap((completed) =>
    completed.map(({ entry, logIndex }, iteration) => ({
      event: {
        at: entry.at,
        event: "iteration" as const,
        detail: String(iteration + 1),
      },
      logIndex,
    })),
  );
  const current = walked.statuses[walked.position];
  const waitingTurn =
    current !== undefined && waitingStepId === current.id ? waiting : undefined;
  const derived = { ...walked, iterationEvents, waitingTurn };
  const hold = holdOf(derived);
  return hold === undefined ? derived : { ...derived, hold };
}

function holdOf(derived: Omit<DerivedRun, "hold">): HoldBasis | undefined {
  if (
    derived.state !== "blocked" ||
    derived.checkpoint !== undefined ||
    derived.pendingGate !== undefined
  ) {
    return undefined;
  }
  const step = derived.statuses[derived.position];
  if (step?.kind === "interactive-agent") return { kind: "interactive", step };
  return step?.kind === "agent" && derived.waitingTurn !== undefined
    ? { kind: "follow-up", step, turn: derived.waitingTurn }
    : undefined;
}

interface WalkInput {
  readonly routing: readonly RoutingNode[];
  readonly state: string;
  readonly runId: string;
  readonly attribution: Attribution;
  /** Each Repeat group's completed Iterations. */
  readonly iterations: ReadonlyMap<RoutingNode, readonly SucceededAttempt[]>;
  readonly pending: PendingGateRecord | undefined;
  readonly waitingStepId: string | undefined;
  readonly gateAnswers: readonly GateAnswerRecord[];
  readonly verdict: (
    name: string,
  ) => { readonly versionId: string; readonly value?: string } | undefined;
}

type WalkedProgress = Omit<
  DerivedRun,
  "iterationEvents" | "waitingTurn" | "hold"
>;

function walk(input: WalkInput): WalkedProgress {
  const { routing, state, attribution } = input;
  const steps = flattenSteps(routing);
  const statuses: RunStepProgress[] = steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    status: "pending",
  }));
  const flatIndex = new Map<Step, number>();
  steps.forEach((step, index) => flatIndex.set(step, index));
  const mark = (step: Step, status: RunStepStatus): void => {
    const index = flatIndex.get(step)!;
    statuses[index] = { ...statuses[index]!, status };
  };
  const at = (step: Step): number => flatIndex.get(step)!;

  // A rested `succeeded` Run: every Step ran to completion (a zero-Iteration
  // group's Steps included), so progress is taken from the terminal state.
  if (state === "succeeded") {
    for (const step of steps) mark(step, "succeeded");
    return { state: "succeeded", statuses, position: steps.length };
  }

  // The status of the Step the Run rests at: a failed Run's current Step failed; a
  // running Run's is running; a `halted` Run's (a Materialization conflict, #88) or
  // a durably `blocked` Run's (an authored Human Gate whose facts we cannot read
  // here because the owner is absent — a Run live in another process, #108) current
  // Step is blocked; a `created` Run has not started, so its Steps stay pending.
  const stalledStatus: RunStepStatus =
    state === "failed"
      ? "failed"
      : state === "running"
        ? "running"
        : state === "halted" || state === "blocked"
          ? "blocked"
          : "pending";
  const rest = (step: Step, status: RunStepStatus): WalkedProgress => {
    mark(step, status);
    return { state: toRunState(state), statuses, position: at(step) };
  };

  // The furthest node the Run demonstrably reached: an Attempt names one of its
  // Steps, or its authored Gate is pending. Every earlier node completed.
  const nodeSteps = routing.map((node) =>
    "repeat" in node ? node.repeat.steps : [node],
  );
  let furthest = -1;
  nodeSteps.forEach((span, index) => {
    if (
      span.some(
        (step) =>
          attribution.attempted(step.id) ||
          input.pending?.stepId === step.id ||
          input.waitingStepId === step.id,
      )
    ) {
      furthest = index;
    }
  });

  for (const [index, node] of routing.entries()) {
    if (!("repeat" in node)) {
      if (attribution.succeeded(node.id, 0) !== undefined) {
        mark(node, "succeeded");
        continue;
      }
      // An authored Human Gate the Run rests at: `blocked` durably (a pending_gate
      // record whose producing Attempt has not settled), distinct from a derived
      // Review checkpoint (#108). Its facts come from the durable record.
      const pending =
        node.kind === "human-gate" &&
        state === "blocked" &&
        input.pending?.stepId === node.id
          ? input.pending
          : undefined;
      if (pending !== undefined) {
        mark(node, "blocked");
        return {
          state: "blocked",
          statuses,
          position: at(node),
          pendingGate: pendingGateView(input.runId, pending),
        };
      }
      return rest(node, stalledStatus);
    }

    const span = node.repeat.steps;
    const completed = input.iterations.get(node)!;
    const next = completed.length;
    // Earlier Iterations ran every span Step.
    if (next > 0) for (const step of span) mark(step, "succeeded");
    // The next Iteration started: the group is current, at its first span Step
    // without a success in that Iteration. (An authored Human Gate cannot appear
    // in a Repeat span — Composition rejects that, #108.)
    if (span.some((step) => attribution.started(step.id, next))) {
      const stalled = span.find(
        (step) => attribution.succeeded(step.id, next) === undefined,
      )!;
      for (const step of span) {
        if (step === stalled) break;
        mark(step, "succeeded");
      }
      return rest(stalled, stalledStatus);
    }
    // The group ended: a later node was reached, a confirmed End Stage (#218)
    // closed its last Iteration, or its `until` Verdict passes — before entry (zero
    // Iterations) or after the last one, while the next node has no Attempt yet
    // (an authored Human Gate has none until answered).
    const until = "until" in node.repeat ? node.repeat.until : undefined;
    const ended =
      furthest > index ||
      (next > 0 &&
        span.some((step) => attribution.endsStage(step.id, next - 1))) ||
      (until !== undefined && input.verdict(until)?.value === "pass");
    if (ended) {
      for (const step of span) mark(step, "succeeded");
      continue;
    }
    if (next === 0) return rest(span[0]!, stalledStatus);
    return finishTerminalGroup(input, node.repeat, completed, rest);
  }
  // Every node completed with the Run not yet rested: it is between Steps (a
  // transient running snapshot).
  return { state: toRunState(state), statuses, position: steps.length };
}

/** Finish a Repeat group the Run rests in between Iterations: derive `blocked`
 *  when the review cadence is reached without a pass, else leave it running. */
function finishTerminalGroup(
  input: WalkInput,
  repeat: RepeatGroup["repeat"],
  completed: readonly SucceededAttempt[],
  rest: (step: Step, status: RunStepStatus) => WalkedProgress,
): WalkedProgress {
  const { state } = input;
  const span = repeat.steps;
  const current = span[span.length - 1]!;
  // A human-controlled Repeat (#217) never raises the Verdict-driven Gate: Continue
  // is each iteration's review, so only the interactive pause below can rest it. Its
  // agent-Continue checkpoint surfaces as `heldForReview`, read from the held call.
  if ("until" in repeat) {
    const interval = Math.min(
      repeat.reviewCheckpoint.interval,
      MAX_REVIEW_CHECKPOINT_INTERVAL,
    );
    // Iterations since this group's last grant: a `continue` grant resets the
    // count, so one grant buys exactly one more interval (ADR 0020, #85). A grant
    // answers a Gate on one of the group's own Steps; before any, the offset is zero.
    const grants = input.gateAnswers.filter((answer) =>
      span.some((step) => step.id === attemptStepId(answer.gateAttemptId)),
    );
    const iterations = completed.length;
    const sinceGrant = iterations - (grants.at(-1)?.iterationsAtGrant ?? 0);
    const verdict = input.verdict(repeat.until);
    // Blocked: the cadence is reached since the last grant, the Verdict does not
    // pass (a pass ended the group), and the Run has not failed. The Gate names the
    // Attempt that completed the latest Iteration.
    if (state !== "failed" && verdict !== undefined && sinceGrant >= interval) {
      const { statuses, position } = rest(current, "blocked");
      return {
        state: "blocked",
        statuses,
        position,
        checkpoint: {
          message: repeat.reviewCheckpoint.message,
          interval,
          completedIterations: sinceGrant,
          latestVerdict: {
            name: repeat.until,
            // Normalize the value actually read (M2 Verdicts are pass/fail).
            value: verdict.value === "pass" ? "pass" : "fail",
            reference: {
              runId: input.runId,
              artifactName: repeat.until,
              versionId: verdict.versionId,
              type: "verdict",
            },
          },
          gate: {
            runId: input.runId,
            stepId: current.id,
            attemptId: completed.at(-1)!.entry.attemptId,
            shape: "approve-reject",
          },
        },
        checkpointIterations: iterations,
      };
    }
  }

  // Short of the cadence but resting `blocked` or `halted` with an interactive
  // first span Step: the next iteration opened on it and it awaits Turns without
  // an Attempt (#216). An Agent first span Step an Interrupt holds open waits the
  // same way (#354).
  if (
    (state === "blocked" || state === "halted") &&
    (span[0]!.kind === "interactive-agent" ||
      input.waitingStepId === span[0]!.id)
  ) {
    return rest(span[0]!, "blocked");
  }
  // Not blocked: the loop is still short of its cadence (a live mid-loop snapshot),
  // or the Run failed on the last span Step.
  return rest(current, state === "failed" ? "failed" : "running");
}

/** The `run` Projection view of an authored pending Human Gate (#108): the durable
 *  record's message and free-text output, plus the exact Gate reference a client
 *  answers against (the producing Attempt id). */
function pendingGateView(
  runId: string,
  pending: PendingGateRecord,
): RunPendingGateView {
  return {
    gate: {
      runId,
      stepId: pending.stepId,
      attemptId: pending.attemptId,
      shape: pending.shape,
    },
    message: pending.message,
    ...(pending.outputArtifactName !== undefined
      ? { outputArtifactName: pending.outputArtifactName }
      : {}),
    ...(pending.suggestions !== undefined
      ? { suggestions: pending.suggestions }
      : {}),
  };
}

/** Map a stored/tracked canonical state to the client vocabulary (#98 A7). The
 *  retired `created` reads as `running` — a launched Run is observed running from
 *  the moment it is admitted — and every other stored state is already one of
 *  RunStateName. */
function toRunState(state: string): RunStateName {
  switch (state) {
    case "running":
    case "blocked":
    case "succeeded":
    case "failed":
    case "halted":
    case "cancelled":
      return state;
    default:
      return "running";
  }
}
