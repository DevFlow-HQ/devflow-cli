import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeJsonlRecordMalformedError,
  createClaudeJsonlNormalizer,
  normalizeClaudeJsonlRecordForProvider,
} from "../../src/adapters/claudeJsonlEventSource.js";
import { ProviderSessionEventCaptureError } from "../../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

const claudeProvider = getBuiltInProviderIdentity("claude");

function assistantRecord(
  overrides: {
    id?: string;
    sessionId?: string;
    stopReason?: string | null;
    text?: string;
    content?: Array<Record<string, unknown>>;
    isSidechain?: boolean;
    type?: string;
  } = {},
) {
  const stopReason =
    "stopReason" in overrides ? overrides.stopReason : "end_turn";

  return {
    type: overrides.type ?? "assistant",
    sessionId: overrides.sessionId ?? "claude-session-1",
    isSidechain: overrides.isSidechain,
    message: {
      id: overrides.id ?? "msg_1",
      role: "assistant",
      stop_reason: stopReason,
      content: overrides.content ?? [{ type: "text", text: overrides.text ?? "Done " }],
    },
  };
}

function userRecord(content: unknown) {
  return {
    type: "user",
    sessionId: "claude-session-1",
    message: {
      role: "user",
      content,
    },
  };
}

test("Claude JSONL normalizer emits one turn completion from end-turn assistant message text blocks", () => {
  const normalizer = createClaudeJsonlNormalizer();

  assert.deepEqual(
    normalizeClaudeJsonlRecordForProvider({
      provider: getBuiltInProviderIdentity("claude"),
      normalizer,
      record: assistantRecord(),
    }),
    {
      type: "turn-completed",
      providerSessionId: "claude-session-1",
      assistantMessage: "Done ",
    },
  );

  assert.deepEqual(
    normalizeClaudeJsonlRecordForProvider({
      provider: getBuiltInProviderIdentity("claude"),
      normalizer,
      record: assistantRecord({ text: "INITIAL_DONE" }),
    }),
    undefined,
  );
});

test("Claude JSONL normalizer maps real user prompts to submitted user messages", () => {
  const normalizer = createClaudeJsonlNormalizer();

  assert.deepEqual(
    normalizer.normalizeRecord(userRecord("human typed reply")),
    {
      type: "submitted-user-message",
      providerSessionId: "claude-session-1",
      message: "human typed reply",
      origin: "unknown",
    },
  );

  assert.deepEqual(
    normalizer.normalizeRecord(
      userRecord([
        { type: "text", text: "describe " },
        { type: "image", source: { type: "base64", media_type: "image/png" } },
        { type: "text", text: "this" },
      ]),
    ),
    {
      type: "submitted-user-message",
      providerSessionId: "claude-session-1",
      message: "describe this",
      origin: "unknown",
    },
  );
});

test("Claude JSONL normalizer filters non-prompt user and provider meta records", () => {
  const normalizer = createClaudeJsonlNormalizer();

  for (const record of [
    userRecord([{ type: "tool_result", content: "tool output" }]),
    userRecord([{ type: "text", text: "[Request interrupted by user]" }]),
    { type: "system", message: { content: "meta" } },
    { type: "summary", message: { content: "compact summary" } },
    { type: "attachment", message: { content: "README.md" } },
    { type: "queue_operation", message: { content: "queued" } },
  ]) {
    assert.equal(normalizer.normalizeRecord(record), undefined);
  }
});

test("Claude JSONL normalizer fails capture for abnormal assistant stop reasons", () => {
  for (const stopReason of ["stop_sequence", "max_tokens"]) {
    const normalizer = createClaudeJsonlNormalizer();

    assert.throws(
      () =>
        normalizeClaudeJsonlRecordForProvider({
          provider: claudeProvider,
          normalizer,
          record: assistantRecord({ stopReason }),
        }),
      (error) => {
        assert.ok(error instanceof ProviderSessionEventCaptureError);
        assert.ok(error.cause instanceof ClaudeJsonlRecordMalformedError);
        assert.equal(error.cause.reason, `unexpected assistant stop_reason ${stopReason}`);
        return true;
      },
    );
  }
});

test("Claude JSONL normalizer ignores mid-turn and sidechain records", () => {
  const normalizer = createClaudeJsonlNormalizer();

  assert.equal(
    normalizeClaudeJsonlRecordForProvider({
      provider: claudeProvider,
      normalizer,
      record: assistantRecord({ stopReason: "tool_use" }),
    }),
    undefined,
  );
  assert.equal(
    normalizeClaudeJsonlRecordForProvider({
      provider: claudeProvider,
      normalizer,
      record: assistantRecord({ stopReason: null }),
    }),
    undefined,
  );
  assert.equal(
    normalizeClaudeJsonlRecordForProvider({
      provider: claudeProvider,
      normalizer,
      record: assistantRecord({ isSidechain: true, text: "sub-agent INITIAL_DONE" }),
    }),
    undefined,
  );
  assert.equal(
    normalizeClaudeJsonlRecordForProvider({
      provider: claudeProvider,
      normalizer,
      record: { type: "user", isSidechain: true, message: { content: "ignored" } },
    }),
    undefined,
  );
});

test("Claude JSONL normalizer assembles text by message id and emits once when the message completes", () => {
  const normalizer = createClaudeJsonlNormalizer();

  assert.equal(
    normalizeClaudeJsonlRecordForProvider({
      provider: claudeProvider,
      normalizer,
      record: assistantRecord({
        id: "msg_split",
        stopReason: null,
        content: [{ type: "text", text: "Hello " }],
      }),
    }),
    undefined,
  );

  assert.deepEqual(
    normalizeClaudeJsonlRecordForProvider({
      provider: claudeProvider,
      normalizer,
      record: assistantRecord({
        id: "msg_split",
        stopReason: "end_turn",
        content: [
          { type: "tool_use", name: "ignored" },
          { type: "text", text: "world INITIAL_DONE" },
        ],
      }),
    }),
    {
      type: "turn-completed",
      providerSessionId: "claude-session-1",
      assistantMessage: "Hello world INITIAL_DONE",
    },
  );

  assert.equal(
    normalizeClaudeJsonlRecordForProvider({
      provider: claudeProvider,
      normalizer,
      record: assistantRecord({
        id: "msg_split",
        stopReason: "end_turn",
        text: "duplicate completion",
      }),
    }),
    undefined,
  );
});
