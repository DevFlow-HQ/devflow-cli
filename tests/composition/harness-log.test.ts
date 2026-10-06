import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withClients } from "../../src/composition/main.js";
import {
  createClaudeCodeAdapter,
  startPermissionBridge,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { assertBase, home, readLog } from "./log-sink.js";

// The Harness half of the operational log (#322, A15): each Harness's phase facts,
// its `CleanupReport`, and Turn usage, mapped field by field from an allowlist and
// read back from the JSONL a Secant invocation writes. A qualification's records
// belong to no Run; a Run's carry its `runId` (#333, pinned by the wiring suite's
// overlapping-Runs case).

const FAKE_PROFILE: HarnessProfile = {
  harness: "claude-code",
  executable: "/usr/bin/claude",
  executableVersion: "2.1.273 (Claude Code)",
  platform: "linux",
  adapterRevision: "fake-claude-1",
  configurationPosture: "user-compatible",
  recovery: { mode: "native-reattach", evidence: "scripted fake" },
  interruption: { mode: "process-only", evidence: "scripted fake" },
  approvals: { available: true, evidence: "scripted fake" },
  agentCalls: {
    available: false,
    evidence: "Native agent-call attachment is not qualified yet.",
  },
  clarifications: { available: false, evidence: "scripted fake" },
  steer: { available: false, evidence: "scripted fake" },
  modelSelection: { at: "unavailable", evidence: "scripted fake" },
  modelObservation: { available: true, evidence: "scripted fake" },
  modelChange: { reach: "next-turn", evidence: "scripted fake" },
  recoveryCoordinate: {
    timing: "before-submission",
    evidence: "scripted fake",
  },
  skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
  fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
};

/** Deterministic discovery, so qualification and Preflight reach the double
 *  without resolving an executable. */
const discoverClaudeCode = () =>
  ({
    kind: "found",
    attempt: {
      source: "path",
      name: "claude",
      description: "PATH name 'claude'",
    },
  }) as const;

/** Prepared Harness phases, usage and cleanup. Initial-preparation reports
 *  have independent conformance in preparation-lifetime.test.ts. The records, with the base fields every record carries
 *  (already pinned by `assertBase`) dropped. */
function harnessRecords(records: readonly Record<string, unknown>[]) {
  return records
    .filter(
      (record) =>
        String(record.event).startsWith("harness-") &&
        !String(record.event).startsWith("harness-preparation-"),
    )
    .map(({ time: _time, invocationId: _id, ...rest }) => rest);
}

test("a Harness qualification writes the double's phase facts and its CleanupReport, keeping only typed failure fields and a translated cause", async () => {
  const { folder, overrides } = home();
  // Every field a record must not carry is seeded, so its absence is checked.
  const script: FakeScript = {
    profile: FAKE_PROFILE,
    turns: [],
    cleanup: {
      clean: false,
      detail: "Session detached. stderr: seeded-detail-41c7",
      failure: {
        phase: "cleanup",
        category: "cleanup-timeout",
        possibleEffects: "possible",
        nativeCode: "143",
        partialOutput: "seeded-partial-9a20",
        retryEvidence: "seeded-retry-55e1",
        diagnostics: "seeded-diagnostics-c3d8",
        cause: new Error("the child was not reaped"),
      },
      sessions: [
        {
          session: "planning",
          availability: {
            state: "detached",
            coordinate: { opaque: "seeded-coordinate-7b3f" },
          },
        },
        {
          session: "review",
          availability: { state: "unusable", reason: "seeded-reason-2e6a" },
        },
      ],
    },
  };
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
    { ...overrides, discoverClaudeCode, harnessAdapter: createFake(script)() },
  );
  assert.equal(status, 0);

  const log = readLog(folder);
  assertBase(log.records);
  const failure = {
    failurePhase: "cleanup",
    category: "cleanup-timeout",
    possibleEffects: "possible",
    nativeCode: "143",
  };
  const records = harnessRecords(log.records);
  const cause = (record: Record<string, unknown>) =>
    record.cause as Record<string, unknown>;
  for (const record of records.filter((r) => r.cause !== undefined)) {
    assert.equal(cause(record).type, "Error");
    assert.equal(cause(record).message, "the child was not reaped");
    assert.match(String(cause(record).stack), /the child was not reaped/);
  }
  assert.deepEqual(
    records.map(({ cause: _cause, ...rest }) => rest),
    [
      {
        level: "info",
        event: "harness-phase-start",
        harness: "claude-code",
        phase: "launch",
      },
      {
        level: "info",
        event: "harness-phase-end",
        harness: "claude-code",
        phase: "launch",
        status: "ok",
        elapsedMs: 0,
      },
      {
        level: "info",
        event: "harness-phase-start",
        harness: "claude-code",
        phase: "handshake",
      },
      {
        level: "info",
        event: "harness-phase-end",
        harness: "claude-code",
        phase: "handshake",
        status: "ok",
        elapsedMs: 0,
      },
      {
        level: "info",
        event: "harness-phase-start",
        harness: "claude-code",
        phase: "cleanup",
      },
      {
        level: "warn",
        event: "harness-phase-end",
        harness: "claude-code",
        phase: "cleanup",
        status: "failed",
        elapsedMs: 0,
        ...failure,
      },
      {
        level: "warn",
        event: "harness-cleanup",
        harness: "claude-code",
        status: "unclean",
        sessions: [
          { session: "planning", availability: "detached" },
          { session: "review", availability: "unusable" },
        ],
        ...failure,
      },
    ],
  );
  assert.equal(
    records.filter((record) => record.cause !== undefined).length,
    2,
  );
  assert.doesNotMatch(log.text, /seeded-/);
});

test("a failed qualification handshake records the double's typed failure", async () => {
  const { folder, overrides } = home();
  await withClients(
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
      discoverClaudeCode,
      harnessAdapter: createFake({
        profile: FAKE_PROFILE,
        turns: [],
        prepareFailure: {
          phase: "prepare",
          category: "authentication",
          possibleEffects: "none",
          diagnostics: "seeded-diagnostics-0d4e",
        },
      })(),
    },
  );

  const records = harnessRecords(readLog(folder).records);
  assert.deepEqual(records.at(-1), {
    level: "warn",
    event: "harness-phase-end",
    harness: "claude-code",
    phase: "handshake",
    status: "failed",
    elapsedMs: 0,
    failurePhase: "prepare",
    category: "authentication",
    possibleEffects: "none",
  });
  // A prepare that failed has no Harness to close.
  assert.equal(
    records.some((record) => record.event === "harness-cleanup"),
    false,
  );
});

/** A one-Step Bundle folder: an Agent Step of `kind` in Session `s`. */
function writeAgentBundle(kind: "agent" | "interactive-agent" = "agent"): {
  folder: string;
  id: string;
} {
  const folder = makeTempDir("secant-oplog-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "fix.md"), "seeded-prompt-8f2a\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.oplog-agent",
      version: "1.0.0",
      name: "Oplog Agent",
      description: "One Agent Step for the operational log.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/fix.md", kind: "prompt" }],
    routing: [
      {
        id: "fix",
        kind,
        session: "s",
        retry: 0,
        prompt: { asset: "prompts/fix.md" },
      },
    ],
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  return { folder, id: manifest.bundle.id };
}

test("an Agent Run records its completed Turn's usage and the Run Harness's CleanupReport", async () => {
  const { folder, overrides } = home();
  const workspace = overrides.launchCwd!;
  let runId = "";
  const script: FakeScript = {
    profile: FAKE_PROFILE,
    turns: [
      {
        events: [{ kind: "assistant-content", content: "seeded-content-6c19" }],
        result: {
          kind: "completed",
          detail: {
            finalContent: "seeded-content-6c19",
            effectiveModel: { known: true, model: "claude-opus-5" },
            session: { state: "open" },
            usage: {
              estimate: true,
              summary: "input 12, output 34 tokens; cost estimate USD 0.5",
            },
          },
        },
      },
    ],
  };
  const status = await withClients(
    async (clients) => {
      const bundle = writeAgentBundle();
      const built = clients.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      const port = clients.projectionPort;
      assert.ok(
        port.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      await awaitSettled(port, "op-approve");
      const digest = built.report.digest;
      const admission = port.submit({
        operationId: "op-launch",
        operation: "launch-run",
        input: {
          bundle: { id: bundle.id },
          launchInputs: {},
          trustDigest: digest,
          harness: "claude-code",
          requestedModel: "fake-model",
        },
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      runId = admission.runId!;
      await awaitSettled(port, "op-launch");
      const run = await awaitRunRest(port, runId);
      assert.equal(run.state, "succeeded");
      return 0;
    },
    {
      ...overrides,
      process: createFakeBundleProcess(),
      discoverClaudeCode,
      harnessAdapter: createFake(script)(),
    },
  );
  assert.equal(status, 0);

  const log = readLog(folder);
  assertBase(log.records);
  const records = harnessRecords(log.records);
  assert.deepEqual(
    records.filter((record) => record.event === "harness-usage"),
    [
      {
        level: "info",
        event: "harness-usage",
        runId,
        harness: "claude-code",
        session: "s",
        estimate: true,
        summary: "input 12, output 34 tokens; cost estimate USD 0.5",
      },
    ],
  );
  // The Run's Harness closes after the Turn, and its report is recorded, all
  // attributed to the Run.
  const usageAt = records.findIndex((r) => r.event === "harness-usage");
  assert.deepEqual(records.slice(usageAt + 1), [
    {
      level: "info",
      event: "harness-phase-start",
      runId,
      harness: "claude-code",
      phase: "cleanup",
    },
    {
      level: "info",
      event: "harness-phase-end",
      runId,
      harness: "claude-code",
      phase: "cleanup",
      status: "ok",
      elapsedMs: 0,
    },
    {
      level: "info",
      event: "harness-cleanup",
      runId,
      harness: "claude-code",
      status: "clean",
      sessions: [],
    },
  ]);
  assert.doesNotMatch(log.text, /seeded-/);
});

test("an interactive Step's Turn usage and its driver's CleanupReport reach the log", async () => {
  const { folder, overrides } = home();
  const workspace = overrides.launchCwd!;
  let runId = "";
  const script: FakeScript = {
    profile: FAKE_PROFILE,
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            finalContent: "acknowledged",
            effectiveModel: { known: true, model: "claude-opus-5" },
            session: { state: "detached", coordinate: { opaque: "coord-s" } },
            usage: { estimate: true, summary: "input 1, output 2 tokens" },
          },
        },
      },
    ],
  };
  await withClients(
    async (clients) => {
      const port = clients.projectionPort;
      const bundle = writeAgentBundle("interactive-agent");
      const built = clients.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      assert.ok(
        port.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      await awaitSettled(port, "op-approve");
      const admission = port.submit({
        operationId: "op-launch",
        operation: "launch-run",
        input: {
          bundle: { id: bundle.id },
          launchInputs: {},
          trustDigest: built.report.digest,
          harness: "claude-code",
          requestedModel: "fake-model",
        },
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      runId = admission.runId!;
      await awaitSettled(port, "op-launch");
      assert.equal((await awaitRunRest(port, runId)).state, "blocked");
      assert.ok(
        port.submit({
          operationId: "op-turn",
          operation: "send-interactive-turn",
          input: { runId, stepId: "fix", text: "seeded-human-text-3b90" },
        }).admitted,
      );
      await awaitSettled(port, "op-turn");
      await awaitRunRest(port, runId);
      assert.ok(
        port.submit({
          operationId: "op-end",
          operation: "end-interactive-step",
          input: { runId, stepId: "fix" },
        }).admitted,
      );
      await awaitSettled(port, "op-end");
      assert.equal((await awaitRunRest(port, runId)).state, "succeeded");
      return 0;
    },
    {
      ...overrides,
      supportsInteractiveTurns: true,
      process: createFakeBundleProcess(),
      discoverClaudeCode,
      harnessAdapter: createFake(script)(),
    },
  );

  const log = readLog(folder);
  assertBase(log.records);
  const records = harnessRecords(log.records);
  const usageAt = records.findIndex((r) => r.event === "harness-usage");
  assert.deepEqual(records[usageAt], {
    level: "info",
    event: "harness-usage",
    runId,
    harness: "claude-code",
    session: "s",
    estimate: true,
    summary: "input 1, output 2 tokens",
  });
  // Ending the Step closes the driver that served the Turn: its report follows.
  assert.deepEqual(
    records
      .slice(usageAt + 1, usageAt + 4)
      .map((r) => [r.event, r.phase, r.runId]),
    [
      ["harness-phase-start", "cleanup", runId],
      ["harness-phase-end", "cleanup", runId],
      ["harness-cleanup", undefined, runId],
    ],
  );
  // Every Harness prepared in this invocation recorded its report exactly once.
  const count = (event: string, phase?: string) =>
    records.filter((r) => r.event === event && r.phase === phase).length;
  assert.ok(count("harness-phase-start", "launch") >= 2);
  assert.equal(
    count("harness-cleanup"),
    count("harness-phase-start", "launch"),
  );
  assert.doesNotMatch(log.text, /seeded-/);
});

test("a Claude Code failure crosses the Harness Seam into the log with its redacted type and cause chain", async () => {
  const { folder, overrides } = home();
  const workspace = overrides.launchCwd!;
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  const token = bridge.session("test").bearer;
  const inner = new RangeError(`inner ${token}`);
  inner.stack = `RangeError: inner ${token}`;
  const error = new TypeError(`launch ${token}`, { cause: inner });
  error.stack = `TypeError: launch ${token}`;
  const bundleProcess = createFakeBundleProcess({ executables: ["claude"] });
  const process = createFakeProcess({
    resolutionHandler: (name) => bundleProcess.resolveExecutable(name),
    commandHandler: (options) =>
      options.role === "harness-probe"
        ? {
            kind: "exited",
            status: 0,
            text: new TextEncoder().encode("2.1.234 (Claude Code)"),
          }
        : bundleProcess.spawnCommand(options),
    syncCommandHandler: (options) => bundleProcess.spawnCommandSync(options),
    ownedProcesses: [
      {
        kind: "launch-failure",
        failure: { ok: false, failure: { kind: "spawn-error", cause: error } },
      },
    ],
  });
  try {
    const status = await withClients(
      async (clients) => {
        const bundle = writeAgentBundle();
        const built = clients.bundleManagement.build(bundle.folder, {
          noInstall: false,
        });
        assert.ok(built.ok, JSON.stringify(built));
        const port = clients.projectionPort;
        assert.ok(
          port.submit({
            operationId: "op-approve",
            operation: "approve-workspace",
            input: { path: workspace },
          }).admitted,
        );
        await awaitSettled(port, "op-approve");
        const admission = port.submit({
          operationId: "op-launch",
          operation: "launch-run",
          input: {
            bundle: { id: bundle.id },
            launchInputs: {},
            trustDigest: built.report.digest,
            harness: "claude-code",
            requestedModel: "fake-model",
          },
        });
        assert.ok(admission.admitted, JSON.stringify(admission));
        await awaitSettled(port, "op-launch");
        assert.equal(
          (await awaitRunRest(port, admission.runId!)).state,
          "failed",
        );
        return 0;
      },
      {
        ...overrides,
        process,
        discoverClaudeCode,
        harnessAdapter: createClaudeCodeAdapter({ env: {} }),
      },
    );
    assert.equal(status, 0);
  } finally {
    await bridge.close();
  }
  const log = readLog(folder);
  assertBase(log.records);
  const failure = log.records.find(
    (record) =>
      record.event === "harness-phase-end" &&
      record.phase === "launch" &&
      record.status === "failed",
  );
  assert.ok(
    failure,
    "the native Adapter's failed launch reached the operational log",
  );
  assert.equal(failure.harness, "claude-code");
  assert.equal(failure.session, "s");
  assert.equal(failure.category, "spawn-error");
  assert.deepEqual(failure.cause, {
    type: "TypeError",
    message: "launch «redacted-bearer-token»",
    stack: "TypeError: launch «redacted-bearer-token»",
    cause: {
      type: "RangeError",
      message: "inner «redacted-bearer-token»",
      stack: "RangeError: inner «redacted-bearer-token»",
    },
  });
  assert.equal(log.text.includes(token), false);
});

test("a reopened interactive Step prepares, records usage, and closes its Harness under its Run", async () => {
  const launched = home();
  const workspace = launched.overrides.launchCwd!;
  const script: FakeScript = {
    profile: FAKE_PROFILE,
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            finalContent: "acknowledged",
            effectiveModel: { known: true, model: "claude-opus-5" },
            session: { state: "detached", coordinate: { opaque: "coord-s" } },
            usage: { estimate: true, summary: "input 1, output 2 tokens" },
          },
        },
      },
    ],
  };
  const overrides = {
    ...launched.overrides,
    supportsInteractiveTurns: true,
    process: createFakeBundleProcess(),
    discoverClaudeCode,
  };
  let runId = "";
  // The first invocation leaves the Run blocked at its interactive Step.
  await withClients(
    async (clients) => {
      const port = clients.projectionPort;
      const bundle = writeAgentBundle("interactive-agent");
      const built = clients.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      assert.ok(
        port.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      await awaitSettled(port, "op-approve");
      const admission = port.submit({
        operationId: "op-launch",
        operation: "launch-run",
        input: {
          bundle: { id: bundle.id },
          launchInputs: {},
          trustDigest: built.report.digest,
          harness: "claude-code",
          requestedModel: "fake-model",
        },
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      runId = admission.runId!;
      await awaitSettled(port, "op-launch");
      assert.equal((await awaitRunRest(port, runId)).state, "blocked");
      return 0;
    },
    { ...overrides, harnessAdapter: createFake(script)() },
  );
  // A later invocation reopens it: its Turn prepares a fresh Harness.
  const reopened = home();
  await withClients(
    async (clients) => {
      const port = clients.projectionPort;
      assert.ok(
        port.submit({
          operationId: "op-turn",
          operation: "send-interactive-turn",
          input: { runId, stepId: "fix", text: "seeded-human-text-5d21" },
        }).admitted,
      );
      await awaitSettled(port, "op-turn");
      assert.equal((await awaitRunRest(port, runId)).state, "blocked");
      assert.ok(
        port.submit({
          operationId: "op-end",
          operation: "end-interactive-step",
          input: { runId, stepId: "fix" },
        }).admitted,
      );
      await awaitSettled(port, "op-end");
      assert.equal((await awaitRunRest(port, runId)).state, "succeeded");
      return 0;
    },
    {
      ...overrides,
      harnessAdapter: createFake(script)(),
      logSink: reopened.overrides.logSink,
    },
  );

  // The reopened Turn's Harness, then the one that ends the Step: every record
  // the later invocation wrote belongs to the Run.
  const records = harnessRecords(readLog(reopened.folder).records);
  assert.deepEqual(
    records.filter((record) => record.runId !== runId),
    [],
  );
  assert.deepEqual(
    records.slice(0, 8).map((record) => [record.event, record.phase]),
    [
      ["harness-phase-start", "launch"],
      ["harness-phase-end", "launch"],
      ["harness-phase-start", "handshake"],
      ["harness-phase-end", "handshake"],
      ["harness-usage", undefined],
      ["harness-phase-start", "cleanup"],
      ["harness-phase-end", "cleanup"],
      ["harness-cleanup", undefined],
    ],
  );
});
