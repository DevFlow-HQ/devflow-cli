import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { withClients } from "../../src/composition/main.js";
import type { HeadlessClients } from "../../src/headless/headless.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type TurnEvent,
  type TurnResult,
} from "../../src/harness/harness.js";
import type {
  ActionOffer,
  ProjectionPort,
} from "../../src/application/projection-port.js";
import { createFake, type FakeTurnScript } from "../harness/fake-adapter.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";

import {
  profile,
  writeBundle,
  launch,
  applied,
  readRun,
  semantic,
  agentStep,
  COMPLETED,
  SEEDED_PROMPT,
  SEEDED_TEXT,
  SEEDED_CONTENT,
  SEEDED_DIAGNOSTICS,
  SEEDED_PARTIAL,
  SEEDED_COORDINATE,
} from "../helpers/runLogFixture.js";

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

interface Logged {
  readonly status: number;
  readonly text: string;
  readonly records: readonly Record<string, unknown>[];
  /** The Run, Attempt, and Turn records, in order. */
  readonly lifecycle: readonly Record<string, unknown>[];
}

/** Run `body` as one headless Secant invocation over a fresh home, with the
 *  Bundle installed and the Workspace approved, then read its one log file. */
// The Application's qualification, launch-preparation, Preflight, and Operation
// records (#319), which `tests/composition/application-log.test.ts` asserts.
const APPLICATION_EVENTS = new Set([
  "qualification-start",
  "qualification-result",
  "launch-preparation-start",
  "launch-preparation-settle",
  "preflight-start",
  "preflight-settle",
  "model-check-start",
  "model-check-settle",
  "operation-admission",
  "operation-outcome",
]);

async function invocation(
  t: TestContext,
  options: {
    readonly routing: readonly unknown[];
    readonly turns: readonly FakeTurnScript[];
    readonly clock?: ReturnType<typeof steppingClock>;
    readonly adapter?: HarnessAdapter;
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
      harnessAdapter:
        options.adapter ??
        createFake({
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
    // The Run, Attempt, and Turn lifecycle alone: the invocation records, the
    // Harness's phase, cleanup, and usage records (#322), and the Application's
    // pre-Run records (#319) are asserted elsewhere.
    lifecycle: records.filter(
      (record) =>
        !String(record.event).startsWith("invocation-") &&
        !String(record.event).startsWith("harness-") &&
        !APPLICATION_EVENTS.has(String(record.event)),
    ),
  };
}

function offered(
  run: ReturnType<typeof readRun>,
  action: ActionOffer["action"],
): boolean {
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
      turnId: "0.0:draft#turn-1",
      session: "planning",
    },
    {
      event: "turn-end",
      runId,
      attemptId: "0.0:draft",
      turnId: "0.0:draft#turn-1",
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
      turnId: "0.1:draft#turn-1",
      session: "planning",
    },
    {
      event: "turn-end",
      runId,
      attemptId: "0.1:draft",
      turnId: "0.1:draft#turn-1",
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
      ["run-end", true, "blocked"],
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
      settles && record !== logged.lifecycle[6],
      String(record.event),
    );
  }
});

test("a live cancel logs the interrupted Turn and execution unwind before Application rests the Run cancelled", async (t) => {
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
      ["run-end", "cancelled", "undefined"],
    ],
  );
});

test("cancelling a held blocked Run correlates the Operation and logs its cancelled rest once", async (t) => {
  let runId = "";
  const logged = await invocation(
    t,
    {
      routing: [
        agentStep("draft", 0),
        {
          id: "gate",
          kind: "human-gate",
          shape: "approve-reject",
          message: "ok?",
        },
      ],
      turns: [{ result: COMPLETED }],
    },
    async (port, digest) => {
      runId = launch(port, digest);
      await awaitSettled(port, "op-launch");
      assert.equal(readRun(port, runId).state, "blocked");
      const cancel = {
        operationId: "op-cancel",
        operation: "cancel-run",
        input: { runId },
      } as const;
      await applied(port, cancel);
      await applied(port, cancel);
    },
  );
  assert.deepEqual(
    logged.lifecycle
      .filter((record) => record.event === "run-end")
      .map(semantic),
    [
      { event: "run-end", runId, outcome: "blocked", elapsedMs: 750 },
      { event: "run-end", runId, outcome: "cancelled" },
    ],
  );
  assert.deepEqual(
    logged.records
      .filter((record) => record.operationId === "op-cancel")
      .map(semantic),
    [
      {
        event: "operation-admission",
        operationId: "op-cancel",
        operation: "cancel-run",
        runId,
        status: "admitted",
      },
      {
        event: "operation-outcome",
        operationId: "op-cancel",
        operation: "cancel-run",
        runId,
        status: "applied",
        elapsedMs: 125,
      },
      {
        event: "operation-admission",
        operationId: "op-cancel",
        operation: "cancel-run",
        runId,
        status: "replayed",
      },
    ],
  );
});

for (const gateKind of ["authored", "checkpoint"] as const) {
  test(`a stop answer at a ${gateKind} Gate logs the Run failed after the answer commits`, async (t) => {
    let runId = "";
    const gate =
      gateKind === "authored"
        ? {
            id: "gate",
            kind: "human-gate",
            shape: "approve-reject",
            message: "ok?",
          }
        : {
            repeat: {
              until: "passing",
              reviewCheckpoint: { interval: 1, message: "review" },
              steps: [
                {
                  id: "check",
                  kind: "command",
                  produces: [{ name: "passing", type: "verdict" }],
                  command: {
                    executable: RUNTIME_NAME,
                    arguments: ["-e", "process.exit(1)"],
                  },
                },
              ],
            },
          };
    const logged = await invocation(
      t,
      {
        routing: [
          agentStep("draft", 0),
          ...(gateKind === "checkpoint"
            ? [
                {
                  id: "initial",
                  kind: "command",
                  produces: [{ name: "passing", type: "verdict" }],
                  command: {
                    executable: RUNTIME_NAME,
                    arguments: ["-e", "process.exit(1)"],
                  },
                },
              ]
            : []),
          gate,
        ],
        turns: [{ result: COMPLETED }],
      },
      async (port, digest) => {
        runId = launch(port, digest);
        await awaitSettled(port, "op-launch");
        const run = readRun(port, runId);
        const gate = run.pendingGate?.gate ?? run.checkpoint?.gate;
        assert.ok(gate);
        await applied(port, {
          operationId: "op-stop",
          operation: "answer-human-gate",
          input: { runId, gate, answer: "stop" },
        });
        assert.equal(readRun(port, runId).state, "failed");
      },
    );
    const rests = logged.lifecycle.filter(
      (record) => record.event === "run-end",
    );
    assert.deepEqual(
      rests.map((record) => record.outcome),
      ["blocked", "failed"],
    );
    assert.deepEqual(semantic(rests[1]!), {
      event: "run-end",
      runId,
      outcome: "failed",
    });
    assert.ok(
      logged.records
        .filter((record) => record.operationId === "op-stop")
        .every((record) => record.runId === runId),
    );
  });
}

test("a preparation refusal after Continue logs the committed halted rest and correlated refusal", async (t) => {
  let runId = "";
  let prepares = 0;
  const adapter: HarnessAdapter = {
    prepare(options) {
      if (++prepares === 2)
        return Promise.resolve({
          ok: false,
          failure: {
            phase: "prepare",
            category: "protocol-incompatible",
            possibleEffects: "none",
          },
        });
      return createFake({
        profile: profile(),
        turns: [{ result: COMPLETED }],
      })().prepare(options);
    },
  };
  const logged = await invocation(
    t,
    {
      routing: [
        agentStep("draft", 0),
        {
          id: "gate",
          kind: "human-gate",
          shape: "approve-reject",
          message: "ok?",
        },
        agentStep("apply", 0),
      ],
      turns: [],
      adapter,
    },
    async (port, digest) => {
      runId = launch(port, digest);
      await awaitSettled(port, "op-launch");
      const gate = readRun(port, runId).pendingGate?.gate;
      assert.ok(gate);
      assert.ok(
        port.submit({
          operationId: "op-continue",
          operation: "answer-human-gate",
          input: { runId, gate, answer: "continue" },
        }).admitted,
      );
      const outcome = await awaitSettled(port, "op-continue");
      assert.equal(outcome.status, "not-applied");
      assert.equal(readRun(port, runId).state, "halted");
    },
  );
  const rests = logged.lifecycle.filter((record) => record.event === "run-end");
  assert.deepEqual(
    rests.map((record) => record.outcome),
    ["blocked", "halted"],
  );
  assert.deepEqual(semantic(rests[1]!), {
    event: "run-end",
    runId,
    outcome: "halted",
  });
  const records = logged.records.filter(
    (record) => record.operationId === "op-continue",
  );
  assert.deepEqual(
    records.map((record) => [
      record.event,
      record.runId,
      record.status,
      record.code,
    ]),
    [
      ["operation-admission", runId, "admitted", undefined],
      [
        "operation-outcome",
        runId,
        "not-applied",
        "selected-harness-unavailable",
      ],
    ],
  );
});

for (const result of ["interrupted", "lost"] as const) {
  test(`a ${result} human Turn logs the Application's halted Run rest`, async (t) => {
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
        ],
        turns: [
          result === "interrupted"
            ? { block: true, result: COMPLETED }
            : {
                result: {
                  kind: "lost",
                  detail: {
                    unknown: "completion",
                    lastObservation: SEEDED_CONTENT,
                    session: {
                      state: "detached",
                      coordinate: { opaque: SEEDED_COORDINATE },
                    },
                  },
                },
              },
        ],
        supportsInteractiveTurns: true,
      },
      async (port, digest) => {
        runId = launch(port, digest);
        await awaitSettled(port, "op-launch");
        await applied(port, {
          operationId: "op-human",
          operation: "send-interactive-turn",
          input: { runId, stepId: "discuss", text: SEEDED_TEXT },
        });
        if (result === "interrupted") {
          for (
            let tick = 0;
            !offered(readRun(port, runId), "interrupt-turn");
            tick++
          ) {
            assert.ok(tick < 1000, "the human Turn never went live");
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          const turn = readRun(port, runId).actionOffers.find(
            (offer) => offer.action === "interrupt-turn",
          );
          assert.ok(turn);
          assert.equal(turn.action, "interrupt-turn");
          if (turn.action !== "interrupt-turn") throw new Error("unreachable");
          await applied(port, {
            operationId: "op-interrupt",
            operation: "interrupt-turn",
            input: { runId, turnId: turn.turnId },
          });
        }
        assert.equal((await awaitRunRest(port, runId)).state, "halted");
      },
    );
    assertNoPayload(logged.text);
    const rests = logged.lifecycle.filter(
      (record) => record.event === "run-end",
    );
    assert.deepEqual(
      rests.map((record) => record.outcome),
      ["blocked", "halted"],
    );
    assert.deepEqual(semantic(rests[1]!), {
      event: "run-end",
      runId,
      outcome: "halted",
    });
  });
}
