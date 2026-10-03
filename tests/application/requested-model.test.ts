import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessDefaults,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import type {
  HarnessFocus,
  HarnessFocusSnapshot,
  LaunchPreparationSnapshot,
  LaunchRunInput,
  RunView,
} from "../../src/application/projection-port.js";
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

// The Run's Model choice (ADR 0034) from launch through the Run Store, resume, and
// the Run view: launch preparation preselects it (the Harness-reported default,
// then the Adapter-declared fallback with its reason), resolves a draft's model and
// effort against the qualified Harness, and carries it on the `launch-run` Offer;
// the launched Run holds it, sends it on every Turn request and records it on each
// admitted Turn identically on launch and resume, it participates in idempotent
// replay identity, each half is refused as irrelevant for a Command-only Bundle, and
// it stays a separate fact from the observed effective model.
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
  const folder = makeTempDir("secant-model-choice-bundle-");
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
  const folder = makeTempDir("secant-model-choice-interactive-");
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
  const folder = makeTempDir("secant-model-choice-cmd-");
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

const AGENT_BUNDLE = "dev.secant.requested-model";

/** A launch draft for the single-Agent Bundle with the given Model choice. */
function agentDraft(
  digest: string,
  choice: { readonly model?: string; readonly effort?: string } = {},
): LaunchRunInput {
  return {
    bundle: { id: AGENT_BUNDLE },
    launchInputs: {},
    trustDigest: digest,
    harness: "claude-code",
    ...(choice.model !== undefined ? { requestedModel: choice.model } : {}),
    ...(choice.effort !== undefined ? { requestedEffort: choice.effort } : {}),
  };
}

/** Read the settled `launch-preparation` assessment of `draft`. */
async function assess(
  wired: Wiring,
  draft: LaunchRunInput,
): Promise<LaunchPreparationSnapshot> {
  const opened = wired.projectionPort.openProjection({
    family: "launch-preparation",
    draft,
  });
  try {
    if (opened.snapshot.status !== "assessing") return opened.snapshot;
    for await (const update of opened.updates) {
      if (update.kind === "durable" && update.snapshot.status !== "assessing") {
        return update.snapshot;
      }
    }
    throw new Error("launch-preparation closed before settling");
  } finally {
    opened.close();
  }
}

/** The `launch-run` Offer's draft of a ready assessment. */
function offeredDraft(snapshot: LaunchPreparationSnapshot): LaunchRunInput {
  const offer = snapshot.actionOffers.find(
    (candidate) => candidate.action === "launch-run",
  );
  assert.ok(offer && offer.action === "launch-run", JSON.stringify(snapshot));
  return offer.draft;
}

const EFFORTS = ["low", "medium", "high"] as const;

/** A `list` declaration: `alpha` offers three efforts and defaults to `low`,
 *  `beta` offers the same with no default of its own, `gamma` has no effort
 *  setting. */
const LISTED: HarnessProfile["modelSelection"] = {
  at: "launch",
  declaration: {
    kind: "list",
    models: [
      {
        model: "alpha",
        label: "Alpha",
        efforts: EFFORTS,
        defaultEffort: "low",
      },
      { model: "beta", label: "Beta", efforts: EFFORTS },
      { model: "gamma", label: "Gamma", efforts: [] },
    ],
  },
  evidence: "scripted fake",
};

/** A `suggested` declaration whose typed names take the declaration efforts. */
const SUGGESTED: HarnessProfile["modelSelection"] = {
  at: "launch",
  declaration: {
    kind: "suggested",
    models: [{ model: "opus", label: "Opus (latest)", efforts: EFFORTS }],
    efforts: ["low", "high"],
  },
  evidence: "scripted fake",
};

const REPORTED: HarnessDefaults = {
  kind: "reported",
  choice: { model: "alpha", effort: "high" },
};

/** Wire a recording fake that declares `modelSelection` and reports `defaults`. */
function wireDeclaring(
  t: TestContext,
  modelSelection: HarnessProfile["modelSelection"],
  defaults: HarnessDefaults,
): {
  wired: Wiring;
  digest: string;
  requests: FakeTurnRequestRecord[];
} {
  const captured = recording({
    ...completedScript("observed"),
    profile: profile(modelSelection),
    defaults,
  });
  const { wired, digest } = wire(
    t,
    captured.adapter,
    writeAgentBundle(),
    makeTempDir("secant-model-choice-home-"),
    makeTempDir("secant-model-choice-ws-"),
  );
  return { wired, digest, requests: captured.requests };
}

test("[model-choice-durability] a launch's model and effort are held on the Run, sent on the Turn request, recorded on its first Turn, projected beside the effective model, and survive reopen", async (t) => {
  const home = makeTempDir("secant-model-choice-home-");
  const workspace = makeTempDir("secant-model-choice-ws-");
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
    input: agentDraft(digest, { model: "requested-opus", effort: "high" }),
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);

  // Durable before the first Attempt: the choice is held on the record.
  const created = wired.runGroup.readRun(runId);
  assert.ok(created.ok);
  assert.deepEqual(created.run.modelChoice, {
    model: "requested-opus",
    effort: "high",
  });

  await awaitSettled(wired.projectionPort, "op-launch");

  assert.deepEqual(captured.requests, [
    { session: "s", modelChoice: { model: "requested-opus", effort: "high" } },
  ]);

  // Requested and effective stay distinct facts on the view; the run-level
  // `requestedModel` keeps naming the choice's model for older parsers.
  const run = readRun(wired, runId);
  assert.equal(run.state, "succeeded");
  assert.deepEqual(run.modelChoice, {
    model: "requested-opus",
    effort: "high",
  });
  assert.equal(run.requestedModel, "requested-opus");
  assert.equal(run.effectiveModel, "observed-sonnet");
  assert.deepEqual(startedTurns(run), [
    {
      turnKind: "agent",
      requestedModel: "requested-opus",
      requestedEffort: "high",
    },
  ]);

  // Reopened in a fresh process, the choice reads back unchanged.
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
  assert.deepEqual(reopenedRecord.run.modelChoice, created.run.modelChoice);
  const reopenedRun = readRun(reopened, runId);
  assert.deepEqual(reopenedRun.modelChoice, run.modelChoice);
  assert.deepEqual(startedTurns(reopenedRun), startedTurns(run));
});

test("each effective model and effort a Turn observes is recorded as a Turn event and projected per Turn, while the Run's effective model stays the settled result's (#345)", async (t) => {
  const home = makeTempDir("secant-effective-model-home-");
  const workspace = makeTempDir("secant-effective-model-ws-");
  const read = { known: true, model: "observed-sonnet", effort: "high" };
  const rerouted = { known: true, model: "observed-haiku", effort: "high" };
  const script: FakeScript = {
    profile: profile(),
    turns: [
      {
        // A reroute replaces the first observation; an unknown one records
        // nothing, and no effort is ever the request's.
        events: [
          { kind: "model", observation: { known: false } },
          { kind: "model", observation: read },
          { kind: "model", observation: { known: true, model: "no-effort" } },
          { kind: "model", observation: rerouted },
        ],
        result: {
          kind: "completed",
          detail: {
            finalContent: "done",
            effectiveModel: rerouted,
            session: { state: "open" },
          },
        },
      },
    ],
  };
  const { wired, digest } = wire(
    t,
    createFake(script)(),
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

  const run = readRun(wired, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.effectiveModel, "observed-haiku");
  const turnEntries = run.timeline.filter(
    (event) =>
      event.event === "turn-started" ||
      event.event === "effective-model" ||
      event.event === "turn-settled",
  );
  const scope = { step: "work", session: "s", sessionName: "s" };
  assert.deepEqual(
    turnEntries.map(({ at: _at, ...entry }) => entry),
    [
      {
        event: "turn-started",
        detail: "s",
        turnKind: "agent",
        requestedModel: "requested-opus",
        ...scope,
      },
      {
        event: "effective-model",
        detail: "observed-sonnet · high",
        effectiveModel: "observed-sonnet",
        effectiveEffort: "high",
        ...scope,
      },
      {
        event: "effective-model",
        detail: "no-effort",
        effectiveModel: "no-effort",
        ...scope,
      },
      {
        event: "effective-model",
        detail: "observed-haiku · high",
        effectiveModel: "observed-haiku",
        effectiveEffort: "high",
        ...scope,
      },
      {
        event: "turn-settled",
        detail: "completed",
        turnKind: "agent",
        ...scope,
      },
    ],
  );
});

test("[model-choice-durability] resume reuses the stored choice and never preselects again", async (t) => {
  const home = makeTempDir("secant-model-choice-home-");
  const workspace = makeTempDir("secant-model-choice-ws-");
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
    input: agentDraft(digest, { model: "requested-opus", effort: "low" }),
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  assert.equal(readRun(wired, runId).state, "failed");

  // Reopen with a Harness that now reports a different default and resume: the
  // resumed Turn requests the stored choice, not the new default.
  const captured = recording({
    ...completedScript("observed-later"),
    defaults: { kind: "reported", choice: { model: "other", effort: "max" } },
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
    { session: "s", modelChoice: { model: "requested-opus", effort: "low" } },
  ]);
  const run = readRun(reopened, runId);
  assert.equal(run.state, "succeeded");
  assert.deepEqual(run.modelChoice, { model: "requested-opus", effort: "low" });
  assert.deepEqual(
    startedTurns(run).map((turn) => [
      turn.requestedModel,
      turn.requestedEffort,
    ]),
    [
      ["requested-opus", "low"],
      ["requested-opus", "low"],
    ],
  );
});

test("an Agent Turn, an Interactive Entry Turn, and a human Turn each record the choice current at admission", async (t) => {
  const home = makeTempDir("secant-model-choice-home-");
  const workspace = makeTempDir("secant-model-choice-ws-");
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
      requestedEffort: "medium",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  assert.equal(readRun(wired, runId).state, "blocked");

  const sent = wired.projectionPort.submit({
    operationId: "op-turn",
    operation: "send-interactive-turn",
    input: { runId, stepId: "chat", text: "Carry on." },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, "op-turn");
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));

  const requested = { model: "requested-opus", effort: "medium" };
  assert.deepEqual(
    captured.requests.map((request) => request.modelChoice),
    [requested, requested, requested],
  );
  const run = await awaitRunRest(wired.projectionPort, runId);
  assert.deepEqual(
    startedTurns(run).map((turn) => [
      turn.turnKind,
      turn.requestedModel,
      turn.requestedEffort,
    ]),
    [
      ["agent", "requested-opus", "medium"],
      ["interactive-agent", "requested-opus", "medium"],
      ["interactive-agent", "requested-opus", "medium"],
    ],
  );
});

test("an Agent-bearing launch submitted without a model is refused model-choice-required, creating no Run", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  for (const choice of [{}, { effort: "high" }]) {
    const admission = wired.projectionPort.submit({
      operationId: `op-${JSON.stringify(choice)}`,
      operation: "launch-run",
      input: agentDraft(digest, choice),
    });
    assert.equal(admission.admitted, false, JSON.stringify(choice));
    if (admission.admitted) continue;
    assert.equal(admission.problem.code, "model-choice-required");
    assert.equal(admission.problem.correction, "model");
  }
  assert.deepEqual(wired.runGroup.listRuns(), []);
});

test("a model the Harness no longer lists fails the resumed Turn not-started, admitting no Turn", async (t) => {
  const home = makeTempDir("secant-model-choice-home-");
  const workspace = makeTempDir("secant-model-choice-ws-");
  const listing = (models: string[]): HarnessProfile["modelSelection"] => ({
    at: "launch",
    declaration: {
      kind: "list",
      models: models.map((model) => ({ model, label: model, efforts: [] })),
    },
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
    input: agentDraft(digest, { model: "listed-b" }),
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

test("a Command-only launch refuses a requested model and effort as irrelevant, leaving no Run", async (t) => {
  const { wired, digest } = wire(
    t,
    createFake(completedScript("observed"))(),
    writeCommandBundle(),
    makeTempDir("secant-model-choice-home-"),
    makeTempDir("secant-model-choice-ws-"),
  );
  const draft = (choice: {
    requestedModel?: string;
    requestedEffort?: string;
  }): LaunchRunInput => ({
    bundle: { id: "dev.secant.requested-model-cmd" },
    launchInputs: {},
    trustDigest: digest,
    ...choice,
  });

  const model = wired.projectionPort.submit({
    operationId: "op-model",
    operation: "launch-run",
    input: draft({ requestedModel: "requested-opus" }),
  });
  assert.equal(model.admitted, false);
  if (!model.admitted) {
    assert.equal(model.problem.code, "requested-model-irrelevant");
    assert.equal(model.problem.details?.model, "requested-opus");
  }
  const effort = wired.projectionPort.submit({
    operationId: "op-effort",
    operation: "launch-run",
    input: draft({ requestedEffort: "high" }),
  });
  assert.equal(effort.admitted, false);
  if (!effort.admitted) {
    assert.equal(effort.problem.code, "requested-effort-irrelevant");
    assert.equal(effort.problem.correction, "effort");
    assert.equal(effort.problem.details?.effort, "high");
  }

  // The assessment collects both in one pass and never qualifies.
  const assessed = await assess(
    wired,
    draft({ requestedModel: "requested-opus", requestedEffort: "high" }),
  );
  assert.equal(assessed.status, "not-ready");
  assert.deepEqual(
    assessed.findings.map((finding) => [finding.code, finding.correction]),
    [
      ["requested-model-irrelevant", "model"],
      ["requested-effort-irrelevant", "effort"],
    ],
  );
  assert.deepEqual(wired.runGroup.listRuns(), []);
});

test("the model and the effort each participate in idempotent replay identity", async (t) => {
  const { wired, digest } = wire(
    t,
    createFake(completedScript("observed"))(),
    writeAgentBundle(),
    makeTempDir("secant-model-choice-home-"),
    makeTempDir("secant-model-choice-ws-"),
  );
  const input = agentDraft(digest, { model: "requested-opus", effort: "high" });

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input,
  });
  assert.ok(admission.admitted, JSON.stringify(admission));

  // Same operation id and same choice: an idempotent replay, identical result.
  assert.deepEqual(
    wired.projectionPort.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input,
    }),
    admission,
  );

  // Same operation id with a different model, or only a different effort: a
  // conflict, because both are in the key.
  for (const different of [
    { ...input, requestedModel: "requested-different" },
    { ...input, requestedEffort: "low" },
  ]) {
    const conflict = wired.projectionPort.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input: different,
    });
    assert.equal(conflict.admitted, false, JSON.stringify(different));
    if (!conflict.admitted) {
      assert.equal(conflict.problem.code, "operation-id-reused");
    }
  }
  await awaitSettled(wired.projectionPort, "op-launch");
});

for (const [label, defaults, source] of [
  ["the Harness-reported default", REPORTED, { kind: "reported" }],
  [
    "the Adapter-declared fallback with its reason",
    {
      kind: "fallback",
      choice: { model: "alpha", effort: "high" },
      reason: "Settings were not read.",
    },
    { kind: "fallback", reason: "Settings were not read." },
  ],
] as const) {
  test(`a draft naming no model launches ${label}, and the Run and its first Turn record it`, async (t) => {
    const { wired, digest, requests } = wireDeclaring(t, LISTED, defaults);

    const assessed = await assess(wired, agentDraft(digest));
    assert.equal(assessed.status, "ready", JSON.stringify(assessed.findings));
    // The draft view says what launches and where it came from; the Offer's
    // draft carries the resolved choice in place of the absent one.
    assert.deepEqual(assessed.draft.modelChoice, {
      model: "alpha",
      effort: "high",
      source,
    });
    assert.equal(assessed.draft.requestedModel, undefined);
    const draft = offeredDraft(assessed);
    assert.equal(draft.requestedModel, "alpha");
    assert.equal(draft.requestedEffort, "high");

    const admission = wired.projectionPort.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input: draft,
    });
    assert.ok(admission.admitted, JSON.stringify(admission));
    assert.ok(admission.runId);
    await awaitSettled(wired.projectionPort, "op-launch");
    assert.deepEqual(requests, [
      { session: "s", modelChoice: { model: "alpha", effort: "high" } },
    ]);
    const run = readRun(wired, admission.runId);
    assert.deepEqual(run.modelChoice, { model: "alpha", effort: "high" });
    assert.deepEqual(
      startedTurns(run).map((turn) => [
        turn.requestedModel,
        turn.requestedEffort,
      ]),
      [["alpha", "high"]],
    );
  });
}

for (const [label, defaults, expected] of [
  [
    "the reported default",
    { kind: "reported", choice: { model: "opus", effort: "high" } },
    { choice: { model: "opus", effort: "high" }, source: { kind: "reported" } },
  ],
  [
    "the fallback with its reason",
    {
      kind: "fallback",
      choice: { model: "opus", effort: "medium" },
      reason: "Settings were not read.",
    },
    {
      choice: { model: "opus", effort: "medium" },
      source: { kind: "fallback", reason: "Settings were not read." },
    },
  ],
  [
    "nothing when the Harness reports nothing",
    { kind: "unavailable", reason: "Nothing is listed." },
    undefined,
  ],
] as const) {
  test(`the Harness focus carries ${label} as its preselection`, async (t) => {
    const { wired } = wireDeclaring(t, SUGGESTED, defaults);
    const opened = wired.projectionPort.openProjection({
      family: "harness-catalog",
      focus: { id: "claude-code" },
    });
    try {
      const harness = async (): Promise<HarnessFocus> => {
        const current = opened.snapshot as HarnessFocusSnapshot;
        if (
          current.result.found &&
          current.result.harness.qualification.state !== "not-checked"
        ) {
          return current.result.harness;
        }
        for await (const update of opened.updates) {
          if (update.kind !== "durable") continue;
          const settled = update.snapshot as HarnessFocusSnapshot;
          if (settled.result.found) return settled.result.harness;
        }
        throw new Error("the focus closed before it settled");
      };
      assert.deepEqual((await harness()).preselection, expected);
    } finally {
      opened.close();
    }
  });
}

test("a Harness that reports nothing to preselect refuses a draft with no model, naming why", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, {
    kind: "unavailable",
    reason: "No default model is listed.",
  });
  const assessed = await assess(wired, agentDraft(digest));
  assert.equal(assessed.status, "not-ready");
  assert.deepEqual(assessed.actionOffers, []);
  assert.equal(assessed.findings.length, 1);
  const [finding] = assessed.findings;
  assert.equal(finding?.code, "model-choice-required");
  assert.equal(finding?.correction, "model");
  assert.match(finding?.explanation ?? "", /No default model is listed\./);

  // A named model needs no preselection; with no preselected effort it takes the
  // model's own default.
  const named = await assess(wired, agentDraft(digest, { model: "alpha" }));
  assert.equal(named.status, "ready", JSON.stringify(named.findings));
  assert.deepEqual(named.draft.modelChoice, {
    model: "alpha",
    effort: "low",
    source: { kind: "requested" },
  });
});

// How an omitted half resolves, against the `list` above and the reported
// default `alpha` at `high`.
for (const [label, choice, expected] of [
  [
    "an effort alone takes the preselected model",
    { effort: "medium" },
    { model: "alpha", effort: "medium" },
  ],
  [
    "a model alone keeps the preselected effort it offers",
    { model: "beta" },
    { model: "beta", effort: "high" },
  ],
  [
    "a model with no effort setting takes none",
    { model: "gamma" },
    { model: "gamma" },
  ],
  [
    "both halves are taken as given",
    { model: "beta", effort: "low" },
    { model: "beta", effort: "low" },
  ],
] as const) {
  test(`launch preparation: ${label}`, async (t) => {
    const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
    const assessed = await assess(wired, agentDraft(digest, choice));
    assert.equal(assessed.status, "ready", JSON.stringify(assessed.findings));
    assert.deepEqual(assessed.draft.modelChoice, {
      ...expected,
      source: { kind: "requested" },
    });
    const draft = offeredDraft(assessed);
    assert.equal(draft.requestedModel, expected.model);
    assert.equal(
      draft.requestedEffort,
      "effort" in expected ? expected.effort : undefined,
    );
  });
}

test("launch preparation: a model alone takes its own default when the preselected effort is not offered", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, {
    kind: "reported",
    choice: { model: "gamma" },
  });
  const assessed = await assess(wired, agentDraft(digest, { model: "alpha" }));
  assert.equal(assessed.status, "ready", JSON.stringify(assessed.findings));
  assert.deepEqual(assessed.draft.modelChoice, {
    model: "alpha",
    effort: "low",
    source: { kind: "requested" },
  });
});

for (const [label, modelSelection, defaults, choice, code, correction] of [
  [
    "a model outside the list",
    LISTED,
    REPORTED,
    { model: "delta" },
    "requested-model-unavailable",
    "model",
  ],
  [
    "an effort the model does not offer",
    LISTED,
    REPORTED,
    { model: "alpha", effort: "max" },
    "requested-effort-unavailable",
    "effort",
  ],
  [
    "any effort for a model with no effort setting",
    LISTED,
    REPORTED,
    { model: "gamma", effort: "low" },
    "requested-effort-unavailable",
    "effort",
  ],
  [
    "a typed name outside the suggested efforts",
    SUGGESTED,
    REPORTED,
    { model: "exact-name", effort: "medium" },
    "requested-effort-unavailable",
    "effort",
  ],
  [
    "a model with no default when no preselected effort fits",
    LISTED,
    { kind: "reported", choice: { model: "gamma" } },
    { model: "beta" },
    "effort-choice-required",
    "effort",
  ],
] as const) {
  test(`launch preparation refuses ${label} before any Run exists`, async (t) => {
    const { wired, digest } = wireDeclaring(t, modelSelection, defaults);
    const assessed = await assess(wired, agentDraft(digest, choice));
    assert.equal(assessed.status, "not-ready");
    assert.deepEqual(assessed.actionOffers, []);
    assert.equal(assessed.draft.modelChoice, undefined);
    assert.deepEqual(
      assessed.findings.map((finding) => [finding.code, finding.correction]),
      [[code, correction]],
    );
    assert.deepEqual(wired.runGroup.listRuns(), []);
  });
}

test("a typed name outside the suggested picks takes the declaration's efforts", async (t) => {
  const { wired, digest } = wireDeclaring(t, SUGGESTED, {
    kind: "reported",
    choice: { model: "opus", effort: "high" },
  });
  const assessed = await assess(
    wired,
    agentDraft(digest, { model: "exact-name" }),
  );
  assert.equal(assessed.status, "ready", JSON.stringify(assessed.findings));
  assert.deepEqual(assessed.draft.modelChoice, {
    model: "exact-name",
    effort: "high",
    source: { kind: "requested" },
  });
});
