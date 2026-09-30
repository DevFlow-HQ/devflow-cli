import assert from "node:assert/strict";
import test from "node:test";
import {
  runNamedScenario,
  withCleanup,
} from "../../scripts/package-smoke/scenario.js";

test("a package-smoke failure names its scenario and preserves the cause", async () => {
  const cause = new Error("the assertion failed");

  await assert.rejects(
    runNamedScenario("install-and-collision", async () => {
      throw cause;
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /install-and-collision/);
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test("cleanup runs after the smoke and a cleanup failure fails a passing smoke", async () => {
  const cleanup = new Error("EPERM: operation not permitted, rm");
  let cleaned = 0;
  assert.equal(
    await withCleanup(
      async () => "passed",
      async () => {
        cleaned += 1;
      },
    ),
    "passed",
  );
  assert.equal(cleaned, 1);
  await assert.rejects(
    withCleanup(
      async () => "passed",
      async () => {
        throw cleanup;
      },
    ),
    (error: unknown) => error === cleanup,
  );
});

test("a failed smoke keeps its own error when cleanup also fails", async () => {
  // A failed scenario can leave a child holding a file in the smoke root, which
  // Windows refuses to delete; that EPERM must not hide which scenario failed.
  const failure = new Error('Package smoke scenario "command-gate" failed.');
  const cleanup = new Error("EPERM: operation not permitted, rm");
  await assert.rejects(
    withCleanup(
      async () => {
        throw failure;
      },
      async () => {},
    ),
    (error: unknown) => error === failure,
  );
  await assert.rejects(
    withCleanup(
      async () => {
        throw failure;
      },
      async () => {
        throw cleanup;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, cleanup]);
      return true;
    },
  );
});
