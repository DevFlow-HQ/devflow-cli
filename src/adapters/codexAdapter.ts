import which from "which";

import {
  type ManagedProviderSessionCapabilities,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResumeInput,
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
    supportsResume: true,
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

    return runSelectedRunner({
      executable,
      input,
      args:
        eventSource === "jsonl"
          ? modelArgs(input)
          : [...modelArgs(input), input.initialPrompt],
    });
  }

  async function resumeSession(
    input: ManagedProviderSessionResumeInput,
  ): Promise<ManagedProviderSessionResult> {
    let executable: string;

    try {
      executable = await resolveExecutable();
    } catch (error) {
      throw new ProviderSessionLaunchError(provider, error);
    }

    const resumePrefix = ["resume", ...modelArgs(input), input.providerSessionId];

    return runSelectedRunner({
      executable,
      input,
      args:
        eventSource === "jsonl"
          ? resumePrefix
          : [...resumePrefix, input.initialPrompt],
    });
  }

  function modelArgs(
    input: Pick<ManagedProviderSessionInput, "model">,
  ): string[] {
    return input.model ? ["--model", input.model] : [];
  }

  async function runSelectedRunner(options: {
    executable: string;
    args: string[];
    input: ManagedProviderSessionInput;
  }): Promise<ManagedProviderSessionResult> {
    const command = {
      provider,
      executable: options.executable,
      args: options.args,
    };
    const runner = eventSource === "jsonl" ? jsonlRunner : hookRunner;

    return runner(command, options.input);
  }

  return {
    provider,
    capabilities,
    detect: detectExecutable,
    runSession,
    resumeSession,
  };
}
