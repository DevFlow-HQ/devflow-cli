import crypto from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fs from "fs-extra";
import { z } from "zod";

import {
  createDevFlowState,
  type GitChangedPath,
  type DevFlowRunHandle,
  type DevFlowProviderSessionState,
  type DevFlowState,
  InvalidProviderSessionStateError,
  type ProjectContextFreshness,
  type ProjectContextRefreshReason,
  validateProjectContextContent,
} from "./devflowState.js";
import { createBuiltInManagedSessionAdapter } from "./adapters/builtInManagedSessionAdapter.js";
import {
  canResumeManagedProviderSession,
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionPhase,
  type ManagedProviderSessionResumeInput,
  type ManagedProviderSessionResult,
  type ManagedSessionAdapter,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
  ProviderSessionLaunchError,
  ProviderSessionTranscriptCaptureError,
} from "./adapters/managedSessionAdapter.js";
import {
  isBuiltInProviderId,
  type BuiltInProviderId,
} from "./adapters/providers.js";
import { UnsupportedProviderError } from "./bootstrapProvider.js";
import {
  createStructuredGrillTranscriptRecorder,
  stripCompletionMarkers,
  type StructuredGrillTranscriptRecorder,
} from "./grillTranscriptRecorder.js";
import type { Logger } from "./logger.js";

export interface ResolvedExecutionRequest {
  projectRoot: string;
  rawTask: string;
  providerId?: string;
  model?: string;
}

export const PIPELINE_STAGES = [
  "intent",
  "bootstrap",
  "grill",
  "prd",
  "issues",
  "execute",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface RunExecutionRequestOptions {
  devFlowState?: DevFlowState;
  logger?: Logger;
  createManagedSessionAdapter?: (
    providerId: BuiltInProviderId,
  ) => ManagedSessionAdapter;
  onRunCreated?: (run: {
    id: string;
    paths: {
      runDirectory: string;
      prdArtifact: string;
      issuesDirectory: string;
      executionArtifact: string;
    };
  }) => void | Promise<void>;
  onStageStart?: (stage: PipelineStage) => void | Promise<void>;
  onExecutionIteration?: (event: {
    iteration: number;
  }) => void | Promise<void>;
}

export interface RunExecutionRequestResult {
  intent: ManagedProviderSessionResult;
  parsedIntent: IntentArtifact;
  bootstrapProvenance: BootstrapProvenance;
}

const INTENT_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "intent.md",
);
const BOOTSTRAP_PROJECT_CONTEXT_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "bootstrap-project-context.md",
);
const GRILL_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "grill.md",
);
const PRD_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "prd.md",
);
const ISSUES_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "issues.md",
);
const EXECUTE_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "execute.md",
);
const INTENT_STAGE_TOTAL_ATTEMPTS = 2;
const BOOTSTRAP_STAGE_TOTAL_ATTEMPTS = 2;
const GRILL_STAGE_TOTAL_ATTEMPTS = 2;
const PRD_STAGE_TOTAL_ATTEMPTS = 2;
const ISSUES_STAGE_TOTAL_ATTEMPTS = 2;
const TDD_GUIDE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "tdd.md",
);

const intentArtifactSchema = z
  .object({
    classification: z.enum(["feature", "bug", "refactor", "unclear"]),
    summary: z.string().refine((value) => value.trim().length > 0, {
      message: "Must be a non-empty string.",
    }),
    rawTask: z.string().refine((value) => value.trim().length > 0, {
      message: "Must be a non-empty string.",
    }),
    needsClarification: z.boolean(),
  })
  .strict();

export type IntentArtifact = z.infer<typeof intentArtifactSchema>;

const gitExecutionHeadSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .nullable();

const executionStopReasonSchema = z.enum([
  "terminal",
  "no-file",
  "cap",
  "error",
]);

const executionLedgerSchema = z
  .object({
    stage: z.literal("execute"),
    iterations: z
      .array(
        z
          .object({
            iteration: z.number().int().positive(),
            marker: z.string().refine((value) => value.trim().length > 0, {
              message: "Must be a non-empty string.",
            }),
            providerSessionId: z
              .string()
              .refine((value) => value.trim().length > 0, {
                message: "Must be a non-empty string.",
              })
              .optional(),
            gitHeadBefore: gitExecutionHeadSchema,
            gitHeadAfter: gitExecutionHeadSchema,
            finalAssistantMessage: z
              .string()
              .refine((value) => value.trim().length > 0, {
                message: "Must be a non-empty string.",
              })
              .optional(),
          })
          .strict(),
      ),
    final: z
      .object({
        stopReason: executionStopReasonSchema,
        completedIssueFilenames: z.array(z.string()),
        remainingIssueFilenames: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type ExecutionLedger = z.infer<typeof executionLedgerSchema>;

export type BootstrapProvenance =
  | "reused"
  | "generated"
  | "refreshed"
  | "metadata-updated";

export class InvalidIntentArtifactError extends Error {
  readonly artifactPath: string;

  constructor(artifactPath: string, details: string) {
    super(`Invalid intent artifact at ${artifactPath}. ${details}`);
    this.name = "InvalidIntentArtifactError";
    this.artifactPath = artifactPath;
  }
}

export class StageArtifactValidationError extends Error {
  readonly stage: PipelineStage;
  readonly artifactPath: string;

  constructor(options: {
    stage: PipelineStage;
    artifactPath: string;
    details: string;
  }) {
    super(
      `Invalid artifact for stage "${options.stage}" at ${options.artifactPath}. ${options.details}`,
    );
    this.name = "StageArtifactValidationError";
    this.stage = options.stage;
    this.artifactPath = options.artifactPath;
  }
}

export class ProviderStageRetryExhaustedError extends Error {
  readonly stage: PipelineStage;
  readonly providerId?: string;
  readonly attempts: number;
  readonly cause: unknown;

  constructor(options: {
    stage: PipelineStage;
    providerId?: string;
    attempts: number;
    cause: unknown;
  }) {
    const causeMessage =
      options.cause instanceof Error
        ? options.cause.message
        : "Unknown provider-backed stage failure";

    super(
      `Provider-backed stage "${options.stage}" exhausted ${options.attempts} attempts. ${causeMessage}`,
    );
    this.name = "ProviderStageRetryExhaustedError";
    this.stage = options.stage;
    this.providerId = options.providerId;
    this.attempts = options.attempts;
    this.cause = options.cause;
  }
}

export class ExecutionLoopCapError extends Error {
  readonly maxIterations: number;

  constructor(maxIterations: number) {
    super(`Execution loop reached the maximum of ${maxIterations} iterations.`);
    this.name = "ExecutionLoopCapError";
    this.maxIterations = maxIterations;
  }
}

export class MissingProviderIdError extends Error {
  constructor() {
    super("Provider-backed orchestration requires a provider id.");
    this.name = "MissingProviderIdError";
  }
}

async function renderIntentPrompt(options: {
  rawTask: string;
  artifactPath: string;
  completionMarker: string;
}): Promise<string> {
  const promptTemplate = await fs.readFile(INTENT_PROMPT_PATH, "utf8");

  return promptTemplate
    .replaceAll("{{RAW_TASK}}", options.rawTask)
    .replaceAll("{{ARTIFACT_PATH}}", options.artifactPath)
    .replaceAll("{{COMPLETION_MARKER}}", options.completionMarker);
}

async function renderBootstrapProjectContextPrompt(options: {
  candidatePath: string;
  completionMarker: string;
  refreshReason: ProjectContextRefreshReason;
  priorContext?: string;
  changedPaths?: GitChangedPath[];
}): Promise<string> {
  const promptTemplate = await fs.readFile(
    BOOTSTRAP_PROJECT_CONTEXT_PROMPT_PATH,
    "utf8",
  );

  return promptTemplate
    .replaceAll("{{CANDIDATE_PATH}}", options.candidatePath)
    .replaceAll("{{COMPLETION_MARKER}}", options.completionMarker)
    .replaceAll("{{REFRESH_REASON}}", options.refreshReason)
    .replaceAll(
      "{{PRIOR_PROJECT_CONTEXT}}",
      options.priorContext ?? "No prior project context is available.",
    )
    .replaceAll(
      "{{CHANGED_PATHS}}",
      formatChangedPathsForPrompt(options.changedPaths),
    );
}

async function renderGrillPrompt(options: {
  rawTask: string;
  intentArtifact: IntentArtifact;
  intentArtifactPath: string;
  projectContextPath: string;
  partialTranscriptPath?: string;
  completionMarker: string;
}): Promise<string> {
  const promptTemplate = await fs.readFile(GRILL_PROMPT_PATH, "utf8");

  return promptTemplate
    .replaceAll("{{RAW_TASK}}", options.rawTask)
    .replaceAll(
      "{{INTENT_ARTIFACT}}",
      JSON.stringify(options.intentArtifact, null, 2),
    )
    .replaceAll("{{INTENT_ARTIFACT_PATH}}", options.intentArtifactPath)
    .replaceAll("{{PROJECT_CONTEXT_PATH}}", options.projectContextPath)
    .replaceAll(
      "{{CLARIFICATION_CONTEXT}}",
      formatClarificationContext(options.intentArtifact),
    )
    .replaceAll(
      "{{PARTIAL_TRANSCRIPT_CONTEXT}}",
      formatPartialGrillTranscriptContext(options.partialTranscriptPath),
    )
    .replaceAll("{{COMPLETION_MARKER}}", options.completionMarker);
}

function renderInterruptedGrillResumePrompt(options: {
  completionMarker: string;
}): string {
  return [
    "Continue the interrupted grill session.",
    "Rely on the resumed provider context for prior answers instead of asking for a transcript dump.",
    "Ask the next unresolved question one at a time.",
    `When the grill is complete, print only: ${options.completionMarker}`,
  ].join("\n");
}

function renderInterruptedPrdResumePrompt(options: {
  prdArtifactPath: string;
  completionMarker: string;
}): string {
  return [
    "Continue the interrupted PRD synthesis.",
    "",
    "Canonical PRD artifact path:",
    options.prdArtifactPath,
    "",
    "Write or repair only the canonical PRD artifact at that path.",
    "Use the resumed provider context and the completed grill discussion already in this session.",
    "Do not interview the user, write issues, or create alternate PRD files.",
    `When the PRD artifact is valid, print exactly: ${options.completionMarker}`,
  ].join("\n");
}

async function renderPrdPrompt(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  completionMarker: string;
  liveDiscussionAvailable: boolean;
}): Promise<string> {
  const promptTemplate = await fs.readFile(PRD_PROMPT_PATH, "utf8");

  return promptTemplate
    .replaceAll("{{RAW_TASK}}", options.request.rawTask)
    .replaceAll("{{INTENT_ARTIFACT_PATH}}", options.run.paths.intentArtifact)
    .replaceAll(
      "{{PROJECT_CONTEXT_PATH}}",
      options.run.paths.projectContextArtifact,
    )
    .replaceAll(
      "{{LIVE_DISCUSSION_CONTEXT}}",
      options.liveDiscussionAvailable
        ? "A just-completed live grill discussion is available in this provider session. Use it as immediate context, but verify decisions against the persisted transcript path below."
        : "No live provider discussion is available. Use the persisted grill transcript path below as the durable source material.",
    )
    .replaceAll("{{GRILL_TRANSCRIPT_PATH}}", options.run.paths.grillTranscript)
    .replaceAll("{{PRD_ARTIFACT_PATH}}", options.run.paths.prdArtifact)
    .replaceAll("{{COMPLETION_MARKER}}", options.completionMarker);
}

async function renderIssuesPrompt(options: {
  prdArtifactPath: string;
  projectContextPath: string;
  issuesDirectory: string;
  completionMarker: string;
}): Promise<string> {
  const promptTemplate = await fs.readFile(ISSUES_PROMPT_PATH, "utf8");

  return promptTemplate
    .replaceAll("{{PRD_ARTIFACT_PATH}}", options.prdArtifactPath)
    .replaceAll("{{PROJECT_CONTEXT_PATH}}", options.projectContextPath)
    .replaceAll("{{ISSUES_DIRECTORY}}", options.issuesDirectory)
    .replaceAll("{{COMPLETION_MARKER}}", options.completionMarker);
}

export async function renderExecutePrompt(options: {
  issuesDirectory: string;
  recentCommits: string;
  prdArtifactPath: string;
  projectContextPath: string;
  tddGuidePath: string;
  iterationMarker: string;
  terminalMarker: string;
}): Promise<string> {
  const promptTemplate = await fs.readFile(EXECUTE_PROMPT_PATH, "utf8");

  return promptTemplate
    .replaceAll(
      "{{OPEN_ISSUES}}",
      await readOpenIssuesForExecutePrompt(options.issuesDirectory),
    )
    .replaceAll("{{RECENT_COMMITS}}", options.recentCommits)
    .replaceAll("{{PRD_ARTIFACT_PATH}}", options.prdArtifactPath)
    .replaceAll("{{PROJECT_CONTEXT_PATH}}", options.projectContextPath)
    .replaceAll("{{TDD_GUIDE_PATH}}", options.tddGuidePath)
    .replaceAll("{{ITERATION_MARKER}}", options.iterationMarker)
    .replaceAll("{{TERMINAL_MARKER}}", options.terminalMarker);
}

async function readOpenIssuesForExecutePrompt(
  issuesDirectory: string,
): Promise<string> {
  const issueFilenames = (await fs.readdir(issuesDirectory))
    .filter((entry) => entry.endsWith(".md"))
    .sort();

  if (issueFilenames.length === 0) {
    return "No open issue markdown files were found.";
  }

  const issueBlocks = await Promise.all(
    issueFilenames.map(async (issueFilename) => {
      const issuePath = join(issuesDirectory, issueFilename);
      const issueContent = await fs.readFile(issuePath, "utf8");

      return [
        `--- BEGIN ISSUE ${basename(issueFilename)} ---`,
        issueContent.trimEnd(),
        `--- END ISSUE ${basename(issueFilename)} ---`,
      ].join("\n");
    }),
  );

  return issueBlocks.join("\n\n");
}

function renderIntentRepairPrompt(options: {
  artifactPath: string;
  completionMarker: string;
  validationError: Error;
}): string {
  return [
    "Repair only the intent artifact.",
    "",
    `Artifact path: ${options.artifactPath}`,
    "",
    "Validation failure:",
    options.validationError.message,
    "",
    "Replace the artifact with valid JSON matching the required intent schema.",
    `When the artifact is repaired, print exactly: ${options.completionMarker}`,
  ].join("\n");
}

function renderBootstrapProjectContextRepairPrompt(options: {
  candidatePath: string;
  completionMarker: string;
  validationError: Error;
}): string {
  return [
    "Repair only the project-context candidate artifact.",
    "",
    `Candidate path: ${options.candidatePath}`,
    "",
    "Validation failure:",
    options.validationError.message,
    "",
    "Replace the candidate artifact with valid bounded project context Markdown.",
    `When the candidate is repaired, print exactly: ${options.completionMarker}`,
  ].join("\n");
}

function renderPrdRepairPrompt(options: {
  prdArtifactPath: string;
  completionMarker: string;
  validationError: Error;
}): string {
  return [
    "Repair only the canonical PRD artifact.",
    "",
    `Canonical PRD artifact path: ${options.prdArtifactPath}`,
    "",
    "Validation failure:",
    options.validationError.message,
    "",
    "Replace the PRD artifact with non-empty Markdown synthesized from the existing task, intent, project context, and grill transcript.",
    "Do not interview the user, write issues, or create alternate PRD files.",
    `When the PRD artifact is repaired, print exactly: ${options.completionMarker}`,
  ].join("\n");
}

function renderIssuesRepairPrompt(options: {
  issuesDirectory: string;
  completionMarker: string;
  validationError: Error;
}): string {
  return [
    "Repair only the issue decomposition artifacts.",
    "",
    "Issues directory:",
    options.issuesDirectory,
    "",
    "Validation failure:",
    options.validationError.message,
    "",
    "Write at least one non-empty issue markdown file directly to the issues directory.",
    "Do not interview the user, edit the PRD, or create execution/validation artifacts.",
    `When the issue artifacts are repaired, print exactly: ${options.completionMarker}`,
  ].join("\n");
}

function createCompletionMarker(prefix = "DEVFLOW_INTENT_COMPLETE"): string {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function formatChangedPathsForPrompt(changedPaths: GitChangedPath[] | undefined): string {
  if (changedPaths === undefined || changedPaths.length === 0) {
    return "No changed path metadata was provided by freshness.";
  }

  return changedPaths
    .map((changedPath) => {
      const previousPath =
        changedPath.previousPath === undefined
          ? ""
          : ` from ${changedPath.previousPath}`;

      return `- ${changedPath.path} (${changedPath.status}${previousPath})`;
    })
    .join("\n");
}

function formatClarificationContext(intentArtifact: IntentArtifact): string {
  return intentArtifact.needsClarification
    ? "The intent classifier flagged this task as needing clarification. Use that as advisory context for the interview, but do not skip grilling."
    : "The intent classifier did not flag mandatory clarification. Still run the grill interview and validate the plan before continuing.";
}

function formatPartialGrillTranscriptContext(
  partialTranscriptPath: string | undefined,
): string {
  if (partialTranscriptPath === undefined) {
    return "No partial grill transcript exists yet.";
  }

  return [
    `Partial grill transcript path: ${partialTranscriptPath}`,
    "Continue from the answered decisions in that transcript.",
    "Do not repeat resolved questions unless necessary.",
  ].join("\n");
}

function requiresProviderBackedProjectContextRefresh(
  freshness: ProjectContextFreshness,
): freshness is Extract<ProjectContextFreshness, { status: "stale" }> {
  return (
    freshness.status === "stale" &&
    [
      "missing-context",
      "context-version-changed",
      "max-age-exceeded",
      "baseline-unavailable",
      "relevant-changes",
    ].includes(freshness.refreshReason)
  );
}

async function readIntentArtifact(artifactPath: string): Promise<IntentArtifact> {
  let parsedArtifact: unknown;

  try {
    parsedArtifact = await fs.readJson(artifactPath);
  } catch (error) {
    const details =
      error instanceof Error ? error.message : "Artifact is not valid JSON.";
    throw new InvalidIntentArtifactError(artifactPath, details);
  }

  const result = intentArtifactSchema.safeParse(parsedArtifact);

  if (!result.success) {
    throw new InvalidIntentArtifactError(artifactPath, result.error.message);
  }

  return result.data;
}

async function startStage(
  stage: PipelineStage,
  options: RunExecutionRequestOptions,
): Promise<void> {
  await options.onStageStart?.(stage);
}

export function isRetryableProviderBackedStageFailure(error: unknown): boolean {
  if (
    error instanceof InterruptedProviderSessionError ||
    error instanceof ProviderSessionCleanupError
  ) {
    return false;
  }

  return (
    error instanceof IncompleteProviderSessionError ||
    error instanceof ProviderSessionLaunchError ||
    error instanceof ProviderSessionEventCaptureError ||
    error instanceof ProviderSessionTranscriptCaptureError ||
    error instanceof StageArtifactValidationError
  );
}

export async function runProviderBackedStageWithRetry<T>(options: {
  stage: PipelineStage;
  providerId?: string;
  totalAttempts: number;
  runAttempt(attempt: number): Promise<T>;
  cleanupBeforeRetry(): Promise<void>;
}): Promise<T> {
  for (let attempt = 1; attempt <= options.totalAttempts; attempt += 1) {
    try {
      return await options.runAttempt(attempt);
    } catch (error) {
      if (!isRetryableProviderBackedStageFailure(error)) {
        throw error;
      }

      if (attempt >= options.totalAttempts) {
        if (options.totalAttempts === 1) {
          throw error;
        }

        throw new ProviderStageRetryExhaustedError({
          stage: options.stage,
          providerId: options.providerId,
          attempts: options.totalAttempts,
          cause: error,
        });
      }

      await options.cleanupBeforeRetry();
    }
  }

  throw new Error("Provider-backed stage retry loop ended without a result.");
}

async function runIntentStage(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  attempt: number;
}): Promise<ManagedProviderSessionResult> {
  const completionMarker = createCompletionMarker();
  const repairCompletionMarker = createCompletionMarker(
    "DEVFLOW_INTENT_REPAIR_COMPLETE",
  );
  const prompt = await renderIntentPrompt({
    rawTask: options.request.rawTask,
    artifactPath: options.run.paths.intentArtifact,
    completionMarker,
  });

  return runManagedSessionWithProviderState({
    run: options.run,
    adapter: options.adapter,
    input: {
      workingDirectory: options.request.projectRoot,
      initialPrompt: prompt,
      initialCompletionMarker: completionMarker,
      phase: createProviderSessionPhase({
        run: options.run,
        kind: "intent",
        attempt: options.attempt,
      }),
      ...(options.request.model ? { model: options.request.model } : {}),
      async validate() {
        await readIntentArtifact(options.run.paths.intentArtifact);
      },
      repair: {
        phase: createProviderSessionPhase({
          run: options.run,
          kind: "intent-repair",
          attempt: options.attempt,
        }),
        completionMarker: repairCompletionMarker,
        renderPrompt(validationError) {
          return renderIntentRepairPrompt({
            artifactPath: options.run.paths.intentArtifact,
            completionMarker: repairCompletionMarker,
            validationError,
          });
        },
        mapFailure(validationError) {
          return new StageArtifactValidationError({
            stage: "intent",
            artifactPath: options.run.paths.intentArtifact,
            details: validationError.message,
          });
        },
      },
    },
  });
}

async function parseStageIntentArtifact(
  artifactPath: string,
): Promise<IntentArtifact> {
  try {
    return await readIntentArtifact(artifactPath);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "intent",
      artifactPath,
      details,
    });
  }
}

async function readValidProjectContextCandidate(
  candidatePath: string,
): Promise<string> {
  let candidate: string;

  try {
    candidate = await fs.readFile(candidatePath, "utf8");
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "bootstrap",
      artifactPath: candidatePath,
      details,
    });
  }

  try {
    validateProjectContextContent(candidate);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "bootstrap",
      artifactPath: candidatePath,
      details,
    });
  }

  return candidate;
}

async function validatePrdArtifact(artifactPath: string): Promise<void> {
  let content: string;

  try {
    content = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "prd",
      artifactPath,
      details,
    });
  }

  if (content.trim().length === 0) {
    throw new StageArtifactValidationError({
      stage: "prd",
      artifactPath,
      details: "PRD artifact must contain non-whitespace content.",
    });
  }
}

export async function validateIssueArtifacts(
  issuesDirectory: string,
): Promise<void> {
  let entries: string[];

  try {
    entries = await fs.readdir(issuesDirectory);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "issues",
      artifactPath: issuesDirectory,
      details,
    });
  }

  const markdownFiles = entries.filter((entry) => entry.endsWith(".md"));

  for (const markdownFile of markdownFiles) {
    const issuePath = join(issuesDirectory, markdownFile);
    const content = await fs.readFile(issuePath, "utf8");

    if (content.trim().length > 0) {
      return;
    }
  }

  throw new StageArtifactValidationError({
    stage: "issues",
    artifactPath: issuesDirectory,
    details: "Issues directory must contain at least one non-empty markdown file.",
  });
}

export async function validateExecutionArtifact(
  artifactPath: string,
): Promise<void> {
  await readExecutionLedger(artifactPath);
}

export async function readExecutionLedger(
  artifactPath: string,
): Promise<ExecutionLedger> {
  let parsedArtifact: unknown;

  try {
    parsedArtifact = await fs.readJson(artifactPath);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "execute",
      artifactPath,
      details,
    });
  }

  const result = executionLedgerSchema.safeParse(parsedArtifact);

  if (!result.success) {
    throw new StageArtifactValidationError({
      stage: "execute",
      artifactPath,
      details: result.error.message,
    });
  }

  return result.data;
}

async function hasValidPrdArtifact(artifactPath: string): Promise<boolean> {
  try {
    await validatePrdArtifact(artifactPath);
    return true;
  } catch (error) {
    if (error instanceof StageArtifactValidationError) {
      return false;
    }

    throw error;
  }
}

async function runBootstrapStage(options: {
  devFlowState: DevFlowState;
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  attempt: number;
}): Promise<BootstrapProvenance> {
  const freshness = await options.devFlowState.projectContext.checkFreshness();

  if (freshness.status === "fresh") {
    return "reused";
  }

  if (
    (freshness.refreshReason === "missing-metadata" ||
      freshness.refreshReason === "metadata-invalid") &&
    freshness.context !== undefined
  ) {
    await options.devFlowState.projectContext.write(freshness.context, {
      refreshReason: freshness.refreshReason,
    });
    return "metadata-updated";
  }

  if (requiresProviderBackedProjectContextRefresh(freshness)) {
    const completionMarker = createCompletionMarker(
      "DEVFLOW_BOOTSTRAP_PROJECT_CONTEXT_COMPLETE",
    );
    const repairCompletionMarker = createCompletionMarker(
      "DEVFLOW_BOOTSTRAP_PROJECT_CONTEXT_REPAIR_COMPLETE",
    );
    const prompt = await renderBootstrapProjectContextPrompt({
      candidatePath: options.run.paths.projectContextCandidate,
      completionMarker,
      refreshReason: freshness.refreshReason,
      priorContext: freshness.context,
      changedPaths: freshness.changedPaths,
    });

    await runManagedSessionWithProviderState({
      run: options.run,
      adapter: options.adapter,
      input: {
        workingDirectory: options.request.projectRoot,
        initialPrompt: prompt,
        initialCompletionMarker: completionMarker,
        phase: createProviderSessionPhase({
          run: options.run,
          kind: "bootstrap",
          attempt: options.attempt,
        }),
        ...(options.request.model ? { model: options.request.model } : {}),
        async validate() {
          await readValidProjectContextCandidate(
            options.run.paths.projectContextCandidate,
          );
        },
        repair: {
          phase: createProviderSessionPhase({
            run: options.run,
            kind: "bootstrap-repair",
            attempt: options.attempt,
          }),
          completionMarker: repairCompletionMarker,
          renderPrompt(validationError) {
            return renderBootstrapProjectContextRepairPrompt({
              candidatePath: options.run.paths.projectContextCandidate,
              completionMarker: repairCompletionMarker,
              validationError,
            });
          },
          mapFailure(validationError) {
            return new StageArtifactValidationError({
              stage: "bootstrap",
              artifactPath: options.run.paths.projectContextCandidate,
              details: validationError.message,
            });
          },
        },
      },
    });

    const candidate = await readValidProjectContextCandidate(
      options.run.paths.projectContextCandidate,
    );

    await options.devFlowState.projectContext.write(candidate, {
      refreshReason: freshness.refreshReason,
    });
    try {
      await fs.remove(options.run.paths.projectContextCandidate);
    } catch {
      // A persisted project context is the durable success condition; leaving
      // the run-scoped candidate behind should not fail bootstrap.
    }

    return freshness.refreshReason === "missing-context"
      ? "generated"
      : "refreshed";
  }

  return "reused";
}

function createPrdCompletionMarker(): string {
  return createCompletionMarker("DEVFLOW_PRD_COMPLETE");
}

function createPrdRepairCompletionMarker(): string {
  return createCompletionMarker("DEVFLOW_PRD_REPAIR_COMPLETE");
}

function createIssuesRepairCompletionMarker(): string {
  return createCompletionMarker("DEVFLOW_ISSUES_REPAIR_COMPLETE");
}

function createProviderSessionPhase(options: {
  run: DevFlowRunHandle;
  kind: string;
  attempt: number;
}): ManagedProviderSessionPhase {
  return {
    id: `${options.run.id}:${options.kind}:attempt-${options.attempt}`,
    kind: options.kind,
    attempt: options.attempt,
  };
}

function listManagedSessionPhases(
  input: ManagedProviderSessionInput,
): ManagedProviderSessionPhase[] {
  return [
    input.phase,
    input.repair?.phase,
    ...(input.continuations ?? []).flatMap((continuation) => [
      continuation.phase,
      continuation.repair?.phase,
    ]),
  ].filter((phase): phase is ManagedProviderSessionPhase => phase !== undefined);
}

function findProviderEventPhase(options: {
  input: ManagedProviderSessionInput;
  event: ManagedProviderSessionEvent;
}): ManagedProviderSessionPhase | undefined {
  if (options.event.phaseId === undefined) {
    return options.input.phase;
  }

  return listManagedSessionPhases(options.input).find(
    (phase) => phase.id === options.event.phaseId,
  );
}

async function persistProviderSessionStateFromEvent(options: {
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  input: ManagedProviderSessionInput;
  event: ManagedProviderSessionEvent;
}): Promise<void> {
  if (
    !options.adapter.capabilities?.supportsProviderSessionId ||
    options.event.providerSessionId === undefined
  ) {
    return;
  }

  const phase = findProviderEventPhase({
    input: options.input,
    event: options.event,
  });

  if (phase === undefined) {
    return;
  }

  const now = new Date().toISOString();
  const existingState = await options.run.readProviderSessionState();
  const preservesExistingStart =
    existingState?.provider.id === options.adapter.provider.id &&
    existingState.providerSessionId === options.event.providerSessionId;

  await options.run.writeProviderSessionState({
    provider: options.adapter.provider,
    providerSessionId: options.event.providerSessionId,
    phase,
    status: options.event.type === "session-completed" ? "completed" : "active",
    startedAt: preservesExistingStart ? existingState.startedAt : now,
    updatedAt: now,
  });
}

async function runManagedSessionWithProviderState(options: {
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  input: ManagedProviderSessionInput;
}): Promise<ManagedProviderSessionResult> {
  const existingOnProviderEvent = options.input.onProviderEvent;

  return options.adapter.runSession({
    ...options.input,
    async onProviderEvent(event) {
      await persistProviderSessionStateFromEvent({
        run: options.run,
        adapter: options.adapter,
        input: options.input,
        event,
      });
      await existingOnProviderEvent?.(event);
    },
  });
}

async function resumeManagedSessionWithProviderState(options: {
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter & {
    resumeSession(
      input: ManagedProviderSessionResumeInput,
    ): Promise<ManagedProviderSessionResult>;
  };
  input: ManagedProviderSessionResumeInput;
}): Promise<ManagedProviderSessionResult> {
  const existingOnProviderEvent = options.input.onProviderEvent;

  return options.adapter.resumeSession({
    ...options.input,
    async onProviderEvent(event) {
      await persistProviderSessionStateFromEvent({
        run: options.run,
        adapter: options.adapter,
        input: options.input,
        event,
      });
      await existingOnProviderEvent?.(event);
    },
  });
}

function createPrdRepairConfig(options: {
  run: DevFlowRunHandle;
  completionMarker: string;
  attempt: number;
}) {
  return {
    phase: createProviderSessionPhase({
      run: options.run,
      kind: "prd-repair",
      attempt: options.attempt,
    }),
    completionMarker: options.completionMarker,
    renderPrompt(validationError: Error) {
      return renderPrdRepairPrompt({
        prdArtifactPath: options.run.paths.prdArtifact,
        completionMarker: options.completionMarker,
        validationError,
      });
    },
    mapFailure(validationError: Error) {
      return new StageArtifactValidationError({
        stage: "prd",
        artifactPath: options.run.paths.prdArtifact,
        details: validationError.message,
      });
    },
  };
}

function createIssuesRepairConfig(options: {
  run: DevFlowRunHandle;
  completionMarker: string;
  attempt: number;
}) {
  return {
    phase: createProviderSessionPhase({
      run: options.run,
      kind: "issues-repair",
      attempt: options.attempt,
    }),
    completionMarker: options.completionMarker,
    renderPrompt(validationError: Error) {
      return renderIssuesRepairPrompt({
        issuesDirectory: options.run.paths.issuesDirectory,
        completionMarker: options.completionMarker,
        validationError,
      });
    },
    mapFailure(validationError: Error) {
      return new StageArtifactValidationError({
        stage: "issues",
        artifactPath: options.run.paths.issuesDirectory,
        details: validationError.message,
      });
    },
  };
}

async function writeCompletedGrillArtifacts(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  recorder?: StructuredGrillTranscriptRecorder;
}): Promise<void> {
  try {
    if (options.recorder) {
      await options.recorder.acceptCompletion();
    } else {
      await options.run.completeGrillTranscript();
    }

    await options.run.writeGrillCheckpoint(
      createGrillCheckpoint({
        request: options.request,
        run: options.run,
      }),
    );
  } catch (error) {
    if (error instanceof ProviderSessionTranscriptCaptureError) {
      throw error;
    }

    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "grill",
      artifactPath: options.run.paths.grillTranscript,
      details,
    });
  }
}

function supportsStructuredGrillTranscriptCapture(
  adapter: ManagedSessionAdapter,
): boolean {
  return (
    adapter.capabilities?.eventSource !== undefined &&
    adapter.capabilities.eventSource !== "pty" &&
    adapter.capabilities.classifiesSubmittedUserMessageOrigin
  );
}

function createGrillCheckpoint(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
}) {
  return {
    stage: "grill" as const,
    status: "complete" as const,
    completedAt: new Date().toISOString(),
    rawTask: options.request.rawTask,
    intentArtifactPath: options.run.paths.intentArtifact,
    projectContextPath: options.run.paths.projectContextArtifact,
    grillTranscriptPath: options.run.paths.grillTranscript,
    prdArtifactPath: options.run.paths.prdArtifact,
  };
}

async function runGrillStage(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  parsedIntent: IntentArtifact;
  attempt: number;
  onPrdStageStart: () => void | Promise<void>;
  resumeProviderSessionId?: string;
}): Promise<void> {
  const completionMarker = createCompletionMarker("DEVFLOW_GRILL_COMPLETE");
  const prdCompletionMarker = createPrdCompletionMarker();
  const prdRepairCompletionMarker = createPrdRepairCompletionMarker();
  const prompt =
    options.resumeProviderSessionId === undefined
      ? await renderGrillPrompt({
          rawTask: options.request.rawTask,
          intentArtifact: options.parsedIntent,
          intentArtifactPath: options.run.paths.intentArtifact,
          projectContextPath: options.run.paths.projectContextArtifact,
          partialTranscriptPath:
            options.attempt === 1 ? undefined : options.run.paths.grillTranscript,
          completionMarker,
        })
      : renderInterruptedGrillResumePrompt({ completionMarker });
  const prdPrompt = await renderPrdPrompt({
    request: options.request,
    run: options.run,
    completionMarker: prdCompletionMarker,
    liveDiscussionAvailable: true,
  });

  try {
    if (
      options.attempt === 1 ||
      !(await fs.pathExists(options.run.paths.grillTranscript))
    ) {
      await options.run.initializeGrillTranscript();
    }

    await options.run.appendGrillAttemptHeading(options.attempt);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "grill",
      artifactPath: options.run.paths.grillTranscript,
      details,
    });
  }

  const recorder = supportsStructuredGrillTranscriptCapture(options.adapter)
    ? createStructuredGrillTranscriptRecorder({
        provider: options.adapter.provider,
        artifact: {
          appendProviderMessage: (content) =>
            options.run.appendGrillProviderMessage(content),
          appendUserMessage: (content) =>
            options.run.appendGrillUserMessage(content),
          complete: () => options.run.completeGrillTranscript(),
        },
        getActiveCompletionMarker: () => completionMarker,
      })
    : undefined;

  const input = {
    workingDirectory: options.request.projectRoot,
    initialPrompt: prompt,
    initialCompletionMarker: completionMarker,
    phase: createProviderSessionPhase({
      run: options.run,
      kind: "grill",
      attempt: options.attempt,
    }),
    ...(options.request.model ? { model: options.request.model } : {}),
    async validate() {
      await writeCompletedGrillArtifacts({
        request: options.request,
        run: options.run,
        recorder,
      });
    },
    continuations: [
      {
        prompt: prdPrompt,
        completionMarker: prdCompletionMarker,
        phase: createProviderSessionPhase({
          run: options.run,
          kind: "prd",
          attempt: options.attempt,
        }),
        onStart: options.onPrdStageStart,
        async validate() {
          await validatePrdArtifact(options.run.paths.prdArtifact);
        },
        repair: createPrdRepairConfig({
          run: options.run,
          completionMarker: prdRepairCompletionMarker,
          attempt: options.attempt,
        }),
      },
    ],
    ...(recorder
      ? {
          onProviderEvent: (event: ManagedProviderSessionEvent) =>
            recorder.recordEvent(event),
        }
      : {
          transcript: {
            onProviderOutput: (chunk: string) =>
              options.run.appendGrillProviderMessage(chunk),
            onSubmittedUserMessage: (message: string) =>
              options.run.appendGrillUserMessage(message),
          },
        }),
  } satisfies ManagedProviderSessionInput;

  if (options.resumeProviderSessionId !== undefined) {
    try {
      if (!canResumeManagedProviderSession(options.adapter)) {
        throw new Error("Adapter cannot resume provider sessions.");
      }

      await resumeManagedSessionWithProviderState({
        run: options.run,
        adapter: options.adapter,
        input: {
          ...input,
          providerSessionId: options.resumeProviderSessionId,
        },
      });
      return;
    } catch (error) {
      if (
        isRetryableProviderBackedStageFailure(error) &&
        (await options.run.getGrillTranscriptStatus()) === "complete" &&
        (await hasValidPrdArtifact(options.run.paths.prdArtifact))
      ) {
        return;
      }

      throw error;
    }
  }

  try {
    await runManagedSessionWithProviderState({
      run: options.run,
      adapter: options.adapter,
      input,
    });
  } catch (error) {
    if (
      isRetryableProviderBackedStageFailure(error) &&
      (await options.run.getGrillTranscriptStatus()) === "complete" &&
      (await hasValidPrdArtifact(options.run.paths.prdArtifact))
    ) {
      return;
    }

    throw error;
  }
}

async function runPrdStage(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  liveDiscussionAvailable: boolean;
  attempt: number;
  resumeProviderSessionId?: string;
}): Promise<void> {
  const completionMarker = createPrdCompletionMarker();
  const repairCompletionMarker = createPrdRepairCompletionMarker();
  const prompt =
    options.resumeProviderSessionId === undefined
      ? await renderPrdPrompt({
          request: options.request,
          run: options.run,
          completionMarker,
          liveDiscussionAvailable: options.liveDiscussionAvailable,
        })
      : renderInterruptedPrdResumePrompt({
          prdArtifactPath: options.run.paths.prdArtifact,
          completionMarker,
        });

  const input = {
    workingDirectory: options.request.projectRoot,
    initialPrompt: prompt,
    initialCompletionMarker: completionMarker,
    phase: createProviderSessionPhase({
      run: options.run,
      kind: "prd",
      attempt: options.attempt,
    }),
    ...(options.request.model ? { model: options.request.model } : {}),
    async validate() {
      await validatePrdArtifact(options.run.paths.prdArtifact);
    },
    repair: createPrdRepairConfig({
      run: options.run,
      completionMarker: repairCompletionMarker,
      attempt: options.attempt,
    }),
  } satisfies ManagedProviderSessionInput;

  if (options.resumeProviderSessionId !== undefined) {
    try {
      if (!canResumeManagedProviderSession(options.adapter)) {
        throw new Error("Adapter cannot resume provider sessions.");
      }

      await resumeManagedSessionWithProviderState({
        run: options.run,
        adapter: options.adapter,
        input: {
          ...input,
          providerSessionId: options.resumeProviderSessionId,
        },
      });
    } catch (error) {
      if (
        isRetryableProviderBackedStageFailure(error) &&
        (await hasValidPrdArtifact(options.run.paths.prdArtifact))
      ) {
        return;
      }

      throw error;
    }
  } else {
    try {
      await runManagedSessionWithProviderState({
        run: options.run,
        adapter: options.adapter,
        input,
      });
    } catch (error) {
      if (
        isRetryableProviderBackedStageFailure(error) &&
        (await hasValidPrdArtifact(options.run.paths.prdArtifact))
      ) {
        return;
      }

      throw error;
    }
  }

  await validatePrdArtifact(options.run.paths.prdArtifact);
}

async function runPrdStageWithRetry(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  liveDiscussionAvailable: boolean;
  resumeProviderSessionId?: string;
}): Promise<void> {
  let resumeProviderSessionId = options.resumeProviderSessionId;

  await runProviderBackedStageWithRetry({
    stage: "prd",
    providerId: options.request.providerId,
    totalAttempts: PRD_STAGE_TOTAL_ATTEMPTS,
    async runAttempt(attempt) {
      await runPrdStage({
        ...options,
        attempt,
        resumeProviderSessionId:
          attempt === 1 ? resumeProviderSessionId : undefined,
      });
    },
    async cleanupBeforeRetry() {
      await fs.remove(options.run.paths.prdArtifact);
      resumeProviderSessionId = undefined;
    },
  });
}

async function runIssuesStage(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  attempt: number;
}): Promise<void> {
  const completionMarker = createCompletionMarker("DEVFLOW_ISSUES_COMPLETE");
  const repairCompletionMarker = createIssuesRepairCompletionMarker();
  const prompt = await renderIssuesPrompt({
    prdArtifactPath: options.run.paths.prdArtifact,
    projectContextPath: options.run.paths.projectContextArtifact,
    issuesDirectory: options.run.paths.issuesDirectory,
    completionMarker,
  });

  await runManagedSessionWithProviderState({
    run: options.run,
    adapter: options.adapter,
    input: {
      workingDirectory: options.request.projectRoot,
      initialPrompt: prompt,
      initialCompletionMarker: completionMarker,
      phase: createProviderSessionPhase({
        run: options.run,
        kind: "issues",
        attempt: options.attempt,
      }),
      ...(options.request.model ? { model: options.request.model } : {}),
      async validate() {
        await validateIssueArtifacts(options.run.paths.issuesDirectory);
      },
      repair: createIssuesRepairConfig({
        run: options.run,
        completionMarker: repairCompletionMarker,
        attempt: options.attempt,
      }),
    },
  });
}

async function runIssuesStageWithRetry(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
}): Promise<void> {
  await runProviderBackedStageWithRetry({
    stage: "issues",
    providerId: options.request.providerId,
    totalAttempts: ISSUES_STAGE_TOTAL_ATTEMPTS,
    async runAttempt(attempt) {
      await runIssuesStage({ ...options, attempt });
    },
    async cleanupBeforeRetry() {
      await fs.emptyDir(options.run.paths.issuesDirectory);
    },
  });
}

async function listExecutionIssueFilenames(
  issuesDirectory: string,
): Promise<string[]> {
  return (await fs.readdir(issuesDirectory))
    .filter((entry) => entry.endsWith(".md"))
    .sort();
}

async function runExecuteStage(options: {
  devFlowState: DevFlowState;
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  onExecutionIteration?: RunExecutionRequestOptions["onExecutionIteration"];
}): Promise<void> {
  const initialIssueFilenames = await listExecutionIssueFilenames(
    options.run.paths.issuesDirectory,
  );
  const maxIterations = initialIssueFilenames.length * 2 + 5;
  const iterations: ExecutionLedger["iterations"] = [];

  async function buildLedger(
    stopReason: ExecutionLedger["final"]["stopReason"],
  ): Promise<ExecutionLedger> {
    const remainingIssueFilenames = await listExecutionIssueFilenames(
      options.run.paths.issuesDirectory,
    );
    const remainingIssueFilenameSet = new Set(remainingIssueFilenames);

    return {
      stage: "execute",
      iterations,
      final: {
        stopReason,
        completedIssueFilenames: initialIssueFilenames.filter(
          (issueFilename) => !remainingIssueFilenameSet.has(issueFilename),
        ),
        remainingIssueFilenames,
      },
    };
  }

  async function writeLedger(
    stopReason: ExecutionLedger["final"]["stopReason"],
  ): Promise<void> {
    await options.run.writeExecution(
      JSON.stringify(await buildLedger(stopReason), null, 2),
    );
    await validateExecutionArtifact(options.run.paths.executionArtifact);
  }

  for (let iteration = 1; ; iteration += 1) {
    const currentIssueFilenames = await listExecutionIssueFilenames(
      options.run.paths.issuesDirectory,
    );

    if (currentIssueFilenames.length === 0) {
      await writeLedger("no-file");
      return;
    }

    const iterationMarker = createCompletionMarker(
      "DEVFLOW_EXECUTION_ITERATION_COMPLETE",
    );
    const terminalMarker = createCompletionMarker(
      "DEVFLOW_EXECUTION_NO_MORE_TASKS",
    );
    const gitHeadBefore = await options.devFlowState.git.getCurrentHead();
    const prompt = await renderExecutePrompt({
      issuesDirectory: options.run.paths.issuesDirectory,
      recentCommits: await options.devFlowState.git.getRecentCommits(),
      prdArtifactPath: options.run.paths.prdArtifact,
      projectContextPath: options.run.paths.projectContextArtifact,
      tddGuidePath: TDD_GUIDE_PATH,
      iterationMarker,
      terminalMarker,
    });

    let result: ManagedProviderSessionResult;
    let finalAssistantMessage: string | undefined;

    try {
      await options.onExecutionIteration?.({ iteration });
      result = await runManagedSessionWithProviderState({
        run: options.run,
        adapter: options.adapter,
        input: {
          workingDirectory: options.request.projectRoot,
          initialPrompt: prompt,
          initialCompletionMarker: iterationMarker,
          initialTerminalCompletionMarker: terminalMarker,
          phase: createProviderSessionPhase({
            run: options.run,
            kind: "execute",
            attempt: iteration,
          }),
          ...(options.request.model ? { model: options.request.model } : {}),
          async validate() {
            // The provider owns issue selection and movement. The loop only
            // records marker-driven progress and final issue-file accounting.
          },
          onProviderEvent(event) {
            if (
              event.structured &&
              event.type === "turn-completed" &&
              event.assistantMessage !== undefined
            ) {
              finalAssistantMessage = event.assistantMessage;
            }
          },
        },
      });
    } catch (error) {
      if (error instanceof IncompleteProviderSessionError) {
        iterations.push({
          iteration,
          marker: error.completionMarker,
          gitHeadBefore,
          gitHeadAfter: await options.devFlowState.git.getCurrentHead(),
        });
        await writeLedger("error");
      }

      throw error;
    }

    const gitHeadAfter = await options.devFlowState.git.getCurrentHead();
    const providerSessionState = await readAdvisoryProviderSessionState(options.run);
    const matchedCompletionMarker = result.matchedCompletionMarker;
    const markerStrippedFinalAssistantMessage = stripCompletionMarkers(
      finalAssistantMessage ?? "",
      [iterationMarker, terminalMarker],
    );

    iterations.push({
      iteration,
      marker: matchedCompletionMarker ?? iterationMarker,
      ...(providerSessionState?.providerSessionId
        ? { providerSessionId: providerSessionState.providerSessionId }
        : {}),
      gitHeadBefore,
      gitHeadAfter,
      ...(markerStrippedFinalAssistantMessage.trim().length > 0
        ? { finalAssistantMessage: markerStrippedFinalAssistantMessage }
        : {}),
    });

    if (matchedCompletionMarker === terminalMarker) {
      await writeLedger("terminal");
      return;
    }

    if (matchedCompletionMarker !== iterationMarker) {
      const error = new IncompleteProviderSessionError({
        provider: options.adapter.provider,
        completionMarker: iterationMarker,
        exitCode: result.exitCode,
        signal: result.signal,
      });
      await writeLedger("error");
      throw error;
    }

    if (iterations.length >= maxIterations) {
      await writeLedger("cap");
      throw new ExecutionLoopCapError(maxIterations);
    }
  }
}

async function appendGrillFailureNoteBestEffort(
  run: DevFlowRunHandle,
  error: unknown,
): Promise<void> {
  if (!(await fs.pathExists(run.paths.grillTranscript))) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);

  try {
    await run.appendGrillAttemptFailure(message);
  } catch {
    // Losing the failure note must not mask the provider-stage failure that
    // drives retry/exhaustion behavior.
  }
}

async function recoverCompletedGrillCheckpointIfNeeded(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
}): Promise<boolean> {
  if ((await options.run.getGrillTranscriptStatus()) !== "complete") {
    return false;
  }

  try {
    if ((await options.run.readGrillCheckpoint()) !== undefined) {
      return false;
    }
  } catch {
    // A completed transcript is authoritative; invalid checkpoint metadata can
    // be replaced from run-scoped paths and the original raw task.
  }

  await options.run.recoverGrillCheckpoint(
    createGrillCheckpoint({
      request: options.request,
      run: options.run,
    }),
  );
  return true;
}

async function readAdvisoryProviderSessionState(
  run: DevFlowRunHandle,
): Promise<DevFlowProviderSessionState | undefined> {
  try {
    return await run.readProviderSessionState();
  } catch (error) {
    if (error instanceof InvalidProviderSessionStateError) {
      return undefined;
    }

    throw error;
  }
}

async function readResumableGrillProviderSessionId(options: {
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
}): Promise<string | undefined> {
  if (!canResumeManagedProviderSession(options.adapter)) {
    return undefined;
  }

  const state = await readAdvisoryProviderSessionState(options.run);

  if (
    state?.providerSessionId === undefined ||
    state.provider.id !== options.adapter.provider.id ||
    state.phase.kind !== "grill" ||
    !["active", "interrupted"].includes(state.status)
  ) {
    return undefined;
  }

  return state.providerSessionId;
}

async function readResumablePrdProviderSessionId(options: {
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
}): Promise<string | undefined> {
  if (!canResumeManagedProviderSession(options.adapter)) {
    return undefined;
  }

  const state = await readAdvisoryProviderSessionState(options.run);

  if (
    state?.providerSessionId === undefined ||
    state.provider.id !== options.adapter.provider.id ||
    state.phase.kind !== "prd" ||
    !["active", "interrupted"].includes(state.status)
  ) {
    return undefined;
  }

  return state.providerSessionId;
}

function isRecoverablePrdFailureAfterCompletedGrill(error: unknown): boolean {
  return (
    (error instanceof StageArtifactValidationError && error.stage === "prd") ||
    (error instanceof IncompleteProviderSessionError &&
      error.completionMarker.startsWith("DEVFLOW_PRD_COMPLETE_"))
  );
}

async function runPrdRecoveryAfterCompletedGrill(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  onPrdStageStart: () => void | Promise<void>;
}): Promise<void> {
  await options.onPrdStageStart();
  await runPrdStageWithRetry({
    request: options.request,
    run: options.run,
    adapter: options.adapter,
    liveDiscussionAvailable: false,
    resumeProviderSessionId: await readResumablePrdProviderSessionId({
      run: options.run,
      adapter: options.adapter,
    }),
  });
}

async function runGrillStageWithRetry(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  parsedIntent: IntentArtifact;
  onPrdStageStart: () => void | Promise<void>;
}): Promise<void> {
  for (let attempt = 1; attempt <= GRILL_STAGE_TOTAL_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 1) {
        const resumeProviderSessionId =
          await readResumableGrillProviderSessionId({
            run: options.run,
            adapter: options.adapter,
          });

        if (resumeProviderSessionId !== undefined) {
          try {
            await runGrillStage({
              ...options,
              attempt,
              resumeProviderSessionId,
            });
            await validatePrdArtifact(options.run.paths.prdArtifact);
            return;
          } catch (error) {
            if (!isRetryableProviderBackedStageFailure(error)) {
              throw error;
            }

            if (
              await recoverCompletedGrillCheckpointIfNeeded({
                request: options.request,
                run: options.run,
              })
            ) {
              await options.onPrdStageStart();
              await runPrdStageWithRetry({
                request: options.request,
                run: options.run,
                adapter: options.adapter,
                liveDiscussionAvailable: false,
              });
              return;
            }

            if ((await options.run.getGrillTranscriptStatus()) === "complete") {
              if (!isRecoverablePrdFailureAfterCompletedGrill(error)) {
                throw error;
              }

              await runPrdRecoveryAfterCompletedGrill(options);
              return;
            }

            await appendGrillFailureNoteBestEffort(options.run, error);
          }
        }
      }

      await runGrillStage({ ...options, attempt });
      await validatePrdArtifact(options.run.paths.prdArtifact);
      return;
    } catch (error) {
      if (!isRetryableProviderBackedStageFailure(error)) {
        throw error;
      }

      if (
        error instanceof StageArtifactValidationError &&
        error.stage === "prd"
      ) {
        await recoverCompletedGrillCheckpointIfNeeded({
          request: options.request,
          run: options.run,
        });

        if ((await options.run.getGrillTranscriptStatus()) !== "complete") {
          throw error;
        }

        await options.onPrdStageStart();
        await runPrdStageWithRetry({
          request: options.request,
          run: options.run,
          adapter: options.adapter,
          liveDiscussionAvailable: false,
        });
        return;
      }

      if (
        await recoverCompletedGrillCheckpointIfNeeded({
          request: options.request,
          run: options.run,
        })
      ) {
        await options.onPrdStageStart();
        await runPrdStageWithRetry({
          request: options.request,
          run: options.run,
          adapter: options.adapter,
          liveDiscussionAvailable: false,
        });
        return;
      }

      if ((await options.run.getGrillTranscriptStatus()) === "complete") {
        if (!isRecoverablePrdFailureAfterCompletedGrill(error)) {
          throw error;
        }

        await runPrdRecoveryAfterCompletedGrill(options);
        return;
      }

      await appendGrillFailureNoteBestEffort(options.run, error);

      if (attempt >= GRILL_STAGE_TOTAL_ATTEMPTS) {
        throw new ProviderStageRetryExhaustedError({
          stage: "grill",
          providerId: options.request.providerId,
          attempts: GRILL_STAGE_TOTAL_ATTEMPTS,
          cause: error,
        });
      }
    }
  }

  throw new Error("Grill stage retry loop ended without a result.");
}

export async function runExecutionRequest(
  request: ResolvedExecutionRequest,
  options: RunExecutionRequestOptions = {},
): Promise<RunExecutionRequestResult> {
  const providerId = request.providerId;

  if (!providerId) {
    throw new MissingProviderIdError();
  }

  if (!isBuiltInProviderId(providerId)) {
    throw new UnsupportedProviderError(providerId);
  }

  const devFlowState =
    options.devFlowState ?? createDevFlowState({ projectRoot: request.projectRoot });
  const createManagedSessionAdapter =
    options.createManagedSessionAdapter ?? createBuiltInManagedSessionAdapter;
  const adapter = createManagedSessionAdapter(providerId);
  const run = await devFlowState.createRun();

  await options.onRunCreated?.({
    id: run.id,
    paths: {
      runDirectory: run.paths.runDirectory,
      prdArtifact: run.paths.prdArtifact,
      issuesDirectory: run.paths.issuesDirectory,
      executionArtifact: run.paths.executionArtifact,
    },
  });

  await startStage("intent", options);
  const intent = await runProviderBackedStageWithRetry({
    stage: "intent",
    providerId,
    totalAttempts: INTENT_STAGE_TOTAL_ATTEMPTS,
    async runAttempt(attempt) {
      const result = await runIntentStage({
        request,
        run,
        adapter,
        attempt,
      });

      await parseStageIntentArtifact(run.paths.intentArtifact);

      return result;
    },
    async cleanupBeforeRetry() {
      await fs.remove(run.paths.intentArtifact);
    },
  });
  const parsedIntent = await parseStageIntentArtifact(run.paths.intentArtifact);

  await startStage("bootstrap", options);
  const bootstrapProvenance = await runProviderBackedStageWithRetry({
    stage: "bootstrap",
    providerId,
    totalAttempts: BOOTSTRAP_STAGE_TOTAL_ATTEMPTS,
    async runAttempt(attempt) {
      return runBootstrapStage({ devFlowState, request, run, adapter, attempt });
    },
    async cleanupBeforeRetry() {
      await fs.remove(run.paths.projectContextCandidate);
    },
  });

  await startStage("grill", options);
  await runGrillStageWithRetry({
    request,
    run,
    adapter,
    parsedIntent,
    onPrdStageStart: () => startStage("prd", options),
  });

  await startStage("issues", options);
  await runIssuesStageWithRetry({
    request,
    run,
    adapter,
  });

  await startStage("execute", options);
  await runExecuteStage({
    devFlowState,
    request,
    run,
    adapter,
    onExecutionIteration: options.onExecutionIteration,
  });

  return { intent, parsedIntent, bootstrapProvenance };
}
