import type { TurnFact } from "../../src/harness/harness.js";
import { historyTextEdges } from "../../src/tui/tui.js";
import assert from "node:assert/strict";
import test from "node:test";
import { openLiveRun } from "../helpers/liveRun.js";
import {
  mountWorkbench,
  runOf,
  press,
  resizeWorkbench,
  noOverflow,
  previewPreferences,
} from "./run-workbench-fixture.js";
import type {
  HistoryContentRead,
  HistoryContentRequest,
} from "../../src/application/projection-port.js";

/** The production Port behind the Workbench, with recorded content reads. */
async function fixture(
  t: Parameters<typeof openLiveRun>[0],
  options: {
    readonly input?: string;
    readonly origin?: "human" | "managed";
    readonly events?: readonly TurnFact[];
    readonly appearance?: "dark" | "light";
  } = {},
) {
  let pendingPreview: (() => void) | undefined;
  const run = await openLiveRun(t, {
    historyTextEdges,
    scheduleHistoryPreview(next) {
      pendingPreview = next;
      return () => {
        pendingPreview = undefined;
      };
    },
  });
  t.after(run.finish);
  run.owner.admitTurn({
    turnId: "turn",
    session: "s",
    attemptId: "0.0:echo",
    origin: options.origin ?? "human",
    kind: "interactive-agent",
    input: options.input ?? "Input",
    recoveryCoordinate: "private",
    harness: "codex",
    at: new Date(),
  });
  for (const event of options.events ?? [])
    run.owner.appendTurnEvent({
      turnId: "turn",
      fact: event,
      at: new Date(),
    });
  const preferences = previewPreferences();
  const wb = await mountWorkbench(
    runOf({
      runId: run.runId,
      sessions: [{ session: "s", name: "Conversation", availability: "open" }],
    }),
    100,
    30,
    undefined,
    true,
    undefined,
    {
      ...preferences,
      snapshot: () => ({
        ...preferences.snapshot(),
        preferences: {
          theme: "everforest",
          appearance: options.appearance ?? "dark",
        },
      }),
    },
  );
  const reads: HistoryContentRequest[] = [],
    replies: HistoryContentRead[] = [],
    released: string[] = [];
  const reader = {
    read: (request: HistoryContentRequest) => {
      reads.push(request);
      return run.port.readHistoryContent(request).then((read) => {
        replies.push(read);
        return read;
      });
    },
    release: (id: string) => {
      released.push(id);
      run.port.releaseHistoryRead(id);
    },
  };
  wb.control.setContentReader(reader.read, reader.release);
  const show = async () => {
    const opened = run.port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
    t.after(opened.close);
    wb.control.setHistory(opened.snapshot);
    await wb.t.renderOnce();
    return opened;
  };
  const opened = await show();
  return {
    ...wb,
    run,
    opened,
    show,
    reads,
    replies,
    released,
    reader,
    flushPreview: () => {
      const next = pendingPreview;
      pendingPreview = undefined;
      next?.();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function frame(wb: Fixture): string {
  return wb.t.captureCharFrame();
}
/** Page in one direction until `marker` is drawn, within a bounded number of keys. */
async function pageUntil(
  wb: Fixture,
  key: "pagedown" | "pageup",
  marker: string,
): Promise<number> {
  for (let presses = 0; presses < 80; presses++) {
    if (frame(wb).includes(marker)) return presses;
    await press(wb.t, wb.renderer, key);
    await wb.t.renderOnce();
    await wb.t.renderOnce();
  }
  assert.fail(`${marker} is never drawn:\n${frame(wb)}`);
}
function assertBoundedReads(wb: Fixture): void {
  for (const read of wb.replies)
    if (read.found && read.type === "history-text")
      assert.ok(read.content.length <= 4096);
}
const body = (label: string, size = 12_000) =>
  `${label}_FIRST\n` +
  Array.from(
    { length: size / 60 },
    (_, i) => `${label} line ${i} ${"界".repeat(20)}`,
  ).join("\n") +
  `\n${label}_LAST`;

for (const appearance of ["dark", "light"] as const)
  test(`m10-audit-history-bounded-content: ${appearance} long human and assistant messages read visible portions in place and page at their edges`, async (t) => {
    const input = body("HUMAN");
    const reply = body("REPLY");
    const wb = await fixture(t, {
      input,
      appearance,
      events: [
        {
          kind: "assistant-content",
          data: { messageId: "m", content: reply },
        },
      ],
    });
    // Fully shown messages need no key: the visible rows read on their own.
    await wb.t.waitForFrame((frame) =>
      frame.includes("More retained text below"),
    );
    assert.ok(wb.reads.length >= 1);
    assert.doesNotMatch(frame(wb), /▸ You|▸ Assistant/);
    await press(wb.t, wb.renderer, "home", { alt: true });
    await wb.t.waitForFrame((frame) => frame.includes("HUMAN_FIRST"));
    await pageUntil(wb, "pagedown", "HUMAN_LAST");
    await pageUntil(wb, "pagedown", "REPLY_FIRST");
    await pageUntil(wb, "pagedown", "REPLY_LAST");
    await pageUntil(wb, "pageup", "REPLY_FIRST");
    assertBoundedReads(wb);
    assert.equal(
      wb.control.view.openRun(wb.run.runId).freshness().kind,
      "current",
    );
    for (const width of [60, 120, 121]) {
      resizeWorkbench(wb.t, wb.renderer, width, 20);
      await wb.t.renderOnce();
      await wb.t.renderOnce();
      noOverflow(frame(wb), width);
      assert.match(frame(wb), /REPLY/);
    }
  });

test("m10-audit-history-bounded-content: a long Steer reads in place and a failed portion retries locally", async (t) => {
  const steer = body("STEER");
  const wb = await fixture(t, {
    events: [
      {
        kind: "steer",
        data: {
          steerId: "s",
          text: steer,
          sentAt: "2026-10-09T00:00:01.000Z",
          settlement: { kind: "delivered", delivery: "within-turn" },
        },
      },
    ],
  });
  await wb.t.waitForFrame((frame) => frame.includes("STEER line"));
  let fail = true;
  wb.control.setContentReader(
    (request) =>
      fail
        ? Promise.resolve({
            found: false,
            problem: {
              code: "test-read-failure",
              explanation: "Unavailable",
              remediation: "Retry",
              possibleEffects: "none",
            },
          })
        : wb.reader.read(request),
    wb.reader.release,
  );
  // A reconnect-free row refresh reopens the reader on the failing source.
  await wb.show();
  await wb.t.waitForFrame((frame) =>
    frame.includes("Error [test-read-failure] · click to retry"),
  );
  assert.equal(
    wb.control.view.openRun(wb.run.runId).freshness().kind,
    "current",
  );
  fail = false;
  const retryLine = frame(wb)
    .split("\n")
    .findIndex((line) => line.includes("Error [test-read-failure]"));
  await wb.t.mockMouse.click(10, retryLine);
  await wb.t.waitForFrame(
    (frame) =>
      !frame.includes("test-read-failure") && frame.includes("STEER line"),
  );
  await press(wb.t, wb.renderer, "home", { alt: true });
  await pageUntil(wb, "pagedown", "STEER_LAST");
  assertBoundedReads(wb);
});

for (const kind of ["thought", "entry-prompt"] as const)
  test(`m10-audit-history-bounded-content: a long ${kind} keeps its collapsed control and reads only while expanded`, async (t) => {
    const content = body(kind === "thought" ? "THOUGHT" : "PROMPT");
    const wb = await fixture(
      t,
      kind === "thought"
        ? {
            events: [{ kind: "thought", data: { summaryId: "t", content } }],
          }
        : { origin: "managed", input: content },
    );
    assert.match(
      frame(wb),
      kind === "thought" ? /▸ Thought/ : /▸ Secant started the Step/,
    );
    assert.equal(wb.reads.length, 0, "collapsed detail reads nothing");
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    const label = kind === "thought" ? "THOUGHT" : "PROMPT";
    await wb.t.waitForFrame((frame) =>
      frame.includes("More retained text below"),
    );
    assert.equal(wb.reads.length, 1);
    await press(wb.t, wb.renderer, "home", { alt: true });
    await wb.t.waitForFrame((frame) => frame.includes(`${label}_FIRST`));
    await pageUntil(wb, "pagedown", `${label}_LAST`);
    assertBoundedReads(wb);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    await wb.t.renderOnce();
    assert.doesNotMatch(frame(wb), new RegExp(`${label}_LAST`));
    assert.ok(
      wb.replies.every(
        (read) => !read.found || wb.released.includes(read.readId),
      ),
      "collapse releases every traversal",
    );
  });

test("m10-audit-history-bounded-content: cut Agent-call and request previews read nothing until inspected, then read complete text", async (t) => {
  const wb = await fixture(t, {
    events: [
      {
        kind: "agent-call",
        data: {
          callId: "c",
          id: "CALL_" + "c".repeat(2_000),
          reason: "Reason",
          answer: {
            outcome: "refused",
            reason: "REFUSAL_" + "r".repeat(20_000),
          },
        },
      },
      {
        kind: "request-raised",
        data: {
          requestId: "r",
          tool: "TOOL",
          input: "REQUEST_" + "q".repeat(20_000),
        },
      },
    ],
  });
  await wb.t.renderOnce();
  assert.match(frame(wb), /▸ Agent call CALL_c/);
  assert.match(frame(wb), /▸ \? Harness Request raised · TOOL ·\s+REQUEST_q/);
  assert.equal(wb.reads.length, 0);
  noOverflow(frame(wb), 100);
  const line = frame(wb)
    .split("\n")
    .findIndex((line) => line.includes("▸ Agent call"));
  await wb.t.mockMouse.click(10, line);
  await wb.t.waitForFrame((frame) => frame.includes("Refusal"));
  assert.equal(wb.reads.length, 1);
  assertBoundedReads(wb);
  await press(wb.t, wb.renderer, "escape");
  await wb.t.renderOnce();
  assert.match(frame(wb), /▸ Agent call CALL_c/);
  assert.ok(
    wb.replies.every(
      (read) => !read.found || wb.released.includes(read.readId),
    ),
    "dismissal releases the inspection read",
  );
});

test("m10-audit-history-bounded-content: a growing live message shows its newest portion while following", async (t) => {
  const wb = await fixture(t);
  const live = body("LIVE", 9_000);
  wb.run.channel.observe({
    message: { turnId: "turn", session: "s", messageId: "m", content: live },
  });
  wb.flushPreview();
  await wb.show();
  await wb.t.waitForFrame((frame) => frame.includes("LIVE_LAST"));
  assert.doesNotMatch(frame(wb), /LIVE_FIRST/);
  assertBoundedReads(wb);
});

test("m10-audit-history-bounded-content: a paused reader keeps its row and offset through a replaced page, and wrapping", async (t) => {
  const reply = body("REPLY");
  const wb = await fixture(t, {
    events: [
      {
        kind: "assistant-content",
        data: { messageId: "m", content: reply },
      },
    ],
  });
  await press(wb.t, wb.renderer, "home", { alt: true });
  await pageUntil(wb, "pagedown", "REPLY line 40 ");
  await press(wb.t, wb.renderer, "down");
  await wb.t.renderOnce();
  const anchored = frame(wb)
    .split("\n")
    .find((line) => line.includes("REPLY line"))!
    .trim();
  wb.run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "assistant-content",
      data: { messageId: "later", content: "LATER_ROW" },
    },
    at: new Date(),
  });
  const update = await wb.opened.updates[Symbol.asyncIterator]().next();
  assert.ok(update.value?.kind === "durable");
  wb.control.setHistory(update.value.snapshot);
  await wb.t.renderOnce();
  await wb.t.renderOnce();
  const first = () =>
    frame(wb)
      .split("\n")
      .find((line) => line.includes("REPLY line"))
      ?.trim();
  assert.equal(first(), anchored, "a replaced page keeps the paused anchor");
  assert.doesNotMatch(frame(wb), /LATER_ROW/);
  resizeWorkbench(wb.t, wb.renderer, 121, 30);
  await wb.t.renderOnce();
  resizeWorkbench(wb.t, wb.renderer, 100, 30);
  await wb.t.renderOnce();
  await wb.t.renderOnce();
  assert.equal(first(), anchored, "wrapping round trips keep the anchor");
  await press(wb.t, wb.renderer, "end", { alt: true });
  await wb.t.waitForFrame((frame) => frame.includes("LATER_ROW"));
});
