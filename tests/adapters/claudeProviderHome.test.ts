import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  deleteClaudeCredentials,
  seedClaudeConfigState,
  seedClaudeCredentials,
} from "../../src/adapters/claudeProviderHome.js";

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

test("Claude credential deletion removes scoped credentials and tolerates absence", async () => {
  const scopedHome = makeTempDir("devflow-claude-scoped-");
  const target = join(scopedHome, ".credentials.json");

  await fs.writeJson(target, { token: "scoped-token" });

  await deleteClaudeCredentials({ claudeConfigDirectory: scopedHome });

  assert.equal(await fs.pathExists(target), false);

  await deleteClaudeCredentials({ claudeConfigDirectory: scopedHome });

  assert.equal(await fs.pathExists(target), false);
});

test("Claude config state seeding creates scoped onboarding and trust state from configured source", async () => {
  const scopedHome = makeTempDir("devflow-claude-scoped-");
  const sourceConfigDirectory = makeTempDir("devflow-claude-source-");
  const projectRoot = makeTempDir("devflow-project-");

  await fs.writeJson(join(sourceConfigDirectory, ".claude.json"), {
    userID: "user_123",
    oauthAccount: {
      emailAddress: "user@example.com",
      organizationRole: "admin",
    },
  });

  await seedClaudeConfigState({
    claudeConfigDirectory: scopedHome,
    environment: { CLAUDE_CONFIG_DIR: sourceConfigDirectory },
    workingDirectory: projectRoot,
  });

  assert.deepEqual(await fs.readJson(join(scopedHome, ".claude.json")), {
    hasCompletedOnboarding: true,
    shiftEnterKeyBindingInstalled: true,
    userID: "user_123",
    oauthAccount: {
      emailAddress: "user@example.com",
      organizationRole: "admin",
    },
    projects: {
      [projectRoot]: {
        hasTrustDialogAccepted: true,
      },
    },
  });
});

test("Claude config state seeding falls back to home .claude.json without CLAUDE_CONFIG_DIR", async () => {
  const scopedHome = makeTempDir("devflow-claude-scoped-");
  const sourceHome = makeTempDir("devflow-claude-home-");
  const projectRoot = makeTempDir("devflow-project-");

  await fs.writeJson(join(sourceHome, ".claude.json"), {
    userID: "home-user",
    oauthAccount: { accountUuid: "account-from-home" },
  });

  await seedClaudeConfigState({
    claudeConfigDirectory: scopedHome,
    environment: {},
    homeDirectory: sourceHome,
    workingDirectory: projectRoot,
  });

  assert.deepEqual(await fs.readJson(join(scopedHome, ".claude.json")), {
    hasCompletedOnboarding: true,
    shiftEnterKeyBindingInstalled: true,
    userID: "home-user",
    oauthAccount: { accountUuid: "account-from-home" },
    projects: {
      [projectRoot]: {
        hasTrustDialogAccepted: true,
      },
    },
  });
});

test("Claude config state seeding never overwrites existing scoped state", async () => {
  const scopedHome = makeTempDir("devflow-claude-scoped-");
  const sourceConfigDirectory = makeTempDir("devflow-claude-source-");
  const existingState = {
    hasCompletedOnboarding: false,
    projects: {
      "/previous/project": { hasTrustDialogAccepted: true },
    },
  };

  await fs.writeJson(join(scopedHome, ".claude.json"), existingState);
  await fs.writeJson(join(sourceConfigDirectory, ".claude.json"), {
    userID: "new-user",
    oauthAccount: { emailAddress: "new@example.com" },
  });

  await seedClaudeConfigState({
    claudeConfigDirectory: scopedHome,
    environment: { CLAUDE_CONFIG_DIR: sourceConfigDirectory },
    workingDirectory: "/new/project",
  });

  assert.deepEqual(
    await fs.readJson(join(scopedHome, ".claude.json")),
    existingState,
  );
});
