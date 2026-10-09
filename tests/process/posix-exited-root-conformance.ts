import assert from "node:assert/strict";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createProcessAdapter,
  type ChildFact,
  type OwnedProcess,
  type ProcessAdapter,
} from "../../src/process/process.js";
import {
  stage,
  withRunnerObserver,
  withTimeout,
} from "../helpers/standalone.js";
import type { RunnerCase } from "../helpers/scenario-runner.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createLifetimeControl } from "../helpers/lifetime-control.js";

type CleanupPath = "timeout" | "cancellation" | "interrupt" | "shutdown";
type RootExit = "status" | "signal";
const cleanupPaths: readonly CleanupPath[] = [
  "timeout",
  "cancellation",
  "interrupt",
  "shutdown",
];

/** Real inherited pipes belong in the supervised runner, never bun test. */
export function registerPosixExitedRootCases(
  register: (test: RunnerCase) => void,
): void {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  register({
    name: "POSIX exited-root output abandonment",
    body: () => failedPipeCleanup("output-abandon"),
  });
  register({
    name: "POSIX exited-root foreign reaper",
    body: () => failedPipeCleanup("foreign-reaper"),
  });
  register({
    name: "POSIX retired numeric group identity",
    body: retiredGroupIdentity,
  });
  if (process.platform === "linux") {
    register({
      name: "POSIX forced-waiter live-root closed-stdio",
      body: forcedWaiterClosedStdio,
    });
  }
  register({ name: "POSIX live-root closed-stdio", body: closedStdioRoot });
  register({
    name: "POSIX live-root cancellation and outside signal",
    body: liveRootStops,
  });
  register({
    name: "POSIX exited-root escaped pipe holder",
    body: escapedPipeHolder,
  });
  register({
    name: "POSIX exited-root descendant cleanup",
    body: async () => {
      for (const path of cleanupPaths) {
        for (const rootExit of ["status", "signal"] as const) {
          await stage(`${path} after native root ${rootExit}`, () =>
            exitedRootCleanup({ path, rootExit, ignoresTerm: false }),
          );
        }
      }
    },
  });
  register({
    name: "m10-audit-runtime-failure-causes: exited-root readiness without watcher capacity",
    body: () =>
      exitedRootCleanup({
        path: "interrupt",
        rootExit: "status",
        ignoresTerm: true,
        refuseWatch: true,
      }),
  });
  register({
    name: "m10-audit-runtime-failure-causes: zero cleanup budget cannot confirm unread pipe drain",
    body: zeroBudgetDrain,
  });
  // Command escalation retains its existing three-second grace. Each path gets
  // its own scenario so both native outcomes fit the supervisor's 20s bound.
  for (const path of cleanupPaths) {
    register({
      name: `POSIX exited-root forced descendant cleanup ${path}`,
      body: async () => {
        for (const rootExit of ["status", "signal"] as const) {
          await stage(
            `${path} forces descendant after native root ${rootExit}`,
            () => exitedRootCleanup({ path, rootExit, ignoresTerm: true }),
          );
        }
      },
    });
  }
}

async function zeroBudgetDrain(): Promise<void> {
  let pid: number | undefined;
  const reaped = Promise.withResolvers<ChildFact>();
  const adapter = createProcessAdapter(
    withRunnerObserver({
      observeChild: (fact) => {
        if (fact.kind === "reap") reaped.resolve(fact);
        if (fact.kind === "spawn") pid = fact.pid;
      },
    }),
  );
  const launched = await adapter.spawnOwnedProcess({
    role: "harness-runtime",
    executable: process.execPath,
    args: [
      "-e",
      // Keep the root live until SIGKILL, so Darwin's zombie-only group refusal
      // cannot replace the zero-budget drain failure this case exercises. Ready
      // is reported only after a stdout byte reached the kernel, and stdout is
      // never read: bytes left in the child's own buffer would die with it.
      "process.on('SIGTERM',()=>{});process.stdout.write('x',()=>process.stderr.write('ready'));setInterval(()=>{},1000);",
    ],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  });
  assert.ok(launched.ok);
  assert.ok(pid !== undefined);
  const child = launched.process;
  try {
    // Readiness reads stderr only. One read may take every buffered byte, so
    // reading stdout could leave nothing unread; unread stdout prevents a drain claim.
    const ready = await child.stderr[Symbol.asyncIterator]().next();
    assert.ok(!ready.done);
    assert.equal(Buffer.from(ready.value).toString(), "ready");
    assert.deepEqual(await child.closeStdin(0), { kind: "cleanup-timeout" });
    const close = await child.closed();
    assert.equal(close.kind, "cleanup-error");
    if (close.kind !== "cleanup-error")
      throw new Error("expected failed drain");
    assert.ok(close.cause instanceof Error);
    assert.match(close.cause.message, /POSIX stdin cleanup timeout/);
    await waitForDeath(adapter, pid, "zero-budget child survived cleanup");
    const terminal = await withTimeout(
      reaped.promise,
      5000,
      "zero-budget root was not reaped",
    );
    assert.ok(terminal.kind === "reap");
    assert.equal(terminal.signal, "SIGKILL");
  } finally {
    await child.interrupt(100);
  }
}

async function exitedRootCleanup(options: {
  readonly path: CleanupPath;
  readonly rootExit: RootExit;
  readonly ignoresTerm: boolean;
  readonly refuseWatch?: boolean;
}): Promise<void> {
  const { path, rootExit, ignoresTerm } = options;
  const control = await createLifetimeControl();
  const facts: ChildFact[] = [];
  let rootPid: number | undefined;
  const adapter = createProcessAdapter(
    withRunnerObserver({
      observeChild(fact) {
        facts.push(fact);
        if (fact.kind === "spawn") rootPid ??= fact.pid;
      },
    }),
  );
  const refuseWatch = options.refuseWatch
    ? "require('node:fs').watch = () => { throw Object.assign(new Error('fixture watcher quota exhausted'), { code: 'EMFILE' }); };"
    : "";
  const descendant = `
    ${refuseWatch}
    ${ignoresTerm ? "process.on('SIGTERM', () => {});" : ""}
    process.stdout.write('out');
    process.stderr.write('err');
    ${control.source("descendant", "process.exit(0);")}
  `;
  const source = `
    ${refuseWatch}
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
      { stdio: ['ignore', 'inherit', 'inherit'] });
    ${control.source("root", rootExit === "status" ? "process.exit(17);" : "process.kill(process.pid, 'SIGTERM');")}
  `;
  const controller = new AbortController();
  let owned: OwnedProcess | undefined;
  let stdout: Promise<string> | undefined;
  let stderr: Promise<string> | undefined;
  const pending =
    path === "timeout" || path === "cancellation"
      ? adapter.spawnCommand({
          role: "command",
          executable: process.execPath,
          args: ["-e", source],
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: path === "timeout" ? 1000 : 5000,
          cancelSignal: controller.signal,
          maxCaptureBytes: 1024,
          truncationMarker: "[truncated]",
        })
      : undefined;
  try {
    if (pending === undefined) {
      const launched = await adapter.spawnOwnedProcess({
        role: "harness-runtime",
        executable: process.execPath,
        args: ["-e", source],
        cwd: process.cwd(),
        env: process.env,
        launchTimeoutMs: 5000,
      });
      assert.ok(launched.ok);
      owned = launched.process;
      stdout = collect(owned.stdout);
      stderr = collect(owned.stderr);
    }
    const descendant = await withTimeout(
      control.ready("descendant"),
      5000,
      "descendant did not become ready",
    );
    const descendantPid = descendant.pid;
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.ok(rootPid !== undefined);
    (await control.ready("root")).release();
    await waitForDeath(adapter, rootPid, "root did not exit");
    assert.equal(isDead(adapter, descendantPid), false);
    assert.equal(
      facts.some(
        (fact) =>
          (fact.kind === "exit" || fact.kind === "reap") &&
          fact.pid === rootPid,
      ),
      false,
    );
    if (path === "cancellation") controller.abort();
    const expected =
      rootExit === "status"
        ? ({ kind: "exited", status: 17 } as const)
        : ({ kind: "signal", signal: "SIGTERM" } as const);
    if (pending !== undefined) {
      assert.deepEqual(
        await withTimeout(
          pending,
          5000,
          "Command did not settle after root exit",
        ),
        rootExit === "status"
          ? { kind: "exited", status: 17, text: Buffer.from("outerr") }
          : { kind: "signal" },
      );
    } else {
      assert.ok(owned !== undefined);
      if (path === "interrupt") {
        const interruption = owned.interrupt(100);
        assert.equal(owned.interrupt(100), interruption);
        assert.deepEqual(await interruption, {
          close: expected,
          escalated: ignoresTerm,
        });
      } else {
        const closing = owned.closeStdin(100);
        assert.equal(owned.closeStdin(100), closing);
        assert.deepEqual(await closing, expected);
      }
      assert.deepEqual(await owned.closed(), expected);
      assert.deepEqual(await Promise.all([stdout, stderr]), ["out", "err"]);
      const settledFacts = facts.length;
      await owned.interrupt(100);
      await owned.closeStdin(100);
      assert.equal(facts.length, settledFacts);
    }
    await waitForDeath(adapter, descendantPid, "descendant survived cleanup");
    const lifecycle = facts.filter(
      (fact) => "pid" in fact && fact.pid === rootPid,
    );
    assert.deepEqual(
      lifecycle.map((fact) => fact.kind),
      [
        "spawn",
        path === "timeout" || path === "shutdown" ? "timeout" : "cancellation",
        ...(ignoresTerm ? ["kill-escalation"] : []),
        "reap",
      ],
    );
    const terminal = lifecycle.at(-1);
    assert.ok(terminal?.kind === "reap");
    assert.equal(terminal.status, rootExit === "status" ? 17 : undefined);
    assert.equal(
      terminal.signal,
      rootExit === "signal" ? "SIGTERM" : undefined,
    );
  } finally {
    // Release through the descendant's own handle, even if it has escaped the
    // group. Never signal remembered numeric identities after native settlement.
    await control.close();
    controller.abort();
    if (owned !== undefined) await owned.interrupt(100);
    if (pending !== undefined)
      await withTimeout(pending, 5000, "fixture cleanup did not settle");
    await Promise.all([stdout, stderr]);
  }
}

function isDead(adapter: ProcessAdapter, pid: number): boolean {
  // A terminated orphan may remain a zombie under a container's PID 1. The
  // retained native root is also a zombie until its inherited pipes drain.
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

async function waitForDeath(
  adapter: ProcessAdapter,
  pid: number,
  message: string,
): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!isDead(adapter, pid)) {
    assert.ok(performance.now() < deadline, message);
    await setImmediate();
  }
}

function waitForFile(folder: string, file: string): Promise<void> {
  let watcher: ReturnType<typeof watch> | undefined;
  return withTimeout(
    new Promise<void>((resolve) => {
      watcher = watch(folder, () => {
        if (existsSync(file)) resolve();
      });
      if (existsSync(file)) resolve();
    }),
    5000,
    "descendant did not become ready",
  ).finally(() => watcher?.close());
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream)
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

async function closedStdioRoot(): Promise<void> {
  const folder = makeTempDir("secant-closed-stdio-");
  const ready = join(folder, "ready");
  const release = join(folder, "release");
  const facts: ChildFact[] = [];
  const listeners = process.listenerCount("SIGCHLD");
  const adapter = createProcessAdapter(
    withRunnerObserver({ observeChild: (fact) => facts.push(fact) }),
  );
  const launched = await adapter.spawnOwnedProcess({
    role: "harness-runtime",
    executable: process.execPath,
    args: [
      "-e",
      `
      const { closeSync, watch, existsSync, writeFileSync, renameSync } = require('node:fs');
      for (const fd of [0, 1, 2]) closeSync(fd);
      const release = ${JSON.stringify(release)};
      const leave = () => { if (existsSync(release)) process.exit(17); };
      watch(${JSON.stringify(folder)}, leave);
      writeFileSync(${JSON.stringify(ready + ".tmp")}, String(process.pid));
    renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
      leave();
    `,
    ],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  });
  assert.ok(launched.ok);
  const child = launched.process;
  try {
    await waitForFile(folder, ready);
    assert.deepEqual(
      await Promise.all([collect(child.stdout), collect(child.stderr)]),
      ["", ""],
    );
    assert.equal(isDead(adapter, Number(readFileSync(ready, "utf8"))), false);
    assert.deepEqual(
      facts
        .filter((fact) => fact.role === "harness-runtime")
        .map((fact) => fact.kind),
      ["spawn"],
    );
    writeFileSync(release, "release");
    assert.deepEqual(
      await withTimeout(
        child.closed(),
        5000,
        "closed-stdio root did not settle",
      ),
      { kind: "exited", status: 17 },
    );
    const lifecycle = facts.filter((fact) => fact.role === "harness-runtime");
    assert.deepEqual(
      lifecycle.map((fact) => fact.kind),
      ["spawn", "exit"],
    );
    const terminal = lifecycle.at(-1);
    assert.ok(terminal?.kind === "exit");
    assert.equal(terminal.status, 17);
    assert.equal(terminal.signal, undefined);
    assert.equal(process.listenerCount("SIGCHLD"), listeners);
  } finally {
    writeFileSync(release, "release");
    await child.interrupt(100);
  }
}

async function liveRootStops(): Promise<void> {
  for (const stop of ["cancellation", "outside-signal"] as const) {
    await stage(`live root ${stop}`, async () => {
      const folder = makeTempDir("secant-live-stop-");
      const ready = join(folder, "ready");
      const release = join(folder, "release");
      const facts: ChildFact[] = [];
      const adapter = createProcessAdapter(
        withRunnerObserver({ observeChild: (fact) => facts.push(fact) }),
      );
      const controller = new AbortController();
      const pending = adapter.spawnCommand({
        role: "command",
        executable: process.execPath,
        args: [
          "-e",
          `
          const { watch, existsSync, writeFileSync, renameSync } = require('node:fs');
          const leave = () => { if (existsSync(${JSON.stringify(release)})) process.kill(process.pid, 'SIGTERM'); };
          watch(${JSON.stringify(folder)}, leave);
          writeFileSync(${JSON.stringify(ready + ".tmp")}, String(process.pid));
    renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
          leave();
        `,
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5000,
        cancelSignal: controller.signal,
        maxCaptureBytes: 1024,
        truncationMarker: "[truncated]",
      });
      try {
        await waitForFile(folder, ready);
        const pid = Number(readFileSync(ready, "utf8"));
        assert.equal(isDead(adapter, pid), false);
        if (stop === "cancellation") controller.abort();
        else writeFileSync(release, "release");
        assert.deepEqual(
          await withTimeout(pending, 5000, "live root did not settle"),
          stop === "cancellation" ? { kind: "cancelled" } : { kind: "signal" },
        );
        const lifecycle = facts.filter(
          (fact) => "pid" in fact && fact.pid === pid,
        );
        assert.deepEqual(
          lifecycle.map((fact) => fact.kind),
          stop === "cancellation"
            ? ["spawn", "cancellation", "reap"]
            : ["spawn", "exit"],
        );
        const terminal = lifecycle.at(-1);
        assert.ok(terminal?.kind === "reap" || terminal?.kind === "exit");
        assert.equal(terminal.status, undefined);
        assert.equal(terminal.signal, "SIGTERM");
        await waitForDeath(adapter, pid, "live root survived stop");
      } finally {
        writeFileSync(release, "release");
        controller.abort();
        await withTimeout(pending, 5000, "live root cleanup did not settle");
      }
    });
  }
}

async function escapedPipeHolder(): Promise<void> {
  const folder = makeTempDir("secant-escaped-holder-");
  const ready = join(folder, "ready");
  const release = join(folder, "release");
  const leave = join(folder, "exit");
  const facts: ChildFact[] = [];
  let rootPid: number | undefined;
  const adapter = createProcessAdapter(
    withRunnerObserver({
      observeChild(fact) {
        facts.push(fact);
        if (fact.kind === "spawn") rootPid ??= fact.pid;
      },
    }),
  );
  const descendant = `
    const { watch, existsSync, writeFileSync, renameSync } = require('node:fs');
    const leave = () => { if (existsSync(${JSON.stringify(release)})) process.exit(0); };
    watch(${JSON.stringify(folder)}, leave);
    process.stdout.write('escaped-out');
    process.stderr.write('escaped-err');
    writeFileSync(${JSON.stringify(ready + ".tmp")}, String(process.pid));
    renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
    leave();
  `;
  const launched = await adapter.spawnOwnedProcess({
    role: "harness-runtime",
    executable: process.execPath,
    args: [
      "-e",
      `
      const { spawn } = require('node:child_process');
      const { watch, existsSync } = require('node:fs');
      const leave = () => { if (existsSync(${JSON.stringify(leave)})) process.exit(17); };
      watch(${JSON.stringify(folder)}, leave);
      spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
        { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      leave();
    `,
    ],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  });
  assert.ok(launched.ok);
  const child = launched.process;
  try {
    await waitForFile(folder, ready);
    const descendantPid = Number(readFileSync(ready, "utf8"));
    assert.equal(await readPrefix(child.stdout, 11), "escaped-out");
    assert.equal(await readPrefix(child.stderr, 11), "escaped-err");
    assert.ok(rootPid !== undefined);
    writeFileSync(leave, "exit");
    await waitForDeath(adapter, rootPid, "escaped holder root did not exit");
    const interruption = await child.interrupt(100);
    if (process.platform === "darwin") {
      // XNU killpg1 skips SZOMB group members, then returns EPERM when the
      // retained root is the group's only member. The escaped holder survives.
      // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c
      assert.equal(interruption.escalated, true);
      assert.equal(interruption.close.kind, "cleanup-error");
      assert.ok(interruption.close.kind === "cleanup-error");
      assert.ok(interruption.close.cause instanceof Error);
      assert.ok("code" in interruption.close.cause);
      assert.equal(interruption.close.cause.code, "EPERM");
      assert.ok("syscall" in interruption.close.cause);
      assert.equal(interruption.close.cause.syscall, "kill");
    } else {
      assert.deepEqual(interruption, {
        close: { kind: "cleanup-timeout" },
        escalated: true,
      });
    }
    const close = await child.closed();
    assert.equal(close.kind, "cleanup-error");
    assert.ok(close.kind === "cleanup-error" && close.cause instanceof Error);
    assert.equal(isDead(adapter, descendantPid), false);
    const afterAbandon = facts.length;
    await child.interrupt(100);
    await child.closeStdin(100);
    assert.equal(facts.length, afterAbandon);
    assert.equal(isDead(adapter, descendantPid), false);
    writeFileSync(release, "release");
    await waitForDeath(
      adapter,
      descendantPid,
      "escaped holder ignored release",
    );
  } finally {
    writeFileSync(release, "release");
    writeFileSync(leave, "exit");
    await child.interrupt(100);
  }
}

async function forcedWaiterClosedStdio(): Promise<void> {
  const adapter = createProcessAdapter(withRunnerObserver());
  const launched = await adapter.spawnOwnedProcess({
    role: "command",
    executable: process.execPath,
    args: [
      "-e",
      `
      import { registerPosixExitedRootCases } from ${JSON.stringify(fileURLToPath(import.meta.url))};
      const cases = [];
      registerPosixExitedRootCases((test) => cases.push(test));
      await cases.find((test) => test.name === 'POSIX live-root closed-stdio').body();
    `,
    ],
    cwd: process.cwd(),
    env: { ...process.env, BUN_FEATURE_FLAG_FORCE_WAITER_THREAD: "1" },
    launchTimeoutMs: 5000,
  });
  assert.ok(launched.ok);
  const child = launched.process;
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  try {
    assert.deepEqual(
      await withTimeout(
        child.closed(),
        5000,
        "forced-waiter qualification did not exit",
      ),
      { kind: "exited", status: 0 },
    );
    assert.deepEqual(await Promise.all([stdout, stderr]), ["", ""]);
  } finally {
    await child.interrupt(100);
  }
}

async function retiredGroupIdentity(): Promise<void> {
  const folder = makeTempDir("secant-retired-group-");
  const rootReady = join(folder, "root-ready");
  const rootRelease = join(folder, "root-release");
  const unrelatedReady = join(folder, "unrelated-ready");
  const unrelatedRelease = join(folder, "unrelated-release");
  const listeners = process.listenerCount("SIGCHLD");
  const numericGroups = new Map<number, number>();
  const originalSignals: { pid: number; signal: "SIGTERM" | "SIGKILL" }[] = [];
  const recycledSignals: { pid: number; signal: "SIGTERM" | "SIGKILL" }[] = [];
  const adapter = createProcessAdapter(
    withRunnerObserver({
      testPosixSignalGroup(pid, signal) {
        const recycled = numericGroups.get(pid);
        if (recycled !== undefined) {
          recycledSignals.push({ pid: recycled, signal });
          return;
        }
        originalSignals.push({ pid, signal });
        process.kill(-pid, signal);
      },
    }),
  );
  const unrelatedAdapter = createProcessAdapter(withRunnerObserver());
  const start = async (
    processAdapter: ProcessAdapter,
    ready: string,
    release: string,
  ): Promise<OwnedProcess> => {
    const launched = await processAdapter.spawnOwnedProcess({
      role: "harness-runtime",
      executable: process.execPath,
      args: [
        "-e",
        `
        const { watch, existsSync, writeFileSync, renameSync } = require('node:fs');
        const leave = () => { if (existsSync(${JSON.stringify(release)})) process.exit(17); };
        watch(${JSON.stringify(folder)}, leave);
        writeFileSync(${JSON.stringify(ready + ".tmp")}, String(process.pid));
        renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
        leave();
      `,
      ],
      cwd: process.cwd(),
      env: process.env,
      launchTimeoutMs: 5000,
    });
    assert.ok(launched.ok);
    return launched.process;
  };
  let root: OwnedProcess | undefined;
  let unrelated: OwnedProcess | undefined;
  const outputs: Promise<string>[] = [];
  try {
    root = await start(adapter, rootReady, rootRelease);
    outputs.push(collect(root.stdout), collect(root.stderr));
    unrelated = await start(unrelatedAdapter, unrelatedReady, unrelatedRelease);
    outputs.push(collect(unrelated.stdout), collect(unrelated.stderr));
    await Promise.all([
      waitForFile(folder, rootReady),
      waitForFile(folder, unrelatedReady),
    ]);
    const rootPid = Number(readFileSync(rootReady, "utf8"));
    const unrelatedPid = Number(readFileSync(unrelatedReady, "utf8"));
    assert.equal(isDead(unrelatedAdapter, unrelatedPid), false);
    assert.deepEqual(await root.interrupt(100), {
      close: { kind: "signal", signal: "SIGTERM" },
      escalated: false,
    });
    assert.deepEqual(await root.closed(), {
      kind: "signal",
      signal: "SIGTERM",
    });
    assert.deepEqual(originalSignals, [{ pid: rootPid, signal: "SIGTERM" }]);
    // Deterministically reuse the retired numeric identity through the private
    // signal seam. Any late signal would now target this unrelated live group.
    numericGroups.set(rootPid, unrelatedPid);
    await root.interrupt(100);
    await root.closeStdin(100);
    await root.interrupt(100);
    assert.deepEqual(recycledSignals, []);
    assert.equal(isDead(unrelatedAdapter, unrelatedPid), false);
    writeFileSync(unrelatedRelease, "release");
    assert.deepEqual(await unrelated.closed(), { kind: "exited", status: 17 });
    assert.deepEqual(await Promise.all(outputs), ["", "", "", ""]);
    assert.equal(process.listenerCount("SIGCHLD"), listeners);
  } finally {
    writeFileSync(rootRelease, "release");
    writeFileSync(unrelatedRelease, "release");
    if (root !== undefined) await root.interrupt(100);
    if (unrelated !== undefined) await unrelated.interrupt(100);
    await Promise.all(outputs);
  }
}

async function readPrefix(
  stream: AsyncIterable<Uint8Array>,
  length: number,
): Promise<string> {
  return readIteratorPrefix(stream[Symbol.asyncIterator](), length);
}

async function readIteratorPrefix(
  iterator: AsyncIterator<Uint8Array>,
  length: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < length) {
    const chunk = await iterator.next();
    assert.ok(!chunk.done);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

async function failedPipeCleanup(
  mode: "output-abandon" | "foreign-reaper",
): Promise<void> {
  const folder = makeTempDir("secant-pipe-failure-");
  const ready = join(folder, "ready");
  const leave = join(folder, "exit");
  const release = join(folder, "release");
  const listeners = process.listenerCount("SIGCHLD");
  const facts: ChildFact[] = [];
  const signals: { pid: number; signal: "SIGTERM" | "SIGKILL" }[] = [];
  let rootPid: number | undefined;
  const adapter = createProcessAdapter(
    withRunnerObserver({
      observeChild(fact) {
        facts.push(fact);
        if (fact.kind === "spawn") rootPid ??= fact.pid;
      },
      testPosixSignalGroup(pid, signal) {
        signals.push({ pid, signal });
        process.kill(-pid, signal);
      },
    }),
  );
  const descendant = `
    const { watch, existsSync, writeFileSync, renameSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    const leave = () => { if (existsSync(${JSON.stringify(release)})) process.exit(0); };
    watch(${JSON.stringify(folder)}, leave);
    process.stdout.write('out');
    process.stderr.write('err');
    writeFileSync(${JSON.stringify(ready + ".tmp")}, String(process.pid));
    renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
    leave();
  `;
  const launched = await adapter.spawnOwnedProcess({
    role: "harness-runtime",
    executable: process.execPath,
    args: [
      "-e",
      `
      const { spawn } = require('node:child_process');
      const { watch, existsSync } = require('node:fs');
      const leave = () => { if (existsSync(${JSON.stringify(leave)})) process.exit(17); };
      watch(${JSON.stringify(folder)}, leave);
      spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
        { stdio: ['ignore', 'inherit', 'inherit'] });
      leave();
    `,
    ],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  });
  assert.ok(launched.ok);
  const child = launched.process;
  let descendantPid: number | undefined;
  try {
    await waitForFile(folder, ready);
    descendantPid = Number(readFileSync(ready, "utf8"));
    const stdout = child.stdout[Symbol.asyncIterator]();
    assert.equal(await readIteratorPrefix(stdout, 3), "out");
    assert.equal(await readPrefix(child.stderr, 3), "err");
    assert.ok(rootPid !== undefined);
    writeFileSync(leave, "exit");
    await waitForDeath(adapter, rootPid, "failed-pipe root did not exit");
    assert.equal(isDead(adapter, descendantPid), false);
    if (mode === "output-abandon") {
      assert.ok(stdout.return !== undefined);
      await stdout.return();
    } else {
      // Perturb the external OS boundary: a foreign reaper releases the retained
      // zombie. Process must revoke authority before any numeric group signal.
      const { dlopen, ptr } = await import("bun:ffi");
      const library = dlopen(
        process.platform === "darwin"
          ? "/usr/lib/libSystem.B.dylib"
          : "libc.so.6",
        {
          waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
        },
      );
      try {
        const status = new Int32Array(1);
        assert.equal(library.symbols.waitpid(rootPid, ptr(status), 1), rootPid);
        assert.equal(status[0], 17 << 8);
      } finally {
        library.close();
      }
      const interruption = await child.interrupt(100);
      assert.equal(interruption.close.kind, "cleanup-error");
    }
    const close = await withTimeout(
      child.closed(),
      5000,
      "failed-pipe cleanup did not settle",
    );
    assert.ok(close.kind === "cleanup-error");
    assert.ok(close.cause instanceof Error);
    const terminals = facts.filter(
      (fact) =>
        (fact.kind === "exit" || fact.kind === "reap") && fact.pid === rootPid,
    );
    assert.equal(terminals.length, 1);
    const terminal = terminals[0];
    if (mode === "output-abandon") {
      assert.ok(terminal?.kind === "reap");
      assert.equal(terminal.status, 17);
      assert.equal(terminal.signal, undefined);
      assert.deepEqual(signals, [{ pid: rootPid, signal: "SIGKILL" }]);
      await waitForDeath(
        adapter,
        descendantPid,
        "output abandonment leaked descendant",
      );
    } else {
      assert.ok("code" in close.cause);
      assert.equal(close.cause.code, "ECHILD");
      assert.ok(terminal?.kind === "exit");
      assert.deepEqual(signals, []);
      assert.equal(isDead(adapter, descendantPid), false);
      await child.interrupt(100);
      await child.closeStdin(100);
      assert.deepEqual(signals, []);
      assert.equal(isDead(adapter, descendantPid), false);
      writeFileSync(release, "release");
      await waitForDeath(
        adapter,
        descendantPid,
        "foreign-reaper descendant ignored release",
      );
    }
    assert.equal(process.listenerCount("SIGCHLD"), listeners);
  } finally {
    writeFileSync(release, "release");
    writeFileSync(leave, "exit");
    await child.interrupt(100);
    if (descendantPid !== undefined)
      await waitForDeath(
        adapter,
        descendantPid,
        "failure fixture leaked descendant",
      );
  }
}
