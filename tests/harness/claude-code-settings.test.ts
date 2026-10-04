import assert from "node:assert/strict";
import test from "node:test";
import {
  controlResponse,
  liveTurnOn,
  prepare,
  scriptedClaude,
  turnRequest,
  type Frame,
} from "./scripted-claude.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { startPermissionBridge } from "../../src/harness/harness.js";
import type { TurnEvent } from "../../src/harness/harness.js";

const reply = (frame: Frame, effort: string | null = "high"): Frame => ({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: frame.request_id,
    response: {
      applied: { model: "configured-model", effort },
      effective: { hooks: "personal-settings-must-not-escape" },
      sources: { credentials: "personal-settings-must-not-escape" },
    },
  },
});

for (const level of [undefined, "xhigh", "bogus"]) {
  test(`settings are lazy, memoized, and keep the environment lock ${level}`, async (t) => {
    setEnvironmentForTest(t, { CLAUDE_CODE_EFFORT_LEVEL: level });
    const scripted = scriptedClaude({
      answer: "confirm",
      settingsAnswer: (frame, emit) => emit(reply(frame)),
    });
    const harness = await prepare(scripted);
    assert.equal(scripted.writes.length, 0);
    const first = harness.readDefaults();
    assert.equal(harness.readDefaults(), first);
    const defaults = await first;
    assert.deepEqual(defaults, {
      kind: "reported",
      choice: {
        model: "configured-model",
        effort: level === "xhigh" ? "xhigh" : "high",
      },
      ...(level === "xhigh"
        ? {
            effortLock: {
              effort: "xhigh",
              source: "CLAUDE_CODE_EFFORT_LEVEL=xhigh",
            },
          }
        : {}),
    });
    assert.equal(scripted.writes.length, 1);
    assert.equal(scripted.writes[0]?.length, 1);
    assert.doesNotMatch(JSON.stringify(defaults), /personal-settings/);
    assert.equal((await harness.close()).clean, true);
  });
}

for (const [label, answer, reason] of [
  [
    "refused",
    (frame: Frame, emit: (frame: Frame) => void) =>
      emit(controlResponse(frame, "error")),
    "Claude Code's settings could not be read before launch.",
  ],
  [
    "malformed",
    (frame: Frame, emit: (frame: Frame) => void) =>
      emit(reply(frame, "unsupported")),
    "Claude Code's settings could not be read before launch.",
  ],
  [
    "no effort",
    (frame: Frame, emit: (frame: Frame) => void) => emit(reply(frame, null)),
    "Claude Code reported no selectable default effort.",
  ],
  [
    "unanswered",
    "ignore",
    "Claude Code's settings did not answer before launch.",
  ],
] as const) {
  test(`a ${label} settings read falls back with a readable reason`, async (t) => {
    setEnvironmentForTest(t, { CLAUDE_CODE_EFFORT_LEVEL: undefined });
    const scripted = scriptedClaude({
      answer: "confirm",
      settingsAnswer: answer,
    });
    const harness = await prepare(scripted, { controlTimeoutMs: 20 });
    assert.deepEqual(await harness.readDefaults(), {
      kind: "fallback",
      choice: { model: "opus", effort: "medium" },
      reason,
    });
    assert.equal((await harness.close()).clean, true);
  });
}

test("an unanswered defaults probe still reports the environment lock", async (t) => {
  setEnvironmentForTest(t, { CLAUDE_CODE_EFFORT_LEVEL: "xhigh" });
  const scripted = scriptedClaude({
    answer: "confirm",
    settingsAnswer: "ignore",
  });
  const harness = await prepare(scripted, { controlTimeoutMs: 20 });
  assert.deepEqual(await harness.readDefaults(), {
    kind: "fallback",
    choice: { model: "opus", effort: "xhigh" },
    reason: "Claude Code's settings did not answer before launch.",
    effortLock: { effort: "xhigh", source: "CLAUDE_CODE_EFFORT_LEVEL=xhigh" },
  });
  await harness.close();
});

test("each Turn observes effort beside the reply's model, never the requested model", async () => {
  const scripted = scriptedClaude({
    answer: "confirm",
    settingsAnswer: (frame, emit) => emit(reply(frame)),
  });
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  scripted.emit({ type: "result", subtype: "success", result: "done" });
  const result = await turn.result();
  assert.ok(result.kind === "completed");
  assert.deepEqual(result.detail.effectiveModel, {
    known: true,
    model: "scripted-model",
    effort: "high",
  });
  assert.ok(
    events.some(
      (event) =>
        event.kind === "model" &&
        event.observation.known &&
        event.observation.effort === "high",
    ),
  );
  await harness.close();
});

test("a late settings reply cannot emit after settlement or leak into the next Turn", async () => {
  const pending: Frame[] = [];
  const scripted = scriptedClaude({
    answer: "confirm",
    settingsAnswer: (frame) => pending.push(frame),
  });
  const harness = await prepare(scripted);
  const { turn, events } = await liveTurnOn(harness);
  scripted.emit({ type: "result", subtype: "success", result: "done" });
  const result = await turn.result();
  assert.ok(result.kind === "completed");
  assert.deepEqual(result.detail.effectiveModel, {
    known: true,
    model: "scripted-model",
  });
  const endedEvents = events.length;
  const next = harness.startTurn(turnRequest("next"));
  const nextEvents: TurnEvent[] = [];
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  next.subscribe((event) => {
    nextEvents.push(event);
    if (event.kind === "session") opened();
  });
  await ready;
  assert.ok(pending[0]);
  scripted.emit(reply(pending[0]), {
    type: "result",
    subtype: "success",
    result: "next done",
  });
  const nextResult = await next.result();
  assert.ok(nextResult.kind === "completed");
  assert.deepEqual(nextResult.detail.effectiveModel, {
    known: true,
    model: "scripted-model",
  });
  assert.equal(events.length, endedEvents);
  assert.ok(
    nextEvents.every(
      (event) =>
        event.kind !== "model" ||
        !event.observation.known ||
        event.observation.effort === undefined,
    ),
  );
  await harness.close();
});

test("a settings reply with null effort reports no effective effort", async () => {
  const scripted = scriptedClaude({
    answer: "confirm",
    settingsAnswer: (frame, emit) => emit(reply(frame, null)),
  });
  const harness = await prepare(scripted);
  const { turn } = await liveTurnOn(harness);
  scripted.emit({ type: "result", subtype: "success", result: "done" });
  const result = await turn.result();
  assert.ok(result.kind === "completed");
  assert.deepEqual(result.detail.effectiveModel, {
    known: true,
    model: "scripted-model",
  });
  await harness.close();
});

for (const failure of ["launch", "write"] as const) {
  test(`a ${failure} failure reading settings returns the declared fallback`, async (t) => {
    setEnvironmentForTest(t, { CLAUDE_CODE_EFFORT_LEVEL: undefined });
    const scripted = scriptedClaude({ answer: "confirm" });
    const harness = await prepare({
      ...scripted,
      process: {
        ...scripted.process,
        spawnOwnedProcess: async (options) => {
          if (failure === "launch") throw new Error("launch failed");
          const launched = await scripted.process.spawnOwnedProcess(options);
          assert.ok(launched.ok);
          return {
            ...launched,
            process: {
              ...launched.process,
              writeStdin: () => Promise.reject(new Error("write failed")),
            },
          };
        },
      },
    });
    assert.deepEqual(await harness.readDefaults(), {
      kind: "fallback",
      choice: { model: "opus", effort: "medium" },
      reason: "Claude Code's settings could not be read before launch.",
    });
    assert.equal((await harness.close()).clean, true);
  });
}
for (const failure of ["cleanup-error", "cleanup-timeout"] as const) {
  test(`settings ${failure} reports unclean cleanup, redacts its cause, and still closes the Run Session`, async (t) => {
    setEnvironmentForTest(t, { CLAUDE_CODE_EFFORT_LEVEL: undefined });
    const bridge = await startPermissionBridge(async () => ({
      decision: "deny",
      message: "Denied for this test.",
    }));
    const attachment = bridge.session("settings-probe", []);
    t.after(() => bridge.close());
    const scripted = scriptedClaude({ answer: "confirm" });
    const harness = await prepare({
      ...scripted,
      process: {
        ...scripted.process,
        spawnOwnedProcess: async (options) => {
          const launched = await scripted.process.spawnOwnedProcess(options);
          assert.ok(launched.ok);
          if (!options.args.includes("--no-session-persistence"))
            return launched;
          const child = launched.process;
          return {
            ...launched,
            process: {
              ...child,
              closeStdin: async (timeout) => {
                await child.closeStdin(timeout);
                return failure === "cleanup-error"
                  ? {
                      kind: "cleanup-error",
                      cause: new Error(`Failed to reap ${attachment.bearer}`),
                    }
                  : { kind: "cleanup-timeout" };
              },
            },
          };
        },
      },
    });
    assert.equal((await harness.readDefaults()).kind, "reported");
    const { turn } = await liveTurnOn(harness);
    const report = await harness.close();
    assert.equal(report.clean, false);
    assert.equal(report.failure?.category, failure);
    assert.equal(report.failure?.phase, "cleanup");
    assert.equal(report.sessions?.length, 1);
    assert.ok(["interrupted", "lost"].includes((await turn.result()).kind));
    assert.equal(
      report.detail,
      "Claude Code's settings process could not be reaped.",
    );
    if (failure === "cleanup-error") {
      assert.ok(report.failure?.cause instanceof Error);
      assert.ok(!report.failure.cause.message.includes(attachment.bearer));
      assert.match(report.failure.cause.message, /Failed to reap/);
    }
  });
}

test("a relaunched Turn pairs settings effort with its own init model", async () => {
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      {
        type: "system",
        subtype: "init",
        session_id: "12121212-1212-4121-8121-121212121212",
        model: scripted.writes.length === 1 ? "prior-model" : "current-model",
      },
    ],
  });
  const harness = await prepare(scripted);
  const { turn: first } = await liveTurnOn(harness);
  scripted.emit({ type: "result", subtype: "success", result: "first done" });
  await first.result();
  scripted.exit({ kind: "exited", status: 0 });
  const { turn, events } = await liveTurnOn(harness, "next");
  scripted.emit({ type: "result", subtype: "success", result: "next done" });
  await turn.result();
  assert.deepEqual(
    events.flatMap((event) =>
      event.kind === "model" ? [event.observation] : [],
    ),
    [{ known: true, model: "current-model", effort: "high" }],
  );
  await harness.close();
});
