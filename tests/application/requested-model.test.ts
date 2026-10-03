import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import type { RunView } from "../../src/application/projection-port.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import {
  createFake,
  type FakeScript,
  type FakeTurnRequestRecord,
} from "../harness/fake-adapter.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";

// The requested model carried from launch through the Run Store, resume, and the Run
// view (#187): a model requested at launch is pinned immutably beside the selected
// Harness, sent on every Turn request and recorded on each admitted Turn (ADR 0034)
// identically on launch and resume with no fallback, participates in idempotent
// replay identity, is refused as irrelevant for a Command-only Bundle, and stays a
// separate fact from the observed effective model.
// Driven end to end through the composition wiring against the deterministic fake
// Adapter, so the durable behaviour — not just the pure codecs — is proven.

// One shared fake Git backs every wiring here, so a Run's Store commits made under one
// wiring read back after the same home is reopened in a fresh wiring (the reopen and
// resume cases), mirroring `openFakeRunGroup`.
const sharedGit = createFakeGitProcess();

function fakeProcess(): ProcessAdapter {
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: (options) => {
      const script = options.args[1] ?? "";
      const status = Number(/process\.exit\((\d+)\)/.exec(script)?.[1] ?? "0");
      return { kind: "exited", status, text: new Uint8Array() };
    },
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => sharedGit.spawnCommandSync(options),
  };
}

function profile(
  modelSelection: HarnessProfile["modelSelection"] = {
    at: "unavailable",
    evidence: "scripted fake",
  },
): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "/usr/bin/claude",
    executableVersion: "1.2.3",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: false, evidence: "scripted fake" },
    // Selection unavailable by default ⇒ the fake admits any requested model
    // without validating it, so most cases exercise the carry, not the list.
    modelSelection,
    modelObservation: { available: true, evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

/** A single-Turn script that completes; `model` is the observed effective model. */
function completedScript(model: string | undefined): FakeScript {
  return {
    profile: profile(),
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            finalContent: "done",
            effectiveModel:
              model !== undefined ? { known: true, model } : { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  };
}

/** A single-Turn script that fails, so the Run rests `failed` and is resumable. */
function failedScript(): FakeScript {
  return {
    profile: profile(),
    turns: [
      {
        result: {
          kind: "failed",
          detail: {
            failure: {
              phase: "turn",
              category: "native-failure",
              possibleEffects: "possible",
              diagnostics: "scripted failure",
            },
            effectiveModel: { known: false },
            session: { state: "detached", coordinate: { opaque: "s" } },
          },
        },
      },
    ],
  };
}

/** `script` recording each Turn request it receives into `requests`. */
function recording(script: FakeScript): {
  adapter: HarnessAdapter;
  requests: FakeTurnRequestRecord[];
} {
  const requests: FakeTurnRequestRecord[] = [];
  return {
    requests,
    adapter: createFake({ ...script, turnRequests: requests })(),
  };
}

/** Each `turn-started` timeline entry's Turn kind and requested Model choice. */
function startedTurns(run: RunView) {
  return run.timeline
    .filter((event) => event.event === "turn-started")
    .map(({ turnKind, requestedModel, requestedEffort }) => ({
      turnKind,
      requestedModel,
      requestedEffort,
    }));
}

function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-requested-model-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.requested-model",
      version: "1.0.0",
      name: "Requested Model E2E",
      description: "A single agent Step for the requested-model carry.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/go.md", kind: "prompt" }],
    routing: [
      {
        id: "work",
        kind: "agent",
        retry: 0,
        session: "s",
        prompt: { asset: "prompts/go.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

function writeAgentThenInteractiveBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-requested-model-interactive-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  writeFileSync(join(folder, "prompts", "chat.md"), "Discuss the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.requested-model-interactive",
      version: "1.0.0",
      name: "Requested Model Turns",
      description:
        "An Agent Step, then an interactive Step with an Entry Turn.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [
      { path: "prompts/go.md", kind: "prompt" },
      { path: "prompts/chat.md", kind: "prompt" },
    ],
    routing: [
      {
        id: "work",
        kind: "agent",
        retry: 0,
        session: "s",
        prompt: { asset: "prompts/go.md" },
      },
      {
        id: "chat",
        kind: "interactive-agent",
        session: "s",
        entryTurn: true,
        prompt: { asset: "prompts/chat.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

function writeCommandBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-requested-model-cmd-");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.requested-model-cmd",
      version: "1.0.0",
      name: "Command Only",
      description: "A single command Step, no Harness.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [],
    routing: [
      {
        id: "run",
        kind: "command",
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "process.exit(0)"],
        },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Wire against a home/workspace with the given Adapter, install the bundle, and
 *  approve the Workspace. Returns the wiring and the installed digest. */
function wire(
  t: TestContext,
  adapter: HarnessAdapter,
  bundle: { folder: string; id: string },
  home: string,
  workspace: string,
): { wired: Wiring; digest: string } {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    // The TUI's capability, so a Bundle with an interactive Step launches.
    supportsInteractiveTurns: true,
    process: fakeProcess(),
    harnessAdapter: adapter,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  return { wired, digest: entry.digest };
}

function readRun(wired: Wiring, runId: string): RunView {
  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return opened.snapshot.result.run;
  } finally {
    opened.close();
  }
}

test("[requested-model-durability] a requested model is pinned, sent on the Turn request, recorded on the Turn, projected beside the effective model, and survives reopen", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const captured = recording(completedScript("observed-sonnet"));
  const { wired, digest } = wire(
    t,
    captured.adapter,
    writeAgentBundle(),
    home,
    workspace,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.requested-model" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "requested-opus",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);

  // Durable before the first Attempt: the model is pinned on the record.
  const created = wired.runGroup.readRun(runId);
  assert.ok(created.ok);
  assert.equal(created.run.requestedModel, "requested-opus");

  await awaitSettled(wired.projectionPort, "op-launch");

  // Sent on the Turn request, with no effort: the Run carries none yet.
  assert.deepEqual(captured.requests, [
    { session: "s", modelChoice: { model: "requested-opus" } },
  ]);

  // Requested and effective stay distinct facts on the view, and the Turn records
  // the model it requested.
  const run = readRun(wired, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.requestedModel, "requested-opus");
  assert.equal(run.effectiveModel, "observed-sonnet");
  assert.notEqual(run.requestedModel, run.effectiveModel);
  assert.deepEqual(startedTurns(run), [
    {
      turnKind: "agent",
      requestedModel: "requested-opus",
      requestedEffort: undefined,
    },
  ]);

  // Reopened in a fresh process, the requested model reads back unchanged.
  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: createFake(completedScript("observed-sonnet"))(),
  });
  t.after(() => {
    reopened.runGroup.close();
    reopened.catalog.close();
  });
  const reopenedRecord = reopened.runGroup.readRun(runId);
  assert.ok(reopenedRecord.ok);
  assert.equal(reopenedRecord.run.requestedModel, "requested-opus");
  const reopenedRun = readRun(reopened, runId);
  assert.equal(reopenedRun.requestedModel, "requested-opus");
  assert.deepEqual(startedTurns(reopenedRun), startedTurns(run));
});

test("[requested-model-durability] resume reuses the stored model with no fallback", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const { wired, digest } = wire(
    t,
    createFake(failedScript())(),
    writeAgentBundle(),
    home,
    workspace,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.requested-model" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "requested-opus",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  assert.equal(readRun(wired, runId).state, "failed");

  // Reopen in a fresh process with a recording Adapter and resume (no model flag).
  const captured = recording(completedScript("observed-later"));
  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: captured.adapter,
  });
  t.after(() => {
    reopened.runGroup.close();
    reopened.catalog.close();
  });
  const resume = reopened.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  await awaitSettled(reopened.projectionPort, resume.operationId);

  // The resumed Turn requested the durable model, not a default, and both Turns
  // record it.
  assert.deepEqual(captured.requests, [
    { session: "s", modelChoice: { model: "requested-opus" } },
  ]);
  const run = readRun(reopened, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.requestedModel, "requested-opus");
  assert.deepEqual(
    startedTurns(run).map((turn) => turn.requestedModel),
    ["requested-opus", "requested-opus"],
  );
});

test("an Agent Turn, an Interactive Entry Turn, and a human Turn each record the model current at admission", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const completed = completedScript("observed-sonnet").turns[0]!;
  // Every prepare replays this script from its first Turn, so each Turn is the
  // same completion whichever prepared Harness serves it.
  const captured = recording({
    profile: profile(),
    turns: [completed, completed, completed],
  });
  const { wired, digest } = wire(
    t,
    captured.adapter,
    writeAgentThenInteractiveBundle(),
    home,
    workspace,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.requested-model-interactive" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "requested-opus",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  // The Agent Step ran, then the interactive Step's Entry Turn; the Run waits for
  // the human.
  assert.equal(readRun(wired, runId).state, "blocked");

  const sent = wired.projectionPort.submit({
    operationId: "op-turn",
    operation: "send-interactive-turn",
    input: { runId, stepId: "chat", text: "Carry on." },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, "op-turn");
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));

  const requested = { model: "requested-opus" };
  assert.deepEqual(
    captured.requests.map((request) => request.modelChoice),
    [requested, requested, requested],
  );
  const run = await awaitRunRest(wired.projectionPort, runId);
  assert.deepEqual(startedTurns(run), [
    {
      turnKind: "agent",
      requestedModel: "requested-opus",
      requestedEffort: undefined,
    },
    {
      turnKind: "interactive-agent",
      requestedModel: "requested-opus",
      requestedEffort: undefined,
    },
    {
      turnKind: "interactive-agent",
      requestedModel: "requested-opus",
      requestedEffort: undefined,
    },
  ]);
});

for (const [label, requestedModel] of [
  ["requested no model", undefined],
  ["stored an empty model", ""],
] as const) {
  test(`a Run that ${label} sends and records none on its Turn`, async (t) => {
    const home = makeTempDir("secant-requested-model-home-");
    const workspace = makeTempDir("secant-requested-model-ws-");
    const captured = recording(completedScript("observed-sonnet"));
    const { wired, digest } = wire(
      t,
      captured.adapter,
      writeAgentBundle(),
      home,
      workspace,
    );
    const admission = wired.projectionPort.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input: {
        bundle: { id: "dev.secant.requested-model" },
        launchInputs: {},
        trustDigest: digest,
        harness: "claude-code",
        ...(requestedModel !== undefined ? { requestedModel } : {}),
      },
    });
    assert.ok(admission.admitted, JSON.stringify(admission));
    assert.ok(admission.runId);
    await awaitSettled(wired.projectionPort, "op-launch");

    // An empty stored model is no request, so the Seam never sees an empty model.
    assert.deepEqual(captured.requests, [{ session: "s" }]);
    const run = readRun(wired, admission.runId);
    assert.equal(run.requestedModel, requestedModel);
    const started = run.timeline.find(
      (event) => event.event === "turn-started",
    );
    assert.ok(started);
    assert.equal("requestedModel" in started, false);
    assert.equal("requestedEffort" in started, false);
  });
}

test("a model the Harness no longer lists fails the resumed Turn not-started, admitting no Turn", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const listing = (models: string[]): HarnessProfile["modelSelection"] => ({
    at: "launch",
    declaration: { kind: "list", models },
    evidence: "scripted fake",
  });
  const { wired, digest } = wire(
    t,
    createFake({
      ...failedScript(),
      profile: profile(listing(["listed-a", "listed-b"])),
    })(),
    writeAgentBundle(),
    home,
    workspace,
  );
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.requested-model" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "listed-b",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  assert.equal(readRun(wired, runId).state, "failed");

  // The Harness has since dropped `listed-b`. The model is not a prepare option,
  // so the resume prepares; the Turn is refused before admission.
  const captured = recording({
    ...completedScript("observed-later"),
    profile: profile(listing(["listed-a"])),
  });
  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: captured.adapter,
  });
  t.after(() => {
    reopened.runGroup.close();
    reopened.catalog.close();
  });
  const resume = reopened.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  await awaitSettled(reopened.projectionPort, resume.operationId);

  assert.deepEqual(captured.requests, [
    { session: "s", modelChoice: { model: "listed-b" } },
  ]);
  const run = readRun(reopened, runId);
  // A not-started Turn fails the Agent Attempt like any other, here with no retry
  // budget left.
  assert.equal(run.state, "failed");
  assert.deepEqual(
    startedTurns(run).map((turn) => turn.requestedModel),
    ["listed-b"],
    "the refused Turn was never admitted",
  );
});

test("a Command-only launch refuses a requested model as irrelevant, leaving no Run", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const { wired, digest } = wire(
    t,
    createFake(completedScript("observed"))(),
    writeCommandBundle(),
    home,
    workspace,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.requested-model-cmd" },
      launchInputs: {},
      trustDigest: digest,
      requestedModel: "requested-opus",
    },
  });
  assert.equal(admission.admitted, false);
  if (!admission.admitted) {
    assert.equal(admission.problem.code, "requested-model-irrelevant");
    assert.equal(admission.problem.details?.model, "requested-opus");
  }
});

test("the requested model participates in idempotent replay identity", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const { wired, digest } = wire(
    t,
    createFake(completedScript("observed"))(),
    writeAgentBundle(),
    home,
    workspace,
  );
  const input = {
    bundle: { id: "dev.secant.requested-model" },
    launchInputs: {},
    trustDigest: digest,
    harness: "claude-code",
    requestedModel: "requested-opus",
  } as const;

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input,
  });
  assert.ok(admission.admitted, JSON.stringify(admission));

  // Same operation id and same model: an idempotent replay, identical result.
  const replay = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input,
  });
  assert.deepEqual(replay, admission);

  // Same operation id, different model: a conflict, because the model is in the key.
  const conflict = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: { ...input, requestedModel: "requested-different" },
  });
  assert.equal(conflict.admitted, false);
  if (!conflict.admitted) {
    assert.equal(conflict.problem.code, "operation-id-reused");
  }
  await awaitSettled(wired.projectionPort, "op-launch");
});
