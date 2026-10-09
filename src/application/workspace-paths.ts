import fuzzysort from "fuzzysort";
import { dirname, isAbsolute, join } from "node:path";
import { lstat } from "node:fs/promises";
import type { ProcessAdapter } from "../process/process.js";
import type {
  WorkspacePathCandidate,
  WorkspacePathQuery,
  WorkspacePathSearch,
} from "./projection-port.js";
import {
  workspacePathHelper,
  type WorkspacePathHelper,
} from "./workspace-path-helper.js";

const FILE_CAP = 100_000;
const HELPER_STOP_MS = 1000;
type ListedCandidate = {
  readonly candidate: WorkspacePathCandidate;
  readonly prepared: ReturnType<typeof fuzzysort.prepare>;
};
type Listing = {
  readonly candidates: Map<string, ListedCandidate>;
  capped: boolean;
  indexing: boolean;
};

/** The token signal owns one listing; query edits only rank its retained paths. */
export function createWorkspacePathSearch(deps: {
  process: ProcessAdapter;
  helper?: WorkspacePathHelper;
}) {
  const source = deps.helper;
  const helper =
    source === undefined
      ? undefined
      : source.kind === "unavailable"
        ? async () => {
            throw source.cause;
          }
        : workspacePathHelper(source);
  const tokens = new WeakMap<
    AbortSignal,
    {
      runId: string;
      workspacePath: string;
      listing: Promise<Listing>;
      partial: Listing;
      signal: AbortSignal;
      notify?: () => void;
    }
  >();
  const active = new Map<AbortController, Promise<Listing>>();
  return {
    search,
    async close() {
      const pending = [...active];
      for (const [controller] of pending) controller.abort();
      await Promise.allSettled(pending.map(([, listing]) => listing));
    },
  };
  async function search(
    input: WorkspacePathQuery & {
      readonly workspacePath: string;
    },
  ): Promise<WorkspacePathSearch> {
    try {
      if (
        !isAbsolute(input.workspacePath) ||
        input.query.length > 1024 ||
        hasControl(input.query)
      )
        throw new Error("Invalid Workspace path query");
      input.signal?.throwIfAborted();
      let token =
        input.signal === undefined ? undefined : tokens.get(input.signal);
      if (
        token !== undefined &&
        (token.runId !== input.runId ||
          token.workspacePath !== input.workspacePath)
      )
        throw new Error(
          "Workspace path token belongs to another Run or Workspace",
        );
      if (token === undefined) {
        const controller = new AbortController();
        const signal =
          input.signal === undefined
            ? controller.signal
            : AbortSignal.any([input.signal, controller.signal]);
        const partial: Listing = {
          candidates: new Map(),
          capped: false,
          indexing: true,
        };
        const listing = list(input.workspacePath, signal, partial, () =>
          token?.notify?.(),
        ).finally(() => {
          partial.indexing = false;
          active.delete(controller);
        });
        active.set(controller, listing);
        token = {
          runId: input.runId,
          workspacePath: input.workspacePath,
          listing,
          partial,
          signal,
        };
        if (input.signal !== undefined) {
          const signal = input.signal;
          tokens.set(signal, token);
          signal.addEventListener("abort", () => tokens.delete(signal), {
            once: true,
          });
        }
      }
      const notify = () => {
        if (
          !token.partial.indexing ||
          token.signal.aborted ||
          input.onProgress === undefined
        )
          return;
        try {
          input.onProgress({
            ...snapshot(token.partial, input.query),
            indexing: true,
          });
        } catch {
          /* A presentation observer cannot fail the owned listing. */
        }
      };
      token.notify = notify;
      notify();
      try {
        const listing = await token.listing;
        input.signal?.throwIfAborted();
        return snapshot(listing, input.query);
      } finally {
        if (token.notify === notify) token.notify = undefined;
      }
    } catch (cause) {
      return { status: "unavailable", cause };
    }
  }

  async function list(
    workspacePath: string,
    signal: AbortSignal,
    listing: Listing,
    notify: () => void,
  ): Promise<Listing> {
    if (helper === undefined)
      throw new Error("Embedded Workspace path helper unavailable");
    const executable = await helper();
    signal?.throwIfAborted();
    const inGit = await gitWorkspace(workspacePath);
    signal?.throwIfAborted();
    const launched = await deps.process.spawnOwnedProcess({
      role: "workspace-paths",
      executable,
      cwd: workspacePath,
      env: process.env,
      args: [
        "--no-config",
        "--files",
        "--null",
        "--hidden",
        ...(inGit ? [] : ["--no-require-git"]),
        "--no-follow",
        "--glob",
        "!**/.git",
        "--glob",
        "!**/.git/**",
        ".",
      ],
      launchTimeoutMs: 5000,
    });
    if (!launched.ok) throw launched.failure.cause;
    const child = launched.process;
    let closed = false;
    const close = child.closed().then((result) => {
      closed = true;
      return result;
    });
    let stopping: Promise<unknown> | undefined;
    const stop = () => {
      if (!closed) stopping ??= child.interrupt(HELPER_STOP_MS);
      return stopping;
    };
    const abort = () => {
      void stop()?.catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      abort();
    }, 30_000);
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      progressTimer ??= setTimeout(() => {
        progressTimer = undefined;
        if (!signal.aborted) notify();
      }, 50);
    };
    let fileCount = 0;
    let capped = false;
    let tail = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      if (signal?.aborted) abort();
      await Promise.all([
        (async () => {
          for await (const bytes of child.stdout) {
            if (capped) continue;
            const text = tail + decoder.decode(bytes, { stream: true });
            let start = 0;
            for (
              let end = text.indexOf("\0");
              end !== -1;
              end = text.indexOf("\0", start)
            ) {
              fileCount++;
              if (fileCount > FILE_CAP) {
                capped = true;
                listing.capped = true;
                notify();
                // Keep draining while Process observes the helper's stop.
                abort();
                break;
              }
              const path = normalized(text.slice(start, end));
              if (path !== undefined) addCandidates(listing.candidates, path);
              start = end + 1;
            }
            changed();
            tail = capped ? "" : text.slice(start);
            if (tail.length > 4096)
              throw new Error("Workspace path exceeds its bound");
          }
          if (!capped && (tail + decoder.decode()).length !== 0)
            throw new Error("Incomplete Workspace path listing");
        })(),
        (async () => {
          for await (const _bytes of child.stderr) {
            /* Unreadable folders are silent. */
          }
        })(),
      ]);
      const result = await close;
      signal?.throwIfAborted();
      if (timedOut) throw new Error("Workspace path helper timed out");
      if (result.kind === "cleanup-error" || result.kind === "spawn-error")
        throw result.cause;
      if (result.kind === "cleanup-timeout")
        throw new Error("Workspace path helper cleanup timed out");
      if (
        !capped &&
        !(
          result.kind === "exited" &&
          (result.status === 0 ||
            (result.status === 1 && fileCount === 0) ||
            (result.status === 2 && fileCount > 0))
        )
      )
        throw new Error("Workspace path helper failed");
      return listing;
    } finally {
      clearTimeout(deadline);
      clearTimeout(progressTimer);
      signal?.removeEventListener("abort", abort);
      await stop();
      await close;
    }
  }
}

// In rg 15.1.0 --no-require-git also disables linked-worktree commondir
// discovery. Use it only outside Git; keep native precedence inside Git.
async function gitWorkspace(workspace: string): Promise<boolean> {
  for (let directory = workspace; ; directory = dirname(directory)) {
    try {
      const git = await lstat(join(directory, ".git"));
      if (git.isDirectory() || git.isFile()) return true;
    } catch {
      /* Unreadable metadata cannot fail path search. */
    }
    if (dirname(directory) === directory) return false;
  }
}

function hasControl(text: string): boolean {
  return Array.from(text).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function normalized(raw: string): string | undefined {
  const path = (
    process.platform === "win32" ? raw.replace(/\\/g, "/") : raw
  ).replace(/^\.\//, "");
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.length > 4096 ||
    hasControl(path) ||
    /^[a-zA-Z]:/.test(path) ||
    segments.some(
      (part) => part === "" || part === "." || part === ".." || part === ".git",
    )
  )
    return;
  return path;
}
function addCandidates(
  candidates: Map<string, ListedCandidate>,
  path: string,
): void {
  for (
    let slash = path.indexOf("/");
    slash !== -1;
    slash = path.indexOf("/", slash + 1)
  ) {
    const folder = path.slice(0, slash);
    addCandidate(candidates, folder, "folder");
  }
  addCandidate(candidates, path, "file");
}
function addCandidate(
  candidates: Map<string, ListedCandidate>,
  path: string,
  kind: WorkspacePathCandidate["kind"],
): void {
  if (candidates.has(path)) return;
  // Raw targets enter fuzzysort's global cache. Prepared targets belong to this token.
  candidates.set(path, {
    candidate: { path, kind },
    prepared: fuzzysort.prepare(path),
  });
}
function snapshot(
  listing: Listing,
  query: string,
): Extract<WorkspacePathSearch, { status: "available" }> {
  return {
    status: "available",
    candidates: matches([...listing.candidates.values()], query),
    ...(listing.capped
      ? {
          notice:
            "Large Workspace: only the first 100,000 files are searchable" as const,
        }
      : {}),
  };
}
function matches(
  candidates: readonly ListedCandidate[],
  rawQuery: string,
): WorkspacePathCandidate[] {
  const query = rawQuery.toLowerCase().replace(/^\.\//, "").replace(/\/$/, "");
  const dots = query.split("/").filter((part) => part.startsWith("."));
  const visible = candidates.filter(
    (candidate) =>
      !candidate.candidate.path
        .split("/")
        .some(
          (part) =>
            part.startsWith(".") &&
            !dots.some(
              (dot) =>
                part.toLowerCase().startsWith(dot) ||
                dot.startsWith(part.toLowerCase()),
            ),
        ),
  );
  if (query === "")
    return visible
      .filter((candidate) => !candidate.candidate.path.includes("/"))
      .sort(
        (a, b) =>
          Number(a.candidate.kind === "file") -
            Number(b.candidate.kind === "file") ||
          compare(a.candidate.path, b.candidate.path),
      )
      .slice(0, 10)
      .map((row) => row.candidate);
  // Rank all matches before truncation so ties at the cutoff stay deterministic.
  return [...fuzzysort.go(query, visible, { key: "prepared" })]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.obj.candidate.path.length - b.obj.candidate.path.length ||
        compare(a.obj.candidate.path, b.obj.candidate.path),
    )
    .slice(0, 10)
    .map((row) => row.obj.candidate);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
