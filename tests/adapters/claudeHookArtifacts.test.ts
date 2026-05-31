import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  claudeHookScript,
  createClaudeHookArtifacts,
} from "../../src/adapters/claudeHookArtifacts.js";
import { installClaudeHookSettings } from "../../src/adapters/claudeHookSettings.js";

test("claude hook artifacts create a run-scoped executable forwarding script", async () => {
  const runDirectory = await fs.mkdtemp(join(tmpdir(), "devflow-claude-run-"));
  const hookDirectory = join(runDirectory, ".claude-hooks");

  const artifacts = await createClaudeHookArtifacts({ hookDirectory });

  assert.deepEqual(artifacts, {
    hookDirectory,
    hookScriptPath: join(hookDirectory, "hook.js"),
    socketPath: join(hookDirectory, "hook.sock"),
  });
  assert.equal(await fs.readFile(artifacts.hookScriptPath, "utf8"), claudeHookScript());
  assert.equal((await fs.stat(artifacts.hookScriptPath)).mode & 0o777, 0o755);
});

test("claude hook artifacts are compatible with project-local settings entries", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-project-"));
  const runDirectory = join(projectRoot, ".devflow", "runs", "run-1");
  const artifacts = await createClaudeHookArtifacts({
    hookDirectory: join(runDirectory, ".claude-hooks"),
  });

  await installClaudeHookSettings({
    projectRoot,
    hookScriptPath: artifacts.hookScriptPath,
  });

  const settings = await fs.readJson(
    join(projectRoot, ".claude", "settings.local.json"),
  );
  assert.deepEqual(settings.hooks.SessionStart[0], {
    matcher: "startup",
    hooks: [
      {
        type: "command",
        command: `node '${artifacts.hookScriptPath}'`,
      },
    ],
  });
  assert.deepEqual(settings.hooks.UserPromptSubmit[0], {
    hooks: [
      {
        type: "command",
        command: `node '${artifacts.hookScriptPath}'`,
      },
    ],
  });
  assert.deepEqual(settings.hooks.Stop[0], {
    hooks: [
      {
        type: "command",
        command: `node '${artifacts.hookScriptPath}'`,
      },
    ],
  });
});

test("claude hook script reads stdin and forwards JSON to the configured IPC socket", () => {
  const script = claudeHookScript();

  assert.match(script, /process\.stdin/);
  assert.match(script, /JSON\.parse/);
  assert.match(script, /DEVFLOW_HOOK_IPC_PATH/);
  assert.match(script, /net\.createConnection/);
  assert.match(script, /JSON\.stringify\(payload\)/);
  assert.match(script, /socket\.end\(payload\)/);
  assert.match(script, /process\.exitCode = 1/);
});

test("claude hook script is deterministic", () => {
  assert.equal(claudeHookScript(), claudeHookScript());
});
