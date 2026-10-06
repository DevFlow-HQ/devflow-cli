import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  OpenedProjection,
  ProjectionUpdate,
  RunSnapshot,
} from "../../src/application/projection-port.js";
import {
  openLiveRun,
  UNREAD_UNIT_BOUND as RETAINED_UNITS,
  UNREAD_UPDATE_BOUND as RETAINED_UPDATES,
  type LiveRun,
} from "../helpers/liveRun.js";

// #306 (M7 audit A4): each opened Projection subscription retains its unread
// updates in its own bounded FIFO. Below the bound every update arrives in order,
// uncoalesced; one update past it ends only that subscription with a single
// `observer-lagged` terminal, ahead of and instead of the released backlog. The Run
// and every other observer continue, and a reopen reads current truth.
//

function openRun(
  t: TestContext,
  run: LiveRun,
): {
  opened: OpenedProjection<RunSnapshot>;
  next: () => Promise<IteratorResult<ProjectionUpdate<RunSnapshot>>>;
} {
  const opened = run.port.openProjection({ family: "run", runId: run.runId });
  t.after(() => opened.close());
  const iterator = opened.updates[Symbol.asyncIterator]();
  return { opened, next: () => iterator.next() };
}

/** Whether `pending` is still unresolved after the microtask queue drains: the
 *  stream is open and holds nothing, with no sleep. */
async function stillPending(pending: Promise<unknown>): Promise<boolean> {
  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  return !resolved;
}

function previewText(
  result: IteratorResult<ProjectionUpdate<RunSnapshot>>,
): string | undefined {
  return !result.done && result.value.kind === "live"
    ? result.value.overlay.usage
    : undefined;
}

async function assertLagged(
  next: () => Promise<IteratorResult<ProjectionUpdate<RunSnapshot>>>,
): Promise<void> {
  assert.deepEqual(await next(), {
    done: false,
    value: { kind: "closed", reason: "observer-lagged" },
  });
  assert.deepEqual(await next(), { done: true, value: undefined });
}

const REQUEST = {
  requestId: "req-edit",
  tool: "Edit",
  input: "change file",
  decisions: ["allow", "deny"] as const,
};

test("closing the last Run observer and reopening still follows live updates", async (t) => {
  const run = await openLiveRun(t);
  const first = openRun(t, run);
  first.opened.close();
  const reopened = openRun(t, run);
  run.channel.raised({ ...REQUEST });
  const update = await reopened.next();
  assert.ok(!update.done && update.value.kind === "live");
  if (!update.done && update.value.kind === "live")
    assert.equal(update.value.overlay.outstanding[0]?.requestId, "req-edit");
  await run.finish();
});

test("a slow observer retains every update up to the bound in order, uncoalesced, across all three lanes", async (t) => {
  const run = await openLiveRun(t);
  const slow = openRun(t, run);

  // Exactly the bound: previews, one durable write, and one live overlay.
  for (let index = 0; index < RETAINED_UPDATES; index += 1) {
    if (index === 10) run.owner.writeState("running");
    else if (index === 20) run.channel.raised({ ...REQUEST });
    else run.channel.observe({ usage: `p${index}` });
  }

  for (let index = 0; index < RETAINED_UPDATES; index += 1) {
    const result = await slow.next();
    assert.equal(result.done, false);
    if (result.done) return;
    if (index === 10) {
      assert.equal(result.value.kind, "durable");
    } else if (index === 20) {
      assert.equal(result.value.kind, "live");
      if (result.value.kind === "live") {
        assert.deepEqual(
          result.value.overlay.outstanding.map((request) => request.requestId),
          ["req-edit"],
        );
      }
    } else {
      assert.equal(previewText(result), `p${index}`);
    }
  }
  // Nothing was dropped, coalesced, or ended: the stream is open and empty.
  assert.equal(await stillPending(slow.next()), true);
  await run.finish();
});

test("one update past the bound ends only the slow subscription, once, while a healthy observer and the Run continue", async (t) => {
  const run = await openLiveRun(t);
  const slow = openRun(t, run);
  const healthy = openRun(t, run);

  for (let index = 0; index <= RETAINED_UPDATES; index += 1) {
    run.channel.observe({ usage: `p${index}` });
    // The healthy observer reads each update as it lands.
    assert.equal(previewText(await healthy.next()), `p${index}`);
  }

  // The terminal arrives first: the backlog is released, not drained, and the
  // iterator completes.
  await assertLagged(slow.next);

  // Later updates never reach the ended subscription; the healthy one keeps them.
  run.channel.observe({ usage: "after" });
  assert.equal(previewText(await healthy.next()), "after");
  assert.deepEqual(await slow.next(), { done: true, value: undefined });

  // The Run was never touched: it settles and rests succeeded.
  await run.finish();
  const durable = await healthy.next();
  assert.ok(!durable.done && durable.value.kind === "durable");
  if (!durable.done && durable.value.kind === "durable") {
    assert.ok(durable.value.snapshot.result.found);
    if (durable.value.snapshot.result.found) {
      assert.equal(durable.value.snapshot.result.run.state, "succeeded");
    }
  }
});

test("reopening after observer-lagged reads the current snapshot and live overlay", async (t) => {
  const run = await openLiveRun(t);
  const slow = openRun(t, run);

  run.channel.raised({ ...REQUEST });
  for (let index = 0; index < RETAINED_UPDATES; index += 1) {
    run.channel.observe({ usage: `p${index}` });
  }
  await assertLagged(slow.next);
  slow.opened.close();

  const reopened = openRun(t, run);
  assert.ok(reopened.opened.snapshot.result.found);
  if (reopened.opened.snapshot.result.found) {
    assert.equal(reopened.opened.snapshot.result.run.state, "running");
  }
  const caughtUp = await reopened.next();
  assert.ok(!caughtUp.done && caughtUp.value.kind === "live");
  if (!caughtUp.done && caughtUp.value.kind === "live") {
    const overlay = caughtUp.value.overlay;
    assert.deepEqual(
      overlay.outstanding.map((request) => request.requestId),
      ["req-edit"],
    );
    assert.equal(overlay.offers[0]?.generation, overlay.generation);
    assert.equal(overlay.usage, `p${RETAINED_UPDATES - 1}`);
  }
  assert.equal(await stillPending(reopened.next()), true);
  await run.finish();
});

test("an oversized update is retained alone, and an update queued behind it ends that subscription", async (t) => {
  const run = await openLiveRun(t);
  const reader = openRun(t, run);
  const slow = openRun(t, run);
  const oversized = "x".repeat(RETAINED_UNITS + 1);

  // An empty backlog admits one update even past the payload budget.
  run.channel.observe({ usage: oversized });
  assert.equal(previewText(await reader.next())?.length, oversized.length);

  // The reader drained it, so the next update lands in an empty backlog again;
  // the slow observer still holds the oversized one and overflows.
  run.channel.observe({ usage: "after" });
  assert.equal(previewText(await reader.next()), "after");
  await assertLagged(slow.next);
  await run.finish();
});

test("retained payload bounds the backlog exactly at its budget, well below the update count", async (t) => {
  const run = await openLiveRun(t);
  const reader = openRun(t, run);
  const slow = openRun(t, run);
  // The retained overlay adds 86 units for its fixed keys and values.
  const half = "y".repeat(RETAINED_UNITS / 2 - 86);

  // Two halves fill both backlogs exactly to the budget; neither overflows.
  run.channel.observe({ usage: half });
  run.channel.observe({ usage: half });
  assert.equal(previewText(await reader.next()), half);
  assert.equal(previewText(await reader.next()), half);

  // One more unit overflows the slow observer at a backlog of two updates; the
  // drained reader takes it.
  run.channel.observe({ usage: "z" });
  assert.equal(previewText(await reader.next()), "z");
  await assertLagged(slow.next);
  await run.finish();
});
