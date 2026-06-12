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

const providerDataPlanePaths = [
  "src/adapters/claudeHookEventSource.ts",
  "src/adapters/codexHookEventSource.ts",
  "src/adapters/claudeJsonlEventSource.ts",
  "src/adapters/codexJsonlEventSource.ts",
  "src/adapters/phaseManager.ts",
];

test("structured PTY runners leave terminal-control defaults inside the harness", async () => {
  for (const runnerPath of structuredRunnerPaths) {
    const source = await readSource(runnerPath);

    assert.doesNotMatch(
      source,
      /nodePtySpawner|process\.stdin|process\.stdout/,
      `${runnerPath} should pass harness overrides only`,
    );
  }
});

test("structured PTY runners delegate completed-session cleanup to harness shutdown", async () => {
  for (const runnerPath of structuredRunnerPaths) {
    const source = await readSource(runnerPath);
    const shutdownCalls =
      source.match(
        /\.shutdown\(\{[\s\S]*?command: command\.gracefulExitCommand,[\s\S]*?timeoutMs: cleanupTimeoutMs,[\s\S]*?\}\)/g,
      ) ?? [];

    assert.equal(
      shutdownCalls.length,
      2,
      `${runnerPath} should use harness.shutdown for success and failure cleanup`,
    );
    assert.doesNotMatch(
      source,
      /harness\.kill\(|harness\.write\(command\.gracefulExitCommand|\.kill\(\)|waitForExit/,
      `${runnerPath} should not re-implement graceful-write/force-kill cleanup`,
    );
  }
});

test("graceful-then-force cleanup lives in the PTY control harness", async () => {
  const source = await readSource("src/adapters/ptyControlHarness.ts");

  assert.match(source, /DEFAULT_GRACEFUL_EXIT_SUBMIT_DELAY_MS = 100/);
  assert.match(
    source,
    /writer\.write\(command\.text\)[\s\S]*delay\(command\.submitDelayMs \?\? DEFAULT_GRACEFUL_EXIT_SUBMIT_DELAY_MS\)[\s\S]*writer\.write\(command\.submitKey\)/,
  );
  assert.match(
    source,
    /async shutdown\(\{ command, timeoutMs \}\) \{[\s\S]*submitGracefulExitCommand\(processHandle, command\)[\s\S]*waitForExit[\s\S]*processHandle\.kill\(\)[\s\S]*return \{ forced: true \};/,
  );
});

test("provider event data planes and marker finalization stay cleanup-policy free", async () => {
  for (const dataPlanePath of providerDataPlanePaths) {
    const source = await readSource(dataPlanePath);

    assert.doesNotMatch(
      source,
      /gracefulExitCommand|cleanupTimeoutMs|ProviderSessionCleanupError|harness\.shutdown|\/exit\\n|\/quit\\r|force-kill|force kill/i,
      `${dataPlanePath} should not contain completed-session cleanup policy`,
    );
  }
});

test("ADR and glossary document graceful completed-session cleanup", async () => {
  const adr = await readSource(
    "docs/adr/0014-graceful-completed-session-cleanup-for-structured-runners.md",
  );
  const context = await readSource("CONTEXT.md");

  assert.match(adr, /Claude.*\/exit/);
  assert.match(adr, /Codex.*\/quit/);
  assert.match(context, /\*\*Graceful exit command\*\*/);
  assert.match(context, /\*\*Completed-session cleanup\*\*/);
});

async function readSource(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), "utf8");
}
