import { access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

import {
  BUILT_IN_PROVIDERS,
  type ProviderAdapter,
  type ProviderDetectionResult,
  type ProviderRunInput,
  type ProviderRunResult,
} from "./providerAdapter.js";

const CODEX_COMMAND = "codex";
const CODEX_PROVIDER = BUILT_IN_PROVIDERS[2];

async function resolveExecutable(command: string): Promise<string> {
  const rawPath = process.env.PATH ?? "";
  const pathEntries = rawPath
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);

    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(`Unable to find executable '${command}' on PATH.`);
}

async function detectCodexExecutable(): Promise<ProviderDetectionResult> {
  try {
    const executable = await resolveExecutable(CODEX_COMMAND);

    return {
      isAvailable: true,
      executable,
    };
  } catch (error) {
    return {
      isAvailable: false,
      reason:
        error instanceof Error
          ? error.message
          : `Unable to find executable '${CODEX_COMMAND}' on PATH.`,
    };
  }
}

async function runCodex(_input: ProviderRunInput): Promise<ProviderRunResult> {
  throw new Error("Codex interactive run behavior is not implemented yet.");
}

export function createCodexAdapter(): ProviderAdapter {
  return {
    provider: CODEX_PROVIDER,
    detect: detectCodexExecutable,
    run: runCodex,
  };
}
