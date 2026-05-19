import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InvalidRepoConfigError,
  persistRepoConfig,
  resolveRepoConfig,
} from "../src/repoConfig.js";

test("repo config is absent until explicitly persisted", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-repo-config-"));

  assert.equal(existsSync(join(projectRoot, ".devflow")), false);
  assert.equal(await resolveRepoConfig({ projectRoot }), undefined);
  assert.equal(existsSync(join(projectRoot, ".devflow")), false);
});

test("persisting repo config creates state lazily and supports later reads", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-repo-config-"));

  await persistRepoConfig({
    projectRoot,
    config: { defaultProvider: "claude" },
  });

  assert.equal(existsSync(join(projectRoot, ".devflow")), true);
  assert.deepEqual(await resolveRepoConfig({ projectRoot }), {
    defaultProvider: "claude",
  });
});

test("repo config validation rejects hand-edited unknown providers", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "devflow-repo-config-"));

  await persistRepoConfig({
    projectRoot,
    config: { defaultProvider: "gemini" },
  });

  const configPath = join(projectRoot, ".devflow", "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ defaultProvider: "nope" }, null, 2),
  );

  await assert.rejects(
    resolveRepoConfig({ projectRoot }),
    (error: unknown) =>
      error instanceof InvalidRepoConfigError &&
      error.message.includes("defaultProvider"),
  );
});
