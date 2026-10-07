import assert from "node:assert/strict";
import { test } from "node:test";
import { mountRenderer } from "./renderer-fixture.js";

import {
  mountWorkbench,
  runOf,
  PROGRESS,
  resizeWorkbench,
  noOverflow,
} from "./run-workbench-fixture.js";

const listenerEvents = [
  "warning",
  "uncaughtException",
  "unhandledRejection",
  "beforeExit",
] as const;
const listenerCounts = () =>
  listenerEvents.map((event) => process.listenerCount(event));
let baseline: number[];
const mounted: Awaited<ReturnType<typeof mountRenderer>>[] = [];

test("m12-renderer-test-lifecycle: owns multiple mounts even when frame readiness rejects", async () => {
  baseline = listenerCounts();
  const first = await mountRenderer(() => <text>First mount</text>, {
    width: 30,
    height: 4,
  });
  mounted.push(first);
  await first.waitForFrame((frame) => frame.includes("First mount"));
  const second = await mountRenderer(() => <text>Second mount</text>, {
    width: 30,
    height: 4,
  });
  mounted.push(second);
  await assert.rejects(
    second.waitForFrame(() => {
      throw new Error("readiness failed");
    }),
    /readiness failed/,
  );
  assert.ok(
    listenerCounts().every((count, index) => count > baseline[index]),
    "mounted renderers must acquire listeners for this cleanup test to detect a leak",
  );
});

test("m12-renderer-test-lifecycle: listeners return to their baseline after the mounting test settles", () => {
  assert.deepEqual(listenerCounts(), baseline);
  assert.equal(mounted.length, 2);
  assert.ok(mounted.every(({ renderer }) => renderer.isDestroyed));
});

test("m12-renderer-test-lifecycle: resize changes the captured terminal and Workbench layout at small, wide and boundary sizes", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      progress: PROGRESS,
      modelChoice: { model: "fake-opus", effort: "high" },
    }),
    100,
    24,
  );
  resizeWorkbench(t, renderer, 40, 16);
  await t.renderOnce();
  assert.equal(t.captureSpans().cols, 40);
  assert.equal(t.captureSpans().rows, 16);
  assert.doesNotMatch(t.captureCharFrame(), /Alpha Flow/);
  noOverflow(t.captureCharFrame(), 40);

  resizeWorkbench(t, renderer, 140, 32);
  await t.renderOnce();
  assert.equal(t.captureSpans().cols, 140);
  assert.equal(t.captureSpans().rows, 32);
  assert.match(t.captureCharFrame(), /Alpha Flow/);
  assert.match(t.captureCharFrame(), /▸ ✓ plan/);
  noOverflow(t.captureCharFrame(), 140);

  resizeWorkbench(t, renderer, 120, 24);
  await t.renderOnce();
  assert.equal(t.captureSpans().cols, 120);
  assert.doesNotMatch(t.captureCharFrame(), /Alpha Flow/);
  assert.match(t.captureCharFrame(), /Step plan · fake-opus · high effort/);
  noOverflow(t.captureCharFrame(), 120);

  resizeWorkbench(t, renderer, 121, 24);
  await t.renderOnce();
  assert.equal(t.captureSpans().cols, 121);
  assert.match(t.captureCharFrame(), /Alpha Flow/);
  assert.doesNotMatch(t.captureCharFrame(), /Step plan/);
  noOverflow(t.captureCharFrame(), 121);
});
