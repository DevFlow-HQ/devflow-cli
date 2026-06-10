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
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
} from "../../src/adapters/managedSessionAdapter.js";
import type {
  JsonlTailEventSource,
  JsonlTailReadResult,
} from "../../src/adapters/jsonlTailEventSource.js";
import {
  runClaudeJsonlSession,
  type ClaudeJsonlSessionCommand,
} from "../../src/adapters/claudeJsonlSessionRunner.js";
import type { SessionLogLocator } from "../../src/adapters/codexSessionLogLocator.js";
import {
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
  type UserInput,
} from "../../src/adapters/ptyManagedSessionRunner.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";
import type { Logger } from "../../src/logger.js";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ columns: number; rows: number }> = [];
  readonly emitter = new EventEmitter();
  removedDataListeners = 0;
  removedExitListeners = 0;
  killed = false;
  killError: unknown;

  onData(listener: (data: string) => void): { dispose(): void } {
    this.emitter.on("data", listener);

    return {
      dispose: () => {
        this.removedDataListeners += 1;
        this.emitter.off("data", listener);
      },
    };
  }

  onExit(
    listener: (event: { exitCode: number; signal: NodeJS.Signals | null }) => void,
  ): { dispose(): void } {
    this.emitter.on("exit", listener);

    return {
      dispose: () => {
        this.removedExitListeners += 1;
        this.emitter.off("exit", listener);
      },
    };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  kill(): void {
    if (this.killError) {
      throw this.killError;
    }

    this.killed = true;
  }

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

class ScriptedClaudePtySpawner implements PtySpawner {
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
      void this.script(options);
    });
    return this.process;
  }
}

function createCapturingLogger() {
  const entries: Array<{
    level: keyof Logger;
    msg: string;
    context: Parameters<Logger["debug"]>[1];
  }> = [];
  const logger: Logger = {
    debug: (msg, context) => entries.push({ level: "debug", msg, context }),
    info: (msg, context) => entries.push({ level: "info", msg, context }),
    warn: (msg, context) => entries.push({ level: "warn", msg, context }),
    error: (msg, context) => entries.push({ level: "error", msg, context }),
    critical: (msg, context) => {
      entries.push({ level: "critical", msg, context });
      return "err_test";
    },
  };

  return { entries, logger };
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

function createCommand(): ClaudeJsonlSessionCommand {
  return {
    provider: getBuiltInProviderIdentity("claude"),
    executable: "claude",
    args: ["--model", "sonnet", "Start"],
  };
}

function createResumeCommand(): ClaudeJsonlSessionCommand {
  return {
    provider: getBuiltInProviderIdentity("claude"),
    executable: "claude",
    args: ["--resume", "claude-session-1", "--model", "sonnet", "Resume"],
    resumeProviderSessionId: "claude-session-1",
  };
}

async function appendTranscriptRecord(
  claudeHome: string,
  relativePath: string,
  record: unknown,
): Promise<void> {
  const filePath = join(claudeHome, relativePath);
  await fs.ensureDir(dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function createFixedSessionLogLocator(filePath: string): SessionLogLocator {
  return {
    async snapshot() {
      return { filePaths: new Set() };
    },
    async locateActiveLog() {
      await waitForFile(filePath);
      return {
        filePath,
        debug: {
          scopedProviderHome: dirname(dirname(filePath)),
          searchedPattern: "projects/**/*.jsonl",
          candidates: [{ filePath, size: 0, mtimeMs: 0 }],
          ignoredPreexistingCount: 0,
          emptyCandidateCount: 0,
          multipleCandidates: false,
        },
      };
    },
    async locateResumeLog() {
      throw new Error("resume is out of scope for this test");
    },
  };
}

function createFixedResumeSessionLogLocator(
  location: Awaited<ReturnType<SessionLogLocator["locateResumeLog"]>>,
  options: {
    onSnapshot?: () => void;
  } = {},
): SessionLogLocator {
  return {
    async snapshot() {
      options.onSnapshot?.();
      return { filePaths: new Set() };
    },
    async locateActiveLog() {
      throw new Error("fresh lookup is out of scope for this test");
    },
    async locateResumeLog(providerSessionId) {
      assert.equal(providerSessionId, "claude-session-1");
      return location;
    },
  };
}

function createPostExitRaceEventSource(recordsAfterBlockedRead: unknown[]): {
  jsonlEventSourceFactory: () => JsonlTailEventSource;
  waitForFirstRead: () => Promise<void>;
  waitForReadInProgress: () => Promise<void>;
  releaseFirstRead: () => void;
  readInProgressCount: () => number;
} {
  let releaseFirstRead!: () => void;
  let resolveFirstRead!: () => void;
  let resolveReadInProgress!: () => void;
  let reading = false;
  let completedReadCount = 0;
  let readInProgressCount = 0;
  const firstRead = new Promise<void>((resolve) => {
    resolveFirstRead = resolve;
  });
  const readInProgress = new Promise<void>((resolve) => {
    resolveReadInProgress = resolve;
  });
  const firstReadReleased = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const emptyResult: JsonlTailReadResult = { records: [], diagnostics: [] };
  const eventSource: JsonlTailEventSource = {
    async readNewRecords() {
      if (reading) {
        readInProgressCount += 1;
        resolveReadInProgress();
        return {
          records: [],
          diagnostics: [{ type: "read-in-progress" }],
        };
      }

      reading = true;
      try {
        completedReadCount += 1;

        if (completedReadCount === 1) {
          resolveFirstRead();
          await firstReadReleased;
          return emptyResult;
        }

        if (completedReadCount === 2) {
          return { records: recordsAfterBlockedRead, diagnostics: [] };
        }

        return emptyResult;
      } finally {
        reading = false;
      }
    },
    watch() {},
    async close() {},
  };

  return {
    jsonlEventSourceFactory: () => eventSource,
    waitForFirstRead: () => firstRead,
    waitForReadInProgress: () => readInProgress,
    releaseFirstRead,
    readInProgressCount: () => readInProgressCount,
  };
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

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function hasCause(error: unknown, expectedCause: unknown): boolean {
  let current = error;

  while (current instanceof Error) {
    const cause = (current as Error & { cause?: unknown }).cause;

    if (cause === expectedCause) {
      return true;
    }

    current = cause;
  }

  return false;
}

test("Claude JSONL runner completes a fresh first turn from a scoped transcript", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const events: ManagedProviderSessionEvent[] = [];
  const output: string[] = [];
  const validationOrder: string[] = [];
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    spawner.process.emitData("raw terminal INITIAL_DONE must not validate\n");
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "normalized " },
          { type: "text", text: "assistant INITIAL_DONE" },
        ],
      },
    });
    spawner.process.emitExit(0);
  });

  const result = await runClaudeJsonlSession(
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
      outputSink: { write: (chunk) => output.push(chunk) },
      terminal: { columns: 100, rows: 30 },
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(spawner.calls, [
    {
      executable: "claude",
      args: ["--model", "sonnet", "Start"],
      options: {
        cwd: projectRoot,
        cols: 100,
        rows: 30,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: claudeHome,
        },
      },
    },
  ]);
  assert.deepEqual(output, ["raw terminal INITIAL_DONE must not validate\n"]);
  assert.deepEqual(validationOrder, ["validate"]);
  assert.deepEqual(
    events.map((event) =>
      event.type === "turn-completed"
        ? `${event.type}:${event.providerSessionId}:${event.assistantMessage}`
        : `${event.type}:${event.providerSessionId}`,
    ),
    [
      "session-start:undefined",
      "turn-completed:claude-session-1:normalized assistant INITIAL_DONE",
      "session-completed:undefined",
    ],
  );
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "INITIAL_DONE",
  });
});

test("Claude JSONL runner seeds scoped credentials without installing hook settings", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const sourceConfigDirectory = await fs.mkdtemp(
    join(tmpdir(), "devflow-claude-source-"),
  );
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);

  await fs.writeJson(join(sourceConfigDirectory, ".credentials.json"), {
    token: "source-token",
  });

  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "assistant INITIAL_DONE" }],
      },
    });
    spawner.process.emitExit(0);
  });

  await runClaudeJsonlSession(
    createCommand(),
    createInput(projectRoot),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
      platform: "linux",
      environment: { ...process.env, CLAUDE_CONFIG_DIR: sourceConfigDirectory },
    },
  );

  assert.deepEqual(await fs.readJson(join(claudeHome, ".credentials.json")), {
    token: "source-token",
  });
  assert.equal(await fs.pathExists(join(claudeHome, "settings.local.json")), false);
  assert.equal(await fs.pathExists(join(claudeHome, "devflow-hooks")), false);
});

test("Claude JSONL runner preserves macOS credential seeding skip", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const sourceConfigDirectory = await fs.mkdtemp(
    join(tmpdir(), "devflow-claude-source-"),
  );
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);

  await fs.writeJson(join(sourceConfigDirectory, ".credentials.json"), {
    token: "source-token",
  });

  const spawner = new ScriptedClaudePtySpawner(async () => {
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "assistant INITIAL_DONE" }],
      },
    });
    spawner.process.emitExit(0);
  });

  await runClaudeJsonlSession(
    createCommand(),
    createInput(projectRoot),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
      platform: "darwin",
      environment: { ...process.env, CLAUDE_CONFIG_DIR: sourceConfigDirectory },
    },
  );

  assert.equal(await fs.pathExists(join(claudeHome, ".credentials.json")), false);
});

test("Claude JSONL runner classifies human user records and suppresses managed prompt echoes", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "user",
      sessionId: "claude-session-1",
      message: {
        role: "user",
        content: "Start",
      },
    });
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "user",
      sessionId: "claude-session-1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "human " },
          { type: "image", source: { type: "base64", media_type: "image/png" } },
          { type: "text", text: "reply" },
        ],
      },
    });
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "assistant INITIAL_DONE" }],
      },
    });
    spawner.process.emitExit(0);
  });

  await runClaudeJsonlSession(
    createCommand(),
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(
    events
      .filter((event) => event.type === "submitted-user-message")
      .map((event) => `${event.origin}:${event.message}`),
    ["human:human reply"],
  );
});

test("Claude JSONL runner keeps draining after PTY exit while a JSONL read is active", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const events: ManagedProviderSessionEvent[] = [];
  const race = createPostExitRaceEventSource([
    {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "assistant INITIAL_DONE" }],
      },
    },
  ]);
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await fs.ensureFile(transcriptPath);
    await race.waitForFirstRead();
    spawner.process.emitExit(0);
    await race.waitForReadInProgress();
    race.releaseFirstRead();
  });

  const result = await runClaudeJsonlSession(
    createCommand(),
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      jsonlEventSourceFactory: race.jsonlEventSourceFactory,
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
      earlyExitDrainTimeoutMs: 100,
    },
  );

  assert.equal(race.readInProgressCount() > 0, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["session-start", "turn-completed", "session-completed"],
  );
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "INITIAL_DONE",
  });
});

test("Claude JSONL runner resumes by tailing an existing transcript from the captured offset", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-resume-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const events: ManagedProviderSessionEvent[] = [];
  const validationOrder: string[] = [];
  let snapshotCalled = false;
  const staleRecord = `${JSON.stringify({
    type: "assistant",
    sessionId: "claude-session-1",
    message: {
      id: "msg_stale",
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "stale INITIAL_DONE" }],
    },
  })}\n`;

  await fs.ensureDir(dirname(transcriptPath));
  await fs.writeFile(transcriptPath, staleRecord, "utf8");

  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "user",
      sessionId: "claude-session-1",
      message: {
        role: "user",
        content: "Resume",
      },
    });
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_resumed",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "resumed INITIAL_DONE" }],
      },
    });
    spawner.process.emitExit(0);
  });

  const result = await runClaudeJsonlSession(
    createResumeCommand(),
    createInput(projectRoot, {
      initialPrompt: "Resume",
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
      sessionLogLocator: createFixedResumeSessionLogLocator(
        {
          filePath: transcriptPath,
          startOffset: Buffer.byteLength(staleRecord, "utf8"),
          debug: {
            scopedProviderHome: claudeHome,
            searchedPattern: "projects/**/*.jsonl",
            candidates: [],
            ignoredPreexistingCount: 0,
            emptyCandidateCount: 0,
            multipleCandidates: false,
          },
        },
        {
          onSnapshot() {
            snapshotCalled = true;
          },
        },
      ),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.equal(snapshotCalled, false);
  assert.deepEqual(spawner.calls.map((call) => call.args), [
    ["--resume", "claude-session-1", "--model", "sonnet", "Resume"],
  ]);
  assert.deepEqual(validationOrder, ["validate"]);
  assert.deepEqual(
    events.map((event) =>
      event.type === "turn-completed"
        ? `${event.type}:${event.providerSessionId}:${event.assistantMessage}`
        : event.type === "submitted-user-message"
          ? `${event.type}:${event.origin}:${event.message}`
          : `${event.type}:${event.providerSessionId}`,
    ),
    [
      "session-start:claude-session-1",
      "turn-completed:claude-session-1:resumed INITIAL_DONE",
      "session-completed:undefined",
    ],
  );
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "INITIAL_DONE",
  });
});

test("Claude JSONL runner keeps PTY control-only while mirroring output, stdin, and resize", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const output: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];
  const userInput = new FakeUserInput();
  const terminal = new FakeTerminal(90, 25);
  const { entries, logger } = createCapturingLogger();
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await fs.ensureDir(dirname(transcriptPath));
    await fs.writeFile(transcriptPath, "", "utf8");
    spawner.process.emitData("terminal marker INITIAL_DONE should not validate\n");
    userInput.emitData("hello\r");
    terminal.emitResize(120, 40);
    await waitForPtyWrites(spawner.process, 1);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "JSONL says INITIAL_DONE" }],
      },
    });
    spawner.process.emitExit(0);
  });

  await runClaudeJsonlSession(
    { ...createCommand(), logger },
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
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(output, [
    "terminal marker INITIAL_DONE should not validate\n",
  ]);
  assert.deepEqual(spawner.process.writes, ["hello\r"]);
  assert.deepEqual(spawner.process.resizes, [{ columns: 120, rows: 40 }]);
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.resumeCount, 1);
  assert.equal(userInput.pauseCount, 1);
  assert.equal(userInput.listenerCount("data"), 0);
  assert.equal(terminal.listenerCount("resize"), 0);
  assert.equal(spawner.process.removedDataListeners, 1);
  assert.equal(spawner.process.removedExitListeners, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["session-start", "turn-completed", "session-completed"],
  );

  const ptyTraceEntries = entries.filter((entry) =>
    entry.msg.startsWith("adapter pty process"),
  );
  assert.deepEqual(
    ptyTraceEntries.map((entry) => ({
      msg: entry.msg,
      context: entry.context?.context,
    })),
    [
      {
        msg: "adapter pty process spawned",
        context: {
          providerId: "claude",
          executable: "claude",
          argumentCount: 3,
        },
      },
      {
        msg: "adapter pty process exit",
        context: {
          providerId: "claude",
          exitCode: 0,
          signal: null,
        },
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(ptyTraceEntries), new RegExp(projectRoot));
});

test("Claude JSONL runner resolves success after graceful shutdown exits naturally", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "assistant INITIAL_DONE" }],
      },
    });
    await waitUntil(() => spawner.process.writes.includes("/exit\n"));
    spawner.process.emitExit(0);
  });

  const result = await runClaudeJsonlSession(
    { ...createCommand(), cleanupCommand: "/exit\n" },
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
      cleanupTimeoutMs: 100,
    },
  );

  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "INITIAL_DONE",
  });
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
  assert.equal(spawner.process.killed, false);
  assert.equal(events.at(-1)?.type, "session-completed");
});

test("Claude JSONL runner force-kills after valid completion and still resolves success", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "assistant INITIAL_DONE" }],
      },
    });
  });

  const result = await runClaudeJsonlSession(
    { ...createCommand(), cleanupCommand: "/exit\n" },
    createInput(projectRoot),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
      cleanupTimeoutMs: 5,
    },
  );

  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "INITIAL_DONE",
  });
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
  assert.equal(spawner.process.killed, true);
});

test("Claude JSONL runner raises cleanup errors only when shutdown force-kill throws", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const killError = new Error("kill failed");
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    spawner.process.killError = killError;
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "assistant INITIAL_DONE" }],
      },
    });
  });

  await assert.rejects(
    runClaudeJsonlSession(
      { ...createCommand(), cleanupCommand: "/exit\n" },
      createInput(projectRoot),
      {
        ptySpawner: spawner,
        outputSink: { write() {} },
        sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
        locatorTimeoutMs: 1_000,
        firstEventTimeoutMs: 1_000,
        cleanupTimeoutMs: 5,
      },
    ),
    (error) =>
      error instanceof ProviderSessionCleanupError && error.cause === killError,
  );
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
});

test("Claude JSONL runner rejects original failures while detached cleanup shuts down the PTY", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const originalFailure = new Error("consumer failed");
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "assistant INITIAL_DONE" }],
      },
    });
  });

  await assert.rejects(
    runClaudeJsonlSession(
      { ...createCommand(), cleanupCommand: "/exit\n" },
      createInput(projectRoot, {
        onProviderEvent(event) {
          if (event.type === "turn-completed") {
            throw originalFailure;
          }
        },
      }),
      {
        ptySpawner: spawner,
        outputSink: { write() {} },
        sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
        locatorTimeoutMs: 1_000,
        firstEventTimeoutMs: 1_000,
        cleanupTimeoutMs: 5,
      },
    ),
    (error) =>
      error instanceof ProviderSessionEventCaptureError &&
      hasCause(error, originalFailure),
  );

  await waitUntil(() => spawner.process.killed);
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
});

test("Claude JSONL runner forwards Ctrl-C and reports requested interruption on provider exit", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const userInput = new FakeUserInput();
  let interrupted = false;
  const spawner = new ScriptedClaudePtySpawner(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    userInput.emitData("\u0003");
    interrupted = true;
    spawner.process.emitExit(130, "SIGINT");
  });

  await assert.rejects(
    runClaudeJsonlSession(createCommand(), createInput(projectRoot), {
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
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.listenerCount("data"), 0);
});

test("Claude JSONL runner submits continuation prompts through PTY and emits managed user events", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_initial",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "initial INITIAL_DONE" }],
      },
    });
    await waitForPtyWrites(spawner.process, 1);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_continuation",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "continued CONTINUATION_DONE" }],
      },
    });
    spawner.process.emitExit(0);
  });

  await runClaudeJsonlSession(
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
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(spawner.process.writes, ["\u001b[200~Continue\u001b[201~\r"]);
  assert.deepEqual(
    events.map((event) =>
      event.type === "submitted-user-message"
        ? `${event.type}:${event.phaseId}:${event.origin}:${event.message}`
        : `${event.type}:${event.phaseId}`,
    ),
    [
      "session-start:runabc123456:intent:attempt-1",
      "turn-completed:runabc123456:intent:attempt-1",
      "submitted-user-message:runabc123456:prd:attempt-1:managed:Continue",
      "turn-completed:runabc123456:prd:attempt-1",
      "session-completed:undefined",
    ],
  );
});

test("Claude JSONL runner submits repair prompts through PTY and reports repair usage", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-"));
  const claudeHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".claude");
  const transcript = "projects/-tmp-devflow/session-1.jsonl";
  const transcriptPath = join(claudeHome, transcript);
  let validateCalls = 0;
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, claudeHome);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_initial",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "initial INITIAL_DONE" }],
      },
    });
    await waitForPtyWrites(spawner.process, 1);
    await appendTranscriptRecord(claudeHome, transcript, {
      type: "assistant",
      sessionId: "claude-session-1",
      message: {
        id: "msg_repair",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "repaired REPAIR_DONE" }],
      },
    });
    spawner.process.emitExit(0);
  });

  const result = await runClaudeJsonlSession(
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
      sessionLogLocator: createFixedSessionLogLocator(transcriptPath),
      locatorTimeoutMs: 1_000,
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.equal(result.repairUsed, true);
  assert.deepEqual(spawner.process.writes, ["\u001b[200~Repair\u001b[201~\r"]);
  assert.deepEqual(
    events
      .filter((event) => event.type === "submitted-user-message")
      .map((event) => `${event.phaseId}:${event.origin}:${event.message}`),
    ["runabc123456:intent:attempt-1:repair-1:managed:Repair"],
  );
});

test("Claude JSONL runner wraps resume transcript lookup failures as provider event capture errors", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-jsonl-resume-missing-"));
  const lookupFailure = new Error("resume transcript missing");
  const locator: SessionLogLocator = {
    async snapshot() {
      throw new Error("snapshot should not be called for resume");
    },
    async locateActiveLog() {
      throw new Error("fresh lookup should not be called for resume");
    },
    async locateResumeLog() {
      throw lookupFailure;
    },
  };

  await assert.rejects(
    () =>
      runClaudeJsonlSession(
        createResumeCommand(),
        createInput(projectRoot, { initialPrompt: "Resume" }),
        {
          ptySpawner: new ScriptedClaudePtySpawner(async () => {}),
          outputSink: { write() {} },
          sessionLogLocator: locator,
          locatorTimeoutMs: 10,
          firstEventTimeoutMs: 10,
        },
      ),
    (error) => {
      assert.ok(error instanceof ProviderSessionEventCaptureError);
      assert.equal(error.cause, lookupFailure);
      return true;
    },
  );
});
