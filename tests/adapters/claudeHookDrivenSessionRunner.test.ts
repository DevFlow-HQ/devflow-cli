import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  IncompleteProviderSessionError,
  ProviderSessionEventCaptureError,
  ProviderSessionTranscriptCaptureError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  runClaudeHookDrivenSession,
  type ClaudeHookDrivenSessionCommand,
} from "../../src/adapters/claudeHookDrivenSessionRunner.js";
import {
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
} from "../../src/adapters/ptyManagedSessionRunner.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
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
    ".claude-hooks",
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
    const hookScriptPath = join(
      projectRoot,
      ".devflow",
      "runs",
      "runabc123456",
      ".claude-hooks",
      "hook.js",
    );

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

  const result = await runClaudeHookDrivenSession(
    createCommand(),
    createInput(projectRoot, {
      async validate() {
        validateCount += 1;
      },
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

  const hookDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    "runabc123456",
    ".claude-hooks",
  );
  const settings = await fs.readJson(
    join(projectRoot, ".claude", "settings.local.json"),
  );

  assert.equal(await fs.pathExists(join(hookDirectory, "hook.js")), true);
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
          DEVFLOW_HOOK_IPC_PATH: join(hookDirectory, "hook.sock"),
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
  });
  assert.equal(validateCount, 1);
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
