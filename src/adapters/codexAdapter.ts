import which from "which";

import {
  buildTierResolutionTrace,
  emitAdapterTrace,
} from "./adapterTrace.js";
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
import { NoopLogger, type Logger } from "../logger.js";

export type CodexHookDrivenRunner = (
  command: CodexHookDrivenSessionCommand,
  input: ManagedProviderSessionInput,
) => Promise<ManagedProviderSessionResult>;

export type CodexJsonlRunner = (
  command: CodexJsonlSessionCommand,
  input: ManagedProviderSessionInput,
) => Promise<ManagedProviderSessionResult>;

export type CodexManagedSessionEventSource = "hooks" | "jsonl";

export interface CodexLaunchArgsInput {
  eventSource: CodexManagedSessionEventSource;
  model?: string;
  initialPrompt: string;
  resumeProviderSessionId?: string;
}

export function buildCodexLaunchArgs(input: CodexLaunchArgsInput): string[] {
  const args = ["-a", "never"];

  if (input.eventSource === "hooks") {
    args.push("--dangerously-bypass-hook-trust");
  }

  if (input.model) {
    args.push("--model", input.model);
  }

  if (input.resumeProviderSessionId) {
    args.push("resume", input.resumeProviderSessionId);

    if (input.eventSource === "hooks") {
      args.push(input.initialPrompt);
    }

    return args;
  }

  if (input.eventSource === "hooks") {
    args.push(input.initialPrompt);
  }

  return args;
}

export interface CodexAdapterOptions {
  logger?: Logger;
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
  const logger = options.logger ?? NoopLogger;
  const hasInjectedLogger = options.logger !== undefined;
  const capabilities: ManagedProviderSessionCapabilities = {
    controlTransport: "pty",
    eventSource,
    supportsProviderSessionId: true,
    supportsResume: true,
    classifiesSubmittedUserMessageOrigin: true,
  };

  emitAdapterTrace(
    logger,
    buildTierResolutionTrace({
      provider,
      tier: eventSource,
      capabilities,
    }),
  );

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
      args: buildCodexLaunchArgs({
        eventSource,
        model: input.model,
        initialPrompt: input.initialPrompt,
      }),
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

    return runSelectedRunner({
      executable,
      input,
      args: buildCodexLaunchArgs({
        eventSource,
        model: input.model,
        initialPrompt: input.initialPrompt,
        resumeProviderSessionId: input.providerSessionId,
      }),
      resumeProviderSessionId:
        eventSource === "jsonl" ? input.providerSessionId : undefined,
    });
  }


  async function runSelectedRunner(runnerOptions: {
    executable: string;
    args: string[];
    input: ManagedProviderSessionInput;
    resumeProviderSessionId?: string;
  }): Promise<ManagedProviderSessionResult> {
    const command = {
      provider,
      executable: runnerOptions.executable,
      args: runnerOptions.args,
      gracefulExitCommand: { text: "/quit", submitKey: "\r" },
      ...(hasInjectedLogger ? { logger } : {}),
      ...(runnerOptions.resumeProviderSessionId
        ? { resumeProviderSessionId: runnerOptions.resumeProviderSessionId }
        : {}),
    };
    const runner = eventSource === "jsonl" ? jsonlRunner : hookRunner;

    return runner(command, runnerOptions.input);
  }

  return {
    provider,
    capabilities,
    detect: detectExecutable,
    runSession,
    resumeSession,
  };
}
