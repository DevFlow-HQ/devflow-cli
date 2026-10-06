import { PALETTES } from "./palette-expectations.js";
import type { PreferencesView } from "../../src/tui/tui.js";
import { inertPreferencesView } from "./inert.js";
import assert from "node:assert/strict";
import {
  launchAgentCompletionRun,
  readCompletionRun,
  completed,
  call,
  reviewedLoop,
  across,
} from "../helpers/agentCompletion.js";
import { awaitSettled, followRun } from "../helpers/settleOperation.js";
import { realpathSync } from "node:fs";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { createApplication } from "../helpers/application.js";
import {
  hostPlatform,
  repeatCommandGateRouting,
  writeRoutingBundle,
} from "../helpers/commandBundle.js";
import { countingBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App, createLiveRunWorkbenchView } from "../../src/tui/tui.js";
import {
  inertHarnessCatalogView,
  inertLaunchPreparationView,
  inertRunActionsView,
  inertRunListView,
  runSummary,
} from "./inert.js";
import type {
  AnswerOutcome,
  BundleCatalogView,
  RunActionOutcome,
  RunActionsView,
  RunLaunchView,
  RunWorkbenchView,
  TRunViewFreshness,
  WorkspaceView,
} from "../../src/tui/tui.js";
import {
  makeFakeRenderer,
  until,
  type FakeRenderer,
} from "./renderer-fixture.js";
import type {
  AnswerHumanGateOffer,
  BundleCatalogSnapshot,
  BundleFocusSnapshot,
  DiagnosticReference,
  ContinueRepeatOffer,
  EndStageOffer,
  EndInteractiveStepOffer,
  InstalledBundleFocus,
  ResourceRead,
  ResourceReference,
  RunLiveOverlay,
  RunCheckpointView,
  RunGateReference,
  ResumeRunOffer,
  RunSnapshot,
  RunStepProgress,
  RunTimelineEvent,
  RunView,
  SessionHistorySnapshot,
  SessionHistoryRow,
  SendInteractiveTurnOffer,
  TranscriptPageReference,
  TranscriptExportReference,
  TranscriptRead,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests for the Run Workbench (#91), reached the real way:
// through the App from a successful Start a Run, over fake `run` snapshots and a
// fake Renderer Port whose `size`/`onKey`/`onResize` we drive directly (AC7).
// They cover: rendering every headless `run show` fact, the details panel, live
// updates on the live edge, the paging anchor + new-activity count +
// jump-to-latest, reference inspection with a truncation marker, focus movement
// and Escape, small-width breakpoints and resize without overflow (AC1–AC8).
// Issue #195 covers the bounded-window marker, counted Jump-to-latest control,
// large-content truncation parity, inspection paging notice, transient Operation
// receipts, and the interaction regression guard at this public renderer seam. It
// changes neither Renderer nor dependency pins, so the Windows Terminal human
// check is not applicable; the named workbench-timeline-inspection scenario runs
// in the canonical test suite on Windows, macOS, and Linux.

const WORKSPACE = "/tmp/secant-workbench-ws";

// --- a fake Renderer Port we can drive (shared fixture, A52) ----------------

// --- fake App seams the flow needs to reach the Workbench ------------------

function approvedWorkspace(
  ownedLiveRuns: number | "unavailable" = 0,
): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 1,
    runSummary:
      ownedLiveRuns === "unavailable"
        ? {
            previousRuns: { state: "known", count: 0 },
            ownedLiveRuns: { state: "unavailable" },
          }
        : runSummary(ownedLiveRuns),
    startupNotices: [],
    harnesses: [],
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

/** One trusted, input-free Bundle so Start a Run reaches Review in one Enter. */
const BUNDLE: InstalledBundleFocus = {
  id: "dev.alpha",
  version: "1.0.0",
  digest: "abc123",
  name: "Alpha Flow",
  description: "A flow.",
  origin: { kind: "local-file", location: "/bundles/x.wfb" },
  shippedWithRunningSecant: false,
  stability: "stable",
  platforms: ["linux"],
  engine: { range: ">=0.1.0", satisfied: true },
  trust: { state: "app-release" },
  author: {},
  launchInputs: [],
  routing: [{ node: "step", step: { id: "build", kind: "command" } }],
  workspacePrerequisites: [],
  producedArtifacts: [],
  executionSummary: {
    platform: "linux",
    identity: { id: "dev.alpha", version: "1.0.0" },
    digest: "abc123",
    origin: { kind: "local-file", location: "/bundles/x.wfb" },
    platforms: ["linux"],
    stepKindCounts: { command: 1 },
    commands: [],
    warning: "Commands run with your user's authority.",
  },
  compositionFindings: [],
};

function oneBundle(): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [BUNDLE] },
  });
  return {
    openList: () => list,
    openFocus: (selector) => {
      const [snapshot] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result: { found: true, bundle: BUNDLE },
      });
      return snapshot;
    },
  };
}

/** A launch seam that settles immediately into the Run's Workbench. */
function launchTo(runId: string): RunLaunchView {
  return {
    launch: () => () => ({ kind: "launched", runId, state: "running" }),
  };
}

// --- a hand-driven Run Workbench read seam ---------------------------------

function refKey(reference: ResourceReference | DiagnosticReference): string {
  return reference.type === "diagnostic"
    ? `d:${reference.diagnosticId}`
    : reference.artifactName;
}

function makeRunView(initial: RunSnapshot) {
  const [snapshot, setSnapshot] = createSignal<RunSnapshot>(initial);
  const [live, setLive] = createSignal<RunLiveOverlay>();
  const [preview, setPreview] = createSignal<string>();
  const [historyOverride, setHistory] = createSignal<SessionHistorySnapshot>();
  const [freshness, setFreshness] = createSignal<TRunViewFreshness>({
    kind: "current",
    catchUp: "fresh",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  const [historyFreshness, setHistoryFreshness] =
    createSignal<TRunViewFreshness>({
      kind: "current",
      catchUp: "fresh",
      lastConfirmedAt: "2026-09-22T10:30:00.000Z",
    });
  const reconnects: string[] = [];
  const reads = new Map<string, ResourceRead>();
  // Transcript pages, keyed by the requested `older` cursor ("" for the newest).
  const transcripts = new Map<string, TranscriptRead>();
  const transcriptReads: (
    TranscriptPageReference | TranscriptExportReference
  )[] = [];
  // The answer seam is hand-driven: `answer` records the dispatch and returns the
  // outcome accessor a test advances (pending → applied/refused), so the tests
  // exercise the controls-unavailable-while-pending and refusal paths (#92).
  const [answerOutcome, setAnswerOutcome] = createSignal<AnswerOutcome>({
    kind: "pending",
  });
  // The three Workbench writes are hand-driven so tests advance each outcome
  // (pending → applied/refused) and assert the exact dispatch (#121).
  const [requestOutcome, setRequestOutcome] = createSignal<AnswerOutcome>({
    kind: "applied",
  });
  const [gateOutcome, setGateOutcome] = createSignal<AnswerOutcome>({
    kind: "applied",
  });
  const answers: {
    gate: RunGateReference;
    answer: "continue" | "stop";
  }[] = [];
  // The interactive seams are hand-driven too (#122): each records its dispatch and
  // returns the shared outcome accessor a test advances, so the tests exercise the
  // blank guard, the boundary-gated End Step, and the pending path.
  const [interactiveOutcome, setInteractiveOutcome] =
    createSignal<AnswerOutcome>({ kind: "pending" });
  const sends: { runId: string; stepId: string; text: string }[] = [];
  // A follow-up after an Interrupt (#354) shares the interactive outcome accessor.
  const followUps: { runId: string; turnId: string; text: string }[] = [];
  const ends: { runId: string; stepId: string }[] = [];
  const continues: { runId: string; stepId: string }[] = [];
  const endStages: { runId: string; stepId: string }[] = [];
  // The steer seam (#148) is hand-driven the same way: it records each dispatch and
  // returns the shared outcome accessor a test advances (pending → applied/refused),
  // so tests exercise the blank guard, the applied close, and the refusal-keeps-draft.
  const [steerOutcome, setSteerOutcome] = createSignal<AnswerOutcome>({
    kind: "pending",
  });
  const steers: { runId: string; turnId: string; text: string }[] = [];
  const texts: { gate: RunGateReference; text: string }[] = [];
  const requests: {
    requestId: string;
    generation: number;
    decision: "allow" | "deny";
  }[] = [];
  const view: RunWorkbenchView = {
    openRun: () => ({
      snapshot,
      live,
      freshness,
      reconnect: () => reconnects.push("reconnect"),
    }),
    openHistory(runId, session) {
      return {
        freshness: historyFreshness,
        reconnect: () => reconnects.push("history"),
        snapshot: () => {
          const override = historyOverride();
          if (override?.session === session) return override;
          const result = snapshot().result;
          const events = result.found
            ? result.run.timeline.filter((event) => event.session === session)
            : [];
          const rows: SessionHistoryRow[] = events.map((event, index) => ({
            id: `history:${event.at}:${event.event}:${index}`,
            position: String(index).padStart(12, "0"),
            source: "stored",
            turnStartedAt: event.at,
            turn: "fixture-turn",
            ...(event.step === undefined ? {} : { step: event.step }),
            value:
              event.event === "request-expired"
                ? { kind: "request", description: "Harness Request expired" }
                : event.agentCall !== undefined
                  ? {
                      kind: "agent-call",
                      call: event.agentCall.id,
                      reason: event.agentCall.reason,
                      reply: event.agentCall.answer.outcome,
                      ...(event.agentCall.answer.outcome === "refused"
                        ? { refusal: event.agentCall.answer.reason }
                        : {}),
                      disposition: event.agentCall.disposition,
                    }
                  : event.event === "assistant-content"
                    ? {
                        kind: "message",
                        role: "assistant",
                        content: event.detail ?? "",
                      }
                    : {
                        kind: "activity",
                        description: `${event.turnKind === "interactive-agent" ? "Interactive Turn" : "Agent Turn"} ${event.event === "turn-started" ? "started" : event.event === "turn-settled" ? `settled · ${event.detail ?? ""}` : (event.detail ?? event.event)}`,
                      },
          }));
          if (session === "fixture-preview" && preview() !== undefined)
            rows.push({
              id: "preview-row",
              position: "999999999999",
              source: "preview",
              turnStartedAt: "ZZZZ",
              turn: "fixture-turn",
              value: {
                kind: "message",
                role: "assistant",
                content: preview()!,
              },
            });
          const page: SessionHistorySnapshot = {
            family: "session-history",
            runId,
            session,
            result: {
              found: true,
              history: {
                rows,
                hasEarlier: false,
                transcriptPage: { type: "transcript-page", runId, session },
                transcriptExport: { type: "transcript-export", runId, session },
              },
            },
          };
          return page;
        },
      };
    },
    readResource: (reference) =>
      reads.get(refKey(reference)) ?? {
        found: false,
        problem: {
          code: "resource-gone",
          explanation: "The referenced bytes are gone.",
          remediation: "Re-run to reproduce the output.",
          possibleEffects: "none",
        },
      },
    answer: (gate, answer) => {
      answers.push({ gate, answer });
      return answerOutcome;
    },
    sendInteractiveTurn: (runId, stepId, text) => {
      sends.push({ runId, stepId, text });
      return interactiveOutcome;
    },
    sendFollowUpTurn: (offer, text) => {
      followUps.push({ runId: offer.runId, turnId: offer.turnId, text });
      return interactiveOutcome;
    },
    endInteractiveStep: (runId, stepId) => {
      ends.push({ runId, stepId });
      return interactiveOutcome;
    },
    continueRepeat: (runId, stepId) => {
      continues.push({ runId, stepId });
      return interactiveOutcome;
    },
    endStage: (runId, stepId) => {
      endStages.push({ runId, stepId });
      return interactiveOutcome;
    },
    steer: (runId, turnId, text) => {
      steers.push({ runId, turnId, text });
      return steerOutcome;
    },
    answerText: (gate, text) => {
      texts.push({ gate, text });
      return gateOutcome;
    },
    answerRequest: (offer, decision) => {
      requests.push({
        requestId: offer.requestId,
        generation: offer.generation,
        decision,
      });
      return requestOutcome;
    },
    readTranscript: (reference) => {
      transcriptReads.push(reference);
      return (
        transcripts.get(
          reference.type === "transcript-page"
            ? (reference.older ?? "")
            : "export",
        ) ?? {
          found: false,
          problem: {
            code: "transcript-gone",
            explanation: "The referenced transcript is gone.",
            remediation: "Re-open the Run.",
            possibleEffects: "none",
          },
        }
      );
    },
  };
  return {
    transcriptReads,
    view,
    setRun: (run: RunView) =>
      setSnapshot({
        family: "run",
        runId: run.runId,
        result: { found: true, run },
      }),
    setSnapshot,
    setLive: (overlay: RunLiveOverlay | undefined) => {
      setLive(overlay);
      if (overlay === undefined) setPreview(undefined);
    },
    setPreview,
    setHistory,
    setHistoryFreshness,
    setFreshness,
    reconnects,
    setRead: (key: string, read: ResourceRead) => reads.set(key, read),
    setTranscript: (cursor: string, read: TranscriptRead) =>
      transcripts.set(cursor, read),
    answers,
    texts,
    requests,
    setAnswerOutcome,
    sends,
    followUps,
    ends,
    continues,
    endStages,
    steers,
    setInteractiveOutcome,
    setSteerOutcome,
    setRequestOutcome,
    setGateOutcome,
  };
}

function snapshotOf(run: RunView): RunSnapshot {
  return { family: "run", runId: run.runId, result: { found: true, run } };
}

function runOf(over: Partial<RunView> = {}): RunView {
  return {
    runId: over.runId ?? "run-1",
    bundle: over.bundle ?? {
      id: "dev.alpha",
      version: "1.0.0",
      name: "Alpha Flow",
      digest: "abc123",
    },
    workspacePath: over.workspacePath ?? "/tmp/ws",
    launchedAt: over.launchedAt ?? "2026-01-01T00:00:00.000Z",
    state: over.state ?? "running",
    liveness: over.liveness ?? { state: "not-live" },
    progress: over.progress ?? [],
    position: over.position ?? 0,
    timeline: over.timeline ?? [],
    outputs: over.outputs ?? [],
    ...(over.checkpoint !== undefined ? { checkpoint: over.checkpoint } : {}),
    ...(over.pendingGate !== undefined
      ? { pendingGate: over.pendingGate }
      : {}),
    ...(over.conflict !== undefined ? { conflict: over.conflict } : {}),
    ...(over.completion !== undefined ? { completion: over.completion } : {}),
    ...(over.pendingAgentCompletion !== undefined
      ? { pendingAgentCompletion: over.pendingAgentCompletion }
      : {}),
    problem: over.problem,
    windowsCleanupNotice: over.windowsCleanupNotice,
    sessions:
      over.sessions ??
      [
        ...new Set(
          (over.timeline ?? []).flatMap((event) =>
            event.session === undefined ? [] : [event.session],
          ),
        ),
      ]
        .map((session) => ({
          session,
          name:
            (over.timeline ?? []).find((event) => event.session === session)
              ?.sessionName ?? session,
          availability: "open" as const,
        }))
        .concat([
          {
            session: "fixture-preview",
            name: "Live conversation",
            availability: "open" as const,
          },
        ]),
    ...(over.effectiveModel !== undefined
      ? { effectiveModel: over.effectiveModel }
      : {}),
    ...(over.modelChoice !== undefined
      ? {
          modelChoice: over.modelChoice,
          requestedModel: over.modelChoice.model,
        }
      : {}),
    ...(over.selectedHarness !== undefined
      ? { selectedHarness: over.selectedHarness }
      : {}),
    ...(over.harness !== undefined ? { harness: over.harness } : {}),
    ...(over.turnPosition !== undefined
      ? { turnPosition: over.turnPosition }
      : {}),
    actionOffers: over.actionOffers ?? [],
  };
}

function events(count: number): RunTimelineEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    at: `T${String(index).padStart(3, "0")}`,
    event: "attempt-settled",
    detail: `e${index}`,
  }));
}

/** Rows whose detail is wider than a 60-column Workbench, so each wraps. */
function wrappingEvents(count: number): RunTimelineEvent[] {
  return events(count).map((event, index) => ({
    ...event,
    detail: `e${index} ${"lorem ipsum ".repeat(5).trim()}`,
  }));
}

/** The timeline viewport's lines, from the one under the timeline label. */
function timelineLines(frame: string): string[] {
  const lines = frame.split("\n");
  return lines.slice(lines.findIndex((line) => /› Timeline/.test(line)) + 1);
}

// --- blocked-Run fixtures (#92) --------------------------------------------

const GATE: RunGateReference = {
  runId: "run-1",
  stepId: "work",
  attemptId: "a9",
  shape: "approve-reject",
};

const ANSWER_OFFER: AnswerHumanGateOffer = {
  action: "answer-human-gate",
  gate: GATE,
  basis: "durable Human Gate",
  continueConsequence:
    "continue: grant one more review interval and resume the Run.",
  stopConsequence:
    "stop: end the Run failed, keeping its history and Artifacts.",
};

function checkpointOf(
  over: Partial<RunCheckpointView> = {},
): RunCheckpointView {
  return {
    message: over.message ?? "Review the batch",
    interval: over.interval ?? 3,
    completedIterations: over.completedIterations ?? 3,
    latestVerdict: over.latestVerdict ?? {
      name: "done",
      value: "fail",
      reference: {
        runId: "run-1",
        artifactName: "done",
        versionId: "v3",
        type: "verdict",
      },
    },
    gate: over.gate ?? GATE,
  };
}

/** A blocked Run resting at a Review checkpoint with the live answer offer. */
function blockedRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "blocked",
    progress: PROGRESS,
    position: 1,
    checkpoint: checkpointOf(),
    actionOffers: [ANSWER_OFFER],
    ...over,
  });
}

// Mount the App and walk Home → Start a Run → launch → the Workbench. The wizard
// screens read the real terminal + keymap (mockInput); the Workbench reads the
// injected fake Renderer Port, which we then drive with `renderer.key`.
async function mountApp(
  control: { readonly view: RunWorkbenchView },
  renderer: FakeRenderer,
  launchRunId: string,
  width: number,
  height: number,
  actions?: RunActionsView,
  reducedMotion = false,
  ownedLiveRuns: number | "unavailable" = 0,
  preferences: PreferencesView = inertPreferencesView(),
) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        preferences={preferences}
        view={approvedWorkspace(ownedLiveRuns)}
        bundles={oneBundle()}
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
        launch={launchTo(launchRunId)}
        run={control.view}
        runList={inertRunListView()}
        actions={actions ?? inertRunActionsView()}
        renderer={renderer.port}
        reducedMotion={reducedMotion}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  await t.waitForFrame((f) => f.includes("Secant"));
  t.mockInput.pressArrow("down"); // explicitly select Start a Run
  t.mockInput.pressEnter(); // Home: Start a Run
  await t.waitForFrame((f) => f.includes("esc back")); // chooser
  t.mockInput.pressEnter(); // trusted + no inputs → Review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start → launch → Workbench
  return { t, exits };
}

async function mountWorkbench(
  run: RunView,
  width = 100,
  height = 40,
  actions?: RunActionsView,
  reducedMotion = false,
  ownedLiveRuns?: number | "unavailable",
  preferences?: PreferencesView,
) {
  const control = makeRunView(snapshotOf(run));
  const renderer = makeFakeRenderer(width, height);
  const { t, exits } = await mountApp(
    control,
    renderer,
    run.runId,
    width,
    height,
    actions,
    reducedMotion,
    ownedLiveRuns,
    preferences,
  );
  await t.waitForFrame((f) => f.includes("Timeline"));
  return { t, control, renderer, exits };
}

async function press(
  t: { renderOnce: () => Promise<void> },
  renderer: FakeRenderer,
  name: string,
  mods: { ctrl?: boolean; alt?: boolean } = {},
) {
  renderer.key(name, mods);
  await t.renderOnce();
}

// Type printable text into a focused native <input> (D9). Text entry rides the
// renderer's mock input (the real terminal path the field reads), never the fake
// Renderer Port — the Port carries only the Workbench dispatcher's command keys.
async function type(
  t: {
    renderOnce: () => Promise<void>;
    mockInput: { typeText: (text: string) => Promise<void> };
  },
  text: string,
) {
  await t.mockInput.typeText(text);
  await t.renderOnce();
}

/** The frame's first `count` non-blank lines: the Workbench header. */
function headerLines(frame: string, count: number): string[] {
  return frame
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, count);
}

function noOverflow(frame: string, width: number) {
  for (const line of frame.split("\n")) {
    assert.ok(
      line.trimEnd().length <= width,
      `overflow at ${width}: ${JSON.stringify(line)}`,
    );
  }
}

const PROGRESS: RunStepProgress[] = [
  { id: "plan", kind: "agent", status: "succeeded" },
  { id: "build", kind: "command", status: "running" },
  { id: "ship", kind: "command", status: "pending" },
];

// --- rendering (AC1) -------------------------------------------------------

test("header, progress, and timeline render the facts headless run show prints", async () => {
  const { t } = await mountWorkbench(
    runOf({
      runId: "run-77",
      state: "running",
      progress: PROGRESS,
      position: 1,
      timeline: [
        { at: "2026-01-01T00:00:00.000Z", event: "run-created" },
        {
          at: "2026-01-01T00:01:00.000Z",
          event: "attempt-settled",
          detail: "passed",
        },
      ],
    }),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Alpha Flow/); // Bundle name
  assert.doesNotMatch(frame, /run-77/); // an active Run's id lives in the panel
  assert.match(frame, /RUNNING/); // state in words
  assert.match(frame, /plan/); // every progress step, always visible
  assert.match(frame, /build/);
  assert.match(frame, /ship/);
  assert.match(frame, /○ Run created/); // timeline events in plain words
  assert.match(frame, /▸ Step Attempt passed/);
});

test("workbench-view-freshness: four stream-health tokens replace scroll-live and gate Operations", async () => {
  const resumeOffer: ResumeRunOffer = {
    action: "resume-run",
    runId: "run-1",
    available: true,
    consequence: "continue from the resting Step.",
  };
  const [pendingResume] = createSignal<RunActionOutcome>({ kind: "pending" });
  const mounted = await mountWorkbench(
    runOf({
      state: "halted",
      actionOffers: [resumeOffer],
      timeline: events(2),
    }),
    100,
    40,
    okActions({ resume: () => pendingResume }),
  );
  const { t, control, renderer } = mounted;
  assert.match(t.captureCharFrame(), /View current/);
  assert.doesNotMatch(t.captureCharFrame(), /\(live\)/);
  renderer.key("r");
  await t.renderOnce();

  control.setFreshness({
    kind: "loading",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /View loading/);

  control.setFreshness({
    kind: "catching-up",
    catchUp: "continuous",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /View catching up/);

  control.setFreshness({
    kind: "disconnected",
    reason: "observer-lagged",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  const disconnected = t.captureCharFrame();
  assert.match(disconnected, /View disconnected/);
  assert.match(disconnected, /last confirmed 2026-09-22 10:30:00Z/);
  assert.match(disconnected, /r Reconnect/);
  assert.match(disconnected, /View freshness · not Run state/);
  assert.match(disconnected, /Operation pending · resume/);
  assert.doesNotMatch(disconnected, /r resume/);

  renderer.key("r");
  await t.renderOnce();
  assert.deepEqual(control.reconnects, ["reconnect"]);
});

test("reopened history renders End Step distinctly from a settled Command Attempt (#134 A19)", async () => {
  const { t } = await mountWorkbench(
    runOf({
      timeline: [
        {
          at: "2026-09-18T00:00:00.000Z",
          event: "interactive-step-ended",
          detail: "succeeded",
        },
        {
          at: "2026-09-18T00:01:00.000Z",
          event: "repeat-continued",
          detail: "succeeded",
        },
        {
          at: "2026-09-18T00:02:00.000Z",
          event: "stage-ended",
          detail: "succeeded",
        },
      ],
    }),
  );
  // A confirmed End Stage reads as its own row, apart from Continue (#218), each in
  // plain words rather than its raw kind (#289).
  const frame = t.captureCharFrame();
  assert.match(frame, /▸ Stage ended/);
  assert.match(frame, /▸ Step ended/);
  // A human-controlled Repeat's Continue reads as its own history row (#217).
  assert.match(frame, /↻ Continued to the next Iteration/);
  assert.doesNotMatch(
    frame,
    /stage-ended|interactive-step-ended|repeat-continued|succeeded/,
  );
});

test("the details panel shows the observed Harness, executable, version, and model, and the header no longer does (#194 story 35)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      selectedHarness: "claude-code",
      modelChoice: { model: "fake-opus", effort: "high" },
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      effectiveModel: "fake-sonnet",
    }),
    100,
    30,
  );
  // The header no longer carries the Harness/model facts (they moved to the panel).
  assert.doesNotMatch(t.captureCharFrame(), /Observed Harness/);
  await press(t, renderer, "d");
  const frame = t.captureCharFrame();
  assert.match(frame, /Selected Harness · claude-code/);
  assert.match(
    frame,
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3 · model fake-sonnet/,
  );
  // Requested and observed models stay visibly distinct (AC1).
  assert.match(frame, /Model choice · fake-opus · high effort/);
  noOverflow(frame, 100);
});

test("the panel drops the long executable path to stay readable at small widths (#194 story 35)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      harness: {
        name: "Claude Code",
        // A long executable path the compact layout drops to fit.
        executable: "/a/very/long/path/to/the/claude/executable/binary/here",
        executableVersion: "1.2.3",
      },
      effectiveModel: "fake-sonnet",
    }),
    100,
    30,
  );
  renderer.resize(70, 30);
  await t.renderOnce();
  await press(t, renderer, "d");
  const compact = t.captureCharFrame();
  assert.match(
    compact,
    /Observed Harness · Claude Code · 1\.2\.3 · model fake-sonnet/,
  );
  noOverflow(compact, 70);
});

test("the panel reports no model rather than inventing one, and omits Harness facts for a Command-only Run (#194 story 35)", async () => {
  // Harness present, model unobserved: the fact is stated honestly, not invented.
  const missing = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
    }),
    100,
    30,
  );
  await press(missing.t, missing.renderer, "d");
  assert.match(
    missing.t.captureCharFrame(),
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3 · model not reported/,
  );

  // Command-only Run: no Harness identity, so no Harness/model lines at all.
  const commandOnly = await mountWorkbench(
    runOf({ state: "succeeded", progress: PROGRESS }),
    100,
    30,
  );
  await press(commandOnly.t, commandOnly.renderer, "d");
  const commandOnlyFrame = commandOnly.t.captureCharFrame();
  assert.doesNotMatch(commandOnlyFrame, /Selected Harness/);
  assert.doesNotMatch(commandOnlyFrame, /Observed Harness/);
  assert.doesNotMatch(commandOnlyFrame, /model/);
});

test("the details panel toggles and shows identity, position, and resources", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      runId: "run-9",
      progress: PROGRESS,
      position: 1,
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-9",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
    }),
  );
  assert.doesNotMatch(t.captureCharFrame(), /Workspace:/); // closed by default
  await press(t, renderer, "d");
  const frame = t.captureCharFrame();
  assert.match(frame, /Details/);
  assert.match(frame, /Run run-9/); // the id the active header leaves out
  assert.match(frame, /dev\.alpha@1\.0\.0/); // identity
  assert.match(frame, /sha256:abc123/);
  assert.match(frame, /Workspace: \/tmp\/ws/);
  assert.match(frame, /step 2 of 3/); // position
  assert.match(frame, /report \(text\)/); // a resource to open
});

test("a blocked Run shows a waiting-for-review note and the checkpoint facts", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: PROGRESS,
      position: 1,
      checkpoint: {
        message: "Review the batch",
        interval: 3,
        completedIterations: 6,
        latestVerdict: {
          name: "done",
          value: "fail",
          reference: {
            runId: "run-1",
            artifactName: "done",
            versionId: "v3",
            type: "verdict",
          },
        },
        gate: {
          runId: "run-1",
          stepId: "work",
          attemptId: "a9",
          shape: "approve-reject",
        },
      },
    }),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /BLOCKED/);
  assert.match(frame, /waiting for review/);
  assert.match(frame, /Review the batch/);
  await press(t, renderer, "d");
  assert.match(t.captureCharFrame(), /checkpoint verdict: done = fail/);
});

// --- live updates + timeline mechanics (AC2, AC3) --------------------------

test("launching transitions to the Workbench before the Run rests, and progress rows appear while a Step runs", async () => {
  // Launch resolves at admission (S1): the App walks Start a Run → launch and lands
  // on the Workbench with the Run still running and no activity yet — before it
  // rests. The read seam is a deferred fake: a durable update then appends timeline
  // rows while a Step runs, and they appear live without leaving the Workbench.
  const control = makeRunView(
    snapshotOf(
      runOf({
        state: "running",
        progress: PROGRESS,
        position: 1,
        timeline: [],
      }),
    ),
  );
  const renderer = makeFakeRenderer(100, 20);
  const { t } = await mountApp(control, renderer, "run-1", 100, 20);
  await t.waitForFrame((f) => f.includes("Timeline"));
  assert.match(t.captureCharFrame(), /RUNNING/); // reached the Workbench, still live
  assert.match(t.captureCharFrame(), /no activity yet/); // the Run has not rested
  // A Step runs: durable progress lands and follows the live edge into view.
  control.setRun(
    runOf({
      state: "running",
      progress: PROGRESS,
      position: 1,
      timeline: events(3),
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, / e2/); // the newest row appeared while running
  assert.match(frame, /View current/);
});

test("the timeline follows the live edge as durable updates append events", async () => {
  const { t, control } = await mountWorkbench(
    runOf({ timeline: events(6) }),
    100,
    16,
  );
  const first = t.captureCharFrame();
  assert.match(first, /View current/);
  assert.match(first, / e5/); // newest visible
  control.setRun(runOf({ timeline: events(9) }));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), / e8/); // followed to the newest
});

test("[selected-versus-observed-evidence] selected and observed Harness facts stay distinct through a live Turn", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
      selectedHarness: "codex",
      effectiveModel: "claude-sonnet-4-5",
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "repair",
          turnKind: "agent",
        },
      ],
    }),
    110,
    24,
  );

  control.setPreview("I am checking the failing assertion");
  control.setLive({
    runId: "run-1",
    generation: 2,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  // Selected and observed facts live in the details panel now (#194 story 35); open
  // it and confirm the two read as visibly distinct lines (AC1), through the live Turn.
  await press(t, renderer, "d");
  const streaming = t.captureCharFrame();
  assert.match(streaming, /Selected Harness · codex/);
  assert.match(
    streaming,
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3/,
  );
  assert.match(streaming, /model claude-sonnet-4-5/);
  assert.match(streaming, /Assistant · streaming/);
  assert.match(streaming, /Assistant · streaming[\s\S]*I am checking/);

  // Below the panel's width breakpoint the panel hides (its facts with it), but the
  // screen still relays out without overflow.
  renderer.resize(40, 24);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 40);
  renderer.resize(110, 24);
  await t.renderOnce();

  control.setRun(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "succeeded" }],
      selectedHarness: "codex",
      effectiveModel: "claude-sonnet-4-5",
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "repair",
          turnKind: "agent",
        },
        {
          at: "T001",
          event: "assistant-content",
          detail: "The assertion is fixed.",
        },
        {
          at: "T002",
          event: "turn-settled",
          detail: "completed",
          turnKind: "agent",
        },
      ],
    }),
  );
  control.setLive(undefined);
  await t.renderOnce();
  const settled = t.captureCharFrame();
  assert.doesNotMatch(settled, /Assistant preview/);
  assert.match(settled, /Assistant · The assertion is fixed\./);
  assert.match(settled, /Agent Turn settled · completed/);
});

test("reopened durable Turn rows label kind by words, colour removed, legacy neutral (#126)", async () => {
  // One reopened Session with an Interactive Turn, a following Agent Turn, and a
  // legacy row whose kind is unknown — the Workbench distinguishes each by glyph
  // plus words alone, with no live overlay (a settled, reopened Run).
  const { t } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: [
        { id: "discuss", kind: "interactive-agent", status: "succeeded" },
      ],
      position: 1,
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "shared",
          turnKind: "interactive-agent",
        },
        {
          at: "T001",
          event: "turn-settled",
          detail: "completed",
          turnKind: "interactive-agent",
        },
        {
          at: "T002",
          event: "turn-started",
          detail: "shared",
          turnKind: "agent",
        },
        {
          at: "T003",
          event: "turn-settled",
          detail: "completed",
          turnKind: "agent",
        },
        // A legacy row (admitted before the kind column): no turnKind, so it reads a
        // neutral "Turn" rather than a fabricated kind.
        { at: "T004", event: "turn-started", detail: "shared" },
      ],
    }),
    110,
    24,
  );
  const frame = t.captureCharFrame();
  // The recorded Session name never labels a row (#289); dividers name it.
  assert.match(frame, /Interactive Turn started/);
  assert.match(frame, /Interactive Turn settled · completed/);
  assert.match(frame, /Agent Turn started/);
  assert.match(frame, /Agent Turn settled · completed/);
  assert.match(frame, /● Turn started/); // legacy: neither kind claimed
  assert.doesNotMatch(frame, /shared/);
});

test("m10-observed-harness-facts: context and usage appear only when reported, without calculated percentages", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Context ·|Usage ·/);

  control.setLive({
    runId: "run-1",
    generation: 2,
    phase: "working",
    outstanding: [],
    offers: [],
    context: { usedTokens: 12_500, limitTokens: 200_000 },
    usage: "estimated $0.04",
  });
  await t.renderOnce();
  const observed = t.captureCharFrame();
  assert.match(observed, /Context · used 12500 tokens, capacity 200000 tokens/);
  assert.match(observed, /Usage · estimated \$0\.04/);
});

test("durable tool activity keeps Projection order beneath the live Turn", async () => {
  const { t } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
      timeline: [
        { at: "T000", event: "turn-started", detail: "repair" },
        { at: "T001", event: "tool-activity", detail: "Bash started" },
        { at: "T002", event: "tool-activity", detail: "Edit completed" },
        { at: "T003", event: "assistant-content", detail: "Done." },
      ],
    }),
  );
  const frame = t.captureCharFrame();
  const bash = frame.indexOf("Tool activity · Bash started");
  const edit = frame.indexOf("Tool activity · Edit completed");
  const assistant = frame.indexOf("Assistant · Done.");
  assert.ok(bash >= 0 && edit > bash && assistant > edit, frame);
});

test("preview-only updates render before a full live overlay exists", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  control.setPreview("First streamed words");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Assistant · streaming/);
  assert.match(frame, /Assistant · streaming[\s\S]*First streamed words/);
});

test("live rows respect paused timeline following and contribute to the new-activity count", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  await press(t, renderer, "up");
  const before = t.captureCharFrame();
  const topLine = before.split("\n").find((line) => / e\d/.test(line));
  assert.ok(topLine);

  control.setPreview("new streamed content");
  await t.renderOnce();
  const paused = t.captureCharFrame();
  assert.equal(
    paused.split("\n").find((line) => / e\d/.test(line)),
    topLine,
  );
  assert.match(paused, /\d+ new activities · Jump to latest/);

  await press(t, renderer, "end");
  const latest = t.captureCharFrame();
  assert.match(latest, /Assistant · streaming[\s\S]*new streamed content/);
  assert.match(latest, /View current/);
});

test("gate, request, interactive Turn, and agent Turn have colour-independent labels", async () => {
  const gate = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: [{ id: "approve", kind: "human-gate", status: "blocked" }],
      pendingGate: {
        gate: {
          runId: "run-1",
          stepId: "approve",
          attemptId: "a1",
          shape: "approve-reject",
        },
        message: "Approve the change?",
      },
      actionOffers: [
        {
          ...ANSWER_OFFER,
          gate: {
            runId: "run-1",
            stepId: "approve",
            attemptId: "a1",
            shape: "approve-reject",
          },
          basis: "durable Human Gate",
        },
      ],
    }),
  );
  assert.match(gate.t.captureCharFrame(), /BLOCKED · durable Human Gate/);
  assert.match(gate.t.captureCharFrame(), /Human Gate · Approve the change\?/);

  const request = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  request.control.setLive({
    runId: "run-1",
    generation: 3,
    phase: "awaiting-approval",
    outstanding: [
      {
        requestId: "req-1",
        tool: "Edit",
        input: '{"path":"src/a.ts"}',
        decisions: ["allow", "deny"],
      },
    ],
    offers: [
      {
        action: "answer-harness-request",
        runId: "run-1",
        requestId: "req-1",
        generation: 1,
        decisions: ["allow", "deny"],
        basis: "ephemeral Harness Request",
      },
    ],
  });
  await request.t.renderOnce();
  assert.match(
    request.t.captureCharFrame(),
    /BLOCKED · ephemeral Harness Request/,
  );
  assert.match(request.t.captureCharFrame(), /Tool: Edit/);
  assert.match(
    request.t.captureCharFrame(),
    /Harness Request · awaiting your approval/,
  );

  const interactive = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: [
        { id: "discuss", kind: "interactive-agent", status: "running" },
      ],
    }),
  );
  interactive.control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await interactive.t.renderOnce();
  const interactiveFrame = interactive.t.captureCharFrame();
  assert.match(interactiveFrame, /BLOCKED · interactive Turn/);
  assert.match(interactiveFrame, /BLOCKED · interactive Turn/);
});

test("scrolling up anchors the first visible row, counts new activity, and jump-to-latest returns to the live edge", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  await press(t, renderer, "up");
  await press(t, renderer, "up");
  const scrolled = t.captureCharFrame();
  const topLine = scrolled.split("\n").find((line) => / e\d/.test(line));
  assert.ok(topLine, "a timeline row is visible");
  assert.match(scrolled, /View current/); // freshness is independent of scrolling

  // New events append; the first visible row stays anchored and the count grows.
  control.setRun(runOf({ timeline: events(36) }));
  await t.renderOnce();
  const anchored = t.captureCharFrame();
  assert.equal(
    anchored.split("\n").find((line) => / e\d/.test(line)),
    topLine,
    "first visible row anchored under append",
  );
  assert.match(anchored, /\d+ new/); // a new-activity badge

  await press(t, renderer, "end"); // jump to the live edge
  const live = t.captureCharFrame();
  assert.match(live, /View current/);
  assert.match(live, / e35/); // the newest event
  assert.doesNotMatch(live, /new activit(?:y|ies) · Jump to latest/);
});

test("timeline paging is wired: home reaches the oldest event, end returns to the live edge", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  assert.match(t.captureCharFrame(), /View current/);
  await press(t, renderer, "pageup"); // detaches from the live edge
  assert.match(t.captureCharFrame(), /View current/);
  await press(t, renderer, "home"); // jump to the oldest
  assert.match(t.captureCharFrame(), / e0 /);
  await press(t, renderer, "end"); // back to the live edge
  const live = t.captureCharFrame();
  assert.match(live, /View current/);
  assert.match(live, / e29/);
});

test("workbench-timeline-inspection: the bounded window marks its beginning and counts Jump to latest activity", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  assert.doesNotMatch(t.captureCharFrame(), /Beginning of Run history/);

  await press(t, renderer, "home");
  const beginning = t.captureCharFrame();
  assert.match(beginning, /Beginning of Run history/);
  assert.match(beginning, / e0 /);

  await press(t, renderer, "down");
  assert.doesNotMatch(t.captureCharFrame(), /Beginning of Run history/);

  await press(t, renderer, "end");
  await press(t, renderer, "up");
  assert.match(t.captureCharFrame(), /1 new activity · Jump to latest/);

  control.setRun(runOf({ timeline: events(32) }));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /3 new activities · Jump to latest/);

  await press(t, renderer, "end");
  assert.doesNotMatch(t.captureCharFrame(), /new activit(?:y|ies)/);

  // A full live window still begins at index zero: the marker is presentation only,
  // so it neither hides an activity nor manufactures a new-activity count.
  const exact = await mountWorkbench(runOf({ timeline: events(7) }), 100, 14);
  const exactFrame = exact.t.captureCharFrame();
  assert.match(exactFrame, /Beginning of Run history/);
  assert.match(exactFrame, / e0 /);
  assert.match(exactFrame, / e6 /);
  assert.doesNotMatch(exactFrame, /new activit(?:y|ies)/);

  const narrow = await mountWorkbench(runOf({ timeline: events(30) }), 40, 14);
  await press(narrow.t, narrow.renderer, "home");
  const narrowBeginning = narrow.t.captureCharFrame();
  assert.match(narrowBeginning, /Beginning of Run history/);
  assert.match(narrowBeginning, /\d+ · Jump to latest/);
  noOverflow(narrowBeginning, 40);
});

test("timeline rows wrap at the width instead of clipping and rewrap on resize (#288)", async () => {
  const words =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
  const { t, renderer } = await mountWorkbench(
    runOf({
      timeline: [{ at: "T000", event: "assistant-content", detail: words }],
    }),
    100,
    20,
  );
  // The row's display lines: the non-blank run under the label.
  const rowLines = () => {
    const lines = timelineLines(t.captureCharFrame());
    return lines.slice(
      0,
      lines.findIndex((line) => line.trim() === ""),
    );
  };
  const counts: number[] = [];
  for (const width of [100, 60, 40]) {
    renderer.resize(width, 20);
    await t.renderOnce();
    noOverflow(t.captureCharFrame(), width);
    const text = rowLines().join(" ");
    for (const word of words.split(" ")) {
      assert.match(text, new RegExp(`\\b${word}\\b`), `${word} at ${width}`);
    }
    // Continuation lines hang under the row's first line.
    for (const line of rowLines().slice(1)) assert.match(line, /^ {5}\S/);
    counts.push(rowLines().length);
  }
  assert.ok(
    counts[0]! < counts[1]! && counts[1]! < counts[2]!,
    `a narrower width wraps over more lines: ${counts.join(", ")}`,
  );
});

test("scrolling over wrapped rows steps by line, keeps its anchor under append and resize, and counts rows (#288)", async () => {
  // Mount at the widest size the test draws (the captured frame keeps its mount
  // size), then narrow to 60 so every row wraps over two lines.
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: wrappingEvents(30) }),
    100,
    14,
  );
  renderer.resize(60, 14);
  await t.renderOnce();
  // One line above the live edge hides only the newest row's last line: the badge
  // counts that one row, not lines.
  await press(t, renderer, "up");
  const scrolled = t.captureCharFrame();
  noOverflow(scrolled, 60);
  assert.match(scrolled, /Timeline · 1 · Jump to latest/);
  const first = timelineLines(scrolled)[0];

  // Three two-line rows append: the first visible line holds, and the count rises
  // by three rows (six lines would read 7).
  control.setRun(runOf({ timeline: wrappingEvents(33) }));
  await t.renderOnce();
  const appended = t.captureCharFrame();
  assert.equal(timelineLines(appended)[0], first);
  assert.match(appended, /Timeline · 4 · Jump to latest/);

  // From the top, down steps one display line at a time: reach row e1's first
  // line, then one more step shows its continuation line first.
  await press(t, renderer, "home");
  for (let i = 0; i < 6; i++) {
    if (/ e1 /.test(timelineLines(t.captureCharFrame())[0]!)) break;
    await press(t, renderer, "down");
  }
  assert.match(timelineLines(t.captureCharFrame())[0]!, / e1 /);
  await press(t, renderer, "down");
  const continuation = timelineLines(t.captureCharFrame())[0]!;
  assert.match(continuation, /^ {5}\S/);
  assert.doesNotMatch(continuation, / e\d+ /);

  // Widening rewraps each row onto one line, and e1 stays the first visible row.
  renderer.resize(100, 14);
  await t.renderOnce();
  const widened = t.captureCharFrame();
  noOverflow(widened, 100);
  assert.match(timelineLines(widened)[0]!, / e1 /);
  // Narrowing again restores the exact line: the anchor kept its offset in e1.
  renderer.resize(60, 14);
  await t.renderOnce();
  assert.match(timelineLines(t.captureCharFrame())[0]!, / e1 /);
});

// --- Step and Session dividers (#289) ---------------------------------------

/** One Turn-scoped event as the Application names it: its Step, its recorded
 *  Session, and the Session's plain name. */
function turnEvent(
  at: string,
  step: string,
  session: string,
  sessionName: string,
  event: RunTimelineEvent["event"] = "turn-started",
): RunTimelineEvent {
  return {
    at,
    event,
    detail: event === "turn-started" ? session : "completed",
    turnKind: "agent",
    step,
    session,
    sessionName,
  };
}

/** A reopened Run crossing Steps and Sessions: grill and write-spec share the
 *  `spec` conversation, a Command step has none, and each Iteration of implement
 *  opens a `fresh` one the Application names with its Iteration. */
function dividedRun(): RunView {
  return runOf({
    state: "succeeded",
    timeline: [
      { at: "T00", event: "run-created" },
      { at: "T01", event: "trust-granted", detail: "op-trust-1" },
      turnEvent("T02", "grill", "spec", "spec"),
      {
        at: "T03",
        event: "assistant-content",
        detail: "Questions answered",
        step: "grill",
        session: "spec",
        sessionName: "spec",
      },
      {
        at: "T04",
        event: "attempt-settled",
        detail: "succeeded",
        step: "grill",
      },
      turnEvent("T05", "write-spec", "spec", "spec"),
      {
        at: "T06",
        event: "attempt-settled",
        detail: "succeeded",
        step: "write-spec",
      },
      {
        at: "T07",
        event: "attempt-settled",
        detail: "succeeded",
        step: "baseline",
      },
      turnEvent(
        "T08",
        "implement",
        "fresh-0.1:implement",
        "fresh, iteration 1",
      ),
      {
        at: "T09",
        event: "attempt-settled",
        detail: "succeeded",
        step: "implement",
      },
      { at: "T10", event: "iteration", detail: "1" },
      turnEvent(
        "T11",
        "implement",
        "fresh-1.1:implement",
        "fresh, iteration 2",
      ),
      {
        at: "T12",
        event: "request-expired",
        detail: "req-42",
        step: "implement",
        session: "fresh-1.1:implement",
        sessionName: "fresh, iteration 2",
      },
      { at: "T13", event: "materialization-conflict", detail: "docs/spec.md" },
    ],
  });
}

/** Each divider line in `lines` as `<glyph> <title>`: a rule of one glyph with the
 *  title centred in it. */
function dividers(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const match = /^\s*([─═])\1* (.+?) \1+\s*$/.exec(line);
    return match === null ? [] : [`${match[1]} ${match[2]}`];
  });
}

test("[step-session-dividers] the timeline marks each Step and Harness Session with distinct plain-word dividers (#289)", async () => {
  // #23 evidence for this slice: meaning without colour (every assertion reads the
  // colourless character frame: the two dividers differ by glyph and words), large
  // content and small terminals in the tests below, and renderer and platform
  // evidence through the fake Renderer Port in the three-OS canonical suite.
  const { t } = await mountWorkbench(dividedRun(), 100, 50);
  const frame = t.captureCharFrame();
  noOverflow(frame, 100);
  const lines = timelineLines(frame);
  // A Session divider on every change of conversation, before the Step divider
  // when both begin at once; a Step divider on every change of Step, and again
  // after an Iteration completes. A shared Session draws no second Session divider.
  assert.deepEqual(dividers(lines), [
    "═ Conversation · spec",
    "─ Step · grill",
    "─ Step · write-spec",
    "─ Step · baseline",
    "═ Conversation · fresh, iteration 1",
    "─ Step · implement",
    "═ Conversation · fresh, iteration 2",
    "─ Step · implement",
  ]);
  // Each divider sits directly above the event row that begins its Step.
  const grill = lines.findIndex((line) => /Step · grill/.test(line));
  assert.match(lines[grill - 1]!, /Conversation · spec/);
  assert.match(lines[grill + 1]!, /Agent Turn started/);
  const baseline = lines.findIndex((line) => /Step · baseline/.test(line));
  assert.match(lines[baseline + 1]!, /▸ Step Attempt succeeded/);

  // Everyday rows read in plain words: no raw event kind, no recorded Session
  // name, no Session label, no ids, and no Session availability word.
  const text = lines.join("\n");
  for (const label of [
    /○ Run created/,
    /✓ Trust granted/,
    /Assistant[\s\S]*Questions answered/,
    /↻ Iteration 1 complete/,
    /\? Harness Request expired/,
    /! Materialization conflict · docs\/spec\.md/,
  ]) {
    assert.match(text, label);
  }
  assert.doesNotMatch(
    text,
    /run-created|trust-granted|attempt-settled|request-expired|materialization-conflict|iteration 1 1/,
  );
  assert.doesNotMatch(text, /fresh-\d|op-trust-1|req-42|session/);
  assert.doesNotMatch(text, /\b(?:open|detached|unusable)\b/);
});

test("[step-session-dividers] a divider wraps its words behind its glyph on a narrow terminal and rewraps on resize (#289)", async () => {
  const { t, renderer } = await mountWorkbench(dividedRun(), 100, 50);
  for (const width of [30, 22, 100]) {
    renderer.resize(width, 50);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    noOverflow(frame, width);
    const lines = timelineLines(frame).map((line) => line.trim());
    // Every word of each title survives, on lines the divider's glyph leads.
    const words = (glyph: string) =>
      lines
        .filter((line) => line.startsWith(glyph))
        .join(" ")
        .split(/[\s─═]+/);
    for (const word of ["Conversation", "fresh,", "iteration", "2"]) {
      assert.ok(words("═").includes(word), `${word} at ${width}`);
    }
    for (const word of ["Step", "write-spec", "baseline", "implement"]) {
      assert.ok(words("─").includes(word), `${word} at ${width}`);
    }
  }
  // Narrow, the title wraps over lines that each begin with the glyph.
  renderer.resize(22, 50);
  await t.renderOnce();
  const narrow = timelineLines(t.captureCharFrame()).map((line) => line.trim());
  const at = narrow.indexOf("═ fresh, iteration 1");
  assert.ok(at > 0, narrow.join("\n"));
  assert.equal(narrow[at - 1], "═ Conversation ·");
});

test("[step-session-dividers] dividers scroll with their rows: the anchor holds and the new-activity count counts events (#289)", async () => {
  // Every row begins a new Step, so each is a divider line plus its event line.
  const stepped = (count: number): RunTimelineEvent[] =>
    events(count).map((event, index) => ({ ...event, step: `s${index}` }));
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: stepped(30) }),
    100,
    14,
  );
  // One line above the live edge hides only the newest row's last line.
  await press(t, renderer, "up");
  const scrolled = t.captureCharFrame();
  assert.match(scrolled, /▼ 1 new activity · Jump to latest/);
  const first = timelineLines(scrolled)[0];

  // Three rows append, each led by its divider: the first visible line holds, and
  // the count rises by three events (six lines would read 7).
  control.setRun(runOf({ timeline: stepped(33) }));
  await t.renderOnce();
  const appended = t.captureCharFrame();
  assert.equal(timelineLines(appended)[0], first);
  assert.match(appended, /▼ 4 new activities · Jump to latest/);

  // From the top, a divider scrolls one line at a time like any row's line.
  await press(t, renderer, "home");
  const top = timelineLines(t.captureCharFrame());
  assert.deepEqual(dividers(top.slice(0, 1)), ["─ Step · s0"]);
  await press(t, renderer, "down");
  assert.match(timelineLines(t.captureCharFrame())[0]!, /Step Attempt e0/);
  await press(t, renderer, "end");
  assert.doesNotMatch(t.captureCharFrame(), /new activit/);
});

test("[step-session-dividers] the transcript marks its conversation and each Step once the start is loaded, with plain headers and title (#289)", async () => {
  const run = runOf({
    sessions: [
      {
        session: "spec",
        name: "spec",
        availability: "open",
        transcriptPage: {
          runId: "run-1",
          session: "spec",
          type: "transcript-page",
        },
      },
      {
        session: "fresh-0.1:implement",
        name: "fresh, iteration 1",
        availability: "open",
        transcriptPage: {
          runId: "run-1",
          session: "fresh-0.1:implement",
          type: "transcript-page",
        },
      },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  const entry = (
    role: "user" | "assistant",
    content: string,
    step: string,
  ) => ({ id: `${role}:${content}`, session: "spec", role, content, step });
  // The newest page holds write-spec; the older page reaches the Session's start.
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [
      entry("user", "Write the spec", "write-spec"),
      entry("assistant", "Spec written", "write-spec"),
    ],
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: [
      entry("user", "Grill me", "grill"),
      entry("assistant", "First question", "grill"),
    ],
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  const newest = t.captureCharFrame();
  noOverflow(newest, 100);
  // The title names the conversation in plain words, never its recorded name.
  assert.match(newest, /Session transcript · spec/);
  // Older entries remain, so where the conversation and its Step began is unknown:
  // no divider is drawn yet.
  assert.deepEqual(dividers(newest.split("\n")), []);

  await press(t, renderer, "p"); // loads without retargeting the anchor
  await press(t, renderer, "home"); // explicitly navigate to the Session's start
  const full = t.captureCharFrame();
  noOverflow(full, 100);
  const lines = full.split("\n");
  assert.deepEqual(dividers(lines), [
    "═ Conversation · spec",
    "─ Step · grill",
    "─ Step · write-spec",
  ]);
  const writeSpec = lines.findIndex((line) => /Step · write-spec/.test(line));
  assert.match(lines[writeSpec + 1]!, /◇ User Turn\s*$/);
  assert.match(lines[writeSpec + 2]!, /Write the spec/);
  assert.doesNotMatch(full, /session|fresh-0/);
  assert.doesNotMatch(full, /\b(?:open|detached|unusable)\b/);
});

test("[step-session-dividers] paging older across a Step boundary keeps the first visible transcript entry under its new divider (#289)", async () => {
  // Height 10 → a 6-line viewport, so the anchor, not the whole page, holds N1.
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    40,
    10,
  );
  const entries = (step: string, ...ids: string[]) =>
    ids.map((id) => ({
      id,
      session: "s",
      role: "user" as const,
      content: `${id} text`,
      step,
    }));
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: entries("write-spec", "N1", "N2", "N3"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: entries("grill", "O1", "O2", "O3"),
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /Session transcript · s/);
  assert.match(t.captureCharFrame(), /N1 text/);

  // Up at the top prepends the older page: N1's header row gains its Step divider,
  // and one line up shows that divider with N1 still in view, no older entry yet.
  await press(t, renderer, "up");
  const anchored = t.captureCharFrame();
  noOverflow(anchored, 40);
  assert.match(anchored, /N1 text/);
  assert.equal(anchored.split("\n")[2]!.trimEnd(), " ◇ User Turn");
  await press(t, renderer, "up"); // divider attached above the retained header
  assert.match(t.captureCharFrame(), /─ Step · write-spec ─/);
  assert.doesNotMatch(anchored, /O\d text/);

  // Above it, the older Step and the conversation's start.
  await press(t, renderer, "home");
  assert.deepEqual(dividers(t.captureCharFrame().split("\n")).slice(0, 2), [
    "═ Conversation · s",
    "─ Step · grill",
  ]);
});

test("a long live preview wraps in full at the live edge (#288)", async () => {
  const { t, control } = await mountWorkbench(
    runOf({ timeline: events(3) }),
    60,
    20,
  );
  const preview = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  control.setPreview(preview);
  control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  noOverflow(frame, 60);
  const text = timelineLines(frame).join(" ");
  for (const word of preview.split(" ")) {
    assert.match(text, new RegExp(`\\b${word}\\b`));
  }
});

test("a streamed preview longer than the viewport wraps in full and scrolls (#288)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(2) }),
    60,
    14,
  );
  const preview = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
  control.setPreview(preview);
  control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  // The live edge shows the newest streamed words; the row runs past the top.
  const live = t.captureCharFrame();
  noOverflow(live, 60);
  assert.match(live, /\bw199\b/);
  assert.doesNotMatch(live, /Assistant preview/);

  // Home reaches the row's first line; every word is reachable by scrolling down.
  await press(t, renderer, "home");
  const seen = new Set<string>();
  for (let i = 0; i < 80; i++) {
    for (const word of timelineLines(t.captureCharFrame())
      .join(" ")
      .match(/\bw\d+\b/g) ?? []) {
      seen.add(word);
    }
    if (seen.has("w199")) break;
    await press(t, renderer, "pagedown");
  }
  assert.equal(seen.size, 200);
});

test("rows that advertise truncation still clip with an ellipsis beside wrapped content (#288)", async () => {
  const timeline = await mountWorkbench(
    runOf({ timeline: wrappingEvents(30) }),
    24,
    14,
  );
  await press(timeline.t, timeline.renderer, "up");
  const frame = timeline.t.captureCharFrame();
  noOverflow(frame, 24);
  assert.match(frame, /› Timeline · 1 · Jump…/);
  // The rows beneath it wrap: the lorem words are whole, never cut by "…".
  const rows = timelineLines(frame).filter((line) => /lorem|ipsum/.test(line));
  assert.ok(rows.length > 0);
  for (const line of rows) assert.doesNotMatch(line, /…/);

  const overlay = await mountWorkbench(transcriptRun(), 14, 24);
  overlay.control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "hello"),
  });
  await openTranscriptDetails(overlay);
  const opened = overlay.t.captureCharFrame();
  noOverflow(opened, 14);
  assert.match(opened, /Session tra…/);
});

test("an empty timeline shows the no-activity placeholder", async () => {
  const { t } = await mountWorkbench(runOf({ timeline: [] }));
  assert.match(t.captureCharFrame(), /no activity yet/);
});

test("pressing d again closes the details panel and returns focus to the timeline", async () => {
  const { t, renderer } = await mountWorkbench(runOf({ timeline: events(4) }));
  await press(t, renderer, "d");
  assert.match(t.captureCharFrame(), /› Details/);
  await press(t, renderer, "d"); // toggle it back off
  assert.doesNotMatch(t.captureCharFrame(), /Workspace:/);
  assert.match(t.captureCharFrame(), /› Timeline/);
});

test("on a terminal too short for the panel, d does not open a clipped details panel", async () => {
  // Wide enough across, but too few rows for DETAILS_HEIGHT plus a timeline row.
  const { t, renderer } = await mountWorkbench(
    runOf({ progress: PROGRESS, timeline: events(6) }),
    100,
    9,
  );
  await press(t, renderer, "d");
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Workspace:/); // panel stayed hidden
  noOverflow(frame, 100);
});

// --- reference inspection (AC4) --------------------------------------------

/** A Run with one Session `s` that advertises transcript References (#124). */
function transcriptRun() {
  return runOf({
    sessions: [
      {
        session: "s",
        name: "s",
        availability: "open",
        transcriptPage: {
          runId: "run-1",
          session: "s",
          type: "transcript-page",
        },
        transcriptExport: {
          runId: "run-1",
          session: "s",
          type: "transcript-export",
        },
      },
    ],
  });
}

/** Transcript entries for Session `s` with the given role and contents. */
function txEntries(role: "user" | "assistant", ...contents: string[]) {
  return contents.map((content) => ({
    id: `${role}:${content}`,
    session: "s",
    role,
    content,
  }));
}

test("the Session transcript opens the newest page and restores focused details (#124, #421)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [
      {
        id: "user-1",
        session: "s",
        role: "user",
        content: "Fix the failing test",
      },
      {
        id: "assistant-1",
        session: "s",
        role: "assistant",
        content: "Working on it",
      },
    ],
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  const opened = t.captureCharFrame();
  assert.match(opened, /Session transcript/);
  // The role headers name no Session (#289): the overlay holds one conversation,
  // which its Session divider names.
  assert.match(opened, /◇ User Turn\s*$/m);
  assert.match(opened, /Fix the failing test/);
  assert.match(opened, /◆ Assistant\s*$/m);
  assert.match(opened, /Working on it/);
  assert.doesNotMatch(opened, /session/);

  await press(t, renderer, "escape");
  assert.match(t.captureCharFrame(), /› Details/);
});

test("paging older upward preserves the first visible entry (#124)", async () => {
  // Height 10 → interior 8 → 6-line viewport, smaller than a 12-line page.
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    10,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "N1", "N2", "N3", "N4"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "O1", "O2", "O3", "O4"),
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  // Opens on the newest entries (the live edge, the bottom); older not loaded.
  let f = t.captureCharFrame();
  assert.match(f, /N4/);
  assert.doesNotMatch(f, /O1|O2|O3|O4/);

  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /N1/);

  // Up at the top loads the older page and keeps N1 on screen (anchor preserved):
  // if the view had jumped to the live edge instead, N4 would show and N1 would not.
  await press(t, renderer, "up");
  f = t.captureCharFrame();
  assert.match(f, /N1/);
  assert.doesNotMatch(f, /N4/);

  // Paging further up reaches the just-loaded older entries: each page is half
  // the 6-line viewport, so the 12 prepended lines take a few presses.
  for (let i = 0; i < 7; i++) await press(t, renderer, "pageup");
  assert.match(t.captureCharFrame(), /O1/);
});

test("workbench-timeline-inspection: a failed older-page read is visible and keeps its retry cursor", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    10,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "N1", "N2", "N3", "N4"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: false,
    problem: {
      code: "transcript-page-stale",
      explanation: "The older transcript page could not be read.",
      remediation: "Scroll up to retry.",
      possibleEffects: "none",
    },
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  await press(t, renderer, "home");
  await press(t, renderer, "up");
  const failed = t.captureCharFrame();
  assert.match(failed, /Notice \[transcript-page-stale\]/);
  assert.match(failed, /Scroll up to retry/);

  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "O1", "O2"),
  });
  await press(t, renderer, "up");
  // The retried older page loads beneath the cleared Notice, keeping N1 in view.
  assert.match(t.captureCharFrame(), /N1/);
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /O1/);
  assert.doesNotMatch(t.captureCharFrame(), /transcript-page-stale/);
});

test("a large transcript entry scrolls without truncation (#124)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  const big = Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n");
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [{ id: "big", session: "s", role: "assistant", content: big }],
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  // Opens at the bottom, so the newest lines show; nothing is truncated away.
  assert.match(t.captureCharFrame(), /line-599/);
  assert.doesNotMatch(t.captureCharFrame(), /truncated/);
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /line-0\b/);
});

test("the transcript inspection wraps long lines at the view width and rewraps on resize (#124, #288)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  const long = "a very long single line that exceeds forty columns easily";
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [{ id: "long", session: "s", role: "user", content: long }],
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), new RegExp(long));

  // Narrow the terminal: the line wraps at a word boundary and nothing is cut.
  t.resize(40, 24);
  renderer.resize(40, 24);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  noOverflow(narrow, 40);
  assert.match(narrow, /^ a very long single line that exceeds\s*$/m);
  assert.match(narrow, /^ forty columns easily\s*$/m);

  // Widen it again: it rewraps back onto one line.
  t.resize(80, 24);
  renderer.resize(80, 24);
  await t.renderOnce();
  const wide = t.captureCharFrame();
  noOverflow(wide, 80);
  assert.match(wide, new RegExp(long));
});

test("paging older over wrapped transcript entries preserves the first visible entry (#124, #288)", async () => {
  // Height 10 → a 6-line viewport; at width 40 each entry wraps over three lines,
  // so a page holds more display lines than logical ones.
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    40,
    10,
  );
  const words = "lorem ipsum dolor sit amet ".repeat(3).trim();
  const entries = (...ids: string[]) =>
    txEntries("user", ...ids.map((id) => `${id} ${words}`));
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: entries("N1", "N2", "N3", "N4"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: entries("O1", "O2", "O3", "O4"),
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /N1 lorem/);

  // Up at the top prepends the older page and moves one line up: N1 stays in view,
  // and none of the prepended entries' text above the separator shows.
  await press(t, renderer, "up");
  const anchored = t.captureCharFrame();
  noOverflow(anchored, 40);
  assert.match(anchored, /N1 lorem/);
  assert.doesNotMatch(anchored, /O\d/);

  await press(t, renderer, "pageup");
  await press(t, renderer, "pageup");
  assert.match(t.captureCharFrame(), /O4 lorem/);
});

test("a paused transcript keeps its first visible line across a resize that rewraps it (#288)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    12,
  );
  const words = "lorem ipsum dolor sit amet ".repeat(3).trim();
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries(
      "user",
      ...["A", "B", "C", "D", "E", "F", "G", "H"].map(
        (id) => `${id}1 ${words}`,
      ),
    ),
  });
  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  // Line by line from the top until C1's entry leads the view, well above the
  // live edge so the paused anchor is what holds it.
  await press(t, renderer, "home");
  const firstContent = () => t.captureCharFrame().split("\n")[2]!; // under the padding and title rows
  for (let i = 0; i < 12 && !/C1 lorem/.test(firstContent()); i++) {
    await press(t, renderer, "down");
  }
  assert.match(firstContent(), /^ C1 lorem/);

  // Narrowing rewraps every entry over more lines; C1 still leads the view.
  t.resize(40, 12);
  renderer.resize(40, 12);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 40);
  assert.match(firstContent(), /^ C1 lorem/);
  t.resize(100, 12);
  renderer.resize(100, 12);
  await t.renderOnce();
  assert.match(firstContent(), /^ C1 lorem/);
});

test("opening a large text output shows bounded content with a truncation marker and scrolls", async () => {
  const run = runOf({
    outputs: [
      {
        name: "log",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "log",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  const big = Array.from({ length: 900 }, (_, i) => `line-${i}`).join("\n");
  control.setRead("log", { found: true, type: "text", content: big });

  await press(t, renderer, "d"); // focus details
  await press(t, renderer, "return"); // open the selected (log) reference
  const opened = t.captureCharFrame();
  assert.match(opened, /log \(text\)/); // inspection title
  assert.match(opened, /line-0/); // top of the content
  assert.doesNotMatch(opened, /line-800/); // bounded — not everything inlined

  for (let i = 0; i < 3; i++) await press(t, renderer, "pagedown");
  assert.match(t.captureCharFrame(), /line-\d\d/);

  await press(t, renderer, "end");
  assert.match(t.captureCharFrame(), /output truncated/); // explicit marker

  await press(t, renderer, "escape");
  assert.doesNotMatch(t.captureCharFrame(), /output truncated/);
  assert.match(t.captureCharFrame(), /Details/);
});

test("workbench-timeline-inspection: timeline and inspection end truncated content with the same marker", async () => {
  const timeline = await mountWorkbench(
    runOf({
      timeline: [
        {
          at: "T000",
          event: "assistant-content",
          detail: `${"x".repeat(157)} … output truncated`,
        },
        {
          at: "T001",
          event: "assistant-content",
          detail: "Still thinking…",
        },
      ],
    }),
    100,
    30,
  );
  // The capped row wraps rather than clipping: every kept character shows, and the
  // marker ends the row's last display line.
  const timelineFrame = timeline.t.captureCharFrame();
  const kept = (timelineFrame.match(/x{10,}/g) ?? []).join("");
  assert.equal(kept.length, 157);
  assert.match(timelineFrame, /^ {5}x+ … output truncated\s*$/m);
  assert.match(timelineFrame, /Still thinking…/);
  assert.doesNotMatch(timelineFrame, /Still thinking … output truncated/);

  const run = runOf({
    outputs: [
      {
        name: "log",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "log",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const inspection = await mountWorkbench(run, 100, 30);
  inspection.control.setRead("log", {
    found: true,
    type: "text",
    content: Array.from({ length: 501 }, (_, index) => `line-${index}`).join(
      "\n",
    ),
  });
  await press(inspection.t, inspection.renderer, "d");
  await press(inspection.t, inspection.renderer, "return");
  await press(inspection.t, inspection.renderer, "end");
  assert.match(inspection.t.captureCharFrame(), /line-499.*… output truncated/);
});

test("captured output with colour escapes and carriage returns renders without them", async () => {
  const run = runOf({
    outputs: [
      {
        name: "log",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "log",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  // A command forcing colour with CRLF line endings: SGR escapes plus `\r\n` (D4).
  const raw = "[31mred line[0m\r\nplain line\r\n[1mbold line[0m";
  control.setRead("log", { found: true, type: "text", content: raw });

  await press(t, renderer, "d"); // focus details
  await press(t, renderer, "return"); // open the log reference
  const frame = t.captureCharFrame();
  assert.ok(!frame.includes("["), "no escape sequences survive");
  assert.ok(!frame.includes("\r"), "no carriage returns survive");
  // Split on /\r?\n/: each CRLF started a fresh row, so all three read cleanly.
  assert.match(frame, /red line/);
  assert.match(frame, /plain line/);
  assert.match(frame, /bold line/);
});

test("a Verdict and a diagnostic open through their references", async () => {
  const run = runOf({
    state: "halted",
    outputs: [
      {
        name: "grade",
        type: "verdict",
        reference: {
          runId: "run-1",
          artifactName: "grade",
          versionId: "v1",
          type: "verdict",
        },
      },
    ],
    conflict: {
      artifactName: "out.txt",
      path: "out.txt",
      reference: { runId: "run-1", diagnosticId: "diag-1", type: "diagnostic" },
    },
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  control.setRead("grade", { found: true, type: "verdict", content: "pass" });
  control.setRead("d:diag-1", {
    found: true,
    type: "diagnostic",
    content: "workspace copy of out.txt went missing",
  });

  await press(t, renderer, "d"); // details focus, first resource (grade) selected
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /grade \(verdict\)/);
  assert.match(t.captureCharFrame(), /pass/);
  await press(t, renderer, "escape");

  await press(t, renderer, "down"); // select the diagnostic
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /halt diagnostic: out\.txt/);
  assert.match(t.captureCharFrame(), /went missing/);
});

test("a halted Run shows the materialization conflict path as a top-level line, at 40 columns", async () => {
  const run = runOf({
    state: "halted",
    conflict: {
      artifactName: "out.txt",
      path: "sub/out.txt",
      reference: { runId: "run-1", diagnosticId: "d1", type: "diagnostic" },
    },
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  // The Workspace path to restore is a top-level line, not only a details-panel
  // row reachable at width ≥ 60 (A13).
  assert.match(t.captureCharFrame(), /restore sub\/out\.txt/);
  renderer.resize(40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /restore sub\/out\.txt/); // still shown at 40 columns
  noOverflow(frame, 40);
});

test("a selected-Harness preparation Problem is visible without colour and survives narrow resize", async () => {
  const run = runOf({
    state: "halted",
    selectedHarness: "codex",
    problem: {
      code: "selected-harness-unavailable",
      explanation: "Codex could not be prepared (authentication).",
      remediation: "Log in separately through Codex, then resume the Run.",
      possibleEffects: "none",
      details: { harness: "codex" },
    },
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  let frame = t.captureCharFrame();
  // The selected-Harness Problem stays a top-level header block, colour-independent.
  assert.match(frame, /selected-harness-unavailable/);
  assert.match(frame, /authentication/);
  assert.match(frame, /Log in separately through Codex/);
  // A halted Run carries its resting prose beside the state word (#194 story 38).
  assert.match(frame, /Execution stopped outside the Workflow\./);
  renderer.resize(40, 24);
  await t.renderOnce();
  frame = t.captureCharFrame();
  assert.match(frame, /selected-harness-unavailable/);
  noOverflow(frame, 40);
});

test("a missing reference surfaces its Problem rather than throwing", async () => {
  const run = runOf({
    outputs: [
      {
        name: "gone",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "gone",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  await press(t, renderer, "d");
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /resource-gone/);
});

// --- focus + Escape (AC5) --------------------------------------------------

test("focus moves timeline → details → timeline, and Escape leaves the Workbench for Home", async () => {
  const { t, renderer } = await mountWorkbench(runOf({ timeline: events(4) }));
  assert.match(t.captureCharFrame(), /› Timeline/); // focus glyph on the timeline
  await press(t, renderer, "d"); // open + focus details
  assert.match(t.captureCharFrame(), /› Details/);
  await press(t, renderer, "tab"); // back to the timeline
  assert.match(t.captureCharFrame(), /› Timeline/);
  await press(t, renderer, "escape"); // leaves the Workbench
  assert.match(t.captureCharFrame(), /Secant/); // back on Home
  assert.doesNotMatch(t.captureCharFrame(), /Timeline/);
});

test("q and Ctrl+C quit from the Workbench", async () => {
  const first = await mountWorkbench(runOf());
  await press(first.t, first.renderer, "q");
  assert.equal(first.exits.length, 1);

  const second = await mountWorkbench(runOf());
  await press(second.t, second.renderer, "c", { ctrl: true });
  assert.equal(second.exits.length, 1);
});

// --- layout (AC6) ----------------------------------------------------------

test("small width compacts the header before hiding the details panel, without overflow", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ progress: PROGRESS, timeline: events(6) }),
    100,
    30,
  );
  await press(t, renderer, "d");
  const wide = t.captureCharFrame();
  assert.match(wide, /Details/);
  const wideHeader = headerLines(wide, 3);
  assert.match(wideHeader[0] ?? "", /Alpha Flow — RUNNING/);
  assert.match(wideHeader[1] ?? "", /^\s*step 1 of 3\s*$/); // wide second line
  assert.match(wideHeader[2] ?? "", /^\s*Progress:/);

  // The header compacts first while the inspection affordance remains available.
  // A live-state Run's compact line leads with the Bundle name and state, like
  // the wide first line, and never with its Run id.
  renderer.resize(70, 30);
  await t.renderOnce();
  const compact = t.captureCharFrame();
  assert.match(compact, /Workspace:/);
  const compactHeader = headerLines(compact, 2);
  assert.match(
    compactHeader[0] ?? "",
    /^\s*Alpha Flow — RUNNING · View current\s*$/,
  );
  assert.match(compactHeader[1] ?? "", /^\s*Progress:/); // one header row
  noOverflow(compact, 70);

  // Below the details breakpoint the panel is hidden too.
  renderer.resize(50, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  assert.doesNotMatch(narrow, /Workspace:/);
  assert.match(headerLines(narrow, 1)[0] ?? "", /Alpha Flow — RUNNING/);
  assert.doesNotMatch(narrow, /run-1/);
  noOverflow(narrow, 50);
});

test("a live-state Run's header carries no Run id or process at any width; the id shows once the Run rests", async () => {
  for (const state of ["running", "blocked"] as const) {
    const { t, control, renderer } = await mountWorkbench(
      runOf({
        state,
        progress: PROGRESS,
        position: 1,
        timeline: events(60),
        liveness: { state: "live-here", ownerPid: 4101 },
      }),
    );
    // The panel is closed, so the whole frame stands for the header here.
    for (const width of [100, 70, 50]) {
      renderer.resize(width, 40);
      await t.renderOnce();
      const frame = t.captureCharFrame();
      assert.doesNotMatch(frame, /run-1/, `${state} at ${width}: no Run id`);
      assert.doesNotMatch(frame, /4101|process/, `${state} at ${width}`);
      assert.doesNotMatch(frame, /live in|not live/, `${state} at ${width}`);
      assert.match(frame, new RegExp(state.toUpperCase())); // state in words
    }

    // Leaving the live state brings the Run id back, wide and compact. The header
    // grows by the resting-prose row, and headerRows counts it: the full timeline
    // still leaves the footer on screen.
    control.setRun(
      runOf({
        state: "halted",
        progress: PROGRESS,
        position: 1,
        timeline: events(60),
      }),
    );
    renderer.resize(100, 40);
    await t.waitForFrame((f) => f.includes("HALTED"));
    const resting = t.captureCharFrame();
    const wide = headerLines(resting, 4);
    assert.match(wide[0] ?? "", /Alpha Flow — HALTED/);
    assert.match(wide[1] ?? "", /^\s*Run run-1 · step 2 of 3\s*$/);
    assert.match(wide[2] ?? "", /Execution stopped outside the Workflow\./);
    assert.match(wide[3] ?? "", /^\s*Progress:/);
    assert.match(resting, /esc back · q quit/);
    renderer.resize(70, 40);
    await t.renderOnce();
    const compact = headerLines(t.captureCharFrame(), 1);
    assert.match(compact[0] ?? "", /Run run-1 — HALTED/);
  }

  for (const state of ["failed", "succeeded", "cancelled"] as const) {
    const { t, renderer } = await mountWorkbench(runOf({ state }));
    assert.match(headerLines(t.captureCharFrame(), 2)[1] ?? "", /Run run-1/);
    renderer.resize(60, 40);
    await t.renderOnce();
    const compact = headerLines(t.captureCharFrame(), 1)[0] ?? "";
    assert.match(compact, /Run run-1/, `${state} compact`);
    assert.match(compact, new RegExp(state.toUpperCase())); // never colour alone
  }
});

test("a resting Run's long id clips with an ellipsis in the header and the details panel", async () => {
  const runId = `run-${"x".repeat(120)}`;
  const { t, renderer } = await mountWorkbench(
    runOf({ runId, state: "failed" }),
    100,
    30,
  );
  assert.match(
    headerLines(t.captureCharFrame(), 2)[1] ?? "",
    /^\s*Run run-x+…\s*$/,
  );
  await press(t, renderer, "d");
  const panel = t.captureCharFrame();
  noOverflow(panel, 100);
  const clipped = panel
    .split("\n")
    .filter((line) => /^\s*Run run-x+…\s*$/.test(line));
  assert.equal(clipped.length, 2); // the wide second line and the panel's Run row

  renderer.resize(50, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  noOverflow(narrow, 50);
  assert.match(headerLines(narrow, 1)[0] ?? "", /^\s*Run run-x+…\s*$/);
});

test("resize relayouts the timeline without overflow and keeps every state readable without colour", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "failed", progress: PROGRESS, timeline: events(20) }),
    90,
    24,
  );
  noOverflow(t.captureCharFrame(), 90);
  assert.match(t.captureCharFrame(), /FAILED/); // word, not just colour
  renderer.resize(60, 18);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 60);
  assert.match(t.captureCharFrame(), /FAILED/);
});

test("the details panel carries the Run id and names whether the Run is live here or in another owner process", async () => {
  const here = await mountWorkbench(
    runOf({ liveness: { state: "live-here", ownerPid: 4101 } }),
  );
  assert.doesNotMatch(here.t.captureCharFrame(), /process 4101/); // not the header
  await press(here.t, here.renderer, "d");
  const hereFrame = here.t.captureCharFrame();
  assert.match(hereFrame, /^\s*Run run-1\s*$/m);
  assert.match(hereFrame, /Live · in this instance \(process 4101\)/);

  const elsewhere = await mountWorkbench(
    runOf({ liveness: { state: "live-elsewhere", ownerPid: 5202 } }),
  );
  await press(elsewhere.t, elsewhere.renderer, "d");
  assert.match(
    elsewhere.t.captureCharFrame(),
    /Live · in another instance \(process 5202\)/,
  );

  // A Run that is not live has no owner to name, so the panel says nothing of one;
  // its id, digest, and recovery evidence stay.
  const rested = await mountWorkbench(
    runOf({
      state: "halted",
      conflict: {
        artifactName: "plan",
        path: "docs/plan.md",
        reference: {
          runId: "run-1",
          diagnosticId: "diag-1",
          type: "diagnostic",
        },
      },
    }),
  );
  await press(rested.t, rested.renderer, "d");
  const restedFrame = rested.t.captureCharFrame();
  assert.match(restedFrame, /^\s*Run run-1\s*$/m);
  assert.doesNotMatch(restedFrame, /Live ·|process/);
  assert.match(restedFrame, /sha256:abc123/);
  assert.match(restedFrame, /Resting reason · A required file changed/);
  assert.match(
    restedFrame,
    /Materialization conflict · restore docs\/plan\.md/,
  );
});

// --- Review checkpoint interaction (#92) -----------------------------------

test("a blocked Run shows the checkpoint interaction in place of the footer, with the facts and evidence", async () => {
  const { t } = await mountWorkbench(
    blockedRunOf({
      checkpoint: checkpointOf({
        message: "Ship it?",
        interval: 3,
        completedIterations: 6,
      }),
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-1",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
    }),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /every 3 iteration\(s\)/); // cadence
  assert.match(frame, /6 completed/); // completed-iteration count
  assert.match(frame, /Ship it\?/); // the authored message
  assert.match(frame, /latest: done = fail/); // the latest fail Verdict
  assert.match(frame, /Continue 3 More Iterations/); // control names the count
  assert.match(frame, /Stop Run/);
  assert.match(frame, /report/); // evidence: the output link
  assert.match(frame, /enter confirm/); // the interaction's own hints
  assert.doesNotMatch(frame, /d details · end latest/); // footer was replaced
});

test("a non-blocked Run shows no checkpoint control and keeps its footer", async () => {
  const { t } = await mountWorkbench(runOf({ timeline: events(3) }));
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.doesNotMatch(frame, /More Iterations/);
  assert.match(frame, /d details/); // footer present
});

test("a checkpoint without a live answer offer shows no controls", async () => {
  const { t } = await mountWorkbench(
    runOf({ state: "blocked", checkpoint: checkpointOf(), actionOffers: [] }),
  );
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /More Iterations/); // no control lacks an offer
  assert.match(frame, /waiting for review/); // the blocked note still shows
});

test("Continue dispatches answer-human-gate continue against the snapshot's gate, with the granted count in the label", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  // Focus lands on the interaction with Continue selected by default.
  assert.match(t.captureCharFrame(), /› \[ Continue 3 More Iterations \]/);
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  assert.equal(control.answers[0]?.answer, "continue");
  assert.deepEqual(control.answers[0]?.gate, GATE);
});

test("Stop dispatches answer-human-gate stop against the snapshot's gate", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  await press(t, renderer, "right"); // select Stop
  assert.match(t.captureCharFrame(), /› \[ Stop Run \]/);
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  assert.equal(control.answers[0]?.answer, "stop");
  assert.deepEqual(control.answers[0]?.gate, GATE);
});

test("the controls are unavailable while the answer is pending and gone once it applies", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  control.setAnswerOutcome({ kind: "pending" });
  await press(t, renderer, "return"); // dispatch continue
  await t.renderOnce();
  assert.equal(control.answers.length, 1);
  assert.match(t.captureCharFrame(), /submitting your answer/);
  assert.match(t.captureCharFrame(), /unavailable/);
  // A second confirm while pending dispatches nothing.
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  // Applied: the live snapshot leaves blocked and the interaction disappears.
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "running", timeline: events(2), actionOffers: [] }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.match(frame, /d details/); // footer returned
});

test("a refused answer surfaces its Problem and re-enables the controls", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  control.setAnswerOutcome({
    kind: "refused",
    problem: {
      code: "gate-stale",
      explanation: "The Gate moved on.",
      remediation: "Re-open the Run.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /refused: The Gate moved on/);
  assert.doesNotMatch(frame, /unavailable/); // controls available again
});

test("a Run that blocks again after a granted interval shows the interaction with the advanced count", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ checkpoint: checkpointOf({ completedIterations: 3 }) }),
  );
  assert.match(t.captureCharFrame(), /3 completed/);
  await press(t, renderer, "return"); // continue
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "running", timeline: events(4), actionOffers: [] }),
  );
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Review checkpoint/);
  // It blocks again after the granted interval, with an advanced count.
  control.setRun(
    blockedRunOf({ checkpoint: checkpointOf({ completedIterations: 6 }) }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /6 completed/);
});

test("a re-block at a fresh Gate resets the control to Continue and clears a prior refusal", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  // Select Stop and dispatch; the answer is refused (the Gate moved on).
  control.setAnswerOutcome({
    kind: "refused",
    problem: {
      code: "gate-stale",
      explanation: "The Gate moved on.",
      remediation: "Re-open the Run.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "right"); // select Stop
  await press(t, renderer, "return");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /refused: The Gate moved on/);
  assert.match(t.captureCharFrame(), /› \[ Stop Run \]/); // Stop still selected

  // The Run runs on, then re-blocks at a *fresh* Gate (a different Attempt).
  control.setRun(
    runOf({ state: "running", timeline: events(2), actionOffers: [] }),
  );
  await t.renderOnce();
  control.setRun(
    blockedRunOf({
      checkpoint: checkpointOf({
        gate: { ...GATE, attemptId: "a10" },
        completedIterations: 6,
      }),
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /6 completed/); // the advanced count
  assert.doesNotMatch(frame, /refused/); // the stale refusal is gone
  assert.match(frame, /› \[ Continue 3 More Iterations \]/); // reset to Continue
});

test("Stop leaves the Run failed with its timeline and Artifacts still browsable", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ timeline: events(3) }),
  );
  await press(t, renderer, "right"); // Stop
  await press(t, renderer, "return");
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({
      state: "failed",
      timeline: events(3),
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-1",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
      actionOffers: [],
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /FAILED/);
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.match(frame, / e0/); // the timeline is intact
  await press(t, renderer, "d"); // Artifacts still browsable
  assert.match(t.captureCharFrame(), /report \(text\)/);
});

test("focus lands on the checkpoint when it appears, tabs to the timeline, and returns when it leaves", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ timeline: events(4) }),
  );
  assert.match(t.captureCharFrame(), /› Review checkpoint/); // focus on the interaction
  await press(t, renderer, "tab"); // to the timeline
  assert.match(t.captureCharFrame(), /› Timeline/);
  await press(t, renderer, "tab"); // wraps back to the checkpoint
  assert.match(t.captureCharFrame(), /› Review checkpoint/);
  // When it leaves, focus returns to the timeline.
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "failed", timeline: events(4), actionOffers: [] }),
  );
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /› Timeline/);
});

test("the checkpoint interaction fits small widths without overflow and states both consequences without colour", async () => {
  const { t, renderer } = await mountWorkbench(blockedRunOf(), 100, 30);
  let frame = t.captureCharFrame();
  noOverflow(frame, 100);
  assert.match(frame, /grant one more review interval/); // continue consequence, plain text
  assert.match(frame, /end the Run failed/); // stop consequence, plain text
  renderer.resize(40, 24);
  await t.renderOnce();
  frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Continue 3 More Iterations/); // controls still readable
  assert.match(frame, /Stop Run/);
});

// --- deleted between launch and initial open -------------------------------

test("a launched Run missing on initial open returns to Previous Runs with its Bundle notice", async () => {
  const control = makeRunView({
    family: "run",
    runId: "ghost",
    result: {
      found: false,
      problem: {
        code: "run-not-found",
        explanation: "No such Run.",
        remediation: "Run `secant run list`.",
        possibleEffects: "none",
      },
    },
  });
  const renderer = makeFakeRenderer(80, 24);
  const { t } = await mountApp(control, renderer, "ghost", 80, 24);
  await t.waitForFrame((frame) => frame.includes("was deleted"));
  assert.match(t.captureCharFrame(), /Alpha Flow was deleted/);
  assert.doesNotMatch(t.captureCharFrame(), /No such Run/);
});

// --- Run Actions: resume / cancel / delete (#92 ticket, AC3) ---------------

const RESUME_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: true as const,
  consequence: "resume: continue from the Step the Run stopped at.",
};
const CANCEL_OFFER = {
  action: "cancel-run" as const,
  runId: "run-1",
  consequence: "end the live Run cancelled, keeping its history and Artifacts.",
};
const DELETE_OFFER = {
  action: "delete-run" as const,
  runId: "run-1",
  consequence: "remove the Run and its stored history and Artifacts from disk.",
};
// A resume that arms an acknowledgement (#194 story 39) and one the Port marks
// unavailable (#194 story 40).
const RESUME_ACK_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: true as const,
  consequence: "resume: continue from the Step the Run stopped at.",
  acknowledgement:
    "the interrupted command may have already run — resuming re-runs this Step, so its effects may repeat.",
};
const RESUME_UNAVAILABLE_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: false as const,
  reason:
    'resume needs the "main" Session, which is no longer usable — start a new Run instead.',
};

function okActions(over: Partial<RunActionsView> = {}): RunActionsView {
  return {
    resume: () => () => ({ kind: "ok" }),
    cancel: () => () => ({ kind: "ok" }),
    remove: () => () => ({ kind: "ok" }),
    interrupt: () => () => ({ kind: "ok" }),
    changeModelChoice: () => () => ({ kind: "ok" }),
    ...over,
  };
}

test("resume stays on the main rail; delete moves into the details panel (#194 story 37)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER, DELETE_OFFER] }),
    100,
    40,
    okActions(),
  );
  // The main rail keeps the primary action; delete is not on it (AC3).
  const rail = t.captureCharFrame();
  assert.match(rail, /r resume — resume: continue from the Step/);
  assert.doesNotMatch(rail, /x delete/);
  assert.doesNotMatch(rail, /c cancel/);
  // Delete lives in the panel with its consequence.
  await press(t, renderer, "d");
  const panel = t.captureCharFrame();
  assert.match(panel, /x delete — remove the Run/);
  assert.doesNotMatch(panel, /c cancel/); // not offered while resting
});

test("no Actions section is shown when the Run offers none", async () => {
  const { t } = await mountWorkbench(runOf({ actionOffers: [] }));
  assert.doesNotMatch(t.captureCharFrame(), /Actions:/);
});

test("resume dispatches and the Workbench follows into the running Run", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "halted", actionOffers: [RESUME_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  const actions = okActions({
    resume: () => {
      // Production drives the Run and the read seam observes it; model that here:
      // the dispatch settles at once and the snapshot advances to running.
      control.setRun(runOf({ state: "running", actionOffers: [CANCEL_OFFER] }));
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  assert.match(t.captureCharFrame(), /r resume/);

  await press(t, renderer, "r");
  const frame = t.captureCharFrame();
  assert.match(frame, /RUNNING/); // transitioned into the running Workbench
  assert.doesNotMatch(frame, /r resume/); // no longer resumable
  // Cancel now lives in the panel (#194 story 37); it is offered while live.
  await press(t, renderer, "d"); // dismiss the "Resume applied" receipt
  await press(t, renderer, "d"); // open the details panel
  assert.match(t.captureCharFrame(), /c cancel/);
});

test("workbench-timeline-inspection: a resume receipt moves from checking to applied and is dismissible", async () => {
  const [outcome, setOutcome] = createSignal<RunActionOutcome>({
    kind: "pending",
  });
  const actions = okActions({ resume: () => outcome });
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
    100,
    40,
    actions,
  );

  await press(t, renderer, "r");
  assert.match(t.captureCharFrame(), /Checking resume/);
  assert.doesNotMatch(t.captureCharFrame(), /d dismiss/);

  setOutcome({ kind: "ok" });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Resume applied · d dismiss/);

  await press(t, renderer, "d");
  const dismissed = t.captureCharFrame();
  assert.doesNotMatch(dismissed, /Resume applied/);
  assert.doesNotMatch(dismissed, /› Details/);
});

test("resume takeover asks once with the owner pid before dispatching the offered form", async () => {
  const takeover = {
    ...RESUME_OFFER,
    takeover: { ownerPid: 7331 },
  };
  let received: ResumeRunOffer | undefined;
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "running",
      liveness: { state: "live-elsewhere", ownerPid: 7331 },
      actionOffers: [takeover],
    }),
    100,
    40,
    okActions({
      resume: (offer) => {
        received = offer;
        return () => ({ kind: "ok" });
      },
    }),
  );

  await press(t, renderer, "r");
  assert.equal(received, undefined);
  assert.match(t.captureCharFrame(), /Take over from process 7331/);
  await press(t, renderer, "y");
  assert.deepEqual(received, takeover);
});

test("workbench-interaction-regression: delete stays armed until y confirms and then leaves", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "failed", actionOffers: [DELETE_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let removed = 0;
  const actions = okActions({
    remove: () => {
      removed += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "d"); // open the panel where delete now lives (#194)
  await t.waitForFrame((f) => f.includes("x delete"));
  await press(t, renderer, "x"); // arm the confirmation
  assert.equal(removed, 0); // not dispatched yet
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "y"); // confirm
  assert.equal(removed, 1);
  assert.match(t.captureCharFrame(), /Previous Runs/);
  assert.match(t.captureCharFrame(), /Alpha Flow was deleted/);
  assert.doesNotMatch(t.captureCharFrame(), /Timeline/);
});

test("Escape backs out of an armed delete without dispatching or leaving", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "failed", actionOffers: [DELETE_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let removed = 0;
  const actions = okActions({
    remove: () => {
      removed += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "d"); // open the panel where delete now lives (#194)
  await t.waitForFrame((f) => f.includes("x delete"));
  await press(t, renderer, "x"); // arm
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "escape"); // back out
  assert.equal(removed, 0);
  assert.doesNotMatch(t.captureCharFrame(), /Delete is permanent/);
  assert.match(t.captureCharFrame(), /Timeline/); // still on the Workbench
});

test("workbench-interaction-regression: cancel stays armed until y confirms", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "running", actionOffers: [CANCEL_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let cancelled = 0;
  const actions = okActions({
    cancel: () => {
      cancelled += 1;
      control.setRun(
        runOf({ state: "cancelled", actionOffers: [DELETE_OFFER] }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "d"); // open the panel where cancel now lives (#194)
  await t.waitForFrame((f) => f.includes("c cancel"));
  await press(t, renderer, "c"); // arm
  assert.equal(cancelled, 0);
  assert.match(t.captureCharFrame(), /Cancel ends the Run/);
  await press(t, renderer, "y"); // confirm
  assert.equal(cancelled, 1);
  const frame = t.captureCharFrame();
  assert.match(frame, /CANCELLED/); // transitioned to the cancelled state
  assert.match(frame, /x delete/); // now offers delete, not cancel
  assert.doesNotMatch(frame, /c cancel/);
});

test("a refused action surfaces the reason without leaving", async () => {
  const actions = okActions({
    resume: () => () => ({
      kind: "refused",
      problem: {
        code: "run-live-elsewhere",
        explanation: "The Run is live in another process.",
        remediation: "Wait for it to rest, then retry.",
        possibleEffects: "none",
      },
    }),
  });
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
    100,
    40,
    actions,
  );
  await press(t, renderer, "r");
  const frame = t.captureCharFrame();
  assert.match(frame, /live in another process/); // the reason is shown
  assert.match(frame, /Timeline/); // still on the Workbench
});

test("a refused delete surfaces its reason though delete lives only in the panel (#194 story 37)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "failed", actionOffers: [DELETE_OFFER] }),
    100,
    40,
    okActions({
      remove: () => () => ({
        kind: "refused",
        problem: {
          code: "run-store-damaged",
          explanation: "The Run store is damaged.",
          remediation: "Re-open the Run.",
          possibleEffects: "none",
        },
      }),
    }),
  );
  // Delete is the only offer, so the main Actions rail is not shown at all — the
  // refusal must not be gated behind it (the regression this guards).
  assert.doesNotMatch(t.captureCharFrame(), /Actions:/);
  await press(t, renderer, "d"); // open the panel where delete lives
  await press(t, renderer, "x"); // arm
  await press(t, renderer, "y"); // confirm → refused
  const after = t.captureCharFrame();
  assert.match(after, /The Run store is damaged\./); // the reason stays visible
  assert.match(after, /Timeline/); // still on the Workbench
});

// --- recovery evidence, resting prose, and the two resume acknowledgements
//     (#194 stories 36-40) ------------------------------------------------

test("[workbench-details-recovery] the panel renders recovery evidence and hosts the relocated destructive actions", async () => {
  // Coverage dimensions for this slice (AC7): keymap and focus (`d` opens the panel,
  // `x` arms delete from it), terminal layout and the details breakpoint (the panel
  // fits at 100×40 without overflow), colour-independent status (every recovery line
  // and the resting prose read as words), interaction tuning (delete arms then
  // confirms on `y`), and renderer/platform evidence (the sessions/latest-activity
  // facts come only from the Run view). Timeline mechanics and large content are
  // inapplicable to this slice; the Windows Terminal human check is not applicable —
  // the named workbench-details-recovery scenario runs in the canonical suite on
  // Windows, macOS, and Linux.
  const run = runOf({
    state: "halted",
    sessions: [
      {
        session: "main-0.1:work",
        name: "main, iteration 1",
        availability: "unusable",
      },
    ],
    timeline: [
      {
        at: "T0",
        event: "turn-settled",
        detail: "interrupted",
        step: "work",
        session: "main-0.1:work",
        sessionName: "main, iteration 1",
      },
    ],
    actionOffers: [RESUME_UNAVAILABLE_OFFER, DELETE_OFFER],
  });
  const { t, renderer } = await mountWorkbench(run, 100, 40, okActions());
  // Header: resting prose beside the state word (story 38, AC4).
  const header = t.captureCharFrame();
  // Everyday rows carry neither the recorded Session name nor its availability
  // (#289 story 84); the Session divider names the conversation in plain words.
  const everyday = timelineLines(header).join("\n");
  assert.match(everyday, /Conversation · main, iteration 1/);
  assert.doesNotMatch(everyday, /\b(?:open|detached|unusable)\b/);
  assert.doesNotMatch(everyday, /main-0\.1|session/);
  assert.match(header, /Execution stopped outside the Workflow\./);
  // Rail: resume is truthfully unavailable, not hidden (story 40); delete is off it.
  assert.match(header, /resume — unavailable · .*no longer usable/);
  assert.doesNotMatch(header, /x delete/);

  await press(t, renderer, "d");
  const panel = t.captureCharFrame();
  assert.match(panel, /Recovery:/);
  assert.match(
    panel,
    /Resting reason · Execution stopped outside the Workflow\./,
  );
  assert.match(panel, /Latest activity · turn-settled interrupted · T0/);
  // Session availability stays in the panel, under the plain name (#289 story 85).
  assert.match(panel, /Session main, iteration 1 · unusable/);
  // Nothing invented when absent (story 36, AC2): no conflict line here.
  assert.doesNotMatch(panel, /Materialization conflict/);
  assert.match(panel, /x delete — remove the Run/);
  noOverflow(panel, 100);

  // The relocated delete keeps its confirm-armed behaviour (story 37, AC3).
  await press(t, renderer, "x");
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "escape"); // Esc backs out without dispatching
  assert.doesNotMatch(t.captureCharFrame(), /Delete is permanent/);
});

test("an unavailable resume is not dispatchable — r does nothing (#194 story 40)", async () => {
  let dispatched = false;
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_UNAVAILABLE_OFFER] }),
    100,
    40,
    okActions({
      resume: () => {
        dispatched = true;
        return () => ({ kind: "ok" });
      },
    }),
  );
  await press(t, renderer, "r");
  assert.equal(dispatched, false);
  assert.match(t.captureCharFrame(), /resume — unavailable/);
});

test("an indeterminate-Command resume arms an acknowledgement before it dispatches (#194 story 39)", async () => {
  let received = false;
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_ACK_OFFER] }),
    100,
    40,
    okActions({
      resume: () => {
        received = true;
        return () => ({ kind: "ok" });
      },
    }),
  );
  // `r` arms the acknowledgement of repeatable effects and does not dispatch yet.
  await press(t, renderer, "r");
  assert.equal(received, false);
  const armed = t.captureCharFrame();
  assert.match(armed, /Resuming may repeat this Step's effects/);
  assert.match(armed, /y to acknowledge and resume/);
  // Esc backs out without resuming.
  await press(t, renderer, "escape");
  assert.equal(received, false);
  assert.doesNotMatch(t.captureCharFrame(), /y to acknowledge/);
  // Arm again and confirm: `y` acknowledges and dispatches the resume.
  await press(t, renderer, "r");
  await press(t, renderer, "y");
  assert.equal(received, true);
});

test("the indeterminate Attempt shows as recovery evidence in the panel (#194 story 36/39)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_ACK_OFFER] }),
    100,
    40,
    okActions(),
  );
  await press(t, renderer, "d");
  assert.match(
    t.captureCharFrame(),
    /Indeterminate Attempt · the interrupted command may have already run/,
  );
});

test("every terminal resting state carries its prose beside the state word (#194 story 38)", async () => {
  for (const [state, prose] of [
    ["succeeded", "Workflow completed."],
    ["failed", "This Run has ended."],
    ["cancelled", "You cancelled this Run."],
    ["halted", "Execution stopped outside the Workflow."],
  ] as const) {
    const { t } = await mountWorkbench(runOf({ state }), 100, 30);
    assert.match(
      t.captureCharFrame(),
      new RegExp(prose.replace(/[.]/g, "\\.")),
      `resting prose for ${state}`,
    );
  }
});

// --- interactive-agent turn-taking (#122) ----------------------------------

const SEND_OFFER: SendInteractiveTurnOffer = {
  action: "send-interactive-turn",
  runId: "run-1",
  stepId: "discuss",
  basis: "interactive Turn",
  consequence: "send the typed text as one human Turn in the Step's Session.",
};
const END_OFFER: EndInteractiveStepOffer = {
  action: "end-interactive-step",
  runId: "run-1",
  stepId: "discuss",
  consequence: "end the interactive Step succeeded and advance the Run.",
};

/** A Run blocked at an interactive-agent Step at a Turn boundary (send + end
 *  offered). Omit the offers via `actionOffers: []` to model a live Turn. */
function interactiveRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "blocked",
    progress: [{ id: "discuss", kind: "interactive-agent", status: "running" }],
    position: 0,
    actionOffers: [SEND_OFFER, END_OFFER],
    ...over,
  });
}

// --- Answer requests, gates, interrupt, and resume (#121) ------------------

/** A live overlay carrying one outstanding approval request and its answer Offer,
 *  both at `generation`. Answering targets the exact requestId/generation. */
function requestOverlay(generation = 3, requestId = "req-1"): RunLiveOverlay {
  return {
    runId: "run-1",
    generation,
    phase: "awaiting-approval",
    outstanding: [
      {
        requestId,
        tool: "Edit",
        input: '{"path":"src/fix.ts"}',
        decisions: ["allow", "deny"],
      },
    ],
    offers: [
      {
        action: "answer-harness-request",
        runId: "run-1",
        requestId,
        generation,
        decisions: ["allow", "deny"],
        basis: "ephemeral Harness Request",
      },
    ],
  };
}

/** A running Run whose Turn is live: it offers interrupt and (unavailable) steer,
 *  and cancel, exactly as the Application offers while a Turn runs (#118). */
const INTERRUPT_OFFER = {
  action: "interrupt-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  consequence:
    "stop the live Turn; the agent then waits for your next message in the same Session.",
};
const STEER_OFFER = {
  action: "steer-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  available: false as const,
  reason: "Claude Code has no same-Turn steer",
};

function liveTurnRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "running",
    progress: [{ id: "repair", kind: "agent", status: "running" }],
    actionOffers: [INTERRUPT_OFFER, STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("the interactive input takes the human's text and Enter sends one Turn (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  // Focus is on the native field during the Step; the human's text rides the mock
  // input, while Enter to send comes over the Port dispatcher (D9).
  await type(wb.t, "hi");
  assert.match(wb.t.captureCharFrame(), /> hi/);

  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "hi" },
  ]);
});

test("a blank interactive Turn is not sent (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  // Enter with an empty draft sends nothing; a whitespace-only draft is the same.
  await press(wb.t, wb.renderer, "return");
  await press(wb.t, wb.renderer, "space");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 0);
});

test("End Step arms a confirmation and dispatches on y (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.ends, [{ runId: "run-1", stepId: "discuss" }]);
});

test("Escape backs out of an armed End Step without dispatching (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(wb.control.ends.length, 0);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
});

test("End Step armed blurs the field so the confirming y never types, and dropping the arm refocuses it (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "hi");
  await press(wb.t, wb.renderer, "e", { ctrl: true }); // arm End Step → field blurs
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  // While armed the field is blurred: a keystroke (the confirming `y` included) does not
  // type — the draft is unchanged. `y` over the Port confirms; it is never text.
  await type(wb.t, "y");
  assert.match(wb.t.captureCharFrame(), /> hi/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /> hiy/);
  // Esc drops the arm; the field refocuses and accepts text again.
  await press(wb.t, wb.renderer, "escape");
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> hi!/);
});

test("the armed End Step confirms on y over the Port and no y lands in the field (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  await press(wb.t, wb.renderer, "y"); // confirm through the Port dispatcher
  assert.deepEqual(wb.control.ends, [{ runId: "run-1", stepId: "discuss" }]);
});

test("the interactive field is blurred until the send is admitted so no key types (D9, #290)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "hi");
  await press(wb.t, wb.renderer, "return"); // send → outcome pending → field blurs
  assert.match(wb.t.captureCharFrame(), /… sending…/); // the pre-admission hint
  await type(wb.t, "X"); // the field is blurred, so this does not land
  assert.match(wb.t.captureCharFrame(), /> hi/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /> hiX/);
});

test("End Step is not offered mid-Turn (#122)", async () => {
  // A live Turn offers its interrupt, not send/end: End Step cannot arm and Enter
  // sends nothing, so the human waits (or interrupts) rather than ending mid-Turn.
  const wb = await mountWorkbench(liveInteractiveRunOf());
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /◆ The agent is working/);
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.equal(wb.control.ends.length, 0);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "a");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 0);
});

// --- human-controlled Repeat Continue (#217) -------------------------------

const CONTINUE_OFFER: ContinueRepeatOffer = {
  action: "continue-repeat",
  runId: "run-1",
  stepId: "discuss",
  consequence:
    "this does not close the ticket; a fresh Session reads the tracker again and may choose it while it is still open.",
};

test("Continue replaces End Step in a human-controlled Repeat: ^N arms a confirmation that says no ticket is closed, and y dispatches (#217)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, CONTINUE_OFFER] }),
  );
  assert.match(wb.t.captureCharFrame(), /enter send Turn · \^N continue/);
  // End Step is not offered here, so ^E arms nothing.
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "n", { ctrl: true });
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /y continue · esc keep/);
  assert.match(armed, /this does not close the ticket/);
  // The arm blurs the field, so the confirming y is never text.
  await type(wb.t, "y");
  assert.doesNotMatch(wb.t.captureCharFrame(), /> drafty/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.continues, [
    { runId: "run-1", stepId: "discuss" },
  ]);
  assert.equal(wb.control.ends.length, 0);
});

test("Escape backs out of an armed Continue, and Continue cannot arm mid-Turn (#217)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, CONTINUE_OFFER] }),
  );
  await press(wb.t, wb.renderer, "n", { ctrl: true });
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /y continue/);
  assert.equal(wb.control.continues.length, 0);

  const live = await mountWorkbench(liveInteractiveRunOf());
  await press(live.t, live.renderer, "n", { ctrl: true });
  assert.doesNotMatch(live.t.captureCharFrame(), /y continue/);
  await press(live.t, live.renderer, "y");
  assert.equal(live.control.continues.length, 0);
});

// --- human-controlled Repeat End Stage (#218) ------------------------------

const END_STAGE_OFFER: EndStageOffer = {
  action: "end-stage",
  runId: "run-1",
  stepId: "discuss",
  consequence:
    "Secant has not checked the tracker. This ends the stage as complete; use it only after you and the agent verified the tickets are done.",
};

test("^E arms End Stage beside Continue with a confirm saying the tracker is unchecked; esc declines keeping focus and the draft; y dispatches End Stage only (#218)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({
      actionOffers: [SEND_OFFER, CONTINUE_OFFER, END_STAGE_OFFER],
    }),
  );
  assert.match(
    wb.t.captureCharFrame(),
    /enter send Turn · \^N continue · \^E end stage/,
  );
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /y end stage · esc keep — Secant has not checked the/);
  assert.doesNotMatch(armed, /End this interactive Step\?/);
  // Declined: nothing dispatches, and the field keeps its draft and focus.
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /y end stage/);
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> draft!/);
  assert.equal(wb.control.endStages.length, 0);
  // Confirmed: the arm blurs the field, so y never types, and only End Stage goes.
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  await type(wb.t, "y");
  assert.doesNotMatch(wb.t.captureCharFrame(), /> draft!y/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.endStages, [
    { runId: "run-1", stepId: "discuss" },
  ]);
  assert.equal(wb.control.continues.length, 0);
  assert.equal(wb.control.ends.length, 0);
});

test("End Stage cannot arm mid-Turn (#218)", async () => {
  const live = await mountWorkbench(liveInteractiveRunOf());
  await press(live.t, live.renderer, "e", { ctrl: true });
  assert.doesNotMatch(live.t.captureCharFrame(), /y end stage/);
  await press(live.t, live.renderer, "y");
  assert.equal(live.control.endStages.length, 0);
});

test("a human-declared completion says the tracker was not checked, apart from a verified one (#218)", async () => {
  const declared = await mountWorkbench(
    runOf({ state: "succeeded", completion: "human-declared" }),
  );
  assert.match(
    declared.t.captureCharFrame(),
    /You declared the stage complete; Secant did not check the tracker\./,
  );
  const verified = await mountWorkbench(runOf({ state: "succeeded" }));
  assert.match(verified.t.captureCharFrame(), /Workflow completed\./);
  assert.doesNotMatch(verified.t.captureCharFrame(), /did not check/);
});

// --- live interactive Turn interrupt (#219) --------------------------------

/** A human Turn is live in the interactive Step: the Run reads `running`, the
 *  boundary offers are gone, and the live-Turn interrupt (and steer) are offered. */
function liveInteractiveRunOf(over: Partial<RunView> = {}): RunView {
  return interactiveRunOf({
    state: "running",
    actionOffers: [INTERRUPT_OFFER, STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("a live interactive Turn shows its Interrupt and two Esc presses dispatch it (#219)", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  await type(wb.t, "next");
  const frame = wb.t.captureCharFrame();
  // The agent holds the Turn, so the label says it is working, never the human's move.
  assert.match(frame, /◆ The agent is working/);
  assert.doesNotMatch(frame, /Your move|Your Turn/);
  assert.match(frame, /esc esc interrupt/);

  await press(wb.t, wb.renderer, "escape"); // arm, never leave
  assert.equal(interrupted, undefined);
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /Press esc again to interrupt/);
  assert.match(armed, /Timeline/);
  assert.match(armed, /> next/); // the draft survives the arm

  await press(wb.t, wb.renderer, "escape"); // dispatch
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
  assert.match(wb.t.captureCharFrame(), /Timeline/);
  assert.equal(wb.control.sends.length, 0);
});

test("any other key cancels an armed interactive Interrupt and still types (#219)", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Press esc again/);
  // One real keypress reaches both the Port dispatcher (which disarms) and the
  // focused field (which types it); the test drives each path.
  wb.renderer.key("a");
  await type(wb.t, "a");
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /Press esc again/);
  assert.match(frame, /> a/);
  assert.equal(interrupted, 0);
  // Disarmed, the next Esc arms again rather than dispatching.
  await press(wb.t, wb.renderer, "escape");
  assert.equal(interrupted, 0);
});

test("Ctrl+E disarms an armed interactive Interrupt, so one more Esc only re-arms (#219)", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(interrupted, 0);
  assert.match(wb.t.captureCharFrame(), /Press esc again/);
});

test("a request during a live interactive Turn owns Esc before the Interrupt (#219)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, okActions());
  wb.control.setLive(requestOverlay());
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /esc esc interrupt/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(wb.control.requests[0]?.decision, "deny");
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again to interrupt/);
});

test("an interrupted interactive Turn returns to the same Step's input, not a halted Run (#219, #353)", async () => {
  const control = makeRunView(snapshotOf(liveInteractiveRunOf()));
  const renderer = makeFakeRenderer(100, 40);
  const actions = okActions({
    interrupt: () => {
      control.setRun(
        interactiveRunOf({
          timeline: [
            { at: "T1", event: "turn-settled", detail: "interrupted" },
          ],
        }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "escape");
  await press(t, renderer, "escape");
  const back = t.captureCharFrame();
  assert.match(back, /BLOCKED · interactive Turn/);
  assert.match(back, /◇ Your move/);
  assert.match(back, /enter send Turn/);
  assert.doesNotMatch(back, /HALTED|r resume|The agent is working/);
});

test("the live interactive Interrupt reads without colour and fits a small terminal (#219)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 40, 16, okActions());
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /esc esc interrupt/);
  noOverflow(frame, 40);
  await press(wb.t, wb.renderer, "escape");
  frame = wb.t.captureCharFrame();
  assert.match(frame, /⚠ Press esc again/);
  noOverflow(frame, 40);
});

test("who holds the Turn reads in words and glyphs at any width and across a resize (#290)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 24, okActions());
  let frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /◆ The agent is working — wait for its reply or interrupt it/,
  );
  noOverflow(frame, 100);

  // Clipped narrow, the working label still names the agent before its ellipsis;
  // its glyph and words differ from the human's move, so colour is never the signal.
  wb.renderer.resize(40, 16);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /◆ The agent is working/);
  noOverflow(frame, 40);

  // The Turn ends: the Run is back at the boundary, and the label hands the move over.
  wb.control.setRun(interactiveRunOf());
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /◇ Your move/);
  noOverflow(wb.t.captureCharFrame(), 40);
  wb.renderer.resize(100, 24);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /◇ Your move — the agent is waiting for your next Turn/);
  assert.doesNotMatch(frame, /The agent is working/);
  noOverflow(frame, 100);
});

// --- working scanner (#292) ------------------------------------------------

/** The scanner's eight cells on a frame's working line (the Workbench's one-column
 *  margin, then the row's two-space indent), or undefined when none shows. */
function scannerOf(frame: string): string | undefined {
  return /^ {3}([■⬝]{8}) /m.exec(frame)?.[1];
}

test("a live interactive Turn leads its interrupt hint with a moving scanner beside the working words (#292)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, okActions());
  const frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /◆ The agent is working — wait for its reply or interrupt it/,
  );
  assert.match(frame, /^ {3}[■⬝]{8} esc esc interrupt — stop the live Turn/m);
  // It moves on its own 40 ms clock: a later frame shows the cells changed.
  const first = scannerOf(frame);
  await until(() => {
    const next = scannerOf(wb.t.captureCharFrame());
    return next !== undefined && next !== first;
  });
  // The field keeps the keys while it moves, and the armed Esc replaces its line.
  await type(wb.t, "next");
  assert.match(wb.t.captureCharFrame(), /> next/);
  await press(wb.t, wb.renderer, "escape");
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /⚠ Press esc again to interrupt/);
  assert.equal(scannerOf(armed), undefined);
  assert.match(armed, /◆ The agent is working/);
});

test("an Agent-step live Turn leads the rail's interrupt row with the scanner and the word working (#292)", async () => {
  const wb = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  const frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /^ {3}[■⬝]{8} working · esc esc interrupt — stop the live Turn/m,
  );
  assert.equal(frame.match(/[■⬝]{8}/g)?.length, 1);
  const first = scannerOf(frame);
  await until(() => {
    const next = scannerOf(wb.t.captureCharFrame());
    return next !== undefined && next !== first;
  });
  // Arming keeps the working row and adds the confirm beneath it.
  await press(wb.t, wb.renderer, "escape");
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /working · esc esc interrupt/);
  assert.match(armed, /⚠ Press esc again to interrupt/);
});

test("the scanner stops when the Turn ends, leaving the boundary's words (#292)", async () => {
  const interactive = await mountWorkbench(
    liveInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  assert.notEqual(scannerOf(interactive.t.captureCharFrame()), undefined);
  interactive.control.setRun(interactiveRunOf());
  await interactive.t.renderOnce();
  let frame = interactive.t.captureCharFrame();
  assert.doesNotMatch(frame, /[■⬝]|\[⋯\]/);
  assert.match(frame, /◇ Your move/);
  assert.match(frame, /enter send Turn/);

  const agent = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  assert.notEqual(scannerOf(agent.t.captureCharFrame()), undefined);
  agent.control.setRun(
    liveTurnRunOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
  );
  await agent.t.renderOnce();
  frame = agent.t.captureCharFrame();
  assert.doesNotMatch(frame, /[■⬝]|\[⋯\]|working ·/);
  assert.match(frame, /r resume/);
});

test("with reduced motion the scanner is a static [⋯] and the working words stay (#292)", async () => {
  const interactive = await mountWorkbench(
    liveInteractiveRunOf(),
    100,
    40,
    okActions(),
    true,
  );
  let frame = interactive.t.captureCharFrame();
  assert.match(frame, /◆ The agent is working/);
  assert.match(frame, /^ {3}\[⋯\] esc esc interrupt — stop the live Turn/m);
  assert.doesNotMatch(frame, /[■⬝]/);

  const agent = await mountWorkbench(
    liveTurnRunOf(),
    40,
    16,
    okActions(),
    true,
  );
  frame = agent.t.captureCharFrame();
  assert.match(frame, /^ {3}\[⋯\] working · esc esc interrupt/m);
  assert.doesNotMatch(frame, /[■⬝]/);
  noOverflow(frame, 40);
  agent.control.setRun(
    liveTurnRunOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
  );
  await agent.t.renderOnce();
  assert.doesNotMatch(agent.t.captureCharFrame(), /\[⋯\]/);
});

test("a request owns the bottom region, so no scanner shows while the agent waits on the human (#292)", async () => {
  const interactive = await mountWorkbench(
    liveInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  interactive.control.setLive(requestOverlay());
  await interactive.t.renderOnce();
  assert.doesNotMatch(interactive.t.captureCharFrame(), /[■⬝]/);

  const agent = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  agent.control.setLive(requestOverlay());
  await agent.t.renderOnce();
  assert.doesNotMatch(agent.t.captureCharFrame(), /[■⬝]|working ·/);
});

test("the scanner and its words fit a small terminal, long history, and a resize (#292)", async () => {
  const agent = await mountWorkbench(
    liveTurnRunOf({ timeline: wrappingEvents(200) }),
    40,
    16,
    okActions(),
  );
  // At 40 columns the rail's words and the cells do not both fit, so the cells
  // yield and the words stay whole: meaning never rides on the scanner.
  let frame = agent.t.captureCharFrame();
  assert.match(frame, /^ {3}working · esc esc interrupt — /m);
  assert.doesNotMatch(frame, /[■⬝]/);
  noOverflow(frame, 40);

  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 24, okActions());
  wb.renderer.resize(40, 16);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /^ {3}[■⬝]{8} esc esc interrupt — /m);
  assert.match(frame, /◆ The agent is working/);
  noOverflow(frame, 40);
  wb.renderer.resize(100, 24);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /^ {3}[■⬝]{8} esc esc interrupt — stop the live Turn/m);
  noOverflow(frame, 100);
});

// --- working scanner colours and narrow rows (#308) -------------------------

// The scanner's drawing is a private leaf, so its colours are asserted against the
// Workbench's own colours rather than the theme it is handed: below 80 columns the
// compact header draws a running Run in the accent the trail derives from, and the
// full header's position line is in the muted colour.

type TRendered = Awaited<ReturnType<typeof mountWorkbench>>["t"];

const rgb = (color: { r: number; g: number; b: number }) =>
  [color.r, color.g, color.b].map((v) => Math.round(v * 255)).join(",");

/** The styled spans of the rail's working row, the line naming `working ·`. */
function railSpans(t: TRendered) {
  const line = t
    .captureSpans()
    .lines.find((candidate) =>
      candidate.spans.some((span) => span.text.includes("working ·")),
    );
  assert.ok(line, "no working row");
  return line.spans;
}

/** The colour of the first span whose own text matches `text`. */
function colorOf(spans: ReturnType<typeof railSpans>, text: RegExp): string {
  const span = spans.find((candidate) => text.test(candidate.text));
  assert.ok(span, `no span matching ${String(text)}`);
  return rgb(span.fg);
}

/** The colour of the first span anywhere in the frame whose text matches `text`. */
function frameColorOf(t: TRendered, text: RegExp): string {
  return colorOf(
    t.captureSpans().lines.flatMap((line) => line.spans),
    text,
  );
}

/** Each scanner cell on the working row, in order, with the colour it draws in. */
function scannerCells(t: TRendered) {
  return railSpans(t).flatMap((span) =>
    [...span.text]
      .filter((glyph) => glyph === "■" || glyph === "⬝")
      .map((glyph) => ({ glyph, color: rgb(span.fg) })),
  );
}

/** The frame line holding the rail's working row, trailing blanks trimmed. */
function workingLine(frame: string): string {
  const line = frame
    .split("\n")
    .find((candidate) => candidate.includes("working ·"));
  assert.ok(line !== undefined, "no working row");
  return line.trimEnd();
}

test("the scanner's lead draws in the running accent, its trail and inactive cells dimmer, its words apart (#292, #308)", async () => {
  const wb = await mountWorkbench(liveTurnRunOf(), 60, 24, okActions());
  const accent = frameColorOf(wb.t, /— RUNNING ·/);
  // Over half the cycle lights no cell, so wait for a frame whose lead and at
  // least one trail step are lit; a cycle is 2.16 s, inside the budget.
  let cells = scannerCells(wb.t);
  const lit = () => cells.filter((cell) => cell.glyph === "■");
  await until(() => {
    cells = scannerCells(wb.t);
    const colors = lit().map((cell) => cell.color);
    return colors.includes(accent) && new Set(colors).size >= 2;
  }, 3000);
  assert.equal(cells.length, 8);
  // One lead in the accent itself; every other lit step and every inactive cell
  // falls off from it, so the trail reads as a sweep, not a flat bar.
  assert.equal(lit().filter((cell) => cell.color === accent).length, 1);
  for (const cell of cells.filter((cell) => cell.glyph === "⬝"))
    assert.notEqual(cell.color, accent);
  assert.notEqual(colorOf(railSpans(wb.t), /working ·/), accent);
});

test("with reduced motion the static [⋯] draws in the muted colour, apart from the rail's words (#292, #308)", async () => {
  const wb = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions(), true);
  const muted = frameColorOf(wb.t, /^step 1 of 1$/);
  const spans = railSpans(wb.t);
  assert.equal(colorOf(spans, /^\[⋯\]$/), muted);
  assert.notEqual(colorOf(spans, /working ·/), muted);
  // The mark replaces the cells rather than leading them.
  const frame = wb.t.captureCharFrame();
  assert.match(workingLine(frame), /^ {3}\[⋯\] working · esc esc interrupt — /);
  assert.doesNotMatch(frame, /[■⬝]/);
});

test("on a narrow row the detail clips first, then the mark yields so the interrupt words stay whole (#292, #308)", async () => {
  // The rail row is 38 columns inside a 40-column terminal's one-column margins:
  // indent, eight cells, a space, the 27-column words, and the clip's ellipsis is
  // 39, so the next column up is the last width the cells keep.
  const wb = await mountWorkbench(liveTurnRunOf(), 41, 16, okActions());
  const line = () => workingLine(wb.t.captureCharFrame());
  // Exact, not just within width: a one-column overrun would wrap the ellipsis.
  assert.match(line(), /^ {3}[■⬝]{8} working · esc esc interrupt…$/);
  wb.renderer.resize(40, 16);
  await wb.t.renderOnce();
  assert.equal(line(), "   working · esc esc interrupt — stop …");
  wb.renderer.resize(41, 16);
  await wb.t.renderOnce();
  assert.match(line(), /^ {3}[■⬝]{8} working · esc esc interrupt…$/);

  // The static mark is narrower, so it holds on at widths the cells cannot.
  const reduced = await mountWorkbench(
    liveTurnRunOf(),
    40,
    16,
    okActions(),
    true,
  );
  assert.equal(
    workingLine(reduced.t.captureCharFrame()),
    "   [⋯] working · esc esc interrupt — s…",
  );
});

test("an applied send clears the draft at Turn admission with no sending state while the agent works (#290)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 100, 40, okActions());
  await type(wb.t, "hi there");
  await press(wb.t, wb.renderer, "return");
  // Between Enter and admission the field is blurred under a short pending hint.
  assert.match(wb.t.captureCharFrame(), /… sending…/);
  assert.match(wb.t.captureCharFrame(), /> hi there/);

  // Admission: the Run push carries the live Turn first, then the send settles applied.
  wb.control.setRun(liveInteractiveRunOf());
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /◆ The agent is working/);
  wb.control.setInteractiveOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  let frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /hi there/); // the draft went with the admitted Turn
  assert.doesNotMatch(frame, /sending/); // nothing lingers for the Turn's length
  assert.match(frame, /◆ The agent is working/);
  assert.match(frame, /esc esc interrupt/);

  // The field is live again during the Turn, so the next Turn can be drafted...
  await type(wb.t, "next");
  assert.match(wb.t.captureCharFrame(), /> next/);
  // ...and when the Turn ends the move returns to the human with that draft intact.
  wb.control.setRun(interactiveRunOf());
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /◇ Your move/);
  assert.match(frame, /enter send Turn/);
  assert.match(frame, /> next/);
  assert.equal(wb.control.sends.length, 1);
});

test("at a Turn boundary the interactive Esc still leaves the Workbench (#219)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Secant/);
});

test("a draft longer than a narrow input stays in bounds and clears at admission (#290)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 48, 24, okActions());
  const long = "draft ".repeat(40).trim(); // far wider than the 48-column input
  await type(wb.t, long);
  noOverflow(wb.t.captureCharFrame(), 48);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: long },
  ]);

  wb.control.setRun(liveInteractiveRunOf());
  wb.control.setInteractiveOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /draft/);
  assert.doesNotMatch(frame, /sending/);
  assert.match(frame, /◆ The agent is working/);
  noOverflow(frame, 48);
});

test("a refused send surfaces the refusal and keeps the typed draft (#122, A9, #290)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 48, 24);
  await type(wb.t, "hi");
  await press(wb.t, wb.renderer, "return");
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "interactive-turn-not-admitted",
      explanation:
        "Run run-1 did not admit the interactive Turn; the text was not sent to the agent.",
      remediation: "send it again",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  // The reason is said in words, clipped to the width rather than overflowing it.
  assert.match(frame, /✗ Run run-1 did not admit the/);
  noOverflow(frame, 48);
  // The refusal re-enables the field with the draft intact (A9), no sending state
  // lingers, and the move stays the human's since no Turn was admitted.
  assert.match(frame, /> hi/);
  assert.doesNotMatch(frame, /sending/);
  assert.match(frame, /◇ Your move/);
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> hi!/);
});

test("a reserved-word refusal keeps the draft and focus through small terminals and resize (#358, #23)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 100, 24);
  assert.match(wb.t.captureCharFrame(), /enter send Turn/);
  await type(wb.t, "/clear");
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "/clear" },
  ]);
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "harness-input-reserved",
      explanation:
        "/clear is reserved by Claude Code; Secant owns the conversation, Model choice, or permission change it requests.",
      remediation:
        "Use Secant's controls for these changes, or send text with a different first word.",
      possibleEffects: "none",
    },
  });
  for (const width of [100, 48, 60, 140]) {
    wb.renderer.resize(width, 24);
    wb.t.resize(width, 24);
    await wb.t.renderOnce();
    const frame = wb.t.captureCharFrame();
    assert.match(frame, /✗ \/clear is reserved by Claude Code/);
    assert.match(frame, /> \/clear/);
    assert.match(frame, /◇ Your move/);
    assert.doesNotMatch(frame, /sending/);
    noOverflow(frame, width);
  }
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> \/clear!/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends[1], {
    runId: "run-1",
    stepId: "discuss",
    text: "/clear!",
  });
});

test("the interactive input reads without colour and fits a narrow terminal (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 48, 24);
  const frame = wb.t.captureCharFrame();
  // The Step and its controls read from glyphs and words, not colour.
  assert.match(frame, /BLOCKED · interactive Turn/);
  assert.match(frame, /◇ Your move/);
  assert.match(frame, /enter send Turn · \^E end step/);
  noOverflow(frame, 48);
});

test("the corrected INTERACTIVE_HEIGHT reclaims one timeline row at a fixed height (A33) with reported metadata (#418)", async () => {
  // #418 reserves two metadata slots, so height 26 retains the predecessor's
  // 15-row viewport. An input that reserves 4 instead of 3 rows still evicts e0.
  // Keep both oldest/newest assertions to detect the original A33 defect.
  const wb = await mountWorkbench(
    interactiveRunOf({ timeline: events(15) }),
    100,
    26,
  );
  const frame = wb.t.captureCharFrame();
  assert.match(frame, / e0 /); // the reclaimed row: the oldest event is visible
  assert.match(frame, / e14/); // the newest event still sits at the live edge
  noOverflow(frame, 100);
});

test("the corrected CHECKPOINT_HEIGHT reclaims one timeline row at a fixed height (A33) with reported metadata (#418)", async () => {
  // The same two metadata slots leave 10 history rows at height 26. A checkpoint
  // that reserves 8 instead of 7 rows still evicts e0, preserving A33 coverage.
  const wb = await mountWorkbench(
    blockedRunOf({ timeline: events(10) }),
    100,
    26,
  );
  const frame = wb.t.captureCharFrame();
  assert.match(frame, / e0 /); // the reclaimed row: the oldest event is visible
  assert.match(frame, / e9/); // the newest event still sits at the live edge
  noOverflow(frame, 100);
});

const FREE_TEXT_GATE: RunGateReference = {
  runId: "run-1",
  stepId: "ask",
  attemptId: "a1",
  shape: "free-text",
};
const FREE_TEXT_OFFER: AnswerHumanGateOffer = {
  action: "answer-human-gate",
  gate: FREE_TEXT_GATE,
  basis: "durable Human Gate",
  continueConsequence: "",
  stopConsequence: "",
  textConsequence: "publish the text as the gate's output and advance the Run.",
};
function freeTextRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "blocked",
    progress: [{ id: "ask", kind: "human-gate", status: "blocked" }],
    pendingGate: {
      gate: FREE_TEXT_GATE,
      message: "What is the ticket number?",
      outputArtifactName: "ticket",
    },
    actionOffers: [FREE_TEXT_OFFER],
    ...over,
  });
}

// Mount a running Run and put an outstanding request on the live overlay.
async function mountWithRequest(overlay: RunLiveOverlay = requestOverlay()) {
  const mounted = await mountWorkbench(runOf({ state: "running" }));
  mounted.control.setLive(overlay);
  await mounted.t.renderOnce();
  return mounted;
}

// AC1 --------------------------------------------------------------

test("an outstanding request renders the tool, input, and both decisions in place of the footer", async () => {
  const { t } = await mountWithRequest();
  const frame = t.captureCharFrame();
  assert.match(frame, /Harness Request · awaiting your approval/);
  assert.match(frame, /Tool: Edit/);
  assert.match(frame, /Input: \{"path":"src\/fix\.ts"\}/);
  assert.match(frame, /\[ Allow \]/);
  assert.match(frame, /\[ Deny \]/);
  assert.match(frame, /enter confirm · esc deny/);
  assert.doesNotMatch(frame, /d details · end latest/); // footer replaced
});

test("Enter confirms allow and dispatches answer-harness-request with the offer's id and generation", async () => {
  const { t, control, renderer } = await mountWithRequest(requestOverlay(5));
  assert.match(t.captureCharFrame(), /› \[ Allow \]/); // allow selected by default
  await press(t, renderer, "return");
  assert.equal(control.requests.length, 1);
  assert.deepEqual(control.requests[0], {
    requestId: "req-1",
    generation: 5,
    decision: "allow",
  });
});

test("→ selects deny and Enter dispatches the deny decision", async () => {
  const { t, control, renderer } = await mountWithRequest();
  await press(t, renderer, "right");
  assert.match(t.captureCharFrame(), /› \[ Deny \]/);
  await press(t, renderer, "return");
  assert.equal(control.requests[0]?.decision, "deny");
});

test("Esc denies the outstanding request", async () => {
  const { t, control, renderer } = await mountWithRequest();
  await press(t, renderer, "escape");
  assert.equal(control.requests.length, 1);
  assert.equal(control.requests[0]?.decision, "deny");
});

test("the request control vanishes when the Turn settles without an answer, and keys reach the timeline again (A8)", async () => {
  const { t, control, renderer } = await mountWithRequest();
  assert.match(t.captureCharFrame(), /Harness Request · awaiting/);
  assert.match(t.captureCharFrame(), /ephemeral Harness Request/); // the header basis
  // The Turn ends (or is interrupted/lost) and the overlay clears — the reducer drops it
  // on a `closed` update or when durable liveness leaves live-here (A8, run-view.test.ts).
  // Here the mounted view is handed the cleared overlay directly.
  control.setLive(undefined);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /awaiting your approval/); // the request control is gone
  assert.doesNotMatch(frame, /ephemeral Harness Request/); // header no longer claims it
  assert.match(frame, /d details/); // footer returned
  // Ordinary keys reach the timeline again — the modal no longer swallows them.
  await press(t, renderer, "d");
  assert.match(t.captureCharFrame(), /› Details/);
});

test("the request is never re-asked: a later overlay with no outstanding clears the control", async () => {
  const { t, control } = await mountWithRequest();
  control.setLive({
    runId: "run-1",
    generation: 4,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /awaiting your approval/);
});

// AC2 --------------------------------------------------------------

test("a stale answer is refused with the Problem inline and the current offer re-rendered", async () => {
  const { t, control, renderer } = await mountWithRequest(requestOverlay(3));
  control.setRequestOutcome({
    kind: "refused",
    problem: {
      code: "harness-request-stale",
      explanation: "The request moved on.",
      remediation: "Answer the current request.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "return");
  await t.renderOnce();
  // The generation bumped under the user; the same requestId re-renders, and the
  // precise Problem shows inline while the control stays up.
  control.setLive(requestOverlay(4));
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /refused: The request moved on/);
  assert.match(frame, /\[ Allow \]/); // the current offer is still rendered
});

test("the controls are unavailable while a request answer is pending and dispatch nothing twice", async () => {
  const { t, control, renderer } = await mountWithRequest();
  control.setRequestOutcome({ kind: "pending" });
  await press(t, renderer, "return");
  await t.renderOnce();
  assert.equal(control.requests.length, 1);
  assert.match(t.captureCharFrame(), /relaying your decision/);
  assert.match(t.captureCharFrame(), /\(unavailable\)/);
  await press(t, renderer, "return"); // a second confirm while pending dispatches nothing
  assert.equal(control.requests.length, 1);
});

// AC3: free-text gate ----------------------------------------------

test("a free-text gate shows a text input in place of the footer", async () => {
  const { t } = await mountWorkbench(freeTextRunOf());
  const frame = t.captureCharFrame();
  assert.match(frame, /Human Gate · What is the ticket number\?/);
  assert.match(frame, /Answer published as: ticket/);
  assert.match(frame, /enter submit · esc back/);
  assert.doesNotMatch(frame, /d details · end latest/); // footer replaced
});

test("typing then Enter dispatches answer-human-gate with the typed text against the gate", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  await type(t, "fix 42"); // text rides the native field via the mock input (D9)
  assert.match(t.captureCharFrame(), /> fix 42/); // field echoes the value
  await press(t, renderer, "return"); // Enter to submit comes over the Port dispatcher
  assert.equal(control.texts.length, 1);
  assert.equal(control.texts[0]?.text, "fix 42");
  assert.deepEqual(control.texts[0]?.gate, FREE_TEXT_GATE);
});

test("the free-text field takes capitals and punctuation verbatim (D9) — fails at HEAD", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  // At HEAD the hand-rolled buffer lowercased capitals and dropped shifted symbols, so
  // `ABC-1!.` arrived `abc-1!.`; the native field carries the exact text.
  await type(t, "ABC-1!.");
  assert.match(t.captureCharFrame(), /> ABC-1!\./);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "ABC-1!.");
});

test("a bracketed paste and a word delete edit the free-text field natively (D9)", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  await t.mockInput.pasteBracketedText("fix issue");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /> fix issue/); // the paste landed whole
  // Ctrl+Backspace deletes the last word — reachable only through the native field.
  t.mockInput.pressBackspace({ ctrl: true });
  await t.renderOnce();
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "fix ");
});

test("the interactive field takes capitals and punctuation verbatim (D9) — fails at HEAD", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "ABC-1!.");
  assert.match(wb.t.captureCharFrame(), /> ABC-1!\./);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "ABC-1!." },
  ]);
});

test("a capital typed as a shifted key reaches the interactive field as uppercase (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  wb.t.mockInput.pressKey("a", { shift: true });
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "A" },
  ]);
});

test("an empty free-text submission is refused locally without dispatching", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  await press(t, renderer, "return"); // nothing typed
  assert.equal(control.texts.length, 0);
  assert.match(t.captureCharFrame(), /cannot be empty/);
  // Backspace on an empty buffer stays empty and still refuses.
  await press(t, renderer, "backspace");
  await press(t, renderer, "return");
  assert.equal(control.texts.length, 0);
});

test("the free-text gate control fits small widths without overflow and reads without colour", async () => {
  const { t, renderer } = await mountWorkbench(freeTextRunOf(), 100, 30);
  noOverflow(t.captureCharFrame(), 100);
  renderer.resize(40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Human Gate/);
  assert.match(frame, /enter submit/);
});

// #213: suggested free-text gate ------------------------------------

function suggestedRunOf(): RunView {
  return freeTextRunOf({
    pendingGate: {
      gate: FREE_TEXT_GATE,
      message: "Where should the spec live?",
      outputArtifactName: "tracker",
      suggestions: ["Local", "GitHub"],
    },
  });
}

test("a suggested gate lists its suggestions beside Other, with Other chosen until the human picks (#213)", async () => {
  const { t } = await mountWorkbench(suggestedRunOf());
  const frame = t.captureCharFrame();
  assert.match(frame, /Human Gate · Where should the spec live\?/);
  assert.match(frame, /Choose: Local · GitHub · \[Other \(type\)\]/);
  assert.match(frame, /↑↓ choose or type · enter submit/);
});

test("down picks a suggestion into the field and Enter submits it as the gate's text answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await press(t, renderer, "down");
  assert.match(t.captureCharFrame(), /Choose: \[Local\] · GitHub/);
  assert.match(t.captureCharFrame(), /> Local/);
  await press(t, renderer, "down");
  assert.match(t.captureCharFrame(), /Choose: Local · \[GitHub\]/);
  await press(t, renderer, "return");
  assert.equal(control.texts.length, 1);
  assert.equal(control.texts[0]?.text, "GitHub");
  assert.deepEqual(control.texts[0]?.gate, FREE_TEXT_GATE);
});

test("up wraps to the last suggestion, and cycling back to Other restores the typed answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await type(t, "Linear");
  await press(t, renderer, "up");
  assert.match(t.captureCharFrame(), /\[GitHub\]/);
  assert.match(t.captureCharFrame(), /> GitHub/);
  await press(t, renderer, "down"); // past the last suggestion: back to Other
  assert.match(t.captureCharFrame(), /\[Other \(type\)\]/);
  assert.match(t.captureCharFrame(), /> Linear/);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "Linear");
});

test("editing a picked suggestion turns it into a typed Other answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await press(t, renderer, "down");
  await type(t, " Enterprise");
  assert.match(t.captureCharFrame(), /\[Other \(type\)\]/);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "Local Enterprise");
});

test("the suggested gate control fits small widths without overflow (#213)", async () => {
  const { t, renderer } = await mountWorkbench(suggestedRunOf(), 100, 30);
  noOverflow(t.captureCharFrame(), 100);
  renderer.resize(40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Choose:/);
  assert.match(frame, /enter submit/);
});

// AC4: interrupt, steer, resume ------------------------------------

test("Steer renders as unavailable with the exact reason and has no dispatch", async () => {
  const { t, control, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    okActions(),
  );
  assert.match(
    t.captureCharFrame(),
    /steer — unavailable · Claude Code has no same-Turn steer/,
  );
  // No key dispatches steer; the seam is never touched from the Workbench.
  await press(t, renderer, "s");
  assert.equal(control.steers.length, 0);
});

// A live Turn under a Harness that declares native steer (Codex): the Actions rail
// names the `s` key, `s` opens a compose input, and Enter sends guidance (#148).
const AVAILABLE_STEER_OFFER = {
  action: "steer-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  available: true as const,
  consequence:
    "send same-Turn guidance to the running agent without ending the Turn.",
};
function steerableRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "running",
    progress: [{ id: "repair", kind: "agent", status: "running" }],
    actionOffers: [INTERRUPT_OFFER, AVAILABLE_STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("available Steer names the `s` key; `s` opens the compose input and Enter sends the guidance (#148)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  // The Actions rail advertises the key and the consequence, readable without colour.
  assert.match(wb.t.captureCharFrame(), /s steer — send same-Turn guidance/);

  // `s` opens the compose input (the footer is replaced with the labelled field).
  await press(wb.t, wb.renderer, "s");
  assert.match(wb.t.captureCharFrame(), /Steer — guide the running Turn/);

  // The guidance rides the native field; Enter sends exactly one steer at the live turnId.
  await type(wb.t, "wrap it up");
  assert.match(wb.t.captureCharFrame(), /> wrap it up/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "wrap it up" },
  ]);
});

test("blank Steer guidance is not sent, and Esc backs out of the compose (#148)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  await press(wb.t, wb.renderer, "s");
  // Enter with an empty draft authors nothing.
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 0);
  // Esc leaves the compose; the passive footer returns and no steer was sent.
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(
    wb.t.captureCharFrame(),
    /Steer — guide the running Turn/,
  );
  assert.equal(wb.control.steers.length, 0);
});

test("a refused Steer keeps the typed guidance and surfaces the refusal (#148)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: {
      code: "steer-rejected",
      explanation: "The live Turn rejected the guidance.",
      remediation: "Steer the next live Turn.",
      possibleEffects: "none",
    },
  });
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "keep going");
  await press(wb.t, wb.renderer, "return");
  const frame = wb.t.captureCharFrame();
  // The draft survives a refusal (A9-style), and the refusal replaces the hint line.
  assert.match(frame, /> keep going/);
  assert.match(frame, /The live Turn rejected the guidance/);
});

test("reopening Steer after Escaping a still-pending send starts a clean, usable compose (#148)", async () => {
  // The default steer outcome stays `pending`, so a dispatched steer never settles.
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "first guidance");
  await press(wb.t, wb.renderer, "return"); // dispatch — now pending ("… steering…")
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "first guidance" },
  ]);
  assert.match(wb.t.captureCharFrame(), /steering/);

  // Escape out while the send is still in flight, then reopen: the reopened compose
  // must not inherit the abandoned send's pending state (which would blur the field
  // and swallow keys). Typing lands and Enter dispatches the new guidance.
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "second guidance");
  assert.match(wb.t.captureCharFrame(), /> second guidance/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers[1], {
    runId: "run-1",
    turnId: "turn-7",
    text: "second guidance",
  });
});

test("the Steer compose stays within a narrow terminal and relays out on resize (#148)", async () => {
  const { t, renderer } = await mountWorkbench(
    steerableRunOf(),
    40,
    24,
    okActions(),
  );
  await press(t, renderer, "s");
  // A long guidance draft cannot push any line past the width.
  await type(
    t,
    "please wrap up the current change and stop before touching anything else",
  );
  noOverflow(t.captureCharFrame(), 40);
  renderer.resize(80, 24);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 80);
});

// --- Steer from the interactive input (#294) -------------------------------

/** A live human Turn in the interactive Step under a Harness that declares steer. */
function steerableInteractiveRunOf(over: Partial<RunView> = {}): RunView {
  return liveInteractiveRunOf({
    actionOffers: [INTERRUPT_OFFER, AVAILABLE_STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

/** A long unavailable-steer evidence, wider than any terminal under test. */
const LONG_STEER_REASON =
  "This Harness has no same-Turn guidance frame: a further user message would queue as the next Turn, so steer is rejected unsupported and never emulated.";

test("Enter in the interactive input steers a live Turn with the draft, with no pending state (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  let frame = wb.t.captureCharFrame();
  // The hint names Enter beside the Interrupt, led by the scanner; the rail stays
  // without a Steer row, since the input carries the controls.
  assert.match(
    frame,
    /^ {3}[■⬝]{8} enter steer · esc esc interrupt — stop the live Turn/m,
  );
  assert.doesNotMatch(frame, /s steer —|Steer — guide/);

  await type(wb.t, "focus on the tests");
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "focus on the tests" },
  ]);
  assert.equal(wb.control.sends.length, 0);
  // In flight, nothing lingers: no steering hint, and a second Enter is ignored
  // rather than sending the draft again.
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /steering|sending/);
  assert.match(frame, /enter steer · esc esc interrupt/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 1);

  // Applied: the sent draft clears and the Turn keeps working.
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /focus on the tests/);
  assert.match(frame, /◆ The agent is working/);
  assert.match(frame, /enter steer · esc esc interrupt/);
});

/** The Problems Steer admission refuses a Claude Code Steer with (#359), as the
 *  Application words them. */
const CLAUDE_STEER_REFUSALS = [
  {
    text: "/clear the slate",
    shown: /✗ \/clear is reserved by Claude Code/,
    problem: {
      code: "harness-input-reserved",
      explanation:
        "/clear is reserved by Claude Code; Secant owns the conversation, Model choice, or permission change it requests.",
      remediation:
        "Use Secant's controls for these changes, or send text with a different first word.",
      possibleEffects: "none",
    },
  },
  {
    text: "/compact",
    shown: /✗ Send \/compact when the Turn ends/,
    problem: {
      code: "steer-session-command",
      explanation:
        "Send /compact when the Turn ends: Claude Code runs its commands after the Turn, not inside it.",
      remediation:
        "Wait for the Turn to end and send it as the next Turn, or Interrupt the Turn first.",
      possibleEffects: "none",
    },
  },
] as const;

test("a Claude Code Steer shows each refusal reason and keeps its draft and focus through small terminals and resize (#359, #23)", async () => {
  for (const refusal of CLAUDE_STEER_REFUSALS) {
    const wb = await mountWorkbench(
      steerableInteractiveRunOf({ selectedHarness: "claude-code" }),
      100,
      24,
      okActions(),
    );
    await type(wb.t, refusal.text);
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.steers, [
      { runId: "run-1", turnId: "turn-7", text: refusal.text },
    ]);
    wb.control.setSteerOutcome({ kind: "refused", problem: refusal.problem });
    for (const width of [100, 48, 60, 140]) {
      wb.renderer.resize(width, 24);
      wb.t.resize(width, 24);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      // The reason leads with what to do, in words and the ✗ glyph, so it
      // survives a narrow clip and reads without colour.
      assert.match(frame, refusal.shown, `${refusal.problem.code} @${width}`);
      assert.ok(frame.includes(`> ${refusal.text}`), `draft @${width}`);
      assert.match(frame, /◆ The agent is working/);
      noOverflow(frame, width);
    }
    // Focus stays in the input: typing extends the kept draft, and Enter steers
    // the edited text.
    await type(wb.t, "!");
    assert.ok(wb.t.captureCharFrame().includes(`> ${refusal.text}!`));
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.steers[1], {
      runId: "run-1",
      turnId: "turn-7",
      text: `${refusal.text}!`,
    });
  }
});

test("the Agent-step Steer compose shows a Session-command refusal and keeps the guidance (#359)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 48, 24, okActions());
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "/compact");
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "/compact" },
  ]);
  const [, sessionCommand] = CLAUDE_STEER_REFUSALS;
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: sessionCommand.problem,
  });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /Steer — guide the running Turn/);
  assert.match(frame, /> \/compact/);
  assert.match(frame, /Send \/compact when the Turn ends/);
  noOverflow(frame, 48);
});

test("text typed while an interactive Steer settles survives its applied outcome (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  await type(wb.t, "check the logs");
  await press(wb.t, wb.renderer, "return");
  // The field keeps its keys in flight, so the human can draft more guidance...
  await type(wb.t, " and then");
  assert.match(wb.t.captureCharFrame(), /> check the logs and then/);
  // ...which is theirs, not the sent Steer's, so the applied outcome leaves it.
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /> check the logs and then/);
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "check the logs" },
  ]);
});

test("a Steer still settling when its Turn ends holds back the send until it settles (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  await type(wb.t, "late guidance");
  await press(wb.t, wb.renderer, "return");
  wb.control.setRun(interactiveRunOf());
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /◇ Your move/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 0);

  // The late Steer is refused against the ended Turn: the draft stays, and Enter now
  // sends it as the next Turn.
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: {
      code: "turn-control-rejected",
      explanation: "The Turn had already ended.",
      remediation: "Send it as the next Turn.",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /✗ The Turn had already ended/);
  assert.match(frame, /> late guidance/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "late guidance" },
  ]);
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /already ended/);
});

test("a blank draft is not steered and a bare `s` types into the interactive input (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  await press(wb.t, wb.renderer, "return");
  await type(wb.t, "   ");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 0);
  assert.doesNotMatch(wb.t.captureCharFrame(), /✗/);

  // `s` is text here: it never opens the Agent step's Steer box.
  wb.renderer.key("s");
  await type(wb.t, "s");
  const frame = wb.t.captureCharFrame();
  assert.match(frame, />\s+s/);
  assert.doesNotMatch(frame, /Steer — guide the running Turn/);
});

test("a refused interactive Steer keeps the draft, and arming the Interrupt clears the refusal (#294)", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    actions,
  );
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: {
      code: "steer-rejected",
      explanation: "The live Turn rejected the guidance.",
      remediation: "Steer the next live Turn.",
      possibleEffects: "none",
    },
  });
  await type(wb.t, "keep going");
  await press(wb.t, wb.renderer, "return");
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /✗ The live Turn rejected the guidance/);
  assert.match(frame, /> keep going/);

  // The Interrupt stays reachable: the first Esc arms, clearing the refusal so the
  // confirm shows, and the second dispatches.
  await press(wb.t, wb.renderer, "escape");
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /✗/);
  assert.match(frame, /⚠ Press esc again to interrupt/);
  await press(wb.t, wb.renderer, "escape");
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
});

test("an unavailable Steer shows its reason at Enter, sends nothing, and keeps the draft (#294)", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  // Unavailable, the hint never names Enter; the reason waits for the attempt.
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /^ {3}[■⬝]{8} esc esc interrupt — stop the live Turn/m);
  assert.doesNotMatch(frame, /enter steer|unavailable/);

  await type(wb.t, "wrap up");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 0);
  assert.equal(wb.control.sends.length, 0);
  frame = wb.t.captureCharFrame();
  // The refusal line carries the Offer's reason word for word, in words and a glyph.
  assert.match(
    frame,
    /^ {3}✗ steer unavailable · Claude Code has no same-Turn steer/m,
  );
  assert.match(frame, /> wrap up/);
  assert.match(frame, /◆ The agent is working/);
  assert.equal(scannerOf(frame), undefined);

  // Esc arms the Interrupt over the reason, and the second Esc dispatches it.
  await press(wb.t, wb.renderer, "escape");
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /steer unavailable/);
  assert.match(frame, /⚠ Press esc again to interrupt/);
  await press(wb.t, wb.renderer, "escape");
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
});

test("the unavailable reason leaves when the Turn ends, and Enter then sends the kept draft (#294)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, okActions());
  await type(wb.t, "wrap up");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /steer unavailable/);

  wb.control.setRun(interactiveRunOf());
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /steer unavailable/);
  assert.match(frame, /◇ Your move/);
  assert.match(frame, /enter send Turn/);
  assert.match(frame, /> wrap up/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "wrap up" },
  ]);
});

test("a long unavailable reason clips to a small terminal and relays out on resize (#294)", async () => {
  const unsteerable = { ...STEER_OFFER, reason: LONG_STEER_REASON };
  const wb = await mountWorkbench(
    liveInteractiveRunOf({
      actionOffers: [INTERRUPT_OFFER, unsteerable, CANCEL_OFFER],
      timeline: wrappingEvents(200),
    }),
    100,
    24,
    okActions(),
  );
  await type(wb.t, "please wrap up the current change before anything else");
  await press(wb.t, wb.renderer, "return");
  let frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /✗ steer unavailable · This Harness has no same-Turn guidance frame.*…/,
  );
  noOverflow(frame, 100);

  // Narrow, the reason clips with its ellipsis; the prefix and the draft's field stay.
  wb.renderer.resize(40, 16);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /^ {3}✗ steer unavailable · This Harness[^\n]*…/m);
  assert.match(frame, /◆ The agent is working/);
  noOverflow(frame, 40);
  wb.renderer.resize(100, 24);
  await wb.t.renderOnce();
  noOverflow(wb.t.captureCharFrame(), 100);
});

test("with reduced motion the Steer cue follows a static [⋯] (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
    true,
  );
  const frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /^ {3}\[⋯\] enter steer · esc esc interrupt — stop the live Turn/m,
  );
  assert.doesNotMatch(frame, /[■⬝]/);
});

test("the Steer cue keeps its words in a small terminal, the scanner yielding first (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    24,
    okActions(),
  );
  wb.renderer.resize(40, 16);
  await wb.t.renderOnce();
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /^ {3}enter steer · esc esc interrupt/m);
  assert.doesNotMatch(frame, /[■⬝]/);
  noOverflow(frame, 40);
  wb.renderer.resize(100, 24);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /^ {3}[■⬝]{8} enter steer · esc esc interrupt — stop the live Turn/m,
  );
  noOverflow(frame, 100);
});

test("Esc from Details returns focus to the timeline during a live Turn, never arming interrupt (A7) — fails at HEAD", async () => {
  // With a live agent Turn the interrupt Offer stands, so at HEAD the two-press Esc arm
  // sat above the focused-region branches and shadowed Details' own Esc: opening Details
  // and pressing Esc armed (and a second Esc cancelled) the Turn instead of going back.
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t, renderer } = await mountWorkbench(
    liveTurnRunOf({ timeline: events(4) }),
    100,
    40,
    actions,
  );
  await press(t, renderer, "d"); // open Details; focus moves there
  const detailsFrame = t.captureCharFrame();
  assert.match(detailsFrame, /› Details/);
  assert.match(detailsFrame, /esc back/); // the footer stays honest about what Esc does
  await press(t, renderer, "escape"); // A7: back to the timeline, not an interrupt arm
  const afterEsc = t.captureCharFrame();
  assert.match(afterEsc, /› Timeline/);
  assert.doesNotMatch(afterEsc, /Press esc again to interrupt/);
  // A second Esc — now in timeline focus — only arms; it dispatches no interrupt-turn.
  await press(t, renderer, "escape");
  assert.equal(interrupted, 0);
});

test("workbench-interaction-regression: interrupt requires two Esc presses and keeps the Workbench", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const { t, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    actions,
  );
  assert.match(t.captureCharFrame(), /esc esc interrupt/); // the control is listed
  await press(t, renderer, "escape"); // arm
  assert.equal(interrupted, undefined);
  assert.match(t.captureCharFrame(), /Press esc again to interrupt/);
  await press(t, renderer, "escape"); // dispatch
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
  assert.match(t.captureCharFrame(), /Timeline/); // did not leave the Workbench
});

test("workbench-interaction-regression: request modal owns Esc before interrupt and steer controls", async () => {
  // The interrupt/steer offers stand while a Turn is live even at awaiting-approval,
  // so without the modal guard the request control and the interrupt hint collide
  // over Esc. The request modal must own the bottom interaction.
  const { t, control, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    okActions(),
  );
  control.setLive(requestOverlay());
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /awaiting your approval/);
  assert.doesNotMatch(frame, /esc esc interrupt/); // interrupt control suppressed
  assert.doesNotMatch(frame, /steer — unavailable/);
  await press(t, renderer, "escape"); // a single Esc denies, and never arms interrupt
  assert.equal(control.requests[0]?.decision, "deny");
  assert.doesNotMatch(t.captureCharFrame(), /Press esc again to interrupt/);
});

test("a request appearing disarms an already-armed interrupt so no stale hint lingers", async () => {
  const mounted = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  await press(mounted.t, mounted.renderer, "escape"); // arm interrupt, no request yet
  assert.match(mounted.t.captureCharFrame(), /Press esc again to interrupt/);
  mounted.control.setLive(requestOverlay()); // a request takes over the interaction
  await mounted.t.renderOnce();
  const frame = mounted.t.captureCharFrame();
  assert.doesNotMatch(frame, /Press esc again to interrupt/); // disarmed and hidden
  assert.match(frame, /awaiting your approval/);
});

test("any other key cancels an armed Interrupt without dispatching or leaving", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t, renderer } = await mountWorkbench(
    liveTurnRunOf({ timeline: events(4) }),
    100,
    40,
    actions,
  );
  await press(t, renderer, "escape"); // arm
  assert.match(t.captureCharFrame(), /Press esc again/);
  await press(t, renderer, "up"); // any other key cancels the arm
  assert.doesNotMatch(t.captureCharFrame(), /Press esc again/);
  assert.equal(interrupted, 0);
});

// After an Interrupt an Agent Step's Attempt stays open and the Run waits for the
// person's follow-up (#354): the bottom input becomes "Reply to the agent", mounted
// from the follow-up Offer, and hands back to the rail once that Turn is live.
const FOLLOW_UP_OFFER = {
  action: "send-follow-up-turn" as const,
  runId: "run-1",
  stepId: "repair",
  attemptId: "0.0:repair",
  turnId: "turn-7",
  basis: "interrupted Agent Turn" as const,
  consequence:
    "send the typed text to the agent as your next message in the same Session; the Step continues from that Turn.",
};

function waitingRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "blocked",
    progress: [{ id: "repair", kind: "agent", status: "blocked" }],
    timeline: [
      {
        at: "T1",
        event: "turn-settled",
        detail: "interrupted",
        turnKind: "agent",
      },
    ],
    actionOffers: [FOLLOW_UP_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("an Agent-step Interrupt hands the bottom input to the person, and Enter sends the follow-up from the compose (#354)", async () => {
  const control = makeRunView(snapshotOf(liveTurnRunOf()));
  const renderer = makeFakeRenderer(100, 40);
  const actions = okActions({
    interrupt: () => {
      // The live snapshot carries the waiting rest in, exactly as production does.
      control.setRun(waitingRunOf());
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "escape"); // arm
  await press(t, renderer, "escape"); // interrupt

  const frame = t.captureCharFrame();
  assert.match(frame, /BLOCKED · interrupted Agent Turn/);
  // Timeline mechanics: the interrupted Turn stays in history and the Step waits.
  assert.match(frame, /Agent Turn settled · interrupted/);
  assert.match(frame, /Progress: ⏸ repair/);
  assert.match(
    frame,
    /Reply to the agent — you stopped it, and it is waiting on you/,
  );
  assert.match(frame, /enter send reply · esc back/);
  // A follow-up ends no Step and resumes nothing; the Interrupt's receipt and its
  // `d` (which would type into the focused field) give way to the compose.
  assert.doesNotMatch(frame, /\^E|end step|r resume|HALTED/);
  assert.doesNotMatch(frame, /Turn interrupted · d dismiss/);
  assert.doesNotMatch(frame, /esc esc interrupt/);

  // `q`, `t`, and `d` type into the focused compose rather than fire commands.
  await type(t, "quit the docs, then test");
  await press(t, renderer, "return");
  assert.deepEqual(control.followUps, [
    { runId: "run-1", turnId: "turn-7", text: "quit the docs, then test" },
  ]);
  assert.deepEqual(control.sends, []);
  assert.match(t.captureCharFrame(), /… sending…/);

  // Admission applies the send and clears the draft; the follow-up Turn goes live and
  // the rail's Agent-step controls take over again.
  control.setInteractiveOutcome({ kind: "applied" });
  control.setRun(
    liveTurnRunOf({
      timeline: [
        {
          at: "T1",
          event: "turn-settled",
          detail: "interrupted",
          turnKind: "agent",
        },
        { at: "T2", event: "turn-started", detail: "s", turnKind: "agent" },
      ],
    }),
  );
  await t.renderOnce();
  const working = t.captureCharFrame();
  // The follow-up Turn appends below the interrupted one in the same Step.
  assert.match(working, /settled · interrupted[\s\S]*Agent Turn started/);
  assert.doesNotMatch(working, /Reply to the agent/);
  assert.match(working, /working · esc esc interrupt/);
  assert.match(working, /› Timeline/);
});

test("a refused follow-up keeps its draft, and Enter on a blank compose sends nothing (#354)", async () => {
  const wb = await mountWorkbench(waitingRunOf());
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.followUps, []);

  await type(wb.t, "try again");
  await press(wb.t, wb.renderer, "return");
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "follow-up-turn-not-waiting",
      explanation: "Run run-1 is running and is not waiting for a follow-up.",
      remediation: "Open the Run.",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /✗ Run run-1 is running and is not waiting/);
  assert.match(frame, /> try again/);
});

test("the follow-up compose keeps its draft and focus while its Attempt waits, and a new Attempt starts it empty (#354)", async () => {
  const wb = await mountWorkbench(waitingRunOf());
  await type(wb.t, "half a thought");
  // A catch-up briefly withdraws every control; the same Attempt's compose returns
  // focused with its draft.
  wb.control.setFreshness({
    kind: "catching-up",
    catchUp: "rebased",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /Reply to the agent/);
  wb.control.setFreshness({
    kind: "current",
    catchUp: "fresh",
    lastConfirmedAt: "2026-09-22T10:30:01.000Z",
  });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /> half a thought/);
  await type(wb.t, " more");
  assert.match(wb.t.captureCharFrame(), /> half a thought more/);

  // A later Attempt of the Step waits on its own Interrupt: a fresh, empty compose.
  wb.control.setRun(
    waitingRunOf({
      actionOffers: [
        { ...FOLLOW_UP_OFFER, attemptId: "0.1:repair", turnId: "turn-9" },
        CANCEL_OFFER,
      ],
    }),
  );
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /half a thought/);
});

test("the follow-up compose owns its keys as the interactive input does, and Esc leaves the Workbench (#354)", async () => {
  const wb = await mountWorkbench(waitingRunOf());
  // Ctrl+E ends no Step here and Ctrl+N continues nothing: no confirm arms.
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  await press(wb.t, wb.renderer, "n", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press y|y continue/);
  await type(wb.t, "back");
  assert.match(wb.t.captureCharFrame(), /> back/);
  await press(wb.t, wb.renderer, "escape");
  await wb.t.waitForFrame((f) => f.includes("Secant"));
});

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`the follow-up compose reads in words and fits ${width}x${height} across a resize (#354)`, async () => {
    const wb = await mountWorkbench(waitingRunOf(), width, height);
    const frame = wb.t.captureCharFrame();
    noOverflow(frame, width);
    // Meaning without colour: the state word, the basis, and who holds the Turn.
    assert.match(frame, /BLOCKED/);
    assert.match(frame, /Reply to the agent/);
    assert.match(frame, /enter send reply/);
    const other = width === 60 ? 140 : 60;
    wb.renderer.resize(other, 24);
    await wb.t.renderOnce();
    const resized = wb.t.captureCharFrame();
    noOverflow(resized, other);
    assert.match(resized, /Reply to the agent/);
  });
}

test("resume on a halted Run dispatches resume-run and live rows resume", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "halted", actionOffers: [RESUME_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let resumed = 0;
  const actions = okActions({
    resume: () => {
      resumed += 1;
      control.setRun(
        liveTurnRunOf({
          timeline: [{ at: "T0", event: "turn-started", turnKind: "agent" }],
        }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("r resume"));
  await press(t, renderer, "r");
  assert.equal(resumed, 1);
  const frame = t.captureCharFrame();
  assert.match(frame, /RUNNING/);
  assert.match(frame, /Agent Turn started/); // the resumed Turn's rows appear
});

// AC5: Esc modes + focus -------------------------------------------

test("Esc means deny in a request, interrupt-arm during a live Turn, and leave when at rest", async () => {
  // At rest with no live Turn: Esc leaves the Workbench.
  const rest = await mountWorkbench(runOf({ state: "succeeded" }));
  await press(rest.t, rest.renderer, "escape");
  assert.match(rest.t.captureCharFrame(), /Secant/); // back on Home

  // During a live Turn: Esc arms interrupt rather than leaving.
  const live = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  await press(live.t, live.renderer, "escape");
  assert.match(live.t.captureCharFrame(), /Press esc again to interrupt/);
  assert.match(live.t.captureCharFrame(), /Timeline/); // stayed

  // With an outstanding request: Esc denies (does not arm interrupt or leave).
  const req = await mountWithRequest();
  await press(req.t, req.renderer, "escape");
  assert.equal(req.control.requests[0]?.decision, "deny");
});

test("the request control fits small widths without overflow and reads without colour", async () => {
  const mounted = await mountWithRequest();
  noOverflow(mounted.t.captureCharFrame(), 100);
  mounted.renderer.resize(40, 24);
  await mounted.t.renderOnce();
  const frame = mounted.t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Allow/);
  assert.match(frame, /Deny/);
});

function steerSettlement(
  id: string,
  text: string,
  settlement: NonNullable<RunTimelineEvent["steer"]>["settlement"],
  step = "discuss",
): RunTimelineEvent {
  return {
    at: "2026-01-01T00:00:01.000Z",
    event: "steer",
    step,
    detail: `${settlement.kind === "dropped" ? "dropped by interrupt" : "delivered within Turn"} · ${text.slice(0, 30).replace(/\s+/g, " ")}`,
    steer: {
      steerId: id,
      text,
      sentAt: "2026-01-01T00:00:00.000Z",
      settlement,
    },
  };
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`Interrupt restores every undelivered interactive Steer with focus at ${width}x${height} (#356)`, async () => {
    let interrupts = 0;
    const wb = await mountWorkbench(
      steerableInteractiveRunOf(),
      width,
      height,
      okActions({
        interrupt: () => {
          interrupts += 1;
          return () => ({ kind: "ok" });
        },
      }),
    );
    await type(wb.t, "restore this guidance");
    await press(wb.t, wb.renderer, "return");
    wb.control.setSteerOutcome({ kind: "applied" });
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /> restore this guidance/);
    await type(wb.t, "my unsent draft");
    await press(wb.t, wb.renderer, "escape");
    assert.equal(interrupts, 0);
    assert.match(wb.t.captureCharFrame(), /esc again/);
    await press(wb.t, wb.renderer, "escape");
    assert.equal(interrupts, 1);
    const timeline = [
      steerSettlement("delivered", "already exposed", {
        kind: "delivered",
        delivery: "within-turn",
      }),
      steerSettlement("first", "restore this guidance", {
        kind: "dropped",
        reason: "interrupt",
      }),
      steerSettlement("second", "second guidance", {
        kind: "dropped",
        reason: "interrupt",
      }),
    ];
    wb.control.setRun(interactiveRunOf({ timeline }));
    await wb.t.renderOnce();
    const frame = wb.t.captureCharFrame();
    assert.match(frame, /draft restored/);
    assert.match(frame, /Steer.*dropped by interrupt/);
    noOverflow(frame, width);
    // Restore once, preserve the unsent draft, and send the exact full text at a boundary.
    wb.control.setRun(interactiveRunOf({ timeline }));
    wb.renderer.resize(width === 60 ? 140 : 60, 24);
    await wb.t.renderOnce();
    noOverflow(wb.t.captureCharFrame(), width === 60 ? 140 : 60);
    await press(wb.t, wb.renderer, "return");
    assert.equal(
      wb.control.sends[0]?.text,
      "restore this guidance\n\nsecond guidance\n\nmy unsent draft",
    );
    assert.doesNotMatch(wb.control.sends[0]?.text ?? "", /already exposed/);
  });
}

test("an Agent Interrupt restores a long Steer into the follow-up compose and Enter sends it as the follow-up (#356, #354)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 60, 24, okActions());
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "sent guidance");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  const text = `verbatim line\n${"long guidance ".repeat(30)}last word`;
  const timeline = [
    steerSettlement(
      "long",
      text,
      { kind: "dropped", reason: "interrupt" },
      "repair",
    ),
  ];
  wb.control.setRun(waitingRunOf({ timeline }));
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /draft restored/);
  assert.match(frame, /enter send reply/);
  assert.doesNotMatch(frame, /r resume from timeline/);
  noOverflow(frame, 60);
  // The original text survives the 160-character timeline cap, sent as the reply.
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.followUps, [
    { runId: "run-1", turnId: "turn-7", text },
  ]);
  assert.equal(wb.control.steers.length, 1);
});

test("a drop seen before the Agent Step rests restores once the follow-up is offered (#354)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 30, okActions());
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "guidance in flight");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  const timeline = [
    steerSettlement(
      "in-flight",
      "guidance in flight",
      { kind: "dropped", reason: "interrupt" },
      "repair",
    ),
  ];
  // The Turn settled, but the walk has not yet written its waiting rest.
  wb.control.setRun(steerableRunOf({ actionOffers: [CANCEL_OFFER], timeline }));
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /draft restored/);
  wb.control.setRun(waitingRunOf({ timeline }));
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /draft restored/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.followUps, [
    { runId: "run-1", turnId: "turn-7", text: "guidance in flight" },
  ]);
});

test("a signal-halted Agent Step parks no compose for Steers its Turn dropped (#354)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 30, okActions());
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "guidance that cannot be sent");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  wb.control.setRun(
    steerableRunOf({
      state: "halted",
      progress: [{ id: "repair", kind: "agent", status: "blocked" }],
      actionOffers: [RESUME_OFFER],
      timeline: [
        steerSettlement(
          "dropped",
          "guidance that cannot be sent",
          { kind: "dropped", reason: "interrupt" },
          "repair",
        ),
      ],
    }),
  );
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /draft restored/);
  assert.doesNotMatch(frame, /Steer — guide/);
  assert.match(frame, /r resume/);
});

test("settlement observed before its receipt restores only after acceptance clears the original draft (#356)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    30,
    okActions(),
  );
  await type(wb.t, "a racing draft");
  await press(wb.t, wb.renderer, "return");
  const timeline = [
    steerSettlement("racing", "a racing draft", {
      kind: "dropped",
      reason: "interrupt",
    }),
  ];
  wb.control.setRun(interactiveRunOf({ timeline }));
  await wb.t.renderOnce();
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /draft restored/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, "a racing draft");
});

test("historic drops and loss drops do not replace the compose on open or repeated snapshots (#356)", async () => {
  const old = steerSettlement("old", "old interrupt", {
    kind: "dropped",
    reason: "interrupt",
  });
  const wb = await mountWorkbench(
    steerableInteractiveRunOf({ timeline: [old] }),
    100,
    30,
    okActions(),
  );
  await type(wb.t, "my current draft");
  const loss = steerSettlement("loss", "lost turn", {
    kind: "dropped",
    reason: "loss",
  });
  wb.control.setRun(interactiveRunOf({ timeline: [old, loss] }));
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /draft restored/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, "my current draft");
});

for (const close of ["offer-ended", "escaped"] as const) {
  test(`an Agent Steer accepted after compose ${close} restores its text once into the follow-up compose (#356, #354)`, async () => {
    const wb = await mountWorkbench(steerableRunOf(), 100, 30, okActions());
    await press(wb.t, wb.renderer, "s");
    await type(wb.t, "guidance awaiting receipt");
    await press(wb.t, wb.renderer, "return");
    if (close === "escaped") await press(wb.t, wb.renderer, "escape");
    const timeline = [
      steerSettlement(
        "late-accepted",
        "guidance awaiting receipt",
        { kind: "dropped", reason: "interrupt" },
        "repair",
      ),
    ];
    wb.control.setRun(waitingRunOf({ timeline }));
    await wb.t.renderOnce();
    wb.control.setSteerOutcome({ kind: "applied" });
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /draft restored/);
    // A repeated snapshot restores nothing twice.
    wb.control.setRun(waitingRunOf({ timeline }));
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.followUps, [
      { runId: "run-1", turnId: "turn-7", text: "guidance awaiting receipt" },
    ]);
  });
}

test("[windows-cleanup-notice] the Workbench shows one informational notice across updates and resize", async () => {
  const notice =
    "Secant will use its usual Windows cleanup. Some tool processes may continue after you stop or close it.";
  const run = runOf({ windowsCleanupNotice: notice });
  const { t, control, renderer } = await mountWorkbench(run, 40, 16);
  try {
    for (const width of [40, 70, 110, 40]) {
      t.resize(width, 16);
      renderer.resize(width, 16);
      control.setRun({ ...run });
      await t.renderOnce();
      const frame = t.captureCharFrame();
      const text = frame.replace(/\s+/g, " ");
      assert.equal(text.match(/Info: Secant/g)?.length, 1);
      assert.match(
        text,
        /Secant will use its usual Windows cleanup\. Some tool processes may continue after you stop or close it\./,
      );
      assert.doesNotMatch(text, /Warning/);
      noOverflow(frame, width);
    }
  } finally {
    t.renderer.destroy();
  }
});

test("declined elicitation history shows the question and setup remediation safely", async () => {
  const { t } = await mountWorkbench(
    runOf({
      state: "succeeded",
      timeline: [
        {
          at: "T000",
          event: "elicitation-declined",
          elicitation: {
            harness: "claude-code",
            server: "setup",
            message: "Finish\u0000setup\u001b[31m now\u001b[0m",
            url: "https://example.com/setup",
          },
          detail:
            "Secant cannot show this elicitation. Finish setup in Claude Code directly before continuing.",
        },
      ],
    }),
    140,
    24,
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Elicitation declined/);
  assert.match(frame, /claude-code\/setup/);
  assert.match(frame, /Finish setup now/);
  assert.doesNotMatch(frame, /\[31m|\[0m/);
  assert.match(frame, /https:\/\/example.com\/setup/);
  assert.match(frame, /Finish setup in Claude Code directly/);
});

for (const [width, height] of [
  [60, 24],
  [140, 44],
]) {
  test(`agent completion renders pending, settled, and hostile reasons at ${width}x${height}`, async (context) => {
    let finish!: () => void;
    const boundary = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const reason = "ready\n\x1b[31mred\x1b[0m\t\x07\u202e" + "終😺 ".repeat(70);
    const { wired, runId } = await launchAgentCompletionRun(context, [
      {
        agentCalls: [call(reason)],
        block: true,
        finish: boundary,
        result: completed,
      },
    ]);
    const pending = await followRun(wired.projectionPort, runId, (run) =>
      run.pendingAgentCompletion !== undefined ? run : undefined,
    );
    const wb = await mountWorkbench(pending, width, height);
    const frame = wb.t.captureCharFrame();
    assert.match(frame, /The agent has asked to end this Step/);
    assert.match(frame, /ready red/);
    for (const control of ["\x1b", "\x07", "\u202e"])
      assert.equal(frame.includes(control), false);
    noOverflow(frame, width);
    const pendingLine = frame
      .split("\n")
      .find((line) => line.includes("The agent has asked"));
    assert.ok(pendingLine?.includes("…"));
    await press(wb.t, wb.renderer, "home");
    finish();
    const settled = await followRun(wired.projectionPort, runId, (run) =>
      run.state === "succeeded" ? run : undefined,
    );
    wb.control.setRun(settled);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "home");
    assert.match(wb.t.captureCharFrame(), /Beginning of Run history/);
    await press(wb.t, wb.renderer, "end");
    const ended = wb.t.captureCharFrame();
    assert.match(ended, /Step ended by the agent/);
    assert.match(ended, /ready red/);
    for (const control of ["\x1b", "\x07", "\u202e"])
      assert.equal(ended.includes(control), false);
    noOverflow(ended, width);
    assert.equal(
      readCompletionRun(wired, runId).timeline.find(
        (event) => event.endedBy === "agent",
      )?.reason,
      reason,
    );
    const newWidth = width === 60 ? 140 : 60;
    const newHeight = height === 24 ? 44 : 24;
    wb.t.resize(newWidth, newHeight);
    wb.renderer.resize(newWidth, newHeight);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "end");
    assert.match(wb.t.captureCharFrame(), /Step ended by the agent/);
    noOverflow(wb.t.captureCharFrame(), newWidth);
  });
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
]) {
  test(`a held agent Continue shows the checkpoint message and keeps the person's controls at ${width}x${height}`, async (context) => {
    const message = "Look over\nthe \x1b[31mtracker\x1b[0m, then Continue.";
    const { wired, runId } = await launchAgentCompletionRun(
      context,
      across(
        ["1", "2"].map((key) => ({
          agentCalls: [call(`ticket ${key} done`, key)],
          result: completed,
        })),
      ),
      reviewedLoop({ interval: 1, message }),
    );
    const held = await followRun(wired.projectionPort, runId, (run) =>
      run.heldForReview !== undefined ? run : undefined,
    );
    assert.equal(held.heldForReview?.message, message);
    const wb = await mountWorkbench(held, width, height);
    const readable = (frame: string) => frame.replace(/\s+/g, " ");
    const heldRow =
      /◆ Held for review · the agent's Continue waits for you · Look over the tracker, then Continue\./g;
    const newWidth = width === 60 ? 140 : 60;
    const newHeight = height === 24 ? 44 : 24;
    for (const [w, h] of [
      [width, height],
      [newWidth, newHeight],
      [width, height],
    ] as const) {
      wb.t.resize(w, h);
      wb.renderer.resize(w, h);
      // A re-pushed snapshot replaces the stable-key tail row, never repeats it.
      wb.control.setRun({ ...held });
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      // Meaning without colour: a glyph and words say the Continue is held, and the
      // authored message wraps at the live edge with its control bytes removed.
      assert.equal(readable(frame).match(heldRow)?.length, 1);
      // The timestamped call row clips on a narrow screen; the held row still reads.
      if (w >= 140) {
        assert.match(readable(frame), /held for review · ticket 2 done/);
        assert.match(
          readable(frame),
          /↻ Continued by the agent · ticket 1 done/,
        );
      }
      assert.equal(frame.includes("\x1b"), false);
      noOverflow(frame, w);
    }
    // The person's controls stay: Continue arms its confirmation.
    await press(wb.t, wb.renderer, "n", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /y continue/);
  });
}

test("agent stage done reads as a Stage request while pending and a Stage end once applied", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      state: "running",
      timeline: [{ at: "T000", event: "turn-started", step: "implement" }],
      pendingAgentCompletion: { call: "stage_done", reason: "no ticket left" },
    }),
    60,
    24,
  );
  assert.match(
    t.captureCharFrame(),
    /The agent has asked to end this Stage · no ticket left/,
  );
  control.setRun(
    runOf({
      state: "succeeded",
      completion: "agent-declared",
      timeline: [
        { at: "T000", event: "turn-started", step: "implement" },
        {
          at: "T001",
          event: "stage-ended",
          detail: "succeeded",
          endedBy: "agent",
          reason: "no ticket left",
          step: "implement",
        },
      ],
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /▸ Stage ended by the agent · no ticket left/);
  noOverflow(frame, 60);
});

// The Workbench Model-choice scenario (#351) runs in the canonical three-OS suite.
const MODEL_OFFER = {
  action: "change-model-choice",
  runId: "run-1",
  available: true,
  currentChoice: { model: "fast", effort: "high" },
  reach: "next-turn",
  modelDeclaration: {
    kind: "list",
    models: [
      {
        model: "fast",
        label: "Fast",
        efforts: ["medium", "high"],
        defaultEffort: "medium",
      },
      {
        model: "deep",
        label: "Deep",
        efforts: ["medium"],
        defaultEffort: "medium",
      },
    ],
  },
} as const;

test("workbench-model-choice: m opens the shared picker and submits the model and effort through Run Actions (#351)", async () => {
  const changes: unknown[] = [];
  const { t, renderer } = await mountWorkbench(
    runOf({
      modelChoice: MODEL_OFFER.currentChoice,
      actionOffers: [MODEL_OFFER],
    }),
    100,
    40,
    okActions({
      changeModelChoice: (offer, choice) => {
        changes.push({ offer, choice });
        return () => ({
          kind: "ok",
          modelChoiceChange: { choice, reach: "next-turn" },
        });
      },
    }),
  );
  try {
    await press(t, renderer, "d");
    assert.match(t.captureCharFrame(), /m change Model choice/);
    await press(t, renderer, "m");
    assert.match(t.captureCharFrame(), /1\. Choose a model/);
    assert.match(t.captureCharFrame(), /Fast.*\[current\]/);
    await press(t, renderer, "down");
    await press(t, renderer, "return");
    assert.match(t.captureCharFrame(), /2\. Choose effort/);
    assert.match(t.captureCharFrame(), /deep does not offer high effort/);
    await press(t, renderer, "return");
    assert.deepEqual(changes, [
      { offer: MODEL_OFFER, choice: { model: "deep", effort: "medium" } },
    ]);
    assert.doesNotMatch(t.captureCharFrame(), /Choose effort/);
    assert.match(t.captureCharFrame(), /applies from the next Turn/);
  } finally {
    t.renderer.destroy();
  }
});

test("workbench-model-choice: absent, unavailable, and stale Offers never open the picker", async () => {
  const wb = await mountWorkbench(runOf());
  try {
    await press(wb.t, wb.renderer, "m");
    assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model|m model/);
    wb.control.setRun(
      runOf({
        actionOffers: [
          {
            ...MODEL_OFFER,
            available: false,
            problem: {
              code: "model-choice-checking",
              explanation: "Model choices are being checked.",
              remediation: "Wait for qualification.",
              possibleEffects: "none",
            },
          },
        ],
      }),
    );
    await press(wb.t, wb.renderer, "d");
    assert.match(
      wb.t.captureCharFrame(),
      /Model choice unavailable · Model choices are being checked/,
    );
    await press(wb.t, wb.renderer, "m");
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /Choose a model|m change Model choice/,
    );
    wb.control.setRun(runOf({ actionOffers: [MODEL_OFFER] }));
    wb.control.setFreshness({
      kind: "catching-up",
      catchUp: "fresh",
      lastConfirmedAt: "2026-10-05T00:00:00Z",
    });
    await press(wb.t, wb.renderer, "m");
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /Choose a model|m change Model choice/,
    );
  } finally {
    wb.t.renderer.destroy();
  }
});

for (const [width, height] of [
  [48, 24],
  [60, 12],
  [140, 44],
]) {
  test(`workbench-model-choice: m stays reachable at ${width}x${height} and resize preserves effort and focus`, async () => {
    const wb = await mountWorkbench(
      runOf({ actionOffers: [MODEL_OFFER] }),
      width,
      height,
    );
    try {
      assert.match(wb.t.captureCharFrame(), /m model/);
      await press(wb.t, wb.renderer, "d");
      if (width < 60 || height < 15)
        assert.doesNotMatch(wb.t.captureCharFrame(), /› Details/);
      await press(wb.t, wb.renderer, "m");
      await press(wb.t, wb.renderer, "down");
      await press(wb.t, wb.renderer, "return");
      noOverflow(wb.t.captureCharFrame(), width);
      wb.t.resize(140, 44);
      wb.renderer.resize(140, 44);
      await wb.t.renderOnce();
      const effort = wb.t.captureCharFrame();
      assert.match(effort, /2\. Choose effort/);
      assert.match(effort, /Model: Deep/);
      assert.match(effort, /› medium \[current\]/);
      assert.doesNotMatch(effort, /tab Harness/);
      await press(wb.t, wb.renderer, "escape");
      assert.match(wb.t.captureCharFrame(), /1\. Choose a model/);
      assert.match(wb.t.captureCharFrame(), /› Deep.*\[current\]/);
      await press(wb.t, wb.renderer, "escape");
      assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
      assert.match(wb.t.captureCharFrame(), /Timeline/);
      noOverflow(wb.t.captureCharFrame(), 140);
    } finally {
      wb.t.renderer.destroy();
    }
  });
}

test("workbench-model-choice: Port Escape steps back even when the real keymap also receives Escape", async () => {
  const wb = await mountWorkbench(runOf({ actionOffers: [MODEL_OFFER] }));
  try {
    await press(wb.t, wb.renderer, "m");
    await press(wb.t, wb.renderer, "return");
    assert.match(wb.t.captureCharFrame(), /Choose effort/);
    wb.renderer.key("escape");
    // Explicit Escape sequence avoids the terminal's lone-Esc disambiguation wait.
    wb.t.mockInput.pressKey("\x1b[27u");
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /1\. Choose a model/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /2\. Choose effort/);
    await press(wb.t, wb.renderer, "c", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
    assert.deepEqual(wb.exits, []);
  } finally {
    wb.t.renderer.destroy();
  }
});

for (const modal of ["request", "gate", "checkpoint"] as const) {
  test(`workbench-model-choice: a ${modal} closes the picker and owns its keys`, async () => {
    const wb = await mountWorkbench(runOf({ actionOffers: [MODEL_OFFER] }));
    try {
      await press(wb.t, wb.renderer, "m");
      assert.match(wb.t.captureCharFrame(), /Choose a model/);
      if (modal === "request") wb.control.setLive(requestOverlay());
      else if (modal === "gate")
        wb.control.setRun(
          freeTextRunOf({ actionOffers: [MODEL_OFFER, FREE_TEXT_OFFER] }),
        );
      else
        wb.control.setRun(
          blockedRunOf({ actionOffers: [MODEL_OFFER, ANSWER_OFFER] }),
        );
      await wb.t.renderOnce();
      assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
      if (modal === "checkpoint") {
        await press(wb.t, wb.renderer, "d");
        assert.doesNotMatch(wb.t.captureCharFrame(), /m change Model choice/);
        await press(wb.t, wb.renderer, "tab");
      }
      await press(wb.t, wb.renderer, "m");
      assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
      if (modal === "request") {
        await press(wb.t, wb.renderer, "escape");
        assert.equal(wb.control.requests[0]?.decision, "deny");
      } else if (modal === "gate") {
        await type(wb.t, "351");
        await press(wb.t, wb.renderer, "return");
        assert.equal(wb.control.texts[0]?.text, "351");
      } else {
        await press(wb.t, wb.renderer, "return");
        assert.equal(wb.control.answers[0]?.answer, "continue");
      }
    } finally {
      wb.t.renderer.destroy();
    }
  });
}

for (const settlement of ["live-turn", "next-turn", "refused"] as const) {
  test(`workbench-model-choice: a live request remains pending until its ${settlement} receipt`, async () => {
    const offer = { ...MODEL_OFFER, reach: "live-turn" as const };
    const [outcome, setOutcome] = createSignal<RunActionOutcome>({
      kind: "pending",
    });
    let submissions = 0;
    const wb = await mountWorkbench(
      runOf({
        selectedHarness: "codex",
        modelChoice: offer.currentChoice,
        actionOffers: [offer],
      }),
      60,
      24,
      okActions({
        changeModelChoice: () => {
          submissions += 1;
          return outcome;
        },
      }),
    );
    try {
      await press(wb.t, wb.renderer, "m");
      assert.match(wb.t.captureCharFrame(), /requested until the Harness/);
      await press(wb.t, wb.renderer, "return");
      await press(wb.t, wb.renderer, "return");
      assert.equal(submissions, 1);
      assert.match(wb.t.captureCharFrame(), /Model choice requested/);
      assert.doesNotMatch(wb.t.captureCharFrame(), /applied to the live Turn/);
      await press(wb.t, wb.renderer, "d");
      assert.match(wb.t.captureCharFrame(), /› Details/);
      assert.doesNotMatch(wb.t.captureCharFrame(), /m change Model choice/);
      await press(wb.t, wb.renderer, "m");
      assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
      assert.equal(submissions, 1);
      if (settlement === "refused")
        setOutcome({
          kind: "refused",
          problem: {
            code: "model-choice-refused",
            explanation: "That model is blocked by your organisation.",
            remediation: "Choose an allowed model.",
            possibleEffects: "none",
          },
        });
      else
        setOutcome({
          kind: "ok",
          modelChoiceChange: { choice: offer.currentChoice, reach: settlement },
        });
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      assert.doesNotMatch(frame, /Model choice requested/);
      if (settlement === "live-turn")
        assert.match(frame, /applied to the live Turn/);
      else if (settlement === "next-turn")
        assert.match(frame, /applies from the next Turn/);
      else {
        assert.match(frame, /Model choice not changed/);
        assert.match(frame, /Choose an allowed model/);
      }
      assert.equal(frame.includes("\x1b"), false);
      noOverflow(frame, 60);
    } finally {
      wb.t.renderer.destroy();
    }
  });
}

test("workbench-model-choice: the dialog holds timeline keys while durable activity still appends", async () => {
  const base = { actionOffers: [MODEL_OFFER], timeline: events(80) };
  const wb = await mountWorkbench(runOf(base));
  try {
    await press(wb.t, wb.renderer, "pageup");
    const before = wb.t.captureCharFrame().match(/.* e\d+ .*/)?.[0];
    assert.ok(before);
    await press(wb.t, wb.renderer, "m");
    await press(wb.t, wb.renderer, "end");
    await press(wb.t, wb.renderer, "q");
    await press(wb.t, wb.renderer, "d");
    assert.deepEqual(wb.exits, []);
    assert.match(wb.t.captureCharFrame(), /Choose a model/);
    wb.control.setRun(runOf({ ...base, timeline: events(83) }));
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "escape");
    const after = wb.t.captureCharFrame();
    assert.ok(after.includes(before));
    assert.match(after, /new activities · Jump to latest/);
    await press(wb.t, wb.renderer, "end");
    assert.match(wb.t.captureCharFrame(), /e82/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /new activities/);
  } finally {
    wb.t.renderer.destroy();
  }
});

for (const effort of ["locked", "unavailable"] as const) {
  test(`workbench-model-choice: Other uses native text and ${effort} effort remains truthful`, async () => {
    const changes: unknown[] = [];
    const offer = {
      ...MODEL_OFFER,
      modelDeclaration: { kind: "free-text" as const, efforts: [] },
      ...(effort === "locked"
        ? {
            effortLock: {
              effort: "high",
              source: "CLAUDE_CODE_EFFORT_LEVEL=high",
            },
          }
        : {}),
    };
    const wb = await mountWorkbench(
      runOf({
        state: "halted",
        selectedHarness: "claude-code",
        actionOffers: [offer],
      }),
      60,
      24,
      okActions({
        changeModelChoice: (_, choice) => {
          changes.push(choice);
          return () => ({
            kind: "ok",
            modelChoiceChange: { choice, reach: "next-turn" },
          });
        },
      }),
    );
    try {
      await press(wb.t, wb.renderer, "m");
      await press(wb.t, wb.renderer, "down");
      await press(wb.t, wb.renderer, "return");
      await type(wb.t, "custom-mq");
      assert.match(wb.t.captureCharFrame(), /custom-mq/);
      assert.deepEqual(wb.exits, []);
      await press(wb.t, wb.renderer, "return");
      const frame = wb.t.captureCharFrame();
      assert.match(frame, /2\. Choose effort/);
      if (effort === "locked") {
        assert.match(frame, /Locked by CLAUDE_CODE_EFFORT_LEVEL=high/);
        assert.match(frame, /high \[current\] \(locked\)/);
      } else assert.match(frame, /This model has no effort setting/);
      await press(wb.t, wb.renderer, "return");
      assert.deepEqual(changes, [
        {
          model: "custom-mq",
          ...(effort === "locked" ? { effort: "high" } : {}),
        },
      ]);
      noOverflow(wb.t.captureCharFrame(), 60);
    } finally {
      wb.t.renderer.destroy();
    }
  });
}

test("workbench-model-choice: losing the Offer closes the dialog and late Harness refusals render in the timeline", async () => {
  const wb = await mountWorkbench(runOf({ actionOffers: [MODEL_OFFER] }));
  try {
    await press(wb.t, wb.renderer, "m");
    wb.control.setRun({
      ...runOf(),
      modelChoiceNotice: "The Harness kept alpha because beta was refused.",
    });
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
    assert.match(
      wb.t.captureCharFrame(),
      /The Harness kept alpha because beta was refused/,
    );
  } finally {
    wb.t.renderer.destroy();
  }
});

test("workbench-confirmation-target-identity: End Step cannot adopt a replacement Step", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  wb.control.setRun(
    interactiveRunOf({
      progress: [
        { id: "next-step", kind: "interactive-agent", status: "running" },
      ],
      actionOffers: [
        { ...SEND_OFFER, stepId: "next-step" },
        { ...END_OFFER, stepId: "next-step" },
      ],
    }),
  );
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.ends, []);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
});

// #389 exercises supported client snapshots. It does not measure how often a
// live Harness produces a replacement, and Step Offers expose no Attempt id.
for (const ending of [
  {
    offer: END_OFFER,
    key: "e",
    prompt: /End this interactive Step\?/,
    writes: "ends",
  },
  {
    offer: CONTINUE_OFFER,
    key: "n",
    prompt: /y continue/,
    writes: "continues",
  },
  {
    offer: END_STAGE_OFFER,
    key: "e",
    prompt: /y end stage/,
    writes: "endStages",
  },
] as const) {
  test(`workbench-confirmation-target-identity: ${ending.offer.action} rejects a replaced Run or Step`, async () => {
    for (const replacement of [
      { ...ending.offer, stepId: "next-step" },
      { ...ending.offer, runId: "run-replacement" },
    ]) {
      const wb = await mountWorkbench(
        interactiveRunOf({ actionOffers: [SEND_OFFER, ending.offer] }),
      );
      await press(wb.t, wb.renderer, ending.key, { ctrl: true });
      assert.match(wb.t.captureCharFrame(), ending.prompt);
      wb.control.setRun(
        interactiveRunOf({ actionOffers: [SEND_OFFER, replacement] }),
      );
      await press(wb.t, wb.renderer, "y");
      assert.deepEqual(wb.control[ending.writes], []);
      assert.doesNotMatch(wb.t.captureCharFrame(), ending.prompt);
    }
  });

  test(`workbench-confirmation-target-identity: ${ending.offer.action} withdrawal and reappearance require a fresh arm`, async () => {
    const initial = interactiveRunOf({
      actionOffers: [SEND_OFFER, ending.offer],
    });
    const wb = await mountWorkbench(initial);
    await type(wb.t, "kept draft");
    await press(wb.t, wb.renderer, ending.key, { ctrl: true });
    wb.control.setRun(interactiveRunOf({ actionOffers: [SEND_OFFER] }));
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), ending.prompt);
    wb.control.setRun(initial);
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(wb.control[ending.writes], []);
    assert.match(wb.t.captureCharFrame(), /> kept draft/);
    await type(wb.t, " editable");
    assert.match(wb.t.captureCharFrame(), /> kept draft editable/);
    await press(wb.t, wb.renderer, ending.key, { ctrl: true });
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(wb.control[ending.writes], [
      { runId: "run-1", stepId: "discuss" },
    ]);
  });

  test(`workbench-confirmation-target-identity: ${ending.offer.action} retains intent through updates and resize`, async () => {
    const original = {
      ...ending.offer,
      consequence: "ORIGINAL consequence " + "long warning ".repeat(30),
    };
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER, original] }),
      160,
      32,
    );
    await type(wb.t, "kept draft");
    await press(wb.t, wb.renderer, ending.key, { ctrl: true });
    const armed = wb.t.captureCharFrame();
    assert.match(armed, ending.prompt);
    assert.match(armed, /ORIGINAL consequence/);
    wb.control.setRun(
      interactiveRunOf({
        timeline: [{ at: "T1", event: "turn-started" }],
        actionOffers: [
          { ...SEND_OFFER },
          { ...original, consequence: "REPLACEMENT wording" },
        ],
      }),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /ORIGINAL consequence/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /REPLACEMENT wording/);
    // The captured target and the fixed three-row input survive both widths.
    for (const width of [48, 100, 160]) {
      wb.renderer.resize(width, 32);
      wb.t.resize(width, 32);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      noOverflow(frame, width);
      assert.equal(
        frame.split("\n").findIndex((line) => line.includes("> kept draft")),
        29,
      );
      assert.doesNotMatch(frame, /REPLACEMENT wording/);
    }
    await type(wb.t, "y");
    assert.doesNotMatch(wb.t.captureCharFrame(), /> kept drafty/);
    await press(wb.t, wb.renderer, "escape");
    assert.doesNotMatch(wb.t.captureCharFrame(), ending.prompt);
    await type(wb.t, " editable");
    assert.match(wb.t.captureCharFrame(), /> kept draft editable/);
    await press(wb.t, wb.renderer, ending.key, { ctrl: true });
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(wb.control[ending.writes], [
      { runId: "run-1", stepId: "discuss" },
    ]);
  });
}

for (const recovery of [
  {
    offer: { ...RESUME_OFFER, takeover: { ownerPid: 7331 } },
    prompt: /Take over from process 7331/,
  },
  { offer: RESUME_ACK_OFFER, prompt: /y to acknowledge and resume/ },
  {
    offer: { ...RESUME_ACK_OFFER, takeover: { ownerPid: 7331 } },
    prompt: /Take over from process 7331/,
  },
] as const) {
  test(`workbench-confirmation-target-identity: resume captures ${recovery.prompt.source} and its consequence`, async () => {
    const received: ResumeRunOffer[] = [];
    const original: Extract<ResumeRunOffer, { available: true }> =
      recovery.offer;
    const initial = runOf({ state: "halted", actionOffers: [original] });
    const wb = await mountWorkbench(
      initial,
      160,
      40,
      okActions({
        resume: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "r");
    assert.match(wb.t.captureCharFrame(), recovery.prompt);
    // A new object for the same normalized target must not reset the arm.
    wb.control.setRun(
      runOf({
        state: "halted",
        actionOffers: [
          {
            ...original,
            ...(original.takeover === undefined
              ? {}
              : { takeover: { ...original.takeover } }),
            consequence: "REPLACEMENT resume consequence",
          },
        ],
        timeline: [{ at: "T1", event: "turn-started" }],
      }),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), recovery.prompt);
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /REPLACEMENT resume consequence/,
    );
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(received, [original]);
  });
}

for (const replacement of [
  {
    ...RESUME_ACK_OFFER,
    acknowledgement: "Different command effects may repeat.",
  },
  { ...RESUME_ACK_OFFER, acknowledgement: undefined },
  { ...RESUME_ACK_OFFER, takeover: { ownerPid: 8442 } },
  { ...RESUME_ACK_OFFER, runId: "run-replacement" },
  RESUME_UNAVAILABLE_OFFER,
] as const) {
  test(`workbench-confirmation-target-identity: changed resume evidence clears acknowledgement (${JSON.stringify(replacement)})`, async () => {
    const received: ResumeRunOffer[] = [];
    const wb = await mountWorkbench(
      runOf({ state: "halted", actionOffers: [RESUME_ACK_OFFER] }),
      100,
      40,
      okActions({
        resume: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "r");
    wb.control.setRun(runOf({ state: "halted", actionOffers: [replacement] }));
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(received, []);
    assert.doesNotMatch(wb.t.captureCharFrame(), /y to acknowledge and resume/);
  });
}

test("workbench-confirmation-target-identity: takeover owner changes and withdrawal cannot silently resume", async () => {
  const original = { ...RESUME_ACK_OFFER, takeover: { ownerPid: 7331 } };
  for (const replacement of [
    { ...original, takeover: { ownerPid: 8442 } },
    { ...original, takeover: undefined },
    { ...original, acknowledgement: "Different acknowledgement" },
    undefined,
  ]) {
    const received: ResumeRunOffer[] = [];
    const initial = runOf({ state: "halted", actionOffers: [original] });
    const wb = await mountWorkbench(
      initial,
      100,
      40,
      okActions({
        resume: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "r");
    wb.control.setRun(
      runOf({
        state: "halted",
        actionOffers: replacement === undefined ? [] : [replacement],
      }),
    );
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /Take over from process 7331/);
    wb.control.setRun(initial);
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(received, []);
    await press(wb.t, wb.renderer, "r");
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(received, [original]);
  }
});

for (const interactive of [false, true]) {
  test(`workbench-confirmation-target-identity: ${interactive ? "input" : "rail"} Interrupt cannot migrate to a replacement Turn`, async () => {
    const received: (typeof INTERRUPT_OFFER)[] = [];
    const liveRun = interactive ? liveInteractiveRunOf : liveTurnRunOf;
    const wb = await mountWorkbench(
      liveRun(),
      160,
      40,
      okActions({
        interrupt: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "escape");
    assert.match(wb.t.captureCharFrame(), /Press esc again to interrupt/);
    wb.control.setRun(
      liveRun({ actionOffers: [{ ...INTERRUPT_OFFER, turnId: "turn-next" }] }),
    );
    await wb.t.renderOnce();
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /Press esc again to interrupt/,
    );
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, []);
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, [{ ...INTERRUPT_OFFER, turnId: "turn-next" }]);
  });

  test(`workbench-confirmation-target-identity: ${interactive ? "input" : "rail"} Interrupt preserves captured wording and clears on withdrawal`, async () => {
    const received: (typeof INTERRUPT_OFFER)[] = [];
    const liveRun = interactive ? liveInteractiveRunOf : liveTurnRunOf;
    const original = {
      ...INTERRUPT_OFFER,
      consequence: "ORIGINAL Turn consequence " + "long warning ".repeat(20),
    };
    const initial = liveRun({ actionOffers: [original] });
    const wb = await mountWorkbench(
      initial,
      160,
      32,
      okActions({
        interrupt: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "escape");
    wb.control.setRun(
      liveRun({
        actionOffers: [
          { ...original, consequence: "REPLACEMENT Turn wording" },
        ],
        timeline: [{ at: "T1", event: "turn-started" }],
      }),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /ORIGINAL Turn consequence/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /REPLACEMENT Turn wording/);
    for (const width of [48, 100, 160]) {
      wb.renderer.resize(width, 32);
      wb.t.resize(width, 32);
      await wb.t.renderOnce();
      noOverflow(wb.t.captureCharFrame(), width);
      assert.match(wb.t.captureCharFrame(), /Press esc again to interrupt/);
    }
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, [original]);
    wb.control.setRun(initial);
    await press(wb.t, wb.renderer, "escape");
    wb.control.setRun(liveRun({ actionOffers: [] }));
    await wb.t.renderOnce();
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /Press esc again to interrupt/,
    );
    wb.control.setRun(initial);
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, [original]);
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, [original, original]);
  });
}

// The Workbench answers an authored free-text Gate; approve-reject keeps the
// headless path (run-gate-control.tsx), covered by tests/headless/run.test.ts.
test("[repeat-command-gate-progress] the Workbench answers the Gate after a passing Repeat and an outside Command, re-running no Command (#384)", async (context) => {
  const { process, runs } = countingBundleProcess();
  const catalog = openCatalog(makeTempDir("secant-wb-progress-home-"));
  context.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-wb-progress-ws-"));
  const runGroup = openFakeRunGroup(
    makeTempDir("secant-wb-progress-store-"),
    workspace,
  );
  context.after(() => runGroup.close());
  const app = createApplication({
    process,
    catalog,
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
  });
  context.after(() => app.shutdown());
  const bundle = writeRoutingBundle({
    id: "dev.secant.repeat-command-gate",
    routing: repeatCommandGateRouting("free-text"),
  });
  assert.ok(app.bundleManagement.build(bundle.folder, { noInstall: false }).ok);
  const digest = catalog.listEntries().find((e) => e.id === bundle.id)!.digest;
  catalog.approveWorkspace(workspace, new Date());
  const launched = app.projectionPort.submit({
    operationId: "launch",
    operation: "launch-run",
    input: { bundle: { id: bundle.id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(launched.admitted);
  await awaitSettled(app.projectionPort, "launch");
  const runId = launched.runId!;

  const renderer = makeFakeRenderer(100, 40);
  const { t } = await mountApp(
    { view: createLiveRunWorkbenchView(app.projectionPort) },
    renderer,
    runId,
    100,
    40,
  );
  await t.waitForFrame((frame) => frame.includes("Human Gate ·"));
  const frame = t.captureCharFrame();
  assert.match(frame, /BLOCKED · durable Human Gate/);
  assert.match(frame, /Human Gate · approve the outside change/);
  assert.match(frame, /step 4 of 5/);
  assert.match(
    frame,
    /Progress: ✓ baseline · ✓ check · ✓ outside · ⏸ gate · · after/,
  );
  assert.deepEqual(runs, { baseline: 1, check: 1, outside: 1 });

  await type(t, "ship it");
  await press(t, renderer, "return");
  const done = await followRun(app.projectionPort, runId, (run) =>
    run.state === "succeeded" ? run : undefined,
  );
  assert.deepEqual(
    done.progress.map((step) => `${step.id}:${step.status}`),
    [
      "baseline:succeeded",
      "check:succeeded",
      "outside:succeeded",
      "gate:succeeded",
      "after:succeeded",
    ],
  );
  assert.deepEqual(runs, { baseline: 1, check: 1, outside: 1, after: 1 });
  await t.waitForFrame((next) => !next.includes("BLOCKED"));
});

// --- inspection quit (#392) -------------------------------------------------

// The inspection footer advertises `q quit`; q there takes the same guarded Exit as
// the Workbench's own q, while every other bare letter stays inside the overlay.
// Scripted Projection and Renderer values cover this client contract; no Harness.

/** A Run offering resume, cancel and delete, with one text output and one Session
 *  transcript, so every Run-action letter has something to leak to. */
function inspectableRun(): RunView {
  return runOf({
    state: "halted",
    actionOffers: [RESUME_OFFER, CANCEL_OFFER, DELETE_OFFER],
    outputs: [
      {
        name: "log",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "log",
          versionId: "v1",
          type: "text",
        },
      },
    ],
    sessions: transcriptRun().sessions,
  });
}

async function mountInspectable(ownedLiveRuns?: number | "unavailable") {
  const dispatched: string[] = [];
  const record = (action: string) => () => {
    dispatched.push(action);
    return () => ({ kind: "ok" }) as const;
  };
  const wb = await mountWorkbench(
    inspectableRun(),
    100,
    40,
    okActions({
      resume: record("resume"),
      cancel: record("cancel"),
      remove: record("delete"),
    }),
    false,
    ownedLiveRuns,
  );
  wb.control.setRead("log", {
    found: true,
    type: "text",
    content: "log line one\nlog line two",
  });
  wb.control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "N1", "N2", "N3", "N4", "N5", "N6", "N7"),
  });
  return { ...wb, dispatched };
}

/** Each inspection kind, opened the way a user reaches it from the details panel,
 *  which stays shown underneath, so its c/x would arm if a key leaked. */
const INSPECTIONS = [
  {
    kind: "output",
    title: /log \(text\)/,
    footer: /↑\/↓ scroll · esc close · q quit/,
    open: async (wb: Awaited<ReturnType<typeof mountInspectable>>) => {
      await press(wb.t, wb.renderer, "d"); // details focus, log selected
      await press(wb.t, wb.renderer, "return");
    },
    reopen: "return", // Escape leaves the details focus on the log
  },
  {
    kind: "transcript",
    title: /Session transcript/,
    footer: /p older · e export · esc close · q quit/,
    open: async (wb: Awaited<ReturnType<typeof mountInspectable>>) => {
      await press(wb.t, wb.renderer, "d");
      await press(wb.t, wb.renderer, "down");
      await press(wb.t, wb.renderer, "return");
    },
    reopen: "return",
  },
] as const;

for (const inspection of INSPECTIONS) {
  test(`workbench-inspection-quit: q in ${inspection.kind} inspection quits at once with no live Run`, async () => {
    const wb = await mountInspectable();
    await inspection.open(wb);
    const frame = wb.t.captureCharFrame();
    assert.match(frame, inspection.title);
    assert.match(frame, inspection.footer);

    await press(wb.t, wb.renderer, "q");
    assert.deepEqual(wb.exits, [undefined]);
  });

  test(`workbench-inspection-quit: q in ${inspection.kind} inspection asks first with live Runs; Keep Running keeps the inspection`, async () => {
    const wb = await mountInspectable(1);
    await inspection.open(wb);
    await press(wb.t, wb.renderer, "end");
    const before = wb.t.captureCharFrame();

    await press(wb.t, wb.renderer, "q");
    await wb.t.waitForFrame((f) => f.includes("Halt 1 live Run and quit?"));
    assert.deepEqual(wb.exits, []);

    wb.t.mockInput.pressEnter(); // the default, Keep Running
    await wb.t.waitForFrame((f) => !f.includes("Halt 1 live Run and quit?"));
    assert.deepEqual(wb.exits, []);
    assert.equal(wb.t.captureCharFrame(), before); // same overlay, same scroll

    await press(wb.t, wb.renderer, "q");
    await wb.t.waitForFrame((f) => f.includes("Halt 1 live Run and quit?"));
    wb.t.mockInput.pressArrow("right");
    wb.t.mockInput.pressEnter(); // Halt and Quit
    await wb.t.waitFor(() => wb.exits.length === 1);
    assert.deepEqual(wb.exits, [undefined]);
  });

  test(`workbench-inspection-quit: ${inspection.kind} inspection keeps Escape, Ctrl+C and Run-action letters on their routes`, async () => {
    const wb = await mountInspectable();
    await inspection.open(wb);
    const open = wb.t.captureCharFrame();

    // Run-action and screen letters stay inside the modal overlay: none arms,
    // confirms or dispatches beneath it.
    for (const key of ["r", "c", "x", "y", "t", "d", "s", "m"]) {
      await press(wb.t, wb.renderer, key);
    }
    assert.deepEqual(wb.dispatched, []);
    assert.deepEqual(wb.exits, []);
    assert.equal(wb.t.captureCharFrame(), open);

    // Escape closes the overlay only: the Workbench stays, its own footer back.
    await press(wb.t, wb.renderer, "escape");
    const closed = wb.t.captureCharFrame();
    assert.doesNotMatch(closed, inspection.footer);
    assert.match(closed, /Timeline/);
    assert.match(closed, /esc back · q quit/);
    assert.deepEqual(wb.exits, []);

    // Ctrl+C keeps its global quit route from inside the overlay.
    await press(wb.t, wb.renderer, inspection.reopen);
    assert.match(wb.t.captureCharFrame(), inspection.footer);
    await press(wb.t, wb.renderer, "c", { ctrl: true });
    assert.deepEqual(wb.exits, [undefined]);
  });
}

test("m10-observed-harness-facts: metadata replacement leaves paused history and its activity badge alone", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({
      timeline: events(40),
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
    100,
    18,
  );
  const overlay: RunLiveOverlay = {
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  };
  control.setLive(overlay);
  await t.renderOnce();
  await press(t, renderer, "up");
  const history = () =>
    t
      .captureCharFrame()
      .split("\n")
      .filter((line) => / e\d|Timeline/.test(line));
  const before = history();
  control.setLive({
    ...overlay,
    context: { limitTokens: 200000 },
    usage: "last output 0 tokens",
  });
  await t.renderOnce();
  assert.deepEqual(history(), before);
  assert.match(t.captureCharFrame(), /Context · capacity 200000 tokens/);
  assert.match(t.captureCharFrame(), /Usage · last output 0 tokens/);
  control.setLive({
    ...overlay,
    context: { usedTokens: 9000, limitTokens: 2, percentage: 150 },
    usage: "input 7 tokens",
  });
  await t.renderOnce();
  assert.deepEqual(history(), before);
  assert.match(
    t.captureCharFrame(),
    /used 9000 tokens, capacity 2 tokens, reported 150%/,
  );
  assert.doesNotMatch(t.captureCharFrame(), /undefined|450000%/);
  control.setLive({ ...overlay, context: {}, usage: "" });
  await t.renderOnce();
  assert.deepEqual(history(), before);
  assert.doesNotMatch(t.captureCharFrame(), /Context ·|Usage ·/);
});

for (const [width, height] of [
  [40, 12],
  [80, 18],
  [120, 24],
] as const) {
  test(`m10-observed-harness-facts: metadata remains bounded and leaves keyboard controls visible at ${width}x${height}`, async () => {
    const { t, control, renderer } = await mountWorkbench(
      runOf({
        timeline: events(30),
        progress: [{ id: "repair", kind: "agent", status: "running" }],
      }),
      width,
      height,
    );
    control.setLive({
      runId: "run-1",
      generation: 1,
      phase: "working",
      outstanding: [],
      offers: [],
      context: { limitTokens: 258400 },
      usage: "last output 0 tokens",
    });
    await t.renderOnce();
    assert.match(t.captureCharFrame(), /Context · capacity 258400 tokens/);
    assert.match(t.captureCharFrame(), /Usage · last output 0 tokens/);
    assert.match(t.captureCharFrame(), /↑\/↓ scroll/);
    await press(t, renderer, "up");
    assert.match(t.captureCharFrame(), /Jump to latest/);
    renderer.resize(width + 2, height);
    await t.renderOnce();
    await press(t, renderer, "end");
    assert.doesNotMatch(
      t.captureCharFrame(),
      /Jump to latest|Thinking|duration|%/,
    );
    assert.match(t.captureCharFrame(), /e29/);
  });
}
function previewPreferences(): PreferencesView {
  return {
    snapshot: () => ({
      family: "preferences",
      preferences: { theme: "everforest", appearance: "dark" },
      supportedThemes: PALETTES.map((p) => p.name),
      actionOffers: [{ action: "change-preferences" }],
    }),
    save: () => () => ({ kind: "applied" }),
  };
}
async function openAppThemes(wb: Awaited<ReturnType<typeof mountWorkbench>>) {
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, "Themes");
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /Themes ·/);
}
const hexRgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

test("m10-home-and-preferences: all 25×2 previews recolor the mounted Workbench through Port keys", async () => {
  const wb = await mountWorkbench(
    runOf(),
    100,
    40,
    undefined,
    true,
    0,
    previewPreferences(),
  );
  const header = () => {
    const span = wb.t
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Alpha"));
    assert.ok(span, wb.t.captureCharFrame());
    return [span.fg.r, span.fg.g, span.fg.b].map((v) => Math.round(v * 255));
  };
  const initial = header();
  for (const palette of PALETTES) {
    await openAppThemes(wb);
    await type(wb.t, palette.name);
    assert.deepEqual(
      header(),
      hexRgb(palette.dark).map((v) => Math.round((v * 105) / 255)),
      palette.name + " dark",
    );
    await press(wb.t, wb.renderer, "tab");
    assert.deepEqual(
      header(),
      hexRgb(palette.light).map((v) => Math.round((v * 105) / 255)),
      palette.name + " light",
    );
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(header(), initial);
  }
  wb.t.resize(40, 16);
  wb.renderer.resize(40, 16);
  await wb.t.renderOnce();
  await openAppThemes(wb);
  await type(wb.t, "zenburn");
  await press(wb.t, wb.renderer, "return");
  noOverflow(wb.t.captureCharFrame(), 40);
  wb.t.resize(140, 32);
  wb.renderer.resize(140, 32);
  await wb.t.renderOnce();
  assert.deepEqual(
    header(),
    hexRgb(PALETTES.find((p) => p.name === "zenburn")!.dark),
  );
});

for (const discovery of ["palette", "themes"] as const) {
  for (const interaction of ["request", "gate"] as const) {
    test(`m10-home-and-preferences: new ${interaction} preempts ${discovery}, deliberate palette reopens and owns keys`, async () => {
      const wb = await mountWorkbench(
        runOf({ state: "running", actionOffers: [INTERRUPT_OFFER] }),
        100,
        40,
        okActions(),
        true,
        0,
        previewPreferences(),
      );
      if (discovery === "themes") {
        await openAppThemes(wb);
        await type(wb.t, "nord");
      } else await press(wb.t, wb.renderer, "p", { ctrl: true });
      if (interaction === "request") wb.control.setLive(requestOverlay());
      else wb.control.setRun(freeTextRunOf());
      await wb.t.renderOnce();
      assert.doesNotMatch(
        wb.t.captureCharFrame(),
        /Themes · .+ · nord|App commands/,
      );
      assert.match(
        wb.t.captureCharFrame(),
        interaction === "request"
          ? /Harness Request/
          : /What is the ticket number/,
      );
      await press(wb.t, wb.renderer, "p", { ctrl: true });
      assert.match(wb.t.captureCharFrame(), /App commands/);
      await type(wb.t, "Quit");
      await press(wb.t, wb.renderer, "return"); // nothing selected; no answer or Quit
      assert.deepEqual(wb.control.requests, []);
      assert.deepEqual(wb.control.texts, []);
      assert.deepEqual(wb.exits, []);
      await press(wb.t, wb.renderer, "escape");
      assert.doesNotMatch(wb.t.captureCharFrame(), /App commands/);
      if (interaction === "request") {
        await press(wb.t, wb.renderer, "return");
        assert.deepEqual(wb.control.requests, [
          { requestId: "req-1", generation: 3, decision: "allow" },
        ]);
      } else {
        await type(wb.t, "409");
        await press(wb.t, wb.renderer, "return");
        assert.deepEqual(wb.control.texts, [
          { gate: FREE_TEXT_GATE, text: "409" },
        ]);
      }
    });
  }
}

test("m10-home-and-preferences: palette End Step follows the key's confirmation and current Offer", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "keep draft");
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  const palette = wb.t.captureCharFrame();
  assert.match(palette, /End Step \(ctrl\+e\)/);
  assert.doesNotMatch(
    palette,
    /Start a Run|Workflow Bundles|Previous Runs|Harnesses/,
  );
  await type(wb.t, "End Step");
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /End this interactive Step/);
  assert.deepEqual(wb.control.ends, []);
  assert.deepEqual(wb.control.sends, []);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /> keep draft/);
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> keep draft!/);
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, "End Step");
  await press(wb.t, wb.renderer, "down");
  wb.control.setRun(interactiveRunOf({ actionOffers: [SEND_OFFER] }));
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.ends, []);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step/);
});

test("m10-home-and-preferences: palette guarded Quit keeps inspection and its focus on dismissal", async () => {
  const wb = await mountInspectable(1);
  await INSPECTIONS[0].open(wb);
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, "Quit");
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /Halt 1 live Run and quit/);
  wb.t.mockInput.pressEnter();
  await wb.t.renderOnce();
  assert.deepEqual(wb.exits, []);
  assert.match(wb.t.captureCharFrame(), /esc close · q quit/);
});

for (const command of ["Model", "Effort"] as const) {
  test(`m10-home-and-preferences: ${command} in the palette opens the working choice picker over a Gate`, async () => {
    const wb = await mountWorkbench(
      freeTextRunOf({ actionOffers: [FREE_TEXT_OFFER, MODEL_OFFER] }),
    );
    await type(wb.t, "keep answer");
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    const frame = wb.t.captureCharFrame();
    for (const name of ["Model", "Effort", "Themes", "Quit"])
      assert.match(frame, new RegExp(name));
    assert.doesNotMatch(frame, /End Step|Continue \(ctrl/);
    await type(wb.t, command);
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      command === "Model" ? /Choose a model/ : /Choose effort/,
    );
    assert.deepEqual(wb.control.texts, []);
    // Escape from effort first returns to model; the next closes the picker.
    if (command === "Effort") await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "escape");
    await type(wb.t, "!");
    assert.match(wb.t.captureCharFrame(), /keep answer!/);
  });
}

test("m10-home-and-preferences: Workbench picker size and resize come from the Renderer Port", async () => {
  const wb = await mountWorkbench(
    runOf(),
    100,
    40,
    undefined,
    true,
    0,
    previewPreferences(),
  );
  // Change only the Port to prove the source of geometry. The physical canvas
  // stays large so it also catches drawing below the Port's advertised boundary.
  wb.renderer.resize(40, 16);
  await wb.t.renderOnce();
  await openAppThemes(wb);
  const narrow = wb.t.captureCharFrame();
  assert.match(narrow, /Themes · Dark/);
  assert.ok(
    narrow
      .split("\n")
      .slice(16)
      .every((line) => !/Preview theme|tab Dark/.test(line)),
  );
  wb.renderer.resize(100, 40);
  await wb.t.renderOnce();
  const wide = wb.t.captureCharFrame();
  assert.ok(
    wide.split("\n").filter((line) => line.includes("Preview theme")).length >
      narrow.split("\n").filter((line) => line.includes("Preview theme"))
        .length,
  );
  await type(wb.t, "zenburn");
  await press(wb.t, wb.renderer, "return");
  assert.doesNotMatch(wb.t.captureCharFrame(), /Themes · Dark/);
});

test("m10-home-and-preferences: palette and keys share refusal cleanup when arming End Step", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "return");
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "stale-send",
      explanation: "stale send",
      remediation: "Try again",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /stale send/);
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, "End Step");
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /End this interactive Step/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /stale send/);
  assert.deepEqual(wb.control.ends, []);
});

/** Open the Session reader through focused details, including below panel breakpoints. */
async function openTranscriptDetails(
  wb: Awaited<ReturnType<typeof mountWorkbench>>,
) {
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  await press(wb.t, wb.renderer, "return");
}

for (const width of [40, 100]) {
  for (const boundary of [false, true]) {
    test(`m10-full-transcript-prepend: retained entry and nonzero wrapped offset survive ${boundary ? "Step-boundary" : "ordinary"} prepend, failure/retry and resize at ${width}`, async () => {
      const wb = await mountWorkbench(transcriptRun(), width, 12);
      const { t, renderer, control } = wb;
      const entries = Array.from({ length: 20 }, (_, index) => ({
        id: `retained-${index}`,
        session: "s",
        role: "assistant" as const,
        content: `ENTRY_${index} ` + `ANCHOR_${index} `.repeat(24),
        step: "write-spec",
      }));
      control.setTranscript("", {
        found: true,
        type: "transcript-page",
        entries,
        older: "c1",
      });
      await openTranscriptDetails(wb);
      await press(t, renderer, "home");
      await press(t, renderer, "down");
      await press(t, renderer, "down");
      const first = () => t.captureCharFrame().split("\n")[2]!.trimEnd();
      const anchored = first();
      assert.equal(
        anchored,
        width === 40
          ? " ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0"
          : " ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0",
      );
      // Loaded page is a snapshot. A later append must not replace it or its opaque cursor.
      control.setTranscript("", {
        found: true,
        type: "transcript-page",
        entries: [
          ...entries.slice(1),
          { id: "later", session: "s", role: "user", content: "LATER_APPEND" },
        ],
        older: "changed",
      });
      control.setTranscript("c1", {
        found: false,
        problem: {
          code: "read-failed",
          explanation: "Older read failed.",
          remediation: "Press p to retry.",
          possibleEffects: "none",
        },
      });
      const before = control.transcriptReads.length;
      await press(t, renderer, "p");
      assert.equal(first(), anchored);
      assert.match(t.captureCharFrame(), /read-failed/);
      assert.equal(control.transcriptReads.length, before + 1);
      assert.equal(control.transcriptReads.at(-1)?.type, "transcript-page");
      assert.deepEqual(control.transcriptReads.at(-1), {
        ...transcriptRun().sessions![0]!.transcriptPage,
        older: "c1",
      });
      control.setTranscript("c1", {
        found: true,
        type: "transcript-page",
        entries: [
          {
            id: "older-entry",
            session: "s",
            role: "user",
            content: "PREPENDED " + "old ".repeat(30),
            step: boundary ? "grill" : "write-spec",
          },
        ],
      });
      await press(t, renderer, "p");
      assert.equal(first(), anchored);
      assert.doesNotMatch(t.captureCharFrame(), /read-failed|LATER_APPEND/);
      // Entry/offset is worded independently of colour and opaque ids stay private.
      assert.match(t.captureCharFrame(), /Entry 2 · line 3/);
      t.resize(width === 40 ? 100 : 40, 12);
      renderer.resize(width === 40 ? 100 : 40, 12);
      await t.renderOnce();
      assert.equal(
        first(),
        width === 40
          ? " ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0"
          : " ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0",
      );
      assert.match(t.captureCharFrame(), /Entry 2 · line 3/);
      noOverflow(t.captureCharFrame(), width === 40 ? 100 : 40);
      await press(t, renderer, "up");
      assert.match(first(), /^ ENTRY_0 /); // same entry, previous displayed line
      await press(t, renderer, "escape");
      await press(t, renderer, "return"); // same selected details resource
      assert.match(t.captureCharFrame(), /Session transcript/);
    });
  }
}

test("m10-full-transcript-prepend: resize clamps only the offset of a surviving retained entry on a short page", async () => {
  const wb = await mountWorkbench(transcriptRun(), 40, 8);
  const { t, renderer, control } = wb;
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [
      {
        id: "retained",
        session: "s",
        role: "assistant",
        content: "ENTRY " + "ANCHOR ".repeat(24),
      },
    ],
    older: "c1",
  });
  await openTranscriptDetails(wb);
  await press(t, renderer, "home");
  for (let i = 0; i < 4; i++) await press(t, renderer, "down");
  assert.match(t.captureCharFrame(), /Entry 1 · line 5/);
  t.resize(100, 30);
  renderer.resize(100, 30);
  await t.renderOnce();
  // Wide content is header + two content lines + separator; clamp to that separator.
  assert.equal(t.captureCharFrame().split("\n")[2]!.trim(), "");
  assert.match(t.captureCharFrame(), /Entry 1 · line 4/);
  assert.doesNotMatch(t.captureCharFrame(), /· latest/);
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: [{ id: "older", session: "s", role: "user", content: "OLDER" }],
  });
  await press(t, renderer, "p");
  assert.match(t.captureCharFrame(), /Entry 2 · line 4/);
  assert.doesNotMatch(t.captureCharFrame(), /OLDER|· latest/);
  t.resize(40, 10);
  renderer.resize(40, 10);
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Entry 2 · line 4/); // discarded offset stays discarded
  assert.equal(
    t.captureCharFrame().split("\n")[2]!.trimEnd(),
    " ANCHOR ANCHOR ANCHOR ANCHOR ANCHOR",
  );
});

test("m10-full-transcript-prepend: initial read failure can retry and an empty conversation remains readable", async () => {
  const wb = await mountWorkbench(transcriptRun(), 100, 12);
  await openTranscriptDetails(wb);
  assert.match(wb.t.captureCharFrame(), /transcript-gone/);
  wb.control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [],
  });
  await press(wb.t, wb.renderer, "p");
  assert.match(wb.t.captureCharFrame(), /Empty conversation/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /transcript-gone/);
  await press(wb.t, wb.renderer, "home");
  await press(wb.t, wb.renderer, "down");
  assert.match(wb.t.captureCharFrame(), /Empty conversation/);
});

test("m10-full-transcript-prepend: export reads the complete Resource only on demand and preserves paging and position", async () => {
  const wb = await mountWorkbench(transcriptRun(), 100, 12);
  const { t, renderer, control } = wb;
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("assistant", "NEWEST"),
    older: "c1",
  });
  await openTranscriptDetails(wb);
  const before = t.captureCharFrame().split("\n").slice(2, 6);
  const copied: string[] = [];
  const original = t.renderer.copyToClipboardOSC52;
  t.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  try {
    await press(t, renderer, "e"); // read failure, same content and cursor
    assert.match(t.captureCharFrame(), /Export \[transcript-gone\]/);
    assert.deepEqual(t.captureCharFrame().split("\n").slice(2, 6), before);
    assert.deepEqual(copied, []);
    control.setTranscript("export", {
      found: true,
      type: "transcript-export",
      entries: [
        ...txEntries("user", "OLDER"),
        {
          id: "export-only",
          session: "s",
          role: "assistant",
          content: "NEWEST",
          incomplete: true,
        },
      ],
    });
    await press(t, renderer, "e");
    assert.deepEqual(copied, [
      "User\nOLDER\n\nAssistant · incomplete\nNEWEST\n",
    ]);
    assert.match(
      t.captureCharFrame(),
      /Export sent to terminal clipboard · 2 entries/,
    );
    assert.deepEqual(t.captureCharFrame().split("\n").slice(2, 6), before);
    t.renderer.copyToClipboardOSC52 = () => false;
    await press(t, renderer, "e");
    assert.match(t.captureCharFrame(), /Export unavailable/);
    assert.deepEqual(
      control.transcriptReads.map((ref) => ref.type),
      [
        "transcript-page",
        "transcript-export",
        "transcript-export",
        "transcript-export",
      ],
    );
    control.setTranscript("c1", {
      found: true,
      type: "transcript-page",
      entries: txEntries("user", "OLDER"),
    });
    await press(t, renderer, "p");
    assert.deepEqual(control.transcriptReads.at(-1), {
      ...transcriptRun().sessions![0]!.transcriptPage,
      older: "c1",
    });
    assert.deepEqual(t.captureCharFrame().split("\n").slice(2, 6), before);
  } finally {
    t.renderer.copyToClipboardOSC52 = original;
  }
});

for (const size of [
  { width: 40, height: 10 },
  { width: 100, height: 40 },
]) {
  test(`m10-workbench-interaction: details and the transcript own keys and focus at ${size.width}x${size.height}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf(),
      size.width,
      size.height,
    );
    wb.control.setRun({
      ...interactiveRunOf(),
      sessions: transcriptRun().sessions,
    });
    wb.control.setTranscript("", {
      found: true,
      type: "transcript-page",
      entries: txEntries("user", "RETAINED"),
    });
    await type(wb.t, "keep draft");
    await press(wb.t, wb.renderer, "t"); // retired shortcut cannot read older history
    assert.deepEqual(wb.control.transcriptReads, []);
    await openTranscriptDetails(wb);
    assert.match(wb.t.captureCharFrame(), /RETAINED/);
    for (const key of ["r", "c", "x", "y", "s", "m", "return", "g"])
      await press(wb.t, wb.renderer, key);
    assert.deepEqual(wb.control.sends, []);
    assert.deepEqual(wb.control.steers, []);
    assert.deepEqual(wb.control.ends, []);
    await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "return"); // returns to selected details resource, not prompt
    assert.match(wb.t.captureCharFrame(), /RETAINED/);
    await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "tab");
    await press(wb.t, wb.renderer, "tab");
    await type(wb.t, "!");
    assert.match(wb.t.captureCharFrame(), /keep draft/);
  });
}

for (const appearance of ["dark", "light"] as const) {
  test(`m10-workbench-interaction: ${appearance} transcript uses theme roles and palette Quit preserves position with unknown ownership`, async () => {
    const base = previewPreferences();
    const preferences: PreferencesView = {
      ...base,
      snapshot: () => ({
        ...base.snapshot(),
        preferences: { theme: "everforest", appearance },
      }),
    };
    const wb = await mountWorkbench(
      transcriptRun(),
      100,
      16,
      undefined,
      true,
      "unavailable",
      preferences,
    );
    wb.control.setTranscript("", {
      found: true,
      type: "transcript-page",
      entries: txEntries("assistant", "READING " + "word ".repeat(120)),
    });
    await openTranscriptDetails(wb);
    await press(wb.t, wb.renderer, "home");
    await press(wb.t, wb.renderer, "down");
    const before = wb.t.captureCharFrame();
    const span = wb.t
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("READING"));
    assert.ok(span);
    assert.deepEqual(
      [span.fg.r, span.fg.g, span.fg.b].map((v) => Math.round(v * 255)),
      hexRgb(PALETTES.find((p) => p.name === "everforest")![appearance]),
    );
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    await type(wb.t, "Quit");
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
    await wb.t.waitForFrame((frame) =>
      frame.includes("Halt live Runs and quit?"),
    );
    assert.match(wb.t.captureCharFrame(), /could not read/);
    wb.t.mockInput.pressEscape();
    await until(
      () => !wb.t.captureCharFrame().includes("Halt live Runs and quit?"),
    );
    assert.equal(wb.t.captureCharFrame(), before);
    await press(wb.t, wb.renderer, "c", { ctrl: true });
    await wb.t.waitForFrame((frame) =>
      frame.includes("Halt live Runs and quit?"),
    );
    wb.t.mockInput.pressEnter();
    await wb.t.waitForFrame(
      (frame) => !frame.includes("Halt live Runs and quit?"),
    );
    assert.equal(wb.t.captureCharFrame(), before);
    assert.deepEqual(wb.exits, []);
    await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "return");
    assert.match(wb.t.captureCharFrame(), /Session transcript/);
  });
}

test("m10-workbench-interaction: compact output inspection yields drawing and keys and returns to its selected resource", async () => {
  const wb = await mountWorkbench(inspectableRun(), 40, 12);
  wb.control.setRead("log", {
    found: true,
    type: "text",
    content: "OUTPUT\n" + "line\n".repeat(30),
  });
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /log \(text\)/);
  assert.match(wb.t.captureCharFrame(), /OUTPUT/);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Details · Resources/);
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /OUTPUT/);
});

test("m10-workbench-interaction: a five-row transcript keeps content and a visible exit hint through dual resize", async () => {
  const wb = await mountWorkbench(transcriptRun(), 40, 12);
  wb.control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("assistant", "READABLE " + "small ".repeat(100)),
    older: "c1",
  });
  await openTranscriptDetails(wb);
  await press(wb.t, wb.renderer, "home");
  await press(wb.t, wb.renderer, "down");
  const first = wb.t.captureCharFrame().split("\n")[2]!.trimEnd();
  wb.t.resize(40, 5);
  wb.renderer.resize(40, 5);
  await wb.t.renderOnce();
  assert.equal(wb.t.captureCharFrame().split("\n")[2]!.trimEnd(), first);
  assert.match(wb.t.captureCharFrame(), /esc · q quit/);
  noOverflow(wb.t.captureCharFrame(), 40);
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /Session transcript/);
});

for (const kind of ["transcript", "output"] as const) {
  test(`m10-workbench-interaction: the inline details route preserves ${kind} focus and resource selection during publication and resize`, async () => {
    const run = kind === "transcript" ? transcriptRun() : inspectableRun();
    const wb = await mountWorkbench(run, 100, 40);
    wb.control.setRead("log", {
      found: true,
      type: "text",
      content: "HELD_OUTPUT",
    });
    wb.control.setTranscript("", {
      found: true,
      type: "transcript-page",
      entries: txEntries("assistant", "HELD_TRANSCRIPT"),
    });
    await press(wb.t, wb.renderer, "d");
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      kind === "transcript" ? /HELD_TRANSCRIPT/ : /HELD_OUTPUT/,
    );
    const added = {
      name: "new-output",
      type: "text" as const,
      reference: {
        runId: "run-1",
        artifactName: "new-output",
        versionId: "new-version",
        type: "text" as const,
      },
    };
    wb.control.setRead("new-output", {
      found: true,
      type: "text",
      content: "WRONG_RESOURCE",
    });
    wb.control.setRun({ ...run, outputs: [added, ...run.outputs] });
    wb.t.resize(40, 12);
    wb.renderer.resize(40, 12);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "escape");
    assert.match(wb.t.captureCharFrame(), /Details · Resources/);
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      kind === "transcript" ? /HELD_TRANSCRIPT/ : /HELD_OUTPUT/,
    );
    assert.doesNotMatch(wb.t.captureCharFrame(), /WRONG_RESOURCE/);
    wb.t.resize(100, 40);
    wb.renderer.resize(100, 40);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "escape");
    assert.match(wb.t.captureCharFrame(), /› Details/);
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      kind === "transcript" ? /HELD_TRANSCRIPT/ : /HELD_OUTPUT/,
    );
  });
}

test("m10-session-history H2: row identity survives preview settlement, insertion and complete page replacement while paused", async () => {
  const run = runOf({
    sessions: [
      { session: "conversation", name: "Conversation", availability: "open" },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 14);
  const row = (
    id: string,
    content: string,
    source: "stored" | "preview" = "stored",
  ): SessionHistoryRow => ({
    id,
    position: id,
    source,
    turnStartedAt: "2026-10-06T00:00:00Z",
    turn: "opaque-turn",
    value: { kind: "message", role: "assistant", content },
  });
  const page = (
    rows: readonly SessionHistoryRow[],
  ): SessionHistorySnapshot => ({
    family: "session-history",
    runId: run.runId,
    session: "conversation",
    result: {
      found: true,
      history: {
        rows,
        hasEarlier: false,
        transcriptPage: {
          type: "transcript-page",
          runId: run.runId,
          session: "conversation",
        },
        transcriptExport: {
          type: "transcript-export",
          runId: run.runId,
          session: "conversation",
        },
      },
    },
  });
  const initial = Array.from({ length: 30 }, (_, index) =>
    row(`opaque-${index}`, index === 5 ? "ACTIVITY_ANCHOR" : `row-${index}`),
  );
  control.setHistory(page(initial));
  await t.renderOnce();
  await press(t, renderer, "home");
  for (let step = 0; step < 20; step++) {
    if (
      timelineLines(t.captureCharFrame())
        .find((line) => line.trim() !== "")
        ?.includes("ACTIVITY_ANCHOR")
    )
      break;
    await press(t, renderer, "down");
  }
  assert.match(
    timelineLines(t.captureCharFrame()).find((line) => line.trim() !== "") ??
      "",
    /ACTIVITY_ANCHOR/,
  );
  const firstVisible = timelineLines(t.captureCharFrame()).find(
    (line) => line.trim() !== "",
  );
  assert.ok(firstVisible);
  const inserted = row("opaque-inserted", "PREVIEW_INSERTED", "preview");
  control.setHistory(page([inserted, ...initial]));
  await t.renderOnce();
  assert.equal(
    timelineLines(t.captureCharFrame()).find((line) => line.trim() !== ""),
    firstVisible,
  );
  assert.doesNotMatch(t.captureCharFrame(), /PREVIEW_INSERTED/);
  control.setHistory(
    page([
      row("opaque-inserted", "PREVIEW_SETTLED"),
      ...initial.map((value) => ({ ...value })),
    ]),
  );
  await t.renderOnce();
  assert.equal(
    timelineLines(t.captureCharFrame()).find((line) => line.trim() !== ""),
    firstVisible,
  );
  assert.doesNotMatch(t.captureCharFrame(), /PREVIEW_SETTLED/);
  await press(t, renderer, "end");
  assert.match(t.captureCharFrame(), /row-29/);
});

test("m10-session-history: a history-only observer loss is visible and reconnect resets its viewport", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({
      sessions: [
        {
          session: "fixture-preview",
          name: "Conversation",
          availability: "open",
        },
      ],
    }),
    100,
    20,
  );
  control.setPreview("Last-known content");
  await t.renderOnce();
  control.setHistoryFreshness({
    kind: "disconnected",
    reason: "observer-lagged",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /View disconnected/);
  assert.match(frame, /Reconnect/);
  assert.match(frame, /Last-known content/);
  await press(t, renderer, "r");
  assert.deepEqual(control.reconnects, ["history"]);
  control.setHistoryFreshness({
    kind: "current",
    catchUp: "rebased",
    lastConfirmedAt: "2026-09-22T10:30:01.000Z",
  });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /View current/);
});

for (const settledAt of ["2026-10-06T00:00:03Z", "2026-10-06T00:00:00Z"])
  test(`m10-session-history: Workflow settlement at ${settledAt} appends below its conversation`, async () => {
    const run = runOf({
      timeline: [
        {
          at: settledAt,
          event: "attempt-settled",
          detail: "succeeded",
          step: "repair",
        },
      ],
      sessions: [
        { session: "s", name: "Conversation", availability: "detached" },
      ],
    });
    const { t, control } = await mountWorkbench(run, 100, 24);
    const rows: SessionHistoryRow[] = [
      {
        id: "opaque-message",
        position: "a",
        source: "stored",
        turnStartedAt: "2026-10-06T00:00:00Z",
        turn: "opaque-turn",
        step: "repair",
        value: {
          kind: "message",
          role: "assistant",
          content: "EARLIER_ASSISTANT_ANSWER",
        },
      },
      {
        id: "opaque-result",
        position: "b",
        source: "stored",
        turnStartedAt: "2026-10-06T00:00:00Z",
        turn: "opaque-turn",
        step: "repair",
        value: { kind: "turn-result", origin: "human", result: "completed" },
      },
    ];
    control.setHistory({
      family: "session-history",
      runId: run.runId,
      session: "s",
      result: {
        found: true,
        history: {
          rows,
          hasEarlier: false,
          transcriptPage: {
            type: "transcript-page",
            runId: run.runId,
            session: "s",
          },
          transcriptExport: {
            type: "transcript-export",
            runId: run.runId,
            session: "s",
          },
        },
      },
    });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    const message = frame.indexOf("EARLIER_ASSISTANT_ANSWER"),
      turn = frame.indexOf("Turn · started by you · completed"),
      workflow = frame.indexOf("Step Attempt succeeded");
    assert.ok(message >= 0 && turn > message && workflow > turn, frame);
    assert.equal(frame.match(/Step · repair/g)?.length, 1);
  });

function historyRow(
  id: string,
  content: string,
  source: "stored" | "preview" = "stored",
): SessionHistoryRow {
  return {
    id,
    position: id,
    source,
    turnStartedAt: "2026-10-06T00:00:00Z",
    turn: "opaque-turn",
    value: { kind: "message", role: "assistant", content },
  };
}
function historyPage(
  rows: readonly SessionHistoryRow[],
  hasEarlier = false,
): SessionHistorySnapshot {
  return {
    family: "session-history",
    runId: "run-1",
    session: "conversation",
    result: {
      found: true,
      history: {
        rows,
        hasEarlier,
        transcriptPage: {
          type: "transcript-page",
          runId: "run-1",
          session: "conversation",
        },
        transcriptExport: {
          type: "transcript-export",
          runId: "run-1",
          session: "conversation",
        },
      },
    },
  };
}
function firstHistoryLine(frame: string): string {
  const lines = frame.split("\n");
  return (
    lines[lines.findIndex((line) => line.includes("Timeline")) + 1] ?? ""
  ).trim();
}
function historyBadge(frame: string): number {
  const label =
    frame.split("\n").find((line) => line.includes("Timeline")) ?? "";
  return Number(label.match(/(?:▼ | · )(\d+)/)?.[1] ?? 0);
}
async function mountHistory(width: number, height = 14, input = false) {
  return mountWorkbench(
    (input ? interactiveRunOf : runOf)({
      sessions: [
        { session: "conversation", name: "Conversation", availability: "open" },
      ],
    }),
    width,
    height,
  );
}
async function seekHistoryLine(
  wb: Awaited<ReturnType<typeof mountWorkbench>>,
  expected: string,
) {
  await press(wb.t, wb.renderer, "home", { alt: true });
  for (
    let line = 0;
    line < 80 && firstHistoryLine(wb.t.captureCharFrame()) !== expected;
    line++
  )
    await press(wb.t, wb.renderer, "down", { alt: true });
  assert.equal(firstHistoryLine(wb.t.captureCharFrame()), expected);
}

for (const width of [40, 100]) {
  test(`m10-paused-history-identity H2: nonzero wrapped offset survives insertion, removal, preview update/settlement, replacement and append at ${width}`, async () => {
    const wb = await mountHistory(width);
    const anchorLine = "ACTIVITY_ANCHOR".padEnd(width - 6, "A");
    const nextLine = "OFFSET_NEXT".padEnd(width - 6, "B");
    const anchor = historyRow(
      "anchor",
      `${"P".repeat(width - 2)} ${anchorLine} ${nextLine}\nANCHOR_LAST`,
      "preview",
    );
    const initial = Array.from({ length: 30 }, (_, i) =>
      i === 5 ? anchor : historyRow(`row-${i}`, `ROW_${i}`),
    );
    wb.control.setHistory(historyPage(initial));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, anchorLine); // offset 2: role header, P line, anchor line
    const badge = historyBadge(wb.t.captureCharFrame());
    assert.equal(badge, 22); // narrow bottom cuts ROW_8; wide bottom fully shows ROW_7

    const unchanged = async (rows: readonly SessionHistoryRow[]) => {
      wb.control.setHistory(historyPage(rows));
      await wb.t.renderOnce();
      assert.equal(firstHistoryLine(wb.t.captureCharFrame()), anchorLine);
      assert.equal(historyBadge(wb.t.captureCharFrame()), badge);
      assert.doesNotMatch(wb.t.captureCharFrame(), /PREVIEW_INSERTED/);
    };
    const inserted = historyRow("inserted", "PREVIEW_INSERTED", "preview");
    await unchanged([inserted, ...initial]);
    await unchanged([
      historyRow("inserted", "PREVIEW_UPDATED", "preview"),
      ...initial,
    ]);
    await unchanged(initial.slice(1)); // remove before the surviving anchor
    await unchanged(
      initial.map((row) =>
        row.id === "anchor"
          ? {
              ...anchor,
              value: {
                kind: "message",
                role: "assistant",
                content: `${"P".repeat(width - 2)} ${anchorLine} ${nextLine}\nPREVIEW_UPDATED_LAST`,
              },
            }
          : row,
      ),
    );
    const settled: SessionHistoryRow = { ...anchor, source: "stored" };
    await unchanged(
      initial.map((row) => (row.id === "anchor" ? settled : { ...row })),
    );
    const appended = [
      ...initial.map((row) => (row.id === "anchor" ? settled : { ...row })),
      historyRow("appended", "APPENDED"),
    ];
    wb.control.setHistory(historyPage(appended));
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), anchorLine);
    assert.equal(historyBadge(wb.t.captureCharFrame()), badge + 1);
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), nextLine); // unchanged offset, not just row
    await press(wb.t, wb.renderer, "end", { alt: true });
    assert.match(wb.t.captureCharFrame(), /APPENDED/);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
    wb.control.setHistory(
      historyPage([...appended, historyRow("live", "LIVE_APPEND")]),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /LIVE_APPEND/);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
  });
}

function activityRow(id: string, description = id): SessionHistoryRow {
  return { ...historyRow(id, ""), value: { kind: "activity", description } };
}

for (const width of [40, 100]) {
  for (const fallback of [
    "tie-later",
    "nearest-earlier",
    "no-survivor",
  ] as const) {
    test(`m10-paused-history-identity: ${fallback} uses prior order, offset zero and exact badge at ${width}`, async () => {
      const wb = await mountHistory(width);
      const initial = Array.from({ length: 20 }, (_, i) =>
        i === 5
          ? historyRow(
              "old-5",
              "OFFSET_ONE\nANCHOR_OFFSET_TWO\nANCHOR_END",
              "preview",
            )
          : activityRow(`old-${i}`, `OLD_${i}`),
      );
      wb.control.setHistory(historyPage(initial));
      await wb.t.renderOnce();
      await seekHistoryLine(wb, "ANCHOR_OFFSET_TWO"); // nonzero offset 2
      const added = Array.from({ length: 15 }, (_, i) =>
        activityRow(`new-${i}`, `NEW_${i}`),
      );
      const replacement =
        fallback === "tie-later"
          ? [added[0]!, initial[7]!, initial[3]!, ...added.slice(1)]
          : fallback === "nearest-earlier"
            ? [added[0]!, initial[8]!, initial[4]!, ...added.slice(1)]
            : added;
      wb.control.setHistory(historyPage(replacement));
      await wb.t.renderOnce();
      assert.equal(
        firstHistoryLine(wb.t.captureCharFrame()),
        fallback === "tie-later"
          ? "↳ OLD_7"
          : fallback === "nearest-earlier"
            ? "↳ OLD_4"
            : "═".repeat(width === 40 ? 4 : 34) +
              " Conversation · Conversation " +
              "═".repeat(width === 40 ? 5 : 35),
      );
      // The first current row carries the Session/beginning dividers, never an activity.
      if (fallback !== "no-survivor") {
        assert.equal(
          historyBadge(wb.t.captureCharFrame()),
          width === 40
            ? fallback === "tie-later"
              ? 8
              : 7
            : fallback === "tie-later"
              ? 9
              : 8,
        );
        await press(wb.t, wb.renderer, "down", { alt: true });
        assert.equal(
          firstHistoryLine(wb.t.captureCharFrame()),
          fallback === "tie-later" ? "↳ OLD_3" : "↳ NEW_1",
        );
      } else {
        assert.equal(
          historyBadge(wb.t.captureCharFrame()),
          width === 40 ? 8 : 9,
        );
        await press(wb.t, wb.renderer, "down", { alt: true });
        assert.match(firstHistoryLine(wb.t.captureCharFrame()), /NEW_0/);
      }
    });
  }

  test(`m10-paused-history-identity: empty-to-returning and short pages remain paused; resize and shrink clamp only the row offset at ${width}`, async () => {
    const wb = await mountHistory(width);
    const anchor = historyRow(
      "anchor",
      "START\nOFFSET_ONE\nOFFSET_TWO\nOFFSET_THREE",
    );
    const initial = [
      activityRow("before", "BEFORE"),
      anchor,
      ...Array.from({ length: 20 }, (_, i) => activityRow(`tail-${i}`)),
    ];
    wb.control.setHistory(historyPage(initial));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, "OFFSET_THREE"); // offset 4
    wb.control.setHistory(historyPage([initial[0]!, anchor]));
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "OFFSET_THREE");
    assert.match(wb.t.captureCharFrame(), /Timeline · Paused/);
    const shortLines = timelineLines(wb.t.captureCharFrame())
      .slice(0, 4)
      .map((line) => line.trim());
    assert.deepEqual(shortLines, ["OFFSET_THREE", "", "", ""]);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
    await press(wb.t, wb.renderer, "up", { alt: true });
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "OFFSET_TWO");
    wb.t.resize(width === 40 ? 100 : 40, 24);
    wb.renderer.resize(width === 40 ? 100 : 40, 24);
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "OFFSET_TWO");
    wb.control.setHistory(
      historyPage([initial[0]!, historyRow("anchor", "SHRUNK_LAST")]),
    );
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "SHRUNK_LAST"); // offset clamps from 3 to 1
    wb.control.setHistory(
      historyPage([
        ...initial.slice(0, 1),
        historyRow("anchor", "SHRUNK_LAST"),
        activityRow("append", "APPENDED_WHILE_PAUSED"),
      ]),
    );
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "SHRUNK_LAST");
    wb.control.setHistory(historyPage([]));
    await wb.t.renderOnce();
    assert.match(
      firstHistoryLine(wb.t.captureCharFrame()),
      /Beginning of Run history/,
    );
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
    assert.match(wb.t.captureCharFrame(), /Timeline · Paused/);
    wb.control.setHistory(
      historyPage([
        activityRow("return", "RETURNED"),
        activityRow("after-return", "AFTER_RETURN"),
      ]),
    );
    await wb.t.renderOnce();
    assert.match(firstHistoryLine(wb.t.captureCharFrame()), /Conversation/); // earliest row, offset zero
    const returned = firstHistoryLine(wb.t.captureCharFrame());
    wb.control.setHistory(
      historyPage(
        Array.from({ length: 30 }, (_, i) =>
          i === 0
            ? activityRow("return", "RETURNED")
            : activityRow(`returned-${i}`),
        ),
      ),
    );
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), returned);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 14); // returning content never silently attached
  });
}

for (const width of [40, 100]) {
  test(`m10-paused-history-identity: 200/201-row eviction preserves an offset then falls forward from an evicted anchor at ${width}`, async () => {
    const wb = await mountHistory(width);
    const initial = Array.from({ length: 200 }, (_, i) =>
      i === 5
        ? historyRow("row-5", "ANCHOR_FIRST\nEVICTION_OFFSET\nANCHOR_LAST")
        : activityRow(`row-${i}`, `ROW_${i}`),
    );
    wb.control.setHistory(historyPage(initial));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, "EVICTION_OFFSET"); // offset 2
    assert.equal(
      historyBadge(wb.t.captureCharFrame()),
      width === 40 ? 188 : 189,
    );
    const retained = [...initial.slice(1), activityRow("row-200", "ROW_200")];
    wb.control.setHistory(historyPage(retained, true));
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "EVICTION_OFFSET");
    assert.equal(
      historyBadge(wb.t.captureCharFrame()),
      width === 40 ? 189 : 190,
    );
    await press(wb.t, wb.renderer, "home", { alt: true });
    await press(wb.t, wb.renderer, "down", { alt: true });
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.match(firstHistoryLine(wb.t.captureCharFrame()), /ROW_1/); // offset 2, below attached rules
    wb.control.setHistory(
      historyPage(
        [...retained.slice(1), activityRow("row-201", "ROW_201")],
        true,
      ),
    );
    await wb.t.renderOnce();
    assert.match(
      firstHistoryLine(wb.t.captureCharFrame()),
      /Earlier conversation is not shown/,
    ); // fallback row-2, offset zero
    assert.equal(historyBadge(wb.t.captureCharFrame()), 197);
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.match(firstHistoryLine(wb.t.captureCharFrame()), /Conversation/);
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.match(firstHistoryLine(wb.t.captureCharFrame()), /ROW_2/);
  });

  test(`m10-paused-history-identity: wheel, Alt, page navigation and explicit latest beside native prompt editing at ${width}`, async () => {
    const wb = await mountHistory(width, 20, true);
    const rows = Array.from({ length: 30 }, (_, i) =>
      historyRow(`row-${i}`, `ROW_${i}`),
    );
    wb.control.setHistory(historyPage(rows));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, "ROW_5");
    const first = firstHistoryLine(wb.t.captureCharFrame());
    await type(wb.t, "draft");
    for (const name of ["up", "down", "home", "end"]) {
      await press(wb.t, wb.renderer, name); // dispatcher lets native field own these
      assert.equal(firstHistoryLine(wb.t.captureCharFrame()), first);
    }
    wb.t.mockInput.pressKey("HOME");
    await type(wb.t, "A");
    wb.t.mockInput.pressKey("END");
    wb.t.mockInput.pressArrow("left");
    await type(wb.t, "B");
    assert.match(wb.t.captureCharFrame(), /AdrafBt/);
    await press(wb.t, wb.renderer, "up", { alt: true });
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "Assistant");
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
    const frame = wb.t.captureCharFrame();
    const y =
      frame.split("\n").findIndex((line) => line.includes("Timeline")) + 1;
    await wb.t.mockMouse.scroll(5, y, "up");
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "Assistant");
    await wb.t.mockMouse.scroll(5, y, "down");
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
    // viewport 10 at 40 columns, 9 at 100; half pages move 5 and 4 displayed lines.
    await press(wb.t, wb.renderer, "pagedown");
    assert.equal(
      firstHistoryLine(wb.t.captureCharFrame()),
      width === 40 ? "Assistant" : "ROW_7",
    );
    await press(wb.t, wb.renderer, "pageup");
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
    assert.match(wb.t.captureCharFrame(), /AdrafBt/);
    await press(wb.t, wb.renderer, "end", { alt: true });
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
    await press(wb.t, wb.renderer, "up", { alt: true });
    assert.equal(historyBadge(wb.t.captureCharFrame()), 1); // partly visible final row
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0); // deliberate downward reattachment
    wb.control.setHistory(
      historyPage([...rows, historyRow("latest", "FOLLOWED_APPEND")]),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /FOLLOWED_APPEND/);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
  });
}

test("m10-paused-history-identity: one-line viewport pages move at least one displayed line", async () => {
  const wb = await mountHistory(100, 8);
  wb.control.setHistory(
    historyPage(
      Array.from({ length: 20 }, (_, i) => historyRow(`row-${i}`, `ROW_${i}`)),
    ),
  );
  await wb.t.renderOnce();
  await seekHistoryLine(wb, "ROW_5");
  await press(wb.t, wb.renderer, "pageup");
  assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "Assistant");
  await press(wb.t, wb.renderer, "pagedown");
  assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
});

for (const width of [40, 100]) {
  test(`m10-paused-history-identity: rewrap keeps a surviving row's nonzero offset and clamps to its last line at ${width}`, async () => {
    const wb = await mountHistory(width);
    const content = `${"P".repeat(width - 2)} ${"REWRAP_OFFSET".padEnd(width - 6, "X")} ${"Z".repeat(width - 6)}`;
    const initial = [
      activityRow("before", "BEFORE"),
      historyRow("anchor", content),
      ...Array.from({ length: 20 }, (_, i) => activityRow(`after-${i}`)),
    ];
    wb.control.setHistory(historyPage(initial));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, "REWRAP_OFFSET".padEnd(width - 6, "X")); // offset 2
    wb.t.resize(width === 40 ? 100 : 40, 14);
    wb.renderer.resize(width === 40 ? 100 : 40, 14);
    await wb.t.renderOnce();
    assert.equal(
      firstHistoryLine(wb.t.captureCharFrame()),
      width === 40 ? "Z".repeat(34) : "P".repeat(34),
    );
    // The offset stays 2 despite reflow: at wide width it is the last content line.
    await press(wb.t, wb.renderer, "up", { alt: true });
    assert.equal(
      firstHistoryLine(wb.t.captureCharFrame()),
      width === 40
        ? `${"P".repeat(38)} ${"REWRAP_OFFSET".padEnd(34, "X")}`
        : "P".repeat(38),
    );
    noOverflow(wb.t.captureCharFrame(), width === 40 ? 100 : 40);
  });
}

for (const width of [40, 100]) {
  for (const owner of [
    "dialog",
    "request",
    "gate",
    "checkpoint",
    "confirmation",
    "details",
  ] as const) {
    test(`m10-paused-history-identity: ${owner} owns navigation before history at ${width}`, async () => {
      const wb = await mountHistory(width, 30, true);
      const rows = Array.from({ length: 30 }, (_, i) =>
        historyRow(`row-${i}`, `ROW_${i}`),
      );
      wb.control.setHistory(historyPage(rows));
      await wb.t.renderOnce();
      await seekHistoryLine(wb, "ROW_5");
      const badge = historyBadge(wb.t.captureCharFrame());
      const sessions = [
        {
          session: "conversation",
          name: "Conversation",
          availability: "open" as const,
        },
      ];
      if (owner === "dialog")
        await press(wb.t, wb.renderer, "p", { ctrl: true });
      else if (owner === "request") wb.control.setLive(requestOverlay());
      else if (owner === "gate") wb.control.setRun(freeTextRunOf({ sessions }));
      else if (owner === "checkpoint")
        wb.control.setRun(blockedRunOf({ sessions }));
      else if (owner === "confirmation")
        await press(wb.t, wb.renderer, "e", { ctrl: true });
      else await press(wb.t, wb.renderer, "g", { ctrl: true });
      await wb.t.renderOnce();
      for (const key of ["end", "home", "up", "down"])
        await press(wb.t, wb.renderer, key, { alt: true });
      await press(wb.t, wb.renderer, "pagedown");
      await wb.t.mockMouse.scroll(5, 6, "down");
      await wb.t.renderOnce();
      assert.deepEqual(wb.control.ends, []);
      assert.deepEqual(wb.control.sends, []);
      assert.deepEqual(wb.control.texts, []);
      if (owner === "dialog") {
        wb.t.mockInput.pressEscape();
        await wb.t.waitForFrame((frame) => !frame.includes("Commands"));
      } else if (owner === "confirmation")
        await press(wb.t, wb.renderer, "escape");
      else if (owner === "details") await press(wb.t, wb.renderer, "d");
      else {
        wb.control.setLive(undefined);
        wb.control.setRun(interactiveRunOf({ sessions }));
        await wb.t.renderOnce();
      }
      assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
      assert.equal(historyBadge(wb.t.captureCharFrame()), badge);
      if (owner === "confirmation")
        assert.doesNotMatch(
          wb.t.captureCharFrame(),
          /End this interactive Step/,
        );
    });
  }
}

test("m10-session-history: tool rows expose color-independent outcomes, input and counts through the Renderer Port", async () => {
  const run = runOf({
    sessions: [{ session: "s", name: "Conversation", availability: "open" }],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 44);
  const row = (
    id: string,
    value: SessionHistoryRow["value"],
  ): SessionHistoryRow => ({
    id,
    position: id,
    source: "stored",
    turn: "turn",
    turnStartedAt: "2026-10-06T00:00:00Z",
    value,
  });
  const values: SessionHistoryRow["value"][] = [
    {
      kind: "tool",
      tool: "read",
      input: "file.ts",
      count: { value: 0, unit: "lines" },
      outcome: { kind: "running" },
    },
    {
      kind: "tool",
      tool: "search",
      input: "needle",
      count: { value: 2, unit: "matches" },
      outcome: { kind: "completed" },
    },
    {
      kind: "tool",
      tool: "command",
      input: "run command",
      outcome: { kind: "failed", error: "Observed error" },
    },
    {
      kind: "tool",
      tool: "file-change",
      input: "changed.ts",
      outcome: { kind: "declined", reason: "Observed refusal" },
    },
    {
      kind: "tool",
      tool: "mcp",
      input: "external/tool",
      outcome: { kind: "unconfirmed" },
    },
  ];
  const page = (
    rows: readonly SessionHistoryRow[],
  ): SessionHistorySnapshot => ({
    family: "session-history",
    runId: run.runId,
    session: "s",
    result: {
      found: true,
      history: {
        rows,
        hasEarlier: false,
        transcriptPage: {
          type: "transcript-page",
          runId: run.runId,
          session: "s",
        },
        transcriptExport: {
          type: "transcript-export",
          runId: run.runId,
          session: "s",
        },
      },
    },
  });
  const rows = values.map((value, i) => row(`opaque-${i}`, value));
  control.setHistory(page(rows));
  await t.renderOnce();
  const frame = t.captureCharFrame();
  for (const label of [
    "read · running · 0 lines",
    "search · completed · 2 matches",
    "command · failed",
    "file change · declined",
    "mcp · unconfirmed",
    "file.ts",
    "needle",
    "Observed error",
    "Observed refusal",
  ])
    assert.ok(frame.includes(label), label);
  const long = row("opaque-long", {
    kind: "tool",
    tool: "other",
    input: "START " + "界".repeat(60) + " END",
    outcome: { kind: "unconfirmed" },
  });
  control.setHistory(page([...rows, long]));
  t.resize(40, 14);
  renderer.resize(40, 14);
  await t.renderOnce();
  await press(t, renderer, "end", { alt: true });
  assert.match(t.captureCharFrame(), /END/);
  assert.doesNotMatch(t.captureCharFrame(), /START.*END/);
  await press(t, renderer, "home", { alt: true });
  assert.match(t.captureCharFrame(), /read/);
});
