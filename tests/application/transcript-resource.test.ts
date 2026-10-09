import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import type { TurnFact } from "../../src/harness/harness.js";
import { turnFact, type TurnFactData } from "../helpers/turnFact.js";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  TRANSCRIPT_PAGE_SIZE,
} from "../../src/application/application.js";
import type {
  TranscriptExportReference,
  TranscriptPageReference,
} from "../../src/application/projection-port.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import type { RunGroup } from "../../src/run/store/store.js";
import { hostPlatform } from "../helpers/commandBundle.js";
import { openLiveRun } from "../helpers/liveRun.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openFakeRunGroup as openRunGroup } from "../run/store/fake-git-process.js";

const AT = new Date("2026-09-16T12:00:00.000Z");

// The transcript `page`/`export` Resource References (#124) resolved through the
// Projection Port: bounded ordered paging, the complete export, and normalized
// Problems for an unknown Run, Session, or cursor — never a native id or path.

// These tests seed Runs and Turns straight through the Run Store and never launch
// or execute a Step, so the injected Process is never exercised — but the source
// `createApplication` requires one. A fake Process satisfies it without any child
// spawn, and the faked Run Store Git keeps `admitTurn`/paging off real `git`.
const executionProcess = createFakeProcess({
  resolutionHandler: (name) => ({
    kind: "found",
    executable: name,
    prefixArgs: [],
  }),
  commandHandler: () => ({ kind: "exited", status: 0, text: new Uint8Array() }),
});

function fixture(t: TestContext) {
  const catalog = openCatalog(makeTempDir("secant-tx-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-tx-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-tx-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    process: executionProcess,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: () => {
      throw new Error("no execution in this test");
    },
  });
  return { app, runGroup };
}

/** Create a Run and seed `count` user Turns in one Session, plus one Turn in a
 *  second Session that must never leak into the first's page. */
function seedRun(
  runGroup: RunGroup,
  count: number,
  operationId = "op-1",
): string {
  const created = runGroup.createRun({
    operationId,
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: { goal: "ship it" },
    at: AT,
  });
  const owner = runGroup.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  for (let i = 0; i < count; i++) {
    owner.admitTurn({
      turnId: `t-${i}`,
      attemptId: "0.0:write",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: `input ${i}`,
      recoveryCoordinate: "native",
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
    recoveryCoordinate: "native",
    harness: "claude-code",
    at: AT,
  });
  owner.close();
  return created.runId;
}

/** The transcript references for Session s. The Projection advertises the same
 *  shapes (asserted against a real Bundle in run-projection.test.ts); here they
 *  are built directly so the resolution paths do not need an installed Bundle. */
function pageRef(_app: ReturnType<typeof fixture>["app"], runId: string) {
  const page: TranscriptPageReference = {
    runId,
    session: "s",
    type: "transcript-page",
  };
  const exportRef: TranscriptExportReference = {
    runId,
    session: "s",
    type: "transcript-export",
  };
  return { page, export: exportRef };
}

test("a Session's transcript pages newest-first and flags older history (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const total = TRANSCRIPT_PAGE_SIZE * 2 + 3;
  const runId = seedRun(runGroup, total);
  const refs = pageRef(app, runId);

  const newest = app.projectionPort.readTranscript(refs.page);
  assert.ok(newest.found && newest.type === "transcript-page");
  assert.equal(newest.entries.length, TRANSCRIPT_PAGE_SIZE);
  assert.equal(newest.entries.at(-1)?.content, `input ${total - 1}`);
  assert.ok(newest.older, "an older cursor when more entries remain");
  // No entry from the other Session leaks in.
  assert.ok(newest.entries.every((e) => e.session === "s"));

  const middle = app.projectionPort.readTranscript({
    ...refs.page,
    older: newest.older,
  } as TranscriptPageReference);
  assert.ok(middle.found && middle.type === "transcript-page");
  assert.equal(middle.entries.length, TRANSCRIPT_PAGE_SIZE);
  assert.ok(middle.older);

  const final = app.projectionPort.readTranscript({
    ...refs.page,
    older: middle.older,
  } as TranscriptPageReference);
  assert.ok(final.found && final.type === "transcript-page");
  assert.equal(final.entries.length, 3);
  assert.equal(final.entries[0]?.content, "input 0");
  assert.equal(final.older, undefined, "no cursor on the final page");
});

test("a single-page transcript carries no older cursor (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 2);
  const refs = pageRef(app, runId);
  const page = app.projectionPort.readTranscript(refs.page);
  assert.ok(page.found && page.type === "transcript-page");
  assert.equal(page.entries.length, 2);
  assert.equal(page.older, undefined);
});

test("the export carries the complete retained transcript (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const total = TRANSCRIPT_PAGE_SIZE + 5;
  const runId = seedRun(runGroup, total);
  const refs = pageRef(app, runId);
  const read = app.projectionPort.readTranscript(refs.export);
  assert.ok(read.found && read.type === "transcript-export");
  assert.equal(read.entries.length, total);
  assert.equal(read.entries[0]?.content, "input 0");
  assert.equal(read.entries.at(-1)?.content, `input ${total - 1}`);
});

test("an invalid cursor is a normalized Problem, not a wrong page (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 3);
  const refs = pageRef(app, runId);
  const read = app.projectionPort.readTranscript({
    ...refs.page,
    older: "not-a-real-cursor",
  } as TranscriptPageReference);
  assert.ok(!read.found);
  assert.equal(read.problem.code, "run-transcript-cursor-invalid");

  // A well-formed but non-positive sequence is still a forged cursor, not an
  // empty page — store sequences are always positive.
  const negative = Buffer.from(JSON.stringify(-5)).toString("base64url");
  const bad = app.projectionPort.readTranscript({
    ...refs.page,
    older: negative,
  } as TranscriptPageReference);
  assert.ok(!bad.found);
  assert.equal(bad.problem.code, "run-transcript-cursor-invalid");
});

test("an unknown Session is a normalized Problem (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 3);
  const read = app.projectionPort.readTranscript({
    runId,
    session: "ghost",
    type: "transcript-page",
  });
  assert.ok(!read.found);
  assert.equal(read.problem.code, "run-session-not-found");
});

test("an unknown Run is a normalized Problem (#124)", (t) => {
  const { app } = fixture(t);
  const read = app.projectionPort.readTranscript({
    runId: "no-such-run",
    session: "s",
    type: "transcript-page",
  });
  assert.ok(!read.found);
});

test("a reopened Run still resolves transcript references (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 4);
  const refs = pageRef(app, runId);
  // Two independent reads acquire-and-close the rested Run each time.
  const first = app.projectionPort.readTranscript(refs.page);
  const second = app.projectionPort.readTranscript(refs.page);
  assert.ok(first.found && first.type === "transcript-page");
  assert.ok(second.found && second.type === "transcript-page");
  assert.deepEqual(
    first.entries.map((e) => e.content),
    second.entries.map((e) => e.content),
  );
});

test("m10-interruption-and-transcript: retained entry identity survives repeat reads, prepend, reopen and later append", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 43);
  const refs = pageRef(app, runId);
  const page = app.projectionPort.readTranscript(refs.page);
  assert.ok(page.found && page.type === "transcript-page" && page.older);
  const older = app.projectionPort.readTranscript({
    ...refs.page,
    older: page.older,
  });
  assert.ok(older.found);
  const exported = app.projectionPort.readTranscript(refs.export);
  assert.ok(exported.found);
  assert.equal(new Set(exported.entries.map((e) => e.id)).size, 43);
  assert.ok(exported.entries.every((e) => e.id.length > 20 && e.id !== e.turn));
  const retainedIds = new Map(exported.entries.map((e) => [e.content, e.id]));
  for (const e of [...older.entries, ...page.entries])
    assert.equal(e.id, retainedIds.get(e.content));
  const owner = runGroup.acquireRun(runId);
  assert.ok(owner);
  owner.admitTurn({
    turnId: "later",
    attemptId: "0.0:write",
    session: "s",
    origin: "human",
    kind: "agent",
    input: "later",
    recoveryCoordinate: "native",
    harness: "claude-code",
    at: AT,
  });
  owner.close();
  assert.deepEqual(
    app.projectionPort.readTranscript({ ...refs.page, older: page.older }),
    older,
  );
  const reread = app.projectionPort.readTranscript(refs.export);
  assert.ok(reread.found);
  for (const e of reread.entries.slice(0, 43))
    assert.equal(e.id, retainedIds.get(e.content));
});

test("m10-audit-conversation-order: first appearances, interrupted text and late Steers agree across history, transcript and export", async (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 1);
  const owner = runGroup.acquireRun(runId);
  assert.ok(owner);
  const append = <K extends TurnFact["kind"]>(
    kind: K,
    payload: TurnFactData<K>,
  ) => {
    assert.ok(
      owner.appendTurnEvent({
        turnId: "t-0",
        fact: turnFact(kind, payload),
        at: AT,
      }).ok,
    );
  };
  append("steer", {
    steerId: "late",
    text: "Sent early",
    sentAt: AT.toISOString(),
    historyOrder: 1,
    settlement: { kind: "waiting" },
  });
  append("assistant-content", {
    messageId: "second",
    content: "Settled first",
    historyOrder: 3,
  });
  append("assistant-content", {
    messageId: "first",
    content: "Interrupted partial",
    historyOrder: 0,
    incomplete: true,
  });
  append("steer", {
    steerId: "late",
    text: "Sent early",
    sentAt: AT.toISOString(),
    historyOrder: 1,
    settlement: { kind: "delivered", delivery: "within-turn" },
  });
  append("steer", {
    steerId: "waiting",
    text: "Not delivered",
    sentAt: AT.toISOString(),
    historyOrder: 4,
    settlement: { kind: "waiting" },
  });
  owner.close();
  const refs = pageRef(app, runId);
  const expected = [
    "input 0",
    "Interrupted partial",
    "Sent early",
    "Settled first",
  ];
  for (const ref of [refs.page, refs.export]) {
    const read = app.projectionPort.readTranscript(ref);
    assert.ok(read.found);
    assert.deepEqual(
      read.entries.map((e) => e.content),
      expected,
    );
    assert.equal(read.entries[1]?.incomplete, true);
  }
  const history = app.projectionPort.openProjection({
    family: "session-history",
    runId,
    session: "s",
  });
  assert.ok(history.snapshot.result.found);
  assert.deepEqual(
    history.snapshot.result.history.rows.flatMap((row) =>
      row.value.kind === "message" ||
      row.value.kind === "entry-prompt" ||
      (row.value.kind === "steer" && row.value.delivery !== "waiting")
        ? [row.value.content]
        : [],
    ),
    expected,
  );
  history.close();
  await app.shutdown();
});

test("m10-audit-conversation-order: one cutoff excludes late settlements inside read ranges and older ranges, while reopen and export include them in place", async (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 43);
  const refs = pageRef(app, runId);
  const newest = app.projectionPort.readTranscript(refs.page);
  assert.ok(newest.found && newest.type === "transcript-page" && newest.older);
  const olderRef = { ...refs.page, older: newest.older };
  const middle = app.projectionPort.readTranscript(olderRef);
  assert.ok(middle.found && middle.type === "transcript-page" && middle.older);
  const owner = runGroup.acquireRun(runId);
  assert.ok(owner);
  for (const n of [3, 10, 30]) {
    assert.ok(
      owner.appendTurnEvent({
        turnId: `t-${n}`,
        fact: {
          kind: "assistant-content",
          data: {
            messageId: "late",
            content: `reply ${n}`,
            historyOrder: 0,
          },
        },
        at: AT,
      }).ok,
    );
  }
  assert.ok(
    owner.admitTurn({
      turnId: "append",
      attemptId: "0.0:write",
      session: "s",
      origin: "human",
      kind: "agent",
      input: "later input",
      recoveryCoordinate: "native",
      harness: "claude-code",
      at: AT,
    }).ok,
  );
  owner.close();
  assert.deepEqual(app.projectionPort.readTranscript(olderRef), middle);
  const oldest = app.projectionPort.readTranscript({
    ...refs.page,
    older: middle.older,
  });
  assert.ok(oldest.found && oldest.type === "transcript-page");
  assert.deepEqual(
    [...oldest.entries, ...middle.entries, ...newest.entries].map(
      (e) => e.content,
    ),
    Array.from({ length: 43 }, (_, n) => `input ${n}`),
  );
  assert.equal(
    new Set(
      [...oldest.entries, ...middle.entries, ...newest.entries].map(
        (e) => e.id,
      ),
    ).size,
    43,
  );
  const exported = app.projectionPort.readTranscript(refs.export);
  assert.ok(exported.found);
  const expected: string[] = [];
  for (let n = 0; n < 43; n++) {
    expected.push(`input ${n}`);
    if ([3, 10, 30].includes(n)) expected.push(`reply ${n}`);
  }
  expected.push("later input");
  assert.deepEqual(
    exported.entries.map((e) => e.content),
    expected,
  );
  const reopened = app.projectionPort.readTranscript(refs.page);
  assert.ok(reopened.found && reopened.type === "transcript-page");
  assert.deepEqual(
    reopened.entries.map((e) => e.content),
    expected.slice(-20),
  );
  const ids = new Map(exported.entries.map((e) => [e.content, e.id]));
  for (const e of [...oldest.entries, ...middle.entries, ...newest.entries])
    assert.equal(e.id, ids.get(e.content));
  await app.shutdown();
});

for (const total of [20, 21])
  test(`m10-audit-conversation-order: exact ${total}-entry traversal boundary`, async (t) => {
    const { app, runGroup } = fixture(t);
    const runId = seedRun(runGroup, total);
    const refs = pageRef(app, runId);
    const page = app.projectionPort.readTranscript(refs.page);
    assert.ok(page.found && page.type === "transcript-page");
    assert.equal(page.entries.length, 20);
    assert.deepEqual(
      page.entries.map((e) => e.content),
      Array.from({ length: 20 }, (_, n) => `input ${n + total - 20}`),
    );
    if (total === 20) assert.equal(page.older, undefined);
    else {
      assert.ok(page.older);
      const older = app.projectionPort.readTranscript({
        ...refs.page,
        older: page.older,
      });
      assert.ok(older.found && older.type === "transcript-page");
      assert.deepEqual(
        older.entries.map((e) => e.content),
        ["input 0"],
      );
      assert.equal(older.older, undefined);
    }
    await app.shutdown();
  });

test("m10-audit-conversation-order: cursors reject foreign Runs, Sessions and malformed boundaries with the typed Problem", async (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 21);
  const foreignRun = seedRun(runGroup, 21, "op-2");
  const refs = pageRef(app, runId);
  const first = app.projectionPort.readTranscript(refs.page);
  assert.ok(first.found && first.type === "transcript-page" && first.older);
  for (const reference of [
    { ...refs.page, runId: foreignRun, older: first.older },
    { ...refs.page, session: "other", older: first.older },
    ...[
      "!",
      "MQ",
      "e30",
      first.older + "=",
      Buffer.from(
        JSON.stringify({
          version: 1,
          runId,
          session: "s",
          cutoff: 0,
          before: { turnSequence: 0, position: -1, seq: 1 },
        }),
      ).toString("base64url"),
    ].map((older) => ({ ...refs.page, older })),
  ]) {
    const read = app.projectionPort.readTranscript(reference);
    assert.ok(!read.found);
    assert.equal(read.problem.code, "run-transcript-cursor-invalid");
  }
  await app.shutdown();
});

test("m10-audit-conversation-order: live first appearance stamps survive out-of-order settlement and Interrupt without per-chunk writes", async (t) => {
  const { port, runId, owner, channel, finish } = await openLiveRun(t);
  t.after(finish);
  const at = AT;
  assert.ok(
    owner.admitTurn({
      turnId: "turn",
      attemptId: "0.0:echo",
      session: "s",
      origin: "human",
      kind: "interactive-agent",
      input: "Input",
      recoveryCoordinate: "native",
      harness: "codex",
      at,
    }).ok,
  );
  const observe = (messageId: string, content: string) =>
    channel.observe({
      message: { turnId: "turn", session: "s", messageId, content },
    });
  observe("first", "Starting");
  assert.ok(
    owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "tool-call",
        data: {
          callId: "tool",
          tool: "read",
          input: "file",
          outcome: { kind: "running" },
        },
      },
      at,
    }).ok,
  );
  observe("second", "Later reply");
  assert.ok(
    owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "assistant-content",
        data: { messageId: "second", content: "Later reply" },
      },
      at,
    }).ok,
  );
  const pageRef = { runId, session: "s", type: "transcript-page" } as const;
  const before = port.readTranscript(pageRef);
  assert.ok(before.found);
  assert.deepEqual(
    before.entries.map((e) => e.content),
    ["Input", "Later reply"],
  );
  const events = owner.turnEvents();
  observe("first", "Starting, growing");
  observe("first", "Interrupted partial");
  observe("crash-lost", "Never retained");
  assert.deepEqual(
    owner.turnEvents(),
    events,
    "live chunks do not write canonical events",
  );
  assert.ok(
    owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "assistant-content",
        data: {
          messageId: "first",
          content: "Interrupted partial",
          incomplete: true,
        },
      },
      at,
    }).ok,
  );
  assert.ok(
    owner.settleTurn({
      turnId: "turn",
      session: "s",
      resultKind: "interrupted",
      resultDetail: "{}",
      availability: "open",
      at,
    }).ok,
  );
  for (const type of ["transcript-page", "transcript-export"] as const) {
    const read = port.readTranscript({ runId, session: "s", type });
    assert.ok(read.found);
    assert.deepEqual(
      read.entries.map((e) => e.content),
      ["Input", "Interrupted partial", "Later reply"],
    );
    assert.equal(read.entries[1]?.incomplete, true);
  }
  const history = port.openProjection({
    family: "session-history",
    runId,
    session: "s",
  });
  assert.ok(history.snapshot.result.found);
  assert.deepEqual(
    history.snapshot.result.history.rows.flatMap((row) =>
      row.source === "stored" && row.value.kind === "message"
        ? [row.value.content]
        : [],
    ),
    ["Input", "Interrupted partial", "Later reply"],
  );
  history.close();
});

test("m10-audit-conversation-order: a large export crosses its bounded batch without gaps, duplicates or Session leakage", async (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 1_001);
  const refs = pageRef(app, runId);
  const exported = app.projectionPort.readTranscript(refs.export);
  assert.ok(exported.found && exported.type === "transcript-export");
  assert.deepEqual(
    exported.entries.map((e) => e.content),
    Array.from({ length: 1_001 }, (_, n) => `input ${n}`),
  );
  assert.equal(new Set(exported.entries.map((e) => e.id)).size, 1_001);
  const page = app.projectionPort.readTranscript(refs.page);
  assert.ok(page.found && page.type === "transcript-page");
  assert.equal(page.entries.length, 20);
  assert.deepEqual(
    page.entries.map((e) => e.content),
    Array.from({ length: 20 }, (_, n) => `input ${981 + n}`),
  );
  await app.shutdown();
});
