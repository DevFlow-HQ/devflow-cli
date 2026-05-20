import assert from "node:assert/strict";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import fs from "fs-extra";

import {
  createDevFlowState,
  InvalidDevFlowConfigError,
  InvalidDevFlowRunIdError,
} from "../src/devflowState.js";

test("devflow config is absent until explicitly saved through the state facade", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-config-"));
  const state = createDevFlowState({ projectRoot });

  assert.equal(await fs.pathExists(join(projectRoot, ".devflow")), false);
  assert.equal(await state.config.load(), undefined);
  assert.equal(await fs.pathExists(join(projectRoot, ".devflow")), false);
});

test("devflow config save lazily creates state and supports later reads", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-config-"));
  const state = createDevFlowState({ projectRoot });

  await state.config.save({ defaultProvider: "claude" });

  assert.equal(await fs.pathExists(join(projectRoot, ".devflow")), true);
  assert.deepEqual(await state.config.load(), {
    defaultProvider: "claude",
  });
});

test("devflow config validation rejects malformed persisted provider ids", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-config-"));
  const state = createDevFlowState({ projectRoot });

  await state.config.save({ defaultProvider: "gemini" });

  const configPath = join(projectRoot, ".devflow", "config.json");
  await fs.outputJson(configPath, { defaultProvider: "nope" }, { spaces: 2 });

  await assert.rejects(
    state.config.load(),
    (error: unknown) =>
      error instanceof InvalidDevFlowConfigError &&
      error.message.includes("defaultProvider"),
  );
});

test("project context is absent until written and then readable from its canonical state location", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  assert.equal(await state.readProjectContext(), undefined);

  await state.writeProjectContext("# Project context\n");

  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "project-context.md"), "utf8"),
    "# Project context\n",
  );
  assert.equal(await state.readProjectContext(), "# Project context\n");
});

test("project context writes overwrite the existing shared artifact in place", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await state.writeProjectContext("first snapshot");
  await state.writeProjectContext("refreshed snapshot");

  assert.equal(await state.readProjectContext(), "refreshed snapshot");
  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "project-context.md"), "utf8"),
    "refreshed snapshot",
  );
});

test("createRun returns isolated run handles with opaque ids and persisted creation metadata", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });

  const firstRun = await state.createRun();
  const secondRun = await state.createRun();

  assert.match(firstRun.id, /^[a-z0-9]{12}$/);
  assert.match(secondRun.id, /^[a-z0-9]{12}$/);
  assert.notEqual(firstRun.id, secondRun.id);

  assert.equal(
    firstRun.paths.runDirectory,
    join(projectRoot, ".devflow", "runs", firstRun.id),
  );
  assert.equal(await fs.pathExists(firstRun.paths.runDirectory), true);
  assert.equal(await fs.pathExists(secondRun.paths.runDirectory), true);

  const metadataPath = join(firstRun.paths.runDirectory, "run.json");
  assert.deepEqual(await fs.readJson(metadataPath), {
    id: firstRun.id,
    createdAt: firstRun.createdAt,
  });
});

test("createRun surfaces invalid generated run ids as domain errors", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const randomUuidMock = mock.method(crypto, "randomUUID", () => "INVALID-ID");

  await assert.rejects(
    state.createRun(),
    (error: unknown) =>
      error instanceof InvalidDevFlowRunIdError &&
      error.runId === "INVALIDID" &&
      error.message.includes("INVALIDID"),
  );

  randomUuidMock.mock.restore();
});
