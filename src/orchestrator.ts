import crypto from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fs from "fs-extra";
import { z } from "zod";

import {
  createDevFlowState,
  type DevFlowRunHandle,
  type DevFlowState,
} from "./devflowState.js";
import { createBuiltInManagedSessionAdapter } from "./adapters/builtInManagedSessionAdapter.js";
import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  type ManagedProviderSessionResult,
  type ManagedSessionAdapter,
  ProviderSessionCleanupError,
  ProviderSessionLaunchError,
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
}

const INTENT_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "intent.md",
);
const INTENT_STAGE_TOTAL_ATTEMPTS = 2;

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

function createCompletionMarker(prefix = "DEVFLOW_INTENT_COMPLETE"): string {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
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

async function runBootstrapStage(options: {
  devFlowState: DevFlowState;
}): Promise<void> {
  const freshness = await options.devFlowState.projectContext.checkFreshness();

  if (freshness.status === "fresh") {
    return;
  }

  if (
    (freshness.refreshReason === "missing-metadata" ||
      freshness.refreshReason === "metadata-invalid") &&
    freshness.context !== undefined
  ) {
    await options.devFlowState.projectContext.write(freshness.context, {
      refreshReason: freshness.refreshReason,
    });
  }
}

async function runNoopStage(): Promise<void> {
  // Placeholder for the MVP pipeline stage order. Later slices will replace
  // these no-op stages with provider-backed or state-writing work.
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

  await startStage("bootstrap", options);
  await runBootstrapStage({ devFlowState });

  for (const stage of PIPELINE_STAGES.slice(2)) {
    await startStage(stage, options);
    await runNoopStage();
  }

  return { intent };
}
