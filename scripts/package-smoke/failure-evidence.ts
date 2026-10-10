import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
  catalogMigrations,
  coordinationMigrations,
  runMigrations,
} from "../../src/drizzle/migrations.js";
import { relocateRunGroup } from "./relocate.js";

const fixture = new URL(
  "../../tests/fixtures/previous-release-failure-evidence/",
  import.meta.url,
);
const expected = z
  .object({
    runs: z.array(
      z.object({
        rest: z.enum(["halted", "failed"]),
        runId: z.string(),
        attempts: z.array(z.object({ outcome: z.string() })),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(new URL("expected.json", fixture), "utf8")));

const UNKNOWN = "This Step failed for unknown reasons.";
const NEXT = "Resume the Run to try again, or delete it.";

/** The authentic pre-M11 failure home (#536), relocated beneath the isolated
 *  install so the copied binary performs its first open and every migration. */
export function failureEvidenceConsumer(
  binary: string,
  root: string,
  environment: NodeJS.ProcessEnv,
): void {
  const workspace = join(root, "m11-w");
  mkdirSync(workspace);
  const cwd = realpathSync.native(workspace);
  const home = join(root, "m11-home");
  cpSync(fixture, home, { recursive: true });
  const group = relocateRunGroup(home, cwd);
  for (const run of expected.runs) {
    const db = new Database(join(group, run.runId, "run.db"));
    try {
      db.query("UPDATE run_record SET workspace_path = ?").run(cwd);
    } finally {
      db.close();
    }
  }
  function secant(args: readonly string[]): string {
    const result = spawnSync(binary, args, {
      cwd,
      env: { ...environment, SECANT_HOME: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stderr, "");
    return result.stdout;
  }

  const first = expected.runs.map((run) =>
    secant(["run", "show", run.runId, "--json"]),
  );
  assert.deepEqual(
    expected.runs.map((run) => secant(["run", "show", run.runId, "--json"])),
    first,
    "a second binary reopen reads the same history",
  );
  for (const [index, run] of expected.runs.entries()) {
    const shown = JSON.parse(first[index]!).result.run;
    assert.equal(shown.state, run.rest);
    assert.deepEqual(shown.restingCause, {
      code: "unknown",
      explanation: UNKNOWN,
      nextStep: NEXT,
    });
    const settled = shown.timeline.filter(
      (event: { event: string }) => event.event === "attempt-settled",
    );
    assert.deepEqual(
      settled.map((event: { detail: string }) => event.detail),
      run.attempts.map((attempt) => attempt.outcome),
    );
    for (const event of settled.slice(1))
      assert.equal(event.failure.code, "unknown");
    const text = secant(["run", "show", run.runId]);
    assert.match(
      text,
      new RegExp(
        `\\nState: ${run.rest}\\nStopped because: ${UNKNOWN.replaceAll(".", "\\.")}\\n`,
      ),
    );
    assert.equal(
      JSON.parse(secant(["run", "read", `${run.runId}/prepare-log`, "--json"]))
        .content,
      `${run.rest} retained artifact`,
    );
  }

  // Each database records exactly its declared embedded journal, and nothing
  // was backfilled into the M11 columns or table.
  const journal = (path: string) => {
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
  };
  const names = (entries: readonly { name: string }[]) =>
    entries.map((e) => e.name);
  assert.deepEqual(journal(join(home, "catalog.db")), names(catalogMigrations));
  assert.deepEqual(
    journal(join(group, "coordination.db")),
    names(coordinationMigrations),
  );
  for (const run of expected.runs) {
    const path = join(group, run.runId, "run.db");
    assert.deepEqual(journal(path), names(runMigrations));
    const db = new Database(path, { readonly: true });
    try {
      assert.deepEqual(
        db.query("SELECT count(*) AS count FROM failure_evidence").get(),
        {
          count: 0,
        },
      );
      assert.deepEqual(
        db
          .query(
            "SELECT resting_cause_code AS code, resting_cause_diagnostic_id AS diagnostic, owner_pid AS pid FROM run_record, run_owner",
          )
          .get(),
        { code: null, diagnostic: null, pid: null },
      );
    } finally {
      db.close();
    }
  }
}
