import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createCodexAdapter } from "../../src/harness/harness.js";
import { z } from "zod";
import type { TurnEvent } from "../../src/harness/harness.js";
import {
  init,
  prepare,
  scriptedClaude,
  turnRequest,
} from "./scripted-claude.js";
import { replayRecordedLine } from "./codex-replay-path.js";

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
) {
  const traffic = z
    .object({
      traffic: z.array(
        z.object({ direction: z.string(), line: z.string().optional() }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("./fixtures/codex/test-repair/case.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const envelope = z.looseObject({
    id: z.number().optional(),
    method: z.string().optional(),
  });
  const requests = new Map<number, string>();
  const replies = new Map<string, z.infer<typeof envelope>>();
  const notifications: object[] = [];
  let running = false;
  for (const entry of traffic.traffic) {
    if (
      entry.line === undefined ||
      !["stdin", "stdout"].includes(entry.direction)
    )
      continue;
    const value = envelope.parse(
      JSON.parse(replayRecordedLine(entry.line, workspace)),
    );
    if (entry.direction === "stdin") {
      if (value.id !== undefined && value.method !== undefined)
        requests.set(value.id, value.method);
      if (value.method === "turn/start") running = true;
    } else if (value.id !== undefined) {
      const method = requests.get(value.id);
      assert.ok(method);
      replies.set(method, value);
    } else if (running) notifications.push(value);
  }
  const encoder = new TextEncoder();
  const process = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: (command) => {
      if (command.args.includes("generate-json-schema")) {
        const out = command.args[command.args.indexOf("--out") + 1];
        assert.ok(out);
        copyFileSync(
          new URL(
            "./fixtures/codex/codex-qualification/stable-schema.generated.json",
            import.meta.url,
          ),
          join(out, "codex_app_server_protocol.schemas.json"),
        );
      }
      return {
        kind: "exited",
        status: 0,
        text: encoder.encode("codex-cli 0.160.0"),
      };
    },
    ownedProcesses: [
      {
        kind: "launched",
        emissions: [
          {
            kind: "terminal",
            trigger: "close-stdin",
            close: { kind: "exited", status: 0 },
          },
        ],
        stdinReplies: (bytes) => {
          const request = envelope.parse(
            JSON.parse(new TextDecoder().decode(bytes)),
          );
          if (request.id === undefined) return [];
          const reply = replies.get(request.method ?? "");
          assert.ok(reply, `reply for ${request.method}`);
          const frames: z.infer<typeof envelope>[] = [
            { ...reply, id: request.id },
          ];
          if (request.method === "turn/start") {
            const terminal = notifications.findIndex(
              (value) => envelope.parse(value).method === "turn/completed",
            );
            frames.push(
              ...notifications
                .slice(0, terminal)
                .map((value) => envelope.parse(value)),
              ...extra.map((value) => {
                const extra = z
                  .looseObject({
                    method: z.string().optional(),
                    params: z
                      .looseObject({
                        threadId: z.unknown().optional(),
                        turnId: z.unknown().optional(),
                        item: z.unknown().optional(),
                      })
                      .optional(),
                  })
                  .parse(value);
                if (
                  extra.params?.item !== undefined &&
                  extra.params.threadId === undefined
                ) {
                  const correlated = z
                    .object({
                      params: z.object({
                        threadId: z.string(),
                        turn: z.object({ id: z.string() }),
                      }),
                    })
                    .parse(
                      notifications.find(
                        (value) =>
                          envelope.parse(value).method === "turn/started",
                      ),
                    );
                  return {
                    ...extra,
                    params: {
                      ...extra.params,
                      threadId: correlated.params.threadId,
                      turnId: correlated.params.turn.id,
                    },
                  };
                }
                return envelope.parse(value);
              }),
              ...notifications
                .slice(terminal)
                .map((value) => envelope.parse(value)),
            );
          }
          return [
            {
              kind: "stdout",
              bytes: encoder.encode(
                frames.map((value) => JSON.stringify(value) + "\n").join(""),
              ),
            },
          ];
        },
      },
    ],
  });
  const adapter = createCodexAdapter({ env: {} });
  t.after(() => adapter.close());
  const prepared = await adapter.prepare({ workspace, process });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  t.after(() => prepared.harness.close());
  const turn = prepared.harness.startTurn({
    ...turnRequest("recorded"),
    modelChoice: { model: "gpt-6.1-sol" },
  });
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  const result = await turn.result();
  assert.equal(result.kind, "completed");
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
  [
    "malformed",
    {
      total: { totalTokens: "wrong", outputTokens: 3 },
      last: "wrong",
      modelContextWindow: "wrong",
      percentage: 90,
      reasoningDurationMs: 42,
    },
    {},
    "total: output 3 tokens",
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
test("m10-observed-harness-facts: authentic Claude external MCP result text does not infer refusal from elicitation", async (t) => {
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
      ["mcp", "mcp__setup__setup · {}", "running"],
      ["mcp", "mcp__setup__setup · {}", "completed"],
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
      (call) =>
        call.tool === "mcp" && call.input.includes("mcp__secant__step_done"),
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
