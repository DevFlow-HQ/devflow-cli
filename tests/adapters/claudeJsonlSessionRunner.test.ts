import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import fs from "fs-extra";

import {
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  runClaudeJsonlSession,
  type ClaudeJsonlSessionCommand,
} from "../../src/adapters/claudeJsonlSessionRunner.js";
import type { SessionLogLocator } from "../../src/adapters/codexSessionLogLocator.js";
import {
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
} from "../../src/adapters/ptyManagedSessionRunner.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

class FakePtyProcess implements PtyProcess {
  readonly emitter = new EventEmitter();

  onData(listener: (data: string) => void): void {
    this.emitter.on("data", listener);
  }

  onExit(
    listener: (event: { exitCode: number; signal: NodeJS.Signals | null }) => void,
  ): void {
    this.emitter.on("exit", listener);
  }

  write(): void {}

  kill(): void {}

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
      void this.script(options);
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

function createCommand(): ClaudeJsonlSessionCommand {
  return {
    provider: getBuiltInProviderIdentity("claude"),
    executable: "claude",
    args: ["--model", "sonnet", "Start"],
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!(await fs.pathExists(path))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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
  });
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
