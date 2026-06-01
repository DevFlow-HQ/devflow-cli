import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import fs from "fs-extra";

import {
  ClaudeSessionLogLocatorResumeNotFoundError,
  createClaudeSessionLogLocator,
  getScopedClaudeProviderHome,
  locateClaudeSessionLogForProvider,
} from "../../src/adapters/claudeSessionLogLocator.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

test("Claude session log locator discovers a newly created scoped transcript", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-locator-"));
  const input = {
    workingDirectory: projectRoot,
    initialPrompt: "Start",
    initialCompletionMarker: "DONE",
    phase: {
      id: "runabc123456:intent:attempt-1",
      kind: "intent",
      attempt: 1,
    },
    async validate() {},
  };
  const claudeHome = getScopedClaudeProviderHome(input);
  const locator = createClaudeSessionLogLocator({ claudeHome });
  const snapshot = await locator.snapshot();
  const transcriptPath = join(
    claudeHome,
    "projects",
    "-tmp-devflow",
    "claude-session-1.jsonl",
  );

  await fs.ensureDir(join(claudeHome, "projects", "-tmp-devflow"));
  const locating = locateClaudeSessionLogForProvider({
    provider: getBuiltInProviderIdentity("claude"),
    locator,
    snapshot,
    timeoutMs: 1_000,
  });

  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "assistant" })}\n`,
    "utf8",
  );

  const location = await locating;

  assert.equal(location.filePath, transcriptPath);
  assert.equal(location.debug.scopedProviderHome, claudeHome);
  assert.equal(location.debug.searchedPattern, "projects/**/*.jsonl");
  assert.equal(location.debug.ignoredPreexistingCount, 0);
});

test("Claude session log locator finds a resume transcript by provider session id and captures its end offset", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-resume-locator-"));
  const input = {
    workingDirectory: projectRoot,
    initialPrompt: "Start",
    initialCompletionMarker: "DONE",
    phase: {
      id: "runabc123456:intent:attempt-1",
      kind: "intent",
      attempt: 1,
    },
    async validate() {},
  };
  const claudeHome = getScopedClaudeProviderHome(input);
  const locator = createClaudeSessionLogLocator({ claudeHome });
  const olderTranscriptPath = join(
    claudeHome,
    "projects",
    "-other-cwd",
    "session-old.jsonl",
  );
  const transcriptPath = join(
    claudeHome,
    "projects",
    "-current-cwd",
    "session-current.jsonl",
  );
  const staleRecord = `${JSON.stringify({
    type: "assistant",
    sessionId: "claude-session-123",
    message: {
      id: "msg_stale",
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "stale DONE" }],
    },
  })}\n`;

  await fs.ensureDir(join(claudeHome, "projects", "-other-cwd"));
  await fs.ensureDir(join(claudeHome, "projects", "-current-cwd"));
  await fs.writeFile(
    olderTranscriptPath,
    `${JSON.stringify({ type: "user", sessionId: "different-session" })}\n`,
    "utf8",
  );
  await fs.writeFile(transcriptPath, staleRecord, "utf8");

  const location = await locator.locateResumeLog("claude-session-123");

  assert.equal(location.filePath, transcriptPath);
  assert.equal(location.startOffset, Buffer.byteLength(staleRecord, "utf8"));
  assert.equal(location.debug.scopedProviderHome, claudeHome);
  assert.equal(location.debug.searchedPattern, "projects/**/*.jsonl");
  assert.equal(location.debug.ignoredPreexistingCount, 0);
});

test("Claude session log locator raises a typed error when resume transcript is missing", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-resume-missing-"));
  const input = {
    workingDirectory: projectRoot,
    initialPrompt: "Start",
    initialCompletionMarker: "DONE",
    phase: {
      id: "runabc123456:intent:attempt-1",
      kind: "intent",
      attempt: 1,
    },
    async validate() {},
  };
  const claudeHome = getScopedClaudeProviderHome(input);
  const locator = createClaudeSessionLogLocator({ claudeHome });

  await assert.rejects(
    () => locator.locateResumeLog("missing-session", { timeoutMs: 5 }),
    (error) => {
      assert.ok(error instanceof ClaudeSessionLogLocatorResumeNotFoundError);
      assert.equal(error.providerSessionId, "missing-session");
      assert.equal(error.scopedProviderHome, claudeHome);
      assert.equal(error.timeoutMs, 5);
      return true;
    },
  );
});
