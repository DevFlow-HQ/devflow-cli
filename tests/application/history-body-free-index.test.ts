import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openLiveRun, type LiveRun } from "../helpers/liveRun.js";

const MESSAGES = 2_000;
const TURNS = MESSAGES / 100;

/** The bodies Store reads returned, and how many reads returned bodies, since the last `take`. */
function bodyReads() {
  let bodies = 0,
    reads = 0;
  return {
    onBodyRead: (count: number) => {
      bodies += count;
      reads++;
    },
    take: () => {
      const read = { bodies, reads };
      bodies = 0;
      reads = 0;
      return read;
    },
  };
}

function admit(owner: LiveRun["owner"], turnId: string, input = "Input"): void {
  assert.ok(
    owner.admitTurn({
      turnId,
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
}

/** Insert raw `turn_event` rows in one transaction, as a previous build stored them. */
function insertEvents(
  owner: LiveRun["owner"],
  storeHome: string,
  rows: readonly (readonly [turnId: string, kind: string, payload: string])[],
): void {
  const groups = join(storeHome, "runs");
  const database = new Database(
    join(groups, readdirSync(groups)[0]!, owner.record.runId, "run.db"),
  );
  try {
    const insert = database.query(
      "INSERT INTO turn_event (turn_id, kind, payload, at) VALUES (?, ?, ?, '2026-10-06T00:00:00.000Z')",
    );
    database.transaction(() => {
      for (const row of rows) insert.run(...row);
    })();
  } finally {
    database.close();
  }
}

/** 2,000 messages with large bodies across 20 Turns and 20 large Turn inputs. */
function seedLargeBodies(owner: LiveRun["owner"], storeHome: string): void {
  for (let turn = 0; turn < TURNS; turn++)
    admit(owner, `past-${turn}`, `Input ${turn} ` + "i".repeat(20_000));
  admit(owner, "turn");
  insertEvents(
    owner,
    storeHome,
    Array.from({ length: MESSAGES }, (_, i) => [
      `past-${Math.floor(i / 100)}`,
      "assistant-content",
      JSON.stringify({
        messageId: `m-${i}`,
        content: `Message ${i} ` + "x".repeat(20_000),
        historyOrder: i % 100,
      }),
    ]),
  );
}

function rowsOf(opened: {
  readonly snapshot: {
    readonly result:
      | {
          readonly found: true;
          readonly history: { readonly rows: readonly unknown[] };
        }
      | { readonly found: false };
  };
}) {
  assert.ok(opened.snapshot.result.found);
  return opened.snapshot.result.history.rows.map((row) => {
    const {
      id: _id,
      position: _position,
      ...rest
    } = row as {
      id: string;
      position: string;
      value: { reference?: unknown };
    };
    return JSON.stringify({
      ...rest,
      value: { ...rest.value, reference: rest.value.reference !== undefined },
    });
  });
}

test("m10-followup-body-free-history-index: opening and reopening history reads bodies only for windowed rows", async (t) => {
  const { onBodyRead, take } = bodyReads();
  // One Store read for the window's event bodies and one for its Turn inputs:
  // each walks an index, so per-row reads would multiply that walk.
  const windowOnly = { bodies: 200, reads: 2 };
  const run = await openLiveRun(t, {
    onBodyRead,
    seedRun: ({ owner, storeHome }) => seedLargeBodies(owner, storeHome),
  });
  const open = () =>
    run.port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
  // 2,021 rows exist: 2,000 messages and 21 Turn inputs; the window is the newest 200.
  const live = open();
  assert.deepEqual(
    take(),
    windowOnly,
    "the live index reads only the window's bodies",
  );
  const rows = rowsOf(live);
  assert.equal(rows.length, 200);
  live.close();
  await run.finish();
  take();
  const reopened = open();
  assert.deepEqual(
    take(),
    windowOnly,
    "a rested reopen reads only the window's bodies",
  );
  assert.equal(rowsOf(reopened).length, 200);
  reopened.close();
  const again = open();
  t.after(again.close);
  assert.deepEqual(
    take(),
    windowOnly,
    "every reopen after release pays only its window",
  );
  assert.deepEqual(rowsOf(again), rowsOf(reopened));
});

test("m10-followup-body-free-history-index: a failed windowed body read makes the page not found with its Problem", async (t) => {
  let fail = false;
  const run = await openLiveRun(t, {
    onRetainedEventRead: () => {
      if (fail) throw new Error("disk read failed");
    },
    seedRun: ({ owner, storeHome }) => {
      admit(owner, "turn");
      insertEvents(owner, storeHome, [
        [
          "turn",
          "assistant-content",
          JSON.stringify({ messageId: "m", content: "Stored" }),
        ],
      ]);
    },
  });
  await run.finish();
  const open = () =>
    run.port.openProjection({
      family: "session-history",
      runId: run.runId,
      session: "s",
    });
  fail = true;
  const failed = open();
  failed.close();
  assert.ok(!failed.snapshot.result.found);
  assert.equal(failed.snapshot.result.problem.code, "run-store-damaged");
  fail = false;
  const recovered = open();
  t.after(recovered.close);
  assert.ok(recovered.snapshot.result.found);
  assert.ok(
    recovered.snapshot.result.history.rows.some(
      (row) => row.value.kind === "message" && row.value.content === "Stored",
    ),
  );
});

test("m10-followup-body-free-history-index: rows history never shows take no window place without their bodies", async (t) => {
  const run = await openLiveRun(t, {
    seedRun: ({ owner, storeHome }) => {
      admit(owner, "turn");
      const rows: [string, string, string][] = [];
      for (let i = 0; i < 199; i++) {
        rows.push([
          "turn",
          "assistant-content",
          JSON.stringify({ messageId: `m-${i}`, content: `Message ${i}` }),
        ]);
        if (i % 4 === 0)
          rows.push([
            "turn",
            "thought",
            JSON.stringify({ summaryId: `blank-${i}`, content: " \n\t　 ﻿" }),
          ]);
        if (i % 9 === 0)
          rows.push([
            "turn",
            "assistant-content",
            JSON.stringify({
              messageId: `nested-${i}`,
              content: "Nested",
              parentActivity: "call",
            }),
          ]);
        if (i % 13 === 0) {
          rows.push([
            "turn",
            "assistant-content",
            JSON.stringify({ content: "No id" }),
          ]);
          rows.push(["turn", "model", JSON.stringify({ model: "gpt" })]);
          rows.push([
            "turn",
            "agent-call-expired",
            JSON.stringify({ callId: "c" }),
          ]);
          rows.push(["turn", "unknown-kind", JSON.stringify({ content: "?" })]);
          rows.push(["turn", "thought", "{not json"]);
          rows.push([
            "turn",
            "tool-call",
            JSON.stringify({ callId: `bad-${i}`, content: 1 }),
          ]);
        }
      }
      // A schema-invalid later row never hides the valid fact under its key.
      rows.push(
        [
          "turn",
          "tool-call",
          JSON.stringify({
            callId: "shadowed",
            tool: "command",
            input: "ls",
            outcome: { kind: "completed" },
          }),
        ],
        ["turn", "tool-call", JSON.stringify({ callId: "shadowed", input: 1 })],
      );
      rows.push([
        "turn",
        "thought",
        JSON.stringify({ summaryId: "shown", content: "　Thinking " }),
      ]);
      insertEvents(owner, storeHome, rows);
    },
  });
  t.after(run.finish);
  const opened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(opened.close);
  assert.ok(opened.snapshot.result.found);
  const { rows, hasEarlier } = opened.snapshot.result.history;
  // The Turn input, 199 messages, one tool and one Thought: no hidden row takes a place.
  assert.equal(hasEarlier, true);
  assert.equal(rows.length, 200);
  assert.deepEqual(rows[0]!.value, {
    kind: "message",
    role: "assistant",
    content: "Message 1",
  });
  const tool = rows.at(-2)!.value;
  assert.ok(tool.kind === "tool");
  assert.equal(tool.input, "ls");
  assert.deepEqual(tool.outcome, { kind: "completed" });
  assert.deepEqual(rows.at(-1)!.value, {
    kind: "thought",
    content: "　Thinking ",
  });
  assert.deepEqual(
    new Set(rows.map((row) => row.value.kind)),
    new Set(["message", "tool", "thought"]),
  );
});
