import { inertPreferencesView } from "./inert.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { createSignal } from "solid-js";
import { App, createLiveRunLaunchView } from "../../src/tui/tui.js";
import { inertRunActionsView, inertRunListView, runSummary } from "./inert.js";
import type {
  BundleCatalogView,
  HarnessCatalogView,
  LaunchPreparationView,
  LaunchOutcome,
  RunLaunchView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  HarnessCatalogSnapshot,
  HarnessFocus,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
  HarnessSummary,
  InstalledBundleFocus,
  LaunchPreparationSnapshot,
  LaunchRunInput,
  OpenedProjection,
  OperationSnapshot,
  Problem,
  ProjectionPort,
  ProjectionSelector,
  RunSnapshot,
  Submission,
  SubmissionAdmission,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests for the Start-a-Run flow (#90, #191, #192). They drive
// the real App over fake Bundle, Harness, launch-preparation, and launch seams:
// assessment states and complete Review fields, ready-only submission, precise
// inline findings, every correction route with selective clearing, the dismissible
// refusal notice, and success into the Workbench. The last group exercises the live
// launch seam over fake `operation`/`run` snapshots.
//
// #191 slice coverage (AC7): keymap and focus (choose/model/inputs bindings and the
// spawn-free-until-choose Harness step), terminal layout and small sizes (40/30-col
// relayout without overflow), colour-independent status (worded qualification and
// model, never a raw enum), interaction tuning (the two-phase Harness step), and
// renderer evidence (every model-field variant and the `N of M` count). Timeline
// mechanics and large content do not apply — this slice owns no timeline or
// scrollable region — and the Windows Terminal check does not apply because it
// changes neither the renderer nor a pin.
//
// #192 slice coverage: Review and refusal tests cover keyboard focus, 40x20 and
// narrow layouts, worded colour-independent states, notice dismissal, and the
// fake-view-seam renderer path. Timeline mechanics and large content do not apply;
// renderer/pin code is unchanged, so the Windows Terminal check does not apply.
//
// #286 slice coverage (the `[start-run-checking]` and `[start-run-highlight]`
// groups): keymap and focus (Enter, ←/→, and typing are inert while models are
// checked; a click highlights without choosing), small terminals and resize
// (40/30 columns mid-check), large content (names longer than the row), interaction
// tuning (the check settling into the model control or the unavailable block, and
// Esc back to the list mid-check), meaning without colour (the glyph and the
// checking words in character frames, the fill and bold in spans), and renderer
// evidence through `testRender` with the fake Renderer Port.
//
// #349 renderer evidence: the guided model and effort stages, per-model resets,
// suggested aliases and native Other input, effort locks and absence, held keys,
// page navigation over long lists, and preserved choice/focus across 60x24 and
// 140x44 resize. Character frames prove current/source/reason meaning without
// colour. The canonical test suite runs these same cases on all three CI platforms.
//
// #350 renderer evidence (the `[start-run-review-edit]` group): keymap and focus
// (Tab and Shift+Tab over Harness, Model, editable Effort, and Start in both
// directions, a locked or unavailable Effort skipped but explained), small
// terminals and resize (all seven #311 cases at 60x24 and 140x44, resized while a
// Review field is focused and again mid-selection inside its edit), large content
// (PgUp/PgDn reach every line of a long reason, and Tab scrolls the focused field
// back into view), interaction tuning (editing returns to Review on the edited
// field without replaying Launch inputs or trust, Esc abandons an edit, Tab moves
// between the guided model stage and the Harness, a Harness change reloads its
// preselection and check (asking for a model when it has none), and Start holds
// through every fresh check and submits only the current ready Offer), and meaning without colour
// (the `›` glyph in character frames, bold in spans). Renderer and platform
// evidence: these run through `testRender` with the fake Renderer Port on all
// three CI platforms; no renderer or pin changed.

const WORKSPACE = "/tmp/secant-launch-workspace";

const DEFAULT_HARNESSES: WorkspaceSnapshot["harnesses"] = [
  { id: "claude-code", name: "Claude Code", availability: "available" },
  { id: "codex", name: "Codex", availability: "available" },
];

function approvedWorkspace(
  harnesses: WorkspaceSnapshot["harnesses"] = DEFAULT_HARNESSES,
): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 2,
    runSummary: runSummary(),
    startupNotices: [],
    harnesses,
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

// --- fake bundle-catalog ---------------------------------------------------

function focus(
  over: Partial<InstalledBundleFocus> & { id: string },
): InstalledBundleFocus {
  const digest = over.digest ?? `digest-${over.id}`;
  return {
    id: over.id,
    version: over.version ?? "1.0.0",
    digest,
    name: over.name ?? over.id,
    description: over.description ?? "A bundle.",
    origin: over.origin ?? { kind: "local-file", location: "/bundles/x.wfb" },
    shippedWithRunningSecant: over.shippedWithRunningSecant ?? false,
    stability: over.stability ?? "stable",
    platforms: over.platforms ?? ["linux"],
    engine: over.engine ?? { range: ">=0.1.0", satisfied: true },
    trust: over.trust ?? { state: "app-release" },
    author: over.author ?? {},
    launchInputs: over.launchInputs ?? [],
    routing: over.routing ?? [
      { node: "step", step: { id: "build", kind: "command" } },
    ],
    workspacePrerequisites: over.workspacePrerequisites ?? [],
    producedArtifacts: over.producedArtifacts ?? [],
    executionSummary: over.executionSummary ?? {
      platform: "linux",
      identity: { id: over.id, version: over.version ?? "1.0.0" },
      digest,
      origin: over.origin ?? { kind: "local-file", location: "/bundles/x.wfb" },
      platforms: ["linux"],
      stepKindCounts: { command: 1 },
      commands: [],
      warning: "Commands run with your user's authority.",
    },
    compositionFindings: over.compositionFindings ?? [],
  };
}

function catalog(bundles: readonly InstalledBundleFocus[]): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles },
  });
  return {
    openList: () => list,
    openFocus: (selector: BundleFocusSelector) => {
      const bundle = bundles.find(
        (candidate) =>
          candidate.id === selector.id &&
          (selector.version === undefined ||
            candidate.version === selector.version),
      );
      const [snapshot] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result:
          bundle !== undefined
            ? { found: true, bundle }
            : {
                found: false,
                problem: {
                  code: "bundle-not-installed",
                  explanation: "gone",
                  remediation: "install",
                  possibleEffects: "none",
                },
              },
      });
      return snapshot;
    },
  };
}

// --- fake harness-catalog --------------------------------------------------

interface HarnessSpec {
  readonly id: "claude-code" | "codex";
  readonly name: string;
  /** A declared model list, `"free-text"`, or `undefined` for none. */
  readonly models?: readonly string[] | "free-text";
  readonly declaration?: HarnessFocus["modelDeclaration"];
  readonly preferenceNotice?: string;
  /** The Application's preselection the focus carries, when the Harness reports
   *  one (ADR 0034). */
  readonly preselection?: HarnessFocus["preselection"];
  /** When present, focus resolves unavailable with this Problem. */
  readonly unavailable?: Problem;
  /** When present, the list-view discovery is not-found (colour-independent
   *  unavailability visible before focusing). */
  readonly notFound?: boolean;
}

const OBSERVATION = {
  executable: "/usr/bin/harness",
  executableVersion: "1.0.0",
  platform: "linux" as const,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

function summaryOf(spec: HarnessSpec): HarnessSummary {
  return {
    id: spec.id,
    name: spec.name,
    discovery: spec.notFound
      ? {
          state: "not-found",
          searched: ["/usr/bin"],
          executableEnvironmentVariable: "SECANT_HARNESS",
        }
      : { state: "found", source: "path", description: "/usr/bin/harness" },
    qualification: { state: "not-checked" },
  };
}

function focusOf(spec: HarnessSpec): HarnessFocus {
  const summary = summaryOf(spec);
  if (spec.unavailable !== undefined) {
    return {
      ...summary,
      qualification: { state: "not-ready", checkedAt: OBSERVATION.checkedAt },
      capabilities: [],
      unavailable: spec.unavailable,
    };
  }
  const supportedModels =
    spec.models === undefined
      ? undefined
      : spec.models === "free-text"
        ? ({ kind: "free-text" } as const)
        : ({ kind: "list", models: spec.models } as const);
  const modelDeclaration =
    spec.declaration ??
    (spec.models === undefined
      ? undefined
      : spec.models === "free-text"
        ? ({
            kind: "free-text",
            efforts: ["low", "medium", "high", "xhigh", "max"],
          } as const)
        : ({
            kind: "list",
            models: spec.models.map((model) => ({
              model,
              label: model,
              efforts: ["low", "medium", "high", "xhigh", "max"],
              defaultEffort: "medium",
            })),
          } as const));
  return {
    ...summary,
    qualification: { state: "qualified", observation: OBSERVATION },
    ...(supportedModels === undefined ? {} : { supportedModels }),
    ...(modelDeclaration === undefined ? {} : { modelDeclaration }),
    ...(spec.preselection === undefined
      ? {}
      : { preselection: spec.preselection }),
    ...(spec.preferenceNotice === undefined
      ? {}
      : { preferenceNotice: spec.preferenceNotice }),
    capabilities: [],
    configurationPosture: "Harness-owned settings stay with the Harness.",
  };
}

/** A fake `harness-catalog` view whose list is spawn-free and whose focus records
 *  every qualified id, so a test can assert that opening the step spawns nothing
 *  and choosing a Harness qualifies only that one. */
function harnessCatalog(specs: readonly HarnessSpec[]): {
  view: HarnessCatalogView;
  focusCalls: string[];
} {
  const focusCalls: string[] = [];
  const [list] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: specs.map(summaryOf),
  });
  const view: HarnessCatalogView = {
    openList: () => list,
    openFocus: (selector: HarnessFocusSelector) => {
      focusCalls.push(selector.id);
      const spec = specs.find((candidate) => candidate.id === selector.id);
      const [snapshot] = createSignal<HarnessFocusSnapshot>({
        family: "harness-catalog",
        view: "focus",
        selection: selector,
        result:
          spec !== undefined
            ? { found: true, harness: focusOf(spec) }
            : {
                found: false,
                problem: {
                  code: "harness-not-registered",
                  explanation: "gone",
                  remediation: "register",
                  possibleEffects: "none",
                },
              },
      });
      return snapshot;
    },
  };
  return { view, focusCalls };
}

/** A fake `harness-catalog` view whose focus opens `not-checked`, as the
 *  Application's uncached focus does while qualification runs, and publishes
 *  its result only when the test calls `settle`. Like the fixed list above, the
 *  list is not re-pushed on settle, so only the focus carries the result. */
function checkingHarnessCatalog(specs: readonly HarnessSpec[]): {
  view: HarnessCatalogView;
  settle: (id: HarnessSpec["id"]) => void;
  hold: (id: HarnessSpec["id"]) => void;
} {
  const [list] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: specs.map(summaryOf),
  });
  const settlers = new Map<string, () => void>();
  const holders = new Map<string, () => void>();
  const view: HarnessCatalogView = {
    openList: () => list,
    openFocus: (selector: HarnessFocusSelector) => {
      const spec = specs.find((candidate) => candidate.id === selector.id);
      if (spec === undefined) throw new Error(`no Harness ${selector.id}`);
      const [snapshot, setSnapshot] = createSignal<HarnessFocusSnapshot>({
        family: "harness-catalog",
        view: "focus",
        selection: selector,
        result: {
          found: true,
          harness: { ...summaryOf(spec), capabilities: [] },
        },
      });
      holders.set(selector.id, () =>
        setSnapshot({
          family: "harness-catalog",
          view: "focus",
          selection: selector,
          result: {
            found: true,
            harness: { ...summaryOf(spec), capabilities: [] },
          },
        }),
      );
      settlers.set(selector.id, () =>
        setSnapshot({
          family: "harness-catalog",
          view: "focus",
          selection: selector,
          result: { found: true, harness: focusOf(spec) },
        }),
      );
      return snapshot;
    },
  };
  const settle = (id: HarnessSpec["id"]) => {
    const settler = settlers.get(id);
    if (settler === undefined) throw new Error(`${id} focus was never opened`);
    settler();
  };
  const hold = (id: HarnessSpec["id"]) => {
    const holder = holders.get(id);
    if (holder === undefined) throw new Error(`${id} focus was never opened`);
    holder();
  };
  return { view, settle, hold };
}

const AVAILABLE_HARNESSES: readonly HarnessSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    models: ["claude-sonnet"],
    preselection: {
      choice: { model: "claude-sonnet", effort: "medium" },
      source: { kind: "reported" },
    },
  },
  {
    id: "codex",
    name: "Codex",
    models: ["gpt-5-codex", "gpt-5"],
    preselection: {
      choice: { model: "gpt-5", effort: "high" },
      source: { kind: "reported" },
    },
  },
];

function defaultHarnessCatalog(): HarnessCatalogView {
  return harnessCatalog(AVAILABLE_HARNESSES).view;
}

// --- hand-driven launch seam -----------------------------------------------

function fakeLaunch() {
  const calls: LaunchRunInput[] = [];
  const [outcome, setOutcome] = createSignal<LaunchOutcome>({
    kind: "pending",
  });
  const view: RunLaunchView = {
    launch(input) {
      calls.push(input);
      return outcome;
    },
  };
  return { view, calls, resolve: (o: LaunchOutcome) => setOutcome(() => o) };
}

/** The model the fake assessment preselects when a draft names none. */
const PRESELECTED_MODEL = "preselected-model";

/** What the fake assessment resolves for an Agent draft (ADR 0034): the named
 *  model as the person's choice, else the preselection with its source. A
 *  Command-only draft (no Harness) resolves none. */
function resolvedChoice(
  draft: LaunchRunInput,
): LaunchPreparationSnapshot["draft"]["modelChoice"] {
  if (draft.harness === undefined) return undefined;
  return draft.requestedModel !== undefined
    ? {
        model: draft.requestedModel,
        effort: draft.requestedEffort,
        source: { kind: "requested" },
      }
    : {
        model: PRESELECTED_MODEL,
        effort: "medium",
        source: { kind: "reported" },
      };
}

/** The draft the fake `launch-run` Offer carries: the resolved choice in place. */
function offeredDraft(draft: LaunchRunInput): LaunchRunInput {
  const choice = resolvedChoice(draft);
  return choice === undefined
    ? draft
    : {
        ...draft,
        requestedModel: choice.model,
        ...(choice.effort !== undefined
          ? { requestedEffort: choice.effort }
          : {}),
      };
}

/** The resolved choice a draft view carries: only a ready assessment has one. */
function readyChoice(
  status: LaunchPreparationSnapshot["status"],
  draft: LaunchRunInput,
): Pick<LaunchPreparationSnapshot["draft"], "modelChoice"> {
  const choice = status === "ready" ? resolvedChoice(draft) : undefined;
  return choice === undefined ? {} : { modelChoice: choice };
}

function preparation(status: LaunchPreparationSnapshot["status"] = "ready") {
  const view: LaunchPreparationView = {
    open(draft) {
      const actionOffers: LaunchPreparationSnapshot["actionOffers"] =
        status === "ready"
          ? [
              {
                action: "launch-run",
                draft: offeredDraft(draft),
                trustRequired: draft.trustDigest !== undefined,
                consequence: "Create and start a Run.",
              },
            ]
          : [];
      const [snapshot] = createSignal<LaunchPreparationSnapshot>({
        family: "launch-preparation",
        status,
        draft: {
          bundle: { id: draft.bundle.id, version: draft.bundle.version },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          ...readyChoice(status, draft),
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings: [],
        actionOffers,
      });
      return snapshot;
    },
  };
  return view;
}

function controlledPreparation() {
  let updateSnapshot:
    ((snapshot: LaunchPreparationSnapshot) => void) | undefined;
  let openedDraft: LaunchRunInput | undefined;
  const view: LaunchPreparationView = {
    open(draft) {
      openedDraft = draft;
      const [snapshot, setSnapshot] = createSignal<LaunchPreparationSnapshot>({
        family: "launch-preparation",
        status: "assessing",
        draft: {
          bundle: { id: draft.bundle.id, version: draft.bundle.version },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          ...readyChoice("assessing", draft),
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings: [],
        actionOffers: [],
      });
      updateSnapshot = (next) => setSnapshot(() => next);
      return snapshot;
    },
  };
  const settle = (
    status: "ready" | "not-ready",
    findings: readonly Problem[],
    modelChoice?: LaunchPreparationSnapshot["draft"]["modelChoice"],
    preferenceNotice?: string,
  ) => {
    if (openedDraft === undefined || updateSnapshot === undefined) {
      throw new Error("Review must open preparation before it can settle");
    }
    const actionOffers: LaunchPreparationSnapshot["actionOffers"] =
      status === "ready"
        ? [
            {
              action: "launch-run",
              draft: offeredDraft(openedDraft),
              trustRequired: openedDraft.trustDigest !== undefined,
              consequence: "Create and start a Run.",
            },
          ]
        : [];
    updateSnapshot({
      family: "launch-preparation",
      status,
      draft: {
        bundle: {
          id: openedDraft.bundle.id,
          version: openedDraft.bundle.version,
          digest: "alpha0000",
          name: "Alpha",
        },
        harness: openedDraft.harness,
        requestedModel: openedDraft.requestedModel,
        ...readyChoice(status, openedDraft),
        ...(modelChoice === undefined ? {} : { modelChoice }),
        ...(preferenceNotice === undefined ? {} : { preferenceNotice }),
        launchInputs: openedDraft.launchInputs,
        trustDigest: openedDraft.trustDigest,
      },
      findings,
      executionSummary: ALPHA.executionSummary,
      actionOffers,
    });
  };
  return { view, settle };
}

function readyPreparationFor(
  bundle: InstalledBundleFocus,
): LaunchPreparationView {
  return {
    open(draft) {
      const [snapshot] = createSignal<LaunchPreparationSnapshot>({
        family: "launch-preparation",
        status: "ready",
        draft: {
          bundle: {
            id: bundle.id,
            version: bundle.version,
            digest: bundle.digest,
            name: bundle.name,
          },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          ...readyChoice("ready", draft),
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings: [],
        executionSummary: bundle.executionSummary,
        actionOffers: [
          {
            action: "launch-run",
            draft: offeredDraft(draft),
            trustRequired: draft.trustDigest !== undefined,
            consequence: "Create and start a Run.",
          },
        ],
      });
      return snapshot;
    },
  };
}

function trustPreparation(bundle: InstalledBundleFocus): LaunchPreparationView {
  return {
    open(draft) {
      const acknowledged = draft.trustDigest === bundle.digest;
      const findings: readonly Problem[] = acknowledged
        ? []
        : [
            {
              code: "bundle-trust-required",
              explanation: "Trust acknowledgement is required.",
              remediation: "Acknowledge this exact Bundle digest.",
              possibleEffects: "none",
              correction: "trust",
            },
          ];
      const actionOffers: LaunchPreparationSnapshot["actionOffers"] =
        acknowledged
          ? [
              {
                action: "launch-run",
                draft: offeredDraft(draft),
                trustRequired: true,
                consequence: "Create and start a Run.",
              },
            ]
          : [];
      const [snapshot] = createSignal<LaunchPreparationSnapshot>({
        family: "launch-preparation",
        status: acknowledged ? "ready" : "not-ready",
        draft: {
          bundle: {
            id: bundle.id,
            version: bundle.version,
            digest: bundle.digest,
            name: bundle.name,
          },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          ...readyChoice(acknowledged ? "ready" : "not-ready", draft),
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings,
        executionSummary: bundle.executionSummary,
        actionOffers,
      });
      return snapshot;
    },
  };
}

// The Run Workbench opens only after a successful launch; most flow tests never
// get there. This stub throws if opened, so a stray transition is caught.
function noRunView(): RunWorkbenchView {
  return {
    openHistory() {
      throw new Error("history not used in this test");
    },
    openRun() {
      throw new Error("run workbench not opened in this test");
    },
    readResource() {
      throw new Error("run workbench not opened in this test");
    },
    readTranscript() {
      throw new Error("run workbench not opened in this test");
    },
    answer() {
      throw new Error("run workbench not opened in this test");
    },
    sendInteractiveTurn() {
      throw new Error("run workbench not opened in this test");
    },
    sendFollowUpTurn() {
      throw new Error("run workbench not opened in this test");
    },
    endInteractiveStep() {
      throw new Error("run workbench not opened in this test");
    },
    continueRepeat() {
      throw new Error("run workbench not opened in this test");
    },
    endStage() {
      throw new Error("run workbench not opened in this test");
    },
    steer() {
      throw new Error("run workbench not opened in this test");
    },
    answerText() {
      throw new Error("run workbench not opened in this test");
    },
    answerRequest() {
      throw new Error("run workbench not opened in this test");
    },
  };
}

// A Run Workbench seam that serves any requested Run id as a resting, succeeded
// Run, so the receipt-replacement tests can assert the transition into it (#91).
function succeedingRunView(): RunWorkbenchView {
  return {
    openHistory() {
      throw new Error("history not used in this test");
    },
    openRun(runId) {
      const [snapshot] = createSignal<RunSnapshot>({
        family: "run",
        runId,
        result: {
          found: true,
          run: {
            runId,
            bundle: {
              id: "dev.alpha",
              version: "1.0.0",
              name: "Alpha",
              digest: "d",
            },
            workspacePath: WORKSPACE,
            launchedAt: "2026-01-01T00:00:00.000Z",
            state: "succeeded",
            liveness: { state: "not-live" },
            progress: [],
            position: 0,
            timeline: [],
            outputs: [],
            actionOffers: [],
          },
        },
      });
      return {
        snapshot,
        live: () => undefined,
        freshness: () => ({
          kind: "current",
          catchUp: "fresh",
          lastConfirmedAt: "2026-09-22T10:30:00.000Z",
        }),
        reconnect() {},
      };
    },
    readResource() {
      throw new Error("no reference read in this test");
    },
    readTranscript() {
      throw new Error("no transcript read in this test");
    },
    answer() {
      throw new Error("no answer dispatched in this test");
    },
    sendInteractiveTurn() {
      throw new Error("no interactive Turn sent in this test");
    },
    sendFollowUpTurn() {
      throw new Error("no follow-up sent in this test");
    },
    endInteractiveStep() {
      throw new Error("no interactive Step ended in this test");
    },
    continueRepeat() {
      throw new Error("no interactive Step ended in this test");
    },
    endStage() {
      throw new Error("no interactive Step ended in this test");
    },
    steer() {
      throw new Error("no steer dispatched in this test");
    },
    answerText() {
      throw new Error("no answer dispatched in this test");
    },
    answerRequest() {
      throw new Error("no answer dispatched in this test");
    },
  };
}

async function mountFlow(
  bundlesView: BundleCatalogView,
  launchView: RunLaunchView,
  width = 100,
  height = 40,
  runView: RunWorkbenchView = noRunView(),
  harnessesView: HarnessCatalogView = defaultHarnessCatalog(),
  preparationView: LaunchPreparationView = preparation(),
  // Modified Enter keys (Shift/Ctrl/Alt) are distinguishable only under the kitty
  // keyboard protocol, which the production renderer requests (#287).
  kittyKeyboard = false,
) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        preferences={inertPreferencesView()}
        view={approvedWorkspace()}
        bundles={bundlesView}
        harnesses={harnessesView}
        preparation={preparationView}
        launch={launchView}
        run={runView}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer(width, height).port}
        reducedMotion={false}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height, kittyKeyboard },
  );
  await t.waitForFrame((f) => f.includes("Secant"));
  // Home starts without a selection; explicitly select Start a Run.
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  // "esc back" is in every chooser footer but not Home's, so it marks arrival.
  await t.waitForFrame((f) => f.includes("esc back"));
  return { t, exits };
}

async function chooseGuided(t: Awaited<ReturnType<typeof testRender>>) {
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  t.mockInput.pressEnter();
}

const ALPHA = focus({
  id: "dev.alpha",
  name: "Alpha",
  description: "The trusted one",
  digest: "alpha0000",
  trust: { state: "app-release" },
  launchInputs: [],
});
const AGENT_ALPHA = focus({
  id: "dev.agent-alpha",
  name: "Agent Alpha",
  description: "The agent-bearing one",
  digest: "agentalpha000",
  trust: { state: "app-release" },
  launchInputs: [],
  routing: [{ node: "step", step: { id: "work", kind: "agent" } }],
});
const BETA = focus({
  id: "dev.beta",
  name: "Beta",
  description: "The untrusted one",
  digest: "beta1111",
  trust: { state: "not-yet-trusted" },
  launchInputs: [
    { name: "target", type: "text", description: "What to build" },
    {
      name: "mode",
      type: "choice",
      description: "How to run",
      choices: ["fast", "slow"],
    },
  ],
});
const AGENT_BETA = focus({
  id: "dev.agent-beta",
  name: "Agent Beta",
  description: "An agent Bundle with draft input.",
  digest: "agentbeta111",
  trust: { state: "app-release" },
  launchInputs: [
    { name: "target", type: "text", description: "What to build" },
  ],
  routing: [{ node: "step", step: { id: "work", kind: "agent" } }],
});
const UNTRUSTED_AGENT_BETA = focus({
  id: "dev.untrusted-agent-beta",
  name: "Untrusted Agent Beta",
  description: "An untrusted agent Bundle with one input.",
  digest: "untrustedagentbeta111",
  trust: { state: "not-yet-trusted" },
  launchInputs: [
    { name: "target", type: "text", description: "What to build" },
  ],
  routing: [{ node: "step", step: { id: "work", kind: "agent" } }],
});

// Two trusted Bundles that both declare an input named `target`, for the
// cross-Bundle draft-leak test.
const GAMMA = focus({
  id: "dev.gamma",
  name: "Gamma",
  description: "trusted one",
  digest: "gamma000",
  trust: { state: "app-release" },
  launchInputs: [{ name: "target", type: "text", description: "for gamma" }],
});
const DELTA = focus({
  id: "dev.delta",
  name: "Delta",
  description: "trusted two",
  digest: "delta000",
  trust: { state: "app-release" },
  launchInputs: [{ name: "target", type: "text", description: "for delta" }],
});
// A second untrusted Bundle, for the acknowledgement-persistence test.
const EPSILON = focus({
  id: "dev.epsilon",
  name: "Epsilon",
  description: "untrusted two",
  digest: "eps22222",
  trust: { state: "not-yet-trusted" },
  launchInputs: [],
});

// --- chooser + trust -------------------------------------------------------

test("chooser lists Bundles with the side panel; untrusted shows the acknowledgement, trusted does not; Continue is gated", async () => {
  const { t } = await mountFlow(catalog([ALPHA, BETA]), fakeLaunch().view);
  const first = t.captureCharFrame();
  // Side panel limited to Name, Description, Source, Workflow.
  assert.match(first, /Name/);
  assert.match(first, /The trusted one/);
  assert.match(first, /Source/);
  assert.match(first, /Workflow/);
  assert.match(first, /build \(command\)/);
  // Trusted selection: no acknowledgement, Continue available.
  assert.doesNotMatch(first, /acknowledge/i);
  assert.match(first, /enter continue/);

  // Move to the untrusted Bundle.
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => /acknowledge/i.test(f));
  const untrusted = t.captureCharFrame();
  assert.match(untrusted, /Untrusted Bundle/);
  assert.match(untrusted, /press a to acknowledge/);
  // Continue unavailable until acknowledged.
  assert.match(untrusted, /acknowledge trust \(a\) to continue/);

  // Acknowledge.
  t.mockInput.pressKey("a");
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  assert.match(t.captureCharFrame(), /enter continue/);
});

test("a Bundle with no declared inputs skips the inputs screen and reaches review, digest shown once", async () => {
  const { t } = await mountFlow(
    catalog([ALPHA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    defaultHarnessCatalog(),
    preparation("assessing"),
  );
  t.mockInput.pressEnter(); // Alpha is trusted + no inputs → straight to review
  await t.waitForFrame((f) => f.includes("Review"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Checking launch/);
  assert.match(frame, /No launch inputs/);
  assert.match(frame, /sha256:alpha0000/);
  assert.equal(
    frame.split("alpha0000").length - 1,
    1,
    "digest shown exactly once",
  );
});

test("[start-run-review-assessment] assessing and not-ready block Start Run; ready enables it and launch settles visibly", async () => {
  const launch = fakeLaunch();
  const assessment = controlledPreparation();
  const { t } = await mountFlow(
    catalog([ALPHA]),
    launch.view,
    100,
    40,
    noRunView(),
    defaultHarnessCatalog(),
    assessment.view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.equal(launch.calls.length, 0, "assessing cannot submit");

  assessment.settle("not-ready", [
    {
      code: "workspace-prerequisite-failed",
      explanation: "Workspace prerequisite not met.",
      remediation: "Launch Secant from a Git worktree root.",
      possibleEffects: "none",
      correction: "workspace",
    },
  ]);
  await t.waitForFrame((frame) => frame.includes("Workspace prerequisite"));
  const refused = t.captureCharFrame();
  assert.match(refused, /Not ready/);
  assert.match(refused, /Launch Secant from a Git worktree root/);
  assert.doesNotMatch(refused, /workspace-prerequisite-failed/);
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.equal(launch.calls.length, 0, "not-ready cannot submit");

  assessment.settle("ready", []);
  await t.waitForFrame((frame) => frame.includes("Ready to start"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  assert.equal(launch.calls.length, 1);
});

test("[start-run-review-assessment] Review renders the complete assessed draft and exact trust posture", async () => {
  const { t } = await mountFlow(
    catalog([UNTRUSTED_AGENT_BETA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    defaultHarnessCatalog(),
    readyPreparationFor(UNTRUSTED_AGENT_BETA),
  );
  t.mockInput.pressKey("a");
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  t.mockInput.typeText("hi");
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  await chooseGuided(t);
  await t.waitForFrame((f) => f.includes("Review"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Workflow.*work \(agent\)/s);
  assert.match(frame, /Bundle.*Untrusted Agent Beta/s);
  assert.match(frame, /sha256:untrustedagentbeta111/);
  assert.match(frame, /Workspace.*secant-launch-workspace/s);
  assert.match(frame, new RegExp(WORKSPACE.replaceAll("/", "\\/")));
  assert.match(frame, /Harness: Claude Code \(claude-code\)/);
  assert.match(frame, /Model: preselected-model/);
  assert.match(frame, /Effort: medium/);
  assert.match(frame, /From your Claude Code settings/);
  assert.match(frame, /target: hi/);
  assert.match(frame, /Trust: Exact digest acknowledged for this launch/);
  assert.equal(frame.split("untrustedagentbeta111").length - 1, 1);
});

test("[both-client-harness-selection] Harness selection is spawn-free until chosen, then qualifies only that Harness", async () => {
  const harnesses = harnessCatalog(AVAILABLE_HARNESSES);
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    launch.view,
    40,
    20,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Claude Code/);
  assert.match(frame, /Codex/);
  assert.match(frame, /Not checked/);
  assert.doesNotMatch(frame, /availability|found via|\/usr\/bin\/harness/i);
  assert.deepEqual(harnesses.focusCalls, []);
  for (const line of frame.split("\n")) assert.ok(line.length <= 40);
  t.mockInput.pressArrow("down");
  assert.deepEqual(harnesses.focusCalls, []);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  assert.deepEqual(harnesses.focusCalls, ["codex"]);
  await chooseGuided(t);
  await t.waitForFrame((f) => f.includes("Review"));
  assert.match(t.captureCharFrame(), /Harness: Codex \(codex\)/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(launch.calls[0]?.harness, "codex");
  assert.equal(launch.calls[0]?.requestedModel, PRESELECTED_MODEL);
  assert.equal(launch.calls[0]?.requestedEffort, "medium");
});

for (const correction of ["harness", "model", "effort"] as const) {
  test(`a ${correction} refusal preserves unrelated Launch inputs and routes to the correction`, async () => {
    const launch = fakeLaunch();
    const { t } = await mountFlow(catalog([AGENT_BETA]), launch.view);
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Launch inputs"));
    t.mockInput.typeText("hi");
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    await chooseGuided(t);
    await t.waitForFrame((f) => f.includes("Review"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Checking launch"));
    launch.resolve({
      kind: "refused",
      problem: {
        code: "choice-unavailable",
        explanation: "The selected choice is no longer available.",
        remediation: "Choose again.",
        possibleEffects: "none",
        correction,
      },
    });
    await t.waitForFrame((f) => f.includes("Run not started"));
    const frame = t.captureCharFrame();
    assert.match(frame, /selected choice/);
    if (correction === "harness") {
      assert.match(frame, /Choose a Harness/);
      assert.match(frame, /› Claude Code/);
      t.mockInput.pressArrow("down");
      t.mockInput.pressEnter();
      await t.waitForFrame((f) => f.includes("Launch inputs"));
      assert.match(t.captureCharFrame(), /hi/);
      t.mockInput.pressEnter();
      await t.waitForFrame((f) => f.includes("1. Choose a model"));
    } else {
      assert.match(frame, /Harness: Claude Code/);
      assert.match(
        frame,
        correction === "model" ? /1. Choose a model/ : /2. Choose effort/,
      );
    }
    if (correction !== "effort") await chooseGuided(t);
    else t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Review"));
    assert.match(t.captureCharFrame(), /target: hi/);
  });
}

test("an unavailable Harness names its reason and remediation, cannot continue, and relayouts after resize", async () => {
  const harnesses = harnessCatalog([
    { id: "claude-code", name: "Claude Code", models: ["claude-sonnet"] },
    {
      id: "codex",
      name: "Codex",
      notFound: true,
      unavailable: {
        code: "harness-not-ready",
        explanation: "Codex support is disabled in this build.",
        remediation: "Enable Codex, or choose another Harness.",
        possibleEffects: "none",
      },
    },
  ]);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    50,
    20,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  // Availability is visible in words before focusing the unavailable Harness.
  assert.match(t.captureCharFrame(), /Unavailable · not found on/);
  t.mockInput.pressArrow("down"); // highlight Codex
  t.mockInput.pressEnter(); // choose Codex → its focus is unavailable
  await t.waitForFrame((frame) => frame.includes("Codex support is disabled"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Codex support is disabled/);
  assert.match(frame, /Enable Codex/);
  t.mockInput.pressEnter(); // cannot continue while unavailable
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Choose a Harness/);
  assert.doesNotMatch(t.captureCharFrame(), /Review/);
  t.resize(30, 20);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(line.length <= 30, `overflow at 30: ${JSON.stringify(line)}`);
  }
});

// --- #286: checking models and highlighted choices -------------------------

/** The styled span of the choice row titled `title`, and the screen background
 *  (the bundle-catalog test's `rowSpan`). */
function rowSpan(t: Awaited<ReturnType<typeof mountFlow>>["t"], title: string) {
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

const CHECKED_HARNESSES: readonly HarnessSpec[] = [
  { id: "claude-code", name: "Claude Code", models: "free-text" },
  {
    id: "codex",
    name: "Codex",
    models: ["gpt-5-codex", "gpt-5"],
    preselection: {
      choice: { model: "gpt-5", effort: "high" },
      source: { kind: "reported" },
    },
  },
];

test("[start-run-checking] while models are checked the step says so and holds Continue; once qualified the model control and Continue appear", async () => {
  const harnesses = checkingHarnessCatalog(CHECKED_HARNESSES);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressArrow("down"); // highlight Codex
  t.mockInput.pressEnter(); // choose Codex → its check starts
  await t.waitForFrame((frame) => frame.includes("Harness: Codex"));

  const checking = t.captureCharFrame();
  assert.match(checking, /Checking models…/);
  assert.doesNotMatch(checking, /Not checked/);
  assert.doesNotMatch(checking, /Qualifying/);
  // No model control until the check settles, so a list Harness never reads
  // as default-only.
  assert.doesNotMatch(checking, /Harness default/);
  assert.doesNotMatch(checking, /Model/);
  // Continue is not offered: the footer drops it.
  assert.match(checking, /esc choose another · q quit/);
  assert.doesNotMatch(checking, /enter continue/);

  // Enter does nothing and ←/→ cycles nothing while the check runs.
  t.mockInput.pressEnter();
  t.mockInput.pressArrow("right");
  await t.renderOnce();
  const held = t.captureCharFrame();
  assert.match(held, /Checking models…/);
  assert.doesNotMatch(held, /Review/);

  harnesses.settle("codex");
  await t.waitForFrame((frame) => frame.includes("Model choices loaded"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("› gpt-5 [current]"));
  const settled = t.captureCharFrame();
  assert.match(settled, /Qualified/);
  // The field opens on the preselection and names where it came from.
  assert.match(settled, /Starts from gpt-5 at high effort/);
  assert.match(settled, /From your Codex settings/);
  assert.doesNotMatch(settled, /Checking models/);
  assert.match(settled, /gpt-5-codex/);
  assert.match(settled, /↑\/↓ move · enter choose/);

  await chooseGuided(t); // Model then effort → Review
  await t.waitForFrame((frame) => frame.includes("Review"));
  assert.match(t.captureCharFrame(), /Harness: Codex \(codex\)/);
});

test("[start-run-checking] a free-text Harness mounts no model field until its check settles", async () => {
  const harnesses = checkingHarnessCatalog(CHECKED_HARNESSES);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressEnter(); // choose Claude Code (free-text)
  await t.waitForFrame((frame) => frame.includes("Checking models…"));
  assert.doesNotMatch(t.captureCharFrame(), /Type an exact model name/);
  t.mockInput.pressKey("o"); // nothing to type into
  await t.renderOnce();

  harnesses.settle("claude-code");
  await t.waitForFrame((frame) => frame.includes("Model choices loaded"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Other… exact model name"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("enter accept"));
  t.mockInput.pressKey("o");
  t.mockInput.pressKey("4");
  await t.waitForFrame((frame) => frame.includes("o4"));
  assert.doesNotMatch(t.captureCharFrame(), /oo4/);
  assert.match(t.captureCharFrame(), /enter accept/);
});

test("[start-run-checking] an unavailable Harness says so only once its check finishes, and still cannot continue", async () => {
  const harnesses = checkingHarnessCatalog([
    { id: "claude-code", name: "Claude Code", models: ["claude-sonnet"] },
    {
      id: "codex",
      name: "Codex",
      unavailable: {
        code: "harness-qualification-unavailable",
        explanation: "Codex is not ready (authentication).",
        remediation: "Log in separately through Codex.",
        possibleEffects: "none",
      },
    },
  ]);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter(); // choose Codex
  await t.waitForFrame((frame) => frame.includes("Checking models…"));
  assert.doesNotMatch(t.captureCharFrame(), /Unavailable/);

  harnesses.settle("codex");
  await t.waitForFrame((frame) => frame.includes("Unavailable · Codex"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Not ready/);
  assert.match(frame, /Log in separately through Codex/);
  assert.equal(
    frame.split("Unavailable").length - 1,
    1,
    "says it is unavailable once",
  );
  assert.doesNotMatch(frame, /Checking models/);
  assert.doesNotMatch(frame, /enter continue/);
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Choose a Harness/);
  assert.doesNotMatch(t.captureCharFrame(), /Review/);
});

test("[start-run-checking] back on the list mid-check, the chosen row reads Checking models… until its focus settles; other rows keep their list words", async () => {
  const harnesses = checkingHarnessCatalog(CHECKED_HARNESSES);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter(); // choose Codex
  await t.waitForFrame((frame) => frame.includes("Checking models…"));
  t.mockInput.pressEscape(); // back to the list while the check runs
  await until(() => t.captureCharFrame().includes("enter choose"));
  const list = t.captureCharFrame();
  assert.match(list, /› Codex \(codex\) — Checking models…/);
  assert.match(list, /Claude Code \(claude-code\) — Not checked/);

  harnesses.settle("codex");
  await t.waitForFrame((frame) => frame.includes("Codex (codex) — Qualified"));
  assert.match(
    t.captureCharFrame(),
    /Claude Code \(claude-code\) — Not checked/,
  );
});

test("[start-run-checking] the checking step relayouts at small widths and after resize without overflow, with long names", async () => {
  const harnesses = checkingHarnessCatalog([
    {
      id: "codex",
      name: "Codex With An Unusually Long Display Name For A Harness",
      models: ["gpt-5"],
    },
  ]);
  const longBundle = focus({
    ...AGENT_ALPHA,
    name: "An Agent Bundle Whose Name Runs Far Past The Choice Column",
  });
  const { t } = await mountFlow(
    catalog([longBundle]),
    fakeLaunch().view,
    40,
    16,
    noRunView(),
    harnesses.view,
  );
  const noOverflow = (width: number) => {
    for (const line of t.captureCharFrame().split("\n")) {
      assert.ok(
        line.length <= width,
        `overflow at ${width}: ${JSON.stringify(line)}`,
      );
    }
  };
  noOverflow(40);
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  noOverflow(40);
  t.mockInput.pressEnter(); // choose the only Harness
  await t.waitForFrame((frame) => frame.includes("Checking models…"));
  noOverflow(40);
  t.resize(30, 14);
  await t.renderOnce();
  noOverflow(30);
  assert.match(t.captureCharFrame(), /Checking models…/);
  assert.doesNotMatch(t.captureCharFrame(), /enter continue/);
});

test("[start-run-highlight] the highlighted Bundle and Harness are filled and bold, and keep the glyph with colour off", async () => {
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA, AGENT_BETA]),
    fakeLaunch().view,
  );
  const bundle = rowSpan(t, "Agent Alpha");
  const otherBundle = rowSpan(t, "Agent Beta");
  assert.ok(bundle.span.text.includes("› Agent Alpha"));
  assert.ok(!otherBundle.span.text.includes("›"));
  assert.ok(bundle.span.attributes & TextAttributes.BOLD);
  assert.equal(otherBundle.span.attributes & TextAttributes.BOLD, 0);
  assert.ok(!bundle.span.bg.equals(bundle.background));
  assert.ok(!bundle.span.bg.equals(otherBundle.span.bg));
  // The id@version line stays a muted detail under the title.
  assert.match(t.captureCharFrame(), /^\s*dev\.agent-alpha@1\.0\.0/m);

  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  const harness = rowSpan(t, "Claude Code (claude-code) — Not checked");
  const otherHarness = rowSpan(t, "Codex (codex) — Not checked");
  assert.ok(harness.span.text.includes("› Claude Code"));
  assert.ok(!otherHarness.span.text.includes("›"));
  assert.ok(harness.span.attributes & TextAttributes.BOLD);
  assert.equal(otherHarness.span.attributes & TextAttributes.BOLD, 0);
  assert.ok(!harness.span.bg.equals(harness.background));
  assert.ok(!harness.span.bg.equals(otherHarness.span.bg));

  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("› Codex"));
  const moved = rowSpan(t, "Codex (codex) — Not checked");
  assert.ok(moved.span.attributes & TextAttributes.BOLD);
  assert.ok(!moved.span.bg.equals(moved.background));
});

test("[start-run-highlight] a click moves the highlight on both lists without choosing", async () => {
  const harnesses = harnessCatalog(AVAILABLE_HARNESSES);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA, AGENT_BETA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    harnesses.view,
  );
  const clickLine = async (needle: string) => {
    const lines = t.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(needle));
    assert.ok(y >= 0, `no line with '${needle}'`);
    await t.mockMouse.click(lines[y]!.indexOf(needle), y);
  };

  await clickLine("Agent Beta");
  await t.waitForFrame((frame) => frame.includes("› Agent Beta"));
  assert.match(t.captureCharFrame(), /An agent Bundle with draft input\./);
  assert.match(t.captureCharFrame(), /Start a Run/);

  t.mockInput.pressArrow("up"); // back to Agent Alpha, which has no inputs
  await t.waitForFrame((frame) => frame.includes("› Agent Alpha"));
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  await clickLine("Codex (codex)");
  await t.waitForFrame((frame) => frame.includes("› Codex"));
  // A click highlights only: nothing is chosen, so nothing is qualified.
  assert.match(t.captureCharFrame(), /enter choose/);
  assert.deepEqual(harnesses.focusCalls, []);
  t.mockInput.pressEnter(); // Enter chooses the clicked row
  await t.waitForFrame((frame) => frame.includes("Harness: Codex"));
  assert.deepEqual(harnesses.focusCalls, ["codex"]);
});

const FALLBACK_CLAUDE: HarnessSpec = {
  id: "claude-code",
  name: "Claude Code",
  models: ["opus", "sonnet"],
  preselection: {
    choice: { model: "opus", effort: "medium" },
    source: {
      kind: "fallback",
      reason: "Claude Code's own settings were not read before launch.",
    },
  },
};

/** The frame's words with line breaks and padding collapsed, so wrapped text
 *  reads as one sentence. */
function words(frame: string): string {
  return frame
    .split("\n")
    .map((line) => line.replace(/[│┃]/g, " ").trim())
    .join(" ")
    .replace(/\s+/g, " ");
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`[start-run-preselection] at ${width}x${height} the guided model list shows the preselected choice and its fallback reason in words, wrapped without clipping`, async () => {
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      fakeLaunch().view,
      width,
      height,
      noRunView(),
      harnessCatalog([FALLBACK_CLAUDE]).view,
    );
    t.mockInput.pressEnter(); // Bundle → Harness
    await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
    t.mockInput.pressEnter(); // choose Claude Code
    await t.waitForFrame((frame) => frame.includes("› opus [current]"));
    // A character frame carries no colour: the current value and the source are
    // read from the words alone.
    const frame = t.captureCharFrame();
    for (const line of frame.split("\n")) {
      assert.ok(
        line.length <= width,
        `overflow at ${width}: ${JSON.stringify(line)}`,
      );
    }
    const text = words(frame);
    assert.match(text, /› opus \[current\]/);
    assert.match(text, /Starts from opus at medium effort/);
    assert.match(
      text,
      /Claude Code's own settings were not read before launch\. Starting with opus and medium effort\./,
    );
    assert.doesNotMatch(text, /Harness default/);
  });
}

test("[start-run-preselection] the review names the resolved preselection and its source once the assessment settles", async () => {
  const prep = controlledPreparation();
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    60,
    24,
    noRunView(),
    harnessCatalog([FALLBACK_CLAUDE]).view,
    prep.view,
  );
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressEnter(); // choose Claude Code
  await t.waitForFrame((frame) => frame.includes("› opus [current]"));
  await chooseGuided(t); // keep the preselection → review
  await t.waitForFrame((frame) => frame.includes("Review"));
  // While assessing, the review says so rather than guessing a choice.
  assert.match(t.captureCharFrame(), /Model: checking…/);
  assert.match(t.captureCharFrame(), /Effort: checking…/);
  prep.settle("ready", []);
  await t.waitForFrame((frame) => frame.includes("Ready to start"));
  const text = words(t.captureCharFrame());
  assert.match(
    text,
    /Model: preselected-model From your Claude Code settings Effort: medium/,
  );
  assert.match(text, /From your Claude Code settings/);
});

test("a Command-only Bundle asks for neither Harness nor model and numbers its steps N of M", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([ALPHA]), launch.view);
  // Command-only ALPHA has no inputs, so the sequence is Bundle → Review: 1 of 2.
  assert.match(t.captureCharFrame(), /Step 1 of 2/);
  t.mockInput.pressEnter(); // straight to review (no Harness, no inputs)
  await t.waitForFrame((f) => f.includes("Review"));
  const review = t.captureCharFrame();
  assert.match(review, /Step 2 of 2/);
  assert.doesNotMatch(review, /Harness:/); // no Harness/model for a Command-only Bundle
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(launch.calls[0]?.harness, undefined);
  assert.equal(launch.calls[0]?.requestedModel, undefined);
});

test("an Agent Bundle with inputs numbers Bundle, Harness, Inputs, Model choice, Review as N of 5", async () => {
  const { t } = await mountFlow(catalog([AGENT_BETA]), fakeLaunch().view);
  assert.match(t.captureCharFrame(), /Step 1 of 5/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  assert.match(t.captureCharFrame(), /Step 2 of 5/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  assert.match(t.captureCharFrame(), /Step 3 of 5/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  assert.match(t.captureCharFrame(), /Step 4 of 5/);
  await chooseGuided(t);
  await t.waitForFrame((f) => f.includes("Review"));
  assert.match(t.captureCharFrame(), /Step 5 of 5/);
});

test("pending feedback then a transition into the Workbench for the Run id; a trusted launch carries no trustDigest", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([ALPHA]),
    launch.view,
    100,
    40,
    succeedingRunView(),
  );
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(launch.calls.length, 1);
  assert.equal(launch.calls[0]?.trustDigest, undefined);

  // A successful launch replaces #90's receipt with the Run's Workbench (#91).
  launch.resolve({ kind: "launched", runId: "run-42", state: "succeeded" });
  await t.waitForFrame((f) => f.includes("Run run-42"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Run run-42/);
  assert.match(frame, /✓ Run succeeded/); // state in words as well as colour
  assert.match(frame, /ctrl\+g details/); // the agent-screen Workbench
});

// --- typed inputs + inline findings ---------------------------------------

test("renders exactly the declared inputs, carries the acknowledged trustDigest, and shows per-input findings inline after Start", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([BETA]), launch.view);
  t.mockInput.pressKey("a"); // acknowledge trust (BETA is the only, selected, Bundle)
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressEnter(); // → inputs (BETA has inputs)
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  const inputs = t.captureCharFrame();
  assert.match(inputs, /target \(text\)/);
  assert.match(inputs, /mode \(choice\)/);

  // Type into the focused text input, then cycle the choice input.
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  await t.waitForFrame((f) => f.includes("hi"));
  t.mockInput.pressArrow("down"); // focus the choice input
  t.mockInput.pressArrow("right"); // choose "fast"
  await t.waitForFrame((f) => /‹ fast ›/.test(f));

  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  const review = t.captureCharFrame();
  assert.match(review, /target: hi/);
  assert.match(review, /mode: fast/);

  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(
    launch.calls[0]?.trustDigest,
    "beta1111",
    "acknowledged digest is sent",
  );
  assert.deepEqual(launch.calls[0]?.launchInputs, {
    target: "hi",
    mode: "fast",
  });

  // Refuse with a per-input violation: route back to inputs with the finding,
  // and the drafts stay intact.
  launch.resolve({
    kind: "refused",
    problem: {
      code: "launch-input-invalid",
      explanation: "invalid",
      remediation: "fix",
      possibleEffects: "none",
      correction: "inputs",
      fieldViolations: [
        { field: "target", explanation: "must be non-empty text." },
      ],
    },
  });
  await t.waitForFrame((f) => f.includes("must be non-empty text."));
  const refused = t.captureCharFrame();
  assert.match(refused, /Launch inputs/);
  assert.match(refused, /Run not started · ctrl\+d dismiss/);
  assert.match(refused, /must be non-empty text\./);
  assert.match(refused, /› target/, "the invalidated field receives focus");
  assert.doesNotMatch(refused, /hi/, "the invalidated input is cleared");

  // A printable `d` still reaches the focused input while the notice is present.
  t.mockInput.pressKey("d");
  await t.waitForFrame((frame) => frame.includes("d"));
  assert.match(t.captureCharFrame(), /Run not started/);
  t.mockInput.pressBackspace();
  // Dismissing the notice never removes the inline finding.
  t.mockInput.pressKey("d", { ctrl: true });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Run not started/);
  assert.match(t.captureCharFrame(), /must be non-empty text\./);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Review"));
  const preserved = t.captureCharFrame();
  assert.match(preserved, /target:/);
  assert.doesNotMatch(preserved, /target: hi/);
  assert.match(preserved, /mode: fast/);
});

// --- multi-line text inputs (#287) ----------------------------------------
//
// #287 slice coverage: keymap and focus (Enter continues, each newline key, Up/Down
// inside a box versus between inputs, kitty and legacy key encodings), small
// terminals and resize (the height cap recomputed at 60x24, 60x48, and 40x20),
// large content (wrap, the cap with internal scroll, the paste placeholder, and a
// multi-line value on Review), interaction tuning (the 3-line and 150-character
// summary boundaries), meaning without colour (the worded `[Pasted ~N lines]`
// placeholder and the `›` focus marker), and renderer evidence (frames from the
// fake Renderer Port). Which modified Enter keys a real terminal delivers is
// recorded human evidence (ADR 0027), not provable here.

// A trusted Command-only Bundle, so Enter on the chooser lands on its inputs.
const ZETA = focus({
  id: "dev.zeta",
  name: "Zeta",
  description: "multi-line inputs",
  digest: "zeta0000",
  trust: { state: "app-release" },
  launchInputs: [
    { name: "brief", type: "text", description: "What to build" },
    { name: "paths", type: "file-set", description: "Files to read" },
    {
      name: "mode",
      type: "choice",
      description: "How to run",
      choices: ["fast", "slow"],
    },
  ],
});

async function openZetaInputs(
  options: { width?: number; height?: number; kittyKeyboard?: boolean } = {},
) {
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([ZETA]),
    launch.view,
    options.width ?? 100,
    options.height ?? 40,
    noRunView(),
    defaultHarnessCatalog(),
    preparation(),
    options.kittyKeyboard ?? true,
  );
  t.mockInput.pressEnter(); // Zeta (trusted, Command-only) → inputs
  await t.waitForFrame((f) => f.includes("brief (text)"));
  return { t, launch };
}

/** Continue to Review, Start, and return the launched draft's inputs. */
async function launchFromInputs(
  t: Awaited<ReturnType<typeof openZetaInputs>>["t"],
  launch: ReturnType<typeof fakeLaunch>,
) {
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Checking launch"));
  return launch.calls[0]?.launchInputs ?? {};
}

const frameRows = (frame: string, pattern: RegExp) =>
  frame.split("\n").filter((row) => pattern.test(row)).length;

test("[launch-text-box] a text input wraps, grows to max(6, a third of the rows), scrolls inside, and recomputes the cap on resize", async () => {
  const { t, launch } = await openZetaInputs({ width: 60, height: 24 });
  // 30 words (119 characters, one line): a paste under the summary threshold.
  const words = Array.from(
    { length: 30 },
    (_, i) => `w${String(i + 1).padStart(2, "0")}`,
  );
  await t.mockInput.pasteBracketedText(words.join(" "));
  await t.waitForFrame((f) => f.includes("w30"));
  const wrapped = t.captureCharFrame();
  for (const word of words) assert.match(wrapped, new RegExp(word));
  assert.equal(frameRows(wrapped, /w\d\d/), 3, "wraps at word boundaries");

  // Twelve more lines: fifteen visual rows against a cap of max(6, 24/3) = 8.
  for (let line = 1; line <= 12; line++) {
    t.mockInput.pressKey("j", { ctrl: true });
    await t.mockInput.typeText(`l${String(line).padStart(2, "0")}`);
  }
  await t.waitForFrame((f) => f.includes("l12"));
  const capped = t.captureCharFrame();
  assert.equal(frameRows(capped, /w\d\d|l\d\d/), 8, "capped at 8 rows");
  assert.match(capped, /l05/);
  assert.doesNotMatch(capped, /l04|w01/, "the top scrolled out of the box");
  assert.match(capped, /paths \(file-set\)/, "the next input stays on screen");
  assert.match(capped, /enter continue/, "the footer stays on screen");

  // Scrolled inside: the cursor's row counts from the top of the text, not of the
  // box, so Down from the last line leaves and Up from it moves within the box.
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› paths"));
  t.mockInput.pressArrow("up");
  await t.waitForFrame((f) => f.includes("› brief"));
  t.mockInput.pressArrow("up");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /› brief/, "Up stayed inside the box");
  t.mockInput.pressArrow("down");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /› brief/, "back on the last line");

  // A taller terminal raises the cap to 16, so every row shows.
  t.resize(60, 48);
  await t.waitForFrame((f) => f.includes("w01") && f.includes("l01"));
  assert.equal(frameRows(t.captureCharFrame(), /w\d\d|l\d\d/), 15);

  // A small terminal floors the cap at 6 rows.
  t.resize(40, 20);
  await t.waitForFrame((f) => frameRows(f, /w\d\d|l\d\d/) === 6);
  const small = t.captureCharFrame();
  assert.match(small, /l12/, "the cursor row stays visible");
  assert.match(small, /paths \(file-set\)/);
  assert.match(small, /↑\/↓ input/, "the footer row stays on screen");

  const inputs = await launchFromInputs(t, launch);
  assert.equal(
    inputs.brief,
    [
      words.join(" "),
      ...Array.from(
        { length: 12 },
        (_, i) => `l${String(i + 1).padStart(2, "0")}`,
      ),
    ].join("\n"),
  );
});

test("[launch-text-box] Enter continues while Shift+Enter, Ctrl+Enter, Alt+Enter, and Ctrl+J each insert a newline", async () => {
  const { t, launch } = await openZetaInputs();
  t.mockInput.pressKey("a");
  t.mockInput.pressEnter({ shift: true });
  t.mockInput.pressKey("b");
  t.mockInput.pressEnter({ ctrl: true });
  t.mockInput.pressKey("c");
  t.mockInput.pressEnter({ meta: true }); // Alt+Enter: OpenTUI reports Alt as meta
  t.mockInput.pressKey("d");
  t.mockInput.pressKey("j", { ctrl: true });
  t.mockInput.pressKey("e");
  await t.waitForFrame((f) => /^\s*e\s*$/m.test(f));
  const frame = t.captureCharFrame();
  assert.match(frame, /brief \(text\)/, "no newline key continued");
  for (const line of ["a", "b", "c", "d", "e"]) {
    assert.match(frame, new RegExp(`^\\s*${line}\\s*$`, "m"));
  }

  // Keypad Enter (kitty `CSI 57414 u`) submits too, never a newline.
  t.mockInput.pressKey("\x1b[57414u");
  await t.waitForFrame((f) => f.includes("Review"));
  const review = t.captureCharFrame();
  assert.match(review, /brief: a\s*\n\s*b\s*\n\s*c\s*\n\s*d\s*\n\s*e/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(launch.calls[0]?.launchInputs.brief, "a\nb\nc\nd\ne");
});

test("[launch-text-box] without the kitty protocol, Ctrl+J still inserts a newline and Enter still continues", async () => {
  const { t, launch } = await openZetaInputs({ kittyKeyboard: false });
  t.mockInput.pressKey("x");
  t.mockInput.pressKey("j", { ctrl: true }); // arrives as `linefeed`
  t.mockInput.pressKey("y");
  await t.waitForFrame((f) => /^\s*y\s*$/m.test(f));
  assert.match(t.captureCharFrame(), /brief \(text\)/);
  const inputs = await launchFromInputs(t, launch);
  assert.equal(inputs.brief, "x\ny");
});

test("[launch-text-box] a short multi-line paste keeps its lines with CRLF and CR normalised, and a file-set keeps its single-line field", async () => {
  const { t, launch } = await openZetaInputs();
  await t.mockInput.pasteBracketedText("alpha\r\nbeta");
  await t.mockInput.pasteBracketedText("\rgamma");
  await t.waitForFrame((f) => f.includes("gamma"));
  const frame = t.captureCharFrame();
  assert.match(frame, /^\s*alpha\s*$/m);
  assert.match(frame, /^\s*beta\s*$/m);
  assert.match(frame, /^\s*gamma\s*$/m);
  assert.doesNotMatch(frame, /\[Pasted/, "two lines stay under the summary");

  t.mockInput.pressArrow("down"); // from the box's last line → the file-set
  await t.waitForFrame((f) => f.includes("› paths"));
  await t.mockInput.pasteBracketedText("p1\np2");
  await t.waitForFrame((f) => f.includes("p1p2"));

  const inputs = await launchFromInputs(t, launch);
  assert.equal(inputs.brief, "alpha\nbeta\ngamma");
  assert.equal(inputs.paths, "p1p2");
});

test("[launch-text-box] a paste of three or more lines shows as [Pasted ~N lines] and its full text reaches Review, back-navigation, and the launch", async () => {
  const { t, launch } = await openZetaInputs();
  await t.mockInput.typeText("see ");
  await t.mockInput.pasteBracketedText("  one\r\ntwo\rthree\n");
  await t.mockInput.typeText(" ok");
  await t.waitForFrame((f) => f.includes("see [Pasted ~3 lines] ok"));
  assert.doesNotMatch(t.captureCharFrame(), /two|three/);

  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Review"));
  const review = t.captureCharFrame();
  assert.match(review, /brief: see {3}one\s*\n\s*two\s*\n\s*three\s*\n\s*ok/);
  assert.doesNotMatch(review, /\[Pasted/);

  // Back on the inputs step the box holds the full text, not the placeholder.
  t.mockInput.pressEscape();
  await t.waitForFrame((f) => f.includes("brief (text)") && f.includes("two"));
  assert.doesNotMatch(t.captureCharFrame(), /\[Pasted/);

  const inputs = await launchFromInputs(t, launch);
  // Untrimmed: the paste's leading spaces and trailing newline survive.
  assert.equal(inputs.brief, "see   one\ntwo\nthree\n ok");
});

test("[launch-text-box] a paste over 150 characters is summarised, 150 is not, and Backspace removes a placeholder with its text", async () => {
  const { t, launch } = await openZetaInputs();
  await t.mockInput.pasteBracketedText("x".repeat(151));
  await t.waitForFrame((f) => f.includes("[Pasted ~1 lines]"));
  t.mockInput.pressBackspace();
  await t.waitForFrame((f) => !f.includes("[Pasted"));

  await t.mockInput.pasteBracketedText("y".repeat(150));
  await t.waitForFrame((f) => f.includes("yyyy"));
  assert.doesNotMatch(t.captureCharFrame(), /\[Pasted/);

  // A summarised paste as the last edit still lands in the draft whole.
  await t.mockInput.pasteBracketedText("z".repeat(151));
  await t.waitForFrame((f) => f.includes("[Pasted ~1 lines]"));
  const inputs = await launchFromInputs(t, launch);
  assert.equal(inputs.brief, "y".repeat(150) + "z".repeat(151));
});

test("[launch-text-box] Up/Down move inside a multi-line box and leave it only from its first or last line", async () => {
  const { t, launch } = await openZetaInputs();
  t.mockInput.pressKey("a");
  t.mockInput.pressKey("j", { ctrl: true });
  t.mockInput.pressKey("b");
  await t.waitForFrame((f) => /^\s*b\s*$/m.test(f));

  t.mockInput.pressArrow("up"); // line 2 → line 1, still in the box
  t.mockInput.pressKey("Z");
  await t.waitForFrame((f) => f.includes("aZ"));
  assert.match(t.captureCharFrame(), /› brief/);
  t.mockInput.pressArrow("up"); // first line of the first input: nowhere to go
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /› brief/);

  t.mockInput.pressArrow("down"); // line 1 → line 2, still in the box
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /› brief/);
  t.mockInput.pressArrow("down"); // last line → the next input
  await t.waitForFrame((f) => f.includes("› paths"));
  t.mockInput.pressArrow("up"); // back into the box, cursor still on line 2
  await t.waitForFrame((f) => f.includes("› brief"));
  t.mockInput.pressArrow("up"); // line 2 → line 1, the box keeps focus
  t.mockInput.pressKey("Y");
  await t.waitForFrame((f) => f.includes("aZY") || f.includes("aYZ"));
  assert.match(t.captureCharFrame(), /› brief/);

  const inputs = await launchFromInputs(t, launch);
  assert.match(inputs.brief ?? "", /^a[ZY]{2}\nb$/);
});

test("an input draft does not leak into another Bundle's same-named input", async () => {
  const { t } = await mountFlow(catalog([GAMMA, DELTA]), fakeLaunch().view);
  t.mockInput.pressEnter(); // Gamma (trusted) → inputs
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  await t.waitForFrame((f) => f.includes("hi"));
  t.mockInput.pressEscape(); // back to the chooser
  await until(() => !t.captureCharFrame().includes("Launch inputs"));
  t.mockInput.pressArrow("down"); // select Delta (also declares `target`)
  t.mockInput.pressEnter(); // → inputs
  await until(() => t.captureCharFrame().includes("for delta"));
  // Delta's `target` starts empty — Gamma's draft did not leak in.
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  assert.match(t.captureCharFrame(), /target: \(not set\)/);
});

test("an acknowledged digest stays acknowledged after visiting another Bundle", async () => {
  const { t } = await mountFlow(catalog([BETA, EPSILON]), fakeLaunch().view);
  t.mockInput.pressKey("a"); // acknowledge Beta
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressArrow("down"); // Epsilon (also untrusted)
  await t.waitForFrame((f) => f.includes("untrusted two"));
  t.mockInput.pressKey("a"); // acknowledge Epsilon too
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressArrow("up"); // back to Beta
  await t.waitForFrame((f) => f.includes("The untrusted one"));
  // Beta is still acknowledged — the set kept it.
  assert.match(t.captureCharFrame(), /Trust acknowledged/);
  assert.match(t.captureCharFrame(), /enter continue/);
});

test("an empty Catalog shows no acknowledge hint", async () => {
  const { t } = await mountFlow(catalog([]), fakeLaunch().view);
  const frame = t.captureCharFrame();
  assert.match(frame, /Catalog is empty/);
  assert.doesNotMatch(frame, /acknowledge/i);
});

// --- refusals routed to their owning step ---------------------------------

async function refuseFromReview(problem: Problem) {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([ALPHA]), launch.view);
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Checking launch"));
  launch.resolve({ kind: "refused", problem });
  return t;
}

test("a Workspace prerequisite failure returns to Bundle selection with the remediation", async () => {
  const t = await refuseFromReview({
    code: "workspace-prerequisite-failed",
    explanation: "The Workspace is not a Git worktree root.",
    remediation:
      "Launch from the root of a Git worktree, or choose another Bundle.",
    possibleEffects: "none",
    correction: "workspace",
  });
  await t.waitForFrame((f) => f.includes("not a Git worktree root"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Start a Run/); // back on the chooser
  assert.match(frame, /Run not started/);
  assert.doesNotMatch(frame, /workspace-prerequisite-failed/);
  assert.match(frame, /choose another Bundle/);
  assert.doesNotMatch(frame, /\^G details|ctrl\+g details/); // never transitioned into the Workbench
});

test("a corrupted Bundle returns to selection advising reinstalling it", async () => {
  const t = await refuseFromReview({
    code: "bundle-snapshot-corrupt",
    explanation:
      "The installed Bundle is corrupted and can no longer be launched.",
    remediation:
      "Reinstall the Bundle to restore an intact copy, then launch again.",
    possibleEffects: "none",
    correction: "bundle",
  });
  await t.waitForFrame((f) => f.includes("installed Bundle is corrupted"));
  const frame = t.captureCharFrame();
  assert.match(frame, /corrupted/);
  assert.match(frame, /Reinstall the Bundle/);
  assert.doesNotMatch(frame, /\^G details|ctrl\+g details/); // never transitioned into the Workbench
});

test("a Command refusal routes to Bundle selection without exposing its code", async () => {
  const t = await refuseFromReview({
    code: "command-executable-not-found",
    explanation: "A required command is no longer available.",
    remediation: "Install the command, or choose another Bundle.",
    possibleEffects: "none",
    correction: "command",
  });
  await t.waitForFrame((frame) => frame.includes("required command"));
  const refused = t.captureCharFrame();
  assert.match(refused, /Start a Run/);
  assert.match(refused, /Run not started/);
  assert.doesNotMatch(refused, /command-executable-not-found/);
});

test("a trust refusal returns to Review and requires acknowledgement of the exact digest again", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([BETA]),
    launch.view,
    40,
    20,
    noRunView(),
    defaultHarnessCatalog(),
    trustPreparation(BETA),
  );
  t.mockInput.pressKey("a");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Ready to start"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  launch.resolve({
    kind: "refused",
    problem: {
      code: "bundle-trust-required",
      explanation: "Trust acknowledgement is required.",
      remediation: "Acknowledge this exact Bundle digest.",
      possibleEffects: "none",
      correction: "trust",
    },
  });

  await t.waitForFrame((frame) =>
    frame.includes("Trust acknowledgement is required"),
  );
  const refused = t.captureCharFrame();
  assert.match(refused, /Review/);
  assert.match(refused, /Not ready/);
  assert.match(refused, /Run not started/);
  assert.match(refused, /Trust: Acknowledgement required/);
  assert.doesNotMatch(refused, /bundle-trust-required/);
  for (const line of refused.split("\n")) {
    assert.ok(line.length <= 40, `overflow at 40: ${JSON.stringify(line)}`);
  }
  t.mockInput.pressKey("a");
  await t.waitForFrame((frame) => frame.includes("Ready to start"));
  assert.match(t.captureCharFrame(), /Exact digest acknowledged/);
});

test("declining trust launches nothing and cannot continue", async () => {
  const launch = fakeLaunch();
  const { t, exits } = await mountFlow(catalog([BETA]), launch.view);
  // Do not acknowledge; Continue must be unavailable.
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /acknowledge trust \(a\) to continue/);
  assert.equal(launch.calls.length, 0, "no launch was submitted");

  // Escape declines: back to Home, still nothing launched.
  t.mockInput.pressEscape();
  await until(() => t.captureCharFrame().includes("Workspace"));
  assert.match(t.captureCharFrame(), /Secant/);
  assert.equal(launch.calls.length, 0);
  assert.deepEqual(exits, []);
});

test("Escape steps back one screen at a time", async () => {
  const { t } = await mountFlow(catalog([BETA]), fakeLaunch().view);
  t.mockInput.pressKey("a");
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressEnter(); // → inputs
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  t.mockInput.pressEscape(); // inputs → choose
  await until(() => !t.captureCharFrame().includes("Launch inputs"));
  assert.match(t.captureCharFrame(), /enter continue/); // back on the chooser
  t.mockInput.pressEscape(); // choose → home
  await until(() => t.captureCharFrame().includes("Workspace"));
  assert.match(t.captureCharFrame(), /enter run/); // Home footer
});

// --- layout ----------------------------------------------------------------

function lineWith(frame: string, needle: string): string {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

test("wide width places the side panel beside the list; a small width collapses it below, both without horizontal overflow", async () => {
  const { t } = await mountFlow(
    catalog([ALPHA, BETA]),
    fakeLaunch().view,
    100,
    30,
  );
  // Row layout: the panel's "Name" shares a line with the "Alpha" list row.
  assert.ok(lineWith(t.captureCharFrame(), "Alpha").includes("Name"));

  t.resize(40, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  for (const line of narrow.split("\n")) {
    assert.ok(line.length <= 40, `overflow at 40: ${JSON.stringify(line)}`);
  }
  // Collapsed: the panel is now below the list — "Name" no longer shares the
  // "Alpha" row, and both are still present.
  assert.match(narrow, /Alpha/);
  assert.match(narrow, /Name/);
  assert.ok(
    !lineWith(narrow, "Alpha").includes("Name"),
    "side panel dropped below the list",
  );

  t.resize(30, 30);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(line.length <= 30, `overflow at 30: ${JSON.stringify(line)}`);
  }
});

// --- live launch seam over fake operation/run snapshots --------------------

function stubProjection(snapshot: unknown): OpenedProjection {
  return {
    snapshot,
    catchUp: "fresh",
    updates: (async function* () {})(),
    close() {},
  } as OpenedProjection;
}

/** A fake Port that answers submit with a fixed admission and serves the
 *  `operation`/`run` snapshots the launch sequence reads. */
function fakePort(config: {
  admission: SubmissionAdmission;
  operation?: OperationSnapshot;
  run?: RunSnapshot;
  onSubmit?: (submission: Submission) => void;
}): ProjectionPort {
  const openProjection = (selector: ProjectionSelector): OpenedProjection => {
    if (selector.family === "operation")
      return stubProjection(config.operation);
    if (selector.family === "run") return stubProjection(config.run);
    throw new Error(`unexpected selector ${selector.family}`);
  };
  return {
    openProjection: openProjection as ProjectionPort["openProjection"],
    submit(submission: Submission): SubmissionAdmission {
      config.onSubmit?.(submission);
      return config.admission;
    },
    readResource() {
      throw new Error("not used");
    },
    readTranscript() {
      throw new Error("not used");
    },
  };
}

const RUN_SUCCEEDED: RunSnapshot = {
  family: "run",
  runId: "run-9",
  result: {
    found: true,
    run: {
      runId: "run-9",
      bundle: { id: "x", version: "1.0.0", name: "X", digest: "d" },
      workspacePath: WORKSPACE,
      launchedAt: "2026-01-01T00:00:00.000Z",
      state: "succeeded",
      liveness: { state: "not-live" },
      progress: [],
      position: 0,
      timeline: [],
      outputs: [],
      actionOffers: [],
    },
  },
};

test("live seam: submit → applied operation → found Run yields a launched receipt", () => {
  let sent: Submission | undefined;
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "applied" },
    },
    run: RUN_SUCCEEDED,
    onSubmit: (s) => (sent = s),
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, {
    kind: "launched",
    runId: "run-9",
    state: "succeeded",
  });
  assert.equal(sent?.operation, "launch-run");
});

test("live seam: a not-admitted submission is a refusal", () => {
  const problem: Problem = {
    code: "workspace-not-approved",
    explanation: "no",
    remediation: "approve",
    possibleEffects: "none",
  };
  const port = fakePort({ admission: { admitted: false, problem } });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, { kind: "refused", problem });
});

test("live seam: launch resolves at admission from the running Run, without reading the operation outcome", () => {
  // The operation is still `pending` (settlement is deferred now, #98). The launch
  // must resolve at admission from the live `run` snapshot — never blocking on the
  // operation outcome — so the flow reaches the Workbench before the Run rests (S1).
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "pending" },
    },
    run: {
      family: "run",
      runId: "run-9",
      result: {
        found: true,
        run: {
          runId: "run-9",
          bundle: { id: "x", version: "1.0.0", name: "X", digest: "d" },
          workspacePath: WORKSPACE,
          launchedAt: "2026-01-01T00:00:00.000Z",
          state: "running",
          liveness: { state: "live-here", ownerPid: 123 },
          progress: [],
          position: 0,
          timeline: [],
          outputs: [],
          actionOffers: [],
        },
      },
    },
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, {
    kind: "launched",
    runId: "run-9",
    state: "running",
  });
});

test("live seam: an admitted launch whose Run cannot be read is a refusal", () => {
  const problem: Problem = {
    code: "run-store-damaged",
    explanation: "bad",
    remediation: "fix",
    possibleEffects: "none",
  };
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    run: { family: "run", runId: "run-9", result: { found: false, problem } },
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, { kind: "refused", problem });
});

test("live seam: an admitted launch with no Run id is a contract-breach refusal", () => {
  const port = fakePort({ admission: { admitted: true, operationId: "op-1" } });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.equal(outcome.kind, "refused");
  assert.equal(
    outcome.kind === "refused" ? outcome.problem.code : "",
    "run-not-identified",
  );
});

test("end-to-end over the live seam: a launched Run transitions into its Workbench", async () => {
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "applied" },
    },
    run: RUN_SUCCEEDED,
  });
  const { t } = await mountFlow(
    catalog([ALPHA]),
    createLiveRunLaunchView(port),
    100,
    40,
    succeedingRunView(),
  );
  t.mockInput.pressEnter(); // Alpha is trusted + no inputs → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Run run-9"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Run run-9/);
  assert.match(frame, /✓ Run succeeded/);
});

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`[start-run-preselection] at ${width}x${height} the last choice source is readable without colour`, async () => {
    const last: HarnessSpec = {
      ...FALLBACK_CLAUDE,
      preselection: {
        choice: { model: "opus", effort: "medium" },
        source: { kind: "last-choice" },
      },
    };
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      fakeLaunch().view,
      width,
      height,
      noRunView(),
      harnessCatalog([last]).view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((frame) => frame.includes("› opus [current]"));
    const frame = t.captureCharFrame();
    assert.match(words(frame), /Your last choice for Claude Code/);
    for (const line of frame.split("\n")) assert.ok(line.length <= width);
  });
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`[start-run-preselection] at ${width}x${height} Review names the last choice source`, async () => {
    const prep = controlledPreparation();
    const last: HarnessSpec = {
      ...FALLBACK_CLAUDE,
      preselection: {
        choice: { model: "opus", effort: "medium" },
        source: { kind: "last-choice" },
      },
    };
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      fakeLaunch().view,
      width,
      height,
      noRunView(),
      harnessCatalog([last]).view,
      prep.view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((frame) => frame.includes("› opus [current]"));
    await chooseGuided(t);
    await t.waitForFrame((frame) => frame.includes("Review"));
    prep.settle("ready", [], {
      model: "opus",
      effort: "medium",
      source: { kind: "last-choice" },
    });
    await t.waitForFrame((frame) =>
      words(frame).includes("Your last choice for Claude Code"),
    );
    assert.match(
      words(t.captureCharFrame()),
      /Model: opus Your last choice for Claude Code Effort: medium/,
    );
    for (const line of t.captureCharFrame().split("\n"))
      assert.ok(line.length <= width);
  });
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`[claude-effort-lock] words survive a model choice and resize at ${width}x${height}`, async () => {
    const lock = { effort: "xhigh", source: "CLAUDE_CODE_EFFORT_LEVEL=xhigh" };
    const locked: HarnessSpec = {
      id: "claude-code",
      name: "Claude Code",
      models: ["opus", "sonnet"],
      preselection: {
        choice: { model: "opus", effort: "xhigh" },
        source: { kind: "reported" },
        effortLock: lock,
      },
    };
    const prep: LaunchPreparationView = {
      open(draft) {
        const [snapshot] = createSignal<LaunchPreparationSnapshot>({
          family: "launch-preparation",
          status: "ready",
          draft: {
            bundle: { id: draft.bundle.id },
            harness: draft.harness,
            launchInputs: draft.launchInputs,
            modelChoice: {
              model: draft.requestedModel ?? "opus",
              effort: "xhigh",
              source: { kind: "requested" },
              effortLock: lock,
            },
          },
          findings: [],
          actionOffers: [
            {
              action: "launch-run",
              draft: {
                ...draft,
                requestedModel: draft.requestedModel ?? "opus",
                requestedEffort: "xhigh",
              },
              trustRequired: false,
              consequence: "Start",
            },
          ],
        });
        return snapshot;
      },
    };
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      fakeLaunch().view,
      width,
      height,
      noRunView(),
      harnessCatalog([locked]).view,
      prep,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((frame) => frame.includes("› opus [current]"));
    const sentence =
      "Locked by CLAUDE_CODE_EFFORT_LEVEL=xhigh. Change that setting outside Secant.";
    assert.ok(words(t.captureCharFrame()).includes(sentence));
    assert.match(
      words(t.captureCharFrame()),
      /Starts from opus at xhigh effort/,
    );
    t.mockInput.pressArrow("down");
    await t.waitForFrame((frame) => frame.includes("› sonnet"));
    t.resize(width === 60 ? 140 : 60, width === 60 ? 44 : 24);
    await t.renderOnce();
    assert.ok(words(t.captureCharFrame()).includes(sentence));
    assert.match(words(t.captureCharFrame()), /› sonnet/);
    await chooseGuided(t);
    await t.waitForFrame((frame) => frame.includes("Review"));
    const review = words(t.captureCharFrame());
    assert.match(review, /Model: sonnet .* Effort: xhigh \(locked\)/);
    assert.ok(review.includes(sentence));
    for (const line of t.captureCharFrame().split("\n"))
      assert.ok(line.length <= (width === 60 ? 140 : 60));
  });
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`[start-run-guided] Codex opens on its preselection and resets to the chosen model's reported default through review at ${width}x${height}`, async () => {
    const harnesses = harnessCatalog([
      {
        id: "codex",
        name: "Codex",
        declaration: {
          kind: "list",
          models: [
            {
              model: "fast",
              label: "Fast",
              efforts: ["low", "medium"],
              defaultEffort: "medium",
            },
            {
              model: "deep",
              label: "Deep",
              efforts: ["high", "xhigh"],
              defaultEffort: "high",
            },
          ],
        },
        preselection: {
          choice: { model: "deep", effort: "xhigh" },
          source: { kind: "reported" },
        },
      },
    ]);
    const launch = fakeLaunch();
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      launch.view,
      width,
      height,
      noRunView(),
      harnesses.view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    assert.match(words(t.captureCharFrame()), /› Deep · deep \[current\]/);
    assert.match(words(t.captureCharFrame()), /From your Codex settings/);
    assert.doesNotMatch(t.captureCharFrame(), /Other/);
    t.mockInput.pressArrow("up");
    await t.waitForFrame((f) => f.includes("› Fast"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("2. Choose effort"));
    const reset =
      "fast does not offer xhigh effort. Effort changed to medium, its default.";
    assert.ok(words(t.captureCharFrame()).includes(reset));
    assert.match(
      words(t.captureCharFrame()),
      /› medium \[current\] \(default\)/,
    );
    assert.doesNotMatch(t.captureCharFrame(), /xhigh \[current\]/);
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Review"));
    assert.ok(words(t.captureCharFrame()).includes(reset));
    assert.match(
      words(t.captureCharFrame()),
      /Model: Fast · fast .* Effort: medium/,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Checking launch"));
    assert.equal(launch.calls[0]?.requestedModel, "fast");
    assert.equal(launch.calls[0]?.requestedEffort, "medium");
  });
}

const GUIDED_CLAUDE: HarnessSpec = {
  id: "claude-code",
  name: "Claude Code",
  declaration: {
    kind: "suggested",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    models: [
      ["fable", "Fable (latest)"],
      ["opus", "Opus (latest)"],
      ["sonnet", "Sonnet (latest)"],
      ["haiku", "Haiku (latest)"],
      ["default", "Default"],
      ["opusplan", "Opus Plan"],
      ["opus[1m]", "Opus (latest) with 1M context"],
      ["sonnet[1m]", "Sonnet (latest) with 1M context"],
    ].map(([model = "", label = ""]) => ({
      model,
      label,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    })),
  },
  preselection: {
    choice: { model: "opus", effort: "medium" },
    source: { kind: "reported" },
  },
};

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`[start-run-guided] Claude suggestions and native Other input accept a non-empty exact name and cancel at ${width}x${height}`, async () => {
    const launch = fakeLaunch();
    const { t, exits } = await mountFlow(
      catalog([AGENT_ALPHA]),
      launch.view,
      width,
      height,
      noRunView(),
      harnessCatalog([GUIDED_CLAUDE]).view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    const list = words(t.captureCharFrame());
    for (const label of [
      "Fable (latest)",
      "Opus (latest)",
      "Sonnet (latest)",
      "Haiku (latest)",
      "Default",
      "Opus Plan",
      "Opus (latest) with 1M context",
      "Sonnet (latest) with 1M context",
    ])
      assert.ok(list.includes(label), label);
    assert.match(list, /› Opus \(latest\) · opus \[current\]/);
    t.mockInput.pressKey("\u001b[6~");
    await t.waitForFrame((f) => f.includes("› Other…"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("enter accept"));
    t.mockInput.pressEnter(); // Empty is held.
    await t.renderOnce();
    assert.match(t.captureCharFrame(), /enter accept/);
    await t.mockInput.typeText("cancelled-name");
    t.mockInput.pressEscape();
    await until(() => t.captureCharFrame().includes("› Opus (latest)"));
    assert.doesNotMatch(t.captureCharFrame(), /cancelled-name/);
    t.mockInput.pressKey("\u001b[6~");
    await t.waitForFrame((f) => f.includes("› Other…"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("enter accept"));
    await t.mockInput.typeText("qa "); // q is text here, and whitespace trims at acceptance.
    t.mockInput.pressArrow("left"); // Native cursor edits, not model cycling.
    t.mockInput.pressKey("2");
    await t.waitForFrame((f) => f.includes("qa2"));
    t.resize(width === 60 ? 140 : 60, width === 60 ? 44 : 24);
    await t.renderOnce();
    assert.match(t.captureCharFrame(), /qa2/);
    assert.deepEqual(exits, []);
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("2. Choose effort"));
    assert.match(t.captureCharFrame(), /› medium \[current\]/);
    for (const effort of ["low", "medium", "high", "xhigh", "max"])
      assert.ok(t.captureCharFrame().includes(effort));
    t.mockInput.pressArrow("down");
    await t.waitForFrame((f) => f.includes("› high"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Review"));
    assert.match(words(t.captureCharFrame()), /Model: qa2 .* Effort: high/);
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Checking launch"));
    assert.equal(launch.calls[0]?.requestedModel, "qa2");
    assert.equal(launch.calls[0]?.requestedEffort, "high");
  });

  test(`[start-run-guided] no-effort acknowledgment and switching back re-enable effort at ${width}x${height}`, async () => {
    const harness: HarnessSpec = {
      id: "codex",
      name: "Codex",
      declaration: {
        kind: "list",
        models: [
          {
            model: "thinking",
            label: "Thinking",
            efforts: ["low", "high"],
            defaultEffort: "high",
          },
          { model: "plain", label: "Plain", efforts: [] },
        ],
      },
      preselection: {
        choice: { model: "thinking", effort: "high" },
        source: { kind: "reported" },
      },
    };
    const launch = fakeLaunch();
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      launch.view,
      width,
      height,
      noRunView(),
      harnessCatalog([harness]).view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    t.mockInput.pressArrow("down");
    await t.waitForFrame((f) => f.includes("› Plain"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("2. Choose effort"));
    assert.match(
      words(t.captureCharFrame()),
      /This model has no effort setting. Not available./,
    );
    assert.match(t.captureCharFrame(), /enter acknowledge/);
    t.mockInput.pressArrow("down");
    await t.renderOnce();
    assert.doesNotMatch(t.captureCharFrame(), /Review/);
    t.mockInput.pressEscape();
    await until(() => t.captureCharFrame().includes("1. Choose a model"));
    t.mockInput.pressArrow("up");
    await t.waitForFrame((f) => f.includes("› Thinking"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("2. Choose effort"));
    assert.doesNotMatch(t.captureCharFrame(), /Not available/);
    assert.match(t.captureCharFrame(), /› high \[current\] \(default\)/);
    t.mockInput.pressArrow("up");
    await t.waitForFrame((f) => f.includes("› low"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Review"));
    assert.match(
      words(t.captureCharFrame()),
      /Model: Thinking · thinking .* Effort: low/,
    );
    // Back returns to effort, Esc then returns to model with the choice intact.
    t.mockInput.pressEscape();
    await until(() => t.captureCharFrame().includes("2. Choose effort"));
    assert.match(t.captureCharFrame(), /› low \[current\]/);
    t.mockInput.pressEscape();
    await until(() => t.captureCharFrame().includes("1. Choose a model"));
    t.mockInput.pressArrow("down");
    await t.waitForFrame((f) => f.includes("› Plain"));
    await chooseGuided(t);
    await t.waitForFrame((f) => f.includes("Review"));
    assert.match(words(t.captureCharFrame()), /Model: Plain · plain/);
    assert.match(
      words(t.captureCharFrame()),
      /Effort: Not available\. This model has no effort setting\./,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Checking launch"));
    assert.equal(launch.calls[0]?.requestedModel, "plain");
    assert.equal(launch.calls[0]?.requestedEffort, undefined);
  });

  test(`[start-run-guided] lock disables effort, requires acknowledgment and stays fixed across model changes at ${width}x${height}`, async () => {
    const lock = { effort: "xhigh", source: "CLAUDE_CODE_EFFORT_LEVEL=xhigh" };
    const harness: HarnessSpec = {
      ...GUIDED_CLAUDE,
      preselection: {
        choice: { model: "opus", effort: "xhigh" },
        source: { kind: "reported" },
        effortLock: lock,
      },
    };
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      fakeLaunch().view,
      width,
      height,
      noRunView(),
      harnessCatalog([harness]).view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    t.mockInput.pressArrow("down");
    await t.waitForFrame((f) => f.includes("› Sonnet"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("2. Choose effort"));
    const sentence =
      "Locked by CLAUDE_CODE_EFFORT_LEVEL=xhigh. Change that setting outside Secant.";
    assert.ok(words(t.captureCharFrame()).includes(sentence));
    assert.match(words(t.captureCharFrame()), /xhigh \[current\] \(locked\)/);
    t.mockInput.pressArrow("up");
    t.mockInput.pressKey("\u001b[6~");
    await t.renderOnce();
    assert.match(words(t.captureCharFrame()), /xhigh \[current\] \(locked\)/);
    assert.doesNotMatch(t.captureCharFrame(), /Review/);
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Review"));
    assert.match(
      words(t.captureCharFrame()),
      /Model: Sonnet \(latest\) · sonnet .* Effort: xhigh/,
    );
  });

  test(`[start-run-guided] long model lists page, wrap and preserve focus through resize and back navigation at ${width}x${height}`, async () => {
    const harness: HarnessSpec = {
      id: "codex",
      name: "Codex",
      declaration: {
        kind: "list",
        models: Array.from({ length: 70 }, (_, index) => ({
          model: `model-${index}`,
          label: `Choice ${index} with a long friendly label that wraps across the small terminal`,
          efforts: ["low", "high"],
          defaultEffort: "high",
        })),
      },
      preselection: {
        choice: { model: "model-35", effort: "high" },
        source: { kind: "last-choice" },
      },
    };
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      fakeLaunch().view,
      width,
      height,
      noRunView(),
      harnessCatalog([harness]).view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    assert.match(words(t.captureCharFrame()), /› Choice 35/);
    assert.match(words(t.captureCharFrame()), /model-35 \[current\]/);
    t.mockInput.pressKey("\u001b[6~");
    await t.waitForFrame((f) => !f.includes("› Choice 35"));
    assert.doesNotMatch(t.captureCharFrame(), /› Choice 35/);
    t.mockInput.pressKey("\u001b[5~");
    await t.waitForFrame((f) => f.includes("› Choice 35"));
    t.mockInput.pressArrow("down");
    await t.waitForFrame((f) => f.includes("› Choice 36"));
    t.resize(width === 60 ? 140 : 60, width === 60 ? 44 : 24);
    await t.renderOnce();
    assert.match(words(t.captureCharFrame()), /› Choice 36/);
    assert.match(
      words(t.captureCharFrame()),
      /friendly label that wraps across the small terminal/,
    );
    for (const line of t.captureCharFrame().split("\n"))
      assert.ok(line.length <= (width === 60 ? 140 : 60));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("2. Choose effort"));
    t.mockInput.pressEscape();
    await until(() => t.captureCharFrame().includes("1. Choose a model"));
    assert.match(words(t.captureCharFrame()), /› Choice 36/);
    assert.match(words(t.captureCharFrame()), /model-36 \[current\]/);
    t.mockInput.pressEscape();
    await until(() => t.captureCharFrame().includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    assert.match(words(t.captureCharFrame()), /model-36 \[current\]/);
  });
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`[start-run-guided] qualification holds the guided effort stage and fresh checks hold Start at ${width}x${height}`, async () => {
    const harnesses = checkingHarnessCatalog([GUIDED_CLAUDE]);
    const prep = controlledPreparation();
    const launch = fakeLaunch();
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      launch.view,
      width,
      height,
      noRunView(),
      harnesses.view,
      prep.view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) =>
      words(f).includes(
        "Checking the Harness and loading model choices… Please wait.",
      ),
    );
    for (const key of [
      "RETURN",
      "ARROW_UP",
      "ARROW_DOWN",
      "\u001b[5~",
      "\u001b[6~",
    ])
      t.mockInput.pressKey(key);
    await t.renderOnce();
    assert.match(t.captureCharFrame(), /Choose a Harness/);
    assert.doesNotMatch(t.captureCharFrame(), /Other|2. Choose effort|Review/);
    harnesses.settle("claude-code");
    await t.waitForFrame((f) => f.includes("Model choices loaded"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("2. Choose effort"));
    harnesses.hold("claude-code");
    await t.waitForFrame((f) =>
      words(f).includes(
        "Checking the Harness and loading model choices… Please wait.",
      ),
    );
    for (const key of [
      "RETURN",
      "ARROW_UP",
      "ARROW_DOWN",
      "\u001b[5~",
      "\u001b[6~",
    ])
      t.mockInput.pressKey(key);
    await t.renderOnce();
    assert.match(t.captureCharFrame(), /2. Choose effort/);
    assert.doesNotMatch(t.captureCharFrame(), /Review/);
    assert.equal(launch.calls.length, 0);
    harnesses.settle("claude-code");
    await t.waitForFrame((f) => f.includes("› medium [current]"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Review"));
    assert.ok(
      words(t.captureCharFrame()).includes(
        "Checking the Harness and loading model choices… Please wait.",
      ),
    );
    for (const key of [
      "RETURN",
      "ARROW_UP",
      "ARROW_DOWN",
      "\u001b[5~",
      "\u001b[6~",
    ])
      t.mockInput.pressKey(key);
    await t.renderOnce();
    assert.equal(launch.calls.length, 0);
    prep.settle("ready", [], {
      model: "opus",
      effort: "medium",
      source: { kind: "reported" },
    });
    await t.waitForFrame((f) => f.includes("Ready to start"));
    assert.match(words(t.captureCharFrame()), /From your Claude Code settings/);
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Checking launch"));
    assert.equal(launch.calls.length, 1);
  });

  test(`[start-run-guided] unchanged preselection and preference notice survive review without requested flags at ${width}x${height}`, async () => {
    const notice =
      "Secant could not read your last choice. The Harness settings are shown.";
    const harness: HarnessSpec = {
      ...GUIDED_CLAUDE,
      preferenceNotice: notice,
      preselection: {
        choice: { model: "opus", effort: "medium" },
        source: { kind: "last-choice" },
      },
    };
    const drafts: LaunchRunInput[] = [];
    const prep = controlledPreparation();
    const preparationView: LaunchPreparationView = {
      open(draft) {
        drafts.push(draft);
        return prep.view.open(draft);
      },
    };
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      fakeLaunch().view,
      width,
      height,
      noRunView(),
      harnessCatalog([harness]).view,
      preparationView,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    assert.ok(words(t.captureCharFrame()).includes(notice));
    await chooseGuided(t);
    await t.waitForFrame((f) => f.includes("Review"));
    assert.equal(drafts[0]?.requestedModel, undefined);
    assert.equal(drafts[0]?.requestedEffort, undefined);
    prep.settle(
      "ready",
      [],
      {
        model: "opus",
        effort: "medium",
        source: { kind: "last-choice" },
      },
      notice,
    );
    await t.waitForFrame((f) =>
      words(f).includes("Your last choice for Claude Code"),
    );
    assert.ok(words(t.captureCharFrame()).includes(notice));
    assert.match(
      words(t.captureCharFrame()),
      /Model: Opus \(latest\) · opus .* Effort: medium/,
    );
  });
}

test("[start-run-guided] a supported effort survives a model change and the same Harness's refusal round-trip", async () => {
  const harness: HarnessSpec = {
    id: "codex",
    name: "Codex",
    declaration: {
      kind: "list",
      models: [
        {
          model: "first",
          label: "First",
          efforts: ["low", "high"],
          defaultEffort: "low",
        },
        {
          model: "second",
          label: "Second",
          efforts: ["low", "high"],
          defaultEffort: "low",
        },
      ],
    },
    preselection: {
      choice: { model: "first", effort: "high" },
      source: { kind: "reported" },
    },
  };
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    launch.view,
    60,
    24,
    noRunView(),
    harnessCatalog([harness]).view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› Second"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  assert.match(t.captureCharFrame(), /› high \[current\]/);
  assert.doesNotMatch(t.captureCharFrame(), /Effort changed/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Checking launch"));
  launch.resolve({
    kind: "refused",
    problem: {
      code: "harness-not-ready",
      explanation: "Harness temporarily unavailable.",
      remediation: "Choose again.",
      possibleEffects: "none",
      correction: "harness",
    },
  });
  await t.waitForFrame((f) => f.includes("Run not started"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  assert.match(t.captureCharFrame(), /› Second · second \[current\]/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  assert.match(t.captureCharFrame(), /› high \[current\]/);
});

test("[start-run-guided] correcting a refused model preserves a non-default supported effort", async () => {
  const harness: HarnessSpec = {
    id: "codex",
    name: "Codex",
    declaration: {
      kind: "list",
      models: [
        {
          model: "first",
          label: "First",
          efforts: ["medium", "high"],
          defaultEffort: "medium",
        },
        {
          model: "second",
          label: "Second",
          efforts: ["medium", "high"],
          defaultEffort: "medium",
        },
      ],
    },
    preselection: {
      choice: { model: "first", effort: "medium" },
      source: { kind: "reported" },
    },
  };
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    launch.view,
    60,
    24,
    noRunView(),
    harnessCatalog([harness]).view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› high"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Checking launch"));
  launch.resolve({
    kind: "refused",
    problem: {
      code: "model-unavailable",
      explanation: "Choose another model.",
      remediation: "Try again.",
      possibleEffects: "none",
      correction: "model",
    },
  });
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› Second"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  assert.match(t.captureCharFrame(), /› high \[current\]/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Review"));
  launch.resolve({ kind: "pending" });
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(launch.calls[1]?.requestedModel, "second");
  assert.equal(launch.calls[1]?.requestedEffort, "high");
});

for (const content of ["label", "reason"] as const) {
  test(`[start-run-guided] paging makes every line of an overflowing ${content} reachable at 60x24`, async () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const harness: HarnessSpec = {
      id: "codex",
      name: "Codex",
      preferenceNotice:
        content === "reason" ? `${long} END_OF_REASON` : undefined,
      declaration: {
        kind: "list",
        models: [
          {
            model: "first",
            label: "First",
            efforts: ["high"],
            defaultEffort: "high",
          },
          {
            model: "second",
            label:
              content === "label" ? `${long} END_OF_MODEL_LABEL` : "Second",
            efforts: ["high"],
            defaultEffort: "high",
          },
        ],
      },
      preselection: {
        choice: { model: "first", effort: "high" },
        source: { kind: "reported" },
      },
    };
    const { t } = await mountFlow(
      catalog([AGENT_ALPHA]),
      fakeLaunch().view,
      60,
      24,
      noRunView(),
      harnessCatalog([harness]).view,
    );
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("Choose a Harness"));
    t.mockInput.pressEnter();
    await t.waitForFrame((f) => f.includes("1. Choose a model"));
    if (content === "label") {
      t.mockInput.pressArrow("down");
      await t.waitForFrame((f) => f.includes("› word0"));
    }
    let seen = false;
    for (let page = 0; page < 12; page++) {
      t.mockInput.pressKey("\u001b[6~");
      await t.renderOnce();
      if (
        t
          .captureCharFrame()
          .includes(
            content === "label" ? "END_OF_MODEL_LABEL" : "END_OF_REASON",
          )
      ) {
        seen = true;
        break;
      }
    }
    assert.ok(seen, `the ${content}'s last line is reachable`);
  });
}

// --- #350: Review edits the Model choice ------------------------------------

type Choice = NonNullable<HarnessFocus["preselection"]>["choice"];
type Assessment = LaunchPreparationSnapshot;

/** A launch assessment that resolves the Model choice as the Application does
 *  for these cases: a requested model is the person's choice (an environment
 *  lock keeps its effort), otherwise the Harness's preselection with its source.
 *  While held, every assessment opens `assessing` until `release`. */
function choicePreparation(specs: readonly HarnessSpec[]) {
  const opened: LaunchRunInput[] = [];
  const offered: LaunchRunInput[] = [];
  const pending: (() => void)[] = [];
  let holding = false;
  const view: LaunchPreparationView = {
    open(draft) {
      opened.push(draft);
      const preselection = specs.find(
        (spec) => spec.id === draft.harness,
      )?.preselection;
      const lock = preselection?.effortLock;
      const effort = lock?.effort ?? draft.requestedEffort;
      const choice: Choice | undefined =
        draft.requestedModel !== undefined
          ? {
              model: draft.requestedModel,
              ...(effort === undefined ? {} : { effort }),
            }
          : preselection?.choice;
      const offerDraft: LaunchRunInput = {
        ...draft,
        requestedModel: choice?.model,
        requestedEffort: choice?.effort,
      };
      const ready: Assessment = {
        family: "launch-preparation",
        status: "ready",
        draft: {
          bundle: { id: draft.bundle.id, version: draft.bundle.version },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          ...(choice === undefined
            ? {}
            : {
                modelChoice: {
                  ...choice,
                  source:
                    draft.requestedModel === undefined
                      ? (preselection?.source ?? { kind: "requested" })
                      : { kind: "requested" },
                  ...(lock === undefined ? {} : { effortLock: lock }),
                },
              }),
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings: [],
        actionOffers: [
          {
            action: "launch-run",
            draft: offerDraft,
            trustRequired: draft.trustDigest !== undefined,
            consequence: "Create and start a Run.",
          },
        ],
      };
      const assessing: Assessment = {
        ...ready,
        status: "assessing",
        draft: {
          bundle: ready.draft.bundle,
          harness: draft.harness,
          launchInputs: draft.launchInputs,
        },
        actionOffers: [],
      };
      const [snapshot, setSnapshot] = createSignal<Assessment>(
        holding ? assessing : ready,
      );
      const settle = () => {
        offered.push(offerDraft);
        setSnapshot(ready);
      };
      if (holding) pending.push(settle);
      else offered.push(offerDraft);
      return snapshot;
    },
  };
  return {
    view,
    opened,
    offered,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const settle of pending.splice(0)) settle();
    },
  };
}

const CODEX_MODELS: HarnessFocus["modelDeclaration"] = {
  kind: "list",
  models: [
    {
      model: "gpt-6-astra",
      label: "GPT-6 Astra",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
    },
    {
      model: "gpt-6-sol",
      label: "GPT-6 Sol",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  ],
};

const NO_EFFORT_CLAUDE_MODELS: HarnessFocus["modelDeclaration"] =
  GUIDED_CLAUDE.declaration?.kind === "suggested"
    ? {
        ...GUIDED_CLAUDE.declaration,
        models: [
          { model: "secant-mini-7", label: "secant-mini-7", efforts: [] },
          ...GUIDED_CLAUDE.declaration.models,
        ],
      }
    : undefined;

const LOCK_SENTENCE =
  "Locked by CLAUDE_CODE_EFFORT_LEVEL=high. Change that setting outside Secant.";
const FALLBACK_REASON = "Claude Code's own settings could not be read.";

type Mounted = Awaited<ReturnType<typeof mountFlow>>["t"];

interface EditStep {
  readonly act: (t: Mounted) => void | Promise<void>;
  /** Text the frame shows once the step lands; checked again after the resize. */
  readonly see: string;
}

/** One of the seven #311 cases: the Harness, the Review it reaches by keeping
 *  the preselection, and one edit made from Review. */
interface ReviewCase {
  readonly name: string;
  readonly harness: HarnessSpec;
  readonly review: readonly string[];
  readonly effortEditable: boolean;
  readonly edit: {
    readonly field: "model" | "effort";
    readonly steps: readonly EditStep[];
    readonly review: readonly string[];
    readonly effortEditable: boolean;
    readonly submitted: Choice;
  };
}

const down: EditStep["act"] = (t) => t.mockInput.pressArrow("down");

const REVIEW_CASES: readonly ReviewCase[] = [
  {
    name: "Codex last choice",
    harness: {
      id: "codex",
      name: "Codex",
      declaration: CODEX_MODELS,
      preselection: {
        choice: { model: "gpt-6-astra", effort: "xhigh" },
        source: { kind: "last-choice" },
      },
    },
    review: [
      "Harness: Codex (codex)",
      "Model: GPT-6 Astra · gpt-6-astra",
      "Your last choice for Codex",
      "Effort: xhigh",
    ],
    effortEditable: true,
    edit: {
      field: "model",
      steps: [
        { act: down, see: "› GPT-6 Sol" },
        {
          act: (t) => t.mockInput.pressEnter(),
          see: "› medium [current] (default)",
        },
        { act: (t) => t.mockInput.pressEnter(), see: "Ready to start" },
      ],
      review: [
        "Model: GPT-6 Sol · gpt-6-sol",
        "Your choice for this launch",
        "Effort: medium",
        "gpt-6-sol does not offer xhigh effort. Effort changed to medium, its default.",
      ],
      effortEditable: true,
      submitted: { model: "gpt-6-sol", effort: "medium" },
    },
  },
  {
    name: "Codex default",
    harness: {
      id: "codex",
      name: "Codex",
      declaration: CODEX_MODELS,
      preselection: {
        choice: { model: "gpt-6-sol", effort: "medium" },
        source: { kind: "reported" },
      },
    },
    review: [
      "Harness: Codex (codex)",
      "Model: GPT-6 Sol · gpt-6-sol",
      "From your Codex settings",
      "Effort: medium",
    ],
    effortEditable: true,
    edit: {
      field: "effort",
      steps: [
        { act: down, see: "› high" },
        { act: (t) => t.mockInput.pressEnter(), see: "Ready to start" },
      ],
      review: [
        "Model: GPT-6 Sol · gpt-6-sol",
        "Your choice for this launch",
        "Effort: high",
      ],
      effortEditable: true,
      submitted: { model: "gpt-6-sol", effort: "high" },
    },
  },
  {
    name: "Claude last choice with Other…",
    harness: {
      ...GUIDED_CLAUDE,
      preselection: {
        choice: { model: "sonnet", effort: "high" },
        source: { kind: "last-choice" },
      },
    },
    review: [
      "Harness: Claude Code (claude-code)",
      "Model: Sonnet (latest) · sonnet",
      "Your last choice for Claude Code",
      "Effort: high",
    ],
    effortEditable: true,
    edit: {
      field: "model",
      steps: [
        { act: (t) => t.mockInput.pressKey("\u001b[6~"), see: "› Other…" },
        { act: (t) => t.mockInput.pressEnter(), see: "enter accept" },
        {
          act: (t) => t.mockInput.typeText("claude-exact-7"),
          see: "claude-exact-7",
        },
        {
          act: (t) => t.mockInput.pressEnter(),
          see: "› high [current]",
        },
        { act: (t) => t.mockInput.pressEnter(), see: "Ready to start" },
      ],
      review: [
        "Model: claude-exact-7",
        "Your choice for this launch",
        "Effort: high",
      ],
      effortEditable: true,
      submitted: { model: "claude-exact-7", effort: "high" },
    },
  },
  {
    name: "Claude default",
    harness: GUIDED_CLAUDE,
    review: [
      "Harness: Claude Code (claude-code)",
      "Model: Opus (latest) · opus",
      "From your Claude Code settings",
      "Effort: medium",
    ],
    effortEditable: true,
    edit: {
      field: "effort",
      steps: [
        { act: down, see: "› high" },
        { act: (t) => t.mockInput.pressEnter(), see: "Ready to start" },
      ],
      review: ["Model: Opus (latest) · opus", "Effort: high"],
      effortEditable: true,
      submitted: { model: "opus", effort: "high" },
    },
  },
  {
    name: "environment lock",
    harness: {
      ...GUIDED_CLAUDE,
      preselection: {
        choice: { model: "opus", effort: "high" },
        source: { kind: "reported" },
        effortLock: {
          effort: "high",
          source: "CLAUDE_CODE_EFFORT_LEVEL=high",
        },
      },
    },
    review: [
      "Model: Opus (latest) · opus",
      "From your Claude Code settings",
      "Effort: high (locked)",
      LOCK_SENTENCE,
    ],
    effortEditable: false,
    edit: {
      field: "model",
      steps: [
        { act: down, see: "› Sonnet (latest)" },
        { act: (t) => t.mockInput.pressEnter(), see: "enter acknowledge" },
        { act: (t) => t.mockInput.pressEnter(), see: "Ready to start" },
      ],
      review: [
        "Model: Sonnet (latest) · sonnet",
        "Effort: high (locked)",
        LOCK_SENTENCE,
      ],
      effortEditable: false,
      submitted: { model: "sonnet", effort: "high" },
    },
  },
  {
    name: "no effort",
    harness: {
      ...GUIDED_CLAUDE,
      declaration: NO_EFFORT_CLAUDE_MODELS,
      preselection: {
        choice: { model: "secant-mini-7" },
        source: { kind: "last-choice" },
      },
    },
    review: [
      "Model: secant-mini-7",
      "Your last choice for Claude Code",
      "Effort: Not available.",
      "This model has no effort setting.",
    ],
    effortEditable: false,
    edit: {
      field: "model",
      steps: [
        { act: down, see: "› Fable (latest)" },
        { act: down, see: "› Opus (latest)" },
        { act: (t) => t.mockInput.pressEnter(), see: "› low" },
        { act: (t) => t.mockInput.pressEnter(), see: "Ready to start" },
      ],
      review: ["Model: Opus (latest) · opus", "Effort: low"],
      effortEditable: true,
      submitted: { model: "opus", effort: "low" },
    },
  },
  {
    name: "fallback",
    harness: {
      ...GUIDED_CLAUDE,
      preselection: {
        choice: { model: "opus", effort: "medium" },
        source: { kind: "fallback", reason: FALLBACK_REASON },
      },
    },
    review: [
      "Model: Opus (latest) · opus",
      `${FALLBACK_REASON} Starting with Opus (latest) and medium effort.`,
      "Effort: medium",
    ],
    effortEditable: true,
    edit: {
      field: "effort",
      steps: [
        { act: down, see: "› high" },
        { act: (t) => t.mockInput.pressEnter(), see: "Ready to start" },
      ],
      review: ["Model: Opus (latest) · opus", "Effort: high"],
      effortEditable: true,
      submitted: { model: "opus", effort: "high" },
    },
  },
];

/** Every frame line fits the terminal width and each expected phrase reads
 *  whole in the frame's words, so nothing was clipped. */
function assertReads(t: Mounted, width: number, phrases: readonly string[]) {
  const frame = t.captureCharFrame();
  for (const line of frame.split("\n"))
    assert.ok(line.length <= width, `overflow: ${JSON.stringify(line)}`);
  const text = words(frame);
  for (const phrase of phrases) assert.ok(text.includes(phrase), phrase);
}

/** The Review row that carries focus, named by its label. */
function focusedRow(t: Mounted): string {
  const line = t
    .captureCharFrame()
    .split("\n")
    .find((candidate) => candidate.trimStart().startsWith("› "));
  return line?.trim().replace(/^› /, "").split(/:| · /)[0] ?? "";
}

async function pressTab(t: Mounted, shift = false) {
  t.mockInput.pressTab(shift ? { shift: true } : undefined);
  await t.renderOnce();
}

/** Tab (or Shift+Tab) through every focus stop, back to where it started. */
async function cycleFocus(t: Mounted, shift: boolean): Promise<string[]> {
  const start = focusedRow(t);
  const seen: string[] = [];
  for (let stop = 0; stop < 5; stop++) {
    await pressTab(t, shift);
    seen.push(focusedRow(t));
    if (seen.at(-1) === start) break;
  }
  return seen;
}

function focusOrder(effortEditable: boolean): string[] {
  return [
    "Harness",
    "Model",
    ...(effortEditable ? ["Effort"] : []),
    "Start Run",
  ];
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  const [otherWidth, otherHeight] = width === 60 ? [140, 44] : [60, 24];
  for (const review of REVIEW_CASES) {
    test(`[start-run-review-edit] ${review.name} at ${width}x${height}: Review repeats the choice, cycles focus, and edits ${review.edit.field} across a resize`, async () => {
      const prep = choicePreparation([review.harness]);
      const launch = fakeLaunch();
      const { t } = await mountFlow(
        catalog([AGENT_ALPHA]),
        launch.view,
        width,
        height,
        noRunView(),
        harnessCatalog([review.harness]).view,
        prep.view,
      );
      t.mockInput.pressEnter();
      await t.waitForFrame((f) => f.includes("Choose a Harness"));
      t.mockInput.pressEnter();
      await t.waitForFrame((f) => f.includes("1. Choose a model"));
      await chooseGuided(t);
      await t.waitForFrame((f) => f.includes("Ready to start"));
      assert.equal(focusedRow(t), "Start Run");
      assertReads(t, width, review.review);

      // Forward and reverse focus; a locked or unavailable Effort is skipped
      // but stays explained.
      const order = focusOrder(review.effortEditable);
      assert.deepEqual(await cycleFocus(t, false), order);
      assert.deepEqual(await cycleFocus(t, true), [
        ...order.slice(0, -1).reverse(),
        "Start Run",
      ]);
      await pressTab(t); // Harness
      await pressTab(t); // Model
      if (review.edit.field === "effort") await pressTab(t);
      const field = review.edit.field === "model" ? "Model" : "Effort";
      assert.equal(focusedRow(t), field);

      // A resize keeps the focused field and the choice.
      t.resize(otherWidth, otherHeight);
      await t.renderOnce();
      assert.equal(focusedRow(t), field);
      assertReads(t, otherWidth, review.review);

      // Enter edits the focused field in place; a resize mid-selection keeps
      // the candidate; finishing returns to Review on the same field.
      t.mockInput.pressEnter();
      await t.waitForFrame((f) =>
        f.includes(
          review.edit.field === "model"
            ? "1. Choose a model"
            : "2. Choose effort",
        ),
      );
      for (const [index, step] of review.edit.steps.entries()) {
        await step.act(t);
        await t.waitForFrame((f) => words(f).includes(step.see));
        if (index === 0) {
          t.resize(width, height);
          await t.renderOnce();
          assert.ok(words(t.captureCharFrame()).includes(step.see));
        }
      }
      assert.equal(focusedRow(t), field);
      assertReads(t, width, review.edit.review);
      assert.deepEqual(await cycleFocus(t, false), [
        ...focusOrder(review.edit.effortEditable).slice(
          focusOrder(review.edit.effortEditable).indexOf(field) + 1,
        ),
        ...focusOrder(review.edit.effortEditable).slice(
          0,
          focusOrder(review.edit.effortEditable).indexOf(field) + 1,
        ),
      ]);

      // Start submits the current ready Offer's exact draft.
      for (let stop = 0; stop < 4 && focusedRow(t) !== "Start Run"; stop++)
        await pressTab(t);
      assert.equal(focusedRow(t), "Start Run");
      t.mockInput.pressEnter();
      await t.waitForFrame((f) => f.includes("Checking launch"));
      assert.equal(launch.calls.length, 1);
      assert.deepEqual(launch.calls[0], prep.offered.at(-1));
      assert.equal(
        launch.calls[0]?.requestedModel,
        review.edit.submitted.model,
      );
      assert.equal(
        launch.calls[0]?.requestedEffort,
        review.edit.submitted.effort,
      );
    });
  }
}

/** The styled span of the Review line that starts with `prefix`. */
function lineSpan(t: Mounted, prefix: string) {
  for (const line of t.captureSpans().lines) {
    const span = line.spans.find((candidate) =>
      candidate.text.trimStart().startsWith(prefix),
    );
    if (span !== undefined) return span;
  }
  throw new Error(`no line starting '${prefix}'`);
}

async function reachReview(t: Mounted) {
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  await chooseGuided(t);
  await t.waitForFrame((f) => f.includes("Ready to start"));
}

test("[start-run-review-edit] editing from Review keeps Launch inputs, trust and the other field, Esc returns unchanged, and only the fresh ready Offer starts", async () => {
  const prep = choicePreparation([GUIDED_CLAUDE]);
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([UNTRUSTED_AGENT_BETA]),
    launch.view,
    60,
    24,
    noRunView(),
    harnessCatalog([GUIDED_CLAUDE]).view,
    prep.view,
  );
  t.mockInput.pressKey("a");
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  await t.mockInput.typeText("hi");
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  await chooseGuided(t);
  await t.waitForFrame((f) => f.includes("Ready to start"));

  // Effort edits in place and returns to Review on Effort.
  for (let stop = 0; stop < 3; stop++) await pressTab(t);
  assert.equal(focusedRow(t), "Effort");
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› high"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Ready to start"));
  assert.equal(focusedRow(t), "Effort");
  assertReads(t, 60, [
    "Model: Opus (latest) · opus",
    "Effort: high",
    "target: hi",
    "Trust: Exact digest acknowledged for this launch",
  ]);

  // Esc abandons a Model edit: Review returns on Model with nothing changed.
  await pressTab(t, true);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› Sonnet"));
  t.mockInput.pressEscape();
  await until(() => t.captureCharFrame().includes("Ready to start"));
  assert.equal(focusedRow(t), "Model");
  assertReads(t, 60, ["Model: Opus (latest) · opus", "Effort: high"]);

  // Esc during an Effort edit steps back to the model list, then to Review.
  await pressTab(t);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  t.mockInput.pressEscape();
  await until(() => t.captureCharFrame().includes("1. Choose a model"));
  t.mockInput.pressEscape();
  await until(() => t.captureCharFrame().includes("Ready to start"));
  assert.equal(focusedRow(t), "Effort");
  assertReads(t, 60, ["Model: Opus (latest) · opus", "Effort: high"]);
  await pressTab(t, true);

  // The edit opens a fresh assessment: Start holds until it is ready, then
  // submits that Offer, never the one assessed before the edit.
  prep.hold();
  await pressTab(t);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› xhigh"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Review") && f.includes("Checking"));
  assertReads(t, 60, ["Start Run · unavailable while checks run"]);
  await pressTab(t);
  assert.equal(focusedRow(t), "Start Run");
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.equal(launch.calls.length, 0);
  prep.release();
  await t.waitForFrame((f) => f.includes("Ready to start"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => !f.includes("Review"));
  assert.equal(launch.calls.length, 1);
  assert.deepEqual(launch.calls[0], prep.offered.at(-1));
  assert.equal(launch.calls[0]?.requestedModel, "opus");
  assert.equal(launch.calls[0]?.requestedEffort, "xhigh");
  assert.equal(launch.calls[0]?.trustDigest, UNTRUSTED_AGENT_BETA.digest);
  assert.deepEqual(launch.calls[0]?.launchInputs, { target: "hi" });
});

test("[start-run-review-edit] a Harness change from Review reloads its preselection and checks, keeps Launch inputs, and holds Start until both finish", async () => {
  const codex: HarnessSpec = {
    id: "codex",
    name: "Codex",
    declaration: CODEX_MODELS,
    preselection: {
      choice: { model: "gpt-6-astra", effort: "xhigh" },
      source: { kind: "last-choice" },
    },
  };
  const harnesses = checkingHarnessCatalog([GUIDED_CLAUDE, codex]);
  const prep = choicePreparation([GUIDED_CLAUDE, codex]);
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([AGENT_BETA]),
    launch.view,
    60,
    24,
    noRunView(),
    harnesses.view,
    prep.view,
  );
  const checkingWords =
    "Checking the Harness and loading model choices… Please wait.";
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => words(f).includes(checkingWords));
  harnesses.settle("claude-code");
  await t.waitForFrame((f) => f.includes("Model choices loaded"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  await t.mockInput.typeText("keep me");
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› high"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Ready to start"));
  assertReads(t, 60, ["Effort: high", "Your choice for this launch"]);

  // Esc on the Harness list returns to Review with the choice intact.
  await pressTab(t);
  assert.equal(focusedRow(t), "Harness");
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  assert.match(t.captureCharFrame(), /› Claude Code/);
  t.mockInput.pressEscape();
  await until(() => t.captureCharFrame().includes("Ready to start"));
  assert.equal(focusedRow(t), "Harness");
  assertReads(t, 60, ["Harness: Claude Code", "Effort: high"]);

  // Another Harness holds progression while it is checked.
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› Codex"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => words(f).includes(checkingWords));
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Harness: Codex/);
  assert.doesNotMatch(t.captureCharFrame(), /Review/);

  // Once checked, Review returns on Harness without replaying Launch inputs,
  // and Start holds through the fresh assessment.
  prep.hold();
  harnesses.settle("codex");
  await t.waitForFrame((f) => f.includes("Model choices loaded"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Review"));
  assert.equal(focusedRow(t), "Harness");
  assertReads(t, 60, [
    "Harness: Codex (codex)",
    checkingWords,
    "Start Run · unavailable while checks run",
  ]);
  await pressTab(t, true);
  assert.equal(focusedRow(t), "Start Run");
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.equal(launch.calls.length, 0);
  prep.release();
  await t.waitForFrame((f) => f.includes("Ready to start"));
  assertReads(t, 60, [
    "Model: GPT-6 Astra · gpt-6-astra",
    "Your last choice for Codex",
    "Effort: xhigh",
    "target: keep me",
  ]);
  assert.doesNotMatch(
    words(t.captureCharFrame()),
    /Your choice for this launch|Claude Code/,
  );
  const draft = prep.opened.at(-1);
  assert.equal(draft?.harness, "codex");
  assert.equal(draft?.requestedModel, undefined);
  assert.equal(draft?.requestedEffort, undefined);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => !f.includes("Review"));
  assert.deepEqual(launch.calls, [prep.offered.at(-1)]);
  assert.equal(launch.calls[0]?.requestedModel, "gpt-6-astra");
  assert.equal(launch.calls[0]?.requestedEffort, "xhigh");
  assert.deepEqual(launch.calls[0]?.launchInputs, { target: "keep me" });
});

test("[start-run-review-edit] at 60x24 PgUp/PgDn reach every line of a long Review, Tab brings the focused field back into view, and focus reads without colour", async () => {
  const long = Array.from({ length: 120 }, (_, index) => `word${index}`).join(
    " ",
  );
  const harness: HarnessSpec = {
    ...GUIDED_CLAUDE,
    preselection: {
      choice: { model: "opus", effort: "medium" },
      source: { kind: "fallback", reason: `${long} END_OF_REASON` },
    },
  };
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    60,
    24,
    noRunView(),
    harnessCatalog([harness]).view,
    choicePreparation([harness]).view,
  );
  await reachReview(t);
  assert.match(t.captureCharFrame(), /PgUp\/PgDn scroll/);
  assert.match(t.captureCharFrame(), /Workflow:/);
  assert.doesNotMatch(t.captureCharFrame(), /END_OF_REASON/);
  let seen = words(t.captureCharFrame());
  for (let page = 0; page < 12 && !seen.includes("Trust:"); page++) {
    t.mockInput.pressKey("\u001b[6~");
    await t.renderOnce();
    seen += ` ${words(t.captureCharFrame())}`;
  }
  for (let index = 0; index < 120; index++)
    assert.ok(seen.includes(`word${index}`), `word${index} is reachable`);
  for (const phrase of ["END_OF_REASON", "Effort: medium", "Trust:"])
    assert.ok(seen.includes(phrase), phrase);
  assert.doesNotMatch(t.captureCharFrame(), /Workflow:/);
  for (let page = 0; page < 12; page++) {
    t.mockInput.pressKey("\u001b[5~");
    await t.renderOnce();
  }
  assert.match(t.captureCharFrame(), /Workflow:/);

  // Focus scrolls its row and reasons into view; the glyph and bold mark it.
  for (let page = 0; page < 12; page++) {
    t.mockInput.pressKey("\u001b[6~");
    await t.renderOnce();
  }
  assert.doesNotMatch(t.captureCharFrame(), /Harness:/);
  await pressTab(t);
  assert.equal(focusedRow(t), "Harness");
  assert.ok(lineSpan(t, "› Harness:").attributes & TextAttributes.BOLD);
  assert.equal(lineSpan(t, "Model:").attributes & TextAttributes.BOLD, 0);
  assert.equal(lineSpan(t, "Start Run").attributes & TextAttributes.BOLD, 0);
  await pressTab(t);
  assert.equal(focusedRow(t), "Model");
  assert.match(t.captureCharFrame(), /› Model: Opus \(latest\) · opus/);
  assert.ok(lineSpan(t, "› Model:").attributes & TextAttributes.BOLD);

  t.resize(140, 44);
  await t.renderOnce();
  assert.equal(focusedRow(t), "Model");
  assertReads(t, 140, ["END_OF_REASON", "Workflow:", "Trust:"]);
  assert.doesNotMatch(t.captureCharFrame(), /PgUp\/PgDn/);
});

test("[start-run-review-edit] a Command-only Review has no Model choice fields: Tab stays on Start and Enter starts", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([ALPHA]), launch.view, 60, 24);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Ready to start"));
  await pressTab(t);
  await pressTab(t, true);
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Harness:|Model:|Effort:|tab\/shift\+tab|›/);
  assert.match(frame, /enter start/);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(launch.calls.length, 1);
});

test("[start-run-review-edit] Tab moves from the guided model stage to the Harness and back; another Harness reloads its preselection there without replaying Launch inputs", async () => {
  const codex: HarnessSpec = {
    id: "codex",
    name: "Codex",
    declaration: CODEX_MODELS,
    preselection: {
      choice: { model: "gpt-6-astra", effort: "xhigh" },
      source: { kind: "last-choice" },
    },
  };
  const harnesses = checkingHarnessCatalog([GUIDED_CLAUDE, codex]);
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([AGENT_BETA]),
    launch.view,
    60,
    24,
    noRunView(),
    harnesses.view,
    choicePreparation([GUIDED_CLAUDE, codex]).view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  harnesses.settle("claude-code");
  await t.waitForFrame((f) => f.includes("Model choices loaded"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  await t.mockInput.typeText("keep me");
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  assert.match(words(t.captureCharFrame()), /tab Harness/);
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› Sonnet"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("2. Choose effort"));

  // Tab reaches the Harness list and Tab returns, with the choice intact.
  await pressTab(t);
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  assert.match(t.captureCharFrame(), /› Claude Code/);
  assert.match(t.captureCharFrame(), /tab\/esc return/);
  await pressTab(t);
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  assert.match(
    words(t.captureCharFrame()),
    /› Sonnet \(latest\) · sonnet \[current\]/,
  );

  // Another Harness is checked before the guided stage reopens on its
  // preselection; Launch inputs are not replayed.
  await pressTab(t);
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› Codex"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) =>
    words(f).includes(
      "Checking the Harness and loading model choices… Please wait.",
    ),
  );
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /1\. Choose a model/);
  harnesses.settle("codex");
  await t.waitForFrame((f) => f.includes("Model choices loaded"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  assert.match(
    words(t.captureCharFrame()),
    /› GPT-6 Astra · gpt-6-astra \[current\]/,
  );
  assert.match(words(t.captureCharFrame()), /Your last choice for Codex/);
  await chooseGuided(t);
  await t.waitForFrame((f) => f.includes("Ready to start"));
  assertReads(t, 60, [
    "Harness: Codex (codex)",
    "Model: GPT-6 Astra · gpt-6-astra",
    "Effort: xhigh",
    "target: keep me",
  ]);
});

test("[start-run-review-edit] Tab is text inside Other's input, not a move to the Harness", async () => {
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    60,
    24,
    noRunView(),
    harnessCatalog([GUIDED_CLAUDE]).view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  t.mockInput.pressKey("\u001b[6~");
  await t.waitForFrame((f) => f.includes("› Other…"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("enter accept"));
  await pressTab(t);
  assert.match(t.captureCharFrame(), /enter accept/);
  assert.doesNotMatch(t.captureCharFrame(), /Choose a Harness/);
});

test("[start-run-review-edit] a Harness change from Review to one with nothing to start from asks for a model before Review", async () => {
  const bare: HarnessSpec = {
    id: "codex",
    name: "Codex",
    declaration: CODEX_MODELS,
  };
  const launch = fakeLaunch();
  const prep = choicePreparation([GUIDED_CLAUDE, bare]);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    launch.view,
    60,
    24,
    noRunView(),
    harnessCatalog([GUIDED_CLAUDE, bare]).view,
    prep.view,
  );
  await reachReview(t);
  await pressTab(t);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› Codex"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("1. Choose a model"));
  assert.doesNotMatch(t.captureCharFrame(), /\[current\]/);
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => f.includes("› GPT-6 Sol"));
  await chooseGuided(t);
  await t.waitForFrame((f) => f.includes("Ready to start"));
  assert.equal(focusedRow(t), "Harness");
  assertReads(t, 60, [
    "Harness: Codex (codex)",
    "Model: GPT-6 Sol · gpt-6-sol",
    "Effort: medium",
  ]);
  await pressTab(t, true);
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => !f.includes("Review"));
  assert.deepEqual(launch.calls, [prep.offered.at(-1)]);
  assert.equal(launch.calls[0]?.requestedModel, "gpt-6-sol");
});
