import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import * as childProcessNamespace from "node:child_process";
import childProcessDefault, {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
} from "node:child_process";
import { spawnSync as bareSpecifierSpawnSync } from "child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { $, spawn as bunSpawn, spawnSync as bunSpawnSync } from "bun";

import { createProcessAdapter } from "../../src/process/process.js";
import { failOnTrappedSpawn, globalHookRuns } from "./spawnTrap.js";

// bunfig.toml preloads the trap, so it is already installed in this file's worker.
// Each test reaches a route for real, then runs the global hook itself in place of
// the runner: the hook's failure is asserted, and the hook empties the record, so
// this file passes. That a throwing preload hook fails its test is Bun's runner
// behavior, which only a nested `bun test` child could assert; the tests below
// prove the preload and the runner's call to the hook instead.

const FILE = "tests/helpers/spawnTrap.test.ts";
// Never on PATH, so a regressed trap reaches a child that fails at once.
const EXECUTABLE = "secant-spawn-trap-never-runs";
const require = createRequire(import.meta.url);

/** Where the trap places a spawn reached from inside the test that owns `t`. */
function inTest(t: TestContext): string {
  return `${FILE} > ${t.fullName}`;
}

/** The error a spawn route threw. The trap throws before any child exists. */
function thrownBy(reach: () => unknown): Error {
  try {
    reach();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  return assert.fail("the spawn route returned instead of reaching the trap");
}

/** The route's own throw names the route, where it was reached, and the fix. */
function assertNamed(thrown: Error, route: string, where: string): void {
  assert.ok(
    thrown.message.includes(`${route} in ${where}`),
    `expected "${route} in ${where}" in: ${thrown.message}`,
  );
  assert.match(thrown.message, /createFakeProcess/);
}

/** Run the global hook as the runner does after a test: it fails the test and
 *  lists every spawn the test reached, in order. Afterwards the record is empty. */
function assertFailsTest(
  reached: readonly { readonly route: string; readonly where: string }[],
): void {
  assert.throws(failOnTrappedSpawn, (error: unknown) => {
    assert.ok(error instanceof Error);
    const listed = error.message
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim());
    assert.deepEqual(
      listed,
      reached.map(({ route, where }) => `${route} in ${where}`),
    );
    assert.match(error.message, /createFakeProcess/);
    return true;
  });
  assert.doesNotThrow(failOnTrappedSpawn);
}

const ROUTES: readonly {
  readonly route: string;
  readonly reach: () => unknown;
}[] = [
  { route: "child_process.spawn", reach: () => spawn(EXECUTABLE) },
  { route: "child_process.spawnSync", reach: () => spawnSync(EXECUTABLE) },
  { route: "child_process.exec", reach: () => exec(EXECUTABLE) },
  { route: "child_process.execSync", reach: () => execSync(EXECUTABLE) },
  { route: "child_process.execFile", reach: () => execFile(EXECUTABLE) },
  {
    route: "child_process.execFileSync",
    reach: () => execFileSync(EXECUTABLE),
  },
  { route: "child_process.fork", reach: () => fork(EXECUTABLE) },
  { route: "Bun.spawn", reach: () => Bun.spawn([EXECUTABLE]) },
  { route: "Bun.spawnSync", reach: () => Bun.spawnSync([EXECUTABLE]) },
  { route: "Bun.$", reach: () => Bun.$`${EXECUTABLE}` },
];

for (const { route, reach } of ROUTES) {
  test(`${route} fails the test that reached it, even when the throw becomes a value`, (t) => {
    // The test body swallows the throw, so only the global hook can fail it.
    const thrown = thrownBy(reach);

    assertNamed(thrown, route, inTest(t));
    assertFailsTest([{ route, where: inTest(t) }]);
  });
}

test("every import of the child-process module reaches the same trap", async (t) => {
  const dynamic = await import("node:child_process");
  const forms: readonly (() => unknown)[] = [
    () => childProcessNamespace.spawnSync(EXECUTABLE),
    () => childProcessDefault.spawnSync(EXECUTABLE),
    () => dynamic.spawnSync(EXECUTABLE),
    () => bareSpecifierSpawnSync(EXECUTABLE),
    // A CommonJS require reaches the module's CommonJS object, not the module mock.
    () => require("node:child_process").spawnSync(EXECUTABLE),
    () => require("child_process").spawnSync(EXECUTABLE),
  ];

  for (const reach of forms) {
    assertNamed(thrownBy(reach), "child_process.spawnSync", inTest(t));
  }
  assertFailsTest(
    forms.map(() => ({ route: "child_process.spawnSync", where: inTest(t) })),
  );
});

test("the spawn functions imported from bun reach the Bun traps", (t) => {
  assertNamed(
    thrownBy(() => $`${EXECUTABLE}`),
    "Bun.$",
    inTest(t),
  );
  assertNamed(
    thrownBy(() => bunSpawn([EXECUTABLE])),
    "Bun.spawn",
    inTest(t),
  );
  assertNamed(
    thrownBy(() => bunSpawnSync([EXECUTABLE])),
    "Bun.spawnSync",
    inTest(t),
  );
  assertFailsTest(
    ["Bun.$", "Bun.spawn", "Bun.spawnSync"].map((route) => ({
      route,
      where: inTest(t),
    })),
  );
});

test("a ChildProcess spawned directly reaches the Bun.spawn trap", (t) => {
  // Bun builds its child-process module on Bun.spawn, so the method needs no trap.
  // `@types/node` does not declare Node's internal `ChildProcess#spawn`.
  const child = new ChildProcess() as unknown as {
    spawn(options: { file: string; args: string[]; stdio: string }): unknown;
  };
  const reach = () =>
    child.spawn({ file: EXECUTABLE, args: [EXECUTABLE], stdio: "pipe" });

  assertNamed(thrownBy(reach), "Bun.spawn", inTest(t));
  assertFailsTest([{ route: "Bun.spawn", where: inTest(t) }]);
});

test("a spawn the real Process Adapter turns into spawn-error still fails its test", async (t) => {
  const result = await createProcessAdapter().spawnOwnedProcess({
    executable: EXECUTABLE,
    args: [],
    cwd: process.cwd(),
    env: {},
    launchTimeoutMs: 1_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "spawn-error");
  assertFailsTest([{ route: "child_process.spawn", where: inTest(t) }]);
});

test("a spawn behind a timer is named by the test that started it", async (t) => {
  // Process code spawns behind timers, where a stack trace no longer shows the test.
  const thrown = await new Promise<Error>((resolve) => {
    setTimeout(
      () => setImmediate(() => resolve(thrownBy(() => spawnSync(EXECUTABLE)))),
      0,
    );
  });

  assertNamed(thrown, "child_process.spawnSync", inTest(t));
  assertFailsTest([{ route: "child_process.spawnSync", where: inTest(t) }]);
});

// Bound while the file loads, so calling it runs outside every test, as a spawn at a
// module's top level does.
const spawnOutsideAnyTest = AsyncResource.bind(() =>
  thrownBy(() => spawnSync(EXECUTABLE)),
);

test("a spawn outside any test is named by its file", () => {
  const where = `${FILE}, outside any test`;

  assertNamed(spawnOutsideAnyTest(), "child_process.spawnSync", where);
  assertFailsTest([{ route: "child_process.spawnSync", where }]);
});

test("bunfig.toml preloads the trap ahead of every other preload", () => {
  const config = Bun.TOML.parse(readFileSync("bunfig.toml", "utf8")) as {
    readonly test?: { readonly preload?: readonly string[] };
  };

  assert.equal(config.test?.preload?.[0], "./tests/helpers/spawnTrap.ts");
});

// The next test sees exactly one more hook run than this one left: the runner's.
let hookRunsAtTestEnd: number | undefined;
test("the runner runs the global hook after a test (records the count)", () => {
  hookRunsAtTestEnd = globalHookRuns();
});

test("the runner runs the global hook after a test (checks the count)", () => {
  assert.notEqual(hookRunsAtTestEnd, undefined);
  assert.equal(globalHookRuns(), hookRunsAtTestEnd! + 1);
});
