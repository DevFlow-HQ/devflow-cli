import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, realpathSync as realpath, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Database } from "bun:sqlite";
import {
  createApplication,
  type Application,
} from "../../src/application/application.js";
import type {
  RunListSnapshot,
  RunSummary,
} from "../../src/application/projection-port.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import type { ProcessAdapter, SpawnResult } from "../../src/process/process.js";
import type { RunCounts, RunGroup } from "../../src/run/store/store.js";
import { hostPlatform, writeCommandBundle } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  createFakeGitProcess,
  openFakeRunGroup as openRunGroup,
} from "../run/store/fake-git-process.js";

// A fixed clock so Today / Yesterday / Older grouping is deterministic on any CI
// timezone: rows are seeded relative to this same instant.
const NOW = new Date(2026, 5, 15, 12, 0, 0);

// The Command steps' execution runs through an injected fake Process, so no child
// is spawned. run-list seeds Runs directly through the Store and never launches, so
// this fake command is never reached — but the Application requires a Process, and
// the execution Seam threads it, exactly as production composition does.
function fakeCommand(): SpawnResult {
  return { kind: "exited", status: 0, text: new Uint8Array() };
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

/** Calls the Application makes on the Run Store Interface, so a summary case
 *  can assert how much Run Store work one observation performs. */
interface StoreCalls {
  listRuns: number;
  readRun: number;
  countRuns: number;
  acquireRun: number;
}

interface Fixture {
  readonly app: Application;
  readonly catalog: Catalog;
  readonly runGroup: RunGroup;
  readonly home: string;
  readonly workspace: string;
  readonly digest: string;
  readonly id: string;
  readonly calls: StoreCalls;
}

interface TFixtureOptions {
  readonly scheduleSettlement?: (settle: () => void | Promise<void>) => void;
  /** Replace the Application's Run Store count read (a malformed registration). */
  readonly countRuns?: () => RunCounts;
}

function fixture(t: TestContext, options: TFixtureOptions = {}): Fixture {
  const catalog = openCatalog(makeTempDir("secant-runlist-home-"));
  t.after(() => catalog.close());
  const workspace = realpath(makeTempDir("secant-runlist-ws-"));
  const home = makeTempDir("secant-runlist-store-");
  const runGroup = openRunGroup(home, workspace);
  t.after(() => runGroup.close());
  const calls: StoreCalls = {
    listRuns: 0,
    readRun: 0,
    countRuns: 0,
    acquireRun: 0,
  };
  const countedGroup: RunGroup = {
    ...runGroup,
    listRuns() {
      calls.listRuns += 1;
      return runGroup.listRuns();
    },
    readRun(runId) {
      calls.readRun += 1;
      return runGroup.readRun(runId);
    },
    countRuns() {
      calls.countRuns += 1;
      return (options.countRuns ?? runGroup.countRuns)();
    },
    acquireRun(runId, acquire) {
      calls.acquireRun += 1;
      return runGroup.acquireRun(runId, acquire);
    },
  };
  const app = createApplication({
    catalog,
    process: executionProcess,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup: countedGroup,
    ...(options.scheduleSettlement !== undefined
      ? { scheduleSettlement: options.scheduleSettlement }
      : {}),
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process: executionProcess,
      }),
    now: () => NOW,
  });
  // Install one command Bundle; every seeded Run reuses its digest so the join can
  // derive a Bundle name from the pinned bytes.
  const cmd = writeCommandBundle();
  const built = app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog.listEntries().find((e) => e.id === cmd.id)!;
  return {
    app,
    catalog,
    runGroup,
    home,
    workspace,
    digest: entry.digest,
    id: cmd.id,
    calls,
  };
}

/** Seed a resting Run at `at` with canonical `state`, releasing the claim. */
function seedRun(f: Fixture, at: Date, state: string): string {
  const created = f.runGroup.createRun({
    operationId: randomUUID(),
    bundleSnapshotDigest: f.digest,
    launch: {},
    at,
  });
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const owner = f.runGroup.acquireRun(created.runId)!;
  owner.writeState(state);
  owner.close();
  f.runGroup.endRun(created.runId);
  return created.runId;
}

function list(
  app: Application,
  options: { resumable?: boolean; before?: string } = {},
): RunListSnapshot {
  const opened = app.projectionPort.openProjection({
    family: "run-list",
    ...(options.resumable ? { resumable: true } : {}),
    ...(options.before !== undefined ? { before: options.before } : {}),
  });
  const snapshot = opened.snapshot;
  opened.close();
  return snapshot;
}

test("run list orders newest first and groups Today / Yesterday / Older", async (t) => {
  const f = fixture(t);
  const older = seedRun(f, new Date(2026, 5, 10, 10, 0, 0), "succeeded");
  const yesterday = seedRun(f, new Date(2026, 5, 14, 10, 0, 0), "failed");
  const today = seedRun(f, new Date(2026, 5, 15, 10, 0, 0), "succeeded");

  const snapshot = list(f.app);
  assert.equal(snapshot.empty, false);
  assert.equal(snapshot.beginningOfHistory, true);
  assert.deepEqual(
    snapshot.rows.map((r) => r.runId),
    [today, yesterday, older],
  );
  assert.deepEqual(
    snapshot.rows.map((r) => r.group),
    ["today", "yesterday", "older"],
  );
  // Each row carries the Bundle's human name, not the digest.
  assert.ok(snapshot.rows.every((r) => r.bundleName.length > 0));
  assert.ok(snapshot.rows.every((r) => r.bundleName !== f.digest));
});

test("--resumable shows only halted and failed Runs", async (t) => {
  const f = fixture(t);
  seedRun(f, new Date(2026, 5, 15, 9, 0, 0), "succeeded");
  const failed = seedRun(f, new Date(2026, 5, 15, 10, 0, 0), "failed");
  const halted = seedRun(f, new Date(2026, 5, 15, 11, 0, 0), "halted");
  seedRun(f, new Date(2026, 5, 15, 8, 0, 0), "created");

  const snapshot = list(f.app, { resumable: true });
  assert.equal(snapshot.filter, "resumable");
  assert.deepEqual(
    new Set(snapshot.rows.map((r) => r.runId)),
    new Set([halted, failed]),
  );
});

test("Runs from another Workspace never appear", async (t) => {
  const f = fixture(t);
  const mine = seedRun(f, new Date(2026, 5, 15, 10, 0, 0), "succeeded");

  // A second Run group for a different Workspace under the same store home.
  const otherWs = realpath(makeTempDir("secant-runlist-other-ws-"));
  const otherGroup = openRunGroup(
    makeTempDir("secant-runlist-other-"),
    otherWs,
  );
  t.after(() => otherGroup.close());
  otherGroup.createRun({
    operationId: randomUUID(),
    bundleSnapshotDigest: f.digest,
    launch: {},
    at: new Date(2026, 5, 15, 11, 0, 0),
  });

  const snapshot = list(f.app);
  assert.deepEqual(
    snapshot.rows.map((r) => r.runId),
    [mine],
  );
});

test("the empty list is an informational snapshot", async (t) => {
  const f = fixture(t);
  const snapshot = list(f.app);
  assert.equal(snapshot.empty, true);
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.beginningOfHistory, true);
  assert.equal(snapshot.nextCursor, undefined);
});

test("pages are bounded; the cursor pages older without duplicating or skipping, and the last page marks the beginning of history", async (t) => {
  const f = fixture(t);
  const total = 21;
  const ids: string[] = [];
  for (let i = 0; i < total; i++) {
    // Distinct, increasing creation times so the total order is stable.
    ids.push(seedRun(f, new Date(2026, 5, 15, 0, 0, i), "succeeded"));
  }

  const first = list(f.app);
  assert.equal(first.rows.length, 20);
  assert.ok(first.nextCursor);
  assert.equal(first.beginningOfHistory, false);

  const second = list(f.app, { before: first.nextCursor });
  assert.equal(second.rows.length, 1);
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.beginningOfHistory, true);

  const seen = [...first.rows, ...second.rows].map((r) => r.runId);
  // No duplicates across pages, and the two pages cover every seeded Run exactly.
  assert.equal(new Set(seen).size, total);
  assert.deepEqual(new Set(seen), new Set(ids));
});

test("an unparseable cursor yields an empty page, not a throw or the whole list", async (t) => {
  const f = fixture(t);
  seedRun(f, new Date(2026, 5, 15, 10, 0, 0), "succeeded");

  const snapshot = list(f.app, { before: "not-a-real-cursor" });
  assert.equal(snapshot.rows.length, 0);
  // The list is not empty (a Run exists), so this is a past-the-end page, not the
  // informational empty snapshot, and it marks the beginning of history.
  assert.equal(snapshot.empty, false);
  assert.equal(snapshot.beginningOfHistory, true);
  assert.equal(snapshot.nextCursor, undefined);
});

// --- authoritative-run-summary (#396) ----------------------------------------
//
// The Workspace's Run summary that Home and the guarded quit read: the Previous
// Runs total and the Runs this instance owns live, from one Run Store traversal
// that never acquires a Run.

function summary(app: Application): RunSummary {
  const opened = app.projectionPort.openProjection({ family: "workspace" });
  const snapshot = opened.snapshot;
  opened.close();
  return snapshot.runSummary;
}

function known(count: number): { state: "known"; count: number } {
  return { state: "known", count };
}

/** Whether a summary count is known and equals `count`. */
function counts(
  summary: RunSummary,
  field: keyof RunSummary,
  count: number,
): boolean {
  const value = summary[field];
  return value.state === "known" && value.count === count;
}

/** Create a Run straight through the Store, owned by this process from staging. */
function createOwned(f: Fixture, digest = f.digest): string {
  const created = f.runGroup.createRun({
    operationId: randomUUID(),
    bundleSnapshotDigest: digest,
    launch: {},
    at: NOW,
  });
  if (created.outcome !== "created") throw new Error("unreachable");
  return created.runId;
}

/** Hold an owned Run at `state` without releasing its ownership. */
function holdOwned(f: Fixture, state: string): string {
  const runId = createOwned(f);
  const owner = f.runGroup.acquireRun(runId)!;
  owner.writeState(state);
  owner.close();
  return runId;
}

/** Make a Run's record unreadable while its ownership row stays intact. */
function damageRecord(f: Fixture, runId: string): void {
  const raw = new Database(join(f.home, "runs", groupName(f), runId, "run.db"));
  raw.run("UPDATE run_record SET selected_harness = ?", ["unknown"]);
  raw.close();
}

function groupName(f: Fixture): string {
  return readdirSync(join(f.home, "runs"))[0]!;
}

/** Follow the `workspace` Projection; `until` resolves on the first snapshot (the
 *  open one or a later durable update) whose summary matches. */
function followWorkspace(app: Application) {
  const opened = app.projectionPort.openProjection({ family: "workspace" });
  const updates = opened.updates[Symbol.asyncIterator]();
  let latest = opened.snapshot;
  let pushes = 0;
  return {
    pushes: () => pushes,
    close: () => opened.close(),
    async until(matches: (summary: RunSummary) => boolean): Promise<void> {
      while (!matches(latest.runSummary)) {
        const next = await updates.next();
        if (next.done === true) throw new Error("workspace stream closed");
        if (next.value.kind === "durable") {
          latest = next.value.snapshot;
          pushes += 1;
        }
      }
    },
  };
}

test("authoritative-run-summary: counts readable history and this instance's canonical ownership", async (t) => {
  const f = fixture(t);
  seedRun(f, new Date(2026, 5, 15, 9, 0, 0), "succeeded");
  // Missing Bundle bytes still count: the list names the Run by its digest.
  const missingBytes = seedRun(f, new Date(2026, 5, 15, 9, 1, 0), "halted");
  {
    const raw = new Database(
      join(f.home, "runs", groupName(f), missingBytes, "run.db"),
    );
    raw.run("UPDATE run_record SET bundle_snapshot_digest = ?", [
      "sha256:gone",
    ]);
    raw.close();
  }
  // A damaged record at rest is omitted from the total.
  damageRecord(f, seedRun(f, new Date(2026, 5, 15, 9, 2, 0), "failed"));
  // A Run another process (pid 1000) owns live counts as history, not as ours.
  const foreign = openRunGroup(f.home, f.workspace, { selfPid: 1000 });
  foreign.createRun({
    operationId: randomUUID(),
    bundleSnapshotDigest: f.digest,
    launch: {},
    at: NOW,
  });
  foreign.close();
  // Owned here: created, driving, held at blocked, and one whose record is damaged.
  createOwned(f);
  holdOwned(f, "running");
  holdOwned(f, "blocked");
  damageRecord(f, createOwned(f));

  assert.deepEqual(summary(f.app), {
    previousRuns: known(6),
    ownedLiveRuns: known(4),
  });
  // The total is the Previous Runs list's own count.
  assert.equal(list(f.app).rows.length, 6);
});

test("authoritative-run-summary: unreadable ownership is unavailable, never a false zero", async (t) => {
  const f = fixture(t);
  seedRun(f, new Date(2026, 5, 15, 9, 0, 0), "succeeded");
  const corrupt = seedRun(f, new Date(2026, 5, 15, 9, 1, 0), "succeeded");
  writeFileSync(
    join(f.home, "runs", groupName(f), corrupt, "run.db"),
    "garbage",
  );

  assert.deepEqual(summary(f.app), {
    previousRuns: known(1),
    ownedLiveRuns: { state: "unavailable" },
  });
});

test("authoritative-run-summary: an unreadable registration leaves both counts unavailable and the Workspace open", async (t) => {
  const f = fixture(t, {
    countRuns: () => {
      throw new Error("Run Store: a runs row is malformed.");
    },
  });

  assert.deepEqual(summary(f.app), {
    previousRuns: { state: "unavailable" },
    ownedLiveRuns: { state: "unavailable" },
  });
});

test("authoritative-run-summary: admission, rest, release, deletion and resumed work update the summary", async (t) => {
  const pending: (() => void | Promise<void>)[] = [];
  const f = fixture(t, {
    scheduleSettlement: (settle) => void pending.push(settle),
  });
  const flush = async (): Promise<void> => {
    for (const settle of pending.splice(0)) await settle();
  };
  f.catalog.approveWorkspace(f.workspace, NOW);
  const workspace = followWorkspace(f.app);
  t.after(() => workspace.close());
  await workspace.until((s) => counts(s, "previousRuns", 0));

  // Admission: a launched Run is owned here before it settles.
  const launched = f.app.projectionPort.submit({
    operationId: randomUUID(),
    operation: "launch-run",
    input: { bundle: { id: f.id }, launchInputs: {}, trustDigest: f.digest },
  });
  assert.ok(launched.admitted, JSON.stringify(launched));
  await workspace.until(
    (s) => counts(s, "previousRuns", 1) && counts(s, "ownedLiveRuns", 1),
  );

  // Rest and release: the Run rests and this instance lets it go.
  await flush();
  await workspace.until((s) => counts(s, "ownedLiveRuns", 0));

  // Resume: admission claims a halted Run before its drive settles. The launch
  // recorded the Trust grant the resume re-checks.
  const halted = seedRun(f, new Date(2026, 5, 15, 9, 0, 0), "halted");
  const resumed = f.app.projectionPort.submit({
    operationId: randomUUID(),
    operation: "resume-run",
    input: { runId: halted },
  });
  assert.ok(resumed.admitted, JSON.stringify(resumed));
  await workspace.until((s) => counts(s, "ownedLiveRuns", 1));
  await flush();
  await workspace.until((s) => counts(s, "ownedLiveRuns", 0));

  // Deletion removes a Run from the total.
  const deleted = f.app.projectionPort.submit({
    operationId: randomUUID(),
    operation: "delete-run",
    input: { runId: launched.runId! },
  });
  assert.ok(deleted.admitted);
  await flush();
  await workspace.until((s) => counts(s, "previousRuns", 1));
});

test("authoritative-run-summary: 101 Runs are counted in one Run Store traversal", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 101; i++) {
    seedRun(f, new Date(2026, 5, 15, 0, 0, i), "succeeded");
  }
  f.calls.listRuns = 0;
  f.calls.readRun = 0;
  f.calls.countRuns = 0;
  f.calls.acquireRun = 0;

  assert.deepEqual(summary(f.app), {
    previousRuns: known(101),
    ownedLiveRuns: known(0),
  });
  // One traversal, no per-record reads, no page drain, and no Run acquired.
  assert.deepEqual(f.calls, {
    listRuns: 0,
    readRun: 0,
    countRuns: 1,
    acquireRun: 0,
  });
});
