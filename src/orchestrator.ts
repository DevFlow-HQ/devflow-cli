import crypto from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fs from "fs-extra";
import { z } from "zod";

import {
  createDevFlowState,
  DEVFLOW_GRILL_TRANSCRIPT_COMPLETE,
  type GitChangedPath,
  type DevFlowRunHandle,
  type DevFlowState,
  type ProjectContextFreshness,
  type ProjectContextRefreshReason,
  validateProjectContextContent,
} from "./devflowState.js";
import { createBuiltInManagedSessionAdapter } from "./adapters/builtInManagedSessionAdapter.js";
import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  type ManagedProviderSessionResult,
  type ManagedSessionAdapter,
  ProviderSessionCleanupError,
  ProviderSessionLaunchError,
  ProviderSessionTranscriptCaptureError,
} from "./adapters/managedSessionAdapter.js";
import {
  isBuiltInProviderId,
  type BuiltInProviderId,
} from "./adapters/providers.js";
import { UnsupportedProviderError } from "./bootstrapProvider.js";

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
  "validate",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface RunExecutionRequestOptions {
  devFlowState?: DevFlowState;
  createManagedSessionAdapter?: (
    providerId: BuiltInProviderId,
  ) => ManagedSessionAdapter;
  onStageStart?: (stage: PipelineStage) => void | Promise<void>;
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
const INTENT_STAGE_TOTAL_ATTEMPTS = 2;
const BOOTSTRAP_STAGE_TOTAL_ATTEMPTS = 2;
const GRILL_STAGE_TOTAL_ATTEMPTS = 2;

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
  readonly attempts: number;
  readonly cause: unknown;

  constructor(options: {
    stage: PipelineStage;
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
    this.attempts = options.attempts;
    this.cause = options.cause;
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
    error instanceof ProviderSessionTranscriptCaptureError ||
    error instanceof StageArtifactValidationError
  );
}

export async function runProviderBackedStageWithRetry<T>(options: {
  stage: PipelineStage;
  totalAttempts: number;
  runAttempt(): Promise<T>;
  cleanupBeforeRetry(): Promise<void>;
}): Promise<T> {
  for (let attempt = 1; attempt <= options.totalAttempts; attempt += 1) {
    try {
      return await options.runAttempt();
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

  return options.adapter.runSession({
    workingDirectory: options.request.projectRoot,
    initialPrompt: prompt,
    initialCompletionMarker: completionMarker,
    ...(options.request.model ? { model: options.request.model } : {}),
    async validate() {
      await readIntentArtifact(options.run.paths.intentArtifact);
    },
    repair: {
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

async function runBootstrapStage(options: {
  devFlowState: DevFlowState;
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
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

    await options.adapter.runSession({
      workingDirectory: options.request.projectRoot,
      initialPrompt: prompt,
      initialCompletionMarker: completionMarker,
      ...(options.request.model ? { model: options.request.model } : {}),
      async validate() {
        await readValidProjectContextCandidate(
          options.run.paths.projectContextCandidate,
        );
      },
      repair: {
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

async function runNoopStage(): Promise<void> {
  // Placeholder for the MVP pipeline stage order. Later slices will replace
  // these no-op stages with provider-backed or state-writing work.
}

async function writeCompletedGrillArtifacts(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
}): Promise<void> {
  try {
    await options.run.completeGrillTranscript();
    await options.run.writeGrillCheckpoint({
      stage: "grill",
      status: "complete",
      completedAt: new Date().toISOString(),
      rawTask: options.request.rawTask,
      intentArtifactPath: options.run.paths.intentArtifact,
      projectContextPath: options.run.paths.projectContextArtifact,
      grillTranscriptPath: options.run.paths.grillTranscript,
      prdArtifactPath: options.run.paths.prdArtifact,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    throw new StageArtifactValidationError({
      stage: "grill",
      artifactPath: options.run.paths.grillTranscript,
      details,
    });
  }
}

async function runGrillStage(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  parsedIntent: IntentArtifact;
  attempt: number;
}): Promise<void> {
  const completionMarker = createCompletionMarker("DEVFLOW_GRILL_COMPLETE");
  const prompt = await renderGrillPrompt({
    rawTask: options.request.rawTask,
    intentArtifact: options.parsedIntent,
    intentArtifactPath: options.run.paths.intentArtifact,
    projectContextPath: options.run.paths.projectContextArtifact,
    partialTranscriptPath:
      options.attempt === 1 ? undefined : options.run.paths.grillTranscript,
    completionMarker,
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

  await options.adapter.runSession({
    workingDirectory: options.request.projectRoot,
    initialPrompt: prompt,
    initialCompletionMarker: completionMarker,
    ...(options.request.model ? { model: options.request.model } : {}),
    async validate() {
      await writeCompletedGrillArtifacts({
        request: options.request,
        run: options.run,
      });
    },
    transcript: {
      onProviderOutput: (chunk) =>
        options.run.appendGrillProviderMessage(chunk),
      onSubmittedUserMessage: (message) =>
        options.run.appendGrillUserMessage(message),
    },
  });
}

async function isGrillTranscriptComplete(transcriptPath: string): Promise<boolean> {
  if (!(await fs.pathExists(transcriptPath))) {
    return false;
  }

  const transcript = await fs.readFile(transcriptPath, "utf8");
  return transcript.includes(DEVFLOW_GRILL_TRANSCRIPT_COMPLETE);
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

async function runGrillStageWithRetry(options: {
  request: ResolvedExecutionRequest;
  run: DevFlowRunHandle;
  adapter: ManagedSessionAdapter;
  parsedIntent: IntentArtifact;
}): Promise<void> {
  for (let attempt = 1; attempt <= GRILL_STAGE_TOTAL_ATTEMPTS; attempt += 1) {
    try {
      await runGrillStage({ ...options, attempt });
      return;
    } catch (error) {
      if (!isRetryableProviderBackedStageFailure(error)) {
        throw error;
      }

      if (await isGrillTranscriptComplete(options.run.paths.grillTranscript)) {
        throw error;
      }

      await appendGrillFailureNoteBestEffort(options.run, error);

      if (attempt >= GRILL_STAGE_TOTAL_ATTEMPTS) {
        throw new ProviderStageRetryExhaustedError({
          stage: "grill",
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

  await startStage("intent", options);
  const intent = await runProviderBackedStageWithRetry({
    stage: "intent",
    totalAttempts: INTENT_STAGE_TOTAL_ATTEMPTS,
    async runAttempt() {
      const result = await runIntentStage({
        request,
        run,
        adapter,
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
    totalAttempts: BOOTSTRAP_STAGE_TOTAL_ATTEMPTS,
    async runAttempt() {
      return runBootstrapStage({ devFlowState, request, run, adapter });
    },
    async cleanupBeforeRetry() {
      await fs.remove(run.paths.projectContextCandidate);
    },
  });

  await startStage("grill", options);
  await runGrillStageWithRetry({ request, run, adapter, parsedIntent });

  for (const stage of PIPELINE_STAGES.slice(3)) {
    await startStage(stage, options);
    await runNoopStage();
  }

  return { intent, parsedIntent, bootstrapProvenance };
}
