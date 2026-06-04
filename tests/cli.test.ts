import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command, CommanderError } from "commander";
import { execa } from "execa";
import fs from "fs-extra";

import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ManagedProviderSessionNotImplementedError,
  ProviderSessionLaunchError,
} from "../src/adapters/managedSessionAdapter.js";
import {
  BUILT_IN_PROVIDERS,
  getBuiltInProviderIdentity,
} from "../src/adapters/providers.js";
import {
  formatInvalidIntentArtifactError,
  formatMissingProviderIdError,
  formatProviderStageRetryExhaustedError,
  formatStageArtifactValidationError,
  formatUnexpectedCliError,
  runCli,
} from "../src/cli.js";
import type { ProviderDiscoveryResult } from "../src/adapters/providerDiscovery.js";
import { createDevFlowState } from "../src/devflowState.js";
import {
  ExecutionLoopCapError,
  type ExecutionLedger,
  InvalidIntentArtifactError,
  MissingProviderIdError,
  PIPELINE_STAGES,
  ProviderStageRetryExhaustedError,
  type RunExecutionRequestOptions,
  StageArtifactValidationError,
} from "../src/orchestrator.js";

function createWritableBuffer() {
  let output = "";

  return {
    write(chunk: string) {
      output += chunk;
    },
    read() {
      return output;
    },
  };
}

async function invokeCli(argv: string[]) {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const resolvedTasks: string[] = [];

  let commandError: CommanderError | undefined;

  try {
    await runCli(argv, {
      stdout,
      stderr,
      providerId: "claude",
      onResolvedTask(rawTask) {
        resolvedTasks.push(rawTask);
      },
      runExecutionRequest: async () => {},
      configureProgram(program) {
        program.exitOverride();
      },
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      commandError = error;
    } else {
      throw error;
    }
  }

  return {
    commandError,
    resolvedTasks,
    stdout: stdout.read(),
    stderr: stderr.read(),
  };
}

async function invokeCliWithOptions(
  argv: string[],
  options: Parameters<typeof runCli>[1] = {},
) {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  let commandError: CommanderError | undefined;

  try {
    await runCli(argv, {
      stdout,
      stderr,
      configureProgram(program) {
        program.exitOverride();
        options.configureProgram?.(program);
      },
      ...options,
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      commandError = error;
    } else {
      throw error;
    }
  }

  return {
    commandError,
    stdout: stdout.read(),
    stderr: stderr.read(),
  };
}

function createDiscoveryResult(
  availableProviderIds: (typeof BUILT_IN_PROVIDERS)[number]["id"][],
): ProviderDiscoveryResult {
  const providers = BUILT_IN_PROVIDERS.map((provider) =>
    availableProviderIds.includes(provider.id)
      ? {
          provider,
          isAvailable: true as const,
          executable: provider.id,
        }
      : {
          provider,
          isAvailable: false as const,
          reason: "Not installed",
        },
  );

  const installedProviders = providers.filter(
    (provider): provider is Extract<(typeof providers)[number], { isAvailable: true }> =>
      provider.isAvailable,
  );

  return {
    providers,
    installedProviders,
    summary:
      installedProviders.length === 0
        ? { availabilityStatus: "none", installedProviderCount: 0 }
        : installedProviders.length === 1
          ? {
              availabilityStatus: "single",
              installedProviderCount: 1,
              recommendedProviderId: installedProviders[0].provider.id,
            }
          : {
              availabilityStatus: "multiple",
              installedProviderCount: installedProviders.length,
            },
  };
}

test("cli joins trailing positional arguments into a single raw task", async () => {
  const result = await invokeCli(["add", "dark", "mode"]);

  assert.equal(result.commandError, undefined);
  assert.deepEqual(result.resolvedTasks, ["add dark mode"]);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("cli trims the resolved raw task without normalizing internal spacing", async () => {
  const result = await invokeCli(["  audit", "   provider", "flow  "]);

  assert.equal(result.commandError, undefined);
  assert.deepEqual(result.resolvedTasks, ["audit    provider flow"]);
});

test("cli rejects missing task input with one clear user-facing error", async () => {
  const result = await invokeCli([]);

  assert.equal(result.resolvedTasks.length, 0);
  assert.equal(result.commandError?.code, "commander.error");
  assert.match(result.stderr, /A task is required\./);
});

test("cli rejects whitespace-only task input with one clear user-facing error", async () => {
  const result = await invokeCli(["   "]);

  assert.equal(result.resolvedTasks.length, 0);
  assert.equal(result.commandError?.code, "commander.error");
  assert.match(result.stderr, /A task is required\./);
});

test("cli preserves commander-owned help output", async () => {
  const result = await invokeCli(["--help"]);

  assert.equal(result.resolvedTasks.length, 0);
  assert.equal(result.commandError?.code, undefined);
  assert.match(result.stdout, /Usage: devflow \[options\] \[taskParts\.\.\.\]/);
  assert.match(result.stdout, /--help/);
  assert.equal(result.stderr, "");
});

test("cli preserves commander-owned version output", async () => {
  const result = await invokeCli(["--version"]);

  assert.equal(result.resolvedTasks.length, 0);
  assert.equal(result.commandError?.code, undefined);
  assert.equal(result.stdout.trim(), "0.1.0");
  assert.equal(result.stderr, "");
});

test("cli resolves the git repository root before handing off the execution request", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-git-root-"));
  const nestedDirectory = join(projectRoot, "packages", "feature");
  fs.ensureDirSync(nestedDirectory);
  await execa("git", ["init"], { cwd: projectRoot });

  const receivedRequests: unknown[] = [];

  const result = await invokeCliWithOptions(["ship", "bootstrap"], {
    cwd: nestedDirectory,
    providerId: "claude",
    runExecutionRequest: async (request) => {
      receivedRequests.push(request);
    },
  });

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedRequests, [
    {
      projectRoot,
      rawTask: "ship bootstrap",
      providerId: "claude",
    },
  ]);
});

test("cli passes the resolved state facade through to the orchestrator runner", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-state-pass-through-"));
  const devFlowState = createDevFlowState({ projectRoot });
  const receivedCalls: Array<{
    request: unknown;
    options: RunExecutionRequestOptions;
  }> = [];

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    devFlowState,
    providerId: "claude",
    runExecutionRequest: async (request, options) => {
      receivedCalls.push({ request, options });
    },
  });

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedCalls, [
    {
      request: {
        projectRoot,
        rawTask: "resume work",
        providerId: "claude",
      },
      options: {
        devFlowState,
        logger: receivedCalls[0]?.options.logger,
        onRunCreated: receivedCalls[0]?.options.onRunCreated,
        onStageStart: receivedCalls[0]?.options.onStageStart,
        onExecutionIteration: receivedCalls[0]?.options.onExecutionIteration,
      },
    },
  ]);
  assert.equal(typeof receivedCalls[0]?.options.logger?.critical, "function");
  assert.equal(typeof receivedCalls[0]?.options.onRunCreated, "function");
  assert.equal(typeof receivedCalls[0]?.options.onStageStart, "function");
  assert.equal(typeof receivedCalls[0]?.options.onExecutionIteration, "function");
});

test("cli prints stage start one-liners in pipeline order", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-stage-start-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const observedStdoutBeforeRun: string[] = [];
  let commandError: CommanderError | undefined;

  try {
    await runCli(["resume", "work"], {
      stdout,
      stderr,
      cwd: projectRoot,
      providerId: "codex",
      runExecutionRequest: async (_request, options) => {
        for (const stage of PIPELINE_STAGES) {
          await options.onStageStart?.(stage);
        }
        observedStdoutBeforeRun.push(stdout.read());
      },
      configureProgram(program) {
        program.exitOverride();
      },
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      commandError = error;
    } else {
      throw error;
    }
  }

  assert.equal(commandError, undefined);
  assert.deepEqual(observedStdoutBeforeRun, [
    [
      "Starting intent stage...\n",
      "Starting bootstrap stage...\n",
      "Starting grill stage...\n",
      "Starting prd stage...\n",
      "Starting issues stage...\n",
      "Starting execute stage...\n",
    ].join(""),
  ]);
  assert.doesNotMatch(stdout.read(), /\x1B\[[0-?]*[ -/]*[@-~]/);
  assert.equal(stderr.read(), "");
});

test("cli prints a thin separator before each execution iteration starts", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-execute-iteration-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const observedStdoutBeforeRun: string[] = [];
  let commandError: CommanderError | undefined;

  try {
    await runCli(["resume", "work"], {
      stdout,
      stderr,
      cwd: projectRoot,
      providerId: "codex",
      runExecutionRequest: async (_request, options) => {
        await options.onExecutionIteration?.({ iteration: 1 });
        observedStdoutBeforeRun.push(stdout.read());
      },
      configureProgram(program) {
        program.exitOverride();
      },
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      commandError = error;
    } else {
      throw error;
    }
  }

  assert.equal(commandError, undefined);
  assert.deepEqual(observedStdoutBeforeRun, ["\n----- execution iteration 1 -----\n"]);
  assert.equal(stderr.read(), "");
});

test("cli prints a run summary from the on-disk execution ledger after a successful run", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-run-summary-"));
  const runDirectory = join(projectRoot, ".devflow", "runs", "run-summary");
  const executionArtifact = join(runDirectory, "execution.json");
  const ledger: ExecutionLedger = {
    stage: "execute",
    iterations: [
      {
        iteration: 1,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        gitHeadBefore: null,
        gitHeadAfter: null,
      },
    ],
    final: {
      stopReason: "terminal",
      completedIssueFilenames: ["001-done.md"],
      remainingIssueFilenames: ["002-hitl.md"],
    },
  };

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async (_request, options) => {
      await options.onRunCreated?.({
        id: "run-summary",
        paths: {
          runDirectory,
          prdArtifact: join(runDirectory, "prd.md"),
          issuesDirectory: join(runDirectory, "issues"),
          executionArtifact,
        },
      });
      await fs.outputJson(executionArtifact, ledger, { spaces: 2 });
    },
  });

  assert.equal(result.commandError, undefined);
  assert.match(result.stdout, /Run summary/);
  assert.match(result.stdout, /no more AFK tasks remain/);
  assert.match(result.stdout, / 1 │ \(no summary available\)/);
  assert.match(result.stdout, /001-done\.md/);
  assert.match(result.stdout, /002-hitl\.md/);
  assert.match(result.stdout, /Execution ledger: .+execution\.json/);
  assert.equal(result.stderr, "");
});

test("cli falls back to the current directory outside git before running the request", async () => {
  const currentDirectory = fs.mkdtempSync(join(tmpdir(), "devflow-cli-no-git-"));
  const receivedRequests: unknown[] = [];

  const result = await invokeCliWithOptions(["draft", "plan"], {
    cwd: currentDirectory,
    providerId: "claude",
    runExecutionRequest: async (request) => {
      receivedRequests.push(request);
    },
  });

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedRequests, [
    {
      projectRoot: currentDirectory,
      rawTask: "draft plan",
      providerId: "claude",
    },
  ]);
});

test("cli maps adapter-layer managed-session not-implemented errors to the expected-limitation message", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-adapter-error-"));

  const result = await invokeCliWithOptions(["draft", "plan"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new ManagedProviderSessionNotImplementedError(
        getBuiltInProviderIdentity("codex"),
      );
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    'Managed provider sessions are not implemented yet for provider "codex".\n',
  );
});

test("cli maps provider launch failures to concise user-facing errors", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-launch-error-"));

  const result = await invokeCliWithOptions(["draft", "plan"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new ProviderSessionLaunchError(
        getBuiltInProviderIdentity("codex"),
        new Error("spawn codex ENOENT"),
      );
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Unable to launch Codex (codex): spawn codex ENOENT.\n",
  );
});

test("cli maps interrupted provider sessions to concise user-facing errors", async () => {
  const projectRoot = fs.mkdtempSync(
    join(tmpdir(), "devflow-cli-interrupted-error-"),
  );

  const result = await invokeCliWithOptions(["draft", "plan"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new InterruptedProviderSessionError({
        provider: getBuiltInProviderIdentity("codex"),
        exitCode: 130,
        signal: "SIGINT",
      });
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Provider session for Codex (codex) was interrupted.\n");
});

test("cli maps execution cap stops to a clear failure", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-cap-error-"));

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new ExecutionLoopCapError(7);
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Execution failed: reached the maximum of 7 iterations.\n",
  );
});

test("cli prints a run summary after an execution cap failure with the error first", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-cap-summary-"));
  const runDirectory = join(projectRoot, ".devflow", "runs", "run-cap-summary");
  const executionArtifact = join(runDirectory, "execution.json");
  const writes: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  let commandError: CommanderError | undefined;

  const ledger: ExecutionLedger = {
    stage: "execute",
    iterations: [
      {
        iteration: 1,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        gitHeadBefore: null,
        gitHeadAfter: null,
      },
    ],
    final: {
      stopReason: "cap",
      completedIssueFilenames: ["001-done.md"],
      remainingIssueFilenames: ["002-left.md"],
    },
  };

  try {
    await runCli(["resume", "work"], {
      stdout: {
        write(chunk) {
          writes.push({ stream: "stdout", chunk });
        },
      },
      stderr: {
        write(chunk) {
          writes.push({ stream: "stderr", chunk });
        },
      },
      cwd: projectRoot,
      providerId: "codex",
      runExecutionRequest: async (_request, options) => {
        await options.onRunCreated?.({
          id: "run-cap-summary",
          paths: {
            runDirectory,
            prdArtifact: join(runDirectory, "prd.md"),
            issuesDirectory: join(runDirectory, "issues"),
            executionArtifact,
          },
        });
        await fs.outputJson(executionArtifact, ledger, { spaces: 2 });
        throw new ExecutionLoopCapError(7);
      },
      configureProgram(program) {
        program.exitOverride();
      },
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      commandError = error;
    } else {
      throw error;
    }
  }

  assert.equal(commandError?.code, "commander.error");
  assert.equal(writes[0]?.stream, "stderr");
  assert.match(writes[0]?.chunk ?? "", /maximum of 7 iterations/);
  assert.equal(writes[1]?.stream, "stdout");
  assert.match(writes[1]?.chunk ?? "", /Run summary/);
  assert.match(writes[1]?.chunk ?? "", /iteration cap/);
  assert.match(writes[1]?.chunk ?? "", /001-done\.md/);
});

test("cli maps execution error stops to a clear failure", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-execute-error-"));

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new IncompleteProviderSessionError({
        provider: getBuiltInProviderIdentity("codex"),
        completionMarker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        exitCode: 1,
        signal: null,
      });
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Execution failed: provider session for Codex (codex) stopped before completing the execution iteration.\n",
  );
});

test("cli prints a run summary after an execution error failure", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-error-summary-"));
  const runDirectory = join(projectRoot, ".devflow", "runs", "run-error-summary");
  const executionArtifact = join(runDirectory, "execution.json");
  const ledger: ExecutionLedger = {
    stage: "execute",
    iterations: [
      {
        iteration: 1,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        gitHeadBefore: null,
        gitHeadAfter: null,
      },
    ],
    final: {
      stopReason: "error",
      completedIssueFilenames: [],
      remainingIssueFilenames: ["001-left.md"],
    },
  };

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async (_request, options) => {
      await options.onRunCreated?.({
        id: "run-error-summary",
        paths: {
          runDirectory,
          prdArtifact: join(runDirectory, "prd.md"),
          issuesDirectory: join(runDirectory, "issues"),
          executionArtifact,
        },
      });
      await fs.outputJson(executionArtifact, ledger, { spaces: 2 });
      throw new IncompleteProviderSessionError({
        provider: getBuiltInProviderIdentity("codex"),
        completionMarker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        exitCode: 1,
        signal: null,
      });
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.match(result.stderr, /stopped before completing/);
  assert.match(result.stdout, /Run summary/);
  assert.match(result.stdout, /execution error/);
  assert.match(result.stdout, /001-left\.md/);
});

test("cli skips failure summary when no execution ledger exists", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-no-ledger-summary-"));
  const runDirectory = join(projectRoot, ".devflow", "runs", "run-no-ledger");

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async (_request, options) => {
      await options.onRunCreated?.({
        id: "run-no-ledger",
        paths: {
          runDirectory,
          prdArtifact: join(runDirectory, "prd.md"),
          issuesDirectory: join(runDirectory, "issues"),
          executionArtifact: join(runDirectory, "execution.json"),
        },
      });
      throw new StageArtifactValidationError({
        stage: "prd",
        artifactPath: join(runDirectory, "prd.md"),
        details: "Artifact is empty.",
      });
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.match(result.stderr, /prd stage/);
  assert.equal(result.stdout, "");
});

test("cli reports summary unavailable for a corrupt execution ledger without masking success", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-corrupt-summary-"));
  const runDirectory = join(projectRoot, ".devflow", "runs", "run-corrupt-summary");
  const executionArtifact = join(runDirectory, "execution.json");

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async (_request, options) => {
      await options.onRunCreated?.({
        id: "run-corrupt-summary",
        paths: {
          runDirectory,
          prdArtifact: join(runDirectory, "prd.md"),
          issuesDirectory: join(runDirectory, "issues"),
          executionArtifact,
        },
      });
      await fs.outputFile(executionArtifact, "{not json");
    },
  });

  assert.equal(result.commandError, undefined);
  assert.match(result.stdout, /Run summary unavailable: execution ledger could not be read\./);
  assert.doesNotMatch(result.stdout, /Run summary\n/);
  assert.equal(result.stderr, "");
});

test("cli formats stage artifact validation failures with stage, artifact, and next action", () => {
  const message = formatStageArtifactValidationError(
    new StageArtifactValidationError({
      stage: "prd",
      artifactPath: "/repo/.devflow/runs/run-1/prd.md",
      details: "Artifact is empty.",
    }),
  );

  assert.match(message, /prd stage/);
  assert.match(message, /\/repo\/\.devflow\/runs\/run-1\/prd\.md/);
  assert.match(message, /Re-run DevFlow/);
});

test("cli formats provider retry exhaustion with stage, provider, attempts, cause, and next action", () => {
  const message = formatProviderStageRetryExhaustedError(
    new ProviderStageRetryExhaustedError({
      stage: "issues",
      providerId: "codex",
      attempts: 2,
      cause: new Error("first line\nstack-like detail"),
    }),
  );

  assert.match(message, /issues stage/);
  assert.match(message, /codex/);
  assert.match(message, /2 attempts/);
  assert.match(message, /first line/);
  assert.doesNotMatch(message, /stack-like detail/);
  assert.match(message, /Re-run DevFlow/);
});

test("cli formats invalid intent artifacts with artifact path and new-run action", () => {
  const message = formatInvalidIntentArtifactError(
    new InvalidIntentArtifactError(
      "/repo/.devflow/runs/run-1/intent.json",
      "Expected object.",
    ),
  );

  assert.match(message, /intent artifact/);
  assert.match(message, /\/repo\/\.devflow\/runs\/run-1\/intent\.json/);
  assert.match(message, /Start a new DevFlow run/);
});

test("cli formats missing providers with provider guidance", () => {
  const message = formatMissingProviderIdError(new MissingProviderIdError());

  assert.match(message, /provider id/);
  assert.match(message, /Re-run DevFlow/);
  assert.match(message, /installed provider/);
});

test("cli maps stage artifact validation failures to concise user-facing errors", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-stage-artifact-"));

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new StageArtifactValidationError({
        stage: "prd",
        artifactPath: join(projectRoot, ".devflow", "runs", "run-1", "prd.md"),
        details: "Artifact is empty.",
      });
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /prd stage/);
  assert.match(result.stderr, /prd\.md/);
  assert.match(result.stderr, /Re-run DevFlow/);
});

test("cli maps provider stage retry exhaustion to concise user-facing errors", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-retry-exhausted-"));

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new ProviderStageRetryExhaustedError({
        stage: "issues",
        providerId: "codex",
        attempts: 2,
        cause: new Error("issues directory stayed empty\nError: stack detail"),
      });
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /issues stage/);
  assert.match(result.stderr, /codex/);
  assert.match(result.stderr, /2 attempts/);
  assert.match(result.stderr, /issues directory stayed empty/);
  assert.doesNotMatch(result.stderr, /stack detail/);
  assert.match(result.stderr, /Re-run DevFlow/);
});

test("cli maps invalid intent artifacts to concise user-facing errors", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-invalid-intent-"));

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new InvalidIntentArtifactError(
        join(projectRoot, ".devflow", "runs", "run-1", "intent.json"),
        "Expected object.",
      );
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /intent artifact/);
  assert.match(result.stderr, /intent\.json/);
  assert.match(result.stderr, /Start a new DevFlow run/);
});

test("cli maps missing provider errors to concise user-facing errors", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-missing-provider-"));

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw new MissingProviderIdError();
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /provider id/);
  assert.match(result.stderr, /Re-run DevFlow/);
  assert.match(result.stderr, /installed provider/);
});

test("cli maps unexpected errors to a redacted line and matching critical log entry", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-unexpected-error-"));
  const clock = { now: () => new Date("2026-05-24T10:11:12.000Z") };
  const devFlowState = createDevFlowState({ projectRoot, clock });
  const error = new TypeError("boom\n    at internal frame");

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    devFlowState,
    providerId: "codex",
    runExecutionRequest: async () => {
      throw error;
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^DevFlow hit an unexpected internal error\. Correlation ref: err_[0-9a-f]{6}\. Diagnostic log: .+\.devflow\/logs\/devflow-2026-05-24\.log\.\n$/,
  );
  assert.doesNotMatch(result.stderr, /TypeError/);
  assert.doesNotMatch(result.stderr, /boom/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);

  const ref = result.stderr.match(/err_[0-9a-f]{6}/)?.[0];
  const entries = fs
    .readFileSync(join(projectRoot, ".devflow", "logs", "devflow-2026-05-24.log"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(entries, [
    {
      ts: "2026-05-24T10:11:12.000Z",
      level: "critical",
      runId: null,
      ref,
      msg: "unexpected cli error",
      err: {
        name: "TypeError",
        message: "boom\n    at internal frame",
        stack: error.stack,
      },
    },
  ]);
});

test("cli formats non-error unexpected failures as a one-line generic error", () => {
  assert.equal(
    formatUnexpectedCliError({
      ref: "err_a1b2c3",
      logPath: "/repo/.devflow/logs/devflow-2026-05-24.log",
    }),
    "DevFlow hit an unexpected internal error. Correlation ref: err_a1b2c3. Diagnostic log: /repo/.devflow/logs/devflow-2026-05-24.log.",
  );
});

test("cli reuses a valid repo-local default provider config when no override is supplied", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-config-root-"));
  const devFlowState = createDevFlowState({ projectRoot });
  await devFlowState.config.save({ defaultProvider: "codex" });

  const receivedRequests: unknown[] = [];

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    runExecutionRequest: async (request) => {
      receivedRequests.push(request);
    },
  });

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedRequests, [
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
  ]);
});

test("cli gives --provider precedence over saved config for the current invocation only", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-provider-override-"));
  fs.outputFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "codex" }, null, 2),
  );

  const receivedRequests: unknown[] = [];
  let promptCallCount = 0;

  const result = await invokeCliWithOptions(
    ["--provider", "claude", "resume", "work"],
    {
      cwd: projectRoot,
      discoverProviders: async () => createDiscoveryResult(["claude", "codex"]),
      promptForProviderSelection: async () => {
        promptCallCount += 1;
        return "codex";
      },
      runExecutionRequest: async (request) => {
        receivedRequests.push(request);
      },
    },
  );

  assert.equal(result.commandError, undefined);
  assert.equal(promptCallCount, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedRequests, [
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "claude",
    },
  ]);
  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli passes through --model unchanged alongside a saved provider without persisting model state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-model-saved-provider-"));
  fs.outputFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "codex" }, null, 2),
  );

  const receivedRequests: unknown[] = [];

  const result = await invokeCliWithOptions(
    ["--model", "gpt-5.5/fast beta", "resume", "work"],
    {
      cwd: projectRoot,
      runExecutionRequest: async (request) => {
        receivedRequests.push(request);
      },
    },
  );

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedRequests, [
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5.5/fast beta",
    },
  ]);
  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli passes through --model unchanged with an explicit provider override without mutating saved config", async () => {
  const projectRoot = fs.mkdtempSync(
    join(tmpdir(), "devflow-cli-model-explicit-provider-"),
  );
  fs.outputFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "codex" }, null, 2),
  );

  const receivedRequests: unknown[] = [];

  const result = await invokeCliWithOptions(
    ["--provider", "claude", "--model", "claude-sonnet-4.5", "resume", "work"],
    {
      cwd: projectRoot,
      discoverProviders: async () => createDiscoveryResult(["claude", "codex"]),
      runExecutionRequest: async (request) => {
        receivedRequests.push(request);
      },
    },
  );

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedRequests, [
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "claude",
      model: "claude-sonnet-4.5",
    },
  ]);
  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli hands the orchestrator the exact resolved request when explicit provider and model overrides are supplied", async () => {
  const projectRoot = fs.mkdtempSync(
    join(tmpdir(), "devflow-cli-exact-resolved-request-"),
  );
  fs.outputFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "codex" }, null, 2),
  );

  const receivedRequests: unknown[] = [];

  const result = await invokeCliWithOptions(
    ["--provider", "claude", "--model", "gpt-5.5/fast beta", "resume", "work"],
    {
      cwd: projectRoot,
      discoverProviders: async () => createDiscoveryResult(["claude", "codex"]),
      runExecutionRequest: async (request) => {
        receivedRequests.push(request);
      },
    },
  );

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedRequests, [
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "claude",
      model: "gpt-5.5/fast beta",
    },
  ]);
  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli rejects unknown --provider values before bootstrap fallback", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-unknown-provider-"));
  fs.outputFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "codex" }, null, 2),
  );

  let discoveryCallCount = 0;

  const result = await invokeCliWithOptions(
    ["--provider", "not-real", "resume", "work"],
    {
      cwd: projectRoot,
      discoverProviders: async () => {
        discoveryCallCount += 1;
        return createDiscoveryResult(["claude", "codex"]);
      },
    },
  );

  assert.equal(discoveryCallCount, 0);
  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unsupported provider: not-real\./);
  assert.match(result.stderr, /Supported providers:/);
  assert.match(result.stderr, /Claude \(claude\)/);
});

test("cli rejects unavailable --provider overrides without mutating saved config", async () => {
  const projectRoot = fs.mkdtempSync(
    join(tmpdir(), "devflow-cli-unavailable-provider-override-"),
  );
  fs.outputFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "codex" }, null, 2),
  );

  const result = await invokeCliWithOptions(
    ["--provider", "claude", "resume", "work"],
    {
      cwd: projectRoot,
      discoverProviders: async () => createDiscoveryResult(["codex"]),
    },
  );

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Requested provider Claude \(claude\) is currently unavailable: Not installed\./,
  );
  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli fails fast when a saved default provider is no longer available", async () => {
  const projectRoot = fs.mkdtempSync(
    join(tmpdir(), "devflow-cli-unavailable-saved-provider-"),
  );
  fs.outputFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "claude" }, null, 2),
  );

  let promptCallCount = 0;

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
    discoverProviders: async () => createDiscoveryResult(["codex"]),
    promptForProviderSelection: async () => {
      promptCallCount += 1;
      return "codex";
    },
  });

  assert.equal(promptCallCount, 0);
  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Saved default provider Claude \(claude\) is currently unavailable: Not installed\./,
  );
});

test("cli rejects invalid repo-local provider config with repair guidance", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-invalid-config-"));
  fs.outputFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "not-real" }, null, 2),
  );

  const result = await invokeCliWithOptions(["resume", "work"], {
    cwd: projectRoot,
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Invalid DevFlow config at .*\.devflow\/config\.json\./,
  );
  assert.match(result.stderr, /defaultProvider/);
  assert.match(
    result.stderr,
    /Delete or repair the config file before running DevFlow again\./,
  );
});

test("cli does not create repo-local state when bootstrap already has an explicit provider", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-lazy-state-"));

  const result = await invokeCliWithOptions(["draft", "plan"], {
    cwd: projectRoot,
    providerId: "claude",
    runExecutionRequest: async () => {},
  });

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(fs.pathExistsSync(join(projectRoot, ".devflow")), false);
});

test("cli fails first-run setup with supported-provider guidance when no supported providers are installed", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-no-providers-"));
  let discoveryCallCount = 0;

  const result = await invokeCliWithOptions(["bootstrap", "repo"], {
    cwd: projectRoot,
    discoverProviders: async () => {
      discoveryCallCount += 1;
      return createDiscoveryResult([]);
    },
  });

  assert.equal(discoveryCallCount, 1);
  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /No supported providers are currently installed\./,
  );
  assert.match(result.stderr, /Claude \(claude\)/);
  assert.match(result.stderr, /Gemini \(gemini\)/);
  assert.match(result.stderr, /Codex \(codex\)/);
  assert.match(result.stderr, /OpenCode \(opencode\)/);
  assert.equal(fs.pathExistsSync(join(projectRoot, ".devflow")), false);
});

test("cli auto-selects and persists the only installed provider during first-run setup", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-auto-provider-"));
  const receivedRequests: unknown[] = [];
  let promptCallCount = 0;

  const result = await invokeCliWithOptions(["continue", "flow"], {
    cwd: projectRoot,
    discoverProviders: async () => createDiscoveryResult(["codex"]),
    promptForProviderSelection: async () => {
      promptCallCount += 1;
      return "claude";
    },
    runExecutionRequest: async (request) => {
      receivedRequests.push(request);
    },
  });

  assert.equal(result.commandError, undefined);
  assert.equal(promptCallCount, 0);
  assert.match(result.stdout, /Saved default provider: Codex \(codex\)\./);
  assert.equal(result.stderr, "");
  assert.deepEqual(receivedRequests, [
    {
      projectRoot,
      rawTask: "continue flow",
      providerId: "codex",
    },
  ]);
  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}\n',
  );
});

test("cli prompts once with canonical provider choices and disabled unavailable entries during first-run setup", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-prompt-provider-"));
  const receivedRequests: unknown[] = [];
  const promptCalls: unknown[] = [];

  const result = await invokeCliWithOptions(["continue", "flow"], {
    cwd: projectRoot,
    discoverProviders: async () => createDiscoveryResult(["claude", "codex"]),
    promptForProviderSelection: async (options) => {
      promptCalls.push(options);
      return "codex";
    },
    runExecutionRequest: async (request) => {
      receivedRequests.push(request);
    },
  });

  assert.equal(result.commandError, undefined);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Saved default provider: Codex \(codex\)\./);
  assert.deepEqual(promptCalls, [
    {
      message: "Select a default provider",
      choices: [
        { value: "claude", label: "Claude (claude)", disabled: false },
        {
          value: "gemini",
          label: "Gemini (gemini)",
          disabled: true,
          unavailableReason: "Not installed",
        },
        { value: "codex", label: "Codex (codex)", disabled: false },
        {
          value: "opencode",
          label: "OpenCode (opencode)",
          disabled: true,
          unavailableReason: "Not installed",
        },
      ],
    },
  ]);
  assert.deepEqual(receivedRequests, [
    {
      projectRoot,
      rawTask: "continue flow",
      providerId: "codex",
    },
  ]);
});

test("cli aborts first-run setup without writing config when provider selection is cancelled", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-cli-cancel-provider-"));
  const receivedRequests: unknown[] = [];

  const result = await invokeCliWithOptions(["continue", "flow"], {
    cwd: projectRoot,
    discoverProviders: async () => createDiscoveryResult(["claude", "codex"]),
    promptForProviderSelection: async () => undefined,
    runExecutionRequest: async (request) => {
      receivedRequests.push(request);
    },
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Provider setup was cancelled before a default was saved\./,
  );
  assert.deepEqual(receivedRequests, []);
  assert.equal(fs.pathExistsSync(join(projectRoot, ".devflow")), false);
});
