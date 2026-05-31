import {
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionEvent,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

export type NormalizedClaudeHookEvent = DistributiveOmit<
  ManagedProviderSessionEvent,
  "provider" | "source" | "structured" | "phaseId"
>;

type ClaudeHookEventName = "SessionStart" | "UserPromptSubmit" | "Stop";

interface ClaudeHookPayloadBase {
  hook_event_name: string;
  session_id: string;
}

interface ClaudeSessionStartHookPayload extends ClaudeHookPayloadBase {
  hook_event_name: "SessionStart";
  matcher: "startup";
}

interface ClaudeUserPromptSubmitHookPayload extends ClaudeHookPayloadBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

interface ClaudeStopHookPayload extends ClaudeHookPayloadBase {
  hook_event_name: "Stop";
  last_assistant_message?: string;
}

type ClaudeHookPayload =
  | ClaudeSessionStartHookPayload
  | ClaudeUserPromptSubmitHookPayload
  | ClaudeStopHookPayload;

export interface NormalizeClaudeHookPayloadForProviderOptions {
  provider: ProviderIdentity;
  payload: unknown;
}

export class ClaudeHookPayloadMalformedError extends Error {
  readonly payload: unknown;
  readonly reason: string;

  constructor(payload: unknown, reason: string) {
    super(`Malformed Claude hook payload: ${reason}.`);
    this.name = "ClaudeHookPayloadMalformedError";
    this.payload = payload;
    this.reason = reason;
  }
}

export function normalizeClaudeHookPayload(
  payload: unknown,
): NormalizedClaudeHookEvent | undefined {
  const hookPayload = parseClaudeHookPayload(payload);

  if (!hookPayload) {
    return undefined;
  }

  const providerSessionId = hookPayload.session_id;

  switch (hookPayload.hook_event_name) {
    case "SessionStart":
      return {
        type: "session-start",
        providerSessionId,
      };

    case "UserPromptSubmit":
      return {
        type: "submitted-user-message",
        message: hookPayload.prompt,
        origin: "unknown",
        providerSessionId,
      };

    case "Stop":
      return hookPayload.last_assistant_message === undefined
        ? {
            type: "turn-completed",
            providerSessionId,
          }
        : {
            type: "turn-completed",
            assistantMessage: hookPayload.last_assistant_message,
            providerSessionId,
          };
  }
}

export function normalizeClaudeHookPayloadForProvider(
  options: NormalizeClaudeHookPayloadForProviderOptions,
): NormalizedClaudeHookEvent | undefined {
  try {
    return normalizeClaudeHookPayload(options.payload);
  } catch (error) {
    throw new ProviderSessionEventCaptureError(options.provider, error);
  }
}

function parseClaudeHookPayload(payload: unknown): ClaudeHookPayload | undefined {
  if (!isRecord(payload)) {
    throw new ClaudeHookPayloadMalformedError(payload, "expected an object");
  }

  if (typeof payload.hook_event_name !== "string") {
    throw new ClaudeHookPayloadMalformedError(
      payload,
      "expected string hook_event_name",
    );
  }

  if (!isKnownClaudeHookEventName(payload.hook_event_name)) {
    return undefined;
  }

  if (typeof payload.session_id !== "string") {
    throw new ClaudeHookPayloadMalformedError(
      payload,
      "expected string session_id",
    );
  }

  switch (payload.hook_event_name) {
    case "SessionStart":
      if (payload.matcher !== "startup") {
        throw new ClaudeHookPayloadMalformedError(
          payload,
          'expected matcher "startup" for SessionStart',
        );
      }

      return {
        hook_event_name: payload.hook_event_name,
        matcher: payload.matcher,
        session_id: payload.session_id,
      };

    case "UserPromptSubmit":
      if (typeof payload.prompt !== "string") {
        throw new ClaudeHookPayloadMalformedError(
          payload,
          "expected string prompt for UserPromptSubmit",
        );
      }

      return {
        hook_event_name: payload.hook_event_name,
        prompt: payload.prompt,
        session_id: payload.session_id,
      };

    case "Stop":
      if (
        payload.last_assistant_message !== undefined &&
        typeof payload.last_assistant_message !== "string"
      ) {
        throw new ClaudeHookPayloadMalformedError(
          payload,
          "expected string last_assistant_message for Stop",
        );
      }

      return {
        hook_event_name: payload.hook_event_name,
        last_assistant_message: payload.last_assistant_message,
        session_id: payload.session_id,
      };
  }
}

function isKnownClaudeHookEventName(
  value: string,
): value is ClaudeHookEventName {
  return (
    value === "SessionStart" ||
    value === "UserPromptSubmit" ||
    value === "Stop"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
