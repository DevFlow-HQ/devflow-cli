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
              ...extra.map((value) => envelope.parse(value)),
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
  assert.ok(events.some((event) => event.kind === "tool-activity"));
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
  assert.deepEqual(
    events.filter((event) => event.kind === "tool-activity"),
    [
      {
        kind: "tool-activity",
        activity: {
          tool: "other",
          phase: "started",
          summary: 'UnfamiliarWork · {"path":"README.md"}',
        },
      },
      {
        kind: "tool-activity",
        activity: {
          tool: "other",
          phase: "completed",
          summary: "UnfamiliarWork · done",
        },
      },
    ],
  );
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
  assert.ok(
    events.some(
      (event) =>
        event.kind === "tool-activity" &&
        event.activity.tool === "other" &&
        event.activity.summary === "UnfamiliarWork · completed",
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
