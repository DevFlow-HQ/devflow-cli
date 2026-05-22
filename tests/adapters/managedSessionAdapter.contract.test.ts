import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

import {
  type BuiltInProviderId,
  getBuiltInProviderIdentity,
  BUILT_IN_PROVIDER_IDS,
  BUILT_IN_PROVIDERS,
} from "../../src/adapters/providers.js";
import {
  IncompleteProviderSessionError,
  ManagedProviderSessionNotImplementedError,
  ProviderSessionCleanupError,
  type ManagedSessionAdapter,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import { createClaudeAdapter } from "../../src/adapters/claudeAdapter.js";
import { createCodexAdapter } from "../../src/adapters/codexAdapter.js";
import { createGeminiAdapter } from "../../src/adapters/geminiAdapter.js";
import { createOpenCodeAdapter } from "../../src/adapters/opencodeAdapter.js";
import { createBuiltInManagedSessionAdapter } from "../../src/adapters/builtInManagedSessionAdapter.js";

interface AdapterContractHarness {
  providerId: BuiltInProviderId;
  command: string;
  displayName: string;
  createAdapter: () => ManagedSessionAdapter;
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

test("managed-session adapters expose static metadata plus async detect and runSession methods", async () => {
  const adapter: ManagedSessionAdapter = {
    provider: BUILT_IN_PROVIDERS[2],
    async detect() {
      return {
        isAvailable: true,
        executable: "codex",
      };
    },
    async runSession(input) {
      await input.validate();
      return {
        repairUsed: false,
        exitCode: 0,
        signal: null,
      };
    },
  };

  await assert.doesNotReject(() => adapter.detect());
  await assert.doesNotReject(() =>
    adapter.runSession({
      workingDirectory: "/tmp/devflow",
      initialPrompt: "Ship the contract",
      initialCompletionMarker: "DEVFLOW_DONE",
      async validate() {},
      model: "gpt-5.5",
    }),
  );
  assert.equal("run" in adapter, false);
});

test("managed-session input exposes validation and repair lifecycle configuration", () => {
  const input: ManagedProviderSessionInput = {
    workingDirectory: "/tmp/devflow",
    initialPrompt: "Ship the contract",
    initialCompletionMarker: "DEVFLOW_DONE",
    model: "gpt-5.5",
    async validate() {},
    repair: {
      completionMarker: "DEVFLOW_REPAIR_DONE",
      renderPrompt(error) {
        return `repair: ${error.message}`;
      },
      mapFailure(error) {
        return new Error(`mapped: ${error.message}`);
      },
    },
  };

  assert.equal(input.model, "gpt-5.5");
  assert.equal(
    input.repair?.renderPrompt(new Error("invalid")),
    "repair: invalid",
  );
});

test("fake managed-session lifecycle propagates original validation errors when repair is absent", async () => {
  const validationError = new Error("intent artifact missing");
  const input: ManagedProviderSessionInput = {
    workingDirectory: "/tmp/devflow",
    initialPrompt: "Ship the contract",
    initialCompletionMarker: "DEVFLOW_DONE",
    async validate() {
      throw validationError;
    },
  };

  async function runFakeManagedSession(
    sessionInput: ManagedProviderSessionInput,
  ) {
    try {
      await sessionInput.validate();
    } catch (error) {
      if (!sessionInput.repair) {
        throw error;
      }

      sessionInput.repair.renderPrompt(error as Error);
    }

    return { repairUsed: false, exitCode: 0, signal: null };
  }

  await assert.rejects(
    runFakeManagedSession(input),
    (error: unknown) => error === validationError,
  );
});

test("managed-session contract exposes typed lifecycle failures with provider identity", () => {
  const provider = getBuiltInProviderIdentity("codex");
  const incomplete = new IncompleteProviderSessionError({
    provider,
    completionMarker: "DEVFLOW_DONE",
    exitCode: 1,
    signal: null,
  });
  const cleanupCause = new Error("pty close failed");
  const cleanup = new ProviderSessionCleanupError(provider, cleanupCause);

  assert.equal(incomplete.name, "IncompleteProviderSessionError");
  assert.equal(incomplete.provider, provider);
  assert.equal(incomplete.completionMarker, "DEVFLOW_DONE");
  assert.equal(incomplete.exitCode, 1);
  assert.equal(incomplete.signal, null);
  assert.equal(cleanup.name, "ProviderSessionCleanupError");
  assert.equal(cleanup.provider, provider);
  assert.equal(cleanup.cause, cleanupCause);
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

const validRunInput: ManagedProviderSessionInput = {
  workingDirectory: "/tmp/devflow",
  initialPrompt: "Ship the contract",
  initialCompletionMarker: "DEVFLOW_DONE",
  async validate() {},
};

assert.equal(validRunInput.model, undefined);

const validRunInputWithModel: ManagedProviderSessionInput = {
  workingDirectory: "/tmp/devflow",
  initialPrompt: "Ship the contract",
  initialCompletionMarker: "DEVFLOW_DONE",
  async validate() {},
  model: "gpt-5.5",
};

assert.equal(validRunInputWithModel.model, "gpt-5.5");

const runInputWithArgs: ManagedProviderSessionInput = {
  workingDirectory: "/tmp/devflow",
  initialPrompt: "Ship the contract",
  initialCompletionMarker: "DEVFLOW_DONE",
  async validate() {},
  // @ts-expect-error Provider run input must not accept arbitrary CLI args.
  extraArgs: ["--dangerous"],
};

void runInputWithArgs;

const runInputWithEnvironment: ManagedProviderSessionInput = {
  workingDirectory: "/tmp/devflow",
  initialPrompt: "Ship the contract",
  initialCompletionMarker: "DEVFLOW_DONE",
  async validate() {},
  // @ts-expect-error Provider run input must not accept custom environment injection.
  env: { DEBUG: "1" },
};

void runInputWithEnvironment;

for (const harness of providerHarnesses) {
  test(`${harness.displayName} adapter runSession intentionally reports missing managed-session transport`, async () => {
    const adapter = harness.createAdapter();

    await assert.rejects(
      () =>
        adapter.runSession({
          workingDirectory: "/tmp/devflow",
          initialPrompt: "Ship the contract",
          initialCompletionMarker: "DEVFLOW_DONE",
          async validate() {},
          model: "gpt-5.5",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedProviderSessionNotImplementedError);
        assert.deepEqual(
          error.provider,
          getBuiltInProviderIdentity(harness.providerId),
        );
        return true;
      },
    );
  });

  test(`built-in managed-session selection wires ${harness.command} detection through the shared managed-session contract`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-${harness.command}-run-`),
    );
    const binDir = path.join(tempRoot, "bin");
    const executablePath = path.join(binDir, harness.command);

    await fs.ensureDir(binDir);
    await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(executablePath, 0o755);

    process.env.PATH = binDir;

    const adapter = createBuiltInManagedSessionAdapter(harness.providerId);

    assert.deepEqual(
      adapter.provider,
      getBuiltInProviderIdentity(harness.providerId),
    );

    const detection = await adapter.detect();
    assert.deepEqual(detection, {
      isAvailable: true,
      executable: executablePath,
    });

    assert.equal("run" in adapter, false);
  });
}
