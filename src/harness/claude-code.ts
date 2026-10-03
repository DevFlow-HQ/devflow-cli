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
import { ControlChannel, type ControlOutcome } from "./claude-code/control.js";
import {
  contentBlocks,
  encodeTurn,
  genericActivity,
  isAbortedResult,
  isAuthenticationResult,
  parseFrame,
  sessionFacts,
  usageObservation,
  type InitFrame,
  type MessageFrame,
  type ParsedFrame,
  type ResultFrame,
  type StreamEventFrame,
} from "./claude-code/frames.js";
import { APPROVAL_DECISIONS } from "./harness.js";
import type {
  CleanupReport,
  ControlReceipt,
  HarnessAdapter,
  HarnessFailure,
  HarnessPhaseObserver,
  HarnessPlatform,
  HarnessProfile,
  HarnessRequest,
  HarnessTurn,
  ModelObservation,
  PrepareOptions,
  PrepareResult,
  PreparedHarness,
  RecoveryCoordinate,
  RequestAnswer,
  RequestId,
  SessionAvailability,
  SessionFacts,
  SteerCapability,
  SteerInput,
  TurnEvent,
  TurnEventListener,
  TurnRequest,
  TurnResult,
  TurnSubscription,
} from "./harness.js";
import { JsonlLineReader } from "./jsonl.js";
import { settleCleanup, startPhase, type PhaseSpan } from "./phases.js";
import { modelChoiceRefusal } from "./model-request.js";
import { writableDirectoryFailure } from "./writable-directory.js";
import {
  EXPIRED_MESSAGE,
  startPermissionBridge,
  type ApprovalOutcome,
  type ApprovalRequest,
  type PermissionBridge,
} from "./permission-bridge.js";
import { redactSecrets, redactText } from "./secrets.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  discoverClaudeCode,
  discoveredHarnessTarget,
  type DiscoveredHarnessTarget,
} from "./discovery.js";

/** The message a denied approval returns to the bridge caller. Claude sees it
 *  and adjusts its approach. */
const DENY_MESSAGE = "The tool use was denied.";

/** This Adapter's revision, stamped onto every profile it produces so a cached
 *  qualification from an older Adapter is never mistaken for a current one. */
const ADAPTER_REVISION = "claude-code-2";

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
  /** Override UUID generation for deterministic protocol replay. */
  readonly sessionId?: () => string;
}

/** The factory a composition root calls. Each `prepare` supplies the Process
 *  Interface and phase observer its Prepared Harness uses; the Adapter keeps
 *  only its qualification cache. The overrides exist only for tests. */
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
  /** Qualification cache, private to the Adapter, keyed by the discovered
   *  target's path and file identity. Same path + identical bytes ⇒ the probed
   *  version cannot have changed, so the cached profile is reused without
   *  re-running `--version`; any drift in either requalifies. */
  private readonly cache = new Map<string, HarnessProfile>();

  constructor(private readonly overrides: ClaudeCodeAdapterOverrides) {}

  async prepare(options: PrepareOptions): Promise<PrepareResult> {
    const platform = harnessPlatform(
      this.overrides.platform ?? process.platform,
    );
    if (platform === undefined) {
      return failed(
        "unsupported-platform",
        `Claude Code is not supported on platform '${process.platform}'.`,
      );
    }
    const writableFailure = writableDirectoryFailure(options.writableDirectory);
    if (writableFailure !== undefined) {
      return { ok: false, failure: writableFailure };
    }

    const processAdapter = options.process;
    const discovery = this.discover(processAdapter, options);
    if (!discovery.ok) return { ok: false, failure: discovery.failure };
    const target = discovery.target;
    const spawn: ProcessAdapter["spawnOwnedProcess"] = (spawnOptions) =>
      processAdapter.spawnOwnedProcess(spawnOptions);

    const controlTimeoutMs =
      this.overrides.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
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
          controlTimeoutMs,
        ),
      };
    }

    const probe = await this.probeVersion(processAdapter, target);
    if (!probe.ok) return { ok: false, failure: probe.failure };

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
        controlTimeoutMs,
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

  constructor(
    readonly profile: HarnessProfile,
    private readonly target: DiscoveredTarget,
    private readonly workspace: string,
    private readonly createSessionId: () => string,
    private readonly spawn: ProcessAdapter["spawnOwnedProcess"],
    /** The one additional writable directory, forwarded as --add-dir (#214). */
    private readonly writableDirectory: string | undefined,
    private readonly phases: HarnessPhaseObserver | undefined,
    private readonly controlTimeoutMs: number,
  ) {}

  /** Memoized bridge start. Its router raises each permission prompt on whatever
   *  Turn is active when Claude calls it. A failed start is not latched: the
   *  memo is cleared so a later Turn re-attempts rather than failing forever on a
   *  transient cause (e.g. a momentary loopback bind clash). */
  private ensureBridge(): Promise<PermissionBridge> {
    if (this.bridgePromise === undefined) {
      const started = startPermissionBridge((request) =>
        this.routeApproval(request),
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
  private routeApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const turn = this.active;
    if (turn === undefined || turn.settled) {
      return Promise.resolve({ decision: "deny", message: EXPIRED_MESSAGE });
    }
    return turn.raiseApproval(request.tool, request.input);
  }

  startTurn(request: TurnRequest): HarnessTurn {
    if (this.closed) {
      throw new Error("startTurn after close: the prepared Harness is closed");
    }
    if (this.active !== undefined && !this.active.settled) {
      throw new Error("startTurn while a Turn is active: one active Turn only");
    }

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
        this.controlTimeoutMs,
      );
      this.sessions.set(request.session, session);
    }
    const turn = new ClaudeCodeTurn(
      request,
      session,
      this.profile.steer,
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
    const outcomes = await Promise.all(
      [...this.sessions.values()].map((session) => session.close()),
    );
    if (this.bridgePromise !== undefined) {
      const bridge = await this.bridgePromise.catch(() => undefined);
      await bridge?.close();
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
    if (failed !== undefined) {
      return {
        clean: false,
        detail: failed.detail,
        failure: failed.failure,
        sessions,
      };
    }
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

/** Whether a launch spawned the Session's child, or why it did not. */
type LaunchOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly category: string; readonly cause: unknown };

class ClaudeCodeSession {
  readonly coordinate: RecoveryCoordinate;
  private process: OwnedProcess | undefined;
  /** The Turn that owns `process`. A later Turn may be admitted before the prior
   *  child-close callback runs, so process ownership cannot be inferred from the
   *  Session's current `active` Turn (#134 A17). */
  private processTurn: ClaudeCodeTurn | undefined;
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
    private readonly controlTimeoutMs: number,
  ) {
    this.coordinate = { opaque: sessionId };
    this.closing = new Promise((resolve) => {
      this.signalClosing = resolve;
    });
  }

  start(turn: ClaudeCodeTurn): void {
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
    this.effectiveModel = model;
  }

  markUnusable(reason: string): void {
    this.unusableReason = reason;
  }

  /** A caller's Interrupt (ADR 0035). When this Turn runs on a live,
   *  initialized process, a stdin `control_request` `interrupt` keeps the
   *  process, the active Turn, and process ownership: Claude Code confirms with
   *  an aborted `result`, which settles the Turn `interrupted` (`active-turn`) and
   *  leaves the process for the next Turn. Any other state takes the process
   *  stop at once, and so does a native stop Claude Code does not confirm. */
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
    this.interrupting = this.interruptNatively(
      turn,
      owned,
      control,
      startPhase(this.phases, "control", this.name),
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
    // Claim sole ownership of the process before awaiting: a concurrent `close`
    // then sees no live process and cannot start its own termination sequence on
    // the same child, so the two never report divergent closes. `onClosed` sees
    // `this.process !== owned` and yields the result to this stop.
    this.releaseProcess();
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
      control.request({ subtype: "interrupt" }),
      turn.result().then(() => undefined),
    ]);
    if (outcome?.kind === "success") {
      await settlesWithin(
        turn,
        this.controlTimeoutMs - (performance.now() - started),
        Promise.race([this.closing, owned.closed().then(() => undefined)]),
      );
    }
    if (outcome === undefined || turn.settled) {
      if (turn.settledKind === "interrupted") span.ok();
      else span.abandoned();
      return;
    }
    if (this.process !== owned) {
      // `onClosed` released a process that exited on its own before
      // confirming: nothing stopped it, so the interruption stays unknown.
      const close = this.scrub(await owned.closed());
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
    turn.noteActivity(
      `${interruptFallbackReason(outcome, this.controlTimeoutMs)}; stopping the Claude Code process.`,
    );
    this.releaseProcess();
    if (this.active === turn) this.active = undefined;
    await this.settleInterruption(turn, owned, span);
  }

  /** Give up the current process: its control channel settles every pending
   *  request `closed`, and the next Turn launches a fresh process. */
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
  ): Promise<void> {
    const outcome = await owned.interrupt(DEFAULT_CLEANUP_TIMEOUT_MS);
    const close = this.scrub(outcome.close);
    const failure = interruptionFailure(close, outcome.escalated);
    if (failure === undefined) control.ok();
    else control.failed(failure);
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
    if (this.process === undefined && this.launchPromise === undefined) {
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
    if (owned === undefined) {
      return {
        clean: true,
        detail: `Session '${this.name}' had no live process.`,
        session: this.name,
        availability: this.detached(),
      };
    }
    const result = this.scrub(
      await owned.closeStdin(DEFAULT_CLEANUP_TIMEOUT_MS),
    );
    const clean = isCleanClose(result);
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
      failure: cleanupFailure(result, detail),
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

    const admission = await turn.admit(this.coordinate);
    if (!admission.recorded) {
      const owned = this.process;
      if (owned !== undefined) {
        this.releaseProcess();
        this.active = undefined;
        await owned.closeStdin(DEFAULT_CLEANUP_TIMEOUT_MS);
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
      if (closed && this.process === prior) this.releaseProcess();
    }

    if (this.process === undefined) {
      const launch = this.launch(turn);
      this.launchPromise = launch;
      const launched = await launch;
      if (this.launchPromise === launch) this.launchPromise = undefined;
      if (!launched.ok) {
        turn.settleNotStarted(launched.category, launched.cause);
        return;
      }
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
        DEFAULT_HANDSHAKE_TIMEOUT_MS,
        startPhase(
          this.phases,
          this.resuming ? "recovery" : "handshake",
          this.name,
        ),
      );
    }
    const acceptingProcess = this.process!;
    try {
      await acceptingProcess.writeStdin(encodeTurn(turn.request));
      if (this.process === acceptingProcess) this.processTurn = turn;
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

  private async launch(turn: ClaudeCodeTurn): Promise<LaunchOutcome> {
    const span = startPhase(this.phases, "launch", this.name);
    const launched = await this.spawnChild(turn);
    if (launched.ok) span.ok();
    else if (launched.category === "closed-before-launch") span.abandoned();
    else span.failed(notStartedFailure(launched.category, launched.cause));
    return launched;
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
    // The model this launch's Turn requests is forwarded natively as --model, and
    // on a relaunch `--resume --model` overrides the transcript's model. A live
    // child reused for a later Turn keeps the model it was launched with; no Run
    // changes its request between Turns until #344, and #348 owns that change.
    // The request's effort is not sent yet (#348).
    const model = turn.request.modelChoice?.model;
    const modelArgs = model !== undefined ? ["--model", model] : [];
    // `--add-dir` extends Claude Code's file-tool access to one more directory and
    // leaves the user's permission mode and settings untouched (#214).
    const writableArgs =
      this.writableDirectory !== undefined
        ? ["--add-dir", this.writableDirectory]
        : [];
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
        // loopback tool and waits on it. The inline config carries the per-Run
        // bearer token; it is the only place the token appears.
        ...bridge.launchArgs,
      ],
      cwd: this.workspace,
      env: process.env,
      launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
    });
    if (!launched.ok) {
      // A spawn error carries the launch argv (Node's `spawnargs`), which
      // includes the bearer token; scrub it before it becomes a failure cause.
      return {
        ok: false,
        category: launched.failure.kind,
        cause: redactSecrets(launched.failure.cause),
      };
    }

    const owned = launched.process;
    const control = new ControlChannel(
      (bytes) => owned.writeStdin(bytes),
      this.controlTimeoutMs,
    );
    this.controls.set(owned, control);
    this.process = owned;
    this.processTurn = turn;
    void this.consumeStdout(owned, control).catch((error) => {
      const redacted = redactSecrets(error);
      this.active?.protocolCorruption(
        `stdout read failed: ${describe(redacted)}`,
        redacted,
      );
    });
    void this.consumeStderr(owned).catch((error) => {
      this.stderr += ` stderr read failed: ${describe(redactSecrets(error))}`;
    });
    void owned.closed().then((result) => {
      control.close();
      this.onClosed(owned, result);
    });
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
        this.consumeLine(next.value, control);
        continue;
      }
      if (next.kind === "truncated" && next.value.trim().startsWith("{")) {
        this.active?.protocolCorruption("truncated JSON frame");
      }
      return;
    }
  }

  private async consumeStderr(owned: OwnedProcess): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of owned.stderr) {
      if (this.stderr.length >= MAX_STDERR_BYTES) continue;
      this.stderr += decoder
        .decode(chunk, { stream: true })
        .slice(0, MAX_STDERR_BYTES - this.stderr.length);
    }
    if (this.stderr.length < MAX_STDERR_BYTES) this.stderr += decoder.decode();
  }

  /** A `control_response` belongs to the process's control channel, never to a
   *  Turn; every other frame is dispatched to the active Turn. */
  private consumeLine(line: string, control: ControlChannel): void {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) return;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch (error) {
      this.active?.protocolCorruption(
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
    this.active?.acceptFrame(parsed);
  }

  private onClosed(owned: OwnedProcess, close: OwnedProcessClose): void {
    // A process stop claims the process before awaiting, so once it is in
    // flight `this.process !== owned` and the stop owns the result here.
    if (this.process !== owned) return;
    const result = this.scrub(close);
    const turn = this.processTurn;
    this.releaseProcess();
    if (this.active === turn) this.active = undefined;
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

  /** A close observation with its cause passed through the bearer redactor, so
   *  both the cause and every diagnostic string derived from it are scrubbed. */
  private scrub(close: OwnedProcessClose): OwnedProcessClose {
    if (close.kind === "cleanup-error" || close.kind === "spawn-error") {
      return { kind: close.kind, cause: redactSecrets(close.cause) };
    }
    return close;
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

class ClaudeCodeTurn implements HarnessTurn {
  get settled(): boolean {
    return this.settledKind !== undefined;
  }
  /** The kind the Turn settled with, once it has. */
  settledKind: TurnResult["kind"] | undefined;
  interrupting = false;
  /** The last authoritative fact observed before truth could be lost — carried
   *  into a `lost` result so a caller sees how far the Turn got. */
  lastObservation = "no authoritative observation before the Turn ended";
  readonly request: TurnRequest;
  private readonly listeners = new Set<TurnEventListener>();
  private readonly events: TurnEvent[] = [];
  private readonly tools = new Map<string, string>();
  private readonly resultPromise: Promise<TurnResult>;
  private resolveResult!: (result: TurnResult) => void;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The open handshake or recovery phase, awaiting init. */
  private initPhase: PhaseSpan | undefined;
  private preview = "";
  private previewIndex: number | undefined;
  /** Outstanding approval prompts, keyed by their exact request id. Several may
   *  coexist; each expires when the Turn ends, is interrupted, or is lost. */
  private readonly approvals = new Map<string, PendingApproval>();
  private approvalSeq = 0;

  constructor(
    request: TurnRequest,
    private readonly session: ClaudeCodeSession,
    private readonly steerCapability: SteerCapability,
    private readonly onSettled: () => void,
  ) {
    this.request = request;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  subscribe(listener: TurnEventListener): TurnSubscription {
    for (const event of this.events) listener(event);
    this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  result(): Promise<TurnResult> {
    return this.resultPromise;
  }

  steer(_input: SteerInput): Promise<ControlReceipt> {
    if (this.settled || this.interrupting) {
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    }
    return Promise.resolve(steerReceipt(this.steerCapability));
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
      this.emit({ kind: "request-raised", request });
    });
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
    this.emit({
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
    for (const pending of this.approvals.values()) {
      if (pending.status !== "outstanding") continue;
      pending.status = "settled";
      this.emit({
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

  /** Dispatch one parsed frame. A known type whose schema failed arrives as
   *  `other` and is generic activity, never corruption (frames.ts). */
  acceptFrame(parsed: ParsedFrame): void {
    if (this.settled) return;
    if (parsed.kind === "init") {
      this.acceptInit(parsed.frame);
      return;
    }
    if (!this.session.isInitialized()) {
      if (parsed.kind !== "result") this.emit(genericActivity(parsed.type));
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
      case "telemetry":
        return;
      case "other":
        this.emit(genericActivity(parsed.type));
    }
  }

  protocolCorruption(detail: string, cause?: unknown): void {
    if (this.settled) return;
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

  /** A native stop leaves the process live, but the Session reports `detached`
   *  with its coordinate either way, as Codex does: a resuming Turn reuses the
   *  live process and sends at once, or relaunches with `--resume`. */
  settleInterrupted(stop: "native" | "process"): void {
    this.settle({
      kind: "interrupted",
      detail: {
        interruption:
          stop === "native"
            ? {
                mode: "active-turn",
                evidence:
                  "Claude Code confirmed the interrupt control request with an aborted result; its process stays live for the next Turn.",
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
    this.initPhase?.ok();
    this.initPhase = undefined;
    this.lastObservation = "Claude Code acknowledged the Session at init";
    const facts = sessionFacts(frame, this.session.coordinate);
    this.emit({ kind: "session", availability: { state: "open" }, facts });
    this.emit({ kind: "model", observation: model });
    this.emit({ kind: "activity", description: describeSessionFacts(facts) });
  }

  private acceptAssistant(frame: MessageFrame): void {
    const parentActivity = frame.parent_tool_use_id ?? undefined;
    for (const block of contentBlocks(frame)) {
      const blockType = block.type;
      if (blockType === "text") {
        const content = block.text;
        if (content !== undefined) {
          this.clearPreview();
          this.lastObservation = `assistant content: ${truncate(content)}`;
          this.emit({
            kind: "assistant-content",
            content,
            ...(parentActivity !== undefined ? { parentActivity } : {}),
          });
        }
        continue;
      }
      if (blockType !== "tool_use") continue;
      const tool = block.name ?? "unknown tool";
      const id = block.id;
      if (id !== undefined) this.tools.set(id, tool);
      this.emit({
        kind: "tool-activity",
        activity: {
          tool,
          phase: "started",
          summary: summarize(block.input),
          ...(parentActivity !== undefined ? { parentActivity } : {}),
        },
      });
    }
  }

  private acceptToolResults(frame: MessageFrame): void {
    const parentActivity = frame.parent_tool_use_id ?? undefined;
    for (const block of contentBlocks(frame)) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id;
      const tool = id === undefined ? undefined : this.tools.get(id);
      this.emit({
        kind: "tool-activity",
        activity: {
          tool: tool ?? "unknown tool",
          phase: "completed",
          summary: summarize(block.content),
          ...(parentActivity !== undefined ? { parentActivity } : {}),
        },
      });
    }
  }

  private acceptStreamEvent(frame: StreamEventFrame): void {
    const delta = frame.event.delta;
    if (delta === undefined || delta.type !== "text_delta") return;
    const text = delta.text;
    if (text !== undefined) this.emitPreview(text);
  }

  private acceptResult(frame: ResultFrame): void {
    const usage = usageObservation(frame);
    if (usage !== undefined) this.emit({ kind: "usage", observation: usage });
    // A native stop's confirmation is an `error_during_execution` result, the
    // same subtype a task failure reports. Only an aborted terminal reason while
    // this Turn's Interrupt is in flight confirms it; an aborted result without
    // one, or any other result that wins the race, settles as itself.
    if (this.interrupting && isAbortedResult(frame)) {
      this.settleInterrupted("native");
      return;
    }
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
    if (subtype === "success") {
      const finalContent = frame.result;
      this.settle({
        kind: "completed",
        detail: {
          ...(finalContent !== undefined ? { finalContent } : {}),
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

  /** Report one live activity line, such as why a native stop fell back. */
  noteActivity(description: string): void {
    this.emit({ kind: "activity", description });
  }

  private emit(event: TurnEvent): void {
    if (this.settled) return;
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private emitPreview(delta: string): void {
    if (this.settled) return;
    this.preview += delta;
    const event: TurnEvent = { kind: "preview", text: this.preview };
    if (this.previewIndex === undefined) {
      this.previewIndex = this.events.length;
      this.events.push(event);
    } else {
      this.events[this.previewIndex] = event;
    }
    for (const listener of this.listeners) listener(event);
  }

  private clearPreview(): void {
    if (this.previewIndex === undefined) return;
    this.events.splice(this.previewIndex, 1);
    this.previewIndex = undefined;
    this.preview = "";
  }

  private settle(result: TurnResult): void {
    if (this.settled) return;
    this.clearHandshake();
    // A Turn that settles before init ends its init phase with the Turn's
    // failure, or abandoned when it was interrupted.
    const failure = resultFailure(result);
    if (failure === undefined) this.initPhase?.abandoned();
    else this.initPhase?.failed(failure);
    this.initPhase = undefined;
    this.clearPreview();
    // Terminal ordering: expire every outstanding prompt (its events publish
    // here) before the producer closes and the one result settles.
    this.expireOutstanding();
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

function describeSessionFacts(facts: SessionFacts): string {
  const version = facts.executableVersion ?? "unknown version";
  const tools = facts.tools.length === 0 ? "no tools" : facts.tools.join(", ");
  const mcp =
    facts.mcp.length === 0
      ? "no MCP servers"
      : facts.mcp.map((server) => `${server.name}=${server.status}`).join(", ");
  return `Claude Code ${version}; tools: ${tools}; MCP: ${mcp}`;
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "unavailable";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The steer receipt the profile implies. The profile is the one statement of
 *  native steer (#127 A12): this Adapter declares it unavailable in `buildProfile`
 *  because the print-mode contract has no same-Turn guidance frame, and it has
 *  no send path. A profile claiming steer here would be an Adapter bug, so it is
 *  refused loudly rather than half-honoured. */
function steerReceipt(capability: SteerCapability): ControlReceipt {
  if (capability.available) {
    throw new Error(
      "Claude Code Adapter: the profile declares native steer this Adapter cannot send",
    );
  }
  return { outcome: "rejected", reason: "unsupported" };
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
      category === "spawn-error" || category === "launch-timeout"
        ? "launch"
        : "turn",
    category,
    possibleEffects: "none",
    cause,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
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

/** Why a native stop fell back to the process stop, as a live activity line. */
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

function isCleanClose(result: OwnedProcessClose): boolean {
  return result.kind === "exited" && result.status === 0;
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
      "user-compatible: no --bare, --strict-mcp-config, --allowedTools, --tools, or permission-mode flag; a caller-requested model is forwarded as --model and no model is selected otherwise; the user's settings, hooks, MCP servers, skills, and CLAUDE.md apply.",
    recovery: {
      mode: "native-reattach",
      evidence:
        "Claude Code reattaches a detached Session by resume-by-id (--resume <id>).",
    },
    interruption: {
      mode: "active-turn",
      evidence: `A stdin interrupt control request ends the active Turn, confirmed by an aborted result, and keeps the process for the next Turn. Unconfirmed within the control bound, ${
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
    clarifications: {
      available: false,
      evidence:
        "Claude Code exposes no raw-CLI question callback; structured clarifications are never emulated.",
    },
    steer: {
      available: false,
      evidence:
        "Claude Code's stream-json print mode has no same-Turn guidance frame: a further user message queues as the next Turn, so steer is rejected unsupported and never emulated.",
    },
    modelSelection: {
      at: "launch",
      declaration: { kind: "free-text" },
      evidence:
        "Claude Code accepts any model string at launch via --model; Secant forwards a caller-requested model and selects none otherwise.",
    },
    modelObservation: {
      available: true,
      evidence:
        "The effective model is read from the init message and result usage, distinct from any requested model.",
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

function failed(category: string, diagnostics: string): PrepareResult {
  return { ok: false, failure: failure(category, diagnostics) };
}
