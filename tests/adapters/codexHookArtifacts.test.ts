import assert from "node:assert/strict";
import test from "node:test";

import {
  codexHookConfigToml,
  codexHookScript,
} from "../../src/adapters/codexHookArtifacts.js";

test("codex hook config wires lifecycle events to the hook script", () => {
  const hookScriptPath = "/tmp/devflow run/.codex/hook.js";

  const config = codexHookConfigToml({ hookScriptPath });

  assert.match(config, /\[hooks\]/);
  assert.match(config, /SessionStart = \[/);
  assert.match(config, /UserPromptSubmit = \[/);
  assert.match(config, /Stop = \[/);
  assert.match(config, /type = "command"/);
  assert.match(config, /command = "node '\/tmp\/devflow run\/\.codex\/hook\.js'"/);
});

test("codex hook config is deterministic for the same inputs", () => {
  const input = { hookScriptPath: "/tmp/devflow/.codex/hook.js" };

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
