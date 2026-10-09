import test from "node:test";
import { registerPreparationOwnership } from "./preparation-conformance.js";

import assert from "node:assert/strict";
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
} from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import type { OwnedProcessClose } from "../../src/process/process.js";

import {
  preparationClock,
  scriptedPreparation,
} from "./scripted-preparation.js";
import { ownPreparations } from "./preparation-double.js";

registerPreparationOwnership(test);

for (const create of [createClaudeCodeAdapter, createCodexAdapter]) {
  test(`m10-audit-preparation-lifetime-bounds: ${create.name} releases resolved cleanup-free failures`, async () => {
    const adapter = create({ env: {}, platform: "aix" });
    for (let i = 0; i < 1000; i++) {
      const result = await adapter.prepare({
        workspace: process.cwd(),
        process: createFakeProcess({}),
      });
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.equal(result.failure.category, "unsupported-platform");
    }
    assert.deepEqual(await adapter.close(), {
      status: "closed",
      preparations: [],
    });
  });
}

test("m10-audit-preparation-lifetime-bounds: failed Codex qualification owns cleanup until independent final exit", async () => {
  const clock = preparationClock();
  const scripted = scriptedPreparation({
    failure: "authentication",
    cleanup: { kind: "cleanup-timeout" },
  });
  const adapter = createCodexAdapter({
    env: {},
    cleanupTimeoutMs: 0,
    preparationClock: clock.clock,
  });
  const result = await adapter.prepare({
    workspace: process.cwd(),
    process: scripted.process,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.category, "authentication");
  const closing = adapter.close();
  assert.deepEqual(clock.scheduled(), [5000]);
  await scripted.exit();
  const report = await closing;
  assert.equal(report.status, "closed");
  assert.equal(report.preparations.length, 1);
  assert.equal(
    report.preparations[0]?.startupFailure?.category,
    "authentication",
  );
  assert.ok(
    report.preparations[0]?.cleanupFailures.some(
      (failure) => failure.category === "cleanup-timeout",
    ),
  );
  assert.deepEqual(report.preparations[0]?.unresolved, []);
  assert.deepEqual(
    scripted.closes,
    [0],
    "initial owner never retries the cached cleanup attempt",
  );
  assert.deepEqual(clock.scheduled(), []);
});

for (const category of ["authentication", "protocol"] as const) {
  test(`m10-audit-preparation-lifetime-bounds: Codex ${category} stays startup failure at a deadline while cleaning`, async () => {
    const clock = preparationClock();
    const cleanup = Promise.withResolvers<OwnedProcessClose>();
    const scripted = scriptedPreparation({
      failure: category,
      cleanup: cleanup.promise,
    });
    const adapter = createCodexAdapter({
      env: {},
      cleanupTimeoutMs: 0,
      preparationClock: clock.clock,
    });
    const pending = adapter.prepare({
      workspace: process.cwd(),
      process: scripted.process,
    });
    await scripted.cleanupStarted;
    const closing = adapter.close();
    clock.advance(5000);
    const report = await closing;
    const expected =
      category === "protocol" ? "protocol-incompatible" : category;
    assert.equal(report.status, "unresolved");
    assert.equal(report.preparations[0]?.startupFailure?.category, expected);
    assert.deepEqual(report.preparations[0]?.unresolved, [
      { kind: "preparation-pending" },
      { kind: "closure-unconfirmed", resource: 1 },
    ]);
    const snapshot = JSON.stringify(report);
    cleanup.resolve({ kind: "cleanup-timeout" });
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.category, expected);
    await scripted.exit();
    assert.equal(JSON.stringify(report), snapshot);
    assert.strictEqual(await adapter.close(), report);
  });
}

test("m10-audit-preparation-lifetime-bounds: a pending cleanup receipt remains unresolved after independent exit", async () => {
  const clock = preparationClock();
  const cleanup = Promise.withResolvers<OwnedProcessClose>();
  const scripted = scriptedPreparation({ cleanup: cleanup.promise });
  const adapter = ownPreparations(
    {
      async prepare(options) {
        const spawned = await options.process.spawnOwnedProcess({
          role: "harness-runtime",
          executable: "scripted",
          args: [],
          cwd: options.workspace,
          env: {},
          launchTimeoutMs: 100,
        });
        assert.ok(spawned.ok);
        void spawned.process.closeStdin(0);
        return {
          ok: false,
          failure: {
            phase: "prepare",
            category: "authentication",
            possibleEffects: "none",
          },
        };
      },
    },
    clock.clock,
  );
  assert.equal(
    (
      await adapter.prepare({
        workspace: process.cwd(),
        process: scripted.process,
      })
    ).ok,
    false,
  );
  await scripted.cleanupStarted;
  await scripted.exit();
  const closing = adapter.close();
  clock.advance(5000);
  const report = await closing;
  assert.equal(report.status, "unresolved");
  assert.deepEqual(report.preparations[0]?.unresolved, [
    { kind: "preparation-pending" },
  ]);
  const snapshot = JSON.stringify(report);
  cleanup.resolve({ kind: "cleanup-timeout" });
  await cleanup.promise;
  assert.strictEqual(await adapter.close(), report);
  assert.equal(JSON.stringify(report), snapshot);
});
