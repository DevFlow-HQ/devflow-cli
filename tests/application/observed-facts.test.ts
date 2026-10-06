import assert from "node:assert/strict";
import test from "node:test";
import { openLiveRun } from "../helpers/liveRun.js";

test("m10-observed-harness-facts: Run Projection replaces partial reports, catches up late subscribers and clears each Turn", async (t) => {
  const { port, runId, channel, owner, finish } = await openLiveRun(t);
  t.after(finish);
  const opened = port.openProjection({ family: "run", runId });
  t.after(() => opened.close());
  const before = JSON.stringify(opened.snapshot);
  const events = owner.turnEvents();
  const updates = opened.updates[Symbol.asyncIterator]();
  channel.bindAnswer(async () => ({ outcome: "accepted" }));
  const started = await updates.next();
  assert.ok(started.value?.kind === "live");
  assert.equal(started.value.overlay.context, undefined);
  assert.equal(started.value.overlay.usage, undefined);
  channel.observe({
    context: { usedTokens: 9000, limitTokens: 2, percentage: 150 },
    usage: "total input 300, last input 10",
  });
  const first = await updates.next();
  assert.ok(first.value?.kind === "live");
  assert.deepEqual(first.value.overlay.context, {
    usedTokens: 9000,
    limitTokens: 2,
    percentage: 150,
  });
  channel.observe({
    context: { limitTokens: 4 },
    usage: "last output 0 tokens",
  });
  const replacement = await updates.next();
  assert.ok(replacement.value?.kind === "live");
  assert.deepEqual(replacement.value.overlay.context, { limitTokens: 4 });
  assert.equal(replacement.value.overlay.usage, "last output 0 tokens");
  assert.equal(
    replacement.value.overlay.generation,
    first.value.overlay.generation,
  );
  const late = port.openProjection({ family: "run", runId });
  t.after(() => late.close());
  assert.equal(
    JSON.stringify(late.snapshot),
    before,
    "live accounting is not Run truth",
  );
  const caughtUp = await late.updates[Symbol.asyncIterator]().next();
  assert.ok(caughtUp.value?.kind === "live");
  assert.deepEqual(caughtUp.value.overlay.context, { limitTokens: 4 });
  channel.observe({ context: {}, usage: "" });
  const absent = await updates.next();
  assert.ok(absent.value?.kind === "live");
  assert.deepEqual(absent.value.overlay.context, {});
  assert.equal(absent.value.overlay.usage, "");
  channel.observe({ context: { usedTokens: 7 }, usage: "input 7" });
  await updates.next();
  channel.bindAnswer(undefined);
  await updates.next();
  channel.bindAnswer(async () => ({ outcome: "accepted" }));
  // An unrelated durable update guarantees progress even if the boundary fails
  // to publish. The first update must still be the cleared live overlay.
  owner.writeState("running");
  const nextTurn = await updates.next();
  assert.ok(nextTurn.value?.kind === "live");
  assert.equal(nextTurn.value.overlay.context, undefined);
  assert.equal(nextTurn.value.overlay.usage, undefined);
  const durable = await updates.next();
  assert.ok(durable.value?.kind === "durable");
  assert.deepEqual(
    owner.turnEvents(),
    events,
    "metadata is never persisted as Turn events",
  );
  await finish();
});
