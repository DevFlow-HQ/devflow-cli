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
import {
  runCodexJsonlSession,
  type CodexJsonlSessionCommand,
} from "./codexJsonlSessionRunner.js";
import { getBuiltInProviderIdentity } from "./providers.js";

export type CodexHookDrivenRunner = (
  command: CodexHookDrivenSessionCommand,
  input: ManagedProviderSessionInput,
) => Promise<ManagedProviderSessionResult>;

export type CodexJsonlRunner = (
  command: CodexJsonlSessionCommand,
  input: ManagedProviderSessionInput,
) => Promise<ManagedProviderSessionResult>;

export type CodexManagedSessionEventSource = "hooks" | "jsonl";

export interface CodexAdapterOptions {
  runCodexHookDrivenSession?: CodexHookDrivenRunner;
  runCodexJsonlSession?: CodexJsonlRunner;
  eventSource?: CodexManagedSessionEventSource;
}

export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): ManagedSessionAdapter {
  const provider = getBuiltInProviderIdentity("codex");
  const eventSource = options.eventSource ?? "hooks";
  const hookRunner = options.runCodexHookDrivenSession ?? runCodexHookDrivenSession;
  const jsonlRunner = options.runCodexJsonlSession ?? runCodexJsonlSession;
  const capabilities: ManagedProviderSessionCapabilities = {
    controlTransport: "pty",
    eventSource,
    supportsProviderSessionId: true,
    supportsResume: false,
    classifiesSubmittedUserMessageOrigin: true,
  };

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

    const args =
      eventSource === "jsonl"
        ? [...(input.model ? ["--model", input.model] : [])]
        : [...(input.model ? ["--model", input.model] : []), input.initialPrompt];

    const command = {
      provider,
      executable,
      args,
    };

    const runner = eventSource === "jsonl" ? jsonlRunner : hookRunner;

    return runner(
      {
        ...command,
      },
      input,
    );
  }

  return {
    provider,
    capabilities,
    detect: detectExecutable,
    runSession,
  };
}
