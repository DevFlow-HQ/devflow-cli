import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaudeJsonlNormalizer,
  normalizeClaudeJsonlRecordForProvider,
} from "../../src/adapters/claudeJsonlEventSource.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

test("Claude JSONL normalizer emits one turn completion from end-turn assistant message text blocks", () => {
  const normalizer = createClaudeJsonlNormalizer();

  assert.deepEqual(
    normalizeClaudeJsonlRecordForProvider({
      provider: getBuiltInProviderIdentity("claude"),
      normalizer,
      record: {
        type: "assistant",
        sessionId: "claude-session-1",
        message: {
          id: "msg_1",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done " }],
        },
      },
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
      record: {
        type: "assistant",
        sessionId: "claude-session-1",
        message: {
          id: "msg_1",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "INITIAL_DONE" }],
        },
      },
    }),
    undefined,
  );
});
