import assert from "node:assert/strict";
import test from "node:test";
import { resolveCommandInvocation } from "../../src/workflow/workflow.js";

test("a Command without a platform override keeps every base field", () => {
  assert.deepEqual(
    resolveCommandInvocation({
      command: {
        executable: "runner",
        arguments: ["--run", { asset: "base.sh" }, { artifact: "source" }],
        workingDirectory: "base",
        env: { SOURCE: { artifact: "source" }, SCRIPT: { asset: "base.sh" } },
      },
      platform: "linux",
    }),
    {
      executable: "runner",
      arguments: ["--run", { asset: "base.sh" }, { artifact: "source" }],
      workingDirectory: "base",
      env: { SOURCE: { artifact: "source" }, SCRIPT: { asset: "base.sh" } },
    },
  );
});

test("a partial override changes only its named fields on the selected platform", () => {
  const command = {
    executable: "runner",
    arguments: ["base"],
    workingDirectory: "base",
    env: { SOURCE: "base" },
    platforms: {
      windows: { executable: "windows-runner", workingDirectory: "windows" },
      macos: { executable: "macos-runner" },
    },
  };
  assert.deepEqual(resolveCommandInvocation({ command, platform: "windows" }), {
    executable: "windows-runner",
    arguments: ["base"],
    workingDirectory: "windows",
    env: { SOURCE: "base" },
  });
  assert.deepEqual(resolveCommandInvocation({ command, platform: "macos" }), {
    executable: "macos-runner",
    arguments: ["base"],
    workingDirectory: "base",
    env: { SOURCE: "base" },
  });
  assert.deepEqual(resolveCommandInvocation({ command, platform: "linux" }), {
    executable: "runner",
    arguments: ["base"],
    workingDirectory: "base",
    env: { SOURCE: "base" },
  });
});

test("explicitly empty arguments and environment replace reference-bearing base fields", () => {
  assert.deepEqual(
    resolveCommandInvocation({
      command: {
        executable: "runner",
        arguments: [{ asset: "base.sh" }],
        env: { SOURCE: { artifact: "source" } },
        platforms: { linux: { arguments: [], env: {} } },
      },
      platform: "linux",
    }),
    {
      executable: "runner",
      arguments: [],
      workingDirectory: undefined,
      env: {},
    },
  );
});

test("an override replaces reference-bearing arguments and environment without merging", () => {
  assert.deepEqual(
    resolveCommandInvocation({
      command: {
        executable: "runner",
        arguments: ["base", { asset: "base.sh" }, { artifact: "base-input" }],
        env: { BASE: { asset: "base.sh" }, SOURCE: { artifact: "base-input" } },
        platforms: {
          linux: {
            arguments: [
              { asset: "selected.sh" },
              { artifact: "selected-input" },
            ],
            env: { SELECTED: { asset: "selected.sh" } },
          },
        },
      },
      platform: "linux",
    }),
    {
      executable: "runner",
      arguments: [{ asset: "selected.sh" }, { artifact: "selected-input" }],
      workingDirectory: undefined,
      env: { SELECTED: { asset: "selected.sh" } },
    },
  );
});
