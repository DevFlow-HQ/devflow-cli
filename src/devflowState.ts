import fs from "fs-extra";
import crypto from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
  BUILT_IN_PROVIDER_IDS,
  type BuiltInProviderId,
} from "./adapters/providerAdapter.js";

const DEVFLOW_STATE_DIRECTORY = ".devflow";
const DEVFLOW_CONFIG_FILENAME = "config.json";
const DEVFLOW_PROJECT_CONTEXT_FILENAME = "project-context.md";
const DEVFLOW_RUNS_DIRECTORY = "runs";
const DEVFLOW_RUN_METADATA_FILENAME = "run.json";
const DEVFLOW_RUN_ID_LENGTH = 12;
const devFlowRunIdPattern = /^[a-z0-9]{12}$/;

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

export interface DevFlowRunHandle {
  id: string;
  createdAt: string;
  paths: {
    runDirectory: string;
  };
}

export interface DevFlowState {
  config: {
    load(): Promise<DevFlowConfig | undefined>;
    save(config: DevFlowConfig): Promise<void>;
  };
  readProjectContext(): Promise<string | undefined>;
  writeProjectContext(content: string): Promise<void>;
  createRun(): Promise<DevFlowRunHandle>;
}

export class InvalidDevFlowConfigError extends Error {
  readonly configPath: string;

  constructor(configPath: string, details: string) {
    super(`Invalid DevFlow config at ${configPath}. ${details}`);
    this.name = "InvalidDevFlowConfigError";
    this.configPath = configPath;
  }
}

export class InvalidDevFlowRunIdError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `Invalid DevFlow run id "${runId}". Run ids must be lowercase alphanumeric strings with exactly ${DEVFLOW_RUN_ID_LENGTH} characters.`,
    );
    this.name = "InvalidDevFlowRunIdError";
    this.runId = runId;
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

function getRunsDirectoryPath(projectRoot: string): string {
  return join(projectRoot, DEVFLOW_STATE_DIRECTORY, DEVFLOW_RUNS_DIRECTORY);
}

function getRunDirectoryPath(projectRoot: string, runId: string): string {
  return join(getRunsDirectoryPath(projectRoot), runId);
}

function getRunMetadataPath(projectRoot: string, runId: string): string {
  return join(
    getRunDirectoryPath(projectRoot, runId),
    DEVFLOW_RUN_METADATA_FILENAME,
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

function createOpaqueRunId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, DEVFLOW_RUN_ID_LENGTH);
}

function assertValidRunId(runId: string): void {
  if (!devFlowRunIdPattern.test(runId)) {
    throw new InvalidDevFlowRunIdError(runId);
  }
}

async function createRun(projectRoot: string): Promise<DevFlowRunHandle> {
  const runId = createOpaqueRunId();
  assertValidRunId(runId);

  const createdAt = new Date().toISOString();
  const runDirectory = getRunDirectoryPath(projectRoot, runId);
  const runMetadataPath = getRunMetadataPath(projectRoot, runId);

  await fs.ensureDir(runDirectory);
  await fs.writeJson(
    runMetadataPath,
    {
      id: runId,
      createdAt,
    },
    { spaces: 2 },
  );

  return {
    id: runId,
    createdAt,
    paths: {
      runDirectory,
    },
  };
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
    createRun: () => createRun(options.projectRoot),
  };
}

export function formatInvalidDevFlowConfigError(
  error: InvalidDevFlowConfigError,
): string {
  return `${error.message} Delete or repair the config file before running DevFlow again.`;
}
