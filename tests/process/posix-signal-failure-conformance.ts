import assert from "node:assert/strict";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  createProcessAdapter,
  type ProcessAdapter,
} from "../../src/process/process.js";
import {
  removeTempDir,
  stage,
  withRunnerObserver,
  withTimeout,
} from "../helpers/standalone.js";
import type { RunnerCase } from "../helpers/scenario-runner.js";
import { makeTempDir } from "../helpers/tempDir.js";

export function registerPosixSignalFailureCases(
  register: (test: RunnerCase) => void,
): void {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  register({
    name: "POSIX failed signal releases creator event-loop ownership",
    body: signalFailure,
  });
}

async function signalFailure(): Promise<void> {
  const folder = makeTempDir("secant-signal-failure-");
  const spawned = join(folder, "spawned");
  const ready = join(folder, "ready");
  const start = join(folder, "start");
  const release = join(folder, "release");
  const observer = withRunnerObserver();
  const adapter = createProcessAdapter(observer);
  const targetSource = `
    const { closeSync, watch, existsSync, writeFileSync, renameSync } = require('node:fs');
    for (const fd of [0, 1, 2]) closeSync(fd);
    const leave = () => { if (existsSync(${JSON.stringify(release)})) process.exit(17); };
    watch(${JSON.stringify(folder)}, leave);
    writeFileSync(${JSON.stringify(ready + ".tmp")}, 'ready');
    renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
    leave();
  `;
  const creatorSource = `
    import assert from 'node:assert/strict';
    import { watch, existsSync, writeFileSync, renameSync } from 'node:fs';
    import { createProcessAdapter } from ${JSON.stringify(new URL("../../src/process/process.ts", import.meta.url).href)};
    import { withRunnerObserver, withTimeout } from ${JSON.stringify(new URL("../helpers/standalone.ts", import.meta.url).href)};
    const denial = Object.assign(new Error('fixture group signal denied'), { code: 'EPERM' });
    const adapter = createProcessAdapter(withRunnerObserver({
      testPosixSignalGroup() { throw denial; },
      observeChild(fact) {
        if (fact.kind === 'spawn') {
          writeFileSync(${JSON.stringify(spawned + ".tmp")}, String(fact.pid));
          renameSync(${JSON.stringify(spawned + ".tmp")}, ${JSON.stringify(spawned)});
        }
      },
    }));
    const launched = await adapter.spawnOwnedProcess({
      role: 'harness-runtime', executable: process.execPath,
      args: ['-e', ${JSON.stringify(targetSource)}], cwd: process.cwd(),
      env: process.env, launchTimeoutMs: 5000,
    });
    assert.ok(launched.ok);
    const child = launched.process;
    await Promise.all([child.stdout, child.stderr].map(async stream => {
      for await (const chunk of stream) assert.equal(chunk.byteLength, 0);
    }));
    await withTimeout(new Promise(done => {
      const check = () => {
        if (existsSync(${JSON.stringify(start)})) { watcher.close(); done(); }
      };
      const watcher = watch(${JSON.stringify(folder)}, check);
      check();
    }), 5000, 'parent did not release signal test');
    const interruption = await withTimeout(child.interrupt(100), 1000, 'signal failure did not settle');
    assert.deepEqual(interruption, {
      close: { kind: 'cleanup-error', cause: denial }, escalated: true,
    });
    assert.deepEqual(await child.closed(), { kind: 'cleanup-error', cause: denial });
    // Return naturally. Explicit process.exit would hide a referenced reaper leak.
  `;
  const launched = await adapter.spawnOwnedProcess({
    role: "command",
    executable: process.execPath,
    args: ["-e", creatorSource],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  });
  assert.ok(launched.ok);
  const creator = launched.process;
  const output = Promise.all([creator.stdout, creator.stderr].map(collect));
  let targetPid: number | undefined;
  try {
    await waitForFile(folder, spawned);
    const pid = Number(readFileSync(spawned, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    targetPid = pid;
    observer.observeChild?.({
      kind: "spawn",
      role: "harness-runtime",
      pid,
    });
    await waitForFile(folder, ready);
    assert.equal(isDead(adapter, pid), false);
    writeFileSync(start, "start");
    await stage("creator exits naturally after failed cleanup", async () => {
      assert.deepEqual(
        await withTimeout(
          creator.closed(),
          5000,
          "failed cleanup kept creator alive",
        ),
        { kind: "exited", status: 0 },
      );
      assert.deepEqual(await output, ["", ""]);
      assert.equal(isDead(adapter, pid), false);
    });
  } finally {
    // The target has its own release handle, including after creator exit.
    // Settle its supervisor fact only after independently observing death.
    writeFileSync(start, "start");
    writeFileSync(release, "release");
    if (targetPid !== undefined) {
      const pid = targetPid;
      await withTimeout(
        (async () => {
          while (!isDead(adapter, pid)) await setImmediate();
        })(),
        5000,
        "denied-signal target did not release",
      );
      observer.observeChild?.({
        kind: "exit",
        role: "harness-runtime",
        pid,
        elapsedMs: 0,
      });
    }
    await creator.interrupt(100);
    await output;
    await removeTempDir(folder);
  }
}

function isDead(adapter: ProcessAdapter, pid: number): boolean {
  const result = adapter.spawnCommandSync({
    role: "command",
    executable: "/bin/ps",
    args: ["-p", String(pid), "-o", "stat="],
    cwd: process.cwd(),
    env: process.env,
    maxBufferBytes: 1024,
  });
  assert.ok(result.kind === "exited");
  assert.ok(result.status === 0 || result.status === 1);
  return (
    result.status === 1 ||
    new TextDecoder().decode(result.stdout).trim().startsWith("Z")
  );
}

function waitForFile(folder: string, file: string): Promise<void> {
  let watcher: ReturnType<typeof watch> | undefined;
  return withTimeout(
    new Promise<void>((resolve) => {
      const check = () => {
        if (existsSync(file)) resolve();
      };
      watcher = watch(folder, check);
      check();
    }),
    5000,
    "signal-failure fixture did not become ready",
  ).finally(() => watcher?.close());
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream)
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}
