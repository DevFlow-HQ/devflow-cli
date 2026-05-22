import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  createDevFlowState,
  type DevFlowState,
} from "../src/devflowState.js";
import {
  ManagedProviderSessionNotImplementedError,
  MissingProviderIdError,
  runExecutionRequest,
  type PipelineStage,
  type ProviderSessionRunner,
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

test("orchestrator default provider session runner fails with a managed-session-not-implemented error", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      { devFlowState },
    ),
    (error: unknown) =>
      error instanceof ManagedProviderSessionNotImplementedError &&
      error.providerId === "codex" &&
      error.message.includes("Managed provider sessions are not implemented yet"),
  );
});

test("orchestrator renders intent prompt and accepts a provider-written intent artifact", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.writeProjectContext("# Project context\n");
  const runnerCalls: Parameters<ProviderSessionRunner["run"]>[0][] = [];
  const sessionRunner: ProviderSessionRunner = {
    async run(options) {
      runnerCalls.push(options);
      assert.equal(options.providerId, "codex");
      assert.equal(options.projectRoot, projectRoot);
      assert.equal(options.model, "gpt-5.5/fast beta");
      assert.match(options.artifactPath, /\/\.devflow\/runs\/[a-z0-9]{12}\/intent\.json$/);
      assert.match(options.completionMarker, /^DEVFLOW_INTENT_COMPLETE_[a-f0-9]{32}$/);
      assert.match(options.prompt, /Classify only the raw task/);
      assert.match(options.prompt, /Raw task:\nresume work/);
      assert.doesNotMatch(options.prompt, /Project context/);
      assert.equal(options.prompt.includes(options.artifactPath), true);
      assert.equal(options.prompt.includes(options.completionMarker), true);
      assert.match(options.prompt, /"classification": "feature" \| "bug" \| "refactor" \| "unclear"/);

      await fs.outputJson(
        options.artifactPath,
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5.5/fast beta",
    },
    { devFlowState, sessionRunner },
  );

  assert.equal(runnerCalls.length, 1);
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
});

test("orchestrator runs the MVP pipeline order with intent active and later stages as no-ops", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  const runnerCalls: Parameters<ProviderSessionRunner["run"]>[0][] = [];
  const sessionRunner: ProviderSessionRunner = {
    async run(options) {
      runnerCalls.push(options);

      await fs.outputJson(
        options.artifactPath,
        {
          classification: "bug",
          summary: "Fix the failing provider handoff.",
          rawTask: "fix provider handoff",
          needsClarification: false,
        },
        { spaces: 2 },
      );
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "fix provider handoff",
      providerId: "codex",
    },
    {
      devFlowState,
      sessionRunner,
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
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].artifactPath.endsWith("/intent.json"), true);

  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runIds.length, 1);
  const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

  assert.deepEqual(await fs.readJson(join(runDirectory, "intent.json")), {
    classification: "bug",
    summary: "Fix the failing provider handoff.",
    rawTask: "fix provider handoff",
    needsClarification: false,
  });
  assert.equal(await fs.pathExists(join(runDirectory, "prd.md")), false);
  assert.equal(await fs.pathExists(join(runDirectory, "issues")), false);
  assert.equal(await fs.pathExists(join(runDirectory, "validation.json")), false);
});

test("orchestrator rejects provider-backed execution before creating a run when provider id is missing", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let runnerCallCount = 0;
  const sessionRunner: ProviderSessionRunner = {
    async run() {
      runnerCallCount += 1;
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
      },
      { devFlowState, sessionRunner },
    ),
    (error: unknown) =>
      error instanceof MissingProviderIdError &&
      error.message.includes("Provider-backed orchestration requires a provider id"),
  );

  assert.equal(runnerCallCount, 0);
  assert.deepEqual(await listRunDirectories(projectRoot), []);
});
