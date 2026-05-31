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

      if (completedMessageIds.has(parsed.messageId)) {
        return undefined;
      }

      completedMessageIds.add(parsed.messageId);

      return {
        type: "turn-completed",
        providerSessionId: parsed.providerSessionId,
        assistantMessage: parsed.assistantMessage,
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
  messageId: string;
  providerSessionId?: string;
  assistantMessage: string;
}

function parseClaudeJsonlRecord(
  record: unknown,
): ParsedClaudeJsonlAssistantTurn | undefined {
  if (!isRecord(record)) {
    throw new ClaudeJsonlRecordMalformedError(record, "expected an object");
  }

  if (record.isSidechain === true) {
    return undefined;
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

  if (record.message.stop_reason !== "end_turn") {
    return undefined;
  }

  const providerSessionId =
    typeof record.sessionId === "string" ? record.sessionId : undefined;

  return {
    messageId: record.message.id,
    providerSessionId,
    assistantMessage: parseTextContent(record, record.message.content),
  };
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
