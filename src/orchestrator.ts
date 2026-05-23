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
  type ManagedProviderSessionResult,
  type ManagedSessionAdapter,
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
  const intent = await runIntentStage({
    request,
    run,
    adapter,
  });

  for (const stage of PIPELINE_STAGES.slice(1)) {
    await startStage(stage, options);
    await runNoopStage();
  }

  return { intent };
}
