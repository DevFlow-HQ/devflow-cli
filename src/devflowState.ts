import fs from "fs-extra";
import crypto from "node:crypto";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  BUILT_IN_PROVIDER_IDS,
  type BuiltInProviderId,
} from "./adapters/providers.js";

const DEVFLOW_STATE_DIRECTORY = ".devflow";
const DEVFLOW_CONFIG_FILENAME = "config.json";
const DEVFLOW_PROJECT_CONTEXT_FILENAME = "project-context.md";
const DEVFLOW_PROJECT_CONTEXT_METADATA_FILENAME = "project-context.meta.json";
const DEVFLOW_RUNS_DIRECTORY = "runs";
const DEVFLOW_RUN_METADATA_FILENAME = "run.json";
const DEVFLOW_RUN_INTENT_FILENAME = "intent.json";
const DEVFLOW_RUN_PRD_FILENAME = "prd.md";
const DEVFLOW_RUN_VALIDATION_FILENAME = "validation.json";
const DEVFLOW_RUN_ISSUES_DIRECTORY = "issues";
const DEVFLOW_RUN_ID_LENGTH = 12;
const devFlowRunIdPattern = /^[a-z0-9]{12}$/;
const devFlowIssueSlugAllowedPattern = /^[A-Za-z0-9 _-]+$/;
const devFlowRunArtifactFilenames = {
  intent: DEVFLOW_RUN_INTENT_FILENAME,
  prd: DEVFLOW_RUN_PRD_FILENAME,
  validation: DEVFLOW_RUN_VALIDATION_FILENAME,
} as const;
const DEVFLOW_PROJECT_CONTEXT_VERSION = 1;
const projectContextLineCap = 150;
const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const gitHeadPattern = /^[0-9a-f]{40}$/;
const dirtyFingerprintPattern = /^dirty-[0-9a-f]{16}$/;
const projectContextRefreshReasons = [
  "missing-context",
  "missing-metadata",
  "metadata-invalid",
  "context-version-changed",
  "max-age-exceeded",
  "baseline-unavailable",
  "relevant-changes",
  "manual",
] as const;

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

const projectContextMetadataSchema = z
  .object({
    generatedAt: z.string().refine(
      (value) => {
        if (!isoDateTimePattern.test(value)) {
          return false;
        }

        const parsedDate = new Date(value);
        return (
          !Number.isNaN(parsedDate.getTime()) &&
          parsedDate.toISOString() === value
        );
      },
      { message: "Must be a valid ISO-8601 UTC timestamp." },
    ),
    gitHead: z.string().regex(gitHeadPattern).nullable(),
    dirtyFingerprint: z.string().regex(dirtyFingerprintPattern).nullable(),
    contextVersion: z.literal(DEVFLOW_PROJECT_CONTEXT_VERSION),
    refreshReason: z.enum(projectContextRefreshReasons),
  })
  .strict();

export interface DevFlowConfig {
  defaultProvider: BuiltInProviderId;
}

export type ProjectContextRefreshReason =
  (typeof projectContextRefreshReasons)[number];

export interface ProjectContextMetadata {
  generatedAt: string;
  gitHead: string | null;
  dirtyFingerprint: string | null;
  contextVersion: number;
  refreshReason: ProjectContextRefreshReason;
}

export type ProjectContextFreshness =
  | {
      status: "fresh";
      context: string;
      metadata: ProjectContextMetadata;
    }
  | {
      status: "stale";
      refreshReason: ProjectContextRefreshReason;
      context?: string;
      metadata?: ProjectContextMetadata;
    };

export interface CreateDevFlowStateOptions {
  projectRoot: string;
}

export interface DevFlowRunHandle {
  id: string;
  createdAt: string;
  writeIntent(content: string): Promise<void>;
  writeIssue(slug: string, content: string): Promise<void>;
  writePrd(content: string): Promise<void>;
  writeValidation(content: string): Promise<void>;
  paths: {
    runDirectory: string;
    intentArtifact: string;
  };
}

export interface DevFlowState {
  config: {
    load(): Promise<DevFlowConfig | undefined>;
    save(config: DevFlowConfig): Promise<void>;
  };
  projectContext: {
    read(): Promise<string | undefined>;
    write(content: string, metadata?: ProjectContextMetadata): Promise<void>;
    readMetadata(): Promise<ProjectContextMetadata | undefined>;
    checkFreshness(): Promise<ProjectContextFreshness>;
  };
  readProjectContext(): Promise<string | undefined>;
  writeProjectContext(
    content: string,
    metadata?: ProjectContextMetadata,
  ): Promise<void>;
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

export class InvalidProjectContextError extends Error {
  constructor(details: string) {
    super(`Invalid project context. ${details}`);
    this.name = "InvalidProjectContextError";
  }
}

export class InvalidProjectContextMetadataError extends Error {
  readonly metadataPath: string;

  constructor(metadataPath: string, details: string) {
    super(`Invalid project context metadata at ${metadataPath}. ${details}`);
    this.name = "InvalidProjectContextMetadataError";
    this.metadataPath = metadataPath;
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

export class InvalidDevFlowIssueSlugError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(
      `Invalid DevFlow issue slug "${slug}". Issue slugs must contain letters, numbers, spaces, underscores, or hyphens and normalize to at least one lowercase alphanumeric segment.`,
    );
    this.name = "InvalidDevFlowIssueSlugError";
    this.slug = slug;
  }
}

export class DuplicateDevFlowRunArtifactError extends Error {
  readonly runId: string;
  readonly artifactName: string;
  readonly artifactPath: string;

  constructor(options: {
    runId: string;
    artifactName: string;
    artifactPath: string;
  }) {
    super(
      `DevFlow run artifact "${options.artifactName}" already exists for run "${options.runId}" at ${options.artifactPath}. Run artifacts are immutable once written.`,
    );
    this.name = "DuplicateDevFlowRunArtifactError";
    this.runId = options.runId;
    this.artifactName = options.artifactName;
    this.artifactPath = options.artifactPath;
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

function getProjectContextMetadataPath(projectRoot: string): string {
  return join(
    projectRoot,
    DEVFLOW_STATE_DIRECTORY,
    DEVFLOW_PROJECT_CONTEXT_METADATA_FILENAME,
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

function getRunArtifactPath(
  projectRoot: string,
  runId: string,
  artifactName: keyof typeof devFlowRunArtifactFilenames,
): string {
  return join(
    getRunDirectoryPath(projectRoot, runId),
    devFlowRunArtifactFilenames[artifactName],
  );
}

function getRunIssueArtifactPath(
  projectRoot: string,
  runId: string,
  normalizedSlug: string,
): string {
  return join(
    getRunDirectoryPath(projectRoot, runId),
    DEVFLOW_RUN_ISSUES_DIRECTORY,
    `${normalizedSlug}.md`,
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

function validateProjectContext(content: string): void {
  if (content.trim().length === 0) {
    throw new InvalidProjectContextError(
      "Project context content must be non-empty.",
    );
  }

  const lineCount = content.split(/\r\n|\r|\n/).length;

  if (lineCount > projectContextLineCap) {
    throw new InvalidProjectContextError(
      `Project context content must be no more than ${projectContextLineCap} lines.`,
    );
  }
}

function validateProjectContextMetadata(
  metadataPath: string,
  metadata: unknown,
): ProjectContextMetadata {
  const result = projectContextMetadataSchema.safeParse(metadata);

  if (!result.success) {
    throw new InvalidProjectContextMetadataError(
      metadataPath,
      formatValidationDetails(result.error),
    );
  }

  return result.data;
}

async function readProjectContextMetadata(
  projectRoot: string,
): Promise<ProjectContextMetadata | undefined> {
  const metadataPath = getProjectContextMetadataPath(projectRoot);
  const metadataExists = await fs.pathExists(metadataPath);

  if (!metadataExists) {
    return undefined;
  }

  let parsedMetadata: unknown;

  try {
    parsedMetadata = await fs.readJson(metadataPath);
  } catch (error) {
    const details =
      error instanceof Error ? error.message : "Metadata file is not valid JSON.";
    throw new InvalidProjectContextMetadataError(metadataPath, details);
  }

  return validateProjectContextMetadata(metadataPath, parsedMetadata);
}

async function writeProjectContext(
  projectRoot: string,
  content: string,
  metadata?: ProjectContextMetadata,
): Promise<void> {
  const projectContextPath = getProjectContextPath(projectRoot);
  const projectContextMetadataPath = getProjectContextMetadataPath(projectRoot);
  const stateDirectory = join(projectRoot, DEVFLOW_STATE_DIRECTORY);
  const validatedMetadata =
    metadata === undefined
      ? undefined
      : validateProjectContextMetadata(projectContextMetadataPath, metadata);

  validateProjectContext(content);
  await fs.ensureDir(stateDirectory);
  await fs.writeFile(projectContextPath, content, "utf8");

  if (validatedMetadata !== undefined) {
    await fs.writeJson(projectContextMetadataPath, validatedMetadata, {
      spaces: 2,
    });
  }
}

async function checkProjectContextFreshness(
  projectRoot: string,
): Promise<ProjectContextFreshness> {
  const context = await readProjectContext(projectRoot);

  if (context === undefined) {
    return {
      status: "stale",
      refreshReason: "missing-context",
    };
  }

  try {
    const metadata = await readProjectContextMetadata(projectRoot);

    if (metadata === undefined) {
      return {
        status: "stale",
        refreshReason: "missing-metadata",
        context,
      };
    }

    return {
      status: "fresh",
      context,
      metadata,
    };
  } catch (error) {
    if (error instanceof InvalidProjectContextMetadataError) {
      return {
        status: "stale",
        refreshReason: "metadata-invalid",
        context,
      };
    }

    throw error;
  }
}

function createOpaqueRunId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, DEVFLOW_RUN_ID_LENGTH);
}

function assertValidRunId(runId: string): void {
  if (!devFlowRunIdPattern.test(runId)) {
    throw new InvalidDevFlowRunIdError(runId);
  }
}

function normalizeIssueSlug(slug: string): string {
  const trimmedSlug = slug.trim();

  if (
    trimmedSlug.length === 0 ||
    !devFlowIssueSlugAllowedPattern.test(trimmedSlug)
  ) {
    throw new InvalidDevFlowIssueSlugError(slug);
  }

  const normalizedSlug = trimmedSlug
    .toLowerCase()
    .replace(/[ _-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (normalizedSlug.length === 0) {
    throw new InvalidDevFlowIssueSlugError(slug);
  }

  return normalizedSlug;
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

  async function writeArtifact(
    artifactName: string,
    artifactPath: string,
    content: string,
  ): Promise<void> {
    try {
      await fs.ensureDir(dirname(artifactPath));
      await fs.writeFile(artifactPath, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new DuplicateDevFlowRunArtifactError({
          runId,
          artifactName,
          artifactPath,
        });
      }

      throw error;
    }
  }

  return {
    id: runId,
    createdAt,
    writeIntent: (content) =>
      writeArtifact(
        "intent",
        getRunArtifactPath(projectRoot, runId, "intent"),
        content,
      ),
    writeIssue: async (slug, content) => {
      const normalizedSlug = normalizeIssueSlug(slug);

      await writeArtifact(
        "issue",
        getRunIssueArtifactPath(projectRoot, runId, normalizedSlug),
        content,
      );
    },
    writePrd: (content) =>
      writeArtifact("prd", getRunArtifactPath(projectRoot, runId, "prd"), content),
    writeValidation: (content) =>
      writeArtifact(
        "validation",
        getRunArtifactPath(projectRoot, runId, "validation"),
        content,
      ),
    paths: {
      runDirectory,
      intentArtifact: getRunArtifactPath(projectRoot, runId, "intent"),
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
    projectContext: {
      read: () => readProjectContext(options.projectRoot),
      write: (content, metadata) =>
        writeProjectContext(options.projectRoot, content, metadata),
      readMetadata: () => readProjectContextMetadata(options.projectRoot),
      checkFreshness: () => checkProjectContextFreshness(options.projectRoot),
    },
    readProjectContext: () => readProjectContext(options.projectRoot),
    writeProjectContext: (content, metadata) =>
      writeProjectContext(options.projectRoot, content, metadata),
    createRun: () => createRun(options.projectRoot),
  };
}

export function formatInvalidDevFlowConfigError(
  error: InvalidDevFlowConfigError,
): string {
  return `${error.message} Delete or repair the config file before running DevFlow again.`;
}
