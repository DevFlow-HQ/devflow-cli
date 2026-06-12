import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  getScopedCodexProviderHome,
  seedCodexCredentials,
} from "../../src/adapters/codexProviderHome.js";
import type { ManagedProviderSessionInput } from "../../src/adapters/managedSessionAdapter.js";

function createInput(
  projectRoot: string,
  overrides: Partial<ManagedProviderSessionInput> = {},
): ManagedProviderSessionInput {
  return {
    workingDirectory: projectRoot,
    initialPrompt: "Start",
    initialCompletionMarker: "INITIAL_DONE",
    phase: {
      id: "runabc123456:intent:attempt-1",
      kind: "intent",
      attempt: 1,
    },
    async validate() {},
    ...overrides,
  };
}

test("Codex provider home resolves to a run-scoped CODEX_HOME", async () => {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "devflow-codex-home-"));

  assert.equal(
    getScopedCodexProviderHome(createInput(projectRoot)),
    join(projectRoot, ".devflow", "runs", "runabc123456", ".codex"),
  );
});

test("Codex credential seeding copies auth.json from explicit CODEX_HOME", async () => {
  const sourceCodexHome = await fs.mkdtemp(
    join(tmpdir(), "devflow-codex-source-"),
  );
  const scopedCodexHome = await fs.mkdtemp(
    join(tmpdir(), "devflow-codex-scoped-"),
  );
  await fs.writeJson(join(sourceCodexHome, "auth.json"), {
    refresh_token: "source-refresh-token",
  });

  await seedCodexCredentials({
    codexHome: scopedCodexHome,
    environment: { CODEX_HOME: sourceCodexHome },
  });

  assert.deepEqual(await fs.readJson(join(scopedCodexHome, "auth.json")), {
    refresh_token: "source-refresh-token",
  });
});

test("Codex credential seeding falls back to home .codex", async () => {
  const homeDirectory = await fs.mkdtemp(join(tmpdir(), "devflow-codex-home-"));
  const scopedCodexHome = await fs.mkdtemp(
    join(tmpdir(), "devflow-codex-scoped-"),
  );
  await fs.ensureDir(join(homeDirectory, ".codex"));
  await fs.writeJson(join(homeDirectory, ".codex", "auth.json"), {
    refresh_token: "home-refresh-token",
  });

  await seedCodexCredentials({
    codexHome: scopedCodexHome,
    environment: {},
    homeDirectory,
  });

  assert.deepEqual(await fs.readJson(join(scopedCodexHome, "auth.json")), {
    refresh_token: "home-refresh-token",
  });
});

test("Codex credential seeding safely no-ops when source auth is missing", async () => {
  const homeDirectory = await fs.mkdtemp(join(tmpdir(), "devflow-codex-home-"));
  const scopedCodexHome = await fs.mkdtemp(
    join(tmpdir(), "devflow-codex-scoped-"),
  );

  await seedCodexCredentials({
    codexHome: scopedCodexHome,
    environment: {},
    homeDirectory,
  });

  assert.equal(await fs.pathExists(join(scopedCodexHome, "auth.json")), false);
});

test("Codex credential seeding no-ops when source and scoped homes match", async () => {
  const scopedCodexHome = await fs.mkdtemp(
    join(tmpdir(), "devflow-codex-scoped-"),
  );
  await fs.writeJson(join(scopedCodexHome, "auth.json"), {
    refresh_token: "already-scoped-refresh-token",
  });

  await seedCodexCredentials({
    codexHome: scopedCodexHome,
    environment: { CODEX_HOME: scopedCodexHome },
  });

  assert.deepEqual(await fs.readJson(join(scopedCodexHome, "auth.json")), {
    refresh_token: "already-scoped-refresh-token",
  });
});
