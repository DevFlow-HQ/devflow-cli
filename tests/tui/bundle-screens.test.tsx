import assert from "node:assert/strict";
import { test } from "node:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import {
  inertHarnessCatalogView,
  inertLaunchPreparationView,
  inertRunActionsView,
  inertRunListView,
} from "./inert.js";
import type {
  BundleCatalogView,
  RunLaunchView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  InstalledBundleFocus,
  InstalledBundleSummary,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests over fake `bundle-catalog` snapshots: the list, the
// empty state, and the inspection view. Content present, key bindings
// dispatching (Enter opens, Escape returns with focus restored, q quits),
// small-width and resize relayout without overflow, and a focus indicator that
// reads without colour (#57 AC1–AC4).

const WORKSPACE = "/tmp/secant-demo-workspace";

/** An already-approved Workspace so Home is interactive at mount. */
function approvedWorkspace(): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 3,
    startupNotices: [],
    harnesses: [],
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

function summary(
  over: Partial<InstalledBundleSummary> &
    Pick<InstalledBundleSummary, "id" | "version" | "name">,
): InstalledBundleSummary {
  return {
    digest: "a1b2c3",
    description: "",
    origin: { kind: "local-file", location: "/bundles/x.wfb" },
    shippedWithRunningSecant: false,
    stability: "stable",
    platforms: ["macos", "linux", "windows"],
    engine: { range: ">=0.1.0", satisfied: true },
    trust: { state: "not-yet-trusted" },
    ...over,
  };
}

// Sorted by name then version descending, as the Projection guarantees.
const ROWS: InstalledBundleSummary[] = [
  summary({
    id: "com.example.alpha",
    version: "1.0.0",
    name: "Alpha Flow",
    engine: {
      range: ">=0.2.0",
      satisfied: false,
      note: "needs Secant ≥ 0.2",
    },
  }),
  summary({
    id: "com.example.proof",
    version: "2.0.0",
    name: "Proof Bundle",
    description: "Proof of the pipeline",
  }),
  summary({
    id: "com.example.proof",
    version: "1.0.0",
    name: "Proof Bundle",
    stability: "prerelease",
  }),
];

const PROOF_FOCUS: InstalledBundleFocus = {
  ...summary({
    id: "com.example.proof",
    version: "2.0.0",
    name: "Proof Bundle",
    description: "Proof of the pipeline",
  }),
  author: { authors: ["Ada"], license: "MIT" },
  launchInputs: [{ name: "target", type: "text", description: "the goal" }],
  routing: [
    { node: "step", step: { id: "plan", kind: "agent" } },
    {
      node: "repeat",
      until: "done",
      reviewCheckpoint: { interval: 3, message: "check in" },
      steps: [
        { id: "work", kind: "agent" },
        { id: "build", kind: "command" },
      ],
    },
  ],
  workspacePrerequisites: ["git"],
  producedArtifacts: [
    { name: "report", type: "file", home: "workspace", producedBy: "plan" },
  ],
  executionSummary: {
    platform: "macos",
    identity: { id: "com.example.proof", version: "2.0.0" },
    digest: "a1b2c3",
    origin: { kind: "local-file", location: "/bundles/x.wfb" },
    platforms: ["macos", "linux", "windows"],
    stepKindCounts: { agent: 2, command: 1 },
    commands: [
      {
        stepId: "build",
        executable: "make",
        environmentVariableNames: ["CI"],
        scripts: ["build.sh"],
      },
    ],
    warning: "Bundles can run arbitrary code.",
  },
  compositionFindings: [
    {
      code: "C001",
      severity: "warning",
      target: "plan",
      explanation: "no timeout",
    },
  ],
};

function bundles(rows: InstalledBundleSummary[]): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: rows },
  });
  return {
    openList: () => list,
    openFocus(selector: BundleFocusSelector) {
      const selected = rows.find(
        (row) => row.id === selector.id && row.version === selector.version,
      );
      const bundle =
        selector.id === PROOF_FOCUS.id &&
        selector.version === PROOF_FOCUS.version
          ? PROOF_FOCUS
          : selected === undefined
            ? undefined
            : {
                ...selected,
                author: {},
                launchInputs: [],
                routing: [],
                workspacePrerequisites: [],
                producedArtifacts: [],
                executionSummary: {
                  platform: "macos" as const,
                  identity: { id: selected.id, version: selected.version },
                  digest: selected.digest,
                  origin: selected.origin,
                  platforms: selected.platforms,
                  stepKindCounts: {},
                  commands: [],
                  warning: "Bundles can run arbitrary code.",
                },
                compositionFindings: [],
              };
      const [focus] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result:
          bundle !== undefined
            ? { found: true, bundle }
            : {
                found: false,
                problem: {
                  code: "not-found",
                  explanation: "No such Bundle.",
                  remediation: "Run `secant bundle list`.",
                  possibleEffects: "none",
                },
              },
      });
      return focus;
    },
  };
}

/** The Bundle screens never launch; a stub launch seam satisfies the App prop. */
function noLaunch(): RunLaunchView {
  return { launch: () => () => ({ kind: "pending" }) };
}

/** The Bundle screens never open the Run Workbench; these stubs satisfy the two
 *  App props the Workbench needs (#91). */
function noRunView(): RunWorkbenchView {
  return {
    openRun() {
      throw new Error("run workbench not used in this test");
    },
    readResource() {
      throw new Error("run workbench not used in this test");
    },
    readTranscript() {
      throw new Error("run workbench not used in this test");
    },
    answer() {
      throw new Error("run workbench not used in this test");
    },
    sendInteractiveTurn() {
      throw new Error("run workbench not used in this test");
    },
    sendFollowUpTurn() {
      throw new Error("run workbench not used in this test");
    },
    endInteractiveStep() {
      throw new Error("run workbench not used in this test");
    },
    continueRepeat() {
      throw new Error("run workbench not used in this test");
    },
    endStage() {
      throw new Error("run workbench not used in this test");
    },
    steer() {
      throw new Error("run workbench not used in this test");
    },
    answerText() {
      throw new Error("run workbench not used in this test");
    },
    answerRequest() {
      throw new Error("run workbench not used in this test");
    },
  };
}

async function mount(rows = ROWS, width = 80, height = 40) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={bundles(rows)}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        reducedMotion={false}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  return { t, exits };
}

/** The single list line carrying the selection glyph identifies the selected row. */
function selectedLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("│ › ")) ?? "";
}

type TRendered = Awaited<ReturnType<typeof mount>>["t"];

/** Home → Workflow Bundles, waiting for the catalog's arrival frame. */
async function openCatalog(t: TRendered) {
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Proof Bundle"));
}

/** The styled span of the list row titled `title`, and the screen background. */
function rowSpan(t: TRendered, title: string) {
  const frame = t.captureSpans();
  const background = frame.lines[0]?.spans[0]?.bg;
  for (const line of frame.lines) {
    const span = line.spans.find((candidate) =>
      [`› ${title}`, `  ${title}`].includes(candidate.text.trimEnd()),
    );
    if (span !== undefined) return { span, background };
  }
  throw new Error(`no row titled '${title}'`);
}

test("bundle-catalog-two-pane: one catalog shows installed count, sorted rows, and visible focus", async () => {
  const { t } = await mount();
  await openCatalog(t);
  const arrival = t.captureCharFrame();
  assert.match(arrival, /3 installed/);
  assert.match(arrival, /› Find an installed Bundle/);
  assert.match(arrival, / {2}Results/);
  assert.match(arrival, /Inspector/);
  // Arriving from Home focuses search with nothing selected and no details.
  assert.equal(selectedLine(arrival), "");
  assert.match(arrival, /No Bundle selected/);
  assert.doesNotMatch(arrival, /No launch inputs/);

  t.mockInput.pressArrow("down"); // search -> list, selecting the top result
  await t.waitForFrame((f) => f.includes("No launch inputs"));
  const frame = t.captureCharFrame();
  assert.match(frame, /› Results/);
  assert.match(frame, /Alpha Flow/);
  assert.match(frame, /com\.example\.alpha@1\.0\.0/);
  assert.match(frame, /local-file/);
  assert.match(frame, /No launch inputs/);
  assert.match(frame, /Start a Run proceeds from Harness to/);
  // Sorted: name asc (Alpha before Proof), then version desc (2.0.0 before 1.0.0).
  assert.ok(frame.indexOf("Alpha Flow") < frame.indexOf("Proof Bundle"));
  assert.ok(
    frame.indexOf("com.example.proof@2.0.0") <
      frame.indexOf("com.example.proof@1.0.0"),
  );
  // Selection glyph on the first row, readable without colour.
  assert.match(selectedLine(frame), /Alpha Flow/);
});

test("Workflow Bundles searches the existing list snapshot and keeps the inspector on one screen", async () => {
  const { t } = await mount();
  await openCatalog(t);

  const initial = t.captureCharFrame();
  assert.match(initial, /Find an installed Bundle/);
  assert.match(initial, /Alpha Flow/);
  assert.match(initial, /com\.example\.alpha@1\.0\.0/);

  await t.mockInput.typeText("pipeline");
  await t.waitForFrame((frame) => !frame.includes("Alpha Flow"));
  const filtered = t.captureCharFrame();
  assert.match(filtered, /Proof Bundle/);
  assert.doesNotMatch(filtered, /Alpha Flow/);
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("Proof of the pipeline"));
  t.mockInput.pressArrow("up"); // the top result returns to search
  await t.waitForFrame((frame) => frame.includes("› Find an installed Bundle"));

  const replaceQuery = async (current: string, next: string) => {
    for (let index = 0; index < current.length; index += 1) {
      t.mockInput.pressBackspace();
    }
    await t.mockInput.typeText(next);
  };
  await replaceQuery("pipeline", "com.example.alpha");
  await t.waitForFrame((frame) => frame.includes("Alpha Flow"));
  assert.doesNotMatch(t.captureCharFrame(), /Proof Bundle/);

  await replaceQuery("com.example.alpha", "/bundles/x.wfb");
  await t.waitForFrame((frame) => frame.includes("Proof Bundle"));
  assert.match(t.captureCharFrame(), /Alpha Flow/);

  await replaceQuery("/bundles/x.wfb", "Alpha Flow");
  await t.waitForFrame((frame) => !frame.includes("Proof Bundle"));
  assert.match(t.captureCharFrame(), /Alpha Flow/);
  assert.doesNotMatch(t.captureCharFrame(), /Proof Bundle/);

  await replaceQuery("Alpha Flow", "missing");
  await t.waitForFrame(
    (frame) =>
      frame.includes("No matching Workflow") && frame.includes("Bundles"),
  );
  const empty = t.captureCharFrame();
  assert.match(empty, /Try a different name, id/);
  assert.match(empty, /description, or origin/);
});

test("a trusted Bundle uses the shared Trust wording in its inspector", async () => {
  const trustedSummary = summary({
    id: "com.example.trusted",
    version: "1.0.0",
    name: "Trusted Flow",
    trust: {
      state: "trusted",
      operationId: "op-1",
      grantedAt: "2026-09-12T09:00:00.000Z",
    },
  });
  const trustedFocus: InstalledBundleFocus = {
    ...PROOF_FOCUS,
    ...trustedSummary,
    description: "A trusted pipeline",
  };
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [trustedSummary] },
  });
  const view: BundleCatalogView = {
    openList: () => list,
    openFocus(selector: BundleFocusSelector) {
      const [focus] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result: { found: true, bundle: trustedFocus },
      });
      return focus;
    },
  };
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={view}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        reducedMotion={false}
        exit={() => {}}
      />
    ),
    { width: 80, height: 40 },
  );
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Trusted Flow"));
  t.mockInput.pressArrow("down"); // select the top result
  await t.waitForFrame((f) => f.includes("A trusted pipeline"));
  assert.match(t.captureCharFrame(), /trusted \(granted 2026-09-12/);
});

test("a built-in reads its Secant release, the shipped marker, and app-release trust", async () => {
  const { t } = await mount(
    [
      summary({
        id: "dev.secant.shipped",
        version: "2.0.0",
        name: "Shipped Flow",
        origin: { kind: "built-in", secantVersion: "1.1.0" },
        shippedWithRunningSecant: true,
        trust: { state: "app-release" },
      }),
    ],
    140,
  );
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Shipped Flow"));
  t.mockInput.pressArrow("down"); // select the top result
  await t.waitForFrame((f) => f.includes("trusted (app release)"));
  assert.match(
    t.captureCharFrame(),
    /Built-in, shipped with Secant 1\.1\.0 · in this release/,
  );
});

test("empty Catalog names the headless install commands", async () => {
  const { t } = await mount([]);
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame(
    (f) => f.includes("No installed Workflow") && f.includes("Bundles"),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Install one with `secant/);
  assert.match(frame, /bundle build` or `secant/);
  assert.match(frame, /bundle install`/);
});

test("a list whose managed bytes are gone shows the Problem, not rows (#74 A3)", async () => {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: {
      found: false,
      problem: {
        code: "bundle-bytes-missing",
        explanation: "Its stored bytes are missing.",
        remediation: "Reinstall the Bundle to restore its bytes.",
        possibleEffects: "none",
      },
    },
  });
  const view: BundleCatalogView = {
    openList: () => list,
    openFocus: () => {
      throw new Error("not used");
    },
  };
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={view}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        reducedMotion={false}
        exit={() => {}}
      />
    ),
    { width: 80, height: 40 },
  );
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Catalog error"));
  const frame = t.captureCharFrame();
  assert.match(frame, /bundle-bytes-missing/);
  assert.match(frame, /Reinstall the Bundle/);
  assert.doesNotMatch(frame, /Catalog is empty/);
});

test("a focused Bundle whose managed bytes are gone shows its Problem", async () => {
  const row = summary({
    id: "com.example.missing",
    version: "1.0.0",
    name: "Missing Bytes",
  });
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [row] },
  });
  const view: BundleCatalogView = {
    openList: () => list,
    openFocus(selector) {
      const [focus] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result: {
          found: false,
          problem: {
            code: "bundle-bytes-missing",
            explanation: "The selected Bundle's managed bytes are missing.",
            remediation: "Reinstall it.",
            possibleEffects: "none",
          },
        },
      });
      return focus;
    },
  };
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={view}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        reducedMotion={false}
        exit={() => {}}
      />
    ),
    { width: 80, height: 24 },
  );
  await t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Missing Bytes"));
  t.mockInput.pressArrow("down"); // select the top result
  await t.waitForFrame(
    (frame) =>
      frame.includes("The selected Bundle's managed bytes are") &&
      frame.includes("missing."),
  );
  assert.match(t.captureCharFrame(), /Missing Bytes/);
});

test("moving the result focus updates the inspector with numbered Workflow commands and allowed facts", async () => {
  const { t } = await mount();
  await openCatalog(t);
  t.mockInput.pressArrow("down"); // search -> list, selecting Alpha Flow
  t.mockInput.pressArrow("down"); // select the second row (Proof Bundle 2.0.0)
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
  );
  await t.waitForFrame((f) => f.includes("Proof of the pipeline"));
  const focus = t.captureCharFrame();
  // The accepted catalog facts, including shared Trust wording and generated
  // Execution summary, stay on the same screen as the result list.
  assert.match(focus, /Proof of the pipeline/);
  assert.match(focus, /sha256:a1b2c3/);
  assert.match(focus, />=0\.1\.0/);
  assert.match(focus, /not yet trusted/);
  assert.match(focus, /target \(text\).*the goal/s);
  assert.match(focus, /1\. plan \(agent\)/);
  assert.match(focus, /2\. Repeat until done/);
  assert.match(focus, /2\.2\. build \(command\)/);
  assert.match(focus, /\$ make/);
  assert.match(focus, /git/);
  assert.match(focus, /Execution summary · macos/);
  assert.match(focus, /make/);
  assert.match(focus, /Warning · Bundles can run arbitrary code/);
  assert.doesNotMatch(focus, /Ada|report \(file\)|C001/);
  assert.doesNotMatch(
    focus,
    /acknowledge trust|install Bundle|uninstall|launch Bundle/i,
  );
  assert.match(selectedLine(focus), /Proof Bundle/);
});

test("pane focus is visible and inspector scrolling clamps at both ends", async () => {
  const { t } = await mount(ROWS, 80, 18);
  await openCatalog(t);
  t.mockInput.pressArrow("down"); // search -> list, selecting Alpha Flow
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("Proof of the pipeline"));

  assert.match(t.captureCharFrame(), /› Results/);
  t.mockInput.pressTab();
  await t.waitForFrame((frame) => frame.includes("› Inspector"));
  const top = t.captureCharFrame();
  // The selection keeps its glyph while another pane has focus.
  assert.match(selectedLine(top), /Proof Bundle/);
  t.mockInput.pressArrow("left");
  await t.waitForFrame((frame) => frame.includes("› Results"));
  t.mockInput.pressArrow("right");
  await t.waitForFrame((frame) => frame.includes("› Inspector"));
  t.mockInput.pressKey("\u001B[6~");
  await t.renderOnce();
  assert.notEqual(t.captureCharFrame(), top);
  t.mockInput.pressKey("\u001B[5~");
  await t.renderOnce();
  assert.equal(t.captureCharFrame(), top);

  for (let index = 0; index < 60; index += 1) {
    t.mockInput.pressArrow("down");
  }
  await t.renderOnce();
  const bottom = t.captureCharFrame();
  assert.match(bottom, /Warning · Bundles can run arbitrary code/);
  assert.doesNotMatch(bottom, /Proof of the pipeline/);

  t.mockInput.pressKey("\u001B[6~");
  await t.renderOnce();
  assert.equal(t.captureCharFrame(), bottom);

  for (let index = 0; index < 60; index += 1) {
    t.mockInput.pressArrow("up");
  }
  await t.renderOnce();
  assert.equal(t.captureCharFrame(), top);
  t.mockInput.pressKey("\u001B[5~");
  await t.renderOnce();
  assert.equal(t.captureCharFrame(), top);
});

// The tests from here to "search owns printable keys…" are the one home for the
// shared catalog navigation (`catalog-navigation.tsx`); the Harness catalog test
// proves the same moves once over its own screen.
test("a drawn separator divides the search pane from the results", async () => {
  for (const [width, height] of [
    [80, 40],
    [50, 30],
  ] as const) {
    const { t } = await mount(ROWS, width, height);
    await openCatalog(t);
    const lines = t.captureCharFrame().split("\n");
    const search = lines.findIndex((line) =>
      line.includes("Find an installed Bundle"),
    );
    const results = lines.findIndex((line) => line.includes("Results"));
    assert.ok(search >= 0 && results > search);
    assert.match(lines[search + 1] ?? "", /name, id, description/);
    // The search pane's own bottom edge is drawn before the results pane opens.
    assert.match(lines[results - 1] ?? "", /└─+┘/);
    assert.equal(results, search + 3);
  }
});

test("arriving from Home clears the selection, so it does not survive a Home round-trip", async () => {
  const { t } = await mount();
  await openCatalog(t);
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
  );
  t.mockInput.pressEscape();
  await until(() => /^ Secant\s*$/m.test(t.captureCharFrame()));
  t.mockInput.pressEnter(); // Workflow Bundles stays highlighted on Home
  await t.waitForFrame((f) => f.includes("Proof Bundle"));
  const arrival = t.captureCharFrame();
  assert.equal(selectedLine(arrival), "");
  assert.match(arrival, /› Find an installed Bundle/);
  assert.match(arrival, /No Bundle selected/);
  assert.doesNotMatch(arrival, /Proof of the pipeline/);
});

test("search owns ←, →, Home, End, and / as text-cursor keys", async () => {
  const { t } = await mount();
  await openCatalog(t);
  await t.mockInput.typeText("lpha");
  t.mockInput.pressKey("HOME");
  await t.mockInput.typeText("a");
  t.mockInput.pressKey("END");
  await t.mockInput.typeText("!");
  t.mockInput.pressArrow("left");
  t.mockInput.pressArrow("left");
  t.mockInput.pressArrow("right");
  await t.mockInput.typeText("/");
  await t.waitForFrame((f) => f.includes("alpha/!"));
  const frame = t.captureCharFrame();
  // Every key edited the query; none moved focus off search.
  assert.match(frame, /› Find an installed Bundle/);
  assert.match(frame, / {2}Results/);
  assert.match(frame, / {2}Inspector/);
  assert.match(frame, /No matching Workflow/);
});

test("Down, PgDn, Up, Tab, and / move focus between search, results, and inspector", async () => {
  const { t } = await mount();
  await openCatalog(t);
  const focusedPane = () => {
    const frame = t.captureCharFrame();
    return ["Find an installed Bundle", "Results", "Inspector"].filter(
      (title) => frame.includes(`› ${title}`),
    );
  };

  // PgDn, like Down, moves search to the list and selects the top result.
  t.mockInput.pressKey("\u001B[6~");
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Alpha"),
  );
  assert.deepEqual(focusedPane(), ["Results"]);
  t.mockInput.pressArrow("down");
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
  );
  t.mockInput.pressArrow("up");
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Alpha"),
  );
  assert.deepEqual(focusedPane(), ["Results"]);
  // Up on the top result returns to search and keeps the selection.
  t.mockInput.pressArrow("up");
  await t.waitForFrame(() => focusedPane()[0] === "Find an installed Bundle");
  assert.match(selectedLine(t.captureCharFrame()), /Alpha Flow/);
  assert.match(t.captureCharFrame(), /No launch inputs/);

  // Tab cycles search → results → inspector → search, keeping the selection.
  t.mockInput.pressTab();
  await t.waitForFrame(() => focusedPane()[0] === "Results");
  assert.match(selectedLine(t.captureCharFrame()), /Alpha Flow/);
  t.mockInput.pressTab();
  await t.waitForFrame(() => focusedPane()[0] === "Inspector");
  t.mockInput.pressTab();
  await t.waitForFrame(() => focusedPane()[0] === "Find an installed Bundle");

  // `/` focuses search from the inspector and from the results.
  t.mockInput.pressTab();
  t.mockInput.pressTab();
  await t.waitForFrame(() => focusedPane()[0] === "Inspector");
  t.mockInput.pressKey("/");
  await t.waitForFrame(() => focusedPane()[0] === "Find an installed Bundle");
  t.mockInput.pressTab();
  await t.waitForFrame(() => focusedPane()[0] === "Results");
  t.mockInput.pressKey("/");
  await t.waitForFrame(() => focusedPane()[0] === "Find an installed Bundle");
  // Neither `/` reached the query.
  assert.match(t.captureCharFrame(), /name, id, description/);

  // Down from search selects the top result even over a kept selection, and a
  // query that filters the selection out clears it.
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
  );
  t.mockInput.pressKey("/");
  await t.waitForFrame(() => focusedPane()[0] === "Find an installed Bundle");
  t.mockInput.pressArrow("down");
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Alpha"),
  );
  t.mockInput.pressKey("/");
  await t.waitForFrame(() => focusedPane()[0] === "Find an installed Bundle");
  await t.mockInput.typeText("pipeline");
  await t.waitForFrame((f) => !f.includes("Alpha Flow"));
  assert.equal(selectedLine(t.captureCharFrame()), "");
  assert.match(t.captureCharFrame(), /No Bundle selected/);
});

test("Tab from search takes the top result only when nothing is kept, and a click selects a row", async () => {
  const { t } = await mount();
  await openCatalog(t);
  t.mockInput.pressTab();
  await t.waitForFrame((f) => f.includes("› Results"));
  assert.match(selectedLine(t.captureCharFrame()), /Alpha Flow/);
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("Proof of the pipeline"));
  t.mockInput.pressKey("/");
  await t.waitForFrame((f) => f.includes("› Find an installed Bundle"));
  t.mockInput.pressTab();
  await t.waitForFrame((f) => f.includes("› Results"));
  assert.match(t.captureCharFrame(), /Proof of the pipeline/);
  assert.match(
    t.captureCharFrame(),
    /│ › Proof Bundle[^\n]*\n[^\n]*com\.example\.proof@2\.0\.0/,
  );

  // A click from search selects that row and focuses the results.
  t.mockInput.pressKey("/");
  await t.waitForFrame((f) => f.includes("› Find an installed Bundle"));
  const lines = t.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("│   Alpha Flow"));
  assert.ok(y >= 0);
  await t.mockMouse.click(lines[y]!.indexOf("Alpha Flow"), y);
  await t.waitForFrame((f) => f.includes("No launch inputs"));
  assert.match(selectedLine(t.captureCharFrame()), /Alpha Flow/);
  assert.match(t.captureCharFrame(), /› Results/);
});

test("the selected row is filled and bold, and keeps its glyph with colour off", async () => {
  const { t } = await mount();
  await openCatalog(t);
  t.mockInput.pressArrow("down");
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Alpha"),
  );

  const selected = rowSpan(t, "Alpha Flow");
  const other = rowSpan(t, "Proof Bundle");
  assert.ok(selected.span.text.includes("› Alpha Flow"));
  assert.ok(!other.span.text.includes("›"));
  assert.ok(selected.span.attributes & TextAttributes.BOLD);
  assert.equal(other.span.attributes & TextAttributes.BOLD, 0);
  assert.ok(!selected.span.bg.equals(selected.background));
  assert.ok(!selected.span.bg.equals(other.span.bg));

  // With focus elsewhere the kept selection stays filled, bold, and marked.
  t.mockInput.pressTab();
  await t.waitForFrame((f) => f.includes("› Inspector"));
  const kept = rowSpan(t, "Alpha Flow");
  assert.ok(kept.span.text.includes("› Alpha Flow"));
  assert.ok(kept.span.attributes & TextAttributes.BOLD);
  assert.ok(!kept.span.bg.equals(kept.background));
});

test("small terminals stack the result and inspector panes without overflow", async () => {
  const { t } = await mount(ROWS, 50, 24);
  await t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Inspector"));
  const frame = t.captureCharFrame();
  const lines = frame.split("\n");
  const resultsLine = lines.findIndex((line) =>
    line.includes("Find an installed Bundle"),
  );
  const inspectorLine = lines.findIndex((line) => line.includes("Inspector"));
  assert.ok(resultsLine >= 0);
  assert.ok(inspectorLine > resultsLine);
  assert.equal(
    lines.some(
      (line) =>
        line.includes("Find an installed Bundle") && line.includes("Inspector"),
    ),
    false,
  );
  for (const line of lines) {
    assert.ok(line.length <= 50, `overflows 50 cols: ${JSON.stringify(line)}`);
  }
});

test("Back returns to Home or the originating Start a Run Bundle step", async () => {
  const homeRun = await mount();
  await openCatalog(homeRun.t);
  homeRun.t.mockInput.pressEscape();
  await until(
    () => !homeRun.t.captureCharFrame().includes("Find an installed Bundle"),
  );
  await homeRun.t.waitForFrame((frame) => /^ Secant\s*$/m.test(frame));
  assert.doesNotMatch(homeRun.t.captureCharFrame(), /Find an installed Bundle/);

  const startRun = await mount();
  await startRun.t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  startRun.t.mockInput.pressEnter(); // Start a Run is the first, default entry
  await startRun.t.waitForFrame((frame) => frame.includes("Start a Run"));
  startRun.t.mockInput.pressArrow("down");
  await startRun.t.waitForFrame((frame) => frame.includes("› Proof Bundle"));
  startRun.t.mockInput.pressKey("v");
  await startRun.t.waitForFrame((frame) =>
    frame.includes("Find an installed Bundle"),
  );
  // View Bundle Details arrives on the results with the chooser's Bundle selected.
  const details = startRun.t.captureCharFrame();
  assert.match(details, /Proof of the pipeline/);
  assert.match(details, /› Results/);
  assert.match(selectedLine(details), /Proof Bundle/);
  // A move in the catalog carries back to the chooser.
  startRun.t.mockInput.pressArrow("up");
  await startRun.t.waitForFrame(() =>
    selectedLine(startRun.t.captureCharFrame()).includes("Alpha Flow"),
  );
  startRun.t.mockInput.pressEscape();
  await until(
    () => !startRun.t.captureCharFrame().includes("Find an installed Bundle"),
  );
  await startRun.t.waitForFrame((frame) => /^ Start a Run\s*$/m.test(frame));
  assert.match(startRun.t.captureCharFrame(), /› Alpha Flow/);
});

test("search owns printable keys while Ctrl+C quits from any pane", async () => {
  const searchRun = await mount();
  await openCatalog(searchRun.t);
  searchRun.t.mockInput.pressKey("q");
  await searchRun.t.waitForFrame((frame) =>
    frame.includes("No matching Workflow"),
  );
  assert.equal(searchRun.exits.length, 0);
  searchRun.t.mockInput.pressCtrlC();
  await searchRun.t.waitFor(() => searchRun.exits.length > 0);
  assert.equal(searchRun.exits.length, 1);

  const inspectRun = await mount();
  await openCatalog(inspectRun.t);
  inspectRun.t.mockInput.pressArrow("down");
  await inspectRun.t.waitForFrame((f) => f.includes("› Results"));
  inspectRun.t.mockInput.pressKey("q");
  await inspectRun.t.renderOnce();
  inspectRun.t.mockInput.pressArrow("right");
  await inspectRun.t.waitForFrame((f) => f.includes("› Inspector"));
  inspectRun.t.mockInput.pressKey("q");
  await inspectRun.t.renderOnce();
  assert.equal(inspectRun.exits.length, 0);
  // Back on search after `/`, printable keys reach the query again.
  inspectRun.t.mockInput.pressKey("/");
  await inspectRun.t.waitForFrame((f) =>
    f.includes("› Find an installed Bundle"),
  );
  inspectRun.t.mockInput.pressKey("q");
  await inspectRun.t.waitForFrame((f) => f.includes("No matching Workflow"));
  assert.equal(inspectRun.exits.length, 0);
  inspectRun.t.mockInput.pressCtrlC();
  await inspectRun.t.waitFor(() => inspectRun.exits.length > 0);
  assert.equal(inspectRun.exits.length, 1);
});

test("long catalog content stays bounded at 80×24 without corrupting visible rows", async () => {
  async function openAt(height: number) {
    const { t } = await mount(ROWS, 80, height);
    await openCatalog(t);
    t.mockInput.pressArrow("down"); // search -> list, selecting Alpha Flow
    t.mockInput.pressArrow("down"); // select Proof Bundle 2.0.0
    await t.waitForFrame(() =>
      selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
    );
    await t.waitForFrame((f) => f.includes("Proof of the pipeline"));
    return t;
  }

  // Tall enough to show the whole focus, then too short for it. `captureCharFrame`
  // ends with a trailing newline, so drop the final empty element.
  const rows = (frame: string) => {
    const lines = frame.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  const full = rows((await openAt(40)).captureCharFrame());
  const clipped = rows((await openAt(24)).captureCharFrame());

  // No horizontal overflow, and no rows past the box height.
  for (const line of clipped) {
    assert.ok(line.length <= 80, `overflows 80 cols: ${JSON.stringify(line)}`);
  }
  assert.ok(clipped.length <= 24, `rendered ${clipped.length} rows past 24`);

  // The overflow guard clips the bottom and keeps every visible row intact, so
  // the top of the short render matches the tall one line-for-line. Without
  // overflow="hidden" + flexShrink={0} the fixed-height column shrinks every row
  // and the two diverge.
  assert.deepEqual(clipped.slice(0, 10), full.slice(0, 10));
});

test("list fits a small width and after resize without overflow", async () => {
  const { t } = await mount(ROWS, 40, 20);
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Proof Bundle"));
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(line.length <= 40, `overflows 40 cols: ${JSON.stringify(line)}`);
  }
  t.resize(30, 16);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(
      line.length <= 30,
      `overflows 30 cols after resize: ${JSON.stringify(line)}`,
    );
  }
});
