import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { makeTempDir } from "../helpers/tempDir.js";
import { z } from "zod";
import type { TurnEvent } from "../../src/harness/harness.js";
import {
  init,
  prepare,
  scriptedClaude,
  turnRequest,
} from "./scripted-claude.js";
import { scriptedCodexFacts } from "./scripted-codex-facts.js";

const frame = z.record(z.string(), z.unknown());
function recordedClaudeResult(name: string, file: string) {
  const frames = readFileSync(
    new URL(`./fixtures/claude-code/${name}/${file}`, import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => frame.parse(JSON.parse(line)));
  const result = frames.find((value) => value.type === "result");
  assert.ok(result);
  return result;
}

test("m10-observed-harness-facts: authentic Claude counters and per-model capacities stay distinct and precede result", async (t) => {
  const recorded = recordedClaudeResult("plain", "turn-1.stdout");
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [init, recorded],
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn(turnRequest("recorded"));
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  assert.equal((await turn.result()).kind, "completed");
  assert.deepEqual(
    events.filter((event) => event.kind === "context"),
    [
      {
        kind: "context",
        observation: {
          modelWindows: [
            { model: "claude-haiku-4-5-20251001", limitTokens: 200000 },
            { model: "claude-opus-5[1m]", limitTokens: 1000000 },
          ],
        },
      },
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "usage"),
    [
      {
        kind: "usage",
        observation: {
          summary:
            "exchange: input 2, output 4 tokens, cache read 0 tokens, cache creation 15707 tokens; cost estimate USD 0.158137",
        },
      },
    ],
  );
  const count = events.length;
  scripted.emit({ type: "future_message" });
  await harness.close();
  assert.equal(events.length, count);
});

// Replay authentic stdout through the production Adapter and an injected Process.
// Only request ids and Workspace placeholders change; fixtures stay byte-faithful.
async function codexFacts(
  t: TestContext,
  extra: readonly object[] = [],
  workspace = makeTempDir("secant-observed-codex-"),
  summaryCase?: { provider: string; model: string; reroute?: string },
  qualification?: {
    mutate: (schema: unknown) => void;
    limits: readonly string[];
  },
  recordingCase = "test-repair",
) {
  const adapter = scriptedCodexFacts(
    extra,
    workspace,
    summaryCase,
    qualification?.mutate,
    recordingCase,
  );
  t.after(() => adapter.close());
  const prepared = await adapter.prepare({ workspace });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  t.after(() => prepared.harness.close());
  assert.deepEqual(
    prepared.harness.profile.displayFactLimits,
    qualification?.limits ?? [],
  );
  const turn = prepared.harness.startTurn({
    ...turnRequest("recorded"),
    modelChoice: { model: "gpt-6.1-sol" },
  });
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  assert.equal((await turn.result()).kind, "completed");
  return events;
}

test("m10-observed-harness-facts: authentic Codex total and last usage are not context occupancy", async (t) => {
  const events = await codexFacts(t);
  assert.deepEqual(events.filter((event) => event.kind === "context").at(-1), {
    kind: "context",
    observation: { limitTokens: 258400 },
  });
  assert.deepEqual(events.filter((event) => event.kind === "usage").at(-1), {
    kind: "usage",
    observation: {
      summary:
        "total: total 125080 tokens, input 124304 tokens, cache read 80768 tokens, cache write 0 tokens, output 776 tokens, reasoning output 52 tokens; last: total 25513 tokens, input 25435 tokens, cache read 24960 tokens, cache write 0 tokens, output 78 tokens, reasoning output 0 tokens",
    },
  });
  assert.equal(
    events.some((event) => event.kind === "activity"),
    false,
  );
  assert.ok(events.some((event) => event.kind === "tool-call"));
});

test("m10-observed-harness-facts: recorded Codex observations survive Windows Workspace paths in nested JSON", async (t) => {
  const events = await codexFacts(t, [], "D:\\a\\secant\\workspace");
  assert.deepEqual(events.filter((event) => event.kind === "context").at(-1), {
    kind: "context",
    observation: { limitTokens: 258400 },
  });
  assert.equal(events.filter((event) => event.kind === "usage").length, 5);
});

test("m10-observed-harness-facts: Claude noise stays private, unfamiliar tools stay other and malformed optional figures stay absent", async (t) => {
  // Synthetic semantic overlays use qualified frame shapes. They do not qualify
  // a provider summary, occupancy percentage, or reasoning duration.
  const recorded = recordedClaudeResult("plain", "turn-1.stdout");
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      init,
      { type: "future_message", description: "do not display" },
      { type: "telemetry", metric: "do not display" },
      { type: "assistant", message: "malformed" },
      {
        type: "stream_event",
        event: {
          delta: {
            type: "thinking_delta",
            thinking: "private",
            duration_ms: 42,
          },
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "private" },
            {
              type: "tool_use",
              id: "call",
              name: "UnfamiliarWork",
              input: { path: "README.md" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "call", content: "done" },
          ],
        },
      },
      {
        ...recorded,
        usage: {
          input_tokens: "wrong",
          output_tokens: 0,
          cache_read_input_tokens: 7,
        },
        total_cost_usd: "wrong",
        modelUsage: {
          unreported: { contextWindow: "wrong" },
          reported: { contextWindow: 2 },
        },
        percentage: 99,
        duration_ms: 42,
      },
    ],
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn(turnRequest("partial"));
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  assert.equal((await turn.result()).kind, "completed");
  assert.equal(
    events.filter((event) => event.kind === "activity").length,
    1,
    "only the existing Session description is activity",
  );
  const calls = events
    .filter((event) => event.kind === "tool-call")
    .map((event) => event.call);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.callId, calls[1]?.callId);
  assert.deepEqual(
    calls.map((call) => ({
      tool: call.tool,
      input: call.input,
      outcome: call.outcome,
    })),
    [
      {
        tool: "other",
        input: 'UnfamiliarWork · {"path":"README.md"}',
        outcome: { kind: "running" },
      },
      {
        tool: "other",
        input: 'UnfamiliarWork · {"path":"README.md"}',
        outcome: { kind: "completed" },
      },
    ],
  );
  assert.notEqual(calls[0]?.callId, "call");
  assert.deepEqual(
    events.filter((event) => event.kind === "context"),
    [
      {
        kind: "context",
        observation: { modelWindows: [{ model: "reported", limitTokens: 2 }] },
      },
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "usage"),
    [
      {
        kind: "usage",
        observation: {
          summary: "exchange: output 0 tokens, cache read 7 tokens",
        },
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /thinking|duration|percentage|do not display|private/,
  );
});

const recordedTarget = {
  threadId: "01a103a8-7606-7072-8fc9-57d05e854bd3",
  turnId: "01a103a8-76a7-7023-b718-c7d86e0e36a2",
};
for (const [description, tokenUsage, context, summary] of [
  ["missing", {}, {}, ""],
  [
    "inconsistent",
    {
      total: { totalTokens: 1, inputTokens: 500, outputTokens: 900 },
      last: { outputTokens: 0 },
      modelContextWindow: 2,
    },
    { limitTokens: 2 },
    "total: total 1 tokens, input 500 tokens, output 900 tokens; last: output 0 tokens",
  ],
] as const) {
  test(`m10-observed-harness-facts: Codex ${description} report replaces fields without repairing figures`, async (t) => {
    const events = await codexFacts(t, [
      {
        method: "thread/tokenUsage/updated",
        params: { ...recordedTarget, tokenUsage },
      },
    ]);
    assert.deepEqual(
      events.filter((event) => event.kind === "context").at(-1),
      { kind: "context", observation: context },
    );
    assert.deepEqual(events.filter((event) => event.kind === "usage").at(-1), {
      kind: "usage",
      observation: { summary },
    });
    assert.equal(
      events.some((event) => event.kind === "activity"),
      false,
    );
  });
}

test("m10-observed-harness-facts: Codex ignores foreign accounting and unknown/raw messages but retains meaningful tools and failures", async (t) => {
  const events = await codexFacts(t, [
    {
      method: "thread/tokenUsage/updated",
      params: {
        ...recordedTarget,
        turnId: "foreign",
        tokenUsage: { modelContextWindow: 1 },
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        ...recordedTarget,
        threadId: "foreign",
        tokenUsage: { modelContextWindow: 1 },
      },
    },
    { method: "thread/tokenUsage/updated", params: { threadId: 7 } },
    { method: "account/rateLimits/updated", params: { rateLimits: {} } },
    {
      method: "item/reasoning/textDelta",
      params: { ...recordedTarget, delta: "private raw reasoning" },
    },
    { method: "future/message", params: { message: "do not display" } },
    {
      method: "item/completed",
      params: { ...recordedTarget, item: { id: "future", type: "futureType" } },
    },
    {
      method: "item/completed",
      params: {
        ...recordedTarget,
        item: {
          id: "unfamiliar",
          type: "dynamicToolCall",
          tool: "UnfamiliarWork",
          status: "completed",
        },
      },
    },
    {
      method: "error",
      params: {
        ...recordedTarget,
        error: { message: "retrying genuine failure" },
        willRetry: true,
      },
    },
  ]);
  assert.deepEqual(events.filter((event) => event.kind === "context").at(-1), {
    kind: "context",
    observation: { limitTokens: 258400 },
  });
  assert.deepEqual(
    events.filter((event) => event.kind === "activity"),
    [
      {
        kind: "activity",
        description:
          "Codex is retrying after an error: retrying genuine failure",
      },
    ],
  );
  assert.equal(
    events.some(
      (event) =>
        event.kind === "tool-call" &&
        event.call.input.includes("UnfamiliarWork"),
    ),
    false,
    "synthetic dynamic-tool fields are not native qualification",
  );
  assert.ok(
    events.some(
      (event) => event.kind === "tool-call" && event.call.tool === "command",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /private raw reasoning|futureType|do not display/,
  );
});

test("m10-observed-harness-facts: authentic Claude message usage is visible before terminal exchange accounting", async (t) => {
  const frames = readFileSync(
    new URL("./fixtures/claude-code/plain/turn-1.stdout", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => frame.parse(JSON.parse(line)));
  const start = frames.find(
    (value) =>
      value.type === "stream_event" &&
      frame.parse(value.event).type === "message_start",
  );
  const assistant = frames.find((value) => value.type === "assistant");
  const delta = frames.find(
    (value) =>
      value.type === "stream_event" &&
      frame.parse(value.event).type === "message_delta",
  );
  assert.ok(start);
  assert.ok(assistant);
  assert.ok(delta);
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      start,
      assistant,
      delta,
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "ready" }] },
      },
    ],
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn(turnRequest("message accounting"));
  const events: TurnEvent[] = [];
  const observed = Promise.withResolvers<void>();
  turn.subscribe((event) => {
    events.push(event);
    if (event.kind === "assistant-content" && event.content === "ready")
      observed.resolve();
  });
  await observed.promise;
  assert.deepEqual(
    events
      .filter((event) => event.kind === "usage")
      .map((event) => event.observation.summary),
    [
      "message: input 2, output 1 tokens, cache read 0 tokens, cache creation 15707 tokens",
      "message: input 2, output 1 tokens, cache read 0 tokens, cache creation 15707 tokens",
      "message: input 2, output 4 tokens, cache read 0 tokens, cache creation 15707 tokens",
    ],
  );
  assert.equal(
    events.some((event) => event.kind === "context"),
    false,
  );
  scripted.emit(recordedClaudeResult("plain", "turn-1.stdout"));
  assert.equal((await turn.result()).kind, "completed");
  assert.match(
    events.filter((event) => event.kind === "usage").at(-1)?.observation
      .summary ?? "",
    /^exchange: input 2, output 4 tokens/,
  );
});

function recordedToolFrames(caseName: string, files: readonly string[]) {
  return files.flatMap((file) =>
    readFileSync(
      new URL(`./fixtures/claude-code/${caseName}/${file}`, import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => frame.parse(JSON.parse(line)))
      .filter((value) => value.type === "assistant" || value.type === "user"),
  );
}
async function claudeTools(
  t: TestContext,
  frames: readonly Record<string, unknown>[],
) {
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      ...frames,
      { type: "result", subtype: "success", is_error: false },
    ],
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn(turnRequest("tools"));
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  assert.equal((await turn.result()).kind, "completed");
  const before = events.length;
  scripted.emit(...frames);
  assert.equal(
    events.length,
    before,
    "no tool fact follows the authoritative result",
  );
  return events
    .filter((event) => event.kind === "tool-call")
    .map((event) => event.call);
}
test("m10-observed-harness-facts: authentic Claude Read/Edit ids, main inputs and reported line counts are qualified", async (t) => {
  const calls = await claudeTools(
    t,
    recordedToolFrames("test-repair", [
      "stdout-0.stdout",
      "stdout-final.stdout",
    ]),
  );
  assert.deepEqual(
    calls.map((call) => ({
      tool: call.tool,
      input: call.input,
      outcome: call.outcome,
      count: call.count,
    })),
    [
      {
        tool: "read",
        input: "«WORKSPACE»/sum.mjs",
        outcome: { kind: "running" },
        count: undefined,
      },
      {
        tool: "read",
        input: "«WORKSPACE»/sum.mjs",
        outcome: { kind: "completed" },
        count: { value: 2, unit: "lines" },
      },
      {
        tool: "read",
        input: "«WORKSPACE»/sum.test.mjs",
        outcome: { kind: "running" },
        count: undefined,
      },
      {
        tool: "read",
        input: "«WORKSPACE»/sum.test.mjs",
        outcome: { kind: "completed" },
        count: { value: 5, unit: "lines" },
      },
      {
        tool: "file-change",
        input: "«WORKSPACE»/sum.mjs",
        outcome: { kind: "running" },
        count: undefined,
      },
      {
        tool: "file-change",
        input: "«WORKSPACE»/sum.mjs",
        outcome: { kind: "completed" },
        count: undefined,
      },
    ],
  );
  assert.equal(calls[0]?.callId, calls[1]?.callId);
  assert.equal(calls[2]?.callId, calls[3]?.callId);
  assert.notEqual(calls[0]?.callId, calls[2]?.callId);
  assert.equal(
    calls.every((call) => call.parentCallId === undefined),
    true,
  );
  assert.doesNotMatch(JSON.stringify(calls), /toolu_/);
});
test("m10-observed-harness-facts: authentic Claude Glob and Write preserve reported fields", async (t) => {
  const glob = await claudeTools(
    t,
    recordedToolFrames("matt-front", ["implement-0.stdout"]),
  );
  assert.equal(glob[0]?.tool, "search");
  assert.equal(glob[0]?.input, "**/*");
  assert.equal(glob[1]?.callId, glob[0]?.callId);
  assert.deepEqual(glob[1]?.count, { value: 2, unit: "files" });
  const write = await claudeTools(
    t,
    recordedToolFrames("model-change", ["turn-1a.stdout", "turn-1b.stdout"]),
  );
  assert.deepEqual(
    write.map((call) => [call.tool, call.input, call.outcome.kind]),
    [
      ["file-change", "«WORKSPACE»/note.txt", "running"],
      ["file-change", "«WORKSPACE»/note.txt", "completed"],
    ],
  );
});
test("m10-observed-harness-facts: authentic Claude rejected Write is declined, independent of Turn success", async (t) => {
  const calls = await claudeTools(
    t,
    recordedToolFrames("steer-cancel", ["turn-1.stdout", "cancelled.stdout"]),
  );
  const declined = calls.find((call) => call.outcome.kind === "declined");
  assert.ok(declined?.outcome.kind === "declined");
  assert.match(declined.outcome.reason ?? "", /tool use was rejected/);
  assert.equal(declined.tool, "file-change");
  assert.equal(declined.count, undefined);
});
test("m10-audit-claude-fact-translation: authentic Claude MCP names translate and result text does not infer refusal from elicitation", async (t) => {
  const calls = await claudeTools(
    t,
    recordedToolFrames("elicitation-declined", [
      "before.stdout",
      "after.stdout",
    ]),
  );
  assert.deepEqual(
    calls
      .filter((call) => call.tool === "mcp")
      .map((call) => [call.tool, call.input, call.outcome.kind]),
    [
      ["mcp", "setup/setup · {}", "running"],
      ["mcp", "setup/setup · {}", "completed"],
    ],
  );
});
test("m10-observed-harness-facts: authentic Codex call ids correlate statuses and main inputs without exposing native ids", async (t) => {
  const calls = (await codexFacts(t))
    .filter((event) => event.kind === "tool-call")
    .map((event) => event.call);
  const first = calls[0]!;
  assert.equal(first.tool, "command");
  assert.equal(first.input, "/bin/bash -lc pwd");
  assert.equal(first.outcome.kind, "running");
  assert.equal(calls[1]?.callId, first.callId);
  assert.equal(calls[1]?.outcome.kind, "completed");
  assert.ok(calls.some((call) => call.outcome.kind === "failed"));
  assert.ok(
    calls.some(
      (call) => call.tool === "file-change" && call.input.endsWith("sum.mjs"),
    ),
  );
  assert.equal(
    calls.every(
      (call) => call.count === undefined && call.parentCallId === undefined,
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(calls), /call_qIdYVG/);
});

test("m10-observed-harness-facts: authentic Claude reused native ids are scoped to each Secant Turn and Session", async (t) => {
  const frames = recordedToolFrames("test-repair", [
    "stdout-0.stdout",
    "stdout-final.stdout",
  ]);
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      ...frames,
      { type: "result", subtype: "success", is_error: false },
    ],
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const ids: string[] = [];
  for (const session of ["planning", "planning", "another"]) {
    const turn = harness.startTurn({
      ...turnRequest(`turn-${ids.length}`),
      session,
    });
    const events: TurnEvent[] = [];
    turn.subscribe((event) => events.push(event));
    assert.equal((await turn.result()).kind, "completed");
    const calls = events
      .filter((event) => event.kind === "tool-call")
      .map((event) => event.call);
    assert.equal(calls[0]?.callId, calls[1]?.callId);
    ids.push(calls[0]!.callId);
  }
  assert.equal(new Set(ids).size, 3);
});
test("m10-observed-harness-facts: malformed and absent optional Claude counts stay unknown while observed errors remain separate", async (t) => {
  const frames = recordedToolFrames("test-repair", [
    "stdout-0.stdout",
    "stdout-final.stdout",
  ]);
  const malformed = frames.map((value) =>
    frame.parse(
      JSON.parse(
        JSON.stringify(value).replace('"numLines":2', '"numLines":"malformed"'),
      ),
    ),
  );
  const calls = await claudeTools(t, malformed);
  assert.equal(calls[1]?.count, undefined);
  assert.deepEqual(calls[1]?.outcome, { kind: "completed" });
  const failure = await claudeTools(t, [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "one",
            name: "Read",
            input: { file_path: "file.ts" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "one",
            is_error: true,
            content: "Observed failure",
          },
        ],
      },
    },
  ]);
  assert.deepEqual(failure[1]?.outcome, {
    kind: "failed",
    error: "Observed failure",
  });
  assert.equal(failure[1]?.count, undefined);
});
test("m10-observed-harness-facts: authentic Claude Secant Agent calls never duplicate as ordinary MCP tool rows", async (t) => {
  const calls = await claudeTools(
    t,
    recordedToolFrames("agent-call", ["before.stdout"]),
  );
  assert.equal(
    calls.some(
      (call) => call.tool === "mcp" && call.input.includes("secant/step_done"),
    ),
    false,
  );
  assert.ok(
    calls.some(
      (call) => call.tool === "other" && call.input.includes("ToolSearch"),
    ),
  );
});

test("m10-observed-harness-facts: authentic Codex external MCP items preserve input and exclude Secant declarations", async (t) => {
  const recorded = z
    .object({
      traffic: z.array(
        z.object({ direction: z.string(), line: z.string().optional() }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("./fixtures/codex/agent-calls/case.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const notices = recorded.traffic.flatMap((entry) => {
    if (entry.direction !== "stdout" || entry.line === undefined) return [];
    const value = z
      .object({
        method: z.string().optional(),
        params: z
          .object({ item: z.looseObject({ type: z.string() }) })
          .optional(),
      })
      .safeParse(JSON.parse(entry.line));
    return value.success &&
      ["item/started", "item/completed"].includes(value.data.method ?? "") &&
      value.data.params?.item.type === "mcpToolCall"
      ? [
          {
            method: value.data.method,
            params: { item: value.data.params.item },
          },
        ]
      : [];
  });
  const events = await codexFacts(t, notices);
  const calls = events.flatMap((event) =>
    event.kind === "tool-call" && event.call.tool === "mcp" ? [event.call] : [],
  );
  assert.deepEqual(
    calls.map((call) => [call.input, call.outcome.kind]),
    [
      ["recording_external/needs_approval · {}", "running"],
      ["recording_external/needs_approval · {}", "completed"],
      ["recording_external/ask_form · {}", "running"],
      ["recording_external/ask_form · {}", "completed"],
      ["recording_external/ask_url · {}", "running"],
      ["recording_external/ask_url · {}", "completed"],
    ],
  );
  assert.equal(calls[0]?.callId, calls[1]?.callId);
  assert.notEqual(calls[0]?.callId, calls[2]?.callId);
  assert.doesNotMatch(JSON.stringify(calls), /step_done|call_iN7t/);
});

test("m10-observed-harness-facts: unqualified Codex command refusal and file-change failure/refusal statuses remain absent", async (t) => {
  const events = await codexFacts(t, [
    {
      method: "item/started",
      params: {
        ...recordedTarget,
        item: {
          type: "mcpToolCall",
          id: "unqualified-mcp",
          server: "external",
          tool: "tool",
          arguments: {},
          status: "inProgress",
        },
      },
    },
    {
      method: "item/completed",
      params: {
        ...recordedTarget,
        item: {
          type: "mcpToolCall",
          id: "unqualified-mcp",
          server: "external",
          tool: "tool",
          arguments: {},
          status: "failed",
        },
      },
    },
    {
      method: "item/started",
      params: {
        ...recordedTarget,
        item: {
          type: "commandExecution",
          id: "unqualified-command",
          command: "do work",
          status: "inProgress",
        },
      },
    },
    {
      method: "item/completed",
      params: {
        ...recordedTarget,
        item: {
          type: "commandExecution",
          id: "unqualified-command",
          command: "do work",
          status: "declined",
        },
      },
    },
    {
      method: "item/started",
      params: {
        ...recordedTarget,
        item: {
          type: "fileChange",
          id: "unqualified-file",
          changes: [
            { path: "file.ts", kind: { type: "update", move_path: null } },
          ],
          status: "inProgress",
        },
      },
    },
    {
      method: "item/completed",
      params: {
        ...recordedTarget,
        item: {
          type: "fileChange",
          id: "unqualified-file",
          changes: [
            { path: "file.ts", kind: { type: "update", move_path: null } },
          ],
          status: "failed",
        },
      },
    },
    {
      method: "item/completed",
      params: {
        ...recordedTarget,
        item: {
          type: "fileChange",
          id: "unqualified-file",
          changes: [
            { path: "file.ts", kind: { type: "update", move_path: null } },
          ],
          status: "declined",
        },
      },
    },
  ]);
  const calls = events.flatMap((event) =>
    event.kind === "tool-call" &&
    ["do work", "update file.ts", "external/tool · {}"].includes(
      event.call.input,
    )
      ? [event.call]
      : [],
  );
  assert.deepEqual(
    calls.map((call) => [call.tool, call.input, call.outcome.kind]),
    [
      ["mcp", "external/tool · {}", "running"],
      ["command", "do work", "running"],
      ["file-change", "update file.ts", "running"],
    ],
  );
});

test("m10-observed-harness-facts: authentic Claude Edit retains supplied hunks on its exact call, requested edits prove nothing", async (t) => {
  const calls = await claudeTools(
    t,
    recordedToolFrames("test-repair", [
      "stdout-0.stdout",
      "stdout-final.stdout",
    ]),
  );
  const edits = calls.filter((call) => call.tool === "file-change");
  assert.equal(edits[0]?.files, undefined);
  assert.deepEqual(edits[1]?.files, [
    {
      path: "«WORKSPACE»/sum.mjs",
      patch: {
        kind: "structured",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              "-export const sum = (a, b) => a - b;",
              "+export const sum = (a, b) => a + b;",
            ],
          },
        ],
      },
    },
  ]);
  assert.equal(edits[0]?.callId, edits[1]?.callId);
  const writes = await claudeTools(
    t,
    recordedToolFrames("model-change", ["turn-1a.stdout", "turn-1b.stdout"]),
  );
  assert.equal(writes[0]?.files, undefined);
  assert.deepEqual(writes[1]?.files, [
    {
      path: "«WORKSPACE»/note.txt",
      kind: "create",
      patch: { kind: "structured", hunks: [] },
    },
  ]);
  const rejected = await claudeTools(
    t,
    recordedToolFrames("steer-cancel", ["turn-1.stdout", "cancelled.stdout"]),
  );
  assert.equal(
    rejected.find((call) => call.outcome.kind === "declined")?.files,
    undefined,
  );
});

test("m10-observed-harness-facts: authentic Codex per-call patches and cumulative snapshots remain separately associated and precede result", async (t) => {
  const workspace = makeTempDir("secant-diff-qualified-");
  const events = await codexFacts(t, [], workspace);
  const calls = events.filter(
    (event) => event.kind === "tool-call" && event.call.tool === "file-change",
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.kind === "tool-call" && calls[1]?.kind === "tool-call");
  assert.deepEqual(calls[0].call.files, [{ path: join(workspace, "sum.mjs") }]);
  assert.deepEqual(calls[1].call.files, [
    {
      path: join(workspace, "sum.mjs"),
      kind: "update",
      patch: {
        kind: "unified",
        content:
          "@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n",
      },
    },
  ]);
  const diffs = events.filter(
    (event) => event.kind === "turn-diff-preview" || event.kind === "turn-diff",
  );
  assert.equal(diffs.length, 5);
  const final = diffs.at(-1);
  assert.ok(final?.kind === "turn-diff");
  assert.deepEqual(final.diff.files, [{ path: "sum.mjs" }]);
  assert.equal(
    final.diff.content,
    "diff --git a/sum.mjs b/sum.mjs\nindex 2abed468420c79958609997d46bac81390728831..bc5f04ddb9e58bfd6e0038a714603f93a9621dab\n--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n",
  );
  for (const diff of diffs) assert.deepEqual(diff.diff, final.diff);
  assert.equal("callId" in final, false);
});

test("m10-observed-harness-facts: Claude interleaved edits use result paths, preserve supplied patches and ignore absent/malformed optional facts", async (t) => {
  const result = (id: string, structured: object) => ({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content: "updated" }],
    },
    tool_use_result: structured,
  });
  const calls = await claudeTools(t, [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "A",
            name: "Edit",
            input: {
              file_path: "requested.ts",
              old_string: "old",
              new_string: "new",
            },
          },
          {
            type: "tool_use",
            id: "B",
            name: "Edit",
            input: { file_path: "requested.ts" },
          },
          {
            type: "tool_use",
            id: "C",
            name: "Write",
            input: { file_path: "requested.ts", content: "new" },
          },
        ],
      },
    },
    result("B", {
      filePath: "observed-B.ts",
      structuredPatch: [
        {
          oldStart: 9,
          oldLines: 0,
          newStart: 9,
          newLines: 1,
          lines: ["+B_PATCH"],
        },
      ],
      additions: 1,
    }),
    result("A", {
      filePath: "observed-A.ts",
      type: "unknown",
      structuredPatch: "malformed",
      content: "do not reconstruct",
    }),
    result("C", { content: "requested content is not a diff" }),
  ]);
  assert.equal(calls[3]?.callId, calls[1]?.callId);
  assert.equal(calls[4]?.callId, calls[0]?.callId);
  assert.deepEqual(calls[3]?.files, [
    {
      path: "observed-B.ts",
      patch: {
        kind: "structured",
        hunks: [
          {
            oldStart: 9,
            oldLines: 0,
            newStart: 9,
            newLines: 1,
            lines: ["+B_PATCH"],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(calls[4]?.files, [{ path: "observed-A.ts" }]);
  assert.equal(calls[5]?.files, undefined);
});

test("m10-observed-harness-facts: Codex interleaving and foreign diffs cannot transfer per-call patches or invent kinds/counts", async (t) => {
  const item = (
    method: string,
    id: string,
    status: string,
    changes: readonly object[],
  ) => ({
    method,
    params: {
      ...recordedTarget,
      item: { type: "fileChange", id, status, changes },
    },
  });
  const content =
    "diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -1 +1 @@\n" +
    "+large supplied content\n".repeat(1600) +
    "LAST_NATIVE_DIFF";
  const events = await codexFacts(t, [
    item("item/started", "A", "inProgress", [
      { path: "same.ts", diff: "A_REQUEST" },
    ]),
    item("item/started", "B", "inProgress", [
      { path: "same.ts", diff: "B_REQUEST" },
    ]),
    item("item/completed", "B", "completed", [
      {
        path: "same.ts",
        kind: { type: "update", move_path: null },
        diff: "B_PATCH",
        additions: 9,
      },
    ]),
    item("item/completed", "A", "completed", [
      { path: "same.ts", kind: { type: "unknown" }, diff: 7 },
    ]),
    {
      method: "turn/diff/updated",
      params: { ...recordedTarget, diff: content },
    },
    {
      method: "turn/diff/updated",
      params: { ...recordedTarget, turnId: "foreign", diff: "FOREIGN_TURN" },
    },
    {
      method: "turn/diff/updated",
      params: {
        ...recordedTarget,
        threadId: "foreign",
        diff: "FOREIGN_THREAD",
      },
    },
    { method: "turn/diff/updated", params: { ...recordedTarget, diff: 7 } },
  ]);
  const calls = events
    .filter((event) => event.kind === "tool-call")
    .map((event) => event.call)
    .slice(-4);
  assert.deepEqual(
    calls.map((call) => call.outcome.kind),
    ["running", "running", "completed", "completed"],
  );
  assert.equal(calls[0]?.callId, calls[3]?.callId);
  assert.equal(calls[1]?.callId, calls[2]?.callId);
  assert.deepEqual(calls[2]?.files, [
    {
      path: "same.ts",
      kind: "update",
      patch: { kind: "unified", content: "B_PATCH" },
    },
  ]);
  assert.deepEqual(calls[3]?.files, [{ path: "same.ts" }]);
  const final = events.find((event) => event.kind === "turn-diff");
  assert.ok(final?.kind === "turn-diff");
  assert.deepEqual(final.diff, { content, files: [{ path: "large.ts" }] });
  assert.doesNotMatch(JSON.stringify(events), /FOREIGN_TURN|FOREIGN_THREAD/);
});

test("m10-observed-harness-facts: Codex only qualifies update kinds with explicit null move metadata", async (t) => {
  const events = await codexFacts(
    t,
    [undefined, "new.ts"].map((move_path, index) => ({
      method: "item/completed",
      params: {
        ...recordedTarget,
        item: {
          type: "fileChange",
          id: `unqualified-move-${index}`,
          status: "completed",
          changes: [
            {
              path: "source.ts",
              kind: {
                type: "update",
                ...(move_path === undefined ? {} : { move_path }),
              },
              diff: "SUPPLIED_PATCH",
            },
          ],
        },
      },
    })),
  );
  const calls = events
    .filter((event) => event.kind === "tool-call")
    .map((event) => event.call)
    .slice(-2);
  assert.equal(calls.length, 2);
  for (const call of calls)
    assert.deepEqual(call.files, [
      {
        path: "source.ts",
        patch: { kind: "unified", content: "SUPPLIED_PATCH" },
      },
    ]);
});

test("m10-observed-harness-facts: authentic Codex commands retain cwd, final output and structured exits without duplicating deltas", async (t) => {
  const workspace = makeTempDir("secant-command-facts-");
  const events = await codexFacts(t, [], workspace);
  const calls = events.flatMap((event) =>
    event.kind === "tool-call" && event.call.tool === "command"
      ? [event.call]
      : [],
  );
  const pwd = calls.find(
    (call) =>
      call.input === "/bin/bash -lc pwd" && call.outcome.kind === "completed",
  );
  assert.ok(pwd);
  assert.equal(pwd.cwd, workspace);
  assert.deepEqual(pwd.output, { text: workspace + "\n" });
  assert.equal(pwd.exitCode, 0);
  assert.equal(pwd.nativeOmission, undefined);
  const tests = calls.filter(
    (call) =>
      call.input === "/bin/bash -lc 'node --test sum.test.mjs'" &&
      call.outcome.kind !== "running",
  );
  assert.deepEqual(
    tests.map((call) => [call.outcome.kind, call.exitCode]),
    [
      ["failed", 1],
      ["completed", 0],
    ],
  );
  assert.equal(tests[0]?.output?.text.split("ℹ tests 1").length, 2);
  assert.match(tests[0]?.output?.text ?? "", /'test failed'/);
  assert.match(tests[1]?.output?.text ?? "", /ℹ pass 1/);
  const failedRead = calls.find((call) => call.exitCode === 2);
  assert.equal(
    failedRead?.output?.text,
    "sed: can't read package.json: No such file or directory\n",
  );
  const previews = events.filter((event) => event.kind === "tool-preview");
  assert.ok(previews.length > 0);
  assert.ok(previews.every((event) => event.call.output !== undefined));
});

// Authentic item bodies qualify null output independently. Copied variants below
// prove field-boundary behavior and semantic races, not additional native shapes.
function approvalCommand() {
  const traffic = z
    .object({ traffic: z.array(z.object({ line: z.string().optional() })) })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("./fixtures/codex/approval/case.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const schema = z.object({
    method: z.literal("item/completed"),
    params: z.object({
      item: z.looseObject({
        type: z.literal("commandExecution"),
        id: z.string(),
        command: z.string(),
        cwd: z.string(),
        aggregatedOutput: z.null(),
        exitCode: z.literal(0),
        status: z.literal("completed"),
      }),
    }),
  });
  for (const entry of traffic.traffic) {
    if (!entry.line?.startsWith("{")) continue;
    const parsed = schema.safeParse(JSON.parse(entry.line));
    if (parsed.success) return parsed.data.params.item;
  }
  throw new Error("authentic approval command missing");
}
test("m10-observed-harness-facts: authentic Codex null final output stays unavailable with observed zero exit", async (t) => {
  const item = approvalCommand();
  const events = await codexFacts(t, [
    { method: "item/completed", params: { item } },
  ]);
  const call = events
    .flatMap((event) =>
      event.kind === "tool-call" && event.call.input === item.command
        ? [event.call]
        : [],
    )
    .at(-1);
  assert.ok(call);
  assert.equal(call.output, undefined);
  assert.equal(call.exitCode, 0);
});
for (const final of [
  "replace",
  "empty",
  "null",
  "absent",
  "malformed",
  "unmatched",
] as const)
  test(`m10-observed-harness-facts: synthetic Codex ${final} reconciles repeated bounded deltas by identity and drains partials before result`, async (t) => {
    const recorded = approvalCommand();
    const item = {
      ...recorded,
      id: "synthetic-command",
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    };
    const terminal = {
      ...item,
      status: "completed",
      ...(final === "replace"
        ? { aggregatedOutput: "FINAL", exitCode: 0 }
        : final === "empty"
          ? { aggregatedOutput: "", exitCode: 0 }
          : final === "malformed"
            ? { aggregatedOutput: 42, exitCode: "exit 0", cwd: 17 }
            : {}),
    };
    const { aggregatedOutput: _omitted, ...absent } = terminal;
    const events = await codexFacts(t, [
      { method: "item/started", params: { item } },
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: item.id, delta: "OLD" + "a".repeat(29_999) },
      },
      { method: "item/started", params: { item } },
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "foreign-item", delta: "FOREIGN" },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: item.id, delta: "Z" },
      },
      ...(final === "unmatched"
        ? []
        : [
            {
              method: "item/completed",
              params: { item: final === "absent" ? absent : terminal },
            },
          ]),
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: item.id, delta: "LATE" },
      },
    ]);
    const calls = events.flatMap((event) =>
      (event.kind === "tool-call" || event.kind === "tool-partial") &&
      event.call.input === item.command
        ? [event]
        : [],
    );
    const last = calls.at(-1);
    assert.ok(last);
    const output = last.call.output;
    assert.deepEqual(
      output,
      final === "replace"
        ? { text: "FINAL" }
        : final === "empty"
          ? { text: "" }
          : {
              text:
                final === "unmatched"
                  ? "a".repeat(29_995) + "ZLATE"
                  : "a".repeat(29_999) + "Z",
              secantDropped: true,
              incomplete: true,
            },
    );
    assert.equal(
      last.kind,
      final === "unmatched" ? "tool-partial" : "tool-call",
    );
    assert.equal(
      last.call.outcome.kind,
      final === "unmatched" ? "running" : "completed",
    );
    if (final === "malformed" || final === "unmatched")
      assert.equal(last.call.exitCode, undefined);
    assert.ok(
      events.every(
        (event) =>
          event.kind !== "tool-preview" ||
          (event.call.output?.text.length ?? 0) <= 30_000,
      ),
    );
  });

test("m10-audit-claude-fact-translation: unidentified Claude replies receive distinct identities", async (t) => {
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      },
      { type: "result", subtype: "success" },
    ],
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn(turnRequest("unidentified replies"));
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  assert.equal((await turn.result()).kind, "completed");
  const messages = events.filter((event) => event.kind === "assistant-content");
  assert.deepEqual(
    messages.map((event) => event.content),
    ["first", "second"],
  );
  for (const message of messages) assert.ok(message.messageId);
  assert.notEqual(messages[0]?.messageId, messages[1]?.messageId);
});

test("m10-audit-claude-fact-translation: child assistant and streaming usage never replace main usage or previews", async (t) => {
  const usage = { input_tokens: 10, output_tokens: 2 };
  const child = { input_tokens: 999, output_tokens: 888 };
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      {
        type: "stream_event",
        event: { type: "message_start", message: { id: "main", usage } },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_parent",
        event: {
          type: "message_start",
          message: { id: "child", usage: child },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_parent",
        event: { type: "message_delta", usage: child },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_parent",
        message: {
          id: "child",
          usage: child,
          content: [{ type: "text", text: "helper" }],
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "main preview" },
        },
      },
      {
        type: "assistant",
        message: {
          id: "main",
          usage,
          content: [{ type: "text", text: "main reply" }],
        },
      },
      { type: "result", subtype: "success" },
    ],
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn(turnRequest("usage"));
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  await turn.result();
  assert.deepEqual(
    events
      .filter((event) => event.kind === "usage")
      .map((event) => event.observation.summary),
    [
      "message: input 10, output 2 tokens",
      "message: input 10, output 2 tokens",
      "",
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.kind === "message-preview")
      .map((event) => [event.messageId, event.content]),
    [["main", "main preview"]],
  );
});

for (const parentFirst of [true, false]) {
  test(`m10-audit-claude-fact-translation: parent identities correlate without native ids, parent first ${parentFirst}`, async (t) => {
    const parent = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_parent",
            name: "Agent",
            input: { task: "help" },
          },
        ],
      },
    };
    const child = {
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      message: {
        content: [
          { type: "text", text: "helper reply" },
          {
            type: "tool_use",
            id: "toolu_child",
            name: "Read",
            input: { file_path: "note.txt" },
          },
        ],
      },
    };
    const scripted = scriptedClaude({
      answer: "confirm",
      userFrame: () => [
        init,
        ...(parentFirst ? [parent, child] : [child, parent]),
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_child",
                content: "done",
              },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ],
    });
    const harness = await prepare(scripted);
    t.after(() => harness.close());
    const turn = harness.startTurn(turnRequest("parent"));
    const events: TurnEvent[] = [];
    turn.subscribe((event) => events.push(event));
    await turn.result();
    const calls = events
      .filter((event) => event.kind === "tool-call")
      .map((event) => event.call);
    const parentCall = calls.find((call) => call.tool === "other");
    const children = calls.filter((call) => call.tool === "read");
    assert.ok(parentCall);
    assert.deepEqual(
      children.map((call) => call.outcome.kind),
      ["running", "completed"],
    );
    assert.equal(children[0]?.callId, children[1]?.callId);
    assert.notEqual(children[0]?.callId, parentCall.callId);
    assert.equal(children[0]?.parentCallId, parentCall.callId);
    assert.equal(
      events.find((event) => event.kind === "assistant-content")
        ?.parentActivity,
      parentCall.callId,
    );
    assert.equal(JSON.stringify(events).includes("toolu_"), false);
  });
}

for (const request of [{ subtype: "future_control" }, { subtype: 123 }, null]) {
  test(`m10-audit-claude-fact-translation: unsupported control is a visible typed failure ${JSON.stringify(request)}`, async (t) => {
    const scripted = scriptedClaude({
      answer: "confirm",
      userFrame: () => [
        init,
        { type: "control_request", request_id: "unknown-request", request },
      ],
    });
    const harness = await prepare(scripted);
    t.after(() => harness.close());
    const turn = harness.startTurn(turnRequest("control"));
    const result = await turn.result();
    assert.equal(result.kind, "lost");
    assert.ok(result.kind === "lost");
    assert.equal(
      result.detail.failure?.category,
      "unsupported-control-request",
    );
    assert.match(
      result.detail.failure?.diagnostics ?? "",
      /unsupported control request/i,
    );
    await scripted.closed();
    assert.equal(scripted.stops(), 1);
  });
}

for (const [provider, model, reroute, qualified] of [
  ["openai", "gpt-6.1-sol", undefined, true],
  ["other-provider", "gpt-6.1-sol", undefined, false],
  ["openai", "other-model", undefined, false],
  ["openai", "other-model", "gpt-6.1-sol", true],
  ["other-provider", "other-model", "gpt-6.1-sol", false],
  ["openai", "gpt-6.1-sol", "other-model", false],
] as const) {
  test(`m10-audit-claude-fact-translation: Codex Thought qualification ${provider}/${model} rerouted ${reroute}`, async (t) => {
    const events = await codexFacts(
      t,
      [],
      makeTempDir("secant-summary-rule-"),
      { provider, model, ...(reroute === undefined ? {} : { reroute }) },
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === "thought-preview")
        .map((event) => event.content),
      qualified ? ["Qualified summary"] : [],
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === "thought")
        .map((event) => event.content),
      qualified ? ["Qualified summary"] : [],
    );
  });
}

test("m10-audit-changed-file-cap: Codex running calls supply ordered targets without patches and completed calls retain every patch", async (t) => {
  const changes = Array.from({ length: 300 }, (_, index) => ({
    path: `reported/${300 - index}/file.ts`,
    kind: { type: "update", move_path: null },
    diff: `@@ -1 +1 @@\n-old\n+PATCH_${index}\n`,
  }));
  const events = await codexFacts(t, [
    {
      method: "item/started",
      params: {
        ...recordedTarget,
        item: {
          type: "fileChange",
          id: "large-call",
          status: "inProgress",
          changes,
        },
      },
    },
    {
      method: "item/completed",
      params: {
        ...recordedTarget,
        item: {
          type: "fileChange",
          id: "large-call",
          status: "completed",
          changes,
        },
      },
    },
  ]);
  const calls = events.flatMap((event) =>
    event.kind === "tool-call" && event.call.input.includes("reported/300/")
      ? [event.call]
      : [],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.outcome.kind, "running");
  assert.deepEqual(
    calls[0]?.files,
    changes.map(({ path }) => ({ path })),
  );
  assert.equal(calls[1]?.callId, calls[0]?.callId);
  assert.equal(calls[1]?.outcome.kind, "completed");
  assert.deepEqual(
    calls[1]?.files,
    changes.map(({ path, diff }) => ({
      path,
      kind: "update",
      patch: { kind: "unified", content: diff },
    })),
  );
});

function isNativeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function schemaDefinitions(schema: unknown): Record<string, unknown> {
  assert.ok(isNativeRecord(schema));
  const definitions = schema.definitions;
  assert.ok(isNativeRecord(definitions));
  const v2 = definitions.v2;
  assert.ok(isNativeRecord(v2));
  return v2;
}
function mutateDefinition(schema: unknown, name: string): void {
  const definitions = schemaDefinitions(schema);
  assert.ok(name in definitions);
  delete definitions[name];
}
for (const [name, label, kinds] of [
  [
    "TurnDiffUpdatedNotification",
    "Turn diffs",
    ["turn-diff", "turn-diff-preview"],
  ],
  [
    "ThreadTokenUsageUpdatedNotification",
    "Context and usage",
    ["context", "usage"],
  ],
  [
    "AgentMessageDeltaNotification",
    "Agent message previews",
    ["message-preview"],
  ],
  [
    "CommandExecutionOutputDeltaNotification",
    "Command output previews",
    ["tool-preview"],
  ],
  [
    "ReasoningSummaryTextDeltaNotification",
    "Thought summary previews",
    ["thought-preview"],
  ],
] satisfies [string, string, string[]][]) {
  test(`m10-audit-optional-native-facts: replay skips disabled ${label} and retains final messages`, async (t) => {
    const events = await codexFacts(
      t,
      [],
      undefined,
      { provider: "openai", model: "gpt-6.1-sol" },
      {
        mutate: (schema) => mutateDefinition(schema, name),
        limits: [
          `${label} are unavailable because the installed Harness changed their format.`,
        ],
      },
    );
    assert.equal(
      events.some((event) => kinds.includes(event.kind)),
      false,
    );
    assert.equal(
      events.some((event) => event.kind === "assistant-content"),
      true,
    );
    assert.equal(
      events.some((event) => event.kind === "model" && event.observation.known),
      true,
    );
    if (name !== "ThreadTokenUsageUpdatedNotification")
      assert.equal(
        events.some((event) => event.kind === "usage"),
        true,
      );
  });
}
for (const params of [
  { itemId: "malformed", delta: { changed: true } },
  { delta: "unidentified preview" },
]) {
  test(`m10-audit-optional-native-facts: malformed enabled agent preview is ignored and final message arrives (${JSON.stringify(params)})`, async (t) => {
    const events = await codexFacts(t, [
      { method: "item/agentMessage/delta", params },
    ]);
    assert.equal(
      events.some((event) => event.kind === "assistant-content"),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.kind === "message-preview" &&
          (event.messageId === "malformed" ||
            event.content.includes("unidentified preview")),
      ),
      false,
    );
  });
}

test("m10-audit-optional-native-facts: replay never reads a disabled completed summary while its qualified preview survives", async (t) => {
  const events = await codexFacts(
    t,
    [],
    undefined,
    { provider: "openai", model: "gpt-6.1-sol" },
    {
      mutate: (schema) => {
        const definitions = schemaDefinitions(schema);
        const items = definitions.ThreadItem;
        assert.ok(
          typeof items === "object" &&
            items !== null &&
            "oneOf" in items &&
            Array.isArray(items.oneOf),
        );
        const reasoning = items.oneOf.find((item: unknown) =>
          z
            .looseObject({
              properties: z.looseObject({
                type: z.object({ enum: z.array(z.string()) }),
              }),
            })
            .parse(item)
            .properties.type.enum.includes("reasoning"),
        );
        assert.ok(
          typeof reasoning === "object" &&
            reasoning !== null &&
            "properties" in reasoning,
        );
        assert.ok(
          typeof reasoning.properties === "object" &&
            reasoning.properties !== null,
        );
        Reflect.deleteProperty(reasoning.properties, "summary");
      },
      limits: [
        "Thought summaries are unavailable because the installed Harness changed their format.",
      ],
    },
  );
  assert.equal(
    events.some((event) => event.kind === "thought" && !event.incomplete),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "thought-preview"),
    true,
  );
  assert.equal(
    events.some((event) => event.kind === "assistant-content"),
    true,
  );
});

for (const recordingCase of [
  "thought-summary-configured",
  "thought-summary-unconfigured",
]) {
  test(`m10-audit-optional-native-facts: authentic ${recordingCase} produces no display limit`, async (t) => {
    const events = await codexFacts(
      t,
      [],
      undefined,
      undefined,
      undefined,
      recordingCase,
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === "thought")
        .map((event) => event.content),
      recordingCase === "thought-summary-configured"
        ? ["**Determining minimal three-digit number**"]
        : [],
    );
  });
}
test("m10-audit-optional-native-facts: an unqualified model's honest summary absence adds no limit", async (t) => {
  const events = await codexFacts(t, [], undefined, {
    provider: "openai",
    model: "other-model",
  });
  assert.equal(
    events.some(
      (event) => event.kind === "thought" || event.kind === "thought-preview",
    ),
    false,
  );
});

for (const tokenUsage of [
  false,
  { total: { outputTokens: 1.5 } },
  { last: "wrong" },
  { modelContextWindow: "wrong" },
  {
    total: { totalTokens: "wrong", outputTokens: 3 },
    last: "wrong",
    modelContextWindow: "wrong",
    percentage: 90,
    reasoningDurationMs: 42,
  },
]) {
  test(`m10-audit-optional-native-facts: malformed enabled usage preserves earlier observations (${JSON.stringify(tokenUsage)})`, async (t) => {
    const events = await codexFacts(t, [
      {
        method: "thread/tokenUsage/updated",
        params: {
          ...recordedTarget,
          tokenUsage: { modelContextWindow: 8192, total: { totalTokens: 42 } },
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: { ...recordedTarget, tokenUsage },
      },
    ]);
    assert.deepEqual(
      events.filter((event) => event.kind === "context").at(-1),
      { kind: "context", observation: { limitTokens: 8192 } },
    );
    assert.deepEqual(events.filter((event) => event.kind === "usage").at(-1), {
      kind: "usage",
      observation: { summary: "total: total 42 tokens" },
    });
  });
}
