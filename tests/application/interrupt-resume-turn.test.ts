import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type ControlReceipt,
  type HarnessAdapter,
  type HarnessProfile,
  type TurnResult,
} from "../../src/harness/harness.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import type {
  InterruptTurnOffer,
  ProjectionPort,
  RunView,
  SteerTurnOffer,
} from "../../src/application/projection-port.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import {
  awaitRunRest,
  awaitSettled,
  followRun,
} from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";

// Interrupt a live Turn through the Port, resume the same Session, and reject the
// unavailable steer control (#118). Each test wires the Application against the
// deterministic fake Claude Code Harness (native steer unavailable) and an injected
// fake Process — no child spawns (#184). No real Harness runs (ADR 0027).

// Claude Code's stream-json print mode has no same-Turn guidance frame, so the steer
// Offer is unavailable and its `reason` is exactly this profile evidence.
const STEER_EVIDENCE =
  "Claude Code's stream-json print mode has no same-Turn guidance frame: a further user message queues as the next Turn, so steer is rejected unsupported and never emulated.";

/** The fake Claude Code profile: native reattach recovery, process-only interruption,
 *  and — the fact these cases turn on — steer unavailable, carrying the exact evidence
 *  the steer Offer and the steer-unavailable Problem surface. */
function claudeProfile(): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "claude",
    executableVersion: "2.1.273",
    platform: "linux",
    adapterRevision: "fake-claude-1",
    configurationPosture: "user-compatible",
    recovery: {
      mode: "native-reattach",
      evidence: "fake claude resumes by id",
    },
    interruption: {
      mode: "process-only",
      evidence: "fake claude stops the process",
    },
    approvals: {
      available: true,
      evidence: "fake claude hosts a permission bridge",
    },
    clarifications: {
      available: false,
      evidence: "fake claude offers no clarifications",
    },
    steer: { available: false, evidence: STEER_EVIDENCE },
    modelSelection: {
      at: "unavailable",
      evidence: "fake claude selects no model",
    },
    modelObservation: {
      available: true,
      evidence: "fake claude observes its own model",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "fake claude mints a session id",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence: "fake claude reads a SKILL.md path",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "fake claude reads an absolute path",
    },
  };
}

// A live Turn interrupted cleanly settles `interrupted` on every OS: the fake Harness
// has no hidden-console child to force-kill, so the Windows force-kill→`lost` variant
// (ADR 0022) is a real-child artifact covered by the runtime replayer conformance, not
// this in-process semantic suite. The interrupted Turn detaches Session "s" by its
// recovery coordinate so a resume can reattach it.
const INTERRUPTED_DETACHED: TurnResult = {
  kind: "interrupted",
  detail: {
    interruption: {
      mode: "process-only",
      evidence: "fake claude stops the process",
    },
    session: { state: "detached", coordinate: { opaque: "s" } },
  },
};

const COMPLETED_OPEN: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: "done",
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

// A resume the Harness does not acknowledge: the recovery phase fails and the Session
// becomes permanently unusable, so no fresh Session is ever opened in its place.
const FAILED_UNACKNOWLEDGED: TurnResult = {
  kind: "failed",
  detail: {
    failure: {
      phase: "recovery",
      category: "recovery-unacknowledged",
      possibleEffects: "possible",
      diagnostics: "the resumed Session was not acknowledged",
    },
    effectiveModel: { known: false },
    session: {
      state: "unusable",
      reason: "the resumed Session was not acknowledged",
    },
  },
};

/** A Turn that emits a Session event then blocks until it is interrupted (or the
 *  Harness is closed); an interrupt settles it `interrupted` with Session "s"
 *  detached — the request-free "blocks mid-Turn" shape the interrupt cases drive. */
function blockingTurn(): FakeScript["turns"][number] {
  return {
    events: [{ kind: "session", availability: { state: "open" } }],
    block: true,
    result: COMPLETED_OPEN, // unused: the Turn is interrupted, never settling naturally
    interruptResult: INTERRUPTED_DETACHED,
  };
}

/** A Turn that completes straight away, reattaching the resumed Session. */
function completedTurn(): FakeScript["turns"][number] {
  return {
    events: [
      { kind: "session", availability: { state: "open" } },
      { kind: "assistant-content", content: "resumed and finished" },
    ],
    result: COMPLETED_OPEN,
  };
}

/** A Turn whose recovery is unacknowledged, failing the resumed Attempt. */
function unacknowledgedTurn(): FakeScript["turns"][number] {
  return { result: FAILED_UNACKNOWLEDGED };
}

/** The scripts one wiring hands out, one per Harness preparation. A launch prepares
 *  once; a resume prepares a fresh Harness, so the second script drives the resumed
 *  Turn. Extra preparations reuse the last script. */
function scriptsFor(scenario: string): readonly FakeScript[] {
  const blocking: FakeScript = {
    profile: claudeProfile(),
    turns: [blockingTurn()],
  };
  if (scenario === "resume") {
    return [blocking, { profile: claudeProfile(), turns: [completedTurn()] }];
  }
  if (scenario === "resume-unacknowledged") {
    return [
      blocking,
      { profile: claudeProfile(), turns: [unacknowledgedTurn()] },
    ];
  }
  return [blocking];
}

/** A Harness Adapter that prepares one scripted fake Harness per `prepare` call. The
 *  Application re-prepares a fresh Harness for each execution (launch, then resume), so
 *  a scenario's successive Turn behaviours are keyed to the preparation sequence. */
function sequencedAdapter(scripts: readonly FakeScript[]): HarnessAdapter {
  let index = 0;
  return {
    prepare(options) {
      const script = scripts[Math.min(index, scripts.length - 1)]!;
      index += 1;
      return createFake(script)().prepare(options);
    },
  };
}

/** A fake Process that resolves any executable and reaches no real child; Git store
 *  operations run through the deterministic fake Git process. */
function fakeProcess(): ProcessAdapter {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: () => ({
      kind: "exited",
      status: 0,
      text: new Uint8Array(),
    }),
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => git.spawnCommandSync(options),
  };
}

/** Author a single-Agent-step Bundle in Session `s`: the Turn the fake drives. */
function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-interrupt-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.interrupt-e2e",
      version: "1.0.0",
      name: "Interrupt E2E",
      description: "A single Agent Step Bundle for interrupt/resume.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/go.md", kind: "prompt" }],
    routing: [
      {
        id: "work",
        kind: "agent",
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

/** Wire the Application against the fake Claude Code Harness for `scenario` and an
 *  injected fake Process. Installs the single-Agent Bundle and approves the Workspace;
 *  returns the wired clients. */
function wire(
  t: TestContext,
  scenario: string,
): { wired: Wiring; bundleId: string; digest: string } {
  const workspace = makeTempDir("secant-interrupt-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-interrupt-home-"),
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: sequencedAdapter(scriptsFor(scenario)),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "claude",
        description: "PATH name 'claude'",
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
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);
  const approve = wired.projectionPort.submit({
    operationId: "op-approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approve.admitted);
  return { wired, bundleId: bundle.id, digest: entry.digest };
}

/** Follow the run Projection until a live Turn offers `interrupt-turn`, so a control
 *  is issued only once the Turn is admitted. The Turn's durable admission pushes a
 *  snapshot to open observers (#290), so this awaits the stream, never a poll or
 *  sleep: an Agent-step Turn reaches a followed client while it is live. */
function awaitLiveTurn(
  port: ProjectionPort,
  runId: string,
  previousTurnId?: string,
): Promise<InterruptTurnOffer> {
  return followRun(port, runId, (run) =>
    run.actionOffers.find(
      (candidate): candidate is InterruptTurnOffer =>
        candidate.action === "interrupt-turn" &&
        candidate.turnId !== previousTurnId,
    ),
  );
}

function runView(port: ProjectionPort, runId: string): RunView {
  const opened = port.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return opened.snapshot.result.run;
  } finally {
    opened.close();
  }
}

test("interrupt-turn stops a live Turn, rests the Run halted, detaches the Session, and settles the Turn interrupted (#118)", async (t) => {
  const { wired, digest } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(launch.admitted, JSON.stringify(launch));
  const runId = launch.runId!;

  const offer = await awaitLiveTurn(port, runId);
  // A steer-turn offer stands beside it, marked unavailable with the exact reason.
  const steer = runView(port, runId).actionOffers.find(
    (candidate): candidate is SteerTurnOffer =>
      candidate.action === "steer-turn",
  );
  assert.ok(steer, "expected a steer-turn offer while the Turn is live");
  assert.equal(steer!.available, false);
  assert.equal(steer!.reason, STEER_EVIDENCE);

  const interrupt = port.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  assert.ok(interrupt.admitted);
  const interruptOutcome = await awaitSettled(port, "op-interrupt");
  assert.equal(
    interruptOutcome.status,
    "applied",
    JSON.stringify(interruptOutcome),
  );

  // The launch Operation settles once the interrupted Turn rests the Run halted.
  await awaitSettled(port, "op-launch");
  const run = runView(port, runId);
  assert.equal(run.state, "halted");
  assert.equal(run.sessions?.[0]?.session, "s");
  assert.equal(run.sessions?.[0]?.availability, "detached");
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, "interrupted");

  // A control issued after acceptance is rejected as a value: the Turn has settled.
  const after = port.submit({
    operationId: "op-interrupt-again",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  assert.ok(after.admitted);
  const afterOutcome = await awaitSettled(port, "op-interrupt-again");
  assert.equal(afterOutcome.status, "not-applied");
  if (afterOutcome.status === "not-applied") {
    assert.equal(afterOutcome.problem.code, "turn-control-rejected");
  }
});

test("steer-turn is rejected as a value when submitted (#118)", async (t) => {
  const { wired, digest } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;
  const offer = await awaitLiveTurn(port, runId);

  const steer = port.submit({
    operationId: "op-steer",
    operation: "steer-turn",
    input: { runId, turnId: offer.turnId, text: "go faster" },
  });
  assert.ok(steer.admitted);
  const outcome = await awaitSettled(port, "op-steer");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "steer-unavailable");
    assert.match(outcome.problem.explanation, /stream-json print mode/);
  }

  // Interrupt so the Run rests and the wired process does not leak a live child.
  port.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  await awaitSettled(port, "op-launch");
});

test("resume-run continues a detached Session in the same Claude Code Session via --resume (#118)", async (t) => {
  const { wired, digest } = wire(t, "resume");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;

  const offer = await awaitLiveTurn(port, runId);
  port.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  await awaitSettled(port, "op-launch");
  assert.equal(runView(port, runId).state, "halted");

  // Resume: the new process starts with --resume, init acknowledges the session, and
  // the Run continues in the same Session to its outcome.
  const resume = port.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  const resumeOutcome = await awaitSettled(port, "op-resume");
  assert.equal(resumeOutcome.status, "applied", JSON.stringify(resumeOutcome));
  assert.equal(runView(port, runId).state, "succeeded");
});

test("a signal (Ctrl+C) mid-Turn interrupts the Turn and rests the Run halted, not cancelled (#118, AC5)", async (t) => {
  // The headless OS-signal path (withClients) drives Application.shutdown(), which
  // aborts every live Run; a live Agent Turn interrupts at the Harness Seam and the
  // Run rests `halted` (resumable) — never `cancelled`. Exit-code (1 vs 130) is a
  // separate concern flagged as a spec conflict; the resting state is the AC value.
  const { wired, digest } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;
  await awaitLiveTurn(port, runId);

  await wired.shutdown();
  const run = runView(port, runId);
  assert.equal(run.state, "halted");
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, "interrupted");
});

test("a resume the Harness does not acknowledge fails the Attempt and never creates a fresh Session (#118)", async (t) => {
  const { wired, digest } = wire(t, "resume-unacknowledged");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;

  const offer = await awaitLiveTurn(port, runId);
  port.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  await awaitSettled(port, "op-launch");

  const resume = port.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted);
  await awaitSettled(port, "op-resume");
  const run = runView(port, runId);
  // The recovery failure rests the Run failed; the Session went unusable and no
  // fresh Session was ever opened in its place (ADR 0022).
  assert.equal(run.state, "failed");
  assert.equal(run.sessions?.[0]?.session, "s");
  assert.equal(run.sessions?.[0]?.availability, "unusable");
});

// A native-steer profile lets the test release an ineffective interrupt naturally.
const INTERRUPT_PROFILE: HarnessProfile = {
  ...claudeProfile(),
  steer: { available: true, evidence: "scripted fake" },
};

async function failedInterruptScenario(
  t: TestContext,
  options: {
    first: "human" | "agent";
    next: "human" | "agent" | "command";
    receipt?: ControlReceipt;
    firstResult?: TurnResult;
    blockNext?: boolean;
  },
) {
  const saved = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = process.execPath;
  t.after(() => {
    if (saved === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = saved;
  });
  let interruptRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    interruptRequested = resolve;
  });
  const interruptCalls: number[] = [];
  const releases: Array<() => Promise<unknown>> = [];
  let index = 0;
  const adapter: HarnessAdapter = {
    async prepare(prepareOptions) {
      const prepared = await createFake({
        profile: INTERRUPT_PROFILE,
        turns:
          index === 0
            ? [
                {
                  block: true,
                  settleOnSteer: true,
                  result: options.firstResult ?? COMPLETED_OPEN,
                },
                {
                  block: options.blockNext,
                  settleOnSteer: true,
                  result: COMPLETED_OPEN,
                },
              ]
            : [
                {
                  block: options.blockNext,
                  settleOnSteer: true,
                  result: COMPLETED_OPEN,
                },
              ],
      })().prepare(prepareOptions);
      if (!prepared.ok) return prepared;
      const harness = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          close: () => harness.close(),
          startTurn(request) {
            const turn = harness.startTurn(request);
            const current = index++;
            releases[current] = () => turn.steer({ text: "finish naturally" });
            return {
              subscribe: (listener) => turn.subscribe(listener),
              answerRequest: (answer) => turn.answerRequest(answer),
              steer: (input) => turn.steer(input),
              result: () => turn.result(),
              async interrupt() {
                interruptCalls.push(current);
                if (current !== 0) return turn.interrupt();
                interruptRequested();
                return options.receipt ?? { outcome: "accepted" };
              },
            };
          },
        },
      };
    },
  };
  const workspace = makeTempDir("secant-interrupt-ws-");
  const bundleProcess = createFakeBundleProcess({
    executables: [process.execPath],
  });
  const commandSignals: boolean[] = [];
  const wired = wireApplication({
    secantHome: makeTempDir("secant-interrupt-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    harnessAdapter: adapter,
    process: createFakeProcess({
      resolutionHandler: (name) => bundleProcess.resolveExecutable(name),
      syncCommandHandler: (o) => bundleProcess.spawnCommandSync(o),
      commandHandler: (o) => {
        commandSignals.push(o.cancelSignal?.aborted === true);
        return o.cancelSignal?.aborted === true
          ? { kind: "cancelled" }
          : { kind: "exited", status: 0, text: new Uint8Array() };
      },
    }),
  });
  t.after(async () => {
    // Release any failed test's blocked Turn before shutdown (the first interrupt
    // deliberately cannot stop it).
    for (const release of releases) await release();
    await wired.shutdown();
    wired.runGroup.close();
    wired.catalog.close();
  });
  const folder = makeTempDir("secant-interrupt-bundle-");
  mkdirSync(join(folder, "prompts"));
  writeFileSync(join(folder, "prompts", "go.md"), "Go.\n");
  const agent = (id: string, kind = "agent") => ({
    id,
    kind,
    session: "s",
    prompt: { asset: "prompts/go.md" },
  });
  const routing = [
    agent("first", options.first === "human" ? "interactive-agent" : "agent"),
  ];
  const next =
    options.next === "command"
      ? {
          id: "next",
          kind: "command",
          command: {
            executable: RUNTIME_NAME,
            arguments: ["-e", "process.exit(0)"],
          },
        }
      : agent("next");
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id: "dev.secant.turn-interrupt",
        version: "1.0.0",
        name: "Interrupt",
        description: "Turn scoping",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [{ path: "prompts/go.md", kind: "prompt" }],
      routing: options.next === "human" ? routing : [...routing, next],
    }),
  );
  const built = wired.bundleManagement.build(folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = wired.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.turn-interrupt")!;
  const port = wired.projectionPort;
  assert.ok(
    port.submit({
      operationId: "approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const launch = port.submit({
    operationId: "launch",
    operation: "launch-run",
    input: {
      bundle: { id: entry.id },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: "claude-code",
    },
  });
  assert.ok(launch.admitted, JSON.stringify(launch));
  const runId = launch.runId!;
  if (options.first === "human") {
    await awaitSettled(port, "launch");
    send(port, runId, "send-first");
    await awaitSettled(port, "send-first");
  }
  const live = await awaitLiveTurn(port, runId);
  assert.ok(
    port.submit({
      operationId: "interrupt",
      operation: "interrupt-turn",
      input: { runId, turnId: live.turnId },
    }).admitted,
  );
  await requested;
  return {
    port,
    runId,
    interruptCalls,
    commandSignals,
    release: (i: number) => releases[i]!(),
    turnId: live.turnId,
  };
}

function send(port: ProjectionPort, runId: string, operationId: string) {
  assert.ok(
    port.submit({
      operationId,
      operation: "send-interactive-turn",
      input: { runId, stepId: "first", text: operationId },
    }).admitted,
  );
}

async function assertRejected(port: ProjectionPort, reason: string) {
  const outcome = await awaitSettled(port, "interrupt");
  assert.equal(outcome.status, "not-applied", JSON.stringify(outcome));
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "interrupt-rejected");
    assert.equal(outcome.problem.details?.reason, reason);
  }
}

test("a completed Turn despite interrupt leaves the next human Turn working (#298)", async (t) => {
  const f = await failedInterruptScenario(t, { first: "human", next: "human" });
  await f.release(0);
  assert.equal((await awaitRunRest(f.port, f.runId)).state, "blocked");
  send(f.port, f.runId, "send-next");
  await awaitSettled(f.port, "send-next");
  const run = await awaitRunRest(f.port, f.runId);
  assert.equal(run.state, "blocked");
  assert.deepEqual(f.interruptCalls, [0]);
  assert.deepEqual(
    run.timeline.filter((e) => e.event === "turn-settled").map((e) => e.detail),
    ["completed", "completed"],
  );
  await assertRejected(f.port, "completed");
});

test("a completed Turn despite interrupt leaves the following Agent Turn working (#298)", async (t) => {
  const f = await failedInterruptScenario(t, { first: "agent", next: "agent" });
  await f.release(0);
  await awaitSettled(f.port, "launch");
  assert.equal(runView(f.port, f.runId).state, "succeeded");
  assert.deepEqual(f.interruptCalls, [0]);
  await assertRejected(f.port, "completed");
});

test("a completed Turn despite interrupt leaves the following Command signal unfired (#298)", async (t) => {
  const f = await failedInterruptScenario(t, {
    first: "agent",
    next: "command",
  });
  await f.release(0);
  await awaitSettled(f.port, "launch");
  assert.equal(runView(f.port, f.runId).state, "succeeded");
  assert.deepEqual(f.commandSignals, [false]);
  await assertRejected(f.port, "completed");
});

test("a rejected interrupt receipt settles immediately and leaves the next human Turn working (#298)", async (t) => {
  const f = await failedInterruptScenario(t, {
    first: "human",
    next: "human",
    receipt: { outcome: "rejected", reason: "already-settled" },
  });
  await assertRejected(f.port, "already-settled");
  assert.equal(runView(f.port, f.runId).state, "running");
  await f.release(0);
  await awaitRunRest(f.port, f.runId);
  send(f.port, f.runId, "send-next");
  await awaitSettled(f.port, "send-next");
  assert.equal((await awaitRunRest(f.port, f.runId)).state, "blocked");
  assert.deepEqual(f.interruptCalls, [0]);
});

test("interrupt settles on its own Turn while a following Agent Turn remains live (#298)", async (t) => {
  const f = await failedInterruptScenario(t, {
    first: "agent",
    next: "agent",
    blockNext: true,
  });
  await f.release(0);
  await awaitLiveTurn(f.port, f.runId, f.turnId);
  await assertRejected(f.port, "completed");
  assert.equal(runView(f.port, f.runId).state, "running");
  await f.release(1);
  await awaitSettled(f.port, "launch");
  assert.equal(runView(f.port, f.runId).state, "succeeded");
});

test("a failed Turn despite interrupt settles not-applied and permits the next human Turn (#298)", async (t) => {
  const f = await failedInterruptScenario(t, {
    first: "human",
    next: "human",
    firstResult: {
      kind: "failed",
      detail: {
        failure: {
          phase: "turn",
          category: "native-failure",
          possibleEffects: "possible",
          diagnostics: "scripted failure",
        },
        effectiveModel: { known: false },
        session: { state: "open" },
      },
    },
  });
  await f.release(0);
  assert.equal((await awaitRunRest(f.port, f.runId)).state, "blocked");
  await assertRejected(f.port, "failed");
  send(f.port, f.runId, "send-next");
  await awaitSettled(f.port, "send-next");
  assert.equal((await awaitRunRest(f.port, f.runId)).state, "blocked");
  assert.deepEqual(f.interruptCalls, [0]);
});

test("an accepted interrupt whose Turn ends lost applies and still rests halted (#298)", async (t) => {
  const f = await failedInterruptScenario(t, {
    first: "human",
    next: "human",
    firstResult: {
      kind: "lost",
      detail: {
        failure: {
          phase: "turn",
          category: "transport-lost",
          possibleEffects: "possible",
          diagnostics: "Windows-style interrupted transport",
        },
        unknown: "interruption",
        lastObservation: "interrupt requested before transport closed",
        session: { state: "detached", coordinate: { opaque: "coord-s" } },
      },
    },
  });
  await f.release(0);
  assert.equal((await awaitSettled(f.port, "interrupt")).status, "applied");
  const run = await awaitRunRest(f.port, f.runId);
  assert.equal(run.state, "halted");
  assert.equal(run.sessions?.[0]?.availability, "detached");
  assert.equal(
    run.timeline.find((e) => e.event === "turn-settled")?.detail,
    "lost",
  );
});
