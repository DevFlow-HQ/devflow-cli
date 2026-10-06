import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TurnEvent } from "../../src/harness/harness.js";
import {
  init,
  prepare,
  scriptedClaude,
  turnRequest,
} from "./scripted-claude.js";

// Native field qualification uses unchanged authentic recording frames. The
// scripted Process supplies only init/terminal control and semantic timing.
function frames(path: string): Record<string, unknown>[] {
  return readFileSync(
    new URL(`fixtures/claude-code/${path}`, import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("m10-observed-harness-facts: authentic Claude assistant messages carry their identity once before the result", async () => {
  const assistant = frames("plain/turn-1.stdout").filter(
    (f) => f.type === "assistant",
  );
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      ...assistant,
      { type: "result", subtype: "success", result: "hello" },
    ],
  });
  const harness = await prepare(scripted);
  try {
    const events: TurnEvent[] = [];
    const turn = harness.startTurn(turnRequest("Reply hello"));
    turn.subscribe((e) => events.push(e));
    assert.equal((await turn.result()).kind, "completed");
    assert.deepEqual(
      events.filter((e) => e.kind === "assistant-content"),
      [
        {
          kind: "assistant-content",
          messageId: "msg_011Cf6xyEd9fUEnohMzuCJyi",
          content: "hello",
        },
      ],
    );
    const count = events.length;
    await Promise.resolve();
    assert.equal(events.length, count, "no events after authoritative result");
  } finally {
    await harness.close();
  }
});

test("m10-observed-harness-facts: authentic Claude stream identity retains only known partial text on interrupted settlement", async () => {
  const stream = frames("interrupt/turn-1.stdout").filter(
    (f) => f.type === "stream_event",
  );
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [init, ...stream],
  });
  const harness = await prepare(scripted);
  try {
    const events: TurnEvent[] = [];
    let ready!: () => void;
    const preview = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const turn = harness.startTurn(turnRequest("Stream a reply"));
    turn.subscribe((e) => {
      events.push(e);
      if (e.kind === "message-preview") ready();
    });
    await preview;
    await turn.interrupt();
    assert.equal((await turn.result()).kind, "interrupted");
    const messages = events.filter((e) => e.kind === "assistant-content");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.messageId, "msg_011CfftdJe6vfYEfgBUZaDUq");
    assert.equal(messages[0]?.incomplete, true);
    assert.equal(messages[0]?.content, "#");
  } finally {
    await harness.close();
  }
});

test("m10-observed-harness-facts: unqualified stream identity stays absent", async () => {
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      {
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "unknown" } },
      },
    ],
  });
  const harness = await prepare(scripted);
  try {
    const events: TurnEvent[] = [];
    let ready!: () => void;
    const preview = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const turn = harness.startTurn(turnRequest("Stream"));
    turn.subscribe((e) => {
      events.push(e);
      if (e.kind === "session") ready();
    });
    await preview;
    await turn.interrupt();
    await turn.result();
    assert.equal(
      events.some((e) => e.kind === "message-preview"),
      false,
    );
    assert.equal(
      events.filter((e) => e.kind === "assistant-content").length,
      0,
    );
  } finally {
    await harness.close();
  }
});

for (const completeSecond of [false, true]) {
  test(`m10-observed-harness-facts: distinct native messages retain their own text when second completion is ${completeSecond}`, async () => {
    const first = frames("interrupt/turn-1.stdout").filter(
      (f) => f.type === "stream_event",
    );
    const second = frames("interrupt/turn-2.stdout");
    const scripted = scriptedClaude({
      answer: "confirm",
      userFrame: () => [
        init,
        ...first,
        ...second.filter(
          (f) =>
            f.type === "stream_event" ||
            (completeSecond && f.type === "assistant"),
        ),
        ...(completeSecond
          ? [{ type: "result", subtype: "success", result: "continued." }]
          : []),
      ],
    });
    const harness = await prepare(scripted);
    try {
      const events: TurnEvent[] = [];
      let ready!: () => void;
      const preview = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const turn = harness.startTurn(turnRequest("Stream two messages"));
      turn.subscribe((e) => {
        events.push(e);
        if (e.kind === "message-preview" && e.content.endsWith("continued."))
          ready();
      });
      if (!completeSecond) {
        await preview;
        await turn.interrupt();
      }
      assert.equal(
        (await turn.result()).kind,
        completeSecond ? "completed" : "interrupted",
      );
      assert.deepEqual(
        events.filter((e) => e.kind === "assistant-content"),
        completeSecond
          ? [
              {
                kind: "assistant-content",
                messageId: "msg_011CfftdjfG5U24L6VzJmpca",
                content: "continued.",
              },
              {
                kind: "assistant-content",
                messageId: "msg_011CfftdJe6vfYEfgBUZaDUq",
                content: "#",
                incomplete: true,
              },
            ]
          : [
              {
                kind: "assistant-content",
                messageId: "msg_011CfftdJe6vfYEfgBUZaDUq",
                content: "#",
                incomplete: true,
              },
              {
                kind: "assistant-content",
                messageId: "msg_011CfftdjfG5U24L6VzJmpca",
                content: "continued.",
                incomplete: true,
              },
            ],
      );
    } finally {
      await harness.close();
    }
  });
}

test("m10-interruption-and-transcript: successful settlement retains unfinished identified text as incomplete", async () => {
  const streamed = frames("interrupt/turn-1.stdout").filter(
    (frame) => frame.type === "stream_event",
  );
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      ...streamed,
      { type: "result", subtype: "success", result: "" },
    ],
  });
  const harness = await prepare(scripted);
  try {
    const events: TurnEvent[] = [];
    const turn = harness.startTurn(
      turnRequest("Success without message terminal"),
    );
    turn.subscribe((event) => events.push(event));
    assert.equal((await turn.result()).kind, "completed");
    assert.deepEqual(
      events.filter((event) => event.kind === "assistant-content"),
      [
        {
          kind: "assistant-content",
          messageId: "msg_011CfftdJe6vfYEfgBUZaDUq",
          content: "#",
          incomplete: true,
        },
      ],
    );
  } finally {
    await harness.close();
  }
});
