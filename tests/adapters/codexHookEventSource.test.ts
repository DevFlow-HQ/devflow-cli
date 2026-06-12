import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexHookPayloadMalformedError,
  normalizeCodexHookPayload,
} from "../../src/adapters/codexHookEventSource.js";

test("codex hook normalizer maps SessionStart to session-start", () => {
  const event = normalizeCodexHookPayload({
    hook_event_name: "SessionStart",
    session_id: "session-123",
  });

  assert.deepEqual(event, {
    type: "session-start",
    providerSessionId: "session-123",
  });
});

test("codex hook normalizer maps UserPromptSubmit prompt to submitted-user-message", () => {
  const event = normalizeCodexHookPayload({
    hook_event_name: "UserPromptSubmit",
    prompt: "Write the PRD",
    session_id: "session-123",
  });

  assert.deepEqual(event, {
    type: "submitted-user-message",
    message: "Write the PRD",
    origin: "unknown",
    providerSessionId: "session-123",
  });
});

test("codex hook normalizer maps Stop assistant content to turn-completed", () => {
  const event = normalizeCodexHookPayload({
    hook_event_name: "Stop",
    last_assistant_message: "Done MARKER",
    session_id: "session-123",
  });

  assert.deepEqual(event, {
    type: "turn-completed",
    assistantMessage: "Done MARKER",
    providerSessionId: "session-123",
  });
});

test("codex hook normalizer omits assistantMessage when Stop has no assistant content", () => {
  const event = normalizeCodexHookPayload({
    hook_event_name: "Stop",
    session_id: "session-123",
  });

  assert.deepEqual(event, {
    type: "turn-completed",
    providerSessionId: "session-123",
  });
});

test("codex hook normalizer ignores unknown hook event types", () => {
  assert.equal(
    normalizeCodexHookPayload({
      hook_event_name: "Notification",
      message: "newer Codex hook",
    }),
    undefined,
  );
});

test("codex hook normalizer ignores unknown native payload fields", () => {
  const event = normalizeCodexHookPayload({
    hook_event_name: "Stop",
    last_assistant_message: "Done MARKER",
    session_id: "session-123",
    transcript_path: "/tmp/codex-rollout.jsonl",
    cwd: "/work/project",
    model: "gpt-5",
  });

  assert.deepEqual(event, {
    type: "turn-completed",
    assistantMessage: "Done MARKER",
    providerSessionId: "session-123",
  });
});

test("codex hook normalizer rejects malformed payloads with a typed error", () => {
  assert.throws(
    () =>
      normalizeCodexHookPayload({
        hook_event_name: "SessionStart",
      }),
    CodexHookPayloadMalformedError,
  );

  assert.throws(
    () =>
      normalizeCodexHookPayload({
        hook_event_name: "SessionStart",
        session_id: 123,
      }),
    CodexHookPayloadMalformedError,
  );

  assert.throws(
    () =>
      normalizeCodexHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-123",
      }),
    CodexHookPayloadMalformedError,
  );

  assert.throws(
    () =>
      normalizeCodexHookPayload({
        hook_event_name: "Stop",
        last_assistant_message: 42,
        session_id: "session-123",
      }),
    CodexHookPayloadMalformedError,
  );
});
