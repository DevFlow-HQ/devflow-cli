// The Claude Code native Interrupt (#346), driven through the Adapter Seam with a
// scripted Process that answers stdin frames the way Claude Code does. No child
// runs, so these cases hold on every OS; the recorded wire is replayed against a
// real child in runtime conformance (tests/harness/replayer-conformance.ts).

import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessPhaseFact } from "../../src/harness/harness.js";
import {
  SESSION_ID,
  abortedResult,
  controlRequests,
  controlResponse,
  controlSettlements,
  init,
  liveTurn,
  liveTurnOn,
  prepare,
  scriptedClaude,
  turnRequest,
} from "./scripted-claude.js";

test("a confirmed native interrupt settles the Turn interrupted active-turn and keeps the process for the next Turn", async () => {
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: (index) =>
      index === 0
        ? liveTurn()
        : [init, { type: "result", subtype: "success", result: "continued" }],
  });
  const phases: HarnessPhaseFact[] = [];
  const harness = await prepare(scripted, { phases });
  const { turn } = await liveTurnOn(harness);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "active-turn");
  assert.deepEqual(result.detail.session, {
    state: "detached",
    coordinate: { opaque: SESSION_ID },
  });
  const [request] = controlRequests(scripted);
  assert.deepEqual(request?.request, {
    subtype: "interrupt",
    cancel_queued: true,
  });
  assert.equal(typeof request?.request_id, "string");
  assert.equal(scripted.stops(), 0, "a confirmed stop never stops the process");
  assert.deepEqual(controlSettlements(phases), ["ok"]);

  // The next Turn, resuming the coordinate, runs on the same live process.
  const next = await harness
    .startTurn(turnRequest("again", result.detail.session.coordinate))
    .result();
  assert.equal(next.kind, "completed");
  assert.equal(scripted.writes.length, 1, "no relaunch");
  assert.deepEqual(
    scripted.writes[0]?.map((frame) => frame.type),
    ["user", "control_request", "user"],
  );
  await harness.close();
});

test("a refused interrupt falls back to the process stop at once", async () => {
  const scripted = scriptedClaude({ answer: "refuse" });
  const phases: HarnessPhaseFact[] = [];
  // A bound the test would time out on proves the refusal needs no wait.
  const harness = await prepare(scripted, {
    controlTimeoutMs: 600_000,
    phases,
  });
  const { turn, events } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "process-only");
  assert.equal(result.detail.session.state, "detached");
  assert.equal(scripted.stops(), 1);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes("refused the interrupt (not now)"),
    ),
  );
  assert.deepEqual(controlSettlements(phases), ["ok"]);
  await harness.close();
});

test("an unanswered interrupt falls back after the control bound, and a forced kill settles lost", async () => {
  const scripted = scriptedClaude({
    answer: "ignore",
    interruption: {
      close: { kind: "signal", signal: "SIGKILL" },
      escalated: true,
    },
  });
  const phases: HarnessPhaseFact[] = [];
  const harness = await prepare(scripted, { controlTimeoutMs: 20, phases });
  const { turn } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
  assert.equal(scripted.stops(), 1);
  assert.deepEqual(controlSettlements(phases), ["failed:interruption-unknown"]);
  await harness.close();
});

test("an acknowledged interrupt whose aborted result never arrives falls back within the same bound", async () => {
  const scripted = scriptedClaude({ answer: "acknowledge-only" });
  const harness = await prepare(scripted, { controlTimeoutMs: 20 });
  const { turn, events } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "process-only");
  assert.equal(scripted.stops(), 1);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes(
          "acknowledged the interrupt but did not end the Turn",
        ),
    ),
  );
  await harness.close();
});

test("a natural result that wins the race keeps its own truth and stops nothing", async () => {
  const scripted = scriptedClaude({ answer: "complete-instead" });
  const phases: HarnessPhaseFact[] = [];
  const harness = await prepare(scripted, { phases });
  const { turn } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  assert.equal(scripted.stops(), 0);
  assert.deepEqual(controlSettlements(phases), ["abandoned"]);
  await harness.close();
});

test("an aborted result with no Interrupt in flight is a failed Turn, never interrupted", async () => {
  const scripted = scriptedClaude({
    answer: "ignore",
    userFrame: () => [init, abortedResult],
  });
  const harness = await prepare(scripted);
  const result = await harness.startTurn(turnRequest("go")).result();
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("unreachable");
  assert.equal(result.detail.failure.category, "error_during_execution");
  await harness.close();
});

test("a failure result answering an Interrupt without an aborted reason settles failed", async () => {
  const scripted = scriptedClaude({
    answer: (frame, emit) => {
      emit(controlResponse(frame, "success"));
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
      });
    },
  });
  const harness = await prepare(scripted);
  const { turn } = await liveTurnOn(harness);
  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "failed");
  assert.equal(scripted.stops(), 0);
  await harness.close();
});

test("an internal stop stays a process stop and writes no control request", async () => {
  // An init that names another Session never started the Turn; the Adapter
  // stops the process itself, which is never a caller's Interrupt.
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [{ ...init, session_id: "another-session" }],
  });
  const harness = await prepare(scripted);
  const result = await harness.startTurn(turnRequest("go")).result();
  assert.equal(result.kind, "not-started");
  await harness.close();
  assert.equal(scripted.stops(), 1);
  assert.equal(controlRequests(scripted).length, 0);
});

test("close during a native interrupt falls back to the process stop without waiting out the bound", async () => {
  const scripted = scriptedClaude({ answer: "ignore" });
  const harness = await prepare(scripted, { controlTimeoutMs: 600_000 });
  const { turn } = await liveTurnOn(harness);

  const interrupted = turn.interrupt();
  // Let the control request reach stdin before closing.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controlRequests(scripted).length, 1);
  const cleanup = await harness.close();
  assert.deepEqual(await interrupted, { outcome: "accepted" });
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "process-only");
  assert.equal(scripted.stops(), 1);
  assert.equal(cleanup.clean, true);
});

test("close while an acknowledged interrupt awaits its aborted result falls back at once", async () => {
  const scripted = scriptedClaude({ answer: "acknowledge-only" });
  const harness = await prepare(scripted, { controlTimeoutMs: 600_000 });
  const { turn } = await liveTurnOn(harness);

  const interrupted = turn.interrupt();
  // Once the acknowledgement is read and its microtasks drain, only the
  // result wait remains, so the close must cut that wait short.
  await scripted.responseRead;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await harness.close();
  await interrupted;
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  assert.equal(scripted.stops(), 1);
});

test("a process that exits on its own before confirming settles lost with the interruption unknown", async () => {
  const scripted = scriptedClaude({
    answer: (frame, emit, exit) => {
      emit(controlResponse(frame, "success"));
      exit();
    },
  });
  const phases: HarnessPhaseFact[] = [];
  const harness = await prepare(scripted, { phases });
  const { turn } = await liveTurnOn(harness);

  await turn.interrupt();
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
  assert.match(
    result.detail.failure?.diagnostics ?? "",
    /closed before confirming the interrupt \(process close with exit 1\)/,
  );
  assert.equal(scripted.stops(), 0, "nothing stopped the process");
  assert.deepEqual(controlSettlements(phases), ["failed:interruption-unknown"]);
  await harness.close();
});

test("a refusal's detail is bounded in the fallback activity", async () => {
  const scripted = scriptedClaude({
    answer: (frame, emit) =>
      emit({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: frame.request_id,
          error: "x".repeat(10_000),
        },
      }),
  });
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  await turn.interrupt();
  await turn.result();
  const refusal = events.find(
    (event) =>
      event.kind === "activity" && event.description.includes("refused"),
  );
  assert.ok(refusal?.kind === "activity");
  assert.ok(refusal.description.length < 400);
  await harness.close();
});

for (const kind of ["contained", "fallback"] as const) {
  test(`Claude reports ${kind} only on a lazy Session launch`, async () => {
    const facts: { kind: string; session?: string }[] = [];
    const scripted = scriptedClaude({
      answer: "confirm",
      containment:
        kind === "contained"
          ? { kind }
          : { kind, cause: new Error("forced job failure") },
    });
    const harness = await prepare(scripted, {
      containment: (fact) => facts.push(fact),
    });
    assert.deepEqual(facts, []);
    const first = await liveTurnOn(harness);
    assert.deepEqual(facts, [{ kind, session: "planning" }]);
    await first.turn.interrupt();
    await first.turn.result();
    const second = await liveTurnOn(harness, "next");
    assert.deepEqual(facts, [{ kind, session: "planning" }]);
    await second.turn.interrupt();
    await harness.close();
  });
}
