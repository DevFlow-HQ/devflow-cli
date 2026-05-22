import which from "which";

import {
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
  type ManagedSessionAdapter,
  type ProviderDetectionResult,
} from "./managedSessionAdapter.js";
import {
  runPtyManagedSession,
  type PtyManagedSessionCommand,
} from "./ptyManagedSessionRunner.js";
import {
  getBuiltInProviderIdentity,
  type BuiltInProviderId,
} from "./providers.js";

export type ManagedSessionPtyRunner = (
  command: PtyManagedSessionCommand,
  input: ManagedProviderSessionInput,
) => Promise<ManagedProviderSessionResult>;

interface CommandManagedSessionConfig {
  providerId: BuiltInProviderId;
  command: string;
  buildArgs(input: ManagedProviderSessionInput): string[];
  cleanupCommand: string;
}

export interface CommandManagedSessionAdapterOptions {
  runPtyManagedSession?: ManagedSessionPtyRunner;
}

export function createCommandManagedSessionAdapter(
  config: CommandManagedSessionConfig,
  options: CommandManagedSessionAdapterOptions = {},
): ManagedSessionAdapter {
  const provider = getBuiltInProviderIdentity(config.providerId);
  const ptyRunner = options.runPtyManagedSession ?? runPtyManagedSession;

  async function resolveExecutable(): Promise<string> {
    return which(config.command);
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
            : `Unable to find executable '${config.command}' on PATH.`,
      };
    }
  }

  async function runSession(
    input: ManagedProviderSessionInput,
  ): Promise<ManagedProviderSessionResult> {
    const executable = await resolveExecutable();

    return ptyRunner(
      {
        provider,
        executable,
        args: config.buildArgs(input),
        cleanupCommand: config.cleanupCommand,
      },
      input,
    );
  }

  return {
    provider,
    detect: detectExecutable,
    runSession,
  };
}
