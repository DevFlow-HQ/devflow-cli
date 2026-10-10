import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { createProcessAdapter } from "../../src/process/process.js";
import { openRunGroup } from "../../src/run/store/store.js";
import { relocateRunGroup } from "./relocate.js";

const fixture = new URL(
  "../../tests/fixtures/previous-release-conversation/",
  import.meta.url,
);
const expected = z
  .object({
    runId: z.string(),
    transcript: z.array(
      z.object({ session: z.string(), role: z.string(), content: z.string() }),
    ),
  })
  .parse(JSON.parse(readFileSync(new URL("expected.json", fixture), "utf8")));

/** Authentic old-schema home, relocated before any new source or binary opens it. */
export function conversationConsumer(
  binary: string,
  root: string,
  environment: NodeJS.ProcessEnv,
): void {
  const workspace = join(root, "m10-w");
  mkdirSync(workspace);
  const cwd = realpathSync.native(workspace);
  function relocated(name: string) {
    const home = join(root, name);
    cpSync(fixture, home, { recursive: true });
    const group = relocateRunGroup(home, cwd);
    const path = join(group, expected.runId, "run.db");
    const db = new Database(path);
    try {
      db.query("UPDATE run_record SET workspace_path = ?").run(cwd);
    } finally {
      db.close();
    }
    return { home, path };
  }
  function read(home: string, session = "shared", status = 0) {
    const result = spawnSync(
      binary,
      ["run", "read", `${expected.runId}/${session}`, "--transcript", "--json"],
      {
        cwd,
        env: { ...environment, SECANT_HOME: home },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, status, `${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  }
  const { home, path } = relocated("m10-c");
  const entries = expected.transcript
    .filter((e) => e.session === "shared")
    .map((e) => ({ ...e, step: "discuss" }));
  const first = read(home);
  assert.deepEqual(first.export, {
    found: true,
    type: "transcript-export",
    entries,
  });
  assert.equal(first.page.found, true);
  assert.equal(first.page.type, "transcript-page");
  assert.deepEqual(first.page.entries, entries.slice(-20));
  assert.equal(typeof first.page.older, "string");
  assert.deepEqual(
    read(home),
    first,
    "a second binary reopen neither duplicates nor replaces conversation",
  );
  assert.deepEqual(
    read(home, "other").export.entries,
    expected.transcript
      .filter((e) => e.session === "other")
      .map((e) => ({ ...e, step: "discuss" })),
  );
  const db = new Database(path);
  try {
    assert.equal(
      db
        .query("SELECT name FROM sqlite_master WHERE name = 'transcript_entry'")
        .get(),
      null,
    );
    assert.deepEqual(
      db
        .query(
          "SELECT count(*) AS count FROM turn_event WHERE transcript_seq IS NOT NULL",
        )
        .get(),
      { count: 24 },
    );
    assert.deepEqual(db.query("SELECT owner_pid AS pid FROM run_owner").get(), {
      pid: null,
    });
  } finally {
    db.close();
  }
  const group = openRunGroup(home, cwd, { process: createProcessAdapter() });
  try {
    const owner = group.acquireRun(expected.runId);
    assert.ok(owner);
    try {
      assert.equal(owner.attemptLog()[0]?.outcome, "succeeded");
      assert.equal(owner.gateAnswers().length, 1);
      assert.equal(owner.pendingGate()?.message, "Keep this gate");
      const version = owner.currentVersion("proof");
      assert.ok(version);
      assert.equal(
        new TextDecoder().decode(owner.readArtifact(version, "proof")),
        "retained artifact",
      );
      owner.admitTurn({
        turnId: "later",
        attemptId: "0.12:discuss",
        session: "shared",
        origin: "human",
        kind: "interactive-agent",
        input: "Later",
        recoveryCoordinate: "fixture-shared",
        harness: "claude-code",
        at: new Date(),
      });
      owner.appendTurnEvent({
        turnId: "later",
        fact: {
          kind: "assistant-content",
          data: {
            messageId: "later-message",
            content: "Later reply",
          },
        },
        at: new Date(),
      });
      owner.settleTurn({
        turnId: "later",
        session: "shared",
        resultKind: "completed",
        resultDetail: "{}",
        availability: "detached",
        availabilityDetail: "fixture-shared",
        at: new Date(),
      });
    } finally {
      owner.close();
    }
  } finally {
    group.close();
  }
  assert.deepEqual(read(home).export.entries, [
    ...entries,
    {
      session: "shared",
      role: "user",
      content: "Later",
      step: "discuss",
      kind: "message",
      turn: "later",
    },
    {
      session: "shared",
      role: "assistant",
      content: "Later reply",
      step: "discuss",
      kind: "message",
      turn: "later",
    },
  ]);
  for (const fault of ["orphan-turn", "orphan-session", "rollback"] as const) {
    const isolated = relocated(`m10-${fault}`);
    let broken = new Database(isolated.path);
    if (fault === "orphan-turn")
      broken.exec(
        "UPDATE transcript_entry SET turn_id = 'missing' WHERE seq = 1",
      );
    if (fault === "orphan-session")
      broken.exec(
        "UPDATE transcript_entry SET session_key = 'missing' WHERE seq = 1",
      );
    if (fault === "rollback")
      broken.exec(
        "CREATE TRIGGER inject_failure BEFORE INSERT ON turn_event WHEN NEW.kind = 'legacy-message' BEGIN SELECT RAISE(ABORT, 'injected rollback'); END",
      );
    const original = broken
      .query("SELECT * FROM transcript_entry ORDER BY seq")
      .all();
    const journal = broken.query("SELECT * FROM __drizzle_migrations").all();
    broken.close();
    assert.equal(read(isolated.home, "shared", 1).code, "run-store-damaged");
    broken = new Database(isolated.path);
    try {
      assert.deepEqual(
        broken.query("SELECT * FROM transcript_entry ORDER BY seq").all(),
        original,
      );
      assert.deepEqual(
        broken.query("SELECT * FROM __drizzle_migrations").all(),
        journal,
      );
      if (fault === "rollback") broken.exec("DROP TRIGGER inject_failure");
      else
        broken.exec(
          "UPDATE transcript_entry SET turn_id = 'turn-0', session_key = 'shared' WHERE seq = 1",
        );
    } finally {
      broken.close();
    }
    assert.deepEqual(read(isolated.home).export.entries, entries);
  }
}
