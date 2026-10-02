import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildFact } from "../../src/process/process.js";
import {
  isAlive,
  superviseProgram,
  type SupervisedFailure,
} from "../helpers/supervisor.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The runner supervisor's runtime cases (#326, spec #313 S3). The supervisor
// spawns, so it is proven here rather than under the test runner: each case runs
// it against one fixture set of supervisor-fixture.ts and asserts the summary
// with each open child's role and PID, that no child the fixture spawned
// survives, that the run's temp folder is gone, and that the breadcrumbs reached
// the operational log. The fixture bound is a supervisor parameter; the
// production 20-second bound is unchanged.

const FIXTURE = fileURLToPath(
  new URL("./supervisor-fixture.ts", import.meta.url),
);
const FIXTURE_BOUND_MS = 2_000;
/** A killed grandchild is reaped by init, not by this process, so its PID can
 *  outlast the kill briefly; this bounds the wait for it to go. */
const GONE_MS = 5_000;

type Register = (name: string, body: () => Promise<void>) => void;

interface Supervised {
  readonly status: number;
  readonly failures: readonly SupervisedFailure[];
  readonly text: string;
  readonly logFolder: string;
  readonly tempParent: string;
}

async function superviseFixture(args: readonly string[]): Promise<Supervised> {
  const tempParent = makeTempDir("secant-supervisor-temp-");
  const logFolder = join(makeTempDir("secant-supervisor-log-"), "logs");
  const reports: string[] = [];
  const { status, failures } = await superviseProgram({
    program: "supervisor-fixture",
    entry: FIXTURE,
    args,
    boundMs: FIXTURE_BOUND_MS,
    logFolder,
    tempParent,
    output: "ignore",
    report: (text) => reports.push(text),
  });
  return { status, failures, text: reports.join(""), logFolder, tempParent };
}

/** The one failure, its children by role, and the run's leftovers checked. */
async function assertCleanFailure(
  run: Supervised,
  scenario: string,
): Promise<SupervisedFailure> {
  assert.equal(run.status, 1, run.text);
  assert.equal(run.failures.length, 1, run.text);
  const failure = run.failures[0]!;
  assert.equal(failure.summary.scenario?.scenario, scenario, run.text);
  assert.deepEqual(failure.survivors, [], run.text);
  for (const child of failure.summary.scenario!.children) {
    if (child.pid !== undefined) await assertGone(child.pid);
  }
  assert.match(
    run.text,
    new RegExp(`^FAILED ${scenario} \\(supervisor-fixture`),
  );
  assert.ok(
    run.text.includes(`  log folder:     ${run.logFolder}\n`),
    run.text,
  );
  // The run's temp folder, and every folder the fixture made under it, is gone.
  assert.deepEqual(readdirSync(run.tempParent), []);
  return failure;
}

async function assertGone(pid: number): Promise<void> {
  const deadline = Date.now() + GONE_MS;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(isAlive(pid), false, `PID ${pid} survived the clean-up`);
}

/** Every operational-log record the fixture's Secant invocations wrote. */
function logRecords(folder: string): Record<string, unknown>[] {
  return readdirSync(folder)
    .sort()
    .flatMap((name) =>
      readFileSync(join(folder, name), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
}

/** Whether some record carries every one of `fields`; a field set to undefined
 *  must be absent. */
function hasRecord(
  records: readonly Record<string, unknown>[],
  fields: Readonly<Record<string, unknown>>,
): boolean {
  return records.some((record) =>
    Object.entries(fields).every(([key, value]) =>
      value === undefined ? !(key in record) : record[key] === value,
    ),
  );
}

/** The summary's first open child is `role` with `pid`. */
function assertFirstOpenChild(run: Supervised, role: string, pid: number) {
  assert.ok(
    run.text.includes(`  open children:  ${role} PID ${pid}, open `),
    run.text,
  );
}

function pidOf(failure: SupervisedFailure, role: ChildFact["role"]): number {
  const child = failure.summary.scenario?.children.find(
    (open) => open.role === role,
  );
  assert.ok(child?.pid !== undefined, `an open ${role} child with a PID`);
  return child.pid;
}

export function registerSupervisorConformance(register: Register): void {
  register(
    "[supervisor] a failed scenario is summarized with its open child, cleaned up, and the run resumes",
    async () => {
      const run = await superviseFixture(["fails"]);
      const failure = await assertCleanFailure(run, "fails-with-open-child");
      assert.deepEqual(failure.summary.cause, { kind: "failed" });
      const pid = pidOf(failure, "harness-runtime");
      assert.ok(run.text.includes("  open stage:     assert, open "), run.text);
      assertFirstOpenChild(run, "harness-runtime", pid);

      const records = logRecords(run.logFolder);
      const scenarioEnds = records
        .filter((record) => record.event === "runner-scenario-end")
        .map((record) => [record.scenario, record.status, record.level]);
      // The second scenario process starts after the failed scenario.
      assert.deepEqual(scenarioEnds, [
        ["passes-before", "passed", "info"],
        ["fails-with-open-child", "failed", "warn"],
        ["passes-after", "passed", "info"],
      ]);
      assert.ok(
        hasRecord(records, {
          event: "child-spawn",
          childRole: "harness-runtime",
          childPid: pid,
        }),
      );
      assert.ok(
        hasRecord(records, {
          event: "runner-stage-end",
          stage: "assert",
          status: "failed",
        }),
      );
      assert.equal(readdirSync(run.logFolder).length, 2);
    },
  );

  register(
    "[supervisor] an asynchronous scenario that outlives the bound is summarized with its open child and cleaned up",
    async () => {
      const run = await superviseFixture(["async-timeout"]);
      const failure = await assertCleanFailure(run, "awaits-a-command");
      assert.deepEqual(failure.summary.cause, {
        kind: "timed-out",
        boundMs: FIXTURE_BOUND_MS,
      });
      assert.ok(failure.summary.elapsedMs >= FIXTURE_BOUND_MS);
      const pid = pidOf(failure, "command");
      assert.ok(run.text.includes("did not settle within 2 seconds"), run.text);
      assert.ok(run.text.includes("  open stage:     await command, open "));
      assertFirstOpenChild(run, "command", pid);
      const records = logRecords(run.logFolder);
      assert.ok(
        hasRecord(records, {
          event: "runner-stage-start",
          scenario: "awaits-a-command",
          stage: "await command",
        }),
      );
      assert.ok(
        hasRecord(records, {
          event: "child-spawn",
          childRole: "command",
          childPid: pid,
        }),
      );
    },
  );

  register(
    "[supervisor] a scenario blocked in a synchronous spawn is summarized with its children and its whole tree killed",
    async () => {
      const marker = join(makeTempDir("secant-supervisor-marker-"), "sync-pid");
      const run = await superviseFixture(["sync-block", marker]);
      const failure = await assertCleanFailure(run, "blocks-in-a-sync-child");
      assert.equal(failure.summary.cause.kind, "timed-out");
      const pid = pidOf(failure, "harness-runtime");
      assert.ok(run.text.includes("  open stage:     block in git, open "));
      assertFirstOpenChild(run, "harness-runtime", pid);
      // A spawn still blocking has reported its role but no PID yet.
      assert.ok(
        run.text.includes(
          "                  git PID unknown (synchronous spawn still blocking), open ",
        ),
        run.text,
      );
      // The blocked child is reached through the scenario's own group or tree.
      assert.ok(existsSync(marker), "the synchronous child started");
      await assertGone(Number(readFileSync(marker, "utf8")));
      const records = logRecords(run.logFolder);
      assert.ok(
        hasRecord(records, {
          event: "child-spawn",
          childRole: "git",
          childPid: undefined,
        }),
      );
    },
  );
}
