import assert from "node:assert/strict";
import test from "node:test";
import { withClients } from "../../src/composition/main.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { writeCommandBundle } from "../helpers/commandBundle.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { assertBase, home, readLog, WALL } from "./log-sink.js";

// Child-process facts in the operational log (#321, spec #313 stories 18–19),
// read back from the JSONL a Secant invocation writes. The Process double
// receives composition's observer through `processFactory`, as the real Adapter
// does through its factory options, so its scripted children report their facts
// and no real child spawns.

test("a Command Run's children reach the log with their role and PID, and no argument, environment value, or output", async (t) => {
  const { folder, overrides } = home();
  const argument = "seeded-argument-a41e";
  const output = "seeded-output-93bd";
  const environment = "seeded-environment-c07f";
  setEnvironmentForTest(t, { SECANT_SEEDED_VALUE: environment });
  const git = createFakeGitProcess();
  const cmd = writeCommandBundle({ script: `console.log('${argument}')` });
  const workspace = overrides.launchCwd!;

  const status = await withClients(
    async ({ projectionPort, bundleManagement }) => {
      assert.ok(bundleManagement.build(cmd.folder, { noInstall: false }).ok);
      assert.ok(
        projectionPort.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      const catalog = projectionPort.openProjection({
        family: "bundle-catalog",
        focus: { id: cmd.id },
      });
      const result = catalog.snapshot.result;
      catalog.close();
      assert.ok(result.found);
      if (!result.found) throw new Error("unreachable");
      const launch = projectionPort.submit({
        operationId: "op-launch",
        operation: "launch-run",
        input: {
          bundle: { id: cmd.id },
          launchInputs: {},
          trustDigest: result.bundle.digest,
        },
      });
      assert.ok(launch.admitted, JSON.stringify(launch));
      await awaitSettled(projectionPort, "op-launch");
      return 0;
    },
    {
      ...overrides,
      process: undefined,
      // The double receives composition's observer the way the real Adapter
      // does: through the factory's options.
      processFactory: (options) =>
        createFakeProcess(
          {
            resolutionHandler: (name) => ({
              kind: "found",
              executable: name,
              prefixArgs: [],
            }),
            commandHandler: () => ({
              kind: "exited",
              status: 0,
              text: new TextEncoder().encode(`${output}\n`),
            }),
            syncCommandHandler: (sync) => git.spawnCommandSync(sync),
          },
          options,
        ),
    },
  );
  assert.equal(status, 0);

  const log = readLog(folder);
  assertBase(log.records);
  const children = log.records.filter((record) =>
    String(record.event).startsWith("child-"),
  );
  const command = children.filter((record) => record.childRole === "command");
  const pid = command[0]?.childPid;
  assert.equal(typeof pid, "number");
  assert.deepEqual(command, [
    {
      level: "info",
      time: WALL.toISOString(),
      invocationId: log.records[0]!.invocationId,
      event: "child-spawn",
      childRole: "command",
      childPid: pid,
    },
    {
      level: "info",
      time: WALL.toISOString(),
      invocationId: log.records[0]!.invocationId,
      event: "child-exit",
      childRole: "command",
      childPid: pid,
      exitStatus: 0,
      // The fake's fixed 12.6 ms, rounded.
      elapsedMs: 13,
    },
  ]);
  // The Artifact repository's git: each synchronous spawn starts before it
  // blocks, and its PID arrives with the exit.
  const gitRecords = children.filter((record) => record.childRole === "git");
  assert.ok(gitRecords.length >= 2, JSON.stringify(children));
  for (let i = 0; i < gitRecords.length; i += 2) {
    assert.deepEqual(
      [gitRecords[i]!.event, "childPid" in gitRecords[i]!],
      ["child-spawn", false],
    );
    assert.equal(gitRecords[i + 1]!.event, "child-exit");
    assert.equal(typeof gitRecords[i + 1]!.childPid, "number");
  }
  for (const seeded of [argument, output, environment, cmd.folder]) {
    assert.equal(log.text.includes(seeded), false, seeded);
  }
});

test("a refused spawn and a timed-out child warn, with the native code and no PID for the spawn that never ran", async () => {
  const { folder, overrides } = home();
  const probed = writeCommandBundle({
    id: "dev.secant.git-probed",
    prerequisites: ["git-worktree-root"],
  });
  const slow = writeCommandBundle({ id: "dev.secant.slow", retry: 0 });
  const workspace = overrides.launchCwd!;

  await withClients(
    async ({ projectionPort, bundleManagement }) => {
      assert.ok(
        projectionPort.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      for (const [index, bundle] of [probed, slow].entries()) {
        assert.ok(
          bundleManagement.build(bundle.folder, { noInstall: false }).ok,
        );
        const catalog = projectionPort.openProjection({
          family: "bundle-catalog",
          focus: { id: bundle.id },
        });
        const result = catalog.snapshot.result;
        catalog.close();
        if (!result.found) throw new Error("unreachable");
        const operationId = `op-launch-${index}`;
        projectionPort.submit({
          operationId,
          operation: "launch-run",
          input: {
            bundle: { id: bundle.id },
            launchInputs: {},
            trustDigest: result.bundle.digest,
          },
        });
        await awaitSettled(projectionPort, operationId);
      }
      return 0;
    },
    {
      ...overrides,
      process: undefined,
      processFactory: (options) =>
        createFakeProcess(
          {
            resolutionHandler: (name) => ({
              kind: "found",
              executable: name,
              prefixArgs: [],
            }),
            commandHandler: () => ({ kind: "timeout" }),
            // The Preflight worktree probe's git never runs.
            syncCommandHandler: () => ({
              kind: "spawn-error",
              cause: Object.assign(new Error("spawnSync git ENOENT"), {
                code: "ENOENT",
              }),
            }),
          },
          options,
        ),
    },
  );

  const log = readLog(folder);
  assertBase(log.records);
  const children = log.records
    .filter((record) => String(record.event).startsWith("child-"))
    .map(({ time: _time, invocationId: _id, ...record }) => record);
  const pid = children.find(
    (record) => record.childRole === "command",
  )?.childPid;
  assert.equal(typeof pid, "number");
  assert.deepEqual(children, [
    { level: "info", event: "child-spawn", childRole: "git" },
    {
      level: "warn",
      event: "child-spawn-error",
      childRole: "git",
      code: "ENOENT",
      elapsedMs: 13,
    },
    {
      level: "info",
      event: "child-spawn",
      childRole: "command",
      childPid: pid,
    },
    {
      level: "warn",
      event: "child-timeout",
      childRole: "command",
      childPid: pid,
    },
    {
      level: "info",
      event: "child-reap",
      childRole: "command",
      childPid: pid,
      signal: "SIGTERM",
      elapsedMs: 13,
    },
  ]);
  assert.equal(log.text.includes("spawnSync git"), false);
});
