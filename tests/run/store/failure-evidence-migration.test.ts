import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
  coordinationMigrations,
  runMigrations,
} from "../../../src/drizzle/migrations.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openRunGroup } from "../../../src/run/store/store.js";
import { createFakeGitProcess } from "./fake-git-process.js";

// An authentic pre-M11 home (#536): a `halted` Run ending on an `indeterminate`
// Attempt and a `failed` Run that exhausted its retry, both written through the
// predecessor's public Interfaces with ownership released. Upgrading migrates
// each database exactly once to its declared journal and backfills nothing.

const fixture = new URL(
  "../../fixtures/previous-release-failure-evidence/",
  import.meta.url,
);
const json = (name: string) =>
  JSON.parse(readFileSync(new URL(name, fixture), "utf8"));
const provenance = z
  .object({
    workspace: z.string(),
    databases: z.array(
      z.object({
        path: z.string(),
        sha256: z.string(),
        journal: z.array(z.string()),
      }),
    ),
  })
  .parse(json("provenance.json"));
const expected = z
  .object({
    runs: z.array(
      z.object({
        rest: z.enum(["halted", "failed"]),
        runId: z.string(),
        state: z.string(),
        createdAt: z.string(),
        attempts: z.array(
          z.object({
            attemptId: z.string(),
            outcome: z.string(),
            at: z.string(),
          }),
        ),
      }),
    ),
  })
  .parse(json("expected.json"));

function journal(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ name: string }, []>(
        "SELECT name FROM __drizzle_migrations ORDER BY id",
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

// The one Run group's folder, relative to the home.
const groupDir = dirname(
  provenance.databases.find((d) => d.path.endsWith("/coordination.db"))!.path,
);

function copy(): string {
  const home = makeTempDir("secant-failure-evidence-migration-");
  cpSync(fixture, home, { recursive: true });
  return home;
}

test("m11-old-and-unknown-evidence: the fixture is the recorded predecessor home with halted and failed rests and failed and indeterminate Attempts", () => {
  const home = copy();
  for (const database of provenance.databases) {
    const path = join(home, database.path);
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      database.sha256,
      database.path,
    );
    assert.deepEqual(journal(path), database.journal, database.path);
  }
  // The predecessor's run journal is a strict prefix of the declared one, ending
  // just before the first M11 migration; later migrations may follow it.
  const runJournal = runMigrations.map((entry) => entry.name);
  for (const run of expected.runs) {
    const recorded = provenance.databases.find((d) =>
      d.path.includes(run.runId),
    )?.journal;
    assert.ok(recorded);
    assert.deepEqual(recorded, runJournal.slice(0, recorded.length));
    assert.equal(runJournal[recorded.length], "resting_cause");
  }
  const outcomes = expected.runs.flatMap((run) =>
    run.attempts.map((attempt) => attempt.outcome),
  );
  assert.ok(outcomes.includes("failed"));
  assert.ok(outcomes.includes("indeterminate"));
  assert.deepEqual(
    expected.runs.map((run) => run.state),
    ["halted", "failed"],
  );
});

test("m11-old-and-unknown-evidence: predecessor Runs migrate exactly, keep their history across two reopens, and gain no evidence or Resting cause", () => {
  const home = copy();
  for (let pass = 0; pass < 2; pass++) {
    const group = openRunGroup(home, provenance.workspace, {
      process: createFakeGitProcess(),
    });
    try {
      for (const run of expected.runs) {
        const read = group.readRun(run.runId);
        assert.ok(read.ok);
        assert.equal(read.run.state, run.state);
        assert.equal(read.run.createdAt, run.createdAt);
        // No crash cause is invented for a released predecessor rest.
        assert.equal(read.run.restingCause, undefined);
        const owner = group.acquireRun(run.runId);
        assert.ok(owner);
        try {
          assert.deepEqual(owner.attemptLog(), run.attempts);
          assert.deepEqual(owner.failureEvidence(), []);
          // Artifact bytes are read through real Git by the package smoke.
          assert.ok(owner.currentVersion("prepare-log"));
          assert.equal(owner.release().ok, true);
        } finally {
          owner.close();
        }
      }
    } finally {
      group.close();
    }
  }
  assert.deepEqual(
    journal(join(home, groupDir, "coordination.db")),
    coordinationMigrations.map((entry) => entry.name),
  );
  for (const run of expected.runs) {
    const path = join(home, groupDir, run.runId, "run.db");
    assert.deepEqual(
      journal(path),
      runMigrations.map((entry) => entry.name),
    );
    const db = new Database(path, { readonly: true });
    try {
      assert.deepEqual(
        db.query("SELECT count(*) AS count FROM failure_evidence").get(),
        { count: 0 },
      );
      assert.deepEqual(
        db
          .query(
            "SELECT state, resting_cause_code, resting_cause_details, resting_cause_evidence_id, resting_cause_diagnostic_id FROM run_record",
          )
          .get(),
        {
          state: run.state,
          resting_cause_code: null,
          resting_cause_details: null,
          resting_cause_evidence_id: null,
          resting_cause_diagnostic_id: null,
        },
      );
    } finally {
      db.close();
    }
  }
});
