import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { TurnEvent, HarnessPhaseFact } from "../../src/harness/harness.js";
import { readFileSync } from "node:fs";
import {
  prepare,
  scriptedClaude,
  turnRequest,
  liveTurn,
  SESSION_ID,
  type Frame,
} from "./scripted-claude.js";

const controlSubtype = (frame: Frame) =>
  z.object({ subtype: z.string() }).safeParse(frame.request).data?.subtype;

const declarations = [
  { id: "step_done", description: "End the step", maxReasonLength: 400 },
];
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/claude-code/${name}`, import.meta.url),
    "utf8",
  );
const response = fixture("mcp-servers/set-servers.stdout");

test("m10-audit-claude-token-stdin: launch awaits recorded attachment before sending the first prompt", async (t) => {
  let acknowledge!: () => void;
  let received!: () => void;
  const attached = new Promise<void>((resolve) => {
    received = resolve;
  });
  const scripted = scriptedClaude({
    answer: "confirm",
    attachmentAnswer(frame, emit) {
      acknowledge = () =>
        emit(
          JSON.parse(
            response.replaceAll(
              "recording-mcp-set-servers",
              String(frame.request_id),
            ),
          ),
        );
      received();
    },
    userFrame: () => [
      ...liveTurn(),
      { type: "result", subtype: "success", result: "done" },
    ],
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn({
    ...turnRequest("go"),
    agentCalls: declarations,
  });
  await attached;
  const [launch] = scripted.spawnOptions;
  assert.ok(launch);
  assert.equal(launch.args.includes("--mcp-config"), false);
  assert.equal(launch.args.includes("--strict-mcp-config"), false);
  const [control] = scripted.writes[0] ?? [];
  assert.ok(control);
  assert.equal(control.type, "control_request");
  assert.deepEqual(
    scripted.writes[0]?.map((frame) => frame.type),
    ["control_request"],
  );
  const request = z
    .object({
      subtype: z.literal("mcp_set_servers"),
      servers: z.record(
        z.string(),
        z.object({ headers: z.object({ Authorization: z.string() }) }),
      ),
    })
    .parse(control.request);
  assert.equal(request.subtype, "mcp_set_servers");
  assert.deepEqual(Object.keys(request.servers), [
    "secant",
    "secant-permissions",
  ]);
  const token = request.servers.secant!.headers.Authorization.slice(
    "Bearer ".length,
  );
  assert.equal(JSON.stringify(launch.args).includes(token), false);
  assert.equal(JSON.stringify(launch.env).includes(token), false);
  acknowledge();
  assert.equal((await turn.result()).kind, "completed");
  assert.deepEqual(
    scripted.writes[0]?.map((frame: Frame) => frame.type),
    ["control_request", "control_request", "user"],
  );
});

for (const ending of [
  "refused",
  "server-error",
  "missing-server",
  "malformed",
  "timeout",
  "closed",
  "write-failed",
  "shutdown",
  "stdout-closed",
  "stdout-failed",
  "malformed-json",
  "wrong-id",
] as const) {
  test(`m10-audit-claude-token-stdin: ${ending} attachment fails launch without native detail or a prompt`, async (t) => {
    let received!: () => void;
    const attached = new Promise<void>((resolve) => {
      received = resolve;
    });
    const scripted = scriptedClaude({
      answer: "confirm",
      attachmentAnswer(frame, emit, exit) {
        received();
        if (ending === "closed") {
          exit();
          return;
        }
        if (ending === "timeout" || ending === "shutdown") return;
        const reply = JSON.parse(
          (ending === "refused"
            ? fixture("mcp-servers-invalid/set-servers.stdout")
            : response
          ).replaceAll("recording-mcp-set-servers", String(frame.request_id)),
        );
        if (ending === "server-error")
          reply.response.response.errors = { secant: "PRIVATE NATIVE DETAIL" };
        if (ending === "missing-server")
          reply.response.response.added = ["secant-permissions"];
        if (ending === "malformed")
          reply.response.response = {
            added: ["secant"],
            errors: "PRIVATE NATIVE DETAIL",
          };
        if (ending === "wrong-id")
          reply.response.request_id = "unrelated-request";
        emit(reply);
      },
    });
    const process = ![
      "write-failed",
      "stdout-closed",
      "stdout-failed",
      "malformed-json",
    ].includes(ending)
      ? scripted.process
      : {
          ...scripted.process,
          async spawnOwnedProcess(
            options: Parameters<typeof scripted.process.spawnOwnedProcess>[0],
          ) {
            const launched = await scripted.process.spawnOwnedProcess(options);
            assert.ok(launched.ok);
            return {
              ...launched,
              process: {
                ...launched.process,
                ...(ending === "write-failed"
                  ? {
                      writeStdin: () =>
                        Promise.reject(new Error("PRIVATE NATIVE DETAIL")),
                    }
                  : {
                      stdout: (async function* () {
                        if (ending === "stdout-failed")
                          throw new Error("PRIVATE NATIVE DETAIL");
                        if (ending === "malformed-json")
                          yield new TextEncoder().encode(
                            "{PRIVATE NATIVE DETAIL\n",
                          );
                      })(),
                    }),
              },
            };
          },
        };
    const phases: HarnessPhaseFact[] = [];
    const harness = await prepare(
      { ...scripted, process },
      { controlTimeoutMs: 10, phases },
    );
    t.after(() => harness.close());
    const turn = harness.startTurn({
      ...turnRequest("go"),
      agentCalls: declarations,
    });
    if (ending === "shutdown") {
      await attached;
      await harness.close();
    }
    const result = await turn.result();
    assert.equal(result.kind, "not-started");
    assert.ok(result.kind === "not-started");
    assert.equal(result.detail.failure.phase, "launch");
    assert.equal(result.detail.failure.category, "mcp-attachment");
    assert.equal(result.detail.failure.possibleEffects, "none");
    assert.equal(
      result.detail.failure.cause,
      `Claude Code MCP attachment ${["server-error", "missing-server", "malformed"].includes(ending) ? "failed" : ["shutdown", "stdout-closed", "stdout-failed", "malformed-json"].includes(ending) ? "closed" : ending === "wrong-id" ? "timeout" : ending}.`,
    );
    assert.equal(result.detail.failure.diagnostics, undefined);
    assert.equal(
      JSON.stringify(result).includes("PRIVATE NATIVE DETAIL"),
      false,
    );
    assert.equal(
      scripted.writes.flat().some((frame) => frame.type === "user"),
      false,
    );
    assert.equal(scripted.spawnOptions.length, 1);
    assert.equal(
      scripted.spawnOptions[0]?.args.includes("--mcp-config"),
      false,
    );
    assert.ok(
      phases.some(
        (fact) =>
          fact.phase === "launch" &&
          fact.kind === "phase-end" &&
          fact.outcome === "failed",
      ),
    );
  });
}

for (const relaunch of ["resume", "model", "windows-interrupt"] as const) {
  test(`m10-audit-claude-token-stdin: ${relaunch} reattaches before the prompt with the same Session bearer`, async (t) => {
    const scripted = scriptedClaude({
      answer: relaunch === "model" ? "ignore" : "confirm",
      ...(relaunch === "windows-interrupt"
        ? { containment: { kind: "contained" } as const }
        : {}),
    });
    const harness = await prepare(scripted, { controlTimeoutMs: 10 });
    t.after(() => harness.close());
    const request = {
      ...turnRequest("first"),
      agentCalls: declarations,
      modelChoice: { model: "haiku", effort: "low" },
    };
    const first = harness.startTurn(request);
    await new Promise<void>((resolve) =>
      first.subscribe((event) => {
        if (event.kind === "session") resolve();
      }),
    );
    if (relaunch === "windows-interrupt") await first.interrupt();
    else {
      scripted.emit({ type: "result", subtype: "success" });
      await first.result();
      if (relaunch === "resume") {
        scripted.exit({ kind: "exited", status: 0 });
        await scripted.closed();
      }
    }
    await first.result();
    const next = harness.startTurn({
      ...request,
      input: { text: "next" },
      modelChoice:
        relaunch === "model"
          ? { model: "sonnet", effort: "high" }
          : request.modelChoice,
    });
    await new Promise<void>((resolve) =>
      next.subscribe((event) => {
        if (event.kind === "session") resolve();
      }),
    );
    assert.equal(scripted.spawnOptions.length, 2);
    assert.ok(scripted.spawnOptions[1]?.args.includes("--resume"));
    assert.ok(scripted.spawnOptions[1]?.args.includes(SESSION_ID));
    const attachment = (frames: Frame[]) =>
      frames.find((frame) => controlSubtype(frame) === "mcp_set_servers")
        ?.request;
    assert.deepEqual(
      attachment(scripted.writes[1]!),
      attachment(scripted.writes[0]!),
    );
    for (const [index, frames] of scripted.writes.entries()) {
      assert.equal(controlSubtype(frames[0]!), "mcp_set_servers");
      assert.ok(frames.findIndex((frame) => frame.type === "user") > 0);
      assert.equal(
        scripted.spawnOptions[index]?.args.includes("--mcp-config"),
        false,
      );
      assert.equal(
        frames.some((frame) => controlSubtype(frame) === "mcp_status"),
        false,
      );
    }
    scripted.emit({ type: "result", subtype: "success" });
    assert.equal((await next.result()).kind, "completed");
  });
}

test("m10-audit-claude-token-stdin: recorded first Turn reaches both live MCP servers", async (t) => {
  const recordedFrames = (file: string) =>
    fixture(`mcp-servers/${file}`)
      .replaceAll("49449449-4494-4494-8494-494494494494", SESSION_ID)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const recorded = z
    .object({
      turns: z.array(
        z.object({
          steps: z.array(
            z.object({
              emit: z.string().optional(),
              bridge: z
                .object({
                  server: z.string().optional(),
                  tool: z.string().optional(),
                  arguments: z.unknown().optional(),
                  tool_name: z.string().optional(),
                  input: z.unknown().optional(),
                  expect: z
                    .object({ isError: z.boolean(), text: z.string() })
                    .optional(),
                })
                .optional(),
            }),
          ),
        }),
      ),
    })
    .parse(JSON.parse(fixture("mcp-servers/case.json")));
  let promptWritten!: () => void;
  const promptReady = new Promise<void>((resolve) => {
    promptWritten = resolve;
  });
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => {
      promptWritten();
      return [];
    },
    attachmentAnswer(frame, emit) {
      emit(
        JSON.parse(
          response.replaceAll(
            "recording-mcp-set-servers",
            String(frame.request_id),
          ),
        ),
      );
    },
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn({
    ...turnRequest("recorded MCP exchange"),
    agentCalls: declarations,
  });
  const events: TurnEvent[] = [];
  const answers: Promise<unknown>[] = [];
  turn.subscribe((event) => {
    events.push(event);
    if (event.kind === "agent-call" && event.phase === "raised")
      answers.push(
        turn.answerAgentCall({
          callId: event.call.callId,
          outcome: "accepted",
        }),
      );
    if (event.kind === "request-raised")
      answers.push(
        turn.answerRequest({
          requestId: event.request.requestId,
          kind: "approval",
          decision: "deny",
        }),
      );
  });
  // The Process's user-frame hook proves launch has finished before replaying Turn work.
  await promptReady;
  const servers = z
    .object({
      servers: z.record(
        z.string(),
        z.object({
          url: z.string(),
          headers: z.object({ Authorization: z.string() }),
        }),
      ),
    })
    .parse(scripted.writes[0]?.[0]?.request).servers;
  const call = async (
    serverName: string,
    method: string,
    params: unknown,
    session?: string,
  ) => {
    const server = servers[serverName];
    assert.ok(server);
    const result = await fetch(server.url, {
      method: "POST",
      headers: {
        ...server.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(result.status, 200);
    return {
      body: await result.json(),
      session: result.headers.get("mcp-session-id"),
    };
  };
  for (const step of recorded.turns[0]!.steps) {
    if (step.emit) scripted.emit(...recordedFrames(step.emit));
    if (!step.bridge) continue;
    const spec = step.bridge;
    const name = spec.server ?? "secant-permissions";
    const initialized = await call(name, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stdin-replay", version: "1" },
    });
    assert.ok(initialized.session);
    const reply = await call(
      name,
      "tools/call",
      {
        name: spec.tool ?? "approve",
        arguments: spec.arguments ?? {
          tool_name: spec.tool_name,
          input: spec.input,
        },
      },
      initialized.session,
    );
    const result = z
      .object({
        result: z.object({
          isError: z.boolean().optional(),
          content: z.array(z.object({ text: z.string() })),
        }),
      })
      .parse(reply.body).result;
    if (spec.expect)
      assert.deepEqual(
        { isError: result.isError ?? false, text: result.content[0]?.text },
        spec.expect,
      );
    else
      assert.deepEqual(JSON.parse(result.content[0]!.text), {
        behavior: "deny",
        message: "The tool use was denied.",
      });
  }
  assert.equal((await turn.result()).kind, "completed");
  assert.equal(
    events.filter(
      (event) => event.kind === "agent-call" && event.phase === "raised",
    ).length,
    1,
  );
  assert.equal(
    events.filter((event) => event.kind === "request-raised").length,
    1,
  );
  assert.deepEqual(await Promise.all(answers), [
    { outcome: "accepted" },
    { outcome: "accepted" },
  ]);
});

test("m10-audit-claude-token-stdin: closure after acknowledgement remains a launch failure before any prompt", async (t) => {
  const scripted = scriptedClaude({
    answer: "confirm",
    attachmentAnswer(frame, emit, exit) {
      emit(
        JSON.parse(
          response.replaceAll(
            "recording-mcp-set-servers",
            String(frame.request_id),
          ),
        ),
      );
      // Advance through control correlation to the launch continuation before closing.
      let remaining = 3;
      const close = () => {
        if (--remaining === 0) exit();
        else queueMicrotask(close);
      };
      queueMicrotask(close);
    },
  });
  const harness = await prepare(scripted);
  t.after(() => harness.close());
  const turn = harness.startTurn(turnRequest("go"));
  const result = await turn.result();
  assert.equal(result.kind, "not-started");
  assert.ok(result.kind === "not-started");
  assert.deepEqual(result.detail.failure, {
    phase: "launch",
    category: "mcp-attachment",
    possibleEffects: "none",
    cause: "Claude Code MCP attachment closed.",
  });
  assert.deepEqual(
    scripted.writes[0]?.map((frame) => controlSubtype(frame)),
    ["mcp_set_servers"],
  );
});
