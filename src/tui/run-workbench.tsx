import { latestFailure } from "../application/projection-port.js";
import { useRenderer } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import {
  createEffect,
  createMemo,
  mapArray,
  createSignal,
  For,
  Index,
  onCleanup,
  on,
  Show,
  Switch,
  Match,
  type Accessor,
} from "solid-js";
import type {
  AnswerHumanGateOffer,
  CancelRunOffer,
  DeleteRunOffer,
  ContinueRepeatOffer,
  EndInteractiveStepOffer,
  EndStageOffer,
  InterruptTurnOffer,
  Problem,
  ResumeRunOffer,
  RunCheckpointView,
  SteerTurnOffer,
  RunView,
  SendFollowUpTurnOffer,
  SendInteractiveTurnOffer,
} from "../application/projection-port.js";
import type { RendererKeyEvent, RendererPort } from "./renderer/renderer.js";
import {
  createDraftControl,
  followUpOfferOf,
  interactiveStep,
} from "./run-draft-control.js";
import { createHistoryViewport } from "./run-history-viewport.js";
import { createPromptCompletion } from "./run-prompt-completion.js";
import { useAppCommands, type AppCommand } from "./app-commands.js";
import { clip } from "./clip.js";
import {
  useRunActionsView,
  type RunActionOutcome,
} from "./run-actions-view.js";
import { useRunWorkbenchView, type AnswerOutcome } from "./run-view.js";
import {
  createInspection,
  InspectionView,
  type Openable,
} from "./run-inspection.js";
import {
  createTranscriptReader,
  TranscriptReaderView,
  type TranscriptTarget,
} from "./run-transcript.js";
import { followSettlement } from "./run-control-effects.js";
import {
  createRequestControl,
  HarnessRequestControl,
  REQUEST_HEIGHT,
  type LiveRequest,
} from "./run-request-control.js";
import {
  createGateControl,
  FreeTextGateControl,
  gateHeight,
  type FreeTextGate,
} from "./run-gate-control.js";
import {
  buildDetailsRows,
  buildSidebarRows,
  CheckpointInteraction,
  DetailsPanel,
  PromptControl,
  HistoryLine,
  promptHeight,
  modelChoiceText,
  restingLines,
  RestingView,
  Sidebar,
  SIDEBAR_WIDTH,
  type DetailsRow,
  type RestingState,
  type PromptHint,
  type PromptModel,
} from "./run-workbench-views.js";
import { SCROLL_KEYS } from "./run-timeline.js";
import { reportedMetadata } from "./run-timeline-rows.js";
import { wrap } from "./wrap.js";
import { createModelChoiceControl } from "./run-model-choice.js";
import { useExit } from "./vendor/exit.js";
import { useDialog } from "./vendor/dialog.js";
import { useTheme } from "./vendor/theme-context.js";

// The Run Workbench (ADR 0036): one agent screen for one Run. The conversation
// fills a headerless column; above 120 columns a 42-column sidebar carries the
// Bundle, Steps, Harness, Model choice, and reported context, and at 120 or less
// the prompt's meta row carries the current Step, Session, and Model choice. It is
// the one screen that takes its keys, size, and resize from the Renderer Port
// (A13), so a single raw-key pipeline drives every control.
//
// Exactly one bottom interaction holds the bottom region (H1): a Harness Request,
// a Human Gate, a Review checkpoint, a resting Run's view, or the ordinary
// always-editable prompt. `interaction` resolves it once; height accounting,
// rendering, focus, key dispatch, hints, and App-command availability all read
// that value instead of re-deciding from the same flags. Dialogs are a separate
// focus layer above it, and the request and gate controls keep their private
// behaviour in their own files.
//
// History scrolling owns opaque row identity, displayed-line offsets and row
// badges. OpenTUI draws the window; Application supplies complete retained pages.

/** The details panel needs this much width across to show inline. */
const DETAILS_MIN_WIDTH = 60;
/** Below this conversation width the panel drops its long executable path. */
const DETAILS_COMPACT_WIDTH = 80;
/** Above this terminal width the sidebar shows (ADR 0036). */
const SIDEBAR_BREAKPOINT = 120;
/** Columns a wrapped timeline row's continuation lines indent by, two past the
 *  row's own indent, so a row's lines read as one activity (#288). */
/** Rows the Review checkpoint interaction holds: the heading with its message,
 *  the cadence-and-evidence line, two controls each with their consequence line,
 *  and a status/hint line. */
const CHECKPOINT_HEIGHT = 7;
/** The prompt grows with its draft's lines up to this many rows. */
const PROMPT_MAX_FIELD_ROWS = 4;
/** Hint rows indent under the field's `> ` prefix. */
const HINT_INDENT = "  ";

type TAvailableResume = Extract<ResumeRunOffer, { available: true }>;
type TConfirmation =
  | {
      readonly kind: "takeover" | "acknowledge";
      readonly offer: TAvailableResume;
    }
  | { readonly kind: "cancel"; readonly offer: CancelRunOffer }
  | { readonly kind: "delete"; readonly offer: DeleteRunOffer }
  | { readonly kind: "end-step"; readonly offer: EndInteractiveStepOffer }
  | { readonly kind: "continue"; readonly offer: ContinueRepeatOffer }
  | { readonly kind: "end-stage"; readonly offer: EndStageOffer };
type TConfirmationOffer = TConfirmation["offer"] | InterruptTurnOffer;

// Only coordinates exposed by the Projection Port participate in identity.
// Step endings carry no Attempt coordinate. Copy and consequences stay captured.
function confirmationTarget(offer: TConfirmationOffer): string {
  switch (offer.action) {
    case "resume-run":
      return JSON.stringify([
        offer.action,
        offer.runId,
        offer.takeover?.ownerPid,
        offer.acknowledgement,
      ]);
    case "interrupt-turn":
      return JSON.stringify([offer.action, offer.runId, offer.turnId]);
    case "end-interactive-step":
    case "continue-repeat":
    case "end-stage":
      return JSON.stringify([offer.action, offer.runId, offer.stepId]);
    case "cancel-run":
    case "delete-run":
      return JSON.stringify([offer.action, offer.runId]);
    default: {
      const exhaustive: never = offer;
      return exhaustive;
    }
  }
}

/** Whether a confirmation shows and is answered in the prompt's hint rows, rather
 *  than in the details panel that owns the Run lifecycle actions. */
function promptBound(
  kind: TConfirmation["kind"],
): kind is "end-step" | "continue" | "end-stage" {
  return kind === "end-step" || kind === "continue" || kind === "end-stage";
}

/** The Step endings the prompt offers at a Turn boundary (#217, #218). */
interface TStepEndings {
  readonly end?: EndInteractiveStepOffer;
  readonly continue?: ContinueRepeatOffer;
  readonly endStage?: EndStageOffer;
}

/** What Enter does with the prompt's draft now, from the current Offers. */
type TPromptSend =
  | { readonly kind: "turn"; readonly offer: SendInteractiveTurnOffer }
  | { readonly kind: "follow-up"; readonly offer: SendFollowUpTurnOffer }
  | { readonly kind: "steer"; readonly offer: SteerTurnOffer }
  | { readonly kind: "none" };

/** The one bottom interaction (H1, ADR 0036), each variant carrying the data its
 *  readers need. Precedence: a Harness Request, then a Human Gate or Review
 *  checkpoint, then a resting Run (from its authoritative durable state), then
 *  the ordinary prompt. */
type TInteraction =
  | { readonly kind: "request"; readonly request: LiveRequest }
  | { readonly kind: "gate"; readonly gate: FreeTextGate }
  | {
      readonly kind: "checkpoint";
      readonly checkpoint: RunCheckpointView;
      readonly offer: AnswerHumanGateOffer;
    }
  | {
      readonly kind: "resting";
      readonly run: RunView;
      readonly state: RestingState;
    }
  | {
      readonly kind: "prompt";
      readonly send: TPromptSend;
      /** The live Turn's Interrupt: present exactly while the agent works. */
      readonly working: InterruptTurnOffer | undefined;
      /** Step endings, offered only at a Turn boundary with no Operation in flight. */
      readonly endings: TStepEndings;
      /** What a Run resting at a gate or checkpoint without a current answer Offer
       *  waits on, said in the prompt's note while its control waits. */
      readonly waiting?: string;
    };

type TActionOperation = "resume" | "cancel" | "delete" | "interrupt";
type TAppliedActionOperation = Exclude<TActionOperation, "delete">;

type TActionReceipt =
  | { readonly kind: "pending"; readonly operation: TActionOperation }
  | { readonly kind: "applied"; readonly operation: TAppliedActionOperation };

const PENDING_ACTION_COPY: Record<TActionOperation, string> = {
  resume: "Checking resume",
  cancel: "Cancelling Run",
  delete: "Deleting Run",
  interrupt: "Interrupting Turn",
};

const APPLIED_ACTION_COPY: Record<TAppliedActionOperation, string> = {
  resume: "Resume applied",
  cancel: "Run cancelled",
  interrupt: "Turn interrupted",
};

/** An applied receipt leaves on the next key, which still reaches its recipient. */
function actionReceiptText(receipt: TActionReceipt): string {
  return receipt.kind === "pending"
    ? PENDING_ACTION_COPY[receipt.operation]
    : `${APPLIED_ACTION_COPY[receipt.operation]} · any key dismisses`;
}

type Focus = "bottom" | "details";

export function RunWorkbench(props: {
  runId: string;
  knownBundleName?: string;
  renderer: RendererPort;
  /** Draw the working scanner as the static `[⋯]` (#292). */
  reducedMotion: boolean;
  onLeave: () => void;
  onDeleted: (name: string) => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const commands = useAppCommands();
  const terminalRenderer = useRenderer();
  const view = useRunWorkbenchView();
  const actions = useRunActionsView();
  const opened = view.openRun(props.runId);
  const snapshot = opened.snapshot;
  const live = opened.live;
  const runFreshness = opened.freshness;

  const [dims, setDims] = createSignal(props.renderer.size());
  onCleanup(
    props.renderer.onResize((width, height) => setDims({ width, height })),
  );

  const run = (): RunView | undefined => {
    const result = snapshot().result;
    return result.found ? result.run : undefined;
  };
  const sessionSelection = createMemo(() => {
    const current = run();
    if (current === undefined)
      return { current: undefined, working: undefined, step: undefined };
    const step = current.progress[current.position]?.id;
    const timeline = [...current.timeline].reverse();
    const latest = timeline.find((event) => event.event === "turn-started");
    const started =
      step === undefined
        ? undefined
        : timeline.find(
            (event) => event.event === "turn-started" && event.step === step,
          );
    const stepSession = started?.session ?? started?.detail;
    const latestSession = latest?.session ?? latest?.detail;
    return {
      current:
        stepSession ?? latestSession ?? current.sessions?.at(-1)?.session,
      working: live() === undefined ? undefined : latestSession,
      step: stepSession,
    };
  });
  const historyFollowers = mapArray(
    () => {
      const selected = sessionSelection();
      return [
        ...new Set(
          [selected.current, selected.working].filter(
            (session): session is string => session !== undefined,
          ),
        ),
      ];
    },
    (session) => ({
      session,
      followed: view.openHistory(props.runId, session),
    }),
  );
  const freshness = () => {
    const current = runFreshness();
    if (current.kind !== "current") return current;
    return (
      historyFollowers()
        .map(({ followed }) => followed.freshness())
        .find((health) => health.kind !== "current") ?? current
    );
  };
  const histories = () =>
    historyFollowers().flatMap(({ session, followed }) => {
      const result = followed.snapshot().result;
      const name =
        run()?.sessions?.find((row) => row.session === session)?.name ??
        session;
      return result.found ? [{ name, session, history: result.history }] : [];
    });
  const viewCurrent = () => freshness().kind === "current";
  const actionableRun = () => (viewCurrent() ? run() : undefined);
  const notFound = (): Problem | undefined => {
    const result = snapshot().result;
    return result.found ? undefined : result.problem;
  };
  let observedRunName = props.knownBundleName;
  createEffect(() => {
    const result = snapshot().result;
    if (result.found) {
      observedRunName = result.run.bundle.name;
      return;
    }
    if (freshness().kind === "current" && observedRunName !== undefined) {
      props.onDeleted(observedRunName);
    }
  });

  const answerOffer = createMemo<AnswerHumanGateOffer | undefined>(() =>
    actionableRun()?.actionOffers.find(
      (offer): offer is AnswerHumanGateOffer =>
        offer.action === "answer-human-gate",
    ),
  );

  // The approval Harness Request and free-text Human Gate controls, each in its own
  // private file (A33): the request/gate state, its self-contained key branch, and
  // its view live there; the Workbench reaches them through the interaction.
  const requestControl = createRequestControl({
    live: () => (viewCurrent() ? live() : undefined),
    answerRequest: (offer, decision) => view.answerRequest(offer, decision),
  });
  const gateControl = createGateControl({
    run: actionableRun,
    answerOffer,
    answerText: (gate, text) => view.answerText(gate, text),
    onLeave: props.onLeave,
  });

  const [focus, setFocus] = createSignal<Focus>("bottom");
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  const [selectedResource, setSelectedResource] = createSignal<
    Openable | TranscriptTarget
  >();
  const [control, setControl] = createSignal<"continue" | "stop">("continue");
  const [answerOutcome, setAnswerOutcome] =
    createSignal<Accessor<AnswerOutcome>>();
  const [answerRefusal, setAnswerRefusal] = createSignal<Problem | undefined>();

  // Every Offer a Workbench control reads: a control renders — and its key
  // dispatches — iff its Offer is present, legality decided inside Secant, so the
  // Workbench never re-derives it.
  const offers = createMemo(() => {
    const list = actionableRun()?.actionOffers ?? [];
    const find = <TAction extends (typeof list)[number]["action"]>(
      action: TAction,
    ) =>
      list.find(
        (offer): offer is Extract<(typeof list)[number], { action: TAction }> =>
          offer.action === action,
      );
    return {
      modelChoice: find("change-model-choice"),
      resume: find("resume-run"),
      cancel: find("cancel-run"),
      remove: find("delete-run"),
      interrupt: find("interrupt-turn"),
      steer: find("steer-turn"),
      send: find("send-interactive-turn"),
      followUp: find("send-follow-up-turn"),
      end: find("end-interactive-step"),
      // A human-controlled Repeat offers Continue in End Step's place (#217), and
      // End Stage beside it (#218).
      continue: find("continue-repeat"),
      endStage: find("end-stage"),
    };
  });

  const [actionRefusal, setActionRefusal] = createSignal<Problem | undefined>();
  const [confirmation, setConfirmation] = createSignal<TConfirmation>();
  const pending = () => confirmation()?.kind;
  // A dispatched Run Action followed to settlement: resume drives execution and a
  // cancel-as-abort aborts a live Run, both asynchronous (#98), so the outcome
  // starts `pending` and the effect below reports it. A second dispatch while one
  // is in flight is ignored.
  const [actionFlight, setActionFlight] = createSignal<{
    readonly op: TActionOperation;
    readonly outcome: Accessor<RunActionOutcome>;
  }>();
  const [actionReceipt, setActionReceipt] = createSignal<TActionReceipt>();
  // The Interrupt is two Esc presses while a Turn works: the first arms it against
  // the captured Turn, the second dispatches. Every other key disarms it.
  const [interruptConfirmation, setInterruptConfirmation] =
    createSignal<InterruptTurnOffer>();
  const actionInFlight = () => {
    const flight = actionFlight();
    return flight !== undefined && flight.outcome().kind === "pending";
  };

  // The one resolved bottom interaction (H1). Every reader below — height,
  // rendering, focus, keys, hints, and App commands — switches on this value.
  const interaction = createMemo<TInteraction>(() => {
    const request = requestControl.active();
    if (request !== undefined) return { kind: "request", request };
    const gate = gateControl.active();
    if (gate !== undefined) return { kind: "gate", gate };
    const checkpoint = run()?.checkpoint;
    const offer = answerOffer();
    if (checkpoint !== undefined && offer !== undefined)
      return { kind: "checkpoint", checkpoint, offer };
    const current = run();
    if (
      current !== undefined &&
      (current.state === "succeeded" ||
        current.state === "failed" ||
        current.state === "cancelled" ||
        current.state === "halted")
    )
      return { kind: "resting", run: current, state: current.state };
    const available = offers();
    const working = available.interrupt;
    const endings: TStepEndings =
      working !== undefined || actionInFlight()
        ? {}
        : {
            ...(available.end === undefined ? {} : { end: available.end }),
            ...(available.continue === undefined
              ? {}
              : { continue: available.continue }),
            ...(available.endStage === undefined
              ? {}
              : { endStage: available.endStage }),
          };
    const waiting =
      checkpoint !== undefined
        ? `⏸ waiting for review — ${checkpoint.message}`
        : current?.pendingGate !== undefined
          ? `◆ Workflow decision · ${current.pendingGate.message}`
          : undefined;
    const send: TPromptSend =
      working !== undefined && available.steer !== undefined
        ? { kind: "steer", offer: available.steer }
        : working === undefined && available.followUp !== undefined
          ? { kind: "follow-up", offer: available.followUp }
          : working === undefined && available.send !== undefined
            ? { kind: "turn", offer: available.send }
            : { kind: "none" };
    return {
      kind: "prompt",
      send,
      working,
      endings,
      ...(waiting === undefined ? {} : { waiting }),
    };
  });
  const promptInteraction = () => {
    const current = interaction();
    return current.kind === "prompt" ? current : undefined;
  };
  // A request, gate, or checkpoint holds the bottom with its own controls: it
  // preempts discovery and pickers, and Model and Effort stay reachable through
  // Ctrl+P over it, never by preempting it.
  const answerHoldsBottom = () => {
    const kind = interaction().kind;
    return kind === "request" || kind === "gate" || kind === "checkpoint";
  };

  const currentConfirmationOffer = (
    action: TConfirmationOffer["action"],
  ): TConfirmationOffer | undefined => {
    const current = offers();
    switch (action) {
      case "resume-run":
        return current.resume?.available === true ? current.resume : undefined;
      case "cancel-run":
        return current.cancel;
      case "delete-run":
        return current.remove;
      case "interrupt-turn":
        return current.interrupt;
      case "end-interactive-step":
        return current.end;
      case "continue-repeat":
        return current.continue;
      case "end-stage":
        return current.endStage;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  };
  const confirmationCurrent = (offer: TConfirmationOffer) => {
    const current = currentConfirmationOffer(offer.action);
    return (
      current !== undefined &&
      confirmationTarget(current) === confirmationTarget(offer)
    );
  };

  const dispatchResume = (offer: TAvailableResume) => {
    // An unavailable resume (#194 story 40) is never dispatched — the Port has
    // said it cannot proceed, so the control is truthful, not actionable.
    if (!confirmationCurrent(offer) || actionInFlight()) return;
    setActionRefusal(undefined);
    setActionReceipt({ kind: "pending", operation: "resume" });
    setActionFlight({ op: "resume", outcome: actions.resume(offer) });
  };
  const dispatchInterrupt = (offer: InterruptTurnOffer) => {
    if (!confirmationCurrent(offer) || actionInFlight()) return;
    setActionRefusal(undefined);
    setActionReceipt({ kind: "pending", operation: "interrupt" });
    setActionFlight({ op: "interrupt", outcome: actions.interrupt(offer) });
  };
  // The two-press Esc Interrupt. `armed` is the arm this key found, since every
  // key clears the arm on arrival: a still-current arm dispatches once against its
  // captured Turn; otherwise this press arms afresh. Arming clears the prompt's
  // refusal so the armed confirm is never hidden (#294).
  const armOrDispatchInterrupt = (
    working: InterruptTurnOffer,
    armed: InterruptTurnOffer | undefined,
  ) => {
    if (actionInFlight()) return;
    if (armed === undefined || !confirmationCurrent(armed)) {
      setPromptRefusal(undefined);
      setInterruptConfirmation(structuredClone(working));
      return;
    }
    dispatchInterrupt(armed);
  };
  // Called on the confirming keypress. Cancel keeps the Run's history; delete
  // removes it and leaves the Workbench for the list once it settles.
  const confirmCancel = (offer: CancelRunOffer) => {
    if (!confirmationCurrent(offer) || actionInFlight()) return;
    setActionRefusal(undefined);
    setActionReceipt({ kind: "pending", operation: "cancel" });
    setActionFlight({ op: "cancel", outcome: actions.cancel(offer.runId) });
  };
  const confirmDelete = (offer: DeleteRunOffer) => {
    if (!confirmationCurrent(offer) || actionInFlight()) return;
    setActionRefusal(undefined);
    setActionReceipt({ kind: "pending", operation: "delete" });
    setActionFlight({ op: "delete", outcome: actions.remove(offer.runId) });
  };
  createEffect(() => {
    const armed = confirmation();
    if (armed === undefined) return;
    // A replaced or withdrawn target clears the arm; reappearance needs a fresh
    // one. A Step-ending confirm also leaves with the prompt it was armed in.
    if (
      !confirmationCurrent(armed.offer) ||
      (promptBound(armed.kind) && interaction().kind !== "prompt")
    )
      setConfirmation(undefined);
  });
  // Views use the captured Offer while armed, including its original consequence.
  const confirmationOffers = () => {
    const armed = confirmation();
    const current = offers();
    return {
      resume:
        armed?.offer.action === "resume-run" ? armed.offer : current.resume,
      cancel: armed?.kind === "cancel" ? armed.offer : current.cancel,
      remove: armed?.kind === "delete" ? armed.offer : current.remove,
    };
  };

  const [caret, setCaret] = createSignal(0);
  // Step-ending confirmations own a receipt independently of captured text.
  const [endingOutcome, setEndingOutcome] =
    createSignal<Accessor<AnswerOutcome>>();
  const drafts = createDraftControl({
    run,
    prompt: () => interaction().kind === "prompt",
    resting: () => interaction().kind === "resting",
    working: () => offers().interrupt !== undefined,
    endingPending: () => endingOutcome()?.().kind === "pending",
    refocus: () => setFocus("bottom"),
    refused: (outcome) => setPromptRefusal(outcome),
  });
  const draft = drafts.draft;
  const sendPending = drafts.sendPending;
  const steerPending = drafts.steerPending;
  const recoveryLines = () =>
    drafts.savedCount() === 0
      ? []
      : hintLines(
          `Unsent text from an earlier input saved · ^P commands → ${interaction().kind === "prompt" ? "Recover" : "Copy"} unsent text (${drafts.savedCount()})${drafts.recoveryNotice() === undefined ? "" : ` · ${drafts.recoveryNotice()}`}`,
        );
  const [promptRefusal, setPromptRefusal] = createSignal<
    | { readonly kind: "refused"; readonly problem: Problem }
    | { readonly kind: "command"; readonly message: string }
    | {
        readonly kind: "unavailable-steer";
        readonly offer: Extract<SteerTurnOffer, { available: false }>;
      }
    | undefined
  >();
  const dispatchSend = (send: TPromptSend) => {
    if (
      (send.kind !== "turn" && send.kind !== "follow-up") ||
      endingOutcome()?.().kind === "pending" ||
      steerPending()
    )
      return;
    drafts.send((text) =>
      send.kind === "follow-up"
        ? view.sendFollowUpTurn(send.offer, text)
        : view.sendInteractiveTurn(send.offer.runId, send.offer.stepId, text),
    );
  };
  const dispatchSteer = (offer: SteerTurnOffer) => {
    if (steerPending() || draft().trim() === "") return;
    if (!offer.available) {
      setPromptRefusal({ kind: "unavailable-steer", offer });
      return;
    }
    drafts.steer((text) => view.steer(offer.runId, offer.turnId, text));
  };
  const confirmEndStep = (offer: EndInteractiveStepOffer) => {
    if (!confirmationCurrent(offer) || sendPending()) return;
    setPromptRefusal(undefined);
    setEndingOutcome(() => view.endInteractiveStep(offer.runId, offer.stepId));
  };
  const confirmContinue = (offer: ContinueRepeatOffer) => {
    if (!confirmationCurrent(offer) || sendPending()) return;
    setPromptRefusal(undefined);
    setEndingOutcome(() => view.continueRepeat(offer.runId, offer.stepId));
  };
  const confirmEndStage = (offer: EndStageOffer) => {
    if (!confirmationCurrent(offer) || sendPending()) return;
    setPromptRefusal(undefined);
    setEndingOutcome(() => view.endStage(offer.runId, offer.stepId));
  };

  // The one arm-then-confirm path every entry reaches — keys, palette, Slash, and
  // focused details — capturing the Offer and its consequence as they are now.
  const arm = (kind: TConfirmation["kind"]) => {
    const current = offers();
    const resume =
      current.resume?.available === true ? current.resume : undefined;
    const armed: TConfirmation | undefined =
      kind === "end-step" && current.end
        ? { kind, offer: structuredClone(current.end) }
        : kind === "continue" && current.continue
          ? { kind, offer: structuredClone(current.continue) }
          : kind === "end-stage" && current.endStage
            ? { kind, offer: structuredClone(current.endStage) }
            : kind === "cancel" && current.cancel
              ? { kind, offer: structuredClone(current.cancel) }
              : kind === "delete" && current.remove
                ? { kind, offer: structuredClone(current.remove) }
                : (kind === "takeover" || kind === "acknowledge") &&
                    resume !== undefined
                  ? { kind, offer: structuredClone(resume) }
                  : undefined;
    if (armed === undefined) return;
    setPromptRefusal(undefined);
    setActionRefusal(undefined);
    setConfirmation(armed);
  };
  const confirm = (armed: TConfirmation) => {
    setConfirmation(undefined);
    switch (armed.kind) {
      case "takeover":
      case "acknowledge":
        dispatchResume(armed.offer);
        return;
      case "cancel":
        confirmCancel(armed.offer);
        return;
      case "delete":
        confirmDelete(armed.offer);
        return;
      case "continue":
        confirmContinue(armed.offer);
        return;
      case "end-stage":
        confirmEndStage(armed.offer);
        return;
      case "end-step":
        confirmEndStep(armed.offer);
        return;
      default: {
        const exhaustive: never = armed;
        return exhaustive;
      }
    }
  };

  // Resume from focused details. A local resume dispatches at once; a takeover or
  // an indeterminate-Command-Attempt acknowledgement (#194 story 39) arms first.
  const resumeFromDetails = () => {
    const resume = offers().resume;
    if (resume?.available !== true) return;
    if (resume.takeover !== undefined) arm("takeover");
    else if (resume.acknowledgement !== undefined) arm("acknowledge");
    else dispatchResume(resume);
  };

  // One transcript openable per Session that has a recorded transcript (#124),
  // each opening that Session's newest page through its `page` Resource Reference.
  const transcriptTargets = createMemo<readonly TranscriptTarget[]>(() => {
    const sessions = run()?.sessions ?? [];
    const withTranscript = sessions.filter(
      (s) => s.transcriptPage !== undefined,
    );
    // The title names the conversation in plain words (#289), since its Session
    // divider shows only once the transcript's start is loaded.
    return withTranscript.map((s) => ({
      label: `Session transcript · ${s.name}`,
      transcript: s.transcriptPage!,
      sessionName: s.name,
      ...(s.transcriptExport === undefined
        ? {}
        : { exportReference: s.transcriptExport }),
    }));
  });
  // Whether the Resting cause's diagnostic is gone: the 90-day prune removes it
  // (ADR 0041). Keyed on its id, so a snapshot update reads no file again.
  const restingDiagnosticId = createMemo(
    () => run()?.restingCause?.diagnostic?.diagnosticId,
  );
  const restingDiagnosticExpired = createMemo(() => {
    const diagnosticId = restingDiagnosticId();
    if (diagnosticId === undefined) return false;
    return !view.readResource({
      runId: props.runId,
      diagnosticId,
      type: "diagnostic",
    }).found;
  });
  const attemptDiagnosticId = createMemo(() => {
    const current = run();
    return current === undefined
      ? undefined
      : latestFailure(current)?.diagnostic?.diagnosticId;
  });
  const attemptDiagnosticExpired = createMemo(() => {
    const diagnosticId = attemptDiagnosticId();
    return (
      diagnosticId !== undefined &&
      !view.readResource({
        runId: props.runId,
        diagnosticId,
        type: "diagnostic",
      }).found
    );
  });
  // The evidence the details panel offers, in a stable order: bound outputs,
  // then a blocked checkpoint's latest Verdict, a halt or failure diagnostic, and
  // transcript.
  const openables = createMemo<readonly (Openable | TranscriptTarget)[]>(() => {
    const current = run();
    if (current === undefined) return [];
    const list: (Openable | TranscriptTarget)[] = current.outputs.map(
      (output) => ({
        label: `${output.name} (${output.type})`,
        reference: output.reference,
      }),
    );
    if (current.checkpoint !== undefined) {
      const verdict = current.checkpoint.latestVerdict;
      list.push({
        label: `checkpoint verdict: ${verdict.name} = ${verdict.value}`,
        reference: verdict.reference,
      });
    }
    if (current.conflict !== undefined) {
      list.push({
        label: `halt diagnostic: ${current.conflict.artifactName}`,
        reference: current.conflict.reference,
      });
    }
    if (
      current.restingCause?.diagnostic !== undefined &&
      !restingDiagnosticExpired()
    ) {
      list.push({
        label: `failure diagnostic: ${current.restingCause.code}`,
        reference: current.restingCause.diagnostic,
      });
    }
    const failure = latestFailure(current);
    if (
      failure?.diagnostic !== undefined &&
      !attemptDiagnosticExpired() &&
      failure.diagnostic.diagnosticId !==
        current.restingCause?.diagnostic?.diagnosticId
    ) {
      list.push({
        label: `failure diagnostic: ${failure.code}`,
        reference: failure.diagnostic,
      });
    }
    list.push(...transcriptTargets());
    return list;
  });

  // The checkpoint interaction's evidence line: the bound outputs (the latest
  // output and any candidate changes). The latest Verdict has its own line, so it
  // is not repeated here (the openables list above still offers it in Details).
  const evidenceLabels = createMemo<readonly string[]>(() =>
    (run()?.outputs ?? []).map((output) => `${output.name} (${output.type})`),
  );

  const interiorH = () => Math.max(1, dims().height - 2);
  /** Full-screen readers (inspection, the Session reader) span the interior. */
  const fullW = () => Math.max(1, dims().width - 2);
  const wide = () => dims().width > SIDEBAR_BREAKPOINT;
  /** The conversation column: the interior less the sidebar and its gap. */
  const innerW = () => Math.max(1, fullW() - (wide() ? SIDEBAR_WIDTH + 1 : 0));
  // Output inspection and retained transcript reading have distinct lifetimes.
  // Only the details-opened transcript reader can request older pages.
  const inspection = createInspection({
    readHistoryContent: view.readHistoryContent,
    releaseHistoryRead: view.releaseHistoryRead,
    readResource: view.readResource,
    interiorH,
    width: fullW,
  });
  const transcript = createTranscriptReader({
    readTranscript: view.readTranscript,
    interiorH,
    width: fullW,
  });

  // Reported context and usage (#418): two fixed slots outside history for an
  // Agent-bearing Run, in the sidebar when it shows and above the bottom region
  // otherwise, so a replacement never moves history or resizes its viewport.
  const metadataLines = () =>
    run()?.progress.some(
      (step) => step.kind === "agent" || step.kind === "interactive-agent",
    )
      ? reportedMetadata(live())
      : [];
  const conversationMetadata = () => (wide() ? [] : metadataLines());
  // The current Step's Session by its plain name, which carries any Iteration
  // ("implement, iteration 2"); the Step's latest started Turn names it.
  const currentSession = () => {
    const session = sessionSelection().step;
    return (
      run()?.sessions?.find((row) => row.session === session)?.name ?? session
    );
  };
  const sidebarRows = (): readonly DetailsRow[] => {
    const current = run();
    return current === undefined
      ? []
      : buildSidebarRows({
          run: current,
          session: currentSession(),
          pendingChoice: modelChoice.requested(),
          metadata: metadataLines(),
        });
  };

  // Notices above the conversation, each one counted line.
  const freshnessNotice = (): string | undefined => {
    const health = freshness();
    switch (health.kind) {
      case "current":
        return undefined;
      case "disconnected":
        return `View disconnected · not Run state · ctrl+r reconnect · last confirmed ${formatConfirmedAt(health.lastConfirmedAt)}`;
      case "loading":
        return "View loading · not Run state · controls unavailable";
      case "catching-up":
        return "View catching up · not Run state · controls unavailable";
    }
  };
  const pendingOperation = () => {
    const flight = actionFlight();
    if (flight !== undefined && flight.outcome().kind === "pending") {
      return flight.op;
    }
    if (answerOutcome()?.().kind === "pending") return "answer";
    if (sendPending()) return "interactive Turn";
    if (steerPending()) return "steer";
    if (requestControl.pending()) return "request answer";
    if (gateControl.pending()) return "gate answer";
    return undefined;
  };
  const modelChoice = createModelChoiceControl({
    run,
    offer: () => offers().modelChoice,
    dims,
    dialog,
    submit: actions.changeModelChoice,
  });
  const modelChoiceLines = () =>
    modelChoice.messages().flatMap((line) => wrap(line, innerW()));
  // A transient Problem in plain words, wrapped in full; its code is in details.
  const problemLines = () => {
    const problem = run()?.problem;
    if (problem === undefined) return [];
    return [
      ...wrap(`✗ ${problem.explanation}`, innerW(), 2).map((text) => ({
        text,
        fg: theme.error,
      })),
      ...wrap(problem.remediation, innerW()).map((text) => ({
        text,
        fg: theme.textMuted,
      })),
    ];
  };
  const noticeRows = () =>
    problemLines().length +
    (run()?.conflict !== undefined ? 1 : 0) +
    (freshnessNotice() !== undefined ? 1 : 0) +
    (!viewCurrent() && pendingOperation() !== undefined ? 1 : 0) +
    (actionReceipt() === undefined ? 0 : 1) +
    // A refused Run Action surfaces here, always visible, whichever control the
    // Offer lives in.
    (actionRefusal() === undefined ? 0 : 1) +
    modelChoiceLines().length +
    (interaction().kind === "prompt" ? 0 : recoveryLines().length);

  // --- the ordinary prompt's model ------------------------------------------

  const promptPlaceholder = (
    prompt: Extract<TInteraction, { kind: "prompt" }>,
  ) => {
    if (prompt.working !== undefined)
      return prompt.send.kind === "steer" && prompt.send.offer.available
        ? "◆ The agent is working — a message steers it at its next step"
        : "◆ The agent is working — wait for its reply or interrupt it";
    switch (prompt.send.kind) {
      case "follow-up":
        return "◇ Reply to the agent — it is waiting on you";
      case "turn":
        return "◇ Your move — the agent is waiting for your next Turn";
      default:
        return interactiveStep(run())
          ? "◇ Your move — the agent is waiting for your next Turn"
          : "· The Workflow is running — nothing to send yet";
    }
  };
  const promptNote = (
    prompt: Extract<TInteraction, { kind: "prompt" }>,
  ): string | undefined => {
    if (drafts.note() !== undefined) return drafts.note();
    if (prompt.send.kind === "follow-up")
      return "◇ You stopped the agent — it is waiting on your reply";
    const current = run();
    if (prompt.waiting !== undefined) return prompt.waiting;
    // After an interactive Step's Interrupt the agent waits on the person
    // (story 75), until a later Turn settles.
    if (prompt.working === undefined && interactiveStep(run())) {
      const step = current?.progress[current.position]?.id;
      const settled = [...(current?.timeline ?? [])]
        .reverse()
        .find((event) => event.event === "turn-settled");
      if (
        settled?.detail === "interrupted" &&
        (settled.step === undefined || settled.step === step)
      )
        return "◇ You stopped the agent — it is waiting on your next Turn";
    }
    return undefined;
  };
  const promptMeta = (): string | undefined => {
    if (wide()) return undefined;
    const current = run();
    if (current === undefined) return undefined;
    const step = current.progress[current.position];
    const parts = [
      ...(step === undefined ? [] : [`Step ${step.id}`]),
      ...(currentSession() === undefined ? [] : [currentSession()!]),
      ...(current.modelChoice === undefined
        ? []
        : [modelChoiceText(current.modelChoice)]),
    ];
    return parts.length === 0 ? undefined : parts.join(" · ");
  };
  const hintLines = (text: string) =>
    wrap(`${HINT_INDENT}${text}`, innerW(), 4);
  const promptHint = (
    prompt: Extract<TInteraction, { kind: "prompt" }>,
  ): PromptHint => {
    const warning = (text: string): PromptHint => ({
      kind: "lines",
      lines: hintLines(text),
      tone: "warning",
    });
    const armed = confirmation();
    // An armed Step ending shows its whole captured consequence, wrapped, with its
    // keys first; End Stage names the unchecked tracker right after them (#218).
    if (armed?.kind === "end-step")
      return warning(
        `⚠ End this interactive Step? Press y to confirm · esc to keep — ${armed.offer.consequence}`,
      );
    if (armed?.kind === "continue")
      return warning(`⚠ y continue · esc keep — ${armed.offer.consequence}`);
    if (armed?.kind === "end-stage")
      return warning(`⚠ y end stage · esc keep — ${armed.offer.consequence}`);
    const interrupt = interruptConfirmation();
    if (interrupt !== undefined)
      return warning(
        `⚠ Press esc again to interrupt · any other key cancels — ${interrupt.consequence}`,
      );
    if (prompt.working !== undefined)
      return {
        kind: "working",
        // Only a working agent can be steered, so either label says it works
        // in words, and both fit beside the cells at 40 columns.
        label:
          prompt.send.kind === "steer" && prompt.send.offer.available
            ? "enter steer · esc esc interrupt"
            : "working · esc esc interrupt",
        detail: prompt.working.consequence,
      };
    const endings = prompt.endings;
    const keys =
      prompt.send.kind === "turn"
        ? endings.continue !== undefined
          ? endings.endStage !== undefined
            ? "enter send Turn · ^N continue · ^P commands · esc back"
            : "enter send Turn · ^N continue · esc back"
          : endings.end !== undefined
            ? "enter send Turn · ^E end step · esc back"
            : "enter send Turn · esc back"
        : prompt.send.kind === "follow-up"
          ? "enter send reply · esc back"
          : "^G details · ^P commands · esc back";
    return {
      kind: "lines",
      lines: [clip(`${HINT_INDENT}${keys}`, innerW())],
      tone: "muted",
    };
  };
  // Everything the prompt draws but the completion list and the hint.
  const promptBase = () => {
    const prompt = promptInteraction();
    if (prompt === undefined) return undefined;
    const note = promptNote(prompt);
    const meta = promptMeta();
    const refusal = promptRefusal();
    return {
      recovery: recoveryLines(),
      refusal:
        refusal === undefined
          ? []
          : hintLines(
              `✗ ${refusal.kind === "refused" ? refusal.problem.explanation : refusal.kind === "command" ? refusal.message : `steer unavailable · ${refusal.offer.reason}`}`,
            ),
      ...(note === undefined ? {} : { note }),
      placeholder: promptPlaceholder(prompt),
      fieldRows: Math.min(
        PROMPT_MAX_FIELD_ROWS,
        Math.max(1, draft().split("\n").length),
      ),
      ...(meta === undefined ? {} : { meta }),
    } satisfies Omit<PromptModel, "hint">;
  };
  const promptModel = (): PromptModel | undefined => {
    const base = promptBase();
    if (base === undefined) return undefined;
    const { hint, rows } = completion.list();
    return { ...base, hint, commands: rows };
  };

  // The bottom region's rows, read from the one interaction.
  const interactionRows = (): number => {
    const current = interaction();
    switch (current.kind) {
      case "request":
        return REQUEST_HEIGHT;
      case "gate":
        return gateHeight(current.gate);
      case "checkpoint":
        return CHECKPOINT_HEIGHT;
      case "resting":
        return restingLines(current.run, current.state, innerW()).length;
      case "prompt": {
        const model = promptModel();
        return model === undefined ? 0 : promptHeight(model);
      }
    }
  };

  /** One row under the conversation for the paused/new-activity badge. */
  const STATUS_ROWS = 1;
  const chrome = () =>
    noticeRows() +
    STATUS_ROWS +
    conversationMetadata().length +
    interactionRows();
  // The details panel needs both room across (its width breakpoint) and room
  // down: its own rows plus at least one timeline row. On a short terminal it stays
  // hidden rather than clipping the panel and the bottom control.
  // Breakpoints compare the conversation column with its padding, which is the
  // terminal width whenever no sidebar shares the screen.
  const detailsAvailable = () =>
    innerW() + 2 >= DETAILS_MIN_WIDTH &&
    interiorH() - chrome() - detailsHeight() >= 1;
  const detailsShown = () => detailsOpen() && detailsAvailable();
  const focusedDetails = () => detailsOpen() && focus() === "details";
  // Ctrl+G keeps focused resources reachable below the panel breakpoints.
  const compactDetails = () => focusedDetails() && !detailsAvailable();
  const viewportH = () =>
    Math.max(
      1,
      interiorH() - chrome() - (detailsShown() ? detailsHeight() : 0),
    );
  // The selection can point past the end after a durable update drops outputs; a
  // clamped read keeps the highlight and any open on a real row.
  const selectedRef = () => {
    const held = selectedResource();
    const index =
      held === undefined
        ? -1
        : openables().findIndex((target) => {
            if ("transcript" in held || "transcript" in target) {
              return (
                "transcript" in held &&
                "transcript" in target &&
                held.transcript.runId === target.transcript.runId &&
                held.transcript.session === target.transcript.session
              );
            }
            const left = held.reference;
            const right = target.reference;
            if (left === undefined || right === undefined)
              return held === target;
            if (left.runId !== right.runId) return false;
            if (left.type === "diagnostic" || right.type === "diagnostic") {
              return (
                left.type === "diagnostic" &&
                right.type === "diagnostic" &&
                left.diagnosticId === right.diagnosticId
              );
            }
            return (
              left.type === right.type &&
              left.artifactName === right.artifactName &&
              left.versionId === right.versionId
            );
          });
    return index < 0
      ? Math.min(selected(), Math.max(0, openables().length - 1))
      : index;
  };

  // The panel's rows. The container reserves exactly these rows (its height) and
  // hands the same array to the pure DetailsPanel, so render and row accounting
  // never drift (tui/AGENTS.md). Lazy (not a createMemo) so it never eagerly reads
  // a const defined later in this body.
  const detailsRows = (): readonly DetailsRow[] => {
    const current = run();
    if (current === undefined) return [];
    const resume = confirmationOffers().resume;
    const armed = pending();
    return buildDetailsRows({
      run: current,
      position: positionText(current),
      compact: innerW() + 2 < DETAILS_COMPACT_WIDTH,
      focused: focus() === "details",
      openables: openables(),
      diagnosticExpired: restingDiagnosticExpired(),
      failureDiagnosticExpired: attemptDiagnosticExpired(),
      selected: selectedRef(),
      resumeAcknowledgement:
        resume?.available === true ? resume.acknowledgement : undefined,
      modelChoice: modelChoice.pending() ? undefined : offers().modelChoice,
      resume,
      cancel: confirmationOffers().cancel,
      remove: confirmationOffers().remove,
      armed: armed === undefined || promptBound(armed) ? undefined : armed,
    });
  };
  const detailsHeight = () => detailsRows().length;

  createEffect(() => {
    // Lifecycle actions confirm in the panel; if it closes mid-arm, drop the
    // confirm so no invisible action stays armed.
    const armed = pending();
    if (!detailsShown() && armed !== undefined && !promptBound(armed))
      setConfirmation(undefined);
  });

  const answerPending = () => {
    const accessor = answerOutcome();
    return accessor !== undefined && accessor().kind === "pending";
  };
  const dispatchAnswer = (answer: "continue" | "stop") => {
    if (answerPending()) return;
    const checkpoint = run()?.checkpoint;
    if (checkpoint === undefined) return;
    setAnswerRefusal(undefined);
    // Set the accessor before the settlement effect reads it: the live seam
    // settles inline, so storing it fires the effect at once.
    setAnswerOutcome(() => view.answer(checkpoint.gate, answer));
  };
  followSettlement(
    answerOutcome,
    () => setAnswerOutcome(undefined),
    setAnswerRefusal,
  );

  // A replaced/withdrawn Turn, or any control other than the prompt taking the
  // bottom region, clears the two-press arm. The next key alone remembers that an
  // arm ended under it, so a second Esc straddling the Turn's end never leaves.
  let interruptArmEnded = false;
  let escapeAfterEndedArm = false;
  createEffect(() => {
    const armed = interruptConfirmation();
    if (
      armed !== undefined &&
      (!confirmationCurrent(armed) || interaction().kind !== "prompt")
    ) {
      setInterruptConfirmation(undefined);
      interruptArmEnded = true;
    }
  });

  // Follow a dispatched Run Action to settlement. A refusal surfaces; an applied
  // delete leaves the Workbench for the list (the Run is gone), while resume and
  // cancel let the live `run` snapshot carry the new state in.
  createEffect(() => {
    const flight = actionFlight();
    if (flight === undefined) return;
    const settled = flight.outcome();
    if (settled.kind === "pending") return;
    if (settled.kind === "refused") {
      setActionRefusal(settled.problem);
      setActionReceipt(undefined);
      setActionFlight(undefined);
    } else {
      setActionFlight(undefined);
      if (flight.op === "delete") {
        setActionReceipt(undefined);
        const name = run()?.bundle.name;
        if (name !== undefined) props.onDeleted(name);
      } else {
        setActionReceipt({ kind: "applied", operation: flight.op });
      }
    }
  });

  // A newly arriving request, gate, or checkpoint target takes the bottom region
  // and its keys: it closes discovery and the picker, and focus returns to it.
  // Deliberate reopening over that target stays available through Ctrl+P.
  createEffect(
    on(
      () => {
        const current = interaction();
        return current.kind === "request"
          ? `request:${current.request.request.requestId}`
          : current.kind === "gate"
            ? `gate:${current.gate.gate.stepId}:${current.gate.gate.attemptId}`
            : current.kind === "checkpoint"
              ? `checkpoint:${current.checkpoint.gate.stepId}:${current.checkpoint.gate.attemptId}`
              : current.kind;
      },
      (target, previous) => {
        if (target === previous) return;
        const kind = interaction().kind;
        if (answerHoldsBottom()) {
          commands.preempt();
          modelChoice.close();
          // No armed confirmation outlives a control that takes the keys.
          setConfirmation(undefined);
          setFocus("bottom");
        }
        // A fresh checkpoint starts on the safer Continue with no old refusal.
        if (kind === "checkpoint") {
          setControl("continue");
          setAnswerRefusal(undefined);
        }
      },
    ),
  );

  // The follow-up replaces the Interrupt's receipt (#354): the prompt says the
  // agent is waiting.
  createEffect(() => {
    if (
      followUpOfferOf(actionableRun()) !== undefined &&
      actionReceipt()?.operation === "interrupt"
    )
      setActionReceipt(undefined);
  });

  createEffect(() => {
    const ending = endingOutcome()?.();
    if (ending === undefined || ending.kind === "pending") return;
    if (ending.kind === "refused") setPromptRefusal(ending);
    setEndingOutcome(undefined);
  });

  // The unavailable Steer's reason speaks for the live Turn only: when the Turn ends
  // it leaves, so the boundary's hint shows and Enter sends the kept draft (#294).
  createEffect(() => {
    if (
      offers().interrupt === undefined &&
      promptRefusal()?.kind === "unavailable-steer"
    )
      setPromptRefusal(undefined);
  });

  // App commands this owner contributes, available from the same interaction the
  // keys read (ADR 0040): Model and Effort until the Run ends, over any control;
  // the Step endings only while the prompt holds the bottom region. Each runs the
  // shared arm-then-confirm path; Application still admits the Operation.
  commands.register(() => {
    const current = interaction();
    // A halted Run keeps its Model choice for the resume; an ended one does not.
    const modelAvailable =
      (current.kind !== "resting" || current.state === "halted") &&
      offers().modelChoice?.available === true &&
      !modelChoice.pending();
    const endings = current.kind === "prompt" ? current.endings : {};
    const entries: AppCommand[] = [
      {
        id: "model",
        order: 50,
        name: "Model",
        description: "Change the Run model and effort",
        slash: "model",
        available: modelAvailable,
        run: () => modelChoice.open("model"),
      },
      {
        id: "effort",
        order: 60,
        name: "Effort",
        description: "Change effort with the Model choice",
        slash: "effort",
        available: modelAvailable,
        run: () => modelChoice.open("effort"),
      },
      {
        id: "end-step",
        order: 70,
        name: "End Step",
        description: "Confirm ending the interactive Step",
        slash: "end-step",
        keyHint: "ctrl+e",
        available: endings.end !== undefined,
        run: () => arm("end-step"),
      },
      {
        id: "continue",
        order: 80,
        name: "Continue",
        description: "Confirm another Repeat iteration",
        slash: "continue",
        keyHint: "ctrl+n",
        available: endings.continue !== undefined,
        run: () => arm("continue"),
      },
      {
        id: "end-stage",
        order: 90,
        name: "End Stage",
        description: "Confirm ending the stage",
        slash: "end-stage",
        available: endings.endStage !== undefined,
        run: () => arm("end-stage"),
      },
    ];
    if (current.kind !== "prompt" && drafts.savedCount() > 0)
      entries.push({
        id: "copy-unsent-text",
        order: 100,
        name: "Copy unsent text",
        description: "Copy saved earlier-input text to the terminal clipboard",
        run: () =>
          drafts.copied(
            terminalRenderer.copyToClipboardOSC52(drafts.savedText()),
          ),
      });
    if (current.kind === "prompt") {
      if (drafts.savedCount() > 0)
        entries.push({
          id: "recover-unsent-text",
          order: 100,
          name: "Recover unsent text",
          description: "Put saved earlier-input text before this draft",
          run: drafts.recover,
        });
    }
    return entries;
  });

  // The prompt's native field takes text only while nothing else holds the keys:
  // no dialog, no confirmation, no focused details.
  const promptFieldFocused = () =>
    dialog.stack.length === 0 &&
    focus() === "bottom" &&
    promptInteraction() !== undefined &&
    confirmation() === undefined;

  const completion = createPromptCompletion({
    draft,
    caret,
    runId: () => run()?.runId,
    enabled: promptFieldFocused,
    commands,
    search: (input) => view.searchWorkspacePaths(input),
    width: innerW,
    space: () => {
      const base = promptBase();
      return base === undefined
        ? 0
        : interiorH() -
            noticeRows() -
            STATUS_ROWS -
            conversationMetadata().length -
            promptHeight({
              ...base,
              hint: { kind: "lines", lines: [], tone: "muted" },
            });
    },
    hint: () => {
      const prompt = promptInteraction();
      return prompt === undefined ? undefined : promptHint(prompt);
    },
    enter: () => {
      const send = promptInteraction()?.send;
      return send?.kind === "steer"
        ? send.offer.available
          ? "steer"
          : "working"
        : send === undefined || send.kind === "none"
          ? "none"
          : "send";
    },
  });
  const invokeSlash = (id?: string) => {
    const known = commands.knownSlash(draft());
    if (known?.arguments) {
      setPromptRefusal({
        kind: "command",
        message: `/${known.entry.slash} doesn't accept inline arguments`,
      });
      return true;
    }
    const entry =
      id === undefined
        ? known?.entry
        : commands.entries().find((entry) => entry.id === id);
    if (entry === undefined && known === undefined && id === undefined)
      return false;
    if (entry === undefined || entry.available === false) {
      setPromptRefusal({
        kind: "command",
        message: `/${known?.entry.slash ?? id} isn't available right now`,
      });
      return true;
    }
    drafts.clear();
    setPromptRefusal(undefined);
    entry.run();
    return true;
  };
  const history = createHistoryViewport({
    view,
    run,
    histories,
    width: innerW,
    height: viewportH,
    reducedMotion: props.reducedMotion,
    inspection,
    covered: () =>
      inspection.inspecting() !== undefined ||
      transcript.reader() !== undefined,
    blocked: () => dialog.stack.length > 0 || confirmation() !== undefined,
  });

  const moveSelection = (delta: number) => {
    const count = openables().length;
    if (count === 0) return;
    const index = Math.max(0, Math.min(selectedRef() + delta, count - 1));
    setSelected(index);
    setSelectedResource(openables()[index]);
  };

  const openSelected = () => {
    const target = openables()[selectedRef()];
    if (target !== undefined) {
      setSelectedResource(target);
      if ("transcript" in target) transcript.open(target);
      else {
        history.detachInspection();
        inspection.open(target);
      }
    }
  };

  // The ordinary prompt's keys (ADR 0036). Text, cursor motion, word deletion,
  // paste, punctuation, and Shift+Enter/Ctrl+J newlines belong to the native field;
  // the Port dispatcher is a global keyInput listener that runs first on the same
  // key event (tui/AGENTS.md), so it claims only these and lets every other key —
  // every bare letter included — reach the field.
  const handlePromptKey = (
    prompt: Extract<TInteraction, { kind: "prompt" }>,
    key: RendererKeyEvent,
    armedInterrupt: InterruptTurnOffer | undefined,
  ) => {
    const name = key.name ?? "";
    if (name === "escape") {
      // Two presses Interrupt the working Turn; at a Turn boundary Esc leaves.
      if (prompt.working !== undefined)
        armOrDispatchInterrupt(prompt.working, armedInterrupt);
      // An Esc that arrives after its Turn ended under the arm is the second
      // half of an Interrupt, never a leave.
      else if (!escapeAfterEndedArm) props.onLeave();
      return;
    }
    if (name === "return" && !key.shift && !key.ctrl && !key.alt) {
      if (prompt.send.kind === "steer") dispatchSteer(prompt.send.offer);
      else dispatchSend(prompt.send);
      return;
    }
    if (!key.ctrl) return;
    // Ctrl+E means End Step only; End Stage has no key (ADR 0040). Arming blurs
    // the field, so the field's own Ctrl+E line-end on the same event is moot.
    if (name === "e" && prompt.endings.end !== undefined) arm("end-step");
    else if (name === "n" && prompt.endings.continue !== undefined)
      arm("continue");
  };

  // Focused details own their letters: resume, cancel, and delete with their
  // confirmations, and resource selection and opening.
  const handleDetailsKey = (key: RendererKeyEvent) => {
    switch (key.name ?? "") {
      case "up":
        moveSelection(-1);
        return;
      case "down":
        moveSelection(1);
        return;
      case "return":
      case "o":
        openSelected();
        return;
      case "r":
        resumeFromDetails();
        return;
      case "c":
        // Cancel and delete act only while the inline panel shows, where their
        // control and confirm render.
        if (detailsShown()) arm("cancel");
        return;
      case "x":
        if (detailsShown()) arm("delete");
        return;
      case "tab":
      case "escape":
        setFocus("bottom");
        return;
      default:
        return;
    }
  };

  const handleKey = (key: RendererKeyEvent) => {
    // Every key disarms the two-press Interrupt; only the Esc that the prompt
    // routes to it reads the arm it found.
    const armedInterrupt = interruptConfirmation();
    setInterruptConfirmation(undefined);
    escapeAfterEndedArm = interruptArmEnded;
    interruptArmEnded = false;
    // An applied receipt leaves on the next key, which keeps its recipient.
    if (actionReceipt()?.kind === "applied") setActionReceipt(undefined);
    const topDialog = dialog.stack.at(-1);
    if (topDialog !== undefined) {
      topDialog.onKey?.(key);
      return;
    }
    const name = key.name ?? "";
    if (name === "p" && key.ctrl) {
      commands.openPalette();
      return;
    }
    const reading =
      transcript.reader() !== undefined ||
      inspection.inspecting() !== undefined;
    if (name === "c" && key.ctrl) {
      // Ctrl+C clears a visible nonempty draft first, then requests guarded Quit.
      if (
        !reading &&
        !compactDetails() &&
        promptInteraction() !== undefined &&
        draft() !== ""
      ) {
        drafts.clear();
        setPromptRefusal(undefined);
        return;
      }
      exit();
      return;
    }
    if (name === "r" && key.ctrl) {
      if (freshness().kind === "disconnected") reconnect();
      else commands.retry();
      return;
    }
    // Details readers consume keys before Run controls and text editing. Quit
    // uses the same guarded Exit, preserving the reader on Keep Running.
    const transcriptKey = transcript.handleKey(name);
    const inspected =
      transcriptKey === "ignored" ? inspection.handleKey(name) : transcriptKey;
    if (inspected === "quit") {
      exit();
      return;
    }
    if (inspected === "consumed") return;
    if (run() === undefined) {
      if (name === "escape") props.onLeave();
      return;
    }
    const current = interaction();
    // A pending confirmation waits for its confirming keypress: `y` confirms and
    // Escape declines, refocusing the prompt with its draft; any other key is
    // ignored, so a stray keystroke never dispatches it.
    const armed = confirmation();
    if (armed !== undefined) {
      if (name === "y") confirm(armed);
      else if (name === "escape") setConfirmation(undefined);
      return;
    }
    if (name === "g" && key.ctrl) {
      if (focusedDetails()) {
        setDetailsOpen(false);
        setFocus("bottom");
      } else {
        setDetailsOpen(true);
        setSelected(0);
        setSelectedResource(undefined);
        setFocus("details");
      }
      return;
    }
    // Modified navigation and page keys scroll the conversation beside native
    // prompt editing and checkpoint choices; focused details keep their keys.
    if (
      !focusedDetails() &&
      current.kind !== "request" &&
      current.kind !== "gate" &&
      !key.ctrl
    ) {
      const action =
        (key.alt && ["up", "down", "home", "end"].includes(name)) ||
        name === "pageup" ||
        name === "pagedown"
          ? SCROLL_KEYS[name]
          : undefined;
      if (action !== undefined) {
        history.scrollBy(action);
        return;
      }
    }
    if (focusedDetails()) {
      handleDetailsKey(key);
      return;
    }
    if (name === "o" && key.ctrl) {
      history.toggleDetail();
      return;
    }
    // A request or gate owns Esc and every printable key (A33): its private control
    // consumes them all, so no prompt, Interrupt, or Run action fires beneath it.
    if (current.kind === "request") {
      requestControl.handleKey(name);
      return;
    }
    if (current.kind === "gate") {
      gateControl.handleKey(name);
      return;
    }
    if (current.kind === "prompt") {
      // Slash precedes `@`, and both precede the prompt's own keys.
      const completed = completion.handleKey(key);
      if (completed?.kind === "run") invokeSlash(completed.id);
      if (completed !== undefined) return;
      if (
        name === "return" &&
        !key.ctrl &&
        !key.alt &&
        !key.shift &&
        invokeSlash()
      )
        return;
    }
    if (name === "tab" && detailsShown()) {
      setFocus("details");
      return;
    }
    switch (current.kind) {
      case "checkpoint":
        // The Review checkpoint's two controls: ←/→ choose, Enter dispatches; both
        // are unavailable while the answer is pending.
        if (name === "left" && !answerPending()) setControl("continue");
        else if (name === "right" && !answerPending()) setControl("stop");
        else if (name === "return") dispatchAnswer(control());
        else if (name === "escape") props.onLeave();
        return;
      case "resting":
        if (name === "escape") props.onLeave();
        return;
      case "prompt":
        handlePromptKey(current, key, armedInterrupt);
        return;
      default: {
        const exhaustive: never = current;
        return exhaustive;
      }
    }
  };
  onCleanup(props.renderer.onKey(handleKey));

  const reconnect = () => {
    if (runFreshness().kind === "disconnected") opened.reconnect();
    const disconnected = historyFollowers().filter(
      ({ followed }) => followed.freshness().kind === "disconnected",
    );
    if (disconnected.length > 0) history.scrollBy("latest");
    for (const { followed } of disconnected) followed.reconnect();
  };

  return (
    <box
      width={dims().width}
      height={dims().height}
      flexDirection="column"
      padding={1}
      onMouseScroll={(event) => {
        const kind = interaction().kind;
        if (
          dialog.stack.length > 0 ||
          kind === "request" ||
          kind === "gate" ||
          confirmation() !== undefined ||
          focusedDetails() ||
          transcript.reader() !== undefined ||
          inspection.inspecting() !== undefined
        )
          return;
        const direction = event.scroll?.direction;
        if (direction === "up" || direction === "down")
          history.scrollBy(direction);
      }}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <Switch>
        <Match when={transcript.reader()}>
          {(current) => (
            <TranscriptReaderView
              title={current().target.label}
              problem={current().problem}
              interiorH={interiorH}
              visible={transcript.visible}
              location={transcript.location}
              notice={transcript.notice}
              width={fullW}
              theme={theme}
            />
          )}
        </Match>
        <Match when={inspection.inspecting()}>
          {(current) => (
            <InspectionView
              inspection={current()}
              footer={inspection.footer}
              lines={inspection.lines}
              window={inspection.window}
              width={fullW}
              theme={theme}
            />
          )}
        </Match>
        <Match when={compactDetails()}>
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text fg={theme.text} flexShrink={0}>
              Details · Resources
            </text>
            <box flexDirection="column" flexGrow={1} overflow="hidden">
              <For
                each={openables().slice(
                  selectedRef(),
                  selectedRef() + Math.max(1, interiorH() - 2),
                )}
              >
                {(target) => (
                  <text fg={theme.text} flexShrink={0}>
                    {clip(
                      `${target === openables()[selectedRef()] ? "› " : "  "}${target.label}`,
                      fullW(),
                    )}
                  </text>
                )}
              </For>
            </box>
            <text fg={theme.textMuted} flexShrink={0}>
              {clip(
                "↑/↓ select · enter open · esc back · ctrl+c quit",
                fullW(),
              )}
            </text>
          </box>
        </Match>
        <Match when={notFound()}>
          {(problem) => (
            <NotFoundView
              runId={props.runId}
              problem={problem()}
              width={fullW}
              theme={theme}
            />
          )}
        </Match>
        <Match when={run()}>
          {(current) => (
            <box flexDirection="row" flexGrow={1} overflow="hidden">
              <box
                flexDirection="column"
                width={innerW()}
                flexShrink={0}
                overflow="hidden"
              >
                {/* A transient Problem and a Materialization conflict are
                    notices, readable without colour. The Problem's code is
                    kept for details (ADR 0041). */}
                <For each={problemLines()}>
                  {(line) => (
                    <text fg={line.fg} flexShrink={0} wrapMode="none">
                      {line.text}
                    </text>
                  )}
                </For>
                <Show when={current().conflict}>
                  {(conflict) => (
                    <text fg={theme.warning} flexShrink={0}>
                      {clip(
                        `✗ conflict — restore ${conflict().path}`,
                        innerW(),
                      )}
                    </text>
                  )}
                </Show>
                <Show when={interaction().kind !== "prompt"}>
                  <For each={recoveryLines()}>
                    {(line) => (
                      <text fg={theme.warning} flexShrink={0} wrapMode="none">
                        {line}
                      </text>
                    )}
                  </For>
                </Show>
                <Show when={freshnessNotice()}>
                  {(notice) => (
                    <text fg={theme.warning} flexShrink={0}>
                      {clip(notice(), innerW())}
                    </text>
                  )}
                </Show>
                <Show when={viewCurrent() ? undefined : pendingOperation()}>
                  {(operation) => (
                    <text fg={theme.warning} flexShrink={0}>
                      {clip(`Operation pending · ${operation()}`, innerW())}
                    </text>
                  )}
                </Show>
                <Show when={actionReceipt()}>
                  {(receipt) => (
                    <text
                      fg={
                        receipt().kind === "applied"
                          ? theme.success
                          : theme.warning
                      }
                      flexShrink={0}
                    >
                      {clip(actionReceiptText(receipt()), innerW())}
                    </text>
                  )}
                </Show>
                <Show when={actionRefusal()}>
                  {(problem) => (
                    <text fg={theme.error} flexShrink={0}>
                      {clip(`✗ ${problem().explanation}`, innerW())}
                    </text>
                  )}
                </Show>
                <For each={modelChoiceLines()}>
                  {(line) => (
                    <text fg={theme.text} flexShrink={0} wrapMode="none">
                      {line}
                    </text>
                  )}
                </For>

                {/* The conversation: exactly `viewportH` display lines, windowed
                    over the wrapped rows. Each line is already wrapped to the
                    width, so OpenTUI must not wrap it again (#288). */}
                <box
                  flexDirection="column"
                  height={viewportH()}
                  flexShrink={0}
                  overflow="hidden"
                >
                  <Show
                    when={history.lines().length > 0}
                    fallback={
                      <text fg={theme.textMuted} flexShrink={0}>
                        {history.atBeginning()
                          ? "  Beginning of Run history · (no activity yet)"
                          : "  (no activity yet)"}
                      </text>
                    }
                  >
                    <Index each={history.lines()}>
                      {(line, index) => (
                        <HistoryLine
                          theme={theme}
                          text={line().text}
                          value={line().value}
                          event={line().event}
                          humanPanel={line().humanPanel}
                          failurePanel={line().failurePanel}
                          width={innerW()}
                          onMouseDown={() => history.click(index)}
                        />
                      )}
                    </Index>
                  </Show>
                </box>
                <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
                  {clip(history.status(), innerW())}
                </text>
                <For each={conversationMetadata()}>
                  {(line) => (
                    <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
                      {clip(line, innerW())}
                    </text>
                  )}
                </For>
                <Show when={detailsShown()}>
                  <DetailsPanel
                    rows={detailsRows}
                    height={detailsHeight()}
                    width={innerW}
                    theme={theme}
                  />
                </Show>
                <Switch>
                  <Match
                    when={(() => {
                      const value = interaction();
                      return value.kind === "request" ? value : undefined;
                    })()}
                  >
                    {(value) => (
                      <HarnessRequestControl
                        request={() => value().request.request}
                        offer={() => value().request.offer}
                        decision={requestControl.decision}
                        pending={requestControl.pending}
                        refusal={requestControl.refusal}
                        width={innerW}
                        theme={theme}
                      />
                    )}
                  </Match>
                  <Match
                    when={(() => {
                      const value = interaction();
                      return value.kind === "gate" ? value.gate : undefined;
                    })()}
                  >
                    {(gate) => (
                      <FreeTextGateControl
                        gate={gate}
                        text={gateControl.text}
                        choice={gateControl.choice}
                        onInput={gateControl.onInput}
                        focused={() => focus() === "bottom"}
                        pending={gateControl.pending}
                        refusal={gateControl.refusal}
                        width={innerW}
                        theme={theme}
                      />
                    )}
                  </Match>
                  <Match
                    when={(() => {
                      const value = interaction();
                      return value.kind === "checkpoint" ? value : undefined;
                    })()}
                  >
                    {(value) => (
                      <CheckpointInteraction
                        checkpoint={() => value().checkpoint}
                        height={CHECKPOINT_HEIGHT}
                        offer={() => value().offer}
                        evidence={evidenceLabels}
                        control={control}
                        focused={() => focus() === "bottom"}
                        pending={answerPending}
                        refusal={answerRefusal}
                        width={innerW}
                        theme={theme}
                      />
                    )}
                  </Match>
                  <Match
                    when={(() => {
                      const value = interaction();
                      return value.kind === "resting" ? value : undefined;
                    })()}
                  >
                    {(resting) => (
                      <RestingView
                        lines={() =>
                          restingLines(resting().run, resting().state, innerW())
                        }
                        theme={theme}
                      />
                    )}
                  </Match>
                  <Match when={promptModel()}>
                    {(model) => (
                      <PromptControl
                        model={model}
                        draft={draft}
                        onInput={drafts.input}
                        focused={promptFieldFocused}
                        listOpen={completion.listOpen}
                        onCaret={setCaret}
                        replacement={completion.replacement}
                        onReplacement={completion.replaced}
                        width={innerW}
                        reducedMotion={props.reducedMotion}
                        theme={theme}
                      />
                    )}
                  </Match>
                </Switch>
              </box>
              <Show when={wide()}>
                <box width={1} flexShrink={0} />
                <Sidebar rows={sidebarRows} theme={theme} />
              </Show>
            </box>
          )}
        </Match>
      </Switch>
    </box>
  );
}

type Theme = ReturnType<typeof useTheme>["theme"];

function positionText(run: RunView): string {
  return run.position >= run.progress.length
    ? "at rest"
    : `step ${run.position + 1} of ${run.progress.length}`;
}

function formatConfirmedAt(confirmedAt: string): string {
  return confirmedAt.replace("T", " ").replace(".000Z", "Z");
}

function NotFoundView(props: {
  runId: string;
  problem: Problem;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <text fg={theme.error} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip(`Run ${props.runId} not found`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(props.problem.explanation, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(props.problem.remediation, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        esc back · ctrl+c quit
      </text>
    </box>
  );
}
