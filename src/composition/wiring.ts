import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  canonicalizeWorkspacePath,
  createApplication,
  type Application,
  type PrepareRunInteractiveStep,
  type RunExecution,
  type RunInteractiveStep,
} from "../application/application.js";
import type { Problem } from "../application/projection-port.js";
import { openCatalog, type Catalog } from "../catalog/catalog.js";
import {
  DEFAULT_BUDGETS,
  inspectBundle,
  readBundleAssets,
} from "../bundle/bundle.js";
import {
  driveInteractiveTurn,
  executeRouting,
  interactiveTurnRest,
  type AssetResolver,
  type ExecutionObserver,
  type HarnessExecutionDeps,
} from "../run/execution/execution.js";
import {
  openRunGroup,
  type RunGroup,
  type RunOwner,
} from "../run/store/store.js";
import {
  type HarnessAdapter,
  type HarnessDiscovery,
  type PreparedHarness,
  type PrepareResult,
} from "../harness/harness.js";
import type { SelectedHarnessId } from "../run/store/store.js";
import {
  type ArtifactType,
  type AssetKind,
  type Platform,
  routingNeedsHarness,
} from "../workflow/workflow.js";
import { HarnessRegistry } from "./harness-registry.js";
import type { ReportingScope } from "./harness-log.js";
import type { OperationalLog } from "./operational-log.js";
import { applicationObserver } from "./application-log.js";
import { runLifecycleObserver } from "./run-lifecycle-log.js";
import {
  createProcessAdapter,
  type ProcessAdapter,
  type ProcessAdapterOptions,
} from "../process/process.js";
import { processObserver } from "./process-observer.js";

// The one wiring path both composition roots take (#74 A1, A2, A6). Before this,
// the headless root and the TUI root each resolved the Secant home, opened the
// Catalog, and constructed the Application — and drifted: the TUI root omitted
// `engineVersion` and `hostPlatform`, so the shell ran as `0.0.0-dev` on
// `platforms[0]`. Here the wiring lives once; the raw launch path is handed to
// the Application, which owns canonicalisation (A6). The caller owns the
// Catalog's lifetime and closes it on every exit path.

// The running engine version, substituted by the Bun compile (scripts/build.ts).
// A free identifier under `bun src/cli/main.ts` (dev) and the Node test runner,
// where the dev sentinel stands in — matching cli/main.ts.
declare const __SECANT_VERSION__: string;
const engineVersion =
  typeof __SECANT_VERSION__ === "string" ? __SECANT_VERSION__ : "0.0.0-dev";

function hostPlatform(platform: NodeJS.Platform): Platform | undefined {
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

/** The operational log's clock: wall-clock time for each record, and a monotonic
 *  reading for elapsed time, so a wall-clock change cannot distort a duration. */
export interface LogClock {
  readonly now: () => Date;
  readonly monotonic: () => number;
}

const PRODUCTION_CLOCK: LogClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
};

/** The operational log's test Seam. An injected sink uses its folder or the
 *  injected Secant home's logs, and its own detail switch (off by default),
 *  independently of the process log environment. Production passes none: the
 *  folder and detail come from the environment or the Secant home, the clock
 *  from the process, and a log-failure notice goes to stderr. */
interface LogSinkOverrides {
  readonly folder?: string;
  readonly clock?: LogClock;
  readonly stderr?: (text: string) => void;
  readonly detail?: boolean;
}

/** Overrides for the composition wiring test, which drives the one path both
 *  roots take against a temporary home without a terminal (#74 A18). Production
 *  passes none: the home, cwd, engine version, and host platform come from the
 *  process. */
export interface WiringOverrides {
  readonly secantHome?: string;
  readonly launchCwd?: string;
  readonly engineVersion?: string;
  readonly hostPlatform?: Platform;
  /** Process test Seam: one instance shared by the invocation and every Run
   *  scope, so its children carry no `runId`. Production constructs here. */
  readonly process?: ProcessAdapter;
  /** Constructor test Seam: proves the default construction branch runs once
   * for the invocation, and once per Run-scoped call when logging, while keeping child
   * creation out of the semantic test runner. It receives the options the real
   * Adapter would, so a double can report child facts to the operational log. */
  readonly processFactory?: (options: ProcessAdapterOptions) => ProcessAdapter;
  /** The Claude Code Adapter registry entry (#116). Production constructs the
   * native Adapter; tests inject one, which reads its Process and phase observer
   * from each prepare's options. */
  readonly harnessAdapter?: HarnessAdapter;
  /** A Codex Adapter test seam. Production constructs the native Adapter. */
  readonly codexHarnessAdapter?: HarnessAdapter;
  /** Whether the launching client can relay human turn-taking (#116, #122). The TUI
   *  root sets this true; the headless root leaves it false so an interactive-agent
   *  Bundle is refused at Preflight. Defaults to false. */
  readonly supportsInteractiveTurns?: boolean;
  /** Deterministic Harness discovery for tests. Production leaves this absent and
   *  Preflight uses the Harness-owned environment/PATH discovery. */
  readonly discoverClaudeCode?: () => HarnessDiscovery;
  /** Deterministic Codex discovery for tests. */
  readonly discoverCodex?: () => HarnessDiscovery;
  /** Where the Shipped Bundle `.wfb` files are read from. Production reads the
   *  `builtin/` asset directory `scripts/build.ts` embeds beside the entry module. */
  readonly shippedBundleDir?: string;
  /** The operational log's test Seam: target folder, clock, and fallback
   *  channel. Semantic tests use it and never set the log environment names. */
  readonly logSink?: LogSinkOverrides;
}

// The environment names composition reads, side by side and nowhere else: no
// Module below composition reads any of them. `SECANT_LOG_DETAIL` is the detail
// switch (#325).
const SECANT_HOME_ENV = "SECANT_HOME";
export const SECANT_LOG_DIR_ENV = "SECANT_LOG_DIR";
const SECANT_LOG_DETAIL_ENV = "SECANT_LOG_DETAIL";

/** What one Secant invocation reads from its process before anything is wired:
 *  the Secant home, the operational-log folder, detail switch, and clock, the
 *  running engine version, and the host platform (absent on an unsupported OS). */
interface HostContext {
  readonly secantHome: string;
  readonly logFolder: string;
  /** Whether the sink writes detail records (#325). Only the sink's start
   *  options read it; no observer learns it. */
  readonly logDetail: boolean;
  /** Shared by the sink and every observer it feeds, so their elapsed times
   *  read one monotonic clock. */
  readonly logClock: LogClock;
  readonly engineVersion: string;
  readonly hostPlatform: Platform | undefined;
}

/** Resolves the host context, overrides first. The log folder follows the
 *  Secant home (`logs` beneath it) unless `SECANT_LOG_DIR` names another.
 *  Detail is on only when `SECANT_LOG_DETAIL`, trimmed, is exactly `1`. */
export function resolveHostContext(overrides: WiringOverrides): HostContext {
  const secantHome =
    overrides.secantHome ??
    (process.env[SECANT_HOME_ENV]?.trim() || join(homedir(), ".secant"));
  return {
    secantHome,
    logFolder:
      overrides.logSink === undefined
        ? process.env[SECANT_LOG_DIR_ENV]?.trim() || join(secantHome, "logs")
        : (overrides.logSink.folder ?? join(secantHome, "logs")),
    logDetail:
      overrides.logSink === undefined
        ? process.env[SECANT_LOG_DETAIL_ENV]?.trim() === "1"
        : (overrides.logSink.detail ?? false),
    logClock: overrides.logSink?.clock ?? PRODUCTION_CLOCK,
    engineVersion: overrides.engineVersion ?? engineVersion,
    hostPlatform: overrides.hostPlatform ?? hostPlatform(process.platform),
  };
}

export interface Wiring extends Application {
  readonly catalog: Catalog;
  readonly runGroup: RunGroup;
  /** The startup ensure's notices, one per Shipped Bundle it could not install. */
  readonly startupNotices: readonly Problem[];
}

// The Shipped Bundles embedded in the compiled binary (ADR 0029 amended by ADR
// 0030): `scripts/build.ts` embeds `dist/builtin` as the `builtin/` asset directory
// beside the entry module, read through `node:fs` with no Bun API. Under
// `bun src/cli/main.ts` and in tests the directory does not exist, so there are
// zero Shipped Bundles and nothing is reported.
function shippedBundleFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".wfb"))
    .sort()
    .map((name) => join(dir, name));
}

/** Resolves the Secant home, opens the Catalog and the launch Workspace's Run
 *  Store, constructs the Run execution, and builds the Application with the
 *  running engine version and host platform, handing it the raw launch cwd. The
 *  caller owns `catalog` and `runGroup` and must close both. `log` is the Secant
 *  invocation's operational log, which both client entries pass; a direct caller
 *  passes none, and neither the Application's facts, the Run lifecycle, any
 *  Harness record, nor any child fact is then reported. */
export function wireApplication(
  overrides: WiringOverrides = {},
  log?: Pick<OperationalLog, "record">,
): Wiring {
  const {
    secantHome,
    engineVersion,
    hostPlatform: host,
    logClock,
  } = resolveHostContext(overrides);
  const observe =
    log === undefined ? undefined : runLifecycleObserver(log, logClock);
  const launchWorkspacePath = overrides.launchCwd ?? process.cwd();
  const canonicalLaunchWorkspacePath =
    canonicalizeWorkspacePath(launchWorkspacePath);
  const constructProcess = (options: ProcessAdapterOptions): ProcessAdapter =>
    overrides.processFactory?.(options) ?? createProcessAdapter(options);
  const processAdapter =
    overrides.process ??
    constructProcess(log === undefined ? {} : processObserver(log));
  // The invocation's scope serves Preflight, discovery, and qualification, whose
  // records belong to no Run.
  const invocation: ReportingScope = {
    process: processAdapter,
    ...(log === undefined ? {} : { log }),
  };
  // One Run scope per Run (#333, ADR 0031): composition binds every lower-Module
  // observer a Run's work reports through to that Run's id, so overlapping Runs'
  // records stay apart while Harness, Process, and Run Store learn no Run. The
  // Process Adapter holds no state but its observer, so each call builds an
  // equivalent scope with its own Process rather than caching one per Run; an
  // injected Process instance cannot be rebound and is shared.
  const runScope: ScopeForRun = (runId) => {
    if (log === undefined) return invocation;
    const runLog = runRecorder(log, runId);
    return {
      process: overrides.process ?? constructProcess(processObserver(runLog)),
      log: runLog,
    };
  };

  // The Catalog derives each installed digest's read-only asset tree through the
  // Bundle Module's reader, injected here so Catalog keeps depending only on the
  // Workflow vocabulary (#100, A8).
  const catalog = openCatalog(secantHome, {
    readAssets: (bytes) => readBundleAssets(bytes, DEFAULT_BUDGETS),
  });
  // Sweep the per-Run extraction directory earlier releases wrote under the home;
  // Runs copy nothing now.
  rmSync(join(secantHome, "run-assets"), { recursive: true, force: true });
  try {
    // The Run Store groups Runs by the resolved absolute Workspace path; open it
    // against the same canonicalisation the Application applies (A6, A20), through
    // the one exported canonicaliser rather than a second `realpathSync.native`
    // site, so a fresh `run show` process reaches the same group directory as the
    // launch.
    // The Run owner's Artifact Git spawns through the Run's own scope.
    const runGroup = openRunGroup(secantHome, canonicalLaunchWorkspacePath, {
      process: processAdapter,
      processForRun: (runId) => runScope(runId).process,
    });
    try {
      const harnessRegistry = new HarnessRegistry(
        canonicalLaunchWorkspacePath,
        invocation,
        {
          claudeCodeAdapter: overrides.harnessAdapter,
          codexAdapter: overrides.codexHarnessAdapter,
          discoverClaudeCode: overrides.discoverClaudeCode,
          discoverCodex: overrides.discoverCodex,
        },
      );
      const application = createApplication({
        catalog,
        launchWorkspacePath,
        engineVersion,
        ...(host !== undefined ? { hostPlatform: host } : {}),
        runGroup,
        // The headless client cannot relay human turn-taking; an interactive-agent
        // Bundle is refused at Preflight (#116). The TUI root sets this true.
        supportsInteractiveTurns: overrides.supportsInteractiveTurns ?? false,
        harnessRegistry: harnessRegistry.applicationRegistrations(),
        process: processAdapter,
        runExecution: makeRunExecution({
          catalog,
          platform: host ?? "linux",
          harnessRegistry,
          runScope,
          ...(observe !== undefined ? { observe } : {}),
        }),
        prepareRunInteractiveStep: makePrepareRunInteractiveStep(
          harnessRegistry,
          runScope,
          observe,
        ),
        // Pre-Run Application facts (#319) beside the Attempt outcomes it settles.
        ...(log !== undefined && observe !== undefined
          ? { observe: applicationObserver(log, logClock, observe) }
          : {}),
      });
      // Every startup, in both roots, before either client reads (ADR 0029). A
      // failure is a notice, never a thrown startup error.
      const startupNotices = application.ensureShippedBundles(
        shippedBundleFiles(
          overrides.shippedBundleDir ?? join(import.meta.dirname, "builtin"),
        ),
      );
      return { catalog, runGroup, startupNotices, ...application };
    } catch (error) {
      runGroup.close();
      throw error;
    }
  } catch (error) {
    // Construction can throw (e.g. the launch path no longer resolves); close
    // the Catalog we opened before rethrowing, so no caller leaks it.
    catalog.close();
    throw error;
  }
}

// The Run execution seam #81 left open: an installed Bundle's `{asset}` paths
// become on-disk paths under the Catalog's digest-named asset tree — extracted
// once at install, shared by every Run of that digest, and re-derived by the
// Catalog when missing (#100, A8). A Run copies nothing. `run read` returns only
// `text`/`verdict` in M2 (execution's file-materialization gap is a documented
// `ponytail:`).
/** The scope a Run's work spawns and reports through, given the Run's id. */
type ScopeForRun = (runId: string) => ReportingScope;

interface TMakeRunExecutionParams {
  readonly catalog: Catalog;
  readonly platform: Platform;
  readonly harnessRegistry: HarnessRegistry;
  readonly runScope: ScopeForRun;
  readonly observe?: ExecutionObserver;
}

function makeRunExecution(params: TMakeRunExecutionParams): RunExecution {
  const { catalog, platform, harnessRegistry, runScope, observe } = params;
  return async ({
    routing,
    digest,
    owner,
    cancelSignal,
    requestChannel,
    observeSteer,
    observeWindowsCleanupFallback,
  }) => {
    // Command Steps and the Run's Harness share the Run's scope.
    const scope = runScope(owner.record.runId);
    const deps = {
      owner,
      platform,
      resolveAsset: treeResolver(catalog, digest),
      process: scope.process,
      ...(observe !== undefined ? { observe } : {}),
      // The Application's per-Run cancel Seam (#98): an abort kills the child's
      // process group and unwinds execution, and the Application decides the rest.
      ...(cancelSignal !== undefined ? { cancelSignal } : {}),
      // The Application's per-Run live request-answer channel (#117): an Agent
      // Turn's approval requests reach the observing client through it.
      ...(requestChannel !== undefined ? { requestChannel } : {}),
    };
    // A Command-only Run needs no Harness. A Bundle carrying an Agent Step prepares
    // one once, reused across every Agent Step of the Run, and closes it when the
    // Run rests — the ownership ADR 0022 requires to transfer exactly once to the
    // Run (#116). A typed preparation failure is returned to Application so it can
    // rest the created Run halted and project a selected-Harness Problem.
    if (!routingNeedsHarness(routing)) return executeRouting(routing, deps);
    const selectedHarness = owner.record.selectedHarness;
    if (selectedHarness === undefined) {
      throw new Error(
        "composition: an Agent-bearing Run has no selected Harness.",
      );
    }
    const facts = harnessFacts(catalog, digest);
    const prepared = await prepareRunHarness(
      harnessRegistry,
      selectedHarness,
      owner,
      scope,
      observeWindowsCleanupFallback,
    );
    if (!prepared.ok) {
      const harnessFailure = harnessRegistry.preparationFailure(
        selectedHarness,
        prepared.failure,
      );
      return { outcome: "harness-unavailable", harnessFailure };
    }
    observeSteer?.(prepared.harness.profile.steer);
    const harness: HarnessExecutionDeps = {
      prepared: prepared.harness,
      inputTypes: facts.inputTypes,
      assetKinds: facts.assetKinds,
    };
    let transferred = false;
    try {
      const report = await executeRouting(routing, { ...deps, harness });
      if (report.outcome === "blocked") {
        transferred = true;
        return {
          ...report,
          interactiveStep: interactiveStepDriver(prepared.harness, observe),
        };
      }
      return report;
    } finally {
      if (!transferred) await prepared.harness.close();
    }
  };
}

// Prepare the opaque Step-scoped interactive driver (#134 A17). A handle transferred
// from `makeRunExecution` is preferred; this path prepares one after reopening a Run
// already blocked at an interactive Step. The Application owns its lifetime without
// learning a Harness type, and the driver closes the prepared Harness exactly once.
function makePrepareRunInteractiveStep(
  harnessRegistry: HarnessRegistry,
  runScope: ScopeForRun,
  observe: ExecutionObserver | undefined,
): PrepareRunInteractiveStep {
  return async ({ owner, observeWindowsCleanupFallback }) => {
    const selectedHarness = owner.record.selectedHarness;
    if (selectedHarness === undefined) {
      throw new Error(
        "composition: an Interactive-agent Run has no selected Harness.",
      );
    }
    const prepared = await prepareRunHarness(
      harnessRegistry,
      selectedHarness,
      owner,
      runScope(owner.record.runId),
      observeWindowsCleanupFallback,
    );
    if (!prepared.ok) {
      return {
        ok: false,
        failure: harnessRegistry.preparationFailure(
          selectedHarness,
          prepared.failure,
        ),
      };
    }
    return {
      ok: true,
      interactiveStep: interactiveStepDriver(prepared.harness, observe),
    };
  };
}

// Prepare a Run's Harness identically on launch, resume, and interactive reopen:
// the Run's working area as the one additional writable directory (#214) and the
// Run's own scope (#333). The model is not a prepare option: Run execution's Turn
// driver sends it on each Turn request (ADR 0034). An unusable area is a typed
// prepare failure, so the Run halts before any Turn rather than writing planning
// files anywhere else.
async function prepareRunHarness(
  harnessRegistry: HarnessRegistry,
  selectedHarness: SelectedHarnessId,
  owner: RunOwner,
  scope: ReportingScope,
  observeWindowsCleanupFallback: (() => void) | undefined,
): Promise<PrepareResult> {
  const area = owner.workingArea();
  if (!area.ok) {
    return {
      ok: false,
      failure: {
        phase: "prepare",
        category: "working-area-unavailable",
        possibleEffects: "none",
        diagnostics: `The Run working area '${area.problem.path}' is not a usable directory.`,
        cause: area.problem.cause,
      },
    };
  }
  return harnessRegistry.prepare(
    selectedHarness,
    {
      workspace: owner.record.workspacePath,
      writableDirectory: area.path,
      containment: (fact) => {
        if (fact.kind === "fallback") observeWindowsCleanupFallback?.();
      },
    },
    scope,
  );
}

/** `log` with every record attributed to `runId`, placed after the event as the
 *  Run lifecycle records place it. */
function runRecorder(
  log: Pick<OperationalLog, "record">,
  runId: string,
): Pick<OperationalLog, "record"> {
  return {
    record: ({ event, ...fields }) => log.record({ event, runId, ...fields }),
  };
}

// Human Turns reach execution through this driver, not the execution
// dependencies, so the observer crosses here too (#320).
function interactiveStepDriver(
  prepared: PreparedHarness,
  observe: ExecutionObserver | undefined,
): RunInteractiveStep {
  let closed = false;
  return {
    steer: prepared.profile.steer,
    async turn({
      owner,
      session,
      attemptId,
      turnId,
      text,
      cancelSignal,
      requestChannel,
    }) {
      const result = await driveInteractiveTurn({
        owner,
        prepared,
        session,
        attemptId,
        turnId,
        text,
        ...(cancelSignal !== undefined ? { cancelSignal } : {}),
        ...(requestChannel !== undefined ? { requestChannel } : {}),
        ...(observe !== undefined ? { observe } : {}),
      });
      return { rest: interactiveTurnRest(result.kind, cancelSignal) };
    },
    async close() {
      if (closed) return;
      closed = true;
      await prepared.close();
    },
  };
}

/** The manifest facts Agent-prompt rendering resolves against (#116): each Launch
 *  input's declared type and each declared asset's kind, re-derived from the pinned
 *  Snapshot's stored bytes by digest. A read/inspect failure here is an environment
 *  fault (the bytes Preflight just validated are gone or corrupt) — it throws rather
 *  than return empty maps, which would silently render a `file` slot as plain text.
 *  ponytail: these facts are re-derived here rather than threaded from Preflight's
 *  composition re-check, to keep the Harness plumbing out of the Application/
 *  RunExecution seam; the cost is one extra inspect per Agent-bearing Run. Thread
 *  them through if that inspect ever shows up. */
function harnessFacts(
  catalog: Catalog,
  digest: string,
): {
  inputTypes: Record<string, ArtifactType>;
  assetKinds: Record<string, AssetKind>;
} {
  const inputTypes: Record<string, ArtifactType> = {};
  const assetKinds: Record<string, AssetKind> = {};
  const bytes = catalog.readManagedBytes(digest);
  if (bytes === undefined) {
    throw new Error(
      `composition: the pinned Bundle (digest ${digest}) has no stored bytes at execution.`,
    );
  }
  const inspected = inspectBundle(bytes, DEFAULT_BUDGETS, false);
  if (!inspected.ok) {
    throw new Error(
      `composition: the pinned Bundle (digest ${digest}) no longer inspects: ${inspected.finding.code}.`,
    );
  }
  const { manifest } = inspected.inspection;
  for (const [name, input] of Object.entries(manifest.inputs)) {
    inputTypes[name] = input.type;
  }
  for (const asset of manifest.assets) {
    assetKinds[asset.path] = asset.kind;
  }
  return { inputTypes, assetKinds };
}

/** A resolver mapping a declared asset path to its file in the digest's asset
 *  tree. A digest whose managed bytes are missing resolves nothing; so does a
 *  path that escapes the tree or names no file in it. Execution then throws on
 *  the first unresolved `{asset}`, which composition owns. */
function treeResolver(catalog: Catalog, digest: string): AssetResolver {
  const root = catalog.assetRoot(digest);
  if (root === undefined) return () => undefined;
  return (assetPath) => {
    const target = resolve(root, assetPath);
    if (!target.startsWith(root + sep)) return undefined;
    return existsSync(target) ? target : undefined;
  };
}
