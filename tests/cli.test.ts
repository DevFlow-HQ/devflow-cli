import assert from "node:assert/strict";
import test from "node:test";

import { Command, CommanderError } from "commander";

import { runCli } from "../src/cli.js";

function createWritableBuffer() {
  let output = "";

  return {
    write(chunk: string) {
      output += chunk;
    },
    read() {
      return output;
    },
  };
}

async function invokeCli(argv: string[]) {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const resolvedTasks: string[] = [];

  let commandError: CommanderError | undefined;

  try {
    await runCli(argv, {
      stdout,
      stderr,
      onResolvedTask(rawTask) {
        resolvedTasks.push(rawTask);
      },
      configureProgram(program) {
        program.exitOverride();
      },
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      commandError = error;
    } else {
      throw error;
    }
  }

  return {
    commandError,
    resolvedTasks,
    stdout: stdout.read(),
    stderr: stderr.read(),
  };
}

test("cli joins trailing positional arguments into a single raw task", async () => {
  const result = await invokeCli(["add", "dark", "mode"]);

  assert.equal(result.commandError, undefined);
  assert.deepEqual(result.resolvedTasks, ["add dark mode"]);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("cli trims the resolved raw task without normalizing internal spacing", async () => {
  const result = await invokeCli(["  audit", "   provider", "flow  "]);

  assert.equal(result.commandError, undefined);
  assert.deepEqual(result.resolvedTasks, ["audit    provider flow"]);
});

test("cli rejects missing task input with one clear user-facing error", async () => {
  const result = await invokeCli([]);

  assert.equal(result.resolvedTasks.length, 0);
  assert.equal(result.commandError?.code, "commander.error");
  assert.match(result.stderr, /A task is required\./);
});

test("cli rejects whitespace-only task input with one clear user-facing error", async () => {
  const result = await invokeCli(["   "]);

  assert.equal(result.resolvedTasks.length, 0);
  assert.equal(result.commandError?.code, "commander.error");
  assert.match(result.stderr, /A task is required\./);
});

test("cli preserves commander-owned help output", async () => {
  const result = await invokeCli(["--help"]);

  assert.equal(result.resolvedTasks.length, 0);
  assert.equal(result.commandError?.code, undefined);
  assert.match(result.stdout, /Usage: devflow \[options\] \[taskParts\.\.\.\]/);
  assert.match(result.stdout, /--help/);
  assert.equal(result.stderr, "");
});

test("cli preserves commander-owned version output", async () => {
  const result = await invokeCli(["--version"]);

  assert.equal(result.resolvedTasks.length, 0);
  assert.equal(result.commandError?.code, undefined);
  assert.equal(result.stdout.trim(), "0.1.0");
  assert.equal(result.stderr, "");
});
