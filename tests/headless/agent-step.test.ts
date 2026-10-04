import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeCodeAdapter,
  type HarnessAdapter,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import type {
  RunTranscriptEntryView,
  RunView,
} from "../../src/application/projection-port.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { scriptedClaude } from "../harness/scripted-claude.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The first Agent Step executed headlessly (#116): a synthesized Bundle
// `command -> agent (session "s", prompt with a {{artifact:…}} file slot and a
// skill in `uses`) -> command`, launched through the composition wiring against a
// deterministic fake Adapter and a deterministic Process double (no child spawns,
// #185). Drives the Projection Port to rest `succeeded` and asserts the durable
// Turn view — the timeline kinds, the Session availability, the effective model,
// and the rendered transcript input — the headless `run show` renders.

// The effective model, executable version, and assistant content the fake Claude
// Code Adapter scripts, matching what the recorded plain-Turn fixture observed.
const PLAIN_EFFECTIVE_MODEL = "claude-opus-5";
const PLAIN_EXECUTABLE_VERSION = "2.1.273 (Claude Code)";
// The model the fake reports as its own default, and the one a direct launch
// submission names, since only launch preparation resolves a preselection.
const PLAIN_REPORTED_MODEL = "opus";

/** The deterministic Claude Code profile the fake Adapter reports for the plain
 *  Turn: the observed identity (#125) the Agent-step assertions read back — an
 *  observed `claude-code` name, a resolved executable, and the recorded version. */
function claudeCodeProfile(): HarnessProfile {
  return {
    harness: "claude-code",
    executable: "/usr/bin/claude",
    executableVersion: PLAIN_EXECUTABLE_VERSION,
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
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

/** A single-Turn plain script: it observes the effective model (as Claude Code does
 *  at init), emits authoritative assistant content, then settles `completed` with
 *  that model and an open Session — the timeline kinds, model, and Session
 *  availability the plain replayer produced. */
function plainScript(): FakeScript {
  return {
    profile: claudeCodeProfile(),
    // A flagless `run launch` starts from the Harness's reported Model choice.
    defaults: { kind: "reported", choice: { model: PLAIN_REPORTED_MODEL } },
    turns: [
      {
        events: [
          {
            kind: "model",
            observation: { known: true, model: PLAIN_EFFECTIVE_MODEL },
          },
          { kind: "assistant-content", content: "hello" },
        ],
        result: {
          kind: "completed",
          detail: {
            finalContent: "hello",
            effectiveModel: { known: true, model: PLAIN_EFFECTIVE_MODEL },
            session: { state: "open" },
          },
        },
      },
    ],
  };
}

function codexProfile(): HarnessProfile {
  return {
    harness: "Codex",
    executable: "/usr/bin/codex",
    executableVersion: "1.2.3",
    platform: "linux",
    adapterRevision: "fake-codex-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "active-turn", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    agentCalls: {
      available: false,
      evidence: "Native agent-call attachment is not qualified yet.",
    },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: true, evidence: "scripted fake" },
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    modelObservation: { available: true, evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

/** Author a `command -> agent -> command` Bundle folder: a `file` Launch input
 *  fills the prompt's `{{artifact:doc}}` slot, and a `skill` asset in the agent's
 *  `uses` appends a SKILL.md line. Command-only bookends run the runtime binary. */
function writeAgentBundle(repeated = false): { folder: string; id: string } {
  const folder = makeTempDir("secant-agent-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  mkdirSync(join(folder, "guide"), { recursive: true });
  writeFileSync(
    join(folder, "prompts", "fix.md"),
    "Repair the failing test in {{artifact:doc}}.\n",
  );
  writeFileSync(
    join(folder, "guide", "SKILL.md"),
    "# Repair guide\nFollow the repair playbook.\n",
  );
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.agent-e2e",
      version: "1.0.0",
      name: "Agent E2E",
      description:
        "A command -> agent -> command Bundle for the first Agent Step.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: { doc: { type: "file", description: "the file to repair" } },
    assets: [
      { path: "prompts/fix.md", kind: "prompt" },
      { path: "guide", kind: "skill" },
    ],
    routing: [
      {
        id: "before",
        kind: "command",
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "process.exit(0)"],
        },
      },
      {
        id: "fix",
        kind: "agent",
        session: "s",
        requires: ["doc"],
        prompt: { asset: "prompts/fix.md" },
        uses: [{ asset: "guide" }],
      },
      {
        id: "after",
        kind: "command",
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "process.exit(0)"],
        },
      },
    ],
  };
  if (repeated)
    manifest.routing.splice(2, 0, {
      id: "fix-again",
      kind: "agent",
      session: "second",
      requires: ["doc"],
      prompt: { asset: "prompts/fix.md" },
      uses: [{ asset: "guide" }],
    });
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Wire the Application against a temporary home and the deterministic fake Claude
 *  Code Adapter, install the Agent Bundle, and approve the Workspace. */
function wireAgent(
  t: TestContext,
  options: {
    adapter?: HarnessAdapter;
    process?: ProcessAdapter;
    repeated?: boolean;
  } = {},
): {
  wired: Wiring;
  bundleId: string;
  digest: string;
  docPath: string;
  home: string;
} {
  // A configured executable, declared to the Process double, so Agent-bearing
  // Preflight discovery passes without a spawn; the fake Adapter is what runs.
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });

  const workspace = makeTempDir("secant-agent-ws-");
  const home = makeTempDir("secant-agent-home-");
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    // A deterministic Process double: the Command bookends and the Run Store's Git
    // go through the fake, so no child spawns.
    process:
      options.process ??
      createFakeBundleProcess({ executables: [process.execPath] }),
    // The fake Adapter reproduces the plain Turn's observed identity and events.
    harnessAdapter: options.adapter ?? createFake(plainScript())(),
  });
  t.after(async () => {
    await wired.shutdown();
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeAgentBundle(options.repeated);
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);

  const approve = wired.projectionPort.submit({
    operationId: "op-approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approve.admitted);

  const docPath = join(makeTempDir("secant-agent-doc-"), "failing.test.ts");
  writeFileSync(docPath, "test('x', () => { throw new Error('fail'); });\n");

  return { wired, bundleId: bundle.id, digest: entry.digest, docPath, home };
}

async function launchAgentRun(
  t: TestContext,
  script?: FakeScript,
): Promise<{
  wired: Wiring;
  runId: string;
  run: RunView;
  docPath: string;
}> {
  const { wired, bundleId, digest, docPath } = wireAgent(
    t,
    script !== undefined ? { adapter: createFake(script)() } : {},
  );
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundleId },
      launchInputs: { doc: docPath },
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: PLAIN_REPORTED_MODEL,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");

  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return { wired, runId, run: opened.snapshot.result.run, docPath };
  } finally {
    opened.close();
  }
}

test("[both-client-harness-selection] headless launch requires and accepts the shared semantic Harness choice", async (t) => {
  const { wired, bundleId, digest, docPath } = wireAgent(t);
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: () => process.cwd(),
  };
  const base = [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
    "--input",
    `doc=${docPath}`,
  ];

  assert.equal(await runHeadless(wired, base, io), 1);
  assert.match(err.join(""), /harness-selection-required/);
  err.length = 0;

  assert.equal(
    await runHeadless(wired, base.concat("--harness", "gemini"), io),
    1,
  );
  assert.match(err.join(""), /harness-selection-unknown/);
  err.length = 0;

  const selectedCode = await runHeadless(
    wired,
    base.concat("--harness", "claude-code"),
    io,
  );
  assert.equal(selectedCode, 0, `${out.join("")}\n${err.join("")}`);
  const runId = /^Run (\S+)$/m.exec(out.join(""))?.[1];
  assert.ok(runId);
  const record = wired.runGroup.readRun(runId);
  assert.ok(record.ok);
  assert.equal(record.run.selectedHarness, "claude-code");
});

test("[selected-versus-observed-evidence] headless distinguishes durable selection before and after observed execution", async (t) => {
  const workspace = makeTempDir("secant-headless-codex-ws-");
  const successful = createFake({
    profile: codexProfile(),
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            finalContent: "done",
            effectiveModel: { known: true, model: "gpt-6" },
            session: { state: "open" },
          },
        },
      },
    ],
  })();
  // The first prepare is launch preparation's qualification; the second, the
  // launch drive's, refuses, and the resume's third succeeds.
  let prepareCount = 0;
  const adapter: HarnessAdapter = {
    async prepare(options) {
      prepareCount++;
      if (prepareCount === 2) {
        return {
          ok: false,
          failure: {
            phase: "prepare",
            category: "authentication",
            possibleEffects: "none",
            nativeCode: "login-required",
            retryEvidence: "safe after separate login",
            diagnostics: "Codex is not authenticated.",
          },
        };
      }
      return successful.prepare(options);
    },
  };
  const wired = wireApplication({
    secantHome: makeTempDir("secant-headless-codex-home-"),
    launchCwd: workspace,
    process: createFakeBundleProcess(),
    codexHarnessAdapter: adapter,
    discoverCodex: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "codex",
        description: "PATH name 'codex'",
      },
    }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const bundle = writeAgentBundle();
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((candidate) => {
    return candidate.id === bundle.id;
  });
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "approve-headless-codex",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const docPath = join(makeTempDir("secant-codex-doc-"), "failing.test.ts");
  writeFileSync(docPath, "test('x', () => {});\n");
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: () => workspace,
  };

  const launchCode = await runHeadless(
    wired,
    [
      "run",
      "launch",
      bundle.id,
      "--trust",
      entry.digest,
      "--input",
      `doc=${docPath}`,
      "--harness",
      "codex",
      "--model",
      "gpt-6",
      "--json",
    ],
    io,
  );
  assert.equal(launchCode, 1, err.join(""));
  const problem = JSON.parse(out.join(""));
  assert.equal(problem.code, "selected-harness-unavailable");
  assert.equal(problem.details.harness, "codex");
  assert.equal(problem.details.nativeCode, "login-required");
  const runId = problem.details.runId;
  assert.equal(typeof runId, "string");
  out.length = 0;
  err.length = 0;

  const showFailureCode = await runHeadless(wired, ["run", "show", runId], io);
  assert.equal(showFailureCode, 0, err.join(""));
  const failedShow = out.join("");
  assert.match(failedShow, /Selected Harness: codex/);
  assert.doesNotMatch(failedShow, /Observed Harness:/);
  assert.doesNotMatch(failedShow, /Observed executable:/);
  assert.doesNotMatch(failedShow, /Observed version:/);
  assert.doesNotMatch(failedShow, /Observed effective model:/);
  out.length = 0;
  err.length = 0;

  const resumeCode = await runHeadless(
    wired,
    ["run", "resume", runId, "--json"],
    io,
  );
  assert.equal(resumeCode, 0, err.join(""));
  const snapshot = JSON.parse(out.join(""));
  assert.equal(snapshot.family, "run");
  assert.equal(snapshot.runId, runId);
  assert.equal(snapshot.result.found, true);
  assert.equal(snapshot.result.run.state, "succeeded");
  assert.ok(Array.isArray(snapshot.result.run.progress));
  assert.ok(Array.isArray(snapshot.result.run.timeline));
  assert.ok(Array.isArray(snapshot.result.run.outputs));
  assert.ok(Array.isArray(snapshot.result.run.actionOffers));
  assert.equal(snapshot.result.run.selectedHarness, "codex");
  assert.equal(snapshot.result.run.harness.name, "Codex");
  const record = wired.runGroup.readRun(runId);
  assert.ok(record.ok);
  assert.equal(record.run.selectedHarness, "codex");
  assert.equal(prepareCount, 3);
});

/** Run one headless command against the wired clients and capture its stdout. */
async function runShow(wired: Wiring, runId: string): Promise<string> {
  const out: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: () => {},
    cwd: () => process.cwd(),
  };
  const code = await runHeadless(
    {
      projectionPort: wired.projectionPort,
      bundleManagement: wired.bundleManagement,
    },
    ["run", "show", runId],
    io,
  );
  assert.equal(code, 0);
  return out.join("");
}

test("run show names the waiting basis of an Agent Step an Interrupt left open, and headless offers no follow-up command (#354)", async (t) => {
  const { wired, runId, run } = await launchAgentRun(t, {
    profile: claudeCodeProfile(),
    turns: [
      {
        result: {
          kind: "interrupted",
          detail: {
            interruption: { mode: "process-only", evidence: "scripted fake" },
            session: { state: "detached", coordinate: { opaque: "s" } },
          },
        },
      },
    ],
  });
  assert.equal(run.state, "blocked");

  const shown = await runShow(wired, runId);

  assert.match(shown, /Blocked: interrupted Agent Turn/);
  // Headless gains no follow-up (its parity record): no command is named for it.
  assert.doesNotMatch(shown, /follow-up/);
});

/** Run `secant run launch` for the agent Bundle with `flags` and return the Run id. */
async function launchWith(
  wired: Wiring,
  params: { bundleId: string; digest: string; docPath: string },
  flags: readonly string[],
): Promise<string> {
  const out: string[] = [];
  const err: string[] = [];
  const launchCode = await runHeadless(
    wired,
    [
      "run",
      "launch",
      params.bundleId,
      "--trust",
      params.digest,
      "--input",
      `doc=${params.docPath}`,
      "--harness",
      "claude-code",
      ...flags,
    ],
    {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: () => process.cwd(),
    },
  );
  assert.equal(launchCode, 0, `${out.join("")}\n${err.join("")}`);
  const runId = /^Run (\S+)$/m.exec(out.join(""))?.[1];
  assert.ok(runId);
  return runId;
}

async function runShowJson(wired: Wiring, runId: string): Promise<RunView> {
  const json: string[] = [];
  const code = await runHeadless(wired, ["run", "show", runId, "--json"], {
    out: (text) => json.push(text),
    err: () => {},
    cwd: () => process.cwd(),
  });
  assert.equal(code, 0);
  return (JSON.parse(json.join("")) as { result: { run: RunView } }).result.run;
}

test("[model-choice-durability] run launch --model --effort records the Model choice, and run show prints it beside the effective model", async (t) => {
  const { wired, bundleId, digest, docPath } = wireAgent(t);
  const runId = await launchWith(wired, { bundleId, digest, docPath }, [
    "--model",
    "requested-opus",
    "--effort",
    "high",
  ]);
  const record = wired.runGroup.readRun(runId);
  assert.ok(record.ok);
  assert.deepEqual(record.run.modelChoice, {
    model: "requested-opus",
    effort: "high",
  });

  const shown = await runShow(wired, runId);
  assert.match(shown, /^Model choice: requested-opus at high effort$/m);
  // The observed effective model stays a separate line: requested vs effective.
  assert.match(shown, /Observed effective model: claude-/);

  // `--json` adds the Run's Model choice and each Turn's requested values, and
  // keeps the run-level requested and effective models (ADR 0034).
  const run = await runShowJson(wired, runId);
  assert.deepEqual(run.modelChoice, {
    model: "requested-opus",
    effort: "high",
  });
  assert.equal(run.requestedModel, "requested-opus");
  assert.match(run.effectiveModel ?? "", /^claude-/);
  const started = run.timeline.find((event) => event.event === "turn-started");
  assert.deepEqual(started, {
    at: started?.at,
    event: "turn-started",
    detail: "s",
    turnKind: "agent",
    requestedModel: "requested-opus",
    requestedEffort: "high",
    step: "fix",
    session: "s",
    sessionName: "s",
  });
  // Each effective model the Turn's Harness reported is its own `effective-model`
  // entry, additively (#345); the last is the run-level effective model, and
  // Claude Code reports no effort yet (#347).
  const effective = run.timeline.filter(
    (event) => event.event === "effective-model",
  );
  assert.ok(effective.length > 0, JSON.stringify(run.timeline));
  for (const entry of effective) {
    assert.deepEqual(entry, {
      at: entry.at,
      event: "effective-model",
      detail: entry.effectiveModel,
      effectiveModel: entry.effectiveModel,
      step: "fix",
      session: "s",
      sessionName: "s",
    });
  }
  assert.equal(effective.at(-1)?.effectiveModel, run.effectiveModel);
  assert.match(shown, /effective-model claude-\S+ · step fix/);
});

test("[model-choice-durability] run launch with neither flag launches the preselection the TUI shows", async (t) => {
  const { wired, bundleId, digest, docPath } = wireAgent(t);
  const runId = await launchWith(wired, { bundleId, digest, docPath }, []);
  // The fake reports `opus` and declares no efforts, so none is invented.
  const run = await runShowJson(wired, runId);
  assert.deepEqual(run.modelChoice, { model: PLAIN_REPORTED_MODEL });
  const started = run.timeline.find((event) => event.event === "turn-started");
  assert.equal(started?.requestedModel, PLAIN_REPORTED_MODEL);
  assert.equal(started?.requestedEffort, undefined);
});

test("run launch --effort alone keeps the preselected model", async (t) => {
  const { wired, bundleId, digest, docPath } = wireAgent(t);
  const runId = await launchWith(wired, { bundleId, digest, docPath }, [
    "--effort",
    "low",
  ]);
  const run = await runShowJson(wired, runId);
  assert.deepEqual(run.modelChoice, {
    model: PLAIN_REPORTED_MODEL,
    effort: "low",
  });
});

test("a command -> agent -> command Bundle runs the plain Turn to succeeded (#116)", async (t) => {
  const { run } = await launchAgentRun(t);

  assert.equal(run.state, "succeeded");
  // The durable Turn view: one Session `s` open, the effective model from init, one
  // Turn admitted.
  assert.equal(run.sessions?.length, 1);
  const session = run.sessions?.[0];
  assert.equal(session?.session, "s");
  assert.equal(session?.availability, "open");
  // #124: a Session with a transcript advertises its typed page/export References.
  assert.deepEqual(session?.transcriptPage, {
    runId: run.runId,
    session: "s",
    type: "transcript-page",
  });
  assert.deepEqual(session?.transcriptExport, {
    runId: run.runId,
    session: "s",
    type: "transcript-export",
  });
  assert.match(run.effectiveModel ?? "", /^claude-/);
  assert.equal(run.turnPosition, 1);
  assert.equal("transcript" in run, false);

  // The normalized Harness identity of the latest Agent-step Attempt (#125): the
  // observed name, the resolved executable, and the observed version — never inferred
  // from configuration.
  assert.equal(run.harness?.name, "claude-code");
  assert.ok(
    (run.harness?.executable ?? "").length > 0,
    run.harness?.executable,
  );
  assert.match(run.harness?.executableVersion ?? "", /2\.1\.273/);

  // The timeline carries the Agent-Turn kinds the acceptance criterion names.
  const kinds = run.timeline.map((event) => event.event);
  assert.ok(kinds.includes("turn-started"), JSON.stringify(kinds));
  assert.ok(kinds.includes("assistant-content"), JSON.stringify(kinds));
  assert.ok(kinds.includes("turn-settled"), JSON.stringify(kinds));
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, "completed");
  // The durable Turn events carry the recorded Crucible Turn kind (#126) additively,
  // so a client labels reopened history without inferring from the Run's position.
  const started = run.timeline.find((event) => event.event === "turn-started");
  assert.equal(started?.turnKind, "agent");
  assert.equal(settled?.turnKind, "agent");
});

test("run show labels selected and observed Harness evidence separately", async (t) => {
  const { wired, runId } = await launchAgentRun(t);
  const shown = await runShow(wired, runId);
  assert.match(shown, /turn-started agent/); // the recorded Turn kind (#126)
  assert.match(shown, /assistant-content/);
  assert.match(shown, /turn-settled agent/);
  assert.match(shown, /Sessions:/);
  assert.match(shown, /s: open/);
  assert.match(shown, /Selected Harness: claude-code/);
  assert.match(shown, /Observed effective model: claude-/);
  // The Harness identity the same `run` Projection carries (#125): name, executable,
  // and version rendered alongside the effective model.
  assert.match(shown, /Observed Harness: claude-code/);
  assert.match(shown, /Observed executable: .+/);
  assert.match(shown, /Observed version: 2\.1\.273/);
  assert.doesNotMatch(shown, /Transcript:/);
});

test("run show --json gains additive Harness-identity fields (#125)", async (t) => {
  const { wired, runId } = await launchAgentRun(t);
  const out: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: () => {},
    cwd: () => process.cwd(),
  };
  const code = await runHeadless(
    {
      projectionPort: wired.projectionPort,
      bundleManagement: wired.bundleManagement,
    },
    ["run", "show", runId, "--json"],
    io,
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(out.join(""));
  const run = parsed.result.run;
  // Additive to the frozen `--json`: the existing `effectiveModel` stays, and a new
  // normalized `harness` object carries the identity — no native id crosses.
  assert.equal(run.selectedHarness, "claude-code");
  assert.equal(run.harness.name, "claude-code");
  assert.match(run.harness.executableVersion, /2\.1\.273/);
  assert.ok(typeof run.harness.executable === "string");
  assert.match(run.effectiveModel, /^claude-/);
});

test("run show prints each event's Step; run show --json and run read --transcript --json gain the Step and plain Session name additively (#289)", async (t) => {
  const { wired, runId } = await launchAgentRun(t);
  const shown = await runShow(wired, runId);
  const timeline = shown
    .slice(shown.indexOf("Timeline:"))
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("  "));
  // The raw kinds stay (headless is the diagnostic surface); each Step-scoped line
  // ends naming its Step, and a Run-scoped line names none.
  assert.match(timeline[0] ?? "", /^ {2}\S+ run-created$/);
  for (const [kind, step] of [
    ["attempt-settled succeeded", "before"],
    ["turn-started agent s", "fix"],
    ["assistant-content", "fix"],
    ["turn-settled agent completed", "fix"],
    ["attempt-settled succeeded", "after"],
  ] as const) {
    assert.ok(
      timeline.some(
        (line) => line.includes(` ${kind}`) && line.endsWith(` · step ${step}`),
      ),
      `${kind} names step ${step}:\n${timeline.join("\n")}`,
    );
  }

  const read = async (args: readonly string[]): Promise<unknown> => {
    const out: string[] = [];
    const io: HeadlessIO = {
      out: (text) => out.push(text),
      err: () => {},
      cwd: () => process.cwd(),
    };
    const code = await runHeadless(
      {
        projectionPort: wired.projectionPort,
        bundleManagement: wired.bundleManagement,
      },
      args,
      io,
    );
    assert.equal(code, 0);
    return JSON.parse(out.join(""));
  };
  // `--json` keeps every existing field and value and only gains new ones.
  const snapshot = (await read(["run", "show", runId, "--json"])) as {
    result: { run: RunView };
  };
  const json = snapshot.result.run;
  const started = json.timeline.find((event) => event.event === "turn-started");
  assert.deepEqual(started, {
    at: started?.at,
    event: "turn-started",
    detail: "s",
    turnKind: "agent",
    requestedModel: PLAIN_REPORTED_MODEL,
    step: "fix",
    session: "s",
    sessionName: "s",
  });
  assert.deepEqual(json.timeline[0], {
    at: json.timeline[0]?.at,
    event: "run-created",
  });
  assert.deepEqual(
    json.sessions?.map(({ session, name, availability }) => ({
      session,
      name,
      availability,
    })),
    [{ session: "s", name: "s", availability: "open" }],
  );
  const transcript = (await read([
    "run",
    "read",
    runId,
    "--transcript",
    "--json",
  ])) as {
    page: { entries: RunTranscriptEntryView[] };
    export: { entries: RunTranscriptEntryView[] };
  };
  for (const entries of [transcript.page.entries, transcript.export.entries]) {
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry), [
        "session",
        "role",
        "content",
        "step",
      ]);
      assert.equal(entry.session, "s");
      assert.equal(entry.step, "fix");
    }
  }
});

test("the rendered prompt carries the file's absolute path and the skill's SKILL.md, no @ (#116)", async (t) => {
  const { wired, run, docPath } = await launchAgentRun(t);
  const reference = run.sessions?.[0]?.transcriptPage;
  assert.ok(reference);
  const transcript = wired.projectionPort.readTranscript(reference);
  assert.ok(transcript.found);
  if (!transcript.found) throw new Error("unreachable");
  const input = transcript.entries.find(
    (entry) => entry.role === "user",
  )?.content;
  assert.ok(input !== undefined, JSON.stringify(transcript.entries));
  // The `file` slot renders as the file's absolute path; the `skill` in `uses`
  // appends a line naming its SKILL.md at an absolute path; no Harness `@` syntax.
  assert.ok(input.includes(docPath), input);
  assert.match(input, /SKILL\.md/);
  assert.ok(!input.includes("@"), input);
});

test("run answer settles a refused Harness preparation after the Gate as a non-success with the selected-Harness Problem (#304)", async (t) => {
  // Launch preparation qualifies the Harness first, the launch drive prepares it,
  // and it refuses on the drive the answer starts.
  let prepares = 0;
  const fake = createFake(plainScript());
  const adapter: HarnessAdapter = {
    prepare(options) {
      prepares += 1;
      return prepares === 3
        ? Promise.resolve({
            ok: false,
            failure: {
              phase: "prepare",
              category: "protocol-incompatible",
              possibleEffects: "none",
              diagnostics: "The pinned protocol subset did not qualify.",
            },
          })
        : fake().prepare(options);
    },
  };
  const workspace = makeTempDir("secant-agent-gate-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-agent-gate-home-"),
    launchCwd: workspace,
    process: createFakeBundleProcess(),
    harnessAdapter: adapter,
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: { source: "configured", name: "fake-claude", description: "" },
    }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const folder = makeTempDir("secant-agent-gate-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id: "dev.secant.agent-gate",
        version: "1.0.0",
        name: "Agent Gate",
        description: "An approve-reject gate before an Agent Step.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [{ path: "prompts/go.md", kind: "prompt" }],
      routing: [
        {
          id: "gate",
          kind: "human-gate",
          shape: "approve-reject",
          message: "proceed?",
        },
        {
          id: "work",
          kind: "agent",
          session: "s",
          prompt: { asset: "prompts/go.md" },
        },
      ],
    }),
  );
  assert.ok(wired.bundleManagement.build(folder, { noInstall: false }).ok);
  const entry = wired.catalog
    .listEntries()
    .find((candidate) => candidate.id === "dev.secant.agent-gate");
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve-agent-gate",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: () => workspace,
  };

  assert.equal(
    await runHeadless(
      wired,
      [
        "run",
        "launch",
        entry.id,
        "--trust",
        entry.digest,
        "--harness",
        "claude-code",
      ],
      io,
    ),
    2,
    err.join(""),
  );
  const runId = /^Run (\S+)$/m.exec(out.join(""))![1]!;
  out.length = 0;
  err.length = 0;

  assert.equal(
    await runHeadless(
      wired,
      ["run", "answer", runId, "--continue", "--json"],
      io,
    ),
    1,
  );
  const problem = JSON.parse(out.join(""));
  assert.equal(problem.code, "selected-harness-unavailable");
  assert.equal(problem.details.harness, "claude-code");
  assert.equal(problem.details.category, "protocol-incompatible");
  assert.equal(problem.details.runId, runId);
  out.length = 0;

  assert.equal(await runHeadless(wired, ["run", "show", runId], io), 0);
  assert.match(out.join(""), /^State: halted$/m);
  assert.equal(prepares, 3);
});

for (const containment of ["fallback", "contained", undefined] as const) {
  test(`[windows-cleanup-notice] headless ${containment ?? "non-Windows"} launch preserves JSON and emits only fallback once across Sessions`, async (t) => {
    let release!: () => void;
    let noticed!: () => void;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    const noticeSeen = new Promise<void>((resolve) => {
      noticed = resolve;
    });
    t.after(() => release());
    const sessionId = "12121212-1212-4121-8121-121212121212";
    const owned = createFakeProcess({
      ownedProcesses: [0, 1].map(() => ({
        kind: "launched",
        containment,
        containmentCause: new Error("forced CreateJobObjectW failure"),
        emissions: [
          {
            kind: "stdout",
            bytes: new TextEncoder().encode(
              `${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "scripted-model" })}\n${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`,
            ),
          },
          {
            kind: "terminal",
            trigger: "close-stdin",
            close: { kind: "exited", status: 0 },
          },
        ],
      })),
    });
    const base = createFakeBundleProcess({ executables: [process.execPath] });
    const { wired, bundleId, digest, docPath } = wireAgent(t, {
      repeated: true,
      adapter: createClaudeCodeAdapter({
        env: { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath },
        sessionId: () => sessionId,
      }),
      process: {
        ...base,
        resolveExecutable: (name, options) =>
          base.resolveExecutable(name, options),
        spawnCommandSync: (options) => base.spawnCommandSync(options),
        spawnCommand: (options) =>
          options.role === "harness-probe"
            ? Promise.resolve({
                kind: "exited",
                status: 0,
                text: new TextEncoder().encode("2.1.288 (Claude Code)"),
              })
            : base.spawnCommand(options),
        spawnOwnedProcess: async (options) => {
          if (options.args.includes("--no-session-persistence")) {
            return scriptedClaude({
              answer: "confirm",
            }).process.spawnOwnedProcess(options);
          }
          const launched = await owned.spawnOwnedProcess(options);
          if (!launched.ok || containment !== "fallback") return launched;
          const child = launched.process;
          return {
            ...launched,
            process: {
              ...child,
              stdout: (async function* () {
                await delivery;
                yield* child.stdout;
              })(),
              stderr: child.stderr,
              writeStdin: (bytes) => child.writeStdin(bytes),
              closeStdin: (timeout) => child.closeStdin(timeout),
              interrupt: (timeout) => child.interrupt(timeout),
              closed: () => child.closed(),
            },
          };
        },
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const io: HeadlessIO = {
      out: (text) => out.push(text),
      err: (text) => {
        err.push(text);
        noticed();
      },
      cwd: () => process.cwd(),
    };
    const launching = runHeadless(
      wired,
      [
        "run",
        "launch",
        bundleId,
        "--harness",
        "claude-code",
        "--trust",
        digest,
        "--input",
        `doc=${docPath}`,
        "--json",
      ],
      io,
    );
    if (containment === "fallback") {
      await noticeSeen;
      assert.deepEqual(out, []);
      assert.deepEqual(err, [
        "Secant will use its usual Windows cleanup. Some tool processes may continue after you stop or close it.\n",
      ]);
      release();
    }
    const status = await launching;
    assert.equal(status, 0, out.join("") + err.join(""));
    const notice =
      "Secant will use its usual Windows cleanup. Some tool processes may continue after you stop or close it.\n";
    assert.equal(err.join(""), containment === "fallback" ? notice : "");
    assert.doesNotMatch(
      out.join(""),
      /windowsCleanupNotice|usual Windows cleanup|CreateJobObjectW/,
    );
    const snapshot = JSON.parse(out.join(""));
    assert.equal(snapshot.result.run.state, "succeeded");
    assert.equal(snapshot.result.run.sessions.length, 2);
    const opened = wired.projectionPort.openProjection({
      family: "run",
      runId: snapshot.runId,
    });
    assert.ok(opened.snapshot.result.found);
    assert.equal(
      opened.snapshot.result.run.windowsCleanupNotice,
      containment === "fallback" ? notice.trim() : undefined,
    );
    const { windowsCleanupNotice: _notice, ...run } =
      opened.snapshot.result.run;
    assert.deepEqual(snapshot.result.run, JSON.parse(JSON.stringify(run)));
    opened.close();
  });
}

test("headless inspection names the last choice and a flagless second launch uses it", async (t) => {
  const { wired, bundleId, digest, docPath } = wireAgent(t);
  await launchWith(wired, { bundleId, digest, docPath }, [
    "--model",
    "remembered-model",
    "--effort",
    "high",
  ]);
  const out: string[] = [];
  assert.equal(
    await runHeadless(wired, ["harness", "inspect", "claude-code"], {
      out: (text) => out.push(text),
      err: () => {},
      cwd: () => process.cwd(),
    }),
    0,
  );
  assert.match(out.join(""), /Your last choice for Claude Code/);
  const runId = await launchWith(wired, { bundleId, digest, docPath }, []);
  assert.deepEqual((await runShowJson(wired, runId)).modelChoice, {
    model: "remembered-model",
    effort: "high",
  });
});

test("headless JSON launch succeeds while reporting preference read and save failures on stderr", async (t) => {
  const { wired, bundleId, digest, docPath, home } = wireAgent(t);
  const database = new Database(join(home, "catalog.db"));
  t.after(() => database.close());
  database.exec("DROP TABLE preferences");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHeadless(
    wired,
    [
      "run",
      "launch",
      bundleId,
      "--trust",
      digest,
      "--input",
      `doc=${docPath}`,
      "--harness",
      "claude-code",
      "--json",
    ],
    {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: () => process.cwd(),
    },
  );
  assert.equal(code, 0);
  const snapshot = JSON.parse(out.join(""));
  assert.equal(snapshot.result.run.state, "succeeded");
  assert.deepEqual(snapshot.result.run.modelChoice, {
    model: PLAIN_REPORTED_MODEL,
  });
  assert.equal("preferenceNotice" in snapshot.result.run, false);
  assert.match(err.join(""), /could not read/);
  assert.equal(err.filter((text) => text.includes("could not save")).length, 1);
});

function lockedScript(): FakeScript {
  return {
    profile: claudeCodeProfile(),
    defaults: {
      kind: "reported",
      choice: { model: "opus", effort: "high" },
      effortLock: { effort: "xhigh", source: "CLAUDE_CODE_EFFORT_LEVEL=xhigh" },
    },
    turns: [
      {
        events: [
          {
            kind: "model",
            observation: {
              known: true,
              model: "observed-model",
              effort: "xhigh",
            },
          },
        ],
        result: {
          kind: "completed",
          detail: {
            finalContent: "done",
            effectiveModel: {
              known: true,
              model: "observed-model",
              effort: "xhigh",
            },
            session: { state: "open" },
          },
        },
      },
    ],
  };
}
for (const json of [false, true]) {
  test(`headless refuses a contradicting effort under the environment lock, json=${json}`, async (t) => {
    const { wired, bundleId, digest, docPath } = wireAgent(t, {
      adapter: createFake(lockedScript())(),
    });
    const out: string[] = [],
      err: string[] = [];
    const code = await runHeadless(
      wired,
      [
        "run",
        "launch",
        bundleId,
        "--trust",
        digest,
        "--input",
        `doc=${docPath}`,
        "--harness",
        "claude-code",
        "--model",
        "sonnet",
        "--effort",
        "low",
        ...(json ? ["--json"] : []),
      ],
      {
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        cwd: () => process.cwd(),
      },
    );
    assert.equal(code, 1);
    if (json) {
      const response = JSON.parse(out.join(""));
      assert.equal(response.status, "not-ready");
      assert.equal(response.findings[0].code, "effort-locked");
      assert.equal(response.findings[0].correction, "effort");
      assert.equal(
        response.findings[0].explanation,
        "Locked by CLAUDE_CODE_EFFORT_LEVEL=xhigh. Change that setting outside Secant.",
      );
    } else {
      assert.match(
        err.join(""),
        /Locked by CLAUDE_CODE_EFFORT_LEVEL=xhigh\. Change that setting outside Secant\./,
      );
    }
    assert.deepEqual(wired.runGroup.listRuns(), []);
  });
}
test("headless shows the lock at launch and records requested and effective effort additively", async (t) => {
  const { wired, bundleId, digest, docPath } = wireAgent(t, {
    adapter: createFake(lockedScript())(),
  });
  const out: string[] = [],
    err: string[] = [];
  const code = await runHeadless(
    wired,
    [
      "run",
      "launch",
      bundleId,
      "--trust",
      digest,
      "--input",
      `doc=${docPath}`,
      "--harness",
      "claude-code",
      "--model",
      "sonnet",
    ],
    {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      cwd: () => process.cwd(),
    },
  );
  assert.equal(code, 0, err.join(""));
  assert.match(
    err.join(""),
    /Locked by CLAUDE_CODE_EFFORT_LEVEL=xhigh\. Change that setting outside Secant\./,
  );
  const runId = /^Run (\S+)$/m.exec(out.join(""))?.[1];
  assert.ok(runId);
  const run = await runShowJson(wired, runId);
  assert.deepEqual(run.modelChoice, { model: "sonnet", effort: "xhigh" });
  const started = run.timeline.find((entry) => entry.event === "turn-started");
  assert.equal(started?.requestedEffort, "xhigh");
  const effective = run.timeline.filter(
    (entry) => entry.event === "effective-model",
  );
  assert.equal(effective.at(-1)?.effectiveModel, "observed-model");
  assert.equal(effective.at(-1)?.effectiveEffort, "xhigh");
});
