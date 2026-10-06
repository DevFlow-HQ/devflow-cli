import type { SessionHistoryRow } from "../../src/application/projection-port.js";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { openLiveRun } from "../helpers/liveRun.js";

test("m10-session-history: a known Session opens atomically and catches up current identified messages", async (t) => {
  const { port, runId, owner, channel, finish } = await openLiveRun(t);
  t.after(finish);
  assert.ok(
    owner.admitTurn({
      turnId: "turn-1",
      attemptId: "0.0:echo",
      session: "conversation",
      origin: "human",
      kind: "interactive-agent",
      input: "Hello",
      recoveryCoordinate: "private-native-session",
      harness: "codex",
      at: new Date("2026-10-06T00:00:00Z"),
    }).ok,
  );
  const opened = port.openProjection({
    family: "session-history",
    runId,
    session: "conversation",
  });
  t.after(() => opened.close());
  assert.ok(opened.snapshot.result.found);
  assert.deepEqual(
    opened.snapshot.result.history.rows.map((row) => row.value.kind),
    ["message"],
  );
  channel.observe({
    message: {
      turnId: "turn-1",
      session: "conversation",
      messageId: "private-message-id",
      content: "Growing",
    },
  });
  const late = port.openProjection({
    family: "session-history",
    runId,
    session: "conversation",
  });
  t.after(() => late.close());
  assert.ok(late.snapshot.result.found);
  const row = late.snapshot.result.history.rows.at(-1)!;
  assert.equal(row.source, "preview");
  assert.deepEqual(row.value, {
    kind: "message",
    role: "assistant",
    content: "Growing",
  });
  assert.ok(!row.id.includes("private-message-id"));
  assert.ok(
    owner.appendTurnEvent({
      turnId: "turn-1",
      kind: "assistant-content",
      payload: JSON.stringify({
        messageId: "private-message-id",
        content: "Complete",
      }),
      at: new Date(),
    }).ok,
  );
  const settled = await late.updates[Symbol.asyncIterator]().next();
  assert.ok(settled.value?.kind === "durable");
  assert.ok(settled.value.snapshot.result.found);
  const final: SessionHistoryRow =
    settled.value.snapshot.result.history.rows.at(-1)!;
  assert.equal(final.id, row.id);
  assert.equal(final.position, row.position);
  assert.equal(final.source, "stored");
  assert.deepEqual(final.value, {
    kind: "message",
    role: "assistant",
    content: "Complete",
  });
  await finish();
});

function clock() {
  let callback: (() => void) | undefined;
  const delays: number[] = [];
  return {
    delays,
    schedule: (next: () => void, delay: number) => {
      assert.equal(callback, undefined);
      delays.push(delay);
      callback = next;
      return () => {
        callback = undefined;
      };
    },
    flush: () => {
      const next = callback;
      callback = undefined;
      next?.();
    },
  };
}
function admit(
  owner: import("../../src/run/store/store.js").RunOwner,
  turnId = "turn",
  session = "s",
) {
  assert.ok(
    owner.admitTurn({
      turnId,
      session,
      attemptId: "0.0:echo",
      origin: "human",
      kind: "interactive-agent",
      input: "Input",
      recoveryCoordinate: "private",
      harness: "codex",
      at: new Date("2026-10-06T00:00:00Z"),
    }).ok,
  );
}
test("m10-session-history: previews coalesce every row's complete value once per Run, never write chunks, and terminal publication cancels queued values", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => opened.close());
  const reader = opened.updates[Symbol.asyncIterator]();
  const before = run.owner.turnEvents();
  for (const [messageId, content] of [
    ["one", "A"],
    ["two", "B"],
    ["one", "Final A"],
  ])
    run.channel.observe({
      message: { turnId: "turn", session: "s", messageId, content },
    });
  assert.deepEqual(run.owner.turnEvents(), before);
  assert.deepEqual(timer.delays, [50]);
  timer.flush();
  for (const content of ["Final A", "B"]) {
    const update = await reader.next();
    assert.ok(update.value?.kind === "history-preview");
    assert.deepEqual(update.value.row.value, {
      kind: "message",
      role: "assistant",
      content,
    });
  }
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "one",
      content: "stale",
    },
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "assistant-content",
    payload: JSON.stringify({ messageId: "one", content: "" }),
    at: new Date(),
  });
  const terminal = await reader.next();
  assert.ok(terminal.value?.kind === "durable");
  assert.ok(terminal.value.snapshot.result.found);
  assert.deepEqual(terminal.value.snapshot.result.history.rows[1]?.value, {
    kind: "message",
    role: "assistant",
    content: "",
  });
  timer.flush();
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "one",
      content: "resurrected",
    },
  });
  timer.flush();
  const reopened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => reopened.close());
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(reopened.snapshot.result.history.rows[1]?.value, {
    kind: "message",
    role: "assistant",
    content: "",
  });
  await run.finish();
});
test("m10-session-history: the combined 200-row window evicts live-only messages and never resurrects them", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => opened.close());
  for (let index = 0; index < 200; index++)
    run.channel.observe({
      message: {
        turnId: "turn",
        session: "s",
        messageId: `message-${index}`,
        content: `row-${index}`,
      },
    });
  timer.flush();
  const late = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => late.close());
  assert.ok(late.snapshot.result.found);
  assert.equal(late.snapshot.result.history.rows.length, 200);
  assert.equal(late.snapshot.result.history.hasEarlier, true);
  assert.deepEqual(late.snapshot.result.history.rows[0]?.value, {
    kind: "message",
    role: "assistant",
    content: "row-0",
  });
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "message-200",
      content: "newest",
    },
  });
  timer.flush();
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "message-0",
      content: "resurrected",
    },
  });
  timer.flush();
  const latest = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => latest.close());
  assert.ok(latest.snapshot.result.found);
  assert.equal(latest.snapshot.result.history.rows.length, 200);
  assert.equal(latest.snapshot.result.history.hasEarlier, true);
  assert.deepEqual(latest.snapshot.result.history.rows[0]?.value, {
    kind: "message",
    role: "assistant",
    content: "row-1",
  });
  await run.finish();
});

test("m10-session-history: first appearance survives late settlement and reopen; ids are scoped to a subscription", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => opened.close());
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "reused-native-id",
      content: "Starts before tool",
    },
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "tool-activity",
    payload: JSON.stringify({
      tool: "Read",
      phase: "started",
      summary: "file",
    }),
    at: new Date(),
  });
  const page = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(page.value?.kind === "durable");
  assert.ok(page.value.snapshot.result.found);
  const initial = page.value.snapshot.result.history.rows[1]!;
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "assistant-content",
    payload: JSON.stringify({
      messageId: "reused-native-id",
      content: "Settles after tool",
    }),
    at: new Date(),
  });
  const final = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(final.value?.kind === "durable");
  assert.ok(final.value.snapshot.result.found);
  assert.equal(final.value.snapshot.result.history.rows[1]?.id, initial.id);
  assert.equal(
    final.value.snapshot.result.history.rows[1]?.position,
    initial.position,
  );
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "detached",
    at: new Date("2026-10-06T00:00:01Z"),
  });
  admit(run.owner, "turn-two");
  run.owner.appendTurnEvent({
    turnId: "turn-two",
    kind: "assistant-content",
    payload: JSON.stringify({
      messageId: "reused-native-id",
      content: "Second Turn",
    }),
    at: new Date(),
  });
  admit(run.owner, "turn-three", "other");
  run.owner.appendTurnEvent({
    turnId: "turn-three",
    kind: "assistant-content",
    payload: JSON.stringify({
      messageId: "reused-native-id",
      content: "Other Session",
    }),
    at: new Date(),
  });
  await run.finish();
  const reopened = run.reopen().openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => reopened.close());
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(
    reopened.snapshot.result.history.rows.map((row) => row.value.kind),
    ["message", "message", "activity", "turn-result", "message", "message"],
  );
  assert.deepEqual(reopened.snapshot.result.history.rows[1]?.value, {
    kind: "message",
    role: "assistant",
    content: "Settles after tool",
  });
  assert.deepEqual(reopened.snapshot.result.history.rows.at(-1)?.value, {
    kind: "message",
    role: "assistant",
    content: "Second Turn",
  });
  assert.notEqual(reopened.snapshot.result.history.rows[1]?.id, initial.id);
});

test("m10-session-history: missing Run and Session are typed Problems; a known empty Session is an empty view", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  const missingRun = run.port.openProjection({
    family: "session-history",
    runId: "missing",
    session: "s",
  });
  t.after(() => missingRun.close());
  assert.ok(!missingRun.snapshot.result.found);
  assert.equal(missingRun.snapshot.result.problem.code, "run-not-found");
  const missingSession = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "missing",
  });
  t.after(() => missingSession.close());
  assert.ok(!missingSession.snapshot.result.found);
  assert.equal(
    missingSession.snapshot.result.problem.code,
    "run-session-not-found",
  );
  // Seed an existing Session with no retained Turns, as a persisted empty-Session fixture.
  admit(run.owner, "fixture-empty", "empty");
  const groupFolder = readdirSync(join(run.storeHome, "runs"))[0]!;
  const fixture = new Database(
    join(run.storeHome, "runs", groupFolder, run.runId, "run.db"),
  );
  try {
    fixture.run("DELETE FROM turn_event WHERE turn_id = 'fixture-empty'");
    fixture.run("DELETE FROM turn WHERE turn_id = 'fixture-empty'");
  } finally {
    fixture.close();
  }
  const empty = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "empty",
  });
  t.after(() => empty.close());
  assert.ok(empty.snapshot.result.found);
  assert.deepEqual(empty.snapshot.result.history.rows, []);
  assert.equal(empty.snapshot.result.history.hasEarlier, false);
  await run.finish();
});

test("m10-session-history: a slow history observer closes alone; healthy FIFO publication and reopen preserve current truth", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  const slow = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => slow.close());
  const healthy = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => healthy.close());
  const reader = healthy.updates[Symbol.asyncIterator]();
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "assistant-content",
    payload: JSON.stringify({
      messageId: "large-message",
      content: "x".repeat(4 * 1024 * 1024),
    }),
    at: new Date(),
  });
  await reader.next();
  for (let index = 0; index < 3; index++) {
    run.owner.writeState("running");
    const update = await reader.next();
    assert.ok(update.value?.kind === "durable");
    assert.ok(update.value.snapshot.result.found);
    assert.deepEqual(update.value.snapshot.result.history.rows[0]?.value, {
      kind: "message",
      role: "user",
      content: "Input",
    });
  }
  const lagged = slow.updates[Symbol.asyncIterator]();
  assert.deepEqual(await lagged.next(), {
    done: false,
    value: { kind: "closed", reason: "observer-lagged" },
  });
  assert.equal((await lagged.next()).done, true);
  const reopened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => reopened.close());
  assert.ok(reopened.snapshot.result.found);
  assert.equal(reopened.snapshot.result.history.rows.length, 2);
  await run.finish();
});

test("m10-interruption-and-transcript: partials, Steer delivery, Agent-call disposition, model and duration stay truthful through settlement", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  for (const [kind, value] of [
    [
      "assistant-content",
      { messageId: "partial", content: "Known partial", incomplete: true },
    ],
    [
      "steer",
      {
        steerId: "waiting",
        text: "Waiting",
        sentAt: "2026-10-06T00:00:00Z",
        settlement: { kind: "waiting" },
      },
    ],
    [
      "steer",
      {
        steerId: "delivered",
        text: "Delivered",
        sentAt: "2026-10-06T00:00:00Z",
        settlement: { kind: "delivered", delivery: "within-turn" },
      },
    ],
    [
      "agent-call",
      {
        callId: "call",
        id: "step_done",
        reason: "Ready",
        answer: { outcome: "accepted" },
      },
    ],
    ["model", { model: "observed-model" }],
  ] as const)
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind,
      payload: JSON.stringify(value),
      at: new Date(),
    });
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "interrupted",
    resultDetail: "{}",
    availability: "detached",
    at: new Date("2026-10-06T00:00:03Z"),
  });
  const view = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => view.close());
  assert.ok(view.snapshot.result.found);
  const rows = view.snapshot.result.history.rows.map((row) => row.value);
  assert.deepEqual(rows, [
    { kind: "message", role: "user", content: "Input" },
    {
      kind: "message",
      role: "assistant",
      content: "Known partial",
      incomplete: true,
    },
    { kind: "steer", content: "Waiting", delivery: "not-delivered" },
    { kind: "steer", content: "Delivered", delivery: "within-turn" },
    {
      kind: "agent-call",
      call: "step_done",
      reason: "Ready",
      reply: "accepted",
      disposition: "dropped",
    },
    {
      kind: "turn-result",
      origin: "human",
      result: "interrupted",
      model: "observed-model",
      durationMs: 3000,
    },
  ]);
  const transcript = run.port.readTranscript(
    view.snapshot.result.history.transcriptExport,
  );
  assert.ok(transcript.found);
  assert.deepEqual(
    transcript.entries.map((entry) => entry.content),
    ["Input", "Known partial", "Delivered"],
  );
  await run.finish();
});
for (const result of ["lost", "not-started"] as const)
  test(`m10-interruption-and-transcript: ${result} has no invented duration and reopening discards memory-only chunks`, async (t) => {
    const run = await openLiveRun(t);
    t.after(run.finish);
    admit(run.owner);
    run.channel.observe({
      message: {
        turnId: "turn",
        session: "s",
        messageId: "memory-only",
        content: "Unrecoverable",
      },
    });
    // A restarted Application can know only durable facts. No partial append occurred.
    run.owner.settleTurn({
      turnId: "turn",
      session: "s",
      resultKind: result,
      resultDetail: "{}",
      availability: "detached",
      at: new Date("2026-10-06T00:00:03Z"),
    });
    await run.finish();
    const reopened = run.reopen().openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
    t.after(() => reopened.close());
    assert.ok(reopened.snapshot.result.found);
    assert.deepEqual(
      reopened.snapshot.result.history.rows.map((row) => row.value),
      [
        { kind: "message", role: "user", content: "Input" },
        { kind: "turn-result", origin: "human", result },
      ],
    );
  });
