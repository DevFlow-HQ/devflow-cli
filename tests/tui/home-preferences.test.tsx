import { InputRenderable } from "@opentui/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignal } from "solid-js";
import {
  App,
  createLivePreferencesView,
  type PreferencesView,
  type BundleCatalogView,
} from "../../src/tui/tui.js";
import type {
  AppearancePreferences,
  Problem,
} from "../../src/application/projection-port.js";
import {
  inertHarnessCatalogView,
  inertLaunchPreparationView,
  inertRunActionsView,
  inertRunListView,
  inertRunWorkbenchView,
  runSummary,
} from "./inert.js";
import { mountRenderer, makeFakeRenderer, until } from "./renderer-fixture.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { createApplication } from "../helpers/application.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { PALETTES } from "./palette-expectations.js";

type SaveResult = ReturnType<PreferencesView["save"]>;
const failure: Problem = {
  code: "preferences-write-failed",
  explanation: "Disk refused the save",
  remediation: "Retry",
  possibleEffects: "none",
};
function controlledPreferences(
  initial: AppearancePreferences = { theme: "everforest", appearance: "dark" },
) {
  const calls: {
    pair: AppearancePreferences;
    settle(value: ReturnType<SaveResult>): void;
  }[] = [];
  const [saved, setSaved] = createSignal(initial);
  const view: PreferencesView = {
    snapshot: () => ({
      family: "preferences",
      preferences: saved(),
      supportedThemes: PALETTES.map((row) => row.name),
      actionOffers: [{ action: "change-preferences" }],
    }),
    save(pair) {
      const [outcome, setOutcome] = createSignal<ReturnType<SaveResult>>({
        kind: "pending",
      });
      calls.push({
        pair,
        settle(value) {
          if (value.kind === "applied") setSaved(pair);
          setOutcome(value);
        },
      });
      return outcome;
    },
  };
  return { view, calls, setSaved };
}
async function mount(
  preferences: PreferencesView | (() => PreferencesView),
  width = 100,
  height = 24,
) {
  const exits: unknown[] = [];
  const bundles: BundleCatalogView = {
    openList: () => () => ({
      family: "bundle-catalog",
      view: "list",
      result: { found: true, bundles: [] },
    }),
    openFocus: () => {
      throw new Error("no Bundle focus in this fixture");
    },
  };
  const t = await mountRenderer(
    () => (
      <App
        preferences={
          typeof preferences === "function" ? preferences() : preferences
        }
        view={{
          snapshot: () => ({
            family: "workspace",
            path: "/workspace",
            approval: { state: "approved", approvedAt: "2026-10-06" },
            installedBundleCount: 0,
            runSummary: runSummary(),
            startupNotices: [],
            harnesses: [],
            actionOffers: [],
          }),
          approve() {},
        }}
        bundles={bundles}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={{ launch: () => () => ({ kind: "pending" }) }}
        run={inertRunWorkbenchView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer(width, height).port}
        reducedMotion={true}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  await t.waitForFrame((frame) => frame.includes("Search commands"));
  return { t, exits };
}
type Rendered = Awaited<ReturnType<typeof mount>>["t"];
async function type(t: Rendered, text: string) {
  await t.mockInput.typeText(text);
  await t.renderOnce();
}
async function themes(t: Rendered) {
  t.mockInput.pressKey("p", { ctrl: true });
  await t.waitForFrame((frame) => frame.includes("App commands"));
  await type(t, "Themes");
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Themes ·"));
}
async function escape(t: Rendered) {
  t.mockInput.pressEscape();
  await until(
    () =>
      !/Themes · (Dark|Light)/.test(t.captureCharFrame()) &&
      !t.captureCharFrame().includes("App commands"),
  ).catch((error) => {
    throw new Error(t.captureCharFrame(), { cause: error });
  });
}
function rgb(color: { r: number; g: number; b: number }) {
  return [color.r, color.g, color.b].map((v) => Math.round(v * 255));
}
function hex(value: string) {
  return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
}
function shellColor(t: Rendered) {
  const span = t
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("Secant"));
  assert.ok(span, t.captureCharFrame());
  return rgb(span.fg);
}

test("m10-home-and-preferences: native Home typing, deterministic name/description search, ties, explicit selection and reset", async () => {
  const f = controlledPreferences();
  const { t, exits } = await mount(f.view);
  await type(t, "q");
  assert.deepEqual(exits, []);
  assert.match(t.captureCharFrame(), /Quit/);
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.deepEqual(exits, []);
  t.mockInput.pressKey("c", { ctrl: true });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Workflow Bundles/);
  assert.deepEqual(exits, []);
  await type(t, "inspect");
  const frame = t.captureCharFrame();
  assert.ok(frame.indexOf("Workflow Bundles") < frame.indexOf("Previous Runs"));
  assert.ok(frame.indexOf("Previous Runs") < frame.indexOf("Harnesses"));
  t.mockInput.pressArrow("down");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /› Workflow Bundles/);
  t.mockInput.pressEscape();
  await until(() => !t.captureCharFrame().includes("› Workflow Bundles"));
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /inspect/);
  t.mockInput.pressKey("c", { ctrl: true });
  await t.renderOnce();
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Find an installed Bundle"));
  t.mockInput.pressEscape();
  await until(() => t.captureCharFrame().includes("Search commands"));
  assert.doesNotMatch(t.captureCharFrame(), /› Start a Run|inspect/);
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Search commands/);
});

test("m10-home-and-preferences: palette is scoped, dismisses once and restores native search focus", async () => {
  const f = controlledPreferences();
  const { t } = await mount(f.view);
  await type(t, "Bundles");
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Find an installed Bundle"));
  const searchFocus = t.renderer.currentFocusedRenderable;
  assert.ok(searchFocus);
  t.mockInput.pressKey("p", { ctrl: true });
  await t.waitForFrame((f) => f.includes("App commands"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Themes/);
  assert.match(frame, /Quit \(ctrl\+c\)/);
  assert.doesNotMatch(frame, /Start a Run|Previous Runs|Harnesses/);
  t.mockInput.pressArrow("down");
  await t.renderOnce();
  await escape(t);
  await until(() => t.renderer.currentFocusedRenderable === searchFocus);
  await type(t, "qq");
  assert.match(t.captureCharFrame(), /qq/);
});

test("m10-home-and-preferences: all 25 Dark/Light previews change actual shell colors and Escape restores entry", async () => {
  const f = controlledPreferences();
  const { t } = await mount(f.view);
  const initial = shellColor(t);
  for (const palette of PALETTES) {
    await themes(t);
    await type(t, palette.name);
    assert.deepEqual(
      shellColor(t),
      hex(palette.dark).map((v) => Math.round((v * 105) / 255)),
      palette.name + " dark",
    );
    t.mockInput.pressTab();
    await t.renderOnce();
    assert.deepEqual(
      shellColor(t),
      hex(palette.light).map((v) => Math.round((v * 105) / 255)),
      palette.name + " light",
    );
    await escape(t);
    assert.deepEqual(shellColor(t), initial);
  }
  assert.deepEqual(f.calls, []);
});

test("m10-home-and-preferences: apply precedes delayed save, failure retains appearance, cancellation restores unsaved entry, retry and next launch", async () => {
  const f = controlledPreferences();
  const { t } = await mount(f.view);
  await themes(t);
  await type(t, "nord");
  t.mockInput.pressTab();
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Saving appearance"));
  assert.deepEqual(shellColor(t), [46, 52, 64]);
  assert.deepEqual(f.calls[0]?.pair, { theme: "nord", appearance: "light" });
  f.calls[0]?.settle({ kind: "refused", problem: failure });
  await t.waitForFrame((f) => f.includes("Appearance not saved"));
  assert.deepEqual(shellColor(t), [46, 52, 64]);
  await themes(t);
  await type(t, "everforest");
  await escape(t);
  assert.deepEqual(shellColor(t), [46, 52, 64]);
  t.mockInput.pressKey("r", { ctrl: true });
  await t.renderOnce();
  assert.equal(f.calls.length, 2);
  f.calls[1]?.settle({ kind: "applied" });
  await t.renderOnce();
  const next = await mount(f.view);
  assert.deepEqual(shellColor(next.t), [46, 52, 64]);
  f.setSaved({ theme: "everforest", appearance: "dark" });
  await t.renderOnce();
  assert.deepEqual(
    shellColor(t),
    [46, 52, 64],
    "saved changes never synchronize active appearance",
  );
});

test("m10-home-and-preferences: live Port saves use fresh Operation ids for retry and initialize a later launch", async (context) => {
  const catalog = openCatalog(makeTempDir("secant-theme-save-"));
  const application = createApplication({
    catalog,
    launchWorkspacePath: makeTempDir("secant-theme-ws-"),
    harnessRegistry: [],
  });
  context.after(async () => {
    await application.shutdown();
    catalog.close();
  });
  const ids: string[] = [];
  const port = application.projectionPort;
  const submit = port.submit.bind(port);
  port.submit = (input) => {
    ids.push(input.operationId);
    if (ids.length === 1) return { admitted: false, problem: failure };
    return submit(input);
  };
  const first = await mount(() => createLivePreferencesView(port));
  await themes(first.t);
  await type(first.t, "nord");
  first.t.mockInput.pressEnter();
  await first.t.waitForFrame((f) => f.includes("Appearance not saved"));
  first.t.mockInput.pressKey("r", { ctrl: true });
  await until(() => ids.length === 2);
  assert.notEqual(ids[0], ids[1]);
  const next = await mount(() => createLivePreferencesView(port));
  assert.deepEqual(shellColor(next.t), [236, 239, 244]);
  assert.equal(catalog.getPreference("theme"), "nord");
});

for (const size of [
  { width: 40, height: 16 },
  { width: 140, height: 32 },
  { width: 30, height: 8 },
]) {
  test(`m10-home-and-preferences: search and theme results stay reachable at ${size.width}x${size.height} and resize`, async () => {
    const f = controlledPreferences();
    const { t } = await mount(f.view, size.width, size.height);
    await themes(t);
    await type(t, "zenburn");
    t.mockInput.pressEnter();
    await t.renderOnce();
    assert.equal(f.calls[0]?.pair.theme, "zenburn");
    t.resize(70, 18);
    await t.renderOnce();
    for (const line of t.captureCharFrame().split("\n"))
      assert.ok(line.length <= 70);
  });
}

for (const place of ["Home", "palette"] as const) {
  test(`m10-audit-truthful-keys: typing from ${place} results edits native search and Escape returns to search`, async () => {
    const { t, exits } = await mount(controlledPreferences().view);
    if (place === "palette") {
      t.mockInput.pressKey("p", { ctrl: true });
      await t.waitForFrame((frame) => frame.includes("App commands"));
    }
    t.mockInput.pressArrow("down");
    await t.renderOnce();
    await type(t, "Quit");
    assert.match(t.captureCharFrame(), /Quit/);
    const input = t.renderer.currentFocusedRenderable;
    assert.ok(input instanceof InputRenderable);
    assert.equal(input.value, "Quit");
    assert.deepEqual(exits, []);
    t.mockInput.pressEscape();
    if (place === "palette")
      await until(() => !t.captureCharFrame().includes("App commands"));
    else {
      await until(() =>
        t.captureCharFrame().includes("Search commands [focused]"),
      );
      assert.match(t.captureCharFrame(), /Quit/);
      t.mockInput.pressEscape();
      await until(() => t.captureCharFrame().includes("Workflow Bundles"));
    }
    assert.deepEqual(exits, []);
  });
}

test("m10-audit-truthful-keys: preference read notice is visible on Home at launch and after resize", async () => {
  const preferences = controlledPreferences().view;
  const { t } = await mount({
    ...preferences,
    snapshot: () => ({
      ...preferences.snapshot(),
      notice: {
        code: "preferences-read-failed",
        explanation: "Saved preferences could not be read",
        remediation: "Using defaults",
        possibleEffects: "none",
      },
    }),
  });
  assert.match(t.captureCharFrame(), /Saved preferences could not be read/);
  t.resize(48, 12);
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Saved preferences could not be read/);
  await type(t, "Quit");
  assert.match(t.captureCharFrame(), /Saved preferences could not be read/);
});
