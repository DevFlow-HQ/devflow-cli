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
  type HarnessFailure,
  type PrepareResult,
} from "../harness/harness.js";
import type { SelectedHarnessId } from "../run/store/store.js";
import {
  prepareRecorded,
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
    invocation: ReportingScope,
    overrides: HarnessRegistryOverrides,
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
        inputRules: CLAUDE_CODE_INPUT_RULES,
        discover: () => {
          const discovery =
            overrides.discoverClaudeCode === undefined
              ? discoverClaudeCode(process)
              : overrides.discoverClaudeCode();
          return normalizeDiscovery(discovery, CLAUDE_CODE_EXECUTABLE_ENV);
        },
        qualify: () =>
          qualifyAdapter(
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
        inputRules: CODEX_INPUT_RULES,
        discover: () => {
          const discovery =
            overrides.discoverCodex === undefined
              ? discoverCodex(process)
              : overrides.discoverCodex();
          return normalizeDiscovery(discovery, CODEX_EXECUTABLE_ENV);
        },
        qualify: () =>
          qualifyAdapter(
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

  applicationRegistrations(): readonly ApplicationHarnessRegistration[] {
    return Array.from(this.entries.values()).map((entry) => entry.application);
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

  const profile = prepared.harness.profile;
  try {
    const cleanup = await prepared.harness.close();
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
  return { ok: true, profile };
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
