import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexJsonlRecordMalformedError,
  createCodexJsonlNormalizer,
  normalizeCodexJsonlRecordForProvider,
} from "../../src/adapters/codexJsonlEventSource.js";
import { ProviderSessionEventCaptureError } from "../../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

test("codex JSONL normalizer maps task completion to turn-completed assistant content", () => {
  const normalizer = createCodexJsonlNormalizer();

  const event = normalizer.normalizeRecord({
    timestamp: "2026-05-29T18:28:46.081Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "019e74fe-turn",
      last_agent_message: "Done INITIAL_DONE",
    },
  });

  assert.deepEqual(event, {
    type: "turn-completed",
    assistantMessage: "Done INITIAL_DONE",
  });
});

test("codex JSONL normalizer maps final assistant messages to turn-completed assistant content", () => {
  const normalizer = createCodexJsonlNormalizer();

  const event = normalizer.normalizeRecord({
    timestamp: "2026-05-29T18:28:46.081Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [
        { type: "output_text", text: "Final answer " },
        { type: "output_text", text: "INITIAL_DONE" },
      ],
    },
  });

  assert.deepEqual(event, {
    type: "turn-completed",
    assistantMessage: "Final answer INITIAL_DONE",
  });
});

test("codex JSONL normalizer maps native user messages to submitted user events", () => {
  const normalizer = createCodexJsonlNormalizer();

  const event = normalizer.normalizeRecord({
    timestamp: "2026-05-29T18:28:46.081Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "human " },
        { type: "input_text", text: "reply" },
      ],
    },
  });

  assert.deepEqual(event, {
    type: "submitted-user-message",
    message: "human reply",
    origin: "unknown",
  });
});

test("codex JSONL normalizer ignores partial assistant records", () => {
  const normalizer = createCodexJsonlNormalizer();

  assert.equal(
    normalizer.normalizeRecord({
      timestamp: "2026-05-29T18:28:46.081Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "partial answer" }],
      },
    }),
    undefined,
  );
});

test("codex JSONL normalizer ignores unknown valid native records", () => {
  const normalizer = createCodexJsonlNormalizer();

  assert.equal(
    normalizer.normalizeRecord({
      timestamp: "2026-05-29T18:28:46.081Z",
      type: "event_msg",
      payload: {
        type: "token_count",
      },
    }),
    undefined,
  );

  assert.equal(
    normalizer.normalizeRecord({
      timestamp: "2026-05-29T18:28:46.081Z",
      type: "future_record",
      payload: {
        stable: true,
      },
    }),
    undefined,
  );
});

test("codex JSONL normalizer maps native session metadata to session-start once", () => {
  const normalizer = createCodexJsonlNormalizer();

  assert.deepEqual(
    normalizer.normalizeRecord({
      timestamp: "2026-05-29T18:28:46.081Z",
      type: "session_meta",
      payload: {
        id: "019e74fe-f2fd-71b2-b698-b828ba67dbfa",
      },
    }),
    {
      type: "session-start",
      providerSessionId: "019e74fe-f2fd-71b2-b698-b828ba67dbfa",
    },
  );

  assert.equal(
    normalizer.normalizeRecord({
      timestamp: "2026-05-29T18:28:46.081Z",
      type: "session_meta",
      payload: {
        id: "019e74fe-f2fd-71b2-b698-b828ba67dbfa",
      },
    }),
    undefined,
  );
});

test("codex JSONL normalizer synthesizes attachment session-start and suppresses native duplicates", () => {
  const normalizer = createCodexJsonlNormalizer();

  assert.deepEqual(normalizer.synthesizeSessionStart(), {
    type: "session-start",
  });
  assert.equal(normalizer.synthesizeSessionStart(), undefined);

  assert.equal(
    normalizer.normalizeRecord({
      timestamp: "2026-05-29T18:28:46.081Z",
      type: "session_meta",
      payload: {
        id: "019e74fe-f2fd-71b2-b698-b828ba67dbfa",
      },
    }),
    undefined,
  );
});

test("codex JSONL normalizer rejects malformed load-bearing records", () => {
  const normalizer = createCodexJsonlNormalizer();

  assert.throws(
    () =>
      normalizer.normalizeRecord({
        timestamp: "2026-05-29T18:28:46.081Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
        },
      }),
    CodexJsonlRecordMalformedError,
  );

  assert.throws(
    () =>
      normalizer.normalizeRecord({
        timestamp: "2026-05-29T18:28:46.081Z",
        type: "session_meta",
        payload: {
          id: 42,
        },
      }),
    CodexJsonlRecordMalformedError,
  );

  assert.throws(
    () =>
      normalizer.normalizeRecord({
        timestamp: "2026-05-29T18:28:46.081Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text" }],
        },
      }),
    CodexJsonlRecordMalformedError,
  );
});

test("codex JSONL provider wrapper classifies malformed load-bearing records as event capture failures", () => {
  const normalizer = createCodexJsonlNormalizer();

  assert.throws(
    () =>
      normalizeCodexJsonlRecordForProvider({
        provider: getBuiltInProviderIdentity("codex"),
        normalizer,
        record: {
          timestamp: "2026-05-29T18:28:46.081Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            last_agent_message: 42,
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSessionEventCaptureError);
      assert.ok(error.cause instanceof CodexJsonlRecordMalformedError);
      return true;
    },
  );
});
