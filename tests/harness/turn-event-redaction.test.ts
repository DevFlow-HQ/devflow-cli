import assert from "node:assert/strict";
import test from "node:test";
import { redactionReplay, LOOKALIKE } from "./redaction-replay.js";
import { turnRequest } from "./scripted-claude.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  createTurnEventProducerForTest,
  startPermissionBridge,
  TURN_EVENT_KINDS,
  type ToolCall,
  type TurnEvent,
} from "../../src/harness/harness.js";

const REPLACEMENT = "«redacted-bearer-token»";

test("m10-audit-turn-event-redaction: producer redacts nested facts before retaining the output tail", async (t) => {
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  t.after(() => bridge.close());
  const bearer = bridge.session("redaction").bearer;
  const producer = createTurnEventProducerForTest();
  const live: TurnEvent[] = [];
  producer.subscribe((event) => live.push(event));
  const source: TurnEvent = {
    kind: "tool-call",
    call: {
      callId: "call",
      tool: "command",
      input: `print ${bearer}`,
      cwd: `/tmp/${bearer}`,
      output: { text: "head" + bearer + "z".repeat(29_990) },
      outcome: { kind: "failed", error: `failed ${bearer}` },
      files: [
        {
          path: bearer,
          patch: {
            kind: "structured",
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [bearer],
              },
            ],
          },
        },
      ],
    },
  };
  producer.emit(source);
  producer.seal();
  const retained: TurnEvent[] = [];
  producer.subscribe((event) => retained.push(event));
  assert.deepEqual(live, retained);
  const event = retained[0];
  assert.ok(event?.kind === "tool-call");
  assert.equal(event.call.input, `print ${REPLACEMENT}`);
  assert.equal(event.call.cwd, `/tmp/${REPLACEMENT}`);
  assert.deepEqual(event.call.outcome, {
    kind: "failed",
    error: `failed ${REPLACEMENT}`,
  });
  assert.equal(
    event.call.output?.text,
    REPLACEMENT.slice(-10) + "z".repeat(29_990),
  );
  assert.equal(event.call.output?.secantDropped, true);
  assert.equal(event.call.files?.[0]?.path, REPLACEMENT);
  assert.equal(JSON.stringify(retained).includes(bearer), false);
  assert.equal(
    source.call.input,
    `print ${bearer}`,
    "redaction does not mutate the native observation",
  );
});

for (const kind of ["codex", "claude-code"] as const) {
  test(`m10-audit-turn-event-redaction: ${kind} recorded bodies redact live and retained facts through the production producer`, async (t) => {
    const bridge = await startPermissionBridge(async () => ({
      decision: "deny",
      message: "unused",
    }));
    t.after(() => bridge.close());
    const bearer = bridge.session(kind).bearer;
    const adapter = redactionReplay(t, kind, bearer);
    const prepared = await adapter.prepare({
      workspace: makeTempDir("secant-redaction-ws-"),
      process: createFakeProcess({}),
    });
    assert.ok(prepared.ok);
    const turn = prepared.harness.startTurn({
      ...turnRequest(LOOKALIKE),
      modelChoice: { model: "gpt-6.1-sol" },
    });
    const live: TurnEvent[] = [];
    turn.subscribe((event) => live.push(event));
    const result = await turn.result();
    assert.equal(result.kind, "completed");
    assert.equal(JSON.stringify(result).includes(bearer), false);
    const retained: TurnEvent[] = [];
    turn.subscribe((event) => retained.push(event)).unsubscribe();
    for (const events of [live, retained]) {
      assert.equal(JSON.stringify(events).includes(bearer), false);
      assert.equal(
        JSON.stringify(events).includes(bearer.slice(0, 31)),
        false,
        "a secret's streamed first half is withheld until it can be redacted",
      );
      assert.ok(
        events.some(
          (e) =>
            e.kind === "assistant-content" &&
            e.content === `reply ${REPLACEMENT} ${LOOKALIKE}`,
        ),
      );
      assert.ok(
        events.some(
          (e) =>
            e.kind === "request-raised" &&
            JSON.stringify(e).includes(REPLACEMENT),
        ),
      );
      assert.ok(
        events.some(
          (e) =>
            e.kind === "elicitation-declined" &&
            e.message === `elicitation ${REPLACEMENT}`,
        ),
      );
      assert.ok(
        events.some(
          (e) =>
            e.kind === "tool-call" &&
            e.call.outcome.kind === "failed" &&
            (kind === "codex" ? e.call.output?.text : e.call.outcome.error) ===
              `failed ${REPLACEMENT}`,
        ),
      );
    }
    assert.ok(
      live.some(
        (e) =>
          e.kind === "message-preview" &&
          e.content === `reply ${REPLACEMENT} ${LOOKALIKE}`,
      ),
    );
    if (kind === "codex") {
      assert.equal(
        live.some(
          (event) =>
            event.kind === "tool-preview" && event.call.tool !== "command",
        ),
        false,
        "command deltas do not attach to another tool's identity",
      );
      const command = retained.find(
        (e) =>
          e.kind === "tool-call" &&
          e.call.input === `print ${REPLACEMENT}` &&
          e.call.outcome.kind === "completed",
      );
      assert.ok(command?.kind === "tool-call");
      assert.deepEqual(command.call.output, {
        text: REPLACEMENT.slice(-10) + "z".repeat(29_990),
        incomplete: true,
        secantDropped: true,
      });
    }
  });
}

test("m10-audit-turn-event-redaction: settling mid-secret drops a withheld start of four or more characters from incomplete text", async (t) => {
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  t.after(() => bridge.close());
  const bearer = bridge.session("settle").bearer;
  const start = bearer.slice(0, 31);
  const producer = createTurnEventProducerForTest();
  const live: TurnEvent[] = [];
  producer.subscribe((event) => live.push(event));
  producer.emit({
    kind: "message-preview",
    messageId: "message",
    content: `reply ${start}`,
  });
  producer.emit({
    kind: "thought-preview",
    summaryId: "summary",
    content: `thinking ${start}`,
  });
  producer.emit({
    kind: "tool-preview",
    call: {
      callId: "command",
      tool: "command",
      input: "print",
      output: { text: `head ${start}` },
      outcome: { kind: "running" },
    },
  });
  producer.settlePreview();
  producer.seal();
  const retained: TurnEvent[] = [];
  producer.subscribe((event) => retained.push(event));
  for (const events of [live, retained])
    assert.equal(JSON.stringify(events).includes(start), false);
  assert.deepEqual(
    retained.map((event) =>
      event.kind === "tool-partial"
        ? event.call.output.text
        : "content" in event
          ? event.content
          : event.kind,
    ),
    ["head ", "reply ", "thinking "],
  );
});

test("m10-audit-turn-event-redaction: a running call's own output and its retained completion withhold a secret start", async (t) => {
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  t.after(() => bridge.close());
  const start = bridge.session("running").bearer.slice(0, 31);
  const producer = createTurnEventProducerForTest();
  const live: TurnEvent[] = [];
  producer.subscribe((event) => live.push(event));
  const running: ToolCall = {
    callId: "command",
    tool: "command",
    input: "print",
    output: { text: `head ${start}` },
    outcome: { kind: "running" },
  };
  producer.emit({ kind: "tool-call", call: running });
  producer.emit({
    kind: "tool-call",
    call: { ...running, output: undefined, outcome: { kind: "completed" } },
  });
  assert.equal(JSON.stringify(live).includes(start), false);
  assert.deepEqual(
    live.map((event) =>
      event.kind === "tool-call" ? event.call.output?.text : event.kind,
    ),
    ["head ", "head "],
  );
});

test("m10-audit-turn-event-redaction: a start shorter than four characters is shown and settled exactly", async (t) => {
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  t.after(() => bridge.close());
  const short = `reply ${bridge.session("short").bearer.slice(0, 3)}`;
  const producer = createTurnEventProducerForTest();
  const live: TurnEvent[] = [];
  producer.subscribe((event) => live.push(event));
  producer.emit({ kind: "message-preview", messageId: "m", content: short });
  producer.settlePreview();
  assert.deepEqual(
    live.map((event) => ("content" in event ? event.content : event.kind)),
    [short, short],
  );
});

test("m10-audit-turn-event-redaction: every normalized event kind is redacted, while look-alike user text stays exact", async (t) => {
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  t.after(() => bridge.close());
  const token = bridge.session("all-fields").bearer;
  const producer = createTurnEventProducerForTest();
  const events: TurnEvent[] = [
    {
      kind: "session",
      availability: { state: "unusable", reason: token },
      facts: {
        recoveryCoordinate: { opaque: "coordinate" },
        tools: [token],
        mcp: [{ name: token, status: token }],
        commands: [token],
      },
    },
    {
      kind: "agent-call",
      phase: "raised",
      call: { callId: { opaque: "agent" }, id: "step_done", reason: token },
    },
    { kind: "agent-call", phase: "expired", callId: { opaque: "agent" } },
    {
      kind: "elicitation-declined",
      harness: "codex",
      server: token,
      message: token,
      url: token,
    },
    { kind: "assistant-content", content: token + LOOKALIKE },
    { kind: "message-preview", messageId: "message", content: token },
    { kind: "thought-preview", summaryId: "summary", content: token },
    { kind: "thought", summaryId: "summary", content: token },
    {
      kind: "turn-diff-preview",
      diff: {
        content: token,
        files: [{ path: token, patch: { kind: "unified", content: token } }],
      },
    },
    { kind: "turn-diff", diff: { content: token, files: [] } },
    {
      kind: "tool-preview",
      call: {
        callId: "partial",
        tool: "command",
        input: token,
        output: { text: token },
        outcome: { kind: "running" },
      },
    },
    {
      kind: "tool-partial",
      call: {
        callId: "partial",
        tool: "command",
        input: token,
        output: { text: token, incomplete: true },
        outcome: { kind: "running" },
      },
    },
    {
      kind: "tool-call",
      call: {
        callId: "declined",
        tool: "command",
        input: token,
        outcome: { kind: "declined", reason: token },
      },
    },
    {
      kind: "request-raised",
      request: {
        requestId: { opaque: "approval" },
        shape: {
          kind: "approval",
          tool: token,
          input: token,
          decisions: ["deny"],
        },
      },
    },
    {
      kind: "request-raised",
      request: {
        requestId: { opaque: "clarify" },
        shape: { kind: "clarification", prompt: token },
      },
    },
    {
      kind: "request-answered",
      requestId: { opaque: "clarify" },
      by: "human",
      answer: {
        requestId: { opaque: "clarify" },
        kind: "clarification",
        text: token + LOOKALIKE,
      },
    },
    { kind: "request-expired", requestId: { opaque: "approval" } },
    {
      kind: "context",
      observation: { modelWindows: [{ model: token, limitTokens: 42 }] },
    },
    { kind: "usage", observation: { summary: token } },
    {
      kind: "model",
      observation: { known: true, model: token, effort: token },
      change: {
        requested: { model: token, effort: token },
        outcome: "refused",
        reason: token,
        kept: { model: token },
      },
    },
    {
      kind: "steer",
      steerId: "steer",
      text: token + LOOKALIKE,
      sentAt: "2026-10-09T00:00:00Z",
      settlement: { kind: "delivered", delivery: "within-turn" },
    },
  ];
  const live: TurnEvent[] = [];
  producer.subscribe((event) => live.push(event));
  for (const event of events) producer.emit(event);
  producer.settlePreview();
  producer.seal();
  assert.deepEqual(
    [...new Set(live.map((event) => event.kind))].sort(),
    [...TURN_EVENT_KINDS].sort(),
  );
  assert.equal(JSON.stringify(live).includes(token), false);
  assert.ok(
    live.some(
      (event) =>
        event.kind === "steer" && event.text === REPLACEMENT + LOOKALIKE,
    ),
  );
  const replay: TurnEvent[] = [];
  producer.subscribe((event) => replay.push(event));
  assert.equal(JSON.stringify(replay).includes(token), false);
  assert.equal(replay.filter((event) => event.kind === "thought").length, 1);
  assert.ok(
    replay.some(
      (event) =>
        event.kind === "assistant-content" &&
        event.incomplete &&
        event.content === REPLACEMENT,
    ),
  );
  assert.ok(
    replay.some(
      (event) =>
        event.kind === "tool-partial" && event.call.output.text === REPLACEMENT,
    ),
  );
  producer.emit({ kind: "usage", observation: { summary: token } });
  assert.equal(JSON.stringify(live).includes(token), false);
});
