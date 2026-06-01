import { homedir } from "node:os";
import { join } from "node:path";

import fs from "fs-extra";

import type { ManagedProviderSessionInput } from "./managedSessionAdapter.js";

export interface SeedClaudeCredentialsOptions {
  claudeConfigDirectory: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDirectory?: string;
}

export function getScopedClaudeProviderHome(
  input: ManagedProviderSessionInput,
): string {
  const runId = input.phase?.id.split(":")[0] ?? "unscoped-claude-session";

  return join(input.workingDirectory, ".devflow", "runs", runId, ".claude");
}

export function getClaudeHookDirectory(claudeConfigDirectory: string): string {
  return join(claudeConfigDirectory, "devflow-hooks");
}

export async function seedClaudeCredentials({
  claudeConfigDirectory,
  environment,
  platform,
  homeDirectory,
}: SeedClaudeCredentialsOptions): Promise<void> {
  if (platform === "darwin") {
    return;
  }

  const sourceConfigDirectory =
    environment.CLAUDE_CONFIG_DIR ?? join(homeDirectory ?? homedir(), ".claude");
  const sourceCredentialsPath = join(sourceConfigDirectory, ".credentials.json");
  const targetCredentialsPath = join(
    claudeConfigDirectory,
    ".credentials.json",
  );

  if (sourceCredentialsPath === targetCredentialsPath) {
    return;
  }

  if (!(await fs.pathExists(sourceCredentialsPath))) {
    return;
  }

  await fs.ensureDir(claudeConfigDirectory);
  await fs.copyFile(sourceCredentialsPath, targetCredentialsPath);
}
