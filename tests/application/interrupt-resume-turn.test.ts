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
  SendFollowUpTurnOffer,
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
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";

// Interrupt a live Turn through the Port, continue it with the follow-up, and reject
// the unavailable steer control (#118, #354). Each test wires the Application against
// the deterministic fake Harness (native steer unavailable, a profile Claude Code no
// longer declares since #359) and an injected fake Process — no child spawns (#184).
// No real Harness runs (ADR 0027).

// The fake profile has no same-Turn guidance, so the steer Offer is unavailable and
// its `reason` is exactly this profile evidence.
// Every Agent-bearing launch names its Model choice (ADR 0034); the fake selects
// no model, so any name is admitted.
const FAKE_MODEL = "fake-model";

const STEER_EVIDENCE =
  "This Harness has no same-Turn guidance, so steer is rejected unsupported and never emulated.";

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

/** The Turns the launch's prepared Harness drives, in order: the Run holds that
 *  Harness across the wait after an Interrupt, so a follow-up is its next Turn. */
function turnsFor(scenario: string): readonly FakeScript["turns"][number][] {
  switch (scenario) {
    case "follow-up":
      return [blockingTurn(), completedTurn()];
    case "follow-up-unacknowledged":
      return [blockingTurn(), unacknowledgedTurn()];
    case "interrupt-again":
      return [blockingTurn(), blockingTurn()];
    default:
      return [blockingTurn()];
  }
}

/** What the wired fake Harness saw: each preparation and close, and each Turn
 *  request's Session, origin, verbatim input, and resume coordinate. */
interface HarnessRecord {
  prepares: number;
  closes: number;
  /** Resolves at the first close, which follows the Run's last pushed rest. */
  readonly closed: Promise<void>;
  readonly onClose: () => void;
  readonly requests: {
    readonly session: string;
    readonly origin: string;
    readonly text: string;
    readonly resume?: string;
  }[];
}

function harnessRecord(): HarnessRecord {
  let onClose: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  return { prepares: 0, closes: 0, closed, onClose, requests: [] };
}

/** A Harness Adapter that prepares one scripted fake Harness per `prepare` call,
 *  recording what it saw. Extra preparations reuse the last script. */
function sequencedAdapter(
  scripts: readonly FakeScript[],
  record?: HarnessRecord,
): HarnessAdapter {
  let index = 0;
  return {
    async prepare(options) {
      const script = scripts[Math.min(index, scripts.length - 1)]!;
      index += 1;
      const prepared = await createFake(script)().prepare(options);
      if (!prepared.ok || record === undefined) return prepared;
      record.prepares += 1;
      const harness = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          readDefaults: () => harness.readDefaults(),
          close() {
            record.closes += 1;
            record.onClose();
            return harness.close();
          },
          startTurn(request) {
            record.requests.push({
              session: request.session,
              origin: request.origin,
              text: request.input.text,
              ...(request.resume !== undefined
                ? { resume: request.resume.opaque }
                : {}),
            });
            return harness.startTurn(request);
          },
        },
      };
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

/** One wiring over `home`/`workspace` whose Harness Adapter prepares `scripts` in
 *  order; closed (shut down first, so a held Harness closes) after the test. */
function wireOver(
  t: TestContext,
  dirs: { readonly home: string; readonly workspace: string },
  scripts: readonly FakeScript[],
  record?: HarnessRecord,
): Wiring {
  const wired = wireApplication({
    secantHome: dirs.home,
    launchCwd: dirs.workspace,
    process: fakeProcess(),
    harnessAdapter: sequencedAdapter(scripts, record),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "claude",
        description: "PATH name 'claude'",
      },
    }),
  });
  t.after(async () => {
    await wired.shutdown();
    wired.runGroup.close();
    wired.catalog.close();
  });
  return wired;
}

/** Wire the Application against the fake Claude Code Harness for `scenario` and an
 *  injected fake Process. Installs the single-Agent Bundle and approves the Workspace;
 *  returns the wired clients and what the Harness saw. */
function wire(
  t: TestContext,
  scenario: string,
): {
  wired: Wiring;
  bundleId: string;
  digest: string;
  harness: HarnessRecord;
  dirs: { readonly home: string; readonly workspace: string };
} {
  const dirs = {
    home: makeTempDir("secant-interrupt-home-"),
    workspace: makeTempDir("secant-interrupt-ws-"),
  };
  const workspace = dirs.workspace;
  const harness = harnessRecord();
  const wired = wireOver(
    t,
    dirs,
    [{ profile: claudeProfile(), turns: turnsFor(scenario) }],
    harness,
  );

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
  return { wired, bundleId: bundle.id, digest: entry.digest, harness, dirs };
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

function launchAgent(port: ProjectionPort, digest: string): string {
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: FAKE_MODEL,
    },
  });
  assert.ok(launch.admitted, JSON.stringify(launch));
  return launch.runId!;
}

/** Interrupt the live Turn `offer` names and await its own outcome. */
async function interrupt(
  port: ProjectionPort,
  runId: string,
  offer: InterruptTurnOffer,
  operationId = "op-interrupt",
): Promise<void> {
  assert.ok(
    port.submit({
      operationId,
      operation: "interrupt-turn",
      input: { runId, turnId: offer.turnId },
    }).admitted,
  );
  const outcome = await awaitSettled(port, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

function followUpOffer(run: RunView): SendFollowUpTurnOffer | undefined {
  return run.actionOffers.find(
    (candidate): candidate is SendFollowUpTurnOffer =>
      candidate.action === "send-follow-up-turn",
  );
}

/** The follow-up Offer once the launch drive has rested: its `blocked` write pushes
 *  the Offer just before the drive ends, and a follow-up sent while that drive is
 *  still in flight is refused, as an interactive send is. */
async function awaitFollowUpOffer(
  port: ProjectionPort,
  runId: string,
): Promise<SendFollowUpTurnOffer> {
  assert.equal((await awaitSettled(port, "op-launch")).status, "applied");
  const offer = followUpOffer(runView(port, runId));
  assert.ok(offer, "expected the follow-up offered");
  return offer;
}

function sendFollowUp(
  port: ProjectionPort,
  offer: SendFollowUpTurnOffer,
  text: string,
  operationId = "op-follow-up",
) {
  return port.submit({
    operationId,
    operation: "send-follow-up-turn",
    input: { runId: offer.runId, turnId: offer.turnId, text },
  });
}

function awaitState(
  port: ProjectionPort,
  runId: string,
  state: RunView["state"],
): Promise<RunView> {
  return followRun(port, runId, (run) =>
    run.state === state ? run : undefined,
  );
}

function timelineDetails(run: RunView, event: string): (string | undefined)[] {
  return run.timeline
    .filter((entry) => entry.event === event)
    .map((entry) => entry.detail);
}

test("interrupt-turn ends only the Agent Turn: the Attempt stays open and the Run waits blocked with the follow-up offered and the Harness held (#354)", async (t) => {
  const { wired, digest, harness } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const runId = launchAgent(port, digest);

  const offer = await awaitLiveTurn(port, runId);
  // A steer-turn offer stands beside it, marked unavailable with the exact reason.
  const steer = runView(port, runId).actionOffers.find(
    (candidate): candidate is SteerTurnOffer =>
      candidate.action === "steer-turn",
  );
  assert.ok(steer, "expected a steer-turn offer while the Turn is live");
  assert.equal(steer!.available, false);
  assert.equal(steer!.reason, STEER_EVIDENCE);
  assert.equal(
    offer.consequence,
    "stop the live Turn; the agent then waits for your next message in the same Session.",
  );

  await interrupt(port, runId, offer);

  // The launch Operation settles once the walk rests at the waiting Step.
  assert.equal((await awaitSettled(port, "op-launch")).status, "applied");
  const run = runView(port, runId);
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.status, "blocked");
  assert.deepEqual(followUpOffer(run), {
    action: "send-follow-up-turn",
    runId,
    stepId: "work",
    attemptId: "0.0:work",
    turnId: offer.turnId,
    basis: "interrupted Agent Turn",
    consequence:
      "send the typed text to the agent as your next message in the same Session; the Step continues from that Turn.",
  });
  // No Attempt settled, nothing to resume, and the waiting Run is cancellable.
  assert.deepEqual(timelineDetails(run, "attempt-settled"), []);
  assert.deepEqual(
    run.actionOffers.map((candidate) => candidate.action).sort(),
    ["cancel-run", "send-follow-up-turn"],
  );
  assert.equal(run.sessions?.[0]?.session, "s");
  assert.equal(run.sessions?.[0]?.availability, "detached");
  assert.deepEqual(timelineDetails(run, "turn-settled"), ["interrupted"]);
  // The Step's Harness is held across the wait, not closed.
  assert.deepEqual([harness.prepares, harness.closes], [1, 0]);

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

test("an unavailable steer-turn is refused at admission with the profile's evidence (#118, #359)", async (t) => {
  const { wired, digest } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const runId = launchAgent(port, digest);
  const offer = await awaitLiveTurn(port, runId);

  const steer = port.submit({
    operationId: "op-steer",
    operation: "steer-turn",
    input: { runId, turnId: offer.turnId, text: "go faster" },
  });
  assert.equal(steer.admitted, false);
  if (!steer.admitted) {
    assert.equal(steer.problem.code, "steer-unavailable");
    assert.match(steer.problem.explanation, /no same-Turn guidance/);
  }

  // Interrupt so the Run rests waiting and the wired process leaks no live Turn.
  await interrupt(port, runId, offer);
  await awaitSettled(port, "op-launch");
  assert.equal(runView(port, runId).state, "blocked");
});

test("the follow-up runs as a human Turn in the same Session and Attempt on the held Harness, and a clean one advances the Run (#354)", async (t) => {
  const { wired, digest, harness } = wire(t, "follow-up");
  const port = wired.projectionPort;
  const runId = launchAgent(port, digest);
  await interrupt(port, runId, await awaitLiveTurn(port, runId));
  const offer = await awaitFollowUpOffer(port, runId);

  const sent = sendFollowUp(port, offer, "Keep going, but skip the docs.");

  assert.ok(sent.admitted, JSON.stringify(sent));
  // It settles at the follow-up Turn's admission (#290).
  assert.equal((await awaitSettled(port, "op-follow-up")).status, "applied");
  const run = await awaitState(port, runId, "succeeded");
  // The human's text went verbatim to the same Session on the held Harness.
  assert.deepEqual(harness.requests.slice(1), [
    {
      session: "s",
      origin: "human",
      text: "Keep going, but skip the docs.",
      resume: "s",
    },
  ]);
  assert.equal(harness.requests[0]?.origin, "managed");
  // One Attempt took its outcome from its last Turn; both Turns are Agent Turns.
  assert.deepEqual(timelineDetails(run, "attempt-settled"), ["succeeded"]);
  assert.deepEqual(timelineDetails(run, "turn-settled"), [
    "interrupted",
    "completed",
  ]);
  assert.deepEqual(
    run.timeline
      .filter((entry) => entry.event === "turn-started")
      .map((entry) => [entry.detail, entry.turnKind, entry.step]),
    [
      ["s", "agent", "work"],
      ["s", "agent", "work"],
    ],
  );
  // The held Harness served the follow-up and closed once at rest.
  await harness.closed;
  assert.deepEqual([harness.prepares, harness.closes], [1, 1]);
  assert.equal(followUpOffer(run), undefined);
});

test("a failed follow-up fails the Attempt by the ordinary retry policy and never opens a fresh Session (#354)", async (t) => {
  const { wired, digest, harness } = wire(t, "follow-up-unacknowledged");
  const port = wired.projectionPort;
  const runId = launchAgent(port, digest);
  await interrupt(port, runId, await awaitLiveTurn(port, runId));
  const offer = await awaitFollowUpOffer(port, runId);

  assert.ok(sendFollowUp(port, offer, "Try again from the plan.").admitted);
  assert.equal((await awaitSettled(port, "op-follow-up")).status, "applied");

  // The recovery failure leaves Session "s" unusable, so every retry the default
  // budget allows fails without a Turn and the Run rests failed (ADR 0022).
  const run = await awaitState(port, runId, "failed");
  assert.deepEqual(timelineDetails(run, "attempt-settled"), [
    "failed",
    "failed",
    "failed",
  ]);
  assert.equal(harness.requests.length, 2);
  assert.equal(run.sessions?.[0]?.session, "s");
  assert.equal(run.sessions?.[0]?.availability, "unusable");
});

test("a second Interrupt holds the Step again with the follow-up offered on the new Turn (#354)", async (t) => {
  const { wired, digest } = wire(t, "interrupt-again");
  const port = wired.projectionPort;
  const runId = launchAgent(port, digest);
  const first = await awaitLiveTurn(port, runId);
  await interrupt(port, runId, first);
  const offer = await awaitFollowUpOffer(port, runId);

  assert.ok(sendFollowUp(port, offer, "first correction").admitted);
  assert.equal((await awaitSettled(port, "op-follow-up")).status, "applied");
  const second = await awaitLiveTurn(port, runId, first.turnId);
  await interrupt(port, runId, second, "op-interrupt-2");

  const waiting = await followRun(port, runId, (run) => {
    const next = run.state === "blocked" ? followUpOffer(run) : undefined;
    return next?.turnId === second.turnId ? { run, next } : undefined;
  });
  assert.equal(waiting.next.attemptId, offer.attemptId);
  assert.notEqual(second.turnId, first.turnId);
  assert.deepEqual(timelineDetails(waiting.run, "attempt-settled"), []);
  assert.deepEqual(timelineDetails(waiting.run, "turn-settled"), [
    "interrupted",
    "interrupted",
  ]);
});

test("a blank or stale follow-up changes nothing (#354)", async (t) => {
  const { wired, digest, harness } = wire(t, "follow-up");
  const port = wired.projectionPort;
  const runId = launchAgent(port, digest);
  await interrupt(port, runId, await awaitLiveTurn(port, runId));
  const offer = await awaitFollowUpOffer(port, runId);

  const blank = sendFollowUp(port, offer, "  \n ");
  assert.equal(blank.admitted, false);
  if (!blank.admitted) assert.equal(blank.problem.code, "follow-up-turn-blank");

  assert.ok(
    port.submit({
      operationId: "op-stale",
      operation: "send-follow-up-turn",
      input: { runId, turnId: `${offer.turnId}-old`, text: "hello" },
    }).admitted,
  );
  const stale = await awaitSettled(port, "op-stale");
  assert.equal(stale.status, "not-applied");
  if (stale.status === "not-applied") {
    assert.equal(stale.problem.code, "follow-up-turn-not-waiting");
  }
  const run = runView(port, runId);
  assert.equal(run.state, "blocked");
  assert.deepEqual(followUpOffer(run), offer);
  assert.equal(harness.requests.length, 1);
});

test("after a reopen the follow-up re-prepares the Harness and resumes the detached Session (#354)", async (t) => {
  const { wired, digest, dirs } = wire(t, "interrupt");
  const runId = launchAgent(wired.projectionPort, digest);
  await interrupt(
    wired.projectionPort,
    runId,
    await awaitLiveTurn(wired.projectionPort, runId),
  );
  await awaitSettled(wired.projectionPort, "op-launch");
  // Until #355, closing Secant keeps the waiting Run blocked and releases it.
  await wired.shutdown();
  wired.runGroup.close();
  wired.catalog.close();

  const reopened = harnessRecord();
  const next = wireOver(
    t,
    dirs,
    [{ profile: claudeProfile(), turns: [completedTurn()] }],
    reopened,
  );
  const port = next.projectionPort;
  const offer = followUpOffer(runView(port, runId));
  assert.ok(offer, "expected the follow-up offered after a reopen");

  assert.ok(sendFollowUp(port, offer, "Continue where you stopped.").admitted);
  assert.equal((await awaitSettled(port, "op-follow-up")).status, "applied");
  await awaitState(port, runId, "succeeded");
  assert.deepEqual(reopened.requests, [
    {
      session: "s",
      origin: "human",
      text: "Continue where you stopped.",
      resume: "s",
    },
  ]);
  await reopened.closed;
  assert.deepEqual([reopened.prepares, reopened.closes], [1, 1]);
});

test("a signal (Ctrl+C) mid-Turn cancels the Agent Attempt and rests the Run halted, not waiting (#118, #354, AC5)", async (t) => {
  // The headless OS-signal path (withClients) drives Application.shutdown(), which
  // aborts every live Run; a live Agent Turn interrupts at the Harness Seam and the
  // Run rests `halted` (resumable) — never `cancelled` and never waiting for a
  // follow-up (ADR 0019, ADR 0035). Exit-code (1 vs 130) is a separate concern
  // flagged as a spec conflict; the resting state is the AC value.
  const { wired, digest } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const runId = launchAgent(port, digest);
  await awaitLiveTurn(port, runId);

  await wired.shutdown();
  const run = runView(port, runId);
  assert.equal(run.state, "halted");
  assert.deepEqual(timelineDetails(run, "turn-settled"), ["interrupted"]);
  assert.deepEqual(timelineDetails(run, "attempt-settled"), ["cancelled"]);
  assert.equal(followUpOffer(run), undefined);
});

// Natural native boundaries release an ineffective interrupt independently of Steer.
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
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  let interruptRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    interruptRequested = resolve;
  });
  const interruptCalls: number[] = [];
  const releases: Array<() => Promise<unknown>> = [];
  const boundaries = Array.from(
    { length: 3 },
    (_, current) =>
      new Promise<void>((resolve) => {
        releases[current] = () => {
          resolve();
          return Promise.resolve();
        };
      }),
  );
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
                  finish: boundaries[index],
                  result: options.firstResult ?? COMPLETED_OPEN,
                },
                {
                  block: options.blockNext,
                  finish: boundaries[index + 1],
                  result: COMPLETED_OPEN,
                },
              ]
            : [
                {
                  block: options.blockNext,
                  finish: boundaries[index],
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
          readDefaults: () => harness.readDefaults(),
          close: () => harness.close(),
          startTurn(request) {
            const turn = harness.startTurn(request);
            const current = index++;
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
      requestedModel: FAKE_MODEL,
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

test("an accepted interrupt whose Agent Turn ends lost applies and still halts, with no follow-up offered (#354)", async (t) => {
  const f = await failedInterruptScenario(t, {
    first: "agent",
    next: "agent",
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
  await awaitSettled(f.port, "launch");
  const run = runView(f.port, f.runId);
  assert.equal(run.state, "halted");
  assert.deepEqual(timelineDetails(run, "turn-settled"), ["lost"]);
  assert.deepEqual(timelineDetails(run, "attempt-settled"), ["indeterminate"]);
  assert.equal(followUpOffer(run), undefined);
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

// In a Repeat group whose first span Step is an Agent Step, an Interrupt in a later
// pass leaves the attempt log ending exactly at the iteration boundary. The
// Projection must still name that Agent Step as the waiting current Step, not the
// group's last Step (#216's boundary case, #354).
test("an Agent Step opening a Repeat pass, interrupted in a later pass, waits as the current Step with the follow-up offered (#354)", async (t) => {
  const workspace = makeTempDir("secant-interrupt-ws-");
  const git = createFakeGitProcess();
  // Every test run exits non-zero, so the `until` Verdict reads `fail` and loops.
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: () => ({
      kind: "exited",
      status: 1,
      text: new Uint8Array(),
    }),
  });
  const wired = wireApplication({
    secantHome: makeTempDir("secant-interrupt-home-"),
    launchCwd: workspace,
    process: {
      resolveExecutable: (name, options) =>
        commands.resolveExecutable(name, options),
      spawnCommand: (options) => commands.spawnCommand(options),
      spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
      spawnCommandSync: (options) => git.spawnCommandSync(options),
    },
    harnessAdapter: sequencedAdapter([
      { profile: claudeProfile(), turns: [completedTurn(), blockingTurn()] },
    ]),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "claude",
        description: "PATH name 'claude'",
      },
    }),
  });
  t.after(async () => {
    await wired.shutdown();
    wired.runGroup.close();
    wired.catalog.close();
  });
  const folder = makeTempDir("secant-interrupt-bundle-");
  mkdirSync(join(folder, "prompts"));
  writeFileSync(join(folder, "prompts", "fix.md"), "Fix the test.\n");
  const runTest = (id: string) => ({
    id,
    kind: "command",
    produces: [{ name: "verdict", type: "verdict" }],
    command: { executable: RUNTIME_NAME, arguments: ["test"] },
  });
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id: "dev.secant.interrupt-repeat",
        version: "1.0.0",
        name: "Interrupt Repeat",
        description: "An Agent Step opening each Repeat pass.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [{ path: "prompts/fix.md", kind: "prompt" }],
      routing: [
        runTest("baseline"),
        {
          repeat: {
            until: "verdict",
            reviewCheckpoint: { interval: 5, message: "Keep repairing?" },
            steps: [
              {
                id: "fix",
                kind: "agent",
                session: "s",
                prompt: { asset: "prompts/fix.md" },
              },
              runTest("run-test"),
            ],
          },
        },
      ],
    }),
  );
  assert.ok(wired.bundleManagement.build(folder, { noInstall: false }).ok);
  const entry = wired.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.interrupt-repeat")!;
  const port = wired.projectionPort;
  assert.ok(
    port.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: entry.id },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: "claude-code",
      requestedModel: FAKE_MODEL,
    },
  });
  assert.ok(launch.admitted, JSON.stringify(launch));
  const runId = launch.runId!;

  // The first pass completes; interrupt the second pass's `fix` Turn.
  const live = await followRun(port, runId, (run) =>
    run.actionOffers.find(
      (candidate): candidate is InterruptTurnOffer =>
        candidate.action === "interrupt-turn" &&
        candidate.turnId.startsWith("1.0:fix#"),
    ),
  );
  await interrupt(port, runId, live);

  const offer = await awaitFollowUpOffer(port, runId);
  const run = runView(port, runId);
  assert.equal(run.state, "blocked");
  assert.deepEqual(
    run.progress.map((step) => [step.id, step.status]),
    [
      ["baseline", "succeeded"],
      ["fix", "blocked"],
      // Still marked from the completed first pass, as at an interactive Step's
      // iteration boundary (#216).
      ["run-test", "succeeded"],
    ],
  );
  assert.equal(run.progress[run.position]?.id, "fix");
  assert.equal(offer.stepId, "fix");
  assert.equal(offer.attemptId, "1.0:fix");
});
