import fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionInput,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";

export interface SessionLogSnapshot {
  filePaths: Set<string>;
}

export interface SessionLogLocation {
  filePath: string;
  debug: SessionLogLocationDebug;
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
}

export interface SessionLogLocateOptions {
  timeoutMs?: number;
}

export interface CodexSessionLogLocatorOptions {
  codexHome: string;
  pollIntervalMs?: number;
}

export interface LocateCodexSessionLogForProviderOptions {
  provider: ProviderIdentity;
  locator: SessionLogLocator;
  snapshot: SessionLogSnapshot;
  timeoutMs?: number;
}

const CODEX_ROLLOUT_PATTERN = "sessions/**/rollout-*.jsonl";
const DEFAULT_LOCATOR_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

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
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

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

      do {
        const files = await findRolloutFiles({
          scopedProviderHome,
          sessionsRoot,
        });
        const newFiles = files.filter(
          (file) => !snapshot.filePaths.has(file.filePath),
        );
        const nonEmptyCandidates = newFiles.filter((file) => {
          if (file.size > 0) {
            return true;
          }

          emptyCandidatesSeen.add(file.filePath);
          return false;
        });

        if (nonEmptyCandidates.length > 0) {
          const candidates = sortCandidates(nonEmptyCandidates);

          return {
            filePath: candidates[0].filePath,
            debug: {
              scopedProviderHome,
              searchedPattern: CODEX_ROLLOUT_PATTERN,
              candidates,
              ignoredPreexistingCount: snapshot.filePaths.size,
              emptyCandidateCount: emptyCandidatesSeen.size,
              multipleCandidates: candidates.length > 1,
            },
          };
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }

        await sleep(Math.min(pollIntervalMs, remainingMs));
      } while (true);

      throw new CodexSessionLogLocatorTimeoutError({
        scopedProviderHome,
        searchedPattern: CODEX_ROLLOUT_PATTERN,
        timeoutMs,
      });
    },
  };
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
