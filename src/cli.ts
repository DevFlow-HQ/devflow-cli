import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import {
  formatInvalidRepoConfigError,
  InvalidRepoConfigError,
  resolveRepoConfig,
} from "./repoConfig.js";
import {
  formatOrchestratorError,
  OrchestratorNotImplementedError,
  runExecutionRequest,
  type ResolvedExecutionRequest,
} from "./orchestrator.js";
import { resolveProjectRoot } from "./projectRoot.js";

const DEFAULT_VERSION = "0.1.0";
const REQUIRED_TASK_ERROR = "A task is required.";

export interface CliWriter {
  write(chunk: string): void;
}

export interface RunCliOptions {
  stdout?: CliWriter;
  stderr?: CliWriter;
  version?: string;
  cwd?: string;
  providerId?: string;
  model?: string;
  onResolvedTask?: (rawTask: string) => void | Promise<void>;
  resolveProjectRoot?: (cwd: string) => Promise<string>;
  runExecutionRequest?: (
    request: ResolvedExecutionRequest,
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

export function createCli(options: RunCliOptions = {}): Command {
  const program = new Command();

  program
    .name("devflow")
    .version(options.version ?? DEFAULT_VERSION)
    .argument("[taskParts...]")
    .action(async (taskParts: string[]) => {
      const rawTask = resolveRawTask(taskParts);
      await options.onResolvedTask?.(rawTask);

      const cwd = options.cwd ?? process.cwd();
      const projectRoot = options.resolveProjectRoot
        ? await options.resolveProjectRoot(cwd)
        : await resolveProjectRoot({ cwd });
      const repoConfig = await resolveRepoConfig({ projectRoot });
      const executionRequestRunner =
        options.runExecutionRequest ?? runExecutionRequest;
      const request = createExecutionRequest(
        rawTask,
        projectRoot,
        options.providerId ?? repoConfig?.defaultProvider,
        options.model,
      );

      await executionRequestRunner(request);
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

    if (error instanceof Error && error.message === REQUIRED_TASK_ERROR) {
      program.error(REQUIRED_TASK_ERROR);
    }

    if (error instanceof OrchestratorNotImplementedError) {
      program.error(formatOrchestratorError(error));
    }

    if (error instanceof InvalidRepoConfigError) {
      program.error(formatInvalidRepoConfigError(error));
    }

    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
