import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ProjectionPort,
  ProjectionSelector,
  SessionHistoryRow,
} from "../../src/application/projection-port.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { openLiveRun } from "../helpers/liveRun.js";
import { readHistoryText } from "./history-content-fixture.js";

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

async function assertPending(pending: Promise<unknown>): Promise<void> {
  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(resolved, false, "no superseded history state remains unread");
}

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
test("m10-audit-history-latest-delivery: unread large pages replace each other while independent readers and reopen preserve truth", async (t) => {
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
  const latest = await slow.updates[Symbol.asyncIterator]().next();
  assert.ok(latest.value?.kind === "durable");
  assert.ok(latest.value.snapshot.result.found);
  assert.deepEqual(
    latest.value.snapshot.result.history.rows
      .slice(2)
      .map((row: SessionHistoryRow) => row.value),
    [0, 1, 2].map((index) => ({
      kind: "message",
      role: "assistant",
      content: `Changed ${index}`,
    })),
  );
  const pending = slow.updates[Symbol.asyncIterator]().next();
  await assertPending(pending);
  slow.close();
  assert.deepEqual(await pending, { done: true, value: undefined });
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

test("m10-audit-history-latest-delivery: two quick pages with 150 full command tails retain only current history", async (t) => {
  const tail = "x".repeat(29_999) + "Z";
  const run = await openLiveRun(t, {
    seedRun: ({ owner, storeHome }) => {
      admit(owner);
      const groups = join(storeHome, "runs");
      const database = new Database(
        join(groups, readdirSync(groups)[0]!, owner.record.runId, "run.db"),
      );
      try {
        const insert = database.query(
          "INSERT INTO turn_event (turn_id, kind, payload, at) VALUES ('turn', 'tool-call', ?, ?)",
        );
        database.transaction(() => {
          for (let i = 0; i < 150; i++)
            insert.run(
              JSON.stringify({
                callId: `command-${i}`,
                tool: "command",
                input: `build ${i}`,
                outcome: { kind: "completed" },
                output: { text: tail },
                historyOrder: i,
              }),
              "2026-10-06T00:00:00.000Z",
            );
        })();
      } finally {
        database.close();
      }
    },
  });
  t.after(run.finish);
  const page = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(page.snapshot.result.found);
  const original = page.snapshot.result.history.rows;
  for (const content of ["First", "Second"])
    assert.ok(
      run.owner.appendTurnEvent({
        turnId: "turn",
        kind: "assistant-content",
        payload: JSON.stringify({ messageId: content, content }),
        at: new Date(),
      }).ok,
    );
  const reader = page.updates[Symbol.asyncIterator]();
  const latest = await reader.next();
  assert.ok(
    latest.value?.kind === "durable" && latest.value.snapshot.result.found,
  );
  const rows: readonly SessionHistoryRow[] =
    latest.value.snapshot.result.history.rows;
  assert.deepEqual(rows.slice(0, 151), original);
  assert.equal(rows.length, 153);
  assert.deepEqual(
    rows.slice(-2).map((row) => row.value),
    [
      { kind: "message", role: "assistant", content: "First" },
      { kind: "message", role: "assistant", content: "Second" },
    ],
  );
  const pending = reader.next();
  await assertPending(pending);
  page.close();
  assert.deepEqual(await pending, { done: true, value: undefined });
});

test("m10-audit-history-latest-delivery: mixed unread pages and previews reconcile settlement, per-row replacement and individual stored facts", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const page = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const tool = (outcome: { kind: "running" } | { kind: "completed" }) =>
    assert.ok(
      run.owner.appendTurnEvent({
        turnId: "turn",
        kind: "tool-call",
        payload: JSON.stringify({
          callId: "call",
          tool: "read",
          input: "a.ts",
          outcome,
        }),
        at: new Date(),
      }).ok,
    );
  const preview = (messageId: string, content: string) => {
    run.channel.observe({
      message: { turnId: "turn", session: "s", messageId, content },
    });
    timer.flush();
  };
  tool({ kind: "running" });
  preview("one", "Obsolete one");
  preview("two", "Obsolete two");
  const current = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(current.snapshot.result.found);
  const identities = current.snapshot.result.history.rows.map((row) => [
    row.id,
    row.position,
  ]);
  current.close();
  tool({ kind: "completed" }); // Replaces the unread page and both previews.
  preview("one", "Latest one");
  preview("two", "First two");
  preview("two", "Latest two");
  run.channel.observe({
    tool: {
      turnId: "turn",
      session: "s",
      call: {
        callId: "call",
        tool: "read",
        input: "must not return",
        outcome: { kind: "running" },
      },
    },
  });
  timer.flush();
  const reader = page.updates[Symbol.asyncIterator]();
  const latest = await reader.next();
  assert.ok(
    latest.value?.kind === "durable" && latest.value.snapshot.result.found,
  );
  const rows: readonly SessionHistoryRow[] =
    latest.value.snapshot.result.history.rows;
  assert.deepEqual(
    rows.map((row) => [row.value.kind, row.source]),
    [
      ["message", "stored"],
      ["tool", "stored"],
      ["message", "preview"],
      ["message", "preview"],
    ],
  );
  assert.deepEqual(rows[1]?.value, {
    kind: "tool",
    tool: "read",
    input: "a.ts",
    outcome: { kind: "completed" },
  });
  const finals = [];
  for (let i = 0; i < 2; i++) {
    const update = await reader.next();
    assert.ok(update.value?.kind === "history-preview");
    const row: SessionHistoryRow = update.value.row;
    const before = rows.find((item) => item.id === row.id)!;
    assert.equal(row.position, before.position);
    assert.equal(row.source, "preview");
    finals.push(row.value);
  }
  assert.deepEqual(finals, [
    { kind: "message", role: "assistant", content: "Latest one" },
    { kind: "message", role: "assistant", content: "Latest two" },
  ]);
  assert.deepEqual(
    run.owner.turnEvents().map((event) => JSON.parse(event.payload).outcome),
    [{ kind: "running" }, { kind: "completed" }],
  );
  const reopened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(
    reopened.snapshot.result.history.rows.map((row) => row.value).slice(2),
    finals,
  );
  assert.notDeepEqual(
    reopened.snapshot.result.history.rows.map((row) => [row.id, row.position]),
    identities,
  );
  const pending = reader.next();
  tool({ kind: "completed" }); // An unchanged page must leave the reader pending.
  await assertPending(pending);
  page.close();
  assert.deepEqual(await pending, { done: true, value: undefined });
});

test("m10-audit-history-latest-delivery: a preview-only burst retains each newest-window row once without resurrecting evicted previews", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const page = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const reader = page.updates[Symbol.asyncIterator]();
  const preview = (i: number, content: string) => {
    run.channel.observe({
      message: { turnId: "turn", session: "s", messageId: `row-${i}`, content },
    });
    timer.flush();
  };
  for (let i = 0; i < 210; i++) preview(i, `Row ${i}`);
  for (let i = 0; i < 1_010; i++) preview(209, `Latest ${i}`);
  preview(0, "Evicted must not return");
  const rows: SessionHistoryRow[] = [];
  for (let i = 0; i < 200; i++) {
    const update = await reader.next();
    assert.ok(update.value?.kind === "history-preview");
    if (i === 199) assert.equal(update.value.hasEarlier, true);
    rows.push(update.value.row);
  }
  assert.deepEqual(
    rows.map((row) => row.value),
    [
      ...Array.from({ length: 199 }, (_, i) => ({
        kind: "message",
        role: "assistant",
        content: `Row ${i + 10}`,
      })),
      { kind: "message", role: "assistant", content: "Latest 1009" },
    ],
  );
  assert.equal(new Set(rows.map((row) => row.id)).size, 200);
  assert.deepEqual(run.owner.turnEvents(), []);
  const pending = reader.next();
  await assertPending(pending);
  page.close();
  assert.deepEqual(await pending, { done: true, value: undefined });
});

test("m10-audit-history-latest-delivery: an oversized preview reaches every reader bounded; close unregisters once and permits an independent observer", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const lost = openHistory({
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
  const reader = lost.updates[Symbol.asyncIterator]();
  const other = healthy.updates[Symbol.asyncIterator]();
  const preview = (messageId: string, content: string) => {
    run.channel.observe({
      message: { turnId: "turn", session: "s", messageId, content },
    });
    timer.flush();
  };
  // Content past the whole allowance no longer ends a reader (#490): rows are bounded.
  preview("large", "x".repeat(8 * 1024 * 1024 + 1));
  preview("next", "After large");
  for (const iterator of [reader, other]) {
    const large = await iterator.next();
    assert.ok(
      large.value?.kind === "history-preview" &&
        large.value.row.value.kind === "message" &&
        large.value.row.value.reference !== undefined,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(large.value)) < 32_768);
    const after = await iterator.next();
    assert.ok(after.value?.kind === "history-preview");
  }
  lost.close();
  lost.close();
  assert.deepEqual(await reader.next(), { done: true, value: undefined });
  preview("next", "Later");
  assert.ok((await other.next()).value?.kind === "history-preview");
  assert.deepEqual(await reader.next(), { done: true, value: undefined });
  const reopened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(reopened.snapshot.result.history.rows.at(-1)?.value, {
    kind: "message",
    role: "assistant",
    content: "Later",
  });
  reopened.close();
  healthy.close();
  // Last-observer cleanup cancels one pending preview; repeated closes cannot cancel it again.
  let cancellations = 0;
  let callback: (() => void) | undefined;
  const isolated = await openLiveRun(t, {
    scheduleHistoryPreview: (next) => {
      callback = next;
      return () => {
        cancellations++;
        callback = undefined;
      };
    },
  });
  t.after(isolated.finish);
  admit(isolated.owner);
  const first = openHistory({
    t,
    port: isolated.port,
    runId: isolated.runId,
    session: "s",
  });
  isolated.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "pending",
      content: "Pending",
    },
  });
  first.close();
  first.close();
  assert.equal(cancellations, 1);
  assert.equal(callback, undefined);
  const pending = first.updates[Symbol.asyncIterator]().next();
  assert.deepEqual(await pending, { done: true, value: undefined });
});

test("m10-audit-history-latest-delivery: shutdown prioritizes one terminal over pages and previews and finishes pending readers", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const queued = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "assistant-content",
      payload: JSON.stringify({ messageId: "stored", content: "Complete" }),
      at: new Date(),
    }).ok,
  );
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "live",
      content: "Preview",
    },
  });
  timer.flush();
  const waiting = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const queueReader = queued.updates[Symbol.asyncIterator]();
  const waitReader = waiting.updates[Symbol.asyncIterator]();
  const pending = waitReader.next();
  await run.finish();
  const stopping = run.shutdown();
  for (const result of [await queueReader.next(), await pending])
    assert.deepEqual(result, {
      done: false,
      value: { kind: "closed", reason: "application-shutdown" },
    });
  queued.close();
  queued.close();
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "late",
      content: "Ignored",
    },
  });
  timer.flush();
  for (const reader of [queueReader, waitReader])
    assert.deepEqual(await reader.next(), { done: true, value: undefined });
  await run.finish();
  await stopping;
});

test("m10-audit-history-latest-delivery: deleting the subject prioritizes one terminal and fresh reopening reports the missing Run", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  const page = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.ok(
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "assistant-content",
      payload: JSON.stringify({ messageId: "stored", content: "Unread" }),
      at: new Date(),
    }).ok,
  );
  await run.finish();
  const submitted = run.port.submit({
    operationId: "delete",
    operation: "delete-run",
    input: { runId: run.runId },
  });
  assert.ok(submitted.admitted);
  assert.deepEqual(await awaitSettled(run.port, "delete"), {
    status: "applied",
  });
  const reader = page.updates[Symbol.asyncIterator]();
  assert.deepEqual(await reader.next(), {
    done: false,
    value: { kind: "closed", reason: "subject-gone" },
  });
  assert.deepEqual(await reader.next(), { done: true, value: undefined });
  page.close();
  page.close();
  const reopened = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  assert.equal(reopened.snapshot.result.found, false);
});

test("m10-audit-history-latest-delivery: replacing a large row preview retains only its bounded latest value", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run.owner);
  const page = openHistory({
    t,
    port: run.port,
    runId: run.runId,
    session: "s",
  });
  const preview = (messageId: string, content: string) => {
    run.channel.observe({
      message: { turnId: "turn", session: "s", messageId, content },
    });
    timer.flush();
  };
  const large = "X".repeat(4 * 1024 * 1024);
  for (let i = 0; i < 3; i++) preview("one", large + i);
  preview("one", "Small replacement");
  preview("two", large);
  const reader = page.updates[Symbol.asyncIterator]();
  const one = await reader.next();
  assert.ok(one.value?.kind === "history-preview");
  assert.deepEqual(one.value.row.value, {
    kind: "message",
    role: "assistant",
    content: "Small replacement",
  });
  const two = await reader.next();
  assert.ok(
    two.value?.kind === "history-preview" &&
      two.value.row.value.kind === "message" &&
      two.value.row.value.reference !== undefined,
  );
  assert.equal(
    await readHistoryText(run.port, two.value.row.value.reference),
    large,
  );
  const pending = reader.next();
  await assertPending(pending);
  page.close();
  assert.deepEqual(await pending, { done: true, value: undefined });
});
