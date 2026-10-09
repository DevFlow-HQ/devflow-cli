import type { SessionHistoryRow } from "../../src/application/projection-port.js";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  ProjectionPort,
  ProjectionSelector,
} from "../../src/application/projection-port.js";
import { openLiveRun } from "../helpers/liveRun.js";

function openHistory({
  t,
  port,
  ...selection
}: Omit<
  Extract<ProjectionSelector, { family: "session-history" }>,
  "family"
> & { t: TestContext; port: ProjectionPort }) {
  const opened = port.openProjection({
    family: "session-history",
    ...selection,
  });
  t.after(() => opened.close());
  return opened;
}

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
  const opened = openHistory({ t, port: port, runId, session: "conversation" });
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
  const late = openHistory({ t, port: port, runId, session: "conversation" });
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
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
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
  const reopened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
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
  openHistory({ t, port: run.port, runId: run.runId, session: "s" });
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
  const late = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
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
  const latest = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
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

test("m12-local-test-helpers: first appearance survives late settlement and reopen; ids are scoped to a subscription", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
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
    kind: "tool-call",
    payload: JSON.stringify({
      callId: "ordered-call",
      tool: "read",
      input: "file",
      outcome: { kind: "running" },
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
  const reopened = openHistory({
    t,
    port: run.reopen(),
    runId: run.runId,
    session: "s",
  });
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(
    reopened.snapshot.result.history.rows.map((row) => row.value.kind),
    ["message", "message", "tool", "turn-result", "message", "message"],
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
  const missingRun = openHistory({
    t,
    port: run.port,
    runId: "missing",
    session: "s",
  });
  assert.ok(!missingRun.snapshot.result.found);
  assert.equal(missingRun.snapshot.result.problem.code, "run-not-found");
  const missingSession = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "missing",
  });
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
  const empty = openHistory({
    t,
    port: run.reopen(),
    runId: run.runId,
    session: "empty",
  });
  assert.ok(empty.snapshot.result.found);
  assert.deepEqual(empty.snapshot.result.history.rows, []);
  assert.equal(empty.snapshot.result.history.hasEarlier, false);
  await run.finish();
});

test("m10-session-history: a slow history observer closes alone; healthy FIFO publication and reopen preserve current truth", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  const slow = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const healthy = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
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
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "assistant-content",
      payload: JSON.stringify({
        messageId: `changed-${index}`,
        content: `Changed ${index}`,
      }),
      at: new Date(),
    });
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
  const reopened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(reopened.snapshot.result.found);
  assert.equal(reopened.snapshot.result.history.rows.length, 5);
  await run.finish();
});

test("m10-interruption-and-transcript: partials, Agent-call disposition, model and duration stay truthful through settlement", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  for (const [kind, value] of [
    [
      "assistant-content",
      { messageId: "partial", content: "Known partial", incomplete: true },
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
  const view = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
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
    ["Input", "Known partial"],
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
    const reopened = openHistory({
      t,
      port: run.reopen(),
      runId: run.runId,
      session: "s",
    });
    assert.ok(reopened.snapshot.result.found);
    assert.deepEqual(
      reopened.snapshot.result.history.rows.map((row) => row.value),
      [
        { kind: "message", role: "user", content: "Input" },
        { kind: "turn-result", origin: "human", result },
      ],
    );
  });

test("m10-session-history: interleaved same-name tools settle in their original rows and unmatched tools stay unconfirmed", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const reader = opened.updates[Symbol.asyncIterator]();
  const append = (callId: string, input: string, outcome: object) =>
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "tool-call",
      payload: JSON.stringify({ callId, tool: "read", input, outcome }),
      at: new Date(),
    });
  append("one", "first.ts", { kind: "running" });
  const first = await reader.next();
  assert.ok(
    first.value?.kind === "durable" && first.value.snapshot.result.found,
  );
  const row = first.value.snapshot.result.history.rows[1]!;
  assert.deepEqual(row.value, {
    kind: "tool",
    tool: "read",
    input: "first.ts",
    outcome: { kind: "running" },
  });
  append("two", "second.ts", { kind: "running" });
  await reader.next();
  append("two", "second.ts", { kind: "failed", error: "Cannot read" });
  await reader.next();
  append("one", "first.ts", { kind: "completed" });
  const final = await reader.next();
  assert.ok(
    final.value?.kind === "durable" && final.value.snapshot.result.found,
  );
  assert.equal(final.value.snapshot.result.history.rows.length, 3);
  assert.equal(final.value.snapshot.result.history.rows[1]?.id, row.id);
  assert.equal(
    final.value.snapshot.result.history.rows[1]?.position,
    row.position,
  );
  append("three", "unmatched.ts", { kind: "running" });
  await reader.next();
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "detached",
    at: new Date(),
  });
  const settled = await reader.next();
  assert.ok(
    settled.value?.kind === "durable" && settled.value.snapshot.result.found,
  );
  assert.deepEqual(settled.value.snapshot.result.history.rows[3]?.value, {
    kind: "tool",
    tool: "read",
    input: "unmatched.ts",
    outcome: { kind: "unconfirmed" },
  });
  assert.doesNotMatch(JSON.stringify(settled.value), /"callId"|"parentCallId"/);
  await run.finish();
  const reopened = openHistory({
    t,
    port: run.reopen(),
    runId: run.runId,
    session: "s",
  });
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(
    reopened.snapshot.result.history.rows.map((r) => r.value),
    settled.value.snapshot.result.history.rows.map(
      (r: SessionHistoryRow) => r.value,
    ),
  );
});

test("m10-session-history: tool previews share the message budget, remain complete, and cannot follow a terminal page", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const reader = opened.updates[Symbol.asyncIterator]();
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "tool-call",
    payload: JSON.stringify({
      callId: "call",
      parentCallId: "parent",
      tool: "search",
      input: "original",
      outcome: { kind: "running" },
    }),
    at: new Date(),
  });
  const initial = await reader.next();
  assert.ok(
    initial.value?.kind === "durable" && initial.value.snapshot.result.found,
  );
  const row = initial.value.snapshot.result.history.rows[1]!;
  const before = run.owner.turnEvents();
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "message",
      content: "Growing",
    },
  });
  for (const input of ["stale", "latest"])
    run.channel.observe({
      tool: {
        turnId: "turn",
        session: "s",
        call: {
          callId: "call",
          parentCallId: "parent",
          tool: "search",
          input,
          count: { value: 0, unit: "matches" },
          outcome: { kind: "running" },
        },
      },
    });
  assert.deepEqual(run.owner.turnEvents(), before);
  assert.deepEqual(timer.delays, [50]);
  const late = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(late.snapshot.result.found);
  assert.deepEqual(late.snapshot.result.history.rows[1]?.value, {
    kind: "tool",
    tool: "search",
    input: "latest",
    count: { value: 0, unit: "matches" },
    outcome: { kind: "running" },
  });
  timer.flush();
  const preview = await reader.next();
  assert.ok(preview.value?.kind === "history-preview");
  assert.equal(preview.value.row.id, row.id);
  assert.equal(preview.value.row.position, row.position);
  await reader.next();
  run.channel.observe({
    tool: {
      turnId: "turn",
      session: "s",
      call: {
        callId: "call",
        tool: "search",
        input: "obsolete",
        outcome: { kind: "running" },
      },
    },
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "tool-call",
    payload: JSON.stringify({
      callId: "call",
      tool: "search",
      input: "final",
      outcome: { kind: "declined", reason: "Not allowed" },
    }),
    at: new Date(),
  });
  const final = await reader.next();
  assert.ok(
    final.value?.kind === "durable" && final.value.snapshot.result.found,
  );
  assert.deepEqual(final.value.snapshot.result.history.rows[1]?.value, {
    kind: "tool",
    tool: "search",
    input: "final",
    outcome: { kind: "declined", reason: "Not allowed" },
  });
  assert.equal(final.value.snapshot.result.history.rows[1]?.id, row.id);
  assert.equal(final.value.snapshot.result.history.rows[1]?.source, "stored");
  timer.flush();
  run.channel.observe({
    tool: {
      turnId: "turn",
      session: "s",
      call: {
        callId: "call",
        tool: "search",
        input: "resurrection",
        outcome: { kind: "running" },
      },
    },
  });
  timer.flush();
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "assistant-content",
    payload: JSON.stringify({ messageId: "message", content: "Complete" }),
    at: new Date(),
  });
  const next = await reader.next();
  assert.ok(
    next.value?.kind === "durable",
    "no queued stale tool preview follows terminal replacement",
  );
  await run.finish();
});

for (const resultKind of ["completed", "interrupted", "lost"])
  test(`m10-interruption-and-transcript: ${resultKind} leaves unmatched tools unconfirmed across Turns and Sessions without inventing results`, async (t) => {
    const run = await openLiveRun(t);
    t.after(run.finish);
    admit(run.owner);
    const append = (turnId: string, input: string, outcome: object) =>
      run.owner.appendTurnEvent({
        turnId,
        kind: "tool-call",
        payload: JSON.stringify({
          callId: "reused",
          tool: "command",
          input,
          outcome,
        }),
        at: new Date(),
      });
    append("turn", "first", { kind: "running" });
    run.owner.settleTurn({
      turnId: "turn",
      session: "s",
      resultKind,
      resultDetail: "{}",
      availability: "detached",
      at: new Date(),
    });
    admit(run.owner, "second");
    append("second", "second", { kind: "running" });
    append("second", "second", { kind: "completed" });
    admit(run.owner, "third", "other");
    append("third", "other Session", { kind: "running" });
    const page = openHistory({
      t,
      port: run.port,
      runId: run.runId,
      session: "s",
    });
    assert.ok(page.snapshot.result.found);
    assert.deepEqual(
      page.snapshot.result.history.rows
        .filter((row) => row.value.kind === "tool")
        .map((row) => row.value),
      [
        {
          kind: "tool",
          tool: "command",
          input: "first",
          outcome: { kind: "unconfirmed" },
        },
        {
          kind: "tool",
          tool: "command",
          input: "second",
          outcome: { kind: "completed" },
        },
      ],
    );
    assert.equal(
      run.owner.turnEvents().filter((event) => event.kind === "tool-call")
        .length,
      4,
    );
    assert.deepEqual(
      run.owner.transcript().map((entry) => entry.content),
      ["Input", "Input", "Input"],
      "tools stay out of stored transcript",
    );
    await run.finish();
    const reopened = openHistory({
      t,
      port: run.reopen(),
      runId: run.runId,
      session: "s",
    });
    assert.ok(reopened.snapshot.result.found);
    assert.deepEqual(
      reopened.snapshot.result.history.rows
        .filter((row) => row.value.kind === "tool")
        .map((row) => row.value),
      page.snapshot.result.history.rows
        .filter((row) => row.value.kind === "tool")
        .map((row) => row.value),
    );
  });

test("m10-session-history: one mixed 200/201 bound counts calls once and evicted starts never return on settlement", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  for (let i = 0; i < 199; i++) {
    if (i % 2 === 0)
      run.owner.appendTurnEvent({
        turnId: "turn",
        kind: "tool-call",
        payload: JSON.stringify({
          callId: `call-${i}`,
          tool: "read",
          input: `file-${i}`,
          outcome: { kind: "running" },
        }),
        at: new Date(),
      });
    else
      run.channel.observe({
        message: {
          turnId: "turn",
          session: "s",
          messageId: `message-${i}`,
          content: `message-${i}`,
        },
      });
  }
  const page = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(page.snapshot.result.found);
  assert.equal(page.snapshot.result.history.rows.length, 200);
  assert.equal(page.snapshot.result.history.hasEarlier, false);
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "tool-call",
    payload: JSON.stringify({
      callId: "newest",
      tool: "other",
      input: "newest",
      outcome: { kind: "running" },
    }),
    at: new Date(),
  });
  const update = await page.updates[Symbol.asyncIterator]().next();
  assert.ok(
    update.value?.kind === "durable" && update.value.snapshot.result.found,
  );
  assert.equal(update.value.snapshot.result.history.rows.length, 200);
  assert.equal(update.value.snapshot.result.history.hasEarlier, true);
  const call = update.value.snapshot.result.history.rows[0]!;
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "overflow",
      content: "new message",
    },
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "tool-call",
    payload: JSON.stringify({
      callId: "call-0",
      tool: "read",
      input: "evicted terminal",
      outcome: { kind: "completed" },
    }),
    at: new Date(),
  });
  const settled = await page.updates[Symbol.asyncIterator]().next();
  assert.ok(
    settled.value?.kind === "durable" && settled.value.snapshot.result.found,
  );
  assert.equal(settled.value.snapshot.result.history.rows.length, 200);
  assert.equal(
    settled.value.snapshot.result.history.rows.some(
      (row: SessionHistoryRow) => row.id === call.id,
    ),
    false,
  );
  assert.doesNotMatch(JSON.stringify(settled.value), /evicted terminal/);
  await run.finish();
});

test("m10-session-history: terminal removal of memory-only previews never resurrects an evicted stored tool in the same subscription", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  for (let i = 0; i < 200; i++)
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "tool-call",
      payload: JSON.stringify({
        callId: `tool-${i}`,
        tool: "read",
        input: `file-${i}`,
        outcome: { kind: "running" },
      }),
      at: new Date(),
    });
  for (let i = 0; i < 2; i++)
    run.channel.observe({
      message: {
        turnId: "turn",
        session: "s",
        messageId: `preview-${i}`,
        content: "Memory-only",
      },
    });
  const page = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(page.snapshot.result.found);
  assert.equal(page.snapshot.result.history.rows.length, 200);
  assert.deepEqual(page.snapshot.result.history.rows[0]?.value, {
    kind: "tool",
    tool: "read",
    input: "file-2",
    outcome: { kind: "running" },
  });
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "detached",
    at: new Date(),
  });
  const settled = await page.updates[Symbol.asyncIterator]().next();
  assert.ok(
    settled.value?.kind === "durable" && settled.value.snapshot.result.found,
  );
  assert.deepEqual(settled.value.snapshot.result.history.rows[0]?.value, {
    kind: "tool",
    tool: "read",
    input: "file-2",
    outcome: { kind: "unconfirmed" },
  });
  assert.equal(settled.value.snapshot.result.history.rows.length, 199);
  assert.equal(settled.value.snapshot.result.history.hasEarlier, true);
  assert.equal(
    settled.value.snapshot.result.history.rows[0]?.id,
    page.snapshot.result.history.rows[0]?.id,
  );
  await run.finish();
});

test("m10-session-history: Thought preview/final reconciliation keeps first position without chunk writes or transcript content", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const before = run.owner.turnEvents();
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "private-summary",
      content: "First line\nGrowing body",
    },
  });
  assert.deepEqual(run.owner.turnEvents(), before);
  timer.flush();
  const reader = opened.updates[Symbol.asyncIterator]();
  const preview = await reader.next();
  assert.ok(preview.value?.kind === "history-preview");
  const row = preview.value.row;
  assert.deepEqual(row.value, {
    kind: "thought",
    content: "First line\nGrowing body",
  });
  assert.ok(!row.id.includes("private-summary"));
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "tool-call",
    payload: JSON.stringify({
      callId: "tool",
      tool: "read",
      input: "file",
      outcome: { kind: "running" },
    }),
    at: new Date(),
  });
  await reader.next();
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "private-summary",
      content: "Stale queued body",
    },
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "thought",
    payload: JSON.stringify({
      summaryId: "private-summary",
      content: "First line\nAuthoritative full body",
      durationMs: 1200,
    }),
    at: new Date(),
  });
  const final = await reader.next();
  assert.ok(final.value?.kind === "durable");
  assert.ok(final.value.snapshot.result.found);
  const settled = final.value.snapshot.result.history.rows[1]!;
  assert.equal(settled.id, row.id);
  assert.equal(settled.position, row.position);
  assert.equal(settled.source, "stored");
  assert.deepEqual(settled.value, {
    kind: "thought",
    content: "First line\nAuthoritative full body",
    durationMs: 1200,
  });
  assert.equal(final.value.snapshot.result.history.rows[2]?.value.kind, "tool");
  timer.flush();
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "private-summary",
      content: "Late stale body",
    },
  });
  timer.flush();
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "thought",
    payload: JSON.stringify({
      summaryId: "private-summary",
      content: "Duplicate",
    }),
    at: new Date(),
  });
  assert.equal(
    run.owner.turnEvents().filter((event) => event.kind === "thought").length,
    1,
  );
  const transcript = run.port.readTranscript(
    final.value.snapshot.result.history.transcriptExport,
  );
  assert.ok(transcript.found);
  assert.deepEqual(
    transcript.entries.map((entry) => entry.content),
    ["Input"],
  );
  await run.finish();
  const reopened = openHistory({
    t,
    port: run.reopen(),
    runId: run.runId,
    session: "s",
  });
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(
    reopened.snapshot.result.history.rows[1]?.value,
    settled.value,
  );
});

test("m10-session-history: mixed Thought/message/tool rows share the exact 200/201 window and discard late previews", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  openHistory({ t, port: run.port, runId: run.runId, session: "s" });
  for (let index = 0; index < 199; index++) {
    if (index % 3 === 0)
      run.channel.observe({
        thought: {
          turnId: "turn",
          session: "s",
          summaryId: `item-${index}`,
          content: `Thought ${index}`,
        },
      });
    else if (index % 3 === 1)
      run.channel.observe({
        message: {
          turnId: "turn",
          session: "s",
          messageId: `item-${index}`,
          content: `Message ${index}`,
        },
      });
    else
      run.owner.appendTurnEvent({
        turnId: "turn",
        kind: "tool-call",
        payload: JSON.stringify({
          callId: `item-${index}`,
          tool: "read",
          input: String(index),
          outcome: { kind: "running" },
        }),
        at: new Date(),
      });
  }
  const exact = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(exact.snapshot.result.found);
  assert.equal(exact.snapshot.result.history.rows.length, 200);
  assert.equal(exact.snapshot.result.history.hasEarlier, false);
  assert.equal(exact.snapshot.result.history.rows[0]?.value.kind, "message");
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "new",
      content: "Newest",
    },
  });
  const over = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(over.snapshot.result.found);
  assert.equal(over.snapshot.result.history.rows.length, 200);
  assert.equal(over.snapshot.result.history.hasEarlier, true);
  assert.deepEqual(over.snapshot.result.history.rows[0]?.value, {
    kind: "thought",
    content: "Thought 0",
  });
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "new",
      content: "Distinct kind with same native id",
    },
  });
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "item-0",
      content: "Evicted must not reappear",
    },
  });
  timer.flush();
  const latest = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(latest.snapshot.result.found);
  assert.equal(latest.snapshot.result.history.rows.length, 200);
  assert.ok(
    !JSON.stringify(latest.snapshot).includes("Evicted must not reappear"),
  );
  assert.deepEqual(
    latest.snapshot.result.history.rows.slice(-2).map((row) => row.value),
    [
      { kind: "thought", content: "Newest" },
      {
        kind: "message",
        role: "assistant",
        content: "Distinct kind with same native id",
      },
    ],
  );
  await run.finish();
});

test("m10-session-history: empty Thought replacements suppress bodies and never revive their preview", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "empty",
      content: "   \n",
    },
  });
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "cleared",
      content: "Preview",
    },
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "thought",
    payload: JSON.stringify({ summaryId: "cleared", content: "" }),
    at: new Date(),
  });
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "cleared",
      content: "Late body",
    },
  });
  timer.flush();
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(opened.snapshot.result.found);
  assert.deepEqual(
    opened.snapshot.result.history.rows.map((row) => row.value),
    [{ kind: "message", role: "user", content: "Input" }],
  );
  await run.finish();
});

test("m10-session-history: cumulative diffs replace one Turn row, retain full content on settlement/reopen and never become call patches or transcript", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const reader = opened.updates[Symbol.asyncIterator]();
  const diff = {
    files: [{ path: "observed.ts" }],
    content:
      "diff --git a/observed.ts b/observed.ts\n" +
      "Full supplied patch\n".repeat(2200) +
      "LAST_DIFF_LINE",
  };
  const before = run.owner.turnEvents();
  run.channel.observe({ diff: { turnId: "turn", session: "s", ...diff } });
  assert.deepEqual(run.owner.turnEvents(), before);
  timer.flush();
  const preview = await reader.next();
  assert.ok(preview.value?.kind === "history-preview");
  const identity = preview.value.row;
  const call = {
    callId: "same-path",
    tool: "file-change",
    input: "observed.ts",
    files: [
      {
        path: "observed.ts",
        patch: { kind: "unified", content: "PER_CALL_PATCH" },
      },
    ],
    outcome: { kind: "completed" },
  };
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "tool-call",
    payload: JSON.stringify(call),
    at: new Date(),
  });
  await reader.next();
  run.channel.observe({
    diff: {
      turnId: "turn",
      session: "s",
      ...diff,
      content: "Stale queued diff",
    },
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "turn-diff",
    payload: JSON.stringify(diff),
    at: new Date(),
  });
  const update = await reader.next();
  assert.ok(
    update.value?.kind === "durable" && update.value.snapshot.result.found,
  );
  const rows: readonly SessionHistoryRow[] =
    update.value.snapshot.result.history.rows;
  assert.deepEqual(
    rows.map((row) => row.value.kind),
    ["message", "turn-diff", "tool"],
  );
  assert.equal(rows[1]?.id, identity.id);
  assert.equal(rows[1]?.position, identity.position);
  assert.deepEqual(rows[1]?.value, { kind: "turn-diff", ...diff });
  assert.ok(rows[2]?.value.kind === "tool");
  assert.deepEqual(rows[2].value.files, call.files);
  timer.flush();
  run.channel.observe({
    diff: { turnId: "turn", session: "s", files: [], content: "Late stale" },
  });
  timer.flush();
  const late = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(late.snapshot.result.found);
  assert.deepEqual(late.snapshot.result.history.rows[1]?.value, {
    kind: "turn-diff",
    ...diff,
  });
  const transcript = run.port.readTranscript(
    update.value.snapshot.result.history.transcriptExport,
  );
  assert.ok(transcript.found);
  assert.deepEqual(
    transcript.entries.map((entry) => entry.content),
    ["Input"],
  );
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "turn-diff",
    payload: JSON.stringify({ files: [], content: "Duplicate final" }),
    at: new Date(),
  });
  assert.equal(
    run.owner.turnEvents().filter((event) => event.kind === "turn-diff").length,
    1,
  );
  await run.finish();
  const reopened = openHistory({
    t,
    port: run.reopen(),
    runId: run.runId,
    session: "s",
  });
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(reopened.snapshot.result.history.rows[1]?.value, {
    kind: "turn-diff",
    ...diff,
  });
});

test("m10-session-history: cumulative diff shares preview fairness and the exact mixed 200/201 bound, without resurrection after eviction", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  run.channel.observe({
    diff: {
      turnId: "turn",
      session: "s",
      content: "First diff",
      files: [{ path: "first.ts" }],
    },
  });
  run.channel.observe({
    thought: {
      turnId: "turn",
      session: "s",
      summaryId: "thought",
      content: "Thought",
    },
  });
  timer.flush();
  const reader = opened.updates[Symbol.asyncIterator]();
  const diffPreview = await reader.next(),
    thoughtPreview = await reader.next();
  assert.ok(
    diffPreview.value?.kind === "history-preview" &&
      thoughtPreview.value?.kind === "history-preview",
  );
  assert.equal(diffPreview.value.row.value.kind, "turn-diff");
  assert.equal(thoughtPreview.value.row.value.kind, "thought");
  assert.deepEqual(timer.delays, [50]);
  for (let index = 0; index < 197; index++) {
    if (index % 2)
      run.channel.observe({
        message: {
          turnId: "turn",
          session: "s",
          messageId: String(index),
          content: `Message ${index}`,
        },
      });
    else
      run.owner.appendTurnEvent({
        turnId: "turn",
        kind: "tool-call",
        payload: JSON.stringify({
          callId: String(index),
          tool: "file-change",
          input: String(index),
          outcome: { kind: "running" },
        }),
        at: new Date(),
      });
  }
  const exact = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(exact.snapshot.result.found);
  assert.equal(exact.snapshot.result.history.rows.length, 200);
  assert.equal(exact.snapshot.result.history.hasEarlier, false);
  run.channel.observe({
    diff: { turnId: "turn", session: "s", content: "Replacement", files: [] },
  });
  const replacement = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(replacement.snapshot.result.found);
  assert.equal(replacement.snapshot.result.history.rows.length, 200);
  assert.equal(
    replacement.snapshot.result.history.rows[1]?.value.kind,
    "turn-diff",
  );
  for (const messageId of ["201", "202"])
    run.channel.observe({
      message: { turnId: "turn", session: "s", messageId, content: messageId },
    });
  run.channel.observe({
    diff: {
      turnId: "turn",
      session: "s",
      content: "Evicted preview",
      files: [],
    },
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "turn-diff",
    payload: JSON.stringify({ content: "Evicted final", files: [] }),
    at: new Date(),
  });
  timer.flush();
  const over = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(over.snapshot.result.found);
  assert.equal(over.snapshot.result.history.rows.length, 200);
  assert.equal(over.snapshot.result.history.hasEarlier, true);
  assert.equal(
    over.snapshot.result.history.rows.some(
      (row) => row.value.kind === "turn-diff",
    ),
    false,
  );
  await run.finish();
});

test("m10-interruption-and-transcript: crash reopening loses memory-only cumulative snapshots and never attaches them to stored calls", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "tool-call",
    payload: JSON.stringify({
      callId: "edit",
      tool: "file-change",
      input: "file.ts",
      outcome: { kind: "running" },
    }),
    at: new Date(),
  });
  run.channel.observe({
    diff: {
      turnId: "turn",
      session: "s",
      content: "MEMORY_ONLY",
      files: [{ path: "file.ts" }],
    },
  });
  assert.equal(
    run.owner.turnEvents().some((event) => event.kind === "turn-diff"),
    false,
  );
  await run.finish();
  const reopened = openHistory({
    t,
    port: run.reopen(),
    runId: run.runId,
    session: "s",
  });
  assert.ok(reopened.snapshot.result.found);
  assert.equal(
    reopened.snapshot.result.history.rows.some(
      (row) => row.value.kind === "turn-diff",
    ),
    false,
  );
  const call = reopened.snapshot.result.history.rows.find(
    (row) => row.value.kind === "tool",
  );
  assert.ok(call?.value.kind === "tool");
  assert.equal(call.value.files, undefined);
});

for (const size of [29_999, 30_000, 30_001])
  test(`m10-session-history: command ${size} character tails coalesce every affected row with messages and never write chunks`, async (t) => {
    const timer = clock();
    const run = await openLiveRun(t, {
      scheduleHistoryPreview: timer.schedule,
    });
    t.after(run.finish);
    admit(run.owner);
    const opened = openHistory({
      t,
      port: run.port,
      runId: run.runId,
      session: "s",
    });
    const reader = opened.updates[Symbol.asyncIterator]();
    const text = "a".repeat(size - 1) + "Z";
    const before = run.owner.turnEvents();
    for (const callId of ["one", "two", "one"])
      run.channel.observe({
        tool: {
          turnId: "turn",
          session: "s",
          call: {
            callId,
            tool: "command",
            input: "build",
            cwd: "/workspace",
            outcome: { kind: "running" },
            output: { text },
            nativeOmission: "Harness omitted stdout",
          },
        },
      });
    run.channel.observe({
      message: {
        turnId: "turn",
        session: "s",
        messageId: "message",
        content: "Assistant",
      },
    });
    assert.deepEqual(run.owner.turnEvents(), before);
    assert.deepEqual(timer.delays, [50]);
    timer.flush();
    for (let i = 0; i < 3; i++) {
      const update = await reader.next();
      assert.ok(update.value?.kind === "history-preview");
      if (i < 2) {
        const value = update.value.row.value;
        assert.equal(value.kind, "tool");
        assert.ok(value.kind === "tool");
        assert.deepEqual(value.output, {
          text: size > 30_000 ? "a".repeat(29_999) + "Z" : text,
          ...(size > 30_000 ? { secantDropped: true } : {}),
        });
        assert.equal(value.nativeOmission, "Harness omitted stdout");
      } else assert.equal(update.value.row.value.kind, "message");
    }
    const late = openHistory({
      t,
      port: run.port,
      runId: run.runId,
      session: "s",
    });
    assert.ok(late.snapshot.result.found);
    assert.equal(
      late.snapshot.result.history.rows.filter(
        (row) => row.value.kind === "tool",
      ).length,
      2,
    );
    await run.finish();
  });

for (const final of [
  "replacement",
  "empty",
  "absent",
  "failed",
  "declined",
] as const)
  test(`m10-session-history: ${final} command output reconciles immediately without stale preview resurrection`, async (t) => {
    const timer = clock();
    const run = await openLiveRun(t, {
      scheduleHistoryPreview: timer.schedule,
    });
    t.after(run.finish);
    admit(run.owner);
    const opened = openHistory({
      t,
      port: run.port,
      runId: run.runId,
      session: "s",
    });
    const reader = opened.updates[Symbol.asyncIterator]();
    const call = {
      callId: "call",
      tool: "command" as const,
      input: "build",
      outcome: { kind: "running" as const },
    };
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "tool-call",
      payload: JSON.stringify(call),
      at: new Date(),
    });
    const start = await reader.next();
    assert.ok(
      start.value?.kind === "durable" && start.value.snapshot.result.found,
    );
    const id = start.value.snapshot.result.history.rows[1]!.id;
    run.channel.observe({
      tool: {
        turnId: "turn",
        session: "s",
        call: { ...call, output: { text: "preview" } },
      },
    });
    const outcome =
      final === "failed"
        ? { kind: "failed", error: "failure reason" }
        : final === "declined"
          ? { kind: "declined", reason: "refusal reason" }
          : { kind: "completed" };
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "tool-call",
      payload: JSON.stringify({
        ...call,
        outcome,
        ...(final === "replacement"
          ? { output: { text: "FINAL" } }
          : final === "empty"
            ? { output: { text: "" } }
            : {}),
      }),
      at: new Date(),
    });
    const terminal = await reader.next();
    assert.ok(
      terminal.value?.kind === "durable" &&
        terminal.value.snapshot.result.found,
    );
    const row = terminal.value.snapshot.result.history.rows[1]!;
    assert.equal(row.id, id);
    assert.equal(row.source, "stored");
    assert.ok(row.value.kind === "tool");
    assert.deepEqual(
      row.value.output,
      final === "replacement"
        ? { text: "FINAL" }
        : final === "empty"
          ? { text: "" }
          : { text: "preview", incomplete: true },
    );
    assert.deepEqual(row.value.outcome, outcome);
    timer.flush();
    run.channel.observe({
      tool: {
        turnId: "turn",
        session: "s",
        call: { ...call, output: { text: "STALE" } },
      },
    });
    timer.flush();
    const reopened = openHistory({
      t,
      port: run.port,
      runId: run.runId,
      session: "s",
    });
    assert.ok(reopened.snapshot.result.found);
    assert.deepEqual(
      reopened.snapshot.result.history.rows[1]?.value,
      row.value,
    );
    await run.finish();
  });

for (const resultKind of ["completed", "interrupted", "lost"])
  test(`m10-interruption-and-transcript: ${resultKind} retains admitted command partials in the same row and invalidates queued output`, async (t) => {
    const timer = clock();
    const run = await openLiveRun(t, {
      scheduleHistoryPreview: timer.schedule,
    });
    t.after(run.finish);
    admit(run.owner);
    const opened = openHistory({
      t,
      port: run.port,
      runId: run.runId,
      session: "s",
    });
    const reader = opened.updates[Symbol.asyncIterator]();
    const call = {
      callId: "call",
      tool: "command" as const,
      input: "build",
      outcome: { kind: "running" as const },
    };
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "tool-call",
      payload: JSON.stringify(call),
      at: new Date(),
    });
    const start = await reader.next();
    assert.ok(
      start.value?.kind === "durable" && start.value.snapshot.result.found,
    );
    const id = start.value.snapshot.result.history.rows[1]!.id;
    run.channel.observe({
      tool: {
        turnId: "turn",
        session: "s",
        call: { ...call, output: { text: "queued output" } },
      },
    });
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "tool-partial",
      payload: JSON.stringify({
        ...call,
        output: { text: "retained partial", incomplete: true },
      }),
      at: new Date(),
    });
    const partial = await reader.next();
    assert.ok(partial.value?.kind === "durable");
    timer.flush();
    run.owner.settleTurn({
      turnId: "turn",
      session: "s",
      resultKind,
      resultDetail: "{}",
      availability: "open",
      at: new Date(),
    });
    const settled = await reader.next();
    assert.ok(
      settled.value?.kind === "durable" && settled.value.snapshot.result.found,
    );
    const row = settled.value.snapshot.result.history.rows[1]!;
    assert.equal(row.id, id);
    assert.equal(row.source, "stored");
    assert.deepEqual(row.value, {
      kind: "tool",
      tool: "command",
      input: "build",
      outcome: { kind: "unconfirmed" },
      output: { text: "retained partial", incomplete: true },
    });
    run.channel.observe({
      tool: {
        turnId: "turn",
        session: "s",
        call: { ...call, output: { text: "late" } },
      },
    });
    timer.flush();
    const reopened = openHistory({
      t,
      port: run.port,
      runId: run.runId,
      session: "s",
    });
    assert.ok(reopened.snapshot.result.found);
    assert.deepEqual(
      reopened.snapshot.result.history.rows[1]?.value,
      row.value,
    );
    assert.deepEqual(
      run.owner.transcript().map((entry) => entry.content),
      ["Input"],
    );
    await run.finish();
  });

test("m10-session-history: command tails, uncapped supplied patches, Turn diffs and messages share one preview budget", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const opened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const reader = opened.updates[Symbol.asyncIterator]();
  const before = run.owner.turnEvents();
  const content = "complete supplied patch".repeat(2000);
  run.channel.observe({
    tool: {
      turnId: "turn",
      session: "s",
      call: {
        callId: "command",
        tool: "command",
        input: "build",
        outcome: { kind: "running" },
        output: { text: "OLD" + "x".repeat(30_000) },
      },
    },
  });
  run.channel.observe({
    tool: {
      turnId: "turn",
      session: "s",
      call: {
        callId: "file",
        tool: "file-change",
        input: "requested.ts",
        outcome: { kind: "running" },
        files: [{ path: "observed.ts", patch: { kind: "unified", content } }],
      },
    },
  });
  run.channel.observe({
    diff: {
      turnId: "turn",
      session: "s",
      content,
      files: [{ path: "cumulative.ts" }],
    },
  });
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "message",
      content: "Assistant",
    },
  });
  assert.deepEqual(timer.delays, [50]);
  assert.deepEqual(run.owner.turnEvents(), before);
  timer.flush();
  const command = await reader.next();
  assert.ok(
    command.value?.kind === "history-preview" &&
      command.value.row.value.kind === "tool",
  );
  assert.deepEqual(command.value.row.value.output, {
    text: "x".repeat(30_000),
    secantDropped: true,
  });
  const file = await reader.next();
  assert.ok(
    file.value?.kind === "history-preview" &&
      file.value.row.value.kind === "tool",
  );
  assert.deepEqual(file.value.row.value.files, [
    { path: "observed.ts", patch: { kind: "unified", content } },
  ]);
  const diff = await reader.next();
  assert.ok(
    diff.value?.kind === "history-preview" &&
      diff.value.row.value.kind === "turn-diff",
  );
  assert.equal(diff.value.row.value.content, content);
  const message = await reader.next();
  assert.ok(message.value?.kind === "history-preview");
  assert.deepEqual(message.value.row.value, {
    kind: "message",
    role: "assistant",
    content: "Assistant",
  });
  assert.deepEqual(run.owner.turnEvents(), before);
  await run.finish();
});

test("m10-audit-entry-prompt-kind: history attributes all managed inputs to Secant and human follow-ups to the human", async (t) => {
  const { port, runId, owner, finish, storeHome } = await openLiveRun(t);
  t.after(finish);
  for (const input of [
    {
      turnId: "attempt",
      origin: "managed",
      kind: "agent",
      input: "Attempt prompt",
    },
    {
      turnId: "retry",
      origin: "managed",
      kind: "agent",
      input: "Retry prompt",
    },
    {
      turnId: "resend",
      origin: "managed",
      kind: "agent",
      input: "Re-sent prompt",
    },
    {
      turnId: "entry",
      origin: "managed",
      kind: "interactive-agent",
      input: "Entry Turn prompt",
    },
    {
      turnId: "unknown-kind",
      origin: "managed",
      kind: "agent",
      input: "Managed prompt with unknown Step kind",
    },
    {
      turnId: "follow-up",
      origin: "human",
      kind: "agent",
      input: "Human follow-up",
    },
    {
      turnId: "interactive",
      origin: "human",
      kind: "interactive-agent",
      input: "Human Turn",
    },
  ] as const) {
    assert.ok(
      owner.admitTurn({
        ...input,
        attemptId: "0.0:echo",
        session: "s",
        recoveryCoordinate: "private",
        harness: "codex",
        at: new Date("2026-10-06T00:00:00Z"),
      }).ok,
    );
  }
  const groupFolder = readdirSync(join(storeHome, "runs"))[0]!;
  const database = new Database(
    join(storeHome, "runs", groupFolder, runId, "run.db"),
  );
  try {
    database.run("UPDATE turn SET kind = NULL WHERE turn_id = 'unknown-kind'");
  } finally {
    database.close();
  }
  const opened = openHistory({ t, port, runId, session: "s" });
  assert.ok(opened.snapshot.result.found);
  assert.deepEqual(
    opened.snapshot.result.history.rows.map((row) => row.value),
    [
      { kind: "entry-prompt", content: "Attempt prompt" },
      { kind: "entry-prompt", content: "Retry prompt" },
      { kind: "entry-prompt", content: "Re-sent prompt" },
      { kind: "entry-prompt", content: "Entry Turn prompt" },
      {
        kind: "entry-prompt",
        content: "Managed prompt with unknown Step kind",
      },
      { kind: "message", role: "user", content: "Human follow-up" },
      { kind: "message", role: "user", content: "Human Turn" },
    ],
  );
  await finish();
});
