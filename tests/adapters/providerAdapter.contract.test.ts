import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

import {
  BUILT_IN_PROVIDER_IDS,
  BUILT_IN_PROVIDERS,
  type BuiltInProviderId,
  getBuiltInProviderIdentity,
  type ProviderAdapter,
  type ProviderRunInput,
} from "../../src/adapters/providerAdapter.js";
import { createClaudeAdapter } from "../../src/adapters/claudeAdapter.js";
import { createCodexAdapter } from "../../src/adapters/codexAdapter.js";
import { createGeminiAdapter } from "../../src/adapters/geminiAdapter.js";
import { createOpenCodeAdapter } from "../../src/adapters/opencodeAdapter.js";
import { createBuiltInProviderAdapter } from "../../src/adapters/builtInProviderAdapter.js";

interface AdapterContractHarness {
  providerId: BuiltInProviderId;
  command: string;
  displayName: string;
  createAdapter: () => ProviderAdapter;
}

const providerHarnesses: AdapterContractHarness[] = [
  {
    providerId: "claude",
    command: "claude",
    displayName: "Claude",
    createAdapter: createClaudeAdapter,
  },
  {
    providerId: "gemini",
    command: "gemini",
    displayName: "Gemini",
    createAdapter: createGeminiAdapter,
  },
  {
    providerId: "codex",
    command: "codex",
    displayName: "Codex",
    createAdapter: createCodexAdapter,
  },
  {
    providerId: "opencode",
    command: "opencode",
    displayName: "OpenCode",
    createAdapter: createOpenCodeAdapter,
  },
];

test("built-in providers are defined from a single runtime source of truth", () => {
  assert.deepEqual(BUILT_IN_PROVIDER_IDS, [
    "claude",
    "gemini",
    "codex",
    "opencode",
  ]);

  assert.deepEqual(
    BUILT_IN_PROVIDERS.map((provider) => provider.id),
    BUILT_IN_PROVIDER_IDS,
  );

  assert.deepEqual(
    BUILT_IN_PROVIDERS.map((provider) => provider.displayName),
    ["Claude", "Gemini", "Codex", "OpenCode"],
  );
});

test("provider identity lookup stays aligned with the built-in provider constants", () => {
  const lookedUpProviders = BUILT_IN_PROVIDER_IDS.map((providerId) =>
    getBuiltInProviderIdentity(providerId),
  );

  assert.deepEqual(lookedUpProviders, BUILT_IN_PROVIDERS);
  assert.equal(getBuiltInProviderIdentity("claude").displayName, "Claude");
  assert.equal(getBuiltInProviderIdentity("gemini").displayName, "Gemini");
  assert.equal(getBuiltInProviderIdentity("codex").displayName, "Codex");
});

test("provider adapters expose static metadata plus async detect and run methods", async () => {
  const adapter: ProviderAdapter = {
    provider: BUILT_IN_PROVIDERS[2],
    async detect() {
      return {
        isAvailable: true,
        executable: "codex",
      };
    },
    async run(input) {
      return {
        success: input.prompt.length > 0,
        exitCode: 0,
        signal: null,
      };
    },
  };

  await assert.doesNotReject(() => adapter.detect());
  await assert.doesNotReject(() =>
    adapter.run({
      prompt: "Ship the contract",
      workingDirectory: "/tmp/devflow",
      model: "gpt-5.5",
    }),
  );
});

for (const harness of providerHarnesses) {
  test(`${harness.displayName} adapter detection resolves structured success and failure outcomes`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-${harness.command}-`),
    );
    const availableBinDir = path.join(tempRoot, "available-bin");
    const missingBinDir = path.join(tempRoot, "missing-bin");

    await fs.ensureDir(availableBinDir);
    await fs.ensureDir(missingBinDir);

    const executablePath = path.join(availableBinDir, harness.command);
    await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(executablePath, 0o755);

    process.env.PATH = availableBinDir;

    const availableResult = await harness.createAdapter().detect();

    assert.deepEqual(availableResult, {
      isAvailable: true,
      executable: executablePath,
    });

    process.env.PATH = missingBinDir;

    const missingResult = await harness.createAdapter().detect();

    assert.equal(missingResult.isAvailable, false);

    if (missingResult.isAvailable) {
      assert.fail("expected missing executable detection to report unavailable");
    }

    assert.match(missingResult.reason, new RegExp(harness.command, "i"));
    assert.doesNotMatch(
      missingResult.reason,
      new RegExp(harness.displayName),
    );
  });
}

const validRunInput: ProviderRunInput = {
  prompt: "Ship the contract",
  workingDirectory: "/tmp/devflow",
};

assert.equal(validRunInput.model, undefined);

const validRunInputWithModel: ProviderRunInput = {
  prompt: "Ship the contract",
  workingDirectory: "/tmp/devflow",
  model: "gpt-5.5",
};

assert.equal(validRunInputWithModel.model, "gpt-5.5");

const runInputWithArgs: ProviderRunInput = {
  prompt: "Ship the contract",
  workingDirectory: "/tmp/devflow",
  // @ts-expect-error Provider run input must not accept arbitrary CLI args.
  extraArgs: ["--dangerous"],
};

void runInputWithArgs;

const runInputWithEnvironment: ProviderRunInput = {
  prompt: "Ship the contract",
  workingDirectory: "/tmp/devflow",
  // @ts-expect-error Provider run input must not accept custom environment injection.
  env: { DEBUG: "1" },
};

void runInputWithEnvironment;

for (const harness of providerHarnesses) {
  test(`${harness.displayName} adapter run launches in the target directory with prompt and optional model`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-${harness.command}-run-`),
    );
    const binDir = path.join(tempRoot, "bin");
    const workingDirectory = path.join(tempRoot, "repo");
    const outputPath = path.join(tempRoot, `${harness.command}-output.txt`);
    const executablePath = path.join(binDir, harness.command);

    await fs.ensureDir(binDir);
    await fs.ensureDir(workingDirectory);
    await fs.writeFile(
      executablePath,
      [
        "#!/bin/sh",
        `printf 'cwd=%s\\n' \"$PWD\" > "${outputPath}"`,
        `printf 'argc=%s\\n' \"$#\" >> "${outputPath}"`,
        "for arg in \"$@\"; do",
        `  printf 'arg=%s\\n' \"$arg\" >> "${outputPath}"`,
        "done",
        "exit 0",
        "",
      ].join("\n"),
    );
    await fs.chmod(executablePath, 0o755);

    process.env.PATH = binDir;

    const result = await harness.createAdapter().run({
      prompt: "Ship the contract",
      workingDirectory,
      model: "gpt-5.5",
    });

    assert.deepEqual(result, {
      success: true,
      exitCode: 0,
      signal: null,
    });

    const output = await fs.readFile(outputPath, "utf8");
    assert.match(output, new RegExp(`^cwd=${workingDirectory}$`, "m"));
    assert.match(output, /^argc=\d+$/m);
    assert.match(output, /^arg=Ship the contract$/m);
    assert.match(output, /^arg=gpt-5.5$/m);
  });

  test(`${harness.displayName} adapter run resolves structured failure metadata for non-zero provider exits`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-${harness.command}-nonzero-`),
    );
    const binDir = path.join(tempRoot, "bin");
    const workingDirectory = path.join(tempRoot, "repo");
    const executablePath = path.join(binDir, harness.command);

    await fs.ensureDir(binDir);
    await fs.ensureDir(workingDirectory);
    await fs.writeFile(executablePath, "#!/bin/sh\nexit 7\n");
    await fs.chmod(executablePath, 0o755);

    process.env.PATH = binDir;

    const result = await harness.createAdapter().run({
      prompt: "Ship the contract",
      workingDirectory,
    });

    assert.deepEqual(result, {
      success: false,
      exitCode: 7,
      signal: null,
    });
  });

  test(`${harness.displayName} adapter run rejects launch failures distinctly from normal provider exits`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-${harness.command}-launch-failure-`),
    );
    const binDir = path.join(tempRoot, "bin");
    const workingDirectory = path.join(tempRoot, "repo");

    await fs.ensureDir(binDir);
    await fs.ensureDir(workingDirectory);

    process.env.PATH = binDir;

    await assert.rejects(
      () =>
        harness.createAdapter().run({
          prompt: "Ship the contract",
          workingDirectory,
        }),
      new RegExp(harness.command, "i"),
    );
  });

  test(`built-in provider selection wires ${harness.command} end to end through the shared adapter contract`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-built-in-${harness.command}-`),
    );
    const binDir = path.join(tempRoot, "bin");
    const workingDirectory = path.join(tempRoot, "repo");
    const outputPath = path.join(tempRoot, `${harness.command}-output.txt`);
    const executablePath = path.join(binDir, harness.command);

    await fs.ensureDir(binDir);
    await fs.ensureDir(workingDirectory);
    await fs.writeFile(
      executablePath,
      [
        "#!/bin/sh",
        `printf 'cwd=%s\\n' \"$PWD\" > "${outputPath}"`,
        "for arg in \"$@\"; do",
        `  printf 'arg=%s\\n' \"$arg\" >> "${outputPath}"`,
        "done",
        "exit 0",
        "",
      ].join("\n"),
    );
    await fs.chmod(executablePath, 0o755);

    process.env.PATH = binDir;

    const adapter = createBuiltInProviderAdapter(harness.providerId);

    assert.deepEqual(
      adapter.provider,
      getBuiltInProviderIdentity(harness.providerId),
    );

    const detection = await adapter.detect();
    assert.deepEqual(detection, {
      isAvailable: true,
      executable: executablePath,
    });

    const result = await adapter.run({
      prompt: "Ship through the contract",
      workingDirectory,
    });

    assert.deepEqual(result, {
      success: true,
      exitCode: 0,
      signal: null,
    });

    const output = await fs.readFile(outputPath, "utf8");
    assert.match(output, new RegExp(`^cwd=${workingDirectory}$`, "m"));
    assert.match(output, /^arg=Ship through the contract$/m);
  });
}
