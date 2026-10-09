import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TestContext } from "node:test";
import { z } from "zod";
import {
  createClaudeCodeAdapter,
  type HarnessAdapter,
  type TurnEvent,
} from "../../src/harness/harness.js";
import { init, SESSION_ID, scriptedClaude } from "./scripted-claude.js";
import { scriptedCodexFacts } from "./scripted-codex-facts.js";

const frame = z.record(z.string(), z.unknown());
const native = z.looseObject({
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export const LOOKALIKE = "user-secret-" + "a".repeat(64);
export const REPLACEMENT = "«redacted-bearer-token»";

function codexBody(recording: string, method: string, type?: string) {
  const traffic = z
    .object({
      traffic: z.array(
        z.object({ direction: z.string(), line: z.string().optional() }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL(`./fixtures/codex/${recording}/case.json`, import.meta.url),
          "utf8",
        ),
      ),
    );
  for (const entry of traffic.traffic) {
    if (entry.direction !== "stdout" || entry.line === undefined) continue;
    const parsed = native.safeParse(JSON.parse(entry.line));
    if (!parsed.success || parsed.data.method !== method) continue;
    if (
      type !== undefined &&
      frame.parse(parsed.data.params.item).type !== type
    )
      continue;
    const { threadId: _thread, turnId: _turn, ...params } = parsed.data.params;
    return { ...parsed.data, params };
  }
  throw new Error(`missing recorded ${recording} ${method} ${type ?? ""}`);
}
function claudeBodies(recording: string, file: string) {
  return readFileSync(
    new URL(`./fixtures/claude-code/${recording}/${file}`, import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => frame.parse(JSON.parse(line)));
}

// Copy recorded bodies, substituting content/correlation only. These overlays
// exercise existing qualified fields; no recording or native qualification changes.
export function redactionReplay(
  t: TestContext,
  kind: "codex" | "claude-code",
  bearer: string,
  observed?: (event: TurnEvent) => void,
): HarnessAdapter {
  let adapter: HarnessAdapter;
  if (kind === "codex") {
    const start = codexBody("test-repair", "item/started", "commandExecution");
    const item = {
      ...frame.parse(start.params.item),
      id: "redaction-command",
      command: `print ${bearer}`,
    };
    const delta = codexBody("test-repair", "item/commandExecution/outputDelta");
    const preview = codexBody("test-repair", "item/agentMessage/delta");
    const approval = codexBody("agent-calls", "mcpServer/elicitation/request");
    const elicitation = {
      ...approval,
      id: 909,
      params: {
        ...approval.params,
        _meta: null,
        serverName: bearer,
        message: `elicitation ${bearer}`,
      },
    };
    const failed = codexBody(
      "test-repair",
      "item/completed",
      "commandExecution",
    );
    const errorItem = {
      ...frame.parse(failed.params.item),
      id: "redaction-error",
      command: "fail",
      status: "failed",
      aggregatedOutput: `failed ${bearer}`,
      exitCode: 1,
    };
    const fileChange = codexBody("test-repair", "item/started", "fileChange");
    const other = {
      ...frame.parse(fileChange.params.item),
      id: "redaction-non-command",
    };
    const final = codexBody("test-repair", "item/completed", "agentMessage");
    adapter = scriptedCodexFacts([
      { ...fileChange, params: { ...fileChange.params, item: other } },
      {
        ...delta,
        params: {
          ...delta.params,
          itemId: other.id,
          delta: `foreign ${bearer}`,
        },
      },
      { ...start, params: { ...start.params, item } },
      {
        ...delta,
        params: {
          ...delta.params,
          itemId: item.id,
          delta: "head" + bearer.slice(0, 31),
        },
      },
      { ...start, params: { ...start.params, item } },
      {
        ...delta,
        params: {
          ...delta.params,
          itemId: item.id,
          delta: bearer.slice(31) + "z".repeat(29_990),
        },
      },
      {
        method: "item/completed",
        params: {
          item: {
            ...item,
            status: "completed",
            aggregatedOutput: null,
            exitCode: 0,
          },
        },
      },
      {
        ...preview,
        params: {
          ...preview.params,
          itemId: "redaction-message",
          delta: `reply ${bearer.slice(0, 31)}`,
        },
      },
      {
        ...preview,
        params: {
          ...preview.params,
          itemId: "redaction-message",
          delta: bearer.slice(31) + ` ${LOOKALIKE}`,
        },
      },
      {
        ...approval,
        id: 908,
        params: {
          ...approval.params,
          message: `approval ${bearer}`,
          _meta: {
            ...frame.parse(approval.params._meta),
            tool_params: { nested: { secret: bearer } },
          },
        },
      },
      elicitation,
      { ...failed, params: { ...failed.params, item: errorItem } },
      {
        ...final,
        params: {
          ...final.params,
          item: {
            ...frame.parse(final.params.item),
            id: "redaction-message",
            text: `reply ${bearer} ${LOOKALIKE}`,
          },
        },
      },
    ]);
  } else {
    const plain = claudeBodies("plain", "turn-1.stdout");
    const messageStart = plain.find(
      (f) =>
        f.type === "stream_event" &&
        frame.parse(f.event).type === "message_start",
    );
    const delta = plain.find(
      (f) =>
        f.type === "stream_event" &&
        frame.parse(f.event).type === "content_block_delta",
    );
    const assistant = plain.find((f) => f.type === "assistant");
    const final = plain.find((f) => f.type === "result");
    const elicitation = claudeBodies(
      "elicitation-declined",
      "before.stdout",
    ).find((f) => f.type === "control_request");
    const tools = claudeBodies("test-repair", "stdout-0.stdout");
    const toolStart = tools.find(
      (f) => f.type === "assistant" && JSON.stringify(f).includes('"tool_use"'),
    );
    const toolError = claudeBodies("steer-cancel", "cancelled.stdout").find(
      (f) => f.type === "user" && JSON.stringify(f).includes('"tool_result"'),
    );
    assert.ok(
      messageStart &&
        delta &&
        assistant &&
        final &&
        elicitation &&
        toolStart &&
        toolError,
    );
    const message = frame.parse(assistant.message);
    const startMessage = frame.parse(toolStart.message);
    const block = z
      .array(frame)
      .parse(startMessage.content)
      .find((value) => value.type === "tool_use");
    assert.ok(block);
    const nativeError = frame.parse(
      z.array(z.unknown()).parse(frame.parse(toolError.message).content)[0],
    );
    const stream = frame.parse(delta.event);
    const frames = [
      messageStart,
      {
        ...delta,
        event: {
          ...stream,
          delta: { type: "text_delta", text: `reply ${bearer.slice(0, 31)}` },
        },
      },
      {
        ...delta,
        event: {
          ...stream,
          delta: {
            type: "text_delta",
            text: bearer.slice(31) + ` ${LOOKALIKE}`,
          },
        },
      },
      {
        ...assistant,
        message: {
          ...message,
          content: [{ type: "text", text: `reply ${bearer} ${LOOKALIKE}` }],
        },
      },
      {
        ...toolStart,
        message: {
          ...startMessage,
          content: [{ ...block, input: { file_path: bearer } }],
        },
      },
      {
        ...toolError,
        tool_use_result: null,
        message: {
          ...frame.parse(toolError.message),
          content: [
            {
              ...nativeError,
              tool_use_id: block.id,
              content: `failed ${bearer}`,
            },
          ],
        },
      },
      {
        ...elicitation,
        request: {
          ...frame.parse(elicitation.request),
          mcp_server_name: bearer,
          message: `elicitation ${bearer}`,
          url: `https://example.com/${bearer}`,
        },
      },
    ];
    const scripted = scriptedClaude({
      answer: "confirm",
      userFrame: () => [init],
    });
    adapter = createClaudeCodeAdapter({ env: {}, sessionId: () => SESSION_ID });
    const nativeAdapter = adapter;
    adapter = {
      close: (options) => nativeAdapter.close(options),
      prepare: async (options) => {
        const prepared = await nativeAdapter.prepare({
          ...options,
          process: scripted.process,
        });
        if (!prepared.ok) return prepared;
        const harness = prepared.harness;
        return {
          ok: true,
          harness: {
            profile: harness.profile,
            readDefaults: () => harness.readDefaults(),
            close: () => harness.close(),
            startTurn(request) {
              const turn = harness.startTurn(request);
              let resolveSession!: () => void;
              const session = new Promise<void>((resolve) => {
                resolveSession = resolve;
              });
              turn.subscribe((event) => {
                if (event.kind === "session") resolveSession();
              });
              const replay = (async () => {
                await session;
                const server = z
                  .object({
                    servers: z.record(
                      z.string(),
                      z.object({
                        url: z.string(),
                        headers: z.object({ Authorization: z.string() }),
                      }),
                    ),
                  })
                  .parse(scripted.writes[0]?.[0]?.request).servers[
                  "secant-permissions"
                ];
                assert.ok(server);
                const rpc = async (
                  method: string,
                  params: unknown,
                  sessionId?: string,
                ) => {
                  const reply = await fetch(server.url, {
                    method: "POST",
                    headers: {
                      ...server.headers,
                      "Content-Type": "application/json",
                      Accept: "application/json, text/event-stream",
                      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
                    },
                    body: JSON.stringify({
                      jsonrpc: "2.0",
                      id: 1,
                      method,
                      params,
                    }),
                  });
                  assert.equal(reply.status, 200);
                  await reply.arrayBuffer();
                  return reply.headers.get("mcp-session-id");
                };
                const id = await rpc("initialize", {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  clientInfo: { name: "redaction-replay", version: "1" },
                });
                assert.ok(id);
                await rpc(
                  "tools/call",
                  {
                    name: "approve",
                    arguments: {
                      tool_name: "Read",
                      input: { file_path: bearer },
                    },
                  },
                  id,
                );
                scripted.emit(...frames, {
                  ...final,
                  result: `reply ${bearer} ${LOOKALIKE}`,
                });
              })();
              void replay.catch(() => scripted.exit());
              t.after(() => replay);
              return turn;
            },
          },
        };
      },
    };
  }
  t.after(() => adapter.close());
  return {
    close: (options) => adapter.close(options),
    async prepare(options) {
      const result = await adapter.prepare({
        ...options,
        workspace: options.workspace,
      });
      if (!result.ok) return result;
      const harness = result.harness;
      t.after(() => harness.close());
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          readDefaults: () => harness.readDefaults(),
          close: () => harness.close(),
          startTurn(request) {
            const turn = harness.startTurn(request);
            return {
              result: () => turn.result(),
              steer: (input) => turn.steer(input),
              interrupt: () => turn.interrupt(),
              answerRequest: (answer) => turn.answerRequest(answer),
              answerAgentCall: (answer) => turn.answerAgentCall(answer),
              changeModel: (choice) => turn.changeModel(choice),
              subscribe(listener) {
                return turn.subscribe((event) => {
                  listener(event);
                  observed?.(event);
                  if (event.kind === "request-raised")
                    void turn.answerRequest({
                      requestId: event.request.requestId,
                      kind: "approval",
                      decision: "deny",
                    });
                });
              },
            };
          },
        },
      };
    },
  };
}
