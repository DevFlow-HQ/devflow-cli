import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type { ProjectionPort } from "../../src/application/projection-port.js";
import type { HarnessAdapter } from "../../src/harness/harness.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MATT_FOLDER = join(repoRoot, "bundles", "matt-front-spec");

export function wireMatt(
  t: TestContext,
  options: {
    readonly harness: "claude-code" | "codex";
    readonly adapter: HarnessAdapter;
    readonly supportsInteractiveTurns?: boolean;
    readonly bundle?: "current" | "historical-2.7.0";
  },
): { wired: Wiring; workspace: string; digest: string } {
  const workspace = makeTempDir("secant-matt-ws-");
  const found = (name: string) => () => ({
    kind: "found" as const,
    attempt: {
      source: "path" as const,
      name,
      description: `PATH name '${name}'`,
    },
  });
  const wired = wireApplication({
    secantHome: makeTempDir("secant-matt-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: options.supportsInteractiveTurns ?? true,
    process: createFakeBundleProcess(),
    discoverClaudeCode: found("claude"),
    discoverCodex: found("codex"),
    ...(options.harness === "codex"
      ? { codexHarnessAdapter: options.adapter }
      : { harnessAdapter: options.adapter }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const installed =
    options.bundle === "historical-2.7.0"
      ? wired.bundleManagement.install(
          join(repoRoot, "tests", "application", "fixtures", "matt-2.7.0.wfb"),
        )
      : wired.bundleManagement.build(MATT_FOLDER, { noInstall: false });
  assert.ok(installed.ok, JSON.stringify(installed));
  const entry = wired.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.matt-front");
  assert.ok(entry);
  const port: ProjectionPort = wired.projectionPort;
  const approval = port.submit({
    operationId: "op-approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approval.admitted, JSON.stringify(approval));
  return { wired, workspace, digest: entry.digest };
}
