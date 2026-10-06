import { inertPreferencesView } from "./inert.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import type {
  BundleCatalogSnapshot,
  HarnessCatalogSnapshot,
  HarnessFocus,
  HarnessFocusResult,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
  HarnessSummary,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";
import { App } from "../../src/tui/tui.js";
import type {
  BundleCatalogView,
  RunLaunchView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import {
  inertLaunchPreparationView,
  inertRunActionsView,
  inertRunListView,
  runSummary,
} from "./inert.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";

const QUALIFIED_CODEX: HarnessFocus = {
  id: "codex",
  name: "Codex",
  discovery: {
    state: "found",
    source: "path",
    description: "PATH name 'codex'",
  },
  qualification: {
    state: "qualified-with-limits",
    observation: {
      executable: "PATH name 'codex' -> /tools/codex",
      executableVersion: "1.2.3",
      platform: "linux",
      checkedAt: "2026-09-22T00:00:00.000Z",
    },
  },
  supportedModels: { kind: "list", models: ["gpt-5", "gpt-5-mini"] },
  modelDeclaration: {
    kind: "list",
    models: [
      {
        model: "gpt-5",
        label: "GPT-5",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      { model: "gpt-5-mini", label: "GPT-5 mini", efforts: [] },
    ],
  },
  harnessDefaults: {
    kind: "reported",
    choice: { model: "gpt-5", effort: "high" },
  },
  capabilities: [
    {
      capability: "session-recovery",
      name: "Session recovery",
      description: "Resume a Harness Session after process loss.",
      state: "available-with-limits",
      limits: "Reloads retained history before live activity.",
    },
    {
      capability: "same-turn-steering",
      name: "Same-Turn steering",
      description: "Send guidance while the current Turn is still working.",
      state: "unavailable",
    },
    {
      capability: "turn-interruption",
      name: "Turn interruption",
      description: "Stop the current Turn and its native work.",
      state: "available",
    },
    {
      capability: "tool-approvals",
      name: "Tool approvals",
      description: "Review tool actions raised by the Harness.",
      state: "available",
    },
    {
      capability: "structured-questions",
      name: "Structured questions",
      description: "Answer structured questions raised by the Harness.",
      state: "not-checked",
    },
    {
      capability: "effective-model",
      name: "Effective model",
      description: "Observe the model that actually served a Turn.",
      state: "available",
    },
  ],
  configurationPosture: "Uses the user's existing Codex configuration.",
};

const UNAVAILABLE_CLAUDE: HarnessFocus = {
  id: "claude-code",
  name: "Claude Code",
  discovery: {
    state: "found",
    source: "configured",
    description: "SECANT_CLAUDE_CODE",
  },
  qualification: {
    state: "not-ready",
    checkedAt: "2026-09-22T00:01:00.000Z",
  },
  capabilities: QUALIFIED_CODEX.capabilities.map((capability) => ({
    capability: capability.capability,
    name: capability.name,
    description: capability.description,
    state: "not-checked",
  })),
  authenticationInstructions:
    "Log in separately through Claude Code, then inspect it again.",
  unavailable: {
    code: "harness-qualification-unavailable",
    explanation: "Claude Code requires authentication.",
    remediation: "Log in separately through Claude Code.",
    possibleEffects: "none",
  },
};

function workspace(): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: "/tmp/secant-demo-workspace",
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 2,
    runSummary: runSummary(),
    startupNotices: [],
    harnesses: [],
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

function emptyBundles(): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [] },
  });
  return {
    openList: () => list,
    openFocus: () => {
      throw new Error("bundle catalog not used in this test");
    },
  };
}

function noLaunch(): RunLaunchView {
  return { launch: () => () => ({ kind: "pending" }) };
}

function noRun(): RunWorkbenchView {
  const unused = () => {
    throw new Error("run workbench not used in this test");
  };
  return {
    openHistory: unused,
    openRun: unused,
    readResource: unused,
    readTranscript: unused,
    answer: unused,
    sendInteractiveTurn: unused,
    sendFollowUpTurn: unused,
    endInteractiveStep: unused,
    continueRepeat: unused,
    endStage: unused,
    steer: unused,
    answerText: unused,
    answerRequest: unused,
  };
}

function harnesses() {
  const notChecked = (harness: HarnessFocus): HarnessSummary => ({
    id: harness.id,
    name: harness.name,
    discovery: harness.discovery,
    qualification: { state: "not-checked" },
  });
  const held = new Set<HarnessFocus["id"]>();
  const [list, setList] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: [notChecked(QUALIFIED_CODEX), notChecked(UNAVAILABLE_CLAUDE)],
  });
  const focused: HarnessFocusSelector[] = [];
  const closed: HarnessFocusSelector[] = [];
  const publishList = () => {
    setList({
      family: "harness-catalog",
      view: "list",
      harnesses: [
        held.has("codex") ? QUALIFIED_CODEX : notChecked(QUALIFIED_CODEX),
        held.has("claude-code")
          ? UNAVAILABLE_CLAUDE
          : notChecked(UNAVAILABLE_CLAUDE),
      ],
    });
  };
  return {
    view: {
      openList: () => list,
      openFocus(selector: HarnessFocusSelector) {
        focused.push(selector);
        onCleanup(() => closed.push(selector));
        const harness =
          selector.id === "codex"
            ? QUALIFIED_CODEX
            : selector.id === "claude-code"
              ? UNAVAILABLE_CLAUDE
              : undefined;
        if (harness === undefined) {
          throw new Error(`unexpected Harness focus '${selector.id}'`);
        }
        const newlyHeld = !held.has(harness.id);
        held.add(harness.id);
        if (newlyHeld) publishList();
        const [focus] = createSignal<HarnessFocusSnapshot>({
          family: "harness-catalog",
          view: "focus",
          selection: selector,
          result: { found: true, harness },
        });
        return focus;
      },
    },
    focused,
    closed,
  };
}

type TMountOptions = {
  width?: number;
  height?: number;
  catalog?: ReturnType<typeof harnesses>;
  /** Down from search selects the top row, as most tests need; default true. */
  selectTop?: boolean;
};

async function mount(options: TMountOptions = {}) {
  const width = options.width ?? 100;
  const height = options.height ?? 36;
  const catalog = options.catalog ?? harnesses();
  const t = await testRender(
    () => (
      <App
        preferences={inertPreferencesView()}
        view={workspace()}
        bundles={emptyBundles()}
        harnesses={catalog.view}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={noRun()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        reducedMotion={false}
        exit={() => {}}
      />
    ),
    { width, height },
  );
  await t.waitForFrame((frame) => frame.includes("Harnesses"));
  t.mockInput.pressArrow("down");
  assert.deepEqual(catalog.focused, []);
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Find a Harness"));
  await t.renderOnce();
  if (options.selectTop ?? true) {
    t.mockInput.pressArrow("down");
    await t.waitForFrame((frame) => frame.includes("│ › "));
  }
  return { t, focused: catalog.focused, closed: catalog.closed };
}

// A catalog whose list never changes; `result` answers each focus it opens.
function staticCatalog(
  list: readonly HarnessSummary[],
  result: (id: HarnessFocusSelector["id"]) => HarnessFocusResult,
) {
  const [snapshot] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: list,
  });
  const focused: HarnessFocusSelector[] = [];
  const closed: HarnessFocusSelector[] = [];
  return {
    view: {
      openList: () => snapshot,
      openFocus(selector: HarnessFocusSelector) {
        focused.push(selector);
        onCleanup(() => closed.push(selector));
        const [focus] = createSignal<HarnessFocusSnapshot>({
          family: "harness-catalog",
          view: "focus",
          selection: selector,
          result: result(selector.id),
        });
        return focus;
      },
    },
    focused,
    closed,
  };
}

// Side by side, a panel row reads `│ results │ │ inspector │`. The results
// pane is the first bordered column only on lines that open with its border;
// the inspector is always the last bordered column.
function resultsPane(frame: string): string {
  return frame
    .split("\n")
    .map((line) => (line.trimStart().startsWith("│") ? line.split("│")[1] : ""))
    .join("\n");
}

function inspectorPane(frame: string): string {
  return frame
    .split("\n")
    .map((line) => {
      const columns = line.split("│");
      return columns.length >= 3 ? columns[columns.length - 2] : "";
    })
    .join("\n");
}

test("harness-catalog-screen renders normalized rows and every inspector section", async () => {
  const { t, focused } = await mount({ width: 140, height: 44 });
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  const frame = t.captureCharFrame();

  assert.deepEqual(focused, [{ id: "codex" }]);
  assert.match(frame, /2 discovered · 1 qualified on this system/);
  assert.match(frame, /Find a Harness/);
  // The everyday row names status and models; discovery evidence stays in
  // the inspector.
  const results = resultsPane(frame);
  assert.match(
    results,
    /› Codex · Qualified with\s+limits\s+2 models observed/,
  );
  assert.match(results, /Claude Code · Not checked\s+Models not yet observed/);
  assert.doesNotMatch(results, /found via|PATH name/);
  assert.match(frame, /Discovery · found via PATH name 'codex'/);
  assert.match(frame, /Harness · codex/);
  assert.match(frame, /Executable · PATH name 'codex' -> \/tools\/codex/);
  assert.match(frame, /Version · 1\.2\.3/);
  assert.match(frame, /Platform · linux/);
  assert.match(frame, /Checked · 2026-09-22T00:00:00\.000Z/);
  assert.match(frame, /Authentication · Ready/);
  // Each model reads with its efforts, the default marked in words; then the
  // Harness's own default and where it came from.
  assert.match(
    inspectorPane(frame),
    /^ Supported models *\n Listed by the Harness · only these can be chosen *\n · GPT-5 · gpt-5 *\n {3}Efforts · low, medium \(default\), high *\n · GPT-5 mini · gpt-5-mini *\n {3}No effort setting *\n *\n Reported settings *\n GPT-5 · gpt-5 at high *\n Reported by the Harness *$/m,
  );
  assert.match(frame, /Capabilities/);
  assert.match(frame, /Session recovery · Available with limits/);
  // Each capability's description and limits sit indented under its name,
  // with a blank line before the next capability.
  assert.match(
    inspectorPane(frame),
    /^ Session recovery · Available with limits *\n {3}Resume a Harness Session after process loss\. *\n {3}Limits · Reloads retained history before live activity\. *\n *\n Same-Turn steering · Unavailable *\n {3}Send guidance/m,
  );
  assert.doesNotMatch(
    frame,
    /Adapter|native payload|credential|Action Offers/i,
  );

  t.mockInput.pressArrow("right");
  for (let index = 0; index < 30; index += 1) {
    t.mockInput.pressArrow("down");
  }
  await t.waitForFrame((next) => next.includes("Configuration"));
  assert.match(
    t.captureCharFrame(),
    /Harness-owned settings stay with the Harness/,
  );
  assert.match(
    inspectorPane(t.captureCharFrame()),
    /^ Structured questions · Not checked *\n {3}Answer structured questions/m,
  );
});

test("an unavailable Harness renders its external remediation and no action", async () => {
  const { t, focused, closed } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("requires authentication"));
  const frame = t.captureCharFrame();

  assert.deepEqual(focused, [{ id: "codex" }, { id: "claude-code" }]);
  assert.match(frame, /Claude Code.*Not ready/s);
  assert.match(frame, /Unavailable · Claude Code requires authentication/);
  assert.match(frame, /Remediation · Log in separately through Claude Code/);
  assert.match(frame, /Authentication · Log in separately through Claude Code/);
  assert.match(frame, /Models not available yet/);
  assert.doesNotMatch(
    frame,
    /Press Enter to|retry qualification|authenticate now/i,
  );

  t.mockInput.pressArrow("up");
  await t.waitForFrame((next) =>
    next.includes("Codex · Qualified with limits"),
  );
  t.mockInput.pressArrow("down");
  await t.waitForFrame((next) => next.includes("requires authentication"));
  assert.deepEqual(focused, [{ id: "codex" }, { id: "claude-code" }]);
  assert.deepEqual(closed, []);
});

test("Harness search uses held names, models, and capabilities and explains no matches", async () => {
  const { t } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("requires authentication"));

  t.mockInput.pressKey("/");
  await t.waitForFrame((frame) => frame.includes("› Find a Harness"));
  await t.mockInput.typeText("gpt-5-mini");
  await t.waitForFrame((frame) => !frame.includes("Claude Code · Not ready"));
  assert.match(t.captureCharFrame(), /Codex/);

  for (let index = 0; index < "gpt-5-mini".length; index += 1) {
    t.mockInput.pressBackspace();
  }
  // A model's friendly label matches as well as its exact name.
  await t.mockInput.typeText("GPT-5 mini");
  await t.waitForFrame((frame) => !frame.includes("Claude Code · Not ready"));
  assert.match(t.captureCharFrame(), /Codex/);

  for (let index = 0; index < "GPT-5 mini".length; index += 1) {
    t.mockInput.pressBackspace();
  }
  await t.mockInput.typeText("effective model");
  await t.waitForFrame((frame) => !frame.includes("Claude Code · Not ready"));
  assert.match(t.captureCharFrame(), /Codex/);

  for (let index = 0; index < "effective model".length; index += 1) {
    t.mockInput.pressBackspace();
  }
  await t.mockInput.typeText("missing");
  await t.waitForFrame((frame) => frame.includes("No matching Harnesses"));
  assert.match(
    t.captureCharFrame(),
    /Try a different name.*capability, model, or.*qualification state/s,
  );
});

// Printable keys reaching search, ←/→ pane moves, inspector scrolling, and
// Ctrl+C from any pane are the shared catalog navigation
// (`catalog-navigation.tsx`); their assertions live once in
// bundle-screens.test.tsx. The arrival and focus test below repeats only the
// moves the Harness catalog's acceptance names.
test("Harness keymap exposes focus without colour and restores Home", async () => {
  const { t, closed } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  assert.match(t.captureCharFrame(), /│ › Codex/);
  assert.match(t.captureCharFrame(), /› Results/);
  // The selection keeps its glyph while the inspector has focus.
  t.mockInput.pressTab();
  await t.waitForFrame((frame) => frame.includes("› Inspector"));
  assert.match(t.captureCharFrame(), /│ › Codex/);

  t.mockInput.pressEscape();
  await until(() => /^ Secant\s*$/m.test(t.captureCharFrame()));
  assert.deepEqual(closed, [{ id: "codex" }]);
  assert.doesNotMatch(t.captureCharFrame(), /› Harnesses/);
  assert.match(t.captureCharFrame(), /Codex qualified/);

  // Selection does not survive the Home round-trip.
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("› Find a Harness"));
  assert.doesNotMatch(t.captureCharFrame(), /│ › /);
  assert.match(t.captureCharFrame(), /No Harness selected/);
});

test("reopening Harnesses preserves held model search for a non-selected row", async () => {
  const { t, closed } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("requires authentication"));
  t.mockInput.pressEscape();
  await until(() => /^ Secant\s*$/m.test(t.captureCharFrame()));
  assert.deepEqual(closed, [{ id: "codex" }, { id: "claude-code" }]);

  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  await t.waitForFrame((frame) => frame.includes("2 models observed"));
  await t.mockInput.typeText("gpt-5-mini");
  await t.waitForFrame((frame) => frame.includes("gpt-5-mini"));
  assert.match(t.captureCharFrame(), /Codex · Qualified with/);
  assert.doesNotMatch(t.captureCharFrame(), /Claude Code · Not ready/);
});

test("a fully qualified Harness counts and renders without a limits suffix", async () => {
  const limitedQualification = QUALIFIED_CODEX.qualification;
  if (
    limitedQualification.state !== "qualified" &&
    limitedQualification.state !== "qualified-with-limits"
  ) {
    throw new Error("qualified fixture lost its observation");
  }
  const qualified: HarnessFocus = {
    id: QUALIFIED_CODEX.id,
    name: QUALIFIED_CODEX.name,
    discovery: QUALIFIED_CODEX.discovery,
    qualification: {
      state: "qualified",
      observation: limitedQualification.observation,
    },
    supportedModels: QUALIFIED_CODEX.supportedModels,
    capabilities: QUALIFIED_CODEX.capabilities,
    configurationPosture: QUALIFIED_CODEX.configurationPosture,
  };
  const catalog = staticCatalog([qualified], () => ({
    found: true,
    harness: qualified,
  }));

  const { t } = await mount({ catalog });
  await t.waitForFrame((frame) => frame.includes("1 qualified on this system"));
  assert.match(t.captureCharFrame(), /Codex · Qualified\s/);
  assert.doesNotMatch(t.captureCharFrame(), /Qualified with limits/);
});

test("unchecked discovery variants, free-text models, and a focus Problem remain inspectable", async () => {
  const unsupported: HarnessFocus = {
    id: "codex",
    name: "Codex",
    discovery: {
      state: "unsupported-shim",
      name: "codex.cmd",
      path: "/tools/codex.cmd",
      executableEnvironmentVariable: "SECANT_CODEX",
    },
    qualification: { state: "not-checked" },
    supportedModels: { kind: "free-text" },
    modelDeclaration: { kind: "free-text", efforts: [] },
    capabilities: QUALIFIED_CODEX.capabilities.map((capability) => ({
      capability: capability.capability,
      name: capability.name,
      description: capability.description,
      state: "not-checked",
    })),
  };
  const missing: HarnessSummary = {
    id: "claude-code",
    name: "Claude Code",
    discovery: {
      state: "not-found",
      searched: ["PATH name 'claude'"],
      executableEnvironmentVariable: "SECANT_CLAUDE_CODE",
    },
    qualification: { state: "not-checked" },
  };
  const catalog = staticCatalog([unsupported, missing], (id) =>
    id === "codex"
      ? { found: true, harness: unsupported }
      : {
          found: false,
          problem: {
            code: "harness-not-found",
            explanation: "The selected Harness is unavailable.",
            remediation: "Inspect another Harness.",
            possibleEffects: "none",
          },
        },
  );

  const { t } = await mount({ catalog });
  await t.waitForFrame((frame) => frame.includes("0 qualified on this system"));
  const unchecked = t.captureCharFrame();
  // A Harness that cannot run says so in words on its row; the path and the
  // searched locations stay in the inspector.
  const results = resultsPane(unchecked);
  assert.match(
    results,
    /› Codex · Unavailable ·\s+unsupported shim\s+Models not yet observed/,
  );
  assert.match(
    results,
    /Claude Code · Unavailable ·\s+not found on PATH\s+Models not yet observed/,
  );
  assert.doesNotMatch(results, /codex\.cmd|searched|Free-text/);
  assert.match(
    inspectorPane(unchecked),
    /Discovery · unsupported shim \/tools\/codex\.cmd/,
  );
  assert.match(unchecked, /Checked · Not checked/);
  assert.match(unchecked, /Authentication · Not checked/);
  assert.match(inspectorPane(unchecked), /Free-text model entry/);

  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) =>
    frame.includes("selected Harness is unavailable"),
  );
  assert.match(
    resultsPane(t.captureCharFrame()),
    /› Claude Code · Unavailable ·\s+not found on PATH/,
  );

  // Stacked on a small terminal, the longer status words wrap inside the row
  // rather than overflowing it.
  t.resize(40, 24);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  assert.match(
    resultsPane(narrow),
    /› Claude Code · Unavailable ·\s+not found on PATH/,
  );
  for (const line of narrow.split("\n")) {
    assert.ok(line.length <= 40, `line overflows: ${JSON.stringify(line)}`);
  }
});

test("qualified rows name free-text entry, and a Harness without model selection shows no model line", async () => {
  const qualification = QUALIFIED_CODEX.qualification;
  if (!("observation" in qualification)) {
    throw new Error("qualified fixture lost its observation");
  }
  const freeText: HarnessFocus = {
    id: "codex",
    name: "Codex",
    discovery: QUALIFIED_CODEX.discovery,
    qualification: {
      state: "qualified",
      observation: qualification.observation,
    },
    supportedModels: { kind: "free-text" },
    modelDeclaration: { kind: "free-text", efforts: ["low", "high"] },
    capabilities: QUALIFIED_CODEX.capabilities,
  };
  const noModels: HarnessFocus = {
    id: "claude-code",
    name: "Claude Code",
    discovery: UNAVAILABLE_CLAUDE.discovery,
    qualification: {
      state: "qualified",
      observation: qualification.observation,
    },
    capabilities: QUALIFIED_CODEX.capabilities,
  };
  const catalog = staticCatalog([freeText, noModels], (id) => ({
    found: true,
    harness: id === "codex" ? freeText : noModels,
  }));

  const { t } = await mount({ catalog });
  await t.waitForFrame((frame) => frame.includes("Free-text model entry"));
  const frame = t.captureCharFrame();
  assert.match(
    resultsPane(frame),
    /› Codex · Qualified *\n {3}Free-text model entry *\n {3}Claude Code · Qualified *\n *\n/,
  );
  assert.doesNotMatch(frame, /Models not yet observed/);
});

/** The inspector panel's content rows in a frame, between its title and its
 *  bottom border, with the borders and padding cut away. */
function inspectorWindow(frame: string): string[] {
  const lines = frame.split("\n");
  const top = lines.findIndex((line) => line.includes("Inspector"));
  const rows: string[] = [];
  for (const line of lines.slice(top + 1)) {
    if (line.includes("└")) break;
    const columns = line.split("│");
    rows.push((columns[columns.length - 2] ?? "").trim());
  }
  return rows;
}

/** How many of `next`'s leading rows repeat the tail of `seen`. */
function longestOverlap(seen: readonly string[], next: readonly string[]) {
  for (let size = Math.min(seen.length, next.length); size > 0; size -= 1) {
    if (seen.slice(-size).every((row, index) => row === next[index])) {
      return size;
    }
  }
  return 0;
}

// #23 evidence for the model catalog (#341): a large suggested list with long
// labels, the declaration-level efforts, and a fallback default under an effort
// lock, read at small sizes and across a resize from text-only frames, so every
// meaning (the default effort, where the default came from, the lock) is words.
test("the inspector's models, efforts, and reported settings survive small sizes, resize, and a large list without colour", async () => {
  const qualification = QUALIFIED_CODEX.qualification;
  if (!("observation" in qualification)) {
    throw new Error("qualified fixture lost its observation");
  }
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const models = Array.from({ length: 30 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      model: `family-${number}[1m]`,
      label: `Family ${number} (latest) with a long friendly label and 1M context`,
      efforts,
      ...(index === 0 ? { defaultEffort: "medium" } : {}),
    };
  });
  const suggested: HarnessFocus = {
    id: "claude-code",
    name: "Claude Code",
    discovery: UNAVAILABLE_CLAUDE.discovery,
    qualification: {
      state: "qualified",
      observation: qualification.observation,
    },
    supportedModels: { kind: "free-text" },
    modelDeclaration: { kind: "suggested", models, efforts },
    harnessDefaults: {
      kind: "fallback",
      choice: { model: "family-30[1m]", effort: "xhigh" },
      reason: "Claude Code's own settings were not read before launch.",
      effortLock: { effort: "xhigh", source: "CLAUDE_CODE_EFFORT_LEVEL=xhigh" },
    },
    capabilities: QUALIFIED_CODEX.capabilities,
  };
  const catalog = staticCatalog([suggested], () => ({
    found: true,
    harness: suggested,
  }));
  const { t } = await mount({ catalog, width: 50, height: 24 });
  await t.waitForFrame((frame) => frame.includes("30 suggested models"));
  const assertWidth = (width: number) => {
    for (const line of t.captureCharFrame().split("\n")) {
      assert.ok(
        line.length <= width,
        `line overflows ${width} cols: ${JSON.stringify(line)}`,
      );
    }
  };
  assertWidth(50);

  // Scroll the inspector to its end, stitching each window into one transcript:
  // every model is reachable and every phrase reads whole once unwrapped.
  t.mockInput.pressArrow("right");
  const transcript: string[] = [];
  for (let press = 0, unchanged = 0; press < 400 && unchanged < 3; press += 1) {
    const window = inspectorWindow(t.captureCharFrame());
    const overlap = longestOverlap(transcript, window);
    unchanged = overlap === window.length ? unchanged + 1 : 0;
    transcript.push(...window.slice(overlap));
    t.mockInput.pressArrow("down");
    await t.renderOnce();
    assertWidth(50);
  }
  const read = transcript.join(" ").replace(/\s+/g, " ");
  for (let index = 1; index <= 30; index += 1) {
    const number = String(index).padStart(2, "0");
    assert.match(
      read,
      new RegExp(
        `· Family ${number} \\(latest\\) with a long friendly label and 1M context · family-${number}\\[1m\\] Efforts · low, medium${index === 1 ? " \\(default\\)" : ""}, high, xhigh, max`,
      ),
    );
  }
  assert.match(
    read,
    /· Any other model Efforts · low, medium, high, xhigh, max Reported settings Family 30 \(latest\) with a long friendly label and 1M context · family-30\[1m\] at xhigh Fallback · Claude Code's own settings were not read before launch\. Locked by CLAUDE_CODE_EFFORT_LEVEL=xhigh\. Change that setting outside Secant\./,
  );

  // A resize keeps the selection and the inspector's focus, rewrapped within
  // the width. At 38×20 the stacked catalog has no rows left for the inspector,
  // so only the selection and the width hold there; 140×44 shows it again.
  t.resize(38, 20);
  await t.renderOnce();
  assertWidth(38);
  assert.match(t.captureCharFrame(), /│ › Claude Code/);
  t.resize(140, 44);
  await t.renderOnce();
  assertWidth(140);
  const wide = t.captureCharFrame();
  assert.match(wide, /│ › Claude Code/);
  assert.match(wide, /› Inspector/);
  assert.match(
    wide,
    /Family \d\d \(latest\) with a long friendly label and 1M context · family-\d\d\[1m\]/,
  );
});

test("Harness catalog stacks and resizes without horizontal overflow", async () => {
  const { t } = await mount({ width: 50, height: 24 });
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  const assertWidth = (width: number) => {
    for (const line of t.captureCharFrame().split("\n")) {
      assert.ok(
        line.length <= width,
        `line overflows ${width} cols: ${JSON.stringify(line)}`,
      );
    }
  };
  const narrow = t.captureCharFrame().split("\n");
  const results = narrow.findIndex((line) => line.includes("Find a Harness"));
  const inspector = narrow.findIndex((line) => line.includes("Inspector"));
  assert.ok(results >= 0 && inspector > results);
  assertWidth(50);

  t.resize(38, 20);
  await t.renderOnce();
  assertWidth(38);
});

test("Harnesses open on search with nothing selected and move focus like the Bundle catalog", async () => {
  const { t, focused } = await mount({ selectTop: false });
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  const pane = () => {
    const frame = t.captureCharFrame();
    return ["Find a Harness", "Results", "Inspector"].filter((title) =>
      frame.includes(`› ${title}`),
    );
  };
  const selectedRow = () =>
    t
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("│ › ")) ?? "";

  // Arrival: search focused, nothing selected, an empty details pane, and no
  // Harness focus opened.
  const arrival = t.captureCharFrame().split("\n");
  assert.deepEqual(pane(), ["Find a Harness"]);
  assert.equal(selectedRow(), "");
  assert.match(t.captureCharFrame(), /No Harness selected/);
  assert.deepEqual(focused, []);
  // The search pane's own bottom edge separates it from the results.
  const search = arrival.findIndex((line) => line.includes("Find a Harness"));
  const results = arrival.findIndex((line) => line.includes("Results"));
  assert.equal(results, search + 3);
  assert.match(arrival[results - 1] ?? "", /└─+┘/);

  // ←, →, Home, End, and / edit the query without leaving search.
  await t.mockInput.typeText("ode");
  t.mockInput.pressKey("HOME");
  await t.mockInput.typeText("c");
  t.mockInput.pressArrow("right");
  t.mockInput.pressArrow("left");
  t.mockInput.pressKey("END");
  await t.mockInput.typeText("/");
  await t.waitForFrame((frame) => frame.includes("code/"));
  assert.deepEqual(pane(), ["Find a Harness"]);
  for (let index = 0; index < "code/".length; index += 1) {
    t.mockInput.pressBackspace();
  }
  await t.waitForFrame((frame) => !frame.includes("code/"));

  // Down selects the top result, which is what opens its focus.
  t.mockInput.pressArrow("down");
  await t.waitForFrame(() => selectedRow().includes("Codex"));
  assert.deepEqual(pane(), ["Results"]);
  assert.deepEqual(focused, [{ id: "codex" }]);
  const row = t
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("› Codex"));
  assert.ok(row !== undefined);
  assert.ok(row.attributes & TextAttributes.BOLD);
  assert.ok(!row.bg.equals(t.captureSpans().lines[0]?.spans[0]?.bg));

  // Up on the top result returns to search; PgDn comes back to the top result.
  t.mockInput.pressArrow("up");
  await t.waitForFrame(() => pane()[0] === "Find a Harness");
  assert.match(selectedRow(), /Codex/);
  t.mockInput.pressKey("\u001B[6~");
  await t.waitForFrame(() => pane()[0] === "Results");
  // Tab cycles to the inspector and back to search; `/` focuses search.
  t.mockInput.pressTab();
  await t.waitForFrame(() => pane()[0] === "Inspector");
  t.mockInput.pressTab();
  await t.waitForFrame(() => pane()[0] === "Find a Harness");
  t.mockInput.pressTab();
  await t.waitForFrame(() => pane()[0] === "Results");
  t.mockInput.pressKey("/");
  await t.waitForFrame(() => pane()[0] === "Find a Harness");
  assert.match(t.captureCharFrame(), /name, model, or capability/);
});
