import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("maintainer context records JSONL rollout constraints for future providers", async () => {
  const adr = await readFile(
    join(
      repoRoot,
      "docs",
      "adr",
      "0002-keep-pty-control-with-structured-event-source-fallbacks.md",
    ),
    "utf8",
  );

  assert.match(adr, /Claude Code/);
  assert.match(adr, /next required JSONL provider after Codex/);
  assert.match(adr, /hook-independent (session )?log discovery/);
  assert.match(adr, /must not rely on hook `transcript_path`/);
  assert.match(adr, /global directory guessing/);
  assert.match(adr, /hooks/);
  assert.match(adr, /JSONL/);
  assert.match(adr, /PTY/);
});

test("maintainer context documents the structured grill transcript contract", async () => {
  const context = await readFile(join(repoRoot, "CONTEXT.md"), "utf8");
  const adr = await readFile(
    join(
      repoRoot,
      "docs",
      "adr",
      "0004-keep-structured-grill-transcript-policy-in-orchestration.md",
    ),
    "utf8",
  );

  assert.match(context, /structured grill transcript contract/i);
  assert.match(adr, /Adapters should own provider-specific event normalization/i);
  assert.match(adr, /orchestration owns the durable grill transcript artifact policy/i);
  assert.match(adr, /turn-completed\.assistantMessage/);
  assert.match(adr, /submitted-user-message/);
  assert.match(adr, /origin-bearing/);
  assert.match(adr, /unknown-origin messages are excluded/i);
  assert.match(adr, /PTY fallback behavior remains available/i);
  assert.match(adr, /ProviderSessionEventCaptureError/);
  assert.match(adr, /ProviderSessionTranscriptCaptureError/);
});

test("maintainer context defines completion marker and grill conclusion confirmation language", async () => {
  const context = await readFile(join(repoRoot, "CONTEXT.md"), "utf8");

  assert.match(context, /\*\*Completion marker\*\*/);
  assert.match(context, /single\*? authoritative .*done.* signal/i);
  assert.match(context, /omitting it leaves the stage unable to advance/i);
  assert.match(context, /emitting it prematurely yields no further turns/i);

  assert.match(context, /\*\*Grill conclusion confirmation\*\*/);
  assert.match(context, /ask the user/i);
  assert.match(context, /remaining questions or concerns/i);
  assert.match(context, /provider-prompt-level/i);
  assert.match(context, /DevFlow still observes only the marker/i);
  assert.match(context, /does not programmatically validate/i);
});

test("end-user README documents the current supported invocation honestly", async () => {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /early/i);
  assert.match(readme, /experimental/i);
  assert.match(readme, /Claude/);
  assert.match(readme, /Codex/);
  assert.doesNotMatch(readme, /Gemini/);
  assert.doesNotMatch(readme, /OpenCode/);
  assert.match(readme, /git clone https:\/\/github\.com\/DevFlow-HQ\/devflow-cli\.git/);
  assert.match(readme, /npm install/);
  assert.match(readme, /npm run build/);
  assert.match(readme, /npm link/);
  assert.match(readme, /npm install -g devflow-cli/);
  assert.match(readme, /not yet on npm/i);
  assert.match(readme, /command.*`devflow`/i);
  assert.match(readme, /devflow "add dark mode"/);
  assert.match(readme, /\[CONTEXT\.md\]\(\.\/CONTEXT\.md\)/);
});
