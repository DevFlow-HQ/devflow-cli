import { reportContainment } from "./containment.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedProcess, ProcessAdapter } from "../process/process.js";
import {
  APPROVAL_DECISIONS,
  type CleanupReport,
  type ControlReceipt,
  type HarnessAdapter,
  type HarnessDefaults,
  type HarnessFailure,
  type HarnessPhaseObserver,
  type HarnessPhaseStep,
  type HarnessPlatform,
  type HarnessProfile,
  type HarnessRequest,
  type HarnessTurn,
  type ModelEntry,
  type ModelObservation,
  type PrepareOptions,
  type PrepareResult,
  type PreparedHarness,
  type RecoveryCoordinate,
  type RequestId,
  type RequestAnswer,
  type SessionAvailability,
  type SteerCapability,
  type SteerInput,
  type SteerSettlement,
  type TurnEvent,
  type TurnEventListener,
  type TurnRequest,
  type TurnResult,
  type TurnSubscription,
} from "./harness.js";
import {
  CODEX_EXECUTABLE_ENV,
  discoverCodex,
  discoveredHarnessTarget,
  type DiscoveredHarnessTarget,
} from "./discovery.js";
import {
  CodexDiagnosticCapture,
  CodexQualificationConnection,
  readCodexDefaults,
  type CodexModelList,
  type CodexRecordingObserver,
} from "./codex/qualification.js";
import { validateRequiredSchema } from "./codex/required-schema.js";
import {
  boundedCodexExchange,
  CodexExchangeTimeoutError,
  type CodexJsonlConnection,
  CodexProtocolError,
  CodexRpcResponseError,
  type CodexRpcEnvelope,
  parseRuntimeNotification,
  parseThreadResumeResult,
  parseThreadStartResult,
  sandboxAdmitsDirectory,
  parseTurnInterruptResult,
  parseTurnSteerResult,
  parseTurnStartResult,
} from "./codex/runtime-protocol.js";
import { modelChoiceRefusal } from "./model-request.js";
import { writableDirectoryFailure } from "./writable-directory.js";
import { settleCleanup, startPhase, type PhaseSpan } from "./phases.js";

export type { CodexRecordingObserver } from "./codex/qualification.js";

const HARNESS_NAME = "codex";
const PROBE_REVISION = "codex-probe-2";
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const GENERATED_SCHEMA_FILE = "codex_app_server_protocol.schemas.json";
const AUTHENTICATION_REQUIRED =
  "Authentication required for Codex. Log in separately through Codex, then retry.";

export interface CodexAdapterOverrides {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Cache-key-only platform seam. Production uses the immutable host profile;
   *  tests vary this independently without lying to executable discovery. */
  readonly qualificationCachePlatform?: () => HarnessPlatform;
  readonly path?: string;
  readonly resolve?: (name: string) => string | undefined;
  readonly probeTimeoutMs?: number;
  readonly launchTimeoutMs?: number;
  /** Bounds the one-off `prepare` qualification handshake (initialize, account,
   *  model list). Kept distinct from `controlTimeoutMs` so a test can make live
   *  controls fast without throttling qualification — spawning a child and running
   *  the handshake is not reliably fast on a loaded CI runner, so squeezing it
   *  there makes `prepare` flaky. */
  readonly handshakeTimeoutMs?: number;
  /** Bounds each post-qualification live exchange against the already-warm child:
   *  session thread start/resume and the Turn's start/interrupt/steer control
   *  acknowledgements. Defaults to `handshakeTimeoutMs`. A stall-then-timeout test
   *  squeezes this to settle a withheld acknowledgement quickly. */
  readonly controlTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly probeRevision?: () => string;
  /** Recorder-only observation of the exact schema, protocol/stderr bytes, and
   *  shutdown. Production passes none; native data never reaches a caller. */
  readonly recordingObserver?: CodexRecordingObserver;
  /** Native-Adapter test seam for ending the shared app-server between Turns.
   *  Production interruption owns this lifecycle privately (#365). */
  readonly observeAppServerLifecycle?: (control: {
    readonly end: () => Promise<CleanupReport>;
  }) => void;
}

interface TDiscoveredTarget extends DiscoveredHarnessTarget {
  readonly source: string;
}

type TProbeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: HarnessFailure };

type CodexGeneration = {
  readonly process: OwnedProcess;
  readonly connection: CodexJsonlConnection;
  readonly diagnostics: CodexDiagnosticCapture;
};

type TGenerationResult =
  | { readonly ok: true; readonly value: CodexGeneration }
  | {
      readonly ok: false;
      readonly failure: HarnessFailure;
      readonly unreaped?: CodexGeneration;
    };

type TLiveQualification =
  | {
      readonly ok: true;
      readonly process: OwnedProcess;
      readonly diagnostics: CodexDiagnosticCapture;
      readonly connection: CodexJsonlConnection;
      /** What `model/list` observed: the non-hidden models with their efforts,
       *  and Codex's default model. */
      readonly modelList: CodexModelList;
    }
  | {
      readonly ok: false;
      readonly failure: HarnessFailure;
      readonly unreaped?: CodexGeneration;
    };

/** The factory a composition root calls. Each `prepare` supplies the Process
 *  Interface and phase observer its Prepared Harness uses; the Adapter keeps
 *  only its schema-qualification cache. */
export function createCodexAdapter(
  overrides: CodexAdapterOverrides,
): HarnessAdapter {
  return new CodexAdapter(overrides);
}

class CodexAdapter implements HarnessAdapter {
  private readonly cache = new Set<string>();

  constructor(private readonly overrides: CodexAdapterOverrides) {}

  async prepare(options: PrepareOptions): Promise<PrepareResult> {
    const nativePlatform = this.overrides.platform ?? process.platform;
    const platform = harnessPlatform(nativePlatform);
    if (platform === undefined) {
      return failed(
        "unsupported-platform",
        `Codex is not supported on platform '${nativePlatform}'.`,
      );
    }

    const writableFailure = writableDirectoryFailure(options.writableDirectory);
    if (writableFailure !== undefined) {
      return { ok: false, failure: writableFailure };
    }

    const processAdapter = options.process;
    const discovery = this.discover(options);
    if (!discovery.ok) return discovery;
    const version = await this.probeVersion(processAdapter, discovery.target);
    if (!version.ok) return version;
    this.overrides.recordingObserver?.version(version.value);

    const probeRevision = this.overrides.probeRevision?.() ?? PROBE_REVISION;
    const cachePlatform =
      this.overrides.qualificationCachePlatform?.() ?? platform;
    const identity = fileIdentity(discovery.target.identityPath);
    const cacheKey = qualificationCacheKey({
      target: discovery.target,
      identity,
      version: version.value,
      platform: cachePlatform,
      probeRevision,
    });
    if (cacheKey === undefined || !this.cache.has(cacheKey)) {
      const schema = await this.qualifySchema(
        processAdapter,
        discovery.target,
        probeRevision,
      );
      if (!schema.ok) return schema;
      if (cacheKey !== undefined) this.cache.add(cacheKey);
    }

    const live = await this.qualifyLive(
      processAdapter,
      options.phases,
      discovery.target,
      options.workspace,
      options.containment,
    );
    if (!live.ok) return { ok: false, failure: live.failure };
    const profile = buildProfile({
      target: discovery.target,
      version: version.value,
      platform,
      probeRevision,
      models: live.modelList.models,
    });
    const harness = new CodexPreparedHarness(
      profile,
      live,
      () =>
        this.replaceGeneration(
          options,
          discovery.target,
          identity,
          version.value,
        ),
      options.workspace,
      this.overrides.controlTimeoutMs ??
        this.overrides.handshakeTimeoutMs ??
        DEFAULT_HANDSHAKE_TIMEOUT_MS,
      this.overrides.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      this.overrides.recordingObserver,
      options.writableDirectory,
      options.phases,
      live.modelList,
    );
    this.overrides.observeAppServerLifecycle?.({
      end: () => harness.endAppServer(),
    });
    return { ok: true, harness };
  }

  private async replaceGeneration(
    options: PrepareOptions,
    qualifiedTarget: TDiscoveredTarget,
    identity: string | undefined,
    version: string,
  ): Promise<TGenerationResult> {
    const mismatch = (): TGenerationResult => ({
      ok: false,
      failure: {
        phase: "recovery",
        category: "recovery-identity",
        possibleEffects: "none",
        diagnostics:
          "Codex executable no longer matches the qualified path, digest, or version.",
      },
    });
    const discovery = this.discover(options);
    if (!discovery.ok) return mismatch();
    const target = discovery.target;
    if (
      target.executable !== qualifiedTarget.executable ||
      target.identityPath !== qualifiedTarget.identityPath ||
      JSON.stringify(target.prefixArgs) !==
        JSON.stringify(qualifiedTarget.prefixArgs) ||
      identity === undefined ||
      fileIdentity(target.identityPath) !== identity
    )
      return mismatch();
    const observedVersion = await this.probeVersion(options.process, target);
    if (!observedVersion.ok)
      return {
        ok: false,
        failure: {
          ...observedVersion.failure,
          phase: "recovery",
          category: "recovery-app-server",
        },
      };
    if (observedVersion.value !== version) return mismatch();
    const live = await this.qualifyLive(
      options.process,
      options.phases,
      target,
      options.workspace,
      options.containment,
    );
    return live.ok
      ? { ok: true, value: live }
      : {
          ok: false,
          failure: {
            ...live.failure,
            phase: "recovery",
            category: "recovery-app-server",
          },
          ...(live.unreaped !== undefined ? { unreaped: live.unreaped } : {}),
        };
  }

  private discover(
    options: PrepareOptions,
  ):
    | { readonly ok: true; readonly target: TDiscoveredTarget }
    | { readonly ok: false; readonly failure: HarnessFailure } {
    const discoveryOptions: {
      configuredExecutable?: string;
      env: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      path?: string;
      resolve?: (name: string) => string | undefined;
    } = {
      env: this.overrides.env ?? process.env,
    };
    if (options.configuredExecutable !== undefined) {
      discoveryOptions.configuredExecutable = options.configuredExecutable;
    }
    discoveryOptions.platform = this.overrides.platform ?? process.platform;
    if (this.overrides.path !== undefined) {
      discoveryOptions.path = this.overrides.path;
    }
    if (this.overrides.resolve !== undefined) {
      discoveryOptions.resolve = this.overrides.resolve;
    }
    const discovery = discoverCodex(options.process, discoveryOptions);
    if (discovery.kind === "found") {
      const target = discoveredHarnessTarget(discovery);
      return {
        ok: true,
        target: {
          source: discovery.attempt.description,
          executable: target.executable,
          prefixArgs: target.prefixArgs,
          identityPath: target.identityPath,
          shim: target.shim,
        },
      };
    }
    if (discovery.kind === "unsupported-shim") {
      return {
        ok: false,
        failure: failure(
          "unsupported-shim",
          `Refusing ${discovery.attempt.description}: '${discovery.path}' is a Windows shim the resolver cannot parse. Name the interpreter, or point ${CODEX_EXECUTABLE_ENV} at the real executable.`,
        ),
      };
    }
    const searched = discovery.attempts
      .map((attempt) => attempt.description)
      .join(", ");
    return {
      ok: false,
      failure: failure(
        "not-found",
        `No Codex executable found. Searched: ${searched}.`,
      ),
    };
  }

  private probeVersion(
    processAdapter: ProcessAdapter,
    target: TDiscoveredTarget,
  ): Promise<TProbeResult<string>> {
    return runTextProbe({
      processAdapter,
      target,
      args: ["--version"],
      category: "version-probe",
      description: "Codex version probe",
      timeoutMs: this.overrides.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    });
  }

  private async qualifySchema(
    processAdapter: ProcessAdapter,
    target: TDiscoveredTarget,
    probeRevision: string,
  ): Promise<TProbeResult<true>> {
    const directory = mkdtempSync(join(tmpdir(), "secant-codex-schema-"));
    try {
      const generated = await runTextProbe({
        processAdapter,
        target,
        args: ["app-server", "generate-json-schema", "--out", directory],
        category: "schema-probe",
        description: "Codex stable-schema probe",
        timeoutMs: this.overrides.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        allowEmpty: true,
      });
      if (!generated.ok) return generated;
      const schemaPath = join(directory, GENERATED_SCHEMA_FILE);
      const size = statSync(schemaPath).size;
      if (size > MAX_SCHEMA_BYTES) {
        return failedProbe(
          "protocol-incompatible",
          `Generated Codex schema exceeds ${MAX_SCHEMA_BYTES} bytes.`,
        );
      }
      const schemaText = readFileSync(schemaPath, "utf8");
      this.overrides.recordingObserver?.schema(schemaText, probeRevision);
      const parsed = JSON.parse(schemaText);
      const validated = validateRequiredSchema(parsed);
      if (!validated.ok) {
        return failedProbe(
          "protocol-incompatible",
          `Generated Codex schema is incompatible: ${validated.diagnostics}.`,
        );
      }
      return { ok: true, value: true };
    } catch (cause) {
      return {
        ok: false,
        failure: failureWithCause(
          "protocol-incompatible",
          "Codex did not produce a readable stable schema bundle.",
          cause,
        ),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async qualifyLive(
    processAdapter: ProcessAdapter,
    phases: HarnessPhaseObserver | undefined,
    target: TDiscoveredTarget,
    workspace: string,
    containment: PrepareOptions["containment"],
  ): Promise<TLiveQualification> {
    const launch = startPhase(phases, "launch");
    const spawned = await processAdapter.spawnOwnedProcess({
      role: "harness-runtime",
      executable: target.executable,
      args: target.prefixArgs.concat("app-server"),
      cwd: workspace,
      env: process.env,
      launchTimeoutMs:
        this.overrides.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    });
    if (!spawned.ok) {
      const launchFailure = failureWithCause(
        "app-server-launch",
        "Could not launch Codex app-server.",
        spawned.failure.cause,
      );
      launch.failed(launchFailure);
      return { ok: false, failure: launchFailure };
    }
    reportContainment(containment, spawned.containment);
    launch.ok();
    // Protocol initialization through the account and model reads is the open
    // handshake. Each exchange is a semantic step nested inside it (#325); the
    // step still open when the handshake ends settles with its outcome.
    const handshake = startPhase(phases, "handshake");
    let step = startPhase(
      phases,
      "handshake",
      undefined,
      "protocol-initialize",
    );
    const live = await this.handshake(spawned.process, (next) => {
      step.ok();
      step = startPhase(phases, "handshake", undefined, next);
    });
    if (live.ok) {
      step.ok();
      handshake.ok();
    } else {
      step.failed(live.failure);
      handshake.failed(live.failure);
    }
    return live;
  }

  private async handshake(
    child: OwnedProcess,
    nextStep: (step: HarnessPhaseStep) => void,
  ): Promise<TLiveQualification> {
    const connection = new CodexQualificationConnection(
      child,
      this.overrides.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      this.overrides.recordingObserver,
    );
    const diagnosticCapture = new CodexDiagnosticCapture(
      child.stderr,
      this.overrides.recordingObserver,
    );
    const refuse = (failure: HarnessFailure, includeStderr: boolean) =>
      failedQualification({
        generation: {
          process: child,
          diagnostics: diagnosticCapture,
          connection: connection.runtimeConnection(),
        },
        failure,
        includeStderr,
        cleanupTimeoutMs:
          this.overrides.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
        observer: this.overrides.recordingObserver,
      });
    try {
      await connection.initialize();
      nextStep("account-check");
      const account = await connection.readAccount();
      if (
        account.requiresOpenaiAuth &&
        (account.account === null || account.account === undefined)
      ) {
        const authFailure = failure("authentication", AUTHENTICATION_REQUIRED);
        return refuse(authFailure, false);
      }
      nextStep("model-list");
      const modelList = await connection.listModels();
      return {
        ok: true,
        process: child,
        diagnostics: diagnosticCapture,
        connection: connection.runtimeConnection(),
        modelList,
      };
    } catch (cause) {
      const failureDiagnostics =
        cause instanceof Error ? cause.message : "unknown protocol failure";
      return refuse(
        failureWithCause(
          "protocol-incompatible",
          `Codex live qualification failed: ${failureDiagnostics}`,
          cause,
        ),
        true,
      );
    }
  }
}

class CodexPreparedHarness implements PreparedHarness {
  private closePromise: Promise<CleanupReport> | undefined;
  private defaults: Promise<HarnessDefaults> | undefined;
  private readonly sessions = new Map<string, CodexSession>();
  private active: CodexTurn | undefined;
  private closed = false;
  private generation: CodexGeneration | undefined;
  private replacement: Promise<TGenerationResult> | undefined;
  private ending: Promise<CleanupReport> | undefined;
  private endedReport: CleanupReport | undefined;
  private unreaped:
    | { readonly generation: CodexGeneration; readonly failure: HarnessFailure }
    | undefined;

  constructor(
    readonly profile: HarnessProfile,
    generation: CodexGeneration,
    private readonly replaceGeneration: () => Promise<TGenerationResult>,
    private readonly workspace: string,
    private readonly controlTimeoutMs: number,
    private readonly cleanupTimeoutMs: number,
    private readonly observer: CodexRecordingObserver | undefined,
    /** The one additional writable directory each thread is started or resumed
     *  with (#214). */
    private readonly writableDirectory: string | undefined,
    private readonly phases: HarnessPhaseObserver | undefined,
    /** The qualification's `model/list`, which the defaults read resolves
     *  against. */
    private readonly modelList: CodexModelList,
  ) {
    this.attachGeneration(generation);
  }

  private attachGeneration(generation: CodexGeneration): void {
    this.generation = generation;
    generation.connection.startRuntime({
      message: (message) => {
        if (this.generation === generation) this.acceptMessage(message);
      },
      ended: (cause) => {
        if (this.generation !== generation) return;
        const active = this.active;
        if (active === undefined) return;
        if (cause instanceof CodexProtocolError) {
          active.protocolFailure(cause.message, cause);
          return;
        }
        active.connectionEnded(cause);
      },
    });
  }

  readDefaults(): Promise<HarnessDefaults> {
    if (this.closed) {
      return Promise.reject(
        new Error("readDefaults after close: the prepared Harness is closed"),
      );
    }
    // `config/read` for the Workspace, sent only when a caller asks, so a Run's
    // own prepare never pays for it.
    this.defaults ??= readCodexDefaults(
      () =>
        boundedCodexExchange({
          operation: () => {
            const connection = this.generation?.connection;
            return connection === undefined
              ? Promise.reject(new Error("Codex app-server has ended"))
              : connection.request("config/read", {
                  cwd: this.workspace,
                  includeLayers: false,
                });
          },
          timeoutMs: this.controlTimeoutMs,
          label: "config/read runtime exchange",
        }),
      this.modelList,
    );
    return this.defaults;
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
      session = new CodexSession(
        request.session,
        this.workspace,
        this.controlTimeoutMs,
        this.writableDirectory,
        this.phases,
      );
      this.sessions.set(request.session, session);
    }
    const turn = new CodexTurn({
      request,
      session,
      steerCapability: this.profile.steer,
      controlTimeoutMs: this.controlTimeoutMs,
      phases: this.phases,
      onSettled: () => {
        if (this.active === turn) this.active = undefined;
      },
    });
    this.active = turn;
    const turnSession = session;
    queueMicrotask(() => void this.submit(turn, turnSession));
    return turn;
  }

  private async submit(turn: CodexTurn, session: CodexSession): Promise<void> {
    // Validate this Turn's model before recovery can spawn or send native frames.
    const refusal = modelChoiceRefusal(this.profile, turn.request.modelChoice);
    if (refusal !== undefined) {
      turn.settleNotStartedWith(refusal);
      return;
    }
    if (session.refusesUnusableTurn(turn)) return;
    if (this.ending !== undefined) await this.ending;
    if (this.closed || turn.settled) {
      turn.settleNotStarted(
        "app-server-closed",
        "Codex closed before Turn admission.",
      );
      return;
    }
    if (this.unreaped !== undefined) {
      turn.recovering();
      await this.endGeneration();
      turn.recovered();
      if (this.closed || turn.settled) {
        turn.settleNotStarted(
          "app-server-closed",
          "Codex closed before Turn admission.",
        );
        return;
      }
    }
    if (this.unreaped !== undefined) {
      turn.settleRecoveryFailure(
        {
          ...this.unreaped.failure,
          phase: "recovery",
          category: "recovery-app-server",
          possibleEffects: "none",
          diagnostics:
            "Codex app-server cleanup is incomplete; replacement cannot start until that process is reaped.",
        },
        session.effectiveModel(),
        session.availability(),
      );
      return;
    }
    let generation = this.generation;
    if (generation === undefined) {
      turn.recovering();
      const recovery = startPhase(this.phases, "recovery", session.name);
      this.replacement = this.replaceGeneration();
      const replacement = await this.replacement;
      this.replacement = undefined;
      if (!replacement.ok) {
        if (replacement.unreaped !== undefined) {
          const cleanupFailure: HarnessFailure = {
            ...replacement.failure,
            phase: "cleanup",
            category: "cleanup",
          };
          this.unreaped = {
            generation: replacement.unreaped,
            failure: cleanupFailure,
          };
          this.endedReport = {
            clean: false,
            detail:
              "Codex replacement qualification could not reap its app-server.",
            failure: cleanupFailure,
            sessions: this.sessionReports(),
          };
        }
        recovery.failed(replacement.failure);
        turn.settleRecoveryFailure(
          replacement.failure,
          session.effectiveModel(),
          session.availability(),
        );
        return;
      }
      generation = replacement.value;
      this.attachGeneration(generation);
      recovery.ok();
      turn.recovered();
    }
    if (this.closed || turn.settled) {
      turn.settleNotStarted(
        "app-server-closed",
        "Codex closed before Turn admission.",
      );
      return;
    }
    turn.attachConnection(generation.connection);
    await session.submit(turn, generation.connection);
  }

  /** End the current generation without closing the Prepared Harness. Detach
   *  before awaiting EOF so late native callbacks cannot reach another Turn. */
  endAppServer(): Promise<CleanupReport> {
    if (this.active !== undefined && !this.active.settled) {
      throw new Error("end app-server while a Turn is active");
    }
    return this.endGeneration();
  }

  private endGeneration(): Promise<CleanupReport> {
    if (this.ending !== undefined) return this.ending;
    const generation = this.generation ?? this.unreaped?.generation;
    if (generation === undefined)
      return Promise.resolve(
        this.endedReport ?? {
          clean: true,
          detail: "Codex app-server is already ended.",
          sessions: this.sessionReports(),
        },
      );
    const retryingCleanup = this.unreaped !== undefined;
    this.unreaped = undefined;
    const active = this.active?.isOnConnection(generation.connection)
      ? this.active
      : undefined;
    // During close, the interrupt acknowledgement may precede its terminal.
    // Keep that live Turn's reader until EOF; close forbids a newer Turn.
    if (active === undefined || active.settled) this.generation = undefined;
    for (const session of this.sessions.values()) session.markDetached();
    this.ending = this.closeGeneration(generation, retryingCleanup).then(
      (report) => {
        // Retired callbacks are fenced, so finish any still-live Turn here. Native
        // terminal truth that already settled it remains authoritative.
        if (this.generation === generation) this.generation = undefined;
        active?.connectionEnded(report.failure?.cause);
        // An incomplete cleanup remains visible after a later generation closes.
        if (this.endedReport?.clean !== false) this.endedReport = report;
        this.ending = undefined;
        return report;
      },
    );
    return this.ending;
  }

  close(): Promise<CleanupReport> {
    if (this.closePromise === undefined) {
      this.closed = true;
      const cleanup = startPhase(this.phases, "cleanup");
      this.closePromise = this.closeProcess().then((report) => {
        settleCleanup(cleanup, report);
        return report;
      });
    }
    return this.closePromise;
  }

  private async closeProcess(): Promise<CleanupReport> {
    const active = this.active;
    if (active !== undefined && !active.settled) {
      active.beginClose();
      await active.interruptForClose(this.cleanupTimeoutMs);
    }
    if (this.replacement !== undefined) await this.replacement;
    const report = await this.endGeneration();
    return this.endedReport?.clean === false
      ? { ...this.endedReport, sessions: this.sessionReports() }
      : report;
  }

  private async closeGeneration(
    generation: CodexGeneration,
    retryingCleanup: boolean,
  ): Promise<CleanupReport> {
    let closed = await generation.process.closeStdin(this.cleanupTimeoutMs);
    if (
      retryingCleanup &&
      (closed.kind === "cleanup-error" || closed.kind === "cleanup-timeout")
    ) {
      try {
        closed = await boundedCodexExchange({
          operation: () => generation.process.closed(),
          timeoutMs: this.cleanupTimeoutMs,
          label: "Codex retired app-server final exit",
        });
      } catch {
        // The cached shutdown receipt remains the evidence until final exit.
      }
    }
    this.observer?.closed(
      closed.kind,
      closed.kind === "exited" ? closed.status : undefined,
    );
    const diagnosticResult = await generation.diagnostics.settle(
      this.cleanupTimeoutMs,
    );
    if (closed.kind === "exited" && closed.status === 0) {
      if (diagnosticResult.cause !== undefined) {
        const detail =
          "Codex app-server closed, but stderr did not drain cleanly.";
        return {
          clean: false,
          detail,
          failure: failureWithCause(
            "cleanup",
            appendStderr(detail, diagnosticResult.text),
            diagnosticResult.cause,
          ),
          sessions: this.sessionReports(),
        };
      }
      return {
        clean: true,
        detail: "Codex app-server closed after stdin EOF.",
        sessions: this.sessionReports(),
      };
    }
    const detail = appendStderr(
      `Codex app-server cleanup ended '${closed.kind}'.`,
      diagnosticResult.text,
    );
    const causes: unknown[] = [];
    if (closed.kind === "cleanup-error" || closed.kind === "spawn-error") {
      causes.push(closed.cause);
    }
    if (diagnosticResult.cause !== undefined) {
      causes.push(diagnosticResult.cause);
    }
    const cause = combinedCause(causes, "Codex cleanup failed");
    const cleanupFailure = failureWithOptionalCause("cleanup", detail, cause);
    if (closed.kind === "cleanup-timeout" || closed.kind === "cleanup-error") {
      this.unreaped = { generation, failure: cleanupFailure };
    }
    return {
      clean: false,
      detail,
      failure: cleanupFailure,
      sessions: this.sessionReports(),
    };
  }

  private acceptMessage(message: CodexRpcEnvelope): void {
    const active = this.active;
    if (active === undefined || active.settled) return;
    try {
      const notification = parseRuntimeNotification(message);
      if (notification !== undefined) active.accept(notification);
    } catch (cause) {
      active.protocolFailure("Codex emitted incompatible runtime data.", cause);
    }
  }

  private sessionReports(): readonly {
    readonly session: string;
    readonly availability: SessionAvailability;
  }[] {
    return [...this.sessions.values()].map((session) => ({
      session: session.name,
      availability: session.availability(),
    }));
  }
}

class CodexSession {
  private coordinate: RecoveryCoordinate | undefined;
  private model: ModelObservation = { known: false };
  private detached = false;
  private unusableFailure: HarnessFailure | undefined;

  constructor(
    readonly name: string,
    private readonly workspace: string,
    private readonly controlTimeoutMs: number,
    /** The additional writable directory (#214), sent as a per-thread config
     *  override and checked against the acknowledged sandbox. */
    private readonly writableDirectory: string | undefined,
    private readonly phases: HarnessPhaseObserver | undefined,
  ) {}

  /** The per-thread config override adding the writable directory (#214). It
   *  extends `workspace-write` roots only, so the user's sandbox mode and approval
   *  policy stay theirs; under read-only the user's approvals govern its writes. */
  private threadConfig(): { config?: Record<string, unknown> } {
    return this.writableDirectory === undefined
      ? {}
      : {
          // ponytail: replaces any user-configured extra writable_roots for this
          // thread; merge them via config/read if a user relies on both.
          config: {
            "sandbox_workspace_write.writable_roots": [this.writableDirectory],
          },
        };
  }

  /** Refuse the Turn, failing the thread exchange's phase, when the
   *  acknowledged sandbox cannot write the directory. */
  private refusesWritableDirectory(
    turn: CodexTurn,
    result: unknown,
    phase: PhaseSpan,
  ): boolean {
    const directory = this.writableDirectory;
    if (directory === undefined || sandboxAdmitsDirectory(result, directory)) {
      return false;
    }
    const refusal = notStartedFailure(
      "writable-directory-refused",
      `Codex acknowledged a workspace-write sandbox without the writable root '${directory}'; check the Codex sandbox configuration and retry.`,
    );
    phase.failed(refusal);
    turn.settleNotStartedWith(refusal);
    return true;
  }

  refusesUnusableTurn(turn: CodexTurn): boolean {
    if (this.unusableFailure === undefined) return false;
    turn.settleRecoveryFailure(this.unusableFailure, this.model);
    return true;
  }

  effectiveModel(): ModelObservation {
    return this.model;
  }

  availability(): SessionAvailability {
    if (this.unusableFailure !== undefined) {
      return {
        state: "unusable",
        reason: recoveryFailureDiagnostics(this.unusableFailure),
      };
    }
    return this.coordinate === undefined
      ? { state: "unusable", reason: "Codex thread was not created." }
      : { state: "detached", coordinate: this.coordinate };
  }

  markDetached(): void {
    this.detached = true;
  }

  async submit(
    turn: CodexTurn,
    connection: CodexJsonlConnection,
  ): Promise<void> {
    if (
      turn.request.resume !== undefined &&
      this.coordinate !== undefined &&
      turn.request.resume.opaque !== this.coordinate.opaque
    ) {
      this.failRecovery(
        turn,
        "Codex recovery requested a different thread than the one mapped to this Session.",
      );
      return;
    }
    const recoveryCoordinate =
      turn.request.resume ?? (this.detached ? this.coordinate : undefined);
    if (
      recoveryCoordinate !== undefined &&
      (this.detached || this.coordinate === undefined)
    ) {
      turn.recovering();
      const recovery = startPhase(this.phases, "recovery", this.name);
      try {
        const result = await boundedCodexExchange({
          operation: () =>
            connection.request("thread/resume", {
              threadId: recoveryCoordinate.opaque,
              ...this.threadConfig(),
            }),
          timeoutMs: this.controlTimeoutMs,
          label: "thread/resume runtime exchange",
        });
        const resumed = parseThreadResumeResult(result);
        if (resumed.threadId !== recoveryCoordinate.opaque) {
          throw new CodexProtocolError(
            "thread/resume acknowledged a different Codex thread",
          );
        }
        if (this.refusesWritableDirectory(turn, result, recovery)) return;
        this.coordinate = recoveryCoordinate;
        this.model = { known: true, model: resumed.model };
        this.detached = false;
        turn.recovered();
        recovery.ok();
      } catch (cause) {
        recovery.failed(
          this.failRecovery(turn, recoveryFailureReason(cause), cause),
        );
        return;
      }
    }
    if (this.coordinate === undefined) {
      // A fresh thread's start is the Session's open handshake.
      const handshake = startPhase(this.phases, "handshake", this.name);
      try {
        const result = await boundedCodexExchange({
          operation: () =>
            connection.request("thread/start", {
              cwd: this.workspace,
              ...this.threadConfig(),
            }),
          timeoutMs: this.controlTimeoutMs,
          label: "thread/start runtime exchange",
        });
        const started = parseThreadStartResult(result);
        if (this.refusesWritableDirectory(turn, result, handshake)) return;
        this.coordinate = { opaque: started.threadId };
        this.model = { known: true, model: started.model };
        handshake.ok();
      } catch (cause) {
        const threadFailure = notStartedFailure(
          "thread-start",
          "Codex did not create a fresh thread before Turn admission.",
          cause,
        );
        handshake.failed(threadFailure);
        turn.settleNotStartedWith(threadFailure);
        return;
      }
    }
    const coordinate = this.coordinate;
    if (coordinate === undefined || turn.settled) return;
    const admission = await turn.admit(coordinate);
    if (!admission.recorded) {
      turn.settleNotStarted(
        "durable-admission",
        admission.reason,
        admission.cause,
      );
      return;
    }
    if (turn.settled) return;
    turn.admitted(coordinate, this.model);
    turn.submitting();
    try {
      const turnId = await turn.requestTurnStart({
        connection,
        threadId: coordinate.opaque,
        input: [{ type: "text", text: turn.request.input.text }],
        label: "turn/start runtime exchange",
      });
      turn.acceptTurn(turnId);
    } catch (cause) {
      if (!turn.settled) turn.lostAcceptance(cause);
    }
  }

  private failRecovery(
    turn: CodexTurn,
    diagnostics: string,
    cause?: unknown,
  ): HarnessFailure {
    const failure: HarnessFailure = {
      phase: "recovery",
      category: "recovery-unacknowledged",
      possibleEffects: "none",
      diagnostics,
      ...(cause !== undefined ? { cause } : {}),
    };
    this.unusableFailure = failure;
    turn.settleRecoveryFailure(failure, this.model);
    return failure;
  }
}

type RuntimeNotification = NonNullable<
  ReturnType<typeof parseRuntimeNotification>
>;

interface PendingCodexApproval {
  readonly request: HarnessRequest;
  readonly nativeRequestId: string | number;
  state:
    | { readonly kind: "outstanding" }
    | { readonly kind: "answering"; readonly answer: RequestAnswer }
    | { readonly kind: "answered" }
    | { readonly kind: "expired" };
}

type TCodexNativeTarget = {
  readonly threadId: string;
  readonly turnId: string;
};

type TCodexTurnParams = {
  readonly request: TurnRequest;
  readonly session: CodexSession;
  readonly steerCapability: SteerCapability;
  readonly controlTimeoutMs: number;
  readonly phases: HarnessPhaseObserver | undefined;
  readonly onSettled: () => void;
};

type TNativeTargetWait = {
  readonly label: string;
  readonly timeoutMs: number;
};

type TControlFailure = {
  readonly category: string;
  readonly diagnostics: string;
  readonly cause: unknown;
};

type TInterruptControlState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "targeting" | "sent" | "acknowledged" | "confirmed";
      readonly receipt: Promise<ControlReceipt>;
    };

interface PendingCodexSteer {
  readonly input: SteerInput;
  readonly sentAt: string;
  accepted: boolean;
  /** Codex wrote its `userMessage` into history; model output after it delivers it. */
  inHistory: boolean;
  /** Model output followed it in history: the model saw it. */
  exposed: boolean;
  /** Re-delivered after it was left over, so its delivery is `re-delivered`. */
  redelivered: boolean;
}

type TCodexTurnInput = { readonly type: "text"; readonly text: string };

type TTurnStart = {
  readonly connection: CodexJsonlConnection;
  readonly threadId: string;
  readonly input: readonly TCodexTurnInput[];
  readonly label: string;
};

type TNativeTargetSlot = {
  readonly promise: Promise<TCodexNativeTarget | undefined>;
  readonly resolve: (target: TCodexNativeTarget | undefined) => void;
  resolved: boolean;
};

type TTurnCompleted = Extract<
  RuntimeNotification,
  { readonly kind: "turn-completed" }
>;

class CodexTurn implements HarnessTurn {
  settled = false;
  readonly request: TurnRequest;
  private readonly session: CodexSession;
  private readonly steerCapability: SteerCapability;
  private boundConnection: CodexJsonlConnection | undefined;
  private readonly controlTimeoutMs: number;
  private readonly phases: HarnessPhaseObserver | undefined;
  private readonly onSettled: () => void;
  private readonly listeners = new Set<TurnEventListener>();
  private readonly events: TurnEvent[] = [];
  private readonly resultPromise: Promise<TurnResult>;
  private resolveResult!: (result: TurnResult) => void;
  private admittedToRuntime = false;
  private submitted = false;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private model: ModelObservation = { known: false };
  private finalContent: string | undefined;
  private terminalError: string | undefined;
  private readonly pendingNotifications: RuntimeNotification[] = [];
  private preview = "";
  private previewIndex: number | undefined;
  private lastObservation = "no authoritative Codex Turn observation";
  private recoveryPending = false;
  private readonly steers = new Map<string, PendingCodexSteer>();
  private readonly steerIds = new Set<string>();
  private readonly approvals = new Map<string, PendingCodexApproval>();
  private readonly approvalsByNativeId = new Map<
    string,
    PendingCodexApproval
  >();
  private readonly approvalInputsByItemId = new Map<string, string>();
  private approvalSequence = 0;
  // Replaced when a leftover Steer's re-delivery moves the Turn to a new native
  // turn id; a control waiting meanwhile targets the re-delivery.
  private nativeTarget = nativeTargetSlot();
  private interruptState: TInterruptControlState = { kind: "idle" };
  private closing = false;

  constructor(params: TCodexTurnParams) {
    this.request = params.request;
    this.session = params.session;
    this.steerCapability = params.steerCapability;
    this.controlTimeoutMs = params.controlTimeoutMs;
    this.phases = params.phases;
    this.onSettled = params.onSettled;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  isOnConnection(connection: CodexJsonlConnection): boolean {
    return this.boundConnection === connection;
  }

  attachConnection(connection: CodexJsonlConnection): void {
    this.boundConnection = connection;
  }

  private get connection(): CodexJsonlConnection {
    if (this.boundConnection === undefined) {
      throw new Error("Codex Turn has no native connection before submission");
    }
    return this.boundConnection;
  }

  subscribe(listener: TurnEventListener): TurnSubscription {
    for (const event of this.events) listener(event);
    if (!this.settled) this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  result(): Promise<TurnResult> {
    return this.resultPromise;
  }

  async steer(input: SteerInput): Promise<ControlReceipt> {
    if (this.settled || this.interruptState.kind !== "idle" || this.closing) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (!this.steerCapability.available) {
      return steerReceipt(this.steerCapability);
    }
    const target = await this.waitForNativeTarget({
      label: "turn/steer target exchange",
      timeoutMs: this.controlTimeoutMs,
    });
    if (target === undefined || !this.acceptsNewInput()) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (this.steerIds.has(input.steerId))
      return { outcome: "rejected", reason: "already-settled" };
    this.steerIds.add(input.steerId);
    return this.steerTarget(input, target);
  }

  private async steerTarget(
    input: SteerInput,
    target: TCodexNativeTarget,
  ): Promise<ControlReceipt> {
    let acceptedWhileLive = false;
    const clientId = `secant-steer-${createHash("sha256").update(input.steerId).digest("hex")}`;
    const pending: PendingCodexSteer = {
      input,
      sentAt: new Date().toISOString(),
      accepted: false,
      inHistory: false,
      exposed: false,
      redelivered: false,
    };
    this.steers.set(clientId, pending);
    let result: unknown;
    const control = startPhase(this.phases, "control", this.request.session);
    try {
      result = await boundedCodexExchange({
        operation: () =>
          this.connection.requestControl({
            method: "turn/steer",
            params: {
              threadId: target.threadId,
              expectedTurnId: target.turnId,
              clientUserMessageId: clientId,
              input: [{ type: "text", text: input.text }],
            },
            onAccepted: (response) => {
              let responseTurnId: string;
              try {
                responseTurnId = parseTurnSteerResult(response);
              } catch {
                return;
              }
              acceptedWhileLive =
                this.acceptsNewInput() &&
                responseTurnId === target.turnId &&
                this.steers.get(clientId) === pending;
              if (!acceptedWhileLive) return;
              pending.accepted = true;
              this.settleDelivered(clientId, pending);
            },
          }),
        timeoutMs: this.controlTimeoutMs,
        label: "turn/steer control exchange",
      });
    } catch (cause) {
      this.steers.delete(clientId);
      this.settleControlPhase(control, cause);
      return this.rejectControlFailure(
        "Codex turn/steer control failed.",
        cause,
      );
    }
    let steeredTurnId: string;
    try {
      steeredTurnId = parseTurnSteerResult(result);
    } catch (cause) {
      control.failed(
        this.controlFailure({
          category: "protocol-corruption",
          diagnostics: "Codex emitted an invalid turn/steer response.",
          cause,
        }),
      );
      return { outcome: "rejected", reason: "expired" };
    }
    control.ok();
    if (!acceptedWhileLive || steeredTurnId !== target.turnId) {
      this.steers.delete(clientId);
      return { outcome: "rejected", reason: "expired" };
    }
    return { outcome: "accepted" };
  }

  async interrupt(): Promise<ControlReceipt> {
    if (this.settled || this.closing) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (this.interruptState.kind !== "idle") {
      return { outcome: "rejected", reason: "already-settled" };
    }
    return this.startInterrupt(this.controlTimeoutMs);
  }

  beginClose(): void {
    this.closing = true;
    this.settleApprovals(false);
  }

  interruptForClose(timeoutMs: number): Promise<ControlReceipt> {
    if (this.settled) {
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    }
    if (this.interruptState.kind === "idle") {
      return this.startInterrupt(timeoutMs);
    }
    return this.waitForInterruptDuringClose(timeoutMs);
  }

  private startInterrupt(timeoutMs: number): Promise<ControlReceipt> {
    // Publish the control state before any already-ready target/response can
    // settle the async operation and reset it during the same microtask turn.
    const interrupt = Promise.resolve().then(() =>
      this.requestInterrupt(timeoutMs),
    );
    this.interruptState = { kind: "targeting", receipt: interrupt };
    return interrupt;
  }

  private async requestInterrupt(timeoutMs: number): Promise<ControlReceipt> {
    const target = await this.waitForNativeTarget({
      label: "turn/interrupt target exchange",
      timeoutMs,
    });
    if (target === undefined || this.settled) {
      this.interruptState = { kind: "idle" };
      return { outcome: "rejected", reason: "expired" };
    }
    const state = this.interruptState;
    if (state.kind !== "targeting") {
      return { outcome: "rejected", reason: "expired" };
    }
    this.interruptState = { kind: "sent", receipt: state.receipt };
    return this.interruptTarget(target, timeoutMs);
  }

  private async interruptTarget(
    target: TCodexNativeTarget,
    timeoutMs: number,
  ): Promise<ControlReceipt> {
    let result: unknown;
    const control = startPhase(this.phases, "control", this.request.session);
    try {
      result = await boundedCodexExchange({
        operation: () =>
          this.connection.request("turn/interrupt", {
            threadId: target.threadId,
            turnId: target.turnId,
          }),
        timeoutMs,
        label: "turn/interrupt control exchange",
      });
    } catch (cause) {
      this.settleControlPhase(control, cause);
      if (cause instanceof CodexRpcResponseError) {
        this.interruptState = { kind: "idle" };
      }
      return this.rejectControlFailure(
        "Codex turn/interrupt control failed.",
        cause,
      );
    }
    try {
      parseTurnInterruptResult(result);
    } catch (cause) {
      control.failed(
        this.controlFailure({
          category: "protocol-corruption",
          diagnostics: "Codex emitted an invalid turn/interrupt response.",
          cause,
        }),
      );
      return { outcome: "rejected", reason: "expired" };
    }
    control.ok();
    const state = this.interruptState;
    if (state.kind === "confirmed") return { outcome: "accepted" };
    if (this.settled || state.kind !== "sent") {
      return { outcome: "rejected", reason: "expired" };
    }
    this.interruptState = { kind: "acknowledged", receipt: state.receipt };
    this.lastObservation = "Codex acknowledged turn/interrupt";
    return { outcome: "accepted" };
  }

  private async waitForInterruptDuringClose(
    timeoutMs: number,
  ): Promise<ControlReceipt> {
    const state = this.interruptState;
    if (state.kind === "idle") {
      return { outcome: "rejected", reason: "expired" };
    }
    try {
      return await boundedCodexExchange({
        operation: () => state.receipt,
        timeoutMs,
        label: "in-flight turn/interrupt during cleanup",
      });
    } catch {
      return { outcome: "rejected", reason: "expired" };
    }
  }

  private acceptsNewInput(): boolean {
    return (
      !this.settled && this.interruptState.kind === "idle" && !this.closing
    );
  }

  private async waitForNativeTarget(
    params: TNativeTargetWait,
  ): Promise<TCodexNativeTarget | undefined> {
    try {
      const { promise } = this.nativeTarget;
      return await boundedCodexExchange({
        operation: () => promise,
        timeoutMs: params.timeoutMs,
        label: params.label,
      });
    } catch {
      return undefined;
    }
  }

  private rejectControlFailure(
    diagnostics: string,
    cause: unknown,
  ): ControlReceipt {
    const expected = expectedControlRejection(cause);
    if (expected !== undefined) return expected;
    if (
      cause instanceof CodexRpcResponseError ||
      cause instanceof CodexExchangeTimeoutError
    ) {
      this.emit({
        kind: "activity",
        description: `${diagnostics} ${cause.message}`,
      });
      return { outcome: "rejected", reason: "expired" };
    }
    this.controlFailure({
      category: "control-transport",
      diagnostics,
      cause,
    });
    return { outcome: "rejected", reason: "expired" };
  }

  /** Lose the Turn to a control failure, unless it already settled; either way
   *  return the failure, for the control phase to settle with. */
  private controlFailure(params: TControlFailure): HarnessFailure {
    const failure = this.controlFailureValue(params);
    if (this.settled) return failure;
    this.session.markDetached();
    const interruptionUnknown = this.interruptionOutcomeUnknown();
    this.settle({
      kind: "lost",
      detail: {
        unknown: interruptionUnknown
          ? "interruption"
          : this.turnId === undefined
            ? "acceptance"
            : "completion",
        lastObservation: this.lastObservation,
        session: this.session.availability(),
        failure,
      },
    });
    return failure;
  }

  private controlFailureValue(params: TControlFailure): HarnessFailure {
    return {
      phase: "control",
      category: params.category,
      possibleEffects: this.submitted ? "possible" : "none",
      diagnostics: params.diagnostics,
      cause: params.cause,
    };
  }

  /** Settle a control phase whose exchange threw: an expected race (the Turn
   *  ended natively first) abandons it; a refusal, timeout, or transport failure
   *  fails it with the native code when the RPC returned one. */
  private settleControlPhase(control: PhaseSpan, cause: unknown): void {
    if (expectedControlRejection(cause) !== undefined) {
      control.abandoned();
      return;
    }
    control.failed({
      ...this.controlFailureValue({
        category:
          cause instanceof CodexRpcResponseError
            ? "control-refused"
            : cause instanceof CodexExchangeTimeoutError
              ? "control-timeout"
              : "control-transport",
        diagnostics: "Codex did not acknowledge the control.",
        cause,
      }),
      ...(cause instanceof CodexRpcResponseError
        ? { nativeCode: String(cause.code) }
        : {}),
    });
  }

  async answerRequest(answer: RequestAnswer): Promise<ControlReceipt> {
    if (this.settled) return { outcome: "rejected", reason: "expired" };
    const pending = this.approvals.get(answer.requestId.opaque);
    if (pending === undefined) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (pending.state.kind !== "outstanding") {
      return { outcome: "rejected", reason: "already-settled" };
    }
    if (answer.kind !== "approval") {
      return { outcome: "rejected", reason: "shape-mismatch" };
    }
    pending.state = { kind: "answering", answer };
    try {
      await this.connection.respondToServerRequest(pending.nativeRequestId, {
        decision: answer.decision === "allow" ? "accept" : "decline",
      });
    } catch (cause) {
      if (pending.state.kind === "answering") {
        pending.state = { kind: "outstanding" };
      }
      this.protocolFailure(
        "Codex approval response could not be written to app-server.",
        cause,
      );
      return this.approvals.get(answer.requestId.opaque)?.state.kind ===
        "answered"
        ? { outcome: "accepted" }
        : { outcome: "rejected", reason: "expired" };
    }
    const state = this.approvals.get(answer.requestId.opaque)?.state;
    if (state?.kind === "answered") return { outcome: "accepted" };
    if (this.settled) return { outcome: "rejected", reason: "expired" };
    if (state?.kind !== "answering") {
      return { outcome: "rejected", reason: "already-settled" };
    }
    this.settleApproval(pending, true);
    return { outcome: "accepted" };
  }

  recovering(): void {
    this.recoveryPending = true;
  }

  recovered(): void {
    this.recoveryPending = false;
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
    } catch (cause) {
      return {
        recorded: false,
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      };
    }
  }

  admitted(coordinate: RecoveryCoordinate, model: ModelObservation): void {
    this.admittedToRuntime = true;
    this.threadId = coordinate.opaque;
    this.model = model;
    this.lastObservation = "Codex acknowledged the Session thread";
    this.emit({
      kind: "session",
      availability: { state: "open" },
      facts: { recoveryCoordinate: coordinate, tools: [], mcp: [] },
    });
    this.emit({ kind: "model", observation: model });
  }

  submitting(): void {
    this.submitted = true;
  }

  /** Start a native turn for this Turn's thread and input; its native turn id. */
  async requestTurnStart(start: TTurnStart): Promise<string> {
    const result = await boundedCodexExchange({
      operation: () =>
        start.connection.request("turn/start", {
          threadId: start.threadId,
          input: start.input,
          // This Turn's requested model is applied at the native per-Turn point;
          // the effective model stays what thread/start observed, never the
          // request. Its effort is not sent yet (#345).
          ...(this.request.modelChoice !== undefined
            ? { model: this.request.modelChoice.model }
            : {}),
        }),
      timeoutMs: this.controlTimeoutMs,
      label: start.label,
    });
    return parseTurnStartResult(result);
  }

  acceptTurn(turnId: string): void {
    if (this.settled) return;
    const threadId = this.threadId;
    if (threadId === undefined) {
      this.protocolFailure(
        "turn/start was acknowledged before thread creation.",
      );
      return;
    }
    this.turnId = turnId;
    this.lastObservation = "Codex accepted turn/start";
    this.resolveTarget({ threadId, turnId });
    this.flushPendingNotifications();
  }

  accept(notification: RuntimeNotification): void {
    if (this.settled || !this.admittedToRuntime) return;
    if (notification.kind === "activity") {
      this.emit({ kind: "activity", description: notification.description });
      return;
    }
    if (notification.kind === "unsupported-server-request") {
      this.protocolFailure(
        `Codex raised unsupported server request '${notification.method}'.`,
      );
      return;
    }
    if (notification.threadId !== this.threadId) return;
    if (notification.kind === "server-request-resolved") {
      if (this.turnId === undefined) {
        this.pendingNotifications.push(notification);
        return;
      }
      this.resolveNativeRequest(notification.nativeRequestId);
      return;
    }
    if (notification.kind === "turn-started" && this.turnId === undefined) {
      this.pendingNotifications.push(notification);
      return;
    }
    if (this.turnId === undefined) {
      this.pendingNotifications.push(notification);
      return;
    }
    if (!this.matchesTurn(notification.turnId)) return;
    if (notification.kind === "approval-request") {
      this.deliverSteersInHistory();
      this.raiseApproval(notification);
      return;
    }
    if (notification.kind === "turn-started") {
      this.lastObservation = "Codex emitted matching turn/started";
      return;
    }
    switch (notification.kind) {
      case "preview":
        this.lastObservation = "Codex emitted assistant preview content";
        this.deliverSteersInHistory();
        this.emitPreview(notification.delta);
        return;
      case "item-event":
        if (notification.userMessageClientId !== undefined) {
          const pending = this.steers.get(notification.userMessageClientId);
          if (pending !== undefined) pending.inHistory = true;
        }
        if (notification.modelOutput) this.deliverSteersInHistory();
        if (notification.approvalInput !== undefined) {
          this.approvalInputsByItemId.set(
            notification.itemId,
            notification.approvalInput,
          );
        }
        if (notification.event !== undefined) {
          if (notification.event.kind === "assistant-content") {
            this.clearPreview();
            this.finalContent = notification.event.content;
            this.lastObservation =
              "Codex completed an authoritative agent message";
          }
          this.emit(notification.event);
        }
        return;
      case "error":
        if (!notification.willRetry) {
          this.terminalError = notification.message;
        }
        this.emit({
          kind: "activity",
          description: notification.willRetry
            ? `Codex is retrying after an error: ${notification.message}`
            : `Codex reported an error: ${notification.message}`,
        });
        return;
      case "turn-completed":
        this.acceptTerminal(notification);
        return;
    }
  }

  connectionEnded(cause?: unknown): void {
    if (this.settled) return;
    if (this.recoveryPending) return;
    if (!this.admittedToRuntime) {
      this.settleNotStarted(
        "app-server-closed",
        "Codex app-server closed before durable Turn admission.",
        cause,
      );
      return;
    }
    this.session.markDetached();
    const interruptionUnknown = this.interruptionOutcomeUnknown();
    this.settle({
      kind: "lost",
      detail: {
        unknown: interruptionUnknown
          ? "interruption"
          : this.turnId === undefined
            ? "acceptance"
            : "completion",
        lastObservation: this.lastObservation,
        session: this.session.availability(),
        failure: {
          phase: "turn",
          category: interruptionUnknown
            ? "interruption-unknown"
            : "app-server-closed",
          possibleEffects: this.submitted ? "possible" : "none",
          diagnostics: interruptionUnknown
            ? "Codex app-server closed before confirming native interruption."
            : "Codex app-server closed without a matching terminal Turn event.",
          ...(cause !== undefined ? { cause } : {}),
        },
      },
    });
  }

  lostAcceptance(cause: unknown): void {
    this.session.markDetached();
    this.settle({
      kind: "lost",
      detail: {
        unknown: "acceptance",
        lastObservation: this.lastObservation,
        session: this.session.availability(),
        failure: {
          phase: "turn",
          category: "turn-start",
          possibleEffects: "possible",
          diagnostics: "Codex did not acknowledge turn/start.",
          cause,
        },
      },
    });
  }

  settleNotStarted(
    category: string,
    diagnostics: string,
    cause?: unknown,
  ): void {
    this.settleNotStartedWith(notStartedFailure(category, diagnostics, cause));
  }

  settleNotStartedWith(failure: HarnessFailure): void {
    this.settle({ kind: "not-started", detail: { failure } });
  }

  settleRecoveryFailure(
    failure: HarnessFailure,
    effectiveModel: ModelObservation,
    availability: SessionAvailability = {
      state: "unusable",
      reason: recoveryFailureDiagnostics(failure),
    },
  ): void {
    this.settle({
      kind: "failed",
      detail: {
        failure,
        effectiveModel,
        session: availability,
      },
    });
  }

  protocolFailure(diagnostics: string, cause?: unknown): void {
    if (this.settled) return;
    if (this.recoveryPending) return;
    if (!this.submitted) {
      this.settleNotStarted("protocol-corruption", diagnostics, cause);
      return;
    }
    this.session.markDetached();
    const interruptionUnknown = this.interruptionOutcomeUnknown();
    this.settle({
      kind: "lost",
      detail: {
        unknown: interruptionUnknown
          ? "interruption"
          : this.turnId === undefined
            ? "acceptance"
            : "completion",
        lastObservation: this.lastObservation,
        session: this.session.availability(),
        failure: {
          phase: "turn",
          category: "protocol-corruption",
          possibleEffects: "possible",
          diagnostics,
          ...(cause !== undefined ? { cause } : {}),
        },
      },
    });
  }

  private matchesTurn(turnId: string): boolean {
    return this.turnId === turnId;
  }

  private raiseApproval(
    notification: Extract<
      RuntimeNotification,
      { readonly kind: "approval-request" }
    >,
  ): void {
    const nativeKey = nativeRequestKey(notification.nativeRequestId);
    if (this.approvalsByNativeId.has(nativeKey)) {
      this.protocolFailure("Codex reused an outstanding server request id.");
      return;
    }
    const input =
      notification.input ??
      this.approvalInputsByItemId.get(notification.itemId);
    if (input === undefined || input.length === 0) {
      this.protocolFailure(
        `Codex raised ${notification.tool} approval without exact action context.`,
      );
      return;
    }
    const requestId: RequestId = {
      opaque: `codex-approval-${this.approvalSequence++}`,
    };
    const request: HarnessRequest = {
      requestId,
      shape: {
        kind: "approval",
        tool: notification.tool,
        input,
        decisions: [...APPROVAL_DECISIONS],
      },
    };
    const pending: PendingCodexApproval = {
      request,
      nativeRequestId: notification.nativeRequestId,
      state: { kind: "outstanding" },
    };
    this.approvals.set(requestId.opaque, pending);
    this.approvalsByNativeId.set(nativeKey, pending);
    this.emit({ kind: "request-raised", request });
  }

  private resolveNativeRequest(nativeRequestId: string | number): void {
    const pending = this.approvalsByNativeId.get(
      nativeRequestKey(nativeRequestId),
    );
    if (pending !== undefined) this.settleApproval(pending, true);
  }

  private settleApproval(
    pending: PendingCodexApproval,
    confirmAnswer: boolean,
  ): void {
    if (pending.state.kind === "answered" || pending.state.kind === "expired") {
      return;
    }
    if (confirmAnswer && pending.state.kind === "answering") {
      const { answer } = pending.state;
      pending.state = { kind: "answered" };
      this.emit({
        kind: "request-answered",
        requestId: pending.request.requestId,
        by: "human",
        answer,
      });
      return;
    }
    pending.state = { kind: "expired" };
    this.emit({
      kind: "request-expired",
      requestId: pending.request.requestId,
    });
  }

  private settleApprovals(confirmAnswers: boolean): void {
    for (const pending of this.approvals.values()) {
      this.settleApproval(pending, confirmAnswers);
    }
  }

  private flushPendingNotifications(): void {
    for (const notification of this.pendingNotifications.splice(0)) {
      this.accept(notification);
    }
  }

  private acceptTerminal(notification: TTurnCompleted): void {
    this.lastObservation = `Codex emitted turn/completed: ${notification.status}`;
    const leftovers = this.leftoverSteers();
    if (
      leftovers.length > 0 &&
      (notification.status === "completed" ||
        notification.status === "failed") &&
      this.acceptsNewInput()
    ) {
      void this.redeliver(notification, leftovers);
      return;
    }
    this.settleTerminal(notification);
  }

  /** Steers Codex wrote into history after the model's last request: a native
   *  terminal with no model output after them leaves them unanswered. */
  private leftoverSteers(): PendingCodexSteer[] {
    return [...this.steers.values()].filter(
      (pending) =>
        pending.inHistory && !pending.exposed && !pending.redelivered,
    );
  }

  /** Re-deliver leftover Steers inside this Turn with a native `turn/start` on
   *  the idle thread: empty input, so the model answers them from history, or
   *  their text when Codex refuses empty input. The Turn re-targets the new
   *  native turn id privately and stays open until that turn's terminal. */
  private async redeliver(
    terminal: TTurnCompleted,
    leftovers: readonly PendingCodexSteer[],
  ): Promise<void> {
    const threadId = terminal.threadId;
    this.turnId = undefined;
    this.nativeTarget = nativeTargetSlot();
    this.settleApprovals(true);
    this.clearPreview();
    this.terminalError = undefined;
    this.lastObservation = "Codex left an accepted Steer unanswered";
    try {
      const empty = await this.startRedelivery(threadId, []);
      // Nothing is re-sent once the human stopped the Turn or Secant closes.
      const started =
        typeof empty === "string" || this.settled || !this.acceptsNewInput()
          ? empty
          : await this.startRedelivery(
              threadId,
              leftovers.map((pending) => ({
                type: "text",
                text: pending.input.text,
              })),
            );
      if (this.settled) return;
      if (typeof started === "string") {
        for (const pending of leftovers) pending.redelivered = true;
        this.acceptTurn(started);
        return;
      }
      if (started !== empty) {
        this.emit({
          kind: "activity",
          description: `Codex refused to re-deliver a Steer. ${started.message}`,
        });
      }
      // The native terminal stands; the Steers stay in history, delivered.
      this.settleTerminal(terminal);
    } catch (cause) {
      if (!this.settled) this.lostAcceptance(cause);
    }
  }

  /** A re-delivery's native turn id, or Codex's refusal of it. */
  private async startRedelivery(
    threadId: string,
    input: readonly TCodexTurnInput[],
  ): Promise<string | CodexRpcResponseError> {
    try {
      return await this.requestTurnStart({
        connection: this.connection,
        threadId,
        input,
        label: "turn/start Steer re-delivery exchange",
      });
    } catch (cause) {
      if (cause instanceof CodexRpcResponseError) return cause;
      throw cause;
    }
  }

  private settleTerminal(notification: TTurnCompleted): void {
    if (notification.status === "inProgress") {
      this.protocolFailure(
        "Codex turn/completed carried nonterminal status 'inProgress'.",
      );
      return;
    }
    if (notification.status === "completed") {
      this.settle(
        {
          kind: "completed",
          detail: {
            ...(this.finalContent !== undefined
              ? { finalContent: this.finalContent }
              : {}),
            effectiveModel: this.model,
            session: { state: "open" },
          },
        },
        true,
      );
      return;
    }
    if (notification.status === "interrupted") {
      this.confirmInterrupt();
      this.session.markDetached();
      this.settle(
        {
          kind: "interrupted",
          detail: {
            interruption: {
              mode: "active-turn",
              evidence: "Codex emitted a matching interrupted terminal Turn.",
            },
            session: this.session.availability(),
          },
        },
        true,
      );
      return;
    }
    const diagnostics =
      notification.error ?? this.terminalError ?? "Codex Turn failed.";
    this.settle(
      {
        kind: "failed",
        detail: {
          failure: {
            phase: "turn",
            category: "execution",
            possibleEffects: "possible",
            diagnostics,
          },
          effectiveModel: this.model,
          session: { state: "open" },
        },
      },
      true,
    );
  }

  private emit(event: TurnEvent): void {
    if (this.settled) return;
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private confirmInterrupt(): void {
    const state = this.interruptState;
    if (state.kind === "idle") return;
    this.interruptState = { kind: "confirmed", receipt: state.receipt };
  }

  private interruptionOutcomeUnknown(): boolean {
    return (
      this.interruptState.kind === "sent" ||
      this.interruptState.kind === "acknowledged"
    );
  }

  private emitPreview(delta: string): void {
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

  /** Model output proves the model saw every Steer already in history. */
  private deliverSteersInHistory(): void {
    for (const [clientId, pending] of this.steers) {
      if (!pending.inHistory) continue;
      pending.exposed = true;
      this.settleDelivered(clientId, pending);
    }
  }

  /** A Steer settles delivered once Codex both accepted it and exposed it,
   *  in either order. */
  private settleDelivered(clientId: string, pending: PendingCodexSteer): void {
    if (!pending.accepted || !pending.exposed) return;
    this.settleSteer(clientId, pending, {
      kind: "delivered",
      delivery: pending.redelivered ? "re-delivered" : "within-turn",
    });
  }

  private settleSteer(
    clientId: string,
    pending: PendingCodexSteer,
    settlement: SteerSettlement,
  ): void {
    this.steers.delete(clientId);
    this.emit({
      kind: "steer",
      ...pending.input,
      sentAt: pending.sentAt,
      settlement,
    });
  }

  private settle(result: TurnResult, confirmAnswers = false): void {
    if (this.settled) return;
    this.resolveTarget(undefined);
    this.clearPreview();
    for (const [clientId, pending] of this.steers) {
      if (!pending.accepted) continue;
      // Codex delivers a Steer by writing it into history (ADR 0035); only a
      // leftover awaits model output, so any other end settles it delivered.
      this.settleSteer(
        clientId,
        pending,
        pending.inHistory
          ? {
              kind: "delivered",
              delivery: pending.redelivered ? "re-delivered" : "within-turn",
            }
          : {
              kind: "dropped",
              reason: result.kind === "interrupted" ? "interrupt" : "loss",
            },
      );
    }
    this.steers.clear();
    this.settleApprovals(confirmAnswers);
    this.settled = true;
    this.listeners.clear();
    this.onSettled();
    this.resolveResult(result);
  }

  private resolveTarget(target: TCodexNativeTarget | undefined): void {
    if (this.nativeTarget.resolved) return;
    this.nativeTarget.resolved = true;
    this.nativeTarget.resolve(target);
  }
}

function nativeTargetSlot(): TNativeTargetSlot {
  let resolve!: (target: TCodexNativeTarget | undefined) => void;
  const promise = new Promise<TCodexNativeTarget | undefined>((settle) => {
    resolve = settle;
  });
  return { promise, resolve, resolved: false };
}

/** The failure a Turn that never started carries. */
function notStartedFailure(
  category: string,
  diagnostics: string,
  cause?: unknown,
): HarnessFailure {
  return {
    phase: "turn",
    category,
    possibleEffects: "none",
    diagnostics,
    ...(cause !== undefined ? { cause } : {}),
  };
}

function nativeRequestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function steerReceipt(capability: SteerCapability): ControlReceipt {
  return capability.available
    ? { outcome: "accepted" }
    : { outcome: "rejected", reason: "unsupported" };
}

function expectedControlRejection(cause: unknown): ControlReceipt | undefined {
  if (!(cause instanceof CodexRpcResponseError) || cause.code !== -32_600) {
    return undefined;
  }
  // Mirrors codex-rs/app-server/src/request_processors/turn_processor.rs:
  // 1083-1153 and 1610-1619 are the current unstructured control races.
  const message = cause.rpcMessage;
  if (cause.method === "turn/interrupt") {
    if (
      message === "no active turn to interrupt" ||
      isExpectedTurnMismatch(cause.method, message)
    ) {
      return { outcome: "rejected", reason: "expired" };
    }
    return undefined;
  }
  if (cause.method !== "turn/steer") return undefined;
  if (message === "input must not be empty") {
    return { outcome: "rejected", reason: "shape-mismatch" };
  }
  if (
    message === "no active turn to steer" ||
    message === "cannot steer a review turn" ||
    message === "cannot steer a compact turn" ||
    message === "active turn uses a different output schema" ||
    isExpectedTurnMismatch(cause.method, message)
  ) {
    return { outcome: "rejected", reason: "expired" };
  }
  return undefined;
}

function isExpectedTurnMismatch(method: string, message: string): boolean {
  if (method === "turn/steer") {
    return /^expected active turn id `[^`\s]+` but found `[^`\s]+`$/.test(
      message,
    );
  }
  return /^expected active turn id \S+ but found \S+$/.test(message);
}

interface TRunTextProbe {
  readonly processAdapter: ProcessAdapter;
  readonly target: TDiscoveredTarget;
  readonly args: readonly string[];
  readonly category: string;
  readonly description: string;
  readonly timeoutMs: number;
  readonly allowEmpty?: boolean;
}

async function runTextProbe(
  options: TRunTextProbe,
): Promise<TProbeResult<string>> {
  const result = await options.processAdapter.spawnCommand({
    role: "harness-probe",
    executable: options.target.executable,
    args: options.target.prefixArgs.concat(options.args),
    cwd: undefined,
    env: process.env,
    timeoutMs: options.timeoutMs,
    maxCaptureBytes: 64 * 1024,
    truncationMarker: "…",
  });
  if (result.kind !== "exited") {
    return failedProbe(
      options.category,
      `${options.description} did not exit cleanly (${result.kind}).`,
    );
  }
  if (result.status !== 0) {
    return {
      ok: false,
      failure: failureWithNativeCode(
        options.category,
        `${options.description} exited ${result.status}.`,
        String(result.status),
      ),
    };
  }
  const text = new TextDecoder().decode(result.text).trim();
  if (text.length === 0 && options.allowEmpty !== true) {
    return failedProbe(
      options.category,
      `${options.description} produced no output.`,
    );
  }
  return { ok: true, value: text };
}

interface TCacheKey {
  readonly target: TDiscoveredTarget;
  readonly identity: string | undefined;
  readonly version: string;
  readonly platform: HarnessPlatform;
  readonly probeRevision: string;
}

function qualificationCacheKey(options: TCacheKey): string | undefined {
  if (options.identity === undefined) return undefined;
  return [
    options.target.source,
    options.target.identityPath,
    options.identity,
    options.version,
    options.platform,
    options.probeRevision,
  ].join("\0");
}

function recoveryFailureReason(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Codex could not acknowledge the requested thread during recovery: ${detail}`;
}

function recoveryFailureDiagnostics(failure: HarnessFailure): string {
  return failure.diagnostics ?? "Codex thread recovery failed.";
}

interface TBuildProfile {
  readonly target: TDiscoveredTarget;
  readonly version: string;
  readonly platform: HarnessPlatform;
  readonly probeRevision: string;
  /** The non-hidden models `model/list` observed during qualification. */
  readonly models: readonly ModelEntry[];
}

function buildProfile(options: TBuildProfile): HarnessProfile {
  const executableKind = options.target.shim ? "npm shim" : "native";
  return {
    harness: HARNESS_NAME,
    executable: `${options.target.source} -> ${options.target.identityPath} (${executableKind})`,
    executableVersion: options.version,
    platform: options.platform,
    adapterRevision: options.probeRevision,
    configurationPosture:
      "user-compatible: inherits the user's Codex home and environment; experimental API is disabled, a caller-requested model is applied natively per Turn and none is set otherwise, while reasoning effort, personality, approval policy, and sandbox policy remain unset by Secant.",
    recovery: {
      mode: "native-reattach",
      evidence:
        "Codex thread/resume must acknowledge the exact requested private thread before durable admission and content submission.",
    },
    interruption: {
      mode: "active-turn",
      evidence:
        "Codex confirms active-Turn interruption through the matching terminal Turn event.",
    },
    approvals: {
      available: true,
      evidence:
        "Qualified command and file approvals expose exact actions; allow accepts once and deny declines once.",
    },
    clarifications: {
      available: false,
      evidence:
        "Native request-user-input is experimental and remains disabled; Secant does not emulate it.",
    },
    steer: {
      available: true,
      evidence:
        "Codex accepts native same-Turn guidance addressed to the exact active thread and Turn.",
    },
    modelSelection: {
      at: "launch-and-per-turn",
      declaration: { kind: "list", models: options.models },
      evidence:
        "The stable protocol accepts native model selection at thread and Turn start; model/list enumerates the supported models, each with its reasoning efforts and default effort, observed during qualification.",
    },
    modelObservation: {
      available: true,
      evidence:
        "thread/start and thread/resume report the effective model, distinct from any requested model.",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence:
        "thread/start returns the private thread id before durable Turn admission and content submission.",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence: "A skill Bundle Asset reaches Codex by its SKILL.md path.",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "A file artifact reaches Codex as a plain absolute path.",
    },
  };
}

function fileIdentity(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function failureWithCause(
  category: string,
  diagnostics: string,
  cause: unknown,
): HarnessFailure {
  return {
    phase: "prepare",
    category,
    possibleEffects: "none",
    diagnostics,
    cause,
  };
}

function failureWithNativeCode(
  category: string,
  diagnostics: string,
  nativeCode: string,
): HarnessFailure {
  return {
    phase: "prepare",
    category,
    possibleEffects: "none",
    diagnostics,
    nativeCode,
  };
}

function failed(category: string, diagnostics: string): PrepareResult {
  return { ok: false, failure: failure(category, diagnostics) };
}

function failedProbe(
  category: string,
  diagnostics: string,
): TProbeResult<never> {
  return { ok: false, failure: failure(category, diagnostics) };
}

interface TFailedQualification {
  readonly generation: CodexGeneration;
  readonly failure: HarnessFailure;
  readonly cleanupTimeoutMs: number;
  readonly includeStderr: boolean;
  readonly observer?: CodexRecordingObserver;
}

async function failedQualification(
  options: TFailedQualification,
): Promise<Extract<TLiveQualification, { ok: false }>> {
  const closed = await options.generation.process.closeStdin(
    options.cleanupTimeoutMs,
  );
  options.observer?.closed(
    closed.kind,
    closed.kind === "exited" ? closed.status : undefined,
  );
  const diagnosticResult = await options.generation.diagnostics.settle(
    options.cleanupTimeoutMs,
  );
  const stderr = options.includeStderr ? diagnosticResult.text : "";
  let diagnostics = options.failure.diagnostics ?? options.failure.category;
  diagnostics = appendStderr(diagnostics, stderr);
  const causes: unknown[] = [];
  if (options.failure.cause !== undefined) causes.push(options.failure.cause);
  if (diagnosticResult.cause !== undefined) {
    causes.push(diagnosticResult.cause);
  }
  if (closed.kind === "exited" && closed.status === 0) {
    return {
      ok: false,
      failure: failureWithOptionalCause(
        options.failure.category,
        diagnostics,
        combinedCause(causes, "Codex qualification failed"),
      ),
    };
  }

  diagnostics += ` Cleanup ended '${closed.kind}'.`;
  const cleanupCause =
    closed.kind === "cleanup-error" || closed.kind === "spawn-error"
      ? closed.cause
      : new Error(`Codex cleanup ended '${closed.kind}'`);
  causes.push(cleanupCause);
  return {
    ok: false,
    failure: failureWithCause(
      options.failure.category,
      diagnostics,
      new AggregateError(causes, "Codex qualification and cleanup failed"),
    ),
    ...(closed.kind === "cleanup-error" || closed.kind === "cleanup-timeout"
      ? { unreaped: options.generation }
      : {}),
  };
}

function combinedCause(causes: readonly unknown[], message: string): unknown {
  if (causes.length === 0) return undefined;
  if (causes.length === 1) return causes[0];
  return new AggregateError(causes, message);
}

function appendStderr(diagnostics: string, stderr: string): string {
  if (stderr.length === 0) return diagnostics;
  return `${diagnostics} Codex stderr: ${stderr}`;
}

function failureWithOptionalCause(
  category: string,
  diagnostics: string,
  cause: unknown,
): HarnessFailure {
  if (cause === undefined) return failure(category, diagnostics);
  return failureWithCause(category, diagnostics, cause);
}
