import { execa } from "execa";
import which from "which";

import {
  BUILT_IN_PROVIDERS,
  type ProviderAdapter,
  type ProviderDetectionResult,
  type ProviderRunInput,
  type ProviderRunResult,
} from "./providerAdapter.js";

const CODEX_COMMAND = "codex";
const CODEX_PROVIDER = BUILT_IN_PROVIDERS[2];

async function resolveCodexExecutable(): Promise<string> {
  return which(CODEX_COMMAND);
}

function buildCodexArgs(input: ProviderRunInput): string[] {
  const args = [input.prompt];

  if (input.model) {
    args.unshift("--model", input.model);
  }

  return args;
}

async function detectCodexExecutable(): Promise<ProviderDetectionResult> {
  try {
    const executable = await resolveCodexExecutable();

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

async function runCodex(input: ProviderRunInput): Promise<ProviderRunResult> {
  const executable = await resolveCodexExecutable();
  const result = await execa(executable, buildCodexArgs(input), {
    cwd: input.workingDirectory,
    stdio: "inherit",
    reject: false,
  });

  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
  };
}

export function createCodexAdapter(): ProviderAdapter {
  return {
    provider: CODEX_PROVIDER,
    detect: detectCodexExecutable,
    run: runCodex,
  };
}
