import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  ProviderSessionEventCaptureError,
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
      },
      {
        type: "submitted-user-message",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "claude-session-1",
        source: "hooks",
        structured: true,
        exitCode: undefined,
        signal: undefined,
      },
      {
        type: "turn-completed",
        phaseId: "runabc123456:intent:attempt-1",
        providerSessionId: "claude-session-1",
        source: "hooks",
        structured: true,
        exitCode: undefined,
        signal: undefined,
      },
      {
        type: "session-completed",
        phaseId: undefined,
        providerSessionId: undefined,
        source: "hooks",
        structured: true,
        exitCode: 0,
        signal: null,
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
    const hookScriptPath = join(
      projectRoot,
      ".devflow",
      "runs",
      "runabc123456",
      ".claude-hooks",
      "hook.js",
    );

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
