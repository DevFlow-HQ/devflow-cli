import {
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionEvent,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

export type NormalizedCodexJsonlEvent = DistributiveOmit<
  ManagedProviderSessionEvent,
  "provider" | "source" | "structured" | "phaseId"
>;

export interface CodexJsonlNormalizer {
  synthesizeSessionStart(): NormalizedCodexJsonlEvent | undefined;
  normalizeRecord(record: unknown): NormalizedCodexJsonlEvent | undefined;
}

export interface NormalizeCodexJsonlRecordForProviderOptions {
  provider: ProviderIdentity;
  normalizer: CodexJsonlNormalizer;
  record: unknown;
}

export class CodexJsonlRecordMalformedError extends Error {
  readonly record: unknown;
  readonly reason: string;

  constructor(record: unknown, reason: string) {
    super(`Malformed Codex JSONL record: ${reason}.`);
    this.name = "CodexJsonlRecordMalformedError";
    this.record = record;
    this.reason = reason;
  }
}

export function createCodexJsonlNormalizer(): CodexJsonlNormalizer {
  let sessionStartEmitted = false;

  return {
    synthesizeSessionStart() {
      if (sessionStartEmitted) {
        return undefined;
      }

      sessionStartEmitted = true;
      return { type: "session-start" };
    },

    normalizeRecord(record) {
      const codexRecord = parseCodexJsonlRecord(record);

      if (codexRecord === undefined) {
        return undefined;
      }

      switch (codexRecord.type) {
        case "session-start":
          if (sessionStartEmitted) {
            return undefined;
          }

          sessionStartEmitted = true;
          return withProviderSessionId(
            { type: "session-start" },
            codexRecord.providerSessionId,
          );

        case "turn-completed":
          return {
            type: "turn-completed",
            assistantMessage: codexRecord.assistantMessage,
          };

        case "submitted-user-message":
          return {
            type: "submitted-user-message",
            message: codexRecord.message,
            origin: "unknown",
          };
      }
    },
  };
}

export function normalizeCodexJsonlRecordForProvider(
  options: NormalizeCodexJsonlRecordForProviderOptions,
): NormalizedCodexJsonlEvent | undefined {
  try {
    return options.normalizer.normalizeRecord(options.record);
  } catch (error) {
    throw new ProviderSessionEventCaptureError(options.provider, error);
  }
}

type ParsedCodexJsonlRecord =
  | {
      type: "session-start";
      providerSessionId?: string;
    }
  | {
      type: "turn-completed";
      assistantMessage: string;
    }
  | {
      type: "submitted-user-message";
      message: string;
    };

function parseCodexJsonlRecord(
  record: unknown,
): ParsedCodexJsonlRecord | undefined {
  if (!isRecord(record)) {
    throw new CodexJsonlRecordMalformedError(record, "expected an object");
  }

  if (record.type === "session_meta") {
    return parseSessionMetaRecord(record);
  }

  if (record.type === "event_msg") {
    return parseEventMessageRecord(record);
  }

  if (record.type === "response_item") {
    return parseResponseItemRecord(record);
  }

  return undefined;
}

function parseSessionMetaRecord(
  record: Record<string, unknown>,
): ParsedCodexJsonlRecord {
  if (!isRecord(record.payload)) {
    throw new CodexJsonlRecordMalformedError(
      record,
      "expected object payload for session_meta",
    );
  }

  if (typeof record.payload.id !== "string") {
    throw new CodexJsonlRecordMalformedError(
      record,
      "expected string payload.id for session_meta",
    );
  }

  return {
    type: "session-start",
    providerSessionId: record.payload.id,
  };
}

function parseEventMessageRecord(
  record: Record<string, unknown>,
): ParsedCodexJsonlRecord | undefined {
  if (!isRecord(record.payload)) {
    throw new CodexJsonlRecordMalformedError(
      record,
      "expected object payload for event_msg",
    );
  }

  if (record.payload.type !== "task_complete") {
    return undefined;
  }

  if (typeof record.payload.last_agent_message !== "string") {
    throw new CodexJsonlRecordMalformedError(
      record,
      "expected string payload.last_agent_message for task_complete",
    );
  }

  return {
    type: "turn-completed",
    assistantMessage: record.payload.last_agent_message,
  };
}

function parseResponseItemRecord(
  record: Record<string, unknown>,
): ParsedCodexJsonlRecord | undefined {
  if (!isRecord(record.payload)) {
    throw new CodexJsonlRecordMalformedError(
      record,
      "expected object payload for response_item",
    );
  }

  if (record.payload.type !== "message") {
    return undefined;
  }

  if (record.payload.role === "assistant") {
    if (record.payload.phase !== "final_answer") {
      return undefined;
    }

    return {
      type: "turn-completed",
      assistantMessage: parseMessageTextContent(
        record,
        record.payload.content,
        "output_text",
        "response_item assistant final_answer",
      ),
    };
  }

  if (record.payload.role === "user") {
    return {
      type: "submitted-user-message",
      message: parseMessageTextContent(
        record,
        record.payload.content,
        "input_text",
        "response_item user message",
      ),
    };
  }

  return undefined;
}

function parseMessageTextContent(
  record: Record<string, unknown>,
  content: unknown,
  expectedType: "input_text" | "output_text",
  description: string,
): string {
  if (!Array.isArray(content)) {
    throw new CodexJsonlRecordMalformedError(
      record,
      `expected array payload.content for ${description}`,
    );
  }

  const parts: string[] = [];

  for (const item of content) {
    if (!isRecord(item)) {
      throw new CodexJsonlRecordMalformedError(
        record,
        `expected object content item for ${description}`,
      );
    }

    if (item.type !== expectedType) {
      continue;
    }

    if (typeof item.text !== "string") {
      throw new CodexJsonlRecordMalformedError(
        record,
        `expected string content item text for ${description}`,
      );
    }

    parts.push(item.text);
  }

  return parts.join("");
}

function withProviderSessionId<T extends NormalizedCodexJsonlEvent>(
  event: T,
  providerSessionId: string | undefined,
): T {
  if (providerSessionId === undefined) {
    return event;
  }

  return {
    ...event,
    providerSessionId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
