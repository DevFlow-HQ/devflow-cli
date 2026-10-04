// The Claude Code Adapter's Model choice change (#348, ADR 0034), driven through
// the Harness Interface against a scripted Claude Code: typed `set_model` and
// `apply_flag_settings` reach a live Turn or a reused child before its next
// prompt, `get_settings` reads the result back, a typed error keeps the Session's
// choice, and an unanswered control relaunches the exact Session with
// `--resume --model --effort`. The recorded wire is replayed in runtime
// conformance (claude-code-adapter-conformance.ts).

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChoice,
  PreparedHarness,
  TurnEvent,
} from "../../src/harness/harness.js";
import {
  liveTurn,
  prepare,
  scriptedClaude,
  SESSION_ID,
  turnRequest,
  type Frame,
  type ScriptedClaude,
} from "./scripted-claude.js";

const LAUNCH: ModelChoice = { model: "haiku", effort: "low" };
const CHANGE: ModelChoice = { model: "sonnet", effort: "high" };

const success = (frame: Frame): Frame => ({
  type: "control_response",
  response: { subtype: "success", request_id: frame.request_id },
});
const refusal = (frame: Frame, error: string): Frame => ({
  type: "control_response",
  response: {
    subtype: "error",
    request_id: frame.request_id,
    error,
    error_code: "catalog_unknown",
  },
});
const result: Frame = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  terminal_reason: "completed",
  user_message_uuids: [],
};

type ControlReply = "success" | "ignore" | { readonly error: string };

/** A scripted Claude Code that keeps each Turn live until the test ends it,
 *  answers each change control per `replies`, and reads back the model and
 *  effort its successful controls set, resolved as Claude Code resolves an alias. */
function changing(
  replies: {
    readonly setModel?: (model: string) => ControlReply;
    readonly applyFlag?: () => ControlReply;
    /** Whether a `get_settings` read after a change is answered. */
    readonly readBack?: boolean;
  } = {},
): ScriptedClaude & { readonly launches: (readonly string[])[] } {
  let model = "claude-haiku-4-5";
  let effort: string | null = "low";
  const answer = (frame: Frame, emit: (frame: Frame) => void) => {
    const request = frame.request as Record<string, unknown>;
    const reply =
      request.subtype === "set_model"
        ? (replies.setModel?.(String(request.model)) ?? "success")
        : request.subtype === "apply_flag_settings"
          ? (replies.applyFlag?.() ?? "success")
          : "ignore";
    if (reply === "ignore") return;
    if (reply !== "success") {
      emit(refusal(frame, reply.error));
      return;
    }
    if (request.subtype === "set_model")
      model = `claude-${String(request.model)}-5`;
    else
      effort = String(
        (request.settings as Record<string, unknown>).effortLevel,
      );
    emit(success(frame));
  };
  let changed = false;
  const scripted = scriptedClaude({
    answer: (frame, emit) => {
      changed ||=
        (frame.request as Record<string, unknown>).subtype === "set_model";
      answer(frame, emit);
    },
    settingsAnswer: (frame, emit) =>
      changed && replies.readBack === false
        ? undefined
        : emit({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: frame.request_id,
              response: { applied: { model, effort } },
            },
          }),
    userFrame: () => liveTurn(),
  });
  const launches: (readonly string[])[] = [];
  return {
    ...scripted,
    launches,
    process: {
      ...scripted.process,
      spawnOwnedProcess(options) {
        launches.push(options.args);
        return scripted.process.spawnOwnedProcess(options);
      },
    },
  };
}

/** Start a Turn requesting `choice` and resolve once its Session is open. */
async function open(
  harness: PreparedHarness,
  choice: ModelChoice = LAUNCH,
  text = "go",
) {
  const turn = harness.startTurn({ ...turnRequest(text), modelChoice: choice });
  const events: TurnEvent[] = [];
  const waiters: { test: (e: TurnEvent) => boolean; done: () => void }[] = [];
  turn.subscribe((event) => {
    events.push(event);
    for (const waiter of [...waiters])
      if (waiter.test(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.done();
      }
  });
  const until = (predicate: (event: TurnEvent) => boolean) =>
    events.some(predicate)
      ? Promise.resolve()
      : new Promise<void>((done) => waiters.push({ test: predicate, done }));
  await until((event) => event.kind === "session");
  return { turn, events, until };
}

const isChange = (event: TurnEvent) =>
  event.kind === "model" && event.change !== undefined;
const changes = (events: readonly TurnEvent[]) =>
  events.flatMap((event) =>
    event.kind === "model" && event.change !== undefined ? [event] : [],
  );
const controls = (scripted: ScriptedClaude, process = 0) =>
  (scripted.writes[process] ?? []).flatMap((frame) =>
    frame.type === "control_request"
      ? [(frame.request as Record<string, unknown>).subtype]
      : frame.type === "user"
        ? ["user"]
        : [],
  );
const flagValue = (args: readonly string[], flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

test("a launch carries the requested model and effort as flags", async (t) => {
  const scripted = changing();
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const { turn } = await open(harness);
  scripted.emit(result);
  assert.equal((await turn.result()).kind, "completed");
  const [args] = scripted.launches;
  assert.ok(args);
  assert.equal(flagValue(args, "--model"), "haiku");
  assert.equal(flagValue(args, "--effort"), "low");
  assert.equal(flagValue(args, "--session-id"), SESSION_ID);
});

test("a choice without effort sends no effort flag", async (t) => {
  const scripted = changing();
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const { turn } = await open(harness, { model: "haiku" });
  scripted.emit(result);
  await turn.result();
  assert.equal(scripted.launches[0]?.includes("--effort"), false);
});

test("a live change applies once Claude Code answers and reads it back", async (t) => {
  const scripted = changing();
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const { turn, events, until } = await open(harness);
  assert.deepEqual(await turn.changeModel(CHANGE), { outcome: "accepted" });
  await until(isChange);
  assert.deepEqual(changes(events), [
    {
      kind: "model",
      observation: { known: true, model: "claude-sonnet-5", effort: "high" },
      change: { requested: CHANGE, outcome: "applied" },
    },
  ]);
  // Each control waits for the one before it: the read-back follows both.
  assert.deepEqual(controls(scripted).slice(-3), [
    "set_model",
    "apply_flag_settings",
    "get_settings",
  ]);
  scripted.emit(result);
  const settled = await turn.result();
  assert.equal(settled.kind, "completed");
  if (settled.kind !== "completed") throw new Error("unreachable");
  assert.deepEqual(settled.detail.effectiveModel, {
    known: true,
    model: "claude-sonnet-5",
    effort: "high",
  });
  assert.deepEqual(await turn.changeModel(CHANGE), {
    outcome: "rejected",
    reason: "expired",
  });
});

test("a refused live model keeps the Session's choice and says why", async (t) => {
  const scripted = changing({
    setModel: (model) => ({ error: `Model '${model}' not found` }),
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const { turn, events, until } = await open(harness);
  const before = events.filter((event) => event.kind === "model").at(-1);
  const unknown = { model: "claude-nonexistent", effort: "high" };
  assert.deepEqual(await turn.changeModel(unknown), { outcome: "accepted" });
  await until(isChange);
  assert.deepEqual(changes(events), [
    {
      kind: "model",
      observation: before?.kind === "model" ? before.observation : undefined,
      change: {
        requested: unknown,
        outcome: "refused",
        reason: "Model 'claude-nonexistent' not found",
        kept: LAUNCH,
      },
    },
  ]);
  // A refused model sends no effort change.
  assert.equal(controls(scripted).includes("apply_flag_settings"), false);
  scripted.emit(result);
  assert.equal((await turn.result()).kind, "completed");
});

/** Start a Turn with `request`'s choice, or none, and resolve once its Session is open. */
async function openRequest(harness: PreparedHarness, choice?: ModelChoice) {
  const turn = harness.startTurn({
    ...turnRequest("go"),
    ...(choice === undefined ? {} : { modelChoice: choice }),
  });
  const events: TurnEvent[] = [];
  let changed!: () => void;
  const change = new Promise<void>((resolve) => {
    changed = resolve;
  });
  await new Promise<void>((resolve) =>
    turn.subscribe((event) => {
      events.push(event);
      if (event.kind === "session") resolve();
      if (isChange(event)) changed();
    }),
  );
  return { turn, events, change };
}

for (const [label, launch, setModel] of [
  ["no model to restore", undefined, (): ControlReply => "success"],
  [
    "a restore Claude Code leaves unanswered",
    LAUNCH,
    (model: string) => (model === LAUNCH.model ? "ignore" : "success"),
  ],
] as const) {
  test(`a refused effort with ${label} relaunches the Session at the next Turn`, async (t) => {
    const scripted = changing({
      setModel,
      applyFlag: () => ({ error: "effort is managed by policy" }),
    });
    const harness = await prepare(scripted, { controlTimeoutMs: 20 });
    t.after(() => harness.close());
    const first = await openRequest(harness, launch);
    assert.deepEqual(await first.turn.changeModel(CHANGE), {
      outcome: "accepted",
    });
    await first.change;
    assert.deepEqual(changes(first.events)[0]?.change, {
      requested: CHANGE,
      outcome: "refused",
      reason: "effort is managed by policy",
      ...(launch === undefined ? {} : { kept: launch }),
    });
    scripted.emit(result);
    await first.turn.result();
    // The process runs neither choice for certain, so the next Turn relaunches.
    const next = await openRequest(harness, launch);
    scripted.emit(result);
    await next.turn.result();
    assert.equal(scripted.launches.length, 2);
    assert.ok(scripted.launches[1]?.includes("--resume"));
  });
}

test("a change Claude Code took but cannot read back is not reported applied", async (t) => {
  const scripted = changing({ readBack: false });
  const harness = await prepare(scripted, { controlTimeoutMs: 20 });
  t.after(() => harness.close());
  const { turn, events, until } = await open(harness);
  await turn.changeModel(CHANGE);
  await until(isChange);
  assert.equal(changes(events)[0]?.change?.outcome, "next-turn");
  scripted.emit(result);
  await turn.result();
});

test("a refused effort restores the model it replaced", async (t) => {
  const scripted = changing({
    applyFlag: () => ({ error: "effort is managed by policy" }),
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const { turn, events, until } = await open(harness);
  assert.deepEqual(await turn.changeModel(CHANGE), { outcome: "accepted" });
  await until(isChange);
  const [change] = changes(events);
  assert.deepEqual(change?.change, {
    requested: CHANGE,
    outcome: "refused",
    reason: "effort is managed by policy",
    kept: LAUNCH,
  });
  const models = (scripted.writes[0] ?? []).flatMap((frame) => {
    const request = frame.request as Record<string, unknown> | undefined;
    return request?.subtype === "set_model" ? [request.model] : [];
  });
  assert.deepEqual(models, ["sonnet", "haiku"]);
  scripted.emit(result);
  await turn.result();
});

test("an unanswered live change applies by relaunching the exact Session at the next Turn", async (t) => {
  const scripted = changing({ setModel: () => "ignore" });
  const harness = await prepare(scripted, { controlTimeoutMs: 20 });
  t.after(() => harness.close());
  const first = await open(harness);
  assert.deepEqual(await first.turn.changeModel(CHANGE), {
    outcome: "accepted",
  });
  await first.until(isChange);
  const [change] = changes(first.events);
  assert.equal(change?.change?.outcome, "next-turn");
  assert.match(
    change?.change?.outcome === "next-turn" ? change.change.reason : "",
    /did not answer/,
  );
  scripted.emit(result);
  assert.equal((await first.turn.result()).kind, "completed");

  const second = await open(harness, CHANGE, "again");
  assert.equal(scripted.launches.length, 2);
  const relaunch = scripted.launches[1];
  assert.ok(relaunch);
  assert.equal(flagValue(relaunch, "--resume"), SESSION_ID);
  assert.equal(flagValue(relaunch, "--model"), "sonnet");
  assert.equal(flagValue(relaunch, "--effort"), "high");
  // The new process got only the prompt and the per-Turn effort read.
  assert.equal(controls(scripted, 1).includes("set_model"), false);
  scripted.emit(result);
  assert.equal((await second.turn.result()).kind, "completed");
});

test("a process that left a change unanswered is sent no further change", async (t) => {
  const scripted = changing({ setModel: () => "ignore" });
  const harness = await prepare(scripted, { controlTimeoutMs: 20 });
  t.after(() => harness.close());
  const { turn, events, until } = await open(harness);
  await turn.changeModel(CHANGE);
  await until(isChange);
  const opus = { model: "opus", effort: "max" };
  assert.deepEqual(await turn.changeModel(opus), { outcome: "accepted" });
  await until(
    (event) =>
      event.kind === "model" && event.change?.requested.model === "opus",
  );
  assert.deepEqual(
    changes(events).map((event) => event.change?.outcome),
    ["next-turn", "next-turn"],
  );
  assert.equal(
    controls(scripted).filter((subtype) => subtype === "set_model").length,
    1,
  );
  scripted.emit(result);
  await turn.result();
});

test("a reused child receives a changed choice before the next prompt", async (t) => {
  const scripted = changing();
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const first = await open(harness);
  scripted.emit(result);
  await first.turn.result();
  const second = await open(harness, CHANGE, "again");
  assert.equal(scripted.launches.length, 1);
  assert.deepEqual(changes(second.events), [
    {
      kind: "model",
      observation: { known: true, model: "claude-sonnet-5", effort: "high" },
      change: { requested: CHANGE, outcome: "applied" },
    },
  ]);
  const sequence = controls(scripted);
  const prompt = sequence.lastIndexOf("user");
  assert.ok(sequence.lastIndexOf("set_model") < prompt);
  assert.ok(sequence.lastIndexOf("apply_flag_settings") < prompt);
  scripted.emit(result);
  await second.turn.result();

  // The same choice again needs no control.
  const before = controls(scripted).length;
  const third = await open(harness, CHANGE, "third");
  scripted.emit(result);
  await third.turn.result();
  assert.deepEqual(
    controls(scripted)
      .slice(before)
      .filter((subtype) => subtype !== "get_settings"),
    ["user"],
  );
});

test("a reused child that refuses the next choice keeps it and still sends the prompt", async (t) => {
  const scripted = changing({
    setModel: (model) =>
      model === "sonnet" ? "success" : { error: `Model '${model}' not found` },
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const first = await open(harness);
  scripted.emit(result);
  await first.turn.result();
  const unknown = { model: "claude-nonexistent", effort: "high" };
  const second = await open(harness, unknown, "again");
  assert.deepEqual(
    changes(second.events).map((event) => event.change),
    [
      {
        requested: unknown,
        outcome: "refused",
        reason: "Model 'claude-nonexistent' not found",
        kept: LAUNCH,
      },
    ],
  );
  assert.equal(scripted.launches.length, 1);
  assert.equal(controls(scripted).at(-1), "user");
  scripted.emit(result);
  assert.equal((await second.turn.result()).kind, "completed");
});

test("a reused child that does not answer is relaunched with the choice for this Turn", async (t) => {
  const scripted = changing({ setModel: () => "ignore" });
  const harness = await prepare(scripted, { controlTimeoutMs: 20 });
  t.after(() => harness.close());
  const first = await open(harness);
  scripted.emit(result);
  await first.turn.result();
  const second = await open(harness, CHANGE, "again");
  assert.equal(scripted.launches.length, 2);
  const relaunch = scripted.launches[1];
  assert.ok(relaunch);
  assert.equal(flagValue(relaunch, "--resume"), SESSION_ID);
  assert.equal(flagValue(relaunch, "--model"), "sonnet");
  assert.equal(flagValue(relaunch, "--effort"), "high");
  assert.deepEqual(controls(scripted, 0).at(-1), "set_model");
  assert.ok(controls(scripted, 1).includes("user"));
  assert.ok(
    second.events.some(
      (event) =>
        event.kind === "activity" && /did not answer/.test(event.description),
    ),
  );
  scripted.emit(result);
  assert.equal((await second.turn.result()).kind, "completed");
  assert.equal((await harness.close()).clean, true);
});

test("a change after an Interrupt is expired", async (t) => {
  const scripted = changing();
  const harness = await prepare(scripted, { controlTimeoutMs: 20 });
  t.after(() => harness.close());
  const { turn } = await open(harness);
  const stopping = turn.interrupt();
  assert.deepEqual(await turn.changeModel(CHANGE), {
    outcome: "rejected",
    reason: "expired",
  });
  await stopping;
  await turn.result();
});
