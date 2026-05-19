import { mkdir, readFile, writeFile } from "node:fs/promises";
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

  let rawConfig: string;

  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  let parsedConfig: unknown;

  try {
    parsedConfig = JSON.parse(rawConfig);
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

  await mkdir(stateDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify(options.config, null, 2) + "\n");
}

export function formatInvalidRepoConfigError(
  error: InvalidRepoConfigError,
): string {
  return `${error.message} Delete or repair the config file before running DevFlow again.`;
}
