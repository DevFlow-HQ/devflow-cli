import which from "which";

import {
  buildTierResolutionTrace,
  emitAdapterTrace,
} from "./adapterTrace.js";
import {
  type ManagedProviderSessionCapabilities,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
  type ManagedSessionAdapter,
  ProviderSessionLaunchError,
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
import { NoopLogger, type Logger } from "../logger.js";

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
  logger?: Logger;
  runPtyManagedSession?: ManagedSessionPtyRunner;
}

const PTY_FALLBACK_CAPABILITIES: ManagedProviderSessionCapabilities = {
  controlTransport: "pty",
  eventSource: "pty",
  supportsProviderSessionId: false,
  supportsResume: false,
  classifiesSubmittedUserMessageOrigin: false,
};

export function createCommandManagedSessionAdapter(
  config: CommandManagedSessionConfig,
  options: CommandManagedSessionAdapterOptions = {},
): ManagedSessionAdapter {
  const provider = getBuiltInProviderIdentity(config.providerId);
  const ptyRunner = options.runPtyManagedSession ?? runPtyManagedSession;
  const logger = options.logger ?? NoopLogger;

  emitAdapterTrace(
    logger,
    buildTierResolutionTrace({
      provider,
      tier: PTY_FALLBACK_CAPABILITIES.eventSource,
      capabilities: PTY_FALLBACK_CAPABILITIES,
    }),
  );

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
    let executable: string;

    try {
      executable = await resolveExecutable();
    } catch (error) {
      throw new ProviderSessionLaunchError(provider, error);
    }

    return ptyRunner(
      {
        provider,
        executable,
        args: config.buildArgs(input),
        cleanupCommand: config.cleanupCommand,
        ...(options.logger !== undefined ? { logger } : {}),
      },
      input,
    );
  }

  return {
    provider,
    capabilities: PTY_FALLBACK_CAPABILITIES,
    detect: detectExecutable,
    runSession,
  };
}
