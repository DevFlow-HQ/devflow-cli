// A scripted Claude Code behind the Process Interface: each stdin frame the
// Adapter writes is answered the way Claude Code does, with no child process.
// The native Interrupt (#346) and Steer (#359) suites drive the real Claude Code
// Adapter through it in the semantic suite; the recorded wire is replayed
// against a real child in runtime conformance (replayer-conformance.ts).

import assert from "node:assert/strict";
import {
  createClaudeCodeAdapter,
  type HarnessContainmentObserver,
  type HarnessPhaseFact,
  type HarnessTurn,
  type PreparedHarness,
  type TurnEvent,
  type TurnRequest,
} from "../../src/harness/harness.js";
import type {
  OwnedProcess,
  OwnedProcessClose,
  OwnedProcessOptions,
  ProcessAdapter,
  ProcessInterruption,
  ProcessLaunchContainment,
} from "../../src/process/process.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";

export const SESSION_ID = "12121212-1212-4121-8121-121212121212";

export type Frame = Record<string, unknown>;

/** How the scripted Claude Code answers one stdin control request. */
export type ControlAnswer =
  | "confirm"
  | "refuse"
  | "ignore"
  | "complete-instead"
  | "acknowledge-only"
  | ((frame: Frame, emit: (frame: Frame) => void, exit: () => void) => void);

export interface ScriptedClaude {
  readonly process: ProcessAdapter;
  /** Every stdin frame the Adapter wrote, per spawned process. */
  readonly writes: Frame[][];
  readonly spawnOptions: OwnedProcessOptions[];
  closed(): Promise<OwnedProcessClose>;
  /** How many times the Adapter stopped a process. */
  stops(): number;
  /** Resolves once the Adapter has read a `control_response` line: the reader
   *  pulled the next line, so it finished dispatching that one. */
  readonly responseRead: Promise<void>;
  /** Resolves after the Adapter dispatched a matching native frame. */
  frameRead(matches: (frame: Frame) => boolean): Promise<void>;
  /** Emit frames on the newest process's stdout, at a moment the test picks. */
  emit(...frames: readonly Frame[]): void;
  /** End the newest process on its own, as a crash or exit would. */
  exit(close?: OwnedProcessClose): void;
}

/** A scripted Claude Code: each user Turn frame gets an init and some streamed
 *  text, so the Turn is live and blocks; each control request is answered per
 *  `answer`; a stop settles the process with `interruption`. `userFrame` sees
 *  each stdin `user` frame on its process (a Turn or a Steer) by index. */
export function scriptedClaude(options: {
  readonly answer: ControlAnswer;
  readonly attachmentAnswer?: ControlAnswer;
  readonly closeStdin?: () => Promise<OwnedProcessClose>;
  readonly settingsAnswer?: ControlAnswer;
  readonly containment?: ProcessLaunchContainment;
  readonly interruption?:
    ProcessInterruption | (() => Promise<ProcessInterruption>);
  readonly userFrame?: (index: number, frame: Frame) => readonly Frame[];
}): ScriptedClaude {
  const writes: Frame[][] = [];
  const spawnOptions: OwnedProcessOptions[] = [];
  let stops = 0;
  const readFrames: Frame[] = [];
  const frameWaiters: {
    matches: (frame: Frame) => boolean;
    resolve: () => void;
  }[] = [];
  let markResponseRead!: () => void;
  const responseRead = new Promise<void>((resolve) => {
    markResponseRead = resolve;
  });
  let current:
    | {
        readonly closed: Promise<OwnedProcessClose>;
        readonly emit: (frame: Frame) => void;
        readonly settle: (close: OwnedProcessClose) => OwnedProcessClose;
      }
    | undefined;
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
  const spawnOwnedProcess: ProcessAdapter["spawnOwnedProcess"] = (launch) => {
    spawnOptions.push(launch);
    const written: Frame[] = [];
    writes.push(written);
    const lines: string[] = [];
    const interruptIds = new Set<unknown>();
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
    current = { emit, settle, closed };
    async function* stdout(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const line = lines.shift();
        if (line !== undefined) {
          yield new TextEncoder().encode(line);
          const read = JSON.parse(line) as Frame;
          readFrames.push(read);
          for (const waiter of frameWaiters)
            if (waiter.matches(read)) waiter.resolve();
          if (
            line.includes('"control_response"') &&
            interruptIds.has(JSON.parse(line).response?.request_id)
          )
            markResponseRead();
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
            const frames = options.userFrame?.(users, frame) ?? liveTurn();
            users += 1;
            for (const each of frames) emit(each);
          } else if (frame.type === "control_request") {
            const request = frame.request;
            if (
              typeof request === "object" &&
              request !== null &&
              "subtype" in request &&
              request.subtype === "interrupt"
            )
              interruptIds.add(frame.request_id);
            if (
              typeof request === "object" &&
              request !== null &&
              "subtype" in request &&
              request.subtype === "mcp_set_servers"
            ) {
              if (options.attachmentAnswer !== undefined)
                answerControl(
                  options.attachmentAnswer,
                  frame,
                  emit,
                  () => settle({ kind: "exited", status: 1 }),
                  false,
                );
              else
                emit({
                  type: "control_response",
                  response: {
                    subtype: "success",
                    request_id: frame.request_id,
                    response: {
                      added: ["secant", "secant-permissions"],
                      removed: [],
                      errors: {},
                    },
                  },
                });
            } else if (
              typeof request === "object" &&
              request !== null &&
              "subtype" in request &&
              request.subtype === "get_settings" &&
              options.settingsAnswer !== undefined
            ) {
              answerControl(
                options.settingsAnswer,
                frame,
                emit,
                () => settle({ kind: "exited", status: 1 }),
                false,
              );
            } else {
              answerControl(options.answer, frame, emit, () =>
                settle({ kind: "exited", status: 1 }),
              );
            }
          }
        });
        return Promise.resolve();
      },
      closeStdin: async () => {
        const result = await (options.closeStdin?.() ??
          Promise.resolve({ kind: "exited", status: 0 } as const));
        if (
          result.kind !== "cleanup-error" &&
          result.kind !== "cleanup-timeout"
        )
          settle(result);
        return result;
      },
      interrupt: () => {
        stopped ??= (async () => {
          stops += 1;
          const interruption =
            typeof options.interruption === "function"
              ? await options.interruption()
              : (options.interruption ?? {
                  close: { kind: "exited", status: 143 },
                  escalated: false,
                });
          if (
            interruption.close.kind !== "cleanup-error" &&
            interruption.close.kind !== "cleanup-timeout"
          )
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
    spawnOptions,
    closed: () => {
      assert.ok(current, "no scripted process is running");
      return current.closed;
    },
    stops: () => stops,
    responseRead,
    frameRead(matches) {
      if (readFrames.some(matches)) return Promise.resolve();
      return new Promise<void>((resolve) =>
        frameWaiters.push({ matches, resolve }),
      );
    },
    emit: (...frames) => {
      assert.ok(current, "no scripted process is running");
      for (const frame of frames) current.emit(frame);
    },
    exit: (close = { kind: "exited", status: 1 }) => {
      assert.ok(current, "no scripted process is running");
      current.settle(close);
    },
  };
}

export const init: Frame = {
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  model: "scripted-model",
};

export function liveTurn(): Frame[] {
  return [
    init,
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "partial" }] },
    },
  ];
}

export function controlResponse(frame: Frame, subtype: string): Frame {
  return {
    type: "control_response",
    response: {
      subtype,
      request_id: frame.request_id,
      ...(subtype === "error" ? { error: "not now" } : {}),
    },
  };
}

export const abortedResult: Frame = {
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
  defaultSettings = true,
): void {
  if (
    defaultSettings &&
    typeof frame.request === "object" &&
    frame.request !== null &&
    "subtype" in frame.request &&
    frame.request.subtype === "get_settings"
  ) {
    emit({
      ...controlResponse(frame, "success"),
      response: {
        subtype: "success",
        request_id: frame.request_id,
        response: { applied: { model: "scripted-model", effort: "high" } },
      },
    });
    return;
  }
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

export async function prepare(
  scripted: ScriptedClaude,
  options: {
    readonly controlTimeoutMs?: number;
    readonly handshakeTimeoutMs?: number;
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
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
  }).prepare({
    workspace: makeTempDir("secant-claude-scripted-ws-"),
    process: scripted.process,
    containment: options.containment,
    ...(options.phases !== undefined
      ? { phases: (fact) => options.phases!.push(fact) }
      : {}),
  });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  return prepared.harness;
}

export function turnRequest(
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
export async function liveTurnOn(
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

export function controlRequests(scripted: ScriptedClaude): Frame[] {
  return scripted.writes.flat().filter((f) => {
    const request = f.request;
    return (
      f.type === "control_request" &&
      typeof request === "object" &&
      request !== null &&
      "subtype" in request &&
      request.subtype === "interrupt"
    );
  });
}

export function controlSettlements(
  facts: readonly HarnessPhaseFact[],
): string[] {
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
