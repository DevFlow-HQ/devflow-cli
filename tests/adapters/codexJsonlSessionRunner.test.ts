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
  runCodexJsonlSession,
  type CodexJsonlSessionCommand,
} from "../../src/adapters/codexJsonlSessionRunner.js";
import {
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
} from "../../src/adapters/ptyManagedSessionRunner.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly emitter = new EventEmitter();

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
