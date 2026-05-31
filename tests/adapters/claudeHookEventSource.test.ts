import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeHookPayloadMalformedError,
  normalizeClaudeHookPayload,
  normalizeClaudeHookPayloadForProvider,
} from "../../src/adapters/claudeHookEventSource.js";
import { ProviderSessionEventCaptureError } from "../../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

test("claude hook normalizer maps startup SessionStart to session-start", () => {
  const event = normalizeClaudeHookPayload({
    hook_event_name: "SessionStart",
    matcher: "startup",
    session_id: "claude-session-123",
  });

  assert.deepEqual(event, {
    type: "session-start",
    providerSessionId: "claude-session-123",
  });
});

test("claude hook normalizer maps UserPromptSubmit prompt to submitted-user-message", () => {
  const event = normalizeClaudeHookPayload({
    hook_event_name: "UserPromptSubmit",
    prompt: "Write the PRD",
    session_id: "claude-session-123",
  });

  assert.deepEqual(event, {
    type: "submitted-user-message",
    message: "Write the PRD",
    origin: "unknown",
    providerSessionId: "claude-session-123",
  });
});

test("claude hook normalizer maps Stop assistant content to turn-completed", () => {
  const event = normalizeClaudeHookPayload({
    hook_event_name: "Stop",
    last_assistant_message: "Done DEVFLOW_COMPLETE",
    session_id: "claude-session-123",
  });

  assert.deepEqual(event, {
    type: "turn-completed",
    assistantMessage: "Done DEVFLOW_COMPLETE",
    providerSessionId: "claude-session-123",
  });
});

test("claude hook normalizer omits assistantMessage when Stop has no assistant content", () => {
  const event = normalizeClaudeHookPayload({
    hook_event_name: "Stop",
    session_id: "claude-session-123",
  });

  assert.deepEqual(event, {
    type: "turn-completed",
    providerSessionId: "claude-session-123",
  });
});

test("claude hook normalizer ignores unknown and out-of-scope hook events", () => {
  const ignoredPayloads = [
    { hook_event_name: "PreToolUse", session_id: "claude-session-123" },
    { hook_event_name: "PostToolUse", session_id: "claude-session-123" },
    { hook_event_name: "Notification", session_id: "claude-session-123" },
    { hook_event_name: "SubagentStop", session_id: "claude-session-123" },
    { hook_event_name: "SessionEnd", session_id: "claude-session-123" },
    { hook_event_name: "StopFailure", session_id: "claude-session-123" },
    { hook_event_name: "NewClaudeHook", session_id: "claude-session-123" },
  ];

  assert.deepEqual(ignoredPayloads.map(normalizeClaudeHookPayload), [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("claude hook normalizer rejects malformed supported payloads with a typed error", () => {
  assert.throws(
    () =>
      normalizeClaudeHookPayload({
        hook_event_name: "SessionStart",
        matcher: "startup",
        session_id: 123,
      }),
    ClaudeHookPayloadMalformedError,
  );

  assert.throws(
    () =>
      normalizeClaudeHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: "claude-session-123",
      }),
    ClaudeHookPayloadMalformedError,
  );

  assert.throws(
    () =>
      normalizeClaudeHookPayload({
        hook_event_name: "Stop",
        last_assistant_message: 42,
        session_id: "claude-session-123",
      }),
    ClaudeHookPayloadMalformedError,
  );

  assert.throws(
    () =>
      normalizeClaudeHookPayload({
        hook_event_name: 42,
        session_id: "claude-session-123",
      }),
    ClaudeHookPayloadMalformedError,
  );
});

test("claude hook provider wrapper maps malformed payloads to provider event capture failures", () => {
  assert.throws(
    () =>
      normalizeClaudeHookPayloadForProvider({
        provider: getBuiltInProviderIdentity("claude"),
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: 42,
          session_id: "claude-session-123",
        },
      }),
    ProviderSessionEventCaptureError,
  );
});
