import { inertPreferencesView } from "./inert.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { testRender } from "@opentui/solid";
import { createRoot, createSignal } from "solid-js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSnapshot,
  LaunchRunInput,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";
import { wireApplication } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessDefaults,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import {
  App,
  createLiveHarnessCatalogView,
  createLiveLaunchPreparationView,
  createLiveRunLaunchView,
  createLiveRunWorkbenchView,
  createLiveRunActionsView,
  type BundleCatalogView,
  type RunLaunchView,
  type WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import { createFake } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { inertRunActionsView, inertRunListView } from "./inert.js";

function profile(): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "fake-claude",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    agentCalls: {
      available: true,
      evidence: "Scripted agent calls.",
    },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: false, evidence: "scripted fake" },
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    modelObservation: { available: true, evidence: "scripted fake" },
    modelChange: { reach: "next-turn", evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

/** The Model choice the fake reports, which Start a Run launches unchanged. */
const REPORTED_DEFAULTS: HarnessDefaults = {
  kind: "reported",
  choice: { model: "fake-opus" },
};

function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-tui-live-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "repair.md"), "Repair the test.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.tui-live",
      version: "1.0.0",
      name: "TUI Live Turn",
      description: "A live Turn renderer fixture.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/repair.md", kind: "prompt" }],
    routing: [
      {
        id: "repair",
        kind: "agent",
        session: "repair",
        prompt: { asset: "prompts/repair.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

function workspaceView(snapshot: WorkspaceSnapshot): WorkspaceView {
  const [value] = createSignal(snapshot);
  return { snapshot: value, approve() {} };
}

function catalogView(
  list: BundleCatalogSnapshot,
  focus: BundleFocusSnapshot,
): BundleCatalogView {
  const [listValue] = createSignal(list);
  const [focusValue] = createSignal(focus);
  return { openList: () => listValue, openFocus: () => focusValue };
}

test("a scripted fake Harness streams through the Port into the Run Workbench", async (t) => {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });

  const workspace = makeTempDir("secant-tui-live-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-tui-live-home-"),
    launchCwd: workspace,
    process: createFakeBundleProcess({ executables: [process.execPath] }),
    harnessAdapter: createFake({
      profile: profile(),
      defaults: REPORTED_DEFAULTS,
      turns: [
        {
          events: [
            {
              kind: "session",
              availability: { state: "open" },
              facts: {
                recoveryCoordinate: { opaque: "fake-session" },
                executableVersion: "0.0.0-fake",
                tools: ["Edit"],
                mcp: [],
                commands: [],
              },
            },
            {
              kind: "model",
              observation: { known: true, model: "fake-sonnet" },
            },
            {
              kind: "message-preview",
              messageId: "repair-message",
              content: "Streaming the repair",
            },
            {
              kind: "tool-activity",
              activity: {
                tool: "Edit",
                phase: "started",
                summary: "editing src/fix.ts",
              },
            },
            { kind: "activity", description: "delegating to subagent" },
            {
              kind: "context",
              observation: { usedTokens: 12_500, limitTokens: 200_000 },
            },
            {
              kind: "usage",
              observation: { summary: "estimated 25 tokens" },
            },
          ],
          requests: [
            {
              id: "edit-1",
              shape: {
                kind: "approval",
                tool: "Edit",
                input: '{"path":"src/fix.ts"}',
                decisions: ["allow", "deny"],
              },
              awaited: true,
            },
          ],
          result: {
            kind: "completed",
            detail: {
              finalContent: "The repair is complete.",
              effectiveModel: { known: true, model: "fake-sonnet" },
              session: { state: "open" },
            },
          },
        },
      ],
    })(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeAgentBundle();
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog
    .listEntries()
    .find((item) => item.id === bundle.id);
  assert.ok(entry);
  const approval = wired.projectionPort.submit({
    operationId: "approve-workspace",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approval.admitted);

  const workspaceProjection = wired.projectionPort.openProjection({
    family: "workspace",
  });
  const listProjection = wired.projectionPort.openProjection({
    family: "bundle-catalog",
  });
  const focusProjection = wired.projectionPort.openProjection({
    family: "bundle-catalog",
    focus: { id: bundle.id },
  });
  t.after(() => {
    workspaceProjection.close();
    listProjection.close();
    focusProjection.close();
  });

  const liveLaunch = createLiveRunLaunchView(wired.projectionPort);
  let launched: ReturnType<RunLaunchView["launch"]> | undefined;
  const launch: RunLaunchView = {
    launch(input: LaunchRunInput) {
      launched = liveLaunch.launch(input);
      return launched;
    },
  };
  const fakeRenderer = makeFakeRenderer(120, 32);
  const rendered = await testRender(
    () => (
      <App
        preferences={inertPreferencesView()}
        view={workspaceView(workspaceProjection.snapshot)}
        bundles={catalogView(listProjection.snapshot, focusProjection.snapshot)}
        harnesses={createLiveHarnessCatalogView(wired.projectionPort)}
        preparation={createLiveLaunchPreparationView(wired.projectionPort)}
        launch={launch}
        run={createLiveRunWorkbenchView(wired.projectionPort)}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={fakeRenderer.port}
        reducedMotion={false}
        exit={() => {}}
      />
    ),
    { width: 120, height: 32 },
  );
  await rendered.waitForFrame((frame) => frame.includes("Secant"));
  rendered.mockInput.pressArrow("down");
  rendered.mockInput.pressEnter(); // explicitly select Start a Run
  await rendered.waitForFrame((frame) => frame.includes("acknowledge"));
  rendered.mockInput.pressKey("a");
  await rendered.waitForFrame((frame) => frame.includes("Trust acknowledged"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("Choose a Harness"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) =>
    frame.includes("Model choices loaded"),
  );
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("1. Choose a model"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("2. Choose effort"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("Review"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("Tool: Edit"));

  // The approval request replaces the bottom input with the inline decision control
  // naming the exact tool and input and both offered decisions (#121 AC1).
  await rendered.waitForFrame((frame) =>
    frame.includes("Harness Request · awaiting your approval"),
  );
  const frame = rendered.captureCharFrame();
  assert.match(frame, /BLOCKED · ephemeral Harness Request/);
  assert.match(frame, /Assistant · streaming[\s\S]*Streaming the repair/);
  assert.match(frame, /Edit started/);
  assert.match(frame, /Context · used 12500 tokens, capacity 200000 tokens/);
  assert.match(frame, /Usage · estimated 25 tokens/);
  assert.match(frame, /Tool: Edit/); // the exact tool
  assert.match(frame, /\[ Allow \]/); // both offered decisions
  assert.match(frame, /\[ Deny \]/);

  const receipt = launched?.();
  assert.equal(receipt?.kind, "launched");
  if (receipt?.kind !== "launched") throw new Error("Run was not launched");
  // Answer allow *through the control*, over the real Port: Enter on the default
  // (allow) decision dispatches `answer-harness-request` and the Turn continues to
  // completion — the whole client wiring, not a hand-built Port submit (#121 AC1).
  fakeRenderer.key("return");
  await rendered.waitForFrame((next) => next.includes("SUCCEEDED"));
  assert.match(rendered.captureCharFrame(), /Edit started/);
  assert.doesNotMatch(rendered.captureCharFrame(), /Assistant preview/);
  // The Harness identity and effective model live in the details panel now (#194
  // story 35), read from the durable `harness` view — not the old model-only header
  // that hardcoded "Claude Code" (#125). Open the panel to confirm the observed line.
  fakeRenderer.key("d");
  await rendered.waitForFrame((next) => next.includes("Observed Harness"));
  assert.match(
    rendered.captureCharFrame(),
    /Observed Harness · Claude Code · fake-claude · 0\.0\.0-fake · model fake-sonnet/,
  );
});

test("the Matt grill takes its idea on the inputs screen and opens on the first Turn built from it (#212)", async (t) => {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const idea = "Add a dark-mode toggle";
  const question = "Q1 - Who can toggle it? Recommended: every user.";
  const workspace = makeTempDir("secant-tui-matt-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-tui-matt-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    process: createFakeBundleProcess({ executables: [process.execPath] }),
    harnessAdapter: createFake({
      profile: profile(),
      defaults: REPORTED_DEFAULTS,
      turns: [
        {
          events: [
            {
              kind: "assistant-content",
              messageId: "fixture-message",
              content: question,
            },
          ],
          result: {
            kind: "completed",
            detail: {
              finalContent: question,
              effectiveModel: { known: true, model: "fake-sonnet" },
              session: { state: "detached", coordinate: { opaque: "c" } },
            },
          },
        },
      ],
    })(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const mattFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "bundles",
    "matt-front-spec",
  );
  assert.ok(wired.bundleManagement.build(mattFolder, { noInstall: false }).ok);
  const bundleId = "dev.secant.matt-front";
  assert.ok(
    wired.projectionPort.submit({
      operationId: "approve-workspace",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const workspaceProjection = wired.projectionPort.openProjection({
    family: "workspace",
  });
  const listProjection = wired.projectionPort.openProjection({
    family: "bundle-catalog",
  });
  const focusProjection = wired.projectionPort.openProjection({
    family: "bundle-catalog",
    focus: { id: bundleId },
  });
  t.after(() => {
    workspaceProjection.close();
    listProjection.close();
    focusProjection.close();
  });

  const fakeRenderer = makeFakeRenderer(120, 36);
  const rendered = await testRender(
    () => (
      <App
        preferences={inertPreferencesView()}
        view={workspaceView(workspaceProjection.snapshot)}
        bundles={catalogView(listProjection.snapshot, focusProjection.snapshot)}
        harnesses={createLiveHarnessCatalogView(wired.projectionPort)}
        preparation={createLiveLaunchPreparationView(wired.projectionPort)}
        launch={createLiveRunLaunchView(wired.projectionPort)}
        run={createLiveRunWorkbenchView(wired.projectionPort)}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={fakeRenderer.port}
        reducedMotion={false}
        exit={() => {}}
      />
    ),
    { width: 120, height: 36 },
  );
  await rendered.waitForFrame((frame) => frame.includes("Secant"));
  rendered.mockInput.pressArrow("down");
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("acknowledge"));
  rendered.mockInput.pressKey("a");
  await rendered.waitForFrame((frame) => frame.includes("Trust acknowledged"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("Choose a Harness"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) =>
    frame.includes("Model choices loaded"),
  );
  rendered.mockInput.pressEnter();
  // The Bundle's required idea is collected on the inputs screen.
  await rendered.waitForFrame((frame) => frame.includes("Launch inputs"));
  assert.match(rendered.captureCharFrame(), /idea \(text\)/);
  await rendered.mockInput.typeText(idea);
  await rendered.waitForFrame((frame) => frame.includes(idea));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("1. Choose a model"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("2. Choose effort"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("Review"));
  assert.match(rendered.captureCharFrame(), new RegExp(`idea: ${idea}`));
  rendered.mockInput.pressEnter();

  // The Workbench opens on the grill's Turn boundary with the agent's first answer
  // already shown: the idea went out in the entry Turn, not a second paste.
  await rendered.waitForFrame((frame) => frame.includes(question));
  await rendered.waitForFrame((frame) =>
    frame.includes("BLOCKED · interactive Turn"),
  );
  const [listed] = wired.runGroup.listRuns();
  assert.ok(listed);
  const runProjection = wired.projectionPort.openProjection({
    family: "run",
    runId: listed.runId,
  });
  const result = runProjection.snapshot.result;
  runProjection.close();
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  const page = result.run.sessions?.[0]?.transcriptPage;
  assert.ok(page);
  const transcript = wired.projectionPort.readTranscript(page);
  assert.ok(transcript.found);
  if (!transcript.found) throw new Error("unreachable");
  const [entry] = transcript.entries.filter((e) => e.role === "user");
  assert.ok(entry?.content.includes(idea), entry?.content);
});

test("workbench-model-choice: the live read prepares the Offer and Run Actions preserves the applied choice, reach, and effort-reset receipt", async (t) => {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const harnessProfile: HarnessProfile = {
    ...profile(),
    modelSelection: {
      at: "launch",
      evidence: "scripted choices",
      declaration: {
        kind: "list",
        models: [
          {
            model: "alpha",
            label: "Alpha",
            efforts: ["high"],
            defaultEffort: "high",
          },
          {
            model: "beta",
            label: "Beta",
            efforts: ["medium"],
            defaultEffort: "medium",
          },
        ],
      },
    },
  };
  const wired = wireApplication({
    secantHome: makeTempDir("secant-model-home-"),
    launchCwd: makeTempDir("secant-model-ws-"),
    process: createFakeBundleProcess({ executables: [process.execPath] }),
    harnessAdapter: createFake({
      profile: harnessProfile,
      defaults: {
        kind: "reported",
        choice: { model: "alpha", effort: "high" },
      },
      turns: [],
    })(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const bundle = writeAgentBundle();
  const built = wired.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok);
  const entry = wired.catalog
    .listEntries()
    .find((candidate) => candidate.id === bundle.id);
  assert.ok(entry);
  const created = wired.runGroup.createRun({
    operationId: "seed-model-run",
    bundleSnapshotDigest: entry.digest,
    launch: {},
    selectedHarness: "claude-code",
    modelChoice: { model: "alpha", effort: "high" },
    at: new Date(),
  });
  assert.equal(created.outcome, "created");
  const owner = wired.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  assert.ok(owner.writeState("halted").ok);
  assert.ok(owner.release().ok);
  owner.close();
  const view = createLiveRunWorkbenchView(wired.projectionPort);
  const projection = createRoot((dispose) => {
    t.after(dispose);
    return view.openRun(created.runId);
  });
  const changeOffer = () => {
    const result = projection.snapshot().result;
    return result.found
      ? result.run.actionOffers.find(
          (offer) => offer.action === "change-model-choice",
        )
      : undefined;
  };
  await until(() => changeOffer()?.available === true);
  const offer = changeOffer();
  assert.ok(offer?.available === true);
  const actions = createLiveRunActionsView(wired.projectionPort);
  const changed = actions.changeModelChoice(offer, { model: "beta" });
  await until(() => changed().kind !== "pending");
  assert.deepEqual(changed(), {
    kind: "ok",
    modelChoiceChange: {
      choice: { model: "beta", effort: "medium" },
      reach: "next-turn",
      effortReset: {
        previous: "high",
        effort: "medium",
        explanation:
          "beta does not offer high effort. Effort changed to medium, its default.",
      },
    },
  });
  await until(() => {
    const result = projection.snapshot().result;
    return result.found && result.run.modelChoice?.model === "beta";
  });
  const refused = actions.changeModelChoice(offer, { model: "unknown" });
  await until(() => refused().kind !== "pending");
  const failure = refused();
  assert.equal(failure.kind, "refused");
  if (failure.kind === "refused")
    assert.equal(failure.problem.code, "requested-model-unavailable");
  const result = projection.snapshot().result;
  assert.ok(result.found);
  assert.deepEqual(result.run.modelChoice, { model: "beta", effort: "medium" });
});
