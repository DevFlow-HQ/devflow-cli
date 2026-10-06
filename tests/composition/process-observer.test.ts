import { ownPreparations } from "../harness/preparation-double.js";
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
  let runId = "";

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
      runId = launch.runId!;
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
      runId,
      childRole: "command",
      childPid: pid,
    },
    {
      level: "info",
      time: WALL.toISOString(),
      invocationId: log.records[0]!.invocationId,
      event: "child-exit",
      runId,
      childRole: "command",
      childPid: pid,
      exitStatus: 0,
      // The fake's fixed 12.6 ms, rounded.
      elapsedMs: 13,
    },
  ]);
  // The Artifact repository's git, in the Run's own scope: each synchronous
  // spawn starts before it blocks, and its PID arrives with the exit.
  const gitRecords = children.filter((record) => record.childRole === "git");
  assert.ok(gitRecords.length >= 2, JSON.stringify(children));
  for (let i = 0; i < gitRecords.length; i += 2) {
    assert.equal(gitRecords[i]!.runId, runId);
    assert.equal(gitRecords[i + 1]!.runId, runId);
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
  const runIds: string[] = [];

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
        const launch = projectionPort.submit({
          operationId,
          operation: "launch-run",
          input: {
            bundle: { id: bundle.id },
            launchInputs: {},
            trustDigest: result.bundle.digest,
          },
        });
        if (launch.admitted && launch.runId !== undefined) {
          runIds.push(launch.runId);
        }
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
  // Preflight refuses the probed Bundle before any Run exists, so only the slow
  // Bundle's Run is created, and only its Command is attributed to it.
  assert.equal(runIds.length, 1);
  const runId = runIds[0];
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
      runId,
      childRole: "command",
      childPid: pid,
    },
    {
      level: "warn",
      event: "child-timeout",
      runId,
      childRole: "command",
      childPid: pid,
    },
    {
      level: "info",
      event: "child-reap",
      runId,
      childRole: "command",
      childPid: pid,
      signal: "SIGTERM",
      elapsedMs: 13,
    },
  ]);
  assert.equal(log.text.includes("spawnSync git"), false);
});

for (const containment of ["fallback", "contained"] as const) {
  test(`operational log retains ${containment} launch evidence and translates only fallback causes`, async () => {
    const { folder, overrides } = home();
    const status = await withClients(
      async (clients) => {
        const opened = clients.projectionPort.openProjection({
          family: "harness-catalog",
          focus: { id: "claude-code" },
        });
        await opened.updates[Symbol.asyncIterator]().next();
        opened.close();
        return 0;
      },
      {
        ...overrides,
        process: undefined,
        processFactory: (options) =>
          createFakeProcess(
            {
              ownedProcesses: [
                {
                  kind: "launched",
                  containment,
                  containmentCause: Object.assign(
                    new Error("forced CreateJobObjectW failure"),
                    { code: "EACCES", argv: "seeded-private-argv" },
                  ),
                  emissions: [
                    {
                      kind: "terminal",
                      trigger: "automatic",
                      close: { kind: "exited", status: 0 },
                    },
                  ],
                },
              ],
            },
            options,
          ),
        discoverClaudeCode: () => ({
          kind: "found",
          attempt: {
            source: "path",
            name: "claude",
            description: "PATH name 'claude'",
          },
        }),
        harnessAdapter: ownPreparations({
          async prepare(options) {
            const result = await options.process.spawnOwnedProcess({
              role: "harness-runtime",
              executable: "seeded-private-executable",
              args: ["seeded-private-argv"],
              cwd: options.workspace,
              env: {},
              launchTimeoutMs: 10,
            });
            assert.ok(result.ok);
            return {
              ok: false,
              failure: {
                phase: "prepare",
                category: "script-finished",
                possibleEffects: "none",
              },
            };
          },
        }),
      },
    );
    assert.equal(status, 0);
    const log = readLog(folder);
    const spawn = log.records.find((record) => record.event === "child-spawn");
    assert.ok(spawn);
    assert.equal(spawn.containment, containment);
    if (containment === "fallback") {
      assert.ok(
        spawn.containmentCause && typeof spawn.containmentCause === "object",
      );
      assert.ok(
        "type" in spawn.containmentCause &&
          "message" in spawn.containmentCause &&
          "code" in spawn.containmentCause,
      );
      assert.equal(spawn.containmentCause.type, "Error");
      assert.equal(
        spawn.containmentCause.message,
        "forced CreateJobObjectW failure",
      );
      assert.equal(spawn.containmentCause.code, "EACCES");
    } else assert.equal(spawn.containmentCause, undefined);
    assert.doesNotMatch(JSON.stringify(log.records), /seeded-private/);
  });
}
