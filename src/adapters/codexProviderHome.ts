import { homedir } from "node:os";
import { join } from "node:path";

import fs from "fs-extra";

import type { ManagedProviderSessionInput } from "./managedSessionAdapter.js";

export interface SeedCodexCredentialsOptions {
  codexHome: string;
  environment: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export function getScopedCodexProviderHome(
  input: ManagedProviderSessionInput,
): string {
  const runId = input.phase?.id.split(":")[0] ?? "unscoped-codex-session";

  return join(input.workingDirectory, ".devflow", "runs", runId, ".codex");
}

/**
 * Copies Codex auth into the scoped CODEX_HOME before launch.
 *
 * This is intentionally copy-in only: if a long session crosses access-token
 * expiry and Codex rotates its refresh token, that rotation is written to the
 * scoped copy and discarded. The next run copies from the source home again,
 * which may contain a superseded token. Copy-back-on-exit and symlinking are
 * explicitly out of scope for this module.
 */
export async function seedCodexCredentials({
  codexHome,
  environment,
  homeDirectory,
}: SeedCodexCredentialsOptions): Promise<void> {
  const sourceCodexHome =
    environment.CODEX_HOME ?? join(homeDirectory ?? homedir(), ".codex");
  const sourceAuthPath = join(sourceCodexHome, "auth.json");
  const targetAuthPath = join(codexHome, "auth.json");

  if (sourceAuthPath === targetAuthPath) {
    return;
  }

  if (!(await fs.pathExists(sourceAuthPath))) {
    return;
  }

  await fs.ensureDir(codexHome);
  await fs.copyFile(sourceAuthPath, targetAuthPath);
}
