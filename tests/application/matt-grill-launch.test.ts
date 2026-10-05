import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type {
  HarnessAdapter,
  HarnessProfile,
  TurnResult,
} from "../../src/harness/harness.js";
import type {
  ActionOffer,
  RunView,
} from "../../src/application/projection-port.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";

// The maintained Matt Bundle's grill launched from a launch idea (#212), over the
// shared Projection Port with the real Application and Run Store on a temporary
// home and a fake Harness under each v1 Harness selection. The grill Step opts into
// an authored entry Turn: its first Turn is the rendered grill prompt carrying the
// idea and the bundled grill-me/grilling paths, so the human never pastes the idea.
// Later Turns are the human's verbatim text in the same planning Session; End Step,
// halt and resume, and an unusable Session keep the Run history truthful.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MATT_FOLDER = join(repoRoot, "bundles", "matt-front-spec");
const MATT_ID = "dev.secant.matt-front";
const IDEA = "Add a dark-mode toggle that follows me across devices.";

type HarnessId = "claude-code" | "codex";

function profile(harness: HarnessId): HarnessProfile {
  return {
    harness: harness === "codex" ? "codex" : "Claude Code",
    executable: harness === "codex" ? "codex" : "fake-claude",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    agentCalls: {
      available: true,
      evidence: "Scripted agent calls.",
    },
    clarifications: { available: false, evidence: "scripted fake" },
    // Codex's one client-visible difference: native same-Turn steer.
    steer: { available: harness === "codex", evidence: "scripted fake" },
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
}

function completed(content: string): FakeScript["turns"][number] {
  return {
    events: [{ kind: "assistant-content", content }],
    result: {
      kind: "completed",
      detail: {
        finalContent: content,
        effectiveModel: { known: true, model: "fake-model" },
        session: { state: "detached", coordinate: { opaque: "coord-spec" } },
      },
    },
  };
}

const BLOCKS: FakeScript["turns"][number] = {
  block: true,
  result: {
    kind: "completed",
    detail: {
      finalContent: "unused",
      effectiveModel: { known: false },
      session: { state: "detached", coordinate: { opaque: "coord-spec" } },
    },
  },
};

const UNUSABLE: TurnResult = {
  kind: "failed",
  detail: {
    failure: {
      phase: "recovery",
      category: "session-unusable",
      possibleEffects: "none",
      cause: undefined,
      diagnostics: "the native conversation could not be recovered",
    },
    effectiveModel: { known: false },
    session: { state: "unusable", reason: "native recovery failed" },
  },
};

/** An Adapter whose Nth `prepare` serves `scripts[N]` (the last repeats), so a
 *  launch, a resume, and a reopened Turn can each see their own scripted Turns. */
function scriptedAdapter(
  harness: HarnessId,
  scripts: readonly (readonly FakeScript["turns"][number][])[],
): { adapter: HarnessAdapter; prepares: () => number } {
  let prepares = 0;
  return {
    adapter: {
      prepare(options) {
        const turns = scripts[Math.min(prepares, scripts.length - 1)]!;
        prepares += 1;
        return createFake({ profile: profile(harness), turns })().prepare(
          options,
        );
      },
    },
    prepares: () => prepares,
  };
}

function wire(
  t: TestContext,
  harness: HarnessId,
  adapter: HarnessAdapter,
  supportsInteractiveTurns = true,
  historical = false,
): { wired: Wiring; digest: string } {
  const workspace = makeTempDir("secant-matt-grill-ws-");
  const found = (name: string) => () => ({
    kind: "found" as const,
    attempt: {
      source: "path" as const,
      name,
      description: `PATH name '${name}'`,
    },
  });
  const wired = wireApplication({
    secantHome: makeTempDir("secant-matt-grill-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns,
    process: createFakeBundleProcess(),
    discoverClaudeCode: found("claude"),
    discoverCodex: found("codex"),
    ...(harness === "codex"
      ? { codexHarnessAdapter: adapter }
      : { harnessAdapter: adapter }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  // The maintained Bundle is built and installed exactly like a user's Bundle.
  const built = historical
    ? wired.bundleManagement.install(
        join(repoRoot, "tests", "application", "fixtures", "matt-2.7.0.wfb"),
      )
    : wired.bundleManagement.build(MATT_FOLDER, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = wired.catalog.listEntries().find((e) => e.id === MATT_ID);
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

function submitLaunch(
  wired: Wiring,
  digest: string,
  harness: HarnessId,
  launchInputs: Readonly<Record<string, string>>,
) {
  return wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: MATT_ID },
      launchInputs,
      trustDigest: digest,
      harness,
      requestedModel: "fake-model",
    },
  });
}

async function launch(
  wired: Wiring,
  digest: string,
  harness: HarnessId,
): Promise<string> {
  const admission = submitLaunch(wired, digest, harness, { idea: IDEA });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  const outcome = await awaitSettled(wired.projectionPort, "op-launch");
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  return admission.runId;
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

function offer<A extends ActionOffer["action"]>(
  run: RunView,
  action: A,
): Extract<ActionOffer, { action: A }> | undefined {
  return run.actionOffers.find((o) => o.action === action) as
    Extract<ActionOffer, { action: A }> | undefined;
}

function userEntries(wired: Wiring, run: RunView): string[] {
  const reference = run.sessions?.[0]?.transcriptPage;
  assert.ok(reference, JSON.stringify(run.sessions));
  const transcript = wired.projectionPort.readTranscript(reference);
  assert.ok(transcript.found);
  if (!transcript.found) throw new Error("unreachable");
  return transcript.entries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content);
}

/** The durable Turns, read through an owner once nothing is live in-process. */
function turns(wired: Wiring, runId: string) {
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    return owner.turns().map((turn) => ({
      origin: turn.origin,
      kind: turn.kind,
      session: turn.session,
      resultKind: turn.resultKind,
    }));
  } finally {
    owner.close();
  }
}

async function submitAndSettle(
  wired: Wiring,
  operationId: string,
  submission: Parameters<Wiring["projectionPort"]["submit"]>[0],
) {
  const admission = wired.projectionPort.submit(submission);
  assert.ok(admission.admitted, JSON.stringify(admission));
  return awaitSettled(wired.projectionPort, operationId);
}

async function awaitInterruptOffer(wired: Wiring, runId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const interrupt = offer(readRun(wired, runId), "interrupt-turn");
    if (interrupt !== undefined) return interrupt;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the entry Turn never exposed its interrupt Offer");
}

for (const harness of ["claude-code", "codex"] as const) {
  test(`[${harness}] the launch idea reaches the grill's first Turn with the bundled grill-me and grilling paths (#212)`, async (t) => {
    const { adapter } = scriptedAdapter(harness, [
      [
        completed("Q1 - Who toggles it? Recommended: each user."),
        completed("Q2 - Where is it stored? Recommended: the profile."),
      ],
    ]);
    const { wired, digest } = wire(t, harness, adapter);
    const runId = await launch(wired, digest, harness);

    // The entry Turn ran on launch: the Run rests at the grill's Turn boundary with
    // one Turn already taken, offering the human the next Turn and End Step.
    const run = readRun(wired, runId);
    assert.equal(run.state, "blocked");
    assert.equal(run.progress[run.position]?.id, "grill");
    assert.equal(run.turnPosition, 1);
    assert.ok(offer(run, "send-interactive-turn"));
    assert.ok(offer(run, "end-interactive-step"));

    const [entry] = userEntries(wired, run);
    assert.ok(entry);
    // The idea is sent verbatim, so the human never pastes it a second time.
    assert.ok(entry.includes(IDEA), entry);
    // Each supplied skill folder resolves through its bundled path, unchanged and
    // complete — the SKILL.md and its supporting metadata.
    for (const skill of ["grill-me", "grilling"]) {
      const match = new RegExp(`(\\S*[\\\\/]${skill}[\\\\/]SKILL\\.md)`).exec(
        entry,
      );
      assert.ok(match, `${skill} path missing from: ${entry}`);
      const bundled = dirname(match[1]!);
      for (const file of ["SKILL.md", join("agents", "openai.yaml")]) {
        const path = join(bundled, file);
        assert.ok(existsSync(path), path);
        assert.deepEqual(
          readFileSync(path),
          readFileSync(join(MATT_FOLDER, "skills", skill, file)),
        );
      }
    }
    // The prompt tells the agent to resolve the nested Skill-tool call by path.
    assert.match(entry, /Skill tool/);

    // A later Turn is the human's verbatim text in the same planning Session.
    const sent = await submitAndSettle(wired, "op-turn-2", {
      operationId: "op-turn-2",
      operation: "send-interactive-turn",
      input: { runId, stepId: "grill", text: "Each user; store it." },
    });
    assert.equal(sent.status, "applied", JSON.stringify(sent));
    const afterTurn = await awaitRunRest(wired.projectionPort, runId);
    assert.equal(afterTurn.state, "blocked");
    assert.equal(afterTurn.turnPosition, 2);
    assert.deepEqual(userEntries(wired, afterTurn).slice(1), [
      "Each user; store it.",
    ]);

    // The human ends the grill explicitly; the Run moves past it and the planning
    // Session is retained (detached) for the later spec Step.
    const ended = await submitAndSettle(wired, "op-end", {
      operationId: "op-end",
      operation: "end-interactive-step",
      input: { runId, stepId: "grill" },
    });
    assert.equal(ended.status, "applied", JSON.stringify(ended));
    const afterEnd = readRun(wired, runId);
    assert.equal(afterEnd.progress[0]?.status, "succeeded");
    assert.equal(afterEnd.pendingGate?.gate.stepId, "choose-tracker");
    assert.deepEqual(
      afterEnd.sessions?.map((s) => [s.session, s.availability]),
      [["spec", "detached"]],
    );
    assert.ok(
      afterEnd.timeline.some(
        (event) => event.event === "interactive-step-ended",
      ),
    );
    // The entry Turn is Secant-authored (`managed`); the later Turn is `human`. Both
    // are Interactive Turns of the one planning Session.
    assert.deepEqual(turns(wired, runId), [
      {
        origin: "managed",
        kind: "interactive-agent",
        session: "spec",
        resultKind: "completed",
      },
      {
        origin: "human",
        kind: "interactive-agent",
        session: "spec",
        resultKind: "completed",
      },
    ]);
  });
}

test("the grill cannot launch without its required idea (#212)", (t) => {
  const { adapter, prepares } = scriptedAdapter("claude-code", [[]]);
  const { wired, digest } = wire(t, "claude-code", adapter);
  const admission = submitLaunch(wired, digest, "claude-code", {});
  assert.equal(admission.admitted, false, JSON.stringify(admission));
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "launch-input-invalid");
  assert.deepEqual(
    admission.problem.fieldViolations?.map((violation) => violation.field),
    ["idea"],
  );
  assert.equal(prepares(), 0);
  assert.deepEqual(wired.runGroup.listRuns(), []);
});

test("an interrupted entry Turn returns the grill to waiting in the same Session without re-sending the idea (#212, #353)", async (t) => {
  // One Step-scoped Harness: the entry Turn blocks until interrupted, and the
  // human's next Turn on the same Harness completes.
  const { adapter, prepares } = scriptedAdapter("claude-code", [
    [BLOCKS, completed("Where were we? Recommended: the storage question.")],
  ]);
  const { wired, digest } = wire(t, "claude-code", adapter);
  const admission = submitLaunch(wired, digest, "claude-code", { idea: IDEA });
  assert.ok(admission.admitted && admission.runId);
  const runId = admission.runId;

  const interrupt = await awaitInterruptOffer(wired, runId);
  const interrupted = await submitAndSettle(wired, "op-interrupt", {
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: interrupt.turnId },
  });
  assert.equal(interrupted.status, "applied", JSON.stringify(interrupted));
  await awaitSettled(wired.projectionPort, "op-launch");

  // The grill waits at its Turn boundary, not halted: the interrupted entry Turn
  // stays in history, is not re-sent, and the Harness stays held.
  const waiting = readRun(wired, runId);
  assert.equal(waiting.state, "blocked");
  assert.equal(waiting.turnPosition, 1);
  assert.ok(offer(waiting, "send-interactive-turn"));
  assert.deepEqual(
    waiting.timeline
      .filter((event) => event.event === "turn-settled")
      .map((event) => event.detail),
    ["interrupted"],
  );

  // The human continues the same planning Session.
  const sent = await submitAndSettle(wired, "op-continue", {
    operationId: "op-continue",
    operation: "send-interactive-turn",
    input: { runId, stepId: "grill", text: "Please continue." },
  });
  assert.equal(sent.status, "applied", JSON.stringify(sent));
  const after = await awaitRunRest(wired.projectionPort, runId);
  assert.equal(after.state, "blocked");
  assert.deepEqual(userEntries(wired, after).slice(1), ["Please continue."]);
  assert.deepEqual(
    turns(wired, runId).map((turn) => [
      turn.origin,
      turn.session,
      turn.resultKind,
    ]),
    [
      ["managed", "spec", "interrupted"],
      ["human", "spec", "completed"],
    ],
  );
  assert.equal(prepares(), 1);
});

test("shutdown during the entry Turn still halts the grill (#212, #353, ADR 0019)", async (t) => {
  const { adapter } = scriptedAdapter("claude-code", [[BLOCKS]]);
  const { wired, digest } = wire(t, "claude-code", adapter);
  const admission = submitLaunch(wired, digest, "claude-code", { idea: IDEA });
  assert.ok(admission.admitted && admission.runId);
  const runId = admission.runId;
  await awaitInterruptOffer(wired, runId);

  // The signal settles the entry Turn `interrupted` too, but it is no Interrupt.
  await wired.shutdown();

  const halted = readRun(wired, runId);
  assert.equal(halted.state, "halted");
  assert.ok(offer(halted, "resume-run")?.available);
  assert.deepEqual(
    turns(wired, runId).map((turn) => [turn.origin, turn.resultKind]),
    [["managed", "interrupted"]],
  );
  assert.equal(
    wired.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    false,
  );
});

test("an unusable planning Session is reported, never replaced by a fresh conversation (#212)", async (t) => {
  const { adapter } = scriptedAdapter("claude-code", [
    [{ result: UNUSABLE }],
    [completed("a fabricated fresh conversation")],
  ]);
  const { wired, digest } = wire(t, "claude-code", adapter);
  const runId = await launch(wired, digest, "claude-code");

  // The failed entry Turn is truthful history; the Session reads unusable.
  const run = readRun(wired, runId);
  assert.equal(run.state, "blocked");
  assert.equal(run.sessions?.[0]?.availability, "unusable");

  // A later human Turn cannot open a fresh conversation in its place, and the send
  // is not applied: its Turn was never admitted (#290).
  const refused = await submitAndSettle(wired, "op-after-unusable", {
    operationId: "op-after-unusable",
    operation: "send-interactive-turn",
    input: { runId, stepId: "grill", text: "Are you still there?" },
  });
  assert.equal(refused.status, "not-applied", JSON.stringify(refused));
  if (refused.status === "not-applied") {
    assert.equal(refused.problem.code, "interactive-turn-not-admitted");
  }
  assert.equal(readRun(wired, runId).sessions?.[0]?.availability, "unusable");
  assert.deepEqual(
    turns(wired, runId).map((turn) => [turn.origin, turn.resultKind]),
    [["managed", "failed"]],
  );
});

test("the headless client refuses the Matt grill at Preflight with the TUI remediation (#212)", async (t) => {
  const { adapter, prepares } = scriptedAdapter("claude-code", [[]]);
  const { wired } = wire(t, "claude-code", adapter, false);
  const out: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => out.push(text),
    cwd: () => process.cwd(),
  };
  const code = await runHeadless(
    {
      projectionPort: wired.projectionPort,
      bundleManagement: wired.bundleManagement,
    },
    ["run", "launch", MATT_ID, "--input", `idea=${IDEA}`],
    io,
  );
  const output = out.join("");
  // A Preflight refusal is exit 1, never the Human-Gate `blocked` exit 2.
  assert.equal(code, 1, output);
  assert.match(output, /interactive-step-needs-tui/);
  assert.match(output, /Run this Bundle in the TUI\./);
  assert.equal(prepares(), 0);
  assert.deepEqual(wired.runGroup.listRuns(), []);
});

test("a Run pinned to Matt 2.7.0 keeps its prompt and human controls after 2.8.0 installs (#374)", async (t) => {
  const { adapter } = scriptedAdapter("claude-code", [
    [completed("Discussing."), completed("Still discussing.")],
  ]);
  const { wired, digest } = wire(t, "claude-code", adapter, true, true);
  const runId = await launch(wired, digest, "claude-code");
  const before = readRun(wired, runId);
  assert.equal(before.bundle.version, "2.7.0");
  assert.match(
    userEntries(wired, before)[0] ?? "",
    /nothing\s+either of us says in the conversation ends it/,
  );
  const output = join(makeTempDir("secant-matt-upgrade-"), "matt.wfb");
  const built = wired.bundleManagement.build(MATT_FOLDER, {
    noInstall: true,
    output,
  });
  assert.ok(built.ok, JSON.stringify(built));
  assert.deepEqual(wired.ensureShippedBundles([output]), []);
  assert.deepEqual(wired.ensureShippedBundles([output]), []);
  assert.deepEqual(
    wired.catalog
      .listEntries()
      .map((entry) => entry.version)
      .sort(),
    ["2.7.0", "2.8.0"],
  );
  await submitAndSettle(wired, "op-old-turn", {
    operationId: "op-old-turn",
    operation: "send-interactive-turn",
    input: { runId, stepId: "grill", text: "Continue the old interview." },
  });
  await awaitRunRest(wired.projectionPort, runId);
  const after = readRun(wired, runId);
  assert.deepEqual(after.bundle, before.bundle);
  assert.equal(after.state, "blocked");
  assert.ok(offer(after, "end-interactive-step"));
  assert.equal(userEntries(wired, after).at(-1), "Continue the old interview.");
  const ended = await submitAndSettle(wired, "op-old-end", {
    operationId: "op-old-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "grill" },
  });
  assert.equal(ended.status, "applied");
  assert.equal(
    readRun(wired, runId).pendingGate?.gate.stepId,
    "choose-tracker",
  );
});
