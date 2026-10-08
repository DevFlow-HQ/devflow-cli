import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import test from "node:test";
import { createApplication } from "../helpers/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { openLiveRun, UNREAD_UPDATE_BOUND } from "../helpers/liveRun.js";
import type { ApplicationEvent } from "../../src/application/application.js";
import { makeTempDir } from "../helpers/tempDir.js";

for (const deferred of [false, true]) {
  test(`operation-receipt-identity-and-lifetime: equal fingerprints of different kinds are refused while ${deferred ? "pending" : "settled"}`, (t) => {
    const catalog = openCatalog(makeTempDir("secant-receipt-home-"));
    t.after(() => catalog.close());
    const workspace = realpathSync.native(makeTempDir("secant-receipt-ws-"));
    const rawPath = '["cancel","raw-collision"]';
    const cwd = process.cwd();
    process.chdir(workspace);
    try {
      // POSIX permits the literal fingerprint as a real directory name. Windows
      // forbids quotes in names, but the admitted approval still owns this identity.
      if (process.platform !== "win32") mkdirSync(rawPath);
      const held: (() => void | Promise<void>)[] = [];
      const app = createApplication({
        catalog,
        launchWorkspacePath: workspace,
        scheduleSettlement: deferred
          ? (settle) => {
              held.push(settle);
            }
          : undefined,
      });
      const port = app.projectionPort;
      assert.deepEqual(
        port.submit({
          operationId: "collision",
          operation: "approve-workspace",
          input: { path: rawPath },
        }),
        { admitted: true, operationId: "collision" },
      );
      const approval = port.openProjection({
        family: "operation",
        operationId: "collision",
      });
      t.after(() => approval.close());
      assert.equal(
        approval.snapshot.outcome.status,
        deferred
          ? "pending"
          : process.platform === "win32"
            ? "not-applied"
            : "applied",
      );
      const collision = port.submit({
        operationId: "collision",
        operation: "cancel-run",
        input: { runId: "raw-collision" },
      });
      assert.equal(collision.admitted, false);
      if (!collision.admitted)
        assert.equal(collision.problem.code, "operation-id-reused");
      // Run support is absent. A fresh cancel would be refused for that reason,
      // so operation-id-reused also proves authorization did not run.
      assert.deepEqual(
        port.submit({
          operationId: "collision",
          operation: "approve-workspace",
          input: { path: rawPath },
        }),
        { admitted: true, operationId: "collision" },
      );
      if (deferred) {
        assert.equal(held.length, 1);
        held.shift()?.();
        const settled = port.openProjection({
          family: "operation",
          operationId: "collision",
        });
        assert.equal(
          settled.snapshot.outcome.status,
          process.platform === "win32" ? "not-applied" : "applied",
        );
        settled.close();
      }
      if (process.platform !== "win32")
        assert.ok(catalog.getWorkspaceApproval(realpathSync.native(rawPath)));
    } finally {
      process.chdir(cwd);
    }
  });
}

test("operation-receipt-identity-and-lifetime: pending and settled replays preserve one effect, observer lifetime and semantic records", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-replay-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-replay-ws-"));
  const held: (() => void | Promise<void>)[] = [];
  const events: ApplicationEvent[] = [];
  let writes = 0;
  const app = createApplication({
    catalog: {
      ...catalog,
      approveWorkspace(path, at) {
        writes++;
        return catalog.approveWorkspace(path, at);
      },
    },
    launchWorkspacePath: workspace,
    scheduleSettlement: (settle) => {
      held.push(settle);
    },
    observe: (event) => {
      events.push(event);
      // Observation faults must not change admission, replay or settlement.
      throw new Error("observer fault");
    },
  });
  const port = app.projectionPort;
  const submission = {
    operationId: "approval",
    operation: "approve-workspace",
    input: { path: workspace },
  } as const;
  const admission = port.submit(submission);
  assert.deepEqual(admission, { admitted: true, operationId: "approval" });
  const pending = port.openProjection({
    family: "operation",
    operationId: "approval",
  });
  const closed = port.openProjection({
    family: "operation",
    operationId: "approval",
  });
  t.after(() => pending.close());
  closed.close();
  const closedReader = closed.updates[Symbol.asyncIterator]();
  assert.equal((await closedReader.next()).done, true);
  assert.deepEqual(pending.snapshot.outcome, { status: "pending" });
  assert.deepEqual(port.submit(submission), admission);
  const conflict = port.submit({
    ...submission,
    input: { path: workspace + "-different" },
  });
  assert.ok(!conflict.admitted);
  assert.equal(conflict.problem.code, "operation-id-reused");
  assert.equal(held.length, 1);
  assert.equal(writes, 0);
  const reader = pending.updates[Symbol.asyncIterator]();
  const settlement = reader.next();
  const settle = held.shift();
  assert.ok(settle);
  await settle();
  // The scheduling callback cannot rerun the already admitted effect.
  await settle();
  assert.equal(writes, 1);
  const expected = {
    family: "operation",
    operationId: "approval",
    outcome: { status: "applied" },
  };
  assert.deepEqual(await settlement, {
    done: false,
    value: { kind: "durable", snapshot: expected },
  });
  assert.deepEqual(port.submit(submission), admission);
  const settled = port.openProjection({
    family: "operation",
    operationId: "approval",
  });
  t.after(() => settled.close());
  assert.deepEqual(settled.snapshot, expected);
  assert.equal(writes, 1);
  assert.deepEqual(events, [
    {
      kind: "operation-admission",
      operationId: "approval",
      operation: "approve-workspace",
      admission: "admitted",
    },
    {
      kind: "operation-admission",
      operationId: "approval",
      operation: "approve-workspace",
      admission: "replayed",
    },
    {
      kind: "operation-admission",
      operationId: "approval",
      operation: "approve-workspace",
      admission: "not-admitted",
      code: "operation-id-reused",
    },
    {
      kind: "operation-outcome",
      operationId: "approval",
      operation: "approve-workspace",
      outcome: "applied",
    },
    {
      kind: "operation-admission",
      operationId: "approval",
      operation: "approve-workspace",
      admission: "replayed",
    },
  ]);
  const waiting = reader.next();
  await app.shutdown();
  assert.deepEqual(await waiting, {
    done: false,
    value: { kind: "closed", reason: "application-shutdown" },
  });
  assert.equal((await reader.next()).done, true);
  assert.equal((await closedReader.next()).done, true);
});

test("operation-receipt-identity-and-lifetime: refusal leaves the id free and inline admission precedes its outcome", (t) => {
  const catalog = openCatalog(makeTempDir("secant-refusal-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-refusal-ws-"));
  const events: ApplicationEvent[] = [];
  const port = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    observe: (event) => {
      events.push(event);
    },
  }).projectionPort;
  const refused = port.submit({
    operationId: "reusable",
    operation: "change-model-choice",
    input: { runId: "absent" },
  });
  assert.ok(!refused.admitted);
  assert.equal(refused.problem.code, "model-choice-change-required");
  const absent = port.openProjection({
    family: "operation",
    operationId: "reusable",
  });
  assert.equal(absent.snapshot.outcome.status, "not-applied");
  if (absent.snapshot.outcome.status === "not-applied")
    assert.equal(absent.snapshot.outcome.problem.code, "operation-not-found");
  absent.close();
  assert.deepEqual(
    port.submit({
      operationId: "reusable",
      operation: "approve-workspace",
      input: { path: workspace },
    }),
    { admitted: true, operationId: "reusable" },
  );
  const receipt = port.openProjection({
    family: "operation",
    operationId: "reusable",
  });
  assert.deepEqual(receipt.snapshot.outcome, { status: "applied" });
  receipt.close();
  assert.deepEqual(events, [
    {
      kind: "operation-admission",
      operationId: "reusable",
      operation: "change-model-choice",
      admission: "not-admitted",
      code: "model-choice-change-required",
    },
    {
      kind: "operation-admission",
      operationId: "reusable",
      operation: "approve-workspace",
      admission: "admitted",
    },
    {
      kind: "operation-outcome",
      operationId: "reusable",
      operation: "approve-workspace",
      outcome: "applied",
    },
  ]);
});

test("operation-receipt-identity-and-lifetime: a lagged Run observer leaves its pending receipt and healthy receipt observers intact", async (t) => {
  const run = await openLiveRun(t);
  const slow = run.port.openProjection({ family: "run", runId: run.runId });
  const first = run.port.openProjection({
    family: "operation",
    operationId: "launch-lag",
  });
  const second = run.port.openProjection({
    family: "operation",
    operationId: "launch-lag",
  });
  t.after(() => {
    slow.close();
    first.close();
    second.close();
  });
  assert.equal(first.snapshot.outcome.status, "pending");
  const receiptReaders = [first, second].map((view) =>
    view.updates[Symbol.asyncIterator](),
  );
  const waiting = receiptReaders.map((reader) => reader.next());
  for (let index = 0; index <= UNREAD_UPDATE_BOUND; index++)
    run.channel.observe({ usage: `p${index}` });
  const slowReader = slow.updates[Symbol.asyncIterator]();
  assert.deepEqual(await slowReader.next(), {
    done: false,
    value: { kind: "closed", reason: "observer-lagged" },
  });
  assert.equal((await slowReader.next()).done, true);
  await run.finish();
  for (const next of waiting) {
    assert.deepEqual(await next, {
      done: false,
      value: {
        kind: "durable",
        snapshot: {
          family: "operation",
          operationId: "launch-lag",
          outcome: { status: "applied" },
        },
      },
    });
  }
  const reopened = run.port.openProjection({
    family: "operation",
    operationId: "launch-lag",
  });
  assert.deepEqual(reopened.snapshot.outcome, { status: "applied" });
  reopened.close();
});

for (const deferred of [false, true]) {
  test(`m10-audit-operation-settlement-owner: ${deferred ? "deferred" : "inline"} settlement returns the ledger receipt to every waiter`, async (t) => {
    const catalog = openCatalog(makeTempDir("secant-settlement-home-"));
    t.after(() => catalog.close());
    const workspace = realpathSync.native(makeTempDir("secant-settlement-ws-"));
    const held: (() => void | Promise<void>)[] = [];
    const app = createApplication({
      catalog,
      launchWorkspacePath: workspace,
      scheduleSettlement: deferred
        ? (settle) => {
            held.push(settle);
          }
        : undefined,
    });
    t.after(() => app.shutdown());
    const port = app.projectionPort;
    assert.deepEqual(
      port.submit({
        operationId: "save",
        operation: "change-preferences",
        input: { theme: "aura", appearance: "light" },
      }),
      { admitted: true, operationId: "save" },
    );
    let resolved = false;
    const first = port.settledOperation("save").then((receipt) => {
      resolved = true;
      return receipt;
    });
    const second = port.settledOperation("save");
    if (deferred) {
      await Promise.resolve();
      assert.equal(resolved, false);
      await held.shift()?.();
    }
    const expected = {
      family: "operation",
      operationId: "save",
      outcome: { status: "applied" },
      preferencesChange: { theme: "aura", appearance: "light" },
    };
    assert.deepEqual(await first, expected);
    assert.deepEqual(await second, expected);
    assert.deepEqual(await port.settledOperation("save"), expected);
  });
}

test("m10-audit-operation-settlement-owner: shutdown ends pending waits without changing the ledger outcome", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-settlement-stop-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-settlement-ws-"));
  const held: (() => void | Promise<void>)[] = [];
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    scheduleSettlement: (settle) => {
      held.push(settle);
    },
  });
  const port = app.projectionPort;
  port.submit({
    operationId: "approval-stop",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  const first = port.settledOperation("approval-stop");
  const second = port.settledOperation("approval-stop");
  await app.shutdown();
  const expected = {
    family: "operation",
    operationId: "approval-stop",
    outcome: {
      status: "not-applied",
      problem: {
        code: "operation-observation-ended",
        explanation:
          "Secant stopped reporting Operation approval-stop before it settled (application-shutdown).",
        remediation:
          "Reconnect to Secant and read the current state before retrying the Operation.",
        possibleEffects: "unknown",
      },
    },
  };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  assert.deepEqual(await port.settledOperation("approval-stop"), expected);
  const ledger = port.openProjection({
    family: "operation",
    operationId: "approval-stop",
  });
  assert.deepEqual(ledger.snapshot.outcome, { status: "pending" });
  ledger.close();
  await held.shift()?.();
  assert.deepEqual(await port.settledOperation("approval-stop"), {
    family: "operation",
    operationId: "approval-stop",
    outcome: { status: "applied" },
  });
});

test("m10-audit-operation-settlement-owner: unknown ids and failed effects return not-applied receipts", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-settlement-failure-"));
  t.after(() => catalog.close());
  const failure = new Error("injected write failure");
  const app = createApplication({
    catalog: {
      ...catalog,
      approveWorkspace() {
        throw failure;
      },
    },
    launchWorkspacePath: realpathSync.native(
      makeTempDir("secant-settlement-ws-"),
    ),
  });
  const port = app.projectionPort;
  const missing = await port.settledOperation("unknown");
  assert.equal(missing.operationId, "unknown");
  assert.equal(missing.outcome.status, "not-applied");
  if (missing.outcome.status === "not-applied")
    assert.equal(missing.outcome.problem.code, "operation-not-found");
  const workspace = port.openProjection({ family: "workspace" });
  const path = workspace.snapshot.path;
  workspace.close();
  assert.deepEqual(
    port.submit({
      operationId: "failed",
      operation: "approve-workspace",
      input: { path },
    }),
    { admitted: true, operationId: "failed" },
  );
  const failed = await port.settledOperation("failed");
  assert.equal(failed.outcome.status, "not-applied");
  if (failed.outcome.status === "not-applied") {
    assert.equal(failed.outcome.problem.code, "run-execution-fault");
    assert.equal(failed.outcome.problem.possibleEffects, "unknown");
  }
  await app.shutdown();
  assert.deepEqual(await port.settledOperation("failed"), failed);
});
