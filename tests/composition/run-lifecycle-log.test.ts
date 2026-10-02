import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { withClients } from "../../src/composition/main.js";
import type { HeadlessClients } from "../../src/headless/headless.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessProfile,
  type TurnEvent,
  type TurnResult,
} from "../../src/harness/harness.js";
import type {
  ActionOffer,
  ProjectionPort,
  RunView,
} from "../../src/application/projection-port.js";
import { createFake, type FakeTurnScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";

// Run, Step Attempt, and Turn lifecycle in the operational log (#320), driven
// through the headless client entry and the Projection Port with Process and
// Harness doubles, then read back from the JSONL the Secant invocation wrote. The
// log-sink Seam supplies the folder and clock; nothing sets SECANT_LOG_DIR.

const WALL = new Date("2026-10-02T09:08:07.006Z");

/** A monotonic reading that advances 125 ms per read, so every elapsed value is
 *  exact, under a wall clock `wall` decides (fixed by default). */
function steppingClock(wall: () => Date = () => WALL) {
  let reading = 1000;
  return { now: wall, monotonic: () => (reading += 125) };
}

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

// Payloads seeded into prompts, Turn input, transcript, and failure detail; none
// may reach the log.
const SEEDED_PROMPT = "seeded-prompt-3f9a1c";
const SEEDED_TEXT = "seeded-human-text-7b2e44";
const SEEDED_CONTENT = "seeded-transcript-c0ffee";
const SEEDED_DIAGNOSTICS = "seeded-diagnostics-51d0aa";
const SEEDED_PARTIAL = "seeded-partial-output-9e8d7c";
const SEEDED_COORDINATE = "seeded-coordinate-a1b2c3";

const COMPLETED: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: SEEDED_CONTENT,
    effectiveModel: { known: false },
    session: { state: "detached", coordinate: { opaque: SEEDED_COORDINATE } },
  },
};

const FAILED: TurnResult = {
  kind: "failed",
  detail: {
    failure: {
      phase: "turn",
      category: "execution",
      possibleEffects: "possible",
      nativeCode: "E_NATIVE_42",
      diagnostics: SEEDED_DIAGNOSTICS,
      partialOutput: SEEDED_PARTIAL,
      cause: new Error("native turn failed"),
    },
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

/** Many streamed events: transcript content, previews, and activity. */
function streamed(count: number): TurnEvent[] {
  return Array.from({ length: count }, (_, index): TurnEvent => {
    switch (index % 3) {
      case 0:
        return { kind: "assistant-content", content: SEEDED_CONTENT };
      case 1:
        return { kind: "preview", text: SEEDED_CONTENT };
      default:
        return { kind: "activity", description: SEEDED_CONTENT };
    }
  });
}

function writeBundle(routing: readonly unknown[]): {
  folder: string;
  id: string;
} {
  const folder = makeTempDir("secant-runlog-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "work.md"), `${SEEDED_PROMPT}\n`);
  const id = "dev.secant.run-lifecycle-log";
  const manifest = {
    formatVersion: 1,
    bundle: {
      id,
      version: "1.0.0",
      name: "Run Lifecycle Log",
      description: "A Bundle the operational-log lifecycle tests launch.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/work.md", kind: "prompt" }],
    routing,
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  return { folder, id };
}

const agentStep = (id: string, retry: number) => ({
  id,
  kind: "agent",
  retry,
  session: "planning",
  prompt: { asset: "prompts/work.md" },
});

interface Logged {
  readonly status: number;
  readonly text: string;
  readonly records: readonly Record<string, unknown>[];
  /** The Run, Attempt, and Turn records, in order. */
  readonly lifecycle: readonly Record<string, unknown>[];
}

/** Run `body` as one headless Secant invocation over a fresh home, with the
 *  Bundle installed and the Workspace approved, then read its one log file. */
async function invocation(
  t: TestContext,
  options: {
    readonly routing: readonly unknown[];
    readonly turns: readonly FakeTurnScript[];
    readonly clock?: ReturnType<typeof steppingClock>;
    readonly supportsInteractiveTurns?: boolean;
  },
  body: (port: ProjectionPort, digest: string) => Promise<void>,
): Promise<Logged> {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const folder = join(makeTempDir("secant-runlog-"), "logs");
  const workspace = makeTempDir("secant-runlog-ws-");
  const bundle = writeBundle(options.routing);
  const status = await withClients(
    async (clients: HeadlessClients) => {
      const built = clients.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      assert.ok(
        clients.projectionPort.submit({
          operationId: "op-approve",
          operation: "approve-workspace",
          input: { path: workspace },
        }).admitted,
      );
      await body(clients.projectionPort, built.report.digest);
      return 0;
    },
    {
      secantHome: makeTempDir("secant-runlog-home-"),
      launchCwd: workspace,
      engineVersion: "9.8.7",
      hostPlatform: "linux",
      process: createFakeBundleProcess({ executables: [process.execPath] }),
      harnessAdapter: createFake({
        profile: profile(),
        turns: options.turns,
      })(),
      supportsInteractiveTurns: options.supportsInteractiveTurns ?? false,
      logSink: {
        folder,
        clock: options.clock ?? steppingClock(),
        stderr: (text) => assert.fail(`unexpected log notice: ${text}`),
      },
    },
  );
  const names = readdirSync(folder);
  assert.equal(names.length, 1, `one file per Secant invocation: ${names}`);
  const text = readFileSync(join(folder, names[0]!), "utf8");
  const records = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    status,
    text,
    records,
    lifecycle: records.filter(
      (record) => !String(record.event).startsWith("invocation-"),
    ),
  };
}

function launch(port: ProjectionPort, digest: string): string {
  const admission = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.run-lifecycle-log" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  return admission.runId;
}

async function applied(
  port: ProjectionPort,
  submission: Parameters<ProjectionPort["submit"]>[0],
): Promise<void> {
  const admission = port.submit(submission);
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(port, submission.operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

function readRun(port: ProjectionPort, runId: string): RunView {
  const opened = port.openProjection({ family: "run", runId });
  try {
    if (!opened.snapshot.result.found) throw new Error("the Run is not found");
    return opened.snapshot.result.run;
  } finally {
    opened.close();
  }
}

function offered(run: RunView, action: ActionOffer["action"]): boolean {
  return run.actionOffers.some((offer) => offer.action === action);
}

/** Every record carries the Secant invocation's base fields at level info. */
function assertBase(logged: Logged): void {
  const id = logged.records[0]!.invocationId;
  for (const record of logged.lifecycle) {
    assert.equal(record.invocationId, id);
    assert.equal(record.level, "info");
    assert.equal(typeof record.time, "string");
  }
}

/** Nothing seeded into a prompt, input, transcript, or failure detail is logged. */
function assertNoPayload(text: string): void {
  for (const seeded of [
    SEEDED_PROMPT,
    SEEDED_TEXT,
    SEEDED_CONTENT,
    SEEDED_DIAGNOSTICS,
    SEEDED_PARTIAL,
    SEEDED_COORDINATE,
  ]) {
    assert.equal(text.includes(seeded), false, `${seeded} reached the log`);
  }
}

/** A record with the base fields dropped, for exact comparison. */
function semantic(record: Record<string, unknown>): Record<string, unknown> {
  const { level: _level, time: _time, invocationId: _id, ...rest } = record;
  return rest;
}

test("a retried Agent Step logs the Run, two Attempts with distinct ids, and each Turn with its Session, and no streamed event", async (t) => {
  let runId = "";
  const logged = await invocation(
    t,
    {
      routing: [agentStep("draft", 1)],
      turns: [{ result: FAILED }, { events: streamed(60), result: COMPLETED }],
    },
    async (port, digest) => {
      runId = launch(port, digest);
      await awaitSettled(port, "op-launch");
      assert.equal(readRun(port, runId).state, "succeeded");
    },
  );
  assert.equal(logged.status, 0);
  assertBase(logged);
  assertNoPayload(logged.text);

  const failure = logged.lifecycle[3]!;
  const cause = failure.cause as Record<string, unknown>;
  assert.equal(cause.type, "Error");
  assert.equal(cause.message, "native turn failed");
  // Each start and its settlement read the clock once, 125 ms apart per read, so
  // the elapsed values count the reads between them.
  assert.deepEqual(logged.lifecycle.map(semantic), [
    { event: "run-start", runId },
    { event: "attempt-start", runId, attemptId: "0.0:draft" },
    {
      event: "turn-start",
      runId,
      attemptId: "0.0:draft",
      turnId: "0.0:draft#turn",
      session: "planning",
    },
    {
      event: "turn-end",
      runId,
      attemptId: "0.0:draft",
      turnId: "0.0:draft#turn",
      session: "planning",
      result: "failed",
      phase: "turn",
      category: "execution",
      possibleEffects: "possible",
      nativeCode: "E_NATIVE_42",
      cause,
      elapsedMs: 125,
    },
    {
      event: "attempt-end",
      runId,
      attemptId: "0.0:draft",
      outcome: "failed",
      elapsedMs: 375,
    },
    { event: "attempt-start", runId, attemptId: "0.1:draft" },
    {
      event: "turn-start",
      runId,
      attemptId: "0.1:draft",
      turnId: "0.1:draft#turn",
      session: "planning",
    },
    {
      event: "turn-end",
      runId,
      attemptId: "0.1:draft",
      turnId: "0.1:draft#turn",
      session: "planning",
      result: "completed",
      elapsedMs: 125,
    },
    {
      event: "attempt-end",
      runId,
      attemptId: "0.1:draft",
      outcome: "succeeded",
      elapsedMs: 375,
    },
    { event: "run-end", runId, outcome: "succeeded", elapsedMs: 1125 },
  ]);
});

test("settlement elapsed time is monotonic: a wall clock that jumps backwards does not distort it", async (t) => {
  // Each wall-clock read lands an hour earlier than the last.
  let wall = WALL.getTime();
  const logged = await invocation(
    t,
    {
      routing: [agentStep("draft", 0)],
      turns: [{ result: COMPLETED }],
      clock: steppingClock(() => new Date((wall -= 3_600_000))),
    },
    async (port, digest) => {
      launch(port, digest);
      await awaitSettled(port, "op-launch");
    },
  );
  const times = logged.lifecycle.map((record) =>
    Date.parse(String(record.time)),
  );
  for (let index = 1; index < times.length; index++) {
    assert.ok(times[index]! < times[index - 1]!, "the wall clock went back");
  }
  assert.deepEqual(
    logged.lifecycle.map((record) => [record.event, record.elapsedMs]),
    [
      ["run-start", undefined],
      ["attempt-start", undefined],
      ["turn-start", undefined],
      ["turn-end", 125],
      ["attempt-end", 375],
      ["run-end", 625],
    ],
  );
});

test("an interactive Step and an authored gate log their pauses, the human Turn, and the Attempt outcomes the Application settles", async (t) => {
  let runId = "";
  const logged = await invocation(
    t,
    {
      routing: [
        {
          id: "discuss",
          kind: "interactive-agent",
          session: "s",
          prompt: { asset: "prompts/work.md" },
        },
        {
          id: "gate",
          kind: "human-gate",
          shape: "approve-reject",
          message: "ok?",
        },
        {
          id: "apply",
          kind: "agent",
          retry: 0,
          session: "s",
          prompt: { asset: "prompts/work.md" },
        },
      ],
      turns: [
        { result: COMPLETED },
        { result: COMPLETED },
        { result: COMPLETED },
      ],
      supportsInteractiveTurns: true,
    },
    async (port, digest) => {
      runId = launch(port, digest);
      await awaitSettled(port, "op-launch");
      assert.equal(readRun(port, runId).state, "blocked");
      await applied(port, {
        operationId: "op-turn",
        operation: "send-interactive-turn",
        input: { runId, stepId: "discuss", text: SEEDED_TEXT },
      });
      await awaitRunRest(port, runId);
      await applied(port, {
        operationId: "op-end",
        operation: "end-interactive-step",
        input: { runId, stepId: "discuss" },
      });
      const atGate = readRun(port, runId);
      assert.ok(atGate.pendingGate);
      await applied(port, {
        operationId: "op-answer",
        operation: "answer-human-gate",
        input: { runId, gate: atGate.pendingGate.gate, answer: "continue" },
      });
      assert.equal(readRun(port, runId).state, "succeeded");
    },
  );
  assertBase(logged);
  assertNoPayload(logged.text);
  assert.deepEqual(
    logged.lifecycle.map((record) => [
      record.event,
      record.attemptId ?? record.runId === runId,
      record.outcome ?? record.result ?? record.session,
    ]),
    [
      ["run-start", true, undefined],
      ["attempt-start", "0.0:discuss", undefined],
      ["attempt-pause", "0.0:discuss", undefined],
      ["run-end", true, "blocked"],
      // The human Turn reaches the Session outside any Routing walk.
      ["turn-start", "0.0:discuss", "s"],
      ["turn-end", "0.0:discuss", "completed"],
      // End Step settles the paused Attempt, then re-walks to the gate.
      ["attempt-end", "0.0:discuss", "succeeded"],
      ["run-start", true, undefined],
      ["attempt-start", "0.0:gate", undefined],
      ["attempt-pause", "0.0:gate", undefined],
      ["run-end", true, "blocked"],
      // The answer settles the gate's Attempt, then the walk runs the last Step.
      ["attempt-end", "0.0:gate", "succeeded"],
      ["run-start", true, undefined],
      ["attempt-start", "0.0:apply", undefined],
      ["turn-start", "0.0:apply", "s"],
      ["turn-end", "0.0:apply", "completed"],
      ["attempt-end", "0.0:apply", "succeeded"],
      ["run-end", true, "succeeded"],
    ],
  );
  // The paused Attempts started in this Secant invocation, so the outcomes the
  // Application settles still carry elapsed time; a pause is not a settlement.
  for (const record of logged.lifecycle) {
    const settles = String(record.event).endsWith("-end");
    assert.equal(
      typeof record.elapsedMs === "number",
      settles,
      String(record.event),
    );
  }
});

test("a cancelled Run logs the interrupted Turn and unwinds its Attempt and Run without claiming an outcome", async (t) => {
  let runId = "";
  const logged = await invocation(
    t,
    {
      routing: [agentStep("draft", 0)],
      turns: [{ block: true, result: COMPLETED }],
    },
    async (port, digest) => {
      runId = launch(port, digest);
      // Wait for the live Turn, so the cancel interrupts it.
      for (
        let tick = 0;
        !offered(readRun(port, runId), "interrupt-turn");
        tick++
      ) {
        assert.ok(tick < 1000, "the Turn never went live");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await applied(port, {
        operationId: "op-cancel",
        operation: "cancel-run",
        input: { runId },
      });
      await awaitSettled(port, "op-launch");
      assert.equal(readRun(port, runId).state, "cancelled");
    },
  );
  assert.deepEqual(
    logged.lifecycle.map((record) => [
      record.event,
      record.outcome ?? record.result,
      typeof record.elapsedMs,
    ]),
    [
      ["run-start", undefined, "undefined"],
      ["attempt-start", undefined, "undefined"],
      ["turn-start", undefined, "undefined"],
      ["turn-end", "interrupted", "number"],
      ["attempt-unwind", undefined, "number"],
      ["run-unwind", undefined, "number"],
    ],
  );
});
