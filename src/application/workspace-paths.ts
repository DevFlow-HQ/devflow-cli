import { constants } from "node:fs";
import { opendir, open, realpath, stat } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import { isAbsolute, join, relative } from "node:path";
import type {
  WorkspacePathCandidate,
  WorkspacePathQuery,
  WorkspacePathSearch,
} from "./projection-port.js";

export async function searchWorkspacePaths(
  input: WorkspacePathQuery,
): Promise<WorkspacePathSearch> {
  try {
    if (
      !isAbsolute(input.workspacePath) ||
      input.query.length > 1024 ||
      Array.from(input.query).some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error("Invalid Workspace path query");
    input.signal?.throwIfAborted();
    const root = await realpath(input.workspacePath);
    const candidates: WorkspacePathCandidate[] = [];
    let visited = 0;
    let ignoreBytes = 0;
    type Rules = { base: string; matcher: Ignore };
    const hiddenQueries = input.query
      .toLowerCase()
      .split("/")
      .filter((segment) => segment.startsWith("."));
    async function rulesAt(directory: string, prefix: string): Promise<Rules> {
      const matcher = ignore();
      for (const name of prefix === ""
        ? [".git/info/exclude", ".gitignore", ".ignore"]
        : [".gitignore", ".ignore"]) {
        input.signal?.throwIfAborted();
        const path = join(directory, name);
        try {
          const resolved = await realpath(path);
          if (!confined(resolved)) continue;
          if (!(await stat(resolved)).isFile()) continue;
          // Nonblocking open also covers replacement by a FIFO after stat.
          const file = await open(
            resolved,
            constants.O_RDONLY | constants.O_NONBLOCK,
          );
          try {
            if (!(await file.stat()).isFile()) continue;
            const bytes = new Uint8Array(256 * 1024 + 1);
            const { bytesRead } = await file.read(bytes);
            if (bytesRead > 256 * 1024)
              throw new Error("Workspace ignore budget exceeded");
            ignoreBytes += bytesRead;
            if (ignoreBytes > 2 * 1024 * 1024)
              throw new Error("Workspace ignore budget exceeded");
            matcher.add(new TextDecoder().decode(bytes.subarray(0, bytesRead)));
          } finally {
            await file.close();
          }
        } catch (cause) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            (cause.code === "ENOENT" || cause.code === "ENOTDIR")
          )
            continue;
          throw cause;
        }
      }
      return { base: prefix, matcher };
    }
    function confined(path: string): boolean {
      const pathFromRoot = relative(root, path);
      return (
        !isAbsolute(pathFromRoot) &&
        pathFromRoot !== ".." &&
        !pathFromRoot.startsWith("../") &&
        !pathFromRoot.startsWith("..\\")
      );
    }
    async function walk(
      directory: string,
      prefix: string,
      depth: number,
      inherited: readonly Rules[],
      ancestors: ReadonlySet<string>,
    ): Promise<void> {
      input.signal?.throwIfAborted();
      const physicalDirectory = await realpath(directory);
      if (!confined(physicalDirectory)) return;
      if (depth > 64) throw new Error("Workspace search depth exceeded");
      const rules = [...inherited, await rulesAt(directory, prefix)];
      const entries = [];
      const stream = await opendir(directory);
      for await (const entry of stream) {
        input.signal?.throwIfAborted();
        if (++visited > 20000)
          throw new Error("Workspace search budget exceeded");
        entries.push(entry);
      }
      entries.sort((a, b) => compare(a.name, b.name));
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        if (
          entry.name.startsWith(".") &&
          !hiddenQueries.some(
            (query) =>
              entry.name.toLowerCase().startsWith(query) ||
              query.startsWith(entry.name.toLowerCase()),
          )
        )
          continue;
        const path = prefix + entry.name;
        const fullPath = join(directory, entry.name);
        let folder = entry.isDirectory();
        let file = entry.isFile();
        let resolved: string;
        try {
          resolved = await realpath(fullPath);
        } catch (cause) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            (cause.code === "ENOENT" || cause.code === "ELOOP")
          )
            continue;
          throw cause;
        }
        if (
          !confined(resolved) ||
          relative(root, resolved).split(/[\\/]/).includes(".git")
        )
          continue;
        if (entry.isSymbolicLink()) {
          try {
            const facts = await stat(resolved);
            folder = facts.isDirectory();
            file = facts.isFile();
          } catch (cause) {
            if (
              cause instanceof Error &&
              "code" in cause &&
              (cause.code === "ENOENT" || cause.code === "ELOOP")
            )
              continue;
            throw cause;
          }
        }
        let ignored = false;
        for (const rule of rules) {
          const result = rule.matcher.test(
            path.slice(rule.base.length) + (folder ? "/" : ""),
          );
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (ignored) continue;
        if (folder) {
          candidates.push({ path, kind: "folder" });
          if (!ancestors.has(resolved))
            await walk(
              fullPath,
              path + "/",
              depth + 1,
              rules,
              new Set([...ancestors, resolved]),
            );
        } else if (file) candidates.push({ path, kind: "file" });
      }
    }
    await walk(root, "", 0, [], new Set([root]));
    const query = input.query.toLowerCase().replace(/\/$/, "");
    return {
      status: "available",
      candidates: candidates
        .map((candidate) => ({
          candidate,
          rank: rank(candidate.path.toLowerCase(), query),
        }))
        .filter((row) => row.rank !== undefined)
        .sort(
          (a, b) =>
            (a.rank ?? 0) - (b.rank ?? 0) ||
            compare(a.candidate.path, b.candidate.path),
        )
        .slice(0, 10)
        .map((row) => row.candidate),
    };
  } catch (cause) {
    return { status: "unavailable", cause };
  }
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function rank(path: string, query: string): number | undefined {
  if (path === query) return 0;
  if (path.startsWith(query)) return 1;
  const filename = path.slice(path.lastIndexOf("/") + 1);
  if (filename.includes(query)) return 2;
  let index = 0;
  for (const char of path) if (char === query[index]) index++;
  return index === query.length ? 3 : undefined;
}
