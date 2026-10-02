import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";

import { setEnvironmentForTest } from "./environment.js";

const NAME = "SECANT_ENVIRONMENT_HELPER_TEST";
const OTHER = "SECANT_ENVIRONMENT_HELPER_TEST_OTHER";

/** A test's cleanup scope whose after hooks run only when the caller says, so a
 *  test can run one test's cleanup after the next test has already started. */
function scope(): { after(fn: () => void): void; cleanUp(): void } {
  const hooks: (() => void)[] = [];
  return {
    after: (fn) => hooks.push(fn),
    cleanUp: () => {
      for (const hook of hooks.splice(0)) hook();
    },
  };
}

test("a test's change is restored when its cleanup runs", () => {
  process.env[NAME] = "original";
  const first = scope();

  setEnvironmentForTest(first, { [NAME]: "first", [OTHER]: "other" });
  assert.equal(process.env[NAME], "first");
  assert.equal(process.env[OTHER], "other");

  first.cleanUp();
  assert.equal(process.env[NAME], "original");
  assert.equal(process.env[OTHER], undefined);
  assert.equal(OTHER in process.env, false);
  delete process.env[NAME];
});

test("undefined unsets a variable for the test and restores it afterwards", () => {
  process.env[NAME] = "original";
  const first = scope();

  setEnvironmentForTest(first, { [NAME]: undefined });
  assert.equal(NAME in process.env, false);

  first.cleanUp();
  assert.equal(process.env[NAME], "original");
  delete process.env[NAME];
});

test("a late cleanup leaves the next test's value in place, even when both set the same value", () => {
  for (const [firstValue, nextValue] of [
    ["first", "next"],
    ["same", "same"],
  ] as const) {
    const timedOut = scope();
    const next = scope();

    // The first test times out before its cleanup runs; the next test starts.
    setEnvironmentForTest(timedOut, { [NAME]: firstValue });
    setEnvironmentForTest(next, { [NAME]: nextValue });

    // The timed-out test's cleanup arrives while the next test is still running.
    timedOut.cleanUp();
    assert.equal(process.env[NAME], nextValue);

    // Once the next test ends, the value from before either test returns.
    next.cleanUp();
    assert.equal(NAME in process.env, false);
  }
});

test("a late cleanup that arrives after the next test ended still restores the original", () => {
  process.env[NAME] = "original";
  const timedOut = scope();
  const next = scope();

  setEnvironmentForTest(timedOut, { [NAME]: "first" });
  setEnvironmentForTest(next, { [NAME]: "next" });
  next.cleanUp();
  assert.equal(process.env[NAME], "first");

  timedOut.cleanUp();
  assert.equal(process.env[NAME], "original");
  delete process.env[NAME];
});

test("a late cleanup restores a variable the next test does not change", () => {
  const timedOut = scope();
  const next = scope();

  setEnvironmentForTest(timedOut, { [NAME]: "first", [OTHER]: "first" });
  setEnvironmentForTest(next, { [NAME]: "next" });

  timedOut.cleanUp();
  assert.equal(process.env[NAME], "next");
  assert.equal(OTHER in process.env, false);

  next.cleanUp();
  assert.equal(NAME in process.env, false);
});

test("the returned restore ends the change early and the after hook then does nothing", () => {
  const first = scope();

  const restore = setEnvironmentForTest(first, { [NAME]: "first" });
  restore();
  assert.equal(NAME in process.env, false);

  // A later change the test makes on its own is not undone by the after hook.
  const later = scope();
  setEnvironmentForTest(later, { [NAME]: "later" });
  first.cleanUp();
  assert.equal(process.env[NAME], "later");
  later.cleanUp();
  assert.equal(NAME in process.env, false);
});

test("the helper registers its cleanup on a real test context", (t) => {
  setEnvironmentForTest(t, { [NAME]: "registered" });
  assert.equal(process.env[NAME], "registered");
});

test("the previous test's real after hook restored its change", () => {
  // Tests within a file run sequentially, so the previous test's hook has run.
  assert.equal(NAME in process.env, false);
});

async function listTestSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listTestSourceFiles(path);
      return entry.isFile() && /\.tsx?$/.test(path) ? [path] : [];
    }),
  );
  return nested.flat();
}

test("test environment changes are made through the shared helper", async () => {
  const testsDirectory = join(process.cwd(), "tests");
  const writesEnvironment =
    /\bprocess\.env(?:\.\w+|\[[^\]]+\])\s*=(?!=)|\bdelete\s+(?:globalThis\.)?process\.env\b/;
  // The helper itself is exempt. `ensureRuntimeOnPath` changes PATH for a whole
  // file, which the per-file worker already isolates (spec #313, story 63). The opt-in Codex
  // recorder is a standalone program, not a test.
  const exempt = new Set([
    "helpers/environment.ts",
    "helpers/environment.test.ts",
    "helpers/commandBundle.ts",
    "harness/record-codex.ts",
  ]);
  const offenders: string[] = [];

  for (const sourceFile of await listTestSourceFiles(testsDirectory)) {
    const relativeToTests = relative(testsDirectory, sourceFile)
      .split(sep)
      .join("/");
    if (exempt.has(relativeToTests)) continue;
    if (writesEnvironment.test(await readFile(sourceFile, "utf8"))) {
      offenders.push(`tests/${relativeToTests}`);
    }
  }

  assert.deepEqual(offenders, []);
});
