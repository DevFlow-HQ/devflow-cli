// The Claude Code native Interrupt (#346), driven through the Adapter Seam with a
// scripted Process that answers stdin frames the way Claude Code does. No child
// runs, so these cases hold on every OS; the recorded wire is replayed against a
// real child in runtime conformance (tests/harness/replayer-conformance.ts).

import assert from "node:assert/strict";
import test from "node:test";
import {
  createClaudeCodeAdapter,
  type HarnessPhaseFact,
  type HarnessContainmentObserver,
  type HarnessTurn,
  type PreparedHarness,
  type TurnEvent,
  type TurnRequest,
} from "../../src/harness/harness.js";
import type {
  OwnedProcess,
  OwnedProcessClose,
  ProcessAdapter,
  ProcessInterruption,
  ProcessLaunchContainment,
} from "../../src/process/process.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";

const SESSION_ID = "12121212-1212-4121-8121-121212121212";

type Frame = Record<string, unknown>;

/** How the scripted Claude Code answers one stdin control request. */
type ControlAnswer =
  | "confirm"
  | "refuse"
  | "ignore"
  | "complete-instead"
  | "acknowledge-only"
  | ((frame: Frame, emit: (frame: Frame) => void, exit: () => void) => void);

interface ScriptedClaude {
  readonly process: ProcessAdapter;
  /** Every stdin frame the Adapter wrote, per spawned process. */
  readonly writes: Frame[][];
  /** How many times the Adapter stopped a process. */
  stops(): number;
  /** Resolves once the Adapter has read a `control_response` line: the reader
   *  pulled the next line, so it finished dispatching that one. */
  readonly responseRead: Promise<void>;
}

/** A scripted Claude Code: each user Turn frame gets an init and some streamed
 *  text, so the Turn is live and blocks; each control request is answered per
 *  `answer`; a stop settles the process with `interruption`. */
function scriptedClaude(options: {
  readonly answer: ControlAnswer;
  readonly containment?: ProcessLaunchContainment;
  readonly interruption?: ProcessInterruption;
  readonly userFrame?: (index: number) => readonly Frame[];
}): ScriptedClaude {
  const writes: Frame[][] = [];
  let stops = 0;
  let markResponseRead!: () => void;
  const responseRead = new Promise<void>((resolve) => {
    markResponseRead = resolve;
  });
  const fake = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commands: [
      {
        trigger: "immediate",
        result: {
          kind: "exited",
          status: 0,
          text: new TextEncoder().encode("2.1.288 (Claude Code)"),
        },
      },
    ],
  });
  const spawnOwnedProcess: ProcessAdapter["spawnOwnedProcess"] = () => {
    const written: Frame[] = [];
    writes.push(written);
    const lines: string[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let resolveClose!: (close: OwnedProcessClose) => void;
    const closed = new Promise<OwnedProcessClose>((resolve) => {
      resolveClose = resolve;
    });
    const emit = (frame: Frame) => {
      lines.push(`${JSON.stringify(frame)}\n`);
      wake?.();
    };
    const settle = (close: OwnedProcessClose): OwnedProcessClose => {
      ended = true;
      wake?.();
      resolveClose(close);
      return close;
    };
    async function* stdout(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const line = lines.shift();
        if (line !== undefined) {
          yield new TextEncoder().encode(line);
          if (line.includes('"control_response"')) markResponseRead();
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
    // eslint-disable-next-line require-yield
    async function* stderr(): AsyncGenerator<Uint8Array> {
      await closed;
    }
    let users = 0;
    let stopped: Promise<ProcessInterruption> | undefined;
    const owned: OwnedProcess = {
      stdout: stdout(),
      stderr: stderr(),
      writeStdin: (bytes) => {
        const frame = JSON.parse(new TextDecoder().decode(bytes)) as Frame;
        written.push(frame);
        queueMicrotask(() => {
          if (frame.type === "user") {
            const frames = options.userFrame?.(users) ?? liveTurn();
            users += 1;
            for (const each of frames) emit(each);
          } else if (frame.type === "control_request") {
            answerControl(options.answer, frame, emit, () =>
              settle({ kind: "exited", status: 1 }),
            );
          }
        });
        return Promise.resolve();
      },
      closeStdin: () => Promise.resolve(settle({ kind: "exited", status: 0 })),
      interrupt: () => {
        stopped ??= (async () => {
          stops += 1;
          const interruption = options.interruption ?? {
            close: { kind: "exited", status: 143 },
            escalated: false,
          };
          settle(interruption.close);
          return interruption;
        })();
        return stopped;
      },
      closed: () => closed,
    };
    return Promise.resolve({
      ok: true,
      process: owned,
      containment: options.containment,
    });
  };
  return {
    process: {
      resolveExecutable: (name, resolveOptions) =>
        fake.resolveExecutable(name, resolveOptions),
      spawnCommand: (spawnOptions) => fake.spawnCommand(spawnOptions),
      spawnCommandSync: (spawnOptions) => fake.spawnCommandSync(spawnOptions),
      spawnOwnedProcess,
    },
    writes,
    stops: () => stops,
    responseRead,
  };
}

const init: Frame = {
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  model: "scripted-model",
};

function liveTurn(): Frame[] {
  return [
    init,
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "partial" }] },
    },
  ];
}

function controlResponse(frame: Frame, subtype: string): Frame {
  return {
    type: "control_response",
    response: {
      subtype,
      request_id: frame.request_id,
      ...(subtype === "error" ? { error: "not now" } : {}),
    },
  };
}

const abortedResult: Frame = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  terminal_reason: "aborted_streaming",
};

function answerControl(
  answer: ControlAnswer,
  frame: Frame,
  emit: (frame: Frame) => void,
  exit: () => void,
): void {
  if (typeof answer === "function") {
    answer(frame, emit, exit);
    return;
  }
  switch (answer) {
    case "confirm":
      emit(controlResponse(frame, "success"));
      emit(abortedResult);
      return;
    case "refuse":
      emit(controlResponse(frame, "error"));
      return;
    case "acknowledge-only":
      emit(controlResponse(frame, "success"));
      return;
    case "complete-instead":
      emit({ type: "result", subtype: "success", result: "finished first" });
      emit(controlResponse(frame, "success"));
      return;
    case "ignore":
      return;
  }
}

async function prepare(
  scripted: ScriptedClaude,
  options: {
    readonly controlTimeoutMs?: number;
    readonly phases?: HarnessPhaseFact[];
    readonly containment?: HarnessContainmentObserver;
  } = {},
): Promise<PreparedHarness> {
  const prepared = await createClaudeCodeAdapter({
    env: {},
    sessionId: () => SESSION_ID,
    ...(options.controlTimeoutMs !== undefined
      ? { controlTimeoutMs: options.controlTimeoutMs }
      : {}),
  }).prepare({
    workspace: makeTempDir("secant-claude-interrupt-ws-"),
    process: scripted.process,
    containment: options.containment,
    ...(options.phases !== undefined
      ? { phases: (fact) => options.phases!.push(fact) }
      : {}),
  });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  return prepared.harness;
}

function turnRequest(
  text: string,
  resume?: TurnRequest["resume"],
): TurnRequest {
  return {
    session: "planning",
    origin: "managed",
    correlationKey: { opaque: text },
    input: { text },
    ...(resume !== undefined ? { resume } : {}),
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  };
}

/** Start a Turn and resolve once its Session is open, collecting its events. */
async function liveTurnOn(
  harness: PreparedHarness,
  text = "go",
): Promise<{ turn: HarnessTurn; events: TurnEvent[] }> {
  const turn = harness.startTurn(turnRequest(text));
  const events: TurnEvent[] = [];
  await new Promise<void>((resolve) => {
    turn.subscribe((event) => {
      events.push(event);
      if (event.kind === "session") resolve();
    });
  });
  return { turn, events };
}

function controlRequests(scripted: ScriptedClaude): Frame[] {
  return scripted.writes.flat().filter((f) => f.type === "control_request");
}

function controlSettlements(facts: readonly HarnessPhaseFact[]): string[] {
  return facts.flatMap((fact) =>
    fact.kind === "phase-end" && fact.phase === "control"
      ? [
          fact.outcome === "failed"
            ? `failed:${fact.failure.category}`
            : fact.outcome,
        ]
      : [],
  );
}

test("a confirmed native interrupt settles the Turn interrupted active-turn and keeps the process for the next Turn", async () => {
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: (index) =>
      index === 0
        ? liveTurn()
        : [init, { type: "result", subtype: "success", result: "continued" }],
  });
  const phases: HarnessPhaseFact[] = [];
  const harness = await prepare(scripted, { phases });
  const { turn } = await liveTurnOn(harness);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "active-turn");
  assert.deepEqual(result.detail.session, {
    state: "detached",
    coordinate: { opaque: SESSION_ID },
  });
  const [request] = controlRequests(scripted);
  assert.deepEqual(request?.request, { subtype: "interrupt" });
  assert.equal(typeof request?.request_id, "string");
  assert.equal(scripted.stops(), 0, "a confirmed stop never stops the process");
  assert.deepEqual(controlSettlements(phases), ["ok"]);

  // The next Turn, resuming the coordinate, runs on the same live process.
  const next = await harness
    .startTurn(turnRequest("again", result.detail.session.coordinate))
    .result();
  assert.equal(next.kind, "completed");
  assert.equal(scripted.writes.length, 1, "no relaunch");
  assert.deepEqual(
    scripted.writes[0]?.map((frame) => frame.type),
    ["user", "control_request", "user"],
  );
  await harness.close();
});

test("a refused interrupt falls back to the process stop at once", async () => {
  const scripted = scriptedClaude({ answer: "refuse" });
  const phases: HarnessPhaseFact[] = [];
  // A bound the test would time out on proves the refusal needs no wait.
  const harness = await prepare(scripted, {
    controlTimeoutMs: 600_000,
    phases,
  });
  const { turn, events } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "process-only");
  assert.equal(result.detail.session.state, "detached");
  assert.equal(scripted.stops(), 1);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes("refused the interrupt (not now)"),
    ),
  );
  assert.deepEqual(controlSettlements(phases), ["ok"]);
  await harness.close();
});

test("an unanswered interrupt falls back after the control bound, and a forced kill settles lost", async () => {
  const scripted = scriptedClaude({
    answer: "ignore",
    interruption: {
      close: { kind: "signal", signal: "SIGKILL" },
      escalated: true,
    },
  });
  const phases: HarnessPhaseFact[] = [];
  const harness = await prepare(scripted, { controlTimeoutMs: 20, phases });
  const { turn } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
  assert.equal(scripted.stops(), 1);
  assert.deepEqual(controlSettlements(phases), ["failed:interruption-unknown"]);
  await harness.close();
});

test("an acknowledged interrupt whose aborted result never arrives falls back within the same bound", async () => {
  const scripted = scriptedClaude({ answer: "acknowledge-only" });
  const harness = await prepare(scripted, { controlTimeoutMs: 20 });
  const { turn, events } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "process-only");
  assert.equal(scripted.stops(), 1);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes(
          "acknowledged the interrupt but did not end the Turn",
        ),
    ),
  );
  await harness.close();
});

test("a natural result that wins the race keeps its own truth and stops nothing", async () => {
  const scripted = scriptedClaude({ answer: "complete-instead" });
  const phases: HarnessPhaseFact[] = [];
  const harness = await prepare(scripted, { phases });
  const { turn } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  assert.equal(scripted.stops(), 0);
  assert.deepEqual(controlSettlements(phases), ["abandoned"]);
  await harness.close();
});

test("an aborted result with no Interrupt in flight is a failed Turn, never interrupted", async () => {
  const scripted = scriptedClaude({
    answer: "ignore",
    userFrame: () => [init, abortedResult],
  });
  const harness = await prepare(scripted);
  const result = await harness.startTurn(turnRequest("go")).result();
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("unreachable");
  assert.equal(result.detail.failure.category, "error_during_execution");
  await harness.close();
});

test("a failure result answering an Interrupt without an aborted reason settles failed", async () => {
  const scripted = scriptedClaude({
    answer: (frame, emit) => {
      emit(controlResponse(frame, "success"));
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
      });
    },
  });
  const harness = await prepare(scripted);
  const { turn } = await liveTurnOn(harness);
  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "failed");
  assert.equal(scripted.stops(), 0);
  await harness.close();
});

test("an internal stop stays a process stop and writes no control request", async () => {
  // An init that names another Session never started the Turn; the Adapter
  // stops the process itself, which is never a caller's Interrupt.
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [{ ...init, session_id: "another-session" }],
  });
  const harness = await prepare(scripted);
  const result = await harness.startTurn(turnRequest("go")).result();
  assert.equal(result.kind, "not-started");
  await harness.close();
  assert.equal(scripted.stops(), 1);
  assert.equal(controlRequests(scripted).length, 0);
});

test("close during a native interrupt falls back to the process stop without waiting out the bound", async () => {
  const scripted = scriptedClaude({ answer: "ignore" });
  const harness = await prepare(scripted, { controlTimeoutMs: 600_000 });
  const { turn } = await liveTurnOn(harness);

  const interrupted = turn.interrupt();
  // Let the control request reach stdin before closing.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controlRequests(scripted).length, 1);
  const cleanup = await harness.close();
  assert.deepEqual(await interrupted, { outcome: "accepted" });
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "process-only");
  assert.equal(scripted.stops(), 1);
  assert.equal(cleanup.clean, true);
});

test("close while an acknowledged interrupt awaits its aborted result falls back at once", async () => {
  const scripted = scriptedClaude({ answer: "acknowledge-only" });
  const harness = await prepare(scripted, { controlTimeoutMs: 600_000 });
  const { turn } = await liveTurnOn(harness);

  const interrupted = turn.interrupt();
  // Once the acknowledgement is read and its microtasks drain, only the
  // result wait remains, so the close must cut that wait short.
  await scripted.responseRead;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await harness.close();
  await interrupted;
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  assert.equal(scripted.stops(), 1);
});

test("a process that exits on its own before confirming settles lost with the interruption unknown", async () => {
  const scripted = scriptedClaude({
    answer: (frame, emit, exit) => {
      emit(controlResponse(frame, "success"));
      exit();
    },
  });
  const phases: HarnessPhaseFact[] = [];
  const harness = await prepare(scripted, { phases });
  const { turn } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
  assert.match(
    result.detail.failure?.diagnostics ?? "",
    /closed before confirming the interrupt \(process close with exit 1\)/,
  );
  assert.equal(scripted.stops(), 0, "nothing stopped the process");
  assert.deepEqual(controlSettlements(phases), ["failed:interruption-unknown"]);
  await harness.close();
});

test("a refusal's detail is bounded in the fallback activity", async () => {
  const scripted = scriptedClaude({
    answer: (frame, emit) =>
      emit({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: frame.request_id,
          error: "x".repeat(10_000),
        },
      }),
  });
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  await turn.interrupt();
  await turn.result();
  const refusal = events.find(
    (event) =>
      event.kind === "activity" && event.description.includes("refused"),
  );
  assert.ok(refusal?.kind === "activity");
  assert.ok(refusal.description.length < 400);
  await harness.close();
});

for (const kind of ["contained", "fallback"] as const) {
  test(`Claude reports ${kind} only on a lazy Session launch`, async () => {
    const facts: { kind: string; session?: string }[] = [];
    const scripted = scriptedClaude({
      answer: "confirm",
      containment:
        kind === "contained"
          ? { kind }
          : { kind, cause: new Error("forced job failure") },
    });
    const harness = await prepare(scripted, {
      containment: (fact) => facts.push(fact),
    });
    assert.deepEqual(facts, []);
    const first = await liveTurnOn(harness);
    assert.deepEqual(facts, [{ kind, session: "planning" }]);
    await first.turn.interrupt();
    await first.turn.result();
    const second = await liveTurnOn(harness, "next");
    assert.deepEqual(facts, [{ kind, session: "planning" }]);
    await second.turn.interrupt();
    await harness.close();
  });
}
