import {
  openAgentAttemptTurn,
  type TurnRecord,
} from "../../../src/run/store/store.js";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "./fake-git-process.js";

const WORKSPACE = "/work/reconcile-turn-project";
const AT = new Date("2026-09-16T12:00:00.000Z");

test("startup reconciliation settles an admitted-but-unsettled Turn as lost/completion-unknown (#118)", (t) => {
  const home = makeTempDir("secant-reconcile-turn-");
  const group = openRunGroup(home, WORKSPACE);
  const created = group.createRun({
    operationId: "op-1",
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: { goal: "ship it" },
    at: AT,
  });
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("running"), { ok: true }); // a live Run mid-Turn
  // Admit a Turn the way the Agent executor does, then never settle it: the owner
  // dies mid-Turn.
  assert.deepEqual(
    owner.admitTurn({
      turnId: "0.0:fix#turn-1",
      attemptId: "0.0:fix",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "Repair the failing test.",
      recoveryCoordinate: "11111111-1111-4111-8111-111111111111",
      harness: "claude-code",
      at: AT,
    }),
    { ok: true },
  );
  owner.close();
  group.close(); // the launch process dies without ending the Run

  // Reopening the group reconciles the dead owner's Run: state -> halted, an
  // indeterminate Attempt marker, and the unsettled Turn -> lost.
  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const read = reopened.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "halted");

  const owner2 = reopened.acquireRun(created.runId);
  assert.ok(owner2);
  t.after(() => owner2.close());
  assert.equal(owner2.attemptLog().at(-1)?.outcome, "indeterminate");

  const turns = owner2.turns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.resultKind, "lost");
  assert.ok(turns[0]?.settledAt !== undefined);

  // The abandoned Turn's Session detaches to its stored coordinate (not left `open`),
  // so a later resume continues in the same Claude Code Session via `--resume` rather
  // than silently opening a fresh conversation (ADR 0022, #118).
  assert.deepEqual(owner2.harnessSessions(), [
    {
      session: "s",
      availability: "detached",
      availabilityDetail: "11111111-1111-4111-8111-111111111111",
    },
  ]);

  // The lost detail records completion-unknown, read back through the Store's
  // `TurnRecord.resultDetail` member rather than a raw `run.db` query.
  assert.ok(turns[0]?.resultDetail !== undefined);
  assert.deepEqual(JSON.parse(turns[0]!.resultDetail!), {
    kind: "lost",
    unknown: "completion",
  });
});

for (const scenario of [
  {
    name: "Agent wait",
    kind: "agent",
    result: "interrupted",
    expected: "halted",
  },
  {
    name: "Interactive wait",
    kind: "interactive-agent",
    result: "interrupted",
    expected: "blocked",
  },
  {
    name: "interrupted human follow-up",
    kind: "agent",
    result: "interrupted",
    latest: true,
    expected: "halted",
  },
  {
    name: "interrupted Interactive human Turn",
    kind: "interactive-agent",
    result: "interrupted",
    latest: true,
    expected: "blocked",
  },
  {
    name: "lost latest Turn",
    kind: "agent",
    result: "lost",
    latest: true,
    expected: "blocked",
  },
  {
    name: "completed latest Turn",
    kind: "agent",
    result: "completed",
    latest: true,
    expected: "blocked",
  },
  {
    name: "unknown latest result",
    kind: "agent",
    result: "future-result",
    latest: true,
    expected: "blocked",
  },
  {
    name: "published Attempt",
    kind: "agent",
    result: "interrupted",
    published: true,
    expected: "blocked",
  },
  {
    name: "unowned legacy wait",
    kind: "agent",
    result: "interrupted",
    release: true,
    expected: "blocked",
  },
  {
    name: "live other owner",
    kind: "agent",
    result: "interrupted",
    live: true,
    expected: "blocked",
  },
] as const) {
  test(`startup recovery of ${scenario.name} preserves history and rests ${scenario.expected} (#355)`, (t) => {
    const home = makeTempDir("secant-reconcile-waiting-");
    const group = openRunGroup(home, WORKSPACE, { selfPid: 1000 });
    const created = group.createRun({
      operationId: "op-wait",
      bundleSnapshotDigest: "sha256:deadbeef",
      launch: {},
      at: AT,
    });
    assert.ok(created.outcome === "created");
    const owner = group.acquireRun(created.runId);
    assert.ok(owner);
    const admitAndSettle = (number: number, result: string) => {
      const turnId = `0.0:fix#turn-${number}`;
      assert.deepEqual(
        owner.admitTurn({
          turnId,
          attemptId: "0.0:fix",
          session: "s",
          origin: number === 1 ? "managed" : "human",
          kind: scenario.kind,
          input: "Fix it",
          recoveryCoordinate: "s",
          harness: "claude-code",
          at: AT,
        }),
        { ok: true },
      );
      assert.deepEqual(
        owner.settleTurn({
          turnId,
          resultKind: result,
          resultDetail: "{}",
          session: "s",
          availability: "detached",
          availabilityDetail: "s",
          at: AT,
        }),
        { ok: true },
      );
    };
    if ("latest" in scenario) admitAndSettle(1, "interrupted");
    admitAndSettle("latest" in scenario ? 2 : 1, scenario.result);
    if ("published" in scenario)
      assert.ok(
        owner.publishAttempt({
          attemptId: "0.0:fix",
          outcome: "succeeded",
          outputs: [],
          required: [],
          at: AT,
        }).ok,
      );
    assert.deepEqual(owner.writeState("blocked"), { ok: true });
    if ("release" in scenario) owner.release();
    const history = owner.attemptLog();
    const turns = owner.turns();
    owner.close();
    group.close();
    const reopened = openRunGroup(home, WORKSPACE, {
      selfPid: 2000,
      isOwnerAlive: () => "live" in scenario,
    });
    t.after(() => reopened.close());
    const read = reopened.readRun(created.runId);
    assert.ok(read.ok);
    assert.equal(read.run.state, scenario.expected);
    assert.equal(reopened.listRuns()[0]?.live, "live" in scenario);
    const recovered = reopened.acquireRun(created.runId, { takeover: true });
    assert.ok(recovered);
    t.after(() => recovered.close());
    assert.deepEqual(recovered.attemptLog(), history);
    assert.deepEqual(recovered.turns(), turns);
  });
}

test("the open-Attempt read finds only an Agent Attempt with Turns and no published outcome (#352)", () => {
  const turn = (
    turnId: string,
    attemptId: string,
    sequence: number,
    kind?: string,
  ): TurnRecord => ({
    turnId,
    attemptId,
    session: "s",
    origin: "managed",
    ...(kind !== undefined ? { kind } : {}),
    sequence,
    input: "Do the work.",
    admittedAt: AT.toISOString(),
  });
  const read = (
    turns: readonly TurnRecord[],
    published: readonly string[] = [],
  ) =>
    openAgentAttemptTurn({
      turns: () => turns,
      attemptLog: () =>
        published.map((attemptId) => ({
          attemptId,
          outcome: "succeeded" as const,
          at: AT.toISOString(),
        })),
    });
  const closed = turn("0.0:a#turn-1", "0.0:a", 0, "agent");

  assert.equal(read([]), undefined);
  assert.equal(read([closed], ["0.0:a"]), undefined);
  // A resting Interactive Attempt has Turns and no outcome, but is not an Agent one.
  assert.equal(
    read([turn("0.0:i#entry", "0.0:i", 0, "interactive-agent")]),
    undefined,
  );
  // A legacy row's kind is unknown, never guessed to be an Agent Turn.
  assert.equal(read([turn("0.0:l#turn", "0.0:l", 0)]), undefined);

  assert.equal(
    read([turn("0.0:u#turn", "0.0:u", 0, "future-kind")]),
    undefined,
  );

  const open = read(
    [
      closed,
      turn("1.0:b#turn-1", "1.0:b", 1, "agent"),
      turn("2.0:i#entry", "2.0:i", 2, "interactive-agent"),
      turn("1.0:b#turn-2", "1.0:b", 3, "agent"),
    ],
    ["0.0:a"],
  );
  assert.equal(open?.attemptId, "1.0:b");
  assert.equal(open.turnId, "1.0:b#turn-2");
});
