import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_NAME } from "./commandBundle.js";
import { createFakeBundleProcess } from "./fakeBundleProcess.js";

test("the fake Bundle Process resolves its runtime and the executables a test declares", () => {
  const fake = createFakeBundleProcess({ executables: [process.execPath] });

  assert.deepEqual(fake.resolveExecutable(RUNTIME_NAME), {
    kind: "found",
    executable: RUNTIME_NAME,
    prefixArgs: [],
  });
  assert.deepEqual(fake.resolveExecutable(process.execPath), {
    kind: "found",
    executable: process.execPath,
    prefixArgs: [],
  });
});

test("the fake Bundle Process answers not found for every undeclared executable", () => {
  const fake = createFakeBundleProcess();

  // The runner's own absolute path exists on every host, so a fall-through to the
  // real resolver would find it; undeclared, the fake must not.
  for (const name of [process.execPath, "codex", "claude", "git"]) {
    assert.deepEqual(fake.resolveExecutable(name), { kind: "not-found" }, name);
  }
});
