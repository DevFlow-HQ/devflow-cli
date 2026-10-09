import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";
import type { ToolCall, TurnFact } from "../../../src/harness/harness.js";
import { turnFact, type TurnFactData } from "../../helpers/turnFact.js";
import {
  readTurnFact,
  type AdmitTurnRequest,
  type RunGroup,
  type RunOwner,
} from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "./fake-git-process.js";

const WORKSPACE = "/work/example-project";
const AT = new Date("2026-09-12T12:00:00.000Z");
function create(
  group: RunGroup,
  operationId: string,
  overrides: {
    digest?: string;
    launch?: unknown;
    selectedHarness?: "claude-code" | "codex";
  } = {},
) {
  return group.createRun({
    operationId,
    bundleSnapshotDigest: overrides.digest ?? "sha256:deadbeef",
    launch: overrides.launch ?? { goal: "ship it" },
    ...(overrides.selectedHarness !== undefined
      ? { selectedHarness: overrides.selectedHarness }
      : {}),
    at: AT,
  });
}

/** The group directory Secant home resolves for the test Workspace. */
function groupDirOf(home: string): string {
  const runs = join(home, "runs");
  return join(runs, readdirSync(runs)[0]!);
}

test("a Turn is admitted, events append, and the result settles immutably (#116)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  const admitted = owner.admitTurn({
    turnId: "turn-1",
    attemptId: "0.0:write",
    session: "s",
    origin: "managed",
    kind: "agent",
    input: "do the thing at /abs/path.md",
    recoveryCoordinate: "native-abc",
    harness: "claude-code",
    at: AT,
  });
  assert.ok(admitted.ok);

  // The Turn row is admitted before any result, the Session reads `open`, and the
  // input is a `user` transcript entry. The Crucible Turn kind is recorded durably
  // (#126), independent of the `managed` origin.
  assert.equal(owner.turns().length, 1);
  assert.equal(owner.turns()[0]?.resultKind, undefined);
  assert.equal(owner.turns()[0]?.kind, "agent");
  assert.equal(owner.turns()[0]?.origin, "managed");
  assert.equal(owner.turns()[0]?.input, "do the thing at /abs/path.md");
  assert.deepEqual(owner.harnessSessions(), [
    { session: "s", availability: "open" },
  ]);
  assert.equal(owner.transcript()[0]?.role, "user");

  owner.appendTurnEvent({
    turnId: "turn-1",
    fact: {
      kind: "assistant-content",
      data: { messageId: "hello-message", content: "hello" },
    },
    at: AT,
  });
  owner.appendTurnEvent({
    turnId: "turn-1",
    fact: { kind: "tool-activity", data: { tool: "Edit", phase: "started" } },
    at: AT,
  });
  assert.equal(owner.turnEvents().length, 2);

  const settled = owner.settleTurn({
    turnId: "turn-1",
    session: "s",
    resultKind: "completed",
    resultDetail: JSON.stringify({ finalContent: "hello" }),
    availability: "open",
    at: AT,
  });
  assert.ok(settled.ok);
  assert.equal(owner.turns()[0]?.resultKind, "completed");
  assert.equal(
    owner.transcript().filter((entry) => entry.role === "assistant").length,
    1,
  );

  // A settled result is immutable: a second settle changes nothing.
  owner.settleTurn({
    turnId: "turn-1",
    session: "s",
    resultKind: "failed",
    resultDetail: "{}",
    availability: "unusable",
    at: AT,
  });
  assert.equal(owner.turns()[0]?.resultKind, "completed");
  assert.equal(owner.harnessSessions()[0]?.availability, "open");

  // The Attempt's effective model is readable once published.
  const published = owner.publishAttempt({
    attemptId: "0.0:write",
    outcome: "succeeded",
    required: [],
    outputs: [],
    at: AT,
    agentEvidence: {
      kind: "agent",
      effectiveModel: "claude-opus-5",
      identity: {
        harness: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
    },
  });
  assert.ok(published.ok);
  assert.equal(owner.harnessEvidence()?.effectiveModel, "claude-opus-5");
});

test("a fenced owner refuses every Turn-side write and the authored pending gate, writing nothing (A51)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const stale = group.acquireRun(created.runId)!;
  const fresh = group.acquireRun(created.runId)!; // bumps the epoch, fencing `stale`
  t.after(() => fresh.close());

  const fenced = { ok: false, reason: "fenced" };
  // Admission refused is what proves the Turn `not-started` (store/AGENTS.md): no
  // stdin is sent because no `turn` row exists.
  assert.deepEqual(
    stale.admitTurn({
      turnId: "turn-1",
      attemptId: "0.0:write",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "do the thing",
      recoveryCoordinate: "native-abc",
      harness: "claude-code",
      at: AT,
    }),
    fenced,
  );
  assert.deepEqual(
    stale.appendTurnEvent({
      turnId: "turn-1",
      fact: {
        kind: "assistant-content",
        data: { messageId: "hello-message", content: "hello" },
      },
      at: AT,
    }),
    fenced,
  );
  assert.deepEqual(
    stale.settleTurn({
      turnId: "turn-1",
      session: "s",
      resultKind: "completed",
      resultDetail: JSON.stringify({ kind: "completed" }),
      availability: "open",
      at: AT,
    }),
    fenced,
  );
  assert.deepEqual(
    stale.recordPendingGate({
      attemptId: "0.1:gate",
      stepId: "gate",
      shape: "approve-reject",
      message: "Ship it?",
      at: AT,
    }),
    fenced,
  );

  // Nothing landed: the fresh owner reads no Turn, no event, no Session, no
  // transcript entry, no pending gate, and the Run never rested `blocked`.
  assert.deepEqual(fresh.turns(), []);
  assert.deepEqual(fresh.turnEvents(), []);
  assert.deepEqual(fresh.harnessSessions(), []);
  assert.deepEqual(fresh.transcript(), []);
  assert.equal(fresh.pendingGate(), undefined);
  const read = group.readRun(created.runId);
  assert.ok(read.ok && read.run.state === "created");
});

test("settling a Turn records the detached and unusable Session availabilities with their detail (A51)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  const later = new Date(AT.getTime() + 1_000);
  const admit = (turnId: string, session: string, at: Date) =>
    owner.admitTurn({
      turnId,
      attemptId: `${turnId}:attempt`,
      session,
      origin: "managed",
      kind: "agent",
      input: `input for ${session}`,
      recoveryCoordinate: `native-${session}`,
      harness: "claude-code",
      at,
    });
  assert.ok(admit("turn-a", "s-a", AT).ok);
  assert.ok(admit("turn-b", "s-b", later).ok);
  assert.deepEqual(
    owner.harnessSessions().map((s) => s.availability),
    ["open", "open"],
  );

  // The process is closed when the Run rests and the Session becomes detached
  // with the resume id (spec #107): the shape execution writes for a completed
  // Turn whose Harness closes, carrying the recovery coordinate as the detail.
  assert.ok(
    owner.settleTurn({
      turnId: "turn-a",
      session: "s-a",
      resultKind: "completed",
      resultDetail: JSON.stringify({ kind: "completed" }),
      availability: "detached",
      availabilityDetail: "native-s-a",
      at: later,
    }).ok,
  );
  // Recovery that fails leaves the Session `unusable`, its reason as the detail.
  assert.ok(
    owner.settleTurn({
      turnId: "turn-b",
      session: "s-b",
      resultKind: "failed",
      resultDetail: JSON.stringify({ kind: "failed" }),
      availability: "unusable",
      availabilityDetail: "resume-unacknowledged",
      at: later,
    }).ok,
  );

  assert.deepEqual(owner.harnessSessions(), [
    {
      session: "s-a",
      availability: "detached",
      availabilityDetail: "native-s-a",
    },
    {
      session: "s-b",
      availability: "unusable",
      availabilityDetail: "resume-unacknowledged",
    },
  ]);
  assert.deepEqual(
    owner.turns().map((turn) => turn.resultKind),
    ["completed", "failed"],
  );
});

test("Turn kind records both kinds in one Session, and a legacy row reads unknown (#126)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  // Two Interactive Turns then a following Agent Turn, all in one named Session —
  // the kind is Crucible truth independent of origin (`human`/`managed`).
  owner.admitTurn({
    turnId: "turn-1",
    attemptId: "0.0:discuss",
    session: "shared",
    origin: "human",
    kind: "interactive-agent",
    input: "let's talk",
    recoveryCoordinate: "native-1",
    harness: "claude-code",
    at: AT,
  });
  owner.admitTurn({
    turnId: "turn-2",
    attemptId: "0.0:discuss",
    session: "shared",
    origin: "human",
    kind: "interactive-agent",
    input: "one more thing",
    recoveryCoordinate: "native-1",
    harness: "claude-code",
    at: AT,
  });
  owner.admitTurn({
    turnId: "turn-3",
    attemptId: "0.0:build",
    session: "shared",
    origin: "managed",
    kind: "agent",
    input: "now build it",
    recoveryCoordinate: "native-1",
    harness: "claude-code",
    at: AT,
  });
  assert.deepEqual(
    owner.turns().map((turn) => turn.kind),
    ["interactive-agent", "interactive-agent", "agent"],
  );

  // A legacy row admitted before the kind column existed (a raw INSERT that omits
  // `kind`, so it is NULL) reads its kind back undefined — genuinely unknown, never
  // fabricated to a guess.
  const runDb = new Database(join(groupDirOf(home), created.runId, "run.db"));
  try {
    runDb
      .query(
        `INSERT INTO turn
           (turn_id, attempt_id, session_key, origin, sequence, input, admitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "turn-legacy",
        "legacy",
        "shared",
        "managed",
        3,
        "old turn",
        AT.toISOString(),
      );
  } finally {
    runDb.close();
  }
  const legacy = owner.turns().find((turn) => turn.turnId === "turn-legacy");
  assert.ok(legacy !== undefined);
  assert.equal(legacy.kind, undefined);
});

test("an Agent Attempt's pre-change `#turn` row and later Turns read back unchanged, in order (#352)", (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  // A Run written before #352 holds its Agent Turn under the one-per-Attempt id
  // (`#turn`); the raw INSERT is that row exactly as the old executor admitted it.
  // Later Turns joining the same Attempt take the per-Turn ids.
  const runDb = new Database(join(groupDirOf(home), created.runId, "run.db"));
  try {
    runDb
      .query(
        `INSERT INTO turn
           (turn_id, attempt_id, session_key, origin, kind, sequence, input,
            admitted_at, result_kind, result_detail, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "0.0:build#turn",
        "0.0:build",
        "shared",
        "managed",
        "agent",
        0,
        "Build it.",
        AT.toISOString(),
        "lost",
        '{"kind":"lost","unknown":"completion"}',
        AT.toISOString(),
      );
  } finally {
    runDb.close();
  }
  for (const [turnId, input] of [
    ["0.0:build#turn-2", "Build it."],
    ["0.0:build#turn-3", "Carry on."],
  ] as const) {
    assert.deepEqual(
      owner.admitTurn({
        turnId,
        attemptId: "0.0:build",
        session: "shared",
        origin: "managed",
        kind: "agent",
        input,
        recoveryCoordinate: "native-1",
        harness: "claude-code",
        at: AT,
      }),
      { ok: true },
    );
  }

  const turns = owner.turns();
  assert.deepEqual(turns[0], {
    turnId: "0.0:build#turn",
    attemptId: "0.0:build",
    session: "shared",
    origin: "managed",
    kind: "agent",
    sequence: 0,
    input: "Build it.",
    admittedAt: AT.toISOString(),
    resultKind: "lost",
    resultDetail: '{"kind":"lost","unknown":"completion"}',
    settledAt: AT.toISOString(),
  });
  assert.deepEqual(
    turns.map((turn) => [turn.turnId, turn.attemptId, turn.sequence]),
    [
      ["0.0:build#turn", "0.0:build", 0],
      ["0.0:build#turn-2", "0.0:build", 1],
      ["0.0:build#turn-3", "0.0:build", 2],
    ],
  );
});

test("each Turn records the Model choice it requested at admission, and none reads absent (ADR 0034)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  const admit = (
    turnId: string,
    modelChoice?: AdmitTurnRequest["modelChoice"],
  ) =>
    owner.admitTurn({
      turnId,
      attemptId: "0.0:build",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "build it",
      recoveryCoordinate: "native-1",
      harness: "codex",
      at: AT,
      ...(modelChoice !== undefined ? { modelChoice } : {}),
    });
  assert.ok(admit("turn-1", { model: "gpt-5.6-sol", effort: "high" }).ok);
  assert.ok(admit("turn-2", { model: "gpt-6-astra" }).ok);
  assert.ok(admit("turn-3").ok);
  // The settled result never rewrites the request recorded at admission.
  owner.settleTurn({
    turnId: "turn-1",
    session: "s",
    resultKind: "completed",
    resultDetail: JSON.stringify({ kind: "completed" }),
    availability: "open",
    at: AT,
  });
  assert.deepEqual(
    owner.turns().map((turn) => [turn.turnId, turn.modelChoice]),
    [
      ["turn-1", { model: "gpt-5.6-sol", effort: "high" }],
      ["turn-2", { model: "gpt-6-astra" }],
      ["turn-3", undefined],
    ],
  );

  // A row admitted before the request columns existed (a raw INSERT that omits
  // them) reads back with no request, never a guessed one.
  const runDb = new Database(join(groupDirOf(home), created.runId, "run.db"));
  try {
    runDb
      .query(
        `INSERT INTO turn
           (turn_id, attempt_id, session_key, origin, kind, sequence, input, admitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "turn-legacy",
        "legacy",
        "s",
        "managed",
        "agent",
        3,
        "old turn",
        AT.toISOString(),
      );
  } finally {
    runDb.close();
  }
  const legacy = owner.turns().find((turn) => turn.turnId === "turn-legacy");
  assert.ok(legacy !== undefined);
  assert.equal("modelChoice" in legacy, false);
});

test("transcriptPage reads bounded, ordered pages and flags older history (#124)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  // Seed five user turns in one Session, and one in a second Session that must
  // never leak into the first Session's page.
  for (let i = 0; i < 5; i++) {
    owner.admitTurn({
      turnId: `t-${i}`,
      attemptId: "0.0:write",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: `input ${i}`,
      recoveryCoordinate: "native-abc",
      harness: "claude-code",
      at: AT,
    });
  }
  owner.admitTurn({
    turnId: "other",
    attemptId: "0.0:write",
    session: "other",
    origin: "managed",
    kind: "agent",
    input: "elsewhere",
    recoveryCoordinate: "native-xyz",
    harness: "claude-code",
    at: AT,
  });

  // The newest page is bounded, oldest-first within the page, and flags older.
  const newest = owner.transcriptPage({
    cutoff: owner.transcriptCutoff(),
    session: "s",
    limit: 2,
  });
  assert.deepEqual(
    newest.entries.map((e) => e.content),
    ["input 3", "input 4"],
  );
  assert.equal(newest.hasOlder, true);

  // Paging upward with the oldest entry's seq walks older entries in order.
  const older = owner.transcriptPage({
    cutoff: owner.transcriptCutoff(),
    session: "s",
    before: newest.entries[0]!.order,
    limit: 2,
  });
  assert.deepEqual(
    older.entries.map((e) => e.content),
    ["input 1", "input 2"],
  );
  assert.equal(older.hasOlder, true);

  // The final page has no older history and is not padded.
  const final = owner.transcriptPage({
    cutoff: owner.transcriptCutoff(),
    session: "s",
    before: older.entries[0]!.order,
    limit: 2,
  });
  assert.deepEqual(
    final.entries.map((e) => e.content),
    ["input 0"],
  );
  assert.equal(final.hasOlder, false);

  // A non-positive limit is clamped to one entry so the page always carries a
  // cursor, rather than reporting older history over an empty page (A11). At HEAD
  // this returned `{ entries: [], hasOlder: true }`, which a pager cannot advance.
  const clamped = owner.transcriptPage({
    cutoff: owner.transcriptCutoff(),
    session: "s",
    limit: 0,
  });
  assert.deepEqual(
    clamped.entries.map((e) => e.content),
    ["input 4"],
  );
  assert.equal(clamped.hasOlder, true);

  // An empty Session pages to nothing without throwing.
  assert.deepEqual(
    owner.transcriptPage({
      cutoff: owner.transcriptCutoff(),
      session: "missing",
      limit: 2,
    }),
    {
      entries: [],
      hasOlder: false,
    },
  );
});

test("current Turn reads only the first unsettled semantic target", (t) => {
  const home = makeTempDir("secant-current-turn-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "current-turn");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.equal(owner.currentTurn(), undefined);
  for (const turnId of ["history", "first-live", "second-live"]) {
    assert.ok(
      owner.admitTurn({
        turnId,
        attemptId: "0.0:write",
        session: "s",
        origin: "managed",
        kind: "agent",
        input: "input",
        recoveryCoordinate: "native",
        harness: "claude-code",
        at: AT,
      }).ok,
    );
  }
  const settle = (turnId: string) => {
    assert.ok(
      owner.settleTurn({
        turnId,
        session: "s",
        resultKind: "completed",
        resultDetail: "{}",
        availability: "open",
        at: AT,
      }).ok,
    );
  };
  settle("history");
  // Retained history is not an input to the current-Turn read. A malformed
  // historical payload would fail the full Turn-history parser.
  const database = new Database(
    join(groupDirOf(home), created.runId, "run.db"),
  );
  database.exec("UPDATE turn SET input = x'00' WHERE turn_id = 'history'");
  database.close();
  assert.deepEqual(owner.currentTurn(), { turnId: "first-live" });
  settle("first-live");
  assert.deepEqual(owner.currentTurn(), { turnId: "second-live" });
  settle("second-live");
  assert.equal(owner.currentTurn(), undefined);
});

test("m10-interruption-and-transcript: each settled message and delivered Steer is one canonical row with exact metadata", (t) => {
  const group = openRunGroup(makeTempDir("secant-messages-"), WORKSPACE);
  t.after(() => group.close());
  const owner = group.acquireRun(create(group, "messages").runId);
  assert.ok(owner);
  t.after(() => owner.close());
  owner.admitTurn({
    turnId: "entry",
    attemptId: "0.0:discuss",
    session: "s",
    origin: "managed",
    kind: "interactive-agent",
    input: "Entry prompt",
    recoveryCoordinate: "native",
    harness: "claude-code",
    at: AT,
  });
  const append = <K extends TurnFact["kind"]>(
    kind: K,
    payload: TurnFactData<K>,
  ) =>
    owner.appendTurnEvent({
      turnId: "entry",
      fact: turnFact(kind, payload),
      at: AT,
    });
  append("assistant-content", { messageId: "first", content: "First message" });
  append("assistant-content", {
    messageId: "first",
    content: "Duplicate must not replace it",
  });
  append("assistant-content", { messageId: "second", content: "" });
  append("assistant-content", {
    content: "Unqualified identity is not conversation",
  });
  for (const delivery of [
    "within-turn",
    "after-boundary",
    "re-delivered",
  ] as const) {
    append("steer", {
      steerId: delivery,
      text: `Steer ${delivery}`,
      sentAt: AT.toISOString(),
      settlement: { kind: "delivered", delivery },
    });
  }
  append("steer", {
    steerId: "dropped",
    text: "Do not show",
    sentAt: AT.toISOString(),
    settlement: { kind: "dropped", reason: "interrupt" },
  });
  append("assistant-content", {
    messageId: "partial",
    content: "Known partial",
    incomplete: true,
  });
  owner.settleTurn({
    turnId: "entry",
    session: "s",
    resultKind: "interrupted",
    resultDetail: "{}",
    availability: "open",
    at: AT,
  });
  const transcript = owner.transcript();
  assert.deepEqual(
    transcript.map((e) => [
      e.role,
      e.content,
      e.kind,
      e.turn,
      e.steer,
      e.incomplete,
    ]),
    [
      ["user", "Entry prompt", "entry-prompt", "entry", undefined, undefined],
      ["assistant", "First message", "message", "entry", undefined, undefined],
      ["assistant", "", "message", "entry", undefined, undefined],
      ...["within-turn", "after-boundary", "re-delivered"].map((delivery) => [
        "user",
        `Steer ${delivery}`,
        "steer",
        "entry",
        { id: delivery, delivery },
        undefined,
      ]),
      ["assistant", "Known partial", "message", "entry", undefined, true],
    ],
  );
  assert.equal(
    owner.turnEvents().filter((e) => e.kind === "steer").length,
    4,
    "all delivery states remain history facts",
  );
  assert.equal(
    owner.turnEvents().filter((e) => e.kind === "assistant-content").length,
    4,
    "settlement adds no final copy",
  );
});

test("m10-interruption-and-transcript: tool starts and observed settlements survive crash reconciliation without fabricated results or transcript entries", (t) => {
  const home = makeTempDir("secant-tool-crash-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "tool-crash");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  assert.ok(owner.writeState("running").ok);
  assert.ok(
    owner.admitTurn({
      turnId: "turn",
      attemptId: "0.0:write",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "Prompt",
      recoveryCoordinate: "private",
      harness: "codex",
      at: AT,
    }).ok,
  );
  const append = (
    callId: string,
    historyOrder: number,
    outcome: ToolCall["outcome"],
  ) =>
    owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "tool-call",
        data: {
          callId,
          parentCallId: "private-parent",
          tool: "read",
          input: "file",
          historyOrder,
          outcome,
        },
      },
      at: AT,
    });
  append("settled", 2, { kind: "running" });
  append("unmatched", 3, { kind: "running" });
  append("settled", 99, { kind: "completed" });
  // Repeated starts and contradictory late results cannot rewrite observed truth.
  append("settled", 100, { kind: "running" });
  append("settled", 100, { kind: "failed", error: "late" });
  const events = owner
    .turnEvents()
    .filter((event) => event.kind === "tool-call");
  assert.equal(events.length, 3);
  assert.equal(JSON.parse(events[2]!.payload).historyOrder, 2);
  assert.equal(JSON.parse(events[2]!.payload).parentCallId, "private-parent");
  assert.deepEqual(
    owner.transcript().map((entry) => entry.content),
    ["Prompt"],
  );
  owner.close();
  group.close();
  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const recovered = reopened.acquireRun(created.runId);
  assert.ok(recovered);
  t.after(() => recovered.close());
  assert.equal(recovered.turns()[0]?.resultKind, "lost");
  assert.deepEqual(
    recovered.turnEvents().filter((event) => event.kind === "tool-call"),
    events,
  );
  assert.deepEqual(
    recovered.transcript().map((entry) => entry.content),
    ["Prompt"],
  );
});

test("m10-session-history: validated supplied patches and Turn diffs survive crash with immutable identity/order and no transcript positions", (t) => {
  const home = makeTempDir("secant-file-facts-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "file-facts");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  owner.writeState("running");
  for (const [turnId, session] of [
    ["first", "s"],
    ["second", "other"],
  ]) {
    assert.ok(turnId && session);
    owner.admitTurn({
      turnId,
      session,
      attemptId: "0.0:edit",
      origin: "human",
      kind: "interactive-agent",
      input: "Input",
      recoveryCoordinate: "private",
      harness: "codex",
      at: AT,
    });
  }
  const files: ToolCall["files"] = [
    {
      path: "observed.ts",
      kind: "update",
      patch: {
        kind: "structured",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new" + " full patch".repeat(4000)],
          },
        ],
      },
      additions: 0,
    },
  ];
  const append = (
    turnId: string,
    outcome: ToolCall["outcome"],
    historyOrder: number,
    facts?: ToolCall["files"],
  ) =>
    owner.appendTurnEvent({
      turnId,
      fact: {
        kind: "tool-call",
        data: {
          callId: "reused",
          tool: "file-change",
          input: "requested.ts",
          outcome,
          historyOrder,
          ...(facts === undefined ? {} : { files: facts }),
        },
      },
      at: AT,
    });
  append("first", { kind: "running" }, 2);
  append("second", { kind: "running" }, 1);
  assert.equal(
    append("first", { kind: "completed" }, 99, [
      { path: "bad.ts", additions: -1 },
    ]).ok,
    false,
  );
  append("first", { kind: "completed" }, 99, files);
  const diff = {
    files: [{ path: "cumulative.ts" }],
    content: "Cumulative patch".repeat(3000),
    historyOrder: 3,
  };
  assert.equal(
    owner.appendTurnEvent({
      turnId: "first",
      // A malformed diff, as an unchecked caller would send it.
      fact: { kind: "turn-diff", data: { files: [], content: 7 } as never },
      at: AT,
    }).ok,
    false,
  );
  owner.appendTurnEvent({
    turnId: "first",
    fact: { kind: "turn-diff", data: diff },
    at: AT,
  });
  owner.appendTurnEvent({
    turnId: "first",
    fact: { kind: "turn-diff", data: { files: [], content: "late" } },
    at: AT,
  });
  const events = owner.turnEvents();
  const terminal = events.filter((event) => event.kind === "tool-call").at(-1);
  assert.ok(terminal);
  assert.deepEqual(JSON.parse(terminal.payload), {
    callId: "reused",
    tool: "file-change",
    input: "requested.ts",
    outcome: { kind: "completed" },
    historyOrder: 2,
    files,
  });
  assert.deepEqual(
    events
      .filter((event) => event.kind === "turn-diff")
      .map((event) => JSON.parse(event.payload)),
    [diff],
  );
  assert.deepEqual(
    owner.transcript().map((entry) => entry.content),
    ["Input", "Input"],
  );
  owner.close();
  group.close();
  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const recovered = reopened.acquireRun(created.runId);
  assert.ok(recovered);
  t.after(() => recovered.close());
  assert.deepEqual(
    recovered.turns().map((turn) => turn.resultKind),
    ["lost", "lost"],
  );
  assert.deepEqual(recovered.turnEvents(), events);
  assert.deepEqual(
    recovered.transcript().map((entry) => entry.content),
    ["Input", "Input"],
  );
});

test("m10-interruption-and-transcript: admitted command partials retain bounded output and first appearance on reopen without settling the tool", (t) => {
  const home = makeTempDir("secant-command-partial-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "command-partial");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  owner.admitTurn({
    turnId: "turn",
    attemptId: "0.0:write",
    session: "s",
    origin: "managed",
    kind: "agent",
    input: "Prompt",
    recoveryCoordinate: "private",
    harness: "codex",
    at: AT,
  });
  const call = {
    callId: "command",
    tool: "command",
    input: "build",
    cwd: WORKSPACE,
    outcome: { kind: "running" },
    historyOrder: 2,
  } as const;
  owner.appendTurnEvent({
    turnId: "turn",
    fact: { kind: "tool-call", data: call },
    at: AT,
  });
  const partial = {
    ...call,
    historyOrder: 99,
    output: { text: "OLD" + "x".repeat(30_000), incomplete: true },
    nativeOmission: "Harness omitted stdout",
  } as const;
  for (let i = 0; i < 2; i++)
    owner.appendTurnEvent({
      turnId: "turn",
      fact: { kind: "tool-partial", data: partial },
      at: AT,
    });
  const retained = owner
    .turnEvents()
    .filter((event) => event.kind === "tool-partial");
  assert.equal(retained.length, 1);
  assert.deepEqual(JSON.parse(retained[0]!.payload), {
    ...call,
    output: { text: "x".repeat(30_000), incomplete: true, secantDropped: true },
    nativeOmission: "Harness omitted stdout",
  });
  owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "interrupted",
    resultDetail: "{}",
    availability: "open",
    at: AT,
  });
  assert.deepEqual(
    owner.transcript().map((entry) => entry.content),
    ["Prompt"],
  );
  owner.close();
  group.close();
  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const recovered = reopened.acquireRun(created.runId);
  assert.ok(recovered);
  t.after(() => recovered.close());
  assert.deepEqual(
    recovered.turnEvents().filter((event) => event.kind === "tool-partial"),
    retained,
  );
  assert.equal(recovered.turns()[0]?.resultKind, "interrupted");
});

for (const size of [29_999, 30_000, 30_001])
  test(`m10-interruption-and-transcript: stored final command output retains exactly the ${size} character boundary with separate markers`, (t) => {
    const group = openRunGroup(makeTempDir("secant-final-tail-"), WORKSPACE);
    t.after(() => group.close());
    const created = create(group, "final-tail");
    const owner = group.acquireRun(created.runId);
    assert.ok(owner);
    t.after(() => owner.close());
    owner.admitTurn({
      turnId: "turn",
      attemptId: "0.0:write",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "Prompt",
      recoveryCoordinate: "private",
      harness: "codex",
      at: AT,
    });
    const call = {
      callId: "call",
      tool: "command",
      input: "build",
      outcome: { kind: "completed" },
      output: { text: "a".repeat(size - 1) + "Z" },
      exitCode: 0,
      nativeOmission: "reported native omission",
    } as const;
    owner.appendTurnEvent({
      turnId: "turn",
      fact: { kind: "tool-call", data: call },
      at: AT,
    });
    const event = owner
      .turnEvents()
      .find((event) => event.kind === "tool-call");
    assert.ok(event);
    assert.deepEqual(JSON.parse(event.payload), {
      ...call,
      output: {
        text: size > 30_000 ? "a".repeat(29_999) + "Z" : call.output.text,
        ...(size > 30_000 ? { secantDropped: true } : {}),
      },
    });
  });

test("m10-audit-turn-event-refusal: invalid facts and a storage fault refuse atomically, then the Turn settles", (t) => {
  const home = makeTempDir("secant-refusal-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-refusal");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.ok(
    owner.admitTurn({
      turnId: "turn",
      attemptId: "attempt",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "Work",
      recoveryCoordinate: "native",
      harness: "claude-code",
      at: AT,
    }).ok,
  );
  for (const call of [
    {
      callId: "",
      tool: "file-change",
      input: "requested.ts",
      outcome: { kind: "completed" },
    },
    {
      callId: "path",
      tool: "file-change",
      input: "requested.ts",
      outcome: { kind: "completed" },
      files: [{ path: "" }],
    },
    {
      callId: "count",
      tool: "file-change",
      input: "requested.ts",
      outcome: { kind: "completed" },
      files: [{ path: "x", additions: -1 }],
    },
    {
      callId: "count-value",
      tool: "search",
      input: "query",
      outcome: { kind: "completed" },
      count: { value: -1, unit: "matches" },
    },
    {
      callId: "exit",
      tool: "command",
      input: "true",
      outcome: { kind: "completed" },
      exitCode: 0.5,
    },
  ] satisfies ToolCall[]) {
    const result = owner.appendTurnEvent({
      turnId: "turn",
      fact: { kind: "tool-call", data: call },
      at: AT,
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("invalid fact was recorded");
    assert.equal(result.reason, "unrecordable");
    assert.deepEqual(owner.turnEvents(), []);
  }
  const malformed = owner.appendTurnEvent({
    turnId: "turn",
    // Data that does not match its kind, as an unchecked caller would send it.
    fact: { kind: "thought", data: "private_turn_text_432" as never },
    at: AT,
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok && malformed.reason === "unrecordable") {
    assert.ok(malformed.cause instanceof Error);
    assert.deepEqual(malformed.safeCause, {
      type: "ZodError",
      message: "Turn event fact does not match its kind's schema.",
    });
    assert.equal(
      JSON.stringify(malformed.safeCause).includes("private_turn_text_432"),
      false,
    );
  }
  const database = new Database(
    join(groupDirOf(home), created.runId, "run.db"),
  );
  t.after(() => database.close());
  database.exec(
    "CREATE TRIGGER refuse_event BEFORE INSERT ON turn_event BEGIN SELECT RAISE(ABORT, 'injected append fault'); END",
  );
  const fault = owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "assistant-content",
      data: { messageId: "failed", content: "Missing" },
    },
    at: AT,
  });
  assert.equal(fault.ok, false);
  if (fault.ok) assert.fail("faulted append was recorded");
  assert.equal(fault.reason, "unrecordable");
  if (fault.reason === "unrecordable") assert.ok(fault.cause instanceof Error);
  assert.deepEqual(owner.turnEvents(), []);
  assert.deepEqual(
    owner.transcript().map((entry) => entry.content),
    ["Work"],
  );
  database.exec("DROP TRIGGER refuse_event");
  assert.ok(
    owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "assistant-content",
        data: { messageId: "later", content: "Later" },
      },
      at: AT,
    }).ok,
  );
  assert.ok(
    owner.settleTurn({
      turnId: "turn",
      session: "s",
      resultKind: "completed",
      resultDetail: "{}",
      availability: "open",
      at: AT,
    }).ok,
  );
  assert.equal(owner.turns()[0]?.resultKind, "completed");
  assert.deepEqual(
    owner.transcript().map((entry) => entry.content),
    ["Work", "Later"],
  );
});

test("m10-followup-typed-turn-facts: every malformed or unknown Turn fact is refused as unrecordable and stores nothing", (t) => {
  const group = openRunGroup(makeTempDir("secant-typed-facts-"), WORKSPACE);
  t.after(() => group.close());
  const owner = group.acquireRun(create(group, "op-typed-facts").runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.ok(
    owner.admitTurn({
      turnId: "turn",
      attemptId: "attempt",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "Work",
      recoveryCoordinate: "native",
      harness: "codex",
      at: AT,
    }).ok,
  );
  // Each fact reaches the Store only through a cast, as an unchecked caller would.
  const malformed = [
    { kind: "model", data: { model: "" } },
    { kind: "agent-call", data: { callId: "call", id: "next" } },
    { kind: "request-raised", data: { tool: "shell" } },
    { kind: "assistant-content", data: { content: 5, messageId: "m" } },
    {
      kind: "tool-partial",
      data: {
        callId: "settled-partial",
        tool: "command",
        input: "build",
        outcome: { kind: "completed" },
        output: { text: "tail", incomplete: true },
      },
    },
    { kind: "invented", data: { content: "private_turn_text_512" } },
  ] as unknown as readonly TurnFact[];
  for (const fact of malformed) {
    const result = owner.appendTurnEvent({ turnId: "turn", fact, at: AT });
    assert.ok(!result.ok, fact.kind);
    assert.equal(result.reason, "unrecordable", fact.kind);
    if (result.reason === "unrecordable")
      assert.equal(
        JSON.stringify(result.safeCause).includes("private_turn_text_512"),
        false,
      );
    assert.deepEqual(owner.turnEvents(), [], fact.kind);
  }
  assert.deepEqual(
    owner.transcript().map((entry) => entry.content),
    ["Work"],
  );
  // A stamped order is checked with the fact it orders.
  const stamped = owner.appendTurnEvent({
    turnId: "turn",
    fact: { kind: "model", data: { model: "gpt-5" } },
    historyOrder: -1,
    at: AT,
  });
  assert.ok(!stamped.ok);
  assert.equal(stamped.reason, "unrecordable");
  assert.deepEqual(owner.turnEvents(), []);
  // A well-formed fact of each kind is stored as the value it was checked to be.
  assert.ok(
    owner.appendTurnEvent({
      turnId: "turn",
      fact: { kind: "model", data: { model: "gpt-5", effort: "high" } },
      historyOrder: 3,
      at: AT,
    }).ok,
  );
  assert.deepEqual(
    owner.turnEvents().map((event) => [event.kind, JSON.parse(event.payload)]),
    [["model", { model: "gpt-5", effort: "high", historyOrder: 3 }]],
  );
});

test("m10-followup-typed-turn-facts: one well-formed fact of every stored kind reads back as written", (t) => {
  const group = openRunGroup(makeTempDir("secant-typed-kinds-"), WORKSPACE);
  t.after(() => group.close());
  const owner = group.acquireRun(create(group, "op-typed-kinds").runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.ok(
    owner.admitTurn({
      turnId: "turn",
      attemptId: "attempt",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "Work",
      recoveryCoordinate: "native",
      harness: "codex",
      at: AT,
    }).ok,
  );
  const call = {
    callId: "call",
    tool: "command",
    input: "build",
    outcome: { kind: "running" },
  } as const;
  const facts = {
    "assistant-content": { messageId: "m", content: "Reply" },
    thought: { summaryId: "t", content: "Thinking", durationMs: 4 },
    "turn-diff": { content: "+line", files: [{ path: "a.ts" }] },
    "tool-call": call,
    "tool-partial": {
      ...call,
      callId: "partial",
      output: { text: "out", incomplete: true },
    },
    steer: {
      steerId: "s",
      text: "Steer",
      sentAt: AT.toISOString(),
      settlement: { kind: "waiting" },
    },
    model: { model: "gpt-5", effort: "high" },
    "agent-call": {
      callId: "agent",
      id: "step_done",
      reason: "Ready",
      answer: { outcome: "accepted" },
    },
    "agent-call-expired": { callId: "agent" },
    "tool-activity": { tool: "shell", summary: "ran" },
    "request-raised": {
      requestId: "r",
      tool: "shell",
      input: "ls",
      decisions: ["allow"],
    },
    "request-answered": { requestId: "r", by: "human", decision: "allow" },
    "request-expired": { requestId: "r" },
    "elicitation-declined": { harness: "codex", message: "Declined" },
  } satisfies { [K in TurnFact["kind"]]: TurnFactData<K> };
  const kinds = Object.keys(facts) as TurnFact["kind"][];
  for (const [order, kind] of kinds.entries())
    assert.ok(
      owner.appendTurnEvent({
        turnId: "turn",
        fact: turnFact(kind, facts[kind]),
        historyOrder: order,
        at: AT,
      }).ok,
      kind,
    );
  assert.deepEqual(
    owner.turnEvents().map((event) => readTurnFact(event)),
    kinds.map((kind, order) => ({
      kind,
      data: { ...facts[kind], historyOrder: order },
    })),
  );
});

function typedTurnFactWrites(owner: RunOwner): void {
  owner.appendTurnEvent({
    turnId: "turn",
    // @ts-expect-error A payload that does not match its kind does not compile.
    fact: { kind: "model", data: { content: "hello" } },
    at: AT,
  });
  owner.appendTurnEvent({
    turnId: "turn",
    // @ts-expect-error A kind outside the schema set does not compile.
    fact: { kind: "invented", data: {} },
    at: AT,
  });
}
void typedTurnFactWrites;

test("m10-audit-entry-prompt-kind: managed Turn inputs are Entry prompts independently of Step kind; human inputs remain messages", (t) => {
  const group = openRunGroup(makeTempDir("secant-entry-prompts-"), WORKSPACE);
  t.after(() => group.close());
  const runId = create(group, "entry-prompts").runId;
  const owner = group.acquireRun(runId);
  assert.ok(owner);
  t.after(() => owner.close());
  const inputs = [
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
  ] as const;
  for (const input of inputs) {
    assert.ok(
      owner.admitTurn({
        ...input,
        attemptId: "0.0:write",
        session: "s",
        recoveryCoordinate: "native",
        harness: "claude-code",
        at: AT,
      }).ok,
    );
  }
  const expected = [
    ["user", "entry-prompt", "Attempt prompt"],
    ["user", "entry-prompt", "Retry prompt"],
    ["user", "entry-prompt", "Re-sent prompt"],
    ["user", "entry-prompt", "Entry Turn prompt"],
    ["user", "message", "Human follow-up"],
    ["user", "message", "Human Turn"],
  ];
  assert.deepEqual(
    owner.transcript().map((e) => [e.role, e.kind, e.content]),
    expected,
  );
  owner.close();
  const reopened = group.acquireRun(runId);
  assert.ok(reopened);
  t.after(() => reopened.close());
  assert.deepEqual(
    reopened.transcript().map((e) => [e.role, e.kind, e.content]),
    expected,
  );
});

test("m10-audit-steer-stored-when-sent: Store rejects invalid waiting and settled Steers atomically", (t) => {
  const group = openRunGroup(
    makeTempDir("secant-steer-validation-"),
    WORKSPACE,
  );
  t.after(() => group.close());
  const created = create(group, "steer-validation");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.ok(
    owner.admitTurn({
      turnId: "turn",
      attemptId: "attempt",
      session: "s",
      origin: "human",
      kind: "agent",
      input: "Work",
      recoveryCoordinate: "native",
      harness: "codex",
      at: AT,
    }).ok,
  );
  for (const settlement of [
    { kind: "waiting" },
    { kind: "dropped", reason: "loss" },
    { kind: "delivered", delivery: "within-turn" },
  ] as const) {
    const result = owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "steer",
        data: {
          steerId: "",
          text: "Invalid Steer",
          sentAt: AT.toISOString(),
          settlement,
        },
      },
      at: AT,
    });
    assert.ok(!result.ok);
    assert.equal(result.reason, "unrecordable");
    assert.deepEqual(owner.turnEvents(), []);
    assert.deepEqual(
      owner.transcript().map((entry) => entry.content),
      ["Work"],
    );
  }
});

test("m10-audit-conversation-order: bounded Store reads separate eligibility from first appearance and filter the Session", (t) => {
  const group = openRunGroup(makeTempDir("secant-order-store-"), WORKSPACE);
  t.after(() => group.close());
  const owner = group.acquireRun(create(group, "order-store").runId);
  assert.ok(owner);
  t.after(() => owner.close());
  for (const [turnId, session] of [
    ["first", "s"],
    ["other", "other"],
    ["last", "s"],
  ] as const) {
    assert.ok(
      owner.admitTurn({
        turnId,
        session,
        attemptId: "0.0:write",
        origin: "human",
        kind: "agent",
        input: turnId,
        recoveryCoordinate: "native",
        harness: "codex",
        at: AT,
      }).ok,
    );
  }
  const append = (turnId: string, messageId: string, historyOrder: number) => {
    assert.ok(
      owner.appendTurnEvent({
        turnId,
        fact: {
          kind: "assistant-content",
          data: {
            messageId,
            content: messageId,
            historyOrder,
          },
        },
        at: AT,
      }).ok,
    );
  };
  append("first", "second", 2);
  append("first", "partial", 0);
  const cutoff = owner.transcriptCutoff();
  const newest = owner.transcriptPage({ session: "s", cutoff, limit: 2 });
  assert.deepEqual(
    newest.entries.map((e) => e.content),
    ["second", "last"],
  );
  assert.equal(newest.hasOlder, true);
  append("first", "late", 1);
  const older = owner.transcriptPage({
    session: "s",
    cutoff,
    before: newest.entries[0]!.order,
    limit: 2,
  });
  assert.deepEqual(
    older.entries.map((e) => e.content),
    ["first", "partial"],
  );
  assert.equal(older.hasOlder, false);
  assert.deepEqual(
    owner.transcriptPage({
      session: "s",
      cutoff,
      before: newest.entries[0]!.order,
      limit: 2,
    }),
    older,
  );
  const fresh = owner.transcriptPage({
    session: "s",
    cutoff: owner.transcriptCutoff(),
    limit: 20,
  });
  assert.deepEqual(
    fresh.entries.map((e) => e.content),
    ["first", "partial", "late", "second", "last"],
  );
  assert.deepEqual(
    fresh.entries.filter((e) => e.content !== "late").map((e) => e.seq),
    [1, 5, 4, 3],
    "eligibility positions and retained identity never renumber",
  );
});
