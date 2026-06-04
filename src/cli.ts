import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

import { Command, CommanderError } from "commander";
import fs from "fs-extra";

import {
  NoSupportedProvidersInstalledError,
  ProviderSetupCancelledError,
  ProviderUnavailableError,
  resolveBootstrapProvider,
  type PromptForProviderSelectionOptions,
  UnsupportedProviderError,
} from "./bootstrapProvider.js";
import type { BuiltInProviderId } from "./adapters/providers.js";
import type { ProviderDiscoveryResult } from "./adapters/providerDiscovery.js";
import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ManagedProviderSessionNotImplementedError,
  ProviderSessionLaunchError,
} from "./adapters/managedSessionAdapter.js";
import {
  createDevFlowState,
  formatInvalidDevFlowConfigError,
  InvalidDevFlowConfigError,
  type DevFlowState,
} from "./devflowState.js";
import {
  ExecutionLoopCapError,
  InvalidIntentArtifactError,
  MissingProviderIdError,
  ProviderStageRetryExhaustedError,
  runExecutionRequest,
  type PipelineStage,
  type RunExecutionRequestOptions,
  type ResolvedExecutionRequest,
  StageArtifactValidationError,
  readExecutionLedger,
} from "./orchestrator.js";
import { resolveProjectRoot } from "./projectRoot.js";
import {
  renderRunSummary,
  type RunSummaryPaths,
} from "./runSummary.js";
import { createLogger, NoopLogger, type Logger } from "./logger.js";

const DEFAULT_VERSION = "0.1.0";
const REQUIRED_TASK_ERROR = "A task is required.";

export interface CliWriter {
  write(chunk: string): void;
}

export interface RunCliOptions {
  stdout?: CliWriter;
  stderr?: CliWriter;
  logger?: Logger;
  version?: string;
  cwd?: string;
  providerId?: string;
  model?: string;
  devFlowState?: DevFlowState;
  onResolvedTask?: (rawTask: string) => void | Promise<void>;
  resolveProjectRoot?: (cwd: string) => Promise<string>;
  discoverProviders?: () => Promise<ProviderDiscoveryResult>;
  promptForProviderSelection?: (
    options: PromptForProviderSelectionOptions,
  ) => Promise<BuiltInProviderId | undefined>;
  runExecutionRequest?: (
    request: ResolvedExecutionRequest,
    options: RunExecutionRequestOptions,
  ) => void | Promise<void>;
  configureProgram?: (program: Command) => void;
}

export function resolveRawTask(taskParts: string[]): string {
  const rawTask = taskParts.join(" ").trim();

  if (rawTask.length === 0) {
    throw new Error(REQUIRED_TASK_ERROR);
  }

  return rawTask;
}

function createExecutionRequest(
  rawTask: string,
  projectRoot: string,
  providerId: string | undefined,
  model: string | undefined,
): ResolvedExecutionRequest {
  return {
    projectRoot,
    rawTask,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
  };
}

function formatProviderLabel(provider: { displayName: string; id: string }): string {
  return `${provider.displayName} (${provider.id})`;
}

function formatProviderSessionLaunchError(
  error: ProviderSessionLaunchError,
): string {
  const causeMessage =
    error.cause instanceof Error ? error.cause.message : "Unknown launch failure";

  return `Unable to launch ${formatProviderLabel(error.provider)}: ${causeMessage}.`;
}

function formatInterruptedProviderSessionError(
  error: InterruptedProviderSessionError,
): string {
  return `Provider session for ${formatProviderLabel(error.provider)} was interrupted.`;
}

function formatExecutionIncompleteProviderSessionError(
  error: IncompleteProviderSessionError,
): string {
  return `Execution failed: provider session for ${formatProviderLabel(error.provider)} stopped before completing the execution iteration.`;
}

function formatExecutionLoopCapError(error: ExecutionLoopCapError): string {
  return `Execution failed: reached the maximum of ${error.maxIterations} iterations.`;
}

export function formatStageArtifactValidationError(
  error: StageArtifactValidationError,
): string {
  return `The ${error.stage} stage produced an invalid artifact at ${error.artifactPath}. Re-run DevFlow to regenerate the artifact.`;
}

function getFirstMessageLine(error: unknown): string {
  if (error instanceof Error) {
    return error.message.split(/\r?\n/, 1)[0] || "Unknown error";
  }

  return String(error).split(/\r?\n/, 1)[0] || "Unknown error";
}

export function formatProviderStageRetryExhaustedError(
  error: ProviderStageRetryExhaustedError,
): string {
  const providerId = error.providerId ?? "unknown provider";
  const causeLine = getFirstMessageLine(error.cause);

  return `The ${error.stage} stage failed with provider ${providerId} after ${error.attempts} attempts. Cause: ${causeLine}. Re-run DevFlow to resume from durable artifacts.`;
}

export function formatInvalidIntentArtifactError(
  error: InvalidIntentArtifactError,
): string {
  return `The intent artifact at ${error.artifactPath} is invalid. Start a new DevFlow run.`;
}

export function formatMissingProviderIdError(
  _error: MissingProviderIdError,
): string {
  return "Missing provider id for provider-backed orchestration. Re-run DevFlow to pick an installed provider.";
}

export function formatUnexpectedCliError(options: {
  ref: string;
  logPath: string;
}): string {
  return `DevFlow hit an unexpected internal error. Correlation ref: ${options.ref}. Diagnostic log: ${options.logPath}.`;
}

function formatStageStartLine(stage: PipelineStage): string {
  return `Starting ${stage} stage...\n`;
}

function formatDiagnosticLogPath(logsDirectory: string, date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");

  return join(logsDirectory, `devflow-${year}-${month}-${day}.log`);
}

interface CreatedRunSummaryContext {
  id: string;
  paths: RunSummaryPaths;
}

const RUN_SUMMARY_UNAVAILABLE_MESSAGE =
  "Run summary unavailable: execution ledger could not be read.";

async function readRunSummary(
  paths: RunSummaryPaths,
  options: { missingLedger: "skip" | "unavailable" },
): Promise<string | undefined> {
  if (!(await fs.pathExists(paths.executionArtifact))) {
    return options.missingLedger === "skip"
      ? undefined
      : `${RUN_SUMMARY_UNAVAILABLE_MESSAGE}\n`;
  }

  try {
    const ledger = await readExecutionLedger(paths.executionArtifact);

    return renderRunSummary(ledger, paths);
  } catch {
    return `${RUN_SUMMARY_UNAVAILABLE_MESSAGE}\n`;
  }
}

function formatCliError(error: unknown): string | undefined {
  if (error instanceof Error && error.message === REQUIRED_TASK_ERROR) {
    return REQUIRED_TASK_ERROR;
  }

  if (error instanceof ManagedProviderSessionNotImplementedError) {
    return error.message;
  }

  if (error instanceof ProviderSessionLaunchError) {
    return formatProviderSessionLaunchError(error);
  }

  if (error instanceof InterruptedProviderSessionError) {
    return formatInterruptedProviderSessionError(error);
  }

  if (
    error instanceof IncompleteProviderSessionError &&
    error.completionMarker.startsWith("DEVFLOW_EXECUTION_")
  ) {
    return formatExecutionIncompleteProviderSessionError(error);
  }

  if (error instanceof ExecutionLoopCapError) {
    return formatExecutionLoopCapError(error);
  }

  if (error instanceof StageArtifactValidationError) {
    return formatStageArtifactValidationError(error);
  }

  if (error instanceof ProviderStageRetryExhaustedError) {
    return formatProviderStageRetryExhaustedError(error);
  }

  if (error instanceof InvalidIntentArtifactError) {
    return formatInvalidIntentArtifactError(error);
  }

  if (error instanceof MissingProviderIdError) {
    return formatMissingProviderIdError(error);
  }

  if (error instanceof InvalidDevFlowConfigError) {
    return formatInvalidDevFlowConfigError(error);
  }

  if (
    error instanceof NoSupportedProvidersInstalledError ||
    error instanceof ProviderSetupCancelledError ||
    error instanceof UnsupportedProviderError ||
    error instanceof ProviderUnavailableError
  ) {
    return error.message;
  }

  return undefined;
}

export function createCli(options: RunCliOptions = {}): Command {
  const program = new Command();
  let createdRun: CreatedRunSummaryContext | undefined;

  program
    .name("devflow")
    .version(options.version ?? DEFAULT_VERSION)
    .option("--provider <providerId>")
    .option("--model <model>")
    .argument("[taskParts...]")
    .action(async (taskParts: string[]) => {
      const rawTask = resolveRawTask(taskParts);
      await options.onResolvedTask?.(rawTask);
      const commandOptions = program.opts<{ provider?: string; model?: string }>();

      const cwd = options.cwd ?? process.cwd();
      const projectRoot = options.resolveProjectRoot
        ? await options.resolveProjectRoot(cwd)
        : await resolveProjectRoot({ cwd });
      const devFlowState =
        options.devFlowState ?? createDevFlowState({ projectRoot });
      const diagnosticLogPath = formatDiagnosticLogPath(
        devFlowState.paths.logsDirectory,
        devFlowState.clock.now(),
      );
      const logger =
        options.logger ??
        createLogger({
          repoLogsDirectory: devFlowState.paths.logsDirectory,
          homeLogsDirectory: join(homedir(), ".devflow", "logs"),
          clock: devFlowState.clock,
        });
      const config = await devFlowState.config.load();
      const executionRequestRunner =
        options.runExecutionRequest ?? runExecutionRequest;
      const resolvedProviderId =
        options.providerId ??
        (await resolveBootstrapProvider({
          projectRoot,
          devFlowState,
          stdout: options.stdout,
          explicitProviderId: commandOptions.provider,
          savedProviderId: config?.defaultProvider,
          discoverProviders: options.discoverProviders,
          promptForProviderSelection: options.promptForProviderSelection,
        }));
      const request = createExecutionRequest(
        rawTask,
        projectRoot,
        resolvedProviderId,
        commandOptions.model ?? options.model,
      );

      try {
        await executionRequestRunner(request, {
          devFlowState,
          logger,
          async onRunCreated(run) {
            createdRun = {
              id: run.id,
              paths: {
                prdArtifact: run.paths.prdArtifact,
                issuesDirectory: run.paths.issuesDirectory,
                executionArtifact: run.paths.executionArtifact,
              },
            };
          },
          onStageStart(stage) {
            options.stdout?.write(formatStageStartLine(stage));
          },
          onExecutionIteration({ iteration }) {
            options.stdout?.write(`\n----- execution iteration ${iteration} -----\n`);
          },
        });

        if (createdRun !== undefined) {
          const summary = await readRunSummary(createdRun.paths, {
            missingLedger: "unavailable",
          });

          if (summary !== undefined) {
            options.stdout?.write(summary);
          }
        }
      } catch (error) {
        const cliErrorMessage = formatCliError(error);
        const message = cliErrorMessage ?? formatUnexpectedCliError({
          ref: logger.critical("unexpected cli error", { err: error }),
          logPath: diagnosticLogPath,
        });

        if (cliErrorMessage !== undefined) {
          logger.error("anticipated cli error", { err: error });
        }

        options.stderr?.write(`${message}\n`);

        if (createdRun !== undefined) {
          const summary = await readRunSummary(createdRun.paths, {
            missingLedger: "skip",
          });

          if (summary !== undefined) {
            options.stdout?.write(summary);
          }
        }

        throw new CommanderError(1, "commander.error", message);
      }
    });

  program.configureOutput({
    writeOut: (chunk) => {
      options.stdout?.write(chunk);
    },
    writeErr: (chunk) => {
      options.stderr?.write(chunk);
    },
  });

  return program;
}

export async function runCli(
  argv: string[],
  options: RunCliOptions = {},
): Promise<void> {
  const program = createCli(options);

  options.configureProgram?.(program);

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" ||
        error.code === "commander.version")
    ) {
      return;
    }

    if (error instanceof CommanderError && error.code === "commander.error") {
      throw error;
    }

    const message = formatCliError(error);

    if (message !== undefined) {
      program.error(message);
    }

    const ref = NoopLogger.critical("unexpected cli error", { err: error });
    program.error(
      formatUnexpectedCliError({
        ref,
        logPath: "unknown",
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
