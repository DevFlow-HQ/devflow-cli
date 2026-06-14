import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("node-pty stays pinned to the spawn-helper layout version", async () => {
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };
  const packageLock = JSON.parse(
    await readFile(join(process.cwd(), "package-lock.json"), "utf8"),
  ) as {
    packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
  };

  assert.equal(packageJson.dependencies?.["node-pty"], "1.1.0");
  assert.equal(packageLock.packages?.[""]?.dependencies?.["node-pty"], "1.1.0");
  assert.equal(packageLock.packages?.["node_modules/node-pty"]?.version, "1.1.0");
});
