import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";

import {
  ensureSpawnHelperExecutable,
  resolveSpawnHelperPath,
} from "../../src/adapters/ensureSpawnHelperExecutable.js";

test("spawn-helper heal is a no-op outside macOS", () => {
  let resolveCalls = 0;
  let statCalls = 0;
  let chmodCalls = 0;

  ensureSpawnHelperExecutable({
    platform: "linux",
    arch: "x64",
    resolve() {
      resolveCalls += 1;
      return "/repo/node_modules/node-pty/lib/index.js";
    },
    statSync() {
      statCalls += 1;
      return { mode: 0o100644 };
    },
    chmodSync() {
      chmodCalls += 1;
    },
  });

  assert.equal(resolveCalls, 0);
  assert.equal(statCalls, 0);
  assert.equal(chmodCalls, 0);
});

test("spawn-helper heal does not chmod an already executable macOS helper", () => {
  const statPaths: string[] = [];
  const chmodCalls: Array<{ path: string; mode: number }> = [];

  ensureSpawnHelperExecutable({
    platform: "darwin",
    arch: "arm64",
    resolve(id) {
      assert.equal(id, "node-pty");
      return "/repo/node_modules/node-pty/lib/index.js";
    },
    statSync(path) {
      statPaths.push(path);
      return { mode: 0o100755 };
    },
    chmodSync(path, mode) {
      chmodCalls.push({ path, mode });
    },
  });

  assert.deepEqual(statPaths, [
    "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  ]);
  assert.deepEqual(chmodCalls, []);
});

test("spawn-helper heal adds the executable bit when the macOS helper is not executable", () => {
  const chmodCalls: Array<{ path: string; mode: number }> = [];

  ensureSpawnHelperExecutable({
    platform: "darwin",
    arch: "x64",
    resolve() {
      return "/repo/node_modules/node-pty/lib/index.js";
    },
    statSync() {
      return { mode: 0o100644 };
    },
    chmodSync(path, mode) {
      chmodCalls.push({ path, mode });
    },
  });

  assert.deepEqual(chmodCalls, [
    {
      path: "/repo/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
      mode: 0o100755,
    },
  ]);
});

test("spawn-helper heal reports the exact chmod remediation when chmod fails", () => {
  const helperPath =
    "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";

  assert.throws(
    () => {
      ensureSpawnHelperExecutable({
        platform: "darwin",
        arch: "arm64",
        resolve() {
          return "/repo/node_modules/node-pty/lib/index.js";
        },
        statSync() {
          return { mode: 0o100644 };
        },
        chmodSync() {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      });
    },
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(helperPath) &&
      error.message.includes(`sudo chmod +x ${helperPath}`),
  );
});

test("spawn-helper heal silently skips absent macOS helper files", () => {
  let chmodCalls = 0;

  assert.doesNotThrow(() => {
    ensureSpawnHelperExecutable({
      platform: "darwin",
      arch: "arm64",
      resolve() {
        return "/repo/node_modules/node-pty/lib/index.js";
      },
      statSync() {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      chmodSync() {
        chmodCalls += 1;
      },
    });
  });

  assert.equal(chmodCalls, 0);
});

test("installed node-pty contains the macOS spawn-helper paths used by the heal", async () => {
  for (const arch of ["arm64", "x64"] as const) {
    const helperPath = resolveSpawnHelperPath({ platform: "darwin", arch });

    try {
      const helperStats = await stat(helperPath);

      assert.ok(
        helperStats.isFile(),
        `node-pty's macOS spawn-helper path should be a file: ${helperPath}`,
      );
    } catch (error) {
      throw new Error(
        [
          "node-pty's macOS spawn-helper was relocated or renamed;",
          `expected ${helperPath} to exist.`,
          "Update resolveSpawnHelperPath() before changing node-pty's package layout.",
        ].join(" "),
        { cause: error },
      );
    }
  }
});
