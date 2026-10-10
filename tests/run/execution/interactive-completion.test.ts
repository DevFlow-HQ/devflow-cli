import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Database } from "bun:sqlite";
import {
  heldAgentCall,
  latestAgentCall,
} from "../../../src/run/execution/execution.js";
import type { RunOwner } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "../store/fake-git-process.js";

const AT = new Date("2026-10-10T12:00:00.000Z");
const ATTEMPT = "0.0:discuss";

function openOwner(t: TestContext) {
  const home = makeTempDir("secant-agent-call-expiry-");
  const group = openRunGroup(home, "/work/example-project");
  t.after(() => group.close());
  const created = group.createRun({
    operationId: "op",
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: {},
    at: AT,
  });
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());
  const runs = join(home, "runs");
  const runDb = join(runs, readdirSync(runs)[0]!, created.runId, "run.db");
  return { owner, runDb };
}

function admit(owner: RunOwner, turnId: string) {
  assert.ok(
    owner.admitTurn({
      turnId,
      attemptId: ATTEMPT,
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "Discuss",
      recoveryCoordinate: "native",
      harness: "codex",
      at: AT,
    }).ok,
  );
}

function callOn(
  owner: RunOwner,
  turnId: string,
  callId: string,
  outcome: "accepted" | "held-for-review" = "accepted",
) {
  assert.ok(
    owner.appendTurnEvent({
      turnId,
      fact: {
        kind: "agent-call",
        data: {
          callId,
          id: "step_done",
          reason: `Done ${callId}`,
          answer: { outcome },
        },
      },
      at: AT,
    }).ok,
  );
}

/** A stored expiry as the Application writes it (unstamped) or as any other
 *  writer may (stamped with a history order). */
function expire(
  owner: RunOwner,
  turnId: string,
  callId: string,
  order?: number,
) {
  assert.ok(
    owner.appendTurnEvent({
      turnId,
      fact: { kind: "agent-call-expired", data: { callId } },
      ...(order !== undefined ? { historyOrder: order } : {}),
      at: AT,
    }).ok,
  );
}

const expiries = [
  { name: "unstamped", write: (o: RunOwner) => expire(o, "turn", "a") },
  { name: "stamped", write: (o: RunOwner) => expire(o, "turn", "a", 7) },
] as const;

for (const expiry of expiries)
  test(`m10-followup-agent-call-expiry: a ${expiry.name} expiry refuses its call and a later live call is accepted`, (t) => {
    const { owner } = openOwner(t);
    admit(owner, "turn");
    callOn(owner, "turn", "a");
    assert.equal(latestAgentCall(owner, ATTEMPT)?.call.callId, "a");
    expiry.write(owner);
    assert.equal(latestAgentCall(owner, ATTEMPT), undefined);
    callOn(owner, "turn", "b");
    const live = latestAgentCall(owner, ATTEMPT);
    assert.equal(live?.call.callId, "b");
    assert.equal(live?.call.id, "step_done");
    assert.equal(live?.turn.turnId, "turn");
  });

test("m10-followup-agent-call-expiry: a key-reordered stored expiry refuses its call", (t) => {
  const { owner, runDb } = openOwner(t);
  admit(owner, "turn");
  callOn(owner, "turn", "a", "held-for-review");
  assert.equal(heldAgentCall(owner, ATTEMPT)?.call.callId, "a");
  // The schema accepts any key order; only a raw row can carry one the Store's
  // own serialization never produces.
  const db = new Database(runDb);
  try {
    db.query(
      "INSERT INTO turn_event (turn_id, kind, payload, at) VALUES (?, ?, ?, ?)",
    ).run(
      "turn",
      "agent-call-expired",
      JSON.stringify({ historyOrder: 2, callId: "a" }),
      AT.toISOString(),
    );
  } finally {
    db.close();
  }
  assert.equal(heldAgentCall(owner, ATTEMPT), undefined);
  assert.equal(latestAgentCall(owner, ATTEMPT), undefined);
});

test("m10-followup-agent-call-expiry: an expiry of another call leaves the latest call valid", (t) => {
  const { owner } = openOwner(t);
  admit(owner, "turn");
  callOn(owner, "turn", "a");
  callOn(owner, "turn", "b");
  expire(owner, "turn", "a", 3);
  assert.equal(latestAgentCall(owner, ATTEMPT)?.call.callId, "b");
});

test("m10-followup-agent-call-expiry: the check reads only the judged Turn's events", (t) => {
  const { owner } = openOwner(t);
  admit(owner, "earlier");
  callOn(owner, "earlier", "a");
  admit(owner, "turn");
  callOn(owner, "turn", "b");
  const read: (string | undefined)[] = [];
  const narrowed: Pick<RunOwner, "turns" | "turnEventsOfKinds"> = {
    turns: () => owner.turns(),
    turnEventsOfKinds: (kinds, turnId) => {
      read.push(turnId);
      return owner.turnEventsOfKinds(kinds, turnId);
    },
  };
  assert.equal(latestAgentCall(narrowed, ATTEMPT)?.call.callId, "b");
  assert.deepEqual(read, ["turn"]);
});

test("m10-followup-bounded-run-snapshot: the Agent-call lookup reads only the judged Turn's Agent-call rows", (t) => {
  const { owner } = openOwner(t);
  admit(owner, "turn");
  callOn(owner, "turn", "a");
  for (const fact of [
    { kind: "thought", data: { summaryId: "t", content: "Thinking" } },
    { kind: "turn-diff", data: { content: "diff", files: [] } },
    { kind: "assistant-content", data: { content: "Hello" } },
  ] as const)
    assert.ok(owner.appendTurnEvent({ turnId: "turn", fact, at: AT }).ok);
  expire(owner, "turn", "a");
  callOn(owner, "turn", "b", "held-for-review");
  const read: string[] = [];
  const counted: Pick<RunOwner, "turns" | "turnEventsOfKinds"> = {
    turns: () => owner.turns(),
    turnEventsOfKinds: (kinds, turnId) => {
      const events = owner.turnEventsOfKinds(kinds, turnId);
      read.push(...events.map((event) => event.kind));
      return events;
    },
  };
  assert.equal(heldAgentCall(counted, ATTEMPT)?.call.callId, "b");
  assert.equal(latestAgentCall(counted, ATTEMPT), undefined);
  assert.deepEqual(read, [
    ...["agent-call", "agent-call-expired", "agent-call"],
    ...["agent-call", "agent-call-expired", "agent-call"],
  ]);
});
