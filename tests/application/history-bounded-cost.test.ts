import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openLiveRun, type LiveRun } from "../helpers/liveRun.js";
import { turnFact } from "../helpers/turnFact.js";
import { readHistoryText } from "./history-content-fixture.js";

const MESSAGES = 2_000;
const BODY = 100_000;

/** The injected observer's latest count of row values each Run's index retains. */
function retention() {
  const values = new Map<string, number>();
  return {
    observeHistoryRetention: (runId: string, count: number) =>
      void values.set(runId, count),
    retained: (runId: string) => values.get(runId),
  };
}

function admit(owner: LiveRun["owner"], turnId: string): void {
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

/** 2,000 retained 100 KB messages, written atomically before Application indexes them. */
function seedLargeMessages(owner: LiveRun["owner"], storeHome: string): void {
  for (let turn = 0; turn < MESSAGES / 100; turn++)
    admit(owner, `past-${turn}`);
  admit(owner, "turn");
  const groups = join(storeHome, "runs");
  const database = new Database(
    join(groups, readdirSync(groups)[0]!, owner.record.runId, "run.db"),
  );
  try {
    const insert = database.query(
      "INSERT INTO turn_event (turn_id, kind, payload, at) VALUES (?, 'assistant-content', ?, ?)",
    );
    database.transaction(() => {
      for (let i = 0; i < MESSAGES; i++)
        insert.run(
          `past-${Math.floor(i / 100)}`,
          JSON.stringify({
            messageId: `m-${i}`,
            content: `Message ${i} ` + "x".repeat(BODY),
            historyOrder: i % 100,
          }),
          "2026-10-06T00:00:00.000Z",
        );
    })();
  } finally {
    database.close();
  }
}

test("m10-followup-bounded-history-cost: the history index retains bodies only for the 200-row window", async (t) => {
  const { observeHistoryRetention, retained } = retention();
  const run = await openLiveRun(t, {
    observeHistoryRetention,
    seedRun: ({ owner, storeHome }) => seedLargeMessages(owner, storeHome),
  });
  t.after(run.finish);
  const page = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(page.close);
  assert.ok(page.snapshot.result.found);
  assert.equal(page.snapshot.result.history.rows.length, 200);
  // 2,021 rows exist: 2,000 messages and 21 Turn inputs.
  assert.equal(retained(run.runId), 200);
  assert.ok(
    run.owner.appendTurnEvent({
      turnId: "turn",
      fact: turnFact("assistant-content", {
        messageId: "next",
        content: "Next",
      }),
      at: new Date(),
    }).ok,
  );
  assert.equal(retained(run.runId), 200);
});

test("m10-followup-bounded-history-cost: an index no observer or live owner holds is released and reopening rebuilds its page", async (t) => {
  const { observeHistoryRetention, retained } = retention();
  const run = await openLiveRun(t, {
    observeHistoryRetention,
    seedRun: ({ owner, storeHome }) => seedLargeMessages(owner, storeHome),
  });
  const open = () =>
    run.port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
  const page = (opened: ReturnType<typeof open>) => {
    assert.equal(retained(run.runId), 200);
    opened.close();
    assert.ok(opened.snapshot.result.found);
    return opened.snapshot.result.history.rows.map(
      ({ id, turn, source, value }) => ({
        id,
        page: JSON.stringify({
          turn,
          source,
          value: { ...value, reference: undefined },
        }),
      }),
    );
  };
  const rows = page(open());
  // The live owner still writes through the index after its last observer closes.
  assert.equal(retained(run.runId), 200);
  await run.finish();
  assert.equal(retained(run.runId), 0, "released once the owner rested");
  assert.equal(page(open()).length, rows.length);
  assert.equal(retained(run.runId), 0, "released at the last close");
  const again = page(open());
  assert.equal(again.length, rows.length);
  const ids = new Set(rows.map((row) => row.id));
  for (const [i, row] of again.entries()) {
    assert.ok(!ids.has(row.id), "reopening mints fresh row identities");
    assert.equal(row.page, rows[i]!.page);
  }
});

test("m10-followup-bounded-history-cost: rows re-entering the window read their values again from the Store", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  const input = "Input " + "i".repeat(5000);
  assert.ok(
    run.owner.admitTurn({
      turnId: "turn",
      attemptId: "0.0:echo",
      session: "s",
      origin: "human",
      kind: "interactive-agent",
      input,
      recoveryCoordinate: "private",
      harness: "codex",
      at: new Date("2026-10-06T00:00:00Z"),
    }).ok,
  );
  const append = (fact: ReturnType<typeof turnFact>) =>
    assert.ok(
      run.owner.appendTurnEvent({ turnId: "turn", fact, at: new Date() }).ok,
    );
  for (let i = 0; i < 198; i++)
    append(
      turnFact("assistant-content", {
        messageId: `m-${i}`,
        content: `Message ${i}`,
      }),
    );
  const open = () => {
    const opened = run.port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
    opened.close();
    assert.ok(opened.snapshot.result.found);
    return opened.snapshot.result.history;
  };
  for (let i = 0; i < 3; i++)
    run.channel.observe({
      message: {
        turnId: "turn",
        session: "s",
        messageId: `live-${i}`,
        content: `Live ${i}`,
      },
    });
  const full = open();
  assert.equal(full.hasEarlier, true);
  assert.deepEqual(full.rows[0]!.value, {
    kind: "message",
    role: "assistant",
    content: "Message 1",
  });
  // Settlement removes the three live-only rows and adds the result, so the
  // evicted input and first message return to the window.
  assert.ok(
    run.owner.settleTurn({
      turnId: "turn",
      session: "s",
      resultKind: "lost",
      resultDetail: "{}",
      availability: "open",
      at: new Date(),
    }).ok,
  );
  const page = open();
  assert.equal(page.hasEarlier, false);
  assert.equal(page.rows.length, 200);
  const first = page.rows[0]!.value;
  assert.ok(first.kind === "message" && first.role === "user");
  assert.equal(first.content.length, 4095);
  assert.ok(first.reference);
  assert.equal(await readHistoryText(run.port, first.reference), input);
  assert.deepEqual(page.rows[1]!.value, {
    kind: "message",
    role: "assistant",
    content: "Message 0",
  });
  assert.equal(page.rows.at(-1)!.value.kind, "turn-result");
});

test("m10-followup-bounded-history-cost: a released index's content references read as stale", async (t) => {
  const run = await openLiveRun(t);
  const body = "Long " + "l".repeat(10_000);
  assert.ok(
    run.owner.admitTurn({
      turnId: "turn",
      attemptId: "0.0:echo",
      session: "s",
      origin: "human",
      kind: "interactive-agent",
      input: body,
      recoveryCoordinate: "private",
      harness: "codex",
      at: new Date("2026-10-06T00:00:00Z"),
    }).ok,
  );
  await run.finish();
  const open = () =>
    run.port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
  const first = open();
  assert.ok(first.snapshot.result.found);
  const input = first.snapshot.result.history.rows[0]!.value;
  assert.ok(input.kind === "message" && input.reference);
  assert.equal(await readHistoryText(run.port, input.reference), body);
  first.close();
  const second = open();
  t.after(second.close);
  const stale = await run.port.readHistoryContent({
    reference: input.reference,
  });
  assert.ok(!stale.found);
  assert.equal(stale.problem.code, "history-content-stale");
  assert.ok(second.snapshot.result.found);
  const fresh = second.snapshot.result.history.rows[0]!.value;
  assert.ok(fresh.kind === "message" && fresh.reference);
  assert.equal(await readHistoryText(run.port, fresh.reference), body);
});
