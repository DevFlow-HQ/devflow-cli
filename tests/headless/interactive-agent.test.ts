import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessFailure,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import type {
  ActionOffer,
  RunView,
  HarnessChoice,
} from "../../src/application/projection-port.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
import {
  awaitRunRest,
  awaitSettled,
  followRun,
} from "../helpers/settleOperation.js";

// The first Interactive agent Step end to end (#122): a synthesized Bundle
// `interactive-agent (session "s") -> agent (session "s")` launched through the
// composition wiring against the deterministic fake Adapter with the TUI's
// `supportsInteractiveTurns`. The Run rests `blocked` at the interactive Step; each
// `send-interactive-turn` is one human Turn whose verbatim text is the transcript
// input; `end-interactive-step` settles the Step and the following Agent Step reuses
// the Session. Headless still refuses such a Bundle at Preflight (that stays in
// preflight.test.ts); this suite drives the whole Interactive path.

function profile(): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "fake-claude",
    executableVersion: "0.0.0-fake",
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

/** One scripted Turn that completes and leaves the Session detached, so the next
 *  human Turn (and the following Agent Step) resumes the same Session. Every Turn
 *  the fake serves in this suite reuses it: a fresh prepared Harness per human Turn
 *  replays the same script entry, which is exactly the detached-resume path. */
const COMPLETED_DETACHED: FakeScript["turns"][number] = {
  result: {
    kind: "completed",
    detail: {
      finalContent: "acknowledged",
      effectiveModel: { known: true, model: "fake-sonnet" },
      session: { state: "detached", coordinate: { opaque: "coord-s" } },
    },
  },
};

/** The default `interactive-agent (session "s") -> agent (session "s")` Routing. */
const DEFAULT_ROUTING: readonly unknown[] = [
  {
    id: "discuss",
    kind: "interactive-agent",
    session: "s",
    prompt: { asset: "prompts/discuss.md" },
  },
  {
    id: "apply",
    kind: "agent",
    session: "s",
    prompt: { asset: "prompts/apply.md" },
  },
];

/** Author a Bundle over `routing` (the interactive -> agent pair by default). */
function writeInteractiveBundle(routing = DEFAULT_ROUTING): {
  folder: string;
  id: string;
} {
  const folder = makeTempDir("secant-interactive-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "discuss.md"), "Discuss the plan.\n");
  writeFileSync(join(folder, "prompts", "apply.md"), "Apply the plan.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.interactive-e2e",
      version: "1.0.0",
      name: "Interactive E2E",
      description: "An interactive-agent -> agent Bundle for the first Step.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [
      { path: "prompts/discuss.md", kind: "prompt" },
      { path: "prompts/apply.md", kind: "prompt" },
    ],
    routing,
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Wire the Application against a temporary home and the fake Adapter with the TUI's
 *  interactive-turn support, install the Bundle, approve the Workspace, and launch
 *  the Run to its first `blocked` rest at the interactive Step. */
async function launchInteractive(
  t: TestContext,
  script: FakeScript | HarnessAdapter,
  counts?: {
    prepares: number;
    readonly closes: number[];
    readonly failureAfterLaunch?: HarnessFailure;
    /** Each Turn's `resume` coordinate, in start order (undefined = fresh). */
    readonly resumes?: (string | undefined)[];
    /** The script every prepare after the first serves (a fresh prepared fake
     *  otherwise replays the launch script from its first Turn). */
    readonly laterScript?: FakeScript;
  },
  routing?: readonly unknown[],
  harness: HarnessChoice["id"] = "claude-code",
): Promise<{ wired: Wiring; runId: string; run: RunView; home: string }> {
  // A resolvable executable so Preflight's Harness discovery passes; the fake
  // Adapter is what actually runs, never this path.
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });

  const workspace = makeTempDir("secant-interactive-ws-");
  const fake = "prepare" in script ? script : createFake(script)();
  const adapter: HarnessAdapter =
    counts === undefined
      ? fake
      : ownPreparations({
          async prepare(options) {
            counts.prepares += 1;
            if (
              counts.prepares > 1 &&
              counts.failureAfterLaunch !== undefined
            ) {
              return { ok: false, failure: counts.failureAfterLaunch };
            }
            const index = counts.closes.push(0) - 1;
            const prepared = await (
              counts.prepares > 1 && counts.laterScript !== undefined
                ? createFake(counts.laterScript)()
                : fake
            ).prepare(options);
            if (!prepared.ok) return prepared;
            const harness = prepared.harness;
            return {
              ok: true,
              harness: {
                profile: harness.profile,
                readDefaults: () => harness.readDefaults(),
                startTurn: (request) => {
                  counts.resumes?.push(request.resume?.opaque);
                  return harness.startTurn(request);
                },
                async close() {
                  counts.closes[index] = counts.closes[index]! + 1;
                  return harness.close();
                },
              },
            };
          },
        });
  const home = makeTempDir("secant-interactive-home-");
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    ...(harness === "claude-code"
      ? { harnessAdapter: adapter }
      : {
          codexHarnessAdapter: adapter,
          discoverCodex: () => ({
            kind: "found" as const,
            attempt: {
              source: "path" as const,
              name: "codex",
              description: "scripted Codex",
            },
          }),
        }),
    process: createFakeBundleProcess({ executables: [process.execPath] }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeInteractiveBundle(routing);
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

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
      harness,
      // The fake selects no model, so any Model choice is admitted.
      requestedModel: "fake-model",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  return { wired, runId, run: readRun(wired, runId), home };
}

/** Read the current `run` snapshot. */
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

async function send(
  wired: Wiring,
  runId: string,
  operationId: string,
  stepId: string,
  text: string,
): Promise<void> {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "send-interactive-turn",
    input: { runId, stepId, text },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  // `applied` means the Turn was admitted; its result arrives on the Run (#290).
  await awaitRunRest(wired.projectionPort, runId);
}

async function awaitInterruptOffer(wired: Wiring, runId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const interrupt = offer(readRun(wired, runId), "interrupt-turn");
    if (interrupt !== undefined) return interrupt;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the interactive Turn never exposed its interrupt Offer");
}

test("interactive-agent rests blocked, takes two human Turns, and ends into the same Session (#122)", async (t) => {
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId, run } = await launchInteractive(
    t,
    {
      profile: profile(),
      turns: [COMPLETED_DETACHED, COMPLETED_DETACHED, COMPLETED_DETACHED],
    },
    counts,
  );

  // Rests `blocked` at the interactive Step with the "interactive Turn" basis, and
  // offers exactly send + end at the boundary; no Attempt has settled yet.
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.kind, "interactive-agent");
  const sendOffer = offer(run, "send-interactive-turn");
  assert.ok(sendOffer, JSON.stringify(run.actionOffers));
  assert.equal(sendOffer.basis, "interactive Turn");
  assert.ok(offer(run, "end-interactive-step"));
  assert.equal(run.turnPosition, undefined);

  // Two human Turns: each is one Turn whose verbatim text is the transcript input.
  await send(wired, runId, "op-t1", "discuss", "let us start here");
  const afterOne = readRun(wired, runId);
  assert.equal(afterOne.state, "blocked");
  assert.equal(afterOne.turnPosition, 1);

  await send(wired, runId, "op-t2", "discuss", "now the next idea");
  assert.equal(counts.prepares, 1);
  assert.deepEqual(counts.closes, [0]);
  const afterTwo = readRun(wired, runId);
  assert.equal(afterTwo.turnPosition, 2);
  const transcriptReference = afterTwo.sessions?.[0]?.transcriptPage;
  assert.ok(transcriptReference);
  const transcript = wired.projectionPort.readTranscript(transcriptReference);
  assert.ok(transcript.found);
  if (!transcript.found) throw new Error("unreachable");
  const humanInputs = transcript.entries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content);
  assert.deepEqual(humanInputs, ["let us start here", "now the next idea"]);
  // The Session detached after each human Turn, so the next Turn resumes it.
  assert.equal(afterTwo.sessions?.length, 1);
  assert.equal(afterTwo.sessions?.[0]?.session, "s");
  assert.equal(afterTwo.sessions?.[0]?.availability, "detached");
  // #124: a detached Session that recorded human Turns still advertises its
  // transcript page/export References.
  assert.equal(afterTwo.sessions?.[0]?.transcriptPage?.type, "transcript-page");
  assert.equal(
    afterTwo.sessions?.[0]?.transcriptExport?.type,
    "transcript-export",
  );

  // End the Step at a boundary: it settles succeeded and the Agent Step reuses "s".
  const end = wired.projectionPort.submit({
    operationId: "op-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "discuss" },
  });
  assert.ok(end.admitted, JSON.stringify(end));
  const endOutcome = await awaitSettled(wired.projectionPort, "op-end");
  assert.equal(endOutcome.status, "applied", JSON.stringify(endOutcome));
  assert.equal(counts.prepares, 2);
  assert.deepEqual(counts.closes, [1, 1]);

  const done = readRun(wired, runId);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(
    done.progress.map((s) => s.status),
    ["succeeded", "succeeded"],
  );

  // The human Turns are origin `human`; the autonomous Agent Turn is `managed`. The
  // Run has rested, so acquiring the owner here fences nothing live. The Crucible
  // Turn kind is recorded independently (#126): the two Interactive Turns and the
  // following Agent Turn are distinguished even though they share one Session.
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    const origins = owner.turns().map((turn) => turn.origin);
    assert.deepEqual(origins, ["human", "human", "managed"]);
    const kinds = owner.turns().map((turn) => turn.kind);
    assert.deepEqual(kinds, [
      "interactive-agent",
      "interactive-agent",
      "agent",
    ]);
  } finally {
    owner.close();
  }

  // After settlement and reopen, the projected durable timeline distinguishes the
  // same historical Turn kinds in the same order — both clients read them off the
  // `turn-started` entries, never from `progress[position]` (#126).
  const timelineKinds = done.timeline
    .filter((event) => event.event === "turn-started")
    .map((event) => event.turnKind);
  assert.deepEqual(timelineKinds, [
    "interactive-agent",
    "interactive-agent",
    "agent",
  ]);
  assert.ok(
    done.timeline.some((event) => event.event === "interactive-step-ended"),
    JSON.stringify(done.timeline),
  );

  // The headless client reads the same reopened history: `run show` prints each
  // historical Turn kind in the same order (AC4), the Interactive Turns before the
  // Agent Turn.
  const shown = await runShow(wired, runId);
  const firstInteractive = shown.indexOf("turn-started interactive-agent");
  const firstAgent = shown.indexOf("turn-started agent");
  assert.ok(firstInteractive >= 0, shown);
  assert.ok(firstAgent > firstInteractive, shown);
  assert.match(shown, /interactive-step-ended/);
});

test("run show names the interactive Turn basis for a blocked interactive Step (#122, A15)", async (t) => {
  // The interactive Turn is the second of the three blocked bases `run show` must name
  // (durable Human Gate, interactive Turn, ephemeral Harness Request). It comes off the
  // durable send-interactive-turn Offer, so `run show` prints it from the snapshot alone.
  const { wired, runId, run } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });
  assert.equal(run.state, "blocked");
  const shown = await runShow(wired, runId);
  assert.match(shown, /Blocked: interactive Turn/);
});

/** Render the headless `run show` for a Run through the public headless entrypoint,
 *  so this reads the reopened history exactly as the CLI client does. */
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

test("a blank interactive Turn is refused before any stdin is sent (#122)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });

  const admission = wired.projectionPort.submit({
    operationId: "op-blank",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "   \n\t " },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "interactive-turn-blank");

  // No Turn was admitted: the Run is still at its first blocked rest.
  const run = readRun(wired, runId);
  assert.equal(run.state, "blocked");
  assert.equal(run.turnPosition, undefined);
});

test("Claude Code reserved Human Turns are refused before Operation or Turn admission (#358)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });
  for (const text of [
    "/clear",
    " \t/Clear now",
    "/new",
    "/reset",
    "/resume",
    "/continue",
    "/fork",
    "/model",
    "/effort",
    "/fast",
    "/config",
  ]) {
    const admission = wired.projectionPort.submit({
      operationId: "op-reserved",
      operation: "send-interactive-turn",
      input: { runId, stepId: "discuss", text },
    });
    assert.equal(admission.admitted, false);
    if (admission.admitted) throw new Error("unreachable");
    assert.equal(admission.problem.code, "harness-input-reserved");
    assert.match(admission.problem.explanation, /Claude Code/);
    assert.match(admission.problem.explanation, /Secant/);
    assert.match(
      admission.problem.explanation,
      /conversation, Model choice, or permission/,
    );
    assert.equal(admission.problem.possibleEffects, "none");
    const run = readRun(wired, runId);
    assert.equal(run.state, "blocked");
    assert.equal(run.turnPosition, undefined);
  }
  // A refusal consumes no Operation id: the same id can admit corrected text.
  const admission = wired.projectionPort.submit({
    operationId: "op-reserved",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "please explain /clear" },
  });
  assert.ok(admission.admitted);
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-reserved")).status,
    "applied",
  );
  await awaitRunRest(wired.projectionPort, runId);
});

test("a Human Turn for an unknown Run is refused before Operation admission (#358)", async (t) => {
  const { wired } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });
  const admission = wired.projectionPort.submit({
    operationId: "op-unknown",
    operation: "send-interactive-turn",
    input: { runId: "missing-run", stepId: "discuss", text: "hello" },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "run-not-found");
});

test("an unselected legacy Run uses Claude Code's rules without upgrading or admitting (#358)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });
  const original = wired.runGroup.readRun(runId);
  assert.ok(original.ok);
  const legacy = wired.runGroup.createRun({
    operationId: "legacy-seed",
    bundleSnapshotDigest: original.run.bundleSnapshotDigest,
    launch: {},
    at: new Date("2026-10-03T00:00:00Z"),
  });
  const owner = wired.runGroup.acquireRun(legacy.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("blocked"), { ok: true });
  owner.close();
  const admission = wired.projectionPort.submit({
    operationId: "op-legacy-reserved",
    operation: "send-interactive-turn",
    input: { runId: legacy.runId, stepId: "discuss", text: "/clear" },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "harness-input-reserved");
  // Opening a Run Projection would itself upgrade this fixture. Read through the
  // Store Interface to prove refusal did not persist a selection or change state.
  const unchanged = wired.runGroup.readRun(legacy.runId);
  assert.ok(unchanged.ok);
  assert.equal(unchanged.run.selectedHarness, undefined);
  assert.equal(unchanged.run.state, "blocked");
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-legacy-reserved",
      operation: "send-interactive-turn",
      input: { runId, stepId: "discuss", text: "hello" },
    }).admitted,
  );
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-legacy-reserved")).status,
    "applied",
  );
  await awaitRunRest(wired.projectionPort, runId);
});

test("a damaged Run store refuses a Human Turn before Operation admission (#358)", async (t) => {
  const { wired, runId, home } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });
  const original = wired.runGroup.readRun(runId);
  assert.ok(original.ok);
  const damaged = wired.runGroup.createRun({
    operationId: "damaged-seed",
    bundleSnapshotDigest: original.run.bundleSnapshotDigest,
    launch: {},
    at: new Date("2026-10-03T00:00:00Z"),
  });
  const directory = readdirSync(home, {
    recursive: true,
    withFileTypes: true,
  }).find((entry) => entry.isDirectory() && entry.name === damaged.runId);
  assert.ok(directory);
  writeFileSync(
    join(directory.parentPath, damaged.runId, "run.db"),
    "damaged database",
  );
  const admission = wired.projectionPort.submit({
    operationId: "op-damaged",
    operation: "send-interactive-turn",
    input: { runId: damaged.runId, stepId: "discuss", text: "hello" },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "run-store-damaged");
});

test("Codex admits reserved-looking Human Turns unchanged (#358)", async (t) => {
  const { wired, runId } = await launchInteractive(
    t,
    {
      profile: { ...profile(), harness: "Codex" },
      turns: Array.from({ length: 11 }, () => COMPLETED_DETACHED),
    },
    undefined,
    undefined,
    "codex",
  );
  for (const [index, text] of [
    "/clear",
    " \t/Clear now",
    "/new",
    "/reset",
    "/resume",
    "/continue",
    "/fork",
    "/model",
    "/effort",
    "/fast",
    "/config",
  ].entries()) {
    const operationId = `op-codex-${index}`;
    const admission = wired.projectionPort.submit({
      operationId,
      operation: "send-interactive-turn",
      input: { runId, stepId: "discuss", text },
    });
    assert.ok(admission.admitted, JSON.stringify(admission));
    const outcome = await awaitSettled(wired.projectionPort, operationId);
    assert.equal(outcome.status, "applied", JSON.stringify({ text, outcome }));
    await awaitRunRest(wired.projectionPort, runId);
    const reference = readRun(wired, runId).sessions?.[0]?.transcriptPage;
    assert.ok(reference);
    const transcript = wired.projectionPort.readTranscript(reference);
    assert.ok(transcript.found);
    if (!transcript.found) throw new Error("unreachable");
    assert.ok(
      transcript.entries.some(
        (entry) => entry.role === "user" && entry.content === text,
      ),
    );
  }
});

test("Claude Code admits a non-reserved leading command (#358)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });
  const admission = wired.projectionPort.submit({
    operationId: "op-compact",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "/compact" },
  });
  assert.ok(admission.admitted);
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-compact")).status,
    "applied",
  );
  await awaitRunRest(wired.projectionPort, runId);
});

/** A human Turn that stays live after admission until it is interrupted or the
 *  Harness closes, so a test can observe the window between admission and Turn end. */
const BLOCKING_TURN: FakeScript["turns"][number] = {
  block: true,
  result: COMPLETED_DETACHED.result,
};

/** A lost Turn result that keeps its Session recoverable. */
const LOST_DETACHED = {
  kind: "lost",
  detail: {
    unknown: "interruption",
    lastObservation: "interrupt requested before transport closed",
    session: { state: "detached", coordinate: { opaque: "coord-lost" } },
  },
} as const;

/** A Turn that blocks until interrupted and then ends lost, which still halts. */
const LOST_ON_INTERRUPT: FakeScript["turns"][number] = {
  ...BLOCKING_TURN,
  interruptResult: LOST_DETACHED,
};

test("an interactive send settles applied at Turn admission while the Turn is still live (#290)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: profile(),
    turns: [BLOCKING_TURN],
  });
  // A followed client, opened before the send: a fresh read already shows a live
  // Turn, so this proves admission also pushes it to an open Projection.
  const pushedInterrupt = followRun(wired.projectionPort, runId, (run) =>
    run.state === "running" ? offer(run, "interrupt-turn") : undefined,
  );

  const sent = wired.projectionPort.submit({
    operationId: "op-send-admitted",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "think about this" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, sent.operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));

  // Settled while the Turn is live: the Run is durably `running`, the Turn is
  // admitted with no result, and only the live-Turn controls are offered.
  const live = readRun(wired, runId);
  assert.equal(live.state, "running");
  const interrupt = offer(live, "interrupt-turn");
  assert.ok(interrupt, JSON.stringify(live.actionOffers));
  assert.equal(offer(live, "send-interactive-turn"), undefined);
  assert.equal(offer(live, "end-interactive-step"), undefined);

  // The followed client sees the live Turn too: admission pushed its interrupt Offer.
  assert.equal((await pushedInterrupt).turnId, interrupt.turnId);

  // A second send while that Turn is live is refused as a value and changes nothing.
  const busy = wired.projectionPort.submit({
    operationId: "op-send-busy",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "and another thing" },
  });
  assert.ok(busy.admitted, JSON.stringify(busy));
  const refused = await awaitSettled(wired.projectionPort, busy.operationId);
  assert.equal(refused.status, "not-applied");
  if (refused.status !== "not-applied") throw new Error("unreachable");
  assert.equal(refused.problem.code, "interactive-turn-busy");

  // The Turn's own outcome arrives through the Run Projection, not the Operation.
  const interrupted = wired.projectionPort.submit({
    operationId: "op-interrupt-admitted",
    operation: "interrupt-turn",
    input: { runId, turnId: interrupt.turnId },
  });
  assert.ok(interrupted.admitted);
  assert.equal(
    (await awaitSettled(wired.projectionPort, interrupted.operationId)).status,
    "applied",
  );
  assert.equal(
    (await awaitRunRest(wired.projectionPort, runId)).state,
    "blocked",
  );
});

test("a send whose Turn is never admitted settles not-applied and leaves the boundary (#290)", async (t) => {
  // The first Turn fails and leaves its Session unusable, so the next Turn can never
  // be admitted (ADR 0022): the send must not read as applied.
  const { wired, runId } = await launchInteractive(t, {
    profile: profile(),
    turns: [
      {
        result: {
          kind: "failed",
          detail: {
            failure: {
              phase: "recovery",
              category: "session-unusable",
              possibleEffects: "none",
              cause: undefined,
              diagnostics: "scripted unusable Session",
            },
            effectiveModel: { known: false },
            session: { state: "unusable", reason: "scripted" },
          },
        },
      },
    ],
  });
  await send(wired, runId, "op-send-fails", "discuss", "first attempt");
  assert.equal(readRun(wired, runId).sessions?.[0]?.availability, "unusable");

  const sent = wired.projectionPort.submit({
    operationId: "op-send-unadmitted",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "try again" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, sent.operationId);
  assert.equal(outcome.status, "not-applied", JSON.stringify(outcome));
  if (outcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(outcome.problem.code, "interactive-turn-not-admitted");
  assert.equal(outcome.problem.possibleEffects, "none");

  // Nothing was admitted: one Turn on record, and the Run is back at the boundary.
  const run = readRun(wired, runId);
  assert.equal(run.state, "blocked");
  assert.equal(run.turnPosition, 1);
  assert.ok(offer(run, "send-interactive-turn"));
});

test("a fault after admission reaches the Run, since the send already settled applied (#290)", async (t) => {
  // The scripted Turn is admitted and settles, then the Adapter faults: the Turn
  // driver throws after the send's Operation was already recorded `applied`.
  const fake = createFake({
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  })();
  const faulting: HarnessAdapter = ownPreparations({
    async prepare(options) {
      const prepared = await fake.prepare(options);
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
            return {
              subscribe: (listener) => turn.subscribe(listener),
              steer: (input) => turn.steer(input),
              interrupt: () => turn.interrupt(),
              answerRequest: (answer) => turn.answerRequest(answer),
              answerAgentCall: (answer) => turn.answerAgentCall(answer),
              changeModel: (choice) => turn.changeModel(choice),
              async result() {
                await turn.result();
                throw new Error("scripted Adapter fault after admission");
              },
            };
          },
        },
      };
    },
  });
  const { wired, runId } = await launchInteractive(t, faulting);

  const sent = wired.projectionPort.submit({
    operationId: "op-send-faults",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "go" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, sent.operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));

  const problem = await followRun(
    wired.projectionPort,
    runId,
    (run) => run.problem,
  );
  assert.equal(problem.code, "run-execution-fault");
  assert.match(problem.explanation, /scripted Adapter fault after admission/);
});

test("a Turn that rejects after admission puts its fault on the Run (#290)", async (t) => {
  // The interrupted Turn ends lost, which releases the Step's Harness, whose close
  // fails: the Turn's promise rejects long after the send settled applied at admission.
  const fake = createFake({
    profile: profile(),
    turns: [LOST_ON_INTERRUPT],
  })();
  const failingClose: HarnessAdapter = ownPreparations({
    async prepare(options) {
      const prepared = await fake.prepare(options);
      if (!prepared.ok) return prepared;
      const harness = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          readDefaults: () => harness.readDefaults(),
          startTurn: (request) => harness.startTurn(request),
          async close() {
            await harness.close();
            throw new Error("scripted Harness close failure");
          },
        },
      };
    },
  });
  const { wired, runId } = await launchInteractive(t, failingClose);
  const sent = wired.projectionPort.submit({
    operationId: "op-send-rejects",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "go" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  assert.equal(
    (await awaitSettled(wired.projectionPort, sent.operationId)).status,
    "applied",
  );
  const interrupt = offer(readRun(wired, runId), "interrupt-turn");
  assert.ok(interrupt);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-interrupt-rejects",
      operation: "interrupt-turn",
      input: { runId, turnId: interrupt.turnId },
    }).admitted,
  );

  const problem = await followRun(
    wired.projectionPort,
    runId,
    (run) => run.problem,
  );
  assert.equal(problem.code, "run-execution-fault");
  assert.match(problem.explanation, /scripted Harness close failure/);
});

test("shutdown closes the Step-scoped Harness once and leaves the interactive rest blocked (#134 A17/A21)", async (t) => {
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId } = await launchInteractive(
    t,
    { profile: profile(), turns: [COMPLETED_DETACHED] },
    counts,
  );
  assert.equal(counts.prepares, 1);
  assert.deepEqual(counts.closes, [0]);

  await wired.shutdown();

  assert.deepEqual(counts.closes, [1]);
  assert.equal(readRun(wired, runId).state, "blocked");
  assert.equal(
    wired.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    false,
  );
});

test("reopened interactive preparation failure halts with a selected-Harness Problem before a Turn", async (t) => {
  const closes: number[] = [];
  const counts = {
    prepares: 0,
    closes,
    failureAfterLaunch: {
      phase: "prepare",
      category: "protocol-incompatible",
      possibleEffects: "none",
      diagnostics: "Pinned protocol subset did not qualify.",
    } satisfies HarnessFailure,
  };
  const { wired, runId } = await launchInteractive(
    t,
    { profile: profile(), turns: [COMPLETED_DETACHED] },
    counts,
  );
  await wired.shutdown();

  const sent = wired.projectionPort.submit({
    operationId: "op-send-prepare-failure",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "Continue the discussion" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, sent.operationId);
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "selected-harness-unavailable");
    assert.equal(outcome.problem.details?.harness, "claude-code");
  }
  const run = readRun(wired, runId);
  assert.equal(run.state, "halted");
  assert.equal(run.problem?.code, "selected-harness-unavailable");
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  assert.deepEqual(owner.turns(), []);
  owner.close();
});

/** A blocking human Turn that an interrupt settles `interrupted`, its Session
 *  detached by `coord-interrupted` so the next Turn resumes it. */
const INTERRUPTIBLE_TURN: FakeScript["turns"][number] = {
  ...BLOCKING_TURN,
  interruptResult: {
    kind: "interrupted",
    detail: {
      interruption: profile().interruption,
      session: {
        state: "detached",
        coordinate: { opaque: "coord-interrupted" },
      },
    },
  },
};

test("an interrupted interactive Turn returns to waiting and keeps the Step-scoped Harness held (#353)", async (t) => {
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId } = await launchInteractive(
    t,
    { profile: profile(), turns: [INTERRUPTIBLE_TURN] },
    counts,
  );
  const { interrupt } = await sendLiveTurn(wired, runId, "op-send-interrupted");

  // Waiting for the person, not halted: the interactive input is offered again, and
  // the Harness qualified once is still held for the next Turn.
  const waiting = await interruptTurn(
    wired,
    runId,
    interrupt.turnId,
    "op-interrupt-interrupted",
  );
  assert.equal(waiting.state, "blocked");
  assert.ok(offer(waiting, "send-interactive-turn"));
  assert.ok(offer(waiting, "end-interactive-step"));
  assert.equal(offer(waiting, "interrupt-turn"), undefined);
  assert.equal(offer(waiting, "resume-run")?.available ?? false, false);
  assert.equal(counts.prepares, 1);
  assert.deepEqual(counts.closes, [0]);
  assert.equal(
    wired.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    true,
  );

  // Headless gains no Interrupt; its Run view reports the waiting Step.
  assert.match(await runShow(wired, runId), /Blocked: interactive Turn/);

  // An interrupted Interactive rest keeps the same shutdown rule (#355).
  await wired.shutdown();
  assert.deepEqual(counts.closes, [1]);
  assert.equal(readRun(wired, runId).state, "blocked");
  assert.equal(
    wired.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    false,
  );
});

test("an interrupted interactive Turn advances nothing and the next Turn continues the same Session (#219, #353)", async (t) => {
  const counts = {
    prepares: 0,
    closes: [] as number[],
    resumes: [] as (string | undefined)[],
  };
  const { wired, runId } = await launchInteractive(
    t,
    { profile: profile(), turns: [INTERRUPTIBLE_TURN, COMPLETED_DETACHED] },
    counts,
  );
  const { interrupt } = await sendLiveTurn(wired, runId, "op-send-long");

  // Waiting at the same interactive Step: nothing settled, nothing advanced, and the
  // Session is kept recoverable rather than replaced.
  const waiting = await interruptTurn(
    wired,
    runId,
    interrupt.turnId,
    "op-interrupt-long",
  );
  assert.equal(waiting.state, "blocked");
  assert.equal(waiting.progress[waiting.position]?.id, "discuss");
  assert.deepEqual(
    waiting.progress.map((s) => s.status === "succeeded"),
    [false, false],
  );
  assert.equal(waiting.sessions?.length, 1);
  assert.equal(waiting.sessions?.[0]?.availability, "detached");
  assert.equal(
    waiting.timeline.find((e) => e.event === "turn-settled")?.detail,
    "interrupted",
  );

  // The next human Turn continues the interrupted native Session on the held Harness.
  await send(wired, runId, "op-send-after", "discuss", "pick up where we were");
  assert.deepEqual(counts.resumes, [undefined, "coord-interrupted"]);
  assert.equal(counts.prepares, 1);
  const after = readRun(wired, runId);
  assert.equal(after.state, "blocked");
  assert.equal(after.sessions?.length, 1);
  assert.equal(after.sessions?.[0]?.session, "s");
  assert.ok(offer(after, "end-interactive-step"));
});

test("shutdown during a live interactive Turn still halts the Run and closes its Harness (#353, ADR 0019)", async (t) => {
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId } = await launchInteractive(
    t,
    { profile: profile(), turns: [INTERRUPTIBLE_TURN] },
    counts,
  );
  await sendLiveTurn(wired, runId, "op-send-shutdown");

  // The signal settles the live Turn `interrupted` too, but it is no Interrupt.
  await wired.shutdown();

  const halted = readRun(wired, runId);
  assert.equal(halted.state, "halted");
  assert.equal(
    halted.timeline.find((e) => e.event === "turn-settled")?.detail,
    "interrupted",
  );
  assert.ok(offer(halted, "resume-run")?.available);
  assert.deepEqual(counts.closes, [1]);
});

/** Send one human Turn that stays live, and return the Run read once admission
 *  settles the send applied, with the live Turn's interrupt and steer Offers. */
async function sendLiveTurn(wired: Wiring, runId: string, operationId: string) {
  const sent = wired.projectionPort.submit({
    operationId,
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "work on this for a while" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  const live = readRun(wired, runId);
  assert.equal(live.state, "running");
  const interrupt = offer(live, "interrupt-turn");
  const steer = offer(live, "steer-turn");
  assert.ok(interrupt, JSON.stringify(live.actionOffers));
  assert.ok(steer, JSON.stringify(live.actionOffers));
  return { interrupt, steer };
}

/** Steer the live Turn and return the settled outcome. */
async function steerTurn(
  wired: Wiring,
  runId: string,
  turnId: string,
  operationId: string,
) {
  const steered = wired.projectionPort.submit({
    operationId,
    operation: "steer-turn",
    input: { runId, turnId, text: "focus on the tests first" },
  });
  assert.ok(steered.admitted, JSON.stringify(steered));
  return awaitSettled(wired.projectionPort, operationId);
}

/** Submit a Steer that admission refuses, and return its Problem. */
function refuseSteer(
  wired: Wiring,
  runId: string,
  turnId: string,
  text: string,
  operationId = "op-steer-refused",
) {
  const steered = wired.projectionPort.submit({
    operationId,
    operation: "steer-turn",
    input: { runId, turnId, text },
  });
  assert.equal(steered.admitted, false, JSON.stringify(steered));
  if (steered.admitted) throw new Error("unreachable");
  return steered.problem;
}

/** A live Turn under a steerable Harness whose Session lists `commands`. */
function steerableSessionTurn(
  commands: readonly string[],
): FakeScript["turns"][number] {
  return {
    ...BLOCKING_TURN,
    events: [
      {
        kind: "session",
        availability: { state: "open" },
        facts: {
          recoveryCoordinate: { opaque: "coord-s" },
          tools: [],
          mcp: [],
          commands,
        },
      },
    ],
  };
}

/** Interrupt the live Turn, assert the interrupt applied, and return the Run's rest. */
async function interruptTurn(
  wired: Wiring,
  runId: string,
  turnId: string,
  operationId: string,
) {
  const interrupted = wired.projectionPort.submit({
    operationId,
    operation: "interrupt-turn",
    input: { runId, turnId },
  });
  assert.ok(interrupted.admitted, JSON.stringify(interrupted));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  return awaitRunRest(wired.projectionPort, runId);
}

test("a live interactive Turn accepts a Steer and keeps working under a Harness that declares steer (#294)", async (t) => {
  const steerProfile: HarnessProfile = {
    ...profile(),
    steer: { available: true, evidence: "scripted fake" },
  };
  const { wired, runId } = await launchInteractive(t, {
    profile: steerProfile,
    turns: [BLOCKING_TURN],
  });
  const { interrupt, steer } = await sendLiveTurn(
    wired,
    runId,
    "op-send-steerable",
  );
  // Offered beside the Interrupt, against the same live Turn.
  assert.equal(steer.available, true);
  assert.equal(steer.turnId, interrupt.turnId);

  const outcome = await steerTurn(wired, runId, steer.turnId, "op-steer-live");
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));

  // A Steer never ends the Turn: the Run still runs it, with the same controls.
  const after = readRun(wired, runId);
  assert.equal(after.state, "running");
  assert.equal(offer(after, "interrupt-turn")?.turnId, interrupt.turnId);
  assert.equal(offer(after, "steer-turn")?.available, true);
  assert.equal(offer(after, "send-interactive-turn"), undefined);

  assert.equal(
    (
      await interruptTurn(
        wired,
        runId,
        interrupt.turnId,
        "op-interrupt-steerable",
      )
    ).state,
    "blocked",
  );
  const settled = readRun(wired, runId).timeline.find(
    (event) => event.event === "steer",
  );
  assert.equal(settled?.steer?.steerId, "op-steer-live");
  assert.deepEqual(settled?.steer?.settlement, {
    kind: "dropped",
    reason: "interrupt",
  });
});

test("a live interactive Turn offers Steer unavailable with the profile's reason and refuses it as a value (#294)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: profile(),
    turns: [BLOCKING_TURN],
  });
  const { interrupt, steer } = await sendLiveTurn(
    wired,
    runId,
    "op-send-unsteerable",
  );
  // The reason is the profile's steer evidence, word for word.
  assert.equal(steer.available, false);
  if (steer.available) throw new Error("unreachable");
  assert.equal(steer.reason, profile().steer.evidence);

  // Availability is checked first, before blank text or the input rules, and
  // refuses at admission: no Operation is admitted.
  for (const text of ["focus on the tests first", "   ", "/clear"]) {
    const refused = refuseSteer(wired, runId, steer.turnId, text);
    assert.equal(refused.code, "steer-unavailable");
    assert.equal(refused.details?.reason, profile().steer.evidence);
  }

  // The refusal changes nothing: the Turn is still live and still interruptible.
  const after = readRun(wired, runId);
  assert.equal(after.state, "running");
  assert.equal(offer(after, "interrupt-turn")?.turnId, interrupt.turnId);

  assert.equal(
    (
      await interruptTurn(
        wired,
        runId,
        interrupt.turnId,
        "op-interrupt-unsteerable",
      )
    ).state,
    "blocked",
  );
});

test("end-interactive-step mid-Turn is rejected with a precise Problem (#122)", async (t) => {
  // A Turn that blocks after admission until it is interrupted or the Harness closes,
  // so a real "mid-Turn" window exists to submit End Step into.
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId } = await launchInteractive(
    t,
    {
      profile: profile(),
      turns: [
        {
          block: true,
          result: {
            kind: "completed",
            detail: {
              finalContent: "unused",
              effectiveModel: { known: false },
              session: {
                state: "detached",
                coordinate: { opaque: "coord-s" },
              },
            },
          },
        },
      ],
    },
    counts,
  );

  // Start a human Turn but do not await it — it blocks mid-Turn.
  const sendAdmission = wired.projectionPort.submit({
    operationId: "op-send",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "thinking out loud" },
  });
  assert.ok(sendAdmission.admitted, JSON.stringify(sendAdmission));

  // A live human Turn runs under `running`, not `blocked`, so a crash mid-Turn
  // reconciles through the #118 path instead of stranding the Run (#122).
  assert.equal(readRun(wired, runId).state, "running");

  // End Step while the Turn is live is refused precisely, changing nothing.
  const endAdmission = wired.projectionPort.submit({
    operationId: "op-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "discuss" },
  });
  assert.ok(endAdmission.admitted, JSON.stringify(endAdmission));
  const endOutcome = await awaitSettled(wired.projectionPort, "op-end");
  assert.equal(endOutcome.status, "not-applied");
  if (endOutcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(endOutcome.problem.code, "interactive-step-mid-turn");

  // Cancel resolves against the *live* Turn (the refused End must not have clobbered
  // its settling promise): the cancel and the send both settle, and the Run rests
  // exactly `cancelled` once the real Turn has unwound.
  const cancel = wired.projectionPort.submit({
    operationId: "op-cancel",
    operation: "cancel-run",
    input: { runId },
  });
  assert.ok(cancel.admitted, JSON.stringify(cancel));
  const cancelOutcome = await awaitSettled(wired.projectionPort, "op-cancel");
  assert.equal(cancelOutcome.status, "applied", JSON.stringify(cancelOutcome));
  // The send settled at admission, but cancel still awaited the whole Turn (#290).
  assert.equal(readRun(wired, runId).state, "cancelled");
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-send")).status,
    "applied",
  );
  assert.equal(counts.prepares, 1);
  assert.deepEqual(counts.closes, [1]);
});

// --- An Interactive Step in a Verdict-driven Repeat (#216) ------------------

/** `baseline (fail) -> repeat until passing { implement (interactive, "impl") ->
 *  check (passes on its second run) }`: two iterations, each its own Attempt and
 *  Session, advanced only by End Step. */
function repeatRouting(): readonly unknown[] {
  const counter = join(makeTempDir("secant-interactive-counter-"), "counter");
  const verdict = [{ name: "passing", type: "verdict" }];
  return [
    {
      id: "baseline",
      kind: "command",
      produces: verdict,
      command: {
        executable: RUNTIME_NAME,
        arguments: ["-e", "process.exit(1)"],
      },
    },
    {
      repeat: {
        until: "passing",
        reviewCheckpoint: { interval: 5, message: "review the loop" },
        steps: [
          {
            id: "implement",
            kind: "interactive-agent",
            session: "impl",
            prompt: { asset: "prompts/discuss.md" },
          },
          {
            id: "check",
            kind: "command",
            produces: verdict,
            command: {
              executable: RUNTIME_NAME,
              arguments: [
                "-e",
                `const fs=require('node:fs');const p=${JSON.stringify(counter)};` +
                  `let n=0;try{n=Number(fs.readFileSync(p,'utf8'))||0;}catch{}` +
                  `n++;fs.writeFileSync(p,String(n));` +
                  `console.log('iteration '+n);process.exit(n>=2?0:1);`,
              ],
            },
          },
          {
            id: "apply",
            kind: "agent",
            session: "impl",
            prompt: { asset: "prompts/apply.md" },
          },
        ],
      },
    },
  ];
}

/** A Turn that blocks until it is interrupted. */
const BLOCKING: FakeScript["turns"][number] = {
  block: true,
  result: COMPLETED_DETACHED.result,
};

/** A fake Adapter whose n-th prepared Harness serves the n-th script's Turns, so
 *  each Step-scoped Harness (launch, each End, each resume) is scripted apart. */
function perPrepareAdapter(
  turnsPerPrepare: readonly FakeScript["turns"][],
): HarnessAdapter {
  let prepares = 0;
  return ownPreparations({
    prepare(options) {
      const turns = turnsPerPrepare[prepares++] ?? [];
      return createFake({ profile: profile(), turns })().prepare(options);
    },
  });
}

async function endStep(
  wired: Wiring,
  runId: string,
  operationId: string,
  stepId: string,
): Promise<void> {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "end-interactive-step",
    input: { runId, stepId },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  // `applied` means the Turn was admitted; its result arrives on the Run (#290).
  await awaitRunRest(wired.projectionPort, runId);
}

function sessionsOf(run: RunView): string[] {
  return (run.sessions ?? []).map((session) => session.session).sort();
}

test("an Interactive Step in a Verdict-driven Repeat gives each iteration its own Attempt and Session; End advances one iteration; halt and resume keep it (#216)", async (t) => {
  const { wired, runId, run } = await launchInteractive(
    t,
    perPrepareAdapter([
      // Launch: iteration 0 at the interactive Step, two human Turns.
      [COMPLETED_DETACHED, COMPLETED_DETACHED],
      // End #1: the span's Agent Step runs in its own Run-wide "impl" Session, then
      // iteration 1 rests at the interactive Step; its first Turn ends lost.
      [COMPLETED_DETACHED, LOST_ON_INTERRUPT],
      // resume-run: iteration 1 again, the same Session takes the next Turn.
      [COMPLETED_DETACHED],
      // End #2: the Agent Step, then check passes and the Run succeeds.
      [COMPLETED_DETACHED],
    ]),
    undefined,
    repeatRouting(),
  );
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.id, "implement");
  assert.ok(offer(run, "end-interactive-step"));
  // A Verdict-driven Repeat has no Continue (#217): refused, changing nothing.
  assert.equal(offer(run, "continue-repeat"), undefined);
  const refusedContinue = await submitContinue(wired, runId, "op-continue");
  assert.equal(refusedContinue.status, "not-applied");
  if (refusedContinue.status === "not-applied") {
    assert.equal(refusedContinue.problem.code, "continue-outside-human-repeat");
  }

  // Two Turns in iteration 0: completion never advances; one conversation.
  await send(wired, runId, "op-i0-t1", "implement", "pick a ticket");
  await send(wired, runId, "op-i0-t2", "implement", "a follow-up question");
  const iteration0 = readRun(wired, runId);
  assert.equal(iteration0.state, "blocked");
  assert.equal(iteration0.progress[iteration0.position]?.id, "implement");
  assert.deepEqual(sessionsOf(iteration0), ["impl-0.0:implement"]);

  // End advances exactly this iteration: check fails, the autonomous Agent Step
  // keeps its Run-wide named Session, and iteration 1 rests at the interactive Step.
  await endStep(wired, runId, "op-end-0", "implement");
  const iteration1 = readRun(wired, runId);
  assert.equal(iteration1.state, "blocked");
  assert.equal(iteration1.progress[iteration1.position]?.id, "implement");
  assert.ok(offer(iteration1, "send-interactive-turn"));

  // Iteration 1's first Turn ends lost under an interrupt: the Run halts, resumable.
  const sent = wired.projectionPort.submit({
    operationId: "op-i1-t1",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "pick the next ticket" },
  });
  assert.ok(sent.admitted);
  const interruptOffer = await awaitInterruptOffer(wired, runId);
  const interrupted = wired.projectionPort.submit({
    operationId: "op-i1-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: interruptOffer.turnId },
  });
  assert.ok(interrupted.admitted);
  await awaitSettled(wired.projectionPort, interrupted.operationId);
  await awaitSettled(wired.projectionPort, sent.operationId);
  const halted = readRun(wired, runId);
  assert.equal(halted.state, "halted");
  assert.deepEqual(sessionsOf(halted), [
    "impl",
    "impl-0.0:implement",
    "impl-1.0:implement",
  ]);

  // Resume lands back in iteration 1, not a fresh iteration or iteration 0.
  const resumed = wired.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resumed.admitted, JSON.stringify(resumed));
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-resume")).status,
    "applied",
  );
  const afterResume = readRun(wired, runId);
  assert.equal(afterResume.state, "blocked");
  assert.equal(afterResume.progress[afterResume.position]?.id, "implement");
  await send(wired, runId, "op-i1-t2", "implement", "carry on");

  await endStep(wired, runId, "op-end-1", "implement");
  const done = readRun(wired, runId);
  assert.equal(done.state, "succeeded");
  assert.equal(
    done.timeline.filter((event) => event.event === "interactive-step-ended")
      .length,
    2,
  );

  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    assert.deepEqual(
      owner
        .turns()
        .map((turn) => [turn.kind, turn.attemptId, turn.session, turn.input]),
      [
        [
          "interactive-agent",
          "0.0:implement",
          "impl-0.0:implement",
          "pick a ticket",
        ],
        [
          "interactive-agent",
          "0.0:implement",
          "impl-0.0:implement",
          "a follow-up question",
        ],
        ["agent", "0.0:apply", "impl", "Apply the plan.\n"],
        [
          "interactive-agent",
          "1.0:implement",
          "impl-1.0:implement",
          "pick the next ticket",
        ],
        [
          "interactive-agent",
          "1.0:implement",
          "impl-1.0:implement",
          "carry on",
        ],
        ["agent", "1.0:apply", "impl", "Apply the plan.\n"],
      ],
    );
  } finally {
    owner.close();
  }
});

test("an entry Turn inside a Repeat opens each iteration's own Session (#212, #216)", async (t) => {
  const routing = repeatRouting().map((node) => {
    const repeat = (node as { repeat?: { steps: Record<string, unknown>[] } })
      .repeat;
    if (repeat === undefined) return node;
    // The interactive Step opts into its entry Turn; drop the span's Agent Step.
    return {
      repeat: {
        ...repeat,
        steps: repeat.steps
          .filter((step) => step.kind !== "agent")
          .map((step) =>
            step.kind === "interactive-agent"
              ? { ...step, entryTurn: true }
              : step,
          ),
      },
    };
  });
  const { wired, runId, run } = await launchInteractive(
    t,
    perPrepareAdapter([
      [COMPLETED_DETACHED],
      [COMPLETED_DETACHED],
      [COMPLETED_DETACHED],
    ]),
    undefined,
    routing,
  );
  assert.equal(run.state, "blocked");
  await endStep(wired, runId, "op-end-0", "implement");
  assert.equal(readRun(wired, runId).state, "blocked");
  await endStep(wired, runId, "op-end-1", "implement");
  assert.equal(readRun(wired, runId).state, "succeeded");

  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    assert.deepEqual(
      owner.turns().map((turn) => [turn.turnId, turn.session, turn.origin]),
      [
        ["0.0:implement#entry", "impl-0.0:implement", "managed"],
        ["1.0:implement#entry", "impl-1.0:implement", "managed"],
      ],
    );
  } finally {
    owner.close();
  }
});

/** A human-controlled Repeat (#217): `repeat { control: human } [interactive
 *  implement]`. No Verdict, no Review checkpoint — only Continue opens the next
 *  iteration (confirmed End Stage, #218, exits). */
function humanRepeatRouting(): readonly unknown[] {
  return [
    {
      repeat: {
        control: "human",
        steps: [
          {
            id: "implement",
            kind: "interactive-agent",
            session: "impl",
            prompt: { asset: "prompts/discuss.md" },
          },
        ],
      },
    },
  ];
}

async function submitContinue(
  wired: Wiring,
  runId: string,
  operationId: string,
  stepId = "implement",
) {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "continue-repeat",
    input: { runId, stepId },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  return awaitSettled(wired.projectionPort, operationId);
}

test("a human-controlled Repeat offers Continue only at a Turn boundary; one Continue settles one iteration into a fresh Session, idempotent by Operation id, with no Review checkpoint (#217)", async (t) => {
  const { wired, runId, run } = await launchInteractive(
    t,
    perPrepareAdapter([
      // Launch: iteration 0, one completed Turn, then one that blocks until interrupt.
      [COMPLETED_DETACHED, BLOCKING],
      // Continue #1..#3: each opens the next iteration; iteration 1 takes one Turn.
      [COMPLETED_DETACHED],
      [],
      [],
    ]),
    undefined,
    humanRepeatRouting(),
  );
  // At the boundary: send + Continue, never End Step (Continue is this mode's control).
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.id, "implement");
  assert.ok(offer(run, "send-interactive-turn"));
  const continueOffer = offer(run, "continue-repeat");
  assert.ok(continueOffer, JSON.stringify(run.actionOffers));
  assert.equal(continueOffer.stepId, "implement");
  assert.match(continueOffer.consequence, /fresh/);
  assert.equal(offer(run, "end-interactive-step"), undefined);
  // End Step is refused in this mode, changing nothing.
  const end = wired.projectionPort.submit({
    operationId: "op-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "implement" },
  });
  assert.ok(end.admitted);
  const endOutcome = await awaitSettled(wired.projectionPort, "op-end");
  assert.equal(endOutcome.status, "not-applied");

  // A completed Turn never advances the iteration.
  await send(wired, runId, "op-i0-t1", "implement", "pick a ticket");
  assert.equal(readRun(wired, runId).state, "blocked");

  // A live Turn: no Continue Offer, and a Continue submission cannot race it.
  const sent = wired.projectionPort.submit({
    operationId: "op-i0-t2",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "a long question" },
  });
  assert.ok(sent.admitted);
  const interruptOffer = await awaitInterruptOffer(wired, runId);
  assert.equal(offer(readRun(wired, runId), "continue-repeat"), undefined);
  const raced = await submitContinue(wired, runId, "op-race");
  assert.equal(raced.status, "not-applied");
  if (raced.status === "not-applied") {
    assert.equal(raced.problem.code, "interactive-step-mid-turn");
  }
  const interrupted = wired.projectionPort.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: interruptOffer.turnId },
  });
  assert.ok(interrupted.admitted);
  await awaitSettled(wired.projectionPort, "op-interrupt");
  await awaitSettled(wired.projectionPort, "op-i0-t2");
  // The interrupt returns iteration 0 to its Turn boundary (#353).
  const boundary = await awaitRunRest(wired.projectionPort, runId);
  assert.equal(boundary.state, "blocked");
  assert.ok(offer(boundary, "continue-repeat"));

  // One Continue settles exactly iteration 0 and rests at iteration 1.
  assert.equal(
    (await submitContinue(wired, runId, "op-continue-0")).status,
    "applied",
  );
  const iteration1 = readRun(wired, runId);
  assert.equal(iteration1.state, "blocked");
  assert.equal(iteration1.progress[iteration1.position]?.id, "implement");
  assert.ok(offer(iteration1, "continue-repeat"));
  // The same Operation id again replays its admission and settles nothing new.
  assert.equal(
    (await submitContinue(wired, runId, "op-continue-0")).status,
    "applied",
  );
  await send(wired, runId, "op-i1-t1", "implement", "next ticket");
  assert.deepEqual(sessionsOf(readRun(wired, runId)), [
    "impl-0.0:implement",
    "impl-1.0:implement",
  ]);

  // Two more Continues: never a Review checkpoint, only Continue moves the loop.
  await submitContinue(wired, runId, "op-continue-1");
  await submitContinue(wired, runId, "op-continue-2");
  const later = readRun(wired, runId);
  assert.equal(later.state, "blocked");
  assert.equal(later.checkpoint, undefined);
  assert.equal(offer(later, "answer-human-gate"), undefined);
  assert.equal(
    later.timeline.filter((event) => event.event === "repeat-continued").length,
    3,
  );
  assert.equal(
    later.timeline.filter((event) => event.event === "interactive-step-ended")
      .length,
    0,
  );

  // Cancel releases the held blocked owner so the store can be read directly.
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-cancel",
      operation: "cancel-run",
      input: { runId },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "op-cancel");
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    assert.deepEqual(
      owner.attemptLog().map((entry) => [entry.attemptId, entry.outcome]),
      [
        ["0.0:implement", "succeeded"],
        ["1.0:implement", "succeeded"],
        ["2.0:implement", "succeeded"],
      ],
    );
    assert.deepEqual(
      owner.turns().map((turn) => [turn.attemptId, turn.session, turn.input]),
      [
        ["0.0:implement", "impl-0.0:implement", "pick a ticket"],
        ["0.0:implement", "impl-0.0:implement", "a long question"],
        ["1.0:implement", "impl-1.0:implement", "next ticket"],
      ],
    );
  } finally {
    owner.close();
  }
});

async function submitEndStage(
  wired: Wiring,
  runId: string,
  operationId: string,
  stepId = "implement",
) {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "end-stage",
    input: { runId, stepId },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  return awaitSettled(wired.projectionPort, operationId);
}

/** A Turn whose agent claims the stage is over: prose never ends it (#218). */
const CLAIMS_DONE: FakeScript["turns"][number] = {
  result: {
    kind: "completed",
    detail: {
      finalContent: "All tickets are done. End implementation stage.",
      effectiveModel: { known: true, model: "fake-sonnet" },
      session: { state: "detached", coordinate: { opaque: "coord-s" } },
    },
  },
};

test("confirmed End Stage settles a human-controlled Repeat and the Run once as human-declared completion, only at a Turn boundary (#218)", async (t) => {
  const { wired, runId, run } = await launchInteractive(
    t,
    perPrepareAdapter([
      // Launch: iteration 0 claims done in prose, then a Turn that blocks.
      [CLAIMS_DONE, BLOCKING],
      // Continue into iteration 1, then End Stage.
      [],
      [],
    ]),
    undefined,
    humanRepeatRouting(),
  );
  // At the boundary End Stage sits beside send and Continue, never End Step, and its
  // consequence says the tracker has not been checked.
  const endStage = offer(run, "end-stage");
  assert.ok(endStage, JSON.stringify(run.actionOffers));
  assert.equal(endStage.stepId, "implement");
  assert.match(endStage.consequence, /not checked the tracker/);
  assert.ok(offer(run, "continue-repeat"));
  assert.ok(offer(run, "send-interactive-turn"));
  assert.equal(offer(run, "end-interactive-step"), undefined);

  // The agent's "done" prose ends nothing: the Step still waits for the human.
  await send(wired, runId, "op-i0-t1", "implement", "are we done?");
  assert.equal(readRun(wired, runId).state, "blocked");
  assert.equal(readRun(wired, runId).completion, undefined);

  // A live Turn: no End Stage Offer, and a raced End Stage is refused unchanged.
  const sent = wired.projectionPort.submit({
    operationId: "op-i0-t2",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "one more thing" },
  });
  assert.ok(sent.admitted);
  const interruptOffer = await awaitInterruptOffer(wired, runId);
  assert.equal(offer(readRun(wired, runId), "end-stage"), undefined);
  const raced = await submitEndStage(wired, runId, "op-race");
  assert.equal(raced.status, "not-applied");
  if (raced.status === "not-applied") {
    assert.equal(raced.problem.code, "interactive-step-mid-turn");
  }
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-interrupt",
      operation: "interrupt-turn",
      input: { runId, turnId: interruptOffer.turnId },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "op-interrupt");
  await awaitSettled(wired.projectionPort, "op-i0-t2");
  // The interrupt returns iteration 0 to its Turn boundary (#353).
  const boundary = await awaitRunRest(wired.projectionPort, runId);
  assert.equal(boundary.state, "blocked");
  assert.ok(offer(boundary, "end-stage"));

  // Continue once, then confirmed End Stage in iteration 1: the Run succeeds, sends
  // no Turn, and records a human declaration rather than a verified completion.
  await submitContinue(wired, runId, "op-continue-0");
  const turnsBefore = readRun(wired, runId).turnPosition;
  assert.equal(
    (await submitEndStage(wired, runId, "op-end-stage")).status,
    "applied",
  );
  const done = readRun(wired, runId);
  assert.equal(done.state, "succeeded");
  assert.equal(done.completion, "human-declared");
  assert.equal(done.turnPosition, turnsBefore);
  assert.equal(offer(done, "end-stage"), undefined);
  assert.equal(offer(done, "continue-repeat"), undefined);
  assert.match(
    await runShow(wired, runId),
    /Completion: declared by a human \(Secant did not check the tracker\)/,
  );
  assert.deepEqual(
    done.timeline
      .filter(
        (event) =>
          event.event === "repeat-continued" || event.event === "stage-ended",
      )
      .map((event) => event.event),
    ["repeat-continued", "stage-ended"],
  );

  // Replaying the same Operation id settles nothing new; a fresh End Stage on the
  // finished Run is refused.
  assert.equal(
    (await submitEndStage(wired, runId, "op-end-stage")).status,
    "applied",
  );
  assert.equal(
    (await submitEndStage(wired, runId, "op-end-stage-again")).status,
    "not-applied",
  );
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    assert.deepEqual(
      owner
        .attemptLog()
        .map((entry) => [entry.attemptId, entry.outcome, entry.endsStage]),
      [
        ["0.0:implement", "succeeded", undefined],
        ["1.0:implement", "succeeded", true],
      ],
    );
  } finally {
    owner.close();
  }
});

test("End Stage exits a human-controlled Repeat into the next node, and is refused outside one (#218)", async (t) => {
  const { wired, runId, run } = await launchInteractive(
    t,
    perPrepareAdapter([[], []]),
    undefined,
    [
      ...humanRepeatRouting(),
      {
        id: "after",
        kind: "command",
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "process.exit(0)"],
        },
      },
    ],
  );
  assert.equal(run.state, "blocked");
  assert.equal(
    (await submitEndStage(wired, runId, "op-end-stage")).status,
    "applied",
  );
  const done = readRun(wired, runId);
  assert.equal(done.state, "succeeded");
  assert.equal(done.completion, "human-declared");
  assert.deepEqual(
    done.progress.map((step) => [step.id, step.status]),
    [
      ["implement", "succeeded"],
      ["after", "succeeded"],
    ],
  );
});

test("after End Stage the Projection rests at the next node, not in another iteration of the group (#218)", async (t) => {
  const { wired, runId } = await launchInteractive(
    t,
    perPrepareAdapter([[], []]),
    undefined,
    [
      ...humanRepeatRouting(),
      {
        id: "review",
        kind: "interactive-agent",
        session: "review",
        prompt: { asset: "prompts/discuss.md" },
      },
    ],
  );
  assert.equal(
    (await submitEndStage(wired, runId, "op-end-stage")).status,
    "applied",
  );
  const next = readRun(wired, runId);
  assert.equal(next.state, "blocked");
  assert.equal(next.completion, undefined);
  assert.deepEqual(
    next.progress.map((step) => [step.id, step.status]),
    [
      ["implement", "succeeded"],
      ["review", "blocked"],
    ],
  );
  assert.equal(next.progress[next.position]?.id, "review");
  // The next Step is outside the group, so it offers End Step, not End Stage.
  assert.ok(offer(next, "end-interactive-step"));
  assert.equal(offer(next, "end-stage"), undefined);
});

test("End Stage is refused as a value on an interactive Step outside a human-controlled Repeat (#218)", async (t) => {
  const { wired, runId, run } = await launchInteractive(t, {
    profile: profile(),
    turns: [],
  });
  assert.equal(offer(run, "end-stage"), undefined);
  const refused = await submitEndStage(wired, runId, "op-end-stage", "discuss");
  assert.equal(refused.status, "not-applied");
  if (refused.status === "not-applied") {
    assert.equal(refused.problem.code, "end-stage-outside-human-repeat");
  }
  const still = readRun(wired, runId);
  assert.equal(still.state, "blocked");
  assert.ok(offer(still, "end-interactive-step"));
});

test("Steer admission checks availability, then blank text, then input rules, then the Session's commands (#359)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: {
      ...profile(),
      steer: { available: true, evidence: "scripted fake" },
    },
    // `/clear` is both reserved and a listed Session command: the input rule,
    // checked first, names it.
    turns: [steerableSessionTurn(["/compact", "/clear", "/context"])],
  });
  const { steer } = await sendLiveTurn(wired, runId, "op-send-ordered");
  assert.equal(steer.available, true);

  const blank = refuseSteer(wired, runId, steer.turnId, " \n\t ");
  assert.equal(blank.code, "steer-blank");

  const reserved = refuseSteer(wired, runId, steer.turnId, "/clear the slate");
  assert.equal(reserved.code, "harness-input-reserved");
  assert.equal(reserved.details?.word, "/clear");

  // The shared matcher: leading whitespace skipped, the whole first word,
  // compared case-insensitively.
  for (const text of ["/compact", "  /COMPACT now", "/Context\nplease"]) {
    const command = refuseSteer(wired, runId, steer.turnId, text);
    assert.equal(command.code, "steer-session-command", text);
    assert.match(command.explanation, /^Send \/\S+ when the Turn ends:/);
    assert.equal(command.details?.harness, "Claude Code");
  }
  const named = refuseSteer(wired, runId, steer.turnId, "/compact");
  assert.equal(named.details?.word, "/compact");

  // A refusal consumes no Operation id and records nothing: the same id then
  // carries a Steer whose first word is no command at all.
  const live = readRun(wired, runId);
  assert.equal(live.state, "running");
  assert.equal(
    live.timeline.filter((event) => event.event === "steer").length,
    0,
  );
  for (const text of ["/compactness of the code", "use the /compact flag"]) {
    const operationId = `op-steer-${text.length}`;
    const admitted = wired.projectionPort.submit({
      operationId,
      operation: "steer-turn",
      input: { runId, turnId: steer.turnId, text },
    });
    assert.ok(admitted.admitted, JSON.stringify(admitted));
    const outcome = await awaitSettled(wired.projectionPort, operationId);
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  }
  const retried = wired.projectionPort.submit({
    operationId: "op-steer-refused",
    operation: "steer-turn",
    input: { runId, turnId: steer.turnId, text: "plain guidance" },
  });
  assert.ok(retried.admitted, JSON.stringify(retried));
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-steer-refused")).status,
    "applied",
  );
});

test("a Codex Steer is refused no reserved word, since Codex reserves none and lists no commands (#359)", async (t) => {
  const { wired, runId } = await launchInteractive(
    t,
    {
      profile: {
        ...profile(),
        harness: "Codex",
        steer: { available: true, evidence: "scripted fake" },
      },
      turns: [steerableSessionTurn([])],
    },
    undefined,
    undefined,
    "codex",
  );
  const { steer } = await sendLiveTurn(wired, runId, "op-send-codex");
  const admitted = wired.projectionPort.submit({
    operationId: "op-steer-codex",
    operation: "steer-turn",
    input: { runId, turnId: steer.turnId, text: "/clear" },
  });
  assert.ok(admitted.admitted, JSON.stringify(admitted));
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-steer-codex")).status,
    "applied",
  );
});

for (const harness of ["claude-code", "codex"] as const) {
  test(`m10-workspace-mentions: ${harness} receives identical human path text without attachments or candidate reads`, async (t) => {
    const inputs: unknown[] = [];
    const fake = createFake({
      profile: profile(),
      turns: [COMPLETED_DETACHED, COMPLETED_DETACHED],
    })();
    const adapter = ownPreparations({
      async prepare(options) {
        const prepared = await fake.prepare(options);
        if (!prepared.ok) return prepared;
        const runtime = prepared.harness;
        return {
          ok: true,
          harness: {
            profile: runtime.profile,
            readDefaults: () => runtime.readDefaults(),
            startTurn(request) {
              inputs.push(request.input);
              return runtime.startTurn(request);
            },
            close: () => runtime.close(),
          },
        };
      },
    });
    const { wired, runId } = await launchInteractive(
      t,
      adapter,
      undefined,
      undefined,
      harness,
    );
    try {
      const text =
        'inspect @"my file.ts"#L10-20 and @folder/ @.hidden @ignored @missing @/outside';
      const admission = wired.projectionPort.submit({
        operation: "send-interactive-turn",
        operationId: "path-text",
        input: { runId, stepId: "discuss", text },
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      assert.equal(
        (await awaitSettled(wired.projectionPort, "path-text")).status,
        "applied",
      );
      await awaitRunRest(wired.projectionPort, runId);
      assert.deepEqual(inputs, [{ text }]);
    } finally {
      await wired.shutdown();
    }
  });
}
