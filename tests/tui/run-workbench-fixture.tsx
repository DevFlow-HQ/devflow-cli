import { PALETTES } from "./palette-expectations.js";
import type { PreferencesView } from "../../src/tui/tui.js";
import { inertPreferencesView } from "./inert.js";
import assert from "node:assert/strict";
import { mountRenderer } from "./renderer-fixture.js";
import { createSignal, onCleanup } from "solid-js";
import { App } from "../../src/tui/tui.js";
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
  RunActionsView,
  RunLaunchView,
  RunWorkbenchView,
  TRunViewFreshness,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, type FakeRenderer } from "./renderer-fixture.js";
import type {
  AnswerHumanGateOffer,
  ChangeModelChoiceOffer,
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

export function makeRunView(initial: RunSnapshot) {
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
  const historyOpens: string[] = [];
  const historyActive = new Set<string>();
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
  // Every captured write gets an independent receipt, including concurrent sends.
  const interactiveReceipts: ReturnType<typeof createSignal<AnswerOutcome>>[] =
    [];
  type SteerOutcome = ReturnType<ReturnType<RunWorkbenchView["steer"]>>;
  const steerReceipts: ReturnType<typeof createSignal<SteerOutcome>>[] = [];
  const receipt = (receipts: typeof interactiveReceipts) => {
    const outcome = createSignal<AnswerOutcome>({ kind: "pending" });
    receipts.push(outcome);
    return outcome[0];
  };
  const setInteractiveOutcome = (
    outcome: AnswerOutcome,
    index = interactiveReceipts.length - 1,
  ) => interactiveReceipts[index]?.[1](outcome);
  const setSteerOutcome = (
    outcome: AnswerOutcome,
    index = steerReceipts.length - 1,
  ) =>
    steerReceipts[index]?.[1]((previous) => ({
      ...outcome,
      steerId: previous.steerId,
    }));
  const sends: { runId: string; stepId: string; text: string }[] = [];
  const followUps: { runId: string; turnId: string; text: string }[] = [];
  const ends: { runId: string; stepId: string }[] = [];
  const continues: { runId: string; stepId: string }[] = [];
  const endStages: { runId: string; stepId: string }[] = [];
  const steers: { runId: string; turnId: string; text: string }[] = [];
  const texts: { gate: RunGateReference; text: string }[] = [];
  const requests: {
    requestId: string;
    generation: number;
    decision: "allow" | "deny";
  }[] = [];
  const view: RunWorkbenchView = {
    async searchWorkspacePaths() {
      return { status: "available", candidates: [] };
    },
    openRun: () => ({
      snapshot,
      live,
      freshness,
      reconnect: () => reconnects.push("reconnect"),
    }),
    openHistory(runId, session) {
      historyOpens.push(session);
      historyActive.add(session);
      onCleanup(() => historyActive.delete(session));
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
      return receipt(interactiveReceipts);
    },
    sendFollowUpTurn: (offer, text) => {
      followUps.push({ runId: offer.runId, turnId: offer.turnId, text });
      return receipt(interactiveReceipts);
    },
    endInteractiveStep: (runId, stepId) => {
      ends.push({ runId, stepId });
      return receipt(interactiveReceipts);
    },
    continueRepeat: (runId, stepId) => {
      continues.push({ runId, stepId });
      return receipt(interactiveReceipts);
    },
    endStage: (runId, stepId) => {
      endStages.push({ runId, stepId });
      return receipt(interactiveReceipts);
    },
    steer: (runId, turnId, text) => {
      steers.push({ runId, turnId, text });
      const outcome = createSignal<SteerOutcome>({
        kind: "pending",
        steerId: `fixture-steer-${steerReceipts.length}`,
      });
      steerReceipts.push(outcome);
      return outcome[0];
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
    historyOpens,
    historyActive,
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
    steerId(index = steerReceipts.length - 1) {
      const receipt = steerReceipts[index];
      assert.ok(receipt, "Steer receipt exists");
      return receipt[0]().steerId;
    },
    setRequestOutcome,
    setGateOutcome,
  };
}

export function snapshotOf(run: RunView): RunSnapshot {
  return { family: "run", runId: run.runId, result: { found: true, run } };
}

export function runOf(over: Partial<RunView> = {}): RunView {
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

export function events(count: number): RunTimelineEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    at: `T${String(index).padStart(3, "0")}`,
    event: "attempt-settled",
    detail: `e${index}`,
  }));
}

/** Rows whose detail is wider than a 60-column Workbench, so each wraps. */
export function wrappingEvents(count: number): RunTimelineEvent[] {
  return events(count).map((event, index) => ({
    ...event,
    detail: `e${index} ${"lorem ipsum ".repeat(5).trim()}`,
  }));
}

/** The conversation's lines: the headerless Workbench starts its conversation on
 *  the first row inside its padding when no notice leads it (ADR 0036). */
export function timelineLines(frame: string): string[] {
  return frame.split("\n").slice(1);
}

/** The conversation column's wrapped text joined back into one string: above
 *  120 columns the 42-column sidebar shares its rows, so only the column counts. */
export function conversationText(frame: string, width: number): string {
  const column = width > 120 ? width - 43 : width;
  return frame
    .split("\n")
    .map((line) => line.slice(0, column).trim())
    .join(" ");
}

/** The Workbench still holds the screen: Home and Previous Runs never draw
 *  inside it, and it never names them. */
export function onWorkbench(frame: string): boolean {
  return !/Start a Run|Previous Runs/.test(frame);
}

/** Start a Run's Review has handed over to the Workbench. */
export function workbenchShown(frame: string): boolean {
  return !frame.includes("enter start") && frame.trim() !== "";
}

// --- blocked-Run fixtures (#92) --------------------------------------------

export const GATE: RunGateReference = {
  runId: "run-1",
  stepId: "work",
  attemptId: "a9",
  shape: "approve-reject",
};

export const ANSWER_OFFER: AnswerHumanGateOffer = {
  action: "answer-human-gate",
  gate: GATE,
  basis: "durable Human Gate",
  continueConsequence:
    "continue: grant one more review interval and resume the Run.",
  stopConsequence:
    "stop: end the Run failed, keeping its history and Artifacts.",
};

export function checkpointOf(
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
export function blockedRunOf(over: Partial<RunView> = {}): RunView {
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
export async function mountApp(
  control: { readonly view: RunWorkbenchView },
  renderer: FakeRenderer,
  launchRunId: string,
  width: number,
  height: number,
  actions?: RunActionsView,
  reducedMotion = false,
  ownedLiveRuns: number | "unavailable" = 0,
  preferences: PreferencesView = inertPreferencesView(),
  observeLayout?: Parameters<typeof App>[0]["observeLayout"],
) {
  const exits: unknown[] = [];
  const t = await mountRenderer(
    () => (
      <App
        observeLayout={observeLayout}
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

export async function mountWorkbench(
  run: RunView,
  width = 100,
  height = 40,
  actions?: RunActionsView,
  reducedMotion = false,
  ownedLiveRuns?: number | "unavailable",
  preferences?: PreferencesView,
  observeLayout?: Parameters<typeof App>[0]["observeLayout"],
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
    observeLayout,
  );
  await t.waitForFrame(workbenchShown);
  return { t, control, renderer, exits };
}

export async function press(
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
export async function type(
  t: {
    renderOnce: () => Promise<void>;
    mockInput: { typeText: (text: string) => Promise<void> };
  },
  text: string,
) {
  await t.mockInput.typeText(text);
  await t.renderOnce();
}

export function noOverflow(frame: string, width: number) {
  for (const line of frame.split("\n")) {
    assert.ok(
      line.trimEnd().length <= width,
      `overflow at ${width}: ${JSON.stringify(line)}`,
    );
  }
}

export const PROGRESS: RunStepProgress[] = [
  { id: "plan", kind: "agent", status: "succeeded" },
  { id: "build", kind: "command", status: "running" },
  { id: "ship", kind: "command", status: "pending" },
];

/** Each divider line in `lines` as `<glyph> <title>`: a rule of one glyph with the
 *  title centred in it. */
export function dividers(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const match = /^\s*([─═])\1* (.+?) \1+\s*$/.exec(line);
    return match === null ? [] : [`${match[1]} ${match[2]}`];
  });
}

// --- reference inspection (AC4) --------------------------------------------

/** A Run with one Session `s` that advertises transcript References (#124). */
export function transcriptRun() {
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
export function txEntries(role: "user" | "assistant", ...contents: string[]) {
  return contents.map((content) => ({
    id: `${role}:${content}`,
    session: "s",
    role,
    content,
  }));
}

// --- Run Actions: resume / cancel / delete (#92 ticket, AC3) ---------------

export const RESUME_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: true as const,
  consequence: "resume: continue from the Step the Run stopped at.",
};

export const CANCEL_OFFER = {
  action: "cancel-run" as const,
  runId: "run-1",
  consequence: "end the live Run cancelled, keeping its history and Artifacts.",
};

export const DELETE_OFFER = {
  action: "delete-run" as const,
  runId: "run-1",
  consequence: "remove the Run and its stored history and Artifacts from disk.",
};

// A resume that arms an acknowledgement (#194 story 39) and one the Port marks
// unavailable (#194 story 40).
export const RESUME_ACK_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: true as const,
  consequence: "resume: continue from the Step the Run stopped at.",
  acknowledgement:
    "the interrupted command may have already run — resuming re-runs this Step, so its effects may repeat.",
};

export function okActions(over: Partial<RunActionsView> = {}): RunActionsView {
  return {
    resume: () => () => ({ kind: "ok" }),
    cancel: () => () => ({ kind: "ok" }),
    remove: () => () => ({ kind: "ok" }),
    interrupt: () => () => ({ kind: "ok" }),
    changeModelChoice: () => () => ({ kind: "ok" }),
    ...over,
  };
}

// --- interactive-agent turn-taking (#122) ----------------------------------

export const SEND_OFFER: SendInteractiveTurnOffer = {
  action: "send-interactive-turn",
  runId: "run-1",
  stepId: "discuss",
  basis: "interactive Turn",
  consequence: "send the typed text as one human Turn in the Step's Session.",
};

export const END_OFFER: EndInteractiveStepOffer = {
  action: "end-interactive-step",
  runId: "run-1",
  stepId: "discuss",
  consequence: "end the interactive Step succeeded and advance the Run.",
};

/** A Run blocked at an interactive-agent Step at a Turn boundary (send + end
 *  offered). Omit the offers via `actionOffers: []` to model a live Turn. */
export function interactiveRunOf(over: Partial<RunView> = {}): RunView {
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
export function requestOverlay(
  generation = 3,
  requestId = "req-1",
): RunLiveOverlay {
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
export const INTERRUPT_OFFER = {
  action: "interrupt-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  consequence:
    "stop the live Turn; the agent then waits for your next message in the same Session.",
};

export const STEER_OFFER = {
  action: "steer-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  available: false as const,
  reason: "Claude Code has no same-Turn steer",
};

export function liveTurnRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "running",
    progress: [{ id: "repair", kind: "agent", status: "running" }],
    actionOffers: [INTERRUPT_OFFER, STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

// --- human-controlled Repeat Continue (#217) -------------------------------

export const CONTINUE_OFFER: ContinueRepeatOffer = {
  action: "continue-repeat",
  runId: "run-1",
  stepId: "discuss",
  consequence:
    "this does not close the ticket; a fresh Session reads the tracker again and may choose it while it is still open.",
};

// --- human-controlled Repeat End Stage (#218) ------------------------------

export const END_STAGE_OFFER: EndStageOffer = {
  action: "end-stage",
  runId: "run-1",
  stepId: "discuss",
  consequence:
    "Secant has not checked the tracker. This ends the stage as complete; use it only after you and the agent verified the tickets are done.",
};

// --- live interactive Turn interrupt (#219) --------------------------------

/** A human Turn is live in the interactive Step: the Run reads `running`, the
 *  boundary offers are gone, and the live-Turn interrupt (and steer) are offered. */
export function liveInteractiveRunOf(over: Partial<RunView> = {}): RunView {
  return interactiveRunOf({
    state: "running",
    actionOffers: [INTERRUPT_OFFER, STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

export const FREE_TEXT_GATE: RunGateReference = {
  runId: "run-1",
  stepId: "ask",
  attemptId: "a1",
  shape: "free-text",
};

export const FREE_TEXT_OFFER: AnswerHumanGateOffer = {
  action: "answer-human-gate",
  gate: FREE_TEXT_GATE,
  basis: "durable Human Gate",
  continueConsequence: "",
  stopConsequence: "",
  textConsequence: "publish the text as the gate's output and advance the Run.",
};

export function freeTextRunOf(over: Partial<RunView> = {}): RunView {
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

// #213: suggested free-text gate ------------------------------------

export function suggestedRunOf(): RunView {
  return freeTextRunOf({
    pendingGate: {
      gate: FREE_TEXT_GATE,
      message: "Where should the spec live?",
      outputArtifactName: "tracker",
      suggestions: ["Local", "GitHub"],
    },
  });
}

// A live Turn under a Harness that declares native steer (Codex): Enter in the
// always-editable prompt sends guidance (#148, ADR 0036).
export const AVAILABLE_STEER_OFFER = {
  action: "steer-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  available: true as const,
  consequence:
    "send same-Turn guidance to the running agent without ending the Turn.",
};

// --- Steer from the interactive input (#294) -------------------------------

/** A live human Turn in the interactive Step under a Harness that declares steer. */
export function steerableInteractiveRunOf(
  over: Partial<RunView> = {},
): RunView {
  return liveInteractiveRunOf({
    actionOffers: [INTERRUPT_OFFER, AVAILABLE_STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

// The Workbench Model-choice scenario (#351) runs in the canonical three-OS suite.
export const MODEL_OFFER = {
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

/** Mount a Run with a Model choice Offer; test-specific facts stay with the caller. */
export function mountModelChoice({
  offer,
  run = {},
  width = 100,
  height = 40,
  actions,
}: {
  offer: ChangeModelChoiceOffer;
  run?: Partial<RunView>;
  width?: number;
  height?: number;
  actions?: RunActionsView;
}) {
  return mountWorkbench(
    runOf({ ...run, actionOffers: [offer] }),
    width,
    height,
    actions,
  );
}

/** Open the shared Model choice picker through the palette's Model or Effort App
 *  command (ADR 0040), the successor of the retired details `m` key. */
export async function openModelChoice(
  t: Parameters<typeof type>[0],
  renderer: FakeRenderer,
  command: "Model" | "Effort" = "Model",
  route: "palette" | "/model" | "/effort" = "palette",
) {
  if (route !== "palette") {
    await type(t, route);
    await press(t, renderer, "return");
    return;
  }
  await press(t, renderer, "p", { ctrl: true });
  await type(t, command);
  await press(t, renderer, "down");
  await press(t, renderer, "return");
}

// --- inspection quit (#392) -------------------------------------------------

// The inspection footer advertises `q quit`; q there takes the same guarded Exit as
// the Workbench's own q, while every other bare letter stays inside the overlay.
// Scripted Projection and Renderer values cover this client contract; no Harness.

/** A Run offering resume, cancel and delete, with one text output and one Session
 *  transcript, so every Run-action letter has something to leak to. */
export function inspectableRun(): RunView {
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

export async function mountInspectable(ownedLiveRuns?: number | "unavailable") {
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
export const INSPECTIONS = [
  {
    kind: "output",
    title: /log \(text\)/,
    footer: /↑\/↓ scroll · esc close · q quit/,
    open: async (wb: Awaited<ReturnType<typeof mountInspectable>>) => {
      await press(wb.t, wb.renderer, "g", { ctrl: true }); // details focus, log selected
      await press(wb.t, wb.renderer, "return");
    },
    reopen: "return", // Escape leaves the details focus on the log
  },
  {
    kind: "transcript",
    title: /Session transcript/,
    footer: /p older · e export · esc close · q quit/,
    open: async (wb: Awaited<ReturnType<typeof mountInspectable>>) => {
      await press(wb.t, wb.renderer, "g", { ctrl: true });
      await press(wb.t, wb.renderer, "down");
      await press(wb.t, wb.renderer, "return");
    },
    reopen: "return",
  },
] as const;

export function previewPreferences(): PreferencesView {
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

export async function openAppThemes(
  wb: Awaited<ReturnType<typeof mountWorkbench>>,
) {
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, "Themes");
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /Themes ·/);
}

export const hexRgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/** Open the Session reader through focused details, including below panel breakpoints. */
export async function openTranscriptDetails(
  wb: Awaited<ReturnType<typeof mountWorkbench>>,
) {
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  await press(wb.t, wb.renderer, "return");
}

/** The frame row a control begins on, found by its heading. */
export function rowOf(frame: string, heading: RegExp): number {
  return frame.split("\n").findIndex((line) => heading.test(line));
}

/** Resize the captured terminal and the Port that drives Workbench layout. */
export function resizeWorkbench(
  t: Pick<Awaited<ReturnType<typeof mountRenderer>>, "resize">,
  renderer: FakeRenderer,
  width: number,
  height: number,
) {
  t.resize(width, height);
  renderer.resize(width, height);
}
