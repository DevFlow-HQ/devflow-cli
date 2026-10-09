import type {
  ProjectionPort,
  WorkspacePathSearch,
} from "../../src/application/projection-port.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  createFakeProcess,
  type FakeProcessScript,
  type FakeOwnedProcessDelivery,
} from "../process/fake-adapter.js";
import type { ApplicationDependencies } from "../../src/application/application.js";
import type { OwnedProcessOptions } from "../../src/process/process.js";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { realpathSync } from "node:fs";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";
import { createApplication } from "../helpers/application.js";
import { makeTempDir } from "../helpers/tempDir.js";

test("m10-audit-token-ripgrep-listing: one token reuses its listing and a new token lists freshly", async (t) => {
  const { runId, port, launches } = fixture(t, [
    "src/old.ts\0",
    "src/new.ts\0",
  ]);
  const first = new AbortController();
  assert.deepEqual(
    await port.searchWorkspacePaths({
      runId,
      query: "old",
      signal: first.signal,
    }),
    {
      status: "available",
      candidates: [{ path: "src/old.ts", kind: "file" }],
    },
  );
  assert.deepEqual(
    await port.searchWorkspacePaths({
      runId,
      query: "new",
      signal: first.signal,
    }),
    {
      status: "available",
      candidates: [],
    },
  );
  assert.equal(launches.length, 1);
  first.abort();
  const second = new AbortController();
  assert.deepEqual(
    await port.searchWorkspacePaths({
      runId,
      query: "new",
      signal: second.signal,
    }),
    {
      status: "available",
      candidates: [{ path: "src/new.ts", kind: "file" }],
    },
  );
  assert.equal(launches.length, 2);
});

function assertUnavailable(result: WorkspacePathSearch) {
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.ok(result.cause instanceof Error);
}

function fixture(
  t: TestContext,
  listings = Array.from({ length: 8 }, () => "run-only.ts\0still-open.ts\0"),
  options: {
    helper?: ApplicationDependencies["workspacePathHelper"] | null;
    script?: FakeProcessScript;
    onSpawn?: () => void;
  } = {},
) {
  const launches: OwnedProcessOptions[] = [];
  let launched: () => void = () => {};
  const waitForLaunch = new Promise<void>((resolve) => {
    launched = resolve;
  });
  const fake = createFakeProcess(
    options.script ?? {
      ownedProcesses: listings.map((text) => ({
        kind: "launched",
        emissions: [
          { kind: "stdout", bytes: Buffer.from(text) },
          {
            kind: "terminal",
            trigger: "automatic",
            close: { kind: "exited", status: 0 },
          },
        ],
      })),
    },
  );
  const helperBytes = Buffer.from("pinned helper fixture");
  let reads = 0;
  const helper =
    options.helper === null
      ? undefined
      : (options.helper ?? {
          kind: "embedded" as const,
          stateDirectory: makeTempDir("secant-helper-"),
          version: "15.1.0",
          sha256: createHash("sha256").update(helperBytes).digest("hex"),
          readBytes: async () => {
            reads++;
            return helperBytes;
          },
        });
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
  const optionsOnSpawn = options.onSpawn ?? (() => {});
  const app = createApplication({
    catalog,
    process: {
      ...fake,
      resolveExecutable: (...args) => fake.resolveExecutable(...args),
      spawnCommand: (options) => fake.spawnCommand(options),
      spawnCommandSync: (options) => fake.spawnCommandSync(options),
      spawnOwnedProcess: (options) => {
        launches.push(options);
        launched();
        const result = fake.spawnOwnedProcess(options);
        optionsOnSpawn();
        return result;
      },
    },
    workspacePathHelper: helper,
    launchWorkspacePath: makeTempDir("secant-other-launch-"),
    runGroup,
  });
  t.after(async () => {
    await app.shutdown();
    runGroup.close();
    catalog.close();
  });
  const port: ProjectionPort = app.projectionPort;
  return {
    workspacePath,
    runId: created.runId,
    runGroup,
    catalog,
    port,
    app,
    waitForLaunch,
    launches,
    helper,
    helperBytes,
    reads: () => reads,
  };
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

test("m10-workspace-mentions: bounded distinct file/folder candidates use fuzzysort ranking", async (t) => {
  const { runId, port } = fixture(t, [
    "alpha\0alpha-long\0src/alpha.ts\0z-a-l-p-h-a\0alpha\0",
    Array.from(
      { length: 15 },
      (_, i) => `item-${String(i).padStart(2, "0")}\0`,
    ).join(""),
  ]);
  assert.deepEqual(await port.searchWorkspacePaths({ runId, query: "alpha" }), {
    status: "available",
    candidates: [
      { path: "alpha", kind: "file" },
      { path: "alpha-long", kind: "file" },
      { path: "src/alpha.ts", kind: "file" },
      { path: "z-a-l-p-h-a", kind: "file" },
    ],
  });
  const result = await port.searchWorkspacePaths({ runId, query: "item" });
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

test("m10-audit-token-ripgrep-listing: bare @ shows derived top-level folders first; dot queries reveal only named segments", async (t) => {
  const { runId, port } = fixture(t, [
    "z.ts\0src/a.ts\0.hid/config\0src/.gitignore\0a.ts\0.empty/config\0",
  ]);
  const signal = new AbortController().signal;
  const search = (query: string) =>
    port.searchWorkspacePaths({ runId, query, signal });
  assert.deepEqual(await search(""), {
    status: "available",
    candidates: [
      { path: "src", kind: "folder" },
      { path: "a.ts", kind: "file" },
      { path: "z.ts", kind: "file" },
    ],
  });
  assert.deepEqual(await search(".hid/"), {
    status: "available",
    candidates: [
      { path: ".hid", kind: "folder" },
      { path: ".hid/config", kind: "file" },
    ],
  });
  assert.deepEqual(await search("src/.git"), {
    status: "available",
    candidates: [{ path: "src/.gitignore", kind: "file" }],
  });
  assert.deepEqual(await search("empty"), {
    status: "available",
    candidates: [],
  });
});

test("m10-audit-token-ripgrep-listing: paths are confined, normalized, distinct, bounded and never load candidate contents", async (t) => {
  const names = [
    "./src/a.ts",
    "src/a.ts",
    "/outside",
    "../escape",
    "a/../escape",
    "C:/escape",
    "a//b",
    ".git/config",
    "src/.git/config",
    "line\nfile",
    "x".repeat(4097),
    "deep/".repeat(70) + "leaf.ts",
  ];
  const { runId, port } = fixture(t, [names.join("\0") + "\0"]);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await port.searchWorkspacePaths({ runId, query: "src", signal }),
    {
      status: "available",
      candidates: [
        { path: "src", kind: "folder" },
        { path: "src/a.ts", kind: "file" },
      ],
    },
  );
  const deep = await port.searchWorkspacePaths({
    runId,
    query: "leaf",
    signal,
  });
  assert.equal(deep.status, "available");
  if (deep.status === "available")
    assert.deepEqual(deep.candidates, [
      { path: "deep/".repeat(70) + "leaf.ts", kind: "file" },
    ]);
});

test("m10-audit-token-ripgrep-listing: first-use publication is verified, reusable and safe across concurrent Applications", async (t) => {
  const a = fixture(t);
  assert.ok(a.helper?.kind === "embedded");
  const b = fixture(t, undefined, { helper: a.helper });
  await Promise.all([
    a.port.searchWorkspacePaths({ runId: a.runId, query: "run-only" }),
    b.port.searchWorkspacePaths({ runId: b.runId, query: "run-only" }),
  ]);
  assert.equal(a.launches.length, 1);
  assert.equal(b.launches.length, 1);
  const executable = a.launches[0]?.executable;
  assert.ok(executable);
  assert.equal(executable, b.launches[0]?.executable);
  assert.match(executable, /rg-15\.1\.0-/);
  assert.deepEqual(readFileSync(executable), a.helperBytes);
  assert.equal(readdirSync(a.helper.stateDirectory).length, 1);
  if (process.platform !== "win32")
    assert.equal(statSync(executable).mode & 0o777, 0o700);
  const reads = a.reads();
  await a.port.searchWorkspacePaths({ runId: a.runId, query: "" });
  assert.equal(a.reads(), reads);
  assert.equal(a.launches.length, 2);
  assert.equal(a.launches[0]?.role, "workspace-paths");
  assert.equal(a.launches[0]?.cwd, a.workspacePath);
  assert.deepEqual(a.launches[0]?.args, [
    "--no-config",
    "--files",
    "--null",
    "--hidden",
    "--no-require-git",
    "--no-follow",
    "--glob",
    "!**/.git",
    "--glob",
    "!**/.git/**",
    ".",
  ]);
  writeFileSync(executable, "corrupt helper");
  assertUnavailable(
    await a.port.searchWorkspacePaths({ runId: a.runId, query: "" }),
  );
  assert.equal(a.launches.length, 2);
});

for (const failure of [
  "absent",
  "missing",
  "wrong-digest",
  "state-is-file",
  "non-regular",
  "symlink",
] as const) {
  test(`m10-audit-token-ripgrep-listing: ${failure} helper makes only search unavailable`, async (t) => {
    const initial = fixture(t);
    assert.ok(initial.helper?.kind === "embedded");
    const helper = { ...initial.helper };
    if (failure === "missing")
      helper.readBytes = async () => {
        throw new Error("missing embedded helper");
      };
    if (failure === "wrong-digest") helper.sha256 = "0".repeat(64);
    if (failure === "state-is-file") {
      helper.stateDirectory = join(makeTempDir("secant-helper-file-"), "file");
      writeFileSync(helper.stateDirectory, "");
    }
    const final = join(
      helper.stateDirectory,
      `rg-${helper.version}-${helper.sha256.slice(0, 16)}${process.platform === "win32" ? ".exe" : ""}`,
    );
    if (failure === "non-regular") mkdirSync(final);
    if (failure === "symlink")
      symlinkSync(
        makeTempDir("secant-helper-link-"),
        final,
        process.platform === "win32" ? "junction" : "dir",
      );
    const { port, runId, launches } = fixture(t, undefined, {
      helper: failure === "absent" ? null : helper,
    });
    assertUnavailable(await port.searchWorkspacePaths({ runId, query: "" }));
    assert.equal(launches.length, 0);
  });
}

for (const [status, text, available] of [
  [0, "", true],
  [1, "", true],
  [2, "a.ts\0", true],
  [2, "", false],
  [3, "a.ts\0", false],
] as const) {
  test(`m10-audit-token-ripgrep-listing: helper exit ${status} with ${text ? "output" : "no output"} is ${available ? "available" : "unavailable"}`, async (t) => {
    const { port, runId } = fixture(t, undefined, {
      script: {
        ownedProcesses: [
          {
            kind: "launched",
            emissions: [
              { kind: "stdout", bytes: Buffer.from(text) },
              { kind: "stderr", bytes: Buffer.from("permission denied") },
              {
                kind: "terminal",
                trigger: "automatic",
                close: { kind: "exited", status },
              },
            ],
          },
        ],
      },
    });
    const result = await port.searchWorkspacePaths({ runId, query: "" });
    assert.equal(result.status, available ? "available" : "unavailable");
    if (result.status === "available")
      assert.deepEqual(
        result.candidates,
        text ? [{ path: "a.ts", kind: "file" }] : [],
      );
  });
}

for (const failure of ["launch", "invalid-utf8", "unterminated"] as const) {
  test(`m10-audit-token-ripgrep-listing: ${failure} output never becomes a partial success`, async (t) => {
    const { port, runId } = fixture(t, undefined, {
      script: {
        ownedProcesses: [
          failure === "launch"
            ? {
                kind: "launch-failure",
                failure: {
                  ok: false,
                  failure: {
                    kind: "spawn-error",
                    cause: new Error("missing helper"),
                  },
                },
              }
            : {
                kind: "launched",
                emissions: [
                  {
                    kind: "stdout",
                    bytes:
                      failure === "invalid-utf8"
                        ? Uint8Array.of(255, 0)
                        : Buffer.from("path"),
                  },
                  {
                    kind: "terminal",
                    trigger: "automatic",
                    close: { kind: "exited", status: 0 },
                  },
                ],
              },
        ],
      },
    });
    assertUnavailable(await port.searchWorkspacePaths({ runId, query: "" }));
  });
}

test("m10-audit-token-ripgrep-listing: split UTF-8 and NUL output reconstruct one path", async (t) => {
  const bytes = Buffer.from("./é.ts\0");
  const { port, runId } = fixture(t, undefined, {
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes: bytes.subarray(0, 3) },
            { kind: "stdout", bytes: bytes.subarray(3, 6) },
            { kind: "stdout", bytes: bytes.subarray(6) },
            {
              kind: "terminal",
              trigger: "automatic",
              close: { kind: "exited", status: 0 },
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(await port.searchWorkspacePaths({ runId, query: "é" }), {
    status: "available",
    candidates: [{ path: "é.ts", kind: "file" }],
  });
});

test("m10-audit-token-ripgrep-listing: cancellation before launch and invalid ingress never start a helper", async (t) => {
  const { runId, port, launches } = fixture(t);
  for (const query of ["\0", "x".repeat(1025), "\x7f"])
    assertUnavailable(await port.searchWorkspacePaths({ runId, query }));
  const controller = new AbortController();
  controller.abort();
  const result = await port.searchWorkspacePaths({
    runId,
    query: "",
    signal: controller.signal,
  });
  assertUnavailable(result);
  if (result.status === "unavailable")
    assert.equal(result.cause, controller.signal.reason);
  assert.equal(launches.length, 0);
});

test("m10-audit-token-ripgrep-listing: closing a live token stops its owned helper and returns unavailable", async (t) => {
  const controller = new AbortController();
  const { runId, port } = fixture(t, undefined, {
    onSpawn: () => controller.abort(),
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes: Buffer.from("a.ts\0") },
            {
              kind: "terminal",
              trigger: "interrupt",
              expectedGracefulMs: 1000,
              interruption: {
                close: { kind: "signal", signal: "SIGTERM" },
                escalated: true,
              },
            },
          ],
        },
      ],
    },
  });
  const result = await port.searchWorkspacePaths({
    runId,
    query: "",
    signal: controller.signal,
  });
  assertUnavailable(result);
  if (result.status === "unavailable")
    assert.equal(result.cause, controller.signal.reason);
});

test("m10-audit-token-ripgrep-listing: cap counts files before folders, searches the retained subset and stops its helper", async (t) => {
  const files = Array.from(
    { length: 100001 },
    (_, i) => `folder-${i}/file-${i}.ts\0`,
  ).join("");
  const { runId, port } = fixture(t, undefined, {
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes: Buffer.from(files) },
            {
              kind: "terminal",
              trigger: "interrupt",
              expectedGracefulMs: 1000,
              interruption: {
                close: { kind: "signal", signal: "SIGTERM" },
                escalated: true,
              },
            },
          ],
        },
      ],
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(
    await port.searchWorkspacePaths({ runId, query: "file-99999.ts", signal }),
    {
      status: "available",
      candidates: [{ path: "folder-99999/file-99999.ts", kind: "file" }],
      notice: "Large Workspace: only the first 100,000 files are searchable",
    },
  );
  assert.deepEqual(
    await port.searchWorkspacePaths({ runId, query: "file-100000.ts", signal }),
    {
      status: "available",
      candidates: [],
      notice: "Large Workspace: only the first 100,000 files are searchable",
    },
  );
});

test("m10-audit-token-ripgrep-listing: Application shutdown drains a pending listing without Run ownership", async (t) => {
  const { runId, port, app, waitForLaunch } = fixture(t, undefined, {
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes: Buffer.from("a.ts\0") },
            {
              kind: "terminal",
              trigger: "interrupt",
              expectedGracefulMs: 1000,
              interruption: {
                close: { kind: "signal", signal: "SIGTERM" },
                escalated: true,
              },
            },
          ],
        },
      ],
    },
  });
  const pending = port.searchWorkspacePaths({ runId, query: "" });
  await waitForLaunch;
  await app.shutdown();
  assertUnavailable(await pending);
});

for (const marker of ["folder", "linked-file"] as const) {
  test(`m10-audit-token-ripgrep-listing: ${marker} Git metadata retains ripgrep's native Git rules`, async (t) => {
    const { workspacePath, runId, port, launches } = fixture(t);
    if (marker === "folder") mkdirSync(join(workspacePath, ".git"));
    if (marker === "linked-file")
      writeFileSync(join(workspacePath, ".git"), "gitdir: /other/state\n");
    await port.searchWorkspacePaths({ runId, query: "" });
    assert.equal(launches[0]?.args.includes("--no-require-git"), false);
  });
}

test("m10-audit-token-ripgrep-listing: visible ancestors of hidden files remain folder candidates", async (t) => {
  const { runId, port } = fixture(t, ["src/.hidden/config\0"]);
  assert.deepEqual(await port.searchWorkspacePaths({ runId, query: "" }), {
    status: "available",
    candidates: [{ path: "src", kind: "folder" }],
  });
});

test("m10-audit-token-ripgrep-listing: a token is bound to its Run even when two Runs share a Workspace", async (t) => {
  const { port, runId, runGroup, launches } = fixture(t, [
    "old.ts\0",
    "new.ts\0",
  ]);
  const other = runGroup.createRun({
    operationId: "other-run",
    bundleSnapshotDigest: "sha256:paths",
    launch: {},
    at: new Date(),
  });
  const signal = new AbortController().signal;
  await port.searchWorkspacePaths({ runId, query: "", signal });
  assertUnavailable(
    await port.searchWorkspacePaths({ runId: other.runId, query: "", signal }),
  );
  assert.equal(launches.length, 1);
  assert.deepEqual(
    await port.searchWorkspacePaths({
      runId: other.runId,
      query: "new",
      signal: new AbortController().signal,
    }),
    { status: "available", candidates: [{ path: "new.ts", kind: "file" }] },
  );
});

test("m10-audit-token-ripgrep-listing: exit 2 with filtered path output is still a successful listing", async (t) => {
  const { port, runId } = fixture(t, undefined, {
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes: Buffer.from("line\nfile\0") },
            {
              kind: "terminal",
              trigger: "automatic",
              close: { kind: "exited", status: 2 },
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(await port.searchWorkspacePaths({ runId, query: "" }), {
    status: "available",
    candidates: [],
  });
});

test("m10-audit-token-ripgrep-listing: the file cap precedes path filtering as well as folder derivation", async (t) => {
  const listed =
    Array.from({ length: 100000 }, (_, i) => `line\nfile-${i}\0`).join("") +
    "late.ts\0";
  const { port, runId } = fixture(t, [listed]);
  assert.deepEqual(await port.searchWorkspacePaths({ runId, query: "late" }), {
    status: "available",
    candidates: [],
    notice: "Large Workspace: only the first 100,000 files are searchable",
  });
});

test("m10-audit-token-ripgrep-listing: a complete 100,000-file listing needs no cap notice", async (t) => {
  const listed =
    Array.from({ length: 99999 }, (_, i) => `file-${i}.ts\0`).join("") +
    "last.ts\0";
  const { port, runId } = fixture(t, [listed]);
  assert.deepEqual(await port.searchWorkspacePaths({ runId, query: "last" }), {
    status: "available",
    candidates: [{ path: "last.ts", kind: "file" }],
  });
});

test("m10-audit-token-ripgrep-listing: a cap does not hide a genuine helper cleanup failure", async (t) => {
  const cause = new Error("helper cleanup failed");
  const bytes = Buffer.from(
    Array.from({ length: 100001 }, (_, i) => `file-${i}\0`).join(""),
  );
  const { port, runId } = fixture(t, undefined, {
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes },
            {
              kind: "terminal",
              trigger: "interrupt",
              expectedGracefulMs: 1000,
              interruption: {
                close: { kind: "cleanup-error", cause },
                escalated: true,
              },
            },
          ],
        },
      ],
    },
  });
  const result = await port.searchWorkspacePaths({ runId, query: "" });
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.cause, cause);
});

test("m10-audit-compose-mention-offsets: ./ has empty-query visibility and ranking while explicit hidden names still opt in", async (t) => {
  const { port, runId } = fixture(t, [
    ".secret\0.hidden/file.ts\0src/a.ts\0readme.md\0",
  ]);
  const signal = new AbortController().signal;
  const expected = {
    status: "available",
    candidates: [
      { path: "src", kind: "folder" },
      { path: "readme.md", kind: "file" },
    ],
  };
  for (const query of ["", "./"]) {
    assert.deepEqual(
      await port.searchWorkspacePaths({ runId, query, signal }),
      expected,
    );
  }
  assert.deepEqual(
    await port.searchWorkspacePaths({ runId, query: "./src", signal }),
    {
      status: "available",
      candidates: [
        { path: "src", kind: "folder" },
        { path: "src/a.ts", kind: "file" },
      ],
    },
  );
  assert.deepEqual(
    await port.searchWorkspacePaths({ runId, query: "./.hidden", signal }),
    {
      status: "available",
      candidates: [
        { path: ".hidden", kind: "folder" },
        { path: ".hidden/file.ts", kind: "file" },
      ],
    },
  );
});

test("m10-audit-progressive-workspace-matches: usable partial results grow, re-rank the same token and settle", async (t) => {
  let delivery: FakeOwnedProcessDelivery | undefined;
  const { runId, port, launches, waitForLaunch } = fixture(t, [], {
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            {
              kind: "terminal",
              trigger: "automatic",
              close: { kind: "exited", status: 0 },
            },
          ],
          onStart: (value) => {
            delivery = value;
          },
        },
      ],
    },
  });
  const signal = new AbortController().signal;
  const updates: WorkspacePathSearch[] = [];
  const events = new EventEmitter();
  const pending = port.searchWorkspacePaths({
    runId,
    query: "",
    signal,
    onProgress: (value) => {
      updates.push(value);
      events.emit("progress", value);
    },
  });
  try {
    assert.deepEqual(updates, [
      { status: "available", candidates: [], indexing: true },
    ]);
    const first = once(events, "progress", {
      signal: AbortSignal.timeout(2000),
    });
    await waitForLaunch;
    assert.ok(delivery);
    delivery.stdout(Buffer.from("src/alpha.ts\0"));
    await first;
    assert.deepEqual(updates.at(-1), {
      status: "available",
      candidates: [{ path: "src", kind: "folder" }],
      indexing: true,
    });
    const current: WorkspacePathSearch[] = [];
    const reranked = port.searchWorkspacePaths({
      runId,
      query: "beta",
      signal,
      onProgress: (value) => {
        current.push(value);
        events.emit("rerank", value);
      },
    });
    assert.deepEqual(current.at(-1), {
      status: "available",
      candidates: [],
      indexing: true,
    });
    const growth = once(events, "rerank", {
      signal: AbortSignal.timeout(2000),
    });
    delivery.stdout(Buffer.from("src/beta.ts\0"));
    await growth;
    assert.deepEqual(current.at(-1), {
      status: "available",
      candidates: [{ path: "src/beta.ts", kind: "file" }],
      indexing: true,
    });
    assert.equal(updates.length, 2);
    assert.equal(launches.length, 1);
    delivery.finish();
    assert.deepEqual(await reranked, {
      status: "available",
      candidates: [{ path: "src/beta.ts", kind: "file" }],
    });
    assert.deepEqual(await pending, {
      status: "available",
      candidates: [{ path: "src", kind: "folder" }],
    });
  } finally {
    delivery?.finish();
  }
});

test("m10-audit-progressive-workspace-matches: settled token edits never restart the indexing status", async (t) => {
  const { port, runId, launches } = fixture(t, ["alpha.ts\0"]);
  const signal = new AbortController().signal;
  await port.searchWorkspacePaths({ runId, query: "alpha", signal });
  const updates: WorkspacePathSearch[] = [];
  await port.searchWorkspacePaths({
    runId,
    query: "a",
    signal,
    onProgress: (value) => updates.push(value),
  });
  assert.deepEqual(updates, []);
  assert.equal(launches.length, 1);
});

test("m10-audit-progressive-workspace-matches: fuzzysort scores replace path tiers, retain weak matches and deterministically break ties", async (t) => {
  const weak = "a" + "x".repeat(100) + "b" + "x".repeat(100) + "c";
  const { port, runId } = fixture(t, [
    "ablong\0z/ab\0x/ab\0abzz\0xxx/abxxxxxx\0xxxxxxxx/ab\0" + weak + "\0",
  ]);
  const signal = new AbortController().signal;
  const result = await port.searchWorkspacePaths({
    runId,
    query: "ab",
    signal,
  });
  assert.equal(result.status, "available");
  if (result.status === "available")
    assert.deepEqual(
      result.candidates.map((c) => c.path),
      ["abzz", "x/ab", "z/ab", "ablong", "xxxxxxxx/ab", "xxx/abxxxxxx", weak],
    );
  assert.deepEqual(
    await port.searchWorkspacePaths({ runId, query: "abc", signal }),
    { status: "available", candidates: [{ path: weak, kind: "file" }] },
  );
});

test("m10-audit-progressive-workspace-matches: ranking ties at the ten-candidate cutoff ignore listing order and duplicates", async (t) => {
  const listed =
    Array.from(
      { length: 16 },
      (_, i) => `file-${String(15 - i).padStart(2, "0")}\0`,
    ).join("") + "file-00\0";
  const { port, runId } = fixture(t, [listed]);
  const result = await port.searchWorkspacePaths({ runId, query: "file" });
  assert.equal(result.status, "available");
  if (result.status === "available")
    assert.deepEqual(
      result.candidates.map((c) => c.path),
      [
        "file-00",
        "file-01",
        "file-02",
        "file-03",
        "file-04",
        "file-05",
        "file-06",
        "file-07",
        "file-08",
        "file-09",
      ],
    );
});

test("m10-audit-progressive-workspace-matches: a failed listing settles unavailable after usable partial matches", async (t) => {
  let delivery: FakeOwnedProcessDelivery | undefined;
  const { port, runId, waitForLaunch } = fixture(t, [], {
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            {
              kind: "terminal",
              trigger: "automatic",
              close: { kind: "exited", status: 3 },
            },
          ],
          onStart: (value) => {
            delivery = value;
          },
        },
      ],
    },
  });
  const events = new EventEmitter();
  const pending = port.searchWorkspacePaths({
    runId,
    query: "a",
    onProgress: (value) => {
      if (value.candidates.length) events.emit("progress", value);
    },
  });
  try {
    await waitForLaunch;
    assert.ok(delivery);
    const progress = once(events, "progress", {
      signal: AbortSignal.timeout(2000),
    });
    delivery.stdout(Buffer.from("alpha.ts\0"));
    assert.deepEqual((await progress)[0], {
      status: "available",
      candidates: [{ path: "alpha.ts", kind: "file" }],
      indexing: true,
    });
    delivery.finish();
    assertUnavailable(await pending);
  } finally {
    delivery?.finish();
  }
});

test("m10-audit-progressive-workspace-matches: observer exceptions cannot fail listing or its settled result", async (t) => {
  const { port, runId } = fixture(t, ["alpha.ts\0"]);
  assert.deepEqual(
    await port.searchWorkspacePaths({
      runId,
      query: "alpha",
      onProgress: () => {
        throw new Error("observer failure");
      },
    }),
    { status: "available", candidates: [{ path: "alpha.ts", kind: "file" }] },
  );
});

test("m10-audit-progressive-workspace-matches: crossing the raw file cap publishes retained matches and the exact cap notice before settlement", async (t) => {
  const listed =
    "visible.ts\0" +
    Array.from({ length: 100000 }, (_, i) => `.hidden/file-${i}\0`).join("");
  const { port, runId } = fixture(t, [listed]);
  const updates: WorkspacePathSearch[] = [];
  await port.searchWorkspacePaths({
    runId,
    query: "visible",
    onProgress: (value) => updates.push(value),
  });
  assert.deepEqual(updates.at(-1), {
    status: "available",
    candidates: [{ path: "visible.ts", kind: "file" }],
    indexing: true,
    notice: "Large Workspace: only the first 100,000 files are searchable",
  });
});

test("m10-audit-progressive-workspace-matches: bare @ orders only top-level entries and ./ never opts into hidden paths", async (t) => {
  const { port, runId, launches } = fixture(t, [
    "z.ts\0src/nested.ts\0docs/readme.md\0a.ts\0.hidden/file.ts\0src/.config/settings\0.secret\0",
  ]);
  const signal = new AbortController().signal;
  const expected = {
    status: "available",
    candidates: [
      { path: "docs", kind: "folder" },
      { path: "src", kind: "folder" },
      { path: "a.ts", kind: "file" },
      { path: "z.ts", kind: "file" },
    ],
  };
  for (const query of ["", "./"])
    assert.deepEqual(
      await port.searchWorkspacePaths({ runId, query, signal }),
      expected,
    );
  assert.deepEqual(
    await port.searchWorkspacePaths({ runId, query: "src/.config", signal }),
    {
      status: "available",
      candidates: [
        { path: "src/.config", kind: "folder" },
        { path: "src/.config/settings", kind: "file" },
      ],
    },
  );
  assert.equal(launches.length, 1);
});

test("m10-audit-progressive-workspace-matches: aborting a usable partial result stops the helper and suppresses further updates", async (t) => {
  const controller = new AbortController();
  const { port, runId } = fixture(t, [], {
    script: {
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes: Buffer.from("alpha.ts\0") },
            {
              kind: "terminal",
              trigger: "interrupt",
              expectedGracefulMs: 1000,
              interruption: {
                close: { kind: "signal", signal: "SIGTERM" },
                escalated: true,
              },
            },
          ],
        },
      ],
    },
  });
  const updates: WorkspacePathSearch[] = [];
  const result = await port.searchWorkspacePaths({
    runId,
    query: "alpha",
    signal: controller.signal,
    onProgress: (value) => {
      updates.push(value);
      if (value.candidates.length > 0) controller.abort();
    },
  });
  assertUnavailable(result);
  if (result.status === "unavailable")
    assert.equal(result.cause, controller.signal.reason);
  assert.deepEqual(updates, [
    { status: "available", candidates: [], indexing: true },
    {
      status: "available",
      candidates: [{ path: "alpha.ts", kind: "file" }],
      indexing: true,
    },
  ]);
});

for (const withSignal of [false, true]) {
  test(`m10-audit-progressive-workspace-matches: Application shutdown suppresses cap progress while draining buffered output, caller signal=${withSignal}`, async (t) => {
    const updates: WorkspacePathSearch[] = [];
    let shutdownStarted = false;
    let closing: Promise<void> | undefined;
    let stop = () => {};
    const { port, runId, app } = fixture(t, [], {
      onSpawn: () => {
        shutdownStarted = true;
        stop();
      },
      script: {
        ownedProcesses: [
          {
            kind: "launched",
            emissions: [
              {
                kind: "stdout",
                bytes: Buffer.from(
                  "visible.ts\0" +
                    Array.from(
                      { length: 100000 },
                      (_, i) => `.hidden/file-${i}\0`,
                    ).join(""),
                ),
              },
              {
                kind: "terminal",
                trigger: "interrupt",
                expectedGracefulMs: 1000,
                interruption: {
                  close: { kind: "signal", signal: "SIGTERM" },
                  escalated: true,
                },
              },
            ],
          },
        ],
      },
    });
    stop = () => {
      closing = app.shutdown();
    };
    const result = await port.searchWorkspacePaths({
      runId,
      query: "visible",
      ...(withSignal ? { signal: new AbortController().signal } : {}),
      onProgress: (value) => {
        if (shutdownStarted) updates.push(value);
      },
    });
    await closing;
    assertUnavailable(result);
    assert.equal(shutdownStarted, true);
    assert.deepEqual(updates, []);
  });
}
