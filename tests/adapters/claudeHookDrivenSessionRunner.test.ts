import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import fs from "fs-extra";

import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
  ProviderSessionLaunchError,
  ProviderSessionTranscriptCaptureError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  runClaudeHookDrivenSession,
  type ClaudeHookDrivenSessionCommand,
} from "../../src/adapters/claudeHookDrivenSessionRunner.js";
import { resolveHookSocketPath } from "../../src/adapters/hookSocketPath.js";
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

  kill(): void {
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

function createCommand(): ClaudeHookDrivenSessionCommand {
  return {
    provider: getBuiltInProviderIdentity("claude"),
    executable: "claude",
    args: ["--model", "sonnet-test", "Start"],
  };
}

function getHookScriptPath(projectRoot: string): string {
  return join(
    projectRoot,
    ".devflow",
    "runs",
    "runabc123456",
    ".claude",
    "devflow-hooks",
    "hook.js",
  );
}

async function runHookScript(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [hookScriptPath], {
      env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `hook exited with ${code}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Claude hook-driven runner installs hook settings, launches through PTY, and completes from hook events plus PTY exit", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const output: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];
  let validateCount = 0;
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    spawner.process.emitData("terminal marker INITIAL_DONE");
    assert.equal(validateCount, 0);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Start",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Manual clarification",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "done INITIAL_DONE",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
  });

  const input = createInput(projectRoot, {
    async validate() {
      validateCount += 1;
    },
    onProviderEvent(event) {
      events.push(event);
    },
  });
  const result = await runClaudeHookDrivenSession(createCommand(), input, {
    ptySpawner: spawner,
    outputSink: { write: (chunk) => output.push(chunk) },
    terminal: { columns: 100, rows: 30 },
    firstEventTimeoutMs: 1_000,
  });

  const hookDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    "runabc123456",
    ".claude",
    "devflow-hooks",
  );
  const claudeConfigDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    "runabc123456",
    ".claude",
  );
  const settings = await fs.readJson(
    join(claudeConfigDirectory, "settings.local.json"),
  );

  assert.equal(await fs.pathExists(join(hookDirectory, "hook.js")), true);
  assert.equal(
    await fs.pathExists(join(projectRoot, ".claude", "settings.local.json")),
    false,
  );
  assert.deepEqual(settings.hooks.SessionStart[0], {
    matcher: "startup",
    hooks: [
      {
        type: "command",
        command: `node '${join(hookDirectory, "hook.js")}'`,
      },
    ],
  });
  assert.deepEqual(spawner.calls, [
    {
      executable: "claude",
      args: ["--model", "sonnet-test", "Start"],
      options: {
        cwd: projectRoot,
        cols: 100,
        rows: 30,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: claudeConfigDirectory,
          DEVFLOW_HOOK_IPC_PATH: resolveHookSocketPath(input),
        },
      },
    },
  ]);
  assert.ok(
    Buffer.byteLength(resolveHookSocketPath(input)) <= 103,
    "hook socket path must fit within the macOS sun_path budget",
  );
  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      phaseId: event.phaseId,
      providerSessionId: event.providerSessionId,
      source: event.source,
      structured: event.structured,
      exitCode: event.type === "session-completed" ? event.exitCode : undefined,
      signal: event.type === "session-completed" ? event.signal : undefined,
      origin:
        event.type === "submitted-user-message" ? event.origin : undefined,
    })),
    [
      {
        type: "session-start",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "claude-session-1",
        source: "hooks",
        structured: true,
        exitCode: undefined,
        signal: undefined,
        origin: undefined,
      },
      {
        type: "submitted-user-message",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "claude-session-1",
        source: "hooks",
        structured: true,
        exitCode: undefined,
        signal: undefined,
        origin: "managed",
      },
      {
        type: "submitted-user-message",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "claude-session-1",
        source: "hooks",
        structured: true,
        exitCode: undefined,
        signal: undefined,
        origin: "human",
      },
      {
        type: "turn-completed",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "claude-session-1",
        source: "hooks",
        structured: true,
        exitCode: undefined,
        signal: undefined,
        origin: undefined,
      },
      {
        type: "session-completed",
        phaseId: undefined,
        providerSessionId: undefined,
        source: "hooks",
        structured: true,
        exitCode: 0,
        signal: null,
        origin: undefined,
      },
    ],
  );
  assert.deepEqual(output, ["terminal marker INITIAL_DONE"]);
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "INITIAL_DONE",
  });
  assert.equal(validateCount, 1);
});

test("Claude hook-driven runner seeds credentials from active source profile on linux", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const sourceConfigDirectory = await fs.mkdtemp(
    join(tmpdir(), "devflow-claude-source-"),
  );
  await fs.writeJson(join(sourceConfigDirectory, ".credentials.json"), {
    token: "source-token",
  });

  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    await runHookScript(getHookScriptPath(projectRoot), options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(getHookScriptPath(projectRoot), options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "done INITIAL_DONE",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
  });

  await runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
    ptySpawner: spawner,
    outputSink: { write() {} },
    firstEventTimeoutMs: 1_000,
    platform: "linux",
    environment: { ...process.env, CLAUDE_CONFIG_DIR: sourceConfigDirectory },
  });

  const scopedConfigDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    "runabc123456",
    ".claude",
  );
  assert.deepEqual(
    await fs.readJson(join(scopedConfigDirectory, ".credentials.json")),
    { token: "source-token" },
  );
  assert.equal(
    await fs.pathExists(join(scopedConfigDirectory, "settings.local.json")),
    true,
  );
});

test("Claude hook-driven runner allows missing source credentials on Windows", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const homeDirectory = await fs.mkdtemp(join(tmpdir(), "devflow-claude-home-"));
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    await runHookScript(getHookScriptPath(projectRoot), options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(getHookScriptPath(projectRoot), options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "done INITIAL_DONE",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
  });

  await runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
    ptySpawner: spawner,
    outputSink: { write() {} },
    firstEventTimeoutMs: 1_000,
    platform: "win32",
    environment: {},
    homeDirectory,
  });

  const scopedConfigDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    "runabc123456",
    ".claude",
  );
  assert.equal(
    await fs.pathExists(join(scopedConfigDirectory, ".credentials.json")),
    false,
  );
  assert.equal(
    spawner.calls[0]?.options.env?.CLAUDE_CONFIG_DIR,
    scopedConfigDirectory,
  );
});

test("Claude hook-driven runner does not seed credentials on macOS", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const sourceConfigDirectory = await fs.mkdtemp(
    join(tmpdir(), "devflow-claude-source-"),
  );
  await fs.writeJson(join(sourceConfigDirectory, ".credentials.json"), {
    token: "source-token",
  });

  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    await runHookScript(getHookScriptPath(projectRoot), options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(getHookScriptPath(projectRoot), options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "done INITIAL_DONE",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
  });

  await runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
    ptySpawner: spawner,
    outputSink: { write() {} },
    firstEventTimeoutMs: 1_000,
    platform: "darwin",
    environment: { ...process.env, CLAUDE_CONFIG_DIR: sourceConfigDirectory },
  });

  assert.equal(
    await fs.pathExists(
      join(
        projectRoot,
        ".devflow",
        "runs",
        "runabc123456",
        ".claude",
        ".credentials.json",
      ),
    ),
    false,
  );
});

test("Claude hook-driven runner fails before launch when existing credentials cannot be copied", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const sourceConfigDirectory = await fs.mkdtemp(
    join(tmpdir(), "devflow-claude-source-"),
  );
  await fs.ensureDir(join(sourceConfigDirectory, ".credentials.json"));
  const spawner = new ScriptedClaudePtySpawner(async () => {});

  await assert.rejects(
    runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
      platform: "linux",
      environment: { ...process.env, CLAUDE_CONFIG_DIR: sourceConfigDirectory },
    }),
    ProviderSessionLaunchError,
  );
  assert.deepEqual(spawner.calls, []);
});

test("Claude hook-driven runner rejects when the first structured event is not SessionStart", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Start",
      session_id: "claude-session-1",
    });
  });

  await assert.rejects(
    runClaudeHookDrivenSession(
      createCommand(),
      createInput(projectRoot),
      {
        ptySpawner: spawner,
        firstEventTimeoutMs: 1_000,
      },
    ),
    (error) =>
      error instanceof ProviderSessionEventCaptureError &&
      /before SessionStart/.test(error.message),
  );
  assert.equal(spawner.process.killed, true);
});

test("Claude hook-driven runner times out with Claude-specific diagnostics when SessionStart never arrives", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const spawner = new ScriptedClaudePtySpawner(async () => {});

  await assert.rejects(
    runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 5,
    }),
    (error) =>
      error instanceof ProviderSessionEventCaptureError &&
      /SessionStart/.test(error.message) &&
      /settings\.local\.json/.test(error.message) &&
      /disabled hooks/i.test(error.message) &&
      /managed policy/i.test(error.message) &&
      /hook\.js/.test(error.message) &&
      /\.sock/.test(error.message),
  );
  assert.equal(spawner.process.killed, true);
});

test("Claude hook-driven runner treats PTY exit before SessionStart as incomplete hook setup", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const spawner = new ScriptedClaudePtySpawner(async () => {
    spawner.process.emitExit(1);
  });

  await assert.rejects(
    runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
    }),
    (error) =>
      error instanceof IncompleteProviderSessionError &&
      /Claude hook setup may have failed before SessionStart/.test(
        error.completionMarker,
      ),
  );
});

test("Claude hook-driven runner drains briefly after early PTY exit before deciding incomplete", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  let validateCount = 0;
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
    await delay(1);
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "late marker INITIAL_DONE",
      session_id: "claude-session-1",
    });
  });

  const result = await runClaudeHookDrivenSession(
    createCommand(),
    createInput(projectRoot, {
      async validate() {
        validateCount += 1;
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
      socketDrainMs: 500,
    },
  );

  assert.equal(validateCount, 1);
  assert.equal(result.exitCode, 0);
});

test("Claude hook-driven runner keeps PTY control-only while mirroring output, stdin, and resize", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const output: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];
  const userInput = new FakeUserInput();
  const terminal = new FakeTerminal(90, 25);
  const { entries, logger } = createCapturingLogger();
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    spawner.process.emitData("terminal marker INITIAL_DONE should not validate\n");
    userInput.emitData("hello\r");
    terminal.emitResize(120, 40);
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "INITIAL_DONE",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
  });

  await runClaudeHookDrivenSession(
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
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(output, [
    "terminal marker INITIAL_DONE should not validate\n",
  ]);
  assert.deepEqual(spawner.process.writes, ["hello\r"]);
  assert.deepEqual(spawner.process.resizes, [{ columns: 120, rows: 40 }]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["session-start", "turn-completed", "session-completed"],
  );
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.resumeCount, 1);
  assert.equal(userInput.pauseCount, 1);
  assert.equal(userInput.listenerCount("data"), 0);
  assert.equal(terminal.listenerCount("resize"), 0);

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

test("Claude hook-driven runner forwards Ctrl-C and reports requested interruption on provider exit", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const userInput = new FakeUserInput();
  let interrupted = false;
  const spawner = new ScriptedClaudePtySpawner(async () => {
    await delay(20);
    userInput.emitData("\u0003");
    interrupted = true;
    spawner.process.emitExit(130, "SIGINT");
  });

  await assert.rejects(
    runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      userInput,
      userInterrupt: {
        wasRequested() {
          return interrupted;
        },
      },
      firstEventTimeoutMs: 1_000,
    }),
    InterruptedProviderSessionError,
  );

  assert.equal(spawner.process.writes.includes("\u0003"), true);
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.listenerCount("data"), 0);
});

test("Claude hook-driven runner treats PTY exit after SessionStart but before finalization as incomplete after drain", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(1);
  });

  await assert.rejects(
    runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
      socketDrainMs: 5,
    }),
    (error) =>
      error instanceof IncompleteProviderSessionError &&
      error.completionMarker === "INITIAL_DONE",
  );
});

test("Claude hook-driven runner raises cleanup errors when PTY does not exit after hook finalization", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "done INITIAL_DONE",
      session_id: "claude-session-1",
    });
  });

  await assert.rejects(
    runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
      cleanupTimeoutMs: 5,
    }),
    ProviderSessionCleanupError,
  );
});

test("Claude hook-driven runner maps hook payload schema failures to event capture errors", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
    });
  });

  await assert.rejects(
    runClaudeHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
    }),
    (error) =>
      error instanceof ProviderSessionEventCaptureError &&
      /Malformed Claude hook payload/.test(error.message),
  );
});

test("Claude hook-driven runner maps provider event callback failures to event capture errors", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Start",
      session_id: "claude-session-1",
    });
  });

  await assert.rejects(
    runClaudeHookDrivenSession(
      createCommand(),
      createInput(projectRoot, {
        onProviderEvent(event) {
          if (event.type === "submitted-user-message") {
            throw new Error("consumer failed");
          }
        },
      }),
      {
        ptySpawner: spawner,
        outputSink: { write() {} },
        firstEventTimeoutMs: 1_000,
      },
    ),
    (error) =>
      error instanceof ProviderSessionEventCaptureError &&
      /consumer failed/.test(error.message),
  );
});

test("Claude hook-driven runner ignores Stop events without assistant content for marker validation", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  let validateCount = 0;
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(1);
  });

  await assert.rejects(
    runClaudeHookDrivenSession(
      createCommand(),
      createInput(projectRoot, {
        async validate() {
          validateCount += 1;
        },
      }),
      {
        ptySpawner: spawner,
        outputSink: { write() {} },
        firstEventTimeoutMs: 1_000,
        socketDrainMs: 1,
      },
    ),
    (error) =>
      error instanceof IncompleteProviderSessionError &&
      error.completionMarker === "INITIAL_DONE",
  );
  assert.equal(validateCount, 0);
});

test("Claude hook-driven runner advances continuations from assistant markers and submits continuation prompts through PTY", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const events: ManagedProviderSessionEvent[] = [];
  const validationOrder: string[] = [];
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    spawner.process.emitData("terminal marker INITIAL_DONE should not validate\n");
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "initial complete INITIAL_DONE",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "prd complete CONTINUATION_DONE",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
  });

  await runClaudeHookDrivenSession(
    createCommand(),
    createInput(projectRoot, {
      async validate() {
        validationOrder.push("initial");
      },
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
          async validate() {
            validationOrder.push("continuation");
          },
        },
      ],
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(validationOrder, ["initial", "continuation"]);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Continue\u001b[201~\r",
  ]);
  assert.deepEqual(
    events.map((event) => `${event.type}:${event.phaseId}`),
    [
      "session-start:runabc123456:intent:attempt-1",
      "turn-completed:runabc123456:intent:attempt-1",
      "turn-completed:runabc123456:prd:attempt-1",
      "session-completed:undefined",
    ],
  );
});

test("Claude hook-driven runner submits repair prompts through PTY and reports repair usage", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  let validateCalls = 0;
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "initial marker INITIAL_DONE",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "repair marker REPAIR_DONE",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
  });

  const result = await runClaudeHookDrivenSession(
    createCommand(),
    createInput(projectRoot, {
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
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.equal(result.repairUsed, true);
  assert.equal(validateCalls, 2);
  assert.deepEqual(spawner.process.writes, ["\u001b[200~Repair\u001b[201~\r"]);
});

test("Claude hook-driven runner captures structured transcript events and preserves transcript failures", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-hooks-"));
  const transcript: Array<{ type: "provider" | "user"; content: string }> = [];
  const spawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Start",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Human answer",
      session_id: "claude-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "Question before marker INITIAL_DONE protocol tail",
      session_id: "claude-session-1",
    });
    spawner.process.emitExit(0);
  });

  await runClaudeHookDrivenSession(
    createCommand(),
    createInput(projectRoot, {
      transcript: {
        onProviderOutput(content) {
          transcript.push({ type: "provider", content });
        },
        onSubmittedUserMessage(content) {
          transcript.push({ type: "user", content });
        },
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(transcript, [
    { type: "user", content: "Start" },
    { type: "user", content: "Human answer" },
    {
      type: "provider",
      content: "Question before marker INITIAL_DONE protocol tail",
    },
  ]);

  const failingSpawner = new ScriptedClaudePtySpawner(async (options) => {
    const hookScriptPath = getHookScriptPath(projectRoot);

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      matcher: "startup",
      session_id: "claude-session-2",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Start",
      session_id: "claude-session-2",
    });
  });

  await assert.rejects(
    runClaudeHookDrivenSession(
      createCommand(),
      createInput(projectRoot, {
        transcript: {
          onSubmittedUserMessage() {
            throw new Error("transcript failed");
          },
        },
      }),
      {
        ptySpawner: failingSpawner,
        outputSink: { write() {} },
        firstEventTimeoutMs: 1_000,
      },
    ),
    (error) =>
      error instanceof ProviderSessionTranscriptCaptureError &&
      error.message.includes("transcript failed"),
  );
});
