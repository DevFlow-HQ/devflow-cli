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
  InterruptedProviderSessionError,
  ProviderSessionLaunchError,
  ProviderSessionCleanupError,
  ProviderSessionTranscriptCaptureError,
  ProviderSessionEventCaptureError,
  type ManagedSessionAdapter,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionPhase,
  type ManagedProviderSessionCapabilities,
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
  expectedArgsWithoutModel: string[];
  expectedArgsWithModel: string[];
  cleanupCommand: string;
  createAdapter: (options?: {
    runPtyManagedSession: CapturingPtyRunner["runPtyManagedSession"];
  }) => ManagedSessionAdapter;
}

class CapturingPtyRunner {
  readonly calls: Array<{
    command: {
      provider: ReturnType<typeof getBuiltInProviderIdentity>;
      executable: string;
      args: string[];
      cleanupCommand?: string;
    };
    input: ManagedProviderSessionInput;
  }> = [];

  async runPtyManagedSession(
    command: {
      provider: ReturnType<typeof getBuiltInProviderIdentity>;
      executable: string;
      args: string[];
      cleanupCommand?: string;
    },
    input: ManagedProviderSessionInput,
  ): Promise<ManagedProviderSessionResult> {
    this.calls.push({ command, input });
    await input.validate();
    return {
      repairUsed: false,
      exitCode: 0,
      signal: null,
    };
  }
}

const providerHarnesses: AdapterContractHarness[] = [
  {
    providerId: "claude",
    command: "claude",
    displayName: "Claude",
    expectedArgsWithoutModel: ["Ship the contract"],
    expectedArgsWithModel: ["--model", "gpt-5.5", "Ship the contract"],
    cleanupCommand: "/exit\n",
    createAdapter: createClaudeAdapter,
  },
  {
    providerId: "gemini",
    command: "gemini",
    displayName: "Gemini",
    expectedArgsWithoutModel: ["--prompt-interactive", "Ship the contract"],
    expectedArgsWithModel: [
      "--model",
      "gpt-5.5",
      "--prompt-interactive",
      "Ship the contract",
    ],
    cleanupCommand: "/quit\n",
    createAdapter: createGeminiAdapter,
  },
  {
    providerId: "codex",
    command: "codex",
    displayName: "Codex",
    expectedArgsWithoutModel: ["Ship the contract"],
    expectedArgsWithModel: ["--model", "gpt-5.5", "Ship the contract"],
    cleanupCommand: "/quit\n",
    createAdapter: createCodexAdapter,
  },
  {
    providerId: "opencode",
    command: "opencode",
    displayName: "OpenCode",
    expectedArgsWithoutModel: ["--prompt", "Ship the contract"],
    expectedArgsWithModel: ["--model", "gpt-5.5", "--prompt", "Ship the contract"],
    cleanupCommand: "/exit\n",
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
    transcript: {
      onProviderOutput(chunk) {
        assert.equal(chunk, "provider text");
      },
      onSubmittedUserMessage(message) {
        assert.equal(message, "user text");
      },
    },
    continuations: [
      {
        prompt: "Continue with the next phase",
        completionMarker: "DEVFLOW_NEXT_DONE",
        onStart() {},
        async validate() {},
      },
    ],
  };

  assert.equal(input.model, "gpt-5.5");
  assert.equal(
    input.repair?.renderPrompt(new Error("invalid")),
    "repair: invalid",
  );
  assert.equal(input.continuations?.[0]?.prompt, "Continue with the next phase");
  assert.equal(
    input.continuations?.[0]?.completionMarker,
    "DEVFLOW_NEXT_DONE",
  );
  input.transcript?.onProviderOutput?.("provider text");
  input.transcript?.onSubmittedUserMessage?.("user text");
});

test("managed-session contract exposes normalized provider events, phases, callbacks, and capabilities", async () => {
  const provider = getBuiltInProviderIdentity("codex");
  const phase: ManagedProviderSessionPhase = {
    id: "prd:initial",
    kind: "prd",
    attempt: 1,
  };
  const capabilities: ManagedProviderSessionCapabilities = {
    controlTransport: "pty",
    eventSource: "pty",
    supportsProviderSessionId: false,
    supportsResume: false,
  };
  const events: ManagedProviderSessionEvent[] = [
    {
      type: "session-start",
      source: "pty",
      structured: false,
      phaseId: phase.id,
      providerSessionId: "session-123",
      provider,
    },
    {
      type: "submitted-user-message",
      source: "pty",
      structured: false,
      phaseId: phase.id,
      provider,
      message: "Please continue",
    },
    {
      type: "assistant-message",
      source: "pty",
      structured: false,
      phaseId: phase.id,
      provider,
      content: "Working...",
    },
    {
      type: "turn-completed",
      source: "provider",
      structured: true,
      phaseId: phase.id,
      provider,
    },
    {
      type: "session-completed",
      source: "provider",
      structured: true,
      provider,
      exitCode: 0,
      signal: null,
    },
    {
      type: "session-failed",
      source: "pty",
      structured: false,
      phaseId: phase.id,
      provider,
      error: "completion marker missing",
    },
  ];
  const capturedEvents: ManagedProviderSessionEvent[] = [];
  const input: ManagedProviderSessionInput = {
    workingDirectory: "/tmp/devflow",
    initialPrompt: "Ship the contract",
    initialCompletionMarker: "DEVFLOW_DONE",
    phase,
    async validate() {},
    onProviderEvent(event) {
      capturedEvents.push(event);
    },
  };
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities,
    async detect() {
      return {
        isAvailable: true,
        executable: "codex",
      };
    },
    async runSession(sessionInput) {
      for (const event of events) {
        await sessionInput.onProviderEvent?.(event);
      }

      return {
        repairUsed: false,
        exitCode: 0,
        signal: null,
      };
    },
  };

  assert.equal(input.phase?.kind, "prd");
  assert.equal(input.phase?.attempt, 1);
  await adapter.runSession(input);
  assert.deepEqual(capturedEvents, events);
  assert.deepEqual(adapter.capabilities, capabilities);
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
  const launchCause = new Error("spawn ENOENT");
  const launch = new ProviderSessionLaunchError(provider, launchCause);
  const incomplete = new IncompleteProviderSessionError({
    provider,
    completionMarker: "DEVFLOW_DONE",
    exitCode: 1,
    signal: null,
  });
  const interrupted = new InterruptedProviderSessionError({
    provider,
    exitCode: 130,
    signal: "SIGINT",
  });
  const cleanupCause = new Error("pty close failed");
  const cleanup = new ProviderSessionCleanupError(provider, cleanupCause);
  const transcriptCause = new Error("append failed");
  const transcript = new ProviderSessionTranscriptCaptureError(
    provider,
    transcriptCause,
  );
  const eventCause = new Error("callback failed");
  const eventCapture = new ProviderSessionEventCaptureError(
    provider,
    eventCause,
  );

  assert.equal(launch.name, "ProviderSessionLaunchError");
  assert.equal(launch.provider, provider);
  assert.equal(launch.cause, launchCause);
  assert.equal(incomplete.name, "IncompleteProviderSessionError");
  assert.equal(incomplete.provider, provider);
  assert.equal(incomplete.completionMarker, "DEVFLOW_DONE");
  assert.equal(incomplete.exitCode, 1);
  assert.equal(incomplete.signal, null);
  assert.equal(interrupted.name, "InterruptedProviderSessionError");
  assert.equal(interrupted.provider, provider);
  assert.equal(interrupted.exitCode, 130);
  assert.equal(interrupted.signal, "SIGINT");
  assert.equal(cleanup.name, "ProviderSessionCleanupError");
  assert.equal(cleanup.provider, provider);
  assert.equal(cleanup.cause, cleanupCause);
  assert.equal(transcript.name, "ProviderSessionTranscriptCaptureError");
  assert.equal(transcript.provider, provider);
  assert.equal(transcript.cause, transcriptCause);
  assert.equal(eventCapture.name, "ProviderSessionEventCaptureError");
  assert.equal(eventCapture.provider, provider);
  assert.equal(eventCapture.cause, eventCause);
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
  test(`${harness.displayName} adapter runSession delegates provider startup config to the shared PTY runner`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-${harness.command}-pty-`),
    );
    const binDir = path.join(tempRoot, "bin");
    const executablePath = path.join(binDir, harness.command);

    await fs.ensureDir(binDir);
    await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(executablePath, 0o755);

    process.env.PATH = binDir;

    const runner = new CapturingPtyRunner();
    const adapter = harness.createAdapter({
      runPtyManagedSession: runner.runPtyManagedSession.bind(runner),
    });

    const result = await adapter.runSession(validRunInput);

    assert.deepEqual(result, {
      repairUsed: false,
      exitCode: 0,
      signal: null,
    });
    assert.deepEqual(runner.calls, [
      {
        command: {
          provider: getBuiltInProviderIdentity(harness.providerId),
          executable: executablePath,
          args: harness.expectedArgsWithoutModel,
          cleanupCommand: harness.cleanupCommand,
        },
        input: validRunInput,
      },
    ]);
  });

  test(`${harness.displayName} adapter passes opaque model overrides through provider-native flags`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-${harness.command}-model-`),
    );
    const binDir = path.join(tempRoot, "bin");
    const executablePath = path.join(binDir, harness.command);

    await fs.ensureDir(binDir);
    await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(executablePath, 0o755);

    process.env.PATH = binDir;

    const runner = new CapturingPtyRunner();
    const adapter = harness.createAdapter({
      runPtyManagedSession: runner.runPtyManagedSession.bind(runner),
    });

    await adapter.runSession(validRunInputWithModel);

    assert.deepEqual(runner.calls[0]?.command, {
      provider: getBuiltInProviderIdentity(harness.providerId),
      executable: executablePath,
      args: harness.expectedArgsWithModel,
      cleanupCommand: harness.cleanupCommand,
    });
  });

  test(`${harness.displayName} adapter maps launch-time executable resolution failures`, async (t) => {
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
    });

    const missingBinDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `devflow-${harness.command}-missing-run-`),
    );

    process.env.PATH = missingBinDir;

    const runner = new CapturingPtyRunner();
    const adapter = harness.createAdapter({
      runPtyManagedSession: runner.runPtyManagedSession.bind(runner),
    });

    await assert.rejects(adapter.runSession(validRunInput), (error: unknown) => {
      assert.ok(error instanceof ProviderSessionLaunchError);
      assert.equal(error.provider, getBuiltInProviderIdentity(harness.providerId));
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, new RegExp(harness.command, "i"));
      return true;
    });
    assert.deepEqual(runner.calls, []);
  });

  test(`built-in managed-session selection wires ${harness.command} execution through the shared managed-session contract`, async (t) => {
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

    const runner = new CapturingPtyRunner();
    const adapter = createBuiltInManagedSessionAdapter(harness.providerId, {
      runPtyManagedSession: runner.runPtyManagedSession.bind(runner),
    });

    assert.deepEqual(
      adapter.provider,
      getBuiltInProviderIdentity(harness.providerId),
    );

    const detection = await adapter.detect();
    assert.deepEqual(detection, {
      isAvailable: true,
      executable: executablePath,
    });

    await adapter.runSession(validRunInput);

    assert.deepEqual(runner.calls, [
      {
        command: {
          provider: getBuiltInProviderIdentity(harness.providerId),
          executable: executablePath,
          args: harness.expectedArgsWithoutModel,
          cleanupCommand: harness.cleanupCommand,
        },
        input: validRunInput,
      },
    ]);
    assert.equal("run" in adapter, false);
  });
}
