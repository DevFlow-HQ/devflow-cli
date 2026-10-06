import { inertPreferencesView } from "./inert.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, realpathSync as realpath } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "bun:sqlite";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import {
  inertRunWorkbenchView,
  inertHarnessCatalogView,
  inertLaunchPreparationView,
  inertRunActionsView,
  inertRunListView,
  runSummary,
} from "./inert.js";
import type {
  BundleCatalogView,
  RunLaunchView,
  RunListView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import { createApplication } from "../../src/application/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { hostPlatform, writeCommandBundle } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openFakeRunGroup as openRunGroup } from "../run/store/fake-git-process.js";
import type {
  BundleCatalogSnapshot,
  RunSummary,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

/** A bundle view over an empty Catalog; these Workspace tests never navigate. */
function emptyBundles(): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [] },
  });
  return {
    openList: () => list,
    openFocus: () => {
      throw new Error("not used");
    },
  };
}

const PATH = "/tmp/secant-demo-workspace";

function unapproved(): WorkspaceSnapshot {
  return {
    family: "workspace",
    path: PATH,
    approval: { state: "unapproved" },
    installedBundleCount: 0,
    runSummary: runSummary(),
    startupNotices: [],
    harnesses: [],
    actionOffers: [{ action: "approve-workspace", input: { path: PATH } }],
  };
}
function approved(
  startupNotices: WorkspaceSnapshot["startupNotices"] = [],
  summary: RunSummary = runSummary(),
): WorkspaceSnapshot {
  return {
    family: "workspace",
    path: PATH,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 0,
    runSummary: summary,
    startupNotices,
    harnesses: [],
    actionOffers: [],
  };
}

/** A hand-driven view over fake snapshots; `approve` flips it to approved. */
function fakeView(): WorkspaceView & { approvedOnce(): boolean } {
  const [snapshot, setSnapshot] = createSignal<WorkspaceSnapshot>(unapproved());
  let approvedCalled = false;
  return {
    snapshot,
    approve() {
      approvedCalled = true;
      setSnapshot(approved());
    },
    approvedOnce: () => approvedCalled,
  };
}

function noLaunch(): RunLaunchView {
  return { launch: () => () => ({ kind: "pending" }) };
}

/** The Workspace/approval screens never open the Run Workbench; stubs satisfy
 *  the two App props the Workbench needs (#91). */

async function mount(width = 60, height = 16) {
  const view = fakeView();
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        preferences={inertPreferencesView()}
        view={view}
        bundles={emptyBundles()}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={inertRunWorkbenchView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        reducedMotion={false}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  return { t, view, exits };
}

/** Home and the guarded quit read the Workspace's Run summary (#396); they never
 *  open the detailed Previous Runs history, so this seam fails if either does. */
function unopenedRunList(): RunListView {
  return {
    openRunList() {
      throw new Error("Home and quit read the Workspace summary, not history");
    },
  };
}

async function mountApproved(
  summary: number | RunSummary,
  startupNotices: WorkspaceSnapshot["startupNotices"] = [],
  size: { width: number; height: number } = { width: 70, height: 18 },
) {
  const [snapshot, setSnapshot] = createSignal<WorkspaceSnapshot>(
    approved(
      startupNotices,
      typeof summary === "number" ? runSummary(summary) : summary,
    ),
  );
  const view: WorkspaceView = { snapshot, approve() {} };
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        preferences={inertPreferencesView()}
        view={view}
        bundles={emptyBundles()}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={inertRunWorkbenchView()}
        runList={unopenedRunList()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        reducedMotion={false}
        exit={(reason) => exits.push(reason)}
      />
    ),
    size,
  );
  await t.waitForFrame((frame) => frame.includes("Secant"));
  const setSummary = (next: RunSummary) =>
    setSnapshot(approved(startupNotices, next));
  return { t, exits, setSummary };
}

test("approval dialog shows the exact path and both options, readable without colour", async () => {
  const { t } = await mount();
  await t.waitForFrame((f) => f.includes(PATH));
  const frame = t.captureCharFrame();
  // Content present: exact absolute path and both options.
  assert.match(frame, /Approve this workspace\?/);
  assert.ok(frame.includes(PATH), "shows the exact absolute path");
  assert.match(frame, /Approve/);
  assert.match(frame, /Decline/);
  // State readable without colour: the active option carries a "›" marker.
  assert.match(frame, /›/);
});

test("Approve opens Home with the Workspace path and the quit binding", async () => {
  const { t, view, exits } = await mount();
  await t.waitForFrame((f) => f.includes(PATH));
  t.mockInput.pressEnter(); // default active option is Approve
  await t.waitForFrame((f) => f.includes("Search commands"));
  assert.equal(view.approvedOnce(), true);
  const frame = t.captureCharFrame();
  assert.match(frame, /Secant/);
  assert.ok(frame.includes(PATH), "Home shows the Workspace path");
  assert.match(frame, /Quit \(ctrl\+c\)/);
  // Home must not show the approval dialog once approved.
  assert.doesNotMatch(frame, /Approve this workspace/);
  // Approving clears the approval dialog programmatically; that clear must not be
  // mistaken for a user dismissal and exit `declined` (regression).
  assert.deepEqual(exits, []);
});

test("Decline (Escape) declines and exits without approving", async () => {
  const { t, view, exits } = await mount();
  await t.waitForFrame((f) => f.includes(PATH));
  t.mockInput.pressEscape();
  await until(() => exits.length > 0);
  assert.deepEqual(exits, ["declined"]);
  assert.equal(view.approvedOnce(), false);
});

test("Ctrl+C on the approval dialog declines and exits", async () => {
  const { t, exits } = await mount();
  await t.waitForFrame((f) => f.includes(PATH));
  t.mockInput.pressCtrlC();
  await t.waitFor(() => exits.length > 0);
  assert.deepEqual(exits, ["declined"]);
});

test("Home shows a failed Shipped Bundle ensure's cause and remedy and stays usable", async () => {
  const { t, exits } = await mountApproved(0, [
    {
      code: "shipped-bundle-not-installed",
      explanation: "Secant could not install its built-in Bundle x.wfb.",
      remediation: "Point SECANT_HOME at a fresh home.",
      possibleEffects: "none",
    },
  ]);
  const frame = t.captureCharFrame();
  assert.match(frame, /Notice: Secant could not install its built-in Bundle/);
  assert.match(frame, /Point SECANT_HOME at a fresh home\./);
  assert.match(frame, /Start a Run/);
  t.mockInput.pressKey("c", { ctrl: true });
  await t.waitFor(() => exits.length === 1);
});

test("Ctrl+C quits immediately with no live Runs", async () => {
  const { t, exits } = await mountApproved(0);
  t.mockInput.pressKey("c", { ctrl: true });
  await t.waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [undefined]);
});

test("Ctrl+C with two live Runs asks once with the count, then quits on confirmation", async () => {
  const { t, exits } = await mountApproved(2);
  t.mockInput.pressKey("c", { ctrl: true });
  await t.waitForFrame((frame) => frame.includes("Halt 2 live Runs and quit?"));
  assert.equal(exits.length, 0);
  assert.equal(
    t.captureCharFrame().match(/Halt 2 live Runs and quit\?/g)?.length,
    1,
  );
  t.mockInput.pressArrow("right");
  t.mockInput.pressEnter();
  await t.waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [undefined]);
});

test("the quit confirmation defaults to keeping live Runs and stays on Home", async () => {
  const { t, exits } = await mountApproved(2);
  t.mockInput.pressKey("c", { ctrl: true });
  await t.waitForFrame((frame) => frame.includes("Halt 2 live Runs and quit?"));
  t.mockInput.pressEnter();
  await t.waitForFrame(
    (frame) => !frame.includes("Halt 2 live Runs and quit?"),
  );
  assert.equal(exits.length, 0);
  assert.match(t.captureCharFrame(), /Secant/);
  assert.match(t.captureCharFrame(), /Workflow Bundles/);
});

test("m10-home-and-preferences: Home orders six commands and arrives with search focused and no selection", async () => {
  const { t, exits } = await mountApproved(2);
  const frame = t.captureCharFrame();
  const names = [
    "Start a Run",
    "Workflow Bundles",
    "Previous Runs",
    "Harnesses",
    "Themes",
    "Quit",
  ];
  const positions = names.map((name) => frame.indexOf(name));
  assert.ok(
    positions.every(
      (pos, index) => pos >= 0 && (index === 0 || pos > positions[index - 1]!),
    ),
  );
  assert.doesNotMatch(frame, /› Start a Run/);
  assert.match(frame, /0 installed Bundles · 2 previous Runs/);
  assert.doesNotMatch(frame, /qualified/);
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Search commands/);
  assert.deepEqual(exits, []);
});

test("Home shows the Workspace summary's total without opening Previous Runs history", async () => {
  const { t, setSummary } = await mountApproved(runSummary(0, 101));
  assert.match(t.captureCharFrame(), /0 installed Bundles · 101 previous Runs/);

  setSummary(runSummary(0, 1));
  await t.waitForFrame((frame) => /· 1 previous Run\s*$/m.test(frame));
});

test("Home says previous Runs are unavailable rather than a false zero", async () => {
  const { t } = await mountApproved({
    previousRuns: { state: "unavailable" },
    ownedLiveRuns: { state: "known", count: 0 },
  });
  assert.match(
    t.captureCharFrame(),
    /0 installed Bundles · previous Runs unavailable/,
  );
});

test("Ctrl+C reads the summary's current owned-live count, not the count at mount", async () => {
  const { t, exits, setSummary } = await mountApproved(0);
  setSummary(runSummary(2));
  await t.renderOnce();
  t.mockInput.pressKey("c", { ctrl: true });
  await t.waitForFrame((frame) => frame.includes("Halt 2 live Runs and quit?"));
  assert.deepEqual(exits, []);
});

for (const size of [
  { width: 70, height: 18 },
  { width: 40, height: 16 },
]) {
  test(`Ctrl+C with an unreadable owned-live count asks once and keeps running by default (${size.width}x${size.height})`, async () => {
    const { t, exits } = await mountApproved(
      {
        previousRuns: { state: "known", count: 3 },
        ownedLiveRuns: { state: "unavailable" },
      },
      [],
      size,
    );
    t.mockInput.pressKey("c", { ctrl: true });
    await t.waitForFrame((frame) => frame.includes("Halt live Runs and quit?"));
    const frame = t.captureCharFrame();
    assert.equal(frame.match(/Halt live Runs and quit\?/g)?.length, 1);
    assert.match(frame, /could not read/);
    assert.match(frame, /› Keep Running/);
    for (const line of frame.split("\n")) {
      assert.ok(line.length <= size.width, `overflow: ${JSON.stringify(line)}`);
    }
    // Home's bindings stay suppressed under the dialog: down moves no menu entry.
    t.mockInput.pressArrow("down");
    t.mockInput.pressEnter(); // the default, Keep Running
    await t.waitForFrame((f) => !f.includes("Halt live Runs and quit?"));
    assert.deepEqual(exits, []);
    assert.doesNotMatch(t.captureCharFrame(), /› Start a Run/);

    // Quit stays available: one more q, then Halt and Quit.
    t.mockInput.pressKey("c", { ctrl: true });
    await t.waitForFrame((f) => f.includes("Halt live Runs and quit?"));
    t.mockInput.pressArrow("right");
    t.mockInput.pressEnter();
    await t.waitFor(() => exits.length === 1);
    assert.deepEqual(exits, [undefined]);
  });
}

test("layout fits a small width and after resize without overflow", async () => {
  const { t } = await mount(40, 12);
  await t.waitForFrame((f) => f.includes(PATH));
  const narrow = t.captureCharFrame();
  for (const line of narrow.split("\n")) {
    assert.ok(
      line.length <= 40,
      `line overflows 40 cols: ${JSON.stringify(line)}`,
    );
  }
  t.resize(30, 10);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(
      line.length <= 30,
      `line overflows 30 cols after resize: ${JSON.stringify(line)}`,
    );
  }
});

// --- authoritative-run-summary (#396) ----------------------------------------
//
// Home and the guarded quit over a real Application and Run Store: mixed history,
// foreign ownership, damage, and an admitted launch, with the Workspace summary
// followed through the Projection Port into the renderer.

test("authoritative-run-summary: Home and the guarded quit follow a real Application's summary", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-summary-home-"));
  t.after(() => catalog.close());
  const workspace = realpath(makeTempDir("secant-summary-ws-"));
  const storeHome = makeTempDir("secant-summary-store-");
  const runGroup = openRunGroup(storeHome, workspace);
  t.after(() => runGroup.close());
  const process = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: () => ({
      kind: "exited",
      status: 0,
      text: new Uint8Array(),
    }),
  });
  const pending: (() => void | Promise<void>)[] = [];
  const app = createApplication({
    catalog,
    process,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process,
      }),
    scheduleSettlement: (settle) => void pending.push(settle),
  });
  catalog.approveWorkspace(workspace, new Date());
  const cmd = writeCommandBundle();
  assert.ok(app.bundleManagement.build(cmd.folder, { noInstall: false }).ok);
  const digest = catalog.listEntries().find((e) => e.id === cmd.id)!.digest;

  // History: one rested Run, one whose record is damaged, one live in pid 1000.
  const seed = (group: typeof runGroup): string => {
    const created = group.createRun({
      operationId: randomUUID(),
      bundleSnapshotDigest: digest,
      launch: {},
      at: new Date(),
    });
    if (created.outcome !== "created") throw new Error("unreachable");
    return created.runId;
  };
  runGroup.endRun(seed(runGroup));
  const damaged = seed(runGroup);
  runGroup.endRun(damaged);
  const groupDir = join(
    storeHome,
    "runs",
    readdirSync(join(storeHome, "runs"))[0]!,
  );
  const raw = new Database(join(groupDir, damaged, "run.db"));
  raw.run("UPDATE run_record SET selected_harness = ?", ["unknown"]);
  raw.close();
  const foreign = openRunGroup(storeHome, workspace, { selfPid: 1000 });
  seed(foreign);
  foreign.close();

  // The Workspace Projection followed into a signal, as the live seam does.
  const opened = app.projectionPort.openProjection({ family: "workspace" });
  t.after(() => opened.close());
  const [snapshot, setSnapshot] = createSignal(opened.snapshot);
  void (async () => {
    for await (const update of opened.updates) {
      if (update.kind === "durable") setSnapshot(update.snapshot);
    }
  })();
  const exits: unknown[] = [];
  const rendered = await testRender(
    () => (
      <App
        preferences={inertPreferencesView()}
        view={{ snapshot, approve() {} }}
        bundles={emptyBundles()}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={inertRunWorkbenchView()}
        runList={unopenedRunList()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        reducedMotion={false}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width: 70, height: 18 },
  );
  await rendered.waitForFrame((f) => f.includes("· 2 previous Runs"));

  // Admission: the launched Run is live here before it settles.
  const launched = app.projectionPort.submit({
    operationId: randomUUID(),
    operation: "launch-run",
    input: { bundle: { id: cmd.id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(launched.admitted, JSON.stringify(launched));
  await rendered.waitForFrame((f) => f.includes("· 3 previous Runs"));
  rendered.mockInput.pressKey("c", { ctrl: true });
  await rendered.waitForFrame((f) => f.includes("Halt 1 live Run and quit?"));
  rendered.mockInput.pressEnter(); // the default, Keep Running
  await rendered.waitForFrame((f) => !f.includes("Halt 1 live Run and quit?"));
  assert.deepEqual(exits, []);

  // Rest and release: nothing is live here any more, so q quits at once.
  for (const settle of pending.splice(0)) await settle();
  await until(() => {
    const owned = snapshot().runSummary.ownedLiveRuns;
    return owned.state === "known" && owned.count === 0;
  });
  rendered.mockInput.pressKey("c", { ctrl: true });
  await rendered.waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [undefined]);
});
