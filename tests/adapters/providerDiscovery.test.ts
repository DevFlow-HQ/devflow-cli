import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "fs-extra";

import {
  getBuiltInProviderIdentity,
} from "../../src/adapters/providers.js";
import {
  type ManagedSessionAdapter,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  discoverBuiltInProviders,
  type ProviderDiscoveryAdapter,
} from "../../src/adapters/providerDiscovery.js";

import { makeTempDir } from "../helpers/tempDir.js";
function createDiscoveryAdapter(
  options: ProviderDiscoveryAdapter,
): ProviderDiscoveryAdapter {
  return options;
}

test("provider discovery ignores deferred providers while summarizing supported providers", async () => {
  const detections = new Map<
    ManagedSessionAdapter["provider"]["id"],
    Awaited<ReturnType<ManagedSessionAdapter["detect"]>>
  >([
    ["claude", { isAvailable: false, reason: "claude missing" }],
    ["gemini", { isAvailable: true, executable: "/usr/local/bin/gemini" }],
    ["codex", { isAvailable: false, reason: "codex missing" }],
    ["opencode", { isAvailable: false, reason: "opencode missing" }],
  ]);

  const detectedProviderIds: ManagedSessionAdapter["provider"]["id"][] = [];

  const result = await discoverBuiltInProviders({
    createAdapter(providerId) {
      detectedProviderIds.push(providerId);

      return createDiscoveryAdapter({
        provider: getBuiltInProviderIdentity(providerId),
        async detect() {
          const detection = detections.get(providerId);

          if (!detection) {
            throw new Error(`Missing test detection for ${providerId}`);
          }

          return detection;
        },
      });
    },
  });

  assert.deepEqual(detectedProviderIds, ["claude", "codex"]);
  assert.deepEqual(
    result.providers.map((provider) => ({
      id: provider.provider.id,
      isAvailable: provider.isAvailable,
    })),
    [
      { id: "claude", isAvailable: false },
      { id: "codex", isAvailable: false },
    ],
  );

  assert.deepEqual(
    result.installedProviders.map((provider) => provider.provider.id),
    [],
  );

  assert.deepEqual(result.summary, {
    availabilityStatus: "none",
    installedProviderCount: 0,
  });
});

test("provider discovery summarizes zero and multiple installed-provider cases without a recommendation", async () => {
  const unavailableResult = await discoverBuiltInProviders({
    createAdapter(providerId) {
      return createDiscoveryAdapter({
        provider: getBuiltInProviderIdentity(providerId),
        async detect() {
          return {
            isAvailable: false,
            reason: `${providerId} missing`,
          };
        },
      });
    },
  });

  assert.deepEqual(unavailableResult.installedProviders, []);
  assert.deepEqual(unavailableResult.summary, {
    availabilityStatus: "none",
    installedProviderCount: 0,
  });

  const multipleResult = await discoverBuiltInProviders({
    createAdapter(providerId) {
      return createDiscoveryAdapter({
        provider: getBuiltInProviderIdentity(providerId),
        async detect() {
          if (providerId === "claude" || providerId === "codex") {
            return {
              isAvailable: true,
              executable: `/opt/${providerId}`,
            };
          }

          return {
            isAvailable: false,
            reason: `${providerId} missing`,
          };
        },
      });
    },
  });

  assert.deepEqual(
    multipleResult.installedProviders.map((provider) => provider.provider.id),
    ["claude", "codex"],
  );
  assert.deepEqual(multipleResult.summary, {
    availabilityStatus: "multiple",
    installedProviderCount: 2,
  });
  assert.equal("recommendedProviderId" in multipleResult.summary, false);
});

test("provider discovery defaults to the production built-in adapter factory", async (t) => {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = makeTempDir("devflow-discovery-");
  const binDir = path.join(tempRoot, "bin");
  const executablePath = path.join(binDir, "codex");

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);

  process.env.PATH = binDir;

  const result = await discoverBuiltInProviders();

  assert.deepEqual(
    result.installedProviders.map((provider) => provider.provider.id),
    ["codex"],
  );
  assert.deepEqual(result.summary, {
    availabilityStatus: "single",
    installedProviderCount: 1,
    recommendedProviderId: "codex",
  });
  assert.equal(result.installedProviders[0]?.executable, executablePath);
});

test("provider discovery degrades unsupported and failed providers into user-safe unavailable results", async () => {
  const result = await discoverBuiltInProviders({
    createAdapter(providerId) {
      return createDiscoveryAdapter({
        provider: getBuiltInProviderIdentity(providerId),
        async detect() {
          if (providerId === "claude") {
            return {
              isAvailable: true,
              executable: "/usr/local/bin/claude",
            };
          }

          if (providerId === "codex") {
            throw new Error("spawn ENOENT while probing codex internals");
          }

          throw new Error(`Unexpected provider probed: ${providerId}`);
        },
      });
    },
  });

  assert.deepEqual(result.providers, [
    {
      provider: getBuiltInProviderIdentity("claude"),
      isAvailable: true,
      executable: "/usr/local/bin/claude",
    },
    {
      provider: getBuiltInProviderIdentity("codex"),
      isAvailable: false,
      reason: "This provider is currently unavailable.",
      debugReason: "spawn ENOENT while probing codex internals",
    },
  ]);

  assert.deepEqual(
    result.installedProviders.map((provider) => provider.provider.id),
    ["claude"],
  );
  assert.deepEqual(result.summary, {
    availabilityStatus: "single",
    installedProviderCount: 1,
    recommendedProviderId: "claude",
  });
  assert.equal("debugReason" in result.installedProviders[0], false);
});
