import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApplication } from "../../src/application/application.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessDefaults,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import type {
  ChangeModelChoiceInput,
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
import {
  followRun,
  awaitRunRest,
  awaitSettled,
} from "../helpers/settleOperation.js";

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
    agentCalls: {
      available: false,
      evidence: "Native agent-call attachment is not qualified yet.",
    },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: false, evidence: "scripted fake" },
    // Selection unavailable by default ⇒ the fake admits any requested model
    // without validating it, so most cases exercise the carry, not the list.
    modelSelection,
    modelObservation: { available: true, evidence: "scripted fake" },
    modelChange: { reach: "next-turn", evidence: "scripted fake" },
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
  home: string;
} {
  const home = makeTempDir("secant-model-choice-home-");
  const captured = recording({
    ...completedScript("observed"),
    profile: profile(modelSelection),
    defaults,
  });
  const { wired, digest } = wire(
    t,
    captured.adapter,
    writeAgentBundle(),
    home,
    makeTempDir("secant-model-choice-ws-"),
  );
  return { wired, digest, requests: captured.requests, home };
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
    "the environment lock over a fallback with its reason",
    {
      kind: "fallback",
      choice: { model: "opus", effort: "medium" },
      reason: "Settings could not be read.",
      effortLock: { effort: "high", source: "CLAUDE_CODE_EFFORT_LEVEL=high" },
    },
    {
      choice: { model: "opus", effort: "high" },
      source: { kind: "fallback", reason: "Settings could not be read." },
      effortLock: { effort: "high", source: "CLAUDE_CODE_EFFORT_LEVEL=high" },
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

test("the next launch and a freshly opened Harness focus preselect the last choice", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  const first = await assess(
    wired,
    agentDraft(digest, { model: "beta", effort: "medium" }),
  );
  const admission = wired.projectionPort.submit({
    operationId: "first",
    operation: "launch-run",
    input: offeredDraft(first),
  });
  assert.ok(admission.admitted);
  await awaitSettled(wired.projectionPort, "first");
  const next = await assess(wired, agentDraft(digest));
  assert.equal(next.status, "ready");
  assert.deepEqual(next.draft.modelChoice, {
    model: "beta",
    effort: "medium",
    source: { kind: "last-choice" },
  });
  const focus = wired.projectionPort.openProjection({
    family: "harness-catalog",
    focus: { id: "claude-code" },
  });
  t.after(() => focus.close());
  assert.ok(focus.snapshot.result.found);
  assert.deepEqual(focus.snapshot.result.harness.preselection, {
    choice: { model: "beta", effort: "medium" },
    source: { kind: "last-choice" },
  });
});

for (const [encoded, reason] of [
  [
    JSON.stringify({ model: "retired", effort: "high" }),
    /retired is no longer offered/,
  ],
  [JSON.stringify({ model: "alpha", effort: "retired" }), /effort/],
  ["{broken", /could not read/],
  [JSON.stringify({ model: 42 }), /could not read/],
  [JSON.stringify({ model: "" }), /could not read/],
] as const) {
  test(`an unsupported or unreadable last choice (${encoded}) falls back with a notice and stays ready`, async (t) => {
    const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
    wired.catalog.setPreference("last-model-choice:claude-code", encoded);
    const assessed = await assess(wired, agentDraft(digest));
    assert.equal(assessed.status, "ready");
    assert.deepEqual(assessed.findings, []);
    assert.deepEqual(assessed.draft.modelChoice, {
      model: "alpha",
      effort: "high",
      source: { kind: "reported" },
    });
    assert.match(assessed.draft.preferenceNotice ?? "", reason);
    const focus = wired.projectionPort.openProjection({
      family: "harness-catalog",
      focus: { id: "claude-code" },
    });
    t.after(() => focus.close());
    assert.ok(focus.snapshot.result.found);
    assert.match(focus.snapshot.result.harness.preferenceNotice ?? "", reason);
    assert.deepEqual(focus.snapshot.result.harness.preselection?.choice, {
      model: "alpha",
      effort: "high",
    });
  });
}

test("a preference-only database read failure uses defaults with a notice", async (t) => {
  const { wired, digest, home } = wireDeclaring(t, LISTED, REPORTED);
  const database = new Database(join(home, "catalog.db"));
  t.after(() => database.close());
  database.exec("DROP TABLE preferences");
  const assessed = await assess(wired, agentDraft(digest));
  assert.equal(assessed.status, "ready");
  assert.equal(assessed.draft.modelChoice?.model, "alpha");
  assert.match(assessed.draft.preferenceNotice ?? "", /could not read/);
});

for (const event of ["INSERT", "UPDATE"] as const) {
  test(`a failed preference ${event} keeps the created Run and reports the unsaved choice on reopen`, async (t) => {
    const { wired, digest, home } = wireDeclaring(t, LISTED, REPORTED);
    if (event === "UPDATE")
      wired.catalog.setPreference(
        "last-model-choice:claude-code",
        JSON.stringify({ model: "alpha", effort: "low" }),
      );
    const database = new Database(join(home, "catalog.db"));
    t.after(() => database.close());
    database.exec(
      `CREATE TRIGGER fail_preference BEFORE ${event} ON preferences BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    const admission = wired.projectionPort.submit({
      operationId: "failed-save",
      operation: "launch-run",
      input: agentDraft(digest, { model: "beta", effort: "medium" }),
    });
    assert.ok(admission.admitted);
    assert.ok(admission.runId);
    assert.deepEqual(readRun(wired, admission.runId).modelChoice, {
      model: "beta",
      effort: "medium",
    });
    assert.match(
      readRun(wired, admission.runId).preferenceNotice ?? "",
      /active for this Run.*could not save/,
    );
    await awaitSettled(wired.projectionPort, "failed-save");
    assert.equal(readRun(wired, admission.runId).state, "succeeded");
    assert.match(
      readRun(wired, admission.runId).preferenceNotice ?? "",
      /could not save/,
    );
    const encoded = wired.catalog.getPreference(
      "last-model-choice:claude-code",
    );
    assert.equal(
      encoded,
      event === "INSERT"
        ? undefined
        : JSON.stringify({ model: "alpha", effort: "low" }),
    );
  });
}

test("two Applications sharing a home adopt the latest committed choice on their next launch, without live sync", async (t) => {
  const home = makeTempDir("secant-shared-choice-home-");
  const bundle = writeAgentBundle();
  const adapter = () =>
    createFake({
      ...completedScript("observed"),
      profile: profile(LISTED),
      defaults: REPORTED,
    })();
  const first = wire(
    t,
    adapter(),
    bundle,
    home,
    makeTempDir("secant-choice-ws-"),
  );
  const second = wire(
    t,
    adapter(),
    bundle,
    home,
    makeTempDir("secant-choice-ws-"),
  );
  const oldFocus = first.wired.projectionPort.openProjection({
    family: "harness-catalog",
    focus: { id: "claude-code" },
  });
  t.after(() => oldFocus.close());
  // Assessment settles the qualification held by the focus too.
  await assess(first.wired, agentDraft(first.digest));
  async function launch(
    wired: Wiring,
    digest: string,
    operationId: string,
    model: string,
    effort: string,
  ) {
    const admission = wired.projectionPort.submit({
      operationId,
      operation: "launch-run",
      input: agentDraft(digest, { model, effort }),
    });
    assert.ok(admission.admitted);
    await awaitSettled(wired.projectionPort, operationId);
  }
  await launch(first.wired, first.digest, "first-choice", "beta", "medium");
  assert.deepEqual(
    (await assess(second.wired, agentDraft(second.digest))).draft.modelChoice,
    { model: "beta", effort: "medium", source: { kind: "last-choice" } },
  );
  await launch(second.wired, second.digest, "second-choice", "alpha", "low");
  assert.deepEqual(
    (await assess(first.wired, agentDraft(first.digest))).draft.modelChoice,
    { model: "alpha", effort: "low", source: { kind: "last-choice" } },
  );
  const focus = first.wired.projectionPort.openProjection({
    family: "harness-catalog",
    focus: { id: "claude-code" },
  });
  t.after(() => focus.close());
  assert.ok(focus.snapshot.result.found);
  assert.deepEqual(focus.snapshot.result.harness.preselection?.choice, {
    model: "alpha",
    effort: "low",
  });
});

test("replaying a launch never overwrites a later saved choice", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  const input = agentDraft(digest, { model: "beta", effort: "medium" });
  assert.ok(
    wired.projectionPort.submit({
      operationId: "replayed",
      operation: "launch-run",
      input,
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "replayed");
  wired.catalog.setPreference(
    "last-model-choice:claude-code",
    JSON.stringify({ model: "gamma" }),
  );
  assert.ok(
    wired.projectionPort.submit({
      operationId: "replayed",
      operation: "launch-run",
      input,
    }).admitted,
  );
  assert.deepEqual(
    (await assess(wired, agentDraft(digest))).draft.modelChoice,
    { model: "gamma", source: { kind: "last-choice" } },
  );
});

for (const [label, selection, choice] of [
  ["suggested Other", SUGGESTED, { model: "custom-other", effort: "high" }],
  [
    "free text",
    {
      at: "launch",
      declaration: { kind: "free-text", efforts: ["low", "high"] },
      evidence: "scripted fake",
    },
    { model: "custom-free", effort: "low" },
  ],
  [
    "no selection declaration",
    { at: "unavailable", evidence: "scripted fake" },
    { model: "unchecked", effort: "custom" },
  ],
  ["no effort setting", LISTED, { model: "gamma" }],
] as const) {
  test(`the saved ${label} choice can preselect even without reported defaults`, async (t) => {
    const { wired, digest } = wireDeclaring(t, selection, {
      kind: "unavailable",
      reason: "No defaults.",
    });
    wired.catalog.setPreference(
      "last-model-choice:claude-code",
      JSON.stringify(choice),
    );
    const assessed = await assess(wired, agentDraft(digest));
    assert.equal(assessed.status, "ready");
    assert.deepEqual(assessed.draft.modelChoice, {
      ...choice,
      source: { kind: "last-choice" },
    });
  });
}

test("launching one Harness preserves the other Harness's last choice", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  const codex = JSON.stringify({ model: "codex-last", effort: "high" });
  wired.catalog.setPreference("last-model-choice:codex", codex);
  const before = await assess(wired, agentDraft(digest));
  assert.equal(before.draft.modelChoice?.source.kind, "reported");
  const launch = wired.projectionPort.submit({
    operationId: "claude-choice",
    operation: "launch-run",
    input: agentDraft(digest, { model: "beta", effort: "low" }),
  });
  assert.ok(launch.admitted);
  await awaitSettled(wired.projectionPort, launch.operationId);
  assert.equal(wired.catalog.getPreference("last-model-choice:codex"), codex);
  assert.deepEqual(
    (await assess(wired, agentDraft(digest))).draft.modelChoice,
    { model: "beta", effort: "low", source: { kind: "last-choice" } },
  );
});

test("a durable launch replay after reopening the Application preserves a newer last choice", async (t) => {
  const home = makeTempDir("secant-replay-choice-home-");
  const workspace = makeTempDir("secant-replay-choice-ws-");
  const bundle = writeAgentBundle();
  const adapter = () =>
    createFake({
      ...completedScript("observed"),
      profile: profile(LISTED),
      defaults: REPORTED,
    })();
  const first = wire(t, adapter(), bundle, home, workspace);
  const input = agentDraft(first.digest, { model: "beta", effort: "medium" });
  const admission = first.wired.projectionPort.submit({
    operationId: "durable-replay",
    operation: "launch-run",
    input,
  });
  assert.ok(admission.admitted);
  await awaitSettled(first.wired.projectionPort, "durable-replay");
  first.wired.catalog.setPreference(
    "last-model-choice:claude-code",
    JSON.stringify({ model: "gamma" }),
  );
  const reopened = wire(t, adapter(), bundle, home, workspace);
  const replay = reopened.wired.projectionPort.submit({
    operationId: "durable-replay",
    operation: "launch-run",
    input,
  });
  assert.ok(replay.admitted);
  assert.equal(replay.runId, admission.runId);
  await awaitSettled(reopened.wired.projectionPort, "durable-replay");
  assert.deepEqual(
    (await assess(reopened.wired, agentDraft(reopened.digest))).draft
      .modelChoice,
    { model: "gamma", source: { kind: "last-choice" } },
  );
});

const EFFORT_LOCK = { effort: "high", source: "CLAUDE_CODE_EFFORT_LEVEL=high" };
for (const requested of [
  undefined,
  { model: "beta" },
  { model: "beta", effort: "high" },
]) {
  test(`launch preserves the environment effort lock for ${JSON.stringify(requested)}`, async (t) => {
    const { wired, digest, requests } = wireDeclaring(t, LISTED, {
      kind: "reported",
      choice: { model: "alpha", effort: "low" },
      effortLock: EFFORT_LOCK,
    });
    const assessed = await assess(wired, agentDraft(digest, requested));
    assert.equal(assessed.status, "ready", JSON.stringify(assessed.findings));
    assert.deepEqual(assessed.draft.modelChoice, {
      model: requested?.model ?? "alpha",
      effort: "high",
      source: { kind: requested === undefined ? "reported" : "requested" },
      effortLock: EFFORT_LOCK,
    });
    const admission = wired.projectionPort.submit({
      operationId: "locked-launch",
      operation: "launch-run",
      input: offeredDraft(assessed),
    });
    assert.ok(admission.admitted);
    assert.ok(admission.runId);
    await awaitSettled(wired.projectionPort, "locked-launch");
    assert.deepEqual(readRun(wired, admission.runId).modelChoice, {
      model: requested?.model ?? "alpha",
      effort: "high",
    });
    assert.equal(requests[0]?.modelChoice?.effort, "high");
  });
}
test("launch refuses an effort contradicting the environment lock before creating a Run", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, {
    kind: "fallback",
    choice: { model: "alpha", effort: "medium" },
    reason: "Settings could not be read.",
    effortLock: EFFORT_LOCK,
  });
  const assessed = await assess(
    wired,
    agentDraft(digest, { model: "beta", effort: "low" }),
  );
  assert.equal(assessed.status, "not-ready");
  assert.deepEqual(assessed.actionOffers, []);
  assert.equal(assessed.findings[0]?.code, "effort-locked");
  assert.equal(assessed.findings[0]?.correction, "effort");
  assert.equal(
    assessed.findings[0]?.explanation,
    "Locked by CLAUDE_CODE_EFFORT_LEVEL=high. Change that setting outside Secant.",
  );
  assert.deepEqual(wired.runGroup.listRuns(), []);
});

for (const kind of ["reported", "fallback"] as const) {
  test(`the environment effort lock overlays the saved Model choice ahead of ${kind} defaults`, async (t) => {
    const defaults: HarnessDefaults =
      kind === "reported"
        ? {
            kind,
            choice: { model: "alpha", effort: "low" },
            effortLock: EFFORT_LOCK,
          }
        : {
            kind,
            choice: { model: "alpha", effort: "medium" },
            reason: "Settings could not be read.",
            effortLock: EFFORT_LOCK,
          };
    const { wired, digest, requests } = wireDeclaring(t, LISTED, defaults);
    wired.catalog.setPreference(
      "last-model-choice:claude-code",
      JSON.stringify({ model: "beta", effort: "medium" }),
    );
    const assessed = await assess(wired, agentDraft(digest));
    assert.equal(assessed.status, "ready");
    assert.deepEqual(assessed.draft.modelChoice, {
      model: "beta",
      effort: "high",
      source: { kind: "last-choice" },
      effortLock: EFFORT_LOCK,
    });
    const focus = wired.projectionPort.openProjection({
      family: "harness-catalog",
      focus: { id: "claude-code" },
    });
    t.after(() => focus.close());
    assert.ok(focus.snapshot.result.found);
    assert.deepEqual(focus.snapshot.result.harness.preselection, {
      choice: { model: "beta", effort: "high" },
      source: { kind: "last-choice" },
      effortLock: EFFORT_LOCK,
    });
    const refused = await assess(
      wired,
      agentDraft(digest, { effort: "medium" }),
    );
    assert.equal(refused.status, "not-ready");
    assert.equal(refused.findings[0]?.code, "effort-locked");
    assert.deepEqual(wired.runGroup.listRuns(), []);
    const admission = wired.projectionPort.submit({
      operationId: "saved-locked-launch",
      operation: "launch-run",
      input: offeredDraft(assessed),
    });
    assert.ok(admission.admitted);
    assert.ok(admission.runId);
    await awaitSettled(wired.projectionPort, "saved-locked-launch");
    assert.deepEqual(readRun(wired, admission.runId).modelChoice, {
      model: "beta",
      effort: "high",
    });
    assert.deepEqual(requests[0]?.modelChoice, {
      model: "beta",
      effort: "high",
    });
  });
}

test("model-choice-bounded-eligibility", async (t) => {
  for (const duringQualification of [
    "unchanged",
    "live",
    "terminal",
    "foreign",
    "choice",
    "terminal-before",
    "foreign-before",
  ] as const) {
    await t.test(duringQualification, async (t) => {
      const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
      const workspaceView = wired.projectionPort.openProjection({
        family: "workspace",
      });
      const workspace = workspaceView.snapshot.path;
      workspaceView.close();
      const home = makeTempDir("secant-bounded-choice-");
      const group = openFakeRunGroup(home, workspace, {
        selfPid: 1000,
        isOwnerAlive: () => true,
      });
      t.after(() => group.close());
      const foreign = openFakeRunGroup(home, workspace, {
        selfPid: 2000,
        isOwnerAlive: () => true,
      });
      t.after(() => foreign.close());
      const created = group.createRun({
        operationId: "seed",
        bundleSnapshotDigest: digest,
        launch: {},
        selectedHarness: "claude-code",
        modelChoice: { model: "alpha", effort: "high" },
        at: new Date(),
      });
      const seeded = group.acquireRun(created.runId);
      assert.ok(seeded);
      assert.ok(seeded.writeState("halted").ok);
      assert.ok(
        seeded.admitTurn({
          turnId: "historical-turn",
          attemptId: "0.0:write",
          session: "historical-session",
          origin: "managed",
          kind: "agent",
          recoveryCoordinate: "historical-native",
          input: "unrelated history",
          harness: "claude-code",
          at: new Date(),
        }).ok,
      );
      assert.ok(
        seeded.settleTurn({
          turnId: "historical-turn",
          session: "historical-session",
          resultKind: "completed",
          resultDetail: "{}",
          availability: "open",
          assistantContent: "unrelated transcript",
          at: new Date(),
        }).ok,
      );
      if (duringQualification === "live") {
        assert.ok(
          seeded.admitTurn({
            turnId: "current-turn",
            attemptId: "0.0:write",
            session: "current-session",
            origin: "managed",
            kind: "agent",
            recoveryCoordinate: "current-native",
            input: "current input",
            harness: "claude-code",
            at: new Date(),
          }).ok,
        );
        assert.ok(seeded.writeState("running").ok);
      } else assert.ok(seeded.release().ok);
      seeded.close();
      let bounded = false;
      let acquisitions = 0;
      let historyReads = 0;
      const observedGroup = {
        ...group,
        acquireRun(...args: Parameters<typeof group.acquireRun>) {
          if (bounded) acquisitions++;
          const owner = group.acquireRun(...args);
          if (owner === undefined) return undefined;
          return new Proxy(owner, {
            get(target, key, receiver) {
              if (
                bounded &&
                [
                  "attemptLog",
                  "turns",
                  "turnEvents",
                  "harnessSessions",
                  "transcript",
                  "transcriptPage",
                  "artifactNames",
                  "harnessEvidence",
                  "materializationConflicts",
                  "gateAnswers",
                ].includes(String(key))
              ) {
                return () => {
                  historyReads++;
                  throw new Error(
                    `Model-choice eligibility read unrelated ${String(key)}`,
                  );
                };
              }
              return Reflect.get(target, key, receiver);
            },
          });
        },
      };
      const qualifying = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let qualifications = 0;
      const app = createApplication({
        catalog: wired.catalog,
        process: fakeProcess(),
        launchWorkspacePath: workspace,
        runGroup: observedGroup,
        runExecution: () => {
          throw new Error("must not execute");
        },
        harnessRegistry: [
          {
            choice: {
              id: "claude-code",
              name: "Claude Code",
              availability: "available",
            },
            inputRules: [],
            servedCapabilities: [],
            discover: () => ({
              kind: "found",
              source: "configured",
              description: "fake",
            }),
            qualify: async () => {
              qualifications++;
              qualifying.resolve();
              await release.promise;
              return { ok: true, profile: profile(LISTED), defaults: REPORTED };
            },
          },
        ],
      });
      t.after(() => app.shutdown());
      const ordinary = app.projectionPort.openProjection({
        family: "run",
        runId: created.runId,
      });
      ordinary.close();
      assert.equal(qualifications, 0, "ordinary Run reads never qualify");
      const before = duringQualification.endsWith("-before");
      if (before) {
        const writer = (
          duringQualification === "foreign-before" ? foreign : group
        ).acquireRun(created.runId, { takeover: true });
        assert.ok(writer);
        if (duringQualification === "terminal-before")
          assert.ok(writer.writeState("succeeded").ok);
        writer.close();
      }
      const preparing = app.projectionPort.openProjection({
        family: "run",
        runId: created.runId,
        prepareModelChoice: true,
      });
      assert.ok(preparing.snapshot.result.found);
      const checking = preparing.snapshot.result.run.actionOffers.find(
        (offer) => offer.action === "change-model-choice",
      );
      assert.ok(
        checking?.action === "change-model-choice" && !checking.available,
      );
      assert.equal(
        checking.problem.code,
        before
          ? duringQualification === "terminal-before"
            ? "run-terminal"
            : "run-live-elsewhere"
          : "model-choice-checking",
      );
      preparing.close();
      if (!before) await qualifying.promise;
      bounded = true;
      const admission = app.projectionPort.submit({
        operationId: "bounded-change",
        operation: "change-model-choice",
        input: { runId: created.runId, effort: "low" },
      });
      assert.ok(admission.admitted);
      if (
        !before &&
        duringQualification !== "unchanged" &&
        duringQualification !== "live"
      ) {
        const writer = (
          duringQualification === "foreign" ? foreign : group
        ).acquireRun(created.runId, { takeover: true });
        assert.ok(writer);
        if (duringQualification === "terminal")
          assert.ok(writer.writeState("succeeded").ok);
        if (duringQualification === "choice")
          assert.ok(
            writer.changeModelChoice({ model: "beta", effort: "medium" }).ok,
          );
        writer.close();
      }
      release.resolve();
      const outcome = await awaitSettled(
        app.projectionPort,
        admission.operationId,
      );
      const refused =
        duringQualification === "terminal" ||
        duringQualification === "foreign" ||
        before;
      assert.equal(
        outcome.status,
        refused ? "not-applied" : "applied",
        JSON.stringify(outcome),
      );
      if (outcome.status === "not-applied")
        assert.equal(
          outcome.problem.code,
          duringQualification.startsWith("terminal")
            ? "run-terminal"
            : "run-live-elsewhere",
        );
      assert.equal(
        historyReads,
        0,
        "no history joins or transient Run Projection reads, including qualification and commit pushes",
      );
      assert.equal(
        acquisitions,
        refused ? 0 : 1,
        "only the existing write owner is acquired",
      );
      bounded = false;
      const final = app.projectionPort.openProjection({
        family: "run",
        runId: created.runId,
        prepareModelChoice: true,
      });
      assert.ok(final.snapshot.result.found);
      const offer = final.snapshot.result.run.actionOffers.find(
        (offer) => offer.action === "change-model-choice",
      );
      assert.ok(offer?.action === "change-model-choice");
      assert.equal(
        offer.available,
        !refused,
        "Offer and intent use identical eligibility",
      );
      if (!offer.available && outcome.status === "not-applied")
        assert.deepEqual(offer.problem, outcome.problem);
      if (offer.available) {
        assert.equal(offer.reach, "next-turn");
        assert.deepEqual(offer.currentChoice, {
          model: duringQualification === "choice" ? "beta" : "alpha",
          effort: "low",
        });
      }
      final.close();
      assert.equal(qualifications, before ? 0 : 1);
    });
  }
});

function seedChoiceRun(
  wired: Wiring,
  digest: string,
  state = "halted",
  choice: { model: string; effort?: string } | null = {
    model: "alpha",
    effort: "high",
  },
) {
  const created = wired.runGroup.createRun({
    operationId: `seed-${state}`,
    bundleSnapshotDigest: digest,
    launch: {},
    selectedHarness: "claude-code",
    ...(choice === null ? {} : { modelChoice: choice }),
    at: new Date(),
  });
  assert.equal(created.outcome, "created");
  const owner = wired.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  assert.ok(owner.writeState(state).ok);
  assert.ok(owner.release().ok);
  owner.close();
  return created.runId;
}

async function changeChoice(
  wired: Wiring,
  operationId: string,
  input: ChangeModelChoiceInput,
) {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "change-model-choice",
    input,
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  await awaitSettled(wired.projectionPort, operationId);
  const receipt = wired.projectionPort.openProjection({
    family: "operation",
    operationId,
  });
  try {
    return receipt.snapshot;
  } finally {
    receipt.close();
  }
}

test("[change-model-choice] an idle halted Run changes effort, retains its model, and pushes the observed choice", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  const runId = seedChoiceRun(wired, digest);
  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  t.after(() => opened.close());
  const receipt = await changeChoice(wired, "change-effort", {
    runId,
    effort: "low",
  });
  assert.equal(receipt.outcome.status, "applied", JSON.stringify(receipt));
  assert.deepEqual(receipt.modelChoiceChange, {
    choice: { model: "alpha", effort: "low" },
    reach: "next-turn",
  });
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "alpha",
    effort: "low",
  });
  for await (const update of opened.updates) {
    if (
      update.kind !== "durable" ||
      !update.snapshot.result.found ||
      update.snapshot.result.run.modelChoice?.effort !== "low"
    )
      continue;
    const offer = update.snapshot.result.run.actionOffers.find(
      (offer) => offer.action === "change-model-choice",
    );
    assert.ok(offer?.action === "change-model-choice" && offer.available);
    assert.deepEqual(offer.currentChoice, { model: "alpha", effort: "low" });
    assert.equal(offer.reach, "next-turn");
    assert.deepEqual(offer.modelDeclaration, LISTED.declaration);
    break;
  }
});

for (const state of [
  "created",
  "blocked",
  "failed",
  "halted",
  "succeeded",
  "cancelled",
]) {
  test(`[change-model-choice] ${state} admission follows open versus terminal Run legality`, async (t) => {
    const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
    const runId = seedChoiceRun(wired, digest, state);
    const receipt = await changeChoice(wired, "state-change", {
      runId,
      model: "beta",
    });
    const terminal = state === "succeeded" || state === "cancelled";
    assert.equal(receipt.outcome.status, terminal ? "not-applied" : "applied");
    if (receipt.outcome.status === "not-applied")
      assert.equal(receipt.outcome.problem.code, "run-terminal");
    assert.deepEqual(readRun(wired, runId).modelChoice, {
      model: terminal ? "alpha" : "beta",
      effort: "high",
    });
  });
}

test("[change-model-choice] incompatible effort resets to the declared default with the exact sentence", async (t) => {
  const selection: HarnessProfile["modelSelection"] = {
    at: "per-turn",
    evidence: "fake",
    declaration: {
      kind: "list",
      models: [
        {
          model: "alpha",
          label: "Alpha",
          efforts: EFFORTS,
          defaultEffort: "high",
        },
        {
          model: "delta",
          label: "Delta",
          efforts: ["low"],
          defaultEffort: "low",
        },
      ],
    },
  };
  const { wired, digest } = wireDeclaring(t, selection, REPORTED);
  const runId = seedChoiceRun(wired, digest);
  const receipt = await changeChoice(wired, "reset-effort", {
    runId,
    model: "delta",
  });
  assert.equal(receipt.outcome.status, "applied");
  assert.deepEqual(receipt.modelChoiceChange, {
    choice: { model: "delta", effort: "low" },
    reach: "next-turn",
    effortReset: {
      previous: "high",
      effort: "low",
      explanation:
        "delta does not offer high effort. Effort changed to low, its default.",
    },
  });
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "delta",
    effort: "low",
  });
});

test("[change-model-choice] invalid models and efforts refuse without changing Run or preference; models without effort clear it", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  const runId = seedChoiceRun(wired, digest);
  wired.catalog.setPreference(
    "last-model-choice:claude-code",
    JSON.stringify({ model: "beta", effort: "medium" }),
  );
  for (const [input, code] of [
    [{ model: "unknown" }, "requested-model-unavailable"],
    [{ effort: "unknown" }, "requested-effort-unavailable"],
    [{ model: "gamma", effort: "high" }, "requested-effort-unavailable"],
  ] as const) {
    const result = await changeChoice(
      wired,
      `refused-${code}-${input.model ?? "effort"}`,
      { runId, ...input },
    );
    assert.equal(result.outcome.status, "not-applied");
    if (result.outcome.status === "not-applied")
      assert.equal(result.outcome.problem.code, code);
    assert.deepEqual(readRun(wired, runId).modelChoice, {
      model: "alpha",
      effort: "high",
    });
    assert.equal(
      wired.catalog.getPreference("last-model-choice:claude-code"),
      JSON.stringify({ model: "beta", effort: "medium" }),
    );
  }
  const cleared = await changeChoice(wired, "clear-effort", {
    runId,
    model: "gamma",
  });
  assert.equal(cleared.outcome.status, "applied");
  assert.deepEqual(readRun(wired, runId).modelChoice, { model: "gamma" });
  assert.equal(
    cleared.modelChoiceChange?.effortReset?.explanation,
    "gamma does not offer an effort setting. Effort cleared.",
  );
});

test("[change-model-choice] an omitted effort that has no declared default requires a choice rather than inventing one", async (t) => {
  const selection: HarnessProfile["modelSelection"] = {
    at: "per-turn",
    evidence: "fake",
    declaration: {
      kind: "list",
      models: [
        { model: "alpha", label: "Alpha", efforts: EFFORTS },
        { model: "delta", label: "Delta", efforts: ["low"] },
      ],
    },
  };
  const { wired, digest } = wireDeclaring(t, selection, REPORTED);
  const runId = seedChoiceRun(wired, digest);
  const receipt = await changeChoice(wired, "no-default", {
    runId,
    model: "delta",
  });
  assert.equal(receipt.outcome.status, "not-applied");
  if (receipt.outcome.status === "not-applied")
    assert.equal(receipt.outcome.problem.code, "effort-choice-required");
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "alpha",
    effort: "high",
  });
});

test("[change-model-choice] suggested names remain open and the qualified lock survives a model change", async (t) => {
  const defaults: HarnessDefaults = {
    kind: "reported",
    choice: { model: "opus", effort: "low" },
    effortLock: { effort: "high", source: "opaque-setting" },
  };
  const { wired, digest } = wireDeclaring(t, SUGGESTED, defaults);
  const runId = seedChoiceRun(wired, digest, "halted", {
    model: "opus",
    effort: "high",
  });
  const changed = await changeChoice(wired, "locked-model", {
    runId,
    model: "organisation/model",
  });
  assert.equal(changed.outcome.status, "applied");
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "organisation/model",
    effort: "high",
  });
  const offer = readRun(wired, runId).actionOffers.find(
    (offer) => offer.action === "change-model-choice",
  );
  assert.ok(offer?.action === "change-model-choice" && offer.available);
  assert.deepEqual(offer.effortLock, {
    effort: "high",
    source: "opaque-setting",
  });
  const refused = await changeChoice(wired, "locked-effort", {
    runId,
    effort: "low",
  });
  assert.equal(refused.outcome.status, "not-applied");
  if (refused.outcome.status === "not-applied") {
    assert.equal(refused.outcome.problem.code, "effort-locked");
    assert.equal(refused.outcome.problem.correction, "effort");
    assert.equal(
      refused.outcome.problem.explanation,
      "Locked by opaque-setting. Change that setting outside Secant.",
    );
  }
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "organisation/model",
    effort: "high",
  });
});

test("[change-model-choice] failed preference save keeps the Run change and notice across reopen; replay preserves a newer preference", async (t) => {
  const { wired, digest, home } = wireDeclaring(t, LISTED, REPORTED);
  const runId = seedChoiceRun(wired, digest);
  const database = new Database(join(home, "catalog.db"));
  t.after(() => database.close());
  database.exec(
    "CREATE TRIGGER fail_choice BEFORE INSERT ON preferences BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  const first = await changeChoice(wired, "save-fails", {
    runId,
    effort: "low",
  });
  assert.equal(first.outcome.status, "applied");
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "alpha",
    effort: "low",
  });
  assert.match(
    readRun(wired, runId).preferenceNotice ?? "",
    /active for this Run.*could not save/,
  );
  database.exec("DROP TRIGGER fail_choice");
  wired.catalog.setPreference(
    "last-model-choice:claude-code",
    JSON.stringify({ model: "beta", effort: "medium" }),
  );
  assert.deepEqual(
    await changeChoice(wired, "save-fails", { runId, effort: "low" }),
    first,
  );
  assert.equal(
    wired.catalog.getPreference("last-model-choice:claude-code"),
    JSON.stringify({ model: "beta", effort: "medium" }),
  );
  const different = wired.projectionPort.submit({
    operationId: "save-fails",
    operation: "change-model-choice",
    input: { runId, effort: "medium" },
  });
  assert.ok(!different.admitted);
  assert.equal(different.problem.code, "operation-id-reused");
  await changeChoice(wired, "save-recovers", { runId, effort: "medium" });
  assert.equal(readRun(wired, runId).preferenceNotice, undefined);
  assert.equal(
    wired.catalog.getPreference("last-model-choice:claude-code"),
    JSON.stringify({ model: "alpha", effort: "medium" }),
  );
});

test("[change-model-choice] a legacy partial change uses declared defaults and never saved Preferences", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  const runId = seedChoiceRun(wired, digest, "halted", null);
  wired.catalog.setPreference(
    "last-model-choice:claude-code",
    JSON.stringify({ model: "beta", effort: "medium" }),
  );
  const result = await changeChoice(wired, "legacy-effort", {
    runId,
    effort: "low",
  });
  assert.equal(result.outcome.status, "applied");
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "alpha",
    effort: "low",
  });
});

test("[change-model-choice] an idle interactive Run and a fresh Repeat iteration send the changed choice on every later Turn", async (t) => {
  const folder = makeTempDir("secant-model-repeat-");
  mkdirSync(join(folder, "prompts"));
  writeFileSync(join(folder, "prompts", "go.md"), "Discuss the work.");
  const bundle = { folder, id: "dev.secant.choice-repeat" };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id: bundle.id,
        version: "1.0.0",
        name: "Choice Repeat",
        description: "Fresh Sessions",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [{ path: "prompts/go.md", kind: "prompt" }],
      routing: [
        {
          repeat: {
            control: "human",
            steps: [
              {
                id: "chat",
                kind: "interactive-agent",
                session: "fresh",
                entryTurn: true,
                prompt: { asset: "prompts/go.md" },
              },
            ],
          },
        },
      ],
    }),
  );
  const completed = completedScript("observed");
  const captured = recording({
    ...completed,
    turns: [...completed.turns, ...completed.turns],
    profile: profile(LISTED),
    defaults: REPORTED,
  });
  const { wired, digest } = wire(
    t,
    captured.adapter,
    bundle,
    makeTempDir("secant-repeat-home-"),
    makeTempDir("secant-repeat-ws-"),
  );
  const launched = wired.projectionPort.submit({
    operationId: "launch-repeat",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      trustDigest: digest,
      launchInputs: {},
      harness: "claude-code",
      requestedModel: "alpha",
      requestedEffort: "high",
    },
  });
  assert.ok(launched.admitted && launched.runId);
  const runId = launched.runId;
  await awaitSettled(wired.projectionPort, "launch-repeat");
  assert.equal(readRun(wired, runId).state, "blocked");
  const changed = await changeChoice(wired, "change-between-turns", {
    runId,
    model: "beta",
    effort: "medium",
  });
  assert.equal(changed.outcome.status, "applied");
  assert.ok(
    wired.projectionPort.submit({
      operationId: "human-next",
      operation: "send-interactive-turn",
      input: { runId, stepId: "chat", text: "Continue discussing." },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "human-next");
  await awaitRunRest(wired.projectionPort, runId);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "fresh-iteration",
      operation: "continue-repeat",
      input: { runId, stepId: "chat" },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "fresh-iteration");
  assert.equal(readRun(wired, runId).state, "blocked");
  assert.deepEqual(
    captured.requests.map((request) => request.modelChoice),
    [
      { model: "alpha", effort: "high" },
      { model: "beta", effort: "medium" },
      { model: "beta", effort: "medium" },
    ],
  );
  assert.notEqual(captured.requests[0]?.session, captured.requests[2]?.session);
  assert.deepEqual(startedTurns(readRun(wired, runId)), [
    {
      turnKind: "interactive-agent",
      requestedModel: "alpha",
      requestedEffort: "high",
    },
    {
      turnKind: "interactive-agent",
      requestedModel: "beta",
      requestedEffort: "medium",
    },
    {
      turnKind: "interactive-agent",
      requestedModel: "beta",
      requestedEffort: "medium",
    },
  ]);
  await wired.shutdown();
});

test("[change-model-choice] foreign live ownership is refused before qualification, and the Offer never fences its owner", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  const workspaceView = wired.projectionPort.openProjection({
    family: "workspace",
  });
  const workspace = workspaceView.snapshot.path;
  workspaceView.close();
  const store = makeTempDir("secant-choice-foreign-");
  const owning = openFakeRunGroup(store, workspace, {
    selfPid: 1000,
    isOwnerAlive: () => true,
  });
  t.after(() => owning.close());
  const created = owning.createRun({
    operationId: "foreign",
    bundleSnapshotDigest: digest,
    launch: {},
    selectedHarness: "claude-code",
    modelChoice: { model: "alpha", effort: "high" },
    at: new Date(),
  });
  const owner = owning.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.ok(owner.writeState("running").ok);
  const observing = openFakeRunGroup(store, workspace, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => observing.close());
  const app = createApplication({
    catalog: wired.catalog,
    process: fakeProcess(),
    launchWorkspacePath: workspace,
    runGroup: observing,
    runExecution: () => {
      throw new Error("must not execute");
    },
    harnessRegistry: [
      {
        choice: {
          id: "claude-code",
          name: "Claude Code",
          availability: "available",
        },
        inputRules: [],
        servedCapabilities: [],
        discover: () => ({
          kind: "found",
          source: "configured",
          description: "fake",
        }),
        qualify: async () => {
          throw new Error("must not qualify foreign Run");
        },
      },
    ],
  });
  const view = app.projectionPort.openProjection({
    family: "run",
    runId: created.runId,
    prepareModelChoice: true,
  });
  t.after(() => view.close());
  assert.ok(view.snapshot.result.found);
  const offer = view.snapshot.result.run.actionOffers.find(
    (candidate) => candidate.action === "change-model-choice",
  );
  assert.ok(offer?.action === "change-model-choice" && !offer.available);
  assert.equal(offer.problem.code, "run-live-elsewhere");
  const submitted = app.projectionPort.submit({
    operationId: "foreign-change",
    operation: "change-model-choice",
    input: { runId: created.runId, model: "beta" },
  });
  assert.ok(submitted.admitted);
  const outcome = await awaitSettled(app.projectionPort, submitted.operationId);
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied")
    assert.equal(outcome.problem.code, "run-live-elsewhere");
  assert.ok(
    owner.writeState("running").ok,
    "reading or refusing must never fence the foreign owner",
  );
  assert.deepEqual(owner.record.modelChoice, {
    model: "alpha",
    effort: "high",
  });
});

test("[change-model-choice] a change while a Turn works is admitted here, keeps that Turn's request, and reaches the next Turn", async (t) => {
  const complete = completedScript("observed").turns[0];
  assert.ok(complete);
  const captured = recording({
    profile: {
      ...profile(LISTED),
      interruption: { mode: "active-turn", evidence: "fake" },
    },
    defaults: REPORTED,
    turns: [complete, { ...complete, block: true }, complete],
  });
  const bundle = writeAgentThenInteractiveBundle();
  const { wired, digest } = wire(
    t,
    captured.adapter,
    bundle,
    makeTempDir("secant-choice-live-home-"),
    makeTempDir("secant-choice-live-ws-"),
  );
  t.after(() => wired.shutdown());
  const launched = wired.projectionPort.submit({
    operationId: "working-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "alpha",
      requestedEffort: "high",
    },
  });
  assert.ok(launched.admitted && launched.runId);
  const runId = launched.runId;
  const interrupt = await followRun(wired.projectionPort, runId, (run) => {
    const offer = run.actionOffers.find(
      (candidate) => candidate.action === "interrupt-turn",
    );
    return run.progress.find((step) => step.id === "chat")?.status ===
      "running" && offer?.action === "interrupt-turn"
      ? offer
      : undefined;
  });
  const result = await changeChoice(wired, "while-working", {
    runId,
    model: "beta",
    effort: "medium",
  });
  assert.equal(result.outcome.status, "applied");
  assert.equal(readRun(wired, runId).state, "running");
  assert.deepEqual(
    captured.requests.map((request) => request.modelChoice),
    [
      { model: "alpha", effort: "high" },
      { model: "alpha", effort: "high" },
    ],
  );
  assert.ok(
    wired.projectionPort.submit({
      operationId: "interrupt-working",
      operation: "interrupt-turn",
      input: { runId, turnId: interrupt.turnId },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "interrupt-working");
  await awaitSettled(wired.projectionPort, "working-launch");
  assert.ok(
    wired.projectionPort.submit({
      operationId: "next-human",
      operation: "send-interactive-turn",
      input: { runId, stepId: "chat", text: "Continue." },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "next-human");
  await awaitRunRest(wired.projectionPort, runId);
  assert.deepEqual(captured.requests.at(-1)?.modelChoice, {
    model: "beta",
    effort: "medium",
  });
  assert.equal(
    startedTurns(readRun(wired, runId)).at(-1)?.requestedModel,
    "beta",
  );
  await wired.shutdown();
});

// --- Live Model choice change (#348) -----------------------------------------

/** A Harness whose changes reach the live Turn, answering from the fake's script. */
const LIVE_REACH: HarnessProfile["modelChange"] = {
  reach: "live-turn",
  evidence: "scripted fake answers a live change",
};
const BETA_OBSERVED = {
  known: true,
  model: "beta-2026",
  effort: "medium",
} as const;

/** Launch the Agent-then-interactive Bundle on alpha at high effort against a
 *  live-reach fake whose interactive Entry Turn blocks with `entry` and whose
 *  next human Turn runs `next`, and resolve once the Entry Turn is live. Each
 *  live change the Harness receives resolves `reached`. */
async function liveChangeRun(
  t: TestContext,
  entry: Partial<FakeScript["turns"][number]>,
  next: Partial<FakeScript["turns"][number]> = {},
) {
  const complete = completedScript("observed").turns[0];
  assert.ok(complete);
  const requests: FakeTurnRequestRecord[] = [];
  const modelChanges: { model: string; effort?: string }[] = [];
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const record = modelChanges.push.bind(modelChanges);
  modelChanges.push = (...items) => {
    const length = record(...items);
    markReached();
    return length;
  };
  const adapter = createFake({
    profile: {
      ...profile(LISTED),
      interruption: { mode: "active-turn", evidence: "fake" },
      modelChange: LIVE_REACH,
    },
    defaults: REPORTED,
    turns: [
      complete,
      { ...complete, block: true, ...entry },
      { ...complete, ...next },
    ],
    turnRequests: requests,
    modelChanges,
  })();
  const bundle = writeAgentThenInteractiveBundle();
  const home = makeTempDir("secant-live-change-home-");
  const { wired, digest } = wire(
    t,
    adapter,
    bundle,
    home,
    makeTempDir("secant-live-change-ws-"),
  );
  t.after(() => wired.shutdown());
  const launched = wired.projectionPort.submit({
    operationId: "live-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "alpha",
      requestedEffort: "high",
    },
  });
  assert.ok(launched.admitted && launched.runId);
  const runId = launched.runId;
  const interrupt = await followRun(wired.projectionPort, runId, (run) => {
    const offer = run.actionOffers.find(
      (candidate) => candidate.action === "interrupt-turn",
    );
    return run.progress.find((step) => step.id === "chat")?.status ===
      "running" && offer?.action === "interrupt-turn"
      ? offer
      : undefined;
  });
  return {
    wired,
    runId,
    home,
    requests,
    modelChanges,
    reached,
    /** Interrupt the live Entry Turn and await the Run's rest. */
    async interrupt() {
      assert.ok(
        wired.projectionPort.submit({
          operationId: "live-interrupt",
          operation: "interrupt-turn",
          input: { runId, turnId: interrupt.turnId },
        }).admitted,
      );
      await awaitSettled(wired.projectionPort, "live-interrupt");
      await awaitSettled(wired.projectionPort, "live-launch");
    },
    /** Send the next human Turn and await its rest. */
    async nextTurn() {
      assert.ok(
        wired.projectionPort.submit({
          operationId: "live-next",
          operation: "send-interactive-turn",
          input: { runId, stepId: "chat", text: "Continue." },
        }).admitted,
      );
      await awaitSettled(wired.projectionPort, "live-next");
      await awaitRunRest(wired.projectionPort, runId);
    },
  };
}

function operationStatus(wired: Wiring, operationId: string) {
  const opened = wired.projectionPort.openProjection({
    family: "operation",
    operationId,
  });
  try {
    return opened.snapshot.outcome.status;
  } finally {
    opened.close();
  }
}

/** The `change-model-choice` Offer once explicit preparation has qualified it. */
async function changeOffer(wired: Wiring, runId: string) {
  const opened = wired.projectionPort.openProjection({
    family: "run",
    runId,
    prepareModelChoice: true,
  });
  const qualified = (snapshot: typeof opened.snapshot) => {
    if (snapshot.family !== "run" || !snapshot.result.found) return undefined;
    const offer = snapshot.result.run.actionOffers.find(
      (candidate) => candidate.action === "change-model-choice",
    );
    return offer?.action === "change-model-choice" &&
      (offer.available || offer.problem.code !== "model-choice-checking")
      ? offer
      : undefined;
  };
  try {
    const first = qualified(opened.snapshot);
    if (first !== undefined) return first;
    for await (const update of opened.updates) {
      if (update.kind !== "durable") continue;
      const offer = qualified(update.snapshot);
      if (offer !== undefined) return offer;
    }
    throw new Error("the Run Projection closed before qualifying");
  } finally {
    opened.close();
  }
}

test("[live-model-change] a change reaching the live Turn is pending until the Harness reports it, then applied", async (t) => {
  let report!: () => void;
  const reported = new Promise<void>((resolve) => {
    report = resolve;
  });
  const live = await liveChangeRun(t, {
    modelChange: {
      report: reported,
      answer: { outcome: "applied", observation: BETA_OBSERVED },
    },
  });
  const { wired, runId } = live;
  // The Offer's reach names the live Turn while one runs.
  const offer = await changeOffer(wired, runId);
  assert.ok(offer.available);
  assert.equal(offer.reach, "live-turn");

  assert.ok(
    wired.projectionPort.submit({
      operationId: "live-change",
      operation: "change-model-choice",
      input: { runId, model: "beta", effort: "medium" },
    }).admitted,
  );
  await live.reached;
  assert.deepEqual(
    [...live.modelChanges],
    [{ model: "beta", effort: "medium" }],
  );
  assert.equal(operationStatus(wired, "live-change"), "pending");
  const pendingReceipt = wired.projectionPort.openProjection({
    family: "operation",
    operationId: "live-change",
  });
  t.after(() => pendingReceipt.close());
  assert.equal(pendingReceipt.snapshot.modelChoiceChange, undefined);
  const receiptUpdate = pendingReceipt.updates[Symbol.asyncIterator]().next();
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "alpha",
    effort: "high",
  });
  assert.equal(
    wired.catalog.getPreference("last-model-choice:claude-code"),
    JSON.stringify({ model: "alpha", effort: "high" }),
  );

  report();
  const settled = await changeChoice(wired, "live-change", {
    runId,
    model: "beta",
    effort: "medium",
  });
  assert.equal(settled.outcome.status, "applied");
  assert.deepEqual(settled.modelChoiceChange, {
    choice: { model: "beta", effort: "medium" },
    reach: "live-turn",
  });
  assert.deepEqual(await receiptUpdate, {
    done: false,
    value: { kind: "durable", snapshot: settled },
  });
  const run = readRun(wired, runId);
  assert.deepEqual(run.modelChoice, { model: "beta", effort: "medium" });
  assert.equal(
    wired.catalog.getPreference("last-model-choice:claude-code"),
    JSON.stringify({ model: "beta", effort: "medium" }),
  );
  // The running Turn's effective model is what the Harness reported.
  assert.deepEqual(
    run.timeline
      .filter((event) => event.event === "effective-model")
      .map(({ effectiveModel, effectiveEffort }) => [
        effectiveModel,
        effectiveEffort,
      ])
      .at(-1),
    ["beta-2026", "medium"],
  );
  await live.interrupt();
  await live.nextTurn();
  assert.deepEqual(live.requests.at(-1)?.modelChoice, {
    model: "beta",
    effort: "medium",
  });
  await wired.shutdown();
});

test("[live-model-change] a second change waits for the pending one to settle", async (t) => {
  let report!: () => void;
  const reported = new Promise<void>((resolve) => {
    report = resolve;
  });
  const live = await liveChangeRun(t, {
    modelChange: {
      report: reported,
      answer: { outcome: "applied", observation: BETA_OBSERVED },
    },
  });
  const { wired, runId } = live;
  assert.ok(
    wired.projectionPort.submit({
      operationId: "first-change",
      operation: "change-model-choice",
      input: { runId, model: "beta", effort: "medium" },
    }).admitted,
  );
  await live.reached;
  const second = await changeChoice(wired, "second-change", {
    runId,
    effort: "low",
  });
  assert.equal(second.outcome.status, "not-applied");
  if (second.outcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(second.outcome.problem.code, "model-choice-change-pending");
  assert.equal(live.modelChanges.length, 1);
  report();
  const first = await changeChoice(wired, "first-change", {
    runId,
    model: "beta",
    effort: "medium",
  });
  assert.equal(first.outcome.status, "applied");
  // Once it settled, the next change resolves from the applied choice.
  const third = await changeChoice(wired, "third-change", {
    runId,
    effort: "low",
  });
  assert.equal(live.modelChanges.at(-1)?.model, "beta");
  assert.equal(live.modelChanges.at(-1)?.effort, "low");
  await live.interrupt();
  assert.equal(third.outcome.status, "applied");
  await wired.shutdown();
});

test("[live-model-change] a refused live change keeps the previous choice and says why", async (t) => {
  const live = await liveChangeRun(t, {
    modelChange: {
      answer: {
        outcome: "refused",
        reason: "beta is blocked by your organisation.",
        kept: { model: "alpha", effort: "high" },
        observation: { known: true, model: "alpha-2026", effort: "high" },
      },
    },
  });
  const { wired, runId } = live;
  const settled = await changeChoice(wired, "refused-change", {
    runId,
    model: "beta",
    effort: "medium",
  });
  assert.equal(live.modelChanges.length, 1);
  assert.equal(settled.outcome.status, "not-applied");
  if (settled.outcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(settled.outcome.problem.code, "model-choice-refused");
  assert.match(
    settled.outcome.problem.explanation,
    /beta is blocked by your organisation\./,
  );
  assert.match(settled.outcome.problem.explanation, /keeps alpha/);
  assert.equal(settled.modelChoiceChange, undefined);
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "alpha",
    effort: "high",
  });
  assert.equal(
    wired.catalog.getPreference("last-model-choice:claude-code"),
    JSON.stringify({ model: "alpha", effort: "high" }),
  );
  await live.interrupt();
  await live.nextTurn();
  assert.deepEqual(live.requests.at(-1)?.modelChoice, {
    model: "alpha",
    effort: "high",
  });
  await wired.shutdown();
});

test("[live-model-change] a live change the Turn ends before answering applies from the next Turn", async (t) => {
  const live = await liveChangeRun(t, {
    modelChange: {
      report: new Promise<void>(() => {}),
      answer: { outcome: "applied", observation: BETA_OBSERVED },
    },
  });
  const { wired, runId } = live;
  assert.ok(
    wired.projectionPort.submit({
      operationId: "unanswered-change",
      operation: "change-model-choice",
      input: { runId, model: "beta", effort: "medium" },
    }).admitted,
  );
  await live.reached;
  assert.equal(operationStatus(wired, "unanswered-change"), "pending");
  await live.interrupt();
  const settled = await changeChoice(wired, "unanswered-change", {
    runId,
    model: "beta",
    effort: "medium",
  });
  assert.equal(settled.outcome.status, "applied");
  assert.equal(settled.modelChoiceChange?.reach, "next-turn");
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "beta",
    effort: "medium",
  });
  await live.nextTurn();
  assert.deepEqual(live.requests.at(-1)?.modelChoice, {
    model: "beta",
    effort: "medium",
  });
  await wired.shutdown();
});

test("[live-model-change] a later Turn's refused request restores the choice its Session kept, with a notice", async (t) => {
  const live = await liveChangeRun(
    t,
    {},
    {
      events: [
        {
          kind: "model",
          observation: { known: true, model: "alpha-2026", effort: "high" },
          change: {
            requested: { model: "beta", effort: "medium" },
            outcome: "refused",
            reason: "Model 'beta' not found",
            kept: { model: "alpha", effort: "high" },
          },
        },
      ],
    },
  );
  const { wired, runId } = live;
  await live.interrupt();
  // Between Turns the change reaches only the next Turn's request.
  assert.equal((await changeOffer(wired, runId)).reach, "next-turn");
  const changed = await changeChoice(wired, "idle-change", {
    runId,
    model: "beta",
    effort: "medium",
  });
  assert.equal(changed.outcome.status, "applied");
  assert.equal(changed.modelChoiceChange?.reach, "next-turn");
  assert.deepEqual(readRun(wired, runId).modelChoice, {
    model: "beta",
    effort: "medium",
  });

  await live.nextTurn();
  assert.deepEqual(live.requests.at(-1)?.modelChoice, {
    model: "beta",
    effort: "medium",
  });
  const run = readRun(wired, runId);
  assert.deepEqual(run.modelChoice, { model: "alpha", effort: "high" });
  assert.equal(
    run.modelChoiceNotice,
    "Claude Code refused beta at medium effort: Model 'beta' not found. The Run keeps alpha at high effort.",
  );
  assert.equal(
    wired.catalog.getPreference("last-model-choice:claude-code"),
    JSON.stringify({ model: "alpha", effort: "high" }),
  );
  await wired.shutdown();
});

test("[change-model-choice] absent or blank values refuse admission without consuming the Operation id", async (t) => {
  const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
  const runId = seedChoiceRun(wired, digest);
  wired.catalog.setPreference(
    "last-model-choice:claude-code",
    JSON.stringify({ model: "beta", effort: "medium" }),
  );
  for (const input of [
    { runId },
    { runId, model: "" },
    { runId, effort: "  " },
  ]) {
    const refused = wired.projectionPort.submit({
      operationId: "reusable-change",
      operation: "change-model-choice",
      input,
    });
    assert.ok(!refused.admitted);
    assert.equal(
      refused.problem.code,
      input.model === undefined && input.effort === undefined
        ? "model-choice-change-required"
        : "model-choice-blank",
    );
    assert.deepEqual(readRun(wired, runId).modelChoice, {
      model: "alpha",
      effort: "high",
    });
    assert.equal(
      wired.catalog.getPreference("last-model-choice:claude-code"),
      JSON.stringify({ model: "beta", effort: "medium" }),
    );
  }
  assert.equal(
    (await changeChoice(wired, "reusable-change", { runId, effort: "low" }))
      .outcome.status,
    "applied",
  );
});

test("[change-model-choice] unknown and Command-only Runs refuse without choosing a model or saving Preferences", async (t) => {
  const { wired } = wireDeclaring(t, LISTED, REPORTED);
  const unknown = await changeChoice(wired, "unknown-change", {
    runId: "unknown",
    model: "alpha",
  });
  assert.equal(unknown.outcome.status, "not-applied");
  if (unknown.outcome.status === "not-applied")
    assert.equal(unknown.outcome.problem.code, "run-not-found");
  const bundle = writeCommandBundle();
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog
    .listEntries()
    .find((entry) => entry.id === bundle.id);
  assert.ok(entry);
  const created = wired.runGroup.createRun({
    operationId: "seed-command-change",
    bundleSnapshotDigest: entry.digest,
    launch: {},
    at: new Date(),
  });
  const owner = wired.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  assert.ok(owner.writeState("halted").ok);
  assert.ok(owner.release().ok);
  owner.close();
  const refused = await changeChoice(wired, "command-change", {
    runId: created.runId,
    model: "alpha",
  });
  assert.equal(refused.outcome.status, "not-applied");
  if (refused.outcome.status === "not-applied")
    assert.equal(refused.outcome.problem.code, "model-choice-irrelevant");
  assert.equal(readRun(wired, created.runId).modelChoice, undefined);
  assert.equal(
    wired.catalog.getPreference("last-model-choice:claude-code"),
    undefined,
  );
});

for (const registered of [true, false]) {
  test(`[change-model-choice] ${registered ? "failed qualification" : "missing registration"} refuses and finishes Offer preparation without changing choice`, async (t) => {
    const { wired, digest } = wireDeclaring(t, LISTED, REPORTED);
    const runId = seedChoiceRun(wired, digest);
    const workspace = readRun(wired, runId).workspacePath;
    wired.catalog.setPreference(
      "last-model-choice:claude-code",
      JSON.stringify({ model: "beta", effort: "medium" }),
    );
    const app = createApplication({
      catalog: wired.catalog,
      process: fakeProcess(),
      launchWorkspacePath: workspace,
      runGroup: wired.runGroup,
      runExecution: () => {
        throw new Error("must not drive");
      },
      harnessRegistry: registered
        ? [
            {
              choice: {
                id: "claude-code",
                name: "Claude Code",
                availability: "available",
              },
              inputRules: [],
              servedCapabilities: [],
              discover: () => ({
                kind: "found",
                source: "configured",
                description: "fake",
              }),
              qualify: async () => ({
                ok: false,
                failure: {
                  phase: "prepare",
                  category: "authentication",
                  possibleEffects: "none",
                },
              }),
            },
          ]
        : [],
    });
    const view = app.projectionPort.openProjection({
      family: "run",
      runId,
      prepareModelChoice: true,
    });
    t.after(() => view.close());
    const offer = await followRun(app.projectionPort, runId, (run) => {
      const offer = run.actionOffers.find(
        (candidate) => candidate.action === "change-model-choice",
      );
      return offer?.action === "change-model-choice" &&
        !offer.available &&
        offer.problem.code !== "model-choice-checking"
        ? offer
        : undefined;
    });
    assert.ok(!offer.available);
    assert.equal(offer.problem.code, "selected-harness-unavailable");
    const submitted = app.projectionPort.submit({
      operationId: "unqualified-change",
      operation: "change-model-choice",
      input: { runId, model: "beta" },
    });
    assert.ok(submitted.admitted);
    const outcome = await awaitSettled(
      app.projectionPort,
      submitted.operationId,
    );
    assert.equal(outcome.status, "not-applied");
    if (outcome.status === "not-applied")
      assert.equal(outcome.problem.code, "selected-harness-unavailable");
    assert.deepEqual(readRun(wired, runId).modelChoice, {
      model: "alpha",
      effort: "high",
    });
    assert.equal(
      wired.catalog.getPreference("last-model-choice:claude-code"),
      JSON.stringify({ model: "beta", effort: "medium" }),
    );
  });
}
