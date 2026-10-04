// The Claude Code stream-json protocol model — private to the Claude Code Adapter
// (#127 D1, A30). Every frame another vendor's CLI writes on stdout is read here
// and nowhere else: each known frame type has one schema, parsed per frame, and
// the pure readers below turn a parsed frame into Secant's own event facts. The
// Adapter body (`claude-code.ts`) dispatches on the parsed frame and mutates Turn
// state; it never touches a raw field.
//
// Parsing is deliberately lenient, exactly as the hand-rolled readers were: an
// unknown frame type, or a known type whose parse fails, is reported as generic
// activity and is never protocol corruption. Only the fields dispatch iterates
// over are structurally required (a message's content array, a stream event's
// object); every other field falls back to "absent" when its type is not the
// expected one (`.catch(undefined)`), so a new or reshaped field in a future
// Claude Code degrades one fact rather than the Turn. Unknown fields pass
// through (`looseObject`) so the readers keep seeing the whole frame.

import { z } from "zod";
import type {
  RecoveryCoordinate,
  SessionFacts,
  TurnEvent,
  UsageObservation,
} from "../harness.js";

// --- Schemas -----------------------------------------------------------------

export const ClaudeEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** A string-valued field that is absent when missing or of another type. */
const lenientString = z.string().optional().catch(undefined);

/** A list of strings that keeps only its string entries, and is empty when
 *  missing or of another type. */
const lenientStrings = z
  .array(z.unknown())
  .optional()
  .catch(undefined)
  .transform((values) =>
    (values ?? []).filter(
      (value): value is string => typeof value === "string",
    ),
  );

/** `system` / `init`: the per-process handshake echoing the Session id. */
const InitFrame = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: lenientString,
  model: lenientString,
  /** The Session's commands by bare name (`compact`), #359. */
  slash_commands: lenientStrings,
});
export type InitFrame = z.infer<typeof InitFrame>;

/** One block of an `assistant` or `user` message. Every field is lenient: a
 *  block whose fields are not the expected type is simply a block without them,
 *  and dispatch skips it the way the untyped reader did. */
const ContentBlock = z.looseObject({
  type: lenientString,
  text: lenientString,
  name: lenientString,
  id: lenientString,
  tool_use_id: lenientString,
  input: z.unknown(),
  content: z.unknown(),
});
export type ContentBlock = z.infer<typeof ContentBlock>;

/** `assistant` and `user` frames share one shape: a message whose content is a
 *  block array. The array is the one structural requirement. */
const MessageFrame = z.looseObject({
  type: z.string(),
  message: z.looseObject({ content: z.array(z.unknown()) }),
  parent_tool_use_id: z.string().nullable().optional().catch(undefined),
});
export type MessageFrame = z.infer<typeof MessageFrame>;
const AssistantFrame = MessageFrame.extend({ type: z.literal("assistant") });
const UserFrame = MessageFrame.extend({ type: z.literal("user") });

/** `stream_event`: a partial-message event; only `text_delta` carries a preview. */
const StreamEventFrame = z.looseObject({
  type: z.literal("stream_event"),
  event: z.looseObject({
    delta: z
      .looseObject({ type: lenientString, text: lenientString })
      .optional()
      .catch(undefined),
  }),
});
export type StreamEventFrame = z.infer<typeof StreamEventFrame>;

/** `result`: the one authoritative result of a native exchange. Only the type
 *  is structural: a result frame always ends its exchange, and a missing or
 *  mistyped `subtype` settles it `failed` as `unknown-result` exactly as the
 *  untyped reader did, rather than leaving the Turn to be lost when the process
 *  later closes. `user_message_uuids` lists every stdin message the exchange put
 *  in front of the model, and `user_message_uuid` the one that started it (#359). */
const ResultFrame = z.looseObject({
  type: z.literal("result"),
  subtype: lenientString,
  is_error: z.boolean().optional().catch(undefined),
  result: lenientString,
  terminal_reason: lenientString,
  user_message_uuid: lenientString,
  user_message_uuids: lenientStrings,
  /** Model turns the exchange ran: 0 for a command Claude Code ran itself,
   *  such as `/compact`. */
  num_turns: z.number().optional().catch(undefined),
});
export type ResultFrame = z.infer<typeof ResultFrame>;

/** `control_response`: Claude Code's answer to a stdin `control_request` (#346).
 *  The echoed `request_id` is the one structural field, since a response that
 *  names no request cannot be correlated; such a frame is generic activity. */
const ControlResponseFrame = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    subtype: lenientString,
    request_id: z.string(),
    error: lenientString,
    // Keep only applied values. Effective settings and sources can carry hooks,
    // credentials and personal commands, and are never retained by this read.
    response: z
      .object({
        applied: z.object({
          model: z.string().min(1),
          effort: ClaudeEffort.nullable(),
        }),
      })
      .optional()
      .catch(undefined),
  }),
});
export type ControlResponseFrame = z.infer<typeof ControlResponseFrame>;

/** Native MCP elicitation. Correlation and subtype are required; descriptive
 * fields degrade to absent like the other native observations. */
const ElicitationFrame = z.looseObject({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.looseObject({
    subtype: z.literal("elicitation"),
    mcp_server_name: lenientString,
    message: lenientString,
    url: lenientString,
  }),
});
export type ElicitationFrame = z.infer<typeof ElicitationFrame>;
const ControlCancelFrame = z.looseObject({
  type: z.literal("control_cancel_request"),
  request_id: z.string(),
});

/** `command_lifecycle` (`msg_lifecycle_v1`): one stdin message's progress,
 *  `queued`, `started` (in front of the model), `completed`, or `cancelled`
 *  (#359). The message's own uuid is the one structural field. */
const CommandLifecycleFrame = z.looseObject({
  type: z.literal("command_lifecycle"),
  command_uuid: z.string(),
  state: lenientString,
});
export type CommandLifecycleFrame = z.infer<typeof CommandLifecycleFrame>;

/** `system` / `status`: what the process is doing, such as `compacting`, and how
 *  a compaction ended (`compact_result`, #359). */
const StatusFrame = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("status"),
  status: lenientString,
  compact_result: lenientString,
});
export type StatusFrame = z.infer<typeof StatusFrame>;

const TelemetryFrame = z.looseObject({ type: z.literal("telemetry") });

/** A frame the Adapter dispatches on. `type` is the raw frame type (for the
 *  generic-activity description); a known type whose schema failed, and any
 *  unknown type, arrive as `other`. */
export type ParsedFrame =
  | {
      readonly kind: "elicitation";
      readonly type: string;
      readonly frame: ElicitationFrame;
    }
  | {
      readonly kind: "control-cancel";
      readonly type: string;
      readonly requestId: string;
    }
  | { readonly kind: "init"; readonly type: string; readonly frame: InitFrame }
  | {
      readonly kind: "assistant";
      readonly type: string;
      readonly frame: MessageFrame;
    }
  | {
      readonly kind: "user";
      readonly type: string;
      readonly frame: MessageFrame;
    }
  | {
      readonly kind: "stream-event";
      readonly type: string;
      readonly frame: StreamEventFrame;
    }
  | {
      readonly kind: "result";
      readonly type: string;
      readonly frame: ResultFrame;
    }
  | {
      readonly kind: "control-response";
      readonly type: string;
      readonly frame: ControlResponseFrame;
    }
  | {
      readonly kind: "command-lifecycle";
      readonly type: string;
      readonly frame: CommandLifecycleFrame;
    }
  | {
      readonly kind: "status";
      readonly type: string;
      readonly frame: StatusFrame;
    }
  | { readonly kind: "telemetry"; readonly type: string }
  | { readonly kind: "other"; readonly type: string | undefined };

/** Parse one decoded stdout line. Non-object JSON (a bare value or array) is
 *  not a frame and yields `undefined`, as the untyped reader skipped it. */
export function parseFrame(value: unknown): ParsedFrame | undefined {
  if (!isRecord(value)) return undefined;
  const type = stringField(value, "type");
  if (type === "system" && stringField(value, "subtype") === "init") {
    const init = InitFrame.safeParse(value);
    return init.success
      ? { kind: "init", type, frame: init.data }
      : { kind: "other", type };
  }
  if (type === "system" && stringField(value, "subtype") === "status") {
    const status = StatusFrame.safeParse(value);
    return status.success
      ? { kind: "status", type, frame: status.data }
      : { kind: "other", type };
  }
  switch (type) {
    case "control_request": {
      const parsed = ElicitationFrame.safeParse(value);
      return parsed.success
        ? { kind: "elicitation", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "control_cancel_request": {
      const parsed = ControlCancelFrame.safeParse(value);
      return parsed.success
        ? { kind: "control-cancel", type, requestId: parsed.data.request_id }
        : { kind: "other", type };
    }
    case "assistant": {
      const parsed = AssistantFrame.safeParse(value);
      return parsed.success
        ? { kind: "assistant", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "user": {
      const parsed = UserFrame.safeParse(value);
      return parsed.success
        ? { kind: "user", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "stream_event": {
      const parsed = StreamEventFrame.safeParse(value);
      return parsed.success
        ? { kind: "stream-event", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "result": {
      const parsed = ResultFrame.safeParse(value);
      return parsed.success
        ? { kind: "result", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "control_response": {
      const parsed = ControlResponseFrame.safeParse(value);
      return parsed.success
        ? { kind: "control-response", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "command_lifecycle": {
      const parsed = CommandLifecycleFrame.safeParse(value);
      return parsed.success
        ? { kind: "command-lifecycle", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "telemetry":
      return TelemetryFrame.safeParse(value).success
        ? { kind: "telemetry", type }
        : { kind: "other", type };
    default:
      return { kind: "other", type };
  }
}

// --- The stdin encoders --------------------------------------------------------

/** One stdin user message, a Turn's prompt or a Steer (#359), stamped with the
 *  Adapter-minted uuid that Claude Code's lifecycle frames and a result's
 *  `user_message_uuids` echo, so each result is matched to its own messages. */
export function encodeUserMessage(uuid: string, text: string): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid,
    })}\n`,
  );
}

/** The control requests this Adapter sends. The Interrupt always cancels
 *  queued stdin messages (#359), so an undelivered Steer never runs after it;
 *  settings reads reuse the channel, and #348 adds the live-change subtypes. */
export type ControlRequest =
  | { readonly subtype: "interrupt"; readonly cancel_queued: true }
  | { readonly subtype: "get_settings" };

export function encodeControlRequest(
  requestId: string,
  request: ControlRequest,
): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    })}\n`,
  );
}

export function encodeElicitationDecline(requestId: string): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { action: "decline" },
      },
    })}\n`,
  );
}

// --- Readers -------------------------------------------------------------------

/** The message's content blocks that are objects; anything else in the array is
 *  skipped, as before. */
export function contentBlocks(frame: MessageFrame): ContentBlock[] {
  return frame.message.content.flatMap((block) => {
    const parsed = ContentBlock.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

export function sessionFacts(
  frame: InitFrame,
  coordinate: RecoveryCoordinate,
): SessionFacts {
  const tools = Array.isArray(frame.tools)
    ? frame.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const mcp = Array.isArray(frame.mcp_servers)
    ? frame.mcp_servers.filter(isRecord).flatMap((server) => {
        const name = stringField(server, "name");
        const status = stringField(server, "status");
        return name === undefined || status === undefined
          ? []
          : [{ name, status }];
      })
    : [];
  const executableVersion = stringField(frame, "claude_code_version");
  return {
    recoveryCoordinate: coordinate,
    tools,
    mcp,
    commands: sessionCommands(frame.slash_commands),
    ...(executableVersion !== undefined ? { executableVersion } : {}),
  };
}

/** Claude Code lists its Session's commands by bare name (`compact`); a person
 *  types them as a leading `/compact`, the word ADR 0040's matcher compares. */
function sessionCommands(names: readonly string[]): string[] {
  const words = names.flatMap((name) => {
    const bare = name.replace(/^\//, "");
    return bare.length === 0 ? [] : [`/${bare}`];
  });
  return [...new Set(words)];
}

export function usageObservation(
  frame: Record<string, unknown>,
): UsageObservation | undefined {
  const parts: string[] = [];
  if (isRecord(frame.usage)) {
    const input = numberField(frame.usage, "input_tokens");
    const output = numberField(frame.usage, "output_tokens");
    if (input !== undefined) parts.push(`input ${input}`);
    if (output !== undefined) parts.push(`output ${output} tokens`);
  }
  const cost = numberField(frame, "total_cost_usd");
  if (cost !== undefined) parts.push(`cost estimate USD ${cost}`);
  if (parts.length === 0) return undefined;
  return {
    estimate: true,
    summary: parts.join(", ").replace(", cost", "; cost"),
  };
}

/** Whether a `result` reports a Turn Claude Code aborted (#346): the interrupted
 *  result of a native stop is `error_during_execution` like a task failure, and
 *  only its `terminal_reason` (`aborted_streaming` while text streamed,
 *  `aborted_tools` during a tool call) tells the two apart. */
export function isAbortedResult(frame: ResultFrame): boolean {
  return (
    frame.terminal_reason === "aborted_streaming" ||
    frame.terminal_reason === "aborted_tools"
  );
}

export function genericActivity(type: string | undefined): TurnEvent {
  return {
    kind: "activity",
    description: `Claude Code activity: ${type ?? "unknown"}`,
  };
}

/** Claude Code reports a not-logged-in run as its stdout result (research:
 *  "missing authentication ... emitted as the stdout result"). No typed auth field
 *  exists in the documented print-mode contract, so this recognises the documented
 *  not-logged-in remediation phrasings only — bare words like "unauthorized" or
 *  "credential" are deliberately excluded so a task result that merely mentions
 *  them keeps its real diagnostics rather than being masked by the login message.
 *  #115's recording pinned the signal: a not-logged-in run returns `subtype:"success"`
 *  with `result:"Not logged in · Please run /login"`, so this is checked before the
 *  success branch. The matched text is never surfaced — only `AUTHENTICATION_REQUIRED`. */
export function isAuthenticationResult(
  frame: Record<string, unknown>,
): boolean {
  const text = [
    stringField(frame, "subtype") ?? "",
    stringField(frame, "result") ?? "",
    stringField(frame, "error") ?? "",
  ].join(" ");
  return /\bnot\s+logged\s+in\b|please (run \/login|log ?in)|\binvalid api key\b|\bauthentication (required|failed|error)\b|\bnot authenticated\b/i.test(
    text,
  );
}

// --- Field accessors (the only place in the Adapter that reads a raw field) ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  return optionalString(value[field]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  const found = value[field];
  return typeof found === "number" && Number.isFinite(found)
    ? found
    : undefined;
}
