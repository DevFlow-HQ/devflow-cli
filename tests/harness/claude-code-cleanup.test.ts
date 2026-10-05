import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessPhaseFact, TurnEvent } from "../../src/harness/harness.js";
import type {
  OwnedProcessClose,
  ProcessInterruption,
} from "../../src/process/process.js";
import {
  SESSION_ID,
  controlRequests,
  controlSettlements,
  liveTurnOn,
  prepare,
  scriptedClaude,
  turnRequest,
} from "./scripted-claude.js";

const incomplete: readonly OwnedProcessClose[] = [
  { kind: "cleanup-timeout" },
  { kind: "cleanup-error", cause: new Error("could not drain child") },
];

for (const close of incomplete) {
  for (const route of ["native refusal", "internal stop"] as const) {
    test(`Claude fallback cleanup retains owner: ${route} with ${close.kind}`, async (t) => {
      const scripted = scriptedClaude({
        answer: "refuse",
        interruption: { close, escalated: false },
        closeStdin: () => Promise.resolve(close),
      });
      const phases: HarnessPhaseFact[] = [];
      const harness = await prepare(scripted, { phases });
      t.after(() => harness.close());
      const { turn, events } = await liveTurnOn(harness);
      let exited = false;
      void scripted.closed().then(() => {
        exited = true;
      });
      if (route === "native refusal") await turn.interrupt();
      else
        scripted.emit({
          type: "system",
          subtype: "init",
          session_id: "another-session",
        });
      const result = await turn.result();
      assert.equal(result.kind, "lost");
      if (route === "native refusal" && result.kind === "lost") {
        assert.equal(result.detail.failure?.phase, "control");
        assert.equal(result.detail.failure?.category, "interruption-unknown");
      }
      const count = events.length;
      assert.equal(
        exited,
        false,
        "incomplete cleanup does not prove final exit",
      );
      const followUp = harness.startTurn(turnRequest("again"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        scripted.spawnOptions.length,
        1,
        "unconfirmed child forbids replacement",
      );
      const next = await followUp.result();
      assert.equal(next.kind, "failed");
      if (next.kind !== "failed") throw new Error("unreachable");
      assert.equal(next.detail.failure.phase, "recovery");
      assert.equal(next.detail.failure.possibleEffects, "none");
      assert.equal(scripted.spawnOptions.length, 1);
      assert.equal(scripted.stops(), 1);
      assert.deepEqual(controlSettlements(phases), [
        "failed:interruption-unknown",
      ]);
      assert.ok(
        phases.some(
          (fact) =>
            fact.kind === "phase-end" &&
            fact.phase === "cleanup" &&
            fact.outcome === "failed" &&
            fact.failure.category === close.kind,
        ),
      );
      assert.equal(
        controlRequests(scripted).length,
        route === "native refusal" ? 1 : 0,
      );
      const cleanup = await harness.close();
      assert.equal(cleanup.clean, false);
      if (cleanup.clean) throw new Error("unreachable");
      assert.ok(cleanup.failure);
      assert.equal(cleanup.failure.phase, "cleanup");
      assert.equal(cleanup.failure.category, close.kind);
      assert.equal(cleanup.sessions?.[0]?.availability.state, "unusable");
      assert.equal(exited, false);
      assert.equal(events.length, count);
      assert.strictEqual(await turn.result(), result);
    });
  }
}

for (const close of incomplete) {
  test(`Claude fallback cleanup retains owner: final exit after ${close.kind} permits exact recovery`, async (t) => {
    const scripted = scriptedClaude({
      answer: "refuse",
      interruption: { close, escalated: true },
    });
    const harness = await prepare(scripted);
    t.after(() => harness.close());
    const { turn, events } = await liveTurnOn(harness);
    await turn.interrupt();
    const result = await turn.result();
    assert.equal(result.kind, "lost");
    const count = events.length;
    const refused = await harness
      .startTurn(turnRequest("before exit"))
      .result();
    assert.equal(refused.kind, "failed");
    assert.equal(scripted.spawnOptions.length, 1);
    scripted.exit({ kind: "exited", status: 143 });
    const recovered = await liveTurnOn(harness, "after exit");
    assert.equal(scripted.spawnOptions.length, 2);
    const args = scripted.spawnOptions[1]?.args;
    assert.ok(args);
    assert.equal(args[args.indexOf("--resume") + 1], SESSION_ID);
    assert.equal(args.includes("--session-id"), false);
    scripted.emit({ type: "result", subtype: "success", result: "continued" });
    assert.equal((await recovered.turn.result()).kind, "completed");
    assert.strictEqual(await turn.result(), result);
    assert.equal(events.length, count);
    const cleanup = await harness.close();
    assert.equal(
      cleanup.clean,
      false,
      "recovery cannot erase earlier cleanup failure",
    );
    assert.equal(cleanup.failure?.phase, "cleanup");
    assert.equal(cleanup.failure?.category, close.kind);
    assert.equal(cleanup.sessions?.[0]?.availability.state, "detached");
  });

  test(`Claude fallback cleanup retains owner: admission refusal with ${close.kind}`, async (t) => {
    let closes = 0;
    const scripted = scriptedClaude({
      answer: "confirm",
      closeStdin: () => {
        closes += 1;
        return Promise.resolve(close);
      },
    });
    const harness = await prepare(scripted);
    t.after(() => harness.close());
    const first = await liveTurnOn(harness);
    scripted.emit({ type: "result", subtype: "success", result: "done" });
    const result = await first.turn.result();
    const request = turnRequest("refused");
    const refused = await harness
      .startTurn({
        ...request,
        recorder: {
          ...request.recorder,
          admit: () =>
            Promise.resolve({ recorded: false, reason: "fenced admission" }),
        },
      })
      .result();
    assert.equal(refused.kind, "not-started");
    if (refused.kind !== "not-started") throw new Error("unreachable");
    assert.equal(refused.detail.failure.category, "durable-admission");
    let exited = false;
    void scripted.closed().then(() => {
      exited = true;
    });
    const next = await harness.startTurn(turnRequest("again")).result();
    assert.equal(next.kind, "failed");
    assert.equal(scripted.spawnOptions.length, 1);
    assert.equal(exited, false);
    const cleanup = await harness.close();
    assert.equal(cleanup.clean, false);
    assert.equal(cleanup.failure?.category, close.kind);
    assert.equal(cleanup.sessions?.[0]?.availability.state, "unusable");
    assert.equal(closes, 1, "close shares the claimed cleanup attempt");
    assert.strictEqual(await first.turn.result(), result);
  });

  for (const completed of [false, true]) {
    test(`Claude fallback cleanup retains owner: natural ${close.kind} ${completed ? "after" : "before"} terminal`, async (t) => {
      const scripted = scriptedClaude({ answer: "confirm" });
      const harness = await prepare(scripted);
      t.after(() => harness.close());
      const first = await liveTurnOn(harness);
      if (completed) {
        scripted.emit({ type: "result", subtype: "success", result: "done" });
        await first.turn.result();
      }
      scripted.exit(close);
      const result = await first.turn.result();
      assert.equal(result.kind, completed ? "completed" : "lost");
      const next = await harness.startTurn(turnRequest("again")).result();
      assert.equal(next.kind, "failed");
      assert.equal(scripted.spawnOptions.length, 1);
      const cleanup = await harness.close();
      assert.equal(cleanup.clean, false);
      assert.equal(cleanup.failure?.phase, "cleanup");
      assert.equal(cleanup.failure?.category, close.kind);
      assert.equal(cleanup.sessions?.[0]?.availability.state, "unusable");
      assert.strictEqual(await first.turn.result(), result);
    });
  }
}

test("Claude fallback cleanup retains owner: a completed graceful stop permits recovery and clean close", async (t) => {
  const scripted = scriptedClaude({ answer: "refuse" });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const first = await liveTurnOn(harness);
  await first.turn.interrupt();
  const result = await first.turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "process-only");
  const second = await liveTurnOn(harness, "again");
  assert.equal(scripted.spawnOptions.length, 2);
  scripted.emit({ type: "result", subtype: "success", result: "done" });
  assert.equal((await second.turn.result()).kind, "completed");
  assert.equal((await harness.close()).clean, true);
});

test("Claude fallback cleanup retains owner: retired frames cannot settle a follow-up waiting for internal cleanup", async (t) => {
  let finish!: (result: ProcessInterruption) => void;
  let begin!: () => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const stopped = new Promise<ProcessInterruption>((resolve) => {
    finish = resolve;
  });
  const scripted = scriptedClaude({
    answer: "refuse",
    interruption: () => {
      begin();
      return stopped;
    },
  });
  const harness = await prepare(scripted);
  t.after(() => {
    finish({ close: { kind: "cleanup-timeout" }, escalated: true });
    return harness.close();
  });
  const first = await liveTurnOn(harness);
  scripted.emit({
    type: "system",
    subtype: "init",
    session_id: "wrong-session",
  });
  const result = await first.turn.result();
  await started;
  const next = harness.startTurn(turnRequest("waiting for cleanup"));
  let settled = false;
  void next.result().then(() => {
    settled = true;
  });
  const events: TurnEvent[] = [];
  next.subscribe((event) => events.push(event));
  scripted.emit(
    { type: "system", subtype: "init", session_id: SESSION_ID },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "old child" }] },
    },
    { type: "result", subtype: "success", result: "old result" },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(events, []);
  finish({ close: { kind: "cleanup-timeout" }, escalated: true });
  assert.equal((await next.result()).kind, "failed");
  assert.equal(scripted.spawnOptions.length, 1);
  assert.strictEqual(await first.turn.result(), result);
  assert.equal((await harness.close()).clean, false);
});

for (const close of incomplete) {
  test(`Claude fallback cleanup retains owner: Model choice relaunch with ${close.kind}`, async (t) => {
    const scripted = scriptedClaude({
      answer: "ignore",
      closeStdin: () => Promise.resolve(close),
    });
    const harness = await prepare(scripted, { controlTimeoutMs: 20 });
    t.after(() => harness.close());
    const first = await liveTurnOn(harness);
    scripted.emit({ type: "result", subtype: "success", result: "done" });
    const result = await first.turn.result();
    const next = await harness
      .startTurn({
        ...turnRequest("new choice"),
        modelChoice: { model: "sonnet" },
      })
      .result();
    assert.equal(next.kind, "failed");
    if (next.kind !== "failed") throw new Error("unreachable");
    assert.equal(next.detail.failure.phase, "recovery");
    assert.equal(scripted.spawnOptions.length, 1);
    assert.strictEqual(await first.turn.result(), result);
    const cleanup = await harness.close();
    assert.equal(cleanup.clean, false);
    assert.equal(cleanup.failure?.category, close.kind);
  });
}

test("Claude fallback cleanup retains owner: close shares an internal stop already in flight", async (t) => {
  let finish!: (result: ProcessInterruption) => void;
  let begin!: () => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const stopped = new Promise<ProcessInterruption>((resolve) => {
    finish = resolve;
  });
  let closes = 0;
  const scripted = scriptedClaude({
    answer: "refuse",
    interruption: () => {
      begin();
      return stopped;
    },
    closeStdin: () => {
      closes += 1;
      return Promise.resolve({ kind: "exited", status: 0 });
    },
  });
  const harness = await prepare(scripted);
  t.after(() => {
    finish({ close: { kind: "cleanup-timeout" }, escalated: true });
    return harness.close();
  });
  const first = await liveTurnOn(harness);
  scripted.emit({
    type: "system",
    subtype: "init",
    session_id: "wrong-session",
  });
  const result = await first.turn.result();
  await started;
  let closed = false;
  const closing = harness.close().then((report) => {
    closed = true;
    return report;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finish({
    close: { kind: "cleanup-error", cause: new Error("stop failed") },
    escalated: true,
  });
  assert.equal((await closing).clean, false);
  assert.equal(scripted.stops(), 1);
  assert.equal(closes, 0);
  assert.strictEqual(await first.turn.result(), result);
});

test("Claude fallback cleanup retains owner: final close preserves an authoritative result drained during cleanup", async (t) => {
  const scripted = scriptedClaude({
    answer: "ignore",
    closeStdin: async () => {
      scripted.emit({
        type: "result",
        subtype: "success",
        result: "completed before exit",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { kind: "exited", status: 0 };
    },
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const first = await liveTurnOn(harness);
  const cleanup = await harness.close();
  const result = await first.turn.result();
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.equal(result.detail.finalContent, "completed before exit");
  assert.equal(cleanup.clean, true);
});
