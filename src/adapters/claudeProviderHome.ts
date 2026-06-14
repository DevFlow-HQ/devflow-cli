import { homedir } from "node:os";
import { join } from "node:path";

import fs from "fs-extra";

import type { ManagedProviderSessionInput } from "./managedSessionAdapter.js";
import { readMacosKeychainCredential } from "./readMacosKeychainCredential.js";

export interface SeedClaudeCredentialsOptions {
  claudeConfigDirectory: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDirectory?: string;
  readMacosKeychainCredential?: () => Promise<string | null>;
}

export interface DeleteClaudeCredentialsOptions {
  claudeConfigDirectory: string;
}

export interface SeedClaudeConfigStateOptions {
  claudeConfigDirectory: string;
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
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
  readMacosKeychainCredential: readKeychainCredential = readMacosKeychainCredential,
}: SeedClaudeCredentialsOptions): Promise<void> {
  if (platform === "darwin") {
    const credential = await readKeychainCredential();

    if (credential === null) {
      return;
    }

    const targetCredentialsPath = join(claudeConfigDirectory, ".credentials.json");

    await fs.ensureDir(claudeConfigDirectory);
    await fs.writeFile(targetCredentialsPath, credential, { mode: 0o600 });
    await fs.chmod(targetCredentialsPath, 0o600);
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

export async function seedClaudeConfigState({
  claudeConfigDirectory,
  environment,
  workingDirectory,
  homeDirectory,
}: SeedClaudeConfigStateOptions): Promise<void> {
  const targetConfigPath = join(claudeConfigDirectory, ".claude.json");

  if (await fs.pathExists(targetConfigPath)) {
    return;
  }

  const sourceConfigPath = environment.CLAUDE_CONFIG_DIR
    ? join(environment.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homeDirectory ?? homedir(), ".claude.json");
  const sourceConfig = (await fs.pathExists(sourceConfigPath))
    ? await fs.readJson(sourceConfigPath)
    : {};

  await fs.ensureDir(claudeConfigDirectory);
  await fs.writeJson(
    targetConfigPath,
    {
      hasCompletedOnboarding: true,
      shiftEnterKeyBindingInstalled: true,
      userID: sourceConfig.userID,
      oauthAccount: sourceConfig.oauthAccount,
      projects: {
        [workingDirectory]: {
          hasTrustDialogAccepted: true,
        },
      },
    },
    { spaces: 2 },
  );
}

export async function deleteClaudeCredentials({
  claudeConfigDirectory,
}: DeleteClaudeCredentialsOptions): Promise<void> {
  await fs.remove(join(claudeConfigDirectory, ".credentials.json"));
}
