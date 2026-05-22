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

export interface ResolvedExecutionRequest {
  projectRoot: string;
  rawTask: string;
  providerId?: string;
  model?: string;
}

export interface ProviderSessionRunOptions {
  providerId: string;
  projectRoot: string;
  prompt: string;
  artifactPath: string;
  completionMarker: string;
  model?: string;
}

export interface ProviderSessionRunner {
  run(options: ProviderSessionRunOptions): Promise<void>;
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
  sessionRunner?: ProviderSessionRunner;
  onStageStart?: (stage: PipelineStage) => void | Promise<void>;
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
    summary: z.string().min(1),
    rawTask: z.string().min(1),
    needsClarification: z.boolean(),
  })
  .strict();

export type IntentArtifact = z.infer<typeof intentArtifactSchema>;

export class ManagedProviderSessionNotImplementedError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `Managed provider sessions are not implemented yet for provider "${providerId}".`,
    );
    this.name = "ManagedProviderSessionNotImplementedError";
    this.providerId = providerId;
  }
}

export class InvalidIntentArtifactError extends Error {
  readonly artifactPath: string;

  constructor(artifactPath: string, details: string) {
    super(`Invalid intent artifact at ${artifactPath}. ${details}`);
    this.name = "InvalidIntentArtifactError";
    this.artifactPath = artifactPath;
  }
}

export class MissingProviderIdError extends Error {
  constructor() {
    super("Provider-backed orchestration requires a provider id.");
    this.name = "MissingProviderIdError";
  }
}

export const defaultProviderSessionRunner: ProviderSessionRunner = {
  async run(options) {
    throw new ManagedProviderSessionNotImplementedError(options.providerId);
  },
};

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

function createCompletionMarker(): string {
  return `DEVFLOW_INTENT_COMPLETE_${crypto.randomBytes(16).toString("hex")}`;
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
  providerId: string;
  run: DevFlowRunHandle;
  sessionRunner: ProviderSessionRunner;
}): Promise<void> {
  const completionMarker = createCompletionMarker();
  const prompt = await renderIntentPrompt({
    rawTask: options.request.rawTask,
    artifactPath: options.run.paths.intentArtifact,
    completionMarker,
  });

  await options.sessionRunner.run({
    providerId: options.providerId,
    projectRoot: options.request.projectRoot,
    prompt,
    artifactPath: options.run.paths.intentArtifact,
    completionMarker,
    ...(options.request.model ? { model: options.request.model } : {}),
  });

  await readIntentArtifact(options.run.paths.intentArtifact);
}

async function runNoopStage(): Promise<void> {
  // Placeholder for the MVP pipeline stage order. Later slices will replace
  // these no-op stages with provider-backed or state-writing work.
}

export async function runExecutionRequest(
  request: ResolvedExecutionRequest,
  options: RunExecutionRequestOptions = {},
): Promise<void> {
  const providerId = request.providerId;

  if (!providerId) {
    throw new MissingProviderIdError();
  }

  const devFlowState =
    options.devFlowState ?? createDevFlowState({ projectRoot: request.projectRoot });
  const sessionRunner = options.sessionRunner ?? defaultProviderSessionRunner;
  const run = await devFlowState.createRun();

  await startStage("intent", options);
  await runIntentStage({
    request,
    providerId,
    run,
    sessionRunner,
  });

  for (const stage of PIPELINE_STAGES.slice(1)) {
    await startStage(stage, options);
    await runNoopStage();
  }
}
