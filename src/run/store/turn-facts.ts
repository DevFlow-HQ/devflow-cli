import { z } from "zod";
import {
  retainCommandOutput,
  type ToolCall,
  type TurnDiff,
  type TurnEvent,
} from "../../harness/harness.js";

// The Run Store owns the shape of every recorded Turn fact. Stored Harness evidence
// reuses the live Harness types: each schema below that records one must, less
// `historyOrder`, equal that type, so a field added to only one side fails
// type-checking here as an argument "not assignable to parameter of type 'never'".
// Readonly-ness is not part of the shape.
type Shape<T> = T extends readonly (infer E)[]
  ? Shape<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Shape<T[K]> }
    : T;
type SameShape<A, B> =
  (<T>() => T extends Shape<A> ? 1 : 2) extends <T>() => T extends Shape<B>
    ? 1
    : 2
    ? unknown
    : never;
function sameAsLive<Live>() {
  return <S extends z.ZodType>(
    schema: S & SameShape<Omit<z.output<S>, "historyOrder">, Live>,
  ): S => schema;
}

const filePatch = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unified"), content: z.string() }),
  z.object({
    kind: z.literal("structured"),
    hunks: z
      .array(
        z.object({
          oldStart: z.number().int().nonnegative(),
          oldLines: z.number().int().nonnegative(),
          newStart: z.number().int().nonnegative(),
          newLines: z.number().int().nonnegative(),
          lines: z.array(z.string()).readonly(),
        }),
      )
      .readonly(),
  }),
]);
const fileChange = z.object({
  path: z.string().min(1),
  kind: z.enum(["create", "update", "delete"]).optional(),
  patch: filePatch.optional(),
  additions: z.number().int().nonnegative().optional(),
  removals: z.number().int().nonnegative().optional(),
});
const turnDiff = sameAsLive<TurnDiff>()(
  z.object({
    content: z.string(),
    files: z.array(fileChange).readonly(),
    historyOrder: z.number().int().nonnegative().optional(),
  }),
);
const commandOutput = z.object({
  text: z.string(),
  secantDropped: z.literal(true).optional(),
  incomplete: z.literal(true).optional(),
});
const toolCall = sameAsLive<ToolCall>()(
  z.object({
    callId: z.string().min(1),
    parentCallId: z.string().optional(),
    tool: z.enum([
      "read",
      "search",
      "command",
      "file-change",
      "web",
      "mcp",
      "subagent",
      "other",
    ]),
    input: z.string(),
    files: z.array(fileChange).readonly().optional(),
    cwd: z.string().optional(),
    exitCode: z.number().int().optional(),
    nativeOmission: z.string().optional(),
    output: commandOutput.transform(retainCommandOutput).optional(),
    count: z
      .object({ value: z.number().nonnegative(), unit: z.string() })
      .optional(),
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("running") }),
      z.object({ kind: z.literal("completed") }),
      z.object({ kind: z.literal("failed"), error: z.string().optional() }),
      z.object({ kind: z.literal("declined"), reason: z.string().optional() }),
    ]),
    historyOrder: z.number().int().nonnegative().optional(),
  }),
);
const assistantMessage = z.object({
  messageId: z.string().min(1).optional(),
  historyOrder: z.number().int().nonnegative().optional(),
  content: z.string(),
  incomplete: z.literal(true).optional(),
  parentActivity: z.string().optional(),
});
const thoughtSummary = z.object({
  summaryId: z.string().min(1),
  content: z.string(),
  historyOrder: z.number().int().nonnegative().optional(),
  incomplete: z.literal(true).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
});
const deliveredSteer = z.object({
  steerId: z.string().min(1),
  historyOrder: z.number().int().nonnegative().optional(),
  text: z.string(),
  sentAt: z.string(),
  settlement: z.object({
    kind: z.literal("delivered"),
    delivery: z.enum(["within-turn", "after-boundary", "re-delivered"]),
  }),
});
const steerEvent = deliveredSteer.extend({
  sentAt: z.iso.datetime(),
  settlement: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("waiting") }),
    deliveredSteer.shape.settlement,
    z.object({
      kind: z.literal("dropped"),
      reason: z.enum(["interrupt", "loss"]),
    }),
  ]),
});

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

const model = z.object({
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
});
const toolActivity = z.object({
  tool: z.string(),
  phase: z.string().optional(),
  summary: z.string().optional(),
});
const requestRaised = z.object({
  requestId: z.string(),
  tool: z.string(),
  input: z.string().optional(),
  decisions: z.array(z.string()).readonly().optional(),
});
const requestAnswered = z.object({
  requestId: z.string(),
  by: z.string().optional(),
  decision: z.string().optional(),
});
const requestExpired = z.object({ requestId: z.string() });
const elicitationDeclined = z.object({
  harness: z.enum(["codex", "claude-code"]).optional(),
  server: z.string().optional(),
  message: z.string(),
  url: z.string().optional(),
});
const callExpired = z.object({ callId: z.string() });
const ordered = { historyOrder: z.number().int().nonnegative().optional() };
export const turnFactSchemas = {
  "assistant-content": assistantMessage,
  thought: thoughtSummary,
  "turn-diff": turnDiff,
  "tool-call": toolCall,
  "tool-partial": sameAsLive<
    Extract<TurnEvent, { kind: "tool-partial" }>["call"]
  >()(
    toolCall.extend({
      outcome: z.object({ kind: z.literal("running") }),
      output: commandOutput
        .extend({ incomplete: z.literal(true) })
        .transform((output) => ({
          ...retainCommandOutput(output),
          incomplete: output.incomplete,
        })),
    }),
  ),
  steer: steerEvent,
  model: model.extend(ordered),
  "agent-call": agentCallSchema.extend(ordered),
  "agent-call-expired": callExpired.extend(ordered),
  "tool-activity": toolActivity.extend(ordered),
  "request-raised": requestRaised.extend(ordered),
  "request-answered": requestAnswered.extend(ordered),
  "request-expired": requestExpired.extend(ordered),
  "elicitation-declined": elicitationDeclined.extend(ordered),
};
export type TurnFact = {
  [K in keyof typeof turnFactSchemas]: {
    readonly kind: K;
    readonly data: z.output<(typeof turnFactSchemas)[K]>;
  };
}[keyof typeof turnFactSchemas];
