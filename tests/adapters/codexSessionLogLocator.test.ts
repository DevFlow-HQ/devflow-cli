import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import fs from "fs-extra";

import {
  CodexSessionLogLocatorTimeoutError,
  createCodexSessionLogLocator,
  getScopedCodexProviderHome,
  locateCodexSessionLogForProvider,
} from "../../src/adapters/codexSessionLogLocator.js";
import {
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

function createInput(
  projectRoot: string,
  phaseId = "runabc123456:intent:attempt-1",
): ManagedProviderSessionInput {
  return {
    workingDirectory: projectRoot,
    initialPrompt: "Start",
    initialCompletionMarker: "DONE",
    phase: { id: phaseId, kind: "intent", attempt: 1 },
    async validate() {},
  };
}

async function createRollout(
  root: string,
  relativePath: string,
  content = "{}\n",
): Promise<string> {
  const filePath = join(root, relativePath);
  await fs.ensureDir(dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

test("Codex session log locator discovers new rollout logs only inside the scoped provider home", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const input = createInput(projectRoot);
  const codexHome = getScopedCodexProviderHome(input);
  const globalCodexHome = join(projectRoot, ".codex");
  const locator = createCodexSessionLogLocator({
    codexHome,
    pollIntervalMs: 5,
  });

  const snapshot = await locator.snapshot();
  await createRollout(
    globalCodexHome,
    "sessions/2026/05/29/rollout-global.jsonl",
  );
  const scopedLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-scoped.jsonl",
  );

  const located = await locator.locateActiveLog(snapshot, { timeoutMs: 100 });

  assert.equal(located.filePath, scopedLog);
  assert.equal(located.debug.scopedProviderHome, codexHome);
  assert.equal(located.debug.searchedPattern, "sessions/**/rollout-*.jsonl");
  assert.deepEqual(
    located.debug.candidates.map((candidate) => candidate.filePath),
    [scopedLog],
  );
});

test("Codex session log locator ignores rollout files that existed before spawn", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const existingLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-existing.jsonl",
  );
  const locator = createCodexSessionLogLocator({
    codexHome,
    pollIntervalMs: 5,
  });

  const snapshot = await locator.snapshot();
  const newLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-new.jsonl",
  );

  const located = await locator.locateActiveLog(snapshot, { timeoutMs: 100 });

  assert.equal(located.filePath, newLog);
  assert.equal(located.debug.ignoredPreexistingCount, 1);
  assert.deepEqual(Array.from(snapshot.filePaths), [existingLog]);
});

test("Codex session log locator waits for empty candidates to receive append data", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const locator = createCodexSessionLogLocator({
    codexHome,
    pollIntervalMs: 5,
  });

  const snapshot = await locator.snapshot();
  const emptyLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-empty.jsonl",
    "",
  );

  setTimeout(() => {
    void fs.appendFile(emptyLog, "{}\n", "utf8");
  }, 20);

  const located = await locator.locateActiveLog(snapshot, { timeoutMs: 250 });

  assert.equal(located.filePath, emptyLog);
  assert.equal(located.debug.emptyCandidateCount, 1);
});

test("Codex session log locator searches nested session trees without date assumptions", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const locator = createCodexSessionLogLocator({
    codexHome,
    pollIntervalMs: 5,
  });

  const snapshot = await locator.snapshot();
  const nestedLog = await createRollout(
    codexHome,
    "sessions/custom/deep/tree/rollout-nested.jsonl",
  );

  const located = await locator.locateActiveLog(snapshot, { timeoutMs: 100 });

  assert.equal(located.filePath, nestedLog);
});

test("Codex session log locator deterministically selects the most recent non-empty candidate", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const locator = createCodexSessionLogLocator({
    codexHome,
    pollIntervalMs: 5,
  });

  const snapshot = await locator.snapshot();
  const olderLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-older.jsonl",
  );
  const newerLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-newer.jsonl",
  );
  const olderDate = new Date("2026-05-29T10:00:00.000Z");
  const newerDate = new Date("2026-05-29T10:01:00.000Z");
  await fs.utimes(olderLog, olderDate, olderDate);
  await fs.utimes(newerLog, newerDate, newerDate);

  const located = await locator.locateActiveLog(snapshot, { timeoutMs: 100 });

  assert.equal(located.filePath, newerLog);
  assert.equal(located.debug.multipleCandidates, true);
  assert.deepEqual(
    located.debug.candidates.map((candidate) => candidate.filePath),
    [newerLog, olderLog],
  );
});

test("Codex session log locator timeout includes scoped home and rollout pattern", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const locator = createCodexSessionLogLocator({
    codexHome,
    pollIntervalMs: 5,
  });

  const snapshot = await locator.snapshot();

  await assert.rejects(
    locator.locateActiveLog(snapshot, { timeoutMs: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof CodexSessionLogLocatorTimeoutError);
      assert.equal(error.scopedProviderHome, codexHome);
      assert.equal(error.searchedPattern, "sessions/**/rollout-*.jsonl");
      assert.match(
        error.message,
        new RegExp(codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.match(error.message, /sessions\/\*\*\/rollout-\*\.jsonl/);
      return true;
    },
  );
});

test("Codex session log locator provider wrapper classifies timeout as event capture failure", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const locator = createCodexSessionLogLocator({
    codexHome,
    pollIntervalMs: 5,
  });
  const snapshot = await locator.snapshot();

  await assert.rejects(
    locateCodexSessionLogForProvider({
      provider: getBuiltInProviderIdentity("codex"),
      locator,
      snapshot,
      timeoutMs: 10,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSessionEventCaptureError);
      assert.ok(error.cause instanceof CodexSessionLogLocatorTimeoutError);
      return true;
    },
  );
});
