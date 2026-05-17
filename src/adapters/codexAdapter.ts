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

async function detectCodexExecutable(): Promise<ProviderDetectionResult> {
  try {
    const executable = await which(CODEX_COMMAND);

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
