import assert from "node:assert/strict";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import fs from "fs-extra";

import {
  createDevFlowState,
  DuplicateDevFlowRunArtifactError,
  InvalidDevFlowConfigError,
  InvalidDevFlowIssueSlugError,
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

test("devflow config validation rejects malformed persisted json", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-config-"));
  const state = createDevFlowState({ projectRoot });

  await fs.outputFile(
    join(projectRoot, ".devflow", "config.json"),
    '{"defaultProvider":"claude"',
  );

  await assert.rejects(
    state.config.load(),
    (error: unknown) =>
      error instanceof InvalidDevFlowConfigError &&
      error.configPath.endsWith("/.devflow/config.json") &&
      error.message.includes("config.json"),
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

test("run handles write canonical immutable artifacts without exposing filenames to callers", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.writeIntent('{"goal":"ship it"}');
  await run.writePrd("# PRD\n");
  await run.writeValidation('{"status":"pending"}');

  assert.equal(
    await fs.readFile(join(run.paths.runDirectory, "intent.json"), "utf8"),
    '{"goal":"ship it"}',
  );
  assert.equal(
    await fs.readFile(join(run.paths.runDirectory, "prd.md"), "utf8"),
    "# PRD\n",
  );
  assert.equal(
    await fs.readFile(join(run.paths.runDirectory, "validation.json"), "utf8"),
    '{"status":"pending"}',
  );
});

test("run artifact writes reject duplicates with a domain-specific error", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.writeIntent('{"goal":"ship it"}');

  await assert.rejects(
    run.writeIntent('{"goal":"rewrite it"}'),
    (error: unknown) =>
      error instanceof DuplicateDevFlowRunArtifactError &&
      error.runId === run.id &&
      error.artifactName === "intent" &&
      error.message.includes("intent"),
  );
});

test("run handles reject duplicate PRD, validation, and normalized issue artifact writes while retaining the first artifact", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.writePrd("# First PRD\n");
  await run.writeValidation('{"status":"first"}');
  await run.writeIssue("Release Prep", "# First issue\n");

  await assert.rejects(
    run.writePrd("# Second PRD\n"),
    (error: unknown) =>
      error instanceof DuplicateDevFlowRunArtifactError &&
      error.runId === run.id &&
      error.artifactName === "prd" &&
      error.artifactPath.endsWith("/prd.md"),
  );
  await assert.rejects(
    run.writeValidation('{"status":"second"}'),
    (error: unknown) =>
      error instanceof DuplicateDevFlowRunArtifactError &&
      error.runId === run.id &&
      error.artifactName === "validation" &&
      error.artifactPath.endsWith("/validation.json"),
  );
  await assert.rejects(
    run.writeIssue("release_prep", "# Second issue\n"),
    (error: unknown) =>
      error instanceof DuplicateDevFlowRunArtifactError &&
      error.runId === run.id &&
      error.artifactName === "issue" &&
      error.artifactPath.endsWith("/issues/release-prep.md"),
  );

  assert.equal(
    await fs.readFile(join(run.paths.runDirectory, "prd.md"), "utf8"),
    "# First PRD\n",
  );
  assert.equal(
    await fs.readFile(join(run.paths.runDirectory, "validation.json"), "utf8"),
    '{"status":"first"}',
  );
  assert.equal(
    await fs.readFile(
      join(run.paths.runDirectory, "issues", "release-prep.md"),
      "utf8",
    ),
    "# First issue\n",
  );
});

test("run handles write issue artifacts through canonical normalized filenames", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.writeIssue("  Release_Prep Plan  ", "# Issue\n");

  assert.equal(
    await fs.readFile(
      join(run.paths.runDirectory, "issues", "release-prep-plan.md"),
      "utf8",
    ),
    "# Issue\n",
  );
});

test("run issue artifact writes reject invalid slugs before creating issue files", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await assert.rejects(
    run.writeIssue("../escape", "# nope\n"),
    (error: unknown) =>
      error instanceof InvalidDevFlowIssueSlugError &&
      error.slug === "../escape" &&
      error.message.includes("../escape"),
  );

  assert.equal(
    await fs.pathExists(join(run.paths.runDirectory, "issues")),
    false,
  );
});

test("run issue artifact writes reject duplicates after slug normalization", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.writeIssue("Release Prep", "# first\n");

  await assert.rejects(
    run.writeIssue("release_prep", "# second\n"),
    (error: unknown) =>
      error instanceof DuplicateDevFlowRunArtifactError &&
      error.runId === run.id &&
      error.artifactName === "issue" &&
      error.artifactPath.endsWith("/issues/release-prep.md"),
  );
});
