import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import { seedClaudeCredentials } from "../../src/adapters/claudeProviderHome.js";

import { makeTempDir } from "../helpers/tempDir.js";

test("Claude credential seeding writes macOS Keychain credential verbatim with private mode", async () => {
  const scopedHome = makeTempDir("devflow-claude-scoped-");
  const credential = '{"claudeAiOauth":{"accessToken":"secret"}}';

  await seedClaudeCredentials({
    claudeConfigDirectory: scopedHome,
    environment: {},
    platform: "darwin",
    readMacosKeychainCredential: async () => credential,
  });

  const target = join(scopedHome, ".credentials.json");
  assert.equal(await fs.readFile(target, "utf8"), credential);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

test("Claude credential seeding writes nothing on macOS without a Keychain credential", async () => {
  const scopedHome = makeTempDir("devflow-claude-scoped-");

  await seedClaudeCredentials({
    claudeConfigDirectory: scopedHome,
    environment: {},
    platform: "darwin",
    readMacosKeychainCredential: async () => null,
  });

  assert.equal(
    await fs.pathExists(join(scopedHome, ".credentials.json")),
    false,
  );
});

test("Claude credential seeding still copies source credentials off macOS", async () => {
  const scopedHome = makeTempDir("devflow-claude-scoped-");
  const sourceHome = makeTempDir("devflow-claude-source-");

  await fs.writeJson(join(sourceHome, ".credentials.json"), {
    token: "source-token",
  });

  await seedClaudeCredentials({
    claudeConfigDirectory: scopedHome,
    environment: { CLAUDE_CONFIG_DIR: sourceHome },
    platform: "linux",
  });

  assert.deepEqual(await fs.readJson(join(scopedHome, ".credentials.json")), {
    token: "source-token",
  });
});
