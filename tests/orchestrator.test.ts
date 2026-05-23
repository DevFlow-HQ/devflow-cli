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
import { getBuiltInProviderIdentity } from "../src/adapters/providers.js";
import { UnsupportedProviderError } from "../src/bootstrapProvider.js";
import {
  MissingProviderIdError,
  runExecutionRequest,
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
  const resolvedProviderIds: string[] = [];
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionInputs.push(input);
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

test("orchestrator passes intent stage input to the managed provider session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.writeProjectContext("# Project context\n");
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

test("orchestrator treats successful runSession completion as sufficient intent stage success", async () => {
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

  await runExecutionRequest(
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
  );

  assert.equal(runSessionCallCount, 1);
  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
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

test("orchestrator maps failed intent repair validation to the stage artifact validation error", async () => {
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
      error instanceof StageArtifactValidationError &&
      error.stage === "intent" &&
      error.artifactPath.endsWith("/intent.json") &&
      error.message.includes("Must be a non-empty string"),
  );

  assert.equal(repairPromptCount, 1);
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
