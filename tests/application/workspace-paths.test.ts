import type {
  ProjectionPort,
  WorkspacePathSearch,
} from "../../src/application/projection-port.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { realpathSync } from "node:fs";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";
import { createApplication } from "../helpers/application.js";
import { makeTempDir } from "../helpers/tempDir.js";

test("m10-workspace-mentions: non-Git Workspace search ranks and bounds distinct file/folder paths", async (t) => {
  const { workspacePath, runId, port } = fixture(t);

  mkdirSync(join(workspacePath, "src"));
  writeFileSync(
    join(workspacePath, "src", "alpha.ts"),
    "never load this content",
  );
  writeFileSync(join(workspacePath, "alpha"), "");
  writeFileSync(join(workspacePath, "alpha-long"), "");
  writeFileSync(join(workspacePath, "z-a-l-p-h-a"), "");
  assert.deepEqual(
    await port.searchWorkspacePaths({
      runId,
      query: "alpha",
    }),
    {
      status: "available",
      candidates: [
        { path: "alpha", kind: "file" },
        { path: "alpha-long", kind: "file" },
        { path: "src/alpha.ts", kind: "file" },
        { path: "z-a-l-p-h-a", kind: "file" },
      ],
    },
  );
  assert.deepEqual(
    await port.searchWorkspacePaths({
      runId,
      query: "src",
    }),
    {
      status: "available",
      candidates: [
        { path: "src", kind: "folder" },
        { path: "src/alpha.ts", kind: "file" },
      ],
    },
  );
  for (let i = 0; i < 15; i++)
    writeFileSync(
      join(workspacePath, `item-${String(i).padStart(2, "0")}`),
      "",
    );
  const result = await port.searchWorkspacePaths({
    runId,
    query: "item",
  });
  assert.equal(result.status, "available");
  if (result.status === "available")
    assert.deepEqual(
      result.candidates.map((c) => c.path),
      [
        "item-00",
        "item-01",
        "item-02",
        "item-03",
        "item-04",
        "item-05",
        "item-06",
        "item-07",
        "item-08",
        "item-09",
      ],
    );
});

test("m10-workspace-mentions: ignore precedence, explicit dot segments, .git exclusion and confined symlinks", async (t) => {
  const { workspacePath, runId, port } = fixture(t);
  const outside = makeTempDir("secant-outside-");

  for (const dir of ["src", ".hidden", "ignored", ".git"])
    mkdirSync(join(workspacePath, dir));
  mkdirSync(join(workspacePath, ".git", "info"));
  writeFileSync(
    join(workspacePath, ".git", "info", "exclude"),
    "excluded.txt\n",
  );
  writeFileSync(join(workspacePath, "excluded.txt"), "");
  writeFileSync(
    join(workspacePath, ".gitignore"),
    "*.log\nignored/\n*.tmp\n!keep.tmp\n",
  );
  writeFileSync(join(workspacePath, ".ignore"), "local.txt\n");
  writeFileSync(
    join(workspacePath, "src", ".gitignore"),
    "!nested.tmp\n/secret.txt\n",
  );
  for (const path of [
    "drop.log",
    "keep.tmp",
    "drop.tmp",
    "local.txt",
    "visible.txt",
    ".hidden/config",
    "ignored/a",
    ".git/internal",
    "src/nested.tmp",
    "src/secret.txt",
    "src/visible.txt",
  ])
    writeFileSync(join(workspacePath, path), "");
  writeFileSync(join(outside, "secret.txt"), "");
  symlinkSync(
    outside,
    join(workspacePath, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  symlinkSync(
    join(workspacePath, "src"),
    join(workspacePath, "inside"),
    process.platform === "win32" ? "junction" : "dir",
  );
  symlinkSync(
    workspacePath,
    join(workspacePath, "src", "cycle"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const search = async (query: string) => {
    const result = await port.searchWorkspacePaths({
      runId,
      query,
    });
    assert.equal(result.status, "available");
    return result.status === "available"
      ? result.candidates.map((c) => c.path)
      : [];
  };
  assert.deepEqual(await search(""), [
    "inside",
    "inside/cycle",
    "inside/nested.tmp",
    "inside/visible.txt",
    "keep.tmp",
    "src",
    "src/cycle",
    "src/nested.tmp",
    "src/visible.txt",
    "visible.txt",
  ]);
  assert.deepEqual(await search(".hidden/"), [".hidden", ".hidden/config"]);
  assert.deepEqual(await search("src/.git"), ["src/.gitignore"]);
  assert.deepEqual(await search(".git/internal"), []);
  assert.deepEqual(await search("drop"), []);
  assert.deepEqual(await search("escape"), []);
  assert.deepEqual(await search("secret"), []);
  rmSync(join(workspacePath, "src", "cycle"));
});

test("m10-workspace-mentions: search failure and invalid ingress are unavailable, never missing-path claims", async (t) => {
  const { workspacePath, runId, port } = fixture(t);

  for (const input of [
    { runId, query: "\0" },
    { runId, query: "x".repeat(1025) },
  ]) {
    assertUnavailable(await port.searchWorkspacePaths(input));
  }
  rmSync(workspacePath, { recursive: true });
  assertUnavailable(await port.searchWorkspacePaths({ runId, query: "a" }));
});

test("m10-workspace-mentions: cancellation, deep trees and oversized ignore metadata stop search as unavailable", async (t) => {
  const { workspacePath, runId, port } = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const aborted = await port.searchWorkspacePaths({
    runId,
    query: "",
    signal: controller.signal,
  });
  assertUnavailable(aborted);
  if (aborted.status === "unavailable")
    assert.equal(aborted.cause, controller.signal.reason);
  writeFileSync(join(workspacePath, ".gitignore"), "x".repeat(256 * 1024 + 1));
  assertUnavailable(await port.searchWorkspacePaths({ runId, query: "" }));
  rmSync(join(workspacePath, ".gitignore"));
  let path = workspacePath;
  for (let i = 0; i < 65; i++) {
    path = join(path, "d");
    mkdirSync(path);
  }
  assertUnavailable(await port.searchWorkspacePaths({ runId, query: "" }));
});

test("m10-workspace-mentions: linked-worktree .git files and non-file ignore metadata keep ordinary search available", async (t) => {
  const { workspacePath, runId, port } = fixture(t);
  writeFileSync(
    join(workspacePath, ".git"),
    "gitdir: /outside/repository/worktrees/example\n",
  );
  mkdirSync(join(workspacePath, ".gitignore"));
  writeFileSync(join(workspacePath, "visible.ts"), "");
  assert.deepEqual(
    await port.searchWorkspacePaths({ runId, query: "visible" }),
    { status: "available", candidates: [{ path: "visible.ts", kind: "file" }] },
  );
});

function assertUnavailable(result: WorkspacePathSearch) {
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.ok(result.cause instanceof Error);
}

function fixture(t: TestContext) {
  const workspacePath = realpathSync.native(makeTempDir("secant-paths-"));
  const catalog = openCatalog(makeTempDir("secant-path-catalog-"));
  const runGroup = openFakeRunGroup(
    makeTempDir("secant-path-store-"),
    workspacePath,
  );
  const created = runGroup.createRun({
    operationId: "paths-run",
    bundleSnapshotDigest: "sha256:paths",
    launch: {},
    at: new Date("2026-10-08T00:00:00Z"),
  });
  const app = createApplication({
    catalog,
    launchWorkspacePath: makeTempDir("secant-other-launch-"),
    runGroup,
  });
  t.after(async () => {
    await app.shutdown();
    runGroup.close();
    catalog.close();
  });
  const port: ProjectionPort = app.projectionPort;
  return { workspacePath, runId: created.runId, runGroup, catalog, port };
}

test("m10-audit-run-keyed-workspace-paths: the Run Store supplies the Workspace without acquiring or granting access", async (t) => {
  const { workspacePath, runId, runGroup, catalog, port } = fixture(t);
  writeFileSync(
    join(workspacePath, "run-only.ts"),
    "candidate content stays unread",
  );
  const owner = runGroup.acquireRun(runId);
  assert.ok(owner);
  const otherRoot = makeTempDir("secant-path-decoy-");
  writeFileSync(join(otherRoot, "decoy.ts"), "");
  const input = { runId, query: "run-only", workspacePath: otherRoot };
  assert.deepEqual(await port.searchWorkspacePaths(input), {
    status: "available",
    candidates: [{ path: "run-only.ts", kind: "file" }],
  });
  // A read must not acquire a new fencing epoch behind the live owner's back.
  assert.deepEqual(owner.writeState("blocked"), { ok: true });
  assert.equal(catalog.getWorkspaceApproval(workspacePath), undefined);
  owner.close();
});

for (const state of ["succeeded", "cancelled"] as const) {
  test(`m10-audit-run-keyed-workspace-paths: a ${state} Run is unavailable before processing the search`, async (t) => {
    const { runId, runGroup, port } = fixture(t);
    const owner = runGroup.acquireRun(runId);
    assert.ok(owner);
    assert.deepEqual(owner.writeState(state), { ok: true });
    owner.close();
    let queries = 0;
    assertUnavailable(
      await port.searchWorkspacePaths({
        runId,
        get query() {
          queries++;
          return "";
        },
      }),
    );
    assert.equal(queries, 0);
  });
}

test("m10-audit-run-keyed-workspace-paths: unknown, deleted and unreadable Runs are unavailable", async (t) => {
  const { runId, runGroup, port } = fixture(t);
  let queries = 0;
  const input = (id: string) => ({
    runId: id,
    get query() {
      queries++;
      return "";
    },
  });
  assertUnavailable(await port.searchWorkspacePaths(input("unknown-run")));
  runGroup.deleteRun({ operationId: "delete-paths-run", runId });
  assertUnavailable(await port.searchWorkspacePaths(input(runId)));
  runGroup.close();
  assertUnavailable(await port.searchWorkspacePaths(input(runId)));
  assert.equal(queries, 0);
});

for (const state of ["running", "blocked", "halted", "failed"] as const) {
  test(`m10-audit-run-keyed-workspace-paths: a ${state} Run remains searchable`, async (t) => {
    const { workspacePath, runId, runGroup, port } = fixture(t);
    writeFileSync(join(workspacePath, "still-open.ts"), "");
    const owner = runGroup.acquireRun(runId);
    assert.ok(owner);
    assert.deepEqual(owner.writeState(state), { ok: true });
    owner.close();
    assert.deepEqual(
      await port.searchWorkspacePaths({ runId, query: "still-open" }),
      {
        status: "available",
        candidates: [{ path: "still-open.ts", kind: "file" }],
      },
    );
  });
}

test("m10-audit-run-keyed-workspace-paths: absent Run support reports search unavailable", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-path-catalog-"));
  const app = createApplication({
    catalog,
    launchWorkspacePath: makeTempDir("secant-paths-"),
  });
  t.after(async () => {
    await app.shutdown();
    catalog.close();
  });
  assertUnavailable(
    await app.projectionPort.searchWorkspacePaths({
      runId: "unknown",
      query: "",
    }),
  );
});
