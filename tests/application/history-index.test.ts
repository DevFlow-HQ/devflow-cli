import { awaitSettled } from "../helpers/settleOperation.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";
import type { SessionHistoryRow } from "../../src/application/projection-port.js";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openLiveRun } from "../helpers/liveRun.js";

function admit(
  owner: import("../../src/run/store/store.js").RunOwner,
  turnId = "turn",
) {
  assert.ok(
    owner.admitTurn({
      turnId,
      attemptId: "0.0:echo",
      session: "s",
      origin: "human",
      kind: "interactive-agent",
      input: "Input",
      recoveryCoordinate: "private",
      harness: "codex",
      at: new Date("2026-10-06T00:00:00Z"),
    }).ok,
  );
}
for (const size of [100, 10_000])
  test(`m10-audit-history-index: ${size} stored facts require no preview reads and at most one append read`, async (t) => {
    let reads = 0;
    let flush: (() => void) | undefined;
    const run = await openLiveRun(t, {
      onHistoryRead: () => reads++,
      seedRun: ({ owner, storeHome }) => {
        for (let i = 0; i < size; i += 100) admit(owner, `past-${i / 100}`);
        admit(owner);
        const groups = join(storeHome, "runs");
        const database = new Database(
          join(groups, readdirSync(groups)[0]!, owner.record.runId, "run.db"),
        );
        try {
          // Seed historical facts atomically before Application indexes them.
          // The live assertions below still exercise the real Store.
          const insert = database.query(
            "INSERT INTO turn_event (turn_id, kind, payload, at) VALUES (?, 'thought', ?, ?)",
          );
          database.transaction(() => {
            for (let i = 0; i < size; i++)
              insert.run(
                `past-${Math.floor(i / 100)}`,
                JSON.stringify({
                  summaryId: `old-${i}`,
                  content: `Thought ${i}`,
                  historyOrder: i % 100,
                }),
                "2026-10-06T00:00:00.000Z",
              );
          })();
        } finally {
          database.close();
        }
      },
      scheduleHistoryPreview: (next) => {
        flush = next;
        return () => {
          flush = undefined;
        };
      },
    });
    t.after(run.finish);
    assert.equal(run.owner.turnEvents().length, size);
    const page = run.port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
    t.after(page.close);
    assert.ok(page.snapshot.result.found);
    assert.equal(
      page.snapshot.result.history.rows.length,
      Math.min(200, size + size / 100 + 1),
    );
    reads = 0;
    const previewStart = performance.now();
    for (let i = 0; i < 20; i++)
      run.channel.observe({
        message: {
          turnId: "turn",
          session: "s",
          messageId: "live",
          content: `Chunk ${i}`,
        },
      });
    const previewMs = (performance.now() - previewStart) / 20;
    flush?.();
    const update = await page.updates[Symbol.asyncIterator]().next();
    assert.ok(update.value?.kind === "history-preview");
    assert.deepEqual(update.value.row.value, {
      kind: "message",
      role: "assistant",
      content: "Chunk 19",
    });
    assert.equal(reads, 0);
    reads = 0;
    const appendStart = performance.now();
    assert.ok(
      run.owner.appendTurnEvent({
        turnId: "turn",
        kind: "assistant-content",
        payload: JSON.stringify({ messageId: "live", content: "Done" }),
        at: new Date(),
      }).ok,
    );
    const appendMs = performance.now() - appendStart;
    const durable = await page.updates[Symbol.asyncIterator]().next();
    assert.ok(
      durable.value?.kind === "durable" && durable.value.snapshot.result.found,
    );
    assert.deepEqual(durable.value.snapshot.result.history.rows.at(-1)?.value, {
      kind: "message",
      role: "assistant",
      content: "Done",
    });
    assert.ok(reads <= 1, `${reads} Store reads for one append`);
    if (process.env.SECANT_HISTORY_BENCHMARK === "1") {
      // Measure the real Port path and SQLite write with a fully consumed stream.
      // Fixed current-Turn dedup population isolates total Run history growth.
      const samples = 100;
      let previewTotal = 0,
        appendTotal = 0;
      run.channel.observe({
        message: {
          turnId: "turn",
          session: "s",
          messageId: "benchmark-preview",
          content: "Start",
        },
      });
      for (let i = 0; i < samples * 10; i++) {
        const start = performance.now();
        run.channel.observe({
          message: {
            turnId: "turn",
            session: "s",
            messageId: "benchmark-preview",
            content: `Preview ${i}`,
          },
        });
        previewTotal += performance.now() - start;
      }
      flush?.();
      await page.updates[Symbol.asyncIterator]().next();
      for (let i = 0; i < samples; i++) {
        const before = performance.now();
        run.owner.appendTurnEvent({
          turnId: "turn",
          kind: "assistant-content",
          payload: JSON.stringify({
            messageId: `bench-${i}`,
            content: "Settled",
          }),
          at: new Date(),
        });
        appendTotal += performance.now() - before;
        await page.updates[Symbol.asyncIterator]().next();
      }
      process.stdout.write(
        `history benchmark ${size}: preview ${(previewTotal / (samples * 10)).toFixed(4)} ms/chunk, append ${(appendTotal / samples).toFixed(4)} ms/append; initial ${previewMs.toFixed(4)}, ${appendMs.toFixed(4)}\n`,
      );
    }
  });

test("m10-audit-history-index: no observer means previews derive nothing; irrelevant writes publish nothing", async (t) => {
  let reads = 0;
  let schedules = 0;
  const run = await openLiveRun(t, {
    onHistoryRead: () => reads++,
    scheduleHistoryPreview: () => {
      schedules++;
      return () => {};
    },
  });
  t.after(run.finish);
  admit(run.owner);
  reads = 0;
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "ignored",
      content: "Hidden",
    },
  });
  assert.equal(reads, 0);
  assert.equal(schedules, 0);
  const page = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(page.close);
  assert.ok(page.snapshot.result.found);
  assert.deepEqual(
    page.snapshot.result.history.rows.map(
      (row: SessionHistoryRow) => row.value,
    ),
    [
      { kind: "message", role: "user", content: "Input" },
      { kind: "message", role: "assistant", content: "Hidden" },
    ],
  );
  let delivered = false;
  const pending = page.updates[Symbol.asyncIterator]().next();
  void pending.then(() => {
    delivered = true;
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "model",
    payload: JSON.stringify({ model: "new-model" }),
    at: new Date(),
  });
  run.owner.writeState("running");
  await Promise.resolve();
  assert.equal(
    delivered,
    false,
    "an unchanged page must not reach a waiting observer",
  );
  page.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("m10-audit-history-index: eviction belongs to each subscription and same-Application reopen matches fresh stored history", async (t) => {
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
        input: `File ${i}`,
        outcome: { kind: "running" },
      }),
      at: new Date(),
    });
  const old = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(old.close);
  assert.ok(old.snapshot.result.found);
  assert.equal(old.snapshot.result.history.rows[0]?.value.kind, "tool");
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "ephemeral",
      content: "Live only",
    },
  });
  run.channel.observe({
    message: {
      turnId: "turn",
      session: "s",
      messageId: "ephemeral-2",
      content: "Also live only",
    },
  });
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "lost",
    resultDetail: "{}",
    availability: "open",
    at: new Date(),
  });
  const settled = await old.updates[Symbol.asyncIterator]().next();
  assert.ok(!settled.done);
  assert.ok(
    settled.value?.kind === "durable" &&
      settled.value.snapshot.family === "session-history" &&
      settled.value.snapshot.result.found,
  );
  const oldValues = settled.value.snapshot.result.history.rows.map(
    (row: SessionHistoryRow) => row.value,
  );
  assert.ok(
    !oldValues.some(
      (value) => value.kind === "tool" && value.input === "File 0",
    ),
  );
  assert.equal(oldValues.length, 199);
  for (const port of [run.port, run.reopen()]) {
    const reopened = port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
    t.after(reopened.close);
    assert.ok(reopened.snapshot.result.found);
    assert.equal(reopened.snapshot.result.history.rows.length, 200);
    assert.deepEqual(reopened.snapshot.result.history.rows[0]?.value, {
      kind: "tool",
      tool: "read",
      input: "File 1",
      outcome: { kind: "unconfirmed" },
    });
    assert.equal(reopened.snapshot.result.history.hasEarlier, true);
  }
});

test("m10-audit-history-index: duplicate facts and another Session's writes do not publish an unchanged page", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  const page = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(page.close);
  const event = {
    turnId: "turn",
    kind: "thought",
    payload: JSON.stringify({ summaryId: "one", content: "Kept" }),
    at: new Date(),
  };
  run.owner.appendTurnEvent(event);
  const changed = await page.updates[Symbol.asyncIterator]().next();
  assert.ok(
    changed.value?.kind === "durable" && changed.value.snapshot.result.found,
  );
  assert.deepEqual(changed.value.snapshot.result.history.rows.at(-1)?.value, {
    kind: "thought",
    content: "Kept",
  });
  let delivered = false;
  const pending = page.updates[Symbol.asyncIterator]().next();
  void pending.then(() => {
    delivered = true;
  });
  run.owner.appendTurnEvent({
    ...event,
    payload: JSON.stringify({ summaryId: "one", content: "Ignored duplicate" }),
  });
  run.owner.admitTurn({
    turnId: "other",
    attemptId: "0.0:echo",
    session: "other",
    origin: "human",
    kind: "interactive-agent",
    input: "Other Session",
    recoveryCoordinate: "private",
    harness: "codex",
    at: new Date(),
  });
  run.owner.appendTurnEvent({
    turnId: "other",
    kind: "thought",
    payload: JSON.stringify({ summaryId: "other", content: "Invisible" }),
    at: new Date(),
  });
  await Promise.resolve();
  assert.equal(
    delivered,
    false,
    "an unchanged page must not reach a waiting observer",
  );
  page.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("m10-audit-history-index: reopening after external ownership refreshes canonical facts and refuses a foreign live owner", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "open",
    at: new Date(),
  });
  const first = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  assert.ok(first.snapshot.result.found);
  assert.equal(first.snapshot.result.history.rows.length, 2);
  first.close();
  const workspace = run.owner.record.workspacePath;
  await run.finish();
  const other = openFakeRunGroup(run.storeHome, workspace, {
    selfPid: 2_000,
    isOwnerAlive: () => true,
  });
  t.after(() => other.close());
  assert.equal(other.resumeRun(run.runId).outcome, "resumed");
  const owner = other.acquireRun(run.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  const foreign = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(foreign.close);
  assert.ok(!foreign.snapshot.result.found);
  assert.equal(foreign.snapshot.result.problem.code, "run-live-elsewhere");
  admit(owner, "external");
  owner.appendTurnEvent({
    turnId: "external",
    kind: "assistant-content",
    payload: JSON.stringify({
      messageId: "external",
      content: "Committed elsewhere",
    }),
    at: new Date(),
  });
  owner.settleTurn({
    turnId: "external",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "open",
    at: new Date(),
  });
  other.endRun(run.runId);
  owner.close();
  for (const port of [run.port, run.reopen()]) {
    const fresh = port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
    t.after(fresh.close);
    assert.ok(fresh.snapshot.result.found);
    assert.equal(fresh.snapshot.result.history.rows.length, 5);
    assert.deepEqual(fresh.snapshot.result.history.rows[3]?.value, {
      kind: "message",
      role: "assistant",
      content: "Committed elsewhere",
    });
  }
});

test("m10-audit-history-index: an equivalent rebuilt index sends no duplicate page to an existing observer", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run.owner);
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "open",
    at: new Date(),
  });
  const page = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(page.close);
  assert.ok(page.snapshot.result.found);
  const workspace = run.owner.record.workspacePath;
  await run.finish();
  const other = openFakeRunGroup(run.storeHome, workspace);
  t.after(() => other.close());
  const owner = other.acquireRun(run.runId);
  assert.ok(owner);
  assert.ok(owner.writeState("halted").ok);
  owner.close();
  const reopened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(reopened.close);
  assert.ok(reopened.snapshot.result.found);
  assert.deepEqual(
    reopened.snapshot.result.history.rows.map(
      (row: SessionHistoryRow) => row.value,
    ),
    page.snapshot.result.history.rows.map(
      (row: SessionHistoryRow) => row.value,
    ),
  );
  let delivered = false;
  const pending = page.updates[Symbol.asyncIterator]().next();
  void pending.then(() => {
    delivered = true;
  });
  const resumed = run.port.submit({
    operationId: "equivalent-resume",
    operation: "resume-run",
    input: { runId: run.runId },
  });
  assert.ok(resumed.admitted, JSON.stringify(resumed));
  const settlement = await awaitSettled(run.port, "equivalent-resume");
  assert.equal(settlement.status, "applied", JSON.stringify(settlement));
  await Promise.resolve();
  assert.equal(
    delivered,
    false,
    "state writes with equivalent facts must not duplicate history",
  );
  page.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
});
