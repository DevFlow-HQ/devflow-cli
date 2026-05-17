import { execa } from "execa";
import which from "which";

import {
  getBuiltInProviderIdentity,
  type BuiltInProviderId,
  type ProviderAdapter,
  type ProviderDetectionResult,
  type ProviderRunInput,
  type ProviderRunResult,
} from "./providerAdapter";

interface CommandProviderConfig {
  providerId: BuiltInProviderId;
  command: string;
}

function buildCommandArgs(input: ProviderRunInput): string[] {
  const args = [input.prompt];

  if (input.model) {
    args.unshift("--model", input.model);
  }

  return args;
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

  async function runCommand(
    input: ProviderRunInput,
  ): Promise<ProviderRunResult> {
    const executable = await resolveExecutable();
    const result = await execa(executable, buildCommandArgs(input), {
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

  return {
    provider,
    detect: detectExecutable,
    run: runCommand,
  };
}
