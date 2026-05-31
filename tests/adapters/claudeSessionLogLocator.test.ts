import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import fs from "fs-extra";

import {
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
