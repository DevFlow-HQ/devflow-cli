import fs from "fs-extra";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";

import { execa } from "execa";
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
const projectContextMaxAgeMilliseconds = 3 * 24 * 60 * 60 * 1000;
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

const projectContextFreshnessMetadataSchema = projectContextMetadataSchema.extend({
  contextVersion: z.number().int(),
});

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

export interface ProjectContextWriteOptions {
  refreshReason: ProjectContextRefreshReason;
}

export interface DevFlowClock {
  now(): Date;
}

export type GitChangedPathStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked";

export interface GitChangedPath {
  path: string;
  status: GitChangedPathStatus;
  previousPath?: string;
}

export type GitBaselineChanges =
  | {
      status: "available";
      changedPaths: GitChangedPath[];
    }
  | {
      status: "baseline-unavailable";
    };

export type GitUntrackedFile =
  | {
      path: string;
      status: "untracked";
      content: Buffer;
    }
  | {
      path: string;
      status: "untracked";
      contentPath: string;
      byteLength: number;
    };

export interface GitDirtyState {
  staged: GitChangedPath[];
  stagedDiff: Buffer;
  unstaged: GitChangedPath[];
  unstagedDiff: Buffer;
  untracked: GitUntrackedFile[];
}

export interface GitProjectContextProbe {
  isRepository(projectRoot: string): Promise<boolean>;
  getCurrentHead(projectRoot: string): Promise<string | null>;
  getCommittedChangesSince(
    projectRoot: string,
    baseline: string,
  ): Promise<GitBaselineChanges>;
  getDirtyState(projectRoot: string): Promise<GitDirtyState>;
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
      changedPaths?: GitChangedPath[];
    };

export interface CreateDevFlowStateOptions {
  projectRoot: string;
  clock?: DevFlowClock;
  gitProbe?: GitProjectContextProbe;
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
    write(
      content: string,
      metadataOrOptions?: ProjectContextMetadata | ProjectContextWriteOptions,
    ): Promise<void>;
    readMetadata(): Promise<ProjectContextMetadata | undefined>;
    checkFreshness(): Promise<ProjectContextFreshness>;
  };
  readProjectContext(): Promise<string | undefined>;
  writeProjectContext(
    content: string,
    metadataOrOptions?: ProjectContextMetadata | ProjectContextWriteOptions,
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

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isIgnoredProjectContextPath(path: string): boolean {
  const normalizedPath = normalizeGitPath(path).replace(/^\/+/, "");
  const pathSegments = normalizedPath.split("/");
  const [firstSegment] = pathSegments;

  if (
    firstSegment === undefined ||
    [".devflow", ".agent", ".agents", ".codex", ".git"].includes(firstSegment)
  ) {
    return true;
  }

  return false;
}

function isRelevantChangedPath(changedPath: GitChangedPath): boolean {
  return (
    !isIgnoredProjectContextPath(changedPath.path) &&
    (changedPath.previousPath === undefined ||
      !isIgnoredProjectContextPath(changedPath.previousPath))
  );
}

function filterRelevantChangedPaths(
  changedPaths: GitChangedPath[],
): GitChangedPath[] {
  return changedPaths.filter(isRelevantChangedPath);
}

function filterRelevantDirtyState(dirtyState: GitDirtyState): GitDirtyState {
  const staged = filterRelevantChangedPaths(dirtyState.staged);
  const unstaged = filterRelevantChangedPaths(dirtyState.unstaged);
  const untracked = dirtyState.untracked.filter((file) =>
    isRelevantChangedPath(file),
  );

  return {
    staged,
    stagedDiff: staged.length === 0 ? Buffer.alloc(0) : dirtyState.stagedDiff,
    unstaged,
    unstagedDiff:
      unstaged.length === 0 ? Buffer.alloc(0) : dirtyState.unstagedDiff,
    untracked,
  };
}

function getDirtyChangedPaths(dirtyState: GitDirtyState): GitChangedPath[] {
  return [
    ...dirtyState.staged,
    ...dirtyState.unstaged,
    ...dirtyState.untracked.map(({ path, status }) => ({ path, status })),
  ];
}

function mapGitChangedPathStatus(statusCode: string): GitChangedPathStatus {
  switch (statusCode) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "modified";
  }
}

function parseGitNameStatus(output: string): GitChangedPath[] {
  if (output.trim().length === 0) {
    return [];
  }

  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const changedPaths: GitChangedPath[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const rawStatusCode = entries[index] ?? "M";
    const status = mapGitChangedPathStatus(rawStatusCode.slice(0, 1));
    const firstPath = entries[index + 1];

    if (firstPath === undefined) {
      break;
    }

    if (status === "renamed" || status === "copied") {
      const nextPath = entries[index + 2];

      if (nextPath === undefined) {
        break;
      }

      changedPaths.push({
        path: normalizeGitPath(nextPath),
        previousPath: normalizeGitPath(firstPath),
        status,
      });
      index += 2;
      continue;
    }

    changedPaths.push({
      path: normalizeGitPath(firstPath),
      status,
    });
    index += 1;
  }

  return changedPaths;
}

async function runGit(
  projectRoot: string,
  args: string[],
): Promise<string> {
  const result = await execa("git", args, {
    cwd: projectRoot,
    reject: true,
  });

  return result.stdout;
}

async function runGitBuffer(
  projectRoot: string,
  args: string[],
): Promise<Buffer> {
  const result = await execa("git", args, {
    cwd: projectRoot,
    encoding: "buffer",
    reject: true,
  });

  return Buffer.from(result.stdout);
}

async function mapWithConcurrency<Input, Output>(
  inputs: Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= inputs.length) {
        return;
      }

      results[currentIndex] = await mapper(inputs[currentIndex]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, inputs.length) },
      async () => worker(),
    ),
  );

  return results;
}

export function createDefaultGitProjectContextProbe(): GitProjectContextProbe {
  return {
    async isRepository(projectRoot) {
      try {
        await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
        return true;
      } catch {
        return false;
      }
    },
    async getCurrentHead(projectRoot) {
      try {
        return await runGit(projectRoot, ["rev-parse", "HEAD"]);
      } catch {
        return null;
      }
    },
    async getCommittedChangesSince(projectRoot, baseline) {
      try {
        const output = await runGit(projectRoot, [
          "diff",
          "--name-status",
          "-z",
          `${baseline}..HEAD`,
        ]);

        return {
          status: "available",
          changedPaths: parseGitNameStatus(output),
        };
      } catch {
        return {
          status: "baseline-unavailable",
        };
      }
    },
    async getDirtyState(projectRoot) {
      const staged = parseGitNameStatus(
        await runGit(projectRoot, [
          "diff",
          "--cached",
          "--name-status",
          "-z",
        ]),
      );
      const stagedDiff = await runGitBuffer(projectRoot, [
        "diff",
        "--cached",
        "--binary",
      ]);
      const unstaged = parseGitNameStatus(
        await runGit(projectRoot, ["diff", "--name-status", "-z"]),
      );
      const unstagedDiff = await runGitBuffer(projectRoot, [
        "diff",
        "--binary",
      ]);
      const untrackedOutput = await runGit(projectRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      const untrackedPaths = untrackedOutput
        .split("\0")
        .filter((path) => path.length > 0)
        .map(normalizeGitPath)
        .filter((path) => isRelevantChangedPath({ path, status: "untracked" }));
      const untracked = await mapWithConcurrency(
        untrackedPaths,
        8,
        async (path) => {
          const contentPath = join(projectRoot, path);
          const stats = await fs.stat(contentPath);

          return {
            path,
            status: "untracked" as const,
            contentPath,
            byteLength: stats.size,
          };
        },
      );

      return { staged, stagedDiff, unstaged, unstagedDiff, untracked };
    },
  };
}

function updateHashWithLengthPrefixedBuffer(
  hash: crypto.Hash,
  label: string,
  content: Buffer,
): void {
  hash.update(`${label}\0${content.byteLength}\0`);
  hash.update(content);
  hash.update("\0");
}

async function updateHashWithLengthPrefixedFile(
  hash: crypto.Hash,
  label: string,
  contentPath: string,
  byteLength: number,
): Promise<void> {
  hash.update(`${label}\0${byteLength}\0`);

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(contentPath);

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      hash.update("\0");
      resolve();
    });
  });
}

function sortedChangedPaths(changedPaths: GitChangedPath[]): GitChangedPath[] {
  return [...changedPaths].sort((left, right) => {
    const leftKey = `${left.status}\0${left.previousPath ?? ""}\0${left.path}`;
    const rightKey = `${right.status}\0${right.previousPath ?? ""}\0${right.path}`;

    return leftKey.localeCompare(rightKey);
  });
}

async function computeGitDirtyFingerprint(
  dirtyState: GitDirtyState,
): Promise<string | null> {
  if (
    dirtyState.staged.length === 0 &&
    dirtyState.stagedDiff.length === 0 &&
    dirtyState.unstaged.length === 0 &&
    dirtyState.unstagedDiff.length === 0 &&
    dirtyState.untracked.length === 0
  ) {
    return null;
  }

  const hash = crypto.createHash("sha1");

  for (const [scope, changedPaths] of [
    ["staged-status", dirtyState.staged],
    ["unstaged-status", dirtyState.unstaged],
  ] as const) {
    for (const changedPath of sortedChangedPaths(changedPaths)) {
      hash.update(
        `${scope}\0${changedPath.status}\0${changedPath.previousPath ?? ""}\0${changedPath.path}\0`,
      );
    }
  }

  updateHashWithLengthPrefixedBuffer(hash, "staged-diff", dirtyState.stagedDiff);
  updateHashWithLengthPrefixedBuffer(
    hash,
    "unstaged-diff",
    dirtyState.unstagedDiff,
  );

  for (const untrackedFile of [...dirtyState.untracked].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    if ("content" in untrackedFile) {
      updateHashWithLengthPrefixedBuffer(
        hash,
        `untracked\0${untrackedFile.path}`,
        untrackedFile.content,
      );
      continue;
    }

    await updateHashWithLengthPrefixedFile(
      hash,
      `untracked\0${untrackedFile.path}`,
      untrackedFile.contentPath,
      untrackedFile.byteLength,
    );
  }

  return `dirty-${hash.digest("hex").slice(0, 16)}`;
}

function isProjectContextMetadata(
  metadataOrOptions: ProjectContextMetadata | ProjectContextWriteOptions,
): metadataOrOptions is ProjectContextMetadata {
  return "generatedAt" in metadataOrOptions;
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

async function readProjectContextMetadataForFreshness(
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

  const result = projectContextFreshnessMetadataSchema.safeParse(parsedMetadata);

  if (!result.success) {
    throw new InvalidProjectContextMetadataError(
      metadataPath,
      formatValidationDetails(result.error),
    );
  }

  return result.data.contextVersion === DEVFLOW_PROJECT_CONTEXT_VERSION
    ? validateProjectContextMetadata(metadataPath, result.data)
    : result.data;
}

async function writeProjectContext(
  projectRoot: string,
  content: string,
  metadataOrOptions: ProjectContextMetadata | ProjectContextWriteOptions | undefined,
  clock: DevFlowClock,
  gitProbe: GitProjectContextProbe,
): Promise<void> {
  const projectContextPath = getProjectContextPath(projectRoot);
  const projectContextMetadataPath = getProjectContextMetadataPath(projectRoot);
  const stateDirectory = join(projectRoot, DEVFLOW_STATE_DIRECTORY);
  const metadata =
    metadataOrOptions === undefined
      ? undefined
      : isProjectContextMetadata(metadataOrOptions)
        ? metadataOrOptions
        : await createProjectContextRefreshMetadata(
            projectRoot,
            metadataOrOptions.refreshReason,
            clock,
            gitProbe,
          );
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

async function createProjectContextRefreshMetadata(
  projectRoot: string,
  refreshReason: ProjectContextRefreshReason,
  clock: DevFlowClock,
  gitProbe: GitProjectContextProbe,
): Promise<ProjectContextMetadata> {
  const generatedAt = clock.now().toISOString();
  const baseMetadata = {
    generatedAt,
    contextVersion: DEVFLOW_PROJECT_CONTEXT_VERSION,
    refreshReason,
  };

  if (!(await gitProbe.isRepository(projectRoot))) {
    return {
      ...baseMetadata,
      gitHead: null,
      dirtyFingerprint: null,
    };
  }

  const dirtyState = filterRelevantDirtyState(
    await gitProbe.getDirtyState(projectRoot),
  );

  return {
    ...baseMetadata,
    gitHead: await gitProbe.getCurrentHead(projectRoot),
    dirtyFingerprint: await computeGitDirtyFingerprint(dirtyState),
  };
}

async function checkProjectContextFreshness(
  projectRoot: string,
  clock: DevFlowClock,
  gitProbe: GitProjectContextProbe,
): Promise<ProjectContextFreshness> {
  const context = await readProjectContext(projectRoot);

  if (context === undefined) {
    return {
      status: "stale",
      refreshReason: "missing-context",
    };
  }

  try {
    const metadata = await readProjectContextMetadataForFreshness(projectRoot);

    if (metadata === undefined) {
      return {
        status: "stale",
        refreshReason: "missing-metadata",
        context,
      };
    }

    if (metadata.contextVersion !== DEVFLOW_PROJECT_CONTEXT_VERSION) {
      return {
        status: "stale",
        refreshReason: "context-version-changed",
        context,
      };
    }

    const generatedAt = new Date(metadata.generatedAt).getTime();

    if (
      clock.now().getTime() - generatedAt >
      projectContextMaxAgeMilliseconds
    ) {
      return {
        status: "stale",
        refreshReason: "max-age-exceeded",
        context,
        metadata,
      };
    }

    if (metadata.gitHead !== null) {
      const isRepository = await gitProbe.isRepository(projectRoot);

      if (!isRepository) {
        return {
          status: "stale",
          refreshReason: "baseline-unavailable",
          context,
          metadata,
        };
      }

      const currentHead = await gitProbe.getCurrentHead(projectRoot);

      if (currentHead === null) {
        return {
          status: "stale",
          refreshReason: "baseline-unavailable",
          context,
          metadata,
        };
      }

      const committedChanges = await gitProbe.getCommittedChangesSince(
        projectRoot,
        metadata.gitHead,
      );

      if (committedChanges.status === "baseline-unavailable") {
        return {
          status: "stale",
          refreshReason: "baseline-unavailable",
          context,
          metadata,
        };
      }

      const relevantCommittedChanges = filterRelevantChangedPaths(
        committedChanges.changedPaths,
      );

      if (relevantCommittedChanges.length > 0) {
        return {
          status: "stale",
          refreshReason: "relevant-changes",
          context,
          metadata,
          changedPaths: relevantCommittedChanges,
        };
      }

      const dirtyState = filterRelevantDirtyState(
        await gitProbe.getDirtyState(projectRoot),
      );
      const dirtyFingerprint = await computeGitDirtyFingerprint(dirtyState);

      if (dirtyFingerprint !== metadata.dirtyFingerprint) {
        return {
          status: "stale",
          refreshReason: "relevant-changes",
          context,
          metadata,
          changedPaths: getDirtyChangedPaths(dirtyState),
        };
      }
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

async function createRun(
  projectRoot: string,
  clock: DevFlowClock,
): Promise<DevFlowRunHandle> {
  const runId = createOpaqueRunId();
  assertValidRunId(runId);

  const createdAt = clock.now().toISOString();
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
  const clock = options.clock ?? { now: () => new Date() };
  const gitProbe = options.gitProbe ?? createDefaultGitProjectContextProbe();

  return {
    config: {
      load: () => loadConfig(options.projectRoot),
      save: (config) => saveConfig(options.projectRoot, config),
    },
    projectContext: {
      read: () => readProjectContext(options.projectRoot),
      write: (content, metadataOrOptions) =>
        writeProjectContext(
          options.projectRoot,
          content,
          metadataOrOptions,
          clock,
          gitProbe,
        ),
      readMetadata: () => readProjectContextMetadata(options.projectRoot),
      checkFreshness: () =>
        checkProjectContextFreshness(options.projectRoot, clock, gitProbe),
    },
    readProjectContext: () => readProjectContext(options.projectRoot),
    writeProjectContext: (content, metadataOrOptions) =>
      writeProjectContext(
        options.projectRoot,
        content,
        metadataOrOptions,
        clock,
        gitProbe,
      ),
    createRun: () => createRun(options.projectRoot, clock),
  };
}

export function formatInvalidDevFlowConfigError(
  error: InvalidDevFlowConfigError,
): string {
  return `${error.message} Delete or repair the config file before running DevFlow again.`;
}
