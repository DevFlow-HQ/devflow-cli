// Claude Code native Steer (#359, ADR 0035), driven through the Adapter Seam
// with a scripted Process that answers stdin frames the way Claude Code 2.1.288
// does. No child runs, so these cases hold on every OS; the recorded wire is
// replayed against a real child in runtime conformance.

import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessTurn, TurnEvent } from "../../src/harness/harness.js";
import {
  SESSION_ID,
  controlRequests,
  controlResponse,
  init,
  liveTurn,
  liveTurnOn,
  prepare,
  scriptedClaude,
  type ControlAnswer,
  type Frame,
  type ScriptedClaude,
} from "./scripted-claude.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function lifecycle(commandUuid: unknown, state: string): Frame {
  return {
    type: "command_lifecycle",
    command_uuid: commandUuid,
    state,
    uuid: "lifecycle-frame-uuid",
    session_id: SESSION_ID,
  };
}

function result(
  text: string,
  uuids: readonly unknown[] = [],
  started?: unknown,
): Frame {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    terminal_reason: "completed",
    ...(started !== undefined ? { user_message_uuid: started } : {}),
    user_message_uuids: uuids,
  };
}

/** A scripted Claude Code whose Turn stays live and that answers a Steer frame
 *  with nothing until the test emits its lifecycle, as 2.1.288 queues it. */
function steerable(answer: ControlAnswer = "ignore"): ScriptedClaude {
  return scriptedClaude({
    answer,
    userFrame: (index) => (index === 0 ? liveTurn() : []),
  });
}

/** The uuid the Adapter stamped on the Turn's prompt, which results list. */
function promptUuid(scripted: ScriptedClaude): unknown {
  return scripted.writes[0]?.find((frame) => frame.type === "user")?.uuid;
}

/** The stdin `user` frames written after the Turn's prompt: the Steers. */
function steerFrames(scripted: ScriptedClaude): Frame[] {
  return (scripted.writes[0] ?? [])
    .filter((frame) => frame.type === "user")
    .slice(1);
}

/** Resolve once the scripted process has received `count` Steer frames. */
async function steersWritten(
  scripted: ScriptedClaude,
  count: number,
): Promise<Frame[]> {
  while (steerFrames(scripted).length < count) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return steerFrames(scripted);
}

function settlements(events: readonly TurnEvent[]) {
  return events.flatMap((event) =>
    event.kind === "steer"
      ? [[event.steerId, event.text, event.settlement] as const]
      : [],
  );
}

/** Whether the Turn has settled, without waiting for it. */
async function isSettled(turn: HarnessTurn): Promise<boolean> {
  return Promise.race([
    turn.result().then(() => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

test("the profile declares native Steer with its delivery evidence", async () => {
  const harness = await prepare(steerable());
  assert.equal(harness.profile.steer.available, true);
  assert.match(harness.profile.steer.evidence, /stdin user frame/);
  assert.match(harness.profile.steer.evidence, /user_message_uuids/);
  assert.match(harness.profile.steer.evidence, /cancel_queued/);
  await harness.close();
});

test("a Steer is a stdin user frame with a minted uuid, delivered within the Turn when its lifecycle starts", async () => {
  const scripted = steerable();
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);

  assert.deepEqual(
    await turn.steer({ steerId: "s-1", text: "also say MANGO" }),
    { outcome: "accepted" },
  );
  const [frame] = await steersWritten(scripted, 1);
  assert.equal(frame?.type, "user");
  assert.deepEqual(frame?.message, { role: "user", content: "also say MANGO" });
  assert.equal(frame?.parent_tool_use_id, null);
  assert.match(String(frame?.uuid), UUID);
  // Queued is not delivery: nothing settles until Claude Code takes it.
  scripted.emit(lifecycle(frame?.uuid, "queued"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(settlements(events), []);

  scripted.emit(lifecycle(frame?.uuid, "started"));
  scripted.emit(
    result(
      "PINEAPPLE MANGO",
      [promptUuid(scripted), frame?.uuid],
      promptUuid(scripted),
    ),
  );
  const settled = await turn.result();
  assert.equal(settled.kind, "completed");
  assert.deepEqual(settlements(events), [
    ["s-1", "also say MANGO", { kind: "delivered", delivery: "within-turn" }],
  ]);
  const steer = events.find((event) => event.kind === "steer");
  assert.ok(
    steer?.kind === "steer" && Number.isFinite(Date.parse(steer.sentAt)),
  );
  await harness.close();
});

test("a Steer listed only in the result's user_message_uuids is delivered within the Turn", async () => {
  const scripted = steerable();
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  await turn.steer({ steerId: "s-1", text: "guidance" });
  const [frame] = await steersWritten(scripted, 1);

  scripted.emit(
    result("done", [promptUuid(scripted), frame?.uuid], promptUuid(scripted)),
  );
  assert.equal((await turn.result()).kind, "completed");
  assert.deepEqual(settlements(events), [
    ["s-1", "guidance", { kind: "delivered", delivery: "within-turn" }],
  ]);
  await harness.close();
});

test("the Turn stretches across a native boundary until a pending Steer runs, tolerating the repeated same-id init", async () => {
  const scripted = steerable();
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  await turn.steer({ steerId: "s-1", text: "now say MANGO" });
  const [frame] = await steersWritten(scripted, 1);

  // The first exchange ends without taking the Steer: its result is a boundary,
  // not the Turn's end.
  scripted.emit(
    result("one two three", [promptUuid(scripted)], promptUuid(scripted)),
  );
  assert.equal(await isSettled(turn), false);
  assert.deepEqual(settlements(events), []);
  // The Turn is still live: another Steer is accepted across the boundary.
  assert.deepEqual(await turn.steer({ steerId: "s-2", text: "and KIWI" }), {
    outcome: "accepted",
  });
  const [, second] = await steersWritten(scripted, 2);

  // Claude Code starts the queued messages as the next native exchange, which
  // re-sends its init with the same Session id.
  scripted.emit(lifecycle(frame?.uuid, "started"));
  scripted.emit(lifecycle(second?.uuid, "started"));
  scripted.emit({ ...init, slash_commands: ["compact"] });
  scripted.emit({
    type: "assistant",
    message: { content: [{ type: "text", text: "MANGO KIWI" }] },
  });
  scripted.emit(result("MANGO KIWI", [frame?.uuid, second?.uuid], frame?.uuid));
  const settled = await turn.result();
  assert.equal(settled.kind, "completed");
  if (settled.kind !== "completed") throw new Error("unreachable");
  assert.equal(settled.detail.finalContent, "MANGO KIWI");
  assert.deepEqual(settlements(events), [
    ["s-1", "now say MANGO", { kind: "delivered", delivery: "after-boundary" }],
    ["s-2", "and KIWI", { kind: "delivered", delivery: "after-boundary" }],
  ]);
  // Both exchanges' content stays in the Turn's history.
  assert.deepEqual(
    events.flatMap((event) =>
      event.kind === "assistant-content" ? [event.content] : [],
    ),
    ["partial", "MANGO KIWI"],
  );
  // The repeated init refreshes the Session fact rather than restarting the Turn.
  const sessions = events.flatMap((event) =>
    event.kind === "session" ? [event.facts?.commands] : [],
  );
  assert.deepEqual(sessions, [[], ["/compact"]]);
  assert.equal(
    events.filter((event) => event.kind === "model").length,
    1,
    "the model is observed once per Turn",
  );
  await harness.close();
});

test("without lifecycle frames, a Steer that started the next exchange is delivered after the boundary", async () => {
  const scripted = steerable();
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  await turn.steer({ steerId: "s-1", text: "next" });
  const [frame] = await steersWritten(scripted, 1);

  scripted.emit(result("first", [promptUuid(scripted)], promptUuid(scripted)));
  assert.equal(await isSettled(turn), false);
  scripted.emit(init, result("second", [frame?.uuid], frame?.uuid));
  assert.equal((await turn.result()).kind, "completed");
  assert.deepEqual(settlements(events), [
    ["s-1", "next", { kind: "delivered", delivery: "after-boundary" }],
  ]);
  await harness.close();
});

test("a failed exchange with a Steer still pending keeps the Turn open for the Steer's exchange", async () => {
  const scripted = steerable();
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  await turn.steer({ steerId: "s-1", text: "try again" });
  const [frame] = await steersWritten(scripted, 1);

  scripted.emit({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    user_message_uuids: [promptUuid(scripted)],
  });
  assert.equal(await isSettled(turn), false);
  scripted.emit(init, result("recovered", [frame?.uuid], frame?.uuid));
  assert.equal((await turn.result()).kind, "completed");
  assert.deepEqual(settlements(events), [
    ["s-1", "try again", { kind: "delivered", delivery: "after-boundary" }],
  ]);
  await harness.close();
});

test("an Interrupt sends cancel_queued and drops every undelivered Steer before the result", async () => {
  const scripted = steerable((request, emit) => {
    for (const frame of steerFrames(scripted))
      emit(lifecycle(frame.uuid, "cancelled"));
    emit(controlResponse(request, "success"));
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_tools",
    });
  });
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  for (const steerId of ["one", "two"]) {
    assert.deepEqual(
      await turn.steer({ steerId, text: `${steerId} guidance` }),
      { outcome: "accepted" },
    );
  }
  await steersWritten(scripted, 2);
  let ended = false;
  turn.subscribe(() => assert.equal(ended, false, "no event after result"));

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  const settled = await turn.result();
  ended = true;
  assert.equal(settled.kind, "interrupted");
  if (settled.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(settled.detail.interruption.mode, "active-turn");
  assert.deepEqual(controlRequests(scripted)[0]?.request, {
    subtype: "interrupt",
    cancel_queued: true,
  });
  assert.deepEqual(settlements(events), [
    ["one", "one guidance", { kind: "dropped", reason: "interrupt" }],
    ["two", "two guidance", { kind: "dropped", reason: "interrupt" }],
  ]);
  assert.equal(scripted.stops(), 0);
  assert.deepEqual(
    await turn.steer({ steerId: "late", text: "keep this draft" }),
    { outcome: "rejected", reason: "expired" },
  );
  await harness.close();
});

test("an Interrupt between exchanges that cancels the last pending Steer ends the Turn interrupted", async () => {
  const scripted = steerable((request, emit) => {
    for (const frame of steerFrames(scripted))
      emit(lifecycle(frame.uuid, "cancelled"));
    emit(controlResponse(request, "success"));
  });
  const harness = await prepare(scripted, { controlTimeoutMs: 600_000 });
  const { turn, events } = await liveTurnOn(harness);
  await turn.steer({ steerId: "s-1", text: "queued" });
  await steersWritten(scripted, 1);
  scripted.emit(result("first", [promptUuid(scripted)], promptUuid(scripted)));
  assert.equal(await isSettled(turn), false);

  await turn.interrupt();
  const settled = await turn.result();
  assert.equal(settled.kind, "interrupted");
  if (settled.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(settled.detail.interruption.mode, "active-turn");
  assert.deepEqual(settlements(events), [
    ["s-1", "queued", { kind: "dropped", reason: "interrupt" }],
  ]);
  assert.equal(scripted.stops(), 0);
  await harness.close();
});

test("a pending Steer is dropped as loss when the process ends without a result", async () => {
  const scripted = steerable();
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  await turn.steer({ steerId: "s-1", text: "lost text" });
  await steersWritten(scripted, 1);

  scripted.exit();
  const settled = await turn.result();
  assert.equal(settled.kind, "lost");
  assert.deepEqual(settlements(events), [
    ["s-1", "lost text", { kind: "dropped", reason: "loss" }],
  ]);
  await harness.close();
});

test("a Steer sent before the prompt is written follows the prompt on stdin", async () => {
  const scripted = steerable("confirm");
  const harness = await prepare(scripted);
  const turn = harness.startTurn({
    session: "planning",
    origin: "managed",
    correlationKey: { opaque: "early" },
    input: { text: "the prompt" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  assert.deepEqual(await turn.steer({ steerId: "early", text: "steer" }), {
    outcome: "accepted",
  });
  assert.deepEqual(
    scripted.writes[0]?.map(
      (frame) => (frame.message as { content?: unknown } | undefined)?.content,
    ),
    [undefined, "the prompt", "steer"],
  );
  await turn.interrupt();
  await turn.result();
  await harness.close();
});

test("Steer controls race as values: a reused id is already-settled and a settled Turn expires", async () => {
  const scripted = steerable();
  const harness = await prepare(scripted);
  const { turn } = await liveTurnOn(harness);
  await turn.steer({ steerId: "same", text: "first" });
  assert.deepEqual(await turn.steer({ steerId: "same", text: "again" }), {
    outcome: "rejected",
    reason: "already-settled",
  });
  assert.equal(steerFrames(scripted).length, 1);
  const [frame] = steerFrames(scripted);
  scripted.emit(result("done", [frame?.uuid], promptUuid(scripted)));
  await turn.result();
  assert.deepEqual(await turn.steer({ steerId: "after", text: "late" }), {
    outcome: "rejected",
    reason: "expired",
  });
  await harness.close();
});

test("init's slash_commands rise as typed leading words on the Session fact", async () => {
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      {
        ...init,
        slash_commands: ["compact", "context", "/review", 7, "", "compact"],
      },
    ],
  });
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  const session = events.find((event) => event.kind === "session");
  assert.ok(session?.kind === "session");
  assert.deepEqual(session.facts?.commands, [
    "/compact",
    "/context",
    "/review",
  ]);
  await turn.interrupt();
  await turn.result();
  await harness.close();
});

const compacting: Frame = {
  type: "system",
  subtype: "status",
  status: "compacting",
  session_id: SESSION_ID,
};

/** The result of a command Claude Code ran itself: success, no model turn. */
const compactionResult: Frame = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  num_turns: 0,
};

function compactResult(outcome: string): Frame {
  return {
    type: "system",
    subtype: "status",
    status: null,
    compact_result: outcome,
    session_id: SESSION_ID,
  };
}

/** A compaction Turn on a process that already ran a Turn: Claude Code sends no
 *  init until the compaction ends. */
async function compactionTurn(
  answer: Parameters<typeof scriptedClaude>[0]["answer"],
) {
  const scripted = scriptedClaude({
    answer,
    userFrame: (index, frame) =>
      index === 0
        ? [init, result("hello", [frame.uuid], frame.uuid)]
        : [lifecycle("compact", "started"), compacting],
  });
  const harness = await prepare(scripted, { controlTimeoutMs: 600_000 });
  const first = harness.startTurn({
    session: "planning",
    origin: "managed",
    correlationKey: { opaque: "first" },
    input: { text: "say hello" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  assert.equal((await first.result()).kind, "completed");
  const turn = harness.startTurn({
    session: "planning",
    origin: "human",
    correlationKey: { opaque: "compact" },
    input: { text: "/compact" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  const events: TurnEvent[] = [];
  await new Promise<void>((resolve) => {
    turn.subscribe((event) => {
      events.push(event);
      if (event.kind === "activity" && event.description.includes("compacting"))
        resolve();
    });
  });
  return { scripted, harness, turn, events };
}

test("an Interrupt that cancels a compaction settles interrupted though Claude Code reports success", async () => {
  const { scripted, harness, turn } = await compactionTurn((request, emit) => {
    emit(controlResponse(request, "success"));
    emit(compactResult("failed"));
    emit(init);
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "Compaction canceled." }] },
    });
    emit(compactionResult);
  });
  await turn.interrupt();
  const settled = await turn.result();
  assert.equal(settled.kind, "interrupted");
  if (settled.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(settled.detail.interruption.mode, "active-turn");
  assert.equal(scripted.stops(), 0);
  await harness.close();
});

test("a compaction Claude Code reports failed settles the Turn failed, not completed", async () => {
  const { scripted, harness, turn } = await compactionTurn("ignore");
  scripted.emit(compactResult("failed"), init, compactionResult);
  const settled = await turn.result();
  assert.equal(settled.kind, "failed");
  if (settled.kind !== "failed") throw new Error("unreachable");
  assert.equal(settled.detail.failure.category, "compaction-failed");
  await harness.close();
});

test("a successful compaction settles the Turn completed", async () => {
  const { scripted, harness, turn, events } = await compactionTurn("ignore");
  scripted.emit(
    compactResult("success"),
    init,
    {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual" },
    },
    compactionResult,
  );
  assert.equal((await turn.result()).kind, "completed");
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes("compaction succeeded"),
    ),
  );
  await harness.close();
});

test("automatic compaction mid-Turn is activity and the Turn runs on", async () => {
  const scripted = scriptedClaude({
    answer: "ignore",
    userFrame: (_index, frame) => [
      init,
      compacting,
      compactResult("success"),
      init,
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto" },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "carried on" }] },
      },
      result("carried on", [frame.uuid], frame.uuid),
    ],
  });
  const harness = await prepare(scripted);
  const turn = harness.startTurn({
    session: "planning",
    origin: "managed",
    correlationKey: { opaque: "auto" },
    input: { text: "long work" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  const settled = await turn.result();
  assert.equal(settled.kind, "completed");
  if (settled.kind !== "completed") throw new Error("unreachable");
  assert.equal(settled.detail.finalContent, "carried on");
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes("compacting the conversation"),
    ),
  );
  await harness.close();
});

test("a local command's result settles completed with its output", async () => {
  const scripted = scriptedClaude({
    answer: "ignore",
    userFrame: () => [
      init,
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Context: 4% used" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Context: 4% used",
        num_turns: 0,
      },
    ],
  });
  const harness = await prepare(scripted);
  const settled = await harness
    .startTurn({
      session: "planning",
      origin: "human",
      correlationKey: { opaque: "local" },
      input: { text: "/context" },
      recorder: {
        admit: () => Promise.resolve({ recorded: true }),
        checkpoint: () => Promise.resolve({ recorded: true }),
      },
    })
    .result();
  assert.equal(settled.kind, "completed");
  if (settled.kind !== "completed") throw new Error("unreachable");
  assert.equal(settled.detail.finalContent, "Context: 4% used");
  await harness.close();
});

const HANDSHAKE_MS = 20;

test("a compaction that runs before init, as on a relaunched process, is not an init timeout", async () => {
  const scripted = scriptedClaude({
    answer: "ignore",
    userFrame: () => [compacting],
  });
  const harness = await prepare(scripted, { handshakeTimeoutMs: HANDSHAKE_MS });
  const turn = harness.startTurn({
    session: "planning",
    origin: "human",
    correlationKey: { opaque: "compact-first" },
    input: { text: "/compact" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  const events: TurnEvent[] = [];
  await new Promise<void>((resolve) => {
    turn.subscribe((event) => {
      events.push(event);
      if (event.kind === "activity" && event.description.includes("compacting"))
        resolve();
    });
  });
  // The Adapter armed its handshake timer before this one, with the same bound;
  // timers of equal delay fire in creation order, so once this one fires the
  // handshake bound has elapsed (an ordering fact, not a sleep).
  await new Promise<void>((resolve) => setTimeout(resolve, HANDSHAKE_MS));
  assert.equal(await isSettled(turn), false);
  scripted.emit(compactResult("success"), init, compactionResult);
  assert.equal((await turn.result()).kind, "completed");
  assert.equal(scripted.stops(), 0);
  await harness.close();
});

test("a process that never inits still times out its handshake", async () => {
  const scripted = scriptedClaude({ answer: "ignore", userFrame: () => [] });
  const harness = await prepare(scripted, { handshakeTimeoutMs: HANDSHAKE_MS });
  const result = await harness
    .startTurn({
      session: "planning",
      origin: "managed",
      correlationKey: { opaque: "silent" },
      input: { text: "go" },
      recorder: {
        admit: () => Promise.resolve({ recorded: true }),
        checkpoint: () => Promise.resolve({ recorded: true }),
      },
    })
    .result();
  assert.equal(result.kind, "not-started");
  if (result.kind !== "not-started") throw new Error("unreachable");
  assert.equal(result.detail.failure.category, "init-timeout");
  await harness.close();
});

test("a result listing only messages this Turn never sent is ignored, not the Turn's end", async () => {
  const scripted = steerable();
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  scripted.emit(
    result("someone else's", ["another-message"], "another-message"),
  );
  assert.equal(await isSettled(turn), false);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" && event.description.includes("did not send"),
    ),
  );
  scripted.emit(result("mine", [promptUuid(scripted)], promptUuid(scripted)));
  const settled = await turn.result();
  assert.equal(settled.kind, "completed");
  if (settled.kind !== "completed") throw new Error("unreachable");
  assert.equal(settled.detail.finalContent, "mine");
  // The prompt itself carries the minted uuid results are matched by.
  assert.match(String(promptUuid(scripted)), UUID);
  await harness.close();
});

test("a failed automatic compaction followed by the model's answer keeps the Turn completed", async () => {
  const scripted = scriptedClaude({
    answer: "ignore",
    userFrame: (_index, frame) => [
      init,
      compacting,
      compactResult("failed"),
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "answered anyway" }] },
      },
      { ...result("answered anyway", [frame.uuid], frame.uuid), num_turns: 2 },
    ],
  });
  const harness = await prepare(scripted);
  const settled = await harness
    .startTurn({
      session: "planning",
      origin: "managed",
      correlationKey: { opaque: "auto-failed" },
      input: { text: "long work" },
      recorder: {
        admit: () => Promise.resolve({ recorded: true }),
        checkpoint: () => Promise.resolve({ recorded: true }),
      },
    })
    .result();
  assert.equal(settled.kind, "completed");
  if (settled.kind !== "completed") throw new Error("unreachable");
  assert.equal(settled.detail.finalContent, "answered anyway");
  await harness.close();
});

test("under an Interrupt, a natural answer after an earlier failed compaction keeps its own truth", async () => {
  const scripted = scriptedClaude({
    answer: (request, emit) => {
      const prompt = promptUuid(scripted);
      emit({ ...result("finished first", [prompt], prompt), num_turns: 3 });
      emit(controlResponse(request, "success"));
    },
    userFrame: () => [init, compacting, compactResult("failed")],
  });
  const harness = await prepare(scripted);
  const turn = harness.startTurn({
    session: "planning",
    origin: "managed",
    correlationKey: { opaque: "race" },
    input: { text: "work" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  await new Promise<void>((resolve) => {
    turn.subscribe((event) => {
      if (event.kind === "activity" && event.description.includes("failed"))
        resolve();
    });
  });
  await turn.interrupt();
  assert.equal((await turn.result()).kind, "completed");
  assert.equal(scripted.stops(), 0);
  await harness.close();
});
