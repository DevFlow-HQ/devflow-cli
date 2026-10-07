import assert from "node:assert/strict";
import test from "node:test";
import type { RunView } from "../../src/application/projection-port.js";
import {
  completed,
  launchAgentCompletionRun,
} from "../helpers/agentCompletion.js";
import { awaitRunRest } from "../helpers/settleOperation.js";
import { findOffer, requireOffer, readRun } from "./run-test-helpers.js";

test("m12-harness-run-test-helpers: Run reads return current truth and close temporary projections on success and missing Run", async (t) => {
  const { wired, runId } = await launchAgentCompletionRun(t, [
    { result: completed },
  ]);
  await awaitRunRest(wired.projectionPort, runId);
  const opened = t.mock.method(wired.projectionPort, "openProjection");
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.runId, runId);
  assert.equal(run.state, "blocked");
  const successful = opened.mock.calls[0]?.result;
  assert.ok(successful);
  assert.deepEqual(await successful.updates[Symbol.asyncIterator]().next(), {
    done: true,
    value: undefined,
  });

  const missing = "missing-run-470";
  assert.throws(
    () => readRun(wired.projectionPort, missing),
    (error) => {
      const failed = opened.mock.calls[1]?.result;
      assert.ok(failed);
      return (
        error instanceof assert.AssertionError &&
        error.message.includes(JSON.stringify(failed.snapshot))
      );
    },
  );
  const failed = opened.mock.calls[1]?.result;
  assert.ok(failed);
  assert.deepEqual(await failed.updates[Symbol.asyncIterator]().next(), {
    done: true,
    value: undefined,
  });
});

test("m12-harness-run-test-helpers: optional Offers preserve absence and required Offers diagnose the observed Run", () => {
  const run: RunView = {
    runId: "run-470",
    bundle: {
      id: "test.bundle",
      version: "1.0.0",
      name: "Test",
      digest: "sha256:test",
    },
    workspacePath: "/work/test",
    launchedAt: "2026-10-07T00:00:00.000Z",
    state: "succeeded",
    liveness: { state: "not-live" },
    progress: [],
    position: 0,
    timeline: [],
    outputs: [],
    actionOffers: [{ action: "change-preferences" }],
  };
  assert.deepEqual(findOffer(run, "change-preferences"), {
    action: "change-preferences",
  });
  assert.deepEqual(requireOffer(run, "change-preferences"), {
    action: "change-preferences",
  });
  assert.equal(findOffer(run, "resume-run"), undefined);
  assert.throws(
    () => requireOffer(run, "resume-run"),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("resume-run") &&
      error.message.includes(JSON.stringify(run)),
  );
});
