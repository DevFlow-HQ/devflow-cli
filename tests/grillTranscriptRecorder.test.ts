import assert from "node:assert/strict";
import test from "node:test";

import {
  createStructuredGrillTranscriptRecorder,
  type GrillTranscriptArtifact,
} from "../src/grillTranscriptRecorder.js";
import {
  ProviderSessionTranscriptCaptureError,
  type ManagedProviderSessionEvent,
} from "../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../src/adapters/providers.js";

const provider = getBuiltInProviderIdentity("codex");

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

function createEvent(
  event: DistributiveOmit<
    ManagedProviderSessionEvent,
    "provider" | "source" | "structured"
  >,
): ManagedProviderSessionEvent {
  return {
    ...event,
    provider,
    source: "hooks",
    structured: true,
  } as ManagedProviderSessionEvent;
}

function createArtifact(): GrillTranscriptArtifact & { writes: string[] } {
  const writes: string[] = [];

  return {
    writes,
    async appendProviderMessage(content) {
      writes.push(`provider:${content}`);
    },
    async appendUserMessage(content) {
      writes.push(`user:${content}`);
    },
    async complete() {
      writes.push("complete");
    },
  };
}

test("structured grill transcript recorder opens on first provider response and closes only after accepted completion", async () => {
  const artifact = createArtifact();
  const recorder = createStructuredGrillTranscriptRecorder({
    provider,
    artifact,
    getActiveCompletionMarker: () => "DONE",
  });

  await recorder.recordEvent(
    createEvent({
      type: "submitted-user-message",
      message: "before provider",
      origin: "human",
    }),
  );
  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "First question?",
    }),
  );
  await recorder.acceptCompletion();
  await recorder.recordEvent(
    createEvent({
      type: "submitted-user-message",
      message: "after close",
      origin: "human",
    }),
  );

  assert.deepEqual(artifact.writes, ["provider:First question?", "complete"]);
});

test("structured grill transcript recorder captures provider turn-completed assistant messages", async () => {
  const artifact = createArtifact();
  const recorder = createStructuredGrillTranscriptRecorder({
    provider,
    artifact,
    getActiveCompletionMarker: () => "DONE",
  });

  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "What constraint matters?",
    }),
  );
  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "What should fail?",
    }),
  );

  assert.deepEqual(artifact.writes, [
    "provider:What constraint matters?",
    "provider:What should fail?",
  ]);
});

test("structured grill transcript recorder captures only human submitted user messages", async () => {
  const artifact = createArtifact();
  const recorder = createStructuredGrillTranscriptRecorder({
    provider,
    artifact,
    getActiveCompletionMarker: () => "DONE",
  });

  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "Question?",
    }),
  );
  await recorder.recordEvent(
    createEvent({
      type: "submitted-user-message",
      message: "managed prompt",
      origin: "managed",
    }),
  );
  await recorder.recordEvent(
    createEvent({
      type: "submitted-user-message",
      message: "unknown prompt",
      origin: "unknown",
    }),
  );
  await recorder.recordEvent(
    createEvent({
      type: "submitted-user-message",
      message: "human answer",
      origin: "human",
    }),
  );

  assert.deepEqual(artifact.writes, ["provider:Question?", "user:human answer"]);
});

test("structured grill transcript recorder strips active marker, excludes post-marker text, and skips empty provider blocks", async () => {
  const artifact = createArtifact();
  let marker = "DONE";
  const recorder = createStructuredGrillTranscriptRecorder({
    provider,
    artifact,
    getActiveCompletionMarker: () => marker,
  });

  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "Decision text DONE protocol text",
    }),
  );
  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "DONE only protocol text",
    }),
  );
  marker = "REPAIR_DONE";
  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "Repair answer REPAIR_DONE later text",
    }),
  );

  assert.deepEqual(artifact.writes, [
    "provider:Decision text ",
    "provider:Repair answer ",
  ]);
});

test("structured grill transcript recorder keeps capture open through grill repair after marker observation", async () => {
  const artifact = createArtifact();
  const recorder = createStructuredGrillTranscriptRecorder({
    provider,
    artifact,
    getActiveCompletionMarker: () => "DONE",
  });

  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "Initial answer DONE",
    }),
  );
  await recorder.recordEvent(
    createEvent({
      type: "submitted-user-message",
      message: "repair answer",
      origin: "human",
    }),
  );
  await recorder.recordEvent(
    createEvent({
      type: "turn-completed",
      assistantMessage: "Fixed answer DONE",
    }),
  );
  await recorder.acceptCompletion();

  assert.deepEqual(artifact.writes, [
    "provider:Initial answer ",
    "user:repair answer",
    "provider:Fixed answer ",
    "complete",
  ]);
});

test("structured grill transcript recorder maps append failures to transcript capture errors", async () => {
  const writeFailure = new Error("disk full");
  const recorder = createStructuredGrillTranscriptRecorder({
    provider,
    artifact: {
      async appendProviderMessage() {
        throw writeFailure;
      },
      async appendUserMessage() {},
      async complete() {},
    },
    getActiveCompletionMarker: () => "DONE",
  });

  await assert.rejects(
    recorder.recordEvent(
      createEvent({
        type: "turn-completed",
        assistantMessage: "Question?",
      }),
    ),
    (error) =>
      error instanceof ProviderSessionTranscriptCaptureError &&
      error.provider === provider &&
      error.cause === writeFailure,
  );
});
