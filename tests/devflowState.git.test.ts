import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";
import fs from "fs-extra";

import { createDevFlowState } from "../src/devflowState.js";

async function git(projectRoot: string, args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd: projectRoot });

  return result.stdout;
}

async function createGitProject(): Promise<{
  projectRoot: string;
  initialHead: string;
}> {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-git-state-"));

  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.email", "devflow@example.test"]);
  await git(projectRoot, ["config", "user.name", "DevFlow Test"]);
  await git(projectRoot, ["config", "commit.gpgsign", "false"]);
  await fs.outputFile(join(projectRoot, "src", "index.ts"), "export const value = 1;\n");
  await git(projectRoot, ["add", "src/index.ts"]);
  await git(projectRoot, ["commit", "-m", "Initial commit"]);

  return {
    projectRoot,
    initialHead: await git(projectRoot, ["rev-parse", "HEAD"]),
  };
}

test("default git probe keeps clean refresh metadata fresh through the state API", async () => {
  const { projectRoot, initialHead } = await createGitProject();
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });

  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.readMetadata(), {
    generatedAt: "2026-05-24T10:00:00.000Z",
    gitHead: initialHead,
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });
  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "fresh",
    context: "context snapshot",
    metadata: {
      generatedAt: "2026-05-24T10:00:00.000Z",
      gitHead: initialHead,
      dirtyFingerprint: null,
      contextVersion: 1,
      refreshReason: "manual",
    },
  });
});

test("default git probe reports committed changes since the stored baseline", async () => {
  const { projectRoot, initialHead } = await createGitProject();
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-24T10:00:00.000Z",
    gitHead: initialHead,
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });
  await fs.outputFile(join(projectRoot, "src", "feature.ts"), "export const feature = true;\n");
  await git(projectRoot, ["add", "src/feature.ts"]);
  await git(projectRoot, ["commit", "-m", "Add feature"]);

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "relevant-changes",
    context: "context snapshot",
    metadata: {
      generatedAt: "2026-05-24T10:00:00.000Z",
      gitHead: initialHead,
      dirtyFingerprint: null,
      contextVersion: 1,
      refreshReason: "manual",
    },
    changedPaths: [{ path: "src/feature.ts", status: "added" }],
  });
});

test("default git probe formats fewer than five recent commits for execution context", async () => {
  const { projectRoot, initialHead } = await createGitProject();
  const state = createDevFlowState({ projectRoot });

  assert.equal(
    await state.git.getRecentCommits(),
    `${initialHead}\n${new Date().toISOString().slice(0, 10)}\nInitial commit`,
  );
});

test("default git probe returns a stable placeholder when a repository has no commits", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-git-empty-"));
  await git(projectRoot, ["init"]);

  const state = createDevFlowState({ projectRoot });

  assert.equal(await state.git.getCurrentHead(), null);
  assert.equal(await state.git.getRecentCommits(), "No commits found.");
});

test("default git probe includes untracked file content in dirty fingerprints", async () => {
  const { projectRoot } = await createGitProject();
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });

  await fs.outputFile(join(projectRoot, "notes", "scratch.md"), "first draft\n");
  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });
  const metadata = await state.projectContext.readMetadata();

  await fs.outputFile(join(projectRoot, "notes", "scratch.md"), "second draft\n");

  assert.match(metadata?.dirtyFingerprint ?? "", /^dirty-[0-9a-f]{16}$/);
  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "relevant-changes",
    context: "context snapshot",
    metadata,
    changedPaths: [{ path: "notes/scratch.md", status: "untracked" }],
  });
});

test("default git probe fingerprints large untracked files without full-file reads", async (t) => {
  const { projectRoot } = await createGitProject();
  const largeUntrackedPath = join(projectRoot, "notes", "large.bin");
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });

  await fs.outputFile(largeUntrackedPath, Buffer.alloc(1024 * 1024, "a"));

  const originalReadFile = fs.readFile.bind(fs);
  t.mock.method(fs, "readFile", async (...args: unknown[]) => {
    const [path] = args;

    if (path === largeUntrackedPath) {
      throw new Error("large untracked files must be streamed");
    }

    return Reflect.apply(originalReadFile, fs, args);
  });

  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });
  const metadata = await state.projectContext.readMetadata();

  await fs.outputFile(largeUntrackedPath, Buffer.alloc(1024 * 1024, "b"));

  assert.match(metadata?.dirtyFingerprint ?? "", /^dirty-[0-9a-f]{16}$/);
  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "relevant-changes",
    context: "context snapshot",
    metadata,
    changedPaths: [{ path: "notes/large.bin", status: "untracked" }],
  });
});

test("default git probe ignores untracked files excluded by git ignore rules", async () => {
  const { projectRoot } = await createGitProject();
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });

  await fs.outputFile(join(projectRoot, ".gitignore"), "ignored.log\n");
  await git(projectRoot, ["add", ".gitignore"]);
  await git(projectRoot, ["commit", "-m", "Ignore logs"]);
  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });
  const metadata = await state.projectContext.readMetadata();

  await fs.outputFile(join(projectRoot, "ignored.log"), "ignored content\n");

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "fresh",
    context: "context snapshot",
    metadata,
  });
});

test("default git probe filters agent-owned untracked files before reading content", async (t) => {
  const { projectRoot } = await createGitProject();
  const agentUntrackedPath = join(projectRoot, ".agent", "large-state.bin");
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });

  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });
  const metadata = await state.projectContext.readMetadata();
  await fs.outputFile(agentUntrackedPath, Buffer.alloc(1024 * 1024, "a"));

  const originalReadFile = fs.readFile.bind(fs);
  t.mock.method(fs, "readFile", async (...args: unknown[]) => {
    const [path] = args;

    if (path === agentUntrackedPath) {
      throw new Error("agent-owned untracked files must be filtered first");
    }

    return Reflect.apply(originalReadFile, fs, args);
  });

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "fresh",
    context: "context snapshot",
    metadata,
  });
});

test("default git probe treats unignored project-shape paths as relevant", async () => {
  const { projectRoot } = await createGitProject();
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });

  await fs.outputFile(join(projectRoot, ".gitignore"), "dist/ignored.js\n");
  await git(projectRoot, ["add", ".gitignore"]);
  await git(projectRoot, ["commit", "-m", "Ignore one dist file"]);
  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });
  const metadata = await state.projectContext.readMetadata();

  await fs.outputFile(join(projectRoot, "dist", "ignored.js"), "ignored by git\n");
  await fs.outputFile(join(projectRoot, "dist", "index.js"), "unignored dist content\n");

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "relevant-changes",
    context: "context snapshot",
    metadata,
    changedPaths: [{ path: "dist/index.js", status: "untracked" }],
  });
});
