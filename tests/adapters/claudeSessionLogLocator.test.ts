import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  ClaudeSessionLogLocatorResumeNotFoundError,
  createClaudeSessionLogLocator,
  getScopedClaudeProviderHome,
  locateClaudeSessionLogForProvider,
} from "../../src/adapters/claudeSessionLogLocator.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";
import type { LogContext, Logger } from "../../src/logger.js";

import { makeTempDir } from "../helpers/tempDir.js";
class SpyLogger implements Logger {
  readonly debugEntries: Array<{ msg: string; context?: LogContext }> = [];

  debug(msg: string, context?: LogContext): void {
    this.debugEntries.push({ msg, context });
  }

  info(): void {}
  warn(): void {}
  error(): void {}
  critical(): string {
    return "err_spy";
  }
}

test("Claude session log locator discovers a newly created scoped transcript", async () => {
  const projectRoot = makeTempDir("devflow-claude-locator-");
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
  const projectRoot = makeTempDir("devflow-claude-resume-locator-");
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

test("Claude session log locator traces resume resolution metadata", async () => {
  const projectRoot = makeTempDir("devflow-claude-resume-locator-");
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
  const logger = new SpyLogger();
  const locator = createClaudeSessionLogLocator({ claudeHome, logger });
  const transcriptPath = join(
    claudeHome,
    "projects",
    "-current-cwd",
    "session-current.jsonl",
  );
  const transcriptContent = `${JSON.stringify({
    type: "assistant",
    sessionId: "claude-session-123",
  })}\n`;

  await fs.ensureDir(join(claudeHome, "projects", "-current-cwd"));
  await fs.writeFile(transcriptPath, transcriptContent, "utf8");

  await locator.locateResumeLog("claude-session-123");

  assert.equal(logger.debugEntries.length, 1);
  assert.equal(logger.debugEntries[0].msg, "adapter session log locator resolved");
  assert.deepEqual(logger.debugEntries[0].context?.context, {
    providerId: "claude",
    resolvedPath: transcriptPath,
    startOffset: Buffer.byteLength(transcriptContent, "utf8"),
    chosenCandidate: transcriptPath,
    candidateCount: 1,
    multipleCandidates: false,
    resumeLookup: "found",
  });
});

test("Claude session log locator raises a typed error when resume transcript is missing", async () => {
  const projectRoot = makeTempDir("devflow-claude-resume-missing-");
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
