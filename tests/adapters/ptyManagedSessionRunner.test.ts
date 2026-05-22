import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  IncompleteProviderSessionError,
  ProviderSessionCleanupError,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  runPtyManagedSession,
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
} from "../../src/adapters/ptyManagedSessionRunner.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly emitter = new EventEmitter();
  killed = false;
  isAlive = true;

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
    this.isAlive = false;
  }

  emitData(data: string): void {
    this.emitter.emit("data", data);
  }

  emitExit(exitCode: number, signal: NodeJS.Signals | null = null): void {
    this.isAlive = false;
    this.emitter.emit("exit", { exitCode, signal });
  }
}

class FakePtySpawner implements PtySpawner {
  readonly process = new FakePtyProcess();
  calls: Array<{
    executable: string;
    args: string[];
    options: PtySpawnOptions;
  }> = [];

  spawn(
    executable: string,
    args: string[],
    options: PtySpawnOptions,
  ): PtyProcess {
    this.calls.push({ executable, args, options });
    return this.process;
  }
}

function createInput(
  overrides: Partial<ManagedProviderSessionInput> = {},
): ManagedProviderSessionInput {
  return {
    workingDirectory: "/tmp/devflow",
    initialPrompt: "Ship the artifact",
    initialCompletionMarker: "DEVFLOW_DONE",
    async validate() {},
    ...overrides,
  };
}

test("PTY managed-session runner mirrors raw output and validates after an ANSI-stripped completion marker", async () => {
  const spawner = new FakePtySpawner();
  const output: string[] = [];
  const validationStates: boolean[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: ["--ask-for-approval", "never"],
      cleanupCommand: "/exit\n",
    },
    createInput({
      async validate() {
        validationStates.push(spawner.process.isAlive);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write: (chunk) => output.push(chunk) },
      terminal: { columns: 132, rows: 43 },
    },
  );

  spawner.process.emitData("\u001b[32mworking\u001b[0m\n");
  spawner.process.emitData("DEVFLOW_\u001b[31mDONE\u001b[0m\n");

  const result = await runPromise;

  assert.deepEqual(spawner.calls, [
    {
      executable: "codex",
      args: ["--ask-for-approval", "never"],
      options: {
        cwd: "/tmp/devflow",
        cols: 132,
        rows: 43,
      },
    },
  ]);
  assert.deepEqual(output, [
    "\u001b[32mworking\u001b[0m\n",
    "DEVFLOW_\u001b[31mDONE\u001b[0m\n",
  ]);
  assert.deepEqual(validationStates, [true]);
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
});

test("PTY managed-session runner detects markers inside the bounded rolling buffer", async () => {
  const spawner = new FakePtySpawner();
  let validated = false;

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
      markerBufferLimit: 16,
    },
    createInput({
      initialCompletionMarker: "DONE",
      async validate() {
        validated = true;
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("x".repeat(32));
  assert.equal(validated, false);

  spawner.process.emitData("DO");
  assert.equal(validated, false);

  spawner.process.emitData("NE");
  const result = await runPromise;

  assert.equal(validated, true);
  assert.equal(result.repairUsed, false);
  assert.equal(spawner.calls[0]?.options.cols, 80);
  assert.equal(spawner.calls[0]?.options.rows, 24);
});

test("PTY managed-session runner reports incomplete sessions before marker detection", async () => {
  const spawner = new FakePtySpawner();

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput(),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("still working\n");
  spawner.process.emitExit(1);

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof IncompleteProviderSessionError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.completionMarker, "DEVFLOW_DONE");
    assert.equal(error.exitCode, 1);
    return true;
  });
});

test("PTY managed-session runner surfaces cleanup failures after valid output", async () => {
  const spawner = new FakePtySpawner();
  const cleanupFailure = new Error("write failed");
  spawner.process.write = () => {
    throw cleanupFailure;
  };

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput(),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("DEVFLOW_DONE\n");

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof ProviderSessionCleanupError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.cause, cleanupFailure);
    return true;
  });
});
