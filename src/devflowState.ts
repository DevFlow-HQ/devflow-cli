import fs from "fs-extra";
import { join } from "node:path";

import { z } from "zod";

import {
  BUILT_IN_PROVIDER_IDS,
  type BuiltInProviderId,
} from "./adapters/providerAdapter.js";

const DEVFLOW_STATE_DIRECTORY = ".devflow";
const DEVFLOW_CONFIG_FILENAME = "config.json";
const DEVFLOW_PROJECT_CONTEXT_FILENAME = "project-context.md";

const devFlowConfigSchema = z
  .object({
    defaultProvider: z.enum(
      BUILT_IN_PROVIDER_IDS as [
        BuiltInProviderId,
        ...BuiltInProviderId[],
      ],
    ),
  })
  .strict();

export interface DevFlowConfig {
  defaultProvider: BuiltInProviderId;
}

export interface CreateDevFlowStateOptions {
  projectRoot: string;
}

export interface DevFlowState {
  config: {
    load(): Promise<DevFlowConfig | undefined>;
    save(config: DevFlowConfig): Promise<void>;
  };
  readProjectContext(): Promise<string | undefined>;
  writeProjectContext(content: string): Promise<void>;
}

export class InvalidDevFlowConfigError extends Error {
  readonly configPath: string;

  constructor(configPath: string, details: string) {
    super(`Invalid DevFlow config at ${configPath}. ${details}`);
    this.name = "InvalidDevFlowConfigError";
    this.configPath = configPath;
  }
}

function getConfigPath(projectRoot: string): string {
  return join(projectRoot, DEVFLOW_STATE_DIRECTORY, DEVFLOW_CONFIG_FILENAME);
}

function getProjectContextPath(projectRoot: string): string {
  return join(
    projectRoot,
    DEVFLOW_STATE_DIRECTORY,
    DEVFLOW_PROJECT_CONTEXT_FILENAME,
  );
}

function formatValidationDetails(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

async function loadConfig(projectRoot: string): Promise<DevFlowConfig | undefined> {
  const configPath = getConfigPath(projectRoot);
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
    throw new InvalidDevFlowConfigError(configPath, details);
  }

  const result = devFlowConfigSchema.safeParse(parsedConfig);

  if (!result.success) {
    throw new InvalidDevFlowConfigError(
      configPath,
      formatValidationDetails(result.error),
    );
  }

  return result.data;
}

async function saveConfig(projectRoot: string, config: DevFlowConfig): Promise<void> {
  const configPath = getConfigPath(projectRoot);
  const stateDirectory = join(projectRoot, DEVFLOW_STATE_DIRECTORY);

  await fs.ensureDir(stateDirectory);
  await fs.writeJson(configPath, config, { spaces: 2 });
}

async function readProjectContext(
  projectRoot: string,
): Promise<string | undefined> {
  const projectContextPath = getProjectContextPath(projectRoot);
  const projectContextExists = await fs.pathExists(projectContextPath);

  if (!projectContextExists) {
    return undefined;
  }

  return fs.readFile(projectContextPath, "utf8");
}

async function writeProjectContext(
  projectRoot: string,
  content: string,
): Promise<void> {
  const projectContextPath = getProjectContextPath(projectRoot);
  const stateDirectory = join(projectRoot, DEVFLOW_STATE_DIRECTORY);

  await fs.ensureDir(stateDirectory);
  await fs.writeFile(projectContextPath, content, "utf8");
}

export function createDevFlowState(
  options: CreateDevFlowStateOptions,
): DevFlowState {
  return {
    config: {
      load: () => loadConfig(options.projectRoot),
      save: (config) => saveConfig(options.projectRoot, config),
    },
    readProjectContext: () => readProjectContext(options.projectRoot),
    writeProjectContext: (content) =>
      writeProjectContext(options.projectRoot, content),
  };
}

export function formatInvalidDevFlowConfigError(
  error: InvalidDevFlowConfigError,
): string {
  return `${error.message} Delete or repair the config file before running DevFlow again.`;
}
