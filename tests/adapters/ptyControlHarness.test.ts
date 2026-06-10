import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  startPtyControlHarness,
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
  type UserInput,
} from "../../src/adapters/ptyControlHarness.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly emitter = new EventEmitter();
  killed = false;
  killError: unknown;
  removedExitListeners = 0;

  onData(): void {}

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

  emitExit(exitCode: number, signal: NodeJS.Signals | null = null): void {
    this.emitter.emit("exit", { exitCode, signal });
  }
}

class FakePtySpawner implements PtySpawner {
  readonly process = new FakePtyProcess();
  readonly calls: Array<{
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

class FakeUserInput extends EventEmitter implements UserInput {
  readonly rawModeChanges: boolean[] = [];

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

  resume(): void {}

  pause(): void {}
}

function startHarness(spawner: FakePtySpawner, userInput?: UserInput) {
  return startPtyControlHarness(
    {
      provider: getBuiltInProviderIdentity("claude"),
      executable: "claude",
      args: [],
      cwd: "/tmp/devflow",
    },
    {},
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
      userInput,
    },
  );
}

test("PTY control harness shutdown writes a raw graceful command and resolves on natural exit", async () => {
  const spawner = new FakePtySpawner();
  const harness = startHarness(spawner);

  const shutdown = harness.shutdown({ command: "/exit\n", timeoutMs: 100 });
  spawner.process.emitExit(0);

  assert.deepEqual(await shutdown, { forced: false });
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
  assert.equal(spawner.process.killed, false);
});

test("PTY control harness shutdown force-kills when the graceful exit window expires", async () => {
  const spawner = new FakePtySpawner();
  const harness = startHarness(spawner);

  assert.deepEqual(await harness.shutdown({ command: "/exit\n", timeoutMs: 1 }), {
    forced: true,
  });
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
  assert.equal(spawner.process.killed, true);
});

test("PTY control harness shutdown resolves immediately after the PTY already exited", async () => {
  const spawner = new FakePtySpawner();
  const harness = startHarness(spawner);

  spawner.process.emitExit(0);

  assert.deepEqual(await harness.shutdown({ command: "/exit\n", timeoutMs: 1 }), {
    forced: false,
  });
  assert.deepEqual(spawner.process.writes, []);
  assert.equal(spawner.process.killed, false);
});

test("PTY control harness shutdown still observes exit after dispose restores terminal input", async () => {
  const spawner = new FakePtySpawner();
  const userInput = new FakeUserInput();
  const harness = startHarness(spawner, userInput);

  harness.dispose();
  const shutdown = harness.shutdown({ command: "/exit\n", timeoutMs: 100 });
  spawner.process.emitExit(0);

  assert.deepEqual(await shutdown, { forced: false });
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(spawner.process.removedExitListeners, 1);
  assert.equal(spawner.process.emitter.listenerCount("exit"), 1);
  assert.equal(spawner.process.killed, false);
});

test("PTY control harness shutdown surfaces kill errors", async () => {
  const spawner = new FakePtySpawner();
  const harness = startHarness(spawner);
  const killError = new Error("kill failed");
  spawner.process.killError = killError;

  await assert.rejects(
    harness.shutdown({ command: "/exit\n", timeoutMs: 1 }),
    (error: unknown) => error === killError,
  );
});
