import assert from "node:assert/strict";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import fs from "fs-extra";

import {
  CompletedDevFlowRunArtifactError,
  createDevFlowState,
  DEVFLOW_GRILL_TRANSCRIPT_COMPLETE,
  DuplicateDevFlowRunArtifactError,
  type GitProjectContextProbe,
  InvalidGrillCheckpointError,
  InvalidDevFlowConfigError,
  InvalidDevFlowIssueSlugError,
  InvalidProjectContextError,
  InvalidProjectContextMetadataError,
  InvalidDevFlowRunIdError,
  InvalidProviderSessionStateError,
} from "../src/devflowState.js";

function createFreshnessProbe(
  overrides: Partial<GitProjectContextProbe> = {},
): GitProjectContextProbe {
  return {
    isRepository: async () => true,
    getCurrentHead: async () => "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    getCommittedChangesSince: async () => ({
      status: "available",
      changedPaths: [],
    }),
    getDirtyState: async () => ({
      staged: [],
      stagedDiff: Buffer.alloc(0),
      unstaged: [],
      unstagedDiff: Buffer.alloc(0),
      untracked: [],
    }),
    ...overrides,
  };
}

function expectedDirtyFingerprint(input: {
  staged?: Array<{ path: string; status: string; previousPath?: string }>;
  stagedDiff?: Buffer;
  unstaged?: Array<{ path: string; status: string; previousPath?: string }>;
  unstagedDiff?: Buffer;
  untracked?: Array<{ path: string; content: Buffer }>;
}): string {
  const hash = crypto.createHash("sha1");

  for (const [scope, changedPaths] of [
    ["staged-status", input.staged ?? []],
    ["unstaged-status", input.unstaged ?? []],
  ] as const) {
    for (const changedPath of [...changedPaths].sort((left, right) =>
      `${left.status}\0${left.previousPath ?? ""}\0${left.path}`.localeCompare(
        `${right.status}\0${right.previousPath ?? ""}\0${right.path}`,
      ),
    )) {
      hash.update(
        `${scope}\0${changedPath.status}\0${changedPath.previousPath ?? ""}\0${changedPath.path}\0`,
      );
    }
  }

  for (const [label, content] of [
    ["staged-diff", input.stagedDiff ?? Buffer.alloc(0)],
    ["unstaged-diff", input.unstagedDiff ?? Buffer.alloc(0)],
  ] as const) {
    hash.update(`${label}\0${content.byteLength}\0`);
    hash.update(content);
    hash.update("\0");
  }

  for (const untrackedFile of [...(input.untracked ?? [])].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(
      `untracked\0${untrackedFile.path}\0${untrackedFile.content.byteLength}\0`,
    );
    hash.update(untrackedFile.content);
    hash.update("\0");
  }

  return `dirty-${hash.digest("hex").slice(0, 16)}`;
}

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

  assert.equal(await state.projectContext.read(), undefined);

  await state.projectContext.write("# Project context\n");

  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "project-context.md"), "utf8"),
    "# Project context\n",
  );
  assert.equal(await state.projectContext.read(), "# Project context\n");
});

test("project context writes overwrite the existing shared artifact in place", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await state.projectContext.write("first snapshot");
  await state.projectContext.write("refreshed snapshot");

  assert.equal(await state.projectContext.read(), "refreshed snapshot");
  assert.equal(
    await fs.readFile(join(projectRoot, ".devflow", "project-context.md"), "utf8"),
    "refreshed snapshot",
  );
});

test("project context writes reject empty content before updating state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await state.projectContext.write("existing context");

  await assert.rejects(
    state.projectContext.write(" \n\t "),
    (error: unknown) =>
      error instanceof InvalidProjectContextError &&
      error.message.includes("non-empty"),
  );

  assert.equal(await state.projectContext.read(), "existing context");
});

test("project context writes reject content over the line cap before updating state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await state.projectContext.write("existing context");

  await assert.rejects(
    state.projectContext.write(
      Array.from({ length: 151 }, (_, index) => `line ${index + 1}`).join("\n"),
    ),
    (error: unknown) =>
      error instanceof InvalidProjectContextError &&
      error.message.includes("150 lines"),
  );

  assert.equal(await state.projectContext.read(), "existing context");
});

test("project context metadata is written beside the shared context and strictly read back", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: "dirty-0123456789abcdef",
    contextVersion: 1,
    refreshReason: "manual",
  });

  assert.deepEqual(
    await fs.readJson(join(projectRoot, ".devflow", "project-context.meta.json")),
    {
      generatedAt: "2026-05-23T10:00:00.000Z",
      gitHead: "0123456789abcdef0123456789abcdef01234567",
      dirtyFingerprint: "dirty-0123456789abcdef",
      contextVersion: 1,
      refreshReason: "manual",
    },
  );
  assert.deepEqual(await state.projectContext.readMetadata(), {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: "dirty-0123456789abcdef",
    contextVersion: 1,
    refreshReason: "manual",
  });
});

test("project context metadata validation rejects malformed writes before updating state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: null,
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });

  await assert.rejects(
    state.projectContext.write("replacement", {
      generatedAt: "not-a-date",
      gitHead: null,
      dirtyFingerprint: null,
      contextVersion: 1,
      refreshReason: "manual",
    }),
    (error: unknown) =>
      error instanceof InvalidProjectContextMetadataError &&
      error.message.includes("generatedAt"),
  );

  assert.equal(await state.projectContext.read(), "context snapshot");
  assert.deepEqual(await state.projectContext.readMetadata(), {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: null,
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });
});

test("project context refresh writes create metadata from the current git state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const dirtyState = {
    staged: [{ path: "src/changed.ts", status: "modified" as const }],
    stagedDiff: Buffer.from("staged diff"),
    unstaged: [],
    unstagedDiff: Buffer.alloc(0),
    untracked: [],
  };
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getCurrentHead: async () => "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      getDirtyState: async () => dirtyState,
    }),
  });

  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.readMetadata(), {
    generatedAt: "2026-05-24T10:00:00.000Z",
    gitHead: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    dirtyFingerprint: expectedDirtyFingerprint(dirtyState),
    contextVersion: 1,
    refreshReason: "manual",
  });
});

test("project context refresh writes update metadata when replacing existing metadata", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T11:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getCurrentHead: async () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dirtyFingerprint: "dirty-0123456789abcdef",
    contextVersion: 1,
    refreshReason: "relevant-changes",
  });

  await state.projectContext.write("updated context snapshot", {
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.readMetadata(), {
    generatedAt: "2026-05-24T11:00:00.000Z",
    gitHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });
});

test("project context refresh writes advance metadata when context content is unchanged", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  let currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let currentTime = "2026-05-24T10:00:00.000Z";
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date(currentTime) },
    gitProbe: createFreshnessProbe({
      getCurrentHead: async () => currentHead,
    }),
  });

  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });

  currentHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  currentTime = "2026-05-24T11:00:00.000Z";

  await state.projectContext.write("context snapshot", {
    refreshReason: "relevant-changes",
  });

  assert.equal(await state.projectContext.read(), "context snapshot");
  assert.deepEqual(await state.projectContext.readMetadata(), {
    generatedAt: "2026-05-24T11:00:00.000Z",
    gitHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "relevant-changes",
  });
});

test("project context refresh writes store clean git metadata with a null dirty fingerprint", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T12:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getCurrentHead: async () => "cccccccccccccccccccccccccccccccccccccccc",
      getDirtyState: async () => ({
        staged: [],
        stagedDiff: Buffer.alloc(0),
        unstaged: [],
        unstagedDiff: Buffer.alloc(0),
        untracked: [],
      }),
    }),
  });

  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.readMetadata(), {
    generatedAt: "2026-05-24T12:00:00.000Z",
    gitHead: "cccccccccccccccccccccccccccccccccccccccc",
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });
});

test("project context refresh writes store non-git metadata without git state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T13:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      isRepository: async () => false,
    }),
  });

  await state.projectContext.write("context snapshot", {
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.readMetadata(), {
    generatedAt: "2026-05-24T13:00:00.000Z",
    gitHead: null,
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });
});

test("project context freshness treats missing context as stale", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "missing-context",
  });
});

test("project context freshness treats missing metadata as stale with readable context", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await state.projectContext.write("context snapshot");

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "missing-metadata",
    context: "context snapshot",
  });
});

test("project context freshness treats malformed metadata as repairable stale cache state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await fs.outputFile(
    join(projectRoot, ".devflow", "project-context.md"),
    "context snapshot",
  );
  await fs.outputJson(
    join(projectRoot, ".devflow", "project-context.meta.json"),
    { generatedAt: "not-a-date" },
    { spaces: 2 },
  );

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "metadata-invalid",
    context: "context snapshot",
  });
});

test("project context freshness treats context version changes as stale repairable state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({ projectRoot });

  await fs.outputFile(
    join(projectRoot, ".devflow", "project-context.md"),
    "context snapshot",
  );
  await fs.outputJson(
    join(projectRoot, ".devflow", "project-context.meta.json"),
    {
      generatedAt: "2026-05-23T10:00:00.000Z",
      gitHead: null,
      dirtyFingerprint: null,
      contextVersion: 0,
      refreshReason: "manual",
    },
    { spaces: 2 },
  );

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "context-version-changed",
    context: "context snapshot",
  });
});

test("project context freshness treats non-git metadata older than three days as stale", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
  });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-20T09:59:59.999Z",
    gitHead: null,
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "max-age-exceeded",
    context: "context snapshot",
    metadata: {
      generatedAt: "2026-05-20T09:59:59.999Z",
      gitHead: null,
      dirtyFingerprint: null,
      contextVersion: 1,
      refreshReason: "manual",
    },
  });
});

test("project context freshness returns fresh non-git metadata within max age", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
  });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-20T10:00:00.000Z",
    gitHead: null,
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "fresh",
    context: "context snapshot",
    metadata: {
      generatedAt: "2026-05-20T10:00:00.000Z",
      gitHead: null,
      dirtyFingerprint: null,
      contextVersion: 1,
      refreshReason: "manual",
    },
  });
});

test("project context freshness uses the injected git probe for unavailable baselines", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getCommittedChangesSince: async () => ({
        status: "baseline-unavailable",
      }),
    }),
  });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "baseline-unavailable",
    context: "context snapshot",
    metadata: {
      generatedAt: "2026-05-23T10:00:00.000Z",
      gitHead: "0123456789abcdef0123456789abcdef01234567",
      dirtyFingerprint: null,
      contextVersion: 1,
      refreshReason: "manual",
    },
  });
});

test("project context freshness treats stored git head as a baseline when no relevant changes exist", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const calls: string[] = [];
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      isRepository: async () => {
        calls.push("isRepository");
        return true;
      },
      getCurrentHead: async () => {
        calls.push("getCurrentHead");
        return "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
      },
      getCommittedChangesSince: async (_root, baseline) => {
        calls.push(`getCommittedChangesSince:${baseline}`);
        return {
          status: "available",
          changedPaths: [],
        };
      },
      getDirtyState: async () => {
        calls.push("getDirtyState");
        return {
          staged: [],
          stagedDiff: Buffer.alloc(0),
          unstaged: [],
          unstagedDiff: Buffer.alloc(0),
          untracked: [],
        };
      },
    }),
  });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual",
  });

  assert.equal((await state.projectContext.checkFreshness()).status, "fresh");
  assert.deepEqual(calls, [
    "isRepository",
    "getCurrentHead",
    "getCommittedChangesSince:0123456789abcdef0123456789abcdef01234567",
    "getDirtyState",
  ]);
});

test("project context freshness reports relevant committed changes since the stored baseline", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const metadata = {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual" as const,
  };
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getCommittedChangesSince: async () => ({
        status: "available",
        changedPaths: [
          { path: "src/added.ts", status: "added" },
          { path: ".devflow/project-context.md", status: "modified" },
          {
            path: "src/renamed-new.ts",
            previousPath: "src/renamed-old.ts",
            status: "renamed",
          },
        ],
      }),
    }),
  });

  await state.projectContext.write("context snapshot", metadata);

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "relevant-changes",
    context: "context snapshot",
    metadata,
    changedPaths: [
      { path: "src/added.ts", status: "added" },
      {
        path: "src/renamed-new.ts",
        previousPath: "src/renamed-old.ts",
        status: "renamed",
      },
    ],
  });
});

test("project context freshness treats repeated dirty git fingerprints as fresh", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const dirtyState = {
    staged: [{ path: "staged.ts", status: "modified" as const }],
    stagedDiff: Buffer.from("staged diff"),
    unstaged: [{ path: "unstaged.ts", status: "deleted" as const }],
    unstagedDiff: Buffer.from("unstaged diff"),
    untracked: [
      {
        path: "notes/new-file.md",
        status: "untracked" as const,
        content: Buffer.from("new file"),
      },
    ],
  };
  const metadata = {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: expectedDirtyFingerprint(dirtyState),
    contextVersion: 1,
    refreshReason: "manual" as const,
  };
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getDirtyState: async () => dirtyState,
    }),
  });

  await state.projectContext.write("context snapshot", metadata);

  assert.match(metadata.dirtyFingerprint, /^dirty-[0-9a-f]{16}$/);
  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "fresh",
    context: "context snapshot",
    metadata,
  });
  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "fresh",
    context: "context snapshot",
    metadata,
  });
});

test("project context freshness treats changed dirty tracked content as stale", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const baselineDirtyState = {
    staged: [{ path: "staged.ts", status: "modified" as const }],
    stagedDiff: Buffer.from("old staged diff"),
    unstaged: [{ path: "unstaged.ts", status: "modified" as const }],
    unstagedDiff: Buffer.from("old unstaged diff"),
    untracked: [],
  };
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getDirtyState: async () => ({
        ...baselineDirtyState,
        unstagedDiff: Buffer.from("new unstaged diff"),
      }),
    }),
  });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: expectedDirtyFingerprint(baselineDirtyState),
    contextVersion: 1,
    refreshReason: "manual",
  });

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "relevant-changes",
    context: "context snapshot",
    metadata: {
      generatedAt: "2026-05-23T10:00:00.000Z",
      gitHead: "0123456789abcdef0123456789abcdef01234567",
      dirtyFingerprint: expectedDirtyFingerprint(baselineDirtyState),
      contextVersion: 1,
      refreshReason: "manual",
    },
    changedPaths: [
      { path: "staged.ts", status: "modified" },
      { path: "unstaged.ts", status: "modified" },
    ],
  });
});

test("project context freshness includes untracked path and content in dirty fingerprints", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const baselineDirtyState = {
    staged: [],
    stagedDiff: Buffer.alloc(0),
    unstaged: [],
    unstagedDiff: Buffer.alloc(0),
    untracked: [
      {
        path: "notes/new-file.md",
        status: "untracked" as const,
        content: Buffer.from("old content"),
      },
    ],
  };
  const changedUntrackedState = {
    ...baselineDirtyState,
    untracked: [
      {
        path: "notes/new-file.md",
        status: "untracked" as const,
        content: Buffer.from("new content"),
      },
    ],
  };
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getDirtyState: async () => changedUntrackedState,
    }),
  });

  await state.projectContext.write("context snapshot", {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: expectedDirtyFingerprint(baselineDirtyState),
    contextVersion: 1,
    refreshReason: "manual",
  });

  assert.notEqual(
    expectedDirtyFingerprint(baselineDirtyState),
    expectedDirtyFingerprint(changedUntrackedState),
  );
  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "relevant-changes",
    context: "context snapshot",
    metadata: {
      generatedAt: "2026-05-23T10:00:00.000Z",
      gitHead: "0123456789abcdef0123456789abcdef01234567",
      dirtyFingerprint: expectedDirtyFingerprint(baselineDirtyState),
      contextVersion: 1,
      refreshReason: "manual",
    },
    changedPaths: [{ path: "notes/new-file.md", status: "untracked" }],
  });
});

test("project context freshness ignores DevFlow and agent-owned path changes", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const metadata = {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual" as const,
  };
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getCommittedChangesSince: async () => ({
        status: "available",
        changedPaths: [
          { path: ".agent/task_progress.md", status: "modified" },
          { path: ".codex/session.json", status: "modified" },
          { path: ".agents/issues/005.md", status: "modified" },
          { path: ".devflow/project-context.md", status: "modified" },
        ],
      }),
      getDirtyState: async () => ({
        staged: [{ path: ".devflow/project-context.md", status: "modified" }],
        stagedDiff: Buffer.from("ignored staged diff"),
        unstaged: [{ path: ".agent/task_progress.md", status: "modified" }],
        unstagedDiff: Buffer.from("ignored unstaged diff"),
        untracked: [
          {
            path: ".agents/issues/005.md",
            status: "untracked",
            content: Buffer.from("ignored issue workflow state"),
          },
        ],
      }),
    }),
  });

  await state.projectContext.write("context snapshot", metadata);

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "fresh",
    context: "context snapshot",
    metadata,
  });
});

test("project context freshness treats project-owned build and dependency paths as relevant", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-context-"));
  const metadata = {
    generatedAt: "2026-05-23T10:00:00.000Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    dirtyFingerprint: null,
    contextVersion: 1,
    refreshReason: "manual" as const,
  };
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-23T10:00:00.000Z") },
    gitProbe: createFreshnessProbe({
      getCommittedChangesSince: async () => ({
        status: "available",
        changedPaths: [
          { path: "dist/index.js", status: "modified" },
          { path: "coverage/report.json", status: "modified" },
          { path: "node_modules/pkg/index.js", status: "modified" },
        ],
      }),
      getDirtyState: async () => ({
        staged: [],
        stagedDiff: Buffer.alloc(0),
        unstaged: [],
        unstagedDiff: Buffer.alloc(0),
        untracked: [],
      }),
    }),
  });

  await state.projectContext.write("context snapshot", metadata);

  assert.deepEqual(await state.projectContext.checkFreshness(), {
    status: "stale",
    refreshReason: "relevant-changes",
    context: "context snapshot",
    metadata,
    changedPaths: [
      { path: "dist/index.js", status: "modified" },
      { path: "coverage/report.json", status: "modified" },
      { path: "node_modules/pkg/index.js", status: "modified" },
    ],
  });
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
  assert.equal(
    firstRun.paths.projectContextCandidate,
    join(firstRun.paths.runDirectory, "project-context.candidate.md"),
  );
  assert.equal(
    firstRun.paths.projectContextCandidate,
    join(projectRoot, ".devflow", "runs", firstRun.id, "project-context.candidate.md"),
  );
  assert.equal(
    firstRun.paths.projectContextArtifact,
    join(projectRoot, ".devflow", "project-context.md"),
  );
  assert.equal(
    firstRun.paths.grillTranscript,
    join(firstRun.paths.runDirectory, "grill-transcript.md"),
  );
  assert.equal(
    firstRun.paths.grillCheckpoint,
    join(firstRun.paths.runDirectory, "grill-checkpoint.json"),
  );
  assert.equal(firstRun.paths.prdArtifact, join(firstRun.paths.runDirectory, "prd.md"));
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

test("run handles write and read provider session state before grill checkpoint creation", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.writeProviderSessionState({
    provider: { id: "codex", displayName: "Codex" },
    providerSessionId: "codex-session-123",
    phase: { id: "grill-initial", kind: "grill", attempt: 1 },
    status: "active",
    startedAt: "2026-05-24T10:00:00.000Z",
    updatedAt: "2026-05-24T10:01:00.000Z",
  });

  assert.equal(await fs.pathExists(run.paths.grillCheckpoint), false);
  assert.deepEqual(await run.readProviderSessionState(), {
    provider: { id: "codex", displayName: "Codex" },
    providerSessionId: "codex-session-123",
    phase: { id: "grill-initial", kind: "grill", attempt: 1 },
    status: "active",
    startedAt: "2026-05-24T10:00:00.000Z",
    updatedAt: "2026-05-24T10:01:00.000Z",
  });
  assert.deepEqual(await fs.readJson(run.paths.providerSessionState), {
    provider: { id: "codex", displayName: "Codex" },
    providerSessionId: "codex-session-123",
    phase: { id: "grill-initial", kind: "grill", attempt: 1 },
    status: "active",
    startedAt: "2026-05-24T10:00:00.000Z",
    updatedAt: "2026-05-24T10:01:00.000Z",
  });
});

test("run handles reject malformed provider session state before writing state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await assert.rejects(
    run.writeProviderSessionState({
      provider: { id: "unknown", displayName: "" },
      providerSessionId: "",
      phase: { id: "", kind: "", attempt: 0 },
      status: "stalled",
      startedAt: "not-a-date",
      updatedAt: "2026-05-24T10:01:00.000Z",
    } as never),
    (error: unknown) =>
      error instanceof InvalidProviderSessionStateError &&
      error.message.includes("provider.id") &&
      error.message.includes("provider.displayName") &&
      error.message.includes("providerSessionId") &&
      error.message.includes("phase.id") &&
      error.message.includes("phase.kind") &&
      error.message.includes("phase.attempt") &&
      error.message.includes("status") &&
      error.message.includes("startedAt"),
  );

  assert.equal(await fs.pathExists(run.paths.providerSessionState), false);
});

test("run handles reject malformed persisted provider session json with a typed error", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await fs.outputFile(run.paths.providerSessionState, "{broken", "utf8");

  await assert.rejects(
    run.readProviderSessionState(),
    (error: unknown) =>
      error instanceof InvalidProviderSessionStateError &&
      error.statePath === run.paths.providerSessionState &&
      error.message.includes("provider-session.json"),
  );
});

test("run handles record readable grill transcript message blocks and immutable completion", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.initializeGrillTranscript();
  await run.appendGrillProviderMessage("\u001b[31mWhat outcome matters?\r\n");
  await run.appendGrillUserMessage("Ship the artifact contract.\n");
  await run.completeGrillTranscript();

  assert.equal(
    await fs.readFile(run.paths.grillTranscript, "utf8"),
    [
      "# Grill Transcript",
      "",
      "## Provider",
      "",
      "What outcome matters?",
      "",
      "## User",
      "",
      "Ship the artifact contract.",
      "",
      DEVFLOW_GRILL_TRANSCRIPT_COMPLETE,
      "",
    ].join("\n"),
  );

  await assert.rejects(
    run.appendGrillProviderMessage("too late"),
    (error: unknown) =>
      error instanceof CompletedDevFlowRunArtifactError &&
      error.runId === run.id &&
      error.artifactName === "grill-transcript",
  );
});

test("run handles validate and write grill checkpoint only after transcript completion", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });
  const run = await state.createRun();
  const checkpoint = {
    stage: "grill" as const,
    status: "complete" as const,
    completedAt: "2026-05-24T10:00:00.000Z",
    rawTask: "resume work",
    intentArtifactPath: run.paths.intentArtifact,
    projectContextPath: run.paths.projectContextArtifact,
    grillTranscriptPath: run.paths.grillTranscript,
    prdArtifactPath: run.paths.prdArtifact,
  };

  await run.initializeGrillTranscript();
  await assert.rejects(
    run.writeGrillCheckpoint(checkpoint),
    (error: unknown) =>
      error instanceof InvalidGrillCheckpointError &&
      error.message.includes("transcript must be complete"),
  );

  await run.completeGrillTranscript();
  await run.writeGrillCheckpoint(checkpoint);

  assert.deepEqual(await fs.readJson(run.paths.grillCheckpoint), checkpoint);
});

test("completed grill checkpoints can include associated provider session metadata", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });
  const run = await state.createRun();
  const checkpoint = {
    stage: "grill" as const,
    status: "complete" as const,
    completedAt: "2026-05-24T10:00:00.000Z",
    rawTask: "resume work",
    intentArtifactPath: run.paths.intentArtifact,
    projectContextPath: run.paths.projectContextArtifact,
    grillTranscriptPath: run.paths.grillTranscript,
    prdArtifactPath: run.paths.prdArtifact,
    providerSession: {
      provider: { id: "codex" as const, displayName: "Codex" as const },
      providerSessionId: "codex-session-123",
      phase: { id: "grill-initial", kind: "grill", attempt: 1 },
    },
  };

  await run.initializeGrillTranscript();
  await run.completeGrillTranscript();
  await run.writeGrillCheckpoint(checkpoint);

  assert.deepEqual(await run.readGrillCheckpoint(), checkpoint);
});

test("provider session metadata does not make incomplete grill checkpoints trusted", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({
    projectRoot,
    clock: { now: () => new Date("2026-05-24T10:00:00.000Z") },
  });
  const run = await state.createRun();

  await run.initializeGrillTranscript();
  await run.appendGrillProviderMessage("The grill is still in progress.\n");

  await assert.rejects(
    run.writeGrillCheckpoint({
      stage: "grill",
      status: "complete",
      completedAt: "2026-05-24T10:00:00.000Z",
      rawTask: "resume work",
      intentArtifactPath: run.paths.intentArtifact,
      projectContextPath: run.paths.projectContextArtifact,
      grillTranscriptPath: run.paths.grillTranscript,
      prdArtifactPath: run.paths.prdArtifact,
      providerSession: {
        provider: { id: "codex", displayName: "Codex" },
        providerSessionId: "codex-session-123",
        phase: { id: "grill-initial", kind: "grill", attempt: 1 },
      },
    }),
    (error: unknown) =>
      error instanceof InvalidGrillCheckpointError &&
      error.message.includes("transcript must be complete"),
  );

  assert.equal(await run.readGrillCheckpoint(), undefined);
});

test("run handles distinguish missing partial and completed grill transcripts", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  assert.equal(await run.getGrillTranscriptStatus(), "missing");

  await run.initializeGrillTranscript();
  await run.appendGrillProviderMessage("What changed?\n");

  assert.equal(await run.getGrillTranscriptStatus(), "partial");

  await run.completeGrillTranscript();

  assert.equal(await run.getGrillTranscriptStatus(), "complete");
});

test("run handles recover missing or corrupt grill checkpoints from completed transcripts", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();
  const checkpoint = {
    stage: "grill" as const,
    status: "complete" as const,
    completedAt: "2026-05-24T10:00:00.000Z",
    rawTask: "resume work",
    intentArtifactPath: run.paths.intentArtifact,
    projectContextPath: run.paths.projectContextArtifact,
    grillTranscriptPath: run.paths.grillTranscript,
    prdArtifactPath: run.paths.prdArtifact,
  };

  assert.equal(await run.readGrillCheckpoint(), undefined);

  await run.initializeGrillTranscript();
  await run.completeGrillTranscript();
  await run.recoverGrillCheckpoint(checkpoint);

  assert.deepEqual(await run.readGrillCheckpoint(), checkpoint);

  await fs.writeFile(run.paths.grillCheckpoint, "{broken", "utf8");
  await assert.rejects(
    run.readGrillCheckpoint(),
    (error: unknown) => error instanceof InvalidGrillCheckpointError,
  );

  await run.recoverGrillCheckpoint({
    ...checkpoint,
    completedAt: "2026-05-24T10:05:00.000Z",
  });

  assert.deepEqual(await run.readGrillCheckpoint(), {
    ...checkpoint,
    completedAt: "2026-05-24T10:05:00.000Z",
  });
});

test("malformed provider session state does not prevent reading completed grill checkpoints", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();
  const checkpoint = {
    stage: "grill" as const,
    status: "complete" as const,
    completedAt: "2026-05-24T10:00:00.000Z",
    rawTask: "resume work",
    intentArtifactPath: run.paths.intentArtifact,
    projectContextPath: run.paths.projectContextArtifact,
    grillTranscriptPath: run.paths.grillTranscript,
    prdArtifactPath: run.paths.prdArtifact,
  };

  await run.initializeGrillTranscript();
  await run.completeGrillTranscript();
  await run.writeGrillCheckpoint(checkpoint);
  await fs.outputFile(run.paths.providerSessionState, "{broken", "utf8");

  assert.deepEqual(await run.readGrillCheckpoint(), checkpoint);
  await assert.rejects(
    run.readProviderSessionState(),
    (error: unknown) => error instanceof InvalidProviderSessionStateError,
  );
});

test("run handles reject checkpoint recovery from partial grill transcripts", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.initializeGrillTranscript();
  await run.appendGrillProviderMessage("Still deciding.\n");

  await assert.rejects(
    run.recoverGrillCheckpoint({
      stage: "grill",
      status: "complete",
      completedAt: "2026-05-24T10:00:00.000Z",
      rawTask: "resume work",
      intentArtifactPath: run.paths.intentArtifact,
      projectContextPath: run.paths.projectContextArtifact,
      grillTranscriptPath: run.paths.grillTranscript,
      prdArtifactPath: run.paths.prdArtifact,
    }),
    (error: unknown) =>
      error instanceof InvalidGrillCheckpointError &&
      error.message.includes("transcript must be complete"),
  );
});

test("run handles reject malformed grill checkpoints before writing state", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-state-runs-"));
  const state = createDevFlowState({ projectRoot });
  const run = await state.createRun();

  await run.initializeGrillTranscript();
  await run.completeGrillTranscript();

  await assert.rejects(
    run.writeGrillCheckpoint({
      stage: "grill",
      status: "complete",
      completedAt: "not-a-date",
      rawTask: "",
      intentArtifactPath: run.paths.intentArtifact,
      projectContextPath: run.paths.projectContextArtifact,
      grillTranscriptPath: run.paths.grillTranscript,
      prdArtifactPath: run.paths.prdArtifact,
    }),
    (error: unknown) =>
      error instanceof InvalidGrillCheckpointError &&
      error.message.includes("completedAt") &&
      error.message.includes("rawTask"),
  );

  assert.equal(await fs.pathExists(run.paths.grillCheckpoint), false);
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
