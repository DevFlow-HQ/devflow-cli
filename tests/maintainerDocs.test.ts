import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("maintainer context records JSONL rollout constraints for future providers", async () => {
  const context = await readFile(join(repoRoot, "CONTEXT.md"), "utf8");

  assert.match(context, /Claude Code/);
  assert.match(context, /next required JSONL provider after Codex/);
  assert.match(context, /hook-independent (session )?log discovery/);
  assert.match(context, /must not rely on hook `transcript_path`/);
  assert.match(context, /global directory guessing/);
  assert.match(context, /hooks primary, JSONL structured fallback, PTY bottom fallback/);
});

test("maintainer context documents the structured grill transcript contract", async () => {
  const context = await readFile(join(repoRoot, "CONTEXT.md"), "utf8");

  assert.match(context, /structured grill transcript contract/i);
  assert.match(context, /adapters own provider-specific event normalization/i);
  assert.match(context, /orchestration owns grill transcript artifact policy/i);
  assert.match(context, /turn-completed\.assistantMessage/);
  assert.match(context, /submitted-user-message/);
  assert.match(context, /origin metadata/);
  assert.match(context, /unknown-origin submitted user messages are excluded/i);
  assert.match(context, /PTY fallback behavior remains available/i);
  assert.match(context, /ProviderSessionEventCaptureError/);
  assert.match(context, /ProviderSessionTranscriptCaptureError/);
});
