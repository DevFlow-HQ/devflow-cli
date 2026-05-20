import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fs from "fs-extra";

import {
  createDevFlowState,
  InvalidDevFlowConfigError,
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
