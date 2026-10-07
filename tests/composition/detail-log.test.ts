import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { withClients } from "../../src/composition/main.js";
import type { ProjectionPort } from "../../src/application/projection-port.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  startPermissionBridge,
  type HarnessFailure,
  type TurnResult,
} from "../../src/harness/harness.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
} from "../harness/fake-adapter.js";
import {
  RUNTIME_NAME,
  writeGateBundle,
  writeMaterializationBundle,
} from "../helpers/commandBundle.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { assertBase, readLog, steppingClock } from "./log-sink.js";

// The opt-in detail mode (#325, spec #313 stories 27–29), driven through the
// headless client entry with Process and Harness doubles and read back from the
// JSONL the Secant invocation wrote. Detail is switched on only through the
// log-sink Seam's own `detail` field; nothing sets SECANT_LOG_DETAIL, which the
// compiled-binary smoke owns. The observers report every detail checkpoint
// every time; only the sink's level decides whether one is written. The fake
// Adapter scripts handshake steps whatever Harness it stands in for; only the
// Codex Adapter reports them in production, which phase conformance pins.

const COMPLETED: TurnResult = {
  kind: "completed",
  detail: {
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

const BUNDLE_ID = "dev.secant.detail-log";

/** A Bundle whose Routing runs a Command and then an Agent Step, so one Run
 *  reaches every Preflight check, Command and Agent Attempts, and a Turn. */
function writeBundle(prompt: string, argument: string): string {
  const folder = makeTempDir("secant-detail-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "work.md"), `${prompt}\n`);
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: BUNDLE_ID,
      version: "1.0.0",
      name: "Detail Log",
      description: "A Bundle the operational-log detail tests launch.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/work.md", kind: "prompt" }],
    routing: [
      {
        id: "prepare",
        kind: "command",
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", `console.log('${argument}')`],
        },
      },
      {
        id: "draft",
        kind: "agent",
        retry: 0,
        session: "planning",
        prompt: { asset: "prompts/work.md" },
      },
    ],
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  return folder;
}

interface LaunchOptions {
  readonly detail: boolean;
  readonly script: FakeScript;
  readonly bundle: string;
}

/** One headless Secant invocation over a fresh home that builds and trusts the
 *  Bundle, approves the Workspace, launches the Run, and awaits its rest; then
 *  its one log file. */
async function launchOnce(t: TestContext, options: LaunchOptions) {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const folder = join(makeTempDir("secant-detail-"), "logs");
  const workspace = makeTempDir("secant-detail-ws-");
  const status = await withClients(
    async ({ projectionPort, bundleManagement }) => {
      const built = bundleManagement.build(options.bundle, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      assert.ok(
        projectionPort.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      await launch(projectionPort, built.report.digest);
      return 0;
    },
    {
      secantHome: makeTempDir("secant-detail-home-"),
      launchCwd: workspace,
      engineVersion: "9.8.7",
      hostPlatform: "linux",
      process: createFakeBundleProcess({ executables: [process.execPath] }),
      // Each prepare hands the fake its phase observer.
      harnessAdapter: createFake(options.script)(),
      logSink: {
        folder,
        clock: steppingClock(),
        stderr: (text) => assert.fail(`unexpected log notice: ${text}`),
        detail: options.detail,
      },
    },
  );
  assert.equal(status, 0);
  const log = readLog(folder);
  assertBase(log.records);
  return log;
}

async function launch(port: ProjectionPort, digest: string): Promise<void> {
  const admission = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: BUNDLE_ID },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "fake-model",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  await awaitSettled(port, "op-launch");
}

/** A record without its base fields, its Run id replaced, so two Secant
 *  invocations' records of the same Run compare exactly. */
function semantic(
  record: Record<string, unknown>,
  runId: unknown,
): Record<string, unknown> {
  const { time: _time, invocationId: _id, ...rest } = record;
  return rest.runId === runId ? { ...rest, runId: "<run>" } : rest;
}

function runIdOf(records: readonly Record<string, unknown>[]): unknown {
  return records.find((record) => record.event === "run-start")?.runId;
}

const STEPS = ["protocol-initialize", "account-check", "model-list"] as const;

test("detail checkpoints are written with detail on and dropped with it off, for the same Run, leaving every other record unchanged", async (t) => {
  const bundle = writeBundle("draft the plan", "prepared");
  const script: FakeScript = {
    profile: fakeHarnessProfile(),
    turns: [{ result: COMPLETED }],
    handshakeSteps: STEPS,
  };
  const off = await launchOnce(t, { detail: false, script, bundle });
  const on = await launchOnce(t, { detail: true, script, bundle });
  const offRun = runIdOf(off.records);
  const onRun = runIdOf(on.records);
  assert.equal(typeof onRun, "string");

  // With detail off, no detail record is written and the start says nothing.
  assert.equal(
    off.records.some((record) => record.level === "debug"),
    false,
  );
  assert.equal("detail" in off.records[0]!, false);
  // With detail on, the start notes it, and every other record is the same.
  assert.equal(on.records[0]!.detail, true);
  assert.deepEqual(
    on.records
      .filter((record) => record.level !== "debug")
      .map((record) => semantic(record, onRun))
      .map(({ detail: _detail, ...rest }) => rest),
    off.records.map((record) => semantic(record, offRun)),
  );

  // Every detail record is debug, carries only semantic values, and names
  // each Preflight check, Run Store write, and Harness handshake step in order.
  const detail = on.records
    .filter((record) => record.level === "debug")
    .map((record) => semantic(record, onRun));
  const preflight = (check: string) => [
    { level: "debug", event: "preflight-check-start", check },
    {
      level: "debug",
      event: "preflight-check-settle",
      check,
      status: "passed",
    },
  ];
  const write = (fields: Record<string, string>) => [
    { level: "debug", event: "store-write-start", runId: "<run>", ...fields },
    {
      level: "debug",
      event: "store-write-end",
      runId: "<run>",
      ...fields,
      status: "committed",
    },
  ];
  const step = (name: string) => [
    {
      level: "debug",
      event: "harness-phase-start",
      runId: "<run>",
      harness: "claude-code",
      phase: "handshake",
      step: name,
    },
    {
      level: "debug",
      event: "harness-phase-end",
      runId: "<run>",
      harness: "claude-code",
      phase: "handshake",
      step: name,
      status: "ok",
      elapsedMs: 0,
    },
  ];
  const turn = detail.find((record) => record.write === "turn-admission");
  const turnId = String(turn?.turnId);
  const prepareAttempt = String(
    detail.find((record) => record.write === "attempt-publish")?.attemptId,
  );
  const draftAttempt = String(turn?.attemptId);
  assert.deepEqual(detail, [
    ...[
      "composition",
      "engine",
      "interactive",
      "harness",
      "inputs",
      "workspace-prerequisites",
      "commands",
    ].flatMap(preflight),
    // The Run's Harness is prepared before the walk starts.
    ...STEPS.flatMap(step),
    ...write({ write: "run-state", state: "running" }),
    ...write({ write: "attempt-publish", attemptId: prepareAttempt }),
    ...write({ write: "turn-admission", attemptId: draftAttempt, turnId }),
    ...write({ write: "turn-settlement", attemptId: draftAttempt, turnId }),
    // The last Step's Attempt rests the Run in its own transaction.
    ...write({
      write: "attempt-publish",
      attemptId: draftAttempt,
      state: "succeeded",
    }),
  ]);
  assert.notEqual(prepareAttempt, draftAttempt);
});

test("a failed handshake step is a detail record carrying only typed failure fields, and its handshake still warns", async (t) => {
  const failure: HarnessFailure = {
    phase: "prepare",
    category: "authentication",
    possibleEffects: "none",
    diagnostics: "seeded-diagnostics-8c1d",
  };
  const bundle = writeBundle("draft the plan", "prepared");
  const log = await launchOnce(t, {
    detail: true,
    bundle,
    script: {
      profile: fakeHarnessProfile(),
      turns: [],
      handshakeSteps: ["protocol-initialize", "account-check"],
      prepareFailure: failure,
    },
  });
  const handshake = log.records
    .filter((record) => record.phase === "handshake")
    .map((record) => [record.level, record.event, record.step, record.status]);
  assert.deepEqual(handshake, [
    ["info", "harness-phase-start", undefined, undefined],
    ["debug", "harness-phase-start", "protocol-initialize", undefined],
    ["debug", "harness-phase-end", "protocol-initialize", "ok"],
    ["debug", "harness-phase-start", "account-check", undefined],
    // The failed step is detail; its handshake carries the warning.
    ["debug", "harness-phase-end", "account-check", "failed"],
    ["warn", "harness-phase-end", undefined, "failed"],
  ]);
  const failedStep = log.records.find(
    (record) => record.step === "account-check" && record.status === "failed",
  )!;
  assert.equal(failedStep.failurePhase, "prepare");
  assert.equal(failedStep.category, "authentication");
  assert.equal(log.text.includes("seeded-diagnostics-8c1d"), false);
});

test("an assessment's refused check settles refused with its codes while later checks still run", async (t) => {
  // No Harness executable is configured, so the Harness check refuses.
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: undefined });
  const folder = join(makeTempDir("secant-detail-"), "logs");
  const workspace = makeTempDir("secant-detail-ws-");
  const bundle = writeBundle("draft the plan", "prepared");
  await withClients(
    async ({ projectionPort, bundleManagement }) => {
      const built = bundleManagement.build(bundle, { noInstall: false });
      assert.ok(built.ok, JSON.stringify(built));
      const admission = projectionPort.submit({
        operationId: "op-launch",
        operation: "launch-run",
        input: {
          bundle: { id: BUNDLE_ID },
          launchInputs: {},
          trustDigest: built.report.digest,
          harness: "claude-code",
          requestedModel: "fake-model",
        },
      });
      assert.equal(admission.admitted, false);
      return 0;
    },
    {
      secantHome: makeTempDir("secant-detail-home-"),
      launchCwd: workspace,
      engineVersion: "9.8.7",
      hostPlatform: "linux",
      process: createFakeBundleProcess(),
      harnessAdapter: createFake({
        profile: fakeHarnessProfile(),
        turns: [],
      })(),
      logSink: {
        folder,
        clock: steppingClock(),
        stderr: (text) => assert.fail(`unexpected log notice: ${text}`),
        detail: true,
      },
    },
  );
  const settles = readLog(folder)
    .records.filter((record) => record.event === "preflight-check-settle")
    .map(({ check, status, codes }) => ({ check, status, codes }));
  assert.deepEqual(
    settles.map((settle) => settle.check),
    [
      "composition",
      "engine",
      "interactive",
      "harness",
      "inputs",
      "workspace-prerequisites",
      "commands",
    ],
  );
  const harness = settles.find((settle) => settle.check === "harness")!;
  assert.equal(harness.status, "refused");
  assert.ok(Array.isArray(harness.codes) && harness.codes.length > 0);
  for (const settle of settles.filter((s) => s.check !== "harness")) {
    assert.deepEqual(settle, {
      check: settle.check,
      status: "passed",
      codes: undefined,
    });
  }
});

test("with detail on, seeded prompts, arguments, environment values, and a registered secret are still absent", async (t) => {
  const environment = "seeded-environment-value-6e02";
  const argument = "seeded-argument-f81b";
  const prompt = "seeded-prompt-1c5d";
  setEnvironmentForTest(t, { SECANT_DETAIL_SEEDED: environment });
  // A secret is registered the one way production registers one: by starting
  // the real in-process permission bridge, which spawns no child.
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  try {
    const bearer = bridge.session("test").bearer;
    // The bearer rides in the prompt the Turn admission carries, and in the
    // cause of a failed handshake step, a detail record with a cause.
    const bundle = writeBundle(`${prompt} ${bearer}`, argument);
    const ran = await launchOnce(t, {
      detail: true,
      bundle,
      script: {
        profile: fakeHarnessProfile(),
        turns: [{ result: COMPLETED }],
        handshakeSteps: STEPS,
      },
    });
    const refused = await launchOnce(t, {
      detail: true,
      bundle,
      script: {
        profile: fakeHarnessProfile(),
        turns: [],
        handshakeSteps: STEPS,
        prepareFailure: {
          phase: "prepare",
          category: "protocol-incompatible",
          possibleEffects: "none",
          diagnostics: `diagnostics ${bearer}`,
          cause: new Error(`native refusal ${bearer}`),
        },
      },
    });
    // The Turn admission and the failed step were both written.
    assert.ok(ran.records.some((record) => record.write === "turn-admission"));
    const failedStep = refused.records.find(
      (record) => record.step === "model-list" && record.status === "failed",
    );
    assert.ok(failedStep?.cause !== undefined);
    for (const text of [ran.text, refused.text]) {
      for (const seeded of [prompt, argument, environment, bearer]) {
        assert.equal(text.includes(seeded), false, `${seeded} reached the log`);
      }
    }
  } finally {
    await bridge.close();
  }
});

test("a Human Gate's pending-gate write, a Materialization conflict's write, and the Preflight a resume runs are detail checkpoints", async (t) => {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: undefined });
  const folder = join(makeTempDir("secant-detail-"), "logs");
  const workspace = realpathSync(makeTempDir("secant-detail-ws-"));
  const gate = writeGateBundle({ shape: "approve-reject" });
  const materialize = writeMaterializationBundle({
    workspaceAbsPath: workspace,
    tamper: "modify",
  });
  const runIds: Record<string, string> = {};
  await withClients(
    async ({ projectionPort: port, bundleManagement }) => {
      assert.ok(
        port.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      for (const [name, bundle] of [
        ["gate", gate],
        ["materialize", materialize],
      ] as const) {
        const built = bundleManagement.build(bundle.folder, {
          noInstall: false,
        });
        assert.ok(built.ok, JSON.stringify(built));
        const admission = port.submit({
          operationId: `op-launch-${name}`,
          operation: "launch-run",
          input: {
            bundle: { id: bundle.id },
            launchInputs: {},
            trustDigest: built.report.digest,
          },
        });
        assert.ok(admission.admitted && admission.runId);
        runIds[name] = admission.runId;
        await awaitSettled(port, `op-launch-${name}`);
      }
      // Restore the tampered copy, then resume: resume runs the
      // short-circuiting Preflight before it re-walks the Routing.
      writeFileSync(join(workspace, "out", "x.txt"), "materialized-content");
      const resumed = port.submit({
        operationId: "op-resume",
        operation: "resume-run",
        input: { runId: runIds.materialize! },
      });
      assert.ok(resumed.admitted, JSON.stringify(resumed));
      await awaitSettled(port, "op-resume");
      return 0;
    },
    {
      secantHome: makeTempDir("secant-detail-home-"),
      launchCwd: workspace,
      engineVersion: "9.8.7",
      hostPlatform: "linux",
      process: createFakeBundleProcess(),
      harnessAdapter: createFake({
        profile: fakeHarnessProfile(),
        turns: [],
      })(),
      logSink: {
        folder,
        clock: steppingClock(),
        stderr: (text) => assert.fail(`unexpected log notice: ${text}`),
        detail: true,
      },
    },
  );
  const records = readLog(folder).records;
  const writes = (runId: string) =>
    records
      .filter(
        (record) =>
          record.event === "store-write-end" && record.runId === runId,
      )
      .map(({ write, state, status }) => [write, state, status]);
  assert.deepEqual(writes(runIds.gate!), [
    ["run-state", "running", "committed"],
    ["attempt-publish", undefined, "committed"],
    ["pending-gate", undefined, "committed"],
    ["run-state", "blocked", "committed"],
  ]);
  const materialized = writes(runIds.materialize!);
  // The launch halts on the conflict; the resume re-walks to success.
  assert.deepEqual(materialized.slice(0, 4), [
    ["run-state", "running", "committed"],
    ["attempt-publish", undefined, "committed"],
    ["attempt-publish", undefined, "committed"],
    ["materialization-conflict", undefined, "committed"],
  ]);
  assert.deepEqual(materialized[4], ["run-state", "running", "committed"]);
  assert.deepEqual(materialized.at(-1), [
    "attempt-publish",
    "succeeded",
    "committed",
  ]);
  // Resume runs the short-circuiting Preflight before it admits the
  // Operation: after the last launch settles and before the resume's admission.
  const resumeAt = records.findIndex(
    (record) =>
      record.event === "operation-admission" &&
      record.operation === "resume-run",
  );
  const launchedAt =
    resumeAt -
    [...records.slice(0, resumeAt)]
      .reverse()
      .findIndex(
        (record) =>
          record.event === "operation-outcome" &&
          record.operation === "launch-run",
      );
  const resumeChecks = records
    .slice(launchedAt, resumeAt)
    .filter((record) => record.event === "preflight-check-settle")
    .map(({ check, status }) => [check, status]);
  assert.deepEqual(resumeChecks, [
    ["composition", "passed"],
    ["engine", "passed"],
    ["interactive", "passed"],
    ["harness", "passed"],
    ["inputs", "passed"],
    ["workspace-prerequisites", "passed"],
    ["commands", "passed"],
  ]);
});
