import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import fs from "fs-extra";

import {
  CodexSessionLogLocatorResumeNotFoundError,
  CodexSessionLogLocatorTimeoutError,
  createCodexSessionLogLocator,
  getScopedCodexProviderHome,
  locateCodexSessionLogForProvider,
  type SessionLogWatchEvent,
  type SessionLogWatcher,
} from "../../src/adapters/codexSessionLogLocator.js";
import {
  ProviderSessionEventCaptureError,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

class FakeSessionLogWatcher implements SessionLogWatcher {
  readonly listeners = new Map<
    SessionLogWatchEvent,
    Array<(filePath: string) => void>
  >();
  closeCount = 0;

  on(
    event: SessionLogWatchEvent,
    listener: (filePath: string) => void,
  ): SessionLogWatcher {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  emit(event: SessionLogWatchEvent, filePath: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(filePath);
    }
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

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

test("Codex session log locator finds a resume rollout by provider session id and captures its end offset", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const providerSessionId = "codex-session-123";
  const matchingContent = '{"type":"session_meta"}\n{"type":"task_complete"}\n';
  const locator = createCodexSessionLogLocator({
    codexHome,
  });

  await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-codex-session-123-old.jsonl",
  );
  const matchingLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-2026-05-29T10-00-00-codex-session-123.jsonl",
    matchingContent,
  );
  await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-other-session.jsonl",
  );

  const located = await locator.locateResumeLog(providerSessionId);

  assert.equal(located.filePath, matchingLog);
  assert.equal(located.startOffset, Buffer.byteLength(matchingContent, "utf8"));
  assert.deepEqual(
    located.debug.candidates.map((candidate) => candidate.filePath),
    [matchingLog],
  );
});

test("Codex session log locator fails resume lookup with a typed error when no rollout matches the provider session id", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const locator = createCodexSessionLogLocator({
    codexHome,
  });

  await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-other-session.jsonl",
  );

  await assert.rejects(
    locator.locateResumeLog("codex-session-123"),
    (error: unknown) => {
      assert.ok(error instanceof CodexSessionLogLocatorResumeNotFoundError);
      assert.equal(error.scopedProviderHome, codexHome);
      assert.equal(error.searchedPattern, "sessions/**/rollout-*.jsonl");
      assert.equal(error.providerSessionId, "codex-session-123");
      assert.match(error.message, /codex-session-123/);
      return true;
    },
  );
});

test("Codex session log locator timeout includes scoped home and rollout pattern", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const locator = createCodexSessionLogLocator({
    codexHome,
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

test("Codex session log locator uses a short-lived scoped watcher for new rollout discovery", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-log-"));
  const codexHome = getScopedCodexProviderHome(createInput(projectRoot));
  const watcher = new FakeSessionLogWatcher();
  const watchedRoots: string[] = [];
  const existingLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-existing.jsonl",
  );
  const locator = createCodexSessionLogLocator({
    codexHome,
    watchSessionsTree(sessionsRoot) {
      watchedRoots.push(sessionsRoot);
      return watcher;
    },
  });

  const snapshot = await locator.snapshot();
  const locatePromise = locator.locateActiveLog(snapshot, { timeoutMs: 500 });
  await waitFor(() => watchedRoots.length === 1);

  const emptyLog = await createRollout(
    codexHome,
    "sessions/2026/05/29/rollout-empty.jsonl",
    "",
  );
  watcher.emit("add", emptyLog);
  await new Promise((resolve) => setTimeout(resolve, 5));

  await fs.appendFile(emptyLog, "{}\n", "utf8");
  watcher.emit("change", emptyLog);

  const located = await locatePromise;

  assert.deepEqual(watchedRoots, [join(codexHome, "sessions")]);
  assert.equal(located.filePath, emptyLog);
  assert.equal(located.debug.ignoredPreexistingCount, 1);
  assert.equal(located.debug.emptyCandidateCount, 1);
  assert.deepEqual(Array.from(snapshot.filePaths), [existingLog]);
  assert.equal(watcher.closeCount, 1);
});
