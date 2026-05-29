import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import fs from "fs-extra";

import {
  InterruptedProviderSessionError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  runCodexJsonlSession,
  type CodexJsonlSessionCommand,
} from "../../src/adapters/codexJsonlSessionRunner.js";
import {
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
  type UserInput,
} from "../../src/adapters/ptyManagedSessionRunner.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ columns: number; rows: number }> = [];
  readonly emitter = new EventEmitter();
  killed = false;

  onData(listener: (data: string) => void): void {
    this.emitter.on("data", listener);
  }

  onExit(
    listener: (event: { exitCode: number; signal: NodeJS.Signals | null }) => void,
  ): void {
    this.emitter.on("exit", listener);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  kill(): void {}

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows });
  }

  emitData(data: string): void {
    this.emitter.emit("data", data);
  }

  emitExit(exitCode: number, signal: NodeJS.Signals | null = null): void {
    this.emitter.emit("exit", { exitCode, signal });
  }
}

class ScriptedCodexPtySpawner implements PtySpawner {
  readonly process = new FakePtyProcess();
  readonly calls: Array<{
    executable: string;
    args: string[];
    options: PtySpawnOptions;
  }> = [];

  constructor(
    private readonly script: (options: PtySpawnOptions) => Promise<void>,
  ) {}

  spawn(
    executable: string,
    args: string[],
    options: PtySpawnOptions,
  ): PtyProcess {
    this.calls.push({ executable, args, options });
    setImmediate(() => {
      void this.script(options).catch((error) => {
        this.process.emitter.emit("script-error", error);
      });
    });
    return this.process;
  }
}

class FakeUserInput extends EventEmitter implements UserInput {
  readonly rawModeChanges: boolean[] = [];
  resumeCount = 0;
  pauseCount = 0;

  constructor(readonly isTTY = true, readonly isRaw = false) {
    super();
  }

  setRawMode(enabled: boolean): void {
    this.rawModeChanges.push(enabled);
  }

  override on(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): this {
    return super.on(event, listener);
  }

  override off(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): this {
    return super.off(event, listener);
  }

  resume(): void {
    this.resumeCount += 1;
  }

  pause(): void {
    this.pauseCount += 1;
  }

  emitData(chunk: Buffer | string): void {
    this.emit("data", chunk);
  }
}

class FakeTerminal extends EventEmitter {
  constructor(
    public columns: number | undefined,
    public rows: number | undefined,
  ) {
    super();
  }

  override on(event: "resize", listener: () => void): this {
    return super.on(event, listener);
  }

  override off(event: "resize", listener: () => void): this {
    return super.off(event, listener);
  }

  emitResize(columns: number | undefined, rows: number | undefined): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

function createInput(
  projectRoot: string,
  overrides: Partial<ManagedProviderSessionInput> = {},
): ManagedProviderSessionInput {
  return {
    workingDirectory: projectRoot,
    initialPrompt: "Start",
    initialCompletionMarker: "INITIAL_DONE",
    phase: {
      id: "runabc123456:intent:attempt-1",
      kind: "intent",
      attempt: 1,
    },
    async validate() {},
    ...overrides,
  };
}

function createCommand(): CodexJsonlSessionCommand {
  return {
    provider: getBuiltInProviderIdentity("codex"),
    executable: "codex",
    args: ["--model", "gpt-test"],
  };
}

async function appendRolloutRecord(
  codexHome: string,
  relativePath: string,
  record: unknown,
): Promise<void> {
  const filePath = join(codexHome, relativePath);
  await fs.ensureDir(dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function appendSessionMeta(
  codexHome: string,
  relativePath: string,
): Promise<void> {
  await appendRolloutRecord(codexHome, relativePath, {
    timestamp: "2026-05-30T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "codex-session-1",
    },
  });
}

async function appendTaskComplete(
  codexHome: string,
  relativePath: string,
  lastAgentMessage: string,
): Promise<void> {
  await appendRolloutRecord(codexHome, relativePath, {
    timestamp: "2026-05-30T00:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      last_agent_message: lastAgentMessage,
    },
  });
}

test("Codex JSONL runner completes a single phase from rollout task completion without PTY capture", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const events: ManagedProviderSessionEvent[] = [];
  const validationOrder: string[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const codexHome = String(options.env?.CODEX_HOME);
    const rollout = "sessions/2026/05/30/rollout-session.jsonl";

    await appendRolloutRecord(codexHome, rollout, {
      timestamp: "2026-05-30T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-session-1",
      },
    });
    await appendRolloutRecord(codexHome, rollout, {
      timestamp: "2026-05-30T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "terminal text is irrelevant INITIAL_DONE",
      },
    });
    spawner.process.emitExit(0);
  });

  const result = await runCodexJsonlSession(
    createCommand(),
    createInput(projectRoot, {
      async validate() {
        validationOrder.push("validate");
      },
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: { columns: 100, rows: 30 },
      pollIntervalMs: 5,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  const codexHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".codex");

  assert.deepEqual(spawner.calls, [
    {
      executable: "codex",
      args: ["--model", "gpt-test"],
      options: {
        cwd: projectRoot,
        cols: 100,
        rows: 30,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    },
  ]);
  assert.deepEqual(spawner.process.writes, ["\u001b[200~Start\u001b[201~\r"]);
  assert.deepEqual(validationOrder, ["validate"]);
  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      phaseId: event.phaseId,
      providerSessionId: event.providerSessionId,
      source: event.source,
      structured: event.structured,
      message: event.type === "submitted-user-message" ? event.message : undefined,
      assistantMessage:
        event.type === "turn-completed" ? event.assistantMessage : undefined,
    })),
    [
      {
        type: "session-start",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: undefined,
        source: "jsonl",
        structured: true,
        message: undefined,
        assistantMessage: undefined,
      },
      {
        type: "submitted-user-message",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: undefined,
        source: "jsonl",
        structured: true,
        message: "Start",
        assistantMessage: undefined,
      },
      {
        type: "turn-completed",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: undefined,
        source: "jsonl",
        structured: true,
        message: undefined,
        assistantMessage: "terminal text is irrelevant INITIAL_DONE",
      },
      {
        type: "session-completed",
        phaseId: undefined,
        providerSessionId: undefined,
        source: "jsonl",
        structured: true,
        message: undefined,
        assistantMessage: undefined,
      },
    ],
  );
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
});

test("Codex JSONL runner keeps PTY control-only while mirroring output, stdin, and resize", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const output: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];
  const userInput = new FakeUserInput();
  const terminal = new FakeTerminal(90, 25);
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const codexHome = String(options.env?.CODEX_HOME);
    const rollout = "sessions/2026/05/30/rollout-session.jsonl";

    spawner.process.emitData("terminal marker INITIAL_DONE should not validate\n");
    userInput.emitData("hello\r");
    terminal.emitResize(120, 40);
    await appendSessionMeta(codexHome, rollout);
    await appendTaskComplete(codexHome, rollout, "JSONL says INITIAL_DONE");
    spawner.process.emitExit(0);
  });

  await runCodexJsonlSession(
    createCommand(),
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write: (chunk) => output.push(chunk) },
      terminal,
      userInput,
      pollIntervalMs: 5,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(output, [
    "terminal marker INITIAL_DONE should not validate\n",
  ]);
  assert.deepEqual(spawner.process.writes, [
    "h",
    "e",
    "l",
    "l",
    "o",
    "\r",
    "\u001b[200~Start\u001b[201~\r",
  ]);
  assert.deepEqual(spawner.process.resizes, [{ columns: 120, rows: 40 }]);
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.resumeCount, 1);
  assert.equal(userInput.pauseCount, 1);
  assert.deepEqual(
    events.map((event) =>
      event.type === "submitted-user-message"
        ? `${event.type}:${event.message}`
        : event.type,
    ),
    [
      "session-start",
      "submitted-user-message:Start",
      "turn-completed",
      "session-completed",
    ],
  );
});

test("Codex JSONL runner forwards Ctrl-C and reports requested interruption on provider exit", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const userInput = new FakeUserInput();
  let interrupted = false;
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const codexHome = String(options.env?.CODEX_HOME);
    const rollout = "sessions/2026/05/30/rollout-session.jsonl";

    await appendSessionMeta(codexHome, rollout);
    await new Promise((resolve) => setTimeout(resolve, 20));
    userInput.emitData("\u0003");
    interrupted = true;
    spawner.process.emitExit(130, "SIGINT");
  });

  await assert.rejects(
    runCodexJsonlSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      userInput,
      userInterrupt: {
        wasRequested() {
          return interrupted;
        },
      },
      pollIntervalMs: 5,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    }),
    InterruptedProviderSessionError,
  );

  assert.equal(spawner.process.writes.includes("\u0003"), true);
});

test("Codex JSONL runner submits continuation prompts through PTY and emits managed user events", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const codexHome = String(options.env?.CODEX_HOME);
    const rollout = "sessions/2026/05/30/rollout-session.jsonl";

    await appendSessionMeta(codexHome, rollout);
    await appendTaskComplete(codexHome, rollout, "INITIAL_DONE");
    await appendTaskComplete(codexHome, rollout, "CONTINUATION_DONE");
    spawner.process.emitExit(0);
  });

  await runCodexJsonlSession(
    createCommand(),
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
      continuations: [
        {
          prompt: "Continue",
          completionMarker: "CONTINUATION_DONE",
          phase: {
            id: "runabc123456:prd:attempt-1",
            kind: "prd",
            attempt: 1,
          },
          async validate() {},
        },
      ],
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      pollIntervalMs: 5,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Start\u001b[201~\r",
    "\u001b[200~Continue\u001b[201~\r",
  ]);
  assert.deepEqual(
    events.map((event) =>
      event.type === "submitted-user-message"
        ? `${event.type}:${event.phaseId}:${event.message}`
        : `${event.type}:${event.phaseId}`,
    ),
    [
      "session-start:runabc123456:intent:attempt-1",
      "submitted-user-message:runabc123456:intent:attempt-1:Start",
      "turn-completed:runabc123456:intent:attempt-1",
      "submitted-user-message:runabc123456:prd:attempt-1:Continue",
      "turn-completed:runabc123456:prd:attempt-1",
      "session-completed:undefined",
    ],
  );
});

test("Codex JSONL runner submits repair prompts through PTY and reports repair usage", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  let validateCalls = 0;
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const codexHome = String(options.env?.CODEX_HOME);
    const rollout = "sessions/2026/05/30/rollout-session.jsonl";

    await appendSessionMeta(codexHome, rollout);
    await appendTaskComplete(codexHome, rollout, "INITIAL_DONE");
    await appendTaskComplete(codexHome, rollout, "REPAIR_DONE");
    spawner.process.emitExit(0);
  });

  const result = await runCodexJsonlSession(
    createCommand(),
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
      async validate() {
        validateCalls += 1;

        if (validateCalls === 1) {
          throw new Error("missing artifact");
        }
      },
      repair: {
        completionMarker: "REPAIR_DONE",
        renderPrompt() {
          return "Repair";
        },
        mapFailure(error) {
          return error;
        },
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      pollIntervalMs: 5,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.equal(result.repairUsed, true);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Start\u001b[201~\r",
    "\u001b[200~Repair\u001b[201~\r",
  ]);
  assert.deepEqual(
    events
      .filter((event) => event.type === "submitted-user-message")
      .map((event) => `${event.phaseId}:${event.message}`),
    [
      "runabc123456:intent:attempt-1:Start",
      "runabc123456:intent:attempt-1:repair-1:Repair",
    ],
  );
});
