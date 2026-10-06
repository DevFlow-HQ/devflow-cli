import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "./fake-git-process.js";

const fixture = new URL(
  "../../fixtures/previous-release-conversation/",
  import.meta.url,
);
const expected = z
  .object({
    runId: z.string(),
    transcript: z.array(
      z.object({
        session: z.string(),
        turnId: z.string(),
        role: z.string(),
        content: z.string(),
        at: z.string(),
      }),
    ),
    turns: z.array(z.unknown()),
    events: z.array(z.unknown()),
    attempts: z.array(z.unknown()),
    gates: z.array(z.unknown()),
    pendingGate: z.unknown(),
    sessions: z.array(z.unknown()),
  })
  .parse(JSON.parse(readFileSync(new URL("expected.json", fixture), "utf8")));
const workspace = "/fixture/conversation";
function copy() {
  const home = makeTempDir("secant-conversation-migration-");
  cpSync(fixture, home, { recursive: true });
  const groupDir = join(home, "runs", readdirSync(join(home, "runs"))[0]!);
  return { home, path: join(groupDir, expected.runId, "run.db") };
}
function conversation(
  entries: readonly {
    session: string;
    turnId: string;
    role: string;
    content: string;
    at: string;
  }[],
) {
  return entries.map(({ session, turnId, role, content, at }) => ({
    session,
    turnId,
    role,
    content,
    at,
  }));
}

test("m10-previous-release-conversation: authoritative empty/divergent messages migrate once, reopen twice and append", () => {
  const { home, path } = copy();
  for (let pass = 0; pass < 2; pass++) {
    const group = openRunGroup(home, workspace);
    try {
      const owner = group.acquireRun(expected.runId);
      assert.ok(owner);
      try {
        assert.deepEqual(conversation(owner.transcript()), expected.transcript);
        assert.deepEqual(owner.turns(), expected.turns);
        assert.deepEqual(owner.turnEvents(), expected.events);
        assert.deepEqual(owner.attemptLog(), expected.attempts);
        assert.deepEqual(owner.gateAnswers(), expected.gates);
        assert.deepEqual(owner.pendingGate(), expected.pendingGate);
        assert.deepEqual(owner.harnessSessions(), expected.sessions);
        assert.ok(owner.currentVersion("proof"));
        const page = owner.transcriptPage({ session: "shared", limit: 20 });
        assert.equal(page.entries.length, 20);
        assert.equal(page.hasOlder, true);
        assert.deepEqual(
          page.entries.map((e) => e.content),
          expected.transcript
            .filter((e: { session: string }) => e.session === "shared")
            .slice(-20)
            .map((e: { content: string }) => e.content),
        );
        assert.ok(
          owner
            .transcript()
            .every(
              (e) => !("kind" in e) && !("turn" in e) && !("incomplete" in e),
            ),
        );
      } finally {
        owner.close();
      }
    } finally {
      group.close();
    }
  }
  const db = new Database(path);
  try {
    assert.equal(
      db
        .query("SELECT name FROM sqlite_master WHERE name = 'transcript_entry'")
        .get(),
      null,
    );
  } finally {
    db.close();
  }
  const group = openRunGroup(home, workspace);
  try {
    const owner = group.acquireRun(expected.runId);
    assert.ok(owner);
    try {
      owner.admitTurn({
        turnId: "later",
        attemptId: "0.12:discuss",
        session: "shared",
        origin: "human",
        kind: "interactive-agent",
        input: "later message",
        recoveryCoordinate: "fixture-shared",
        harness: "claude-code",
        at: new Date(),
      });
      assert.deepEqual(
        conversation(owner.transcript()).slice(0, 24),
        expected.transcript,
      );
      assert.equal(owner.transcript().at(-1)?.content, "later message");
      assert.ok(
        owner.transcriptPage({ session: "shared", limit: 20 }).entries.at(-1)!
          .seq > 24,
      );
    } finally {
      owner.close();
    }
  } finally {
    group.close();
  }
});

for (const failure of [
  "orphan-turn",
  "orphan-session",
  "wrong-session",
  "injected-rollback",
] as const) {
  test(`m10-previous-release-conversation: ${failure} retains recoverable transcript and journal`, () => {
    const { home, path } = copy();
    let db = new Database(path);
    if (failure === "orphan-turn")
      db.exec("UPDATE transcript_entry SET turn_id = 'missing' WHERE seq = 1");
    if (failure === "orphan-session")
      db.exec(
        "UPDATE transcript_entry SET session_key = 'missing' WHERE seq = 1",
      );
    if (failure === "wrong-session")
      db.exec(
        "UPDATE transcript_entry SET session_key = 'other' WHERE seq = 1",
      );
    if (failure === "injected-rollback")
      db.exec(
        "CREATE TRIGGER inject_migration_failure BEFORE INSERT ON turn_event WHEN NEW.kind = 'legacy-message' BEGIN SELECT RAISE(ABORT, 'injected conversation migration rollback'); END",
      );
    const before = db
      .query("SELECT * FROM transcript_entry ORDER BY seq")
      .all();
    const journal = db.query("SELECT * FROM __drizzle_migrations").all();
    db.close();
    const group = openRunGroup(home, workspace);
    try {
      const read = group.readRun(expected.runId);
      assert.ok(!read.ok, "a failed migration isolates the Run");
      assert.equal(read.problem.kind, "run-store-damaged");
    } finally {
      group.close();
    }
    db = new Database(path);
    try {
      assert.deepEqual(
        db.query("SELECT * FROM transcript_entry ORDER BY seq").all(),
        before,
      );
      assert.deepEqual(
        db.query("SELECT * FROM __drizzle_migrations").all(),
        journal,
      );
      assert.equal(
        db
          .query(
            "SELECT name FROM pragma_table_info('turn_event') WHERE name = 'transcript_seq'",
          )
          .get(),
        null,
      );
      if (failure === "injected-rollback")
        db.exec("DROP TRIGGER inject_migration_failure");
      else
        db.exec(
          "UPDATE transcript_entry SET turn_id = 'turn-0', session_key = 'shared' WHERE seq = 1",
        );
    } finally {
      db.close();
    }
    const repaired = openRunGroup(home, workspace);
    try {
      assert.ok(repaired.readRun(expected.runId).ok);
    } finally {
      repaired.close();
    }
  });
}
