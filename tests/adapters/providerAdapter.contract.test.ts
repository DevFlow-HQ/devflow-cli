import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_PROVIDER_IDS,
  BUILT_IN_PROVIDERS,
  type ProviderAdapter,
  type ProviderRunInput,
} from "../../src/adapters/providerAdapter.js";

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
