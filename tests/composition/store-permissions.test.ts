import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";
import {
  launchTui,
  wireApplication,
  withClients,
} from "../../src/composition/main.js";
import { createFakeRenderer } from "../../src/tui/renderer/renderer.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { writeBundle, agentStep } from "../helpers/runLogFixture.js";
import { runHeadless } from "../../src/headless/headless.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { home, io } from "./log-sink.js";

const POSIX = process.platform !== "win32";
const mode = (path: string) => statSync(path).mode & 0o777;

function tree(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [path, ...tree(path)] : [path];
  });
}

for (const existing of [false, true]) {
  test(`m10-audit-store-permissions: ${existing ? "existing loose" : "new"} home is restricted before wiring creates files`, async () => {
    const fixture = home();
    const secantHome = join(
      makeTempDir("secant-permissions-"),
      "parent",
      "home",
    );
    let restricted = false;
    if (existing) {
      mkdirSync(secantHome, { recursive: true });
      if (POSIX) chmodSync(secantHome, 0o775);
    }
    const output = io();
    const status = await withClients(
      (clients) => {
        if (POSIX) {
          assert.equal(mode(secantHome), 0o700);
          const paths = tree(secantHome);
          for (const path of paths)
            assert.equal(
              mode(path),
              statSync(path).isDirectory() ? 0o700 : 0o600,
              path,
            );
          assert.ok(paths.some((path) => path.endsWith("catalog.db")));
          assert.ok(paths.some((path) => path.endsWith("coordination.db")));
        }
        return runHeadless(clients, ["workspace", "--json"], output.io);
      },
      {
        ...fixture.overrides,
        secantHome,
        chmodHome: (path, requestedMode) => {
          assert.equal(existsSync(join(path, "logs")), false);
          chmodSync(path, requestedMode);
          restricted = true;
        },
        logSink: {
          ...fixture.overrides.logSink,
          folder: join(secantHome, "logs"),
        },
        process: undefined,
        processFactory: () => {
          // The invocation has opened its log, but no Catalog or Run Store yet.
          assert.equal(existsSync(join(secantHome, "catalog.db")), false);
          if (POSIX) assert.equal(mode(secantHome), 0o700);
          return fixture.overrides.process!;
        },
      },
    );
    assert.equal(status, 0);
    assert.equal(restricted, POSIX);
    assert.deepEqual(output.err, []);
    assert.deepEqual(fixture.notices, []);
  });
}

test("m10-audit-store-permissions: existing file modes and old saved token bytes stay unchanged", async () => {
  const fixture = home();
  const secantHome = fixture.overrides.secantHome!;
  const old = join(secantHome, "old-run-token");
  writeFileSync(old, "old bearer token bytes");
  if (POSIX) chmodSync(old, 0o644);
  assert.equal(await withClients(() => 0, fixture.overrides), 0);
  const paths = tree(secantHome).filter((path) => path.endsWith(".db"));
  assert.equal(paths.length, 2);
  if (POSIX) for (const path of paths) chmodSync(path, 0o664);
  assert.equal(await withClients(() => 0, fixture.overrides), 0);
  if (POSIX) {
    assert.equal(mode(old), 0o644);
    for (const path of paths) assert.equal(mode(path), 0o664);
  }
  assert.equal(readFileSync(old, "utf8"), "old bearer token bytes");
});

test("m10-audit-store-permissions: Catalog assets, Run databases, diagnostics and receipt directories are private", async () => {
  const fixture = home();
  const secantHome = fixture.overrides.secantHome!;
  const overrides = {
    ...fixture.overrides,
    process: createFakeBundleProcess(),
  };
  assert.equal(
    await withClients(async () => {
      // Exercise the existing storage Interfaces inside the invocation's prepared home.
      const wired = wireApplication(overrides);
      try {
        const bundle = writeBundle([agentStep("work", 0)]);
        const built = wired.bundleManagement.build(bundle.folder, {
          noInstall: false,
        });
        assert.ok(built.ok, JSON.stringify(built));
        const entry = wired.catalog.listEntries()[0]!;
        const created = wired.runGroup.createRun({
          operationId: "permissions-run",
          bundleSnapshotDigest: entry.digest,
          launch: {},
          at: new Date("2026-10-08T00:00:00Z"),
        });
        assert.equal(created.outcome, "created");
        const owner = wired.runGroup.acquireRun(created.runId);
        assert.ok(owner);
        try {
          const area = owner.workingArea();
          assert.ok(area.ok);
          const receipts = owner.outputReceiptDirectory("0.0:work");
          assert.ok(receipts.ok);
          const conflict = owner.recordMaterializationConflict({
            artifactName: "spec",
            path: "spec.md",
            versionId: "version",
            diagnostic: new TextEncoder().encode("private diagnostic"),
            at: new Date("2026-10-08T00:00:00Z"),
          });
          assert.ok(conflict.ok);
          assert.equal(
            new TextDecoder().decode(
              owner.readDiagnostic(conflict.diagnosticId),
            ),
            "private diagnostic",
          );
          if (POSIX) {
            const assets = join(secantHome, "bundles", entry.digest);
            const paths = tree(secantHome);
            assert.ok(paths.some((path) => path.endsWith("run.db")));
            assert.ok(
              paths.some((path) => path.endsWith(conflict.diagnosticId)),
            );
            for (const path of paths) {
              const expected = statSync(path).isDirectory()
                ? 0o700
                : path.startsWith(assets + sep)
                  ? 0o400
                  : 0o600;
              assert.equal(mode(path), expected, path);
            }
          }
        } finally {
          owner.close();
        }
      } finally {
        await wired.close();
      }
      return 0;
    }, overrides),
    0,
  );
});

for (const failure of ["throws", "ignored"] as const) {
  test(`m10-audit-store-permissions: ${failure} restriction yields one headless notice and one TUI notice while startup continues`, async () => {
    const cause = new Error("filesystem refuses mode");
    const fixture = home();
    const secantHome = fixture.overrides.secantHome!;
    if (POSIX) chmodSync(secantHome, 0o775);
    const overrides = {
      ...fixture.overrides,
      chmodHome: () => {
        if (failure === "throws") throw cause;
      },
    };
    const output = io();
    assert.equal(
      await withClients((clients) => {
        assert.equal(clients.startupNotices?.length, POSIX ? 1 : 0);
        if (POSIX && failure === "throws")
          assert.equal(clients.startupNotices?.[0]?.cause, cause);
        return runHeadless(clients, ["workspace", "--json"], output.io);
      }, overrides),
      0,
    );
    assert.match(output.out.join(""), /"path"/);
    assert.equal(
      output.err.filter((line) =>
        line.startsWith("Notice [secant-home-not-private]"),
      ).length,
      POSIX ? 1 : 0,
    );
    assert.equal(output.err.length, POSIX ? 2 : 0); // One notice and its existing remediation line.
    assert.deepEqual(fixture.notices, []);

    let mounted = false;
    assert.equal(
      await launchTui({
        ...overrides,
        terminal: { interactive: true, legacyConsole: () => false },
        createRenderer: async () => ({
          port: createFakeRenderer(),
          stdin: { release() {} },
          mount: async ({ projectionPort, exit }) => {
            const workspace = projectionPort.openProjection({
              family: "workspace",
            });
            try {
              const snapshot = workspace.snapshot;
              assert.equal(snapshot.family, "workspace");
              if (snapshot.family !== "workspace")
                throw new Error("expected Workspace");
              assert.equal(snapshot.startupNotices.length, POSIX ? 1 : 0);
              if (POSIX)
                assert.equal(
                  snapshot.startupNotices[0]?.code,
                  "secant-home-not-private",
                );
              mounted = true;
            } finally {
              workspace.close();
            }
            exit();
          },
        }),
      }),
      0,
    );
    assert.equal(mounted, true);
    assert.deepEqual(fixture.notices, []);
  });
}

test("m10-audit-store-permissions: Windows skips home restriction and emits no warning", async () => {
  const fixture = home();
  const secantHome = fixture.overrides.secantHome!;
  if (POSIX) chmodSync(secantHome, 0o775);
  const before = mode(secantHome);
  const output = io();
  assert.equal(
    await withClients(
      (clients) => runHeadless(clients, ["workspace", "--json"], output.io),
      {
        ...fixture.overrides,
        hostPlatform: "windows",
        chmodHome: () => {
          throw new Error("Windows must not call chmod");
        },
      },
    ),
    0,
  );
  assert.equal(mode(secantHome), before);
  assert.deepEqual(output.err, []);
  assert.deepEqual(fixture.notices, []);
});
