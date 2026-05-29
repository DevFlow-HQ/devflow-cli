import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "fs-extra";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  IncompleteProviderSessionError,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  runCodexHookDrivenSession,
  type CodexHookDrivenSessionCommand,
} from "../../src/adapters/codexHookDrivenSessionRunner.js";
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
  readonly forwarded: string[] = [];
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

function createCommand(): CodexHookDrivenSessionCommand {
  return {
    provider: getBuiltInProviderIdentity("codex"),
    executable: "codex",
    args: ["--model", "gpt-test", "Start"],
  };
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

test("Codex hook-driven runner writes per-run hook artifacts and completes a single phase from hook events", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  const output: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const hookScriptPath = join(String(options.env?.CODEX_HOME), "hook.js");

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
      providerSessionId: "codex-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Start",
      providerSessionId: "codex-session-1",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "done INITIAL_DONE",
      providerSessionId: "codex-session-1",
    });
    spawner.process.emitExit(0);
  });

  const result = await runCodexHookDrivenSession(
    createCommand(),
    createInput(projectRoot, {
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write: (chunk) => output.push(chunk) },
      terminal: { columns: 100, rows: 30 },
      firstEventTimeoutMs: 1_000,
    },
  );

  const codexHome = join(projectRoot, ".devflow", "runs", "runabc123456", ".codex");

  assert.equal(await fs.pathExists(join(codexHome, "config.toml")), true);
  assert.equal(await fs.pathExists(join(codexHome, "hook.js")), true);
  assert.deepEqual(spawner.calls, [
    {
      executable: "codex",
      args: ["--model", "gpt-test", "Start"],
      options: {
        cwd: projectRoot,
        cols: 100,
        rows: 30,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          DEVFLOW_HOOK_IPC_PATH: join(codexHome, "hook.sock"),
        },
      },
    },
  ]);
  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      phaseId: event.phaseId,
      providerSessionId: event.providerSessionId,
      source: event.source,
      structured: event.structured,
      origin:
        event.type === "submitted-user-message" ? event.origin : undefined,
    })),
    [
      {
        type: "session-start",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "codex-session-1",
        source: "hooks",
        structured: true,
        origin: undefined,
      },
      {
        type: "submitted-user-message",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "codex-session-1",
        source: "hooks",
        structured: true,
        origin: "managed",
      },
      {
        type: "turn-completed",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "codex-session-1",
        source: "hooks",
        structured: true,
        origin: undefined,
      },
      {
        type: "session-completed",
        phaseId: undefined,
        providerSessionId: undefined,
        source: "hooks",
        structured: true,
        origin: undefined,
      },
    ],
  );
  assert.deepEqual(output, []);
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
});

test("Codex hook-driven runner advances continuations and submits prompts through PTY control", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  const events: ManagedProviderSessionEvent[] = [];
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const hookScriptPath = join(String(options.env?.CODEX_HOME), "hook.js");

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "INITIAL_DONE",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Continue",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "CONTINUATION_DONE",
    });
    spawner.process.emitExit(0);
  });

  await runCodexHookDrivenSession(
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
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Continue\u001b[201~\r",
  ]);
  assert.deepEqual(
    events.map((event) =>
      event.type === "submitted-user-message"
        ? `${event.type}:${event.phaseId}:${event.origin}`
        : `${event.type}:${event.phaseId}`,
    ),
    [
      "session-start:runabc123456:intent:attempt-1",
      "turn-completed:runabc123456:intent:attempt-1",
      "submitted-user-message:runabc123456:prd:attempt-1:managed",
      "turn-completed:runabc123456:prd:attempt-1",
      "session-completed:undefined",
    ],
  );
});

test("Codex hook-driven runner keeps PTY control-only while mirroring output, stdin, and resize", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  const output: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];
  const userInput = new FakeUserInput();
  const terminal = new FakeTerminal(90, 25);
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const hookScriptPath = join(String(options.env?.CODEX_HOME), "hook.js");

    spawner.process.emitData("terminal marker INITIAL_DONE should not validate\n");
    userInput.emitData("hello\r");
    terminal.emitResize(120, 40);
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "INITIAL_DONE",
    });
    spawner.process.emitExit(0);
  });

  await runCodexHookDrivenSession(
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
      firstEventTimeoutMs: 1_000,
    },
  );

  assert.deepEqual(output, [
    "terminal marker INITIAL_DONE should not validate\n",
  ]);
  assert.deepEqual(spawner.process.writes, ["h", "e", "l", "l", "o", "\r"]);
  assert.deepEqual(spawner.process.resizes, [{ columns: 120, rows: 40 }]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["session-start", "turn-completed", "session-completed"],
  );
});

test("Codex hook-driven runner submits repair prompts and reports repair usage", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  let validateCalls = 0;
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const hookScriptPath = join(String(options.env?.CODEX_HOME), "hook.js");

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "INITIAL_DONE",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Repair",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "REPAIR_DONE",
    });
    spawner.process.emitExit(0);
  });

  const result = await runCodexHookDrivenSession(
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
  assert.deepEqual(spawner.process.writes, ["\u001b[200~Repair\u001b[201~\r"]);
});

test("Codex hook-driven runner treats PTY exit before SessionStart as incomplete hook setup", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  const spawner = new ScriptedCodexPtySpawner(async () => {
    spawner.process.emitExit(1);
  });

  await assert.rejects(
    runCodexHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
    }),
    (error) =>
      error instanceof IncompleteProviderSessionError &&
      /hook setup may have failed/i.test(error.message),
  );
});

test("Codex hook-driven runner treats PTY exit before final marker validation as incomplete", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const hookScriptPath = join(String(options.env?.CODEX_HOME), "hook.js");

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
    });
    spawner.process.emitExit(1);
  });

  await assert.rejects(
    runCodexHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
    }),
    IncompleteProviderSessionError,
  );
});

test("Codex hook-driven runner times out when no SessionStart hook arrives", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  const spawner = new ScriptedCodexPtySpawner(async () => {});

  await assert.rejects(
    runCodexHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 5,
    }),
    (error) =>
      error instanceof ProviderSessionEventCaptureError &&
      /SessionStart/i.test(error.message) &&
      /hook setup/i.test(error.message),
  );
});

test("Codex hook-driven runner raises cleanup errors when PTY does not exit after finalization", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const hookScriptPath = join(String(options.env?.CODEX_HOME), "hook.js");

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "Stop",
      last_assistant_message: "INITIAL_DONE",
    });
  });

  await assert.rejects(
    runCodexHookDrivenSession(createCommand(), createInput(projectRoot), {
      ptySpawner: spawner,
      outputSink: { write() {} },
      firstEventTimeoutMs: 1_000,
      cleanupTimeoutMs: 5,
    }),
    ProviderSessionCleanupError,
  );
});

test("Codex hook-driven runner maps hook payload and provider event failures to event capture errors", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-hooks-"));
  const spawner = new ScriptedCodexPtySpawner(async (options) => {
    const hookScriptPath = join(String(options.env?.CODEX_HOME), "hook.js");

    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "SessionStart",
    });
    await runHookScript(hookScriptPath, options.env ?? {}, {
      hook_event_name: "UserPromptSubmit",
      prompt: "Start",
    });
  });

  await assert.rejects(
    runCodexHookDrivenSession(
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
    ProviderSessionEventCaptureError,
  );
});
