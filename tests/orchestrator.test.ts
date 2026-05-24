import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  createDevFlowState,
  type DevFlowState,
} from "../src/devflowState.js";
import { createBuiltInManagedSessionAdapter } from "../src/adapters/builtInManagedSessionAdapter.js";
import type {
  ManagedProviderSessionInput,
  ManagedProviderSessionResult,
  ManagedSessionAdapter,
} from "../src/adapters/managedSessionAdapter.js";
import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionCleanupError,
} from "../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../src/adapters/providers.js";
import { UnsupportedProviderError } from "../src/bootstrapProvider.js";
import {
  MissingProviderIdError,
  ProviderStageRetryExhaustedError,
  isRetryableProviderBackedStageFailure,
  runExecutionRequest,
  runProviderBackedStageWithRetry,
  StageArtifactValidationError,
  type PipelineStage,
} from "../src/orchestrator.js";

async function listRunDirectories(
  projectRoot: string,
): Promise<string[]> {
  const runsDirectory = join(projectRoot, ".devflow", "runs");

  if (!(await fs.pathExists(runsDirectory))) {
    return [];
  }

  return (await fs.readdir(runsDirectory)).sort();
}

async function createExecutableOnPath(
  t: test.TestContext,
  command: string,
): Promise<string> {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    join(tmpdir(), `devflow-orchestrator-${command}-`),
  );
  const binDir = join(tempRoot, "bin");
  const executablePath = join(binDir, command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);
  process.env.PATH = binDir;

  return executablePath;
}

test("orchestrator resolves the selected built-in provider through a managed-session adapter factory", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const resolvedProviderIds: string[] = [];
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionInputs.push(input);
      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5.5/fast beta",
    },
    {
      devFlowState,
      createManagedSessionAdapter(providerId) {
        resolvedProviderIds.push(providerId);
        return adapter;
      },
    },
  );

  assert.deepEqual(resolvedProviderIds, ["codex"]);
  assert.equal(runSessionInputs.length, 1);
  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runIds.length, 1);
});

test("orchestrator can complete the active intent stage through a built-in provider adapter with fake PTY execution", async (t) => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const executablePath = await createExecutableOnPath(t, "codex");
  const ptyCalls: Array<{
    executable: string;
    args: string[];
    input: ManagedProviderSessionInput;
  }> = [];

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5.5/fast beta",
    },
    {
      devFlowState,
      createManagedSessionAdapter(providerId) {
        return createBuiltInManagedSessionAdapter(providerId, {
          async runPtyManagedSession(command, input) {
            ptyCalls.push({
              executable: command.executable,
              args: command.args,
              input,
            });

            assert.equal(input.workingDirectory, projectRoot);
            assert.equal(input.model, "gpt-5.5/fast beta");
            assert.equal(command.provider.id, "codex");
            assert.ok(
              command.args.some((arg) =>
                arg.includes(input.initialCompletionMarker),
              ),
            );

            await fs.outputJson(
              join(
                projectRoot,
                ".devflow",
                "runs",
                (await listRunDirectories(projectRoot))[0],
                "intent.json",
              ),
              {
                classification: "feature",
                summary: "Resume the current workstream.",
                rawTask: "resume work",
                needsClarification: false,
              },
              { spaces: 2 },
            );
            await input.validate();

            return { repairUsed: false, exitCode: 0, signal: null };
          },
        });
      },
    },
  );

  assert.deepEqual(result.intent, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
  assert.equal(ptyCalls.length, 1);
  assert.equal(ptyCalls[0]?.executable, executablePath);
  assert.equal(ptyCalls[0]?.args[0], "--model");
  assert.equal(ptyCalls[0]?.args[1], "gpt-5.5/fast beta");

  const runIds = await listRunDirectories(projectRoot);
  assert.deepEqual(
    await fs.readJson(
      join(projectRoot, ".devflow", "runs", runIds[0], "intent.json"),
    ),
    {
      classification: "feature",
      summary: "Resume the current workstream.",
      rawTask: "resume work",
      needsClarification: false,
    },
  );
});

test("orchestrator reports intent repair metadata from a built-in provider adapter", async (t) => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  await createExecutableOnPath(t, "codex");
  const repairResults: ManagedProviderSessionResult[] = [];

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter(providerId) {
        return createBuiltInManagedSessionAdapter(providerId, {
          async runPtyManagedSession(_command, input) {
            await assert.rejects(input.validate());
            assert.ok(input.repair);
            const repairPrompt = input.repair.renderPrompt(
              new Error("intent artifact missing"),
            );
            assert.match(repairPrompt, /Repair only the intent artifact/);

            await fs.outputJson(
              join(
                projectRoot,
                ".devflow",
                "runs",
                (await listRunDirectories(projectRoot))[0],
                "intent.json",
              ),
              {
                classification: "feature",
                summary: "Resume the current workstream.",
                rawTask: "resume work",
                needsClarification: false,
              },
              { spaces: 2 },
            );
            await input.validate();

            const sessionResult = {
              repairUsed: true,
              exitCode: 0,
              signal: null,
            };
            repairResults.push(sessionResult);
            return sessionResult;
          },
        });
      },
    },
  );

  assert.deepEqual(result.intent, {
    repairUsed: true,
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(repairResults, [result.intent]);
});

test("orchestrator retries a retryable intent provider-session failure inside the same run", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const stages: PipelineStage[] = [];
  const artifactPaths: string[] = [];
  const initialCompletionMarkers: string[] = [];
  const initialPrompts: string[] = [];
  const artifactExistedAtAttemptStart: boolean[] = [];
  let runSessionCallCount = 0;
  const provider = getBuiltInProviderIdentity("codex");
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const artifactPath = join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "intent.json",
      );

      artifactPaths.push(artifactPath);
      initialCompletionMarkers.push(input.initialCompletionMarker);
      initialPrompts.push(input.initialPrompt);
      artifactExistedAtAttemptStart.push(await fs.pathExists(artifactPath));

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          artifactPath,
          {
            classification: "feature",
            summary: "stale failed attempt",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        throw new IncompleteProviderSessionError({
          provider,
          completionMarker: input.initialCompletionMarker,
          exitCode: 1,
          signal: null,
        });
      }

      await fs.outputJson(
        artifactPath,
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal((await listRunDirectories(projectRoot)).length, 1);
  assert.equal(artifactPaths[0], artifactPaths[1]);
  assert.deepEqual(artifactExistedAtAttemptStart, [false, false]);
  assert.notEqual(initialCompletionMarkers[0], initialCompletionMarkers[1]);
  assert.match(initialPrompts[0], new RegExp(initialCompletionMarkers[0]));
  assert.match(initialPrompts[1], new RegExp(initialCompletionMarkers[1]));
  assert.deepEqual(
    stages.filter((stage) => stage === "intent"),
    ["intent"],
  );
  assert.deepEqual(await fs.readJson(artifactPaths[1]), {
    classification: "feature",
    summary: "Resume the current workstream.",
    rawTask: "resume work",
    needsClarification: false,
  });
});

test("orchestrator retries intent after failed in-session repair and accepts a valid retry repair", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const artifactPaths: string[] = [];
  const artifactExistedAtAttemptStart: boolean[] = [];
  const initialCompletionMarkers: string[] = [];
  const repairCompletionMarkers: string[] = [];
  const initialPrompts: string[] = [];
  const repairPrompts: string[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const artifactPath = join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "intent.json",
      );

      artifactPaths.push(artifactPath);
      artifactExistedAtAttemptStart.push(await fs.pathExists(artifactPath));
      initialCompletionMarkers.push(input.initialCompletionMarker);
      initialPrompts.push(input.initialPrompt);
      assert.ok(input.repair);
      repairCompletionMarkers.push(input.repair.completionMarker);

      await assert.rejects(input.validate());
      const repairPrompt = input.repair.renderPrompt(
        new Error(`attempt ${runSessionCallCount} invalid intent`),
      );
      repairPrompts.push(repairPrompt);

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          artifactPath,
          {
            classification: "feature",
            summary: "",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );

        try {
          await input.validate();
        } catch (repairError) {
          assert.ok(repairError instanceof Error);
          throw input.repair.mapFailure(repairError);
        }
      }

      await fs.outputJson(
        artifactPath,
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();

      return { repairUsed: true, exitCode: 0, signal: null };
    },
  };

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.deepEqual(result.intent, {
    repairUsed: true,
    exitCode: 0,
    signal: null,
  });
  assert.equal(runSessionCallCount, 2);
  assert.equal(artifactPaths[0], artifactPaths[1]);
  assert.deepEqual(artifactExistedAtAttemptStart, [false, false]);
  assert.notEqual(initialCompletionMarkers[0], initialCompletionMarkers[1]);
  assert.notEqual(repairCompletionMarkers[0], repairCompletionMarkers[1]);
  assert.match(initialPrompts[0], new RegExp(initialCompletionMarkers[0]));
  assert.match(initialPrompts[1], new RegExp(initialCompletionMarkers[1]));
  assert.match(repairPrompts[0], new RegExp(repairCompletionMarkers[0]));
  assert.match(repairPrompts[1], new RegExp(repairCompletionMarkers[1]));
  assert.deepEqual(await fs.readJson(artifactPaths[1]), {
    classification: "feature",
    summary: "Resume the current workstream.",
    rawTask: "resume work",
    needsClarification: false,
  });
});

test("orchestrator raises a typed retry-exhausted error and preserves the final failed intent artifact", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const artifactPaths: string[] = [];
  const artifactExistedAtAttemptStart: boolean[] = [];
  const finalFailureMessages: string[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const artifactPath = join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "intent.json",
      );

      artifactPaths.push(artifactPath);
      artifactExistedAtAttemptStart.push(await fs.pathExists(artifactPath));

      await fs.outputJson(
        artifactPath,
        {
          classification: "feature",
          summary:
            runSessionCallCount === 1
              ? "first failed attempt"
              : "final failed attempt",
          rawTask: "resume work",
          needsClarification: "no",
        },
        { spaces: 2 },
      );

      try {
        await input.validate();
      } catch (validationError) {
        assert.ok(validationError instanceof Error);
        const failure = input.repair?.mapFailure(validationError);
        assert.ok(failure instanceof StageArtifactValidationError);
        finalFailureMessages.push(failure.message);
        throw failure;
      }

      throw new Error("Invalid intent artifact unexpectedly passed validation.");
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "intent" &&
      error.attempts === 2 &&
      error.cause instanceof StageArtifactValidationError &&
      error.cause.message === finalFailureMessages[1],
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal(artifactPaths[0], artifactPaths[1]);
  assert.deepEqual(artifactExistedAtAttemptStart, [false, false]);
  assert.deepEqual(await fs.readJson(artifactPaths[1]), {
    classification: "feature",
    summary: "final failed attempt",
    rawTask: "resume work",
    needsClarification: "no",
  });
});

test("orchestrator passes intent stage input to the managed provider session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const stages: PipelineStage[] = [];
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionInputs.push(input);
      assert.equal(input.workingDirectory, projectRoot);
      assert.equal(input.model, "gpt-5.5/fast beta");
      assert.match(input.initialCompletionMarker, /^DEVFLOW_INTENT_COMPLETE_[a-f0-9]{32}$/);
      assert.match(input.initialPrompt, /Classify only the raw task/);
      assert.match(input.initialPrompt, /Raw task:\nresume work/);
      assert.doesNotMatch(input.initialPrompt, /Project context/);
      assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);
      assert.match(input.initialPrompt, /\/\.devflow\/runs\/[a-z0-9]{12}\/intent\.json/);
      assert.equal("stage" in input, false);
      assert.equal("artifactPath" in input, false);
      assert.equal("context" in input, false);

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5.5/fast beta",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
  assert.equal(runSessionInputs.length, 1);

  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runIds.length, 1);
  const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

  assert.deepEqual(await fs.readJson(join(runDirectory, "intent.json")), {
    classification: "feature",
    summary: "Resume the current workstream.",
    rawTask: "resume work",
    needsClarification: false,
  });
  assert.equal(await fs.pathExists(join(runDirectory, "prd.md")), false);
  assert.equal(await fs.pathExists(join(runDirectory, "issues")), false);
  assert.equal(await fs.pathExists(join(runDirectory, "validation.json")), false);
});

test("orchestrator reuses fresh project context during bootstrap without provider work", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await baseDevFlowState.projectContext.write("# Project context\n", {
    refreshReason: "manual",
  });
  const metadataPath = join(projectRoot, ".devflow", "project-context.meta.json");
  const metadataBefore = await fs.readFile(metadataPath, "utf8");
  const stages: PipelineStage[] = [];
  let checkFreshnessCallCount = 0;
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    projectContext: {
      ...baseDevFlowState.projectContext,
      async checkFreshness() {
        checkFreshnessCallCount += 1;
        return baseDevFlowState.projectContext.checkFreshness();
      },
    },
  };
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionInputs.push(input);

      assert.equal(stages.at(-1), "intent");
      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(runSessionInputs.length, 1);
  assert.equal(checkFreshnessCallCount, 1);
  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
  assert.equal(await fs.readFile(metadataPath, "utf8"), metadataBefore);
});

test("orchestrator repairs missing project-context metadata during bootstrap without provider work", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const existingContext = "# Project context\n\nKeep this exact text.\n";
  await baseDevFlowState.projectContext.write(existingContext);
  const metadataPath = join(projectRoot, ".devflow", "project-context.meta.json");
  const stages: PipelineStage[] = [];
  const projectContextWrites: Array<{
    content: string;
    refreshReason: string | undefined;
  }> = [];
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    projectContext: {
      ...baseDevFlowState.projectContext,
      async write(content, metadataOrOptions) {
        projectContextWrites.push({
          content,
          refreshReason:
            metadataOrOptions && "refreshReason" in metadataOrOptions
              ? metadataOrOptions.refreshReason
              : undefined,
        });
        return baseDevFlowState.projectContext.write(content, metadataOrOptions);
      },
    },
  };
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(runSessionCallCount, 1);
  assert.deepEqual(projectContextWrites, [
    {
      content: existingContext,
      refreshReason: "missing-metadata",
    },
  ]);
  assert.equal(await baseDevFlowState.projectContext.read(), existingContext);
  assert.equal(
    (await fs.readJson(metadataPath)).refreshReason,
    "missing-metadata",
  );
  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
});

test("orchestrator repairs invalid project-context metadata during bootstrap without provider work", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const existingContext = "# Project context\n\nPreserve invalid metadata content.\n";
  const metadataPath = join(projectRoot, ".devflow", "project-context.meta.json");
  await fs.outputFile(
    join(projectRoot, ".devflow", "project-context.md"),
    existingContext,
  );
  await fs.outputJson(metadataPath, { generatedAt: "not-a-date" }, { spaces: 2 });
  const projectContextWrites: Array<{
    content: string;
    refreshReason: string | undefined;
  }> = [];
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    projectContext: {
      ...baseDevFlowState.projectContext,
      async write(content, metadataOrOptions) {
        projectContextWrites.push({
          content,
          refreshReason:
            metadataOrOptions && "refreshReason" in metadataOrOptions
              ? metadataOrOptions.refreshReason
              : undefined,
        });
        return baseDevFlowState.projectContext.write(content, metadataOrOptions);
      },
    },
  };
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionCallCount, 1);
  assert.deepEqual(projectContextWrites, [
    {
      content: existingContext,
      refreshReason: "metadata-invalid",
    },
  ]);
  assert.equal(await baseDevFlowState.projectContext.read(), existingContext);
  assert.equal(
    (await fs.readJson(metadataPath)).refreshReason,
    "metadata-invalid",
  );
});

test("orchestrator generates missing project context through the managed provider during bootstrap", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const projectContextWrites: Array<{
    content: string;
    refreshReason: string | undefined;
  }> = [];
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    projectContext: {
      ...baseDevFlowState.projectContext,
      async write(content, metadataOrOptions) {
        projectContextWrites.push({
          content,
          refreshReason:
            metadataOrOptions && "refreshReason" in metadataOrOptions
              ? metadataOrOptions.refreshReason
              : undefined,
        });
        return baseDevFlowState.projectContext.write(content, metadataOrOptions);
      },
    },
  };
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const generatedContext = [
    "# Project Context",
    "",
    "## Purpose",
    "DevFlow coordinates provider-backed development workflows.",
    "",
    "## Architecture",
    "The orchestrator creates runs and delegates durable state to DevFlowState.",
    "",
    "## Key Paths",
    "- src/orchestrator.ts",
    "- src/devflowState.ts",
    "",
    "## Commands",
    "- npm run test",
    "- npm run typecheck",
    "",
    "## Conventions",
    "Tests exercise public orchestration behavior.",
    "",
  ].join("\n");

  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionInputs.push(input);
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (runSessionInputs.length === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.equal(input.workingDirectory, projectRoot);
      assert.match(
        input.initialCompletionMarker,
        /^DEVFLOW_BOOTSTRAP_PROJECT_CONTEXT_COMPLETE_[a-f0-9]{32}$/,
      );
      assert.match(input.initialPrompt, /bounded repository orientation/i);
      assert.match(input.initialPrompt, /ecosystem-neutral inspection/i);
      assert.match(input.initialPrompt, /purpose/i);
      assert.match(input.initialPrompt, /architecture/i);
      assert.match(input.initialPrompt, /key paths/i);
      assert.match(input.initialPrompt, /commands/i);
      assert.match(input.initialPrompt, /conventions/i);
      assert.match(
        input.initialPrompt,
        /project-context\.candidate\.md/,
      );
      assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);

      const candidatePath = join(runDirectory, "project-context.candidate.md");
      await fs.outputFile(candidatePath, generatedContext);
      await input.validate();

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionInputs.length, 2);
  assert.deepEqual(projectContextWrites, [
    {
      content: generatedContext,
      refreshReason: "missing-context",
    },
  ]);
  assert.equal(await baseDevFlowState.projectContext.read(), generatedContext);
  assert.equal(
    (await baseDevFlowState.projectContext.readMetadata())?.refreshReason,
    "missing-context",
  );

  const runIds = await listRunDirectories(projectRoot);
  assert.equal(
    await fs.pathExists(
      join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "project-context.candidate.md",
      ),
    ),
    false,
  );
});

test("orchestrator refreshes semantically stale project context through the managed provider during bootstrap", async () => {
  for (const refreshReason of [
    "context-version-changed",
    "max-age-exceeded",
    "baseline-unavailable",
    "relevant-changes",
  ] as const) {
    const projectRoot = fs.mkdtempSync(
      join(tmpdir(), `devflow-orchestrator-${refreshReason}-`),
    );
    const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
    const priorContext = "# Project Context\n\nExisting orientation.\n";
    await baseDevFlowState.projectContext.write(priorContext, {
      refreshReason: "manual",
    });
    const refreshedContext = [
      "# Project Context",
      "",
      "## Purpose",
      "DevFlow coordinates provider-backed development workflows.",
      "",
      "## Architecture",
      "The orchestrator refreshes stale shared project context.",
      "",
      "## Key Paths",
      "- src/orchestrator.ts",
      "- src/devflowState.ts",
      "",
      "## Commands",
      "- npm run test",
      "- npm run typecheck",
      "",
      "## Conventions",
      "Tests exercise public orchestration behavior.",
      "",
    ].join("\n");
    const candidateContext =
      refreshReason === "max-age-exceeded" ? priorContext : refreshedContext;
    const projectContextWrites: Array<{
      content: string;
      refreshReason: string | undefined;
    }> = [];
    const devFlowState: DevFlowState = {
      ...baseDevFlowState,
      projectContext: {
        ...baseDevFlowState.projectContext,
        async checkFreshness() {
          return {
            status: "stale",
            refreshReason,
            context: priorContext,
            changedPaths:
              refreshReason === "relevant-changes"
                ? [
                    { path: "src/orchestrator.ts", status: "modified" },
                    {
                      path: "docs/context.md",
                      previousPath: "docs/old-context.md",
                      status: "renamed",
                    },
                    { path: "src/obsolete.ts", status: "deleted" },
                  ]
                : undefined,
          };
        },
        async write(content, metadataOrOptions) {
          projectContextWrites.push({
            content,
            refreshReason:
              metadataOrOptions && "refreshReason" in metadataOrOptions
                ? metadataOrOptions.refreshReason
                : undefined,
          });
          return baseDevFlowState.projectContext.write(content, metadataOrOptions);
        },
      },
    };
    const prompts: string[] = [];
    let runSessionCallCount = 0;
    const adapter: ManagedSessionAdapter = {
      provider: getBuiltInProviderIdentity("codex"),
      async detect() {
        return { isAvailable: true, executable: "codex" };
      },
      async runSession(input) {
        runSessionCallCount += 1;
        const runIds = await listRunDirectories(projectRoot);
        const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

        if (runSessionCallCount === 1) {
          await fs.outputJson(
            join(runDirectory, "intent.json"),
            {
              classification: "feature",
              summary: "Refresh context from raw task details.",
              rawTask: "SECRET RAW TASK",
              needsClarification: true,
            },
            { spaces: 2 },
          );
          await input.validate();
          return { repairUsed: false, exitCode: 0, signal: null };
        }

        prompts.push(input.initialPrompt);
        assert.equal(input.workingDirectory, projectRoot);
        assert.match(
          input.initialCompletionMarker,
          /^DEVFLOW_BOOTSTRAP_PROJECT_CONTEXT_COMPLETE_[a-f0-9]{32}$/,
        );
        assert.match(input.initialPrompt, /Refresh reason:/);
        assert.match(input.initialPrompt, new RegExp(refreshReason));
        assert.match(input.initialPrompt, /Existing project context:/);
        assert.match(input.initialPrompt, /Existing orientation/);
        assert.match(input.initialPrompt, /focused inspection/i);
        assert.match(input.initialPrompt, /changed, renamed, new, deleted-related, nearby, or referenced files/i);
        assert.doesNotMatch(input.initialPrompt, /whole-repo rescan/i);
        assert.doesNotMatch(input.initialPrompt, /SECRET RAW TASK/);
        assert.doesNotMatch(input.initialPrompt, /Refresh context from raw task details/);
        assert.doesNotMatch(input.initialPrompt, /needsClarification/);
        assert.doesNotMatch(input.initialPrompt, /classification/);

        if (refreshReason === "relevant-changes") {
          assert.match(input.initialPrompt, /src\/orchestrator\.ts \(modified\)/);
          assert.match(
            input.initialPrompt,
            /docs\/context\.md \(renamed from docs\/old-context\.md\)/,
          );
          assert.match(input.initialPrompt, /src\/obsolete\.ts \(deleted\)/);
        }

        const candidatePath = join(runDirectory, "project-context.candidate.md");
        await fs.outputFile(candidatePath, candidateContext);
        await input.validate();

        return { repairUsed: false, exitCode: 0, signal: null };
      },
    };

    await runExecutionRequest(
      {
        projectRoot,
        rawTask: "SECRET RAW TASK",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    );

    assert.equal(runSessionCallCount, 2);
    assert.equal(prompts.length, 1);
    assert.deepEqual(projectContextWrites, [
      {
        content: candidateContext,
        refreshReason,
      },
    ]);
    assert.equal(await baseDevFlowState.projectContext.read(), candidateContext);
    assert.equal(
      (await baseDevFlowState.projectContext.readMetadata())?.refreshReason,
      refreshReason,
    );
  }
});

test("orchestrator rejects invalid generated project-context candidates during bootstrap", async () => {
  for (const [name, invalidCandidate, expectedMessage] of [
    ["empty", " \n\t", /Project context content must be non-empty/],
    [
      "too-long",
      Array.from({ length: 151 }, (_value, index) => `line ${index + 1}`).join(
        "\n",
      ),
      /Project context content must be no more than 150 lines/,
    ],
  ] as const) {
    const projectRoot = fs.mkdtempSync(
      join(tmpdir(), `devflow-orchestrator-${name}-`),
    );
    const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
    let runSessionCallCount = 0;
    const adapter: ManagedSessionAdapter = {
      provider: getBuiltInProviderIdentity("codex"),
      async detect() {
        return { isAvailable: true, executable: "codex" };
      },
      async runSession(input) {
        runSessionCallCount += 1;
        const runIds = await listRunDirectories(projectRoot);
        const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

        if (runSessionCallCount === 1) {
          await fs.outputJson(
            join(runDirectory, "intent.json"),
            {
              classification: "feature",
              summary: "Resume the current workstream.",
              rawTask: "resume work",
              needsClarification: false,
            },
            { spaces: 2 },
          );
          await input.validate();
          return { repairUsed: false, exitCode: 0, signal: null };
        }

        await fs.outputFile(
          join(runDirectory, "project-context.candidate.md"),
          invalidCandidate,
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      },
    };

    await assert.rejects(
      runExecutionRequest(
        {
          projectRoot,
          rawTask: "resume work",
          providerId: "codex",
        },
        {
          devFlowState,
          createManagedSessionAdapter() {
            return adapter;
          },
        },
      ),
      expectedMessage,
    );

    assert.equal(runSessionCallCount, 3);
    assert.equal(await devFlowState.projectContext.read(), undefined);
    assert.equal(await devFlowState.projectContext.readMetadata(), undefined);
  }
});

test("orchestrator supplies bootstrap validation and one in-session repair attempt to the managed provider session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const repairedContext = [
    "# Project Context",
    "",
    "## Purpose",
    "DevFlow coordinates provider-backed development workflows.",
    "",
    "## Architecture",
    "The bootstrap stage repairs invalid project-context candidates in-session.",
    "",
    "## Key Paths",
    "- src/orchestrator.ts",
    "",
    "## Commands",
    "- npm run test",
    "",
    "## Conventions",
    "Tests exercise public orchestration behavior.",
    "",
  ].join("\n");
  const repairPrompts: string[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      const candidatePath = join(runDirectory, "project-context.candidate.md");
      await fs.outputFile(candidatePath, " \n\t");
      const validationError = await input.validate().then(
        () => undefined,
        (error: Error) => error,
      );
      assert.ok(validationError);
      assert.ok(input.repair);
      const repairPrompt = input.repair.renderPrompt(validationError);
      repairPrompts.push(repairPrompt);
      assert.match(repairPrompt, /Repair only the project-context candidate artifact/);
      assert.match(repairPrompt, /project-context\.candidate\.md/);
      assert.doesNotMatch(repairPrompt, /resume work/);
      assert.doesNotMatch(repairPrompt, /classification/);

      await fs.outputFile(candidatePath, repairedContext);
      await input.validate();

      return { repairUsed: true, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal(repairPrompts.length, 1);
  assert.equal(await devFlowState.projectContext.read(), repairedContext);
});

test("orchestrator retries bootstrap after repair failure and removes the failed candidate before retry", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const validContext = [
    "# Project Context",
    "",
    "## Purpose",
    "DevFlow coordinates provider-backed development workflows.",
    "",
    "## Architecture",
    "Bootstrap retries the whole stage after repair failure.",
    "",
    "## Key Paths",
    "- src/orchestrator.ts",
    "",
    "## Commands",
    "- npm run test",
    "",
    "## Conventions",
    "Tests exercise public orchestration behavior.",
    "",
  ].join("\n");
  const candidateExistedAtBootstrapAttemptStart: boolean[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);
      const candidatePath = join(runDirectory, "project-context.candidate.md");

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      candidateExistedAtBootstrapAttemptStart.push(
        await fs.pathExists(candidatePath),
      );

      if (candidateExistedAtBootstrapAttemptStart.length === 1) {
        await fs.outputFile(candidatePath, " \n\t");
        const validationError = await input.validate().then(
          () => undefined,
          (error: Error) => error,
        );
        assert.ok(validationError);
        assert.ok(input.repair);
        throw input.repair.mapFailure(validationError);
      }

      await fs.outputFile(candidatePath, validContext);
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.deepEqual(candidateExistedAtBootstrapAttemptStart, [false, false]);
  assert.equal(runSessionCallCount, 3);
  assert.equal(await devFlowState.projectContext.read(), validContext);
});

test("orchestrator preserves the final failed bootstrap candidate after retry exhaustion", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      const candidatePath = join(runDirectory, "project-context.candidate.md");
      const failedCandidate = [
        `failed bootstrap candidate ${runSessionCallCount}`,
        ...Array.from(
          { length: 151 },
          (_value, index) => `overflow line ${index + 1}`,
        ),
      ].join("\n");
      await fs.outputFile(candidatePath, failedCandidate);
      const validationError = await input.validate().then(
        () => undefined,
        (error: Error) => error,
      );
      assert.ok(validationError);
      assert.ok(input.repair);
      throw input.repair.mapFailure(validationError);
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: Error) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "bootstrap" &&
      error.attempts === 2,
  );

  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runSessionCallCount, 3);
  assert.equal(
    await fs.readFile(
      join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "project-context.candidate.md",
      ),
      "utf8",
    ),
    [
      "failed bootstrap candidate 3",
      ...Array.from(
        { length: 151 },
        (_value, index) => `overflow line ${index + 1}`,
      ),
    ].join("\n"),
  );
  assert.equal(await devFlowState.projectContext.read(), undefined);
});

test("orchestrator treats bootstrap candidate cleanup failure after persistence as non-fatal", async (t) => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const validContext = [
    "# Project Context",
    "",
    "## Purpose",
    "DevFlow coordinates provider-backed development workflows.",
    "",
    "## Architecture",
    "Successful bootstrap persistence is not undone by candidate cleanup failure.",
    "",
    "## Key Paths",
    "- src/orchestrator.ts",
    "",
    "## Commands",
    "- npm run test",
    "",
    "## Conventions",
    "Tests exercise public orchestration behavior.",
    "",
  ].join("\n");
  let runSessionCallCount = 0;
  const originalRemove = fs.remove;
  t.after(() => {
    fs.remove = originalRemove;
  });

  fs.remove = async (path: string) => {
    if (path.endsWith("project-context.candidate.md")) {
      throw new Error("simulated candidate cleanup failure");
    }

    return originalRemove(path);
  };

  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      await fs.outputFile(
        join(runDirectory, "project-context.candidate.md"),
        validContext,
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal(await devFlowState.projectContext.read(), validContext);
});

test("orchestrator validates parsed intent before starting bootstrap", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "do the thing",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "intent" &&
      error.cause instanceof StageArtifactValidationError &&
      error.cause.artifactPath.endsWith("/intent.json"),
  );

  assert.equal(runSessionCallCount, 2);
  assert.deepEqual(stages, ["intent"]);
  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runIds.length, 1);
  assert.equal(
    await fs.pathExists(
      join(projectRoot, ".devflow", "runs", runIds[0], "intent.json"),
    ),
    false,
  );
});

test("orchestrator supplies intent validation and one in-session repair attempt to the managed provider session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  let repairedCompletion: { repairUsed: boolean } | undefined;
  const repairPrompts: string[] = [];
  const validationFailures: Error[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      try {
        await input.validate();
      } catch (error) {
        assert.ok(error instanceof Error);
        validationFailures.push(error);
        assert.ok(input.repair);
        assert.match(
          input.repair.completionMarker,
          /^DEVFLOW_INTENT_REPAIR_COMPLETE_[a-f0-9]{32}$/,
        );
        const repairPrompt = input.repair.renderPrompt(error);
        repairPrompts.push(repairPrompt);
        assert.match(repairPrompt, /Repair only the intent artifact/);
        assert.match(repairPrompt, /no such file or directory|ENOENT/);
        assert.match(repairPrompt, /\/\.devflow\/runs\/[a-z0-9]{12}\/intent\.json/);

        await fs.outputJson(
          join(
            projectRoot,
            ".devflow",
            "runs",
            (await listRunDirectories(projectRoot))[0],
            "intent.json",
          ),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();

        repairedCompletion = { repairUsed: true };
        return { repairUsed: true, exitCode: 0, signal: null };
      }

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(validationFailures.length, 1);
  assert.equal(repairPrompts.length, 1);
  assert.deepEqual(repairedCompletion, { repairUsed: true });
});

test("orchestrator preserves the final failed repair validation error as the retry-exhausted cause", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let repairPromptCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      try {
        await input.validate();
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(input.repair);
        input.repair.renderPrompt(error);
        repairPromptCount += 1;

        await fs.outputJson(
          join(
            projectRoot,
            ".devflow",
            "runs",
            (await listRunDirectories(projectRoot))[0],
            "intent.json",
          ),
          {
            classification: "feature",
            summary: "",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );

        try {
          await input.validate();
        } catch (repairError) {
          assert.ok(repairError instanceof Error);
          throw input.repair.mapFailure(repairError);
        }
      }

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "intent" &&
      error.attempts === 2 &&
      error.cause instanceof StageArtifactValidationError &&
      error.cause.artifactPath.endsWith("/intent.json") &&
      error.cause.message.includes("Must be a non-empty string"),
  );

  assert.equal(repairPromptCount, 2);
});

test("provider-backed stage retry helper surfaces the original failure for a single configured attempt", async () => {
  const originalFailure = new StageArtifactValidationError({
    stage: "intent",
    artifactPath: "/tmp/intent.json",
    details: "invalid json",
  });
  let cleanupCallCount = 0;

  await assert.rejects(
    runProviderBackedStageWithRetry({
      stage: "intent",
      totalAttempts: 1,
      async runAttempt() {
        throw originalFailure;
      },
      async cleanupBeforeRetry() {
        cleanupCallCount += 1;
      },
    }),
    (error: unknown) => error === originalFailure,
  );

  assert.equal(cleanupCallCount, 0);
});

test("provider-backed stage retry classification keeps lifecycle failures non-retryable", () => {
  const provider = getBuiltInProviderIdentity("codex");

  assert.equal(
    isRetryableProviderBackedStageFailure(
      new IncompleteProviderSessionError({
        provider,
        completionMarker: "DEVFLOW_INTENT_COMPLETE",
        exitCode: 1,
        signal: null,
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableProviderBackedStageFailure(
      new StageArtifactValidationError({
        stage: "intent",
        artifactPath: "/tmp/intent.json",
        details: "invalid",
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableProviderBackedStageFailure(
      new InterruptedProviderSessionError({
        provider,
        exitCode: null,
        signal: "SIGINT",
      }),
    ),
    false,
  );
  assert.equal(
    isRetryableProviderBackedStageFailure(
      new ProviderSessionCleanupError(provider, new Error("cleanup failed")),
    ),
    false,
  );
  assert.equal(isRetryableProviderBackedStageFailure(new Error("setup failed")), false);
});

test("orchestrator surfaces interrupted provider sessions without retrying the intent stage", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  let runSessionCallCount = 0;
  const provider = getBuiltInProviderIdentity("codex");
  const interrupted = new InterruptedProviderSessionError({
    provider,
    exitCode: null,
    signal: "SIGINT",
  });
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      throw interrupted;
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === interrupted,
  );

  assert.equal(runSessionCallCount, 1);
  assert.deepEqual(stages, ["intent"]);
});

test("orchestrator surfaces provider cleanup failures without retrying the intent stage", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  let runSessionCallCount = 0;
  const provider = getBuiltInProviderIdentity("codex");
  const cleanup = new ProviderSessionCleanupError(
    provider,
    new Error("cleanup command failed"),
  );
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      throw cleanup;
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === cleanup,
  );

  assert.equal(runSessionCallCount, 1);
  assert.deepEqual(stages, ["intent"]);
});

test("orchestrator stops after cleanup failure even when the intent artifact is valid", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  const provider = getBuiltInProviderIdentity("codex");
  const cleanup = new ProviderSessionCleanupError(
    provider,
    new Error("cleanup command failed"),
  );
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      throw cleanup;
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === cleanup,
  );

  assert.deepEqual(stages, ["intent"]);
});

test("orchestrator rejects provider-backed execution before creating a run when provider id is missing", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let runnerCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runnerCallCount += 1;
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof MissingProviderIdError &&
      error.message.includes("Provider-backed orchestration requires a provider id"),
  );

  assert.equal(runnerCallCount, 0);
  assert.deepEqual(await listRunDirectories(projectRoot), []);
});

test("orchestrator rejects unsupported provider ids before creating a run", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let adapterFactoryCallCount = 0;

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "not-real",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          adapterFactoryCallCount += 1;
          return {
            provider: getBuiltInProviderIdentity("codex"),
            async detect() {
              return { isAvailable: true, executable: "codex" };
            },
            async runSession() {
              return { repairUsed: false, exitCode: 0, signal: null };
            },
          };
        },
      },
    ),
    (error: unknown) =>
      error instanceof UnsupportedProviderError &&
      error.message.includes("Unsupported provider: not-real"),
  );

  assert.equal(adapterFactoryCallCount, 0);
  assert.deepEqual(await listRunDirectories(projectRoot), []);
});

test("orchestrator surfaces adapter factory failures before creating a run or starting a stage", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  const adapterFailure = new Error("adapter resolution failed");

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          throw adapterFailure;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === adapterFailure,
  );

  assert.deepEqual(stages, []);
  assert.deepEqual(await listRunDirectories(projectRoot), []);
});

test("orchestrator surfaces run creation failures before starting a stage or provider attempt", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const runCreationFailure = new Error("run creation failed");
  const stages: PipelineStage[] = [];
  let runSessionCallCount = 0;
  const devFlowState: DevFlowState = {
    config: {
      async load() {
        return undefined;
      },
      async save() {},
    },
    projectContext: {
      async read() {
        return undefined;
      },
      async write() {},
      async readMetadata() {
        return undefined;
      },
      async checkFreshness() {
        return {
          status: "stale",
          refreshReason: "missing-context",
        };
      },
    },
    async createRun() {
      throw runCreationFailure;
    },
  };
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === runCreationFailure,
  );

  assert.equal(runSessionCallCount, 0);
  assert.deepEqual(stages, []);
});
