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
  type ManagedProviderSessionResumeInput,
  type ManagedProviderSessionResult,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionPhase,
  type ManagedProviderSessionCapabilities,
  type SubmittedUserMessageOrigin,
  canResumeManagedProviderSession,
} from "../../src/adapters/managedSessionAdapter.js";
import { createClaudeAdapter } from "../../src/adapters/claudeAdapter.js";
import { createCodexAdapter } from "../../src/adapters/codexAdapter.js";
import { createGeminiAdapter } from "../../src/adapters/geminiAdapter.js";
import { createOpenCodeAdapter } from "../../src/adapters/opencodeAdapter.js";
import { createBuiltInManagedSessionAdapter } from "../../src/adapters/builtInManagedSessionAdapter.js";
import type { ClaudeHookDrivenSessionCommand } from "../../src/adapters/claudeHookDrivenSessionRunner.js";
import type { ClaudeJsonlSessionCommand } from "../../src/adapters/claudeJsonlSessionRunner.js";
import type { CodexHookDrivenSessionCommand } from "../../src/adapters/codexHookDrivenSessionRunner.js";
import type { CodexJsonlSessionCommand } from "../../src/adapters/codexJsonlSessionRunner.js";

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

interface CodexAdapterContractHarness {
  providerId: "codex";
  command: "codex";
  displayName: "Codex";
  expectedArgsWithoutModel: string[];
  expectedArgsWithModel: string[];
  createAdapter: (options?: {
    runCodexHookDrivenSession: CapturingCodexHookRunner["runCodexHookDrivenSession"];
    runCodexJsonlSession?: CapturingCodexJsonlRunner["runCodexJsonlSession"];
    eventSource?: "hooks" | "jsonl";
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

class CapturingCodexHookRunner {
  readonly calls: Array<{
    command: CodexHookDrivenSessionCommand;
    input: ManagedProviderSessionInput | ManagedProviderSessionResumeInput;
  }> = [];

  async runCodexHookDrivenSession(
    command: CodexHookDrivenSessionCommand,
    input: ManagedProviderSessionInput | ManagedProviderSessionResumeInput,
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

class CapturingClaudeHookRunner {
  readonly calls: Array<{
    command: ClaudeHookDrivenSessionCommand;
    input: ManagedProviderSessionInput | ManagedProviderSessionResumeInput;
  }> = [];

  async runClaudeHookDrivenSession(
    command: ClaudeHookDrivenSessionCommand,
    input: ManagedProviderSessionInput | ManagedProviderSessionResumeInput,
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

class CapturingClaudeJsonlRunner {
  readonly calls: Array<{
    command: ClaudeJsonlSessionCommand;
    input: ManagedProviderSessionInput | ManagedProviderSessionResumeInput;
  }> = [];

  async runClaudeJsonlSession(
    command: ClaudeJsonlSessionCommand,
    input: ManagedProviderSessionInput | ManagedProviderSessionResumeInput,
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

class CapturingCodexJsonlRunner {
  readonly calls: Array<{
    command: CodexJsonlSessionCommand;
    input: ManagedProviderSessionInput | ManagedProviderSessionResumeInput;
  }> = [];

  async runCodexJsonlSession(
    command: CodexJsonlSessionCommand,
    input: ManagedProviderSessionInput | ManagedProviderSessionResumeInput,
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
    providerId: "opencode",
    command: "opencode",
    displayName: "OpenCode",
    expectedArgsWithoutModel: ["--prompt", "Ship the contract"],
    expectedArgsWithModel: ["--model", "gpt-5.5", "--prompt", "Ship the contract"],
    cleanupCommand: "/exit\n",
    createAdapter: createOpenCodeAdapter,
  },
];

const codexHarness: CodexAdapterContractHarness = {
  providerId: "codex",
  command: "codex",
  displayName: "Codex",
  expectedArgsWithoutModel: ["Ship the contract"],
  expectedArgsWithModel: ["--model", "gpt-5.5", "Ship the contract"],
  createAdapter: createCodexAdapter,
};

const allProviderHarnesses = [
  ...providerHarnesses,
  codexHarness,
].sort(
  (left, right) =>
    BUILT_IN_PROVIDER_IDS.indexOf(left.providerId) -
    BUILT_IN_PROVIDER_IDS.indexOf(right.providerId),
);

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

test("managed-session contract exposes a distinct resume entry point gated by truthful capabilities", async () => {
  const provider = getBuiltInProviderIdentity("codex");
  const resumeInputs: ManagedProviderSessionResumeInput[] = [];
  const resumeInput: ManagedProviderSessionResumeInput = {
    providerSessionId: "codex-session-123",
    workingDirectory: "/tmp/devflow",
    initialPrompt: "Continue the interrupted grill.",
    initialCompletionMarker: "DEVFLOW_DONE",
    phase: {
      id: "grill:resume",
      kind: "grill",
      attempt: 2,
    },
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
    continuations: [
      {
        prompt: "Continue into PRD synthesis",
        completionMarker: "DEVFLOW_PRD_DONE",
        async validate() {},
      },
    ],
    transcript: {
      onSubmittedUserMessage() {},
      onProviderOutput() {},
    },
    onProviderEvent() {},
  };
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      throw new Error("fresh runSession should stay distinct from resumeSession");
    },
    async resumeSession(input) {
      resumeInputs.push(input);
      await input.validate();
      return {
        repairUsed: false,
        exitCode: 0,
        signal: null,
      };
    },
  };

  assert.equal(canResumeManagedProviderSession(adapter), true);
  if (!canResumeManagedProviderSession(adapter)) {
    assert.fail("expected adapter to support resume");
  }
  await assert.doesNotReject(() => adapter.resumeSession(resumeInput));
  assert.deepEqual(resumeInputs, [resumeInput]);
});

test("managed-session resume guard requires provider session ids, resume capability, and resume entry point", () => {
  const provider = getBuiltInProviderIdentity("codex");
  const baseAdapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
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

  const resumeSession: NonNullable<ManagedSessionAdapter["resumeSession"]> =
    async (input) => {
      await input.validate();
      return {
        repairUsed: false,
        exitCode: 0,
        signal: null,
      };
    };

  assert.equal(
    canResumeManagedProviderSession({
      ...baseAdapter,
      capabilities: {
        controlTransport: "pty",
        eventSource: "hooks",
        supportsProviderSessionId: true,
        supportsResume: true,
        classifiesSubmittedUserMessageOrigin: true,
      },
    }),
    false,
  );
  assert.equal(
    canResumeManagedProviderSession({
      ...baseAdapter,
      resumeSession,
      capabilities: {
        controlTransport: "pty",
        eventSource: "hooks",
        supportsProviderSessionId: false,
        supportsResume: true,
        classifiesSubmittedUserMessageOrigin: true,
      },
    }),
    false,
  );
  assert.equal(
    canResumeManagedProviderSession({
      ...baseAdapter,
      resumeSession,
      capabilities: {
        controlTransport: "pty",
        eventSource: "hooks",
        supportsProviderSessionId: true,
        supportsResume: false,
        classifiesSubmittedUserMessageOrigin: true,
      },
    }),
    false,
  );
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
    classifiesSubmittedUserMessageOrigin: false,
  };
  const submittedUserMessageOrigins: SubmittedUserMessageOrigin[] = [
    "managed",
    "human",
    "unknown",
  ];
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
      origin: "managed",
    },
    {
      type: "turn-completed",
      source: "hooks",
      structured: true,
      phaseId: phase.id,
      provider,
      assistantMessage: "Working...",
    },
    {
      type: "session-completed",
      source: "jsonl",
      structured: true,
      provider,
      exitCode: 0,
      signal: null,
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
  assert.deepEqual(submittedUserMessageOrigins, ["managed", "human", "unknown"]);
  await adapter.runSession(input);
  assert.deepEqual(capturedEvents, events);
  assert.deepEqual(adapter.capabilities, capabilities);
});

test("built-in managed-session adapters expose effective PTY fallback and default Codex hook capabilities", () => {
  const expectedPtyCapabilities: ManagedProviderSessionCapabilities = {
    controlTransport: "pty",
    eventSource: "pty",
    supportsProviderSessionId: false,
    supportsResume: false,
    classifiesSubmittedUserMessageOrigin: false,
  };
  const expectedCodexCapabilities: ManagedProviderSessionCapabilities = {
    controlTransport: "pty",
    eventSource: "hooks",
    supportsProviderSessionId: true,
    supportsResume: true,
    classifiesSubmittedUserMessageOrigin: true,
  };

  const adapters = BUILT_IN_PROVIDER_IDS.map((providerId) =>
    createBuiltInManagedSessionAdapter(providerId),
  );

  assert.deepEqual(
    adapters.map((adapter) => ({
      providerId: adapter.provider.id,
      capabilities: adapter.capabilities,
      canResume: canResumeManagedProviderSession(adapter),
      hasResumeSession: typeof adapter.resumeSession === "function",
    })),
    BUILT_IN_PROVIDER_IDS.map((providerId) => ({
      providerId,
      capabilities:
        providerId === "codex"
          ? expectedCodexCapabilities
          : expectedPtyCapabilities,
      canResume: providerId === "codex",
      hasResumeSession: providerId === "codex",
    })),
  );
});

test("Codex adapter exposes selected JSONL capabilities without changing automatic hook default", () => {
  assert.equal(createCodexAdapter().capabilities?.eventSource, "hooks");
  assert.equal(
    createBuiltInManagedSessionAdapter("codex").capabilities?.eventSource,
    "hooks",
  );

  const jsonlCapabilities: ManagedProviderSessionCapabilities = {
    controlTransport: "pty",
    eventSource: "jsonl",
    supportsProviderSessionId: true,
    supportsResume: true,
    classifiesSubmittedUserMessageOrigin: true,
  };

  assert.deepEqual(
    createCodexAdapter({ eventSource: "jsonl" }).capabilities,
    jsonlCapabilities,
  );
  assert.deepEqual(
    createBuiltInManagedSessionAdapter("codex", {
      codexEventSource: "jsonl",
    }).capabilities,
    jsonlCapabilities,
  );
});

test("Claude adapter exposes hook-mode capabilities including resume support", () => {
  const hookCapabilities: ManagedProviderSessionCapabilities = {
    controlTransport: "pty",
    eventSource: "hooks",
    supportsProviderSessionId: true,
    supportsResume: true,
    classifiesSubmittedUserMessageOrigin: true,
  };

  assert.deepEqual(
    createClaudeAdapter({ eventSource: "hooks" }).capabilities,
    hookCapabilities,
  );
  assert.equal(
    canResumeManagedProviderSession(createClaudeAdapter({ eventSource: "hooks" })),
    true,
  );
  assert.equal(createClaudeAdapter().capabilities?.eventSource, "pty");
  assert.equal(
    createBuiltInManagedSessionAdapter("claude").capabilities?.eventSource,
    "pty",
  );
  assert.deepEqual(
    createBuiltInManagedSessionAdapter("claude", {
      claudeEventSource: "hooks",
    }).capabilities,
    hookCapabilities,
  );
});

test("Claude adapter exposes JSONL only when explicitly selected", () => {
  const ptyCapabilities: ManagedProviderSessionCapabilities = {
    controlTransport: "pty",
    eventSource: "pty",
    supportsProviderSessionId: false,
    supportsResume: false,
    classifiesSubmittedUserMessageOrigin: false,
  };

  assert.deepEqual(createClaudeAdapter().capabilities, ptyCapabilities);
  assert.equal(typeof createClaudeAdapter().resumeSession, "undefined");
  assert.equal(
    canResumeManagedProviderSession(createClaudeAdapter()),
    false,
  );
  assert.deepEqual(createClaudeAdapter({ eventSource: "jsonl" }).capabilities, {
    controlTransport: "pty",
    eventSource: "jsonl",
    supportsProviderSessionId: true,
    supportsResume: true,
    classifiesSubmittedUserMessageOrigin: true,
  });
  assert.equal(
    canResumeManagedProviderSession(createClaudeAdapter({ eventSource: "jsonl" })),
    true,
  );
  assert.deepEqual(
    createBuiltInManagedSessionAdapter("claude", {
      claudeEventSource: "jsonl",
    }).capabilities,
    {
      controlTransport: "pty",
      eventSource: "jsonl",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
  );
});

const validResumeInput: ManagedProviderSessionResumeInput = {
  providerSessionId: "codex-session-123",
  workingDirectory: "/tmp/devflow",
  initialPrompt: "Continue the interrupted work",
  initialCompletionMarker: "RESUME_DONE",
  async validate() {},
};

const validResumeInputWithModel: ManagedProviderSessionResumeInput = {
  ...validResumeInput,
  model: "gpt-5.5",
};

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

for (const harness of allProviderHarnesses) {
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

test("Claude adapter delegates hook-mode sessions to the hook-driven runner", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-claude-hooks-adapter-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, "claude");

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const runner = new CapturingClaudeHookRunner();
  const adapter = createClaudeAdapter({
    eventSource: "hooks",
    runClaudeHookDrivenSession:
      runner.runClaudeHookDrivenSession.bind(runner),
  });

  const result = await adapter.runSession(validRunInputWithModel);

  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(runner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("claude"),
        executable: executablePath,
        args: ["--model", "gpt-5.5", "Ship the contract"],
      },
      input: validRunInputWithModel,
    },
  ]);
});

test("Claude adapter delegates fresh JSONL sessions to the JSONL runner", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-claude-jsonl-adapter-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, "claude");

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const hookRunner = new CapturingClaudeHookRunner();
  const jsonlRunner = new CapturingClaudeJsonlRunner();
  const adapter = createClaudeAdapter({
    eventSource: "jsonl",
    runClaudeHookDrivenSession:
      hookRunner.runClaudeHookDrivenSession.bind(hookRunner),
    runClaudeJsonlSession:
      jsonlRunner.runClaudeJsonlSession.bind(jsonlRunner),
  });

  const result = await adapter.runSession(validRunInputWithModel);

  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(hookRunner.calls, []);
  assert.deepEqual(jsonlRunner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("claude"),
        executable: executablePath,
        args: ["--model", "gpt-5.5", "Ship the contract"],
      },
      input: validRunInputWithModel,
    },
  ]);
});

test("Claude adapter resumeSession delegates hook resume with native --resume flag and prompt", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-claude-hooks-resume-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, "claude");

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const runner = new CapturingClaudeHookRunner();
  const adapter = createClaudeAdapter({
    eventSource: "hooks",
    runClaudeHookDrivenSession:
      runner.runClaudeHookDrivenSession.bind(runner),
  });

  assert.equal(canResumeManagedProviderSession(adapter), true);
  if (!canResumeManagedProviderSession(adapter)) {
    assert.fail("expected Claude adapter to support resume");
  }

  await adapter.resumeSession(validResumeInputWithModel);

  assert.deepEqual(runner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("claude"),
        executable: executablePath,
        args: [
          "--resume",
          "codex-session-123",
          "--model",
          "gpt-5.5",
          "Continue the interrupted work",
        ],
      },
      input: validResumeInputWithModel,
    },
  ]);
});

test("Claude adapter resumeSession delegates hook resume without a model flag", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-claude-hooks-resume-no-model-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, "claude");

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const runner = new CapturingClaudeHookRunner();
  const adapter = createClaudeAdapter({
    eventSource: "hooks",
    runClaudeHookDrivenSession:
      runner.runClaudeHookDrivenSession.bind(runner),
  });

  await adapter.resumeSession?.(validResumeInput);

  assert.deepEqual(runner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("claude"),
        executable: executablePath,
        args: ["--resume", "codex-session-123", "Continue the interrupted work"],
      },
      input: validResumeInput,
    },
  ]);
});

test("Claude adapter resumeSession delegates JSONL resume with native --resume flag and provider session id", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-claude-jsonl-resume-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, "claude");

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const hookRunner = new CapturingClaudeHookRunner();
  const jsonlRunner = new CapturingClaudeJsonlRunner();
  const adapter = createClaudeAdapter({
    eventSource: "jsonl",
    runClaudeHookDrivenSession:
      hookRunner.runClaudeHookDrivenSession.bind(hookRunner),
    runClaudeJsonlSession:
      jsonlRunner.runClaudeJsonlSession.bind(jsonlRunner),
  });

  assert.equal(canResumeManagedProviderSession(adapter), true);
  if (!canResumeManagedProviderSession(adapter)) {
    assert.fail("expected Claude JSONL adapter to support resume");
  }

  await adapter.resumeSession(validResumeInputWithModel);

  assert.deepEqual(hookRunner.calls, []);
  assert.deepEqual(jsonlRunner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("claude"),
        executable: executablePath,
        args: [
          "--resume",
          "codex-session-123",
          "--model",
          "gpt-5.5",
          "Continue the interrupted work",
        ],
        resumeProviderSessionId: "codex-session-123",
      },
      input: validResumeInputWithModel,
    },
  ]);
});

test("Codex adapter runSession delegates provider startup config to the hook-driven runner", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-hooks-adapter-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, codexHarness.command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const runner = new CapturingCodexHookRunner();
  const adapter = codexHarness.createAdapter({
    runCodexHookDrivenSession:
      runner.runCodexHookDrivenSession.bind(runner),
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
        provider: getBuiltInProviderIdentity("codex"),
        executable: executablePath,
        args: codexHarness.expectedArgsWithoutModel,
      },
      input: validRunInput,
    },
  ]);
});

test("Codex adapter runSession delegates exclusively to JSONL runner when selected", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-jsonl-adapter-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, codexHarness.command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const hookRunner = new CapturingCodexHookRunner();
  const jsonlRunner = new CapturingCodexJsonlRunner();
  const adapter = codexHarness.createAdapter({
    eventSource: "jsonl",
    runCodexHookDrivenSession:
      hookRunner.runCodexHookDrivenSession.bind(hookRunner),
    runCodexJsonlSession: jsonlRunner.runCodexJsonlSession.bind(jsonlRunner),
  });

  assert.equal(adapter.capabilities?.eventSource, "jsonl");

  const result = await adapter.runSession(validRunInput);

  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(hookRunner.calls, []);
  assert.deepEqual(jsonlRunner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("codex"),
        executable: executablePath,
        args: [],
      },
      input: validRunInput,
    },
  ]);
});

test("Codex adapter passes opaque model overrides through provider-native flags", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-hooks-model-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, codexHarness.command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const runner = new CapturingCodexHookRunner();
  const adapter = codexHarness.createAdapter({
    runCodexHookDrivenSession:
      runner.runCodexHookDrivenSession.bind(runner),
  });

  await adapter.runSession(validRunInputWithModel);

  assert.deepEqual(runner.calls[0]?.command, {
    provider: getBuiltInProviderIdentity("codex"),
    executable: executablePath,
    args: codexHarness.expectedArgsWithModel,
  });
});

test("Codex adapter resumeSession delegates hook resume with provider session id and prompt", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-hooks-resume-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, codexHarness.command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const runner = new CapturingCodexHookRunner();
  const adapter = codexHarness.createAdapter({
    runCodexHookDrivenSession:
      runner.runCodexHookDrivenSession.bind(runner),
  });

  assert.equal(canResumeManagedProviderSession(adapter), true);
  if (!canResumeManagedProviderSession(adapter)) {
    assert.fail("expected Codex adapter to support resume");
  }

  await adapter.resumeSession(validResumeInputWithModel);

  assert.deepEqual(runner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("codex"),
        executable: executablePath,
        args: [
          "resume",
          "--model",
          "gpt-5.5",
          "codex-session-123",
          "Continue the interrupted work",
        ],
      },
      input: validResumeInputWithModel,
    },
  ]);
});

test("Codex adapter resumeSession delegates JSONL resume without putting prompt in launch args", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-jsonl-resume-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, codexHarness.command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const hookRunner = new CapturingCodexHookRunner();
  const jsonlRunner = new CapturingCodexJsonlRunner();
  const adapter = codexHarness.createAdapter({
    eventSource: "jsonl",
    runCodexHookDrivenSession:
      hookRunner.runCodexHookDrivenSession.bind(hookRunner),
    runCodexJsonlSession: jsonlRunner.runCodexJsonlSession.bind(jsonlRunner),
  });

  assert.equal(canResumeManagedProviderSession(adapter), true);
  if (!canResumeManagedProviderSession(adapter)) {
    assert.fail("expected Codex adapter to support resume");
  }

  await adapter.resumeSession(validResumeInputWithModel);

  assert.deepEqual(hookRunner.calls, []);
  assert.deepEqual(jsonlRunner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("codex"),
        executable: executablePath,
        args: ["resume", "--model", "gpt-5.5", "codex-session-123"],
        resumeProviderSessionId: "codex-session-123",
      },
      input: validResumeInputWithModel,
    },
  ]);
});

test("Codex adapter maps launch-time executable resolution failures before hook runner startup", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const missingBinDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-hooks-missing-run-"),
  );

  process.env.PATH = missingBinDir;

  const runner = new CapturingCodexHookRunner();
  const adapter = codexHarness.createAdapter({
    runCodexHookDrivenSession:
      runner.runCodexHookDrivenSession.bind(runner),
  });

  await assert.rejects(adapter.runSession(validRunInput), (error: unknown) => {
    assert.ok(error instanceof ProviderSessionLaunchError);
    assert.equal(error.provider, getBuiltInProviderIdentity("codex"));
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /codex/i);
    return true;
  });
  assert.deepEqual(runner.calls, []);
});

test("built-in managed-session selection wires codex execution through the hook-driven runner", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-hooks-run-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, codexHarness.command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const runner = new CapturingCodexHookRunner();
  const adapter = createBuiltInManagedSessionAdapter("codex", {
    runCodexHookDrivenSession:
      runner.runCodexHookDrivenSession.bind(runner),
  });

  assert.deepEqual(adapter.provider, getBuiltInProviderIdentity("codex"));

  const detection = await adapter.detect();
  assert.deepEqual(detection, {
    isAvailable: true,
    executable: executablePath,
  });

  await adapter.runSession(validRunInput);

  assert.deepEqual(runner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("codex"),
        executable: executablePath,
        args: codexHarness.expectedArgsWithoutModel,
      },
      input: validRunInput,
    },
  ]);
  assert.equal("run" in adapter, false);
});

test("built-in managed-session selection wires codex JSONL mode before launch", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "devflow-codex-jsonl-run-"),
  );
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, codexHarness.command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const hookRunner = new CapturingCodexHookRunner();
  const jsonlRunner = new CapturingCodexJsonlRunner();
  const adapter = createBuiltInManagedSessionAdapter("codex", {
    codexEventSource: "jsonl",
    runCodexHookDrivenSession:
      hookRunner.runCodexHookDrivenSession.bind(hookRunner),
    runCodexJsonlSession: jsonlRunner.runCodexJsonlSession.bind(jsonlRunner),
  });

  assert.equal(adapter.capabilities?.eventSource, "jsonl");

  await adapter.runSession(validRunInput);

  assert.deepEqual(hookRunner.calls, []);
  assert.deepEqual(jsonlRunner.calls, [
    {
      command: {
        provider: getBuiltInProviderIdentity("codex"),
        executable: executablePath,
        args: [],
      },
      input: validRunInput,
    },
  ]);
});
