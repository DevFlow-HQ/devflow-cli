import which from "which";

import {
  type ManagedProviderSessionCapabilities,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
  type ManagedSessionAdapter,
  ProviderSessionLaunchError,
  type ProviderDetectionResult,
} from "./managedSessionAdapter.js";
import {
  runCodexHookDrivenSession,
  type CodexHookDrivenSessionCommand,
} from "./codexHookDrivenSessionRunner.js";
import { getBuiltInProviderIdentity } from "./providers.js";

export type CodexHookDrivenRunner = (
  command: CodexHookDrivenSessionCommand,
  input: ManagedProviderSessionInput,
) => Promise<ManagedProviderSessionResult>;

export interface CodexAdapterOptions {
  runCodexHookDrivenSession?: CodexHookDrivenRunner;
}

const CODEX_CAPABILITIES: ManagedProviderSessionCapabilities = {
  controlTransport: "pty",
  eventSource: "hooks",
  supportsProviderSessionId: true,
  supportsResume: false,
};

export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): ManagedSessionAdapter {
  const provider = getBuiltInProviderIdentity("codex");
  const hookRunner = options.runCodexHookDrivenSession ?? runCodexHookDrivenSession;

  async function resolveExecutable(): Promise<string> {
    return which("codex");
  }

  async function detectExecutable(): Promise<ProviderDetectionResult> {
    try {
      const executable = await resolveExecutable();

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
            : "Unable to find executable 'codex' on PATH.",
      };
    }
  }

  async function runSession(
    input: ManagedProviderSessionInput,
  ): Promise<ManagedProviderSessionResult> {
    let executable: string;

    try {
      executable = await resolveExecutable();
    } catch (error) {
      throw new ProviderSessionLaunchError(provider, error);
    }

    return hookRunner(
      {
        provider,
        executable,
        args: [...(input.model ? ["--model", input.model] : []), input.initialPrompt],
      },
      input,
    );
  }

  return {
    provider,
    capabilities: CODEX_CAPABILITIES,
    detect: detectExecutable,
    runSession,
  };
}
