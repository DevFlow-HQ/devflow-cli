import fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import chokidar from "chokidar";

import {
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionInput,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";
import type {
  SessionLogCandidateDebug,
  SessionLogLocation,
  SessionLogLocator,
  SessionLogSnapshot,
  SessionLogWatchEvent,
  SessionLogWatcher,
} from "./codexSessionLogLocator.js";

export interface ClaudeSessionLogLocatorOptions {
  claudeHome: string;
  watchProjectsTree?: ClaudeSessionLogWatchProjectsTree;
}

export interface LocateClaudeSessionLogForProviderOptions {
  provider: ProviderIdentity;
  locator: SessionLogLocator;
  snapshot: SessionLogSnapshot;
  timeoutMs?: number;
}

export type ClaudeSessionLogWatchProjectsTree = (
  projectsRoot: string,
) => SessionLogWatcher;

const CLAUDE_TRANSCRIPT_PATTERN = "projects/**/*.jsonl";
const DEFAULT_LOCATOR_TIMEOUT_MS = 30_000;

export class ClaudeSessionLogLocatorTimeoutError extends Error {
  readonly scopedProviderHome: string;
  readonly searchedPattern: string;
  readonly timeoutMs: number;

  constructor(options: {
    scopedProviderHome: string;
    searchedPattern: string;
    timeoutMs: number;
  }) {
    super(
      `Claude transcript log was not found under scoped provider home "${options.scopedProviderHome}" before ${options.timeoutMs}ms elapsed. Searched pattern: ${options.searchedPattern}.`,
    );
    this.name = "ClaudeSessionLogLocatorTimeoutError";
    this.scopedProviderHome = options.scopedProviderHome;
    this.searchedPattern = options.searchedPattern;
    this.timeoutMs = options.timeoutMs;
  }
}

export function getScopedClaudeProviderHome(
  input: ManagedProviderSessionInput,
): string {
  const runId = input.phase?.id.split(":")[0] ?? "unscoped-claude-session";

  return join(input.workingDirectory, ".devflow", "runs", runId, ".claude");
}

export function createClaudeSessionLogLocator(
  options: ClaudeSessionLogLocatorOptions,
): SessionLogLocator {
  const scopedProviderHome = resolve(options.claudeHome);
  const projectsRoot = join(scopedProviderHome, "projects");
  const watchProjectsTree =
    options.watchProjectsTree ?? watchClaudeProjectsTree;

  return {
    async snapshot() {
      const files = await findTranscriptFiles({
        scopedProviderHome,
        projectsRoot,
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
      const watcher = watchProjectsTree(projectsRoot);
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
            projectsRoot,
            snapshot,
            emptyCandidatesSeen,
          });

          if (selected) {
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

      throw new ClaudeSessionLogLocatorTimeoutError({
        scopedProviderHome,
        searchedPattern: CLAUDE_TRANSCRIPT_PATTERN,
        timeoutMs,
      });
    },

    async locateResumeLog() {
      throw new Error("Claude JSONL resume lookup is not implemented yet.");
    },
  };
}

export async function locateClaudeSessionLogForProvider(
  options: LocateClaudeSessionLogForProviderOptions,
): Promise<SessionLogLocation> {
  try {
    return await options.locator.locateActiveLog(options.snapshot, {
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw new ProviderSessionEventCaptureError(options.provider, error);
  }
}

async function findSelectableCandidate(options: {
  scopedProviderHome: string;
  projectsRoot: string;
  snapshot: SessionLogSnapshot;
  emptyCandidatesSeen: Set<string>;
}): Promise<SessionLogLocation | undefined> {
  const files = await findTranscriptFiles({
    scopedProviderHome: options.scopedProviderHome,
    projectsRoot: options.projectsRoot,
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
      searchedPattern: CLAUDE_TRANSCRIPT_PATTERN,
      candidates,
      ignoredPreexistingCount: options.snapshot.filePaths.size,
      emptyCandidateCount: options.emptyCandidatesSeen.size,
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

async function findTranscriptFiles(options: {
  scopedProviderHome: string;
  projectsRoot: string;
}): Promise<SessionLogCandidateDebug[]> {
  const files: SessionLogCandidateDebug[] = [];

  await walkDirectory(options.projectsRoot, async (filePath) => {
    if (!filePath.endsWith(".jsonl")) {
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

function watchClaudeProjectsTree(projectsRoot: string): SessionLogWatcher {
  return chokidar.watch(projectsRoot, {
    ignoreInitial: true,
    awaitWriteFinish: false,
  });
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
