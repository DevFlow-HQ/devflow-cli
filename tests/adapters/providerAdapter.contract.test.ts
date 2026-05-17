import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BUILT_IN_PROVIDER_IDS,
  BUILT_IN_PROVIDERS,
  type ProviderAdapter,
  type ProviderRunInput,
} from "../../src/adapters/providerAdapter.js";
import { createCodexAdapter } from "../../src/adapters/codexAdapter.js";

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

test("representative adapter detection resolves structured success and failure outcomes", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "devflow-codex-"));
  const availableBinDir = path.join(tempRoot, "available-bin");
  const missingBinDir = path.join(tempRoot, "missing-bin");

  await mkdir(availableBinDir);
  await mkdir(missingBinDir);

  const executablePath = path.join(availableBinDir, "codex");
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await chmod(executablePath, 0o755);

  process.env.PATH = availableBinDir;

  const availableResult = await createCodexAdapter().detect();

  assert.deepEqual(availableResult, {
    isAvailable: true,
    executable: executablePath,
  });

  process.env.PATH = missingBinDir;

  const missingResult = await createCodexAdapter().detect();

  assert.equal(missingResult.isAvailable, false);

  if (missingResult.isAvailable) {
    assert.fail("expected missing executable detection to report unavailable");
  }

  assert.match(missingResult.reason, /codex/i);
  assert.doesNotMatch(missingResult.reason, /Codex/);
});

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

test("representative adapter run launches in the target directory with prompt and optional model", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "devflow-codex-run-"));
  const binDir = path.join(tempRoot, "bin");
  const workingDirectory = path.join(tempRoot, "repo");
  const outputPath = path.join(tempRoot, "codex-output.txt");
  const executablePath = path.join(binDir, "codex");

  await mkdir(binDir);
  await mkdir(workingDirectory);
  await writeFile(
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
  await chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const result = await createCodexAdapter().run({
    prompt: "Ship the contract",
    workingDirectory,
    model: "gpt-5.5",
  });

  assert.deepEqual(result, {
    success: true,
    exitCode: 0,
    signal: null,
  });

  const output = await readFile(outputPath, "utf8");
  assert.match(output, new RegExp(`^cwd=${workingDirectory}$`, "m"));
  assert.match(output, /^argc=\d+$/m);
  assert.match(output, /^arg=Ship the contract$/m);
  assert.match(output, /^arg=gpt-5.5$/m);
});

test("representative adapter run resolves structured failure metadata for non-zero provider exits", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-nonzero-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const workingDirectory = path.join(tempRoot, "repo");
  const executablePath = path.join(binDir, "codex");

  await mkdir(binDir);
  await mkdir(workingDirectory);
  await writeFile(executablePath, "#!/bin/sh\nexit 7\n");
  await chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const result = await createCodexAdapter().run({
    prompt: "Ship the contract",
    workingDirectory,
  });

  assert.deepEqual(result, {
    success: false,
    exitCode: 7,
    signal: null,
  });
});

test("representative adapter run rejects launch failures distinctly from normal provider exits", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-launch-failure-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const workingDirectory = path.join(tempRoot, "repo");

  await mkdir(binDir);
  await mkdir(workingDirectory);

  process.env.PATH = binDir;

  await assert.rejects(
    () =>
      createCodexAdapter().run({
        prompt: "Ship the contract",
        workingDirectory,
      }),
    /codex/i,
  );
});
