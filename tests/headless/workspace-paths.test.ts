import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runHeadlessCli } from "../../src/headless/headless.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";
import { makeTempDir } from "../helpers/tempDir.js";

test("m10-audit-token-ripgrep-listing: headless paths uses the Run-keyed query in text and JSON without approval", async (t) => {
  const bytes = Buffer.from("pinned helper");
  const h = openHeadlessHarness(t, {
    process: createFakeProcess({
      ownedProcesses: Array.from({ length: 3 }, () => ({
        kind: "launched",
        emissions: [
          { kind: "stdout", bytes: Buffer.from("src/a.ts\0visible.ts\0") },
          {
            kind: "terminal",
            trigger: "automatic",
            close: { kind: "exited", status: 0 },
          },
        ],
      })),
    }),
    workspacePathHelper: {
      kind: "embedded",
      stateDirectory: makeTempDir("paths-helper-"),
      version: "15.1.0",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      readBytes: async () => bytes,
    },
  });
  assert.ok(h.runGroup);
  const run = h.runGroup.createRun({
    operationId: "paths",
    bundleSnapshotDigest: "sha256:paths",
    launch: {},
    at: new Date(),
  });
  assert.equal(
    await h.run(["run", "paths", run.runId, "--json"]),
    0,
    h.output(),
  );
  assert.deepEqual(JSON.parse(h.stdout()), {
    status: "available",
    candidates: [
      { path: "src", kind: "folder" },
      { path: "visible.ts", kind: "file" },
    ],
  });
  assert.equal(h.stderr(), "");
  h.reset();
  assert.equal(await h.run(["run", "paths", run.runId, "src"]), 0, h.output());
  assert.equal(h.stdout(), "src/\nsrc/a.ts\n");
  assert.equal(h.stderr(), "");
  h.reset();
  assert.equal(
    await h.run(["run", "paths", run.runId, "missing", "--json"]),
    0,
    h.output(),
  );
  assert.deepEqual(JSON.parse(h.stdout()), {
    status: "available",
    candidates: [],
  });
  assert.equal(h.catalog.getWorkspaceApproval(h.workspace), undefined);
});

test("m10-audit-token-ripgrep-listing: unavailable headless paths refuses with cause-free JSON", async (t) => {
  const h = openHeadlessHarness(t);
  assert.equal(await h.run(["run", "paths", "unknown", "--json"]), 1);
  const result = JSON.parse(h.stdout());
  assert.equal(result.code, "workspace-path-search-unavailable");
  assert.equal("cause" in result, false);
  assert.equal(result.possibleEffects, "none");
  assert.equal(h.stderr(), "");
  h.reset();
  assert.equal(await h.run(["run", "paths", "unknown"]), 1);
  assert.equal(h.stdout(), "");
  assert.match(h.stderr(), /workspace-path-search-unavailable/);
});

test("m10-audit-token-ripgrep-listing: missing Run id and path help never construct composition", async () => {
  let calls = 0,
    stdout = "",
    stderr = "";
  const io = {
    out: (text: string) => {
      stdout += text;
    },
    err: (text: string) => {
      stderr += text;
    },
    cwd: () => "/unused",
  };
  const execute = () => {
    calls++;
    assert.fail("parse paths must not compose");
  };
  assert.equal(
    await runHeadlessCli(["run", "paths", "--json"], io, "0.2.0", execute),
    1,
  );
  assert.equal(JSON.parse(stdout).code, "missing-run-id");
  stdout = "";
  stderr = "";
  assert.equal(
    await runHeadlessCli(["run", "paths", "--help"], io, "0.2.0", execute),
    0,
  );
  assert.match(stdout, /query/);
  assert.equal(stderr, "");
  assert.equal(calls, 0);
});
