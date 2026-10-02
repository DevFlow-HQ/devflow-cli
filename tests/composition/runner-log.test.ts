import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { runRunnerInvocation } from "../../src/composition/main.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { assertBase, readLog, steppingClock, WALL } from "./log-sink.js";

// A standalone runner program's breadcrumbs in the operational log (#326, spec
// #313 story 54): runtime conformance and terminal lifecycle each run as one
// Secant invocation of the `runner` client, so their scenario and stage
// lifecycle and their children's facts land beside every other record.

function sink() {
  const folder = join(makeTempDir("secant-runner-log-"), "logs");
  const notices: string[] = [];
  return {
    folder,
    notices,
    logSink: {
      folder,
      clock: steppingClock(),
      stderr: (text: string) => notices.push(text),
    },
  };
}

test("scenario and stage breadcrumbs and child facts become records, and a failure warns", async () => {
  const { folder, notices, logSink } = sink();

  const status = await runRunnerInvocation(
    "runtime-conformance",
    logSink,
    async (log) => {
      log.breadcrumb({ kind: "scenario-start", scenario: "first" });
      log.breadcrumb({
        kind: "stage-start",
        scenario: "first",
        stage: "probe",
      });
      log.processOptions.observeChild?.({
        kind: "spawn",
        role: "command",
        pid: 41,
      });
      log.processOptions.observeChild?.({ kind: "spawn", role: "git" });
      log.breadcrumb({
        kind: "stage-end",
        scenario: "first",
        stage: "probe",
        status: "failed",
        elapsedMs: 12.4,
      });
      log.breadcrumb({
        kind: "scenario-end",
        scenario: "first",
        status: "passed",
        elapsedMs: 30.6,
      });
      log.breadcrumb({
        kind: "scenario-end",
        scenario: "second",
        status: "failed",
        elapsedMs: 0,
      });
      return 3;
    },
  );
  assert.equal(status, 3);
  assert.deepEqual(notices, []);

  const { records } = readLog(folder);
  assertBase(records);
  const fields = records.map(
    ({ invocationId: _id, time: _time, ...rest }) => rest,
  );
  assert.deepEqual(fields[0], {
    level: "info",
    event: "invocation-start",
    client: "runner",
    version: fields[0]!.version,
    platform: fields[0]!.platform,
    pid: process.pid,
  });
  assert.deepEqual(fields.slice(1, -1), [
    {
      level: "info",
      event: "runner-scenario-start",
      program: "runtime-conformance",
      scenario: "first",
    },
    {
      level: "info",
      event: "runner-stage-start",
      program: "runtime-conformance",
      scenario: "first",
      stage: "probe",
    },
    { level: "info", event: "child-spawn", childRole: "command", childPid: 41 },
    { level: "info", event: "child-spawn", childRole: "git" },
    {
      level: "warn",
      event: "runner-stage-end",
      program: "runtime-conformance",
      scenario: "first",
      stage: "probe",
      status: "failed",
      elapsedMs: 12,
    },
    {
      level: "info",
      event: "runner-scenario-end",
      program: "runtime-conformance",
      scenario: "first",
      status: "passed",
      elapsedMs: 31,
    },
    {
      level: "warn",
      event: "runner-scenario-end",
      program: "runtime-conformance",
      scenario: "second",
      status: "failed",
      elapsedMs: 0,
    },
  ]);
  assert.equal(fields.at(-1)!.event, "invocation-end");
  assert.equal(fields.at(-1)!.client, "runner");
  assert.equal(fields.at(-1)!.exitStatus, 3);
  assert.equal(records[0]!.time, WALL.toISOString());
});

test("a runner program that throws records the failure and rethrows", async () => {
  const { folder, logSink } = sink();
  const failure = new Error("runner body exploded");

  await assert.rejects(
    runRunnerInvocation("terminal-lifecycle", logSink, async (log) => {
      log.breadcrumb({ kind: "scenario-start", scenario: "quit" });
      throw failure;
    }),
    failure,
  );

  const events = readLog(folder).records.map((record) => record.event);
  assert.deepEqual(events, [
    "invocation-start",
    "runner-scenario-start",
    "invocation-failure",
    "invocation-end",
  ]);
});
