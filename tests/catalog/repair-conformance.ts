import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  DEFAULT_BUDGETS,
  buildBundle,
  readBundleAssets,
  type ZipEntry,
} from "../../src/bundle/bundle.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import {
  createProcessAdapter,
  type ProcessAdapter,
} from "../../src/process/process.js";
import { collectText, observeOutput } from "../helpers/childOutput.js";
import { stage, withRunnerObserver } from "../helpers/standalone.js";
import { makeTempDir } from "../helpers/tempDir.js";

// Concurrent asset-tree repair across real processes (#380). Two workers over
// one home each find an installed digest's tree incomplete and park before
// repairing; the parent releases one to completion and then the other. Both must
// return a completed, readable tree, and the waiting one must reuse the tree the
// first published rather than rebuild it. A last worker parks while its repair
// holds installation coordination, and another connection must be refused it.

const REPAIR_WORKER = fileURLToPath(
  new URL("./asset-repair-worker.ts", import.meta.url),
);
const MATT_FRONT_SPEC = fileURLToPath(
  new URL("../../bundles/matt-front-spec", import.meta.url),
);
// An undeclared file the parent drops into the first published tree: it survives
// only if the waiting repair reuses that tree.
const PUBLISHED_MARKER = "published-by-first-repair";
// The worker's barriers read one byte of stdin; its value carries nothing.
const RESUME = new Uint8Array([1]);

export function registerCatalogRepairConformance(
  register: (name: string, body: () => Promise<void>) => void,
): void {
  register("catalog-concurrent-asset-repair", async () => {
    await overlappingRepairs("missing");
    await overlappingRepairs("truncated");
    await repairHoldsCoordination();
  });
}

type TDamagedInstall = {
  readonly home: string;
  readonly digest: string;
  readonly declared: readonly ZipEntry[];
  readonly processAdapter: ProcessAdapter;
};

function installDamaged(damage: "missing" | "truncated"): TDamagedInstall {
  const built = buildBundle(MATT_FRONT_SPEC);
  assert.ok(built.ok, "the Matt front Bundle did not build");
  const { bytes, digest, identity } = built.built;
  // The Bundle Module's reading of the archive is the independent declaration of
  // what every returned tree must hold.
  const declared = readBundleAssets(bytes, DEFAULT_BUDGETS);
  assert.ok(declared !== undefined && declared.length > 0);
  const home = makeTempDir("secant-runtime-repair-");
  return stage(`install and damage the ${damage} tree`, () => {
    const catalog = openCatalog(home, {
      readAssets: (archive) => readBundleAssets(archive, DEFAULT_BUDGETS),
    });
    try {
      const installed = catalog.installBundle({
        identity,
        digest,
        bytes,
        origin: { kind: "local-build", folder: MATT_FRONT_SPEC },
        installedAt: new Date("2026-10-05T00:00:00.000Z"),
      });
      assert.equal(installed.outcome, "installed");
      const root = catalog.assetRoot(digest);
      assert.ok(root !== undefined);
      if (damage === "missing") {
        rmSync(root, { recursive: true, force: true });
      } else {
        const asset = declared.find((entry) => entry.data.length > 0);
        assert.ok(asset !== undefined);
        chmodSync(join(root, asset.path), 0o644);
        writeFileSync(join(root, asset.path), "");
      }
    } finally {
      catalog.close();
    }
    return {
      home,
      digest,
      declared,
      processAdapter: createProcessAdapter(withRunnerObserver()),
    };
  });
}

async function overlappingRepairs(damage: "missing" | "truncated") {
  const install = installDamaged(damage);
  const first = await stage(`park the first ${damage} repair`, () =>
    parkedRepairWorker(install, "overlap"),
  );
  const second = await stage(`park the waiting ${damage} repair`, () =>
    parkedRepairWorker(install, "overlap"),
  );
  const firstRoot = await stage(`publish the first ${damage} repair`, () =>
    first.release(),
  );
  writeFileSync(join(firstRoot, PUBLISHED_MARKER), "kept");
  const secondRoot = await stage(`settle the waiting ${damage} repair`, () =>
    second.release(),
  );

  assert.equal(secondRoot, firstRoot);
  assert.ok(
    existsSync(join(firstRoot, PUBLISHED_MARKER)),
    "the waiting repair replaced the tree the first repair published",
  );
  assertCompletedTrees(install, [firstRoot, secondRoot]);
}

async function repairHoldsCoordination() {
  const install = installDamaged("missing");
  const worker = await stage("hold coordination in a repair", async () => {
    const parked = await parkedRepairWorker(install, "hold");
    await parked.resume();
    await parked.waitFor("holding\n");
    return parked;
  });
  stage("probe coordination from another connection", () => {
    const probe = new Database(join(install.home, "catalog.db"));
    try {
      probe.exec("PRAGMA busy_timeout = 0");
      assert.throws(
        () => probe.exec("BEGIN IMMEDIATE"),
        /locked|busy/i,
        "another connection was admitted while a repair held coordination",
      );
    } finally {
      probe.close();
    }
  });
  const root = await stage("settle the holding repair", () => worker.release());
  assertCompletedTrees(install, [root]);
}

// Every returned root holds each declared asset's exact bytes, and the store holds
// only the managed bytes and their tree: no staging is left behind.
function assertCompletedTrees(
  install: TDamagedInstall,
  roots: readonly string[],
): void {
  for (const root of roots) {
    for (const asset of install.declared) {
      assert.ok(
        Buffer.from(readFileSync(join(root, asset.path))).equals(
          Buffer.from(asset.data),
        ),
        `${asset.path} under ${root} does not hold its declared bytes`,
      );
    }
  }
  assert.deepEqual(readdirSync(join(install.home, "bundles")).sort(), [
    install.digest,
    `${install.digest}.wfb`,
  ]);
}

async function parkedRepairWorker(
  install: TDamagedInstall,
  mode: "overlap" | "hold",
): Promise<{
  readonly waitFor: (expected: string) => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly release: () => Promise<string>;
}> {
  const spawned = await install.processAdapter.spawnOwnedProcess({
    role: "command",
    executable: process.execPath,
    args: [REPAIR_WORKER, install.home, install.digest, mode],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5_000,
  });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) throw new Error("repair worker did not launch");
  const worker = spawned.process;
  const output = observeOutput(worker.stdout);
  const stderr = collectText(worker.stderr);
  const failure = async (cause: unknown): Promise<never> => {
    const [close, diagnostics] = await Promise.all([worker.closed(), stderr]);
    throw new Error(
      `repair worker failed; close=${JSON.stringify(close)}; stderr=${JSON.stringify(diagnostics)}`,
      { cause },
    );
  };
  const waitFor = (expected: string) => output.waitFor(expected).catch(failure);
  const resume = () => worker.writeStdin(RESUME);
  await waitFor("parked\n");
  return {
    waitFor,
    resume,
    // Resume the last barrier, await the caller's own settlement, and return
    // the root its `assetRoot` reported.
    async release() {
      await resume();
      await waitFor("repaired\n");
      const [close, diagnostics] = await Promise.all([
        worker.closeStdin(5_000),
        stderr,
      ]);
      assert.deepEqual(
        close,
        { kind: "exited", status: 0 },
        diagnostics || "repair worker did not exit successfully",
      );
      const reported = /^root (.*)$/m.exec(output.text())?.[1];
      assert.ok(reported !== undefined, "repair worker reported no root");
      const root: unknown = JSON.parse(reported);
      assert.ok(typeof root === "string", "repair worker returned no root");
      return root;
    },
  };
}
