import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createProcessAdapter,
  type ChildFact,
  type OwnedProcess,
  type ProcessAdapterOptions,
} from "../../src/process/process.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { stage, withRunnerObserver } from "../helpers/standalone.js";
import type { RunnerCase } from "../helpers/scenario-runner.js";
import { isLive, observeLifetime } from "./windows-contained-native.js";

const worker = fileURLToPath(
  new URL("./windows-contained-worker.ts", import.meta.url),
);
const encoder = new TextEncoder();
function observed(options: ProcessAdapterOptions = {}) {
  const facts: ChildFact[] = [];
  return {
    adapter: createProcessAdapter(
      withRunnerObserver({
        ...options,
        observeChild: (fact) => facts.push(fact),
      }),
    ),
    facts,
  };
}
function options(mode: string, args: readonly string[] = []) {
  return {
    role: "harness-runtime" as const,
    executable: process.execPath,
    args: [worker, mode, ...args],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  };
}
async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream)
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}
async function line(process: OwnedProcess) {
  const iterator = process.stdout[Symbol.asyncIterator]();
  let text = "";
  while (!text.includes("\n")) {
    const result = await iterator.next();
    assert.equal(result.done, false, text);
    text += new TextDecoder().decode(result.value);
  }
  return { text, iterator };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "native process handles must all be signaled");
}
function assertContainment(
  facts: readonly ChildFact[],
  containment: "contained" | "fallback",
): void {
  const launches = facts.filter(
    (fact) => fact.role === "harness-runtime" && fact.kind === "spawn",
  );
  assert.equal(launches.length, 1, JSON.stringify(facts));
  assert.ok(launches[0]?.kind === "spawn");
  assert.equal(launches[0].containment, containment);
}

async function exactDelivery(): Promise<void> {
  const root = makeTempDir("secant-contained-");
  const directory = join(root, "路径 with spaces");
  mkdirSync(directory);
  const runtime = join(directory, "contained-runtime.exe");
  copyFileSync(process.execPath, runtime);
  const args = [
    "",
    "spaces and tabs\t",
    'embedded"quote',
    'slashes\\\\"quote',
    "trailing slash\\",
    "line one\nline two",
    "line one\r\nline two",
    "%PATH% ^&|<> !bang!",
    "日本 café 🐈",
    "a".repeat(30_000),
  ];
  const { adapter, facts } = observed();
  const launched = await stage("contained argv/environment launch", () =>
    adapter.spawnOwnedProcess({
      ...options("arguments", args),
      executable: "contained-runtime",
      cwd: directory,
      env: {
        ...process.env,
        Path: "Z:\\deliberately-missing",
        PATH: directory,
        SECANT_CONTAINMENT_VALUE: "日本 café 🐈\nline\r\nlast",
        SECANT_CONTAINMENT_OMITTED: undefined,
      },
    }),
  );
  assert.ok(launched.ok);
  const [stdout, stderr, close] = await Promise.all([
    collect(launched.process.stdout),
    collect(launched.process.stderr),
    launched.process.closed(),
  ]);
  assert.deepEqual(close, { kind: "exited", status: 0 });
  assert.equal(stderr, "");
  const delivered = z
    .object({
      membership: z.object({
        inJob: z.boolean(),
        breakawayDenied: z.boolean(),
      }),
      args: z.array(z.string()),
      pathKeys: z.array(z.string()),
      path: z.string(),
      value: z.string(),
      omitted: z.null(),
      cwd: z.string(),
    })
    .parse(JSON.parse(stdout));
  assert.deepEqual(delivered.membership, {
    inJob: true,
    breakawayDenied: true,
  });
  assert.deepEqual(delivered.args, args);
  assert.deepEqual(delivered.pathKeys, ["PATH"]);
  assert.equal(delivered.path, directory);
  assert.equal(delivered.value, "日本 café 🐈\nline\r\nlast");
  assert.equal(delivered.cwd, directory);
  assertContainment(facts, "contained");
}

async function handleExit(): Promise<void> {
  const { adapter, facts } = observed();
  const launched = await adapter.spawnOwnedProcess(options("handle-exit"));
  assert.ok(launched.ok);
  let finalRead = false;
  const stdout = collect(launched.process.stdout).then((text) => {
    finalRead = true;
    return text;
  });
  const stderr = collect(launched.process.stderr);
  const close = await launched.process.closed();
  assert.equal(
    finalRead,
    true,
    "closed must follow consumption of the final Harness frame",
  );
  assert.deepEqual(close, { kind: "exited", status: 23 });
  const result = z
    .object({ pid: z.number().int().positive(), final: z.string() })
    .parse(JSON.parse(await stdout));
  assert.equal(result.final, "x".repeat(128 * 1024));
  assert.equal(await stderr, "stderr-final:" + "y".repeat(128 * 1024));
  // The holder could keep EOF open for minutes. Handle exit ends the job instead.
  assert.equal(isLive(result.pid), false);
  assertContainment(facts, "contained");
}

async function fallback(): Promise<void> {
  for (const failAt of [
    "job-create",
    "job-configure",
    "stdio",
    "handle-list",
    "job-list",
    "create-process",
    "exit-wait",
    "exit-callback",
  ] as const) {
    await stage(`forced fallback at ${failAt}`, async () => {
      const root = makeTempDir("secant-fallback-");
      const marker = join(root, "launches");
      const { adapter, facts } = observed({
        testWindowsContainmentFailure: failAt,
      });
      const launched = await adapter.spawnOwnedProcess(
        options("echo", [marker]),
      );
      assert.ok(launched.ok);
      const ready = await line(launched.process);
      assert.equal(ready.text, "ready\n");
      const reply = ready.iterator.next();
      await launched.process.writeStdin(encoder.encode("one Turn\n"));
      const result = await reply;
      assert.equal(result.done, false);
      assert.equal(new TextDecoder().decode(result.value), "one Turn\n");
      const end = ready.iterator.next();
      const stopped = await launched.process.interrupt(5000);
      assert.equal(stopped.containment, "fallback");
      assert.equal(stopped.escalated, true);
      assert.equal(stopped.close.kind, "exited");
      assert.equal((await end).done, true);
      assert.equal(await launched.process.interrupt(5000), stopped);
      assert.equal(
        readFileSync(marker, "utf8").trim().split("\n").length,
        1,
        "only one Harness executes",
      );
      assertContainment(facts, "fallback");
    });
  }
}

async function crashCleanup(): Promise<void> {
  // The holder must itself be uncontained, otherwise its ancestor's job could
  // hide a broken inner job. Kill only this holder, never /T.
  const { adapter, facts } = observed({
    testWindowsContainmentFailure: "job-create",
  });
  const launched = await adapter.spawnOwnedProcess(options("crash-owner"));
  assert.ok(launched.ok);
  const ready = await stage("escaped Bash descendants ready", () =>
    line(launched.process),
  );
  const tree = z
    .object({
      harnessPid: z.number().int().positive(),
      bashPid: z.number().int().positive(),
      pids: z.array(z.number().int().positive()).length(2),
    })
    .parse(JSON.parse(ready.text));
  const holders = [tree.harnessPid, ...tree.pids].map(observeLifetime);
  try {
    assert.ok(holders.every((holder) => holder.alive()));
    assert.equal(isLive(tree.bashPid), false);
    const parent = facts.find(
      (fact) => fact.kind === "spawn" && fact.role === "harness-runtime",
    );
    assert.ok(parent?.kind === "spawn" && parent.pid !== undefined);
    const killed = adapter.spawnCommandSync({
      role: "command",
      executable: "taskkill",
      args: ["/F", "/PID", String(parent.pid)],
      env: process.env,
      maxBufferBytes: 65536,
    });
    assert.ok(killed.kind === "exited" && killed.status === 0);
    await stage("no contained descendant survives parent crash", () =>
      until(() => holders.every((holder) => !holder.alive())),
    );
    assert.equal((await ready.iterator.next()).done, true);
    assert.equal((await launched.process.closed()).kind, "exited");
  } finally {
    for (const holder of holders) holder.close();
    await launched.process.interrupt(5000);
  }
}

async function waitReference(): Promise<void> {
  const { adapter } = observed();
  const launched = await adapter.spawnOwnedProcess(options("wait-reference"));
  assert.ok(launched.ok);
  const [stdout, stderr, close] = await Promise.all([
    collect(launched.process.stdout),
    collect(launched.process.stderr),
    launched.process.closed(),
  ]);
  assert.deepEqual(JSON.parse(stdout), { kind: "exited", status: 19 });
  assert.equal(stderr, "");
  assert.deepEqual(close, { kind: "exited", status: 0 });
}

export function registerWindowsContainmentCases(
  register: (test: RunnerCase) => void,
): void {
  for (const [name, body] of [
    ["exact-delivery-and-at-creation-membership", exactDelivery],
    ["handle-exit-drains-final-output", handleExit],
    ["forced-fallback-once", fallback],
    ["parent-crash-escaped-bash", crashCleanup],
    ["exit-wait-reference", waitReference],
  ] as const) {
    register({
      name: `process-windows-containment-${name}`,
      body: () => (process.platform === "win32" ? body() : undefined),
    });
  }
}
