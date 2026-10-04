import { z } from "zod";
import {
  agentCompletionCalls,
  flattenSteps,
  humanReviewCheckpoint,
  inHumanRepeat,
  type RoutingNode,
  type Step,
} from "../../workflow/workflow.js";
import type {
  AttemptLogEntry,
  RunOwner,
  TurnEventRecord,
} from "../store/store.js";
import { decodeAttemptId } from "./attempt-id.js";

type InteractiveEndControl =
  | "end-interactive-step"
  | "continue-repeat"
  | "end-stage"
  | "step_done"
  | "stage_done";

export type InteractiveEndLegality =
  | { readonly kind: "legal" }
  | { readonly kind: "held-for-review" }
  | {
      readonly kind: "refused";
      readonly reason:
        | "no-live-turn"
        | "call-not-enabled"
        | "mid-turn"
        | "end-step-in-human-repeat"
        | "continue-outside-human-repeat"
        | "end-stage-outside-human-repeat";
    };

/** Legality of the controls that settle an interactive Step. Callers first confirm
 *  the Run is at that Step; Turn liveness includes their own in-flight work. The
 *  Attempt log decides whether an agent Continue reaches the Review checkpoint. */
export function interactiveEndLegality({
  routing,
  step,
  control,
  turnLive,
  attemptLog,
}: {
  readonly routing: readonly RoutingNode[];
  readonly step: Pick<Step, "id">;
  readonly control: InteractiveEndControl;
  readonly turnLive: boolean;
  readonly attemptLog: readonly AttemptLogEntry[];
}): InteractiveEndLegality {
  if (control === "step_done" || control === "stage_done") {
    if (!turnLive) return { kind: "refused", reason: "no-live-turn" };
    const call = control === "step_done" ? "step" : "stage";
    const authored = flattenSteps(routing).find((s) => s.id === step.id);
    if (
      authored === undefined ||
      !agentCompletionCalls(routing, authored).includes(call)
    )
      return { kind: "refused", reason: "call-not-enabled" };
    // Stopping is never the runaway case, so stage done is never held (ADR 0032).
    const checkpoint = humanReviewCheckpoint(routing, step.id);
    if (
      control === "step_done" &&
      checkpoint !== undefined &&
      consecutiveAgentContinues(attemptLog, step.id) >= checkpoint.interval
    )
      return { kind: "held-for-review" };
    return interactiveEndLegality({
      routing,
      step,
      control:
        control === "stage_done"
          ? "end-stage"
          : checkpoint !== undefined
            ? "continue-repeat"
            : "end-interactive-step",
      turnLive: false,
      attemptLog,
    });
  }
  // A raced control reports the live Turn even when its position also mismatches.
  if (turnLive) return { kind: "refused", reason: "mid-turn" };
  const humanRepeat = inHumanRepeat(routing, step.id);
  switch (control) {
    case "end-interactive-step":
      return humanRepeat
        ? { kind: "refused", reason: "end-step-in-human-repeat" }
        : { kind: "legal" };
    case "continue-repeat":
      return humanRepeat
        ? { kind: "legal" }
        : { kind: "refused", reason: "continue-outside-human-repeat" };
    case "end-stage":
      return humanRepeat
        ? { kind: "legal" }
        : { kind: "refused", reason: "end-stage-outside-human-repeat" };
    default: {
      const exhaustive: never = control;
      return exhaustive;
    }
  }
}

/** The run of agent Continues since the person's last Continue, read from the
 *  Step's settled Iterations. Failed Attempts and other Steps neither count nor
 *  reset it; a human-controlled group holds exactly one interactive Step. */
function consecutiveAgentContinues(
  log: readonly AttemptLogEntry[],
  stepId: string,
): number {
  let count = 0;
  for (const entry of log) {
    if (
      decodeAttemptId(entry.attemptId)?.stepId !== stepId ||
      entry.outcome !== "succeeded" ||
      entry.endsStage === true
    )
      continue;
    count = entry.endedBy === "agent" ? count + 1 : 0;
  }
  return count;
}

const agentCallSchema = z.object({
  callId: z.string(),
  id: z.string(),
  reason: z
    .string()
    .max(400)
    .refine((reason) => reason.trim().length > 0),
  answer: z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("accepted") }),
    z.object({ outcome: z.literal("held-for-review") }),
    z.object({ outcome: z.literal("refused"), reason: z.string() }),
  ]),
});

/** Tolerantly read normalized call history, never Harness protocol frames. */
export function readAgentCallEvent(event: TurnEventRecord) {
  if (event.kind !== "agent-call") return undefined;
  try {
    const parsed = agentCallSchema.safeParse(JSON.parse(event.payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Only the latest call of the latest Turn can settle an open Attempt, so an
 *  earlier accepted call never outlives a later held or refused one. */
export function latestAgentCall(
  owner: Pick<RunOwner, "turns" | "turnEvents">,
  attemptId: string,
) {
  const latest = lastTurnCall(owner, attemptId);
  return latest?.call.answer.outcome === "accepted" ? latest : undefined;
}

/** The latest Turn's step done the Review checkpoint held for the person. */
export function heldAgentCall(
  owner: Pick<RunOwner, "turns" | "turnEvents">,
  attemptId: string,
) {
  const latest = lastTurnCall(owner, attemptId);
  return latest?.call.answer.outcome === "held-for-review" ? latest : undefined;
}

function isCompletionCall(
  id: string | undefined,
): id is "step_done" | "stage_done" {
  return id === "step_done" || id === "stage_done";
}

function lastTurnCall(
  owner: Pick<RunOwner, "turns" | "turnEvents">,
  attemptId: string,
) {
  const turn = owner
    .turns()
    .filter((t) => t.attemptId === attemptId)
    .at(-1);
  if (turn === undefined) return undefined;
  const events = owner.turnEvents().filter((e) => e.turnId === turn.turnId);
  const call = events
    .map(readAgentCallEvent)
    .filter((c) => c !== undefined)
    .at(-1);
  const id: string | undefined = call?.id;
  if (call === undefined || !isCompletionCall(id)) return undefined;
  if (
    events.some(
      (e) =>
        e.kind === "agent-call-expired" &&
        e.payload === JSON.stringify({ callId: call.callId }),
    )
  )
    return undefined;
  return { turn, call: { ...call, id } };
}
