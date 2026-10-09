import {
  PreparationOwner,
  type PreparationClock,
} from "./preparation-owner.js";
import { TurnEventProducer } from "./turn-event-producer.js";
import { reportContainment } from "./containment.js";
// The Claude Code Harness Adapter — private to the Harness Module, re-exported
// from `harness.ts` only through its factory. It discovers and qualifies the
// executable, then owns named stream-json Sessions and normalizes their Turns.
// Process spawning, pipe backpressure, and cleanup stay in the `process` Module;
// Claude-native frames and identifiers stay behind this Seam: the stream-json
// protocol model (schemas and pure readers) is the private `claude-code/frames.ts`,
// and this file only dispatches on what it parsed.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type {
  OwnedProcess,
  OwnedProcessClose,
  ProcessAdapter,
} from "../process/process.js";
import { readSettings } from "./claude-code/settings.js";
import { ControlChannel, type ControlOutcome } from "./claude-code/control.js";
import {
  ClaudeEffort,
  contentBlocks,
  observedToolStart,
  observedToolResult,
  encodeUserMessage,
  mcpServers,
  encodeElicitationDecline,
  type ElicitationFrame,
  contextObservation,
  isAbortedResult,
  isAuthenticationResult,
  parseFrame,
  sessionFacts,
  usageObservation,
  type CommandLifecycleFrame,
  type InitFrame,
  type MessageFrame,
  type ParsedFrame,
  type ResultFrame,
  type StatusFrame,
  type StreamEventFrame,
} from "./claude-code/frames.js";
import { APPROVAL_DECISIONS } from "./harness.js";
import type {
  AgentCall,
  AgentCallReply,
  AgentCallAnswer,
  AgentCallDeclaration,
  CleanupReport,
  ControlReceipt,
  HarnessAdapter,
  HarnessDefaults,
  HarnessFailure,
  HarnessPhaseObserver,
  HarnessContainmentObserver,
  HarnessPlatform,
  HarnessProfile,
  HarnessRequest,
  HarnessTurn,
  ModelChange,
  ModelChoice,
  ModelEntry,
  ModelObservation,
  PrepareOptions,
  PrepareResult,
  PreparedHarness,
  RecoveryCoordinate,
  RequestAnswer,
  RequestId,
  SessionAvailability,
  SteerCapability,
  SteerInput,
  SteerSettlement,
  TurnEventListener,
  ToolCall,
  TurnRequest,
  TurnResult,
  TurnSubscription,
  UsageObservation,
} from "./harness.js";
import { JsonlLineReader } from "./jsonl.js";
import { settleCleanup, startPhase, type PhaseSpan } from "./phases.js";
import { modelChoiceRefusal } from "./model-request.js";
import { writableDirectoryFailure } from "./writable-directory.js";
import {
  EXPIRED_MESSAGE,
  startPermissionBridge,
  bindAgentCallDeclarations,
  type ApprovalOutcome,
  type ApprovalRequest,
  type PermissionBridge,
} from "./permission-bridge.js";
import { redactSecrets, redactText } from "./secrets.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  CLAUDE_CODE_SERVED_CAPABILITIES,
  discoverClaudeCode,
  discoveredHarnessTarget,
  type DiscoveredHarnessTarget,
} from "./discovery.js";

/** The message a denied approval returns to the bridge caller. Claude sees it
 *  and adjusts its approach. */
const DENY_MESSAGE = "The tool use was denied.";

/** This Adapter's revision, stamped onto every profile it produces so a cached
 *  qualification from an older Adapter is never mistaken for a current one. */
const ADAPTER_REVISION = "claude-code-7";

const HARNESS_NAME = "claude-code";

/** The version probe's own timeout. Per ADR 0022 only launch/probe steps are
 *  bounded; agent thought and tools never are. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
/** Bounds a native stop from the `control_request` write through the aborted
 *  `result` that confirms it. Claude Code answers in milliseconds (#255), so a
 *  stop still unconfirmed at this bound falls back to the process stop. */
const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;
const MAX_STDERR_BYTES = 64 * 1024;

/** The exact remediation surfaced when Claude Code is not authenticated. Secant
 *  transports no credentials, so the fix is always to log in through Claude Code
 *  itself. The raw result is never carried across the Seam — it may quote a key. */
const AUTHENTICATION_REQUIRED =
  "Authentication required for Claude Code. Log in separately through Claude Code, then retry.";

/** Test seams, all optional; production passes none and the real PATH walk,
 *  host platform, and `process.env` decide. They mirror the process Module's
 *  own `ResolveExecutableOptions`, so the Windows `.cmd`-shim and refusal paths
 *  are driven cross-OS exactly as that Module drives them. */
export interface ClaudeCodeAdapterOverrides {
  /** Deterministic initial-cleanup clock/timer Seam. Production omits it. */
  readonly preparationClock?: PreparationClock;
  /** Where the configured-executable env var is read (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Host platform for the profile and the shim rule (default `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Override PATH the walk searches; the real `which` still decides the match. */
  readonly path?: string;
  /** Replace the PATH walk entirely, so the shim rule is testable off Windows. */
  readonly resolve?: (name: string) => string | undefined;
  readonly probeTimeoutMs?: number;
  /** Bounds a native stop before the process-stop fallback, so a replayed
   *  unanswered `control_request` falls back within a test's bound. */
  readonly controlTimeoutMs?: number;
  /** Bounds the wait for init, so a scripted silent process times out within
   *  a test's bound. */
  readonly handshakeTimeoutMs?: number;
  /** Override UUID generation for deterministic protocol replay. */
  readonly sessionId?: () => string;
}

/** The factory a composition root calls. Each `prepare` supplies the Process
 *  Interface and phase observer its Prepared Harness uses; the Adapter keeps
 *  its qualification cache and owns initial acquisitions until handoff. The overrides exist only for tests. */
export function createClaudeCodeAdapter(
  overrides: ClaudeCodeAdapterOverrides,
): HarnessAdapter {
  return new ClaudeCodeAdapter(overrides);
}

/** A resolved, spawnable Claude Code target. */
interface DiscoveredTarget extends DiscoveredHarnessTarget {
  readonly source: string;
}

class ClaudeCodeAdapter implements HarnessAdapter {
  private readonly preparations: PreparationOwner;

  close(options?: Parameters<HarnessAdapter["close"]>[0]) {
    return this.preparations.close(options);
  }

  prepare(options: PrepareOptions): Promise<PrepareResult> {
    return this.preparations.prepare(options, (scoped) => this.acquire(scoped));
  }

  /** Qualification cache, private to the Adapter, keyed by the discovered
   *  target's path and file identity. Same path + identical bytes ⇒ the probed
   *  version cannot have changed, so the cached profile is reused without
   *  re-running `--version`; any drift in either requalifies. */
  private readonly cache = new Map<string, HarnessProfile>();

  constructor(private readonly overrides: ClaudeCodeAdapterOverrides) {
    this.preparations = new PreparationOwner(overrides.preparationClock);
  }

  private async acquire(options: PrepareOptions): Promise<PrepareResult> {
    const refuse = (failure: HarnessFailure): PrepareResult => {
      return { ok: false, failure };
    };
    const platform = harnessPlatform(
      this.overrides.platform ?? process.platform,
    );
    if (platform === undefined) {
      return refuse(
        failure(
          "unsupported-platform",
          `Claude Code is not supported on platform '${process.platform}'.`,
        ),
      );
    }
    const writableFailure = writableDirectoryFailure(options.writableDirectory);
    if (writableFailure !== undefined) {
      return refuse(writableFailure);
    }

    const processAdapter = options.process;
    const discovery = this.discover(processAdapter, options);
    if (!discovery.ok) return refuse(discovery.failure);
    const target = discovery.target;
    const spawn: ProcessAdapter["spawnOwnedProcess"] = (spawnOptions) =>
      processAdapter.spawnOwnedProcess(spawnOptions);

    const timeouts: SessionTimeouts = {
      controlMs: this.overrides.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
      handshakeMs:
        this.overrides.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    };
    const identity = fileIdentity(target.identityPath);
    // Keyed by the target's path and file identity (the spec's cache key); the
    // discovery route is folded in too so a reused profile never reports a stale
    // source (e.g. "configured command" after the same file is later found on PATH).
    const cacheKey = `${target.source}\0${target.identityPath}\0${identity ?? "?"}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return {
        ok: true,
        harness: new ClaudeCodePreparedHarness(
          cached,
          target,
          options.workspace,
          this.overrides.sessionId ?? randomUUID,
          spawn,
          options.writableDirectory,
          options.phases,
          timeouts,
          options.containment,
        ),
      };
    }

    const probe = await this.probeVersion(processAdapter, target);
    if (!probe.ok) return refuse(probe.failure);

    const profile = buildProfile(target, probe.version, platform);
    this.cache.set(cacheKey, profile);
    return {
      ok: true,
      harness: new ClaudeCodePreparedHarness(
        profile,
        target,
        options.workspace,
        this.overrides.sessionId ?? randomUUID,
        spawn,
        options.writableDirectory,
        options.phases,
        timeouts,
        options.containment,
      ),
    };
  }

  /** Discover in order: an explicit configured command or path (the env var, or
   *  the caller's `configuredExecutable`) first, then the canonical PATH name
   *  `claude`. `not-found` names every searched location; an unparsable shim is
   *  the distinct `unsupported-shim` and is not fallen through. */
  private discover(
    processAdapter: ProcessAdapter,
    options: PrepareOptions,
  ):
    | { ok: true; target: DiscoveredTarget }
    | { ok: false; failure: HarnessFailure } {
    const discovery = discoverClaudeCode(processAdapter, {
      ...(options.configuredExecutable !== undefined
        ? { configuredExecutable: options.configuredExecutable }
        : {}),
      env: this.overrides.env ?? process.env,
      ...(this.overrides.platform !== undefined
        ? { platform: this.overrides.platform }
        : {}),
      ...(this.overrides.path !== undefined
        ? { path: this.overrides.path }
        : {}),
      ...(this.overrides.resolve !== undefined
        ? { resolve: this.overrides.resolve }
        : {}),
    });
    if (discovery.kind === "found") {
      return {
        ok: true,
        target: {
          source: discovery.attempt.description,
          ...discoveredHarnessTarget(discovery),
        },
      };
    }
    if (discovery.kind === "unsupported-shim") {
      return {
        ok: false,
        failure: failure(
          "unsupported-shim",
          `Refusing ${discovery.attempt.description}: '${discovery.path}' is a Windows shim the resolver cannot parse. Name the interpreter, or point ${CLAUDE_CODE_EXECUTABLE_ENV} at the real executable.`,
        ),
      };
    }
    return {
      ok: false,
      failure: failure(
        "not-found",
        "No Claude Code executable found. Searched: " +
          discovery.attempts.map((attempt) => attempt.description).join(", ") +
          ".",
      ),
    };
  }

  /** Probe `<executable> --version` and nothing else — the only argv this slice
   *  builds. stdin is closed by `spawnCommand`, so no content is ever sent. */
  private async probeVersion(
    processAdapter: ProcessAdapter,
    target: DiscoveredTarget,
  ): Promise<
    { ok: true; version: string } | { ok: false; failure: HarnessFailure }
  > {
    const result = await processAdapter.spawnCommand({
      role: "harness-probe",
      executable: target.executable,
      args: [...target.prefixArgs, "--version"],
      cwd: undefined,
      env: process.env,
      timeoutMs: this.overrides.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxCaptureBytes: 64 * 1024,
      truncationMarker: "…",
    });
    if (result.kind !== "exited") {
      return {
        ok: false,
        failure: failure(
          "version-probe",
          `Could not run '${target.executable} --version' (${result.kind}).`,
        ),
      };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        failure: {
          ...failure(
            "version-probe",
            `'${target.executable} --version' exited ${result.status}.`,
          ),
          nativeCode: String(result.status),
        },
      };
    }
    const version = new TextDecoder().decode(result.text).trim();
    if (version.length === 0) {
      return {
        ok: false,
        failure: failure(
          "version-probe",
          `'${target.executable} --version' produced no version output.`,
        ),
      };
    }
    return { ok: true, version };
  }
}

/** The bounds a Session's native exchanges run under. */
interface SessionTimeouts {
  /** A native stop, from the `control_request` write through its result. */
  readonly controlMs: number;
  /** The wait for a process's init. */
  readonly handshakeMs: number;
}

/** One prepared Harness owns every live named Session for one Workspace. It
 * permits one active Turn globally, while retaining each idle Session process
 * for a later Turn. */
class ClaudeCodePreparedHarness implements PreparedHarness {
  private readonly sessions = new Map<string, ClaudeCodeSession>();
  private active: ClaudeCodeTurn | undefined;
  private closed = false;
  private closePromise: Promise<CleanupReport> | undefined;
  /** One MCP permission bridge per prepared Harness, created lazily on the first
   *  launch that could prompt for permission, so a Harness that never runs a
   *  Turn pays nothing. #117 decides which Runs launch a Turn at all. */
  private bridgePromise: Promise<PermissionBridge> | undefined;
  private defaultsPromise: Promise<HarnessDefaults> | undefined;
  private defaultsCleanup: OwnedProcessClose | undefined;

  constructor(
    readonly profile: HarnessProfile,
    private readonly target: DiscoveredTarget,
    private readonly workspace: string,
    private readonly createSessionId: () => string,
    private readonly spawn: ProcessAdapter["spawnOwnedProcess"],
    /** The one additional writable directory, forwarded as --add-dir (#214). */
    private readonly writableDirectory: string | undefined,
    private readonly phases: HarnessPhaseObserver | undefined,
    private readonly timeouts: SessionTimeouts,
    private readonly containment: HarnessContainmentObserver | undefined,
  ) {}

  /** Memoized bridge start. Its router raises each permission prompt on whatever
   *  Turn is active when Claude calls it. A failed start is not latched: the
   *  memo is cleared so a later Turn re-attempts rather than failing forever on a
   *  transient cause (e.g. a momentary loopback bind clash). */
  private ensureBridge(): Promise<PermissionBridge> {
    if (this.bridgePromise === undefined) {
      const started = startPermissionBridge(
        (session, request) => this.routeApproval(session, request),
        (session) => {
          const turn = this.active;
          return this.closed ||
            turn === undefined ||
            turn.settled ||
            turn.request.session !== session
            ? undefined
            : (call) => turn.raiseAgentCall(call);
        },
      ).catch((error) => {
        if (this.bridgePromise === started) this.bridgePromise = undefined;
        throw error;
      });
      this.bridgePromise = started;
    }
    return this.bridgePromise;
  }

  /** Relay one bridge call to the active Turn. With no live Turn to raise it on,
   *  the prompt is denied as expired rather than left hanging. */
  private routeApproval(
    session: string,
    request: ApprovalRequest,
  ): Promise<ApprovalOutcome> {
    const turn = this.active;
    if (
      turn === undefined ||
      turn.settled ||
      turn.request.session !== session
    ) {
      return Promise.resolve({ decision: "deny", message: EXPIRED_MESSAGE });
    }
    return turn.raiseApproval(request.tool, request.input);
  }

  readDefaults(): Promise<HarnessDefaults> {
    if (this.closed) {
      return Promise.reject(
        new Error("readDefaults after close: the prepared Harness is closed"),
      );
    }
    this.defaultsPromise ??= readSettings({
      spawn: this.spawn,
      executable: this.target.executable,
      prefixArgs: this.target.prefixArgs,
      workspace: this.workspace,
      env: { ...process.env },
      timeoutMs: this.timeouts.controlMs,
    }).then(({ defaults, cleanup }) => {
      this.defaultsCleanup = cleanup;
      return defaults;
    });
    return this.defaultsPromise;
  }

  private readonly callDeclarations = new Map<
    string,
    readonly AgentCallDeclaration[]
  >();

  startTurn(request: TurnRequest): HarnessTurn {
    if (this.closed) {
      throw new Error("startTurn after close: the prepared Harness is closed");
    }
    if (this.active !== undefined && !this.active.settled) {
      throw new Error("startTurn while a Turn is active: one active Turn only");
    }

    const declarations = bindAgentCallDeclarations(
      this.callDeclarations.get(request.session),
      request.agentCalls,
    );
    if (declarations.length > 0 && !this.profile.agentCalls.available)
      throw new Error("agent calls are unsupported by this Harness");
    this.callDeclarations.set(request.session, declarations);
    let session = this.sessions.get(request.session);
    if (session === undefined) {
      // Resuming a Session this Prepared Harness has not tracked (e.g. after a
      // restart): its coordinate is the caller's recovery coordinate, not a fresh
      // mint — otherwise `--resume` would name a Session Claude Code never saw.
      const coordinate = request.resume?.opaque ?? this.createSessionId();
      session = new ClaudeCodeSession(
        request.session,
        this.target,
        this.workspace,
        coordinate,
        () => this.ensureBridge(),
        this.spawn,
        this.profile,
        this.writableDirectory,
        this.phases,
        this.timeouts,
        this.containment,
      );
      this.sessions.set(request.session, session);
    }
    const turn = new ClaudeCodeTurn(
      { ...request, agentCalls: declarations },
      session,
      this.profile.steer,
      this.profile.modelChange,
      () => {
        if (this.active === turn) this.active = undefined;
      },
    );
    this.active = turn;
    session.start(turn);
    return turn;
  }

  close(): Promise<CleanupReport> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    const cleanup = startPhase(this.phases, "cleanup");
    // Expire any prompt the active Turn is waiting on, so a blocked bridge caller
    // is answered `expired` before its transport is torn down under it.
    this.active?.expireForShutdown();
    this.closePromise = this.closeSessions().then((report) => {
      settleCleanup(cleanup, report);
      return report;
    });
    return this.closePromise;
  }

  private async closeSessions(): Promise<CleanupReport> {
    await this.defaultsPromise;
    const outcomes = await Promise.all(
      [...this.sessions.values()].map((session) => session.close()),
    );
    let bridgeFailure: HarnessFailure | undefined;
    if (this.bridgePromise !== undefined) {
      const bridge = await this.bridgePromise.catch(() => undefined);
      try {
        await bridge?.close();
      } catch (cause) {
        bridgeFailure = {
          phase: "cleanup",
          category: "loopback-close",
          possibleEffects: "none",
          cause: redactSecrets(cause),
        };
      }
    }
    const failed = outcomes.find(
      (
        outcome,
      ): outcome is Extract<SessionCloseOutcome, { readonly clean: false }> =>
        !outcome.clean,
    );
    const sessions = outcomes.map((outcome) => ({
      session: outcome.session,
      availability: outcome.availability,
    }));
    const probeClose = this.defaultsCleanup;
    if (
      probeClose !== undefined &&
      probeClose.kind !== "exited" &&
      probeClose.kind !== "signal"
    ) {
      const detail = "Claude Code's settings process could not be reaped.";
      return {
        clean: false,
        detail,
        failure: cleanupFailure(scrubClose(probeClose), detail),
        sessions,
      };
    }
    if (failed !== undefined) {
      return {
        clean: false,
        detail: failed.detail,
        failure: failed.failure,
        sessions,
      };
    }
    if (bridgeFailure !== undefined)
      return {
        clean: false,
        detail: "Harness loopback listener failed to close.",
        failure: bridgeFailure,
        sessions,
      };
    return {
      clean: true,
      detail: `${outcomes.length} Claude Code Session(s) detached.`,
      sessions,
    };
  }
}

type SessionCloseOutcome = {
  readonly clean: boolean;
  readonly detail: string;
  readonly session: string;
  readonly availability: SessionAvailability;
} & (
  | { readonly clean: true }
  | { readonly clean: false; readonly failure: HarnessFailure }
);

/** How Claude Code answered one Model choice change (#348). */
type ChoiceAnswer =
  | { readonly kind: "applied"; readonly observation: ModelObservation }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unanswered" }
  | { readonly kind: "closed" };

function choiceFailure(
  outcome: Exclude<ControlOutcome, { kind: "success" }>,
): ChoiceAnswer {
  switch (outcome.kind) {
    case "refused":
      return { kind: "refused", reason: outcome.detail };
    case "closed":
      return { kind: "closed" };
    case "timeout":
    case "write-failed":
      return { kind: "unanswered" };
  }
}

function sameChoice(a: ModelChoice, b: ModelChoice | undefined): boolean {
  return b !== undefined && a.model === b.model && a.effort === b.effort;
}

/** Whether a launch spawned the Session's child, or why it did not. */
type LaunchOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly category: string; readonly cause: unknown };

interface RetiringClaudeProcess {
  readonly owned: OwnedProcess;
  readonly completion: Promise<OwnedProcessClose>;
  result: OwnedProcessClose | undefined;
  finalExit: boolean;
}

/** One retirement owns the cleanup attempt and retains an unconfirmed child.
 * A cleanup receipt and the independent final lifetime observation are separate
 * evidence. Historical cleanup failure survives exact-Session recovery. */
class ClaudeRetirement {
  private retained: RetiringClaudeProcess | undefined;
  failure: HarnessFailure | undefined;

  constructor(
    private readonly name: string,
    private readonly phases: HarnessPhaseObserver | undefined,
  ) {}

  retire(
    owned: OwnedProcess,
    cleanup: () => Promise<OwnedProcessClose>,
    reportPhase: boolean,
  ): Promise<OwnedProcessClose> {
    if (this.retained?.owned === owned) return this.retained.completion;
    const span = reportPhase
      ? startPhase(this.phases, "cleanup", this.name)
      : undefined;
    const retirement: RetiringClaudeProcess = {
      owned,
      completion: Promise.resolve()
        .then(cleanup)
        .then((receipt) => {
          const close = scrubClose(receipt);
          retirement.result = close;
          if (incompleteCleanup(close)) {
            this.failure = cleanupFailure(
              close,
              describeClose(this.name, close),
            );
            span?.failed(this.failure);
          } else span?.ok();
          if (!incompleteCleanup(close) || retirement.finalExit) {
            if (this.retained === retirement) this.retained = undefined;
          }
          return close;
        }),
      result: undefined,
      finalExit: false,
    };
    this.retained = retirement;
    void owned.closed().then((close) => {
      if (incompleteCleanup(close)) return;
      retirement.finalExit = true;
      if (retirement.result !== undefined && this.retained === retirement)
        this.retained = undefined;
    });
    return retirement.completion;
  }

  async recoverable(): Promise<boolean> {
    await this.retained?.completion;
    return this.retained === undefined;
  }

  async finish(): Promise<OwnedProcessClose | undefined> {
    return this.retained?.completion;
  }
}

function incompleteCleanup(close: OwnedProcessClose): boolean {
  return close.kind === "cleanup-error" || close.kind === "cleanup-timeout";
}

class ClaudeCodeSession {
  readonly coordinate: RecoveryCoordinate;
  private process: OwnedProcess | undefined;
  private windowsProcess = false;
  private attaching: OwnedProcess | undefined;
  private readonly retirement: ClaudeRetirement;
  private nativeControl: PhaseSpan | undefined;
  /** The Turn that owns `process`. A later Turn may be admitted before the prior
   *  child-close callback runs, so process ownership cannot be inferred from the
   *  Session's current `active` Turn (#134 A17). */
  private processTurn: ClaudeCodeTurn | undefined;
  /** Final close still drains native truth into its original Turn. No later
   *  Turn can start after close, and retirement never redirects this output. */
  private closingOutput:
    { readonly owned: OwnedProcess; readonly turn: ClaudeCodeTurn } | undefined;
  private launchPromise: Promise<LaunchOutcome> | undefined;
  private active: ClaudeCodeTurn | undefined;
  private closed = false;
  private initialized = false;
  /** True for the current process only when it was launched with `--resume`, so a
   *  non-acknowledging init is a recovery failure rather than a fresh not-started. */
  private resuming = false;
  /** Once a process has launched for this Session, any relaunch resumes rather than
   *  starts fresh — recovery never silently creates a new conversation. */
  private launchedOnce = false;
  /** Set when a resume was not acknowledged: the Session cannot continue and every
   *  further Turn fails with the same recovery failure. */
  private unusableReason: string | undefined;
  private effectiveModel: ModelObservation = { known: false };
  private effectiveEffort: string | undefined;
  /** The Model choice the current process runs, in the request's own words: its
   *  launch flags, then each change Claude Code confirmed (#348). Absent when the
   *  launch named no model. */
  private applied: ModelChoice | undefined;
  /** A change control went unanswered, so the next Turn relaunches the Session
   *  with `--resume --model --effort` rather than trusting this process. */
  private relaunchForChoice = false;
  /** Changes run one at a time, each control waiting for the one before it. */
  private changing: Promise<unknown> = Promise.resolve();
  private stderr = "";
  /** A claimed interrupt still settling its Turn. `close` awaits it, so the
   *  bridge — and the bearer it keeps registered for Seam redaction — outlives
   *  every cause this Session can still send across. */
  private interrupting: Promise<void> | undefined;
  /** Each spawned process's control channel; request ids are per process. */
  private readonly controls = new WeakMap<OwnedProcess, ControlChannel>();
  /** Resolves when `close` begins, so a native stop still awaiting its
   *  confirmation falls back to the process stop at once. */
  private readonly closing: Promise<void>;
  private signalClosing!: () => void;

  constructor(
    readonly name: string,
    private readonly target: DiscoveredTarget,
    private readonly workspace: string,
    sessionId: string,
    private readonly ensureBridge: () => Promise<PermissionBridge>,
    private readonly spawn: ProcessAdapter["spawnOwnedProcess"],
    /** The qualified profile, whose model declaration each Turn's request is
     *  checked against before admission. */
    private readonly profile: HarnessProfile,
    /** The additional writable directory, forwarded as --add-dir on every
     *  launch, fresh or resumed (#214). */
    private readonly writableDirectory: string | undefined,
    private readonly phases: HarnessPhaseObserver | undefined,
    private readonly timeouts: SessionTimeouts,
    private readonly containment: HarnessContainmentObserver | undefined,
  ) {
    this.coordinate = { opaque: sessionId };
    this.retirement = new ClaudeRetirement(name, phases);
    this.closing = new Promise((resolve) => {
      this.signalClosing = resolve;
    });
  }

  start(turn: ClaudeCodeTurn): void {
    this.effectiveEffort = undefined;
    if (this.effectiveModel.known)
      this.effectiveModel = { known: true, model: this.effectiveModel.model };
    this.active = turn;
    queueMicrotask(() => {
      void this.submit(turn);
    });
  }

  model(): ModelObservation {
    return this.effectiveModel;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isResuming(): boolean {
    return this.resuming;
  }

  observeInit(model: ModelObservation): void {
    this.initialized = true;
    this.effectiveModel =
      model.known && this.effectiveEffort !== undefined
        ? { ...model, effort: this.effectiveEffort }
        : model;
  }

  markUnusable(reason: string): void {
    this.unusableReason = reason;
  }

  /** Request native interruption on an initialized process. An aborted result
   *  confirms it; Windows then reaps before settlement, while POSIX retains the
   *  process. Any other state or missing confirmation takes the process stop. */
  async interrupt(turn: ClaudeCodeTurn): Promise<void> {
    if (this.active !== turn) return;
    const owned = this.process;
    const control =
      owned !== undefined && this.processTurn === turn && this.initialized
        ? this.controls.get(owned)
        : undefined;
    if (owned === undefined || control === undefined) {
      await this.stop(turn);
      return;
    }
    this.nativeControl = startPhase(this.phases, "control", this.name);
    this.interrupting = this.interruptNatively(
      turn,
      owned,
      control,
      this.nativeControl,
    );
    await this.interrupting;
  }

  /** The process stop: SIGTERM to the process tree through the process Module
   *  (a force-kill on Windows), drain to exit, and settle. The internal stops
   *  (a failed Turn write, an init timeout or mismatch, protocol corruption) take
   *  it directly; a caller's Interrupt takes it only as the fallback. */
  async stop(turn: ClaudeCodeTurn): Promise<void> {
    if (this.active !== turn) return;
    const owned = this.process;
    if (owned === undefined) {
      turn.settleInterrupted("process");
      return;
    }
    this.active = undefined;
    this.interrupting = this.settleInterruption(
      turn,
      owned,
      startPhase(this.phases, "control", this.name),
    );
    await this.interrupting;
  }

  /** One `control` span covers the native request and, when Claude Code does not
   *  confirm it, the process-stop fallback. The control bound runs from the
   *  request's write to the aborted `result`. A result that wins the race keeps
   *  its own truth and abandons the span. A process that exits on its own first
   *  leaves the interruption unknown; a refused request, a failed write, an
   *  unconfirmed stop, or a closing Session falls back. */
  private async interruptNatively(
    turn: ClaudeCodeTurn,
    owned: OwnedProcess,
    control: ControlChannel,
    span: PhaseSpan,
  ): Promise<void> {
    const started = performance.now();
    // A result that wins the race settles the Turn without waiting on the
    // response; the channel still correlates it, or times it out, alone.
    const outcome = await Promise.race([
      control.request({ subtype: "interrupt", cancel_queued: true }),
      turn.nativeConfirmation,
      turn.result().then(() => undefined),
    ]);
    if (outcome?.kind === "success") {
      await settlesWithin(
        turn,
        this.timeouts.controlMs - (performance.now() - started),
        Promise.race([
          this.closing,
          owned.closed().then(() => undefined),
          turn.nativeConfirmation,
        ]),
      );
    }
    if (turn.nativeConfirmed) {
      span.ok();
      await turn.result();
      return;
    }
    if (outcome === undefined || turn.settled) {
      if (turn.settledKind === "interrupted") span.ok();
      else span.abandoned();
      return;
    }
    if (this.process !== owned) {
      // `onClosed` released a process that exited on its own before
      // confirming: nothing stopped it, so the interruption stays unknown.
      const close = scrubClose(await owned.closed());
      const failure: HarnessFailure = {
        phase: "control",
        category: "interruption-unknown",
        possibleEffects: "possible",
        diagnostics: `Claude Code closed before confirming the interrupt (${describeProcessResult(close)}).${this.diagnostics()}`,
        ...processCode(close),
        ...(close.kind === "cleanup-error" ? { cause: close.cause } : {}),
      };
      span.failed(failure);
      turn.settleLost("interruption", turn.lastObservation, failure);
      return;
    }
    const fallbackFailure: HarnessFailure = {
      phase: "control",
      category:
        outcome.kind === "refused" ? "control-refused" : "control-unconfirmed",
      possibleEffects: "possible",
      diagnostics: `${interruptFallbackReason(outcome, this.timeouts.controlMs)}; stopping the Claude Code process.`,
    };
    if (this.active === turn) this.active = undefined;
    await this.settleInterruption(turn, owned, span, fallbackFailure);
  }

  needsNativeReap(): boolean {
    return this.windowsProcess;
  }

  async reapConfirmed(): Promise<void> {
    this.nativeControl?.ok();
    const owned = this.process;
    if (owned !== undefined) await this.retire(owned);
  }

  /** Write one input frame to the process serving this Turn. */
  async writeInput(turn: ClaudeCodeTurn, bytes: Uint8Array): Promise<boolean> {
    const owned = this.process;
    if (owned === undefined || this.processTurn !== turn) return false;
    try {
      await owned.writeStdin(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove dispatch authority as retirement claims the child. */
  private releaseProcess(): void {
    this.closeControl();
    this.process = undefined;
    this.processTurn = undefined;
  }

  /** Settle every control request pending on the current process `closed`. */
  private closeControl(): void {
    if (this.process !== undefined) this.controls.get(this.process)?.close();
  }

  /** A process stop settles the control span on the termination's outcome,
   *  even when the Turn has already settled. A process that stops on the
   *  graceful signal ends the Turn `interrupted` (`process-only`); one that has to
   *  be force-killed, or whose termination is unconfirmed, ends it `lost` with
   *  `interruption-unknown`. */
  private async settleInterruption(
    turn: ClaudeCodeTurn,
    owned: OwnedProcess,
    control: PhaseSpan,
    fallbackFailure?: HarnessFailure,
  ): Promise<void> {
    let escalated = false;
    const close = await this.retire(owned, async () => {
      const outcome = await owned.interrupt(DEFAULT_CLEANUP_TIMEOUT_MS);
      escalated = outcome.escalated;
      return outcome.close;
    });
    const failure = interruptionFailure(close, escalated);
    if (failure !== undefined)
      control.failed({
        ...failure,
        ...(fallbackFailure === undefined
          ? {}
          : {
              diagnostics: `${fallbackFailure.diagnostics} ${failure.diagnostics}`,
            }),
      });
    else if (fallbackFailure !== undefined) control.failed(fallbackFailure);
    else control.ok();
    if (turn.settled) return;
    if (failure !== undefined) {
      turn.settleLost("interruption", turn.lastObservation, failure);
      return;
    }
    turn.settleInterrupted("process");
  }

  async close(): Promise<SessionCloseOutcome> {
    this.closed = true;
    this.signalClosing();
    this.closeControl();
    if (
      this.process === undefined &&
      this.launchPromise === undefined &&
      this.interrupting === undefined
    ) {
      const active = this.active;
      if (active !== undefined && !active.settled) {
        active.settleNotStarted(
          "closed-before-launch",
          "The prepared Harness closed before Claude Code launched.",
        );
      }
      this.active = undefined;
    }
    const launch = this.launchPromise;
    if (launch !== undefined) await launch;
    await this.interrupting;
    const owned = this.process;
    const processTurn = this.processTurn;
    if (owned !== undefined && processTurn !== undefined)
      this.closingOutput = { owned, turn: processTurn };
    // Print mode may exit 1 after a natively interrupted Turn. Capture its
    // confirmation before retirement clears the active process's Turn owner.
    const nativeInterrupted =
      this.processTurn?.settledKind === "interrupted" &&
      this.processTurn.nativeConfirmed;
    const result =
      owned === undefined
        ? await this.retirement.finish()
        : await this.retire(
            owned,
            () => owned.closeStdin(DEFAULT_CLEANUP_TIMEOUT_MS),
            false,
          );
    this.closingOutput = undefined;
    if (result !== undefined) this.settleClosedTurn(processTurn, result);
    if (result === undefined) {
      if (this.retirement.failure !== undefined)
        return {
          clean: false,
          detail: "Claude Code cleanup was incomplete.",
          failure: this.retirement.failure,
          session: this.name,
          availability: this.detached(),
        };
      return {
        clean: true,
        detail: `Session '${this.name}' had no live process.`,
        session: this.name,
        availability: this.detached(),
      };
    }
    const clean =
      this.retirement.failure === undefined &&
      result.kind === "exited" &&
      (result.status === 0 || (result.status === 1 && nativeInterrupted));
    const detail = describeClose(this.name, result);
    const availability: SessionAvailability =
      result.kind === "cleanup-error" || result.kind === "cleanup-timeout"
        ? {
            state: "unusable",
            reason: `Claude Code cleanup was not confirmed: ${describeProcessResult(result)}.`,
          }
        : this.detached();
    const common = {
      detail,
      session: this.name,
      availability,
    };
    if (clean) return { clean: true, ...common };
    return {
      clean: false,
      ...common,
      failure: this.retirement.failure ?? cleanupFailure(result, detail),
    };
  }

  private async submit(turn: ClaudeCodeTurn): Promise<void> {
    if (turn.settled) return;

    // The shared per-Turn model rule (ADR 0034). Claude Code declares free text, so
    // it admits any model; the check keeps the profile the one statement of it.
    const refusal = modelChoiceRefusal(this.profile, turn.request.modelChoice);
    if (refusal !== undefined) {
      turn.settleNotStartedWith(refusal);
      return;
    }

    if (this.unusableReason !== undefined) {
      turn.settleRecoveryFailure(this.unusableReason, this.model());
      return;
    }

    if (!(await this.retirement.recoverable())) {
      turn.settleCleanupRecoveryFailure();
      return;
    }
    if (turn.settled) return;
    if (this.closed) {
      turn.settleNotStarted(
        "closed-before-launch",
        "The prepared Harness closed before Claude Code launched.",
      );
      return;
    }
    const admission = await turn.admit(this.coordinate);
    if (!admission.recorded) {
      const owned = this.process;
      if (owned !== undefined) {
        this.active = undefined;
        await this.retire(owned);
      }
      turn.settleNotStarted(
        "durable-admission",
        admission.cause ?? admission.reason,
        admission.reason,
      );
      return;
    }
    if (turn.settled || this.closed) {
      if (!turn.settled) {
        turn.settleNotStarted(
          "closed-before-launch",
          "The prepared Harness closed before Claude Code launched.",
        );
      }
      return;
    }

    // A terminal result can settle just before that Turn's child process emits
    // close, while some Harnesses keep the same process alive for another Turn.
    // Give an already-settled close one event-loop turn to win; otherwise retain
    // the live process and send the next frame to it.
    const prior =
      this.process !== undefined && this.processTurn !== turn
        ? this.process
        : undefined;
    if (prior !== undefined) {
      const closed = await Promise.race([
        prior.closed().then(() => true as const),
        new Promise<false>((resolve) => setImmediate(() => resolve(false))),
      ]);
      if (closed && this.process === prior)
        this.onClosed(prior, await prior.closed());
      if (!(await this.retirement.recoverable())) {
        turn.settleCleanupRecoveryFailure();
        return;
      }
    }

    // A reused child runs the choice it was launched or last changed with. A
    // differing request reaches it as typed controls before the prompt; a child
    // that left a control unanswered is no longer trusted, so the Session
    // relaunches with the request's flags.
    const choice = turn.request.modelChoice;
    const reused = this.process;
    const channel =
      reused === undefined ? undefined : this.controls.get(reused);
    if (
      reused !== undefined &&
      channel !== undefined &&
      (this.relaunchForChoice ||
        (choice !== undefined && !sameChoice(choice, this.applied)))
    ) {
      const answer =
        choice === undefined
          ? ({ kind: "unanswered" } as const)
          : await this.changeChoice(reused, channel, choice);
      if (turn.settled) return;
      if (answer.kind === "unanswered") {
        await this.retire(reused);
        if (!(await this.retirement.recoverable())) {
          turn.settleCleanupRecoveryFailure();
          return;
        }
      } else if (choice !== undefined) this.report(turn, choice, answer);
      if (turn.settled) return;
    }

    if (this.process === undefined) {
      const span = startPhase(this.phases, "launch", this.name);
      const launch = this.spawnChild(turn);
      this.launchPromise = launch;
      const launched = await launch;
      if (this.launchPromise === launch) this.launchPromise = undefined;
      if (!launched.ok) {
        if (launched.category === "closed-before-launch") span.abandoned();
        else span.failed(notStartedFailure(launched.category, launched.cause));
        turn.settleNotStarted(launched.category, launched.cause);
        return;
      }
      if (this.process === undefined || this.closed) {
        const cause = "Claude Code MCP attachment closed.";
        span.failed(notStartedFailure("mcp-attachment", cause));
        turn.settleNotStarted("mcp-attachment", cause);
        return;
      }
      span.ok();
    }
    if (turn.settled) return;
    if (this.closed) {
      turn.settleNotStarted(
        "closed-before-send",
        "The prepared Harness closed before the Turn was sent.",
      );
      return;
    }

    // A fresh process's init is its open handshake; a resumed process's init
    // acknowledges the resume, so it is the recovery handshake.
    if (!this.initialized) {
      turn.armHandshake(
        this.timeouts.handshakeMs,
        startPhase(
          this.phases,
          this.resuming ? "recovery" : "handshake",
          this.name,
        ),
      );
    }
    const acceptingProcess = this.process;
    if (acceptingProcess === undefined) {
      turn.settleNotStarted(
        "mcp-attachment",
        "Claude Code MCP attachment closed.",
      );
      return;
    }
    this.attaching = undefined;
    const control = this.controls.get(acceptingProcess);
    if (control !== undefined) {
      void control.request({ subtype: "get_settings" }).then((outcome) => {
        if (
          this.process !== acceptingProcess ||
          this.active !== turn ||
          turn.settled
        )
          return;
        if (outcome.kind !== "success" || outcome.settings === undefined)
          return;
        this.effectiveEffort = outcome.settings.effort ?? undefined;
        if (this.initialized && this.effectiveModel.known) {
          this.effectiveModel = {
            known: true,
            model: this.effectiveModel.model,
            ...(this.effectiveEffort === undefined
              ? {}
              : { effort: this.effectiveEffort }),
          };
          turn.observeModel(this.effectiveModel);
        }
      });
    }
    try {
      await acceptingProcess.writeStdin(
        encodeUserMessage(turn.promptUuid, turn.request.input.text),
      );
      if (this.process === acceptingProcess) this.processTurn = turn;
      turn.markSent();
    } catch (error) {
      turn.settleLost("acceptance", "stdin write failed", {
        phase: "turn",
        category: "stdin-write",
        possibleEffects: "possible",
        cause: redactSecrets(error),
      });
      void this.stop(turn);
      return;
    }
  }

  /** Send a live Turn's Model choice change to the process running it (#348).
   *  False when no process runs this Turn, so the receipt is `expired`; the
   *  outcome reaches the Turn's stream once Claude Code answers. */
  changeLive(turn: ClaudeCodeTurn, choice: ModelChoice): boolean {
    const owned = this.process;
    const control =
      owned !== undefined && this.processTurn === turn
        ? this.controls.get(owned)
        : undefined;
    if (owned === undefined || control === undefined) return false;
    void this.changeChoice(owned, control, choice).then((answer) => {
      if (this.process !== owned) return;
      if (answer.kind !== "unanswered") {
        this.report(turn, choice, answer);
        return;
      }
      this.relaunchForChoice = true;
      turn.observeModel(this.model(), {
        requested: choice,
        outcome: "next-turn",
        reason:
          "Claude Code did not answer the Model choice change; the Session relaunches with it at the next Turn.",
      });
    });
    return true;
  }

  /** Report a change Claude Code answered on the Turn's stream: an applied one
   *  with the value read back, a refused one with the unchanged observation. */
  private report(
    turn: ClaudeCodeTurn,
    requested: ModelChoice,
    answer: Exclude<ChoiceAnswer, { kind: "unanswered" }>,
  ): void {
    if (answer.kind === "closed") return;
    if (answer.kind === "applied") {
      turn.observeModel(answer.observation, { requested, outcome: "applied" });
      return;
    }
    turn.observeModel(this.model(), {
      requested,
      outcome: "refused",
      reason: answer.reason,
      ...(this.applied === undefined ? {} : { kept: this.applied }),
    });
  }

  private changeChoice(
    owned: OwnedProcess,
    control: ControlChannel,
    choice: ModelChoice,
  ): Promise<ChoiceAnswer> {
    const change = this.changing.then(() =>
      this.applyChoice(owned, control, choice),
    );
    this.changing = change;
    return change;
  }

  /** `set_model`, then `apply_flag_settings` when the choice has an effort, each
   *  sent only once the one before it succeeded, then a `get_settings` read-back.
   *  A refused effort restores the model it replaced, so a refusal keeps the
   *  whole previous choice. */
  private async applyChoice(
    owned: OwnedProcess,
    control: ControlChannel,
    choice: ModelChoice,
  ): Promise<ChoiceAnswer> {
    if (this.relaunchForChoice) return { kind: "unanswered" };
    const current = (): boolean => this.process === owned;
    const previous = this.applied;
    const model = await control.request({
      subtype: "set_model",
      model: choice.model,
    });
    if (model.kind !== "success") return choiceFailure(model);
    if (choice.effort !== undefined) {
      const effort = await control.request({
        subtype: "apply_flag_settings",
        settings: { effortLevel: choice.effort },
      });
      if (effort.kind !== "success") {
        if (effort.kind !== "refused") return choiceFailure(effort);
        // A model this process cannot be told to return to leaves it running
        // neither choice, so the next Turn relaunches it with its own flags.
        const restored =
          previous === undefined
            ? undefined
            : await control.request({
                subtype: "set_model",
                model: previous.model,
              });
        if (current() && restored?.kind !== "success")
          this.relaunchForChoice = true;
        return choiceFailure(effort);
      }
    }
    if (!current()) return { kind: "closed" };
    this.applied = choice;
    // Applied only once Claude Code reports what it now runs; a change it took
    // but cannot read back is trusted to no one, so the Session relaunches.
    const read = await control.request({ subtype: "get_settings" });
    if (read.kind === "closed") return { kind: "closed" };
    const settings = read.kind === "success" ? read.settings : undefined;
    if (settings === undefined) {
      if (current()) this.relaunchForChoice = true;
      return { kind: "unanswered" };
    }
    const observation: ModelObservation = {
      known: true,
      model: settings.model,
      ...(settings.effort === null ? {} : { effort: settings.effort }),
    };
    if (current()) {
      this.effectiveModel = observation;
      this.effectiveEffort = observation.effort;
    }
    return { kind: "applied", observation };
  }

  /** Claim before awaiting on every retirement route. Readers and close
   * callbacks lose dispatch authority immediately; one owner keeps the receipt
   * and retains the child until its cleanup or final exit is confirmed. */
  private retire(
    owned: OwnedProcess,
    cleanup: () => Promise<OwnedProcessClose> = () =>
      owned.closeStdin(DEFAULT_CLEANUP_TIMEOUT_MS),
    reportPhase = true,
  ): Promise<OwnedProcessClose> {
    if (this.process === owned) this.releaseProcess();
    return this.retirement.retire(owned, cleanup, reportPhase);
  }

  private async spawnChild(turn: ClaudeCodeTurn): Promise<LaunchOutcome> {
    let bridge: PermissionBridge;
    try {
      bridge = await this.ensureBridge();
    } catch (error) {
      return { ok: false, category: "permission-bridge", cause: error };
    }
    if (this.closed) {
      return { ok: false, category: "closed-before-launch", cause: undefined };
    }
    // A first launch mints the Session with `--session-id`; any relaunch (an
    // explicit resume coordinate, or a Session that already ran and detached)
    // reattaches with `--resume`, never a silent fresh conversation.
    const resuming = turn.request.resume !== undefined || this.launchedOnce;
    this.resuming = resuming;
    this.launchedOnce = true;
    // Each process re-runs its own init handshake, so init state is per process.
    this.initialized = false;
    const sessionArgs = resuming
      ? ["--resume", this.coordinate.opaque]
      : ["--session-id", this.coordinate.opaque];
    // The Model choice this launch's Turn requests is forwarded natively as
    // --model and --effort; on a relaunch the flags override the transcript's
    // model. A child reused for a later Turn takes a changed choice through
    // typed controls instead (#348).
    const choice = turn.request.modelChoice;
    const modelArgs =
      choice === undefined
        ? []
        : [
            "--model",
            choice.model,
            ...(choice.effort === undefined ? [] : ["--effort", choice.effort]),
          ];
    // `--add-dir` extends Claude Code's file-tool access to one more directory and
    // leaves the user's permission mode and settings untouched (#214).
    const writableArgs =
      this.writableDirectory !== undefined
        ? ["--add-dir", this.writableDirectory]
        : [];
    const attachment = bridge.session(this.name, turn.request.agentCalls);
    const launched = await this.spawn({
      role: "harness-runtime",
      executable: this.target.executable,
      args: [
        ...this.target.prefixArgs,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        ...modelArgs,
        ...writableArgs,
        ...sessionArgs,
        // The permission bridge: Claude relays every permission prompt to this
        // loopback tool and waits on it. Authentication is attached over stdin.
        ...attachment.launchArgs,
      ],
      cwd: this.workspace,
      env: process.env,
      launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
    });
    if (!launched.ok) {
      // Redact any Secant secret echoed by the launch failure.
      return {
        ok: false,
        category: launched.failure.kind,
        cause: redactSecrets(launched.failure.cause),
      };
    }

    this.windowsProcess = launched.containment !== undefined;
    reportContainment(this.containment, launched.containment, this.name);
    const owned = launched.process;
    const control = new ControlChannel(
      (bytes) => owned.writeStdin(bytes),
      this.timeouts.controlMs,
    );
    this.controls.set(owned, control);
    this.process = owned;
    this.attaching = owned;
    this.processTurn = turn;
    this.applied = choice;
    this.relaunchForChoice = false;
    void this.consumeStdout(owned, control).catch((error) => {
      if (this.attaching === owned) {
        control.close();
        return;
      }
      const redacted = redactSecrets(error);
      this.outputTurn(owned)?.protocolCorruption(
        `stdout read failed: ${describe(redacted)}`,
        redacted,
      );
    });
    void this.consumeStderr(owned).catch((error) => {
      if (this.outputTurn(owned) === undefined) return;
      this.stderr += ` stderr read failed: ${describe(redactSecrets(error))}`;
    });
    void owned.closed().then((result) => {
      control.close();
      this.onClosed(owned, result);
    });
    const servers = mcpServers(attachment.configuration);
    const answer = await control.request({
      subtype: "mcp_set_servers",
      servers,
    });
    if (
      this.process !== owned ||
      answer.kind !== "success" ||
      answer.attachment === undefined ||
      answer.attachment.failed ||
      !Object.keys(servers).every((name) =>
        answer.attachment?.added.includes(name),
      )
    ) {
      const outcome =
        this.process !== owned
          ? "closed"
          : answer.kind === "success"
            ? "failed"
            : answer.kind;
      await this.retire(owned);
      this.attaching = undefined;
      return {
        ok: false,
        category: "mcp-attachment",
        cause: `Claude Code MCP attachment ${outcome}.`,
      };
    }
    return { ok: true };
  }

  private async consumeStdout(
    owned: OwnedProcess,
    control: ControlChannel,
  ): Promise<void> {
    const reader = new JsonlLineReader(owned.stdout);
    for (;;) {
      const next = await reader.next();
      if (next.kind === "line") {
        this.consumeLine(owned, next.value, control);
        continue;
      }
      if (this.attaching === owned) {
        control.close();
        return;
      }
      if (next.kind === "truncated" && next.value.trim().startsWith("{")) {
        this.outputTurn(owned)?.protocolCorruption("truncated JSON frame");
      }
      return;
    }
  }

  private async consumeStderr(owned: OwnedProcess): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of owned.stderr) {
      if (
        this.outputTurn(owned) === undefined ||
        this.stderr.length >= MAX_STDERR_BYTES
      )
        continue;
      this.stderr += decoder
        .decode(chunk, { stream: true })
        .slice(0, MAX_STDERR_BYTES - this.stderr.length);
    }
    if (
      this.outputTurn(owned) !== undefined &&
      this.stderr.length < MAX_STDERR_BYTES
    )
      this.stderr += decoder.decode();
  }

  /** A `control_response` belongs to the process's control channel, never to a
   *  Turn; every other frame is dispatched to the active Turn. */
  private consumeLine(
    owned: OwnedProcess,
    line: string,
    control: ControlChannel,
  ): void {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) return;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch (error) {
      if (this.attaching === owned) {
        control.close();
        return;
      }
      this.outputTurn(owned)?.protocolCorruption(
        "malformed JSON frame",
        redactSecrets(error),
      );
      return;
    }
    const parsed = parseFrame(frame);
    if (parsed === undefined) return;
    if (parsed.kind === "control-response") {
      control.accept(parsed.frame);
      return;
    }
    if (this.attaching !== owned) this.outputTurn(owned)?.acceptFrame(parsed);
  }

  private outputTurn(owned: OwnedProcess): ClaudeCodeTurn | undefined {
    if (this.process === owned) return this.active;
    if (this.closingOutput?.owned === owned) return this.closingOutput.turn;
    return undefined;
  }

  private onClosed(owned: OwnedProcess, close: OwnedProcessClose): void {
    // A process stop claims the process before awaiting, so once it is in
    // flight `this.process !== owned` and the stop owns the result here.
    if (this.process !== owned) return;
    const result = scrubClose(close);
    const turn = this.processTurn;
    void this.retire(owned, () => Promise.resolve(result), false);
    if (this.active === turn) this.active = undefined;
    if (this.attaching !== owned) this.settleClosedTurn(turn, result);
  }

  private settleClosedTurn(
    turn: ClaudeCodeTurn | undefined,
    result: OwnedProcessClose,
  ): void {
    if (turn === undefined || turn.settled) return;
    // A native stop in flight owns the result too: its control request just
    // settled `closed`, so it settles this unconfirmed close itself.
    if (turn.interrupting) return;
    if (!this.initialized) {
      const diagnostics = `Claude Code closed before init (${describeProcessResult(result)}).${this.diagnostics()}`;
      turn.settleNotStarted(
        "initialization",
        result.kind === "cleanup-error" ? result.cause : diagnostics,
        diagnostics,
      );
      return;
    }
    turn.settleLost("completion", turn.lastObservation, {
      phase: "turn",
      category: "completion-unknown",
      possibleEffects: "possible",
      diagnostics: `Process closed before an authoritative result: ${describeProcessResult(result)}.${this.diagnostics()}`,
      ...processCode(result),
      ...(result.kind === "cleanup-error" ? { cause: result.cause } : {}),
    });
  }

  private detached(): SessionAvailability {
    return { state: "detached", coordinate: this.coordinate };
  }

  /** Captured stderr as a diagnostic suffix, scrubbed like every other text
   *  that crosses the Seam from below launch: a child that echoed its argv on
   *  failure would otherwise carry the bearer back verbatim. */
  private diagnostics(): string {
    const text = redactText(this.stderr).trim();
    return text.length === 0 ? "" : ` stderr: ${text}`;
  }
}

/** One outstanding approval prompt awaiting an answer, expiry, or shutdown. */
interface PendingApproval {
  readonly request: HarnessRequest;
  status: "outstanding" | "settled";
  readonly resolve: (outcome: ApprovalOutcome) => void;
}

/** How one native exchange ended: its result, usage, and whether it was a
 *  compaction Claude Code reported failed. */
interface ExchangeEnd {
  readonly frame: ResultFrame;
  readonly usage: UsageObservation | undefined;
  readonly compactionFailed: boolean;
}

/** One Steer written (or being written) to stdin and not yet settled. */
interface PendingSteer {
  readonly input: SteerInput;
  readonly sentAt: string;
  /** The native exchange running when it was sent, counted by the boundaries
   *  before it, or undefined when it was sent between exchanges. Delivery in any
   *  other exchange is after a boundary. */
  readonly exchange: number | undefined;
}

class ClaudeCodeTurn implements HarnessTurn {
  get settled(): boolean {
    return this.settledKind !== undefined;
  }
  /** The kind the Turn settled with, once it has. */
  settledKind: TurnResult["kind"] | undefined;
  interrupting = false;
  nativeConfirmed = false;
  readonly nativeConfirmation: Promise<void>;
  private confirmNative!: () => void;
  /** The last authoritative fact observed before truth could be lost — carried
   *  into a `lost` result so a caller sees how far the Turn got. */
  lastObservation = "no authoritative observation before the Turn ended";
  readonly request: TurnRequest;
  private readonly producer = new TurnEventProducer();
  private readonly tools = new Map<string, ToolCall>();
  private readonly toolIds = new Map<string, string>();
  private readonly resultPromise: Promise<TurnResult>;
  private resolveResult!: (result: TurnResult) => void;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The open handshake or recovery phase, awaiting init. */
  private initPhase: PhaseSpan | undefined;
  /** Outstanding approval prompts, keyed by their exact request id. Several may
   *  coexist; each expires when the Turn ends, is interrupted, or is lost. */
  private readonly approvals = new Map<string, PendingApproval>();
  private approvalSeq = 0;
  private readonly calls = new Map<
    string,
    {
      status: "outstanding" | "settled";
      readonly resolve: (reply: AgentCallReply) => void;
    }
  >();
  private readonly elicitations = new Set<string>();
  /** Steers awaiting model exposure, keyed by their minted uuid (#359). */
  private readonly steers = new Map<string, PendingSteer>();
  private readonly steerIds = new Set<string>();
  /** Native exchanges this Turn has ended while a Steer was still pending; each
   *  one is a boundary the Turn stretched across (ADR 0035). */
  private boundaries = 0;
  /** The last exchange's result, held while an accepted Steer is pending: the
   *  Turn ends at the first boundary after which none is. */
  private heldResult: ExchangeEnd | undefined;
  /** True from a held boundary until the next native exchange starts. */
  private betweenExchanges = false;
  /** Whether this Turn has seen its first init; a later one in the same Turn is
   *  the next native exchange's, tolerated rather than a new handshake. */
  private initObserved = false;
  /** Claude Code reported a compaction failed (`compact_result: "failed"`) in
   *  the running exchange, which a cancelled compaction does while its result
   *  still says success. Reset at each exchange's result. */
  private compactionFailed = false;
  /** The uuid stamped on this Turn's prompt; with its Steers' uuids, the stdin
   *  messages a result must list to belong to this Turn (ADR 0040). */
  readonly promptUuid = randomUUID();
  private readonly messages = new Set<string>([this.promptUuid]);
  /** Resolves true once the prompt is on stdin, false if the Turn settles first:
   *  a Steer is written only after it. */
  private readonly sent: Promise<boolean>;
  private resolveSent!: (sent: boolean) => void;

  constructor(
    request: TurnRequest,
    private readonly session: ClaudeCodeSession,
    private readonly steerCapability: SteerCapability,
    private readonly modelChange: HarnessProfile["modelChange"],
    private readonly onSettled: () => void,
  ) {
    this.request = request;
    this.nativeConfirmation = new Promise((resolve) => {
      this.confirmNative = resolve;
    });
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
    this.sent = new Promise((resolve) => {
      this.resolveSent = resolve;
    });
  }

  subscribe(listener: TurnEventListener): TurnSubscription {
    return this.producer.subscribe(listener);
  }

  result(): Promise<TurnResult> {
    return this.resultPromise;
  }

  /** Native Steer (ADR 0035): a stdin `user` frame stamped with a minted uuid,
   *  written after the prompt. Accepted once the bytes are written; it settles
   *  when Claude Code puts it in front of the model, or drops on the Turn's end. */
  async steer(input: SteerInput): Promise<ControlReceipt> {
    if (this.settled || this.interrupting) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (!this.steerCapability.available) {
      return { outcome: "rejected", reason: "unsupported" };
    }
    if (this.steerIds.has(input.steerId)) {
      return { outcome: "rejected", reason: "already-settled" };
    }
    this.steerIds.add(input.steerId);
    if (!(await this.sent) || this.settled || this.interrupting) {
      return { outcome: "rejected", reason: "expired" };
    }
    const uuid = randomUUID();
    this.messages.add(uuid);
    this.steers.set(uuid, {
      input,
      sentAt: new Date().toISOString(),
      exchange: this.betweenExchanges ? undefined : this.boundaries,
    });
    const written = await this.session.writeInput(
      this,
      encodeUserMessage(uuid, input.text),
    );
    // A Steer already settled was delivered or dropped, so it was accepted.
    if (written || !this.steers.has(uuid)) return { outcome: "accepted" };
    this.steers.delete(uuid);
    this.endHeldBoundary();
    return { outcome: "rejected", reason: "expired" };
  }

  /** A live Model choice change (#348): typed controls to the process running
   *  this Turn, accepted once sent after the prompt. Its outcome is a `model`
   *  event carrying the change. */
  async changeModel(choice: ModelChoice): Promise<ControlReceipt> {
    if (this.settled || this.interrupting) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (this.modelChange.reach !== "live-turn") {
      return { outcome: "rejected", reason: "unsupported" };
    }
    if (!(await this.sent) || this.settled || this.interrupting) {
      return { outcome: "rejected", reason: "expired" };
    }
    return this.session.changeLive(this, choice)
      ? { outcome: "accepted" }
      : { outcome: "rejected", reason: "expired" };
  }

  /** The prompt reached stdin, so Steers may follow it. */
  markSent(): void {
    this.resolveSent(true);
  }

  async interrupt(): Promise<ControlReceipt> {
    if (this.settled) return { outcome: "rejected", reason: "expired" };
    if (this.interrupting) {
      return { outcome: "rejected", reason: "already-settled" };
    }
    this.interrupting = true;
    // Expire prompts up front so the live bridge caller receives `expired`
    // before the stop reaches the process.
    this.expireOutstanding();
    await this.session.interrupt(this);
    return { outcome: "accepted" };
  }

  /** Raise one permission prompt on this Turn and resolve when it is answered or
   *  expired. Called only by the prepared Harness's bridge router. */
  raiseApproval(tool: string, input: string): Promise<ApprovalOutcome> {
    if (this.settled || this.interrupting) {
      return Promise.resolve({ decision: "deny", message: EXPIRED_MESSAGE });
    }
    const requestId: RequestId = { opaque: `approval-${this.approvalSeq++}` };
    const request: HarnessRequest = {
      requestId,
      shape: {
        kind: "approval",
        tool,
        input,
        decisions: [...APPROVAL_DECISIONS],
      },
    };
    return new Promise<ApprovalOutcome>((resolve) => {
      this.approvals.set(requestId.opaque, {
        request,
        status: "outstanding",
        resolve,
      });
      this.producer.emit({ kind: "request-raised", request });
    });
  }

  raiseAgentCall(call: AgentCall): Promise<AgentCallReply> {
    if (this.settled || this.producer.sealed || this.interrupting)
      return Promise.resolve({
        outcome: "refused",
        reason: "no Turn in progress",
      });
    return new Promise((resolve) => {
      this.calls.set(call.callId.opaque, { status: "outstanding", resolve });
      this.producer.emit({ kind: "agent-call", phase: "raised", call });
    });
  }

  answerAgentCall(answer: AgentCallAnswer): Promise<ControlReceipt> {
    if (this.settled || this.producer.sealed || this.interrupting)
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    const pending = this.calls.get(answer.callId.opaque);
    if (pending === undefined)
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    if (pending.status === "settled")
      return Promise.resolve({
        outcome: "rejected",
        reason: "already-settled",
      });
    pending.status = "settled";
    pending.resolve(answer);
    return Promise.resolve({ outcome: "accepted" });
  }

  answerRequest(answer: RequestAnswer): Promise<ControlReceipt> {
    if (this.settled || this.interrupting) {
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    }
    const pending = this.approvals.get(answer.requestId.opaque);
    if (pending === undefined) {
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    }
    if (pending.status === "settled") {
      return Promise.resolve({
        outcome: "rejected",
        reason: "already-settled",
      });
    }
    if (answer.kind !== pending.request.shape.kind) {
      // The request stays outstanding; a correctly shaped answer can still land.
      return Promise.resolve({ outcome: "rejected", reason: "shape-mismatch" });
    }
    pending.status = "settled";
    this.producer.emit({
      kind: "request-answered",
      requestId: answer.requestId,
      by: "human",
      answer,
    });
    pending.resolve(
      answer.kind === "approval" && answer.decision === "allow"
        ? { decision: "allow" }
        : { decision: "deny", message: DENY_MESSAGE },
    );
    return Promise.resolve({ outcome: "accepted" });
  }

  /** Expire every still-outstanding prompt: emit its `request-expired` event and
   *  resolve its bridge call as a deny. Idempotent per request. Callers ensure
   *  this runs while the Turn is not yet settled so the events are observable. */
  private expireOutstanding(): void {
    this.elicitations.clear();
    for (const [opaque, pending] of this.calls) {
      if (pending.status !== "outstanding") continue;
      pending.status = "settled";
      this.producer.emit({
        kind: "agent-call",
        phase: "expired",
        callId: { opaque },
      });
      pending.resolve({ outcome: "refused", reason: "request expired" });
    }
    for (const pending of this.approvals.values()) {
      if (pending.status !== "outstanding") continue;
      pending.status = "settled";
      this.producer.emit({
        kind: "request-expired",
        requestId: pending.request.requestId,
      });
      pending.resolve({ decision: "deny", message: EXPIRED_MESSAGE });
    }
  }

  /** Expire outstanding prompts during `close`, before the process is reaped, so
   *  a blocked bridge caller is answered rather than severed. */
  expireForShutdown(): void {
    if (this.settled) return;
    this.expireOutstanding();
  }

  async admit(coordinate: RecoveryCoordinate): Promise<
    | { readonly recorded: true }
    | {
        readonly recorded: false;
        readonly reason: string;
        readonly cause?: unknown;
      }
  > {
    try {
      return await this.request.recorder.admit({
        correlationKey: this.request.correlationKey,
        session: this.request.session,
        origin: this.request.origin,
        input: this.request.input,
        recoveryCoordinate: coordinate,
        resume: this.request.resume,
      });
    } catch (error) {
      return { recorded: false, reason: describe(error), cause: error };
    }
  }

  armHandshake(timeoutMs: number, phase: PhaseSpan): void {
    this.initPhase = phase;
    this.handshakeTimer = setTimeout(() => {
      this.settleNotStarted(
        "init-timeout",
        `Claude Code did not emit system/init within ${timeoutMs}ms.`,
      );
      void this.session.stop(this);
    }, timeoutMs);
  }

  /** Dispatch parsed observations, ignoring unsupported facts. Control requests
   *  instead require an answer or a visible failure (frames.ts). */
  acceptFrame(parsed: ParsedFrame): void {
    if (this.settled || this.producer.sealed) return;
    if (parsed.kind === "elicitation") {
      this.declineElicitation(parsed.frame);
      return;
    }
    if (parsed.kind === "unsupported-control") {
      this.settleLost("completion", this.lastObservation, {
        phase: "turn",
        category: "unsupported-control-request",
        possibleEffects: "possible",
        diagnostics:
          "Claude Code sent an unsupported control request. The Turn could not continue.",
      });
      void this.session.stop(this);
      return;
    }
    if (parsed.kind === "control-cancel") {
      this.elicitations.delete(parsed.requestId);
      return;
    }
    if (parsed.kind === "init") {
      this.acceptInit(parsed.frame);
      return;
    }
    if (!this.session.isInitialized()) {
      // A process whose first Turn is a compaction (a `/compact` sent to a
      // relaunched Session) reports init only once the compaction ends, which
      // can outlast the handshake bound: Claude Code has started, so the wait
      // for init is no longer bounded.
      if (parsed.kind === "status" && parsed.frame.status === "compacting") {
        this.clearHandshake();
        this.acceptStatus(parsed.frame);
        return;
      }
      return;
    }
    switch (parsed.kind) {
      case "assistant":
        this.acceptAssistant(parsed.frame);
        return;
      case "user":
        this.acceptToolResults(parsed.frame);
        return;
      case "stream-event":
        this.acceptStreamEvent(parsed.frame);
        return;
      case "result":
        this.acceptResult(parsed.frame);
        return;
      case "command-lifecycle":
        this.acceptLifecycle(parsed.frame);
        return;
      case "status":
        this.acceptStatus(parsed.frame);
        return;
      case "telemetry":
        return;
      case "other":
        return;
    }
  }

  private declineElicitation(frame: ElicitationFrame): void {
    const id = frame.request_id;
    if (this.elicitations.has(id)) return;
    this.elicitations.add(id);
    this.producer.emit({
      kind: "elicitation-declined",
      harness: HARNESS_NAME,
      server: frame.request.mcp_server_name ?? "unknown",
      message: frame.request.message ?? "",
      ...(frame.request.url === undefined ? {} : { url: frame.request.url }),
    });
    if (!this.elicitations.has(id) || this.producer.sealed || this.interrupting)
      return;
    void this.session
      .writeInput(this, encodeElicitationDecline(id))
      .then((written) => {
        if (
          !this.elicitations.delete(id) ||
          this.settled ||
          this.producer.sealed
        )
          return;
        if (!written)
          this.protocolCorruption(
            "Claude Code elicitation reply could not be written",
          );
      });
  }

  protocolCorruption(detail: string, cause?: unknown): void {
    if (this.settled || this.producer.sealed) return;
    this.settleLost("completion", detail, {
      phase: "turn",
      category: "protocol-corruption",
      possibleEffects: "possible",
      diagnostics: detail,
      ...(cause !== undefined ? { cause } : {}),
    });
    void this.session.stop(this);
  }

  settleNotStarted(
    category: string,
    cause: unknown,
    diagnostics?: string,
  ): void {
    this.settleNotStartedWith(notStartedFailure(category, cause, diagnostics));
  }

  settleNotStartedWith(failure: HarnessFailure): void {
    this.settle({ kind: "not-started", detail: { failure } });
  }

  /** Native confirmation detaches the exact Session. Windows reaps before the
   *  result resolves; POSIX reuses its process. A relaunch always uses --resume. */
  settleInterrupted(stop: "native" | "process"): void {
    if (this.settled || this.producer.sealed) return;
    if (stop === "native") {
      this.nativeConfirmed = true;
      this.confirmNative();
    }
    this.settle({
      kind: "interrupted",
      detail: {
        interruption:
          stop === "native"
            ? {
                mode: "active-turn",
                evidence:
                  "Claude Code confirmed the interrupt control request with an aborted result.",
              }
            : {
                mode: "process-only",
                evidence:
                  "Claude Code process termination ended the active Turn.",
              },
        session: {
          state: "detached",
          coordinate: this.session.coordinate,
        },
      },
    });
  }

  settleCleanupRecoveryFailure(): void {
    this.settle({
      kind: "failed",
      detail: {
        failure: {
          phase: "recovery",
          category: "recovery-process",
          possibleEffects: "none",
          diagnostics:
            "Claude Code cannot resume until its previous process cleanup is confirmed.",
        },
        effectiveModel: this.session.model(),
        session: { state: "detached", coordinate: this.session.coordinate },
      },
    });
  }

  /** A resume that Claude Code did not acknowledge: the Session becomes unusable
   *  and the Turn fails in the `recovery` phase. Recovery never falls back to a
   *  fresh conversation, so this is a typed failure, not a new Session. */
  settleRecoveryFailure(
    reason: string,
    effectiveModel: ModelObservation,
  ): void {
    this.session.markUnusable(reason);
    this.settle({
      kind: "failed",
      detail: {
        failure: {
          phase: "recovery",
          category: "recovery-unacknowledged",
          // The Turn content was already sent before init, so a wrong conversation
          // may have acted on it.
          possibleEffects: "possible",
          diagnostics: reason,
        },
        effectiveModel,
        session: { state: "unusable", reason },
      },
    });
  }

  settleLost(
    unknown: "acceptance" | "completion" | "interruption",
    lastObservation: string,
    failure: HarnessFailure,
  ): void {
    this.settle({
      kind: "lost",
      detail: {
        unknown,
        lastObservation,
        session: {
          state: "detached",
          coordinate: this.session.coordinate,
        },
        failure,
      },
    });
  }

  private acceptInit(frame: InitFrame): void {
    this.clearHandshake();
    const nativeSessionId = frame.session_id;
    if (this.initObserved) {
      // Each native exchange re-sends init. A Turn that stretched across a
      // boundary, or ran a compaction, sees it again with the same Session id:
      // only the Session fact (its commands may change) is refreshed.
      if (nativeSessionId !== this.session.coordinate.opaque) {
        this.protocolCorruption(
          "Claude Code init named a different Session mid-Turn",
        );
        return;
      }
      this.betweenExchanges = false;
      this.producer.emit({
        kind: "session",
        availability: { state: "open" },
        facts: sessionFacts(frame, this.session.coordinate),
      });
      return;
    }
    if (nativeSessionId !== this.session.coordinate.opaque) {
      // A resume that the Harness does not acknowledge is a recovery failure that
      // makes the Session unusable — never a silent fresh conversation. A fresh
      // launch whose id is not echoed simply never started.
      if (this.session.isResuming()) {
        const reason =
          nativeSessionId === undefined
            ? "Claude Code --resume did not report a Session id, so the conversation cannot be reattached."
            : "Claude Code --resume acknowledged a different Session, so the conversation cannot be reattached.";
        this.settleRecoveryFailure(reason, this.session.model());
      } else {
        this.settleNotStarted(
          "init-session",
          nativeSessionId === undefined
            ? "Claude Code init omitted its Session id."
            : "Claude Code init did not acknowledge the minted Session id.",
        );
      }
      void this.session.stop(this);
      return;
    }
    const modelName = frame.model;
    const model: ModelObservation =
      modelName === undefined
        ? { known: false }
        : { known: true, model: modelName };
    this.session.observeInit(model);
    this.initObserved = true;
    this.initPhase?.ok();
    this.initPhase = undefined;
    this.lastObservation = "Claude Code acknowledged the Session at init";
    const facts = sessionFacts(frame, this.session.coordinate);
    this.producer.emit({
      kind: "session",
      availability: { state: "open" },
      facts,
    });
    this.producer.emit({ kind: "model", observation: this.session.model() });
  }

  observeModel(observation: ModelObservation, change?: ModelChange): void {
    if (this.settled) return;
    this.producer.emit({
      kind: "model",
      observation,
      ...(change === undefined ? {} : { change }),
    });
  }

  private acceptAssistant(frame: MessageFrame): void {
    if (frame.parent_tool_use_id == null && "usage" in frame.message)
      this.producer.emit({
        kind: "usage",
        observation: usageObservation(frame.message, "message"),
      });
    const parentActivity =
      frame.parent_tool_use_id == null
        ? undefined
        : this.toolId(frame.parent_tool_use_id);
    const blocks = contentBlocks(frame);
    let emittedText = false;
    for (const block of blocks) {
      const blockType = block.type;
      if (blockType === "text") {
        const content = blocks
          .filter((b) => b.type === "text")
          .flatMap((b) => (b.text === undefined ? [] : [b.text]))
          .join("");
        if (block.text !== undefined && !emittedText) {
          emittedText = true;
          if (frame.message.id !== undefined)
            this.producer.clearPreview(frame.message.id);
          this.lastObservation = `assistant content: ${truncate(content)}`;
          this.producer.emit({
            kind: "assistant-content",
            messageId: frame.message.id ?? randomUUID(),
            content,
            ...(parentActivity !== undefined ? { parentActivity } : {}),
          });
        }
        continue;
      }
      if (blockType !== "tool_use") continue;
      if (
        block.name === "mcp__secant__step_done" ||
        block.name === "mcp__secant__stage_done"
      )
        continue;
      const id = block.id;
      if (id === undefined || this.tools.has(id)) continue;
      const call: ToolCall = {
        ...observedToolStart(block, this.toolId(id)),
        ...(parentActivity === undefined
          ? {}
          : { parentCallId: parentActivity }),
      };
      this.tools.set(id, call);
      this.producer.emit({ kind: "tool-call", call });
    }
  }

  private toolId(nativeId: string): string {
    const existing = this.toolIds.get(nativeId);
    if (existing !== undefined) return existing;
    const id = randomUUID();
    this.toolIds.set(nativeId, id);
    return id;
  }

  private acceptToolResults(frame: MessageFrame): void {
    for (const block of contentBlocks(frame)) {
      if (block.type !== "tool_result" || block.tool_use_id === undefined)
        continue;
      const start = this.tools.get(block.tool_use_id);
      if (start === undefined || start.outcome.kind !== "running") continue;
      const call = observedToolResult(frame, block, start);
      this.tools.set(block.tool_use_id, call);
      this.producer.emit({ kind: "tool-call", call });
    }
  }

  private streamedMessageId: string | undefined;

  private acceptStreamEvent(frame: StreamEventFrame): void {
    if (frame.parent_tool_use_id != null) return;
    const event = frame.event;
    if (
      event.type === "message_start" &&
      event.message !== undefined &&
      "usage" in event.message
    )
      this.producer.emit({
        kind: "usage",
        observation: usageObservation(event.message, "message"),
      });
    if (event.type === "message_delta" && "usage" in event)
      this.producer.emit({
        kind: "usage",
        observation: usageObservation(event, "message"),
      });
    if (event.type === "message_start") {
      this.streamedMessageId = event.message?.id;
    }
    const delta = frame.event.delta;
    if (delta === undefined || delta.type !== "text_delta") return;
    const text = delta.text;
    if (text !== undefined)
      this.producer.emitPreview(text, this.streamedMessageId);
  }

  /** A Steer's lifecycle: `started` is model exposure, `cancelled` the drop an
   *  Interrupt's `cancel_queued` makes. The prompt's own lifecycle is ignored. */
  private acceptLifecycle(frame: CommandLifecycleFrame): void {
    const uuid = frame.command_uuid;
    const pending = this.steers.get(uuid);
    if (pending === undefined) return;
    if (frame.state === "started") {
      // A Steer started while the Turn sat at a boundary starts the next exchange.
      this.betweenExchanges = false;
      this.settleSteer(uuid, pending, this.delivered(pending));
    } else if (frame.state === "cancelled") {
      this.settleSteer(uuid, pending, { kind: "dropped", reason: "interrupt" });
      this.endHeldBoundary();
    }
  }

  private acceptStatus(frame: StatusFrame): void {
    if (frame.compact_result !== undefined) {
      if (frame.compact_result !== "success") this.compactionFailed = true;
      return;
    }
  }

  private delivered(pending: PendingSteer): SteerSettlement {
    return {
      kind: "delivered",
      delivery:
        pending.exchange === this.boundaries ? "within-turn" : "after-boundary",
    };
  }

  private settleSteer(
    uuid: string,
    pending: PendingSteer,
    settlement: SteerSettlement,
  ): void {
    this.steers.delete(uuid);
    this.producer.emit({
      kind: "steer",
      steerId: pending.input.steerId,
      text: pending.input.text,
      sentAt: pending.sentAt,
      settlement,
    });
  }

  /** A held boundary whose last pending Steer went away without running: the
   *  Turn ends there, interrupted when an Interrupt cancelled it. */
  private endHeldBoundary(): void {
    const held = this.heldResult;
    if (held === undefined || this.steers.size > 0 || this.settled) return;
    this.heldResult = undefined;
    if (this.interrupting) this.settleInterrupted("native");
    else this.finishExchange(held);
  }

  /** One native exchange ended. Steers it lists were in front of the model.
   *  While an accepted Steer is still pending the result is a boundary, not the
   *  Turn's end: Claude Code runs the queued message as the next exchange. */
  private acceptResult(frame: ResultFrame): void {
    // A result lists the stdin messages its exchange put in front of the model.
    // One that lists only messages this Turn never sent is another exchange's,
    // never this Turn's end (ADR 0040).
    if (
      frame.user_message_uuids.length > 0 &&
      !frame.user_message_uuids.some((uuid) => this.messages.has(uuid))
    ) {
      return;
    }
    const reportedUsage = usageObservation(frame);
    this.producer.emit({
      kind: "context",
      observation: contextObservation(frame),
    });
    this.producer.emit({ kind: "usage", observation: reportedUsage });
    const usage =
      reportedUsage.summary.length === 0 ? undefined : reportedUsage;
    for (const uuid of frame.user_message_uuids) {
      const pending = this.steers.get(uuid);
      if (pending !== undefined) {
        this.settleSteer(uuid, pending, this.delivered(pending));
      }
    }
    // A compaction Claude Code ran itself (no model turn) and reported failed.
    const end: ExchangeEnd = {
      frame,
      usage,
      compactionFailed: this.compactionFailed && frame.num_turns === 0,
    };
    this.compactionFailed = false;
    // A native stop's confirmation is an `error_during_execution` result, the
    // same subtype a task failure reports. Only an aborted terminal reason while
    // this Turn's Interrupt is in flight confirms it; an aborted result without
    // one, or any other result that wins the race, settles as itself. A
    // compaction the Interrupt cancelled reports `compact_result: "failed"` and
    // then a success result with no model turn, so it confirms the stop too.
    if (this.interrupting && (isAbortedResult(frame) || end.compactionFailed)) {
      this.settleInterrupted("native");
      return;
    }
    if (this.steers.size > 0) {
      this.heldResult = end;
      this.boundaries += 1;
      this.betweenExchanges = true;
      this.lastObservation = "Claude Code ended a native exchange";
      return;
    }
    this.heldResult = undefined;
    this.finishExchange(end);
  }

  /** Settle the Turn from the end of its last native exchange. */
  private finishExchange({
    frame,
    usage,
    compactionFailed,
  }: ExchangeEnd): void {
    const subtype = frame.subtype ?? "unknown-result";
    // Authentication is recognized before the success branch: #115's recording
    // pinned the real signal — the not-logged-in result arrives as
    // `subtype:"success"` but with `is_error:true`, zero cost, and empty usage, and
    // `result:"Not logged in · Please run /login"`. Guard the success case on that
    // `is_error` flag: a real answer whose text merely quotes a login phrase settles
    // with `is_error:false`, so it stays a completed Turn. A non-`success` result
    // matching the pattern is an auth failure regardless, as before.
    if (
      isAuthenticationResult(frame) &&
      (subtype !== "success" || frame.is_error === true)
    ) {
      // Never carry the raw result across the Seam: it may quote a key or token.
      // Only the fixed remediation message reaches the caller.
      this.settle({
        kind: "failed",
        detail: {
          failure: {
            phase: "turn",
            category: "authentication",
            possibleEffects: "none",
            diagnostics: AUTHENTICATION_REQUIRED,
          },
          effectiveModel: this.session.model(),
          session: { state: "open" },
        },
      });
      return;
    }
    if (subtype === "success" && compactionFailed) {
      // Claude Code reports a compaction that did not happen as a success.
      this.settle({
        kind: "failed",
        detail: {
          failure: {
            phase: "turn",
            category: "compaction-failed",
            possibleEffects: "none",
            diagnostics: "Claude Code reported that its compaction failed.",
          },
          effectiveModel: this.session.model(),
          session: { state: "open" },
        },
      });
      return;
    }
    if (subtype === "success") {
      this.settle({
        kind: "completed",
        detail: {
          effectiveModel: this.session.model(),
          session: { state: "open" },
          ...(usage !== undefined ? { usage } : {}),
        },
      });
      return;
    }
    this.settle({
      kind: "failed",
      detail: {
        failure: {
          phase: "turn",
          category: subtype,
          possibleEffects: "possible",
          ...(frame.result !== undefined
            ? { partialOutput: frame.result }
            : {}),
        },
        effectiveModel: this.session.model(),
        session: { state: "open" },
      },
    });
  }

  private settle(result: TurnResult): void {
    if (this.settled || this.producer.sealed) return;
    this.clearHandshake();
    // A Turn that settles before init ends its init phase with the Turn's
    // failure, or abandoned when it was interrupted.
    const failure = resultFailure(result);
    if (failure === undefined) this.initPhase?.abandoned();
    else this.initPhase?.failed(failure);
    this.initPhase = undefined;
    this.producer.settlePreview();
    // Terminal ordering: drop every Steer still pending, then expire every
    // outstanding prompt (their events publish here), before the producer
    // closes and the one result settles.
    for (const [uuid, pending] of [...this.steers]) {
      this.settleSteer(uuid, pending, {
        kind: "dropped",
        reason: result.kind === "interrupted" ? "interrupt" : "loss",
      });
    }
    this.heldResult = undefined;
    this.expireOutstanding();
    this.resolveSent(false);
    this.producer.seal();
    if (
      result.kind === "interrupted" &&
      result.detail.interruption.mode === "active-turn" &&
      this.session.needsNativeReap()
    ) {
      void this.session
        .reapConfirmed()
        .then(() => this.finishSettlement(result));
    } else this.finishSettlement(result);
  }

  private finishSettlement(result: TurnResult): void {
    this.settledKind = result.kind;
    this.onSettled();
    this.resolveResult(result);
  }

  private clearHandshake(): void {
    if (this.handshakeTimer === undefined) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }
}

// A tool_use is known work even when its tool name is unfamiliar. Unknown
// protocol frames never reach this classifier. Native MCP tool names stay useful.
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** The failure a Turn that never started carries. */
function notStartedFailure(
  category: string,
  cause: unknown,
  diagnostics?: string,
): HarnessFailure {
  return {
    phase:
      category === "spawn-error" ||
      category === "launch-timeout" ||
      category === "mcp-attachment"
        ? "launch"
        : "turn",
    category,
    possibleEffects: "none",
    cause,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
}

/** Redact every close cause before failure translation at the Harness Seam. */
function scrubClose(close: OwnedProcessClose): OwnedProcessClose {
  if (close.kind === "cleanup-error" || close.kind === "spawn-error") {
    return { kind: close.kind, cause: redactSecrets(close.cause) };
  }
  return close;
}

/** The failure a Turn result carries, if any. */
function resultFailure(result: TurnResult): HarnessFailure | undefined {
  switch (result.kind) {
    case "not-started":
    case "failed":
    case "lost":
      return result.detail.failure;
    case "completed":
    case "interrupted":
      return undefined;
  }
}

/** Why a termination did not confirm a graceful stop, or undefined when it did:
 *  an unconfirmed cleanup or a forced kill leaves the interruption unknown. */
function interruptionFailure(
  close: OwnedProcessClose,
  escalated: boolean,
): HarnessFailure | undefined {
  if (close.kind === "cleanup-error" || close.kind === "cleanup-timeout") {
    return {
      phase: "control",
      category: "interruption-unknown",
      possibleEffects: "possible",
      diagnostics: `Claude Code termination was not confirmed: ${describeProcessResult(close)}.`,
      ...(close.kind === "cleanup-error" ? { cause: close.cause } : {}),
    };
  }
  if (!escalated) return undefined;
  return {
    phase: "control",
    category: "interruption-unknown",
    possibleEffects: "possible",
    diagnostics: `Claude Code did not stop on SIGTERM and was force-killed (${describeProcessResult(close)}).`,
    ...processCode(close),
  };
}

/** Wait up to `ms` for the Turn to settle, cut short when `cutoff` resolves. */
async function settlesWithin(
  turn: ClaudeCodeTurn,
  ms: number,
  cutoff: Promise<void>,
): Promise<void> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    turn.result(),
    cutoff,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/** Why a native stop fell back to the process stop, for the control phase. */
function interruptFallbackReason(
  outcome: ControlOutcome,
  timeoutMs: number,
): string {
  switch (outcome.kind) {
    case "success":
      return `Claude Code acknowledged the interrupt but did not end the Turn within ${timeoutMs}ms`;
    case "refused":
      return `Claude Code refused the interrupt (${truncate(redactText(outcome.detail))})`;
    case "timeout":
      return `Claude Code did not answer the interrupt within ${timeoutMs}ms`;
    case "write-failed":
      return "The interrupt could not be written to Claude Code";
    case "closed":
      return "Claude Code closed, or the Session began closing, before the interrupt was confirmed";
  }
}

/** The native exit code or terminating signal of a close, as a diagnostic code.
 *  Never a raw frame. */
function processCode(result: OwnedProcessClose): { nativeCode?: string } {
  if (result.kind === "exited") return { nativeCode: String(result.status) };
  if (result.kind === "signal" && result.signal !== null) {
    return { nativeCode: result.signal };
  }
  return {};
}

function describeClose(session: string, result: OwnedProcessClose): string {
  return `Session '${session}' detached after ${describeProcessResult(result)}.`;
}

function describeProcessResult(result: OwnedProcessClose): string {
  switch (result.kind) {
    case "exited":
      return `process close with exit ${result.status}`;
    case "signal":
      return `process close from signal ${result.signal ?? "unknown"}`;
    case "spawn-error":
      return `process error: ${describe(result.cause)}`;
    case "cleanup-error":
      return `process cleanup error: ${describe(result.cause)}`;
    case "cleanup-timeout":
      return "process cleanup timeout";
  }
}

function cleanupFailure(
  result: OwnedProcessClose,
  diagnostics: string,
): HarnessFailure {
  return {
    phase: "cleanup",
    category: result.kind,
    possibleEffects:
      result.kind === "cleanup-error" || result.kind === "cleanup-timeout"
        ? "possible"
        : "none",
    diagnostics,
    ...(result.kind === "cleanup-error" ? { cause: result.cause } : {}),
    ...(result.kind === "exited"
      ? { nativeCode: String(result.status) }
      : result.kind === "signal" && result.signal !== null
        ? { nativeCode: result.signal }
        : {}),
  };
}

/** The five effort levels `claude --help` documents for `--effort`. Claude Code
 *  publishes no per-model query, so every suggestion offers all five and names
 *  no default effort: which levels a model honours, or that it has none, is
 *  observed, never declared (ADR 0034 rejects a Claude model catalogue). */
const CLAUDE_CODE_EFFORTS = ClaudeEffort.options;

/** Claude Code's documented model aliases (ADR 0034): each family's latest
 *  model, Default, Opus Plan, and the 1M-context variants. Suggestions, never a
 *  list Secant validates; any exact name is still admitted. */
const CLAUDE_CODE_SUGGESTIONS: readonly ModelEntry[] = [
  suggestion("fable", "Fable (latest)"),
  suggestion("opus", "Opus (latest)"),
  suggestion("sonnet", "Sonnet (latest)"),
  suggestion("haiku", "Haiku (latest)"),
  suggestion("default", "Default"),
  suggestion("opusplan", "Opus Plan"),
  suggestion("opus[1m]", "Opus (latest) with 1M context"),
  suggestion("sonnet[1m]", "Sonnet (latest) with 1M context"),
];

function suggestion(model: string, label: string): ModelEntry {
  return { model, label, efforts: CLAUDE_CODE_EFFORTS };
}

/** The immutable profile, tied to the observed executable, version, platform,
 *  posture, and Adapter revision. Every capability is an M3 fact (#107) with
 *  the evidence it rests on. */
function buildProfile(
  target: DiscoveredTarget,
  version: string,
  platform: HarnessPlatform,
): HarnessProfile {
  // For a shim, the runtime that actually runs is worth naming; the wrapped
  // script is already the identity path in the line below, so it is not repeated.
  const kind = target.shim ? `npm shim via ${target.executable}` : "native";
  return {
    harness: HARNESS_NAME,
    executable: `${target.source} -> ${target.identityPath} (${kind})`,
    executableVersion: version,
    platform,
    adapterRevision: ADAPTER_REVISION,
    configurationPosture:
      "user-compatible: no --bare, --strict-mcp-config, --tools, or permission-mode flag; --allowedTools pre-approves only declared Secant calls, and user or managed deny rules still win; a caller-requested model is forwarded as --model and no model is selected otherwise; the user's settings, hooks, MCP servers, skills, and CLAUDE.md apply.",
    recovery: {
      mode: "native-reattach",
      evidence:
        "Claude Code reattaches a detached Session by resume-by-id (--resume <id>).",
    },
    interruption: {
      mode: "active-turn",
      evidence: `A stdin interrupt control request ends the active Turn, confirmed by an aborted result. On Windows, Secant reaps the process tree before reporting interruption and the next Turn resumes the same Session with --resume; on POSIX the process stays live. Unconfirmed within the control bound, ${
        platform === "windows"
          ? "it falls back to a forced process-tree kill, reported lost because Windows offers a hidden console child no graceful signal"
          : "it falls back to SIGTERM of the process, reported interrupted when the process exits on it and lost when it must be force-killed"
      }; the next Turn then resumes the Session with --resume.`,
    },
    approvals: {
      available: true,
      evidence:
        "Approvals are raised through the Secant-hosted MCP permission bridge.",
    },
    agentCalls: {
      available: CLAUDE_CODE_SERVED_CAPABILITIES.agentCalls === true,
      evidence:
        "Session-attached loopback MCP calls use an acknowledged mcp_set_servers stdin control on every launch and narrowly scoped --allowedTools; user and managed deny rules retain authority.",
    },
    clarifications: {
      available: false,
      evidence:
        "Claude Code exposes no raw-CLI question callback; structured clarifications are never emulated.",
    },
    steer: {
      available: true,
      evidence:
        "A Steer is a stdin user frame stamped with a Secant-minted uuid: written during a tool round it reaches the model with the round's tool result, and written while text streams it runs as the next native exchange inside the same Turn. Delivery is read from command_lifecycle frames and the result's user_message_uuids; an Interrupt sends cancel_queued, so an undelivered Steer is dropped, never run.",
    },
    modelSelection: {
      at: "launch-and-per-turn",
      declaration: {
        kind: "suggested",
        models: CLAUDE_CODE_SUGGESTIONS,
        efforts: CLAUDE_CODE_EFFORTS,
      },
      evidence:
        "Claude Code accepts any model string via --model, an alias for the latest model or a full name, and lists no models; Secant suggests its documented aliases, validates nothing, and forwards a caller-requested model and effort as --model and --effort at launch, or as typed set_model and apply_flag_settings to a Session already running.",
    },
    modelObservation: {
      available: true,
      evidence:
        "The effective model is read from the init message and the effort from get_settings, distinct from any requested model.",
    },
    modelChange: {
      reach: "live-turn",
      evidence:
        "Recorded on Claude Code 2.1.289 (the model-change fixture): a typed set_model and apply_flag_settings sent while a Turn waited on a tool answered success, get_settings then read back the new model and effort, and the Turn's next reply ran on the new model; an unknown model answers a typed error and keeps the Session's model. A Claude Code that does not answer is relaunched with --resume --model --effort at the next Turn.",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence:
        "Secant mints the session UUID and passes it at spawn, so the recovery coordinate is durable before submission.",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence:
        "A skill Bundle Asset reaches the agent by its SKILL.md absolute path in v1 (ADR 0022).",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "A file artifact reaches the agent as a plain absolute path.",
    },
  };
}

/** The bytes-plus-location identity of a resolved target, or undefined when it
 *  cannot be stat'd (the cache then never hits for it). Windows inodes are
 *  unreliable, so size and mtime carry the identity. */
function fileIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function harnessPlatform(
  platform: NodeJS.Platform,
): HarnessPlatform | undefined {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

function failure(category: string, diagnostics: string): HarnessFailure {
  return {
    phase: "prepare",
    category,
    possibleEffects: "none",
    diagnostics,
  };
}
