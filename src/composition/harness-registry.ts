import { mergeHarnessInputRules } from "../application/application.js";
import type { HarnessInputRule } from "../workflow/workflow.js";
import type {
  ApplicationHarnessQualification,
  ApplicationHarnessRegistration,
  RunHarnessPreparationFailure,
  THarnessDiscovery,
} from "../application/application.js";
import type { HarnessChoice } from "../application/projection-port.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  CLAUDE_CODE_SERVED_CAPABILITIES,
  CLAUDE_CODE_INPUT_RULES,
  CODEX_INPUT_RULES,
  CODEX_EXECUTABLE_ENV,
  CODEX_SERVED_CAPABILITIES,
  createClaudeCodeAdapter,
  createCodexAdapter,
  discoverClaudeCode,
  discoverCodex,
  type HarnessDiscovery,
  type HarnessAdapter,
  type HarnessDefaults,
  type HarnessFailure,
  type PrepareResult,
  type CleanupReport,
} from "../harness/harness.js";
import type { SelectedHarnessId } from "../run/store/store.js";
import {
  prepareRecorded,
  recordPreparationCleanup,
  recordQualificationCleanupUnresolved,
  type ReportingScope,
  type ScopedPrepareOptions,
} from "./harness-log.js";

/** Test Adapters in place of the native ones. A double reads the Process and
 *  phase observer from each prepare's options, as the native Adapters do. */
export interface HarnessRegistryOverrides {
  readonly claudeCodeAdapter?: HarnessAdapter;
  readonly codexAdapter?: HarnessAdapter;
  readonly discoverClaudeCode?: () => HarnessDiscovery;
  readonly discoverCodex?: () => HarnessDiscovery;
  readonly qualificationClock?: {
    readonly now: () => number;
    readonly schedule: (callback: () => void, delayMs: number) => () => void;
  };
}

const inputRules = {
  "claude-code": CLAUDE_CODE_INPUT_RULES,
  codex: CODEX_INPUT_RULES,
} satisfies Record<SelectedHarnessId, readonly HarnessInputRule[]>;

/** Build tooling uses the same registered portfolio as runtime ingestion. */
export function supportedBundleInputRules(): readonly HarnessInputRule[] {
  return mergeHarnessInputRules(Object.values(inputRules));
}

interface HeldQualification {
  readonly result: Promise<ApplicationHarnessQualification>;
  expire(): void;
}

interface THarnessRegistryEntry {
  readonly application: ApplicationHarnessRegistration;
  readonly adapter: HarnessAdapter;
}

/** One closed registry table owns both production Harnesses. Application receives
 * only each entry's normalized half; a Run prepares the private Adapter by the
 * durable semantic id, through its own scope. Discovery and qualification use the
 * invocation's scope, so qualification records belong to no Run. */
export class HarnessRegistry {
  private readonly entries: ReadonlyMap<
    SelectedHarnessId,
    THarnessRegistryEntry
  >;

  constructor(
    qualificationWorkspace: string,
    private readonly invocation: ReportingScope,
    private readonly overrides: HarnessRegistryOverrides,
  ) {
    const { process } = invocation;
    const claudeCodeAdapter =
      overrides.claudeCodeAdapter ?? createClaudeCodeAdapter({});
    const claudeCode: THarnessRegistryEntry = {
      application: {
        choice: {
          id: "claude-code",
          name: "Claude Code",
          availability: "available",
        },
        servedCapabilities: Object.keys(CLAUDE_CODE_SERVED_CAPABILITIES),
        inputRules: inputRules["claude-code"],
        discover: () => {
          const discovery =
            overrides.discoverClaudeCode === undefined
              ? discoverClaudeCode(process)
              : overrides.discoverClaudeCode();
          return normalizeDiscovery(discovery, CLAUDE_CODE_EXECUTABLE_ENV);
        },
        qualify: () =>
          this.qualify(
            claudeCodeAdapter,
            "claude-code",
            qualificationWorkspace,
            invocation,
          ),
      },
      adapter: claudeCodeAdapter,
    };
    const codexAdapter = overrides.codexAdapter ?? createCodexAdapter({});
    const codex: THarnessRegistryEntry = {
      application: {
        choice: { id: "codex", name: "Codex", availability: "available" },
        servedCapabilities: Object.keys(CODEX_SERVED_CAPABILITIES),
        inputRules: inputRules.codex,
        discover: () => {
          const discovery =
            overrides.discoverCodex === undefined
              ? discoverCodex(process)
              : overrides.discoverCodex();
          return normalizeDiscovery(discovery, CODEX_EXECUTABLE_ENV);
        },
        qualify: () =>
          this.qualify(
            codexAdapter,
            "codex",
            qualificationWorkspace,
            invocation,
          ),
      },
      adapter: codexAdapter,
    };
    this.entries = new Map([
      ["claude-code", claudeCode],
      ["codex", codex],
    ]);
  }

  private closing: Promise<void> | undefined;
  private qualificationDeadline: number | undefined;
  private readonly qualificationStop = new AbortController();
  private readonly qualifications = new Set<HeldQualification>();

  private qualify(
    adapter: HarnessAdapter,
    harness: SelectedHarnessId,
    workspace: string,
    invocation: ReportingScope,
  ): Promise<ApplicationHarnessQualification> {
    let reporting = true;
    let handedOff = false;
    let cleanupRecorded = false;
    const expire = () => {
      if (reporting && handedOff && !cleanupRecorded)
        recordQualificationCleanupUnresolved(harness, invocation.log);
      reporting = false;
    };
    const scope: ReportingScope = {
      ...invocation,
      ...(invocation.log === undefined
        ? {}
        : {
            log: {
              record: (record) => {
                if (!reporting) return;
                if (
                  this.qualificationDeadline !== undefined &&
                  this.monotonicNow() >= this.qualificationDeadline
                ) {
                  expire();
                  return;
                }
                if (record.event === "harness-cleanup") cleanupRecorded = true;
                invocation.log?.record(record);
              },
            },
          }),
    };
    const result = qualifyAdapter(
      adapter,
      harness,
      workspace,
      scope,
      this.qualificationStop.signal,
      () => {
        handedOff = true;
      },
    );
    const qualification: HeldQualification = {
      result,
      expire,
    };
    this.qualifications.add(qualification);
    const release = () => {
      reporting = false;
      this.qualifications.delete(qualification);
    };
    void result.then(release, release);
    return result;
  }

  private async drainQualifications(
    monotonicDeadlineMs: number,
  ): Promise<void> {
    let cancelTimer: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.allSettled(
          Array.from(
            this.qualifications,
            (qualification) => qualification.result,
          ),
        ),
        new Promise<void>((resolve) => {
          const expire = () => {
            // Publish the immutable deadline observation before the drain ends.
            for (const qualification of this.qualifications)
              qualification.expire();
            resolve();
          };
          const delayMs = Math.max(
            0,
            monotonicDeadlineMs - this.monotonicNow(),
          );
          if (this.overrides.qualificationClock !== undefined)
            cancelTimer = this.overrides.qualificationClock.schedule(
              expire,
              delayMs,
            );
          else {
            const timer = setTimeout(expire, delayMs);
            cancelTimer = () => clearTimeout(timer);
          }
        }),
      ]);
    } finally {
      cancelTimer?.();
    }
  }

  private monotonicNow(): number {
    return this.overrides.qualificationClock?.now() ?? performance.now();
  }

  /** All calls close admission synchronously before composition starts Run drain. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const result = Promise.withResolvers<void>();
    this.closing = result.promise;
    const monotonicDeadlineMs = this.monotonicNow() + 5000;
    this.qualificationDeadline = monotonicDeadlineMs;
    const reports = Array.from(this.entries, ([harness, entry]) =>
      entry.adapter.close({ monotonicDeadlineMs }).then((report) => {
        recordPreparationCleanup(report, harness, this.invocation.log);
      }),
    );
    this.qualificationStop.abort();
    void Promise.allSettled([
      ...reports,
      this.drainQualifications(monotonicDeadlineMs),
    ]).then((outcomes) => {
      const errors = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (errors.length > 0) result.reject(errors[0]);
      else result.resolve();
    });
    return this.closing;
  }

  applicationRegistrations(): readonly ApplicationHarnessRegistration[] {
    return Array.from(this.entries.values()).map((entry) => entry.application);
  }

  inputRules(selectedHarness: SelectedHarnessId): readonly HarnessInputRule[] {
    return this.entry(selectedHarness).application.inputRules;
  }

  choice(selectedHarness: SelectedHarnessId): HarnessChoice {
    return this.entry(selectedHarness).application.choice;
  }

  /** Prepares the selected Harness through `scope`, recording its phases,
   *  usage, and cleanup there. */
  prepare(
    selectedHarness: SelectedHarnessId,
    options: ScopedPrepareOptions,
    scope: ReportingScope,
  ): Promise<PrepareResult> {
    return prepareRecorded(
      this.entry(selectedHarness).adapter,
      selectedHarness,
      options,
      scope,
    );
  }

  preparationFailure(
    selectedHarness: SelectedHarnessId,
    failure: HarnessFailure,
  ): RunHarnessPreparationFailure {
    return {
      selectedHarness,
      harnessName: this.choice(selectedHarness).name,
      phase: failure.phase,
      category: failure.category,
      possibleEffects: failure.possibleEffects,
      partialOutput: failure.partialOutput,
      nativeCode: failure.nativeCode,
      retryEvidence: failure.retryEvidence,
      diagnostics: failure.diagnostics,
      cause: failure.cause,
    };
  }

  private entry(selectedHarness: SelectedHarnessId): THarnessRegistryEntry {
    const entry = this.entries.get(selectedHarness);
    if (entry === undefined) {
      throw new Error(
        `composition: selected Harness '${selectedHarness}' is not registered.`,
      );
    }
    return entry;
  }
}

async function qualifyAdapter(
  adapter: HarnessAdapter,
  harness: SelectedHarnessId,
  workspace: string,
  invocation: ReportingScope,
  signal: AbortSignal,
  handedOff: () => void,
): Promise<ApplicationHarnessQualification> {
  let prepared: PrepareResult;
  try {
    prepared = await prepareRecorded(
      adapter,
      harness,
      { workspace },
      invocation,
    );
  } catch (error) {
    return qualificationException("prepare", error);
  }
  if (!prepared.ok) {
    return { ok: false, failure: qualificationFailure(prepared.failure) };
  }

  handedOff();
  const profile = prepared.harness.profile;
  let closing: Promise<CleanupReport> | undefined;
  const close = () =>
    (closing ??= Promise.resolve().then(() => prepared.harness.close()));
  const stopped = Promise.withResolvers<undefined>();
  const stop = () => {
    // Start cleanup without waiting for the defaults exchange to answer.
    void close().catch(() => undefined);
    stopped.resolve(undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let defaults: HarnessDefaults | undefined;
  let defaultsError: unknown;
  try {
    if (!signal.aborted) {
      try {
        defaults = await Promise.race([
          prepared.harness.readDefaults(),
          stopped.promise,
        ]);
      } catch (error) {
        defaultsError = error;
      }
    }
    try {
      const cleanup = await close();
      if (!cleanup.clean) {
        return {
          ok: false,
          failure:
            cleanup.failure === undefined
              ? {
                  phase: "cleanup",
                  category: "cleanup",
                  possibleEffects: "possible",
                  diagnostics: cleanup.detail,
                }
              : qualificationFailure(cleanup.failure),
        };
      }
    } catch (error) {
      return qualificationException("cleanup", error);
    }
    if (signal.aborted) {
      return {
        ok: false,
        failure: {
          phase: "prepare",
          category: "preparation-cancelled",
          possibleEffects: "none",
        },
      };
    }
    if (defaults === undefined)
      return qualificationException("prepare", defaultsError);
    return { ok: true, profile, defaults };
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

function qualificationFailure(
  failure: HarnessFailure,
): Extract<ApplicationHarnessQualification, { ok: false }>["failure"] {
  return {
    phase: failure.phase,
    category: failure.category,
    possibleEffects: failure.possibleEffects,
    nativeCode: failure.nativeCode,
    retryEvidence: failure.retryEvidence,
    diagnostics: failure.diagnostics,
    cause: failure.cause,
  };
}

function qualificationException(
  phase: "prepare" | "cleanup",
  error: unknown,
): ApplicationHarnessQualification {
  return {
    ok: false,
    failure: {
      phase,
      category: `${phase}-exception`,
      possibleEffects: phase === "prepare" ? "none" : "possible",
      diagnostics:
        error instanceof Error
          ? error.message
          : `Harness ${phase} failed unexpectedly.`,
      cause: error,
    },
  };
}

function normalizeDiscovery(
  discovery: HarnessDiscovery,
  executableEnvironmentVariable: string,
): THarnessDiscovery {
  if (discovery.kind === "found") {
    return {
      kind: "found",
      source: discovery.attempt.source,
      description: discovery.attempt.description,
    };
  }
  if (discovery.kind === "unsupported-shim") {
    return {
      kind: "unsupported-shim",
      name: discovery.attempt.name,
      path: discovery.path,
      executableEnvironmentVariable,
    };
  }
  return {
    kind: "not-found",
    searched: searchedDescriptions(
      discovery.attempts,
      executableEnvironmentVariable,
    ),
    executableEnvironmentVariable,
  };
}

function searchedDescriptions(
  attempts: readonly {
    readonly source: "configured" | "path";
    readonly name: string;
    readonly description: string;
  }[],
  executableEnvironmentVariable: string,
): readonly string[] {
  return attempts.map((attempt) => {
    const source =
      attempt.source === "configured"
        ? `configured command (${executableEnvironmentVariable})`
        : attempt.description;
    return `${source}: "${attempt.name}"`;
  });
}
