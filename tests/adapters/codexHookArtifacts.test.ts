import assert from "node:assert/strict";
import test from "node:test";

import {
  codexHookConfigToml,
  codexHookScript,
  codexTrustedProjectToml,
} from "../../src/adapters/codexHookArtifacts.js";

test("codex trusted project block quotes the working directory as TOML", () => {
  const config = codexTrustedProjectToml('/tmp/devflow "trusted"\\repo');

  assert.equal(
    config,
    [
      '[projects."/tmp/devflow \\"trusted\\"\\\\repo"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );
});

test("codex hook config merges project trust with hook definitions", () => {
  const hookScriptPath = "/tmp/devflow run/.codex/hook.js";
  const workingDirectory = "/tmp/devflow repo";

  const config = codexHookConfigToml({ hookScriptPath, workingDirectory });

  assert.match(config, /^\[projects\."\/tmp\/devflow repo"\]$/m);
  assert.match(config, /^trust_level = "trusted"$/m);
  assert.match(config, /^\[hooks\]$/m);
  assert.match(config, /SessionStart = \[/);
  assert.match(config, /UserPromptSubmit = \[/);
  assert.match(config, /Stop = \[/);
});

test("codex hook config wires lifecycle events to the hook script", () => {
  const hookScriptPath = "/tmp/devflow run/.codex/hook.js";

  const config = codexHookConfigToml({
    hookScriptPath,
    workingDirectory: "/tmp/devflow repo",
  });

  assert.match(config, /\[hooks\]/);
  assert.match(config, /SessionStart = \[/);
  assert.match(config, /UserPromptSubmit = \[/);
  assert.match(config, /Stop = \[/);
  assert.match(config, /type = "command"/);
  assert.match(config, /command = "node '\/tmp\/devflow run\/\.codex\/hook\.js'"/);
});

test("codex hook config is deterministic for the same inputs", () => {
  const input = {
    hookScriptPath: "/tmp/devflow/.codex/hook.js",
    workingDirectory: "/tmp/devflow repo",
  };

  assert.equal(codexHookConfigToml(input), codexHookConfigToml(input));
});

test("codex hook script reads stdin and forwards JSON to the configured IPC socket", () => {
  const script = codexHookScript();

  assert.match(script, /process\.stdin/);
  assert.match(script, /JSON\.parse/);
  assert.match(script, /DEVFLOW_HOOK_IPC_PATH/);
  assert.match(script, /net\.createConnection/);
  assert.match(script, /JSON\.stringify\(payload\)/);
  assert.match(script, /socket\.end\(payload\)/);
  assert.match(script, /process\.exitCode = 1/);
});

test("codex hook script is deterministic", () => {
  assert.equal(codexHookScript(), codexHookScript());
});
