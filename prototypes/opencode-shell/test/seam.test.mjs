// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Drives the entire shell lifecycle through the Crucible-owned RendererPort with
// no terminal, no OpenTUI, no native library and no OpenCode server. Runs on
// stock Node on any platform: `node --test test/seam.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createShell } from "../src/shell.mjs";
import { createFakeRenderer } from "../src/fake-renderer.mjs";
import { assertRendererPort } from "../src/renderer-port.mjs";

function harness() {
  const renderer = createFakeRenderer();
  const proc = new EventEmitter();
  const exits = [];
  const teardowns = [];
  proc.exit = (code) => exits.push(code);
  proc.stderr = { write: () => {} };
  const shell = createShell({
    renderer,
    process: proc,
    onExit: (info) => teardowns.push(info),
  });
  return { renderer, proc, shell, exits, teardowns };
}

test("the fake renderer satisfies the port contract", () => {
  assertRendererPort(createFakeRenderer());
});

test("start renders an initial frame", () => {
  const { renderer, shell } = harness();
  shell.start();
  assert.equal(renderer.frames.length, 1);
  assert.match(renderer.frames[0].lines.join("\n"), /status\s+running/);
});

test("input is accepted and re-rendered", () => {
  const { renderer, shell } = harness();
  shell.start();
  renderer.pressKey("a");
  renderer.pressKey("b");
  assert.equal(renderer.frames.length, 3);
  assert.match(renderer.frames.at(-1).lines.join("\n"), /keys\s+a b/);
});

test("resize updates size and re-renders", () => {
  const { renderer, shell } = harness();
  shell.start();
  renderer.resizeTo(120, 40);
  assert.match(renderer.frames.at(-1).lines.join("\n"), /size\s+120x40/);
  assert.match(renderer.frames.at(-1).lines.join("\n"), /resizes\s+1/);
});

for (const [signal, reason] of [
  ["SIGINT", "sigint"],
  ["SIGTERM", "sigterm"],
  ["SIGHUP", "sighup"],
]) {
  test(`${signal} tears down exactly once`, async () => {
    const { renderer, proc, shell, teardowns } = harness();
    shell.start();
    proc.emit(signal);
    await new Promise((r) => setImmediate(r));
    assert.equal(renderer.destroyCalls.length, 1);
    assert.equal(teardowns.at(-1).reason, reason);
    assert.equal(teardowns.at(-1).teardownCount, 1);
  });
}

test("repeated signals still tear down exactly once", async () => {
  const { renderer, proc, shell } = harness();
  shell.start();
  proc.emit("SIGINT");
  proc.emit("SIGINT");
  proc.emit("SIGTERM");
  await new Promise((r) => setImmediate(r));
  assert.equal(renderer.destroyCalls.length, 1);
});

test("quit key tears down and exits 0", async () => {
  const { renderer, shell, exits, teardowns } = harness();
  shell.start();
  renderer.pressKey("q");
  await new Promise((r) => setImmediate(r));
  assert.equal(renderer.destroyCalls.length, 1);
  assert.equal(teardowns.at(-1).reason, "normal");
  assert.deepEqual(exits, [0]);
});

test("a render failure still tears down", async () => {
  const { renderer, shell, exits, teardowns } = harness();
  shell.start();
  renderer.pressKey("r");
  await new Promise((r) => setImmediate(r));
  assert.equal(renderer.destroyCalls.length, 1);
  assert.equal(teardowns.at(-1).reason, "render-failure");
  assert.deepEqual(exits, [1]);
});

test("an uncaught exception still tears down", async () => {
  const { renderer, proc, shell, teardowns } = harness();
  shell.start();
  proc.emit("uncaughtException", new Error("boom"));
  await new Promise((r) => setImmediate(r));
  assert.equal(renderer.destroyCalls.length, 1);
  assert.equal(teardowns.at(-1).reason, "uncaught-exception");
});

test("an unhandled rejection still tears down", async () => {
  const { renderer, proc, shell, teardowns } = harness();
  shell.start();
  proc.emit("unhandledRejection", new Error("boom"));
  await new Promise((r) => setImmediate(r));
  assert.equal(renderer.destroyCalls.length, 1);
  assert.equal(teardowns.at(-1).reason, "unhandled-rejection");
});

// Regression test for the real bug this prototype found: signal handlers used to
// be removed at the START of teardown, leaving a window in which a signal arriving
// mid-teardown hit the default action and killed the process before it finished.
test("a signal arriving DURING teardown is absorbed, not fatal", async () => {
  const renderer = createFakeRenderer();
  const proc = new EventEmitter();
  const exits = [];
  const teardowns = [];
  proc.exit = (code) => exits.push(code);
  proc.stderr = { write: () => {} };

  let releaseDestroy;
  const destroyStarted = new Promise((resolve) => {
    const original = renderer.destroy;
    renderer.destroy = async () => {
      await original();
      resolve();
      await new Promise((r) => {
        releaseDestroy = r;
      });
    };
  });

  const shell = createShell({
    renderer,
    process: proc,
    onExit: (info) => teardowns.push(info),
  });
  shell.start();

  proc.emit("SIGTERM");
  await destroyStarted;

  // Mid-teardown: the handlers must STILL be installed, or this signal would be
  // fatal in a real process.
  assert.ok(proc.listenerCount("SIGINT") > 0, "SIGINT handler was removed too early");
  proc.emit("SIGINT");
  proc.emit("SIGINT");

  releaseDestroy();
  await new Promise((r) => setImmediate(r));

  assert.equal(renderer.destroyCalls.length, 1, "renderer destroyed more than once");
  assert.equal(teardowns.length, 1, "teardown reported more than once");
  assert.equal(teardowns[0].reason, "sigterm");
  assert.equal(proc.eventNames().length, 0, "listeners must be gone AFTER teardown");
});

test("teardown removes every listener it installed", async () => {
  const { proc, shell } = harness();
  shell.start();
  const before = proc.eventNames().length;
  await shell.teardown("normal");
  assert.ok(before > 0);
  assert.equal(proc.eventNames().length, 0, "no listeners may survive teardown");
});

test("repeated start/stop cycles leak nothing", async () => {
  for (let i = 0; i < 25; i += 1) {
    const { renderer, proc, shell } = harness();
    shell.start();
    proc.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    assert.equal(renderer.destroyCalls.length, 1);
    assert.equal(proc.eventNames().length, 0);
  }
});
