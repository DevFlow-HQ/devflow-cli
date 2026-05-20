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
  OrchestratorNotImplementedError,
  runExecutionRequest,
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

test("orchestrator snapshots the resolved request into a new run through the state boundary before surfacing the stub error", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.writeProjectContext("# Project context\n");

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
        model: "gpt-5.5/fast beta",
      },
      { devFlowState },
    ),
    OrchestratorNotImplementedError,
  );

  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runIds.length, 1);

  const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);
  assert.deepEqual(await fs.readJson(join(runDirectory, "intent.json")), {
    rawTask: "resume work",
    providerId: "codex",
    model: "gpt-5.5/fast beta",
    projectContext: "# Project context\n",
  });
});
