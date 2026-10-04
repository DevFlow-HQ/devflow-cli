import { z } from "zod";
import {
  agentCompletionCalls,
  flattenSteps,
  inHumanRepeat,
  type RoutingNode,
  type Step,
} from "../../workflow/workflow.js";
import type { RunOwner, TurnEventRecord } from "../store/store.js";

type InteractiveEndControl =
  | "end-interactive-step"
  | "continue-repeat"
  | "end-stage"
  | "step_done"
  | "stage_done";

export type InteractiveEndLegality =
  | { readonly kind: "legal" }
  | {
      readonly kind: "refused";
      readonly reason:
        | "no-live-turn"
        | "call-not-enabled"
        | "call-not-supported"
        | "mid-turn"
        | "end-step-in-human-repeat"
        | "continue-outside-human-repeat"
        | "end-stage-outside-human-repeat";
    };

/** Legality of the controls that settle an interactive Step. Callers first confirm
 *  the Run is at that Step; Turn liveness includes their own in-flight work. */
export function interactiveEndLegality({
  routing,
  step,
  control,
  turnLive,
}: {
  readonly routing: readonly RoutingNode[];
  readonly step: Pick<Step, "id">;
  readonly control: InteractiveEndControl;
  readonly turnLive: boolean;
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
    // Agent Continue, End Stage, and checkpoint policy land together in #373.
    if (control === "stage_done" || inHumanRepeat(routing, step.id))
      return { kind: "refused", reason: "call-not-supported" };
    return interactiveEndLegality({
      routing,
      step,
      control: "end-interactive-step",
      turnLive: false,
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

const agentCallSchema = z.object({
  callId: z.string(),
  id: z.string(),
  reason: z
    .string()
    .max(400)
    .refine((reason) => reason.trim().length > 0),
  answer: z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("accepted") }),
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

/** Only the latest call of the latest Turn can settle an open Attempt. */
export function latestAgentCall(
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
  if (
    call === undefined ||
    call.answer.outcome !== "accepted" ||
    call.id !== "step_done"
  )
    return undefined;
  if (
    events.some(
      (e) =>
        e.kind === "agent-call-expired" &&
        e.payload === JSON.stringify({ callId: call.callId }),
    )
  )
    return undefined;
  return { turn, call };
}
