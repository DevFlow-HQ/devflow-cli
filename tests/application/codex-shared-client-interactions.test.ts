import { readRun } from "./run-test-helpers.js";
import { writeAgentBundle as authorAgentBundle } from "../helpers/agentBundle.js";
import { storedProcess } from "../helpers/wiringDoubles.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type {
  HarnessProfile,
  TurnEvent,
  TurnResult,
} from "../../src/harness/harness.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import type {
  ProjectionPort,
  SteerTurnOffer,
} from "../../src/application/projection-port.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
} from "../harness/fake-adapter.js";

import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// A selected Codex Run drives the same normalized client interactions as Claude
// Code — the timeline shapes, the durable snapshot, and the Turn-scoped controls —
// with only the Adapter changed (#148, spec stories 15–23). The one client-visible
// difference is a capability the profile declares: Codex offers native same-Turn
// Steer where Claude Code cannot. Each test wires the Application against the
// deterministic fake Codex Harness (native steer available) and an injected fake
// Process — no child spawns (#184) — and drives the Port with `harness: "codex"`.

// The fake Codex Harness's profile: identical to Claude Code except native steer is
// available, which is the one client-visible difference these cases exercise.
const CODEX_PROFILE_OVERRIDES = {
  harness: "codex",
  executable: "codex",
  executableVersion: "0.0.0-fake-codex",
  adapterRevision: "fake-codex-1",
  recovery: {
    mode: "native-reattach",
    evidence: "fake codex reattaches a thread",
  },
  interruption: {
    mode: "process-only",
    evidence: "fake codex stops the process",
  },
  approvals: { available: true, evidence: "fake codex hosts approvals" },
  clarifications: {
    available: false,
    evidence: "fake codex offers no clarifications",
  },
  steer: {
    available: true,
    evidence: "fake codex offers native same-Turn steer",
  },
  modelSelection: {
    at: "unavailable",
    evidence: "fake codex selects no model",
  },
  modelObservation: {
    available: true,
    evidence: "fake codex observes its own model",
  },
  recoveryCoordinate: {
    timing: "before-submission",
    evidence: "fake codex mints a thread id",
  },
  skillDelivery: { mode: "plain-path", evidence: "fake codex reads a path" },
  fileDelivery: { mode: "plain-path", evidence: "fake codex reads a path" },
} satisfies Partial<HarnessProfile>;

const COMPLETED: TurnResult = {
  kind: "completed",
  detail: {
    effectiveModel: { known: true, model: "fake-codex-model" },
    session: { state: "open" },
  },
};

/** The fake Codex script for a fixture. The `steer` case blocks the live Turn so a
 *  native Steer can reach it, then completes at an explicit native boundary; `completion` completes
 *  straight away. Both emit a Session event and authoritative assistant content. */
function codexScript(fixture: string, finish: Promise<void>): FakeScript {
  const events: TurnEvent[] = [
    { kind: "session", availability: { state: "open" } },
    { kind: "assistant-content", content: `recorded ${fixture}` },
  ];
  if (fixture === "elicitation") {
    events.push({
      kind: "elicitation-declined",
      harness: "codex",
      server: "external",
      message: "Enter a code",
      url: "https://example.com/verify",
    });
    events.push({
      kind: "elicitation-declined",
      harness: "codex",
      server: "external",
      message: "Enter a name",
    });
  }
  if (fixture === "steer") {
    return {
      profile: fakeHarnessProfile(CODEX_PROFILE_OVERRIDES),
      turns: [{ events, block: true, finish, result: COMPLETED }],
    };
  }
  return {
    profile: fakeHarnessProfile(CODEX_PROFILE_OVERRIDES),
    turns: [{ events, result: COMPLETED }],
  };
}

/** A fake Process that resolves any executable and reaches no real child; Git store
 *  operations run through the deterministic fake Git process. */
function fakeProcess(): ProcessAdapter {
  return storedProcess({
    script: {
      commandHandler: () => ({
        kind: "exited",
        status: 0,
        text: new Uint8Array(),
      }),
    },
  });
}

/** Author a single-Agent-step Bundle whose prompt renders to exactly `prompt` — the
 *  recorded fixture replays strictly, so the rendered Turn input must match byte for
 *  byte (readAgentPrompt returns the asset bytes verbatim). */
function writeAgentBundle(prompt: string): { folder: string; id: string } {
  // No trailing newline: the recorded turn/start input carries none.

  const { folder } = authorAgentBundle({
    id: "dev.secant.codex-cli-e2e",
    name: "Codex Client E2E",
    description:
      "A single Agent Step Bundle driven through the Codex replayer.",
    prompt: { path: "prompts/go.md", text: prompt },
    routing: [
      {
        id: "work",
        kind: "agent",
        session: "s",
        prompt: { asset: "prompts/go.md" },
      },
    ],
  });
  return { folder, id: "dev.secant.codex-cli-e2e" };
}

/** Wire the Application with the Codex Adapter over the named recorded replayer, and
 *  a synthetic Codex discovery so Preflight admits the selection. Installs the
 *  single-Agent Bundle authored for `prompt` and approves the Workspace. */
function wire(
  t: TestContext,
  fixture: string,
  prompt: string,
): { wired: Wiring; bundleId: string; digest: string; finish: () => void } {
  let finish!: () => void;
  const boundary = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const workspace = makeTempDir("secant-codex-cli-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-codex-cli-home-"),
    launchCwd: workspace,
    process: fakeProcess(),
    codexHarnessAdapter: createFake(codexScript(fixture, boundary))(),
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

  const bundle = writeAgentBundle(prompt);
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
  return { wired, bundleId: bundle.id, digest: entry.digest, finish };
}

function launchCodex(
  port: ProjectionPort,
  bundleId: string,
  digest: string,
): string {
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundleId },
      launchInputs: {},
      trustDigest: digest,
      harness: "codex",
      requestedModel: "fake-model",
    },
  });
  assert.ok(launch.admitted, JSON.stringify(launch));
  assert.ok(launch.runId);
  return launch.runId;
}

/** Poll the run Projection until a live Turn offers `steer-turn` available, so a
 *  control targets the current live generation (a Turn's durable admission pushes no
 *  durable update). Returns the available offer. */
async function awaitSteerable(
  port: ProjectionPort,
  runId: string,
): Promise<Extract<SteerTurnOffer, { available: true }>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = readRun(port, runId);
    const steer = run.actionOffers.find(
      (offer): offer is SteerTurnOffer => offer.action === "steer-turn",
    );
    if (steer !== undefined && steer.available) return steer;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the Codex Agent Turn never offered an available steer");
}

test("[codex-shared-client-interactions] a live Codex Turn offers native Steer; steering keeps it working and the Run succeeds", async (t) => {
  const { wired, bundleId, digest, finish } = wire(
    t,
    "steer",
    "Think silently about the number one until you receive more guidance. Do not inspect files or run tools.",
  );
  const port = wired.projectionPort;
  const runId = launchCodex(port, bundleId, digest);

  // The steer Offer is available (the Codex profile declares native steer), and it
  // carries the live turnId — no Claude-specific "unavailable" wording reaches the
  // client. Interrupt is offered beside it, as for any live Turn.
  const steer = await awaitSteerable(port, runId);
  assert.equal(steer.available, true);
  assert.match(steer.consequence, /without ending the Turn/);
  const interrupt = readRun(port, runId).actionOffers.find(
    (offer) => offer.action === "interrupt-turn",
  );
  assert.ok(interrupt, "interrupt is offered beside steer on a live Turn");

  // Steering with the recorded guidance reaches the native Turn and is applied; the
  // Turn keeps working (steer never rests the Run) and then completes on its own.
  const steered = port.submit({
    operationId: "op-steer",
    operation: "steer-turn",
    input: {
      runId,
      turnId: steer.turnId,
      text: "Finish now with exactly: recorded steer.",
    },
  });
  assert.ok(steered.admitted);
  const steerOutcome = await awaitSettled(port, "op-steer");
  assert.equal(steerOutcome.status, "applied", JSON.stringify(steerOutcome));

  assert.equal(readRun(port, runId).state, "running");
  finish();
  await awaitSettled(port, "op-launch");
  const run = readRun(port, runId);
  assert.equal(run.state, "succeeded");
  // Codex activity normalizes into the same timeline vocabulary as Claude Code: a
  // Turn started and settled, with authoritative assistant content in between — no
  // protocol-specific frame kind crosses the Port (AC1/AC2).
  const kinds = run.timeline.map((event) => event.event);
  assert.ok(kinds.includes("turn-started"));
  assert.ok(kinds.includes("assistant-content"));
  assert.ok(kinds.includes("turn-settled"));
  const settlement = run.timeline.find((event) => event.event === "steer");
  assert.equal(settlement?.steer?.steerId, "op-steer");
  assert.equal(
    settlement?.steer?.text,
    "Finish now with exactly: recorded steer.",
  );
  assert.deepEqual(settlement?.steer?.settlement, {
    kind: "delivered",
    delivery: "within-turn",
  });
  assert.ok(settlement?.steer?.sentAt);
});

test("[codex-shared-client-interactions] a completed Codex Turn renders in existing timeline shapes and the Run succeeds", async (t) => {
  const { wired, bundleId, digest } = wire(
    t,
    "completion",
    "Reply with exactly: recorded completion.",
  );
  const port = wired.projectionPort;
  const runId = launchCodex(port, bundleId, digest);

  await awaitSettled(port, "op-launch");
  const run = readRun(port, runId);
  assert.equal(run.state, "succeeded");
  // A Codex Session records its availability through the same normalized view.
  assert.equal(run.sessions?.[0]?.session, "s");
  // The effective model Codex actually supplied surfaces as evidence (never a picker
  // in M4); a native model object never crosses the Port.
  assert.ok(run.effectiveModel !== undefined);
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, "completed");
});

test("[codex-shared-client-interactions] Interrupt records every pending Steer verbatim, replay stays singular, and late Steer is refused (#356)", async (t) => {
  const { wired, bundleId, digest } = wire(
    t,
    "steer",
    "Work until interrupted.",
  );
  const port = wired.projectionPort;
  const runId = launchCodex(port, bundleId, digest);
  const offer = await awaitSteerable(port, runId);
  const texts = [
    "first line\n\n" + "large text ".repeat(35) + "last line",
    "second message",
  ];
  for (const [index, text] of texts.entries()) {
    const operationId = `steer-${index}`;
    const submission = {
      operationId,
      operation: "steer-turn",
      input: { runId, turnId: offer.turnId, text },
    } as const;
    assert.ok(port.submit(submission).admitted);
    assert.equal((await awaitSettled(port, operationId)).status, "applied");
    assert.ok(port.submit(submission).admitted);
    assert.equal((await awaitSettled(port, operationId)).status, "applied");
  }
  assert.ok(
    port.submit({
      operationId: "stop",
      operation: "interrupt-turn",
      input: { runId, turnId: offer.turnId },
    }).admitted,
  );
  assert.equal((await awaitSettled(port, "stop")).status, "applied");
  await awaitSettled(port, "op-launch");
  const run = readRun(port, runId);
  // The Interrupt ends only the Turn: the Agent Step waits for the follow-up (#354).
  assert.equal(run.state, "blocked");
  assert.ok(
    run.actionOffers.some(
      (candidate) =>
        candidate.action === "send-follow-up-turn" &&
        candidate.turnId === offer.turnId,
    ),
  );
  const events = run.timeline.filter((event) => event.event === "steer");
  assert.deepEqual(
    events.map((event) => [
      event.steer?.steerId,
      event.steer?.text,
      event.steer?.settlement,
    ]),
    texts.map((text, index) => [
      `steer-${index}`,
      text,
      { kind: "dropped", reason: "interrupt" },
    ]),
  );
  assert.ok((events[0]?.detail?.length ?? 0) <= 160);
  const settlements = run.timeline.filter(
    (event) => event.event === "turn-settled",
  );
  assert.equal(settlements.length, 1);
  assert.ok(
    run.timeline.indexOf(events[1]!) < run.timeline.indexOf(settlements[0]!),
  );
  const draft = "my late draft\nstays verbatim";
  assert.ok(
    port.submit({
      operationId: "late",
      operation: "steer-turn",
      input: { runId, turnId: offer.turnId, text: draft },
    }).admitted,
  );
  const late = await awaitSettled(port, "late");
  assert.equal(late.status, "not-applied");
  if (late.status === "not-applied")
    assert.equal(late.problem.code, "turn-control-rejected");
  assert.equal(
    readRun(port, runId).timeline.filter((event) => event.event === "steer")
      .length,
    2,
  );
});

test("declined elicitations remain in Run history after the Turn completes", async (t) => {
  const { wired, bundleId, digest } = wire(t, "elicitation", "Reply now.");
  const port = wired.projectionPort;
  const runId = launchCodex(port, bundleId, digest);
  await awaitSettled(port, "op-launch");
  const run = readRun(port, runId);
  assert.equal(run.state, "succeeded");
  assert.deepEqual(
    run.timeline
      .filter((entry) => entry.event === "elicitation-declined")
      .map((entry) => entry.detail),
    [
      "Secant cannot show this elicitation. Finish setup in Codex directly before continuing. Declined from external: Enter a code · https://example.com/verify",
      "Secant cannot show this elicitation. Finish setup in Codex directly before continuing. Declined from external: Enter a name",
    ],
  );
});
