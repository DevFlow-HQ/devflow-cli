import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import fs from "fs-extra";

import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  runCodexJsonlSession,
  type CodexJsonlSessionCommand,
} from "../../src/adapters/codexJsonlSessionRunner.js";
import type { SessionLogLocator } from "../../src/adapters/codexSessionLogLocator.js";
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

async function appendNativeUserMessage(
  codexHome: string,
  relativePath: string,
  message: string,
): Promise<void> {
  await appendRolloutRecord(codexHome, relativePath, {
    timestamp: "2026-05-30T00:00:00.500Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: message }],
    },
  });
}

async function waitForPtyWrites(
  process: FakePtyProcess,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (process.writes.length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} PTY writes.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!(await fs.pathExists(path))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForProviderEvent(
  events: ManagedProviderSessionEvent[],
  predicate: (event: ManagedProviderSessionEvent) => boolean,
): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!events.some(predicate)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for provider event.");
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function createFixedSessionLogLocator(filePath: string): SessionLogLocator {
  return {
    async snapshot() {
      return { filePaths: new Set() };
    },
    async locateActiveLog() {
      return {
        filePath,
        debug: {
          scopedProviderHome: dirname(dirname(dirname(dirname(filePath)))),
          searchedPattern: "sessions/**/rollout-*.jsonl",
          candidates: [{ filePath, size: 0, mtimeMs: 0 }],
          ignoredPreexistingCount: 0,
          emptyCandidateCount: 0,
          multipleCandidates: false,
        },
      };
    },
    async locateResumeLog() {
      return {
        filePath,
        startOffset: 0,
        debug: {
          scopedProviderHome: dirname(dirname(dirname(dirname(filePath)))),
          searchedPattern: "sessions/**/rollout-*.jsonl",
          candidates: [{ filePath, size: 0, mtimeMs: 0 }],
          ignoredPreexistingCount: 0,
          emptyCandidateCount: 0,
          multipleCandidates: false,
        },
      };
    },
  };
}

async function prepareFixedRollout(projectRoot: string): Promise<{
  codexHome: string;
  rollout: string;
  rolloutPath: string;
  sessionLogLocator: SessionLogLocator;
}> {
  const codexHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".codex");
  const rollout = "sessions/2026/05/30/rollout-session.jsonl";
  const rolloutPath = join(codexHome, rollout);

  await fs.ensureFile(rolloutPath);

  return {
    codexHome,
    rollout,
    rolloutPath,
    sessionLogLocator: createFixedSessionLogLocator(rolloutPath),
  };
}

test("Codex JSONL runner completes a single phase from rollout task completion without PTY capture", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const { codexHome, rollout, sessionLogLocator } =
    await prepareFixedRollout(projectRoot);
  const events: ManagedProviderSessionEvent[] = [];
  const validationOrder: string[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
    await waitForPtyWrites(spawner.process, 1);
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
      sessionLogLocator,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

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
      origin:
        event.type === "submitted-user-message" ? event.origin : undefined,
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
        origin: undefined,
        assistantMessage: undefined,
      },
      {
        type: "submitted-user-message",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: undefined,
        source: "jsonl",
        structured: true,
        message: "Start",
        origin: "managed",
        assistantMessage: undefined,
      },
      {
        type: "turn-completed",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: undefined,
        source: "jsonl",
        structured: true,
        message: undefined,
        origin: undefined,
        assistantMessage: "terminal text is irrelevant INITIAL_DONE",
      },
      {
        type: "session-completed",
        phaseId: undefined,
        providerSessionId: undefined,
        source: "jsonl",
        structured: true,
        message: undefined,
        origin: undefined,
        assistantMessage: undefined,
      },
    ],
  );
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "INITIAL_DONE",
  });
});

test("Codex JSONL runner classifies native user messages and suppresses managed prompt echoes", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const { codexHome, rollout, sessionLogLocator } =
    await prepareFixedRollout(projectRoot);
  const events: ManagedProviderSessionEvent[] = [];
  const output: string[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
    await waitForPtyWrites(spawner.process, 1);
    await appendSessionMeta(codexHome, rollout);
    await appendNativeUserMessage(codexHome, rollout, "Start");
    await appendNativeUserMessage(codexHome, rollout, "human reply");
    await appendRolloutRecord(codexHome, rollout, {
      timestamp: "2026-05-30T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "JSONL final INITIAL_DONE" }],
      },
    });
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
      sessionLogLocator,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(output, []);
  assert.deepEqual(
    events
      .filter((event) => event.type === "submitted-user-message")
      .map((event) => `${event.origin}:${event.message}`),
    ["managed:Start", "human:human reply"],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "turn-completed")
      .map((event) => event.assistantMessage),
    ["JSONL final INITIAL_DONE"],
  );
});

test("Codex JSONL runner resumes by tailing an existing rollout from the captured offset", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const codexHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".codex");
  const rollout =
    "sessions/2026/05/30/rollout-2026-05-30T00-00-00-codex-session-1.jsonl";
  const rolloutPath = join(codexHome, rollout);
  const events: ManagedProviderSessionEvent[] = [];
  const locatorCalls: string[] = [];

  await appendSessionMeta(codexHome, rollout);
  await appendTaskComplete(codexHome, rollout, "previous turn INITIAL_DONE");
  const startOffset = (await fs.stat(rolloutPath)).size;

  const sessionLogLocator: SessionLogLocator = {
    async snapshot() {
      locatorCalls.push("snapshot");
      throw new Error("resume should not snapshot");
    },
    async locateActiveLog() {
      locatorCalls.push("locateActiveLog");
      throw new Error("resume should not use snapshot-diff discovery");
    },
    async locateResumeLog(providerSessionId) {
      locatorCalls.push(`locateResumeLog:${providerSessionId}`);
      return {
        filePath: rolloutPath,
        startOffset,
        debug: {
          scopedProviderHome: codexHome,
          searchedPattern: "sessions/**/rollout-*.jsonl",
          candidates: [{ filePath: rolloutPath, size: startOffset, mtimeMs: 0 }],
          ignoredPreexistingCount: 0,
          emptyCandidateCount: 0,
          multipleCandidates: false,
        },
      };
    },
  };
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
    await waitForPtyWrites(spawner.process, 1);
    await appendTaskComplete(codexHome, rollout, "resumed turn INITIAL_DONE");
    spawner.process.emitExit(0);
  });

  await runCodexJsonlSession(
    {
      ...createCommand(),
      args: ["resume", "codex-session-1"],
      resumeProviderSessionId: "codex-session-1",
    },
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(locatorCalls, ["locateResumeLog:codex-session-1"]);
  assert.deepEqual(spawner.process.writes, ["\u001b[200~Start\u001b[201~\r"]);
  assert.deepEqual(
    events.map((event) =>
      event.type === "turn-completed"
        ? `${event.type}:${event.assistantMessage}`
        : event.type,
    ),
    [
      "session-start",
      "submitted-user-message",
      "turn-completed:resumed turn INITIAL_DONE",
      "session-completed",
    ],
  );
});

test("Codex JSONL runner fresh launch snapshots before spawn and tails selected rollouts from offset zero", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const codexHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".codex");
  const existingRollout = "sessions/2026/05/30/rollout-existing.jsonl";
  const freshRollout = "sessions/2026/05/30/rollout-fresh.jsonl";
  const existingRolloutPath = join(codexHome, existingRollout);
  const freshRolloutPath = join(codexHome, freshRollout);
  const events: ManagedProviderSessionEvent[] = [];
  const calls: string[] = [];
  const snapshot = { filePaths: new Set<string>([existingRolloutPath]) };

  await appendSessionMeta(codexHome, existingRollout);
  await appendTaskComplete(
    codexHome,
    existingRollout,
    "preexisting turn INITIAL_DONE",
  );

  const sessionLogLocator: SessionLogLocator = {
    async snapshot() {
      calls.push("snapshot");
      assert.equal(spawner.calls.length, 0);
      return snapshot;
    },
    async locateActiveLog(receivedSnapshot) {
      calls.push("locateActiveLog");
      assert.equal(receivedSnapshot, snapshot);
      assert.deepEqual(Array.from(receivedSnapshot.filePaths), [
        existingRolloutPath,
      ]);
      await waitForFile(freshRolloutPath);
      return {
        filePath: freshRolloutPath,
        debug: {
          scopedProviderHome: codexHome,
          searchedPattern: "sessions/**/rollout-*.jsonl",
          candidates: [{ filePath: freshRolloutPath, size: 0, mtimeMs: 0 }],
          ignoredPreexistingCount: 1,
          emptyCandidateCount: 0,
          multipleCandidates: false,
        },
      };
    },
    async locateResumeLog(providerSessionId) {
      calls.push(`locateResumeLog:${providerSessionId}`);
      throw new Error("fresh launch should not use resume lookup");
    },
  };
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
    await appendSessionMeta(codexHome, freshRollout);
    await appendTaskComplete(codexHome, freshRollout, "fresh turn INITIAL_DONE");
    await waitForPtyWrites(spawner.process, 1);
    await waitForProviderEvent(
      events,
      (event) => event.type === "turn-completed",
    );
    spawner.process.emitExit(0);
  });
  const originalSpawn = spawner.spawn.bind(spawner);
  spawner.spawn = (...args) => {
    calls.push("spawn");
    return originalSpawn(...args);
  };

  await runCodexJsonlSession(
    createCommand(),
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(calls, ["snapshot", "spawn", "locateActiveLog"]);
  assert.deepEqual(spawner.calls.map((call) => call.args), [
    ["--model", "gpt-test"],
  ]);
  assert.deepEqual(
    events.map((event) =>
      event.type === "turn-completed"
        ? `${event.type}:${event.assistantMessage}`
        : event.type,
    ),
    [
      "session-start",
      "submitted-user-message",
      "turn-completed:fresh turn INITIAL_DONE",
      "session-completed",
    ],
  );
});

test("Codex JSONL runner keeps PTY control-only while mirroring output, stdin, and resize", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const { codexHome, rollout, sessionLogLocator } =
    await prepareFixedRollout(projectRoot);
  const output: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];
  const userInput = new FakeUserInput();
  const terminal = new FakeTerminal(90, 25);
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
    spawner.process.emitData("terminal marker INITIAL_DONE should not validate\n");
    userInput.emitData("hello\r");
    terminal.emitResize(120, 40);
    await waitForPtyWrites(spawner.process, 7);
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
      sessionLogLocator,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(output, [
    "terminal marker INITIAL_DONE should not validate\n",
  ]);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Start\u001b[201~\r",
    "h",
    "e",
    "l",
    "l",
    "o",
    "\r",
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
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    }),
    InterruptedProviderSessionError,
  );

  assert.equal(spawner.process.writes.includes("\u0003"), true);
});

test("Codex JSONL runner submits continuation prompts through PTY and emits managed user events", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const { codexHome, rollout, sessionLogLocator } =
    await prepareFixedRollout(projectRoot);
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
    await waitForPtyWrites(spawner.process, 1);
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
      sessionLogLocator,
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
        ? `${event.type}:${event.phaseId}:${event.origin}:${event.message}`
        : `${event.type}:${event.phaseId}`,
    ),
    [
      "session-start:runabc123456:intent:attempt-1",
      "submitted-user-message:runabc123456:intent:attempt-1:managed:Start",
      "turn-completed:runabc123456:intent:attempt-1",
      "submitted-user-message:runabc123456:prd:attempt-1:managed:Continue",
      "turn-completed:runabc123456:prd:attempt-1",
      "session-completed:undefined",
    ],
  );
});

test("Codex JSONL runner submits repair prompts through PTY and reports repair usage", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const { codexHome, rollout, sessionLogLocator } =
    await prepareFixedRollout(projectRoot);
  let validateCalls = 0;
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
    await appendSessionMeta(codexHome, rollout);
    await waitForPtyWrites(spawner.process, 1);
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
      sessionLogLocator,
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
      .map((event) => `${event.phaseId}:${event.origin}:${event.message}`),
    [
      "runabc123456:intent:attempt-1:managed:Start",
      "runabc123456:intent:attempt-1:repair-1:managed:Repair",
    ],
  );
});

test("Codex JSONL runner fails with event capture when no rollout file appears", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const spawner = new ScriptedCodexPtySpawner(async () => {});

  await assert.rejects(
    runCodexJsonlSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      locatorTimeoutMs: 20,
      firstEventTimeoutMs: 1_000,
    }),
    ProviderSessionEventCaptureError,
  );
});

test("Codex JSONL runner fails when rollout has no usable structured event before timeout", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    await appendRolloutRecord(
      String(options.env?.CODEX_HOME),
      "sessions/2026/05/30/rollout-session.jsonl",
      {
        timestamp: "2026-05-30T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
        },
      },
    );
  });

  await assert.rejects(
    runCodexJsonlSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 20,
    }),
    ProviderSessionEventCaptureError,
  );
});

test("Codex JSONL runner classifies malformed load-bearing records as event capture failures", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    await appendRolloutRecord(
      String(options.env?.CODEX_HOME),
      "sessions/2026/05/30/rollout-session.jsonl",
      {
        timestamp: "2026-05-30T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
        },
      },
    );
  });

  await assert.rejects(
    runCodexJsonlSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    }),
    ProviderSessionEventCaptureError,
  );
});

test("Codex JSONL runner skips malformed unrelated completed lines", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const { codexHome, rollout, rolloutPath, sessionLogLocator } =
    await prepareFixedRollout(projectRoot);
  const events: ManagedProviderSessionEvent[] = [];
  await fs.appendFile(rolloutPath, "{unrelated}\n", "utf8");
  await fs.appendFile(
    rolloutPath,
    '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"INITIAL_DONE"}}\n',
    "utf8",
  );
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
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
      outputSink: { write() {} },
      sessionLogLocator,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "session-start",
      "submitted-user-message",
      "turn-completed",
      "session-completed",
    ],
  );
});

test("Codex JSONL runner drains briefly after early PTY exit before incomplete-session failure", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const codexHome = String(options.env?.CODEX_HOME);
    const rollout = "sessions/2026/05/30/rollout-session.jsonl";

    await appendSessionMeta(codexHome, rollout);
    spawner.process.emitExit(1);
  });

  await assert.rejects(
    runCodexJsonlSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
      earlyExitDrainTimeoutMs: 20,
    }),
    (error: unknown) => {
      assert.ok(error instanceof IncompleteProviderSessionError);
      assert.equal(error.completionMarker, "INITIAL_DONE");
      assert.equal(error.exitCode, 1);
      return true;
    },
  );
});

test("Codex JSONL runner reports cleanup timeout after phase finalization", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-jsonl-"));
  const { codexHome, rollout, sessionLogLocator } =
    await prepareFixedRollout(projectRoot);
  await appendSessionMeta(codexHome, rollout);
  await appendTaskComplete(codexHome, rollout, "INITIAL_DONE");
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    assert.equal(options.env?.CODEX_HOME, codexHome);
  });

  await assert.rejects(
    runCodexJsonlSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
      cleanupTimeoutMs: 20,
    }),
    ProviderSessionCleanupError,
  );
});
