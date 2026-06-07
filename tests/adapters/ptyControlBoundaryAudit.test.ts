import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const structuredRunnerPaths = [
  "src/adapters/claudeHookDrivenSessionRunner.ts",
  "src/adapters/codexHookDrivenSessionRunner.ts",
  "src/adapters/claudeJsonlSessionRunner.ts",
  "src/adapters/codexJsonlSessionRunner.ts",
];

test("structured PTY runners leave terminal-control defaults inside the harness", async () => {
  for (const runnerPath of structuredRunnerPaths) {
    const source = await readFile(join(process.cwd(), runnerPath), "utf8");

    assert.doesNotMatch(
      source,
      /nodePtySpawner|process\.stdin|process\.stdout/,
      `${runnerPath} should pass harness overrides only`,
    );
  }
});
