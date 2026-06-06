import fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import chokidar from "chokidar";

import {
  buildSessionLogLocatorResolutionTrace,
  emitAdapterTrace,
} from "./adapterTrace.js";
import {
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionInput,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";
import { NoopLogger, type Logger } from "../logger.js";

export interface SessionLogSnapshot {
  filePaths: Set<string>;
}

export interface SessionLogLocation {
  filePath: string;
  debug: SessionLogLocationDebug;
}

export interface SessionLogResumeLocation extends SessionLogLocation {
  startOffset: number;
}

export interface SessionLogLocationDebug {
  scopedProviderHome: string;
  searchedPattern: string;
  candidates: SessionLogCandidateDebug[];
  ignoredPreexistingCount: number;
  emptyCandidateCount: number;
  multipleCandidates: boolean;
}

export interface SessionLogCandidateDebug {
  filePath: string;
  size: number;
  mtimeMs: number;
}

export interface SessionLogLocator {
  snapshot(): Promise<SessionLogSnapshot>;
  locateActiveLog(
    snapshot: SessionLogSnapshot,
    options?: SessionLogLocateOptions,
  ): Promise<SessionLogLocation>;
  locateResumeLog(
    providerSessionId: string,
    options?: SessionLogLocateOptions,
  ): Promise<SessionLogResumeLocation>;
}

export interface SessionLogLocateOptions {
  timeoutMs?: number;
}

export interface CodexSessionLogLocatorOptions {
  codexHome: string;
  watchSessionsTree?: SessionLogWatchSessionsTree;
  logger?: Logger;
}

export interface LocateCodexSessionLogForProviderOptions {
  provider: ProviderIdentity;
  locator: SessionLogLocator;
  snapshot: SessionLogSnapshot;
  timeoutMs?: number;
}

const CODEX_ROLLOUT_PATTERN = "sessions/**/rollout-*.jsonl";
const DEFAULT_LOCATOR_TIMEOUT_MS = 30_000;
const CODEX_PROVIDER: ProviderIdentity = {
  id: "codex",
  displayName: "Codex",
};

export type SessionLogWatchEvent = "add" | "change";

export interface SessionLogWatcher {
  on(
    event: SessionLogWatchEvent,
    listener: (filePath: string) => void,
  ): SessionLogWatcher;
  close(): Promise<void> | void;
}

export type SessionLogWatchSessionsTree = (
  sessionsRoot: string,
) => SessionLogWatcher;

export class CodexSessionLogLocatorTimeoutError extends Error {
  readonly scopedProviderHome: string;
  readonly searchedPattern: string;
  readonly timeoutMs: number;

  constructor(options: {
    scopedProviderHome: string;
    searchedPattern: string;
    timeoutMs: number;
  }) {
    super(
      `Codex rollout log was not found under scoped provider home "${options.scopedProviderHome}" before ${options.timeoutMs}ms elapsed. Searched pattern: ${options.searchedPattern}.`,
    );
    this.name = "CodexSessionLogLocatorTimeoutError";
    this.scopedProviderHome = options.scopedProviderHome;
    this.searchedPattern = options.searchedPattern;
    this.timeoutMs = options.timeoutMs;
  }
}

export class CodexSessionLogLocatorResumeNotFoundError extends Error {
  readonly scopedProviderHome: string;
  readonly searchedPattern: string;
  readonly providerSessionId: string;

  constructor(options: {
    scopedProviderHome: string;
    searchedPattern: string;
    providerSessionId: string;
  }) {
    super(
      `Codex rollout log for provider session "${options.providerSessionId}" was not found under scoped provider home "${options.scopedProviderHome}". Searched pattern: ${options.searchedPattern}.`,
    );
    this.name = "CodexSessionLogLocatorResumeNotFoundError";
    this.scopedProviderHome = options.scopedProviderHome;
    this.searchedPattern = options.searchedPattern;
    this.providerSessionId = options.providerSessionId;
  }
}

export function getScopedCodexProviderHome(
  input: ManagedProviderSessionInput,
): string {
  const runId = input.phase?.id.split(":")[0] ?? "unscoped-codex-session";

  return join(input.workingDirectory, ".devflow", "runs", runId, ".codex");
}

export function createCodexSessionLogLocator(
  options: CodexSessionLogLocatorOptions,
): SessionLogLocator {
  const scopedProviderHome = resolve(options.codexHome);
  const sessionsRoot = join(scopedProviderHome, "sessions");
  const watchSessionsTree =
    options.watchSessionsTree ?? watchCodexSessionsTree;
  const logger = options.logger ?? NoopLogger;

  return {
    async snapshot() {
      const files = await findRolloutFiles({
        scopedProviderHome,
        sessionsRoot,
      });

      return {
        filePaths: new Set(files.map((file) => file.filePath)),
      };
    },

    async locateActiveLog(snapshot, locateOptions = {}) {
      const timeoutMs =
        locateOptions.timeoutMs ?? DEFAULT_LOCATOR_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      const emptyCandidatesSeen = new Set<string>();
      const watcher = watchSessionsTree(sessionsRoot);
      let wakeup: (() => void) | undefined;
      const notifyWakeup = (): void => {
        wakeup?.();
      };

      watcher.on("add", notifyWakeup);
      watcher.on("change", notifyWakeup);

      try {
        do {
          const selected = await findSelectableCandidate({
            scopedProviderHome,
            sessionsRoot,
            snapshot,
            emptyCandidatesSeen,
          });

          if (selected) {
            emitSessionLogResolutionTrace({
              logger,
              location: selected,
              resumeLookup: "not-requested",
            });
            return selected;
          }

          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            break;
          }

          await waitForWatcherWakeup({
            timeoutMs: remainingMs,
            register(resolveWakeup) {
              wakeup = resolveWakeup;
            },
            unregister() {
              wakeup = undefined;
            },
          });
        } while (true);
      } finally {
        await watcher.close();
      }

      throw new CodexSessionLogLocatorTimeoutError({
        scopedProviderHome,
        searchedPattern: CODEX_ROLLOUT_PATTERN,
        timeoutMs,
      });
    },

    async locateResumeLog(providerSessionId) {
      const selected = await findResumeCandidate({
        scopedProviderHome,
        sessionsRoot,
        providerSessionId,
      });

      if (selected) {
        emitSessionLogResolutionTrace({
          logger,
          location: selected,
          resumeLookup: "found",
        });
        return selected;
      }

      emitAdapterTrace(
        logger,
        buildSessionLogLocatorResolutionTrace({
          provider: CODEX_PROVIDER,
          candidateCount: 0,
          multipleCandidates: false,
          resumeLookup: "not-found",
        }),
      );

      throw new CodexSessionLogLocatorResumeNotFoundError({
        scopedProviderHome,
        searchedPattern: CODEX_ROLLOUT_PATTERN,
        providerSessionId,
      });
    },
  };
}

function emitSessionLogResolutionTrace(options: {
  logger: Logger;
  location: SessionLogLocation | SessionLogResumeLocation;
  resumeLookup: "not-requested" | "found";
}): void {
  emitAdapterTrace(
    options.logger,
    buildSessionLogLocatorResolutionTrace({
      provider: CODEX_PROVIDER,
      resolvedPath: options.location.filePath,
      startOffset:
        "startOffset" in options.location ? options.location.startOffset : 0,
      chosenCandidate: options.location.debug.candidates[0]?.filePath,
      candidateCount: options.location.debug.candidates.length,
      multipleCandidates: options.location.debug.multipleCandidates,
      resumeLookup: options.resumeLookup,
    }),
  );
}

async function findSelectableCandidate(options: {
  scopedProviderHome: string;
  sessionsRoot: string;
  snapshot: SessionLogSnapshot;
  emptyCandidatesSeen: Set<string>;
}): Promise<SessionLogLocation | undefined> {
  const files = await findRolloutFiles({
    scopedProviderHome: options.scopedProviderHome,
    sessionsRoot: options.sessionsRoot,
  });
  const newFiles = files.filter(
    (file) => !options.snapshot.filePaths.has(file.filePath),
  );
  const nonEmptyCandidates = newFiles.filter((file) => {
    if (file.size > 0) {
      return true;
    }

    options.emptyCandidatesSeen.add(file.filePath);
    return false;
  });

  if (nonEmptyCandidates.length === 0) {
    return undefined;
  }

  const candidates = sortCandidates(nonEmptyCandidates);

  return {
    filePath: candidates[0].filePath,
    debug: {
      scopedProviderHome: options.scopedProviderHome,
      searchedPattern: CODEX_ROLLOUT_PATTERN,
      candidates,
      ignoredPreexistingCount: options.snapshot.filePaths.size,
      emptyCandidateCount: options.emptyCandidatesSeen.size,
      multipleCandidates: candidates.length > 1,
    },
  };
}

async function findResumeCandidate(options: {
  scopedProviderHome: string;
  sessionsRoot: string;
  providerSessionId: string;
}): Promise<SessionLogResumeLocation | undefined> {
  const files = await findRolloutFiles({
    scopedProviderHome: options.scopedProviderHome,
    sessionsRoot: options.sessionsRoot,
  });
  const candidates = sortCandidates(
    files.filter((file) =>
      isRolloutForProviderSession(file.filePath, options.providerSessionId),
    ),
  );

  if (candidates.length === 0) {
    return undefined;
  }

  return {
    filePath: candidates[0].filePath,
    startOffset: candidates[0].size,
    debug: {
      scopedProviderHome: options.scopedProviderHome,
      searchedPattern: CODEX_ROLLOUT_PATTERN,
      candidates,
      ignoredPreexistingCount: 0,
      emptyCandidateCount: 0,
      multipleCandidates: candidates.length > 1,
    },
  };
}

async function waitForWatcherWakeup(options: {
  timeoutMs: number;
  register(resolveWakeup: () => void): void;
  unregister(): void;
}): Promise<void> {
  await new Promise<void>((resolveWakeup) => {
    const timer = setTimeout(resolveWakeup, options.timeoutMs);
    options.register(() => {
      clearTimeout(timer);
      resolveWakeup();
    });
  });
  options.unregister();
}

export async function locateCodexSessionLogForProvider(
  options: LocateCodexSessionLogForProviderOptions,
): Promise<SessionLogLocation> {
  try {
    return await options.locator.locateActiveLog(options.snapshot, {
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw new ProviderSessionEventCaptureError(options.provider, error);
  }
}

async function findRolloutFiles(options: {
  scopedProviderHome: string;
  sessionsRoot: string;
}): Promise<SessionLogCandidateDebug[]> {
  const files: SessionLogCandidateDebug[] = [];

  await walkDirectory(options.sessionsRoot, async (filePath) => {
    if (!isRolloutJsonlPath(filePath)) {
      return;
    }

    const resolvedPath = resolve(filePath);
    if (!isPathInside(resolvedPath, options.scopedProviderHome)) {
      return;
    }

    const stats = await fs.stat(resolvedPath);

    files.push({
      filePath: resolvedPath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  });

  return files;
}

async function walkDirectory(
  directory: string,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(directory, entry.name);

        if (entry.isDirectory()) {
          await walkDirectory(entryPath, onFile);
          return;
        }

        if (entry.isFile()) {
          await onFile(entryPath);
        }
      }),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

function isRolloutJsonlPath(filePath: string): boolean {
  const fileName = filePath.split(/[\\/]/).at(-1) ?? "";

  return fileName.startsWith("rollout-") && fileName.endsWith(".jsonl");
}

function isRolloutForProviderSession(
  filePath: string,
  providerSessionId: string,
): boolean {
  const fileName = filePath.split(/[\\/]/).at(-1) ?? "";

  return fileName.endsWith(`-${providerSessionId}.jsonl`);
}

function isPathInside(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate);

  return (
    pathFromRoot.length > 0 &&
    !pathFromRoot.startsWith("..") &&
    !isAbsolute(pathFromRoot)
  );
}

function sortCandidates(
  candidates: SessionLogCandidateDebug[],
): SessionLogCandidateDebug[] {
  return [...candidates].sort((left, right) => {
    const mtimeComparison = right.mtimeMs - left.mtimeMs;

    if (mtimeComparison !== 0) {
      return mtimeComparison;
    }

    return left.filePath.localeCompare(right.filePath);
  });
}

function watchCodexSessionsTree(sessionsRoot: string): SessionLogWatcher {
  return chokidar.watch(sessionsRoot, {
    ignoreInitial: true,
    awaitWriteFinish: false,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
