import which from "which";

import {
  ManagedProviderSessionNotImplementedError,
  type ManagedProviderSessionInput,
  type ProviderAdapter,
  type ProviderDetectionResult,
} from "./providerAdapter.js";
import {
  getBuiltInProviderIdentity,
  type BuiltInProviderId,
} from "./providers.js";

interface CommandProviderConfig {
  providerId: BuiltInProviderId;
  command: string;
}

export function createCommandProviderAdapter(
  config: CommandProviderConfig,
): ProviderAdapter {
  const provider = getBuiltInProviderIdentity(config.providerId);

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
    _input: ManagedProviderSessionInput,
  ): Promise<never> {
    throw new ManagedProviderSessionNotImplementedError(provider);
  }

  return {
    provider,
    detect: detectExecutable,
    runSession,
  };
}
