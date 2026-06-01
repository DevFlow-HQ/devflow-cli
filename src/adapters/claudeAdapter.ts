import which from "which";

import {
  createCommandManagedSessionAdapter,
  type CommandManagedSessionAdapterOptions,
} from "./commandManagedSessionAdapter.js";
import {
  runClaudeHookDrivenSession,
  type ClaudeHookDrivenSessionCommand,
} from "./claudeHookDrivenSessionRunner.js";
import {
  runClaudeJsonlSession,
  type ClaudeJsonlSessionCommand,
} from "./claudeJsonlSessionRunner.js";
import { ProviderSessionLaunchError } from "./managedSessionAdapter.js";
import type {
  ManagedProviderSessionCapabilities,
  ManagedProviderSessionInput,
  ManagedProviderSessionResumeInput,
  ManagedProviderSessionResult,
  ManagedSessionAdapter,
  ProviderDetectionResult,
} from "./managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "./providers.js";

export type ClaudeManagedSessionEventSource = "pty" | "hooks" | "jsonl";

export interface ClaudeAdapterOptions
  extends CommandManagedSessionAdapterOptions {
  eventSource?: ClaudeManagedSessionEventSource;
  runClaudeHookDrivenSession?: ClaudeHookDrivenRunner;
  runClaudeJsonlSession?: ClaudeJsonlRunner;
}

export type ClaudeHookDrivenRunner = (
  command: ClaudeHookDrivenSessionCommand,
  input: ManagedProviderSessionInput,
) => Promise<ManagedProviderSessionResult>;

export type ClaudeJsonlRunner = (
  command: ClaudeJsonlSessionCommand,
  input: ManagedProviderSessionInput,
) => Promise<ManagedProviderSessionResult>;

const CLAUDE_PTY_FALLBACK_CAPABILITIES: ManagedProviderSessionCapabilities = {
  controlTransport: "pty",
  eventSource: "pty",
  supportsProviderSessionId: false,
  supportsResume: false,
  classifiesSubmittedUserMessageOrigin: false,
};

const CLAUDE_HOOK_CAPABILITIES: ManagedProviderSessionCapabilities = {
  controlTransport: "pty",
  eventSource: "hooks",
  supportsProviderSessionId: true,
  supportsResume: true,
  classifiesSubmittedUserMessageOrigin: true,
};

const CLAUDE_JSONL_CAPABILITIES: ManagedProviderSessionCapabilities = {
  controlTransport: "pty",
  eventSource: "jsonl",
  supportsProviderSessionId: true,
  supportsResume: true,
  classifiesSubmittedUserMessageOrigin: true,
};

export function createClaudeAdapter(
  options: ClaudeAdapterOptions = {},
): ManagedSessionAdapter {
  if (options.eventSource === "hooks") {
    return createClaudeHookAdapter(options);
  }

  if (options.eventSource === "jsonl") {
    return createClaudeJsonlAdapter(options);
  }

  const adapter = createCommandManagedSessionAdapter(
    {
      providerId: "claude",
      command: "claude",
      cleanupCommand: "/exit\n",
      buildArgs(input) {
        return [...(input.model ? ["--model", input.model] : []), input.initialPrompt];
      },
    },
    options,
  );

  return {
    ...adapter,
    capabilities: CLAUDE_PTY_FALLBACK_CAPABILITIES,
  };
}

function createClaudeJsonlAdapter(
  options: ClaudeAdapterOptions,
): ManagedSessionAdapter {
  const provider = getBuiltInProviderIdentity("claude");
  const jsonlRunner = options.runClaudeJsonlSession ?? runClaudeJsonlSession;

  async function resolveExecutable(): Promise<string> {
    return which("claude");
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
            : "Unable to find executable 'claude' on PATH.",
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

    return jsonlRunner(
      {
        provider,
        executable,
        args: buildClaudeArgs(input),
      },
      input,
    );
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

    return jsonlRunner(
      {
        provider,
        executable,
        args: buildClaudeResumeArgs(input),
        resumeProviderSessionId: input.providerSessionId,
      },
      input,
    );
  }

  return {
    provider,
    capabilities: CLAUDE_JSONL_CAPABILITIES,
    detect: detectExecutable,
    runSession,
    resumeSession,
  };
}

function createClaudeHookAdapter(
  options: ClaudeAdapterOptions,
): ManagedSessionAdapter {
  const provider = getBuiltInProviderIdentity("claude");
  const hookRunner =
    options.runClaudeHookDrivenSession ?? runClaudeHookDrivenSession;

  async function resolveExecutable(): Promise<string> {
    return which("claude");
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
            : "Unable to find executable 'claude' on PATH.",
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
        args: buildClaudeArgs(input),
      },
      input,
    );
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

    return hookRunner(
      {
        provider,
        executable,
        args: buildClaudeResumeArgs(input),
      },
      input,
    );
  }

  return {
    provider,
    capabilities: CLAUDE_HOOK_CAPABILITIES,
    detect: detectExecutable,
    runSession,
    resumeSession,
  };
}

function buildClaudeArgs(
  input: Pick<ManagedProviderSessionInput, "model" | "initialPrompt">,
): string[] {
  return [...(input.model ? ["--model", input.model] : []), input.initialPrompt];
}

function buildClaudeResumeArgs(
  input: Pick<
    ManagedProviderSessionResumeInput,
    "model" | "initialPrompt" | "providerSessionId"
  >,
): string[] {
  return [
    "--resume",
    input.providerSessionId,
    ...(input.model ? ["--model", input.model] : []),
    input.initialPrompt,
  ];
}
