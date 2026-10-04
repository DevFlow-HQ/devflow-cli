import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCall } from "../../src/harness/harness.js";
import { z } from "zod";
import { startPermissionBridge } from "../../src/harness/harness.js";

const declarations = [
  { id: "step_done", description: "End the step", maxReasonLength: 400 },
];

async function rpc(
  url: string,
  bearer: string,
  method: string,
  params: unknown,
  sessionId?: string,
) {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function initialize(url: string, bearer: string) {
  const response = await rpc(url, bearer, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "listener-test", version: "1" },
  });
  assert.equal(response.status, 200);
  await response.json();
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  return sessionId;
}

test("one listener isolates Session tokens and accepts extra MCP sessions", async () => {
  const received: AgentCall[] = [];
  const bridge = await startPermissionBridge(
    async () => ({ decision: "allow" }),
    () => async (call) => {
      received.push(call);
      return { outcome: "accepted" };
    },
  );
  try {
    const a = bridge.session("a", declarations);
    const b = bridge.session("b", declarations);
    assert.notEqual(a.bearer, b.bearer);
    assert.equal(a.url, b.url);
    const first = await initialize(a.url, a.bearer);
    const extra = await initialize(a.url, a.bearer);
    const other = await initialize(b.url, b.bearer);
    assert.notEqual(first, extra);
    assert.notEqual(extra, other);
    const wrong = await rpc(a.url, "wrong", "tools/list", {});
    assert.equal(wrong.status, 401);
    await wrong.text();
    const crossSession = await rpc(a.url, b.bearer, "tools/list", {}, first);
    assert.equal(crossSession.status, 404);
    await crossSession.text();
    const call = await rpc(
      a.url,
      a.bearer,
      "tools/call",
      { name: "step_done", arguments: { reason: "  done\nnow  " } },
      extra,
    );
    assert.equal(call.status, 200);
    const payload = z
      .object({ result: z.object({ isError: z.boolean() }) })
      .parse(await call.json());
    assert.equal(payload.result.isError, false);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, "step_done");
    assert.equal(received[0]?.reason, "  done\nnow  ");
    assert.ok(received[0]?.callId.opaque);
  } finally {
    await bridge.close();
  }
});

const toolResult = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  }),
});
async function callTool(
  attachment: { url: string; bearer: string },
  sessionId: string,
  args: unknown,
  name = "step_done",
) {
  const response = await rpc(
    attachment.url,
    attachment.bearer,
    "tools/call",
    { name, arguments: args },
    sessionId,
  );
  assert.equal(response.status, 200);
  return toolResult.parse(await response.json()).result;
}

test("calls resolve the token's live Turn, preserve reasons, and return closed replies", async () => {
  const calls: { session: string; call: AgentCall }[] = [];
  let active: string | undefined;
  let outcome: "accepted" | "held-for-review" | "refused" = "accepted";
  const bridge = await startPermissionBridge(
    async () => ({ decision: "allow" }),
    (session) =>
      session !== active
        ? undefined
        : async (call) => {
            calls.push({ session, call });
            if (outcome === "refused")
              return { outcome, reason: "End Step is unavailable" };
            return { outcome };
          },
  );
  try {
    const a = bridge.session("a", declarations);
    const b = bridge.session("b", declarations);
    const ma = await initialize(a.url, a.bearer);
    const mb = await initialize(b.url, b.bearer);
    assert.deepEqual(await callTool(a, ma, { reason: "ready" }), {
      isError: true,
      content: [{ type: "text", text: "no Turn in progress" }],
    });
    active = "b";
    assert.equal(
      (await callTool(a, ma, { reason: "a helper from the idle Session" }))
        .isError,
      true,
    );
    assert.equal(calls.length, 0);
    const raw = " \nready\t\u001b[31m \n ";
    assert.deepEqual(await callTool(b, mb, { reason: raw }), {
      isError: false,
      content: [
        {
          type: "text",
          text: "accepted: takes effect when this Turn finishes",
        },
      ],
    });
    assert.equal(calls[0]?.session, "b");
    assert.equal(calls[0]?.call.reason, raw);
    outcome = "held-for-review";
    assert.deepEqual(await callTool(b, mb, { reason: "review" }), {
      isError: false,
      content: [
        {
          type: "text",
          text: "held for review: the human decides the next Iteration",
        },
      ],
    });
    outcome = "refused";
    assert.deepEqual(await callTool(b, mb, { reason: "refused" }), {
      isError: true,
      content: [{ type: "text", text: "End Step is unavailable" }],
    });
    active = undefined;
    assert.equal(
      (await callTool(b, mb, { reason: "late helper" })).isError,
      true,
    );
    assert.equal(calls.length, 3);
    assert.equal(
      new Set(calls.map((entry) => entry.call.callId.opaque)).size,
      3,
    );
  } finally {
    await bridge.close();
  }
});

test("reason validation rejects whitespace, oversized, missing, and nonstring input", async () => {
  const reasons: string[] = [];
  const bridge = await startPermissionBridge(
    async () => ({ decision: "allow" }),
    () => async (call) => {
      reasons.push(call.reason);
      return { outcome: "accepted" };
    },
  );
  try {
    const attachment = bridge.session("bounds", [
      ...declarations,
      { id: "short", description: "A shorter call", maxReasonLength: 4 },
    ]);
    const session = await initialize(attachment.url, attachment.bearer);
    for (const args of [
      { reason: "" },
      { reason: " \n\t " },
      { reason: "x".repeat(401) },
      {},
      { reason: 17 },
      { reason: null },
    ]) {
      assert.equal((await callTool(attachment, session, args)).isError, true);
    }
    assert.equal(reasons.length, 0);
    assert.equal(
      (await callTool(attachment, session, { reason: "x".repeat(400) }))
        .isError,
      false,
    );
    assert.equal(
      (await callTool(attachment, session, { reason: "x" })).isError,
      false,
    );
    assert.equal(
      (await callTool(attachment, session, { reason: "longer" }, "short"))
        .isError,
      true,
    );
    assert.equal(
      (await callTool(attachment, session, { reason: "four" }, "short"))
        .isError,
      false,
    );
    assert.deepEqual(reasons, ["x".repeat(400), "x", "four"]);
  } finally {
    await bridge.close();
  }
});

test("tool unions and tokens stay fixed across MCP reconnects; idle Sessions expose no calls", async () => {
  const bridge = await startPermissionBridge(async () => ({
    decision: "allow",
  }));
  try {
    const union = [
      ...declarations,
      { id: "stage_done", description: "End the stage", maxReasonLength: 400 },
    ];
    const snapshot = union.map((call) => ({ ...call }));
    const attachment = bridge.session("union", union);
    union[0].description = "caller mutated its copy";
    assert.throws(() => bridge.session("union", union), /declarations changed/);
    assert.throws(() => bridge.session("union"), /declarations changed/);
    const again = bridge.session("union", [...snapshot].reverse());
    assert.equal(again.bearer, attachment.bearer);
    const session = await initialize(attachment.url, attachment.bearer);
    const list = await rpc(
      attachment.url,
      attachment.bearer,
      "tools/list",
      {},
      session,
    );
    const tools = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({ name: z.string(), description: z.string() }),
          ),
        }),
      })
      .parse(await list.json()).result.tools;
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.description]),
      [
        ["stage_done", "End the stage"],
        ["step_done", "End the step"],
      ],
    );
    const removed = await fetch(attachment.url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${attachment.bearer}`,
        "mcp-session-id": session,
      },
    });
    assert.equal(removed.status, 200);
    await removed.text();
    const extra = await initialize(attachment.url, attachment.bearer);
    assert.notEqual(extra, session);
    assert.equal(bridge.session("union", snapshot).bearer, attachment.bearer);
    const idle = bridge.session("idle");
    const unavailable = await rpc(idle.url, idle.bearer, "initialize", {});
    assert.equal(unavailable.status, 404);
    await unavailable.text();
    for (const invalid of [
      [{ ...snapshot[0], maxReasonLength: 401 }],
      [{ ...snapshot[0], maxReasonLength: 0 }],
      [{ ...snapshot[0], maxReasonLength: 2.5 }],
      [...snapshot, snapshot[0]],
      [{ ...snapshot[0], id: "" }],
    ]) {
      assert.throws(
        () => bridge.session("invalid", invalid),
        /invalid agent-call declaration/,
      );
    }
  } finally {
    await bridge.close();
  }
  await bridge.close();
  assert.throws(() => bridge.session("late"), /listener close/);
});

test("permissions share the listener but stay attributed to their Session and endpoint", async () => {
  let active = "a";
  const approvals: { session: string; tool: string; input: string }[] = [];
  const bridge = await startPermissionBridge(async (session, request) => {
    if (session !== active)
      return { decision: "deny", message: "request expired" };
    approvals.push({ session, ...request });
    return { decision: "allow" };
  });
  try {
    const a = bridge.session("a", declarations);
    const b = bridge.session("b", declarations);
    const permissionUrl = a.url.replace("/mcp", "/permissions");
    const pa = await initialize(permissionUrl, a.bearer);
    const pb = await initialize(permissionUrl, b.bearer);
    const call = async (bearer: string, sessionId: string) => {
      const response = await rpc(
        permissionUrl,
        bearer,
        "tools/call",
        {
          name: "approve",
          arguments: { tool_name: "Edit", input: { path: "file" } },
        },
        sessionId,
      );
      return toolResult.parse(await response.json()).result.content[0]?.text;
    };
    assert.equal(
      await call(a.bearer, pa),
      '{"behavior":"allow","updatedInput":{"path":"file"}}',
    );
    active = "b";
    assert.equal(
      await call(a.bearer, pa),
      '{"behavior":"deny","message":"request expired"}',
    );
    assert.equal(
      await call(b.bearer, pb),
      '{"behavior":"allow","updatedInput":{"path":"file"}}',
    );
    assert.deepEqual(approvals, [
      { session: "a", tool: "Edit", input: '{"path":"file"}' },
      { session: "b", tool: "Edit", input: '{"path":"file"}' },
    ]);
    const wrongEndpoint = await rpc(a.url, a.bearer, "tools/list", {}, pa);
    assert.equal(wrongEndpoint.status, 404);
    await wrongEndpoint.text();
  } finally {
    await bridge.close();
  }
});
