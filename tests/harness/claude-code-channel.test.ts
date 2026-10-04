import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { AgentCall, TurnEvent } from "../../src/harness/harness.js";
import {
  prepare,
  scriptedClaude,
  turnRequest,
  liveTurnOn,
  init,
} from "./scripted-claude.js";

const declarations = [
  { id: "step_done", description: "End the step", maxReasonLength: 400 },
];
const serverSchema = z.object({
  url: z.string(),
  headers: z.object({ Authorization: z.string() }),
});

async function rpc(
  server: z.infer<typeof serverSchema>,
  method: string,
  params: unknown,
  session?: string,
) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return {
    payload: await response.json(),
    session: response.headers.get("mcp-session-id"),
  };
}

for (const outcome of ["accepted", "held-for-review", "refused"] as const) {
  test(`Claude channel attaches only declared calls and answers ${outcome} exactly once`, async (t) => {
    const scripted = scriptedClaude({ answer: "confirm" });
    let server: z.infer<typeof serverSchema> | undefined;
    const harness = await prepare({
      ...scripted,
      process: {
        ...scripted.process,
        spawnOwnedProcess(options) {
          const raw = options.args[options.args.indexOf("--mcp-config") + 1];
          assert.ok(raw);
          const config = z
            .object({ mcpServers: z.object({ secant: serverSchema }) })
            .parse(JSON.parse(raw));
          server = config.mcpServers.secant;
          assert.deepEqual(
            options.args.slice(options.args.indexOf("--allowedTools")),
            ["--allowedTools", "mcp__secant__step_done"],
          );
          return scripted.process.spawnOwnedProcess(options);
        },
      },
    });
    t.after(() => harness.close());
    const turn = harness.startTurn({
      ...turnRequest("go"),
      agentCalls: declarations,
    });
    const events: TurnEvent[] = [];
    await new Promise<void>((resolve) =>
      turn.subscribe((event) => {
        events.push(event);
        if (event.kind === "session") resolve();
      }),
    );
    assert.ok(server);
    const initialized = await rpc(server, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "channel-test", version: "1" },
    });
    assert.ok(initialized.session);
    const raised = new Promise<AgentCall>((resolve) =>
      turn.subscribe((event) => {
        if (event.kind === "agent-call" && event.phase === "raised")
          resolve(event.call);
      }),
    );
    const response = rpc(
      server,
      "tools/call",
      { name: "step_done", arguments: { reason: "  ready\nnow  " } },
      initialized.session,
    );
    const call = await raised;
    assert.equal(call.reason, "  ready\nnow  ");
    const answer = {
      callId: call.callId,
      ...(outcome === "refused"
        ? { outcome, reason: "unavailable" }
        : { outcome }),
    };
    assert.deepEqual(await turn.answerAgentCall(answer), {
      outcome: "accepted",
    });
    assert.deepEqual(await turn.answerAgentCall(answer), {
      outcome: "rejected",
      reason: "already-settled",
    });
    const result = z
      .object({
        result: z.object({
          isError: z.boolean(),
          content: z.array(z.object({ text: z.string() })),
        }),
      })
      .parse((await response).payload).result;
    assert.equal(result.isError, outcome === "refused");
    assert.equal(
      result.content[0]?.text,
      outcome === "accepted"
        ? "accepted: takes effect when this Turn finishes"
        : outcome === "held-for-review"
          ? "held for review: the human decides the next Iteration"
          : "unavailable",
    );
    await turn.interrupt();
    await turn.result();
    assert.equal(
      events.filter((e) => e.kind === "agent-call" && e.phase === "expired")
        .length,
      0,
    );
    const idle = z
      .object({ result: z.object({ isError: z.boolean() }) })
      .parse(
        (
          await rpc(
            server,
            "tools/call",
            { name: "step_done", arguments: { reason: "late" } },
            initialized.session,
          )
        ).payload,
      );
    assert.equal(idle.result.isError, true);
  });
}

test("Claude declines an elicitation and handles exact withdrawal without affecting native interrupt", async (t) => {
  const scripted = scriptedClaude({ answer: "confirm" });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const { turn, events } = await liveTurnOn(harness);
  scripted.emit(
    {
      type: "control_request",
      request_id: "elicitation-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "setup",
        message: "Finish setup",
        mode: "url",
        url: "https://example.com/setup",
      },
    },
    { type: "control_cancel_request", request_id: "elicitation-1" },
    { type: "control_cancel_request", request_id: "unrelated" },
  );
  await turn.interrupt();
  assert.equal((await turn.result()).kind, "interrupted");
  assert.deepEqual(
    events.filter((e) => e.kind === "elicitation-declined"),
    [
      {
        kind: "elicitation-declined",
        harness: "claude-code",
        server: "setup",
        message: "Finish setup",
        url: "https://example.com/setup",
      },
    ],
  );
  const replies = scripted.writes
    .flat()
    .filter((f) => f.type === "control_response");
  assert.ok(replies.length <= 1, "a withdrawal never sends a duplicate answer");
  if (replies.length)
    assert.deepEqual(replies[0], {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "elicitation-1",
        response: { action: "decline" },
      },
    });
});

for (const ending of [
  "completed",
  "failed",
  "lost",
  "interrupt",
  "close",
] as const) {
  test(`Claude expires unanswered calls before ${ending} settlement`, async (t) => {
    const scripted = scriptedClaude({ answer: "confirm" });
    let server: z.infer<typeof serverSchema> | undefined;
    const harness = await prepare({
      ...scripted,
      process: {
        ...scripted.process,
        spawnOwnedProcess(options) {
          const raw = options.args[options.args.indexOf("--mcp-config") + 1];
          assert.ok(raw);
          server = z
            .object({ mcpServers: z.object({ secant: serverSchema }) })
            .parse(JSON.parse(raw)).mcpServers.secant;
          return scripted.process.spawnOwnedProcess(options);
        },
      },
    });
    t.after(() => harness.close());
    const turn = harness.startTurn({
      ...turnRequest("go"),
      agentCalls: declarations,
    });
    const events: TurnEvent[] = [];
    await new Promise<void>((resolve) =>
      turn.subscribe((event) => {
        events.push(event);
        if (event.kind === "session") resolve();
      }),
    );
    assert.ok(server);
    const connection = await rpc(server, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "expiry", version: "1" },
    });
    assert.ok(connection.session);
    const raised = new Promise<AgentCall>((resolve) =>
      turn.subscribe((event) => {
        if (event.kind === "agent-call" && event.phase === "raised")
          resolve(event.call);
      }),
    );
    const pending = rpc(
      server,
      "tools/call",
      { name: "step_done", arguments: { reason: "ready" } },
      connection.session,
    ).catch(() => undefined);
    const call = await raised;
    if (ending === "interrupt") await turn.interrupt();
    else if (ending === "close") await harness.close();
    else if (ending === "lost") scripted.exit();
    else
      scripted.emit({
        type: "result",
        subtype: ending === "completed" ? "success" : "error_during_execution",
      });
    const result = await turn.result();
    assert.equal(
      result.kind,
      ending === "close"
        ? "lost"
        : ending === "interrupt"
          ? "interrupted"
          : ending,
    );
    assert.deepEqual(
      events.filter((e) => e.kind === "agent-call" && e.phase === "expired"),
      [{ kind: "agent-call", phase: "expired", callId: call.callId }],
    );
    assert.deepEqual(
      await turn.answerAgentCall({ callId: call.callId, outcome: "accepted" }),
      { outcome: "rejected", reason: "expired" },
    );
    const count = events.length;
    await pending;
    assert.equal(events.length, count);
  });
}

test("withdrawal expires only its exact elicitation while an unrelated reply failure loses the Turn", async (t) => {
  const scripted = scriptedClaude({ answer: "confirm" });
  const writes: { reject(error: Error): void }[] = [];
  let writesReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    writesReady = resolve;
  });
  const harness = await prepare({
    ...scripted,
    process: {
      ...scripted.process,
      async spawnOwnedProcess(options) {
        const launched = await scripted.process.spawnOwnedProcess(options);
        assert.ok(launched.ok);
        if (!launched.ok) throw new Error("unreachable");
        const owned = launched.process;
        return {
          ...launched,
          process: {
            ...owned,
            writeStdin(bytes) {
              const frame = JSON.parse(new TextDecoder().decode(bytes));
              if (frame.type !== "control_response")
                return owned.writeStdin(bytes);
              return new Promise<void>((_resolve, reject) => {
                writes.push({ reject });
                if (writes.length === 2) writesReady();
              });
            },
          },
        };
      },
    },
  });
  t.after(() => harness.close());
  const { turn, events } = await liveTurnOn(harness);
  for (const id of ["one", "two"])
    scripted.emit({
      type: "control_request",
      request_id: id,
      request: {
        subtype: "elicitation",
        mcp_server_name: "setup",
        message: id,
      },
    });
  await ready;
  scripted.emit(
    { type: "control_cancel_request", request_id: "one" },
    { ...init },
  );
  // The repeated Session observation proves the preceding withdrawal was read.
  await new Promise<void>((resolve) =>
    turn.subscribe((event) => {
      if (event.kind === "session") resolve();
    }),
  );
  writes[0]!.reject(new Error("cancelled write"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    events.filter((e) => e.kind === "elicitation-declined").length,
    2,
  );
  writes[1]!.reject(new Error("broken stdin"));
  const result = await turn.result();
  assert.equal(result.kind, "lost");
});

test("Claude writes a correlated decline and continues the Turn without raising a human request", async (t) => {
  const scripted = scriptedClaude({ answer: "confirm" });
  let received!: (frame: unknown) => void;
  const reply = new Promise<unknown>((resolve) => {
    received = resolve;
  });
  const harness = await prepare({
    ...scripted,
    process: {
      ...scripted.process,
      async spawnOwnedProcess(options) {
        const launched = await scripted.process.spawnOwnedProcess(options);
        assert.ok(launched.ok);
        if (!launched.ok) throw new Error("unreachable");
        const owned = launched.process;
        return {
          ...launched,
          process: {
            ...owned,
            writeStdin(bytes) {
              const frame = JSON.parse(new TextDecoder().decode(bytes));
              if (frame.type === "control_response") received(frame);
              return owned.writeStdin(bytes);
            },
          },
        };
      },
    },
  });
  t.after(() => harness.close());
  const { turn, events } = await liveTurnOn(harness);
  scripted.emit({
    type: "control_request",
    request_id: "form",
    request: {
      subtype: "elicitation",
      mcp_server_name: "setup",
      message: "Your name?",
      requested_schema: {},
    },
  });
  assert.deepEqual(await reply, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "form",
      response: { action: "decline" },
    },
  });
  scripted.emit({ type: "result", subtype: "success", result: "continued" });
  assert.equal((await turn.result()).kind, "completed");
  assert.equal(events.filter((e) => e.kind === "request-raised").length, 0);
  assert.deepEqual(
    events.filter((e) => e.kind === "elicitation-declined"),
    [
      {
        kind: "elicitation-declined",
        harness: "claude-code",
        server: "setup",
        message: "Your name?",
      },
    ],
  );
});

test("Claude reattaches the same bearer and declarations after a Windows reap", async (t) => {
  const scripted = scriptedClaude({
    answer: "confirm",
    containment: { kind: "contained" },
  });
  const args: string[][] = [];
  const harness = await prepare({
    ...scripted,
    process: {
      ...scripted.process,
      spawnOwnedProcess(options) {
        args.push([...options.args]);
        return scripted.process.spawnOwnedProcess(options);
      },
    },
  });
  t.after(() => harness.close());
  const start = (text: string) =>
    harness.startTurn({ ...turnRequest(text), agentCalls: declarations });
  const first = start("first");
  await new Promise<void>((resolve) =>
    first.subscribe((event) => {
      if (event.kind === "session") resolve();
    }),
  );
  await first.interrupt();
  assert.equal((await first.result()).kind, "interrupted");
  assert.throws(
    () => harness.startTurn(turnRequest("changed")),
    /declarations changed/,
  );
  const next = start("next");
  await new Promise<void>((resolve) =>
    next.subscribe((event) => {
      if (event.kind === "session") resolve();
    }),
  );
  assert.equal(args.length, 2);
  assert.ok(args[1]?.includes("--resume"));
  assert.ok(!args[1]?.includes("--session-id"));
  const config = (argv: string[]) => argv[argv.indexOf("--mcp-config") + 1];
  assert.equal(config(args[0]!), config(args[1]!));
  assert.equal(args[1]?.at(-1), "mcp__secant__step_done");
  await next.interrupt();
  assert.equal((await next.result()).kind, "interrupted");
});

for (const nativeInterrupt of [true, false]) {
  test(`closing with Claude's abort exit code is clean only after native confirmation: ${nativeInterrupt}`, async (t) => {
    const scripted = scriptedClaude({
      answer: nativeInterrupt ? "confirm" : "complete-instead",
      closeStdin: () => Promise.resolve({ kind: "exited", status: 1 }),
    });
    const harness = await prepare(scripted);
    t.after(() => harness.close());
    const { turn } = await liveTurnOn(harness);
    await turn.interrupt();
    assert.equal(
      (await turn.result()).kind,
      nativeInterrupt ? "interrupted" : "completed",
    );
    const cleanup = await harness.close();
    assert.equal(cleanup.clean, nativeInterrupt);
    if (!nativeInterrupt) assert.equal(cleanup.failure?.nativeCode, "1");
  });
}
