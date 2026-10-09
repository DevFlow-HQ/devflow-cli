import { RunNotices } from "./run-notices.js";
import { createWorkspacePathSearch } from "./workspace-paths.js";
import type { WorkspacePathHelper } from "./workspace-path-helper.js";
import { mergeHarnessInputRules } from "./harness-registry.js";
export { mergeHarnessInputRules } from "./harness-registry.js";
import { z } from "zod";
import {
  DEFAULT_BUDGETS,
  inspectBundle,
  type Budgets,
} from "../bundle/bundle.js";
import type { Catalog } from "../catalog/catalog.js";
import {
  flattenSteps,
  matchHarnessInputRule,
  routingNeedsHarness,
  type AgentStep,
  type AuthoredManifest,
  type Platform,
  type RoutingNode,
} from "../workflow/workflow.js";
import {
  interactiveEndLegality,
  latestAgentCall,
  interactiveStepTarget,
  type AgentFollowUp,
  type RequestChannel,
  type RunReport,
  RUN_CANCEL_ABORT as CANCEL_ABORT,
  SIGNAL_ABORT,
} from "../run/execution/execution.js";
import type {
  PublishAttemptRequest,
  RunGroup,
  RunOwner,
  RunRecord,
  SelectedHarnessId,
} from "../run/store/store.js";
import {
  focusSnapshot,
  listSnapshot,
  type BundleCatalogDependencies,
} from "./bundle-catalog.js";
import { createHarnessCatalog } from "./harness-catalog.js";
import { engineProblem } from "./engine-range.js";
import { createLaunchPreparation } from "./launch-preparation.js";
import {
  guardedApplicationObserver,
  type ApplicationObserver,
} from "./observer.js";
import type { BundleManagement } from "./bundle-management.js";
import {
  createBundleManagement,
  type BundleManagementDependencies,
} from "./build-bundle.js";
import {
  ensureShippedBundles,
  type ShippedBundleEnsure,
} from "./shipped-bundles.js";
import { deriveRun, type HoldBasis } from "./run-progress.js";
import {
  deriveRunFacts,
  GATE_ANSWER_ARTIFACT,
  runSnapshot,
  type RunFacts,
  type RunProjectionDependencies,
  type RunSteerCapability,
} from "./run-projection.js";
import {
  bundleBytesCorrupt,
  bundleBytesMissing,
  bundleTrustRequired,
  followUpTurnBlank,
  followUpTurnNotAdmitted,
  followUpTurnNotWaiting,
  gateShapeMismatch,
  gateStale,
  harnessRequestExpired,
  harnessRequestIndeterminate,
  harnessRequestRejected,
  harnessRequestStale,
  harnessInputReserved,
  interactiveControlMismatch,
  interactiveStepMidTurn,
  interactiveStepNotActive,
  interactiveTurnBlank,
  interactiveTurnBusy,
  interactiveTurnNotAdmitted,
  interruptRejected,
  pathNotFound,
  runDiagnosticMissing,
  runExecutionFault,
  runIsLive,
  runLiveElsewhere,
  runNotBlocked,
  runNotFound,
  runNotLive,
  runNotResumable,
  runOutputMissing,
  runStoreDamaged,
  runSupportUnavailable,
  modelChoiceRequired,
  selectedHarnessUnavailable,
  steerBlank,
  steerRejected,
  steerSessionCommand,
  steerUnavailable,
  turnControlRejected,
  type InteractiveControl,
} from "./problems.js";
import type { UpdateStream } from "./update-stream.js";
import {
  modelChoiceRefusalExplanation,
  preselectModelChoice,
  modelChoiceOffer,
  resolveChangedModelChoice,
  saveLastModelChoice,
  sameModelChoice,
} from "./model-choice.js";
import type { ModelChange, ModelChoice } from "../harness/harness.js";
import {
  OperationLedger,
  type OperationSettlement,
} from "./operation-ledger.js";
import { createSessionHistory } from "./session-history.js";
import { SubscriptionLifecycle } from "./subscription-lifecycle.js";
import { listRunsSnapshot, summarizeRuns } from "./run-list.js";
import { readTranscriptResource } from "./transcript-resource.js";
// Re-exported through the Module entry so clients and tests reach the page size
// without importing the internal resolver file (module-boundaries).
export { TRANSCRIPT_PAGE_SIZE } from "./transcript-resource.js";
import { preflight } from "./preflight.js";
import { createLiveOverlay, type LiveOverlayState } from "./live-overlay.js";
import {
  answerHarnessRequestReplayKey,
  answerReplayKey,
  cancelReplayKey,
  canonicalizeWorkspacePath,
  deleteReplayKey,
  continueRepeatReplayKey,
  endInteractiveStepReplayKey,
  endStageReplayKey,
  interruptTurnReplayKey,
  launchReplayKey,
  resumeReplayKey,
  sendFollowUpTurnReplayKey,
  sendInteractiveTurnReplayKey,
  steerTurnReplayKey,
} from "./replay-keys.js";
export { canonicalizeWorkspacePath } from "./replay-keys.js";
import { createPreferences } from "./preferences.js";
import type {
  PreferencesSnapshot,
  AnswerHarnessRequestInput,
  AnswerHumanGateInput,
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  ChangeModelChoiceInput,
  ContinueRepeatInput,
  EndInteractiveStepInput,
  EndStageInput,
  InterruptTurnInput,
  HarnessCatalogSnapshot,
  HarnessDiagnosticReference,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
  LaunchPreparationSnapshot,
  LaunchRunInput,
  ResumeRunInput,
  SendFollowUpTurnInput,
  SendInteractiveTurnInput,
  SteerTurnInput,
  OpenedProjection,
  OperationSnapshot,
  ProjectionPort,
  ProjectionSelector,
  Problem,
  HistoryTextEdges,
  DiagnosticReference,
  ResourceRead,
  ResourceReference,
  RunGateReference,
  TranscriptExportReference,
  TranscriptPageReference,
  TranscriptRead,
  RunListSnapshot,
  RunSnapshot,
  SessionHistorySnapshot,
  Submission,
  SubmissionAdmission,
  WorkspaceSnapshot,
} from "./projection-port.js";
import type {
  ApplicationHarnessQualification,
  ApplicationHarnessRegistration,
  RunHarnessPreparationFailure,
} from "./harness-registry.js";
import { type ProcessAdapter } from "../process/process.js";
export type { ApplicationEvent, ApplicationObserver } from "./observer.js";
export type {
  ApplicationHarnessQualification,
  ApplicationHarnessRegistration,
  RunHarnessPreparationFailure,
  THarnessDiscovery,
} from "./harness-registry.js";

/** How composition drives one acquired Run to rest. It constructs the Run
 *  execution (the `{asset}` resolver, host platform, and bounds) and calls the
 *  execution Interface; a fenced owner or publication fault throws (composition
 *  owns it). A selected Harness that refuses preparation is not thrown: it returns
 *  the `harness-unavailable` report before any Step runs or Run state is written,
 *  and the Application owns resting the Run. The Application wraps the owner it is
 *  handed to observe each publication, so this signature stays execution-agnostic. */
export type RunExecution = (context: {
  readonly routing: readonly RoutingNode[];
  readonly digest: string;
  readonly owner: RunOwner;
  /** The cancel Seam a live Run is driven under (#98): when it aborts mid-command
   *  the child's process group is killed and execution unwinds. The Application owns
   *  one AbortController per live Run and passes its signal here; the execution
   *  Interface stays agnostic to why it aborted. */
  readonly cancelSignal?: AbortSignal;
  /** The Application's per-Run live request-answer channel (#117): an Agent Turn's
   *  approval requests reach the observing client through it, and a client answers
   *  through `answer-harness-request`. Absent for a Command-only Run. */
  readonly requestChannel?: RequestChannel;
  /** Current prepared-profile evidence projected while the Attempt is still live;
   *  the settled Attempt persists the same fact for reopen/resume. */
  readonly observeSteer?: (capability: RunSteerCapability) => void;
  readonly observeWindowsCleanupFallback?: () => void;
  /** The Step's Harness the Application held across a waiting rest (#354), handed
   *  back so the walk reuses it instead of preparing another. Ownership transfers
   *  with the call: the walk closes it, or hands it back on a `blocked` rest. */
  readonly heldStep?: RunInteractiveStep;
  /** The human's follow-up to the Agent Turn an Interrupt left waiting (#354).
   *  Execution decides whether it still applies; the Application only forwards it. */
  readonly followUp?: AgentFollowUp;
}) => Promise<RunExecutionReport>;

/** Either the routing ran to a rest, or the selected Harness refused preparation
 *  before anything ran. The refusal is its own outcome, never an ordinary `halted`
 *  rest, so a reader must narrow it away before reaching the executed report (#304). */
type RunExecutionReport = ExecutedRunReport | HarnessUnavailableReport;

interface ExecutedRunReport extends RunReport {
  /** An already-qualified Harness whose ownership transfers to the Application
   *  when execution rests `blocked`. The Application holds it while the Run holds
   *  its Step for the human (an interactive Step, or an Agent Step waiting after an
   *  Interrupt, #354), treats it as opaque, and closes it otherwise and whenever
   *  the Step ends or the Run releases ownership. */
  readonly heldStep?: RunInteractiveStep;
}

interface HarnessUnavailableReport {
  readonly outcome: "harness-unavailable";
  /** A selected Adapter's typed preparation failure, normalized by composition.
   * No Adapter object, native protocol value, or executable target crosses. */
  readonly harnessFailure: RunHarnessPreparationFailure;
}

/** The opaque Step-scoped driver composition transfers to a tracked Run. It reuses
 *  one prepared Harness across an interactive Step's human Turns, or holds an Agent
 *  Step's Harness across its wait after an Interrupt (#354, which never calls
 *  `turn`), and exposes only the normalized control evidence and Turn outcome the
 *  Application owns. */
export interface RunInteractiveStep {
  readonly steer: RunSteerCapability;
  turn(context: {
    readonly runId: string;
    readonly owner: RunOwner;
    readonly routing: readonly RoutingNode[];
    readonly step: AgentStep;
    /** The Step's named Session, reused across the Step's Turns and later Steps. */
    readonly session: string;
    /** The interactive Step's pending Attempt id, so every human Turn links to it. */
    readonly attemptId: string;
    /** A unique id per human Turn. */
    readonly turnId: string;
    /** The human's verbatim Turn text. */
    readonly text: string;
    readonly cancelSignal?: AbortSignal;
    readonly requestChannel?: RequestChannel;
  }): Promise<InteractiveTurnReport>;
  close(): Promise<void>;
}

type TRunInteractiveStepPreparation =
  | { readonly ok: true; readonly interactiveStep: RunInteractiveStep }
  | { readonly ok: false; readonly failure: RunHarnessPreparationFailure };

export type PrepareRunInteractiveStep = (context: {
  readonly cancelSignal?: AbortSignal;
  readonly observeWindowsCleanupFallback?: () => void;
  readonly owner: RunOwner;
}) => Promise<TRunInteractiveStepPreparation>;

/** The rest one human interactive Turn leaves the Run at (#122, #353), decided by
 *  execution so the Application stays Harness-agnostic: `blocked` waits for the next
 *  Turn with the Step held; `halted` (resumable) releases the Step. */
type InteractiveTurnReport = {
  readonly rest: "blocked" | "halted";
};

// Run-wide cancel ends the Run cancelled; a process signal stops live work and
// leaves it resumable. Turn interrupt uses its own live binding and never fires
// the Run's controller. Execution owns the cancel/signal sentinel strings.

/** A launched Run tracked in this process (#98): its routing and Bundle facts, the
 *  owner while live (so a snapshot read never fences the executing owner), the
 *  in-memory latest state, the AbortController that stops its execution, the
 *  settlement promise a cancel awaits, the streams watching it, and its live
 *  Agent-Turn overlay (#117). */
interface TrackedRun {
  readonly digest: string;
  readonly routing: readonly RoutingNode[];
  readonly name: string;
  readonly id: string;
  readonly version: string;
  state: string;
  owner?: RunOwner;
  done: boolean;
  readonly abort: AbortController;
  promise?: Promise<OperationSettlement>;
  readonly takeover?: boolean;
  readonly observers: Set<UpdateStream>;
  readonly live: LiveOverlayState;
  /** The Step's Harness held while the Run holds that Step for the human. */
  heldStep?: RunInteractiveStep;
  steer?: RunSteerCapability;
  problem?: Problem;
}

/** A Run claimed to act on the Step it holds for the human (#122, #354): the
 *  claimed owner and its tracking, whether the ownership was already held, and the
 *  resolved record/facts. */
interface ClaimedRun {
  readonly tracking: TrackedRun;
  readonly owner: RunOwner;
  readonly ownershipWasHeld: boolean;
  readonly record: RunRecord;
  readonly facts: RunFacts;
}

/** What `beginInteractive` returns once a Run is confirmed to rest at the named
 *  interactive-agent Step (#122): the claim plus the resolved Step. */
interface InteractiveContext extends ClaimedRun {
  readonly step: AgentStep;
}

// Application owns the Workspace-approval use case behind the Projection Port.
// The Port is in-memory: it resolves paths, records approvals through the
// Catalog, and reflects durable truth back into open Projections. A submitted
// Operation is admitted at once and recorded `pending`; its settlement is
// scheduled through `scheduleSettlement`, which runs inline by default so
// approve-workspace still settles before its caller opens the Projection. A
// deferred settler (a test, later a real long-lived Run) lets an observer open
// the `operation` Projection while it is still `pending` and receive the
// settled outcome as a durable update on the same stream. The async `updates`
// stream also carries the durable change to any `workspace` Projection observing
// when the launch Workspace becomes approved.

/** Trusted presentation composition analyses bounded transient segments without
 * retaining them. Projection Port callers receive only content and edge counts. */
export type HistoryTextEdgeAnalyser = (
  source: Iterable<string>,
  start: number,
  end: number,
) => HistoryTextEdges;
export interface ApplicationDependencies {
  readonly historyTextEdges?: HistoryTextEdgeAnalyser;
  /** Invocation-start notices supplied by composition to both clients. */
  readonly startupNotices?: readonly Problem[];
  readonly catalog: Catalog;
  /** Process reaches Preflight through composition. */
  readonly process: ProcessAdapter;
  readonly workspacePathHelper?: WorkspacePathHelper;
  /** The launch Workspace path, typically the raw cwd; Application canonicalises
   *  it (A6): the roots pass the path they were given, this Module owns the
   *  `realpathSync.native` invariant. */
  readonly launchWorkspacePath: string;
  /** Install budgets a Bundle can never raise; composition wires the defaults. */
  readonly bundleBudgets?: Budgets;
  /** The running Secant engine version, for compatibility checks and the catalog note.
   *  Defaults to the dev sentinel when a caller has no version to declare. */
  readonly engineVersion?: string;
  /** The host platform the Execution summary resolves commands for. */
  readonly hostPlatform?: Platform;
  /** How a submitted Operation's settlement is scheduled. The default runs it
   *  inline: a synchronous settler (approve-workspace, cancel, delete) is already
   *  settled when an `operation` Projection opens; an async one (a Run reaching
   *  rest) settles on the operation stream's first durable update. A test supplies
   *  a controllable settler to exercise the `pending` → settled path. */
  readonly scheduleSettlement?: (
    settle: () => void | Promise<void>,
  ) => void | Promise<void>;
  /** The Run Store for the launch Workspace, opened by composition (which owns
   *  its lifetime). Absent when a caller wires no Run support; `launch-run` and
   *  the `run` Projection then report a Problem rather than executing. */
  readonly runGroup?: RunGroup;
  /** The Run execution composition constructs and hands in (see RunExecution). */
  readonly runExecution?: RunExecution;
  /** How one human interactive Turn is driven (#122); composition hands it in.
   *  Absent when a caller wires no interactive support (headless refuses interactive
   *  Bundles at Preflight, so it never reaches this seam). */
  readonly prepareRunInteractiveStep?: PrepareRunInteractiveStep;
  /** The clock the `run-list` Projection groups rows by (Today / Yesterday /
   *  Older). Defaults to the wall clock; a test injects a fixed instant (#87). */
  readonly now?: () => Date;
  /** Bound Run snapshot work during a Turn. Settlements flush immediately. */
  readonly scheduleRunUpdate?: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  readonly scheduleHistoryPreview?: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  /** Whether the launching client can relay human turn-taking (#116). Headless
   *  cannot, so it refuses an `interactive-agent` Bundle at Preflight; the TUI sets
   *  this true. Defaults to false. */
  readonly supportsInteractiveTurns?: boolean;
  /** Closed semantic Harness registry. Composition strips Adapter instances and
   * native discovery targets before handing these entries to Application. */
  readonly harnessRegistry?: readonly ApplicationHarnessRegistration[];
  /** Where the facts the Application owns are reported: Operation admission and
   *  outcome, Harness qualification, launch preparation and Preflight (#319), and
   *  the outcomes of the Step Attempts it settles, an answered authored gate and
   *  an ended interactive Step (#320). Composition fills it from the operational
   *  log; absent, they are reported nowhere. */
  readonly observe?: ApplicationObserver;
}

export interface Application {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
  /** The startup ensure (ADR 0029): install each embedded Shipped Bundle `.wfb`
   *  through ordinary ingestion as a built-in of this engine version with
   *  app-release trust. Never throws; returns one notice per file it could not
   *  install, which the `workspace` Projection also carries. Composition calls it
   *  once, before either client reads. */
  ensureShippedBundles(files: readonly string[]): readonly Problem[];
  /** End subscriptions with application-shutdown, then drain every Run this
   *  process owns with no work in flight, whatever its durable state: close its
   *  held Harness, release a blocked rest's claim without changing it, and leave
   *  follow-up waits' and mid-work claims for reconciliation. Then abort every
   *  running Run, await settlement, drain what those drives retained, and await
   *  drains already in flight. A failed drain skips no other; the call rejects
   *  with it once all have run. Composition
   *  calls this from its OS-signal handler before teardown, so no prepared Harness
   *  or child is left running. */
  shutdown(): Promise<void>;
}

// Launch inputs are a name→value string map (LaunchInput values are opaque
// strings); the resume path validates the opaque run.db payload against this
// before Preflight (A10).
const launchInputMap = z.record(z.string(), z.string());

export function createApplication(deps: ApplicationDependencies): Application {
  const { catalog, runGroup, runExecution, prepareRunInteractiveStep } = deps;
  const observe = guardedApplicationObserver(deps.observe);
  const process = deps.process;
  const launchWorkspacePath = canonicalizeWorkspacePath(
    deps.launchWorkspacePath,
  );
  const now = deps.now ?? (() => new Date());
  const subscriptions = new SubscriptionLifecycle();
  const harnessCatalog = createHarnessCatalog(
    deps.harnessRegistry ?? [],
    now,
    subscriptions,
    observe,
    catalog,
    (harness) => {
      for (const [runId, observers] of runObservers) {
        if (observers.size > 0 && runsHarness(runId) === harness)
          pushRunUpdate(runId);
      }
    },
  );
  const harnessInputRegistrations = new Map(
    (deps.harnessRegistry ?? []).map((entry) => [entry.choice.id, entry]),
  );
  const budgets = deps.bundleBudgets ?? DEFAULT_BUDGETS;
  const engineVersion = deps.engineVersion ?? "0.0.0-dev";
  // The launch-draft evaluator both `submitLaunch` (first failing check) and the
  // `launch-preparation` Projection (every finding) read, so both clients admit a
  // launch under identical rules and route a refusal to the same step (#189).
  const launchPreparation = createLaunchPreparation({
    subscriptions,
    catalog,
    budgets,
    engineVersion,
    process,
    ...(deps.hostPlatform !== undefined
      ? { hostPlatform: deps.hostPlatform }
      : {}),
    supportsInteractiveTurns: deps.supportsInteractiveTurns ?? false,
    harnessRegistry: deps.harnessRegistry ?? [],
    launchWorkspacePath,
    qualify: (id) => harnessCatalog.qualify(id),
    observe,
  });
  const operations = new OperationLedger({
    subscriptions,
    observe,
    scheduleSettlement: deps.scheduleSettlement,
  });
  const preferences = createPreferences({ catalog, operations, subscriptions });
  // A launched Run tracked in this process: its routing and Bundle facts, the
  // owner while it is live (so a snapshot read never fences the executing owner),
  // the in-memory latest state, the AbortController that stops its execution
  // (cancel-run and process signals abort it), the settlement promise a cancel
  // awaits, and the streams watching it (#98).
  const runs = new Map<string, TrackedRun>();
  const runNotices = new RunNotices();
  // Live changes awaiting their Harness's answer, per Run (#348). Each settles
  // once, synchronously, so its Run write lands before the next Turn starts.
  const pendingModelChanges = new Map<
    string,
    Set<{
      readonly choice: ModelChoice;
      settle(answer: ModelChange | undefined): void;
    }>
  >();
  const modelChoicePreparations = new Set<string>();
  function runsHarness(runId: string): string | undefined {
    const read = runGroup?.readRun(runId);
    return read?.ok ? read.run.selectedHarness : undefined;
  }
  function runModelQualification(
    runId: string,
  ): ApplicationHarnessQualification | undefined {
    const harness = runsHarness(runId);
    return harness === undefined
      ? undefined
      : harnessCatalog.qualification(harness);
  }
  // A Run's observer set outlives any one live tracking entry. A Projection opened
  // while the Run rests joins here before a later Operation creates or replaces
  // tracking, so it receives future updates for its whole lifetime (#134 A1).
  const runObservers = new Map<string, Set<UpdateStream>>();
  const history = createSessionHistory({
    textEdges: deps.historyTextEdges,
    observedOwner: (runId) => {
      const tracking = runs.get(runId);
      return tracking !== undefined && !tracking.done
        ? tracking.owner
        : undefined;
    },
    subscriptions,
    schedule:
      deps.scheduleHistoryPreview ??
      ((callback, delay) => {
        const timer = setTimeout(callback, delay);
        timer.unref();
        return () => clearTimeout(timer);
      }),
    available(runId) {
      try {
        if (runGroup === undefined) return runSupportUnavailable();
        const read = runGroup.readRun(runId);
        if (!read.ok)
          return read.problem.kind === "unknown-run"
            ? runNotFound(runId)
            : runStoreDamaged(runId);
        const foreign = liveElsewhere(runId);
        return foreign === undefined
          ? true
          : runLiveElsewhere(runId, foreign.ownerPid);
      } catch (cause) {
        return { ...runStoreDamaged(runId), cause };
      }
    },
    readEvent(runId, index) {
      try {
        const acquired = acquireForRead(runId);
        if (!acquired.ok) return acquired.problem;
        try {
          return acquired.owner.turnEventAt(index) ?? runStoreDamaged(runId);
        } finally {
          if (acquired.transient) acquired.owner.close();
        }
      } catch (cause) {
        return { ...runStoreDamaged(runId), cause };
      }
    },
    read(runId) {
      if (runGroup === undefined)
        return { found: false, problem: runSupportUnavailable() };
      const read = runGroup.readRun(runId);
      if (!read.ok)
        return {
          found: false,
          problem:
            read.problem.kind === "unknown-run"
              ? runNotFound(runId)
              : runStoreDamaged(runId),
        };
      const acquired = acquireForRead(runId);
      if (!acquired.ok) return { found: false, problem: acquired.problem };
      const { owner, transient } = acquired;
      try {
        return {
          found: true,
          records: {
            turns: owner.turns(),
            events: owner.turnEvents(),
            transcript: owner.transcript(),
            sessions: owner.harnessSessions().map((s) => s.session),
            harness: read.run.selectedHarness,
          },
        };
      } catch {
        return { found: false, problem: runStoreDamaged(runId) };
      } finally {
        if (transient) owner.close();
      }
    },
  });
  const liveOverlay = createLiveOverlay((runId) => runs.get(runId), {
    reported: reportedModelChange,
    message: (runId, message) => history.observe(runId, message),
    tool: (runId, tool) => history.observeTool(runId, tool),
    diff: (runId, diff) => history.observeDiff(runId, diff),
    thought: (runId, thought) => history.observeThought(runId, thought),
    ended: (runId) => {
      for (const pending of [...(pendingModelChanges.get(runId) ?? [])])
        pending.settle(undefined);
    },
  });
  const workspaceObservers = new Set<UpdateStream>();
  // The Run summary last pushed to Workspace observers, serialized (#396).
  let pushedRunSummary: string | undefined;
  const bundleCatalogObservers = new Set<UpdateStream>();
  const runListObservers = new Set<{
    readonly updates: UpdateStream;
    readonly resumable: boolean;
    readonly before?: string;
  }>();
  // Filled once by the startup ensure; empty until then (and in tests that skip it).
  let shippedBundles: ShippedBundleEnsure = {
    shipped: new Set(),
    notices: [],
  };
  const bundleCatalog: BundleCatalogDependencies = {
    catalog,
    budgets,
    engineVersion,
    get shipped() {
      return shippedBundles.shipped;
    },
    ...(deps.hostPlatform !== undefined
      ? { hostPlatform: deps.hostPlatform }
      : {}),
  };
  const harnessChoices = (deps.harnessRegistry ?? []).map(
    (registration) => registration.choice,
  );
  const runProjection: RunProjectionDependencies | undefined =
    runGroup === undefined
      ? undefined
      : {
          runGroup,
          catalog,
          budgets,
          ...(deps.hostPlatform !== undefined
            ? { hostPlatform: deps.hostPlatform }
            : {}),
        };

  function observersForRun(runId: string): Set<UpdateStream> {
    const existing = runObservers.get(runId);
    if (existing !== undefined) return existing;
    const observers = new Set<UpdateStream>();
    runObservers.set(runId, observers);
    return observers;
  }

  function workspaceSnapshot(): WorkspaceSnapshot {
    const approval = catalog.getWorkspaceApproval(launchWorkspacePath);
    return {
      family: "workspace",
      path: launchWorkspacePath,
      approval: approval
        ? { state: "approved", approvedAt: approval.approvedAt }
        : { state: "unapproved" },
      installedBundleCount: catalog.countInstalledBundles(),
      runSummary: summarizeRuns(runGroup),
      startupNotices: [
        ...(deps.startupNotices ?? []),
        ...shippedBundles.notices,
      ],
      harnesses: harnessChoices,
      actionOffers: approval
        ? []
        : [
            {
              action: "approve-workspace",
              input: { path: launchWorkspacePath },
            },
          ],
    };
  }

  function applyApproval(rawPath: string): OperationSettlement {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalizeWorkspacePath(rawPath);
    } catch (error) {
      return { status: "not-applied", problem: pathNotFound(rawPath, error) };
    }
    catalog.approveWorkspace(canonicalPath, new Date());
    if (canonicalPath === launchWorkspacePath) {
      const snapshot = workspaceSnapshot();
      for (const observer of workspaceObservers) {
        observer.push({ kind: "durable", snapshot });
      }
    }
    return { status: "applied" };
  }

  // Push the current Run snapshot to every observer watching this Run. Called
  // after each publication (via the wrapped owner) while the Run is live.
  function observeWindowsCleanupFallback(runId: string): void {
    if (!runNotices.observeWindowsCleanupFallback(runId)) return;
    pushRunUpdate(runId);
  }

  const pendingRunUpdates = new Map<string, () => void>();
  const scheduleRunUpdate =
    deps.scheduleRunUpdate ??
    ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    });

  function cancelRunUpdate(runId: string): void {
    pendingRunUpdates.get(runId)?.();
    pendingRunUpdates.delete(runId);
  }

  function scheduleTurnUpdate(runId: string): void {
    history.publish(runId);
    if (!runObservers.get(runId)?.size || pendingRunUpdates.has(runId)) return;
    pendingRunUpdates.set(
      runId,
      scheduleRunUpdate(() => {
        pendingRunUpdates.delete(runId);
        pushRunUpdate(runId);
      }, 50),
    );
  }

  function pushRunUpdate(runId: string, readOwner?: RunOwner): void {
    cancelRunUpdate(runId);
    if (runProjection === undefined) return;
    const tracking = runs.get(runId);
    const observers = runObservers.get(runId);
    if (observers !== undefined && observers.size > 0) {
      const snapshot = runSnapshot(runProjection, runId, {
        liveOwner: readOwner,
        modelChoicePreparation: modelChoicePreparations.has(runId),
        modelChoiceQualification: runModelQualification(runId),
        notices: runNotices.snapshot(runId),
        ...(tracking === undefined
          ? {}
          : {
              facts: {
                routing: tracking.routing,
                name: tracking.name,
                id: tracking.id,
                version: tracking.version,
                digest: tracking.digest,
              },
              ...(tracking.owner !== undefined
                ? { liveOwner: tracking.owner }
                : {}),
              state: tracking.state,
              problem: tracking.problem,
              ...(tracking.steer !== undefined
                ? { steer: tracking.steer }
                : {}),
            }),
      });
      for (const observer of observers) {
        observer.push({ kind: "durable", snapshot });
      }
    }
    history.publish(runId);
  }

  // Fan a change to the Workspace's Runs — admission, release, rest, or
  // delete — out to every Run-list page and to the Workspace's Run summary (#396).
  function pushRunCollectionUpdates(): void {
    pushRunSummary();
    if (runProjection === undefined) return;
    for (const observer of runListObservers) {
      const options = {
        resumable: observer.resumable,
        now: now(),
      };
      const snapshot = listRunsSnapshot(
        runProjection,
        observer.before === undefined
          ? options
          : { ...options, before: observer.before },
      );
      observer.updates.push({ kind: "durable", snapshot });
    }
  }

  // Push the Workspace snapshot only when its Run summary moved, so the frequent
  // Run writes that cannot change a count stay off the Workspace stream. An opened
  // Workspace observer resets the comparison, so it never misses a later change.
  function pushRunSummary(): void {
    if (workspaceObservers.size === 0) return;
    const snapshot = workspaceSnapshot();
    const summary = JSON.stringify(snapshot.runSummary);
    if (summary === pushedRunSummary) return;
    pushedRunSummary = summary;
    for (const observer of workspaceObservers) {
      observer.push({ kind: "durable", snapshot });
    }
  }

  // The registration of a Run live in ANOTHER process, or undefined when the Run is
  // not live, is live in THIS process, or its listing cannot be read (#98 S2). A Run
  // whose owner process is still alive is left live at group open (Run Store owner
  // liveness), so resuming or answering it would fence — and abort — the process
  // driving it; the caller refuses `run-live-elsewhere` instead.
  function liveElsewhere(runId: string): { ownerPid?: number } | undefined {
    if (runGroup === undefined) return undefined;
    const tracked = runs.get(runId);
    if (tracked !== undefined && !tracked.done && tracked.owner !== undefined) {
      return undefined; // live in this process
    }
    try {
      const listing = runGroup.readRunListing(runId);
      return listing?.live && !listing.ownedByThisProcess ? listing : undefined;
    } catch {
      // A malformed coordination row never throws out of submit (A4); the caller's
      // own store reads then surface it as a typed Problem.
      return undefined;
    }
  }

  // Tell every observer watching this Run that its subject is gone (#98): a delete
  // removes the store, so any open `run` Projection is closed rather than left to
  // read a Run that no longer exists. Pushed before the tracking entry is dropped.
  function pushRunClosed(runId: string): void {
    cancelRunUpdate(runId);
    history.closed(runId);
    const observers = runObservers.get(runId);
    if (observers === undefined) return;
    for (const observer of observers) observer.end("subject-gone");
  }

  // Settle a Step Attempt the Application owns — an answered authored gate or an
  // ended interactive Step — and report its outcome (#320).
  function settleAttemptOrThrow(
    owner: RunOwner,
    runId: string,
    request: PublishAttemptRequest,
  ): void {
    publishGateAttemptOrThrow(owner.publishAttempt(request));
    observe({
      kind: "attempt-end",
      runId,
      attemptId: request.attemptId,
      outcome: request.outcome,
    });
  }

  // Report only a rest this Application drive successfully commits. Execution
  // receives observedOwner too, so its writes must keep their own observer.
  function restRun(
    owner: RunOwner,
    runId: string,
    outcome: "cancelled" | "halted" | "blocked",
  ): ReturnType<RunOwner["writeState"]> {
    const result = owner.writeState(outcome);
    if (result.ok) observe({ kind: "run-rest", runId, outcome });
    return result;
  }

  // Wrap the acquired owner so each canonical write pushes a fresh Run snapshot
  // to observers. Reads delegate to the raw owner unchanged; write methods are
  // intercepted and push only after they commit.
  function observedOwner(owner: RunOwner, runId: string): RunOwner {
    const tracking = runs.get(runId);
    return {
      ...owner,
      // The raw owner refreshes its record after an upgrade write; read through it
      // so a wrapper made before the write never serves the stale value.
      get record() {
        return owner.record;
      },
      appendTurnEvent(event) {
        const receipt = owner.appendTurnEvent(history.append(runId, event));
        if (receipt.ok && receipt.event !== undefined) {
          history.appended(runId, receipt.event);
          scheduleTurnUpdate(runId);
        }
        return receipt;
      },
      settleTurn(request) {
        const receipt = owner.settleTurn(request);
        if (receipt.ok) {
          history.settled(runId, request);
          pushRunUpdate(runId);
        }
        return receipt;
      },
      selectHarness(selectedHarness) {
        const result = owner.selectHarness(selectedHarness);
        if (result.outcome === "selected") {
          history.selectedHarness(runId, selectedHarness);
          pushRunUpdate(runId);
        }
        return result;
      },
      selectModelChoice(choice) {
        const result = owner.selectModelChoice(choice);
        if (result.outcome === "selected") pushRunUpdate(runId);
        return result;
      },
      changeModelChoice(choice) {
        const result = owner.changeModelChoice(choice);
        if (result.ok) pushRunUpdate(runId, owner);
        return result;
      },
      writeState(state) {
        const previous = tracking?.state;
        const result = owner.writeState(state);
        if (result.ok && tracking !== undefined) {
          tracking.state = state;
          pushRunUpdate(runId);
          if (
            (state !== "running" && state !== "created") ||
            (state === "running" &&
              (previous === "halted" || previous === "failed"))
          )
            pushRunCollectionUpdates();
        }
        return result;
      },
      publishAttempt(request) {
        const result = owner.publishAttempt(request);
        if (result.ok) {
          if (request.advanceState !== undefined && tracking !== undefined) {
            tracking.state = request.advanceState;
          }
          pushRunUpdate(runId);
          if (
            request.advanceState !== undefined &&
            request.advanceState !== "running" &&
            request.advanceState !== "created"
          )
            pushRunCollectionUpdates();
        }
        return result;
      },
      recordMaterializationConflict(request) {
        const result = owner.recordMaterializationConflict(request);
        // The store rests the Run `halted` inside this call, so mirror that into
        // the in-memory state and push the halted snapshot to observers.
        if (result.ok && tracking !== undefined) {
          tracking.state = "halted";
          pushRunUpdate(runId);
          pushRunCollectionUpdates();
        }
        return result;
      },
      recordGateAnswer(request) {
        const result = owner.recordGateAnswer(request);
        // A `stop` advances the Run to `failed` inside this transaction; mirror
        // that advance into the in-memory state and push it to observers (#85).
        if (result.ok && request.advanceState !== undefined && tracking) {
          tracking.state = request.advanceState;
          pushRunUpdate(runId);
          if (
            request.advanceState !== "running" &&
            request.advanceState !== "created"
          )
            pushRunCollectionUpdates();
        }
        return result;
      },
      admitTurn(request) {
        history.prepare(runId);
        const result = owner.admitTurn(request);
        // A durable Turn admission makes the Turn live (#290): push it so an open
        // client sees the Turn's controls at once, not only when the Turn ends.
        if (result.ok) {
          history.admitted(runId, request);
          pushRunUpdate(runId);
        }
        return result;
      },
      recordPendingGate(request) {
        const result = owner.recordPendingGate(request);
        // Recording an authored gate rests the Run `blocked` in the same
        // transaction (#108); mirror that into the in-memory state and push the
        // blocked snapshot so an open client sees the gate at once (A3).
        if (result.ok && tracking !== undefined) {
          tracking.state = "blocked";
          pushRunUpdate(runId);
          pushRunCollectionUpdates();
        }
        return result;
      },
    };
  }

  function upgradeLegacyHarnessSelection(
    owner: RunOwner,
    routing: readonly RoutingNode[],
    runId: string,
  ): "ready" | "fenced" {
    if (
      owner.record.selectedHarness !== undefined ||
      !routingNeedsHarness(routing)
    ) {
      return "ready";
    }
    return observedOwner(owner, runId).selectHarness("claude-code").outcome !==
      "fenced"
      ? "ready"
      : "fenced";
  }

  // A Run created before every launch resolved a Model choice holds none (ADR
  // 0034). Resuming it resolves the preselection once, through the same qualify
  // path launch preparation reads, and writes it with the fenced null-only upgrade.
  // A Harness that reports nothing to preselect halts with a model correction.
  // A qualification failure is reported by the drive's own prepare. Other drives return undefined at once,
  // so it gains no await before execution starts. A fenced write throws.
  function upgradeLegacyModelChoice(
    owner: RunOwner,
    routing: readonly RoutingNode[],
    runId: string,
  ): Promise<Problem | undefined> | undefined {
    const harness = owner.record.selectedHarness;
    if (
      owner.record.modelChoice !== undefined ||
      harness === undefined ||
      !routingNeedsHarness(routing)
    ) {
      return undefined;
    }
    return harnessCatalog.qualify(harness).then((qualification) => {
      if (qualification === undefined || !qualification.ok) return;
      const registration = harnessInputRegistrations.get(harness);
      if (registration === undefined) return;
      const { preselection, preferenceNotice } = preselectModelChoice({
        catalog,
        harness: registration.choice,
        profile: qualification.profile,
        defaults: qualification.defaults,
      });
      if (preferenceNotice !== undefined)
        runNotices.setPreference(runId, preferenceNotice);
      if (preselection === undefined)
        return {
          ...modelChoiceRequired(
            registration.choice,
            qualification.defaults.kind === "unavailable"
              ? qualification.defaults.reason
              : undefined,
          ),
          explanation:
            "This Run has no Model choice. Choose a model before resuming it.",
          remediation: `Run secant run model ${runId} --model <id>, then resume the Run.`,
        };
      const written = observedOwner(owner, runId).selectModelChoice(
        preselection.choice,
      );
      if (written.outcome === "fenced") {
        throw new Error("application: legacy Model choice write was fenced.");
      }
    });
  }

  // Why the Run holds its current Step for the human, by the Projection's one
  // derivation (#354), read through the owner this process holds.
  function currentHoldBasis(
    routing: readonly RoutingNode[],
    state: string,
    owner: RunOwner,
    runId: string,
  ): HoldBasis | undefined {
    return deriveRun(routing, state, runId, owner).hold;
  }

  async function adoptHeldStep(
    report: ExecutedRunReport,
    tracking: TrackedRun,
    owner: RunOwner,
    runId: string,
  ): Promise<void> {
    if (report.heldStep === undefined) return;
    if (
      report.outcome === "blocked" &&
      currentHoldBasis(tracking.routing, tracking.state, owner, runId) !==
        undefined
    ) {
      tracking.heldStep = report.heldStep;
      tracking.steer = report.heldStep.steer;
      return;
    }
    await report.heldStep.close();
  }

  async function closeHeldStep(tracking: TrackedRun): Promise<void> {
    const heldStep = tracking.heldStep;
    if (heldStep === undefined) return;
    tracking.heldStep = undefined;
    await heldStep.close();
  }

  // Drains in flight, so shutdown also awaits one a cancel or a drive began.
  const drains = new Set<Promise<void>>();

  // Drain what this process retains for a Run it stops owning: the held Step, then
  // the claim (unless left for Store reconciliation), then the owner. `done` is set
  // before the first await, so no concurrent cancel or shutdown selects them again.
  // `leaveClaim` is read after the Step closes, inside the cleanup, so a failing
  // read still closes the owner.
  function drainRetained(
    runId: string,
    tracking: TrackedRun,
    owner: RunOwner,
    leaveClaim: () => boolean = () => false,
  ): Promise<void> {
    tracking.done = true;
    const drain = closeRetained(runId, tracking, owner, leaveClaim);
    drains.add(drain);
    const forget = () => drains.delete(drain);
    void drain.then(forget, forget);
    return drain;
  }

  async function closeRetained(
    runId: string,
    tracking: TrackedRun,
    owner: RunOwner,
    leaveClaim: () => boolean,
  ): Promise<void> {
    try {
      await closeHeldStep(tracking);
    } finally {
      tracking.owner = undefined;
      try {
        if (!leaveClaim()) owner.release();
      } finally {
        owner.close();
        pushRunUpdate(runId);
        pushRunCollectionUpdates();
      }
    }
  }

  async function driveWithAbortProtocol(params: {
    readonly runId: string;
    readonly tracking: TrackedRun;
    readonly owner: RunOwner;
    readonly drive: () => Promise<OperationSettlement>;
    readonly retainOwner: () => boolean;
    readonly setRetainOwner: (retain: boolean) => void;
  }): Promise<OperationSettlement> {
    const { runId, tracking, owner } = params;
    try {
      return await params.drive();
    } catch (error) {
      if (tracking.abort.signal.aborted) {
        if (tracking.abort.signal.reason === CANCEL_ABORT) {
          restRun(observedOwner(owner, runId), runId, "cancelled");
          params.setRetainOwner(false);
          return { status: "applied" };
        }
        params.setRetainOwner(true);
        return { status: "applied" };
      }
      return {
        status: "not-applied",
        problem: runExecutionFault(runId, error),
      };
    } finally {
      tracking.promise = undefined;
      if (params.retainOwner()) {
        tracking.done = false;
      } else {
        await drainRetained(runId, tracking, owner);
      }
    }
  }

  // Rest the Run `halted` on a selected Harness's typed preparation failure and
  // settle the Operation with its normalized Problem (#304). The one translation
  // for every drive: launch, resume, a Gate answer, an interactive ending, and a
  // reopened human Turn. The Problem is set before the write so the pushed halted
  // snapshot carries it; a fenced write leaves a replacement owner's Run untouched.
  function haltForHarnessFailure(
    runId: string,
    tracking: TrackedRun,
    observed: RunOwner,
    failure: RunHarnessPreparationFailure,
  ): OperationSettlement {
    // Preparation's typed cancellation joins the Run's own abort protocol.
    // Established startup failures retain their Harness Problem.
    if (failure.category === "preparation-cancelled")
      tracking.abort.signal.throwIfAborted();
    const problem = selectedHarnessUnavailable(runId, failure);
    const previous = tracking.problem;
    tracking.problem = problem;
    if (!restRun(observed, runId, "halted").ok) tracking.problem = previous;
    return { status: "not-applied", problem };
  }

  // Drive the routing once and decide the Operation's outcome and whether the
  // owner stays held, so every drive rests a refused Harness preparation the same
  // way (#304). Work an advancing control committed before this call stays
  // committed; a refusal only rests the Run halted after it.
  async function executeTrackedRouting(params: {
    readonly runId: string;
    readonly tracking: TrackedRun;
    readonly owner: RunOwner;
    readonly executionOwner: RunOwner;
    readonly routing: readonly RoutingNode[];
    readonly digest: string;
    /** A held Step Harness the walk takes over (#354); closed here if the walk
     *  never starts. */
    readonly heldStep?: RunInteractiveStep;
    readonly followUp?: AgentFollowUp;
  }): Promise<{
    readonly outcome: OperationSettlement;
    readonly retainOwner: boolean;
  }> {
    if (
      upgradeLegacyHarnessSelection(
        params.owner,
        params.routing,
        params.runId,
      ) === "fenced"
    ) {
      await params.heldStep?.close();
      throw new Error(
        "application: legacy Harness selection write was fenced.",
      );
    }
    // Await only a real upgrade: even `await undefined` yields, which would let a
    // shutdown abort before execution registers its listener.
    const choiceUpgrade = upgradeLegacyModelChoice(
      params.owner,
      params.routing,
      params.runId,
    );
    if (choiceUpgrade !== undefined) {
      const problem = await choiceUpgrade;
      if (problem !== undefined) {
        params.tracking.problem = problem;
        restRun(params.executionOwner, params.runId, "halted");
        return {
          outcome: { status: "not-applied", problem },
          retainOwner: false,
        };
      }
    }
    const report = await driveTrackedRouting(params);
    if (report.outcome === "harness-unavailable") {
      return {
        outcome: haltForHarnessFailure(
          params.runId,
          params.tracking,
          params.executionOwner,
          report.harnessFailure,
        ),
        retainOwner: false,
      };
    }
    await adoptHeldStep(report, params.tracking, params.owner, params.runId);
    if (report.outcome === "blocked") {
      const settlement = settleAgentCompletion(params);
      if (settlement !== undefined) return settlement;
    }
    return {
      outcome: { status: "applied" },
      retainOwner: report.outcome === "blocked",
    };
  }

  async function driveTrackedRouting(
    params: Parameters<typeof executeTrackedRouting>[0],
  ) {
    const report = await runExecution!({
      routing: params.routing,
      digest: params.digest,
      owner: params.executionOwner,
      cancelSignal: params.tracking.abort.signal,
      requestChannel: liveOverlay.requestChannel(params.runId),
      observeWindowsCleanupFallback: () =>
        observeWindowsCleanupFallback(params.runId),
      observeSteer: (capability) => {
        params.tracking.steer = capability;
      },
      ...(params.heldStep !== undefined ? { heldStep: params.heldStep } : {}),
      ...(params.followUp !== undefined ? { followUp: params.followUp } : {}),
    });
    return report;
  }

  function settleAgentCompletion(
    params: Parameters<typeof executeTrackedRouting>[0],
  ): Promise<Awaited<ReturnType<typeof executeTrackedRouting>>> | undefined {
    const last = params.owner.turns().at(-1);
    // No call preserves the synchronous boundary path. Awaiting an empty
    // settlement would leave the human's controls busy after the blocked push.
    if (
      params.tracking.state !== "blocked" ||
      params.tracking.abort.signal.aborted ||
      last?.resultKind !== "completed" ||
      params.owner
        .attemptLog()
        .some((entry) => entry.attemptId === last.attemptId) ||
      latestAgentCall(params.owner, last.attemptId) === undefined
    )
      return undefined;
    return settle();

    async function settle(): Promise<
      Awaited<ReturnType<typeof executeTrackedRouting>>
    > {
      while (
        params.tracking.state === "blocked" &&
        !params.tracking.abort.signal.aborted
      ) {
        const basis = currentHoldBasis(
          params.routing,
          "blocked",
          params.owner,
          params.runId,
        );
        if (basis?.kind !== "interactive") break;
        const step = flattenSteps(params.routing).find(
          (s): s is AgentStep =>
            s.id === basis.step.id && s.kind === "interactive-agent",
        );
        if (step === undefined) break;
        const target = interactiveStepTarget(
          params.routing,
          step,
          params.owner.attemptLog(),
        );
        const pending = latestAgentCall(params.owner, target.attemptId);
        if (
          pending?.turn.resultKind !== "completed" ||
          pending.turn.settledAt === undefined
        )
          break;
        const legality = interactiveEndLegality({
          routing: params.routing,
          step,
          control: pending.call.id,
          turnLive: true,
          attemptLog: params.owner.attemptLog(),
        });
        if (legality.kind !== "legal") break;
        await publishInteractiveEnd({
          runId: params.runId,
          owner: params.executionOwner,
          tracking: params.tracking,
          attemptId: target.attemptId,
          endsStage: pending.call.id === "stage_done",
          endedBy: "agent",
        });
        // The first walk consumed the follow-up and transferred its Harness.
        // Publication closed that handle; later walks prepare fresh work.
        const report = await driveTrackedRouting({
          ...params,
          heldStep: undefined,
          followUp: undefined,
        });
        if (report.outcome === "harness-unavailable")
          return {
            outcome: haltForHarnessFailure(
              params.runId,
              params.tracking,
              params.executionOwner,
              report.harnessFailure,
            ),
            retainOwner: false,
          };
        await adoptHeldStep(
          report,
          params.tracking,
          params.owner,
          params.runId,
        );
        if (report.outcome !== "blocked")
          return { outcome: { status: "applied" }, retainOwner: false };
      }
      return {
        outcome: { status: "applied" },
        retainOwner: params.tracking.state === "blocked",
      };
    }
  }

  async function publishInteractiveEnd(params: {
    readonly runId: string;
    readonly owner: RunOwner;
    readonly tracking: TrackedRun;
    readonly attemptId: string;
    readonly endsStage: boolean;
    readonly endedBy?: "agent";
  }) {
    await closeHeldStep(params.tracking);
    if (params.tracking.abort.signal.aborted) return;
    settleAttemptOrThrow(params.owner, params.runId, {
      attemptId: params.attemptId,
      outcome: "succeeded",
      required: [],
      outputs: [],
      at: new Date(),
      advanceState: "running",
      ...(params.endsStage ? { endsStage: true as const } : {}),
      ...(params.endedBy !== undefined ? { endedBy: params.endedBy } : {}),
    });
  }

  // Acquire the Run and drive it through the injected execution. The launch
  // Operation is `applied`
  // once the Run reaches rest (succeeded, failed, or a `blocked` pause at a Review
  // checkpoint). Ownership stays held through `blocked` and is released only when
  // the Run reaches a resting state; a fenced owner or publication fault is a coordination/environment
  // fault that execution throws, carried here as a `not-applied` Problem.
  async function runAndSettle(runId: string): Promise<OperationSettlement> {
    const tracking = runs.get(runId);
    if (
      tracking === undefined ||
      runGroup === undefined ||
      runExecution === undefined
    ) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    const owner = runGroup.acquireRun(
      runId,
      tracking.takeover === true ? { takeover: true } : undefined,
    );
    if (owner === undefined) {
      tracking.done = true;
      return { status: "not-applied", problem: runStoreDamaged(runId) };
    }
    tracking.owner = owner;
    if (tracking.takeover === true) pushRunCollectionUpdates();
    const observed = observedOwner(owner, runId);
    if (tracking.takeover === true && tracking.state === "blocked") {
      // This takeover intentionally drives no routing, so it performs the
      // resume-boundary upgrade here rather than in executeTrackedRouting.
      if (
        upgradeLegacyHarnessSelection(owner, tracking.routing, runId) ===
        "fenced"
      ) {
        tracking.owner = undefined;
        tracking.done = true;
        try {
          owner.release();
        } finally {
          owner.close();
          pushRunCollectionUpdates();
        }
        return { status: "not-applied", problem: runStoreDamaged(runId) };
      }
      tracking.promise = undefined;
      tracking.done = false;
      pushRunUpdate(runId);
      return { status: "applied" };
    }
    // A signal-abort and a blocked pause retain ownership. Every rested outcome
    // releases it in the finally.
    let leaveClaimLive = false;
    return driveWithAbortProtocol({
      runId,
      tracking,
      owner,
      drive: async () => {
        const driven = await executeTrackedRouting({
          runId,
          tracking,
          owner,
          executionOwner: observed,
          routing: tracking.routing,
          digest: tracking.digest,
        });
        leaveClaimLive = driven.retainOwner;
        return driven.outcome;
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // Start a Run's execution promise and record it on the tracking entry so a
  // concurrent cancel-run (or a process signal) can abort it and await its rest
  // (#98). Called as the launch/resume Operation's settler: invoking `runAndSettle`
  // runs its synchronous prefix (which acquires the owner) before the first await,
  // so the promise captured here already has the owner in hand.
  function startRun(runId: string): Promise<OperationSettlement> {
    const tracking = runs.get(runId);
    // A takeover that only re-acquires a Run resting `blocked` runs no execution:
    // `runAndSettle` re-fences the owner, leaves the Run blocked, and settles
    // synchronously (clearing its own `promise`). Its tracking entry must keep
    // `promise === undefined` so cancel-run and shutdown treat it as the held
    // blocked Run it is (write `cancelled`/`halted` and release the owner), not a
    // live execution to abort — so do not overwrite the promise back in that case.
    const blockedTakeover =
      tracking?.takeover === true && tracking.state === "blocked";
    const promise = runAndSettle(runId);
    if (tracking !== undefined && !blockedTakeover) tracking.promise = promise;
    return promise;
  }

  // Selector-typed per the Port overloads (#74 A8); the implementation signature
  // returns the union and the overloads narrow it for callers. The body is one
  // switch over the closed selector families, so no snapshot cast is needed here
  // or in either client.
  function openProjection(selector: {
    readonly family: "session-history";
    readonly runId: string;
    readonly session: string;
  }): OpenedProjection<SessionHistorySnapshot>;
  function openProjection(selector: {
    readonly family: "preferences";
  }): OpenedProjection<PreferencesSnapshot>;
  function openProjection(selector: {
    readonly family: "workspace";
  }): OpenedProjection<WorkspaceSnapshot>;
  function openProjection(selector: {
    readonly family: "operation";
    readonly operationId: string;
  }): OpenedProjection<OperationSnapshot>;
  function openProjection(selector: {
    readonly family: "bundle-catalog";
    readonly focus: BundleFocusSelector;
  }): OpenedProjection<BundleFocusSnapshot>;
  function openProjection(selector: {
    readonly family: "bundle-catalog";
    readonly focus?: undefined;
  }): OpenedProjection<BundleCatalogSnapshot>;
  function openProjection(selector: {
    readonly family: "harness-catalog";
    readonly focus: HarnessFocusSelector;
  }): OpenedProjection<HarnessFocusSnapshot>;
  function openProjection(selector: {
    readonly family: "harness-catalog";
    readonly focus?: undefined;
  }): OpenedProjection<HarnessCatalogSnapshot>;
  function openProjection(selector: {
    readonly family: "launch-preparation";
    readonly draft: LaunchRunInput;
  }): OpenedProjection<LaunchPreparationSnapshot>;
  function openProjection(selector: {
    readonly family: "run";
    readonly runId: string;
    readonly prepareModelChoice?: true;
  }): OpenedProjection<RunSnapshot>;
  function openProjection(selector: {
    readonly family: "run-list";
    readonly resumable?: boolean;
    readonly before?: string;
  }): OpenedProjection<RunListSnapshot>;
  function openProjection(selector: ProjectionSelector): OpenedProjection;
  function openProjection(selector: ProjectionSelector): OpenedProjection {
    if (selector.family === "session-history")
      return history.open(selector.runId, selector.session);
    if (selector.family === "preferences") return preferences.open();
    if (selector.family === "run") {
      return openRunProjection(selector.runId, selector.prepareModelChoice);
    }
    if (selector.family === "run-list") {
      const snapshot: RunListSnapshot =
        runProjection === undefined
          ? {
              family: "run-list",
              filter: selector.resumable ? "resumable" : "all",
              rows: [],
              beginningOfHistory: true,
              empty: true,
            }
          : listRunsSnapshot(runProjection, {
              resumable: selector.resumable ?? false,
              now: now(),
              ...(selector.before !== undefined
                ? { before: selector.before }
                : {}),
            });
      const updates = subscriptions.open((updates) => {
        const observer = {
          updates,
          resumable: selector.resumable ?? false,
          ...(selector.before !== undefined ? { before: selector.before } : {}),
        };
        runListObservers.add(observer);
        return () => {
          runListObservers.delete(observer);
        };
      });
      return {
        snapshot,
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    }
    if (selector.family === "bundle-catalog") {
      if (selector.focus !== undefined) {
        // A focus is a settled point-in-time inspection; no updates arrive.
        const updates = subscriptions.open();
        return {
          snapshot: focusSnapshot(bundleCatalog, selector.focus),
          catchUp: "fresh",
          updates,
          close() {
            updates.close();
          },
        };
      }
      const updates = subscriptions.open((updates) => {
        bundleCatalogObservers.add(updates);
        return () => {
          bundleCatalogObservers.delete(updates);
        };
      });
      return {
        snapshot: listSnapshot(bundleCatalog),
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    }
    if (selector.family === "harness-catalog") {
      if (selector.focus !== undefined) {
        return harnessCatalog.openFocus(selector.focus);
      }
      return harnessCatalog.openList();
    }
    if (selector.family === "launch-preparation") {
      return launchPreparation.open(selector.draft);
    }
    if (selector.family === "workspace") {
      const updates = subscriptions.open((updates) => {
        workspaceObservers.add(updates);
        pushedRunSummary = undefined;
        return () => {
          workspaceObservers.delete(updates);
        };
      });
      return {
        snapshot: workspaceSnapshot(),
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    }
    return operations.open(selector.operationId);
  }

  function openRunProjection(
    runId: string,
    prepareModelChoice = false,
  ): OpenedProjection {
    if (runProjection === undefined) {
      const updates = subscriptions.open();
      // No Run support wired: a Problem snapshot, not a throw, like an unknown id.
      return {
        snapshot: {
          family: "run",
          runId,
          result: { found: false, problem: runSupportUnavailable() },
        },
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    }
    // Reopening is itself an upgrade boundary. Derive only from the still-installed
    // pinned Snapshot, then perform the one fenced write before projecting the Run.
    // A missing/corrupt Snapshot is left untouched for `runSnapshot` to translate
    // into its existing Problem, and a foreign live owner is never fenced by a read.
    const read = runGroup?.readRun(runId);
    if (read?.ok && read.run.selectedHarness === undefined) {
      const derived = deriveRunFacts(
        runProjection,
        read.run.bundleSnapshotDigest,
      );
      if ("facts" in derived && routingNeedsHarness(derived.facts.routing)) {
        const tracking = runs.get(runId);
        const heldOwner =
          tracking !== undefined && !tracking.done ? tracking.owner : undefined;
        const owner = heldOwner ?? runProjection.runGroup.acquireRun(runId);
        if (owner !== undefined) {
          try {
            upgradeLegacyHarnessSelection(owner, derived.facts.routing, runId);
          } finally {
            if (heldOwner === undefined) owner.close();
          }
        }
      }
    }
    if (prepareModelChoice && read?.ok) modelChoicePreparations.add(runId);
    const tracking = runs.get(runId);
    const snapshot = runSnapshot(runProjection, runId, {
      modelChoicePreparation: modelChoicePreparations.has(runId),
      modelChoiceQualification: runModelQualification(runId),
      notices: runNotices.snapshot(runId),
      ...(tracking === undefined
        ? {}
        : {
            facts: {
              routing: tracking.routing,
              name: tracking.name,
              id: tracking.id,
              version: tracking.version,
              digest: tracking.digest,
            },
            ...(tracking.owner !== undefined
              ? { liveOwner: tracking.owner }
              : {}),
            state: tracking.state,
            problem: tracking.problem,
            ...(tracking.steer !== undefined ? { steer: tracking.steer } : {}),
          }),
    });
    // Every existing Run joins its Run-scoped observer set, even while rested: an
    // Operation may drive it later, and opening a Projection promises future
    // updates for the Projection's lifetime (ADR 0024).
    const updates = subscriptions.open((updates) => {
      if (!snapshot.result.found) return () => {};
      const observers = observersForRun(runId);
      observers.add(updates);
      return () => {
        observers.delete(updates);
        if (observers.size === 0) cancelRunUpdate(runId);
      };
    });
    if (snapshot.result.found) {
      if (
        prepareModelChoice &&
        snapshot.result.run.selectedHarness !== undefined &&
        liveElsewhere(runId) === undefined &&
        snapshot.result.run.state !== "succeeded" &&
        snapshot.result.run.state !== "cancelled"
      )
        void harnessCatalog.qualify(snapshot.result.run.selectedHarness);
      // A late-joining observer catches up on the current live overlay at once, so
      // a headless follower that opens after a request was raised still sees it
      // (#117). No-op when the Run has no live Turn to describe.
      if (tracking !== undefined && !tracking.done) {
        liveOverlay.push(runId, updates);
      }
      return {
        snapshot,
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    }
    return {
      snapshot,
      catchUp: "fresh",
      updates,
      close() {
        updates.close();
      },
    };
  }

  function submitApprove(
    operationId: string,
    input: { readonly path: string },
  ): SubmissionAdmission {
    return operations.submit(
      { operationId, operation: "approve-workspace", replayKey: input.path },
      () => ({ admitted: true, settle: () => applyApproval(input.path) }),
    );
  }

  function submitLaunch(
    operationId: string,
    input: LaunchRunInput,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "launch-run",
        replayKey: launchReplayKey(input),
      },
      () => {
        if (runGroup === undefined || runExecution === undefined) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        // The shared evaluator runs the ordered creation-free checks (installed
        // Bundle, Workspace approval, pinned bytes and Composition, Preflight, and
        // Trust) and returns the first failing one plus the resolved facts a create
        // needs. It is the same evaluator the `launch-preparation` Projection reads,
        // so a refusal here carries the correction target both clients route to, and
        // the Trust grant is still recorded only *after* the Run is created below —
        // a Problem here leaves no Run and no grant (#189, AC1/AC4).
        const evaluation = launchPreparation.evaluate(input);
        if (
          evaluation.findings.length > 0 ||
          evaluation.resolution === undefined
        ) {
          // Findings are non-empty whenever the resolution is absent; the fallback is
          // a defensive impossibility, not a reachable branch.
          return {
            admitted: false,
            problem: evaluation.findings[0] ?? runSupportUnavailable(),
          };
        }
        const {
          entry,
          manifest,
          selectedHarness,
          requestedModel,
          requestedEffort,
          needsGrant,
        } = evaluation.resolution;
        // Every Agent-bearing Run carries a Model choice (ADR 0034). `submit` never
        // qualifies, so it takes the choice the `launch-run` Offer resolved; a draft
        // without one was not assessed and is refused before anything is created.
        if (selectedHarness !== undefined && requestedModel === undefined) {
          // Preflight admitted the selection from this registry, so it is present.
          const registration = harnessInputRegistrations.get(selectedHarness);
          if (registration === undefined) {
            throw new Error(
              `application: Harness ${selectedHarness} is not registered.`,
            );
          }
          return {
            admitted: false,
            problem: modelChoiceRequired(registration.choice),
          };
        }

        const created = runGroup.createRun({
          operationId,
          bundleSnapshotDigest: entry.digest,
          launch: input.launchInputs,
          selectedHarness,
          ...(requestedModel !== undefined
            ? {
                modelChoice: {
                  model: requestedModel,
                  ...(requestedEffort !== undefined
                    ? { effort: requestedEffort }
                    : {}),
                },
              }
            : {}),
          at: new Date(),
        });
        if (needsGrant) {
          catalog.grantTrust({
            operationId,
            digest: entry.digest,
            installationGeneration: entry.installationGeneration,
            grantedAt: new Date(),
          });
        }
        const runId = created.runId;
        if (
          created.outcome === "created" &&
          selectedHarness !== undefined &&
          created.record.modelChoice !== undefined
        ) {
          const notice = saveLastModelChoice(
            catalog,
            selectedHarness,
            created.record.modelChoice,
          );
          if (notice !== undefined) runNotices.setPreference(runId, notice);
        }
        runs.set(runId, {
          digest: entry.digest,
          routing: manifest.routing,
          name: manifest.bundle.name,
          id: manifest.bundle.id,
          version: manifest.bundle.version,
          state: created.record.state,
          done: false,
          abort: new AbortController(),
          observers: observersForRun(runId),
          live: liveOverlay.fresh(),
        });
        pushRunCollectionUpdates();
        return {
          admitted: true,
          runId,
          settle: () => startRun(runId),
        };
      },
    );
  }

  // The Run-precondition re-check a resume runs before authorizing more work: the
  // exact pinned digest must still be installed, its bytes must still validate and
  // compose, the Bundle must still Preflight for this Workspace, and Trust must
  // still hold (ADR 0021, #86). A removed or replaced install surfaces as a
  // reinstall Problem, so a resume never runs a Bundle that could not be launched
  // fresh. Returns the manifest (its facts drive the resumed Run) or a Problem.
  interface TResumePreconditionsParams {
    readonly digest: string;
    readonly launchInputs: Readonly<Record<string, string>>;
    readonly storedHarness?: SelectedHarnessId;
  }

  function resumePreconditions(
    params: TResumePreconditionsParams,
  ): { manifest: AuthoredManifest } | { problem: Problem } {
    const { digest, launchInputs, storedHarness } = params;
    const entry = catalog.listEntries().find((e) => e.digest === digest);
    if (entry === undefined) {
      // The exact digest is no longer installed (uninstalled, or replaced by a
      // different install): its bytes cannot be trusted to be the pinned Snapshot.
      return { problem: bundleBytesMissing({ digest }) };
    }
    const bytes = catalog.readManagedBytes(digest);
    if (bytes === undefined) {
      return { problem: bundleBytesMissing({ digest }) };
    }
    const inspected = inspectBundle(bytes, budgets, [], true);
    if (!inspected.ok) {
      return {
        problem:
          ("engineUnsupported" in inspected
            ? engineProblem(inspected.engineUnsupported, engineVersion)
            : undefined) ??
          bundleBytesCorrupt({ digest }, inspected.finding.code),
      };
    }
    const manifest = inspected.inspection.manifest;
    const harnessSelection = routingNeedsHarness(manifest.routing)
      ? (storedHarness ?? "claude-code")
      : undefined;
    const pre = preflight(
      {
        manifest,
        engine: inspected.inspection.engine,
        engineVersion,
        composition: inspected.inspection.composition,
        workspacePath: launchWorkspacePath,
        launchInputs,
        hostPlatform: deps.hostPlatform,
        digest,
        supportsInteractiveTurns: deps.supportsInteractiveTurns ?? false,
        harnessSelection,
        harnessRegistry: deps.harnessRegistry ?? [],
      },
      process,
      observe,
    );
    if ("problem" in pre) return { problem: pre.problem };
    const grant = catalog.getTrustGrant(digest, entry.installationGeneration);
    if (grant === undefined) {
      return {
        problem: bundleTrustRequired(manifest, digest, deps.hostPlatform),
      };
    }
    return { manifest };
  }

  // Resume a Run resting `halted` or `failed`, or explicitly take over a live Run
  // (ADR 0019, ADR 0031): re-verify the pinned Snapshot is still installed and runnable,
  // then drive it further through the same execution — which skips the completed
  // Steps and re-runs from where it rested. A `failed` Run's declared attempt and
  // Iteration bounds reset naturally: the failed Step's Attempts never settled
  // `succeeded` (so it re-runs with a fresh retry budget), and a checkpoint stop
  // recorded the grant offset the Repeat loop restarts its interval from (#85).
  function submitResume(
    operationId: string,
    input: ResumeRunInput,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "resume-run",
        replayKey: resumeReplayKey(input),
      },
      () => {
        if (
          runGroup === undefined ||
          runExecution === undefined ||
          runProjection === undefined
        ) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        const read = runGroup.readRun(input.runId);
        if (!read.ok) {
          return {
            admitted: false,
            problem:
              read.problem.kind === "unknown-run"
                ? runNotFound(input.runId)
                : runStoreDamaged(input.runId),
          };
        }
        const record = read.run;
        const foreign = liveElsewhere(input.runId);
        const takeoverMatches =
          foreign !== undefined &&
          foreign.ownerPid !== undefined &&
          input.takeover?.ownerPid === foreign.ownerPid;
        if (foreign !== undefined && !takeoverMatches) {
          return {
            admitted: false,
            problem: runLiveElsewhere(input.runId, foreign.ownerPid),
          };
        }
        const recovery =
          record.state === "blocked" &&
          runs.get(input.runId)?.owner === undefined
            ? runSnapshot(runProjection!, input.runId, {})
            : undefined;
        const deferredCompletion =
          recovery?.result.found === true &&
          recovery.result.run.actionOffers.some(
            (offer) => offer.action === "resume-run" && offer.available,
          );
        // Resume applies to a resting Run or an unapplied clean agent call (#372). A
        // `running` record means the Run is live (here or elsewhere); resuming it would
        // fence the process driving it. A `succeeded`/`cancelled` Run is terminal.
        if (
          (takeoverMatches &&
            (record.state === "succeeded" || record.state === "cancelled")) ||
          (!takeoverMatches &&
            record.state !== "halted" &&
            record.state !== "failed" &&
            !deferredCompletion)
        ) {
          return {
            admitted: false,
            problem: runNotResumable(input.runId, record.state),
          };
        }
        // Re-check Trust, Preflight, and that the exact pinned digest is still
        // installed before authorizing more work (#86); a removed or replaced install
        // is refused with a reinstall Problem, not resumed.
        // Launch inputs are stored and read back opaque (RunRecord.launch: unknown).
        // Validate them to the string map Preflight consumes before handing them on: a
        // drifted or corrupt run.db row is a damaged store refused with a typed Problem
        // here, ahead of Preflight, never a trusted cast (A10).
        const launchInputs = launchInputMap.safeParse(record.launch ?? {});
        if (!launchInputs.success) {
          return { admitted: false, problem: runStoreDamaged(input.runId) };
        }
        const runnable = resumePreconditions({
          digest: record.bundleSnapshotDigest,
          launchInputs: launchInputs.data,
          storedHarness: record.selectedHarness,
        });
        if ("problem" in runnable) {
          return { admitted: false, problem: runnable.problem };
        }
        const manifest = runnable.manifest;
        if (!takeoverMatches) {
          const claim = runGroup.resumeRun(input.runId);
          if (claim.outcome === "run-live-elsewhere") {
            return {
              admitted: false,
              problem: runLiveElsewhere(input.runId, claim.ownerPid),
            };
          }
          if (claim.outcome === "unknown-run") {
            return { admitted: false, problem: runNotFound(input.runId) };
          }
        }
        runs.set(input.runId, {
          digest: record.bundleSnapshotDigest,
          routing: manifest.routing,
          name: manifest.bundle.name,
          id: manifest.bundle.id,
          version: manifest.bundle.version,
          state: record.state,
          done: false,
          abort: new AbortController(),
          ...(takeoverMatches ? { takeover: true } : {}),
          observers: observersForRun(input.runId),
          live: liveOverlay.fresh(),
        });
        // Takeover claims at acquire; ordinary resume already claimed here.
        if (!takeoverMatches) pushRunCollectionUpdates();
        return {
          admitted: true,
          runId: input.runId,
          settle: () => startRun(input.runId),
        };
      },
    );
  }

  // Answer the durable Human Gate a `blocked` Run rests at (#85). Admitted at
  // once; the answer is validated, recorded, and driven to the next rest at
  // settle time (deferred under a test), since deriving the current gate needs
  // the acquired owner.
  function submitAnswer(
    operationId: string,
    input: AnswerHumanGateInput,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "answer-human-gate",
        replayKey: answerReplayKey(input),
      },
      () => {
        if (
          runGroup === undefined ||
          runExecution === undefined ||
          runProjection === undefined
        ) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        return {
          admitted: true,
          runId: input.runId,
          settle: () => startAnswer(operationId, input),
        };
      },
    );
  }

  // Start an answer's settlement and record its promise on the tracking entry the
  // continue branch creates, so a concurrent cancel-run (or a process signal) can
  // abort the granted interval and await its rest (#98), mirroring `startRun`.
  function startAnswer(
    operationId: string,
    input: AnswerHumanGateInput,
  ): Promise<OperationSettlement> {
    const promise = answerAndSettle(operationId, input);
    const tracking = runs.get(input.runId);
    if (tracking !== undefined) tracking.promise = promise;
    return promise;
  }

  // Validate the answer against the live Gate, record it durably, then either end
  // the Run `failed` (`stop`) or drive the granted interval to its next rest
  // (`continue`) — in this process. A stale/mismatched Gate or a Run that is not
  // blocked settles `not-applied` and changes nothing.
  async function answerAndSettle(
    operationId: string,
    input: AnswerHumanGateInput,
  ): Promise<OperationSettlement> {
    if (
      runGroup === undefined ||
      runExecution === undefined ||
      runProjection === undefined
    ) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    const read = runGroup.readRun(input.runId);
    if (!read.ok) {
      return {
        status: "not-applied",
        problem:
          read.problem.kind === "unknown-run"
            ? runNotFound(input.runId)
            : runStoreDamaged(input.runId),
      };
    }
    const record = read.run;
    // A Run live in another process is refused before anything is claimed (#98 S2):
    // re-claiming and acquiring it would fence the process driving it.
    const foreign = liveElsewhere(input.runId);
    if (foreign !== undefined) {
      return {
        status: "not-applied",
        problem: runLiveElsewhere(input.runId, foreign.ownerPid),
      };
    }
    const derivedFacts = deriveRunFacts(
      runProjection,
      record.bundleSnapshotDigest,
    );
    if ("problem" in derivedFacts) {
      return { status: "not-applied", problem: derivedFacts.problem };
    }
    const facts = derivedFacts.facts;
    // Reject a clearly-resting or terminal record before touching coordination, so answering a
    // Run that is not blocked changes nothing at all — no claim toggle, no epoch
    // bump. (A `running` record still needs the owner to tell blocked from a live
    // mid-execution Run; that is checked once acquired.)
    if (
      record.state !== "blocked" &&
      record.state !== "running" &&
      record.state !== "created"
    ) {
      return {
        status: "not-applied",
        problem: runNotBlocked(input.runId, record.state),
      };
    }
    let tracking = runs.get(input.runId);
    let owner =
      tracking !== undefined && !tracking.done ? tracking.owner : undefined;
    const ownershipWasHeld = owner !== undefined;
    if (owner === undefined) {
      const claim = runGroup.resumeRun(input.runId);
      if (claim.outcome === "run-live-elsewhere") {
        return {
          status: "not-applied",
          problem: runLiveElsewhere(input.runId, claim.ownerPid),
        };
      }
      if (claim.outcome === "unknown-run") {
        return { status: "not-applied", problem: runNotFound(input.runId) };
      }
      owner = runGroup.acquireRun(input.runId);
      if (owner === undefined) {
        return {
          status: "not-applied",
          problem: runStoreDamaged(input.runId),
        };
      }
      tracking = {
        digest: record.bundleSnapshotDigest,
        routing: facts.routing,
        name: facts.name,
        id: facts.id,
        version: facts.version,
        state: record.state,
        owner,
        done: false,
        abort: new AbortController(),
        observers: observersForRun(input.runId),
        live: liveOverlay.fresh(),
      };
      runs.set(input.runId, tracking);
      // The claim makes this Run live here before the drive's first write.
      pushRunCollectionUpdates();
    }
    if (tracking === undefined || owner === undefined) {
      return { status: "not-applied", problem: runStoreDamaged(input.runId) };
    }
    if (
      upgradeLegacyHarnessSelection(owner, facts.routing, input.runId) ===
      "fenced"
    ) {
      if (!ownershipWasHeld) {
        tracking.owner = undefined;
        tracking.done = true;
        owner.release();
        owner.close();
        runs.delete(input.runId);
        pushRunCollectionUpdates();
      }
      return { status: "not-applied", problem: runStoreDamaged(input.runId) };
    }
    const activeTracking = tracking;
    const activeOwner = owner;
    // A signal-abort of the granted interval leaves the claim live for the next
    // open to reconcile `halted`; every other exit releases the claim (#98).
    let leaveClaimLive = ownershipWasHeld;
    return driveWithAbortProtocol({
      runId: input.runId,
      tracking: activeTracking,
      owner: activeOwner,
      drive: async () => {
        const observed = observedOwner(activeOwner, input.runId);
        const priorAnswers = activeOwner.gateAnswers();
        const derived = deriveRun(
          facts.routing,
          record.state,
          input.runId,
          activeOwner,
        );
        // Idempotent replay of the *same* operation id: settle `applied` without
        // re-validating the (now-moved) Gate or re-driving execution. Keyed on the
        // operation id, not on whether the Gate settled — a different operation
        // answering an already-answered gate must fall through to the staleness check
        // below and be refused, exactly as a moved derived checkpoint would (#108).
        // Within one process the operations map already dedupes a repeated operation
        // id (an authored gate records no `gate_answer` row, so this durable check
        // only fires for a derived checkpoint's cross-process replay). Process death
        // after a `continue` but before the interval rests leaves the Run stored
        // `running` with a live claim, so startup reconciliation (#86) rests it
        // `halted` and `run resume` re-drives it — the grant is honored, not doubled.
        const already = priorAnswers.some(
          (answer) => answer.operationId === operationId,
        );
        if (already) return { status: "applied" };

        // The live Gate the Run currently rests at: an authored gate (a durable
        // pending_gate) takes precedence over a derived Review checkpoint; a blocked
        // Run derives exactly one of the two (#108).
        const liveGate = derived.pendingGate?.gate ?? derived.checkpoint?.gate;
        if (derived.state !== "blocked" || liveGate === undefined) {
          return {
            status: "not-applied",
            problem: runNotBlocked(input.runId, derived.state),
          };
        }
        if (!gateEquals(liveGate, input.gate)) {
          return {
            status: "not-applied",
            problem: gateStale(input.runId, input.gate, liveGate),
          };
        }
        // The answer's form must match the Gate's shape (#108): a `free-text` gate
        // takes `--text`, an `approve-reject` gate takes `continue`/`stop`. A mismatch
        // changes nothing.
        const shapeMatches =
          liveGate.shape === "free-text"
            ? input.text !== undefined && input.answer === undefined
            : input.answer !== undefined && input.text === undefined;
        if (!shapeMatches) {
          return {
            status: "not-applied",
            problem: gateShapeMismatch(input.runId, liveGate.shape),
          };
        }

        // An authored gate settles its producing Attempt (#108): `free-text` publishes
        // the answer as the gate's declared `text` output and advances; approve advances
        // with no output; reject settles `failed` and rests the Run failed. All in one
        // Store boundary; the answering process then drives the Run to its next rest.
        if (derived.pendingGate !== undefined) {
          if (liveGate.shape === "free-text") {
            const outputName = derived.pendingGate.outputArtifactName;
            if (outputName === undefined) {
              throw new Error(
                "application: a free-text gate has no declared output artifact name.",
              );
            }
            settleAttemptOrThrow(observed, input.runId, {
              attemptId: input.gate.attemptId,
              outcome: "succeeded",
              required: [{ name: outputName, type: "text" }],
              outputs: [
                {
                  name: outputName,
                  type: "text",
                  content: new TextEncoder().encode(input.text!),
                },
              ],
              at: new Date(),
              advanceState: "running",
            });
          } else {
            const reject = input.answer === "stop";
            settleAttemptOrThrow(observed, input.runId, {
              attemptId: input.gate.attemptId,
              outcome: reject ? "failed" : "succeeded",
              required: [],
              outputs: [],
              at: new Date(),
              advanceState: reject ? "failed" : "running",
            });
            if (reject) {
              observe({
                kind: "run-rest",
                runId: input.runId,
                outcome: "failed",
              });
              leaveClaimLive = false;
              return { status: "applied" };
            }
          }
          // approve or free-text: drive the resumed Run to its next rest in this process.
          const driven = await executeTrackedRouting({
            runId: input.runId,
            tracking: activeTracking,
            owner: activeOwner,
            executionOwner: observed,
            routing: facts.routing,
            digest: record.bundleSnapshotDigest,
          });
          leaveClaimLive = driven.retainOwner;
          return driven.outcome;
        }

        // A derived Review checkpoint: the M2 continue/stop path (#85). The grant or
        // stop resets the checkpointed group's count at its completed Iterations.
        const answer = input.answer!;
        const iterationsAtGrant = derived.checkpointIterations ?? 0;
        const recorded = observed.recordGateAnswer({
          operationId,
          gateAttemptId: input.gate.attemptId,
          answer,
          iterationsAtGrant,
          artifactName: GATE_ANSWER_ARTIFACT,
          at: new Date(),
          ...(answer === "stop" ? { advanceState: "failed" } : {}),
        });
        if (!recorded.ok) {
          throw new Error(
            "reason" in recorded
              ? `cannot record the gate answer: ${recorded.reason}`
              : `cannot record the gate answer: ${recorded.problem.kind}`,
          );
        }
        if (answer === "stop") {
          observe({ kind: "run-rest", runId: input.runId, outcome: "failed" });
          leaveClaimLive = false;
          return { status: "applied" };
        }
        // `continue`: the answering process drives the granted interval to rest.
        const driven = await executeTrackedRouting({
          runId: input.runId,
          tracking: activeTracking,
          owner: activeOwner,
          executionOwner: observed,
          routing: facts.routing,
          digest: record.bundleSnapshotDigest,
        });
        leaveClaimLive = driven.retainOwner;
        return driven.outcome;
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // Answer one outstanding approval Harness Request on a live Agent Turn (#117).
  // Admitted at once; the answer reaches the live Turn at settle time (inline by
  // default, so a headless follower's answer unblocks the Turn promptly). The
  // request is ephemeral — never durable — so a Turn that already ended, a stale
  // generation, or an id no longer outstanding is refused precisely and answers
  // nothing. Idempotent per operation id through the ledger.
  function submitAnswerHarnessRequest(
    operationId: string,
    input: AnswerHarnessRequestInput,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "answer-harness-request",
        replayKey: answerHarnessRequestReplayKey(input),
      },
      () => {
        if (runGroup === undefined) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        return {
          admitted: true,
          runId: input.runId,
          settle: () => answerHarnessRequest(input),
        };
      },
    );
  }

  // Route one answer to the live Turn's control (#117): accepted settles the
  // Operation `applied`; a stale generation, an expired id, or a control race
  // (`expired`/`already-settled`/`shape-mismatch`) settles `not-applied` with the
  // precise Problem — the answer's provenance (`by`) is carried to the durable
  // `request-answered` timeline record by execution.
  async function answerHarnessRequest(
    input: AnswerHarnessRequestInput,
  ): Promise<OperationSettlement> {
    const tracking = runs.get(input.runId);
    if (
      tracking === undefined ||
      tracking.done ||
      tracking.live.answer === undefined ||
      !tracking.live.outstanding.has(input.requestId)
    ) {
      return {
        status: "not-applied",
        problem: harnessRequestExpired(input.runId, input.requestId),
      };
    }
    if (input.generation !== tracking.live.generation) {
      return {
        status: "not-applied",
        problem: harnessRequestStale(
          input.runId,
          input.generation,
          tracking.live.generation,
        ),
      };
    }
    const result = await tracking.live.answer(
      input.requestId,
      input.decision,
      input.by,
    );
    if (result.outcome === "rejected") {
      return {
        status: "not-applied",
        problem: harnessRequestRejected(
          input.runId,
          input.requestId,
          result.reason,
        ),
      };
    }
    if (result.outcome === "indeterminate") {
      return {
        status: "not-applied",
        problem: harnessRequestIndeterminate(input.runId, input.requestId),
      };
    }
    return { status: "applied" };
  }

  // Interrupt the live Turn of a running Run (#118). Admitted at once; the
  // interrupt is relayed at settle time and awaits its own Turn's result.
  // Idempotent per operation id.
  function submitInterruptTurn(
    operationId: string,
    input: InterruptTurnInput,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "interrupt-turn",
        replayKey: interruptTurnReplayKey(input),
      },
      () => {
        if (runGroup === undefined) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        return {
          admitted: true,
          runId: input.runId,
          settle: () => interruptTurnAndSettle(input),
        };
      },
    );
  }

  // Reach only the named live Turn's bound interrupt. Execution maps the Harness
  // receipt and this Turn's result; its outcome never waits on later Run work.
  function interruptTurnAndSettle(
    input: InterruptTurnInput,
  ): OperationSettlement | Promise<OperationSettlement> {
    const tracking = runs.get(input.runId);
    const owner =
      tracking !== undefined && !tracking.done ? tracking.owner : undefined;
    const live = owner?.turns().find((turn) => turn.resultKind === undefined);
    if (
      tracking?.live.interrupt === undefined ||
      live === undefined ||
      live.turnId !== input.turnId
    ) {
      return {
        status: "not-applied",
        problem: turnControlRejected(
          input.runId,
          "interrupt-turn",
          input.turnId,
        ),
      };
    }
    return tracking.live.interrupt().then((result) => {
      if (result.outcome === "rejected") {
        return {
          status: "not-applied",
          problem: interruptRejected(input.runId, input.turnId, result.reason),
        };
      }
      return { status: "applied" };
    });
  }

  // Steer the live Turn (#118, #148, #359). Admission refuses in ADR 0040's order,
  // before any Operation or stdin: a Harness without native steer (with its
  // recorded profile evidence, never emulated), then blank text, then the selected
  // Harness's input rules, then a command the live Session lists. An admitted
  // Steer is relayed at settle time. Idempotent per operation id.
  function submitSteerTurn(
    operationId: string,
    input: SteerTurnInput,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "steer-turn",
        replayKey: steerTurnReplayKey(input),
      },
      () => {
        if (runGroup === undefined) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        const refusal = steerRefusal(input);
        if (refusal !== undefined) return { admitted: false, problem: refusal };
        return {
          admitted: true,
          runId: input.runId,
          settle: () => steerTurnAndSettle(operationId, input),
        };
      },
    );
  }

  // The ordered Steer admission checks (ADR 0040). The prepared profile decides
  // availability (live first, then persisted with the Attempt); the rules and the
  // Session's commands share Workflow's matcher. Only a Run tracked here can hold a
  // live Turn, so the Session's commands come from its live overlay.
  function steerRefusal(input: SteerTurnInput): Problem | undefined {
    const tracking = runs.get(input.runId);
    const steer =
      tracking?.steer ?? tracking?.owner?.harnessEvidence()?.identity?.steer;
    if (steer === undefined || !steer.available) {
      return steerUnavailable(
        input.runId,
        steer?.evidence ??
          "No recorded Harness profile evidence permits same-Turn steer.",
      );
    }
    if (input.text.trim() === "") return steerBlank(input.runId);
    const selected = tracking?.owner?.record.selectedHarness;
    const reserved = reservedHarnessWord(input.runId, selected, input.text);
    if (reserved !== undefined) return reserved;
    const command = matchHarnessInputRule({
      text: input.text,
      rules: [
        {
          kind: "reserved-leading-words",
          words: tracking?.live.sessionCommands ?? [],
        },
      ],
    });
    return command === undefined
      ? undefined
      : steerSessionCommand({
          runId: input.runId,
          harness:
            inputRuleRegistration(selected)?.choice.name ??
            selected ??
            "claude-code",
          word: command,
        });
  }

  // The selected Harness's input-rule registration (ADR 0040). A pre-M4
  // unselected Run is upgraded to Claude Code on reopen and resume, so its rules
  // apply to it here too, without acquiring ownership or writing.
  function inputRuleRegistration(selected: SelectedHarnessId | undefined) {
    return harnessInputRegistrations.get(selected ?? "claude-code");
  }

  // Relay admitted same-Turn guidance to the live Turn's bound steer function
  // (#148); a native control race (`expired`/`already-settled`/`shape-mismatch`)
  // settles `not-applied` precisely. The Turn keeps working either way — steer
  // never rests the Run. A control naming a Turn that is no longer the live one is
  // rejected as a value, exactly as interrupt is.
  function steerTurnAndSettle(
    steerId: string,
    input: SteerTurnInput,
  ): OperationSettlement | Promise<OperationSettlement> {
    const tracking = runs.get(input.runId);
    const owner =
      tracking !== undefined && !tracking.done ? tracking.owner : undefined;
    const live =
      owner !== undefined
        ? owner.turns().find((turn) => turn.resultKind === undefined)
        : undefined;
    if (
      tracking === undefined ||
      tracking.live.steer === undefined ||
      live === undefined ||
      live.turnId !== input.turnId
    ) {
      return {
        status: "not-applied",
        problem: turnControlRejected(input.runId, "steer-turn", input.turnId),
      };
    }
    return tracking.live.steer({ steerId, text: input.text }).then((result) => {
      if (result.outcome === "rejected") {
        return {
          status: "not-applied",
          problem: steerRejected(input.runId, input.turnId, result.reason),
        };
      }
      if (result.outcome === "unrecorded") {
        return {
          status: "not-applied",
          problem: {
            code: "steer-not-recorded",
            explanation:
              "The Harness accepted the guidance, but Secant could not record it. Delivery is not confirmed.",
            remediation:
              "Inspect the Run's history before deciding whether to send the guidance again.",
            possibleEffects: "unknown",
            details: {
              runId: input.runId,
              turnId: input.turnId,
              reason: result.reason,
            },
          },
        };
      }
      return { status: "applied" };
    });
  }

  // --- Interactive-agent turn-taking (#122) --------------------------------
  //
  // An interactive-agent Step rests the Run `blocked` and hands its Session to the
  // human. `send-interactive-turn` drives one human Turn against that Session (the
  // Run stays blocked between Turns); `end-interactive-step` settles the Step's
  // Attempt `succeeded` at a Turn boundary and advances the Run. Both reuse the M2
  // blocked-under-owner machinery: the owner is held through `blocked`, so a Turn
  // drives against the held owner; a reopened blocked Run is resumed and re-acquired
  // like the answer path (ADR 0031). Neither branches on Bundle identity.

  /** Claim the owner of a Run to act on the Step it holds for the human (#122,
   *  #354). Reuses the held owner when the Run is live in this process; otherwise
   *  resumes and acquires it and creates a tracking entry, mirroring the answer path.
   *  `admit` refuses from the durable record before any claim is touched, so acting
   *  on a Run that clearly cannot take the control toggles no claim and bumps no
   *  epoch; `confirm` then re-derives through the claimed owner. A refusal releases
   *  an owner freshly acquired for it; a held owner stays live. */
  function claimHeldRun(
    runId: string,
    admit: (record: RunRecord, facts: RunFacts) => Problem | undefined,
    confirm: (claimed: ClaimedRun) => Problem | undefined,
  ): ClaimedRun | { readonly problem: Problem } {
    if (runGroup === undefined || runProjection === undefined) {
      return { problem: runSupportUnavailable() };
    }
    const read = runGroup.readRun(runId);
    if (!read.ok) {
      return {
        problem:
          read.problem.kind === "unknown-run"
            ? runNotFound(runId)
            : runStoreDamaged(runId),
      };
    }
    const record = read.run;
    const foreign = liveElsewhere(runId);
    if (foreign !== undefined) {
      return { problem: runLiveElsewhere(runId, foreign.ownerPid) };
    }
    const derivedFacts = deriveRunFacts(
      runProjection,
      record.bundleSnapshotDigest,
    );
    if ("problem" in derivedFacts) return { problem: derivedFacts.problem };
    const facts = derivedFacts.facts;
    const refused = admit(record, facts);
    if (refused !== undefined) return { problem: refused };
    let tracking = runs.get(runId);
    let owner =
      tracking !== undefined && !tracking.done ? tracking.owner : undefined;
    const ownershipWasHeld = owner !== undefined;
    if (owner === undefined) {
      const claim = runGroup.resumeRun(runId);
      if (claim.outcome === "run-live-elsewhere") {
        return { problem: runLiveElsewhere(runId, claim.ownerPid) };
      }
      if (claim.outcome === "unknown-run") {
        return { problem: runNotFound(runId) };
      }
      owner = runGroup.acquireRun(runId);
      if (owner === undefined) return { problem: runStoreDamaged(runId) };
      tracking = {
        digest: record.bundleSnapshotDigest,
        routing: facts.routing,
        name: facts.name,
        id: facts.id,
        version: facts.version,
        state: record.state,
        owner,
        done: false,
        abort: new AbortController(),
        observers: observersForRun(runId),
        live: liveOverlay.fresh(),
      };
      runs.set(runId, tracking);
      // The claim makes this Run live here before the drive's first write.
      pushRunCollectionUpdates();
    }
    if (tracking === undefined || owner === undefined) {
      return { problem: runStoreDamaged(runId) };
    }
    const releaseFresh = (): void => {
      if (ownershipWasHeld) return;
      tracking.owner = undefined;
      tracking.done = true;
      owner.release();
      owner.close();
      runs.delete(runId);
      pushRunCollectionUpdates();
    };
    if (
      upgradeLegacyHarnessSelection(owner, facts.routing, runId) === "fenced"
    ) {
      releaseFresh();
      return { problem: runStoreDamaged(runId) };
    }
    const claimed = { tracking, owner, ownershipWasHeld, record, facts };
    const unconfirmed = confirm(claimed);
    if (unconfirmed !== undefined) {
      releaseFresh();
      return { problem: unconfirmed };
    }
    return claimed;
  }

  /** Claim the owner of a Run blocked at the named interactive-agent Step and prove
   *  the Run currently rests there (#122). Returns everything a Turn or End needs,
   *  or a Problem. */
  function beginInteractive(
    runId: string,
    stepId: string,
  ): InteractiveContext | { readonly problem: Problem } {
    let step: AgentStep | undefined;
    const claimed = claimHeldRun(
      runId,
      (record, facts) => {
        step = flattenSteps(facts.routing).find(
          (candidate): candidate is AgentStep =>
            candidate.id === stepId && candidate.kind === "interactive-agent",
        );
        // Reject a clearly non-blocked record before touching coordination. (A
        // `running` record still needs the owner to tell blocked from a live
        // mid-execution Run.)
        return step === undefined ||
          (record.state !== "blocked" &&
            record.state !== "running" &&
            record.state !== "created")
          ? interactiveStepNotActive(runId, stepId, record.state)
          : undefined;
      },
      ({ owner, record, facts }) => {
        // Confirm the Run derives to `blocked` at this exact interactive Step — not
        // a derived checkpoint, an authored gate, or a Step it has moved past.
        const derived = deriveRun(facts.routing, record.state, runId, owner);
        const current = derived.statuses[derived.position];
        // `blocked` is the boundary (between Turns); `running` is a live human Turn,
        // which runs under `running` so a crash reconciles it via the #118 path
        // (#122). Both are "at the Step"; the caller's Turn-live check then tells a
        // boundary from a live Turn.
        const atStep =
          (derived.state === "blocked" || derived.state === "running") &&
          derived.checkpoint === undefined &&
          derived.pendingGate === undefined &&
          current?.id === stepId &&
          current.kind === "interactive-agent";
        return atStep
          ? undefined
          : interactiveStepNotActive(runId, stepId, derived.state);
      },
    );
    if ("problem" in claimed) return claimed;
    return { ...claimed, step: step! };
  }

  /** Whether a Turn is currently live for this Run: a settlement promise in flight
   *  here, or an admitted Turn with no settled result. */
  function interactiveTurnLive(tracking: TrackedRun, owner: RunOwner): boolean {
    return (
      tracking.promise !== undefined ||
      owner.turns().some((turn) => turn.resultKind === undefined)
    );
  }

  // Send one human Turn to the interactive-agent Step the Run is blocked at (#122).
  // Blank/whitespace-only text is refused at admission, before any stdin is sent.
  function submitSendInteractiveTurn(
    operationId: string,
    input: SendInteractiveTurnInput,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "send-interactive-turn",
        replayKey: sendInteractiveTurnReplayKey(input),
      },
      () => {
        if (
          runGroup === undefined ||
          prepareRunInteractiveStep === undefined ||
          runProjection === undefined
        ) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        // Secant authors nothing: a blank Turn is refused before it is admitted, so no
        // Turn is recorded and no stdin is ever written (AC1).
        if (input.text.trim() === "") {
          return {
            admitted: false,
            problem: interactiveTurnBlank(input.runId),
          };
        }
        const refused = admitHumanTurnText(input.runId, input.text);
        if (refused !== undefined) return { admitted: false, ...refused };
        return {
          admitted: true,
          runId: input.runId,
          settle: () => startSendInteractiveTurn(operationId, input),
        };
      },
    );
  }

  // Read the Run a human Turn is admitted against (#122, #354), refusing a missing
  // or damaged store and a leading word that would change Harness state Secant owns
  // (#358) — admission acquires no owner and writes nothing.
  function admitHumanTurnText(
    runId: string,
    text: string,
  ): { readonly problem: Problem } | undefined {
    const read = runGroup!.readRun(runId);
    if (!read.ok) {
      return {
        problem:
          read.problem.kind === "unknown-run"
            ? runNotFound(runId)
            : runStoreDamaged(runId),
      };
    }
    const reserved = reservedHarnessWord(runId, read.run.selectedHarness, text);
    return reserved === undefined ? undefined : { problem: reserved };
  }

  // A human Turn's or Steer's leading word that would change Harness state Secant
  // owns (#358, #359), refused without acquiring ownership or writing.
  function reservedHarnessWord(
    runId: string,
    selected: SelectedHarnessId | undefined,
    text: string,
  ): Problem | undefined {
    const registration = inputRuleRegistration(selected);
    if (registration === undefined) return undefined;
    const word = matchHarnessInputRule({
      text,
      rules: registration.inputRules,
    });
    return word === undefined
      ? undefined
      : harnessInputReserved({
          runId,
          harness: registration.choice.name,
          word,
        });
  }

  // Decide send synchronously, then run the Turn asynchronously. A refusal (support
  // unavailable, not blocked at the Step, or a Turn already live) returns WITHOUT
  // setting `tracking.promise`, so it never clobbers a genuinely live Turn's promise —
  // the signal cancel-run and shutdown read to know when the Run has actually rested.
  // Only the going-live path records the promise, mirroring `startRun`'s guard.
  // The send settles at the Turn's durable admission (#290), while `tracking.promise`
  // still spans the whole Turn; a Turn that ends unadmitted settles not-applied.
  function startSendInteractiveTurn(
    operationId: string,
    input: SendInteractiveTurnInput,
  ): Promise<OperationSettlement> {
    if (
      runGroup === undefined ||
      prepareRunInteractiveStep === undefined ||
      runProjection === undefined
    ) {
      return Promise.resolve({
        status: "not-applied",
        problem: runSupportUnavailable(),
      });
    }
    const begun = beginInteractive(input.runId, input.stepId);
    if ("problem" in begun) {
      return Promise.resolve({ status: "not-applied", problem: begun.problem });
    }
    // One Turn at a time: a live Turn refuses a new one as a value (the offer is
    // suppressed then). Checked here, so the refusal leaves `tracking.promise` intact.
    if (interactiveTurnLive(begun.tracking, begun.owner)) {
      return Promise.resolve({
        status: "not-applied",
        problem: interactiveTurnBusy(input.runId),
      });
    }
    return settleAtAdmission({
      runId: input.runId,
      operationId,
      tracking: begun.tracking,
      notAdmitted: () => interactiveTurnNotAdmitted(input.runId),
      drive: (onAdmitted) =>
        runInteractiveSend(operationId, input, begun, onAdmitted),
    });
  }

  // Run a human Turn's drive and settle its Operation at the Turn's durable
  // admission (#290, #354), while `tracking.promise` spans the whole drive for
  // cancel and shutdown. After admission the Operation has already settled, so a
  // later fault reaches clients on the Run; a drive that rests without admitting
  // the Turn settles `not-applied` with its own Problem, else `notAdmitted`.
  function settleAtAdmission(params: {
    readonly runId: string;
    readonly operationId: string;
    readonly tracking: TrackedRun;
    readonly notAdmitted: () => Problem;
    readonly drive: (onAdmitted: () => void) => Promise<OperationSettlement>;
  }): Promise<OperationSettlement> {
    const { runId, operationId, tracking } = params;
    let admitted = false;
    let settleAdmitted: (outcome: OperationSettlement) => void = () => {};
    const admission = new Promise<OperationSettlement>((resolve) => {
      settleAdmitted = resolve;
    });
    const turn = params.drive(() => {
      admitted = true;
      settleAdmitted({ status: "applied" });
    });
    tracking.promise = turn;
    const faultOnRun = (problem: Problem): OperationSettlement => {
      tracking.problem = problem;
      pushRunUpdate(runId);
      return { status: "applied" };
    };
    const turnEnd = turn.then(
      (outcome): OperationSettlement => {
        if (admitted) {
          return outcome.status === "not-applied"
            ? faultOnRun(outcome.problem)
            : { status: "applied" };
        }
        return outcome.status === "not-applied"
          ? outcome
          : { status: "not-applied", problem: params.notAdmitted() };
      },
      (error: unknown): OperationSettlement => {
        if (!admitted) throw error;
        return faultOnRun(runExecutionFault(runId, error, operationId));
      },
    );
    return Promise.race([admission, turnEnd]);
  }

  async function runInteractiveSend(
    operationId: string,
    input: SendInteractiveTurnInput,
    begun: InteractiveContext,
    onAdmitted: () => void,
  ): Promise<OperationSettlement> {
    const { tracking, owner, step } = begun;
    const { attemptId, session } = interactiveStepTarget(
      begun.facts.routing,
      step,
      owner.attemptLog(),
    );
    const turnId = `${attemptId}#human:${operationId}`;
    const observed = observedOwner(owner, input.runId);
    // The Turn admits through this owner, so its durable admission settles the send.
    const turnOwner: RunOwner = {
      ...observed,
      admitTurn(request) {
        const result = observed.admitTurn(request);
        if (result.ok) onAdmitted();
        return result;
      },
    };
    // The Run stays `blocked` between Turns, so the claim is retained on the normal
    // path and after an Interrupt; only a lost Turn, a signal, or a cancel releases it.
    let leaveClaimLive = true;
    return driveWithAbortProtocol({
      runId: input.runId,
      tracking,
      owner,
      drive: async () => {
        if (tracking.heldStep === undefined) {
          // A reopened human Turn is a resume boundary too: it prepares here,
          // without the routing drive's upgrade.
          const choiceUpgrade = upgradeLegacyModelChoice(
            owner,
            begun.facts.routing,
            input.runId,
          );
          if (choiceUpgrade !== undefined) {
            const problem = await choiceUpgrade;
            if (problem !== undefined) {
              leaveClaimLive = false;
              tracking.problem = problem;
              restRun(observed, input.runId, "halted");
              return { status: "not-applied", problem };
            }
          }
          const prepared = await prepareRunInteractiveStep!({
            cancelSignal: tracking.abort.signal,
            observeWindowsCleanupFallback: () =>
              observeWindowsCleanupFallback(input.runId),
            owner,
          });
          if (!prepared.ok) {
            leaveClaimLive = false;
            return haltForHarnessFailure(
              input.runId,
              tracking,
              observed,
              prepared.failure,
            );
          }
          tracking.heldStep = prepared.interactiveStep;
          tracking.steer = tracking.heldStep.steer;
        }
        // A live human Turn is running work, so the Run reads `running` while it runs and
        // returns to `blocked` at the next boundary. This is what makes a crash mid-Turn
        // reconcile through the #118 path (a `running` record with an unsettled Turn is
        // rested `halted`, its Session detached), rather than strand the Run blocked with
        // a Turn that can never settle (#122).
        observed.writeState("running");
        const report = await tracking.heldStep.turn({
          runId: input.runId,
          owner: turnOwner,
          routing: begun.facts.routing,
          step,
          session,
          attemptId,
          turnId,
          text: input.text,
          cancelSignal: tracking.abort.signal,
          requestChannel: liveOverlay.requestChannel(input.runId),
        });
        if (report.rest === "halted") {
          // A lost or signal-stopped Turn: rest the Run `halted`, resumable, through
          // the held owner so observers see it (#118).
          restRun(observed, input.runId, "halted");
          leaveClaimLive = false;
          return { status: "applied" };
        }
        // The Turn is recorded, an interrupted one too (#353): back to the boundary
        // for the next Turn, the Step's Harness still held.
        // `writeState` pushes the fresh snapshot (with the new transcript entry),
        // which the Turn's event and settle writes bypass observedOwner and would not push.
        restRun(observed, input.runId, "blocked");
        const settlement = settleAgentCompletion({
          runId: input.runId,
          tracking,
          owner,
          executionOwner: observed,
          routing: begun.facts.routing,
          digest: begun.record.bundleSnapshotDigest,
        });
        if (settlement !== undefined) {
          const settled = await settlement;
          leaveClaimLive = settled.retainOwner;
          return settled.outcome;
        }
        return { status: "applied" };
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // --- Follow-up after an Interrupt in an Agent Step (#354) -----------------
  //
  // An Interrupt leaves an Agent Step's Attempt open and the Run `blocked` with the
  // Step's Harness held. The follow-up is its own Operation, admitted only on that
  // derived waiting basis: it re-walks the Routing with the human's text, so Run
  // execution sends it as a human-origin Turn of the open Attempt and applies the
  // receipt validation and retry policy. It is not the interactive send.

  function submitSendFollowUpTurn(
    operationId: string,
    input: SendFollowUpTurnInput,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "send-follow-up-turn",
        replayKey: sendFollowUpTurnReplayKey(input),
      },
      () => {
        if (
          runGroup === undefined ||
          runExecution === undefined ||
          runProjection === undefined
        ) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        // Secant authors nothing: a blank follow-up is refused before it is admitted.
        if (input.text.trim() === "") {
          return { admitted: false, problem: followUpTurnBlank(input.runId) };
        }
        const refused = admitHumanTurnText(input.runId, input.text);
        if (refused !== undefined) return { admitted: false, ...refused };
        return {
          admitted: true,
          runId: input.runId,
          settle: () => startSendFollowUpTurn(operationId, input),
        };
      },
    );
  }

  // Legality is re-derived at settle time, synchronously, so a refusal never
  // overwrites a live drive's `tracking.promise`. The Operation settles at the
  // follow-up Turn's admission, as a send does (#290).
  function startSendFollowUpTurn(
    operationId: string,
    input: SendFollowUpTurnInput,
  ): Promise<OperationSettlement> {
    const notWaiting = (state: string) =>
      followUpTurnNotWaiting(input.runId, input.turnId, state);
    const claimed = claimHeldRun(
      input.runId,
      (record) =>
        record.state === "blocked" ? undefined : notWaiting(record.state),
      ({ tracking, owner, record, facts }) => {
        // A drive already in flight (a follow-up not yet admitted) holds the Step.
        if (tracking.promise !== undefined) return notWaiting("running");
        const basis = currentHoldBasis(
          facts.routing,
          record.state,
          owner,
          input.runId,
        );
        return basis?.kind === "follow-up" && basis.turn.turnId === input.turnId
          ? undefined
          : notWaiting(record.state);
      },
    );
    if ("problem" in claimed) {
      return Promise.resolve({
        status: "not-applied",
        problem: claimed.problem,
      });
    }
    return settleAtAdmission({
      runId: input.runId,
      operationId,
      tracking: claimed.tracking,
      notAdmitted: () => followUpTurnNotAdmitted(input.runId),
      drive: (onAdmitted) => runFollowUp(input, claimed, onAdmitted),
    });
  }

  async function runFollowUp(
    input: SendFollowUpTurnInput,
    claimed: ClaimedRun,
    onAdmitted: () => void,
  ): Promise<OperationSettlement> {
    const { tracking, owner, record, facts } = claimed;
    const observed = observedOwner(owner, input.runId);
    // The walk admits only one human-origin Turn — the follow-up — so its durable
    // admission settles the Operation; execution owns the Turn id.
    const executionOwner: RunOwner = {
      ...observed,
      admitTurn(request) {
        const result = observed.admitTurn(request);
        if (result.ok && request.origin === "human") onAdmitted();
        return result;
      },
    };
    // The walk takes the held Harness over; without one (after a reopen) composition
    // prepares another, which resumes the detached Session.
    const heldStep = tracking.heldStep;
    tracking.heldStep = undefined;
    let leaveClaimLive = false;
    return driveWithAbortProtocol({
      runId: input.runId,
      tracking,
      owner,
      drive: async () => {
        const driven = await executeTrackedRouting({
          runId: input.runId,
          tracking,
          owner,
          executionOwner,
          routing: facts.routing,
          digest: record.bundleSnapshotDigest,
          ...(heldStep !== undefined ? { heldStep } : {}),
          followUp: { turnId: input.turnId, text: input.text },
        });
        leaveClaimLive = driven.retainOwner;
        return driven.outcome;
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // End the interactive-agent Step the Run is blocked at (#122). Admitted at once;
  // at settle time it is refused mid-Turn, else it settles the Step's Attempt
  // succeeded and drives the Run to its next rest. Idempotent per operation id.
  // `continue-repeat` (#217) is the same settle for a Step inside a human-controlled
  // Repeat, where it opens the next iteration; `end-stage` (#218) settles it marked
  // as the human's confirmed End Stage, so the group exits instead. End Step is
  // refused inside such a group and the other two outside one, so one iteration is
  // never settled by two controls.
  function submitEndInteractiveStep(
    operationId: string,
    input: EndInteractiveStepInput | ContinueRepeatInput | EndStageInput,
    control: InteractiveControl,
  ): SubmissionAdmission {
    const replayKey =
      control === "continue-repeat"
        ? continueRepeatReplayKey(input)
        : control === "end-stage"
          ? endStageReplayKey(input)
          : endInteractiveStepReplayKey(input);
    return operations.submit(
      { operationId, operation: control, replayKey },
      () => {
        if (
          runGroup === undefined ||
          runExecution === undefined ||
          runProjection === undefined
        ) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        return {
          admitted: true,
          runId: input.runId,
          settle: () => startEndInteractiveStep(input, control),
        };
      },
    );
  }

  // Decide End synchronously (as send does), so a refusal — support unavailable, not
  // at the Step, or mid-Turn — never overwrites a live Turn's `tracking.promise`.
  function startEndInteractiveStep(
    input: EndInteractiveStepInput,
    control: InteractiveControl,
  ): Promise<OperationSettlement> {
    if (
      runGroup === undefined ||
      runExecution === undefined ||
      runProjection === undefined
    ) {
      return Promise.resolve({
        status: "not-applied",
        problem: runSupportUnavailable(),
      });
    }
    const begun = beginInteractive(input.runId, input.stepId);
    if ("problem" in begun) {
      return Promise.resolve({ status: "not-applied", problem: begun.problem });
    }
    const legality = interactiveEndLegality({
      routing: begun.facts.routing,
      step: begun.step,
      control,
      turnLive: interactiveTurnLive(begun.tracking, begun.owner),
      attemptLog: begun.owner.attemptLog(),
    });
    if (legality.kind !== "legal") {
      return Promise.resolve({
        status: "not-applied",
        problem:
          legality.kind === "refused" && legality.reason === "mid-turn"
            ? interactiveStepMidTurn(input.runId, begun.step.id)
            : interactiveControlMismatch(input.runId, begun.step.id, control),
      });
    }
    const promise = runInteractiveEnd(input, begun, control === "end-stage");
    begun.tracking.promise = promise;
    return promise;
  }

  async function runInteractiveEnd(
    input: EndInteractiveStepInput,
    begun: InteractiveContext,
    endsStage: boolean,
  ): Promise<OperationSettlement> {
    const { tracking, owner, record, facts, step } = begun;
    const observed = observedOwner(owner, input.runId);
    const { attemptId } = interactiveStepTarget(
      facts.routing,
      step,
      owner.attemptLog(),
    );
    let leaveClaimLive = false;
    return driveWithAbortProtocol({
      runId: input.runId,
      tracking,
      owner,
      drive: async () => {
        await publishInteractiveEnd({
          runId: input.runId,
          owner: observed,
          tracking,
          attemptId,
          endsStage,
        });
        const driven = await executeTrackedRouting({
          runId: input.runId,
          tracking,
          owner,
          executionOwner: observed,
          routing: facts.routing,
          digest: record.bundleSnapshotDigest,
        });
        leaveClaimLive = driven.retainOwner;
        return driven.outcome;
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // Admit a partial Run-wide choice change; qualification and writes settle later.
  function submitChangeModelChoice(
    operationId: string,
    input: ChangeModelChoiceInput,
  ): SubmissionAdmission {
    const replayKey = JSON.stringify([
      "change-model-choice",
      input.runId,
      input.model ?? null,
      input.effort ?? null,
    ]);
    return operations.submit(
      { operationId, operation: "change-model-choice", replayKey },
      () => {
        if (input.model === undefined && input.effort === undefined)
          return {
            admitted: false,
            problem: {
              code: "model-choice-change-required",
              explanation: "A Model choice change needs a model or an effort.",
              remediation:
                "Supply --model <id> or --effort <level> to secant run model.",
              possibleEffects: "none",
            },
          };
        for (const value of [input.model, input.effort]) {
          if (value !== undefined && value.trim().length === 0)
            return {
              admitted: false,
              problem: {
                code: "model-choice-blank",
                explanation: "Model and effort values must not be blank.",
                remediation: "Supply a model or effort name.",
                possibleEffects: "none",
              },
            };
        }
        return {
          admitted: true,
          runId: input.runId,
          settle: () => changeModelChoiceAndSettle(input),
        };
      },
    );
  }

  async function changeModelChoiceAndSettle(
    input: ChangeModelChoiceInput,
  ): Promise<OperationSettlement> {
    const { runId } = input;
    if (runGroup === undefined)
      return { status: "not-applied", problem: runSupportUnavailable() };
    let read = runGroup.readRun(runId);
    if (!read.ok)
      return {
        status: "not-applied",
        problem:
          read.problem.kind === "unknown-run"
            ? runNotFound(runId)
            : runStoreDamaged(runId),
      };
    // Legacy selection upgrades still belong to the existing Run owner. Modern
    // Runs need only their immutable selection, never the Bundle or Run history.
    if (read.run.selectedHarness === undefined) {
      const derived = deriveRunFacts(
        { runGroup, catalog, budgets },
        read.run.bundleSnapshotDigest,
      );
      if ("problem" in derived)
        return { status: "not-applied", problem: derived.problem };
      if (!routingNeedsHarness(derived.facts.routing))
        return {
          status: "not-applied",
          problem: {
            code: "model-choice-irrelevant",
            explanation:
              "This Run has no Agent Steps and needs no Model choice.",
            remediation: "Choose an Agent-bearing Run.",
            possibleEffects: "none",
          },
        };
      const listing = runGroup.readRunListing(runId);
      const foreign =
        listing?.live && !listing.ownedByThisProcess ? listing : undefined;
      if (foreign !== undefined)
        return {
          status: "not-applied",
          problem: runLiveElsewhere(runId, foreign.ownerPid),
        };
      const tracking = runs.get(runId);
      const held =
        tracking !== undefined && !tracking.done ? tracking.owner : undefined;
      const owner = held ?? runGroup.acquireRun(runId);
      if (owner === undefined)
        return { status: "not-applied", problem: runLiveElsewhere(runId) };
      try {
        upgradeLegacyHarnessSelection(owner, derived.facts.routing, runId);
      } finally {
        if (held === undefined) owner.close();
      }
      read = runGroup.readRun(runId);
      if (!read.ok)
        return {
          status: "not-applied",
          problem:
            read.problem.kind === "unknown-run"
              ? runNotFound(runId)
              : runStoreDamaged(runId),
        };
    }
    const initialListing = runGroup.readRunListing(runId);
    const initial = modelChoiceOffer({
      runId,
      currentChoice: read.run.modelChoice,
      state: read.run.state,
      foreignOwner:
        initialListing?.live && !initialListing.ownedByThisProcess
          ? initialListing
          : undefined,
      qualification:
        read.run.selectedHarness === undefined
          ? undefined
          : harnessCatalog.qualification(read.run.selectedHarness),
      turnLive: false,
    });
    if (!initial.available && initial.problem.code !== "model-choice-checking")
      return { status: "not-applied", problem: initial.problem };
    const harness = read.run.selectedHarness;
    if (harness !== undefined) await harnessCatalog.qualify(harness);
    // Qualification yields. Re-read canonical state, choice and ownership before
    // resolving either half or acquiring a writer; tracking alone is not authority.
    const latest = runGroup.readRun(runId);
    if (!latest.ok)
      return {
        status: "not-applied",
        problem:
          latest.problem.kind === "unknown-run"
            ? runNotFound(runId)
            : runStoreDamaged(runId),
      };
    const listing = runGroup.readRunListing(runId);
    const eligibility = modelChoiceOffer({
      runId,
      currentChoice: latest.run.modelChoice,
      state: latest.run.state,
      foreignOwner:
        listing?.live && !listing.ownedByThisProcess ? listing : undefined,
      qualification:
        latest.run.selectedHarness === undefined
          ? undefined
          : harnessCatalog.qualification(latest.run.selectedHarness),
      turnLive: false,
    });
    if (!eligibility.available)
      return { status: "not-applied", problem: eligibility.problem };
    const selected = latest.run.selectedHarness;
    const qualification =
      selected === undefined
        ? undefined
        : harnessCatalog.qualification(selected);
    const registration =
      selected === undefined
        ? undefined
        : harnessInputRegistrations.get(selected);
    if (
      selected === undefined ||
      qualification === undefined ||
      !qualification.ok ||
      registration === undefined
    )
      return { status: "not-applied", problem: runSupportUnavailable() };
    // A change still waiting for its Harness would land after this one; its
    // halves resolve against the Run's choice, which that answer may replace.
    if ((pendingModelChanges.get(runId)?.size ?? 0) > 0)
      return {
        status: "not-applied",
        problem: {
          code: "model-choice-change-pending",
          explanation: `A Model choice change is still waiting for ${registration.choice.name} to answer.`,
          remediation: "Wait for it to apply or be refused, then change again.",
          possibleEffects: "none",
        },
      };
    const resolved = resolveChangedModelChoice({
      harness: registration.choice,
      profile: qualification.profile,
      defaults: qualification.defaults,
      current: latest.run.modelChoice,
      model: input.model,
      effort: input.effort,
    });
    if (!resolved.ok)
      return {
        status: "not-applied",
        problem: {
          ...resolved.problem,
          remediation: `Run secant run model ${runId} with an available --model or --effort.`,
        },
      };
    const tracking = runs.get(runId);
    const held =
      tracking !== undefined && !tracking.done ? tracking.owner : undefined;
    const owner = held ?? runGroup.acquireRun(runId);
    if (owner === undefined)
      return { status: "not-applied", problem: runLiveElsewhere(runId) };
    const transient = held === undefined;
    try {
      const offer = modelChoiceOffer({
        runId,
        currentChoice: latest.run.modelChoice,
        state: latest.run.state,
        foreignOwner: undefined,
        qualification,
        turnLive: listing?.live === true && owner.currentTurn() !== undefined,
      });
      const change = resolved.result;
      // A change reaching the running Turn waits for its Harness to answer; the
      // Run and preference are written only once it applies (#348).
      const live = tracking?.live.changeModel;
      if (
        offer.reach === "live-turn" &&
        held !== undefined &&
        live !== undefined
      )
        return new Promise<OperationSettlement>((resolve) => {
          const pendings = pendingModelChanges.get(runId) ?? new Set();
          pendingModelChanges.set(runId, pendings);
          const pending = {
            choice: change.choice,
            // Synchronous, so the write precedes the next Turn's start.
            settle(answer: ModelChange | undefined): void {
              if (!pendings.delete(pending)) return;
              if (pendings.size === 0) pendingModelChanges.delete(runId);
              resolve(
                answer?.outcome === "refused"
                  ? {
                      status: "not-applied",
                      problem: {
                        code: "model-choice-refused",
                        explanation: modelChoiceRefusalExplanation(
                          registration.choice.name,
                          change.choice,
                          answer.reason,
                          latest.run.modelChoice,
                        ),
                        remediation: `Choose another Model choice, or run secant run model ${runId} with an available --model.`,
                        possibleEffects: "none",
                        correction: "model",
                      },
                    }
                  : commitModelChoiceChange(runId, held, selected, {
                      ...change,
                      // Unanswered by the Turn's end, it applies from the next.
                      reach:
                        answer?.outcome === "applied"
                          ? "live-turn"
                          : "next-turn",
                    }),
              );
            },
          };
          pendings.add(pending);
          void live(change.choice).then((receipt) => {
            if (receipt.outcome === "rejected") pending.settle(undefined);
          });
        });
      // A pushed read uses this writer's owner, so observation never fences it.
      return commitModelChoiceChange(runId, owner, selected, {
        ...change,
        reach: "next-turn",
      });
    } finally {
      if (transient) owner.close();
    }
  }

  /** Save a Run's committed choice as the last choice, keeping a failure's notice. */
  function saveRunModelChoice(
    runId: string,
    harness: string,
    choice: ModelChoice,
  ): void {
    const notice = saveLastModelChoice(catalog, harness, choice);
    runNotices.setPreference(runId, notice);
  }

  /** Write a resolved change to the Run, then the last-choice preference, and
   *  return the applied receipt metadata. */
  function commitModelChoiceChange(
    runId: string,
    owner: RunOwner,
    harness: string,
    result: NonNullable<OperationSnapshot["modelChoiceChange"]>,
  ): OperationSettlement {
    const written = observedOwner(owner, runId).changeModelChoice(
      result.choice,
    );
    if (!written.ok)
      return { status: "not-applied", problem: runLiveElsewhere(runId) };
    saveRunModelChoice(runId, harness, result.choice);
    runNotices.setModelChoice(runId, undefined);
    pushRunUpdate(runId, owner);
    return { status: "applied", modelChoiceChange: result };
  }

  /** A Harness answered a change on a live Turn (#348). A pending live change
   *  for the same choice settles on it. Otherwise it answered a later Turn's own
   *  request: a refusal of the Run's current choice restores the choice its
   *  Session kept, saved as the last choice, and says why. */
  function reportedModelChange(runId: string, change: ModelChange): void {
    const pending = [...(pendingModelChanges.get(runId) ?? [])].filter(
      (candidate) => sameModelChoice(candidate.choice, change.requested),
    );
    if (pending.length > 0) {
      for (const candidate of pending) candidate.settle(change);
      return;
    }
    if (change.outcome !== "refused" || change.kept === undefined) return;
    const owner = runs.get(runId)?.owner;
    const current = owner?.record.modelChoice;
    const harness = owner?.record.selectedHarness;
    if (
      owner === undefined ||
      harness === undefined ||
      current === undefined ||
      !sameModelChoice(current, change.requested)
    )
      return;
    if (!observedOwner(owner, runId).changeModelChoice(change.kept).ok) return;
    saveRunModelChoice(runId, harness, change.kept);
    runNotices.setModelChoice(
      runId,
      modelChoiceRefusalExplanation(
        harnessInputRegistrations.get(harness)?.choice.name ?? harness,
        change.requested,
        change.reason,
        change.kept,
      ),
    );
    pushRunUpdate(runId, owner);
  }

  // Cancel a live Run (#87), idempotently per Operation id.
  function submitCancel(
    operationId: string,
    runId: string,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "cancel-run",
        replayKey: cancelReplayKey(runId),
      },
      () => {
        if (runGroup === undefined) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        return {
          admitted: true,
          runId,
          settle: () => cancelAndSettle(runId),
        };
      },
    );
  }

  // Rest a live Run `cancelled` — the only route to that terminal state (#87, #98).
  // A Run live in THIS process is cancelled as an abort: stop its execution, then
  // await the `cancelled` rest the execution promise writes through the owner it
  // still holds. A non-live blocked Run is acquired, rested cancelled, and
  // released: blocked remains resumable work after its prior owner is gone. A Run
  // live in ANOTHER process is cancelled by the fresh-owner
  // epoch-bump trick, which fences the stale owner so its next canonical write is
  // refused (execution stops), then records `cancelled` and releases the claim,
  // every Artifact intact. Other resting Runs have no cancel to make.
  function cancelAndSettle(
    runId: string,
  ): OperationSettlement | Promise<OperationSettlement> {
    if (runGroup === undefined) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    const tracking = runs.get(runId);
    if (
      tracking !== undefined &&
      !tracking.done &&
      tracking.owner !== undefined &&
      tracking.promise === undefined
    ) {
      const owner = tracking.owner;
      return cancelOwnedBlockedRun(runId, tracking, owner);
    }
    if (
      tracking !== undefined &&
      !tracking.done &&
      tracking.owner !== undefined &&
      tracking.promise !== undefined
    ) {
      // Live in this process: abort execution (killing its child) and await the
      // `cancelled` rest runAndSettle writes and pushes. runAndSettle owns the owner
      // close and claim release, so nothing here fences its owner. `owner` and
      // `promise` are set inside the same synchronous prefix (see startRun), so
      // requiring both never drops a genuine in-process cancel to the fence path; it
      // only keeps the abort from resolving `applied` against a Run whose settlement
      // promise is not yet captured.
      const promise = tracking.promise;
      tracking.abort.abort(CANCEL_ABORT);
      return promise.then(() => {
        runs.delete(runId);
        return { status: "applied" };
      });
    }
    // Live elsewhere (or not tracked here): fence the stale owner and rest it. This
    // is a deliberate takeover — cancel force-rests a Run whichever process owns it —
    // so acquire with `takeover` to fence a live owner rather than be declined.
    try {
      const listing = runGroup.listRuns().find((run) => run.runId === runId);
      if (listing === undefined) {
        return { status: "not-applied", problem: runNotFound(runId) };
      }
      if (!listing.live) {
        const read = runGroup.readRun(runId);
        if (!read.ok) {
          return {
            status: "not-applied",
            problem:
              read.problem.kind === "unknown-run"
                ? runNotFound(runId)
                : runStoreDamaged(runId),
          };
        }
        if (read.run.state !== "blocked") {
          return { status: "not-applied", problem: runNotLive(runId) };
        }
        const owner = runGroup.acquireRun(runId);
        if (owner === undefined) {
          return { status: "not-applied", problem: runStoreDamaged(runId) };
        }
        try {
          restRun(observedOwner(owner, runId), runId, "cancelled");
          owner.release();
        } finally {
          owner.close();
        }
        pushRunUpdate(runId);
        runs.delete(runId);
        pushRunCollectionUpdates();
        return { status: "applied" };
      }
      const owner = runGroup.acquireRun(runId, { takeover: true });
      if (owner === undefined) {
        return { status: "not-applied", problem: runStoreDamaged(runId) };
      }
      try {
        // Our epoch is the freshest, so this write is not fenced. A concurrent
        // second cancel is the only actor that could fence it, and it is resting the
        // same Run cancelled too, so the outcome is unchanged either way.
        restRun(observedOwner(owner, runId), runId, "cancelled");
        owner.release();
      } finally {
        owner.close();
      }
      pushRunCollectionUpdates();
      runs.delete(runId);
      return { status: "applied" };
    } catch {
      // A malformed coordination row (listRuns) or a store fault settles here, the
      // way run/answer route an execution fault, so nothing throws out of submit (A4).
      return { status: "not-applied", problem: runStoreDamaged(runId) };
    }
  }

  async function cancelOwnedBlockedRun(
    runId: string,
    tracking: TrackedRun,
    owner: RunOwner,
  ): Promise<OperationSettlement> {
    restRun(observedOwner(owner, runId), runId, "cancelled");
    try {
      await drainRetained(runId, tracking, owner);
    } finally {
      runs.delete(runId);
    }
    return { status: "applied" };
  }

  // Delete a resting or terminal Run (#87). Admitted at once; applied at settle
  // time through the Run Store's admitted delete, which is idempotent per
  // operation id and a no-op on an absent Run.
  function submitDelete(
    operationId: string,
    runId: string,
  ): SubmissionAdmission {
    return operations.submit(
      {
        operationId,
        operation: "delete-run",
        replayKey: deleteReplayKey(runId),
      },
      () => {
        if (runGroup === undefined) {
          return { admitted: false, problem: runSupportUnavailable() };
        }
        return {
          admitted: true,
          runId,
          settle: () => deleteAndSettle(operationId, runId),
        };
      },
    );
  }

  function deleteAndSettle(
    operationId: string,
    runId: string,
  ): OperationSettlement {
    if (runGroup === undefined) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    try {
      return applyDelete(runGroup, operationId, runId);
    } catch {
      // A malformed coordination row (listRuns) or a store fault settles here, so
      // nothing throws out of submit (A4).
      return { status: "not-applied", problem: runStoreDamaged(runId) };
    }
  }

  function applyDelete(
    runGroup: RunGroup,
    operationId: string,
    runId: string,
  ): OperationSettlement {
    // A live Run cannot be deleted (its store is in use); cancel it first.
    // ponytail: this liveness check is not transactional with the store delete,
    // and the Run Store's admitted delete deliberately does not re-check the claim
    // (it deletes any Run, live or not). So a Run that a *different process* resumes
    // in the window between this check and the delete could have its store removed
    // out from under it — a cross-process race that M2's one-command-per-process
    // usage does not hit. Close it by deciding liveness inside `admitDelete` under
    // its BEGIN IMMEDIATE lock (as create/resume do) if concurrent delete/resume
    // ever races.
    const listing = runGroup.listRuns().find((run) => run.runId === runId);
    if (listing?.live === true) {
      return { status: "not-applied", problem: runIsLive(runId) };
    }
    // The admitted delete drops the registration then reclaims the store under a
    // `.deleting` quarantine; idempotent per operation id, and re-deleting a Run
    // already gone still settles applied.
    runGroup.deleteRun({ operationId, runId });
    // Tell any observer its subject is gone before the tracking entry is dropped (#98).
    pushRunClosed(runId);
    pushRunCollectionUpdates();
    runs.delete(runId);
    runNotices.delete(runId);
    modelChoicePreparations.delete(runId);
    return { status: "applied" };
  }

  // Acquire an owner for history and Resource reads: read through
  // the live in-process owner when one exists (so the read never fences it), else
  // acquire-and-close a rested Run, else refuse a Run live in another process
  // (acquiring would bump its fencing epoch and abort it). `transient` says the
  // caller must close the owner it was handed.
  function acquireForRead(runId: string):
    | {
        readonly ok: true;
        readonly owner: RunOwner;
        readonly transient: boolean;
      }
    | { readonly ok: false; readonly problem: Problem } {
    if (runGroup === undefined) {
      return { ok: false, problem: runSupportUnavailable() };
    }
    const live = runs.get(runId)?.owner;
    const foreign = live === undefined ? liveElsewhere(runId) : undefined;
    if (foreign !== undefined) {
      return { ok: false, problem: runLiveElsewhere(runId, foreign.ownerPid) };
    }
    const owner = live ?? runGroup.acquireRun(runId);
    if (owner === undefined) {
      return { ok: false, problem: runStoreDamaged(runId) };
    }
    return { ok: true, owner, transient: live === undefined };
  }

  // Admit at once and record `pending`; settlement is scheduled (inline by
  // default, deferred under a test) and publishes the outcome then.
  function dispatch(submission: Submission): SubmissionAdmission {
    switch (submission.operation) {
      case "change-preferences":
        return preferences.submit(submission.operationId, submission.input);
      case "approve-workspace":
        return submitApprove(submission.operationId, submission.input);
      case "launch-run":
        return submitLaunch(submission.operationId, submission.input);
      case "change-model-choice":
        return submitChangeModelChoice(
          submission.operationId,
          submission.input,
        );
      case "resume-run":
        return submitResume(submission.operationId, submission.input);
      case "answer-human-gate":
        return submitAnswer(submission.operationId, submission.input);
      case "answer-harness-request":
        return submitAnswerHarnessRequest(
          submission.operationId,
          submission.input,
        );
      case "interrupt-turn":
        return submitInterruptTurn(submission.operationId, submission.input);
      case "steer-turn":
        return submitSteerTurn(submission.operationId, submission.input);
      case "send-interactive-turn":
        return submitSendInteractiveTurn(
          submission.operationId,
          submission.input,
        );
      case "send-follow-up-turn":
        return submitSendFollowUpTurn(submission.operationId, submission.input);
      case "end-interactive-step":
      case "continue-repeat":
      case "end-stage":
        return submitEndInteractiveStep(
          submission.operationId,
          submission.input,
          submission.operation,
        );
      case "cancel-run":
        return submitCancel(submission.operationId, submission.input.runId);
      case "delete-run":
        return submitDelete(submission.operationId, submission.input.runId);
    }
  }

  const workspacePaths = createWorkspacePathSearch({
    process: deps.process,
    helper: deps.workspacePathHelper,
  });
  const projectionPort: ProjectionPort = {
    openProjection,
    submit: dispatch,
    settledOperation: (operationId) => operations.settledOperation(operationId),
    async searchWorkspacePaths(input) {
      try {
        const read = runGroup?.readRun(input.runId);
        if (
          !read?.ok ||
          read.run.state === "succeeded" ||
          read.run.state === "cancelled"
        )
          return {
            status: "unavailable",
            cause: new Error("Workspace path search requires an open Run."),
          };
        return workspacePaths.search({
          runId: input.runId,
          workspacePath: read.run.workspacePath,
          query: input.query,
          signal: input.signal,
          onProgress: input.onProgress,
        });
      } catch (cause) {
        return { status: "unavailable", cause };
      }
    },

    readHistoryContent: history.readContent,
    releaseHistoryRead: history.releaseContent,
    readResource(
      reference:
        ResourceReference | DiagnosticReference | HarnessDiagnosticReference,
    ): ResourceRead {
      if (reference.type === "harness-diagnostic") {
        return harnessCatalog.readDiagnostic(reference);
      }
      const acquired = acquireForRead(reference.runId);
      if (!acquired.ok) return { found: false, problem: acquired.problem };
      const { owner, transient } = acquired;
      try {
        const bytes =
          reference.type === "diagnostic"
            ? owner.readDiagnostic(reference.diagnosticId)
            : owner.readArtifact(reference.versionId, reference.artifactName);
        if (bytes === undefined) {
          return {
            found: false,
            problem:
              reference.type === "diagnostic"
                ? runDiagnosticMissing(reference)
                : runOutputMissing(reference),
          };
        }
        return {
          found: true,
          type: reference.type,
          content: new TextDecoder().decode(bytes),
        };
      } finally {
        if (transient) owner.close();
      }
    },

    readTranscript(
      reference: TranscriptPageReference | TranscriptExportReference,
    ): TranscriptRead {
      const acquired = acquireForRead(reference.runId);
      if (!acquired.ok) return { found: false, problem: acquired.problem };
      const { owner, transient } = acquired;
      try {
        return readTranscriptResource(owner, reference);
      } finally {
        if (transient) owner.close();
      }
    },
  };

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    for (const runId of pendingRunUpdates.keys()) cancelRunUpdate(runId);
    history.shutdown();
    operations.endObservation();
    subscriptions.shutdown();
    return (shutdownPromise ??= Promise.allSettled([
      workspacePaths.close(),
      shutdownRuns(),
    ])
      .then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            "application: shutdown cleanup failed",
          );
      })
      .finally(() => {
        shutdownPromise = undefined;
      }));
  }

  async function shutdownRuns(): Promise<void> {
    // Establish every live Run's shutdown reason before any cleanup can yield.
    // Composition already cancelled pending preparations; a retained Step may
    // close slowly while those preparations settle. Capture the same promises we
    // abort, since their drives clear tracking.promise at settlement (#437).
    const live = [...runs.values()].flatMap((tracking) => {
      if (tracking.done || tracking.promise === undefined) return [];
      const settlement = tracking.promise.catch(() => undefined);
      tracking.abort.abort(SIGNAL_ABORT);
      return [settlement];
    });
    // Drain idle retained owners, await the live drives, then drain what those
    // drives retained. Signal-stopped work leaves its claim for reconciliation.
    // A failed drain skips no other drain or abort; shutdown rejects after all
    // cleanup finishes. Also await a drain a cancel or drive already began.
    const failures = await drainOwnedIdleRuns();
    await Promise.all(live);
    failures.push(...(await drainOwnedIdleRuns()));
    // Their own callers report those drains' failures.
    await Promise.allSettled(drains);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "application: shutdown cleanup failed",
      );
    }
  }

  // Select by retained ownership, never the durable state: a drive that faulted
  // mid-Turn leaves its owner and Step held with the Run still `running` (#385).
  async function drainOwnedIdleRuns(): Promise<unknown[]> {
    const owned = [...runs.entries()].filter(
      ([, tracking]) =>
        !tracking.done &&
        tracking.promise === undefined &&
        tracking.owner !== undefined,
    );
    const failures: unknown[] = [];
    for (const [runId, tracking] of owned) {
      const owner = tracking.owner!;
      try {
        await drainRetained(runId, tracking, owner, () =>
          leavesClaimAtShutdown(runId, tracking, owner),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  // Gates, checkpoints, and interactive waits keep their blocked rest and release
  // ownership, so they stay answerable. An interrupted Agent Step's waiting claim
  // is left for Store reconciliation to halt on reopen (ADR 0035), as is any Run
  // stopped mid-work: released, an unowned `running` record is never reconciled.
  function leavesClaimAtShutdown(
    runId: string,
    tracking: TrackedRun,
    owner: RunOwner,
  ): boolean {
    if (tracking.state !== "blocked") return true;
    return (
      currentHoldBasis(tracking.routing, tracking.state, owner, runId)?.kind ===
      "follow-up"
    );
  }

  const bundleManagementDeps: BundleManagementDependencies = {
    inputRules: mergeHarnessInputRules(
      (deps.harnessRegistry ?? []).map((entry) => entry.inputRules),
    ),
    catalog,
    budgets: bundleCatalog.budgets,
    engineVersion,
    onInstalled() {
      // A fresh install changes the list; push the new snapshot to observers.
      if (bundleCatalogObservers.size === 0) return;
      const snapshot = listSnapshot(bundleCatalog);
      for (const observer of bundleCatalogObservers) {
        observer.push({ kind: "durable", snapshot });
      }
    },
  };

  return {
    projectionPort,
    shutdown,
    bundleManagement: createBundleManagement(bundleManagementDeps),
    ensureShippedBundles(files) {
      shippedBundles = ensureShippedBundles(
        bundleManagementDeps,
        files,
        bundleCatalog.engineVersion,
      );
      return [...(deps.startupNotices ?? []), ...shippedBundles.notices];
    },
  };
}

function gateEquals(a: RunGateReference, b: RunGateReference): boolean {
  return (
    a.runId === b.runId &&
    a.stepId === b.stepId &&
    a.attemptId === b.attemptId &&
    a.shape === b.shape
  );
}

/** Settle an authored gate's producing Attempt (#108). A fenced owner or an
 *  unstageable answer is a coordination/environment fault the answer use case
 *  owns; a replay of an already-settled gate remains a silent no-op. */
function publishGateAttemptOrThrow(
  result: ReturnType<RunOwner["publishAttempt"]>,
): void {
  if (result.ok) return;
  throw new Error(
    "reason" in result
      ? `cannot settle the gate answer: ${result.reason}`
      : `cannot settle the gate answer: ${result.problem.kind}`,
  );
}
