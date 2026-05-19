import fs from "fs-extra";
import { join } from "node:path";

import { z } from "zod";

import {
  BUILT_IN_PROVIDER_IDS,
  type BuiltInProviderId,
} from "./adapters/providerAdapter.js";

const DEVFLOW_STATE_DIRECTORY = ".devflow";
const DEVFLOW_CONFIG_FILENAME = "config.json";

const repoConfigSchema = z
  .object({
    defaultProvider: z.enum(
      BUILT_IN_PROVIDER_IDS as [
        BuiltInProviderId,
        ...BuiltInProviderId[],
      ],
    ),
  })
  .strict();

export interface RepoConfig {
  defaultProvider: BuiltInProviderId;
}

export interface ResolveRepoConfigOptions {
  projectRoot: string;
}

export interface PersistRepoConfigOptions extends ResolveRepoConfigOptions {
  config: RepoConfig;
}

export class InvalidRepoConfigError extends Error {
  readonly configPath: string;

  constructor(configPath: string, details: string) {
    super(`Invalid DevFlow config at ${configPath}. ${details}`);
    this.name = "InvalidRepoConfigError";
    this.configPath = configPath;
  }
}

function getConfigPath(projectRoot: string): string {
  return join(projectRoot, DEVFLOW_STATE_DIRECTORY, DEVFLOW_CONFIG_FILENAME);
}

function formatValidationDetails(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export async function resolveRepoConfig(
  options: ResolveRepoConfigOptions,
): Promise<RepoConfig | undefined> {
  const configPath = getConfigPath(options.projectRoot);
  const configExists = await fs.pathExists(configPath);

  if (!configExists) {
    return undefined;
  }

  let parsedConfig: unknown;

  try {
    parsedConfig = await fs.readJson(configPath);
  } catch (error) {
    const details =
      error instanceof Error ? error.message : "Config file is not valid JSON.";
    throw new InvalidRepoConfigError(configPath, details);
  }

  const result = repoConfigSchema.safeParse(parsedConfig);

  if (!result.success) {
    throw new InvalidRepoConfigError(
      configPath,
      formatValidationDetails(result.error),
    );
  }

  return result.data;
}

export async function persistRepoConfig(
  options: PersistRepoConfigOptions,
): Promise<void> {
  const configPath = getConfigPath(options.projectRoot);
  const stateDirectory = join(options.projectRoot, DEVFLOW_STATE_DIRECTORY);

  await fs.ensureDir(stateDirectory);
  await fs.writeJson(configPath, options.config, { spaces: 2 });
}

export function formatInvalidRepoConfigError(
  error: InvalidRepoConfigError,
): string {
  return `${error.message} Delete or repair the config file before running DevFlow again.`;
}
