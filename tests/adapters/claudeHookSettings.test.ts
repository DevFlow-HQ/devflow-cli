import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  cleanupClaudeHookSettings,
  ClaudeHookSettingsError,
  installClaudeHookSettings,
} from "../../src/adapters/claudeHookSettings.js";

test("claude hook settings setup writes only project-local local settings", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-settings-"));
  const hookScriptPath = join(projectRoot, ".devflow", "runs", "run-1", ".claude", "hook.js");

  await installClaudeHookSettings({ projectRoot, hookScriptPath });

  assert.equal(await fs.pathExists(join(projectRoot, ".claude", "settings.local.json")), true);
  assert.equal(await fs.pathExists(join(projectRoot, ".claude", "settings.json")), false);
});

test("claude hook settings setup preserves settings and appends DevFlow hooks", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-settings-"));
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  const userStopHook = {
    hooks: [{ type: "command", command: "node user-stop.js" }],
  };

  await fs.outputJson(
    settingsPath,
    {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        Stop: [userStopHook],
      },
    },
    { spaces: 2 },
  );

  await installClaudeHookSettings({
    projectRoot,
    hookScriptPath: "/tmp/devflow run/.claude/hook.js",
  });

  const settings = await fs.readJson(settingsPath);
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.Stop.length, 2);
  assert.deepEqual(settings.hooks.Stop[0], userStopHook);
  assert.deepEqual(settings.hooks.SessionStart[0], {
    matcher: "startup",
    hooks: [
      {
        type: "command",
        command: "node '/tmp/devflow run/.claude/hook.js'",
      },
    ],
  });
});

test("claude hook settings cleanup removes only matching DevFlow command hooks", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-settings-"));
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  const hookScriptPath = "/tmp/devflow/.claude/hook.js";
  const otherDevFlowScriptPath = "/tmp/devflow-other/.claude/hook.js";

  await installClaudeHookSettings({ projectRoot, hookScriptPath });
  await installClaudeHookSettings({
    projectRoot,
    hookScriptPath: otherDevFlowScriptPath,
  });

  const userHook = {
    hooks: [{ type: "command", command: "node user-stop.js" }],
  };
  const settings = await fs.readJson(settingsPath);
  settings.hooks.Stop.unshift(userHook);
  await fs.writeJson(settingsPath, settings, { spaces: 2 });

  await cleanupClaudeHookSettings({
    projectRoot,
    hookScriptPath,
    deleteIfEmptyAndCreatedByDevFlow: false,
  });

  const cleaned = await fs.readJson(settingsPath);
  assert.equal(cleaned.hooks.SessionStart.length, 1);
  assert.equal(cleaned.hooks.UserPromptSubmit.length, 1);
  assert.equal(cleaned.hooks.Stop.length, 2);
  assert.deepEqual(cleaned.hooks.Stop[0], userHook);
  assert.match(
    cleaned.hooks.Stop[1].hooks[0].command,
    /devflow-other\/\.claude\/hook\.js/,
  );
});

test("claude hook settings cleanup preserves user commands sharing a matcher entry", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-settings-"));
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  const hookScriptPath = "/tmp/devflow/.claude/hook.js";

  await fs.outputJson(
    settingsPath,
    {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "node '/tmp/devflow/.claude/hook.js'",
              },
              {
                type: "command",
                command: "node user-stop.js",
              },
            ],
          },
        ],
      },
    },
    { spaces: 2 },
  );

  await cleanupClaudeHookSettings({
    projectRoot,
    hookScriptPath,
    deleteIfEmptyAndCreatedByDevFlow: false,
  });

  const cleaned = await fs.readJson(settingsPath);
  assert.deepEqual(cleaned.hooks.Stop, [
    {
      hooks: [
        {
          type: "command",
          command: "node user-stop.js",
        },
      ],
    },
  ]);
});

test("claude hook settings cleanup deletes empty DevFlow-created local settings file", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-settings-"));
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  const hookScriptPath = "/tmp/devflow/.claude/hook.js";

  await installClaudeHookSettings({ projectRoot, hookScriptPath });
  await cleanupClaudeHookSettings({
    projectRoot,
    hookScriptPath,
    deleteIfEmptyAndCreatedByDevFlow: true,
  });

  assert.equal(await fs.pathExists(settingsPath), false);
});

test("claude hook settings cleanup preserves non-empty user settings", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-settings-"));
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  const hookScriptPath = "/tmp/devflow/.claude/hook.js";

  await fs.outputJson(settingsPath, { env: { NODE_ENV: "test" } }, { spaces: 2 });
  await installClaudeHookSettings({ projectRoot, hookScriptPath });
  await cleanupClaudeHookSettings({
    projectRoot,
    hookScriptPath,
    deleteIfEmptyAndCreatedByDevFlow: false,
  });

  assert.deepEqual(await fs.readJson(settingsPath), { env: { NODE_ENV: "test" } });
});

test("claude hook settings setup fails clearly on malformed local settings JSON", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-claude-settings-"));
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");

  await fs.outputFile(settingsPath, '{"hooks":');

  await assert.rejects(
    installClaudeHookSettings({
      projectRoot,
      hookScriptPath: "/tmp/devflow/.claude/hook.js",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeHookSettingsError);
      assert.match(error.message, /Could not read Claude local settings/);
      assert.match(error.message, /\.claude\/settings\.local\.json/);
      return true;
    },
  );
});
