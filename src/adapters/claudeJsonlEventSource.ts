import {
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionEvent,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

export type NormalizedClaudeJsonlEvent = DistributiveOmit<
  ManagedProviderSessionEvent,
  "provider" | "source" | "structured" | "phaseId"
>;

export interface ClaudeJsonlNormalizer {
  synthesizeSessionStart(): NormalizedClaudeJsonlEvent | undefined;
  normalizeRecord(record: unknown): NormalizedClaudeJsonlEvent | undefined;
}

export interface NormalizeClaudeJsonlRecordForProviderOptions {
  provider: ProviderIdentity;
  normalizer: ClaudeJsonlNormalizer;
  record: unknown;
}

export class ClaudeJsonlRecordMalformedError extends Error {
  readonly record: unknown;
  readonly reason: string;

  constructor(record: unknown, reason: string) {
    super(`Malformed Claude JSONL record: ${reason}.`);
    this.name = "ClaudeJsonlRecordMalformedError";
    this.record = record;
    this.reason = reason;
  }
}

export function createClaudeJsonlNormalizer(): ClaudeJsonlNormalizer {
  let sessionStartEmitted = false;
  const completedMessageIds = new Set<string>();
  const pendingTextByMessageId = new Map<string, string[]>();

  return {
    synthesizeSessionStart() {
      if (sessionStartEmitted) {
        return undefined;
      }

      sessionStartEmitted = true;
      return { type: "session-start" };
    },

    normalizeRecord(record) {
      const parsed = parseClaudeJsonlRecord(record);

      if (!parsed) {
        return undefined;
      }

      if (parsed.type === "submitted-user-message") {
        return {
          type: "submitted-user-message",
          providerSessionId: parsed.providerSessionId,
          message: parsed.message,
          origin: "unknown",
        };
      }

      if (completedMessageIds.has(parsed.messageId)) {
        return undefined;
      }

      const pendingText = pendingTextByMessageId.get(parsed.messageId) ?? [];
      pendingText.push(parsed.assistantMessage);

      if (!parsed.completesTurn) {
        pendingTextByMessageId.set(parsed.messageId, pendingText);
        return undefined;
      }

      pendingTextByMessageId.delete(parsed.messageId);
      completedMessageIds.add(parsed.messageId);

      return {
        type: "turn-completed",
        providerSessionId: parsed.providerSessionId,
        assistantMessage: pendingText.join(""),
      };
    },
  };
}

export function normalizeClaudeJsonlRecordForProvider(
  options: NormalizeClaudeJsonlRecordForProviderOptions,
): NormalizedClaudeJsonlEvent | undefined {
  try {
    return options.normalizer.normalizeRecord(options.record);
  } catch (error) {
    throw new ProviderSessionEventCaptureError(options.provider, error);
  }
}

interface ParsedClaudeJsonlAssistantTurn {
  type: "turn-completed";
  messageId: string;
  providerSessionId?: string;
  assistantMessage: string;
  completesTurn: boolean;
}

interface ParsedClaudeJsonlUserMessage {
  type: "submitted-user-message";
  providerSessionId?: string;
  message: string;
}

function parseClaudeJsonlRecord(
  record: unknown,
): ParsedClaudeJsonlAssistantTurn | ParsedClaudeJsonlUserMessage | undefined {
  if (!isRecord(record)) {
    throw new ClaudeJsonlRecordMalformedError(record, "expected an object");
  }

  if (record.isSidechain === true) {
    return undefined;
  }

  if (record.type === "user") {
    return parseUserRecord(record);
  }

  if (record.type !== "assistant") {
    return undefined;
  }

  if (!isRecord(record.message)) {
    throw new ClaudeJsonlRecordMalformedError(
      record,
      "expected object message for assistant record",
    );
  }

  if (record.message.role !== "assistant") {
    return undefined;
  }

  if (typeof record.message.id !== "string") {
    throw new ClaudeJsonlRecordMalformedError(
      record,
      "expected string message.id for assistant record",
    );
  }

  const stopReason = record.message.stop_reason;

  if (stopReason === "stop_sequence" || stopReason === "max_tokens") {
    throw new ClaudeJsonlRecordMalformedError(
      record,
      `unexpected assistant stop_reason ${stopReason}`,
    );
  }

  const providerSessionId =
    typeof record.sessionId === "string" ? record.sessionId : undefined;

  return {
    type: "turn-completed",
    messageId: record.message.id,
    providerSessionId,
    assistantMessage: parseTextContent(record, record.message.content),
    completesTurn: stopReason === "end_turn",
  };
}

function parseUserRecord(
  record: Record<string, unknown>,
): ParsedClaudeJsonlUserMessage | undefined {
  if (!isRecord(record.message)) {
    throw new ClaudeJsonlRecordMalformedError(
      record,
      "expected object message for user record",
    );
  }

  if (record.message.role !== "user") {
    return undefined;
  }

  const message = parseUserPromptContent(record, record.message.content);

  if (!message || isSyntheticInterruptedRequestText(message)) {
    return undefined;
  }

  return {
    type: "submitted-user-message",
    providerSessionId:
      typeof record.sessionId === "string" ? record.sessionId : undefined,
    message,
  };
}

function parseUserPromptContent(
  record: Record<string, unknown>,
  content: unknown,
): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    throw new ClaudeJsonlRecordMalformedError(
      record,
      "expected string or array message.content for user record",
    );
  }

  const parts: string[] = [];

  for (const item of content) {
    if (!isRecord(item)) {
      throw new ClaudeJsonlRecordMalformedError(
        record,
        "expected object content item for user record",
      );
    }

    if (item.type !== "text") {
      continue;
    }

    if (typeof item.text !== "string") {
      throw new ClaudeJsonlRecordMalformedError(
        record,
        "expected string text content for user record",
      );
    }

    parts.push(item.text);
  }

  return parts.length === 0 ? undefined : parts.join("");
}

function isSyntheticInterruptedRequestText(message: string): boolean {
  const normalized = message.trim();

  return (
    normalized === "[Request interrupted by user]" ||
    normalized === "Request interrupted by user"
  );
}

function parseTextContent(record: Record<string, unknown>, content: unknown): string {
  if (!Array.isArray(content)) {
    throw new ClaudeJsonlRecordMalformedError(
      record,
      "expected array message.content for assistant record",
    );
  }

  const parts: string[] = [];

  for (const item of content) {
    if (!isRecord(item)) {
      throw new ClaudeJsonlRecordMalformedError(
        record,
        "expected object content item for assistant record",
      );
    }

    if (item.type !== "text") {
      continue;
    }

    if (typeof item.text !== "string") {
      throw new ClaudeJsonlRecordMalformedError(
        record,
        "expected string text content for assistant record",
      );
    }

    parts.push(item.text);
  }

  return parts.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
