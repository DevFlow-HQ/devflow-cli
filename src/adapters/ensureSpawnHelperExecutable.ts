import { chmodSync as realChmodSync, statSync as realStatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

export interface EnsureSpawnHelperExecutableDependencies {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  resolve?: (id: string) => string;
  statSync?: (path: string) => { mode: number };
  chmodSync?: (path: string, mode: number) => void;
}

export function ensureSpawnHelperExecutable({
  platform = process.platform,
  arch = process.arch,
  resolve = nodeRequire.resolve.bind(nodeRequire),
  statSync = realStatSync,
  chmodSync = realChmodSync,
}: EnsureSpawnHelperExecutableDependencies = {}): void {
  if (platform !== "darwin") {
    return;
  }

  const helperPath = resolveSpawnHelperPath({ platform, arch, resolve });

  let mode: number;
  try {
    mode = statSync(helperPath).mode;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }

    throw error;
  }

  if ((mode & 0o111) !== 0) {
    return;
  }

  try {
    chmodSync(helperPath, mode | 0o111);
  } catch {
    throw new Error(
      [
        "node-pty's macOS spawn-helper is not executable",
        `and DevFlow could not add the executable bit at ${helperPath}.`,
        `Run: sudo chmod +x ${helperPath}`,
      ].join(" "),
    );
  }
}

export interface ResolveSpawnHelperPathDependencies {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  resolve?: (id: string) => string;
}

export function resolveSpawnHelperPath({
  platform = process.platform,
  arch = process.arch,
  resolve = nodeRequire.resolve.bind(nodeRequire),
}: ResolveSpawnHelperPathDependencies = {}): string {
  const nodePtyEntryPath = resolve("node-pty");
  const nodePtyPackageDir = dirname(dirname(nodePtyEntryPath));

  return join(
    nodePtyPackageDir,
    "prebuilds",
    `${platform}-${arch}`,
    "spawn-helper",
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
