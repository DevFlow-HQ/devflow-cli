import { readRun } from "./run-test-helpers.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
} from "../../src/application/application.js";
import type {
  OperationOutcome,
  ProjectionSelector,
} from "../../src/application/projection-port.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import type {
  ProcessAdapter,
  SpawnOptions,
  SpawnResult,
} from "../../src/process/process.js";
import type { RunGroup } from "../../src/run/store/store.js";
import {
  hostPlatform,
  writeCommandBundle,
  writeGateBundle,
} from "../helpers/commandBundle.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  createFakeGitProcess,
  openFakeRunGroup as openRunGroup,
} from "../run/store/fake-git-process.js";

// The Command steps' execution runs through an injected fake Process, so a Run
// spawns no child. A blocking script models a genuinely live child that settles
// only when the Application's cancel Seam aborts it — reproducing the real
// abort → RunCancelledError unwind that cancel-run and shutdown depend on.
function fakeCommand(
  options: SpawnOptions,
): SpawnResult | Promise<SpawnResult> {
  const script = options.args[1] ?? "";
  if (script.includes("setInterval") || script.includes("setTimeout")) {
    if (options.cancelSignal === undefined) return { kind: "timeout" };
    if (options.cancelSignal.aborted) return { kind: "cancelled" };
    return new Promise<SpawnResult>((resolve) => {
      options.cancelSignal!.addEventListener(
        "abort",
        () => resolve({ kind: "cancelled" }),
        { once: true },
      );
    });
  }
  // A `console.log('x')` script exits 0 (a `pass` Verdict) and captures `x\n`.
  const logged = /console\.log\('([^']*)'\)/.exec(script)?.[1];
  return {
    kind: "exited",
    status: 0,
    text: new TextEncoder().encode(logged === undefined ? "" : `${logged}\n`),
  };
}

const executionProcess: ProcessAdapter = (() => {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) =>
      name === "secant-no-such-binary-xyz"
        ? { kind: "not-found" }
        : { kind: "found", executable: name, prefixArgs: [] },
    commandHandler: fakeCommand,
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => git.spawnCommandSync(options),
  };
})();

interface Fixture {
  readonly app: Application;
  readonly runGroup: RunGroup;
  readonly catalog: Catalog;
  readonly workspace: string;
  readonly storeHome: string;
  readonly digest: string;
}

function fixture(t: TestContext): Fixture {
  const catalog = openCatalog(makeTempDir("secant-cd-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-cd-ws-"));
  const storeHome = makeTempDir("secant-cd-store-");
  const runGroup = openRunGroup(storeHome, workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    process: executionProcess,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: ({ routing, owner, cancelSignal }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process: executionProcess,
        // Thread the Application's cancel Seam, as production wiring does, so a
        // cancel of a Run live in this process actually aborts its execution (#98).
        ...(cancelSignal !== undefined ? { cancelSignal } : {}),
      }),
  });
  const cmd = writeCommandBundle();
  const built = app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog.listEntries().find((e) => e.id === cmd.id)!;
  return { app, runGroup, catalog, workspace, storeHome, digest: entry.digest };
}

/** Seed a Run and drive it to `state`; `live` leaves the Workspace claim held. */
function seedRun(f: Fixture, state: string, live: boolean): string {
  const created = f.runGroup.createRun({
    operationId: randomUUID(),
    bundleSnapshotDigest: f.digest,
    launch: {},
    at: new Date(),
  });
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const owner = f.runGroup.acquireRun(created.runId)!;
  owner.writeState(state);
  owner.close();
  if (!live) f.runGroup.endRun(created.runId);
  return created.runId;
}

function submit(
  app: Application,
  operation: "cancel-run" | "delete-run",
  runId: string,
  operationId: string,
): OperationOutcome {
  const admission = app.projectionPort.submit({
    operationId,
    operation,
    input: { runId },
  });
  assert.ok(admission.admitted);
  const opened = app.projectionPort.openProjection({
    family: "operation",
    operationId,
  });
  const outcome = opened.snapshot.outcome;
  opened.close();
  return outcome;
}

/** The offered actions on the exact `run` Projection. */
function offers(app: Application, runId: string): string[] {
  return readRun(app.projectionPort, runId).actionOffers.map((o) => o.action);
}

test("cancel-run rests a live Run cancelled, keeps its store, and flips the offer", async (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "running", true);
  // While live, the run Projection offers cancel, not delete.
  assert.deepEqual(offers(f.app, runId), ["cancel-run"]);

  const outcome = submit(f.app, "cancel-run", runId, "op-cancel");
  assert.equal(outcome.status, "applied");

  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.run.state, "cancelled");
  // The claim is released and the Run now offers delete, not cancel.
  assert.equal(
    f.runGroup.listRuns().some((r) => r.runId === runId && r.live),
    false,
  );
  assert.deepEqual(offers(f.app, runId), ["delete-run"]);
});

test("cancel-run aborts a Run live in this process, rests it cancelled, and pushes the cancelled snapshot (#98 AC2)", async (t) => {
  const f = fixture(t);
  f.catalog.approveWorkspace(f.workspace, new Date());
  // A Bundle whose command blocks until killed, so the Run stays genuinely live in
  // this process (its child spawned and running) while we cancel it.
  const blocking = writeCommandBundle({
    id: "dev.secant.block",
    script: "setInterval(() => {}, 1_000_000)",
  });
  const built = f.app.bundleManagement.build(blocking.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === blocking.id)!;

  const launch = f.app.projectionPort.submit({
    operationId: "op-launch-block",
    operation: "launch-run",
    input: {
      bundle: { id: blocking.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;

  // Open the run Projection before cancelling and collect its durable updates, so
  // we can assert an open observer receives the `cancelled` snapshot (AC2).
  const view = f.app.projectionPort.openProjection({ family: "run", runId });
  const seenStates: string[] = [];
  const draining = (async () => {
    for await (const update of view.updates) {
      if (update.kind === "durable" && update.snapshot.result.found) {
        seenStates.push(update.snapshot.result.run.state);
        if (update.snapshot.result.run.state === "cancelled") return;
      }
      if (update.kind === "closed") return;
    }
  })();

  // The launch Operation is pending while the Run blocks.
  const pending = f.app.projectionPort.openProjection({
    family: "operation",
    operationId: "op-launch-block",
  });
  assert.equal(pending.snapshot.outcome.status, "pending");
  pending.close();

  const cancel = f.app.projectionPort.submit({
    operationId: "op-cancel-block",
    operation: "cancel-run",
    input: { runId },
  });
  assert.ok(cancel.admitted);
  const cancelOutcome = await awaitSettled(
    f.app.projectionPort,
    "op-cancel-block",
  );
  assert.equal(cancelOutcome.status, "applied");

  await draining;
  view.close();

  // The Run rests cancelled — its child was killed and its store kept.
  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.run.state, "cancelled");
  // The claim is released, and an open observer saw the cancelled snapshot.
  assert.equal(
    f.runGroup.listRuns().some((r) => r.runId === runId && r.live),
    false,
  );
  assert.ok(seenStates.includes("cancelled"));
});

test("shutdown aborts two live Runs and reconciliation rests each halted with one indeterminate marker", async (t) => {
  const f = fixture(t);
  f.catalog.approveWorkspace(f.workspace, new Date());
  const blocking = writeCommandBundle({
    id: "dev.secant.block-sig",
    script: "setInterval(() => {}, 1_000_000)",
  });
  const built = f.app.bundleManagement.build(blocking.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === blocking.id)!;

  const runIds = ["a", "b"].map((suffix) => {
    const launch = f.app.projectionPort.submit({
      operationId: `op-launch-sig-${suffix}`,
      operation: "launch-run",
      input: {
        bundle: { id: blocking.id },
        launchInputs: {},
        trustDigest: entry.digest,
      },
    });
    assert.ok(launch.admitted);
    return launch.runId!;
  });

  // Shutdown aborts the live Run and awaits its rest — it resolves only once the
  // child is dead — and leaves the Workspace claim live so the next open reconciles
  // the Run `halted` (it does not rest it `cancelled`, which is cancel-run's job).
  await f.app.shutdown();

  assert.equal(f.runGroup.listRuns().filter((run) => run.live).length, 2);

  const reopened = openRunGroup(f.storeHome, f.workspace);
  t.after(() => reopened.close());
  for (const runId of runIds) {
    const read = reopened.readRun(runId);
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.run.state, "halted");
    const listing = reopened.listRuns().find((run) => run.runId === runId);
    assert.equal(listing?.live, false);
    const owner = reopened.acquireRun(runId);
    assert.ok(owner);
    assert.deepEqual(
      owner.attemptLog().map((entry) => entry.outcome),
      ["indeterminate"],
    );
    owner.close();
  }
});

test("cancel-run on a resting Run is refused and offers no cancel", async (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "succeeded", false);
  assert.deepEqual(offers(f.app, runId), ["delete-run"]);

  const outcome = submit(f.app, "cancel-run", runId, "op-cancel");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "run-not-live");
  }
  // Unchanged: the Run is still recorded and still resting.
  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.run.state, "succeeded");
});

test("cancel-run acquires a non-live blocked Run and rests it cancelled (#134 A2)", (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "blocked", false);
  assert.deepEqual(offers(f.app, runId), ["cancel-run"]);

  const outcome = submit(f.app, "cancel-run", runId, "op-cancel-blocked");
  assert.equal(outcome.status, "applied");

  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.run.state, "cancelled");
  assert.equal(
    f.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    false,
  );
  assert.deepEqual(offers(f.app, runId), ["delete-run"]);
});

test("delete-run removes a resting Run's store and is idempotent per operation id", async (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "failed", false);

  const first = submit(f.app, "delete-run", runId, "op-del");
  assert.equal(first.status, "applied");
  // The store is gone: unknown to both list and readRun.
  assert.equal(
    f.runGroup.listRuns().some((r) => r.runId === runId),
    false,
  );
  assert.equal(f.runGroup.readRun(runId).ok, false);

  // Same operation id replays applied (no throw, no second effect).
  const replay = submit(f.app, "delete-run", runId, "op-del");
  assert.equal(replay.status, "applied");
  // A fresh operation id on the already-gone Run still settles applied (the
  // admitted delete is a no-op on an absent Run).
  const again = submit(f.app, "delete-run", runId, "op-del-2");
  assert.equal(again.status, "applied");
});

test("delete-run on a live Run is refused, leaving it present", async (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "running", true);

  const outcome = submit(f.app, "delete-run", runId, "op-del");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "run-is-live");
  }
  assert.equal(f.runGroup.readRun(runId).ok, true);
});

test("a malformed coordination row settles cancel and delete not-applied, never throwing out of submit (#98 A4)", (t) => {
  const catalog = openCatalog(makeTempDir("secant-cd-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-cd-ws-"));
  const real = openRunGroup(makeTempDir("secant-cd-store-"), workspace);
  t.after(() => real.close());
  // A group whose listing throws, as a malformed coordination row makes the real
  // store's listRuns throw. cancel and delete must settle it through their catch —
  // the way run and answer route an execution fault — never throw out of submit.
  const runGroup = {
    ...real,
    listRuns() {
      throw new Error("Run Store: a runs row is malformed.");
    },
  } as unknown as RunGroup;
  const app = createApplication({
    catalog,
    process: executionProcess,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
  });

  for (const operation of ["cancel-run", "delete-run"] as const) {
    const outcome = submit(app, operation, "run-x", `op-${operation}`);
    assert.equal(outcome.status, "not-applied");
    if (outcome.status === "not-applied") {
      assert.equal(outcome.problem.code, "run-store-damaged");
    }
  }
});

test("CI: all Projection families end before blocked ownership releases and running work finishes cleanup", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-shutdown-active-home-"));
  const workspace = realpathSync.native(
    makeTempDir("secant-shutdown-active-ws-"),
  );
  const storeHome = makeTempDir("secant-shutdown-active-store-");
  const runGroup = openRunGroup(storeHome, workspace);
  t.after(() => {
    runGroup.close();
    catalog.close();
  });
  const process = createFakeBundleProcess();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted!: () => void;
  const stopping = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cleaned = false;
  let aborts = 0;
  let blockedId = "";
  const app = createApplication({
    catalog,
    process,
    launchWorkspacePath: workspace,
    runGroup,
    hostPlatform: hostPlatform(),
    runExecution: async ({ routing, owner, cancelSignal }) => {
      if (
        routing.some((step) => "kind" in step && step.kind === "human-gate")
      ) {
        return executeRouting(routing, {
          owner,
          platform: hostPlatform(),
          resolveAsset: () => undefined,
          process,
        });
      }
      owner.writeState("running");
      assert.ok(cancelSignal);
      const stopped = new Promise<void>((resolve) => {
        cancelSignal.addEventListener(
          "abort",
          () => {
            aborts++;
            // A running Run is aborted only after the blocked Run released ownership.
            assert.equal(
              runGroup.listRuns().find((run) => run.runId === blockedId)?.live,
              false,
            );
            assert.equal(cancelSignal.reason, "secant:process-signal");
            resolve();
            aborted();
          },
          { once: true },
        );
      });
      started();
      await stopped;
      await cleanup; // injected Harness/child cleanup is deliberately held
      cleaned = true;
      throw new Error("injected execution unwinds after signal-abort cleanup");
    },
  });
  t.after(() => {
    release();
  });
  catalog.approveWorkspace(workspace, new Date());
  function launch(
    bundle: ReturnType<typeof writeCommandBundle>,
    operationId: string,
  ) {
    assert.ok(
      app.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
    );
    const entry = catalog
      .listEntries()
      .find((entry) => entry.id === bundle.id)!;
    const admission = app.projectionPort.submit({
      operationId,
      operation: "launch-run",
      input: {
        bundle: { id: bundle.id },
        launchInputs: {},
        trustDigest: entry.digest,
      },
    });
    assert.ok(admission.admitted);
    return admission.runId!;
  }
  blockedId = launch(
    writeGateBundle({
      id: "dev.secant.shutdown-gate",
      shape: "approve-reject",
    }),
    "blocked-launch",
  );
  assert.equal(
    (await awaitSettled(app.projectionPort, "blocked-launch")).status,
    "applied",
  );
  const runningId = launch(
    writeCommandBundle({ id: "dev.secant.shutdown-running" }),
    "running-launch",
  );
  await running;
  const damagedId = runGroup.createRun({
    bundleSnapshotDigest: catalog.listEntries()[0]!.digest,
    operationId: "damaged-seed",
    launch: {},
    at: new Date(),
  }).runId;
  const damagedDir = readdirSync(storeHome, {
    recursive: true,
    withFileTypes: true,
  }).find((entry) => entry.isDirectory() && entry.name === damagedId);
  assert.ok(damagedDir);
  writeFileSync(
    join(damagedDir.parentPath, damagedId, "run.db"),
    "damaged database",
  );
  const selectors: ProjectionSelector[] = [
    { family: "workspace" },
    { family: "run", runId: blockedId },
    { family: "run", runId: runningId },
    { family: "run", runId: "unknown" },
    { family: "run", runId: damagedId },
    { family: "run-list" },
    { family: "run-list", resumable: true },
    { family: "bundle-catalog" },
    { family: "bundle-catalog", focus: { id: "dev.secant.shutdown-gate" } },
    { family: "harness-catalog" },
    { family: "harness-catalog", focus: { id: "unknown" } },
    {
      family: "launch-preparation",
      draft: { bundle: { id: "dev.secant.shutdown-gate" }, launchInputs: {} },
    },
    { family: "operation", operationId: "blocked-launch" },
    { family: "operation", operationId: "running-launch" },
    { family: "operation", operationId: "unknown" },
  ];
  const views = selectors.map((selector) =>
    app.projectionPort.openProjection(selector),
  );
  for (const [index, code] of [
    [3, "run-not-found"],
    [4, "run-store-damaged"],
  ] as const) {
    const snapshot = views[index]!.snapshot;
    assert.ok(snapshot.family === "run" && !snapshot.result.found);
    assert.equal(snapshot.result.problem.code, code);
  }
  for (const view of views) t.after(() => view.close());
  const readers = views.map((view) => view.updates[Symbol.asyncIterator]());
  const pending = readers[13]!.next();
  // This Workspace stream has a stale durable backlog at shutdown.
  app.projectionPort.submit({
    operationId: "another-approval",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  let complete = false;
  const shutdown = app.shutdown().then(() => {
    complete = true;
  });
  const repeated = app.shutdown();
  await stopping;
  assert.equal(complete, false);
  assert.equal(cleaned, false);
  for (const [index, reader] of readers.entries()) {
    assert.deepEqual(await (index === 13 ? pending : reader.next()), {
      done: false,
      value: { kind: "closed", reason: "application-shutdown" },
    });
    assert.equal((await reader.next()).done, true);
  }
  const blocked = app.projectionPort.openProjection({
    family: "run",
    runId: blockedId,
  });
  assert.ok(blocked.snapshot.result.found);
  assert.equal(blocked.snapshot.result.run.state, "blocked");
  assert.ok(
    blocked.snapshot.result.run.actionOffers.some(
      (offer) => offer.action === "answer-human-gate",
    ),
  );
  blocked.close();
  release();
  await Promise.all([shutdown, repeated]);
  assert.equal(cleaned, true);
  assert.equal(complete, true);
  assert.equal(
    runGroup.listRuns().find((run) => run.runId === runningId)?.live,
    true,
  );
  assert.equal(aborts, 1);
  const laterRun = launch(
    writeCommandBundle({ id: "dev.secant.shutdown-later" }),
    "later-launch",
  );
  await app.shutdown();
  assert.equal(aborts, 2);
  assert.equal(
    (await awaitSettled(app.projectionPort, "later-launch")).status,
    "applied",
  );
  assert.equal(
    runGroup.listRuns().find((run) => run.runId === laterRun)?.live,
    true,
  );
});
