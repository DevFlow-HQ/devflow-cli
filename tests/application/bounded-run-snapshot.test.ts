import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openLiveRun, type LiveRun } from "../helpers/liveRun.js";

const AT = "2026-10-10T00:00:00.000Z";
const LARGE = "x".repeat(20_000);
// Kinds the Run timeline never shows, whose bodies are the Run's bulk.
const UNSHOWN = new Set(["turn-diff", "tool-partial", "thought"]);

/** A Turn event as a Store read returns it. */
interface TurnEventRecord {
  readonly turnId: string;
  readonly kind: string;
  readonly payload: string;
}

/** The Turn events Store reads returned since the last `take`, with how many reads returned any. */
function eventReads() {
  let read: TurnEventRecord[] = [];
  let reads = 0;
  return {
    onTurnEventRead: (events: readonly TurnEventRecord[]) => {
      read.push(...events);
      reads++;
    },
    take: () => {
      const taken = { events: read, reads };
      read = [];
      reads = 0;
      return taken;
    },
  };
}

/** Every event read once, and none the timeline never shows. */
function assertBounded(events: readonly TurnEventRecord[], label: string) {
  assert.deepEqual(
    events.filter((event) => UNSHOWN.has(event.kind)).map((e) => e.kind),
    [],
    `${label}: no unshown body is read`,
  );
  const keys = events.map((e) => JSON.stringify([e.turnId, e.kind, e.payload]));
  assert.equal(new Set(keys).size, keys.length, `${label}: no event twice`);
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
      at: new Date(AT),
    }).ok,
  );
}

/** Insert raw `turn_event` rows in one transaction, as a previous build stored them. */
function insertEvents(
  owner: LiveRun["owner"],
  storeHome: string,
  rows: readonly (readonly [turnId: string, kind: string, payload: unknown])[],
): void {
  const groups = join(storeHome, "runs");
  const database = new Database(
    join(groups, readdirSync(groups)[0]!, owner.record.runId, "run.db"),
  );
  try {
    const insert = database.query(
      "INSERT INTO turn_event (turn_id, kind, payload, at) VALUES (?, ?, ?, ?)",
    );
    database.transaction(() => {
      for (const [turnId, kind, payload] of rows)
        insert.run(
          turnId,
          kind,
          typeof payload === "string" ? payload : JSON.stringify(payload),
          AT,
        );
    })();
  } finally {
    database.close();
  }
}

/** One Turn's worth of every stored kind, unique per Turn so a re-read is visible. */
function everyKind(turnId: string): [string, string, unknown][] {
  const call = (callId: string) => ({
    callId,
    id: "step_done",
    reason: `Done ${callId}`,
    answer: { outcome: "accepted" },
  });
  const steer = (settlement: object) => ({
    steerId: `steer-${turnId}`,
    text: `Steer ${turnId}`,
    sentAt: AT,
    settlement,
  });
  const tool = { tool: "command", input: `ls ${turnId}` };
  return [
    [turnId, "thought", { summaryId: `t-${turnId}`, content: LARGE }],
    [turnId, "turn-diff", { content: LARGE, files: [{ path: "a.ts" }] }],
    [
      turnId,
      "tool-partial",
      {
        ...tool,
        callId: `p-${turnId}`,
        outcome: { kind: "running" },
        output: { text: LARGE, incomplete: true },
      },
    ],
    [turnId, "assistant-content", { messageId: turnId, content: "Hello" }],
    [
      turnId,
      "tool-call",
      { ...tool, callId: `c-${turnId}`, outcome: { kind: "completed" } },
    ],
    [turnId, "model", { model: `model-${turnId}` }],
    [turnId, "steer", steer({ kind: "waiting" })],
    [turnId, "steer", steer({ kind: "delivered", delivery: "within-turn" })],
    [turnId, "agent-call", call(`a-${turnId}`)],
    [turnId, "agent-call-expired", { callId: `a-${turnId}` }],
    [turnId, "agent-call", call(`b-${turnId}`)],
    [turnId, "tool-call", { callId: `bad-${turnId}`, input: 1 }],
    [turnId, "unknown-kind", { content: turnId }],
  ];
}

function scheduler() {
  const pending = new Set<() => void>();
  return {
    schedule(callback: () => void) {
      pending.add(callback);
      return () => {
        pending.delete(callback);
      };
    },
    flush() {
      for (const callback of [...pending]) {
        pending.delete(callback);
        callback();
      }
    },
  };
}

test("m10-followup-bounded-run-snapshot: a Run snapshot reads each shown event once and no unshown body", async (t) => {
  const { onTurnEventRead, take } = eventReads();
  const clock = scheduler();
  const run = await openLiveRun(t, {
    onTurnEventRead,
    scheduleRunUpdate: clock.schedule,
    seedRun: ({ owner, storeHome }) => {
      admit(owner, "past");
      admit(owner, "turn");
      insertEvents(owner, storeHome, [
        ...everyKind("past"),
        ...everyKind("turn"),
      ]);
    },
  });
  const opened = run.port.openProjection({ family: "run", runId: run.runId });
  t.after(opened.close);
  assert.ok(opened.snapshot.result.found);
  const open = take();
  assertBounded(open.events, "open");
  assert.equal(open.reads, 1, "one Store read serves the whole snapshot");
  const timeline = opened.snapshot.result.run.timeline;
  assert.deepEqual(
    timeline
      .filter((e) => e.event === "agent-call")
      .map((e) => e.agentCall?.reason),
    ["Done a-past", "Done b-past", "Done a-turn", "Done b-turn"],
  );
  assert.deepEqual(
    timeline.filter((e) => e.event === "steer").map((e) => e.detail),
    [
      "delivered within Turn · Steer past",
      "delivered within Turn · Steer turn",
    ],
  );

  // Every durable push while observed refreshes the snapshot by the same bound.
  for (const [kind, data] of [
    ["thought", { summaryId: "live", content: LARGE }],
    ["assistant-content", { messageId: "live", content: "Live" }],
  ] as const) {
    assert.ok(
      run.owner.appendTurnEvent({
        turnId: "turn",
        fact: { kind, data } as Parameters<
          LiveRun["owner"]["appendTurnEvent"]
        >[0]["fact"],
        at: new Date(AT),
      }).ok,
    );
    clock.flush();
    const pushed = take();
    assertBounded(pushed.events, `after ${kind}`);
    assert.equal(pushed.reads, 1, `after ${kind}: one read`);
  }
  await run.finish();
});
