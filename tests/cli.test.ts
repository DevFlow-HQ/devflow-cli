import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command, CommanderError } from "commander";

import { BUILT_IN_PROVIDERS } from "../src/adapters/providerAdapter.js";
import { runCli } from "../src/cli.js";
import type { ProviderDiscoveryResult } from "../src/adapters/providerDiscovery.js";

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
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-git-root-"));
  const nestedDirectory = join(projectRoot, "packages", "feature");
  mkdirSync(nestedDirectory, { recursive: true });
  execFileSync("git", ["init"], { cwd: projectRoot });

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

test("cli falls back to the current directory outside git and fails with a clear orchestrator stub message", async () => {
  const currentDirectory = mkdtempSync(join(tmpdir(), "devflow-cli-no-git-"));

  const result = await invokeCliWithOptions(["draft", "plan"], {
    cwd: currentDirectory,
    providerId: "claude",
  });

  assert.equal(result.commandError?.code, "commander.error");
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Execution orchestration is not implemented yet\./,
  );
  assert.match(result.stderr, new RegExp(`Project root: ${currentDirectory}`));
  assert.match(result.stderr, /Task: draft plan/);
});

test("cli reuses a valid repo-local default provider config when no override is supplied", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-config-root-"));
  mkdirSync(join(projectRoot, ".devflow"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".devflow", "config.json"),
    JSON.stringify({ defaultProvider: "codex" }, null, 2),
  );

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
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-provider-override-"));
  mkdirSync(join(projectRoot, ".devflow"), { recursive: true });
  writeFileSync(
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
    await readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli passes through --model unchanged alongside a saved provider without persisting model state", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-model-saved-provider-"));
  mkdirSync(join(projectRoot, ".devflow"), { recursive: true });
  writeFileSync(
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
    await readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli passes through --model unchanged with an explicit provider override without mutating saved config", async () => {
  const projectRoot = mkdtempSync(
    join(tmpdir(), "devflow-cli-model-explicit-provider-"),
  );
  mkdirSync(join(projectRoot, ".devflow"), { recursive: true });
  writeFileSync(
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
    await readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli rejects unknown --provider values before bootstrap fallback", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-unknown-provider-"));
  mkdirSync(join(projectRoot, ".devflow"), { recursive: true });
  writeFileSync(
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
  const projectRoot = mkdtempSync(
    join(tmpdir(), "devflow-cli-unavailable-provider-override-"),
  );
  mkdirSync(join(projectRoot, ".devflow"), { recursive: true });
  writeFileSync(
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
    await readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}',
  );
});

test("cli fails fast when a saved default provider is no longer available", async () => {
  const projectRoot = mkdtempSync(
    join(tmpdir(), "devflow-cli-unavailable-saved-provider-"),
  );
  mkdirSync(join(projectRoot, ".devflow"), { recursive: true });
  writeFileSync(
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
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-invalid-config-"));
  mkdirSync(join(projectRoot, ".devflow"), { recursive: true });
  writeFileSync(
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
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-lazy-state-"));

  const result = await invokeCliWithOptions(["draft", "plan"], {
    cwd: projectRoot,
    providerId: "claude",
    runExecutionRequest: async () => {},
  });

  assert.equal(result.commandError, undefined);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(join(projectRoot, ".devflow")), false);
});

test("cli fails first-run setup with supported-provider guidance when no supported providers are installed", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-no-providers-"));
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
  assert.equal(existsSync(join(projectRoot, ".devflow")), false);
});

test("cli auto-selects and persists the only installed provider during first-run setup", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-auto-provider-"));
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
    await readFile(join(projectRoot, ".devflow", "config.json"), "utf8"),
    '{\n  "defaultProvider": "codex"\n}\n',
  );
});

test("cli prompts once with canonical provider choices and disabled unavailable entries during first-run setup", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-prompt-provider-"));
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
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-cli-cancel-provider-"));
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
  assert.equal(existsSync(join(projectRoot, ".devflow")), false);
});
