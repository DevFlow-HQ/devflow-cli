import type { ManagedProviderSessionEvent } from "./managedSessionAdapter.js";

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

export type NormalizedCodexHookEvent = DistributiveOmit<
  ManagedProviderSessionEvent,
  "provider" | "source" | "structured" | "phaseId"
>;

type CodexHookEventName = "SessionStart" | "UserPromptSubmit" | "Stop";

interface CodexHookPayloadBase {
  hook_event_name: string;
  session_id: string;
}

interface CodexSessionStartHookPayload extends CodexHookPayloadBase {
  hook_event_name: "SessionStart";
}

interface CodexUserPromptSubmitHookPayload extends CodexHookPayloadBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

interface CodexStopHookPayload extends CodexHookPayloadBase {
  hook_event_name: "Stop";
  last_assistant_message?: string;
}

type CodexHookPayload =
  | CodexSessionStartHookPayload
  | CodexUserPromptSubmitHookPayload
  | CodexStopHookPayload;

export class CodexHookPayloadMalformedError extends Error {
  readonly payload: unknown;
  readonly reason: string;

  constructor(payload: unknown, reason: string) {
    super(`Malformed Codex hook payload: ${reason}.`);
    this.name = "CodexHookPayloadMalformedError";
    this.payload = payload;
    this.reason = reason;
  }
}

export function normalizeCodexHookPayload(
  payload: unknown,
): NormalizedCodexHookEvent | undefined {
  const hookPayload = parseCodexHookPayload(payload);

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

function parseCodexHookPayload(payload: unknown): CodexHookPayload | undefined {
  if (!isRecord(payload)) {
    throw new CodexHookPayloadMalformedError(payload, "expected an object");
  }

  if (typeof payload.hook_event_name !== "string") {
    throw new CodexHookPayloadMalformedError(
      payload,
      "expected string hook_event_name",
    );
  }

  if (!isKnownCodexHookEventName(payload.hook_event_name)) {
    return undefined;
  }

  if (typeof payload.session_id !== "string") {
    throw new CodexHookPayloadMalformedError(
      payload,
      "expected string session_id",
    );
  }

  switch (payload.hook_event_name) {
    case "SessionStart":
      return {
        hook_event_name: payload.hook_event_name,
        session_id: payload.session_id,
      };

    case "UserPromptSubmit":
      if (typeof payload.prompt !== "string") {
        throw new CodexHookPayloadMalformedError(
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
        throw new CodexHookPayloadMalformedError(
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

function isKnownCodexHookEventName(
  value: string,
): value is CodexHookEventName {
  return (
    value === "SessionStart" ||
    value === "UserPromptSubmit" ||
    value === "Stop"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
