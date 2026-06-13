import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import test from "node:test";

import { cleanupTempDirsForTest, makeTempDir } from "./tempDir.js";

test("makeTempDir creates temp directories under the OS temp directory", () => {
  const directory = makeTempDir("devflow-temp-helper-");

  assert.equal(dirname(directory), tmpdir());
  assert.equal(existsSync(directory), true);
});

test("registered temp directories are removed when cleanup runs", async () => {
  const directory = makeTempDir("devflow-temp-helper-cleanup-");

  await cleanupTempDirsForTest();

  assert.equal(existsSync(directory), false);
});
