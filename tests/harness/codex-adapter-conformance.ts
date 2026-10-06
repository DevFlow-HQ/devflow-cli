// The Codex-specific Adapter conformance cases: native approval mapping and
// fail-closed shapes, malformed/truncated/CRLF runtime framing, native
// steer/interrupt control arbitration and error codes, exact-thread recovery,
// recorded-fixture replay, discovery/resolution, the profile, and schema/model
// qualification — the facts the shared conformance suite does not cover.
//
// These moved out of the process-free semantic suite (#198): every case drives
// the real Codex Adapter (whose `prepare` spawns the qualification child) or the
// synthetic replayer/scripted process a real child cannot be made to emit on
// demand, so they run in the standalone runtime-conformance runner
// (tests/process/runtime-conformance.ts), not under the test runner. This file is
// not a `.test.ts`: a local `test` shim collects each case and
// `registerCodexAdapterConformance` forwards them to the runner.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import {
  CODEX_EXECUTABLE_ENV,
  type CleanupReport,
  type CodexRecordingObserver,
  type DurableTurnRecorder,
  type HarnessPlatform,
  type ModelChoice,
  type ModelObservation,
  type PrepareOptions,
  type PreparedHarness,
  type RecoveryCoordinate,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from "../../src/harness/harness.js";
import { createCodexAdapter } from "./test-adapters.js";
import {
  createProcessAdapter,
  type ProcessAdapter,
  type OwnedProcess,
} from "../../src/process/process.js";
import { withRunnerObserver } from "../helpers/standalone.js";
import { processWithSpawn } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { seedTestRepairWorkspace } from "../helpers/testRepairWorkspace.js";
import {
  installCodexReplayer,
  installSyntheticCodexReplayer,
  type InstalledCodexReplayer,
} from "./codex-replayer.js";
import {
  CODEX_RECORDING_INPUT,
  CODEX_TEST_REPAIR_MODEL_CHOICE,
  CODEX_RECORDING_MODEL_CHOICE,
  codexTestRepairPrompt,
} from "./codex-recording-cases.js";
import {
  collectAdapterConformanceCases,
  type RegisterConformanceCase,
} from "./conformance.js";
import { createCodexRecordingCapture } from "./codex-recording.js";
import { replayRecordedLine } from "./codex-replay-path.js";

// Each `test(...)` below registers with the runtime-conformance runner instead of
// the test runner; the shared collector carries `node:test`'s `{ skip }` option.
const { test, forward } = collectAdapterConformanceCases();

export function registerCodexAdapterConformance(
  register: RegisterConformanceCase,
): void {
  forward(register);
}

// The shared prepare/profile, Turn-lifecycle, native-steer, interrupt/recovery,
// exact-thread-recovery, and approval conformance cases over the real Codex
// replayer moved out of the Bun test runner into the standalone
// runtime-conformance runner (#184): see tests/harness/replayer-conformance.ts
// (`codex-replayer-conformance`). The Codex-specific cases below stay here.

test("Codex Agent calls use an authenticated Session channel and settle before producer close", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  try {
    assert.equal(prepared.profile.agentCalls.available, true);
    const turn = prepared.startTurn({
      ...turnRequest(),
      agentCalls: [
        { id: "step_done", description: "End the step", maxReasonLength: 400 },
      ],
    });
    const events = observeEvents(turn);
    await waitForEventCount(turn, events, "model", 1);
    const native = installed
      .invocations()
      .flatMap((i) => i.stdinLines)
      .map((line) => JSON.parse(line));
    const start = native.find((frame) => frame.method === "thread/start");
    assert.equal(start.params.approvalsReviewer, "user");
    assert.equal(
      start.params.config["mcp_servers.secant.default_tools_approval_mode"],
      "approve",
    );
    const url = start.params.config["mcp_servers.secant.url"];
    const headers = {
      ...start.params.config["mcp_servers.secant.http_headers"],
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const rpc = async (method: string, params: object) =>
      fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "codex-test", version: "1" },
    });
    assert.equal(init.status, 200);
    await init.json();
    const sessionId = init.headers.get("mcp-session-id");
    assert.ok(sessionId);
    Object.assign(headers, { "mcp-session-id": sessionId });
    const wrong = await rpc("tools/call", {
      name: "step_done",
      arguments: { reason: "done" },
      _meta: { threadId: "wrong" },
    });
    assert.equal((await wrong.json()).result.isError, true);
    const stale = await rpc("tools/call", {
      name: "step_done",
      arguments: { reason: "done" },
      _meta: {
        "x-codex-turn-metadata": {
          thread_id: "thread-1",
          turn_id: "stale-turn",
        },
      },
    });
    assert.equal((await stale.json()).result.isError, true);
    assert.equal(events.filter((e) => e.kind === "agent-call").length, 0);
    const call = rpc("tools/call", {
      name: "step_done",
      arguments: { reason: "  done\nnow  " },
      _meta: {
        "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-1" },
      },
    });
    await waitForEventCount(turn, events, "agent-call", 1);
    const raised = events.find(
      (e) => e.kind === "agent-call" && e.phase === "raised",
    );
    assert.ok(raised?.kind === "agent-call" && raised.phase === "raised");
    assert.equal(raised.call.reason, "  done\nnow  ");
    const answer = {
      callId: raised.call.callId,
      outcome: "held-for-review",
    } as const;
    assert.deepEqual(await turn.answerAgentCall(answer), {
      outcome: "accepted",
    });
    assert.deepEqual(await turn.answerAgentCall(answer), {
      outcome: "rejected",
      reason: "already-settled",
    });
    assert.equal(
      (await (await call).json()).result.content[0].text,
      "held for review: the human decides the next Iteration",
    );
    // A direct helper and a deeper descendant inherit the Session bearer;
    // their own Turn ids cannot be compared with the parent's live Turn.
    let callCount = 1;
    for (const parent of ["thread-1", "helper-thread"]) {
      const helper = rpc("tools/call", {
        name: "step_done",
        arguments: { reason: "helper done" },
        _meta: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "helper-descendant",
            turn_id: "helper-turn",
            parent_thread_id: parent,
          }),
        },
      });
      await waitForEventCount(turn, events, "agent-call", ++callCount);
      const latest = events.at(-1);
      assert.ok(latest?.kind === "agent-call" && latest.phase === "raised");
      assert.deepEqual(
        await turn.answerAgentCall({
          callId: latest.call.callId,
          outcome: "accepted",
        }),
        { outcome: "accepted" },
      );
      assert.equal((await (await helper).json()).result.isError, false);
    }
    const unanswered = rpc("tools/call", {
      name: "step_done",
      arguments: { reason: "later" },
    });
    await waitForEventCount(turn, events, "agent-call", ++callCount);
    await turn.interrupt();
    assert.equal((await turn.result()).kind, "interrupted");
    assert.equal((await (await unanswered).json()).result.isError, true);
    assert.equal(events.at(-1)?.kind, "agent-call");
    assert.deepEqual(await turn.answerAgentCall(answer), {
      outcome: "rejected",
      reason: "expired",
    });
    const idle = await rpc("tools/call", {
      name: "step_done",
      arguments: { reason: "idle" },
    });
    assert.equal(
      (await idle.json()).result.content[0].text,
      "no Turn in progress",
    );
  } finally {
    await prepared.close();
  }
});

for (const legacy of [false, true]) {
  test(`Codex recorded channel ${legacy ? "legacy input decline" : "Agent call, approvals and elicitation declines"}`, async () => {
    const installed = installCodexReplayer(
      legacy ? "agent-calls-legacy" : "agent-calls",
    );
    const prepared = await prepareCodex(installed.path);
    try {
      const turn = prepared.startTurn({
        ...turnRequest(undefined, {
          text: legacy
            ? CODEX_RECORDING_INPUT.agentCallsLegacy
            : CODEX_RECORDING_INPUT.agentCalls,
        }),
        agentCalls: [
          {
            id: "step_done",
            description: "End the Step",
            maxReasonLength: 400,
          },
        ],
      });
      const events = observeEvents(turn);
      turn.subscribe((event) => {
        if (event.kind === "agent-call" && event.phase === "raised")
          void turn.answerAgentCall({
            callId: event.call.callId,
            outcome: "accepted",
          });
        if (event.kind === "request-raised")
          void turn.answerRequest({
            requestId: event.request.requestId,
            kind: "approval",
            decision: "allow",
          });
      });
      const result = await turn.result();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      assert.equal(
        events.filter((event) => event.kind === "request-raised").length,
        legacy ? 0 : 3,
      );
      assert.equal(
        events.filter(
          (event) => event.kind === "agent-call" && event.phase === "raised",
        ).length,
        legacy ? 0 : 1,
      );
      assert.deepEqual(
        events.filter((event) => event.kind === "elicitation-declined"),
        legacy
          ? []
          : [
              {
                kind: "elicitation-declined",
                harness: "codex",
                server: "recording_external",
                message: "Enter a recording code",
              },
              {
                kind: "elicitation-declined",
                harness: "codex",
                server: "recording_external",
                message: "Open the recording verification link",
                url: "https://example.com/verify",
              },
            ],
      );
    } finally {
      await prepared.close();
    }
  });
}

test("Codex tool elicitations offer Allow/Deny and decline other elicitations", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "allow",
        kind: "elicitation",
        toolApproval: true,
        message: "Call external.write with value 1",
        toolParams: { path: "safe" },
        itemId: "1",
      },
      {
        id: "deny",
        kind: "elicitation",
        toolApproval: true,
        message: "Call external.write with value 2",
        toolParams: { path: "sensitive" },
        itemId: "2",
        uncorrelated: true,
      },
      {
        id: "form",
        kind: "elicitation",
        message: "Enter a code",
        itemId: "3",
        uncorrelated: true,
      },
      {
        id: "link",
        kind: "elicitation",
        message: "Open this link",
        url: "https://example.com/verify",
        itemId: "4",
      },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  try {
    const turn = prepared.startTurn(turnRequest());
    const events = observeEvents(turn);
    await waitForRequestCount(turn, events, 2);
    const requests = events.flatMap((e) =>
      e.kind === "request-raised" ? [e.request] : [],
    );
    assert.deepEqual(
      requests.map((r) => r.shape),
      [
        {
          kind: "approval",
          tool: "external",
          input: 'Call external.write with value 1\n{"path":"safe"}',
          decisions: ["allow", "deny"],
        },
        {
          kind: "approval",
          tool: "external",
          input: 'Call external.write with value 2\n{"path":"sensitive"}',
          decisions: ["allow", "deny"],
        },
      ],
    );
    for (const [index, request] of requests.entries())
      assert.deepEqual(
        await turn.answerRequest({
          requestId: request.requestId,
          kind: "approval",
          decision: index === 0 ? "allow" : "deny",
        }),
        { outcome: "accepted" },
      );
    assert.equal((await turn.result()).kind, "completed");
    assert.deepEqual(
      events.filter((e) => e.kind === "elicitation-declined"),
      [
        {
          kind: "elicitation-declined",
          harness: "codex",
          server: "external",
          message: "Enter a code",
        },
        {
          kind: "elicitation-declined",
          harness: "codex",
          server: "external",
          message: "Open this link",
          url: "https://example.com/verify",
        },
      ],
    );
    const replies = installed
      .invocations()
      .flatMap((i) => i.stdinLines)
      .map((line) => JSON.parse(line))
      .filter((frame) => ["allow", "deny", "form", "link"].includes(frame.id));
    assert.deepEqual(
      replies.map((r) => r.result),
      [
        { action: "decline", content: null, _meta: null },
        { action: "decline", content: null, _meta: null },
        { action: "accept", content: { decision: "approve" }, _meta: null },
        { action: "decline", content: null, _meta: null },
      ],
    );
  } finally {
    await prepared.close();
  }
});

test("Codex unknown reverse requests still fail the Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [{ id: "unknown", kind: "unknown-request", itemId: "1" }],
  });
  const prepared = await prepareCodex(installed.path);
  try {
    assert.equal(
      (await prepared.startTurn(turnRequest()).result()).kind,
      "lost",
    );
  } finally {
    await prepared.close();
  }
});

for (const fault of [
  "thread/start",
  "turn/start",
  "thread/read",
  "native-error",
] as const) {
  test(`Codex Session bearer is redacted from ${fault}`, async () => {
    const installed = installSyntheticCodexReplayer();
    if (fault === "thread/read") installed.configureThreadRead("rpc-error");
    if (fault === "native-error")
      installed.configureTurn({ retryingError: "NATIVE_BEARER" });
    const native = createProcessAdapter(withRunnerObserver());
    let bearer: string | undefined;
    const processAdapter = processWithSpawn(async (options) => {
      const spawned = await native.spawnOwnedProcess(options);
      if (!spawned.ok) return spawned;
      const owned = spawned.process;
      return {
        ...spawned,
        process: {
          stdout: {
            async *[Symbol.asyncIterator]() {
              for await (const bytes of owned.stdout) {
                const text = new TextDecoder()
                  .decode(bytes)
                  .replaceAll("NATIVE_BEARER", bearer ?? "NATIVE_BEARER")
                  .replaceAll(
                    "failed to read thread: rollout is empty",
                    `echoed ${bearer ?? "unavailable"}`,
                  );
                yield new TextEncoder().encode(text);
              }
            },
          },
          stderr: owned.stderr,
          closed: () => owned.closed(),
          closeStdin: (ms) => owned.closeStdin(ms),
          interrupt: (ms) => owned.interrupt(ms),
          writeStdin(bytes) {
            const text = new TextDecoder().decode(bytes);
            const frame = JSON.parse(text);
            if (frame.method === "thread/start") {
              bearer =
                frame.params.config[
                  "mcp_servers.secant.http_headers"
                ].Authorization.slice(7);
            }
            if (
              (fault === "thread/start" || fault === "turn/start") &&
              frame.method === fault
            )
              return Promise.reject(new Error(`write failed ${bearer}`));
            return owned.writeStdin(bytes);
          },
        },
      };
    });
    const result = await createCodexAdapter({
      path: installed.path,
      env: {},
    }).prepare({ workspace: process.cwd(), process: processAdapter });
    assert.ok(result.ok);
    try {
      const turn = result.harness.startTurn({
        ...turnRequest(),
        agentCalls: [
          { id: "step_done", description: "Done", maxReasonLength: 400 },
        ],
      });
      const events = observeEvents(turn);
      const terminal = await turn.result();
      assert.ok(bearer);
      const secret = bearer;
      if (fault === "thread/start" || fault === "turn/start") {
        assert.equal(
          terminal.kind,
          fault === "thread/start" ? "not-started" : "lost",
        );
        assert.ok(terminal.kind === "not-started" || terminal.kind === "lost");
        const cause = terminal.detail.failure?.cause;
        assert.ok(cause instanceof Error);
        assert.equal(cause.message.includes(bearer), false);
        assert.equal(cause.stack?.includes(bearer), false);
        assert.match(cause.message, /redacted/);
      } else {
        assert.equal(terminal.kind, "completed");
        const descriptions = events.flatMap((event) =>
          event.kind === "activity" ? [event.description] : [],
        );
        assert.ok(descriptions.some((text) => text.includes("redacted")));
        assert.equal(
          descriptions.some((text) => text.includes(secret)),
          false,
        );
      }
    } finally {
      await result.harness.close();
    }
  });
}

// --- Approval requests -------------------------------------------------------

test("Codex approval allow and deny map only to native accept and decline", async () => {
  const installed = installCodexReplayer("codex-approval-contract");
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 2);
  const requests = events.flatMap((event) =>
    event.kind === "request-raised" ? [event.request] : [],
  );
  assert.deepEqual(
    requests.map((request) => request.shape),
    [
      {
        kind: "approval",
        tool: "command",
        input: "bun test",
        decisions: ["allow", "deny"],
      },
      {
        kind: "approval",
        tool: "file-change",
        input: "update src/file.ts",
        decisions: ["allow", "deny"],
      },
    ],
  );
  await turn.answerRequest({
    requestId: requests[0]!.requestId,
    kind: "approval",
    decision: "allow",
  });
  await turn.answerRequest({
    requestId: requests[1]!.requestId,
    kind: "approval",
    decision: "deny",
  });
  assert.equal((await turn.result()).kind, "completed");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const responses = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter(
      (message) => message.method === undefined && message.result !== undefined,
    );
  assert.deepEqual(responses.slice(-2), [
    { id: 5, result: { decision: "accept" } },
    { id: "server-file-1", result: { decision: "decline" } },
  ]);
  await prepared.close();
});

test("native approval resolution wins over a late answer while peers remain independent", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "resolved",
        kind: "command",
        itemId: "command-1",
        command: "bun test",
      },
      {
        id: "live",
        kind: "file",
        itemId: "file-change-1",
        changes: [{ path: "src/file.ts", kind: "update" }],
      },
    ],
    resolveFirstApproval: true,
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForExpiredRequestCount(turn, events, 1);
  const requests = events.flatMap((event) =>
    event.kind === "request-raised" ? [event.request] : [],
  );
  assert.deepEqual(
    await turn.answerRequest({
      requestId: requests[0]!.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "rejected", reason: "already-settled" },
  );
  assert.deepEqual(
    await turn.answerRequest({
      requestId: requests[1]!.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "accepted" },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("concurrent answers write exactly one native decision", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "one-answer",
        kind: "command",
        itemId: "command-1",
        command: "bun test",
      },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  const receipts = await Promise.all([
    turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "allow",
    }),
    turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "deny",
    }),
  ]);
  assert.deepEqual(receipts, [
    { outcome: "accepted" },
    { outcome: "rejected", reason: "already-settled" },
  ]);
  assert.equal((await turn.result()).kind, "completed");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const nativeAnswers = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter((message) => message.id === "one-answer");
  assert.deepEqual(nativeAnswers, [
    { id: "one-answer", result: { decision: "accept" } },
  ]);
  await prepared.close();
});

test("a duplicate native server request id fails the Turn closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "duplicate",
        kind: "command",
        itemId: "command-1",
        command: "bun test",
      },
    ],
    duplicateFirstApproval: true,
  });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  assert.match(result.detail.failure?.diagnostics ?? "", /reused/);
  await prepared.close();
});

test("a moved file approval exposes both exact paths", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "move-file",
        kind: "file",
        itemId: "file-change-1",
        changes: [
          {
            path: "src/old.ts",
            kind: "update",
            movePath: "src/new.ts",
          },
        ],
      },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  assert.equal(request.request.shape.kind, "approval");
  if (request.request.shape.kind !== "approval") throw new Error("unreachable");
  assert.equal(request.request.shape.input, "move src/old.ts to src/new.ts");
  await turn.answerRequest({
    requestId: request.request.requestId,
    kind: "approval",
    decision: "deny",
  });
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

for (const [nativeRace, terminalStatus] of [
  ["resolution", "completed"],
  ["terminal", "completed"],
  ["terminal", "interrupted"],
  ["terminal", "failed"],
] as const) {
  test(`${nativeRace} confirms an approval answer while its write is in flight (${terminalStatus})`, async () => {
    const { controlled, prepared, turn, events, request } =
      await approvalRaceFixture();
    const humanAnswer = {
      requestId: request.request.requestId,
      kind: "approval",
      decision: "allow",
    } satisfies Parameters<typeof turn.answerRequest>[0];
    const answer = turn.answerRequest(humanAnswer);
    await controlled.responseWriteStarted;
    if (nativeRace === "resolution") {
      controlled.emitResolution();
      await waitForEventCount(turn, events, "request-answered", 1);
      controlled.emitResolution();
      controlled.releaseResponseWrite();
      assert.deepEqual(await answer, { outcome: "accepted" });
    }
    controlled.emitTerminal(terminalStatus);
    assert.equal((await turn.result()).kind, terminalStatus);
    assert.deepEqual(
      events.filter((event) => event.kind === "request-answered"),
      [
        {
          kind: "request-answered",
          requestId: humanAnswer.requestId,
          by: "human",
          answer: humanAnswer,
        },
      ],
    );
    assert.equal(
      events.filter((event) => event.kind === "request-expired").length,
      0,
    );
    const eventCountAtResult = events.length;
    controlled.releaseResponseWrite();
    assert.deepEqual(await answer, { outcome: "accepted" });
    assert.equal(events.length, eventCountAtResult);
    await prepared.close();
  });
}

for (const nativeRace of ["resolution", "terminal"] as const) {
  test(`${nativeRace} expires an approval before its answer write starts`, async () => {
    const { controlled, prepared, turn, events, request } =
      await approvalRaceFixture();
    if (nativeRace === "resolution") {
      controlled.emitResolution();
      await waitForExpiredRequestCount(turn, events, 1);
    } else {
      controlled.emitTerminal();
      assert.equal((await turn.result()).kind, "completed");
    }
    assert.deepEqual(
      await turn.answerRequest({
        requestId: request.request.requestId,
        kind: "approval",
        decision: "allow",
      }),
      {
        outcome: "rejected",
        reason: nativeRace === "resolution" ? "already-settled" : "expired",
      },
    );
    assert.equal(controlled.responseWriteCount, 0);
    assert.deepEqual(
      events.filter((event) => event.kind === "request-expired"),
      [{ kind: "request-expired", requestId: request.request.requestId }],
    );
    assert.equal(
      events.filter((event) => event.kind === "request-answered").length,
      0,
    );
    if (nativeRace === "resolution") controlled.emitTerminal();
    assert.equal((await turn.result()).kind, "completed");
    await prepared.close();
  });
}

test("approval response write failure preserves its cause and expires the request", async () => {
  const { controlled, prepared, turn, events, request } =
    await approvalRaceFixture();
  const answer = turn.answerRequest({
    requestId: request.request.requestId,
    kind: "approval",
    decision: "allow",
  });
  await controlled.responseWriteStarted;
  const cause = new Error("scripted approval response write failure");
  controlled.rejectResponseWrite(cause);
  assert.deepEqual(await answer, { outcome: "rejected", reason: "expired" });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.cause, cause);
  assert.equal(
    events.filter((event) => event.kind === "request-expired").length,
    1,
  );
  await prepared.close();
});

for (const nativeRace of ["resolution", "terminal"] as const) {
  test(`${nativeRace} confirmation survives a subsequent approval write failure`, async () => {
    const { controlled, prepared, turn, events, request } =
      await approvalRaceFixture();
    const humanAnswer = {
      requestId: request.request.requestId,
      kind: "approval",
      decision: "deny",
    } satisfies Parameters<typeof turn.answerRequest>[0];
    const answer = turn.answerRequest(humanAnswer);
    await controlled.responseWriteStarted;
    if (nativeRace === "resolution") {
      controlled.emitResolution();
      await waitForEventCount(turn, events, "request-answered", 1);
    } else {
      controlled.emitTerminal();
      assert.equal((await turn.result()).kind, "completed");
    }
    const cause = new Error("write failed after native confirmation");
    controlled.rejectResponseWrite(cause);
    assert.deepEqual(await answer, { outcome: "accepted" });
    const result = await turn.result();
    assert.equal(
      result.kind,
      nativeRace === "resolution" ? "lost" : "completed",
    );
    if (result.kind === "lost")
      assert.equal(result.detail.failure?.cause, cause);
    assert.deepEqual(
      events.filter((event) => event.kind === "request-answered"),
      [
        {
          kind: "request-answered",
          requestId: humanAnswer.requestId,
          by: "human",
          answer: humanAnswer,
        },
      ],
    );
    assert.equal(
      events.filter((event) => event.kind === "request-expired").length,
      0,
    );
    await prepared.close();
  });
}

test("close expires an approval answer whose write is in flight", async () => {
  const { controlled, prepared, turn, events, request } =
    await approvalRaceFixture();
  const answer = turn.answerRequest({
    requestId: request.request.requestId,
    kind: "approval",
    decision: "allow",
  });
  await controlled.responseWriteStarted;
  const closing = prepared.close();
  await waitForExpiredRequestCount(turn, events, 1);
  controlled.emitResolution();
  controlled.emitTerminal();
  assert.equal((await turn.result()).kind, "completed");
  controlled.releaseResponseWrite();
  assert.deepEqual(await answer, { outcome: "rejected", reason: "expired" });
  assert.deepEqual(
    events.filter((event) => event.kind === "request-expired"),
    [{ kind: "request-expired", requestId: request.request.requestId }],
  );
  assert.equal(
    events.filter((event) => event.kind === "request-answered").length,
    0,
  );
  assert.equal((await closing).clean, true);
});

for (const failure of [
  "connection loss",
  "protocol corruption",
  "nonterminal completion",
] as const) {
  test(`${failure} expires an unconfirmed approval answer while its write is in flight`, async () => {
    const { controlled, prepared, turn, events, request } =
      await approvalRaceFixture();
    const answer = turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "allow",
    });
    await controlled.responseWriteStarted;
    if (failure === "connection loss") controlled.endConnection();
    else if (failure === "protocol corruption") controlled.emitCorruption();
    else controlled.emitTerminal("inProgress");
    assert.equal((await turn.result()).kind, "lost");
    const eventCountAtResult = events.length;
    controlled.releaseResponseWrite();
    assert.deepEqual(await answer, { outcome: "rejected", reason: "expired" });
    assert.deepEqual(
      events.filter((event) => event.kind === "request-expired"),
      [{ kind: "request-expired", requestId: request.request.requestId }],
    );
    assert.equal(
      events.filter((event) => event.kind === "request-answered").length,
      0,
    );
    assert.equal(events.length, eventCountAtResult);
    await prepared.close();
  });
}

test("terminal truth expires an outstanding approval before settling", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "expired",
        kind: "command",
        itemId: "command-1",
        command: "bun test",
      },
    ],
    completeWithOutstandingApproval: true,
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  assert.equal((await turn.result()).kind, "completed");
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  assert.equal(
    events.filter((event) => event.kind === "request-expired").length,
    1,
  );
  assert.deepEqual(
    await turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "rejected", reason: "expired" },
  );
  await prepared.close();
});

test("close expires an outstanding approval before native interruption", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "close-command",
        kind: "command",
        itemId: "close-command-1",
        command: "bun test",
      },
    ],
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  await waitForSession(turn);

  assert.equal((await prepared.close()).clean, true);
  assert.equal((await turn.result()).kind, "interrupted");
  const expired = events.filter((event) => event.kind === "request-expired");
  assert.equal(expired.length, 1);
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  assert.equal(
    JSON.parse(appServer.stdinLines.at(-1) ?? "{}").method,
    "turn/interrupt",
  );
});

test("unsupported mandatory Codex approval shapes fail closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      { id: "unsupported", kind: "unsupported-command", itemId: "stdin-1" },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  await prepared.close();
});

test("a file approval without exact file-change context fails closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [{ id: "file", kind: "file", itemId: "missing-file-change" }],
  });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  assert.match(
    result.detail.failure?.diagnostics ?? "",
    /without exact action context/,
  );
  await prepared.close();
});

test("request-user-input is declined without ending the Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      { id: "request-input", kind: "request-user-input", itemId: "input-1" },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "completed");
  const replies = installed
    .invocations()
    .flatMap((i) => i.stdinLines)
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.id === "request-input");
  assert.deepEqual(replies, [{ id: "request-input", result: { answers: {} } }]);
  assert.equal(prepared.profile.clarifications.available, false);
  await prepared.close();
});

// --- Turns: admission, framing, and terminal truth ---------------------------

test("refused durable admission sends no prompt content", async () => {
  const installed = installSyntheticCodexReplayer();
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(
    turnRequest({
      admit: () =>
        Promise.resolve({ recorded: false, reason: "run.db refused" }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    }),
  );

  assert.equal((await turn.result()).kind, "not-started");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const messages = appServer.stdinLines.map((line) => JSON.parse(line));
  assert.ok(messages.some((message) => message.method === "thread/start"));
  assert.ok(messages.every((message) => message.method !== "turn/start"));
  assert.ok(
    appServer.stdinLines.every((line) => !line.includes("private prompt")),
  );
  await prepared.close();
});

for (const stopAfter of ["accepted", "item-completed"] as const) {
  test(`${stopAfter} without terminal truth settles lost`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({ stopAfter });
    const prepared = await prepareCodex(installed.path);
    const result = await prepared.startTurn(turnRequest()).result();
    assert.equal(result.kind, "lost");
    if (result.kind !== "lost") throw new Error("unreachable");
    assert.equal(result.detail.unknown, "completion");
    await prepared.close();
  });
}

test("a malformed runtime frame loses the Turn without fabricating completion", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ malformedFrame: true });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  await prepared.close();
});

test("a truncated runtime frame loses the Turn as protocol corruption", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ truncatedFrame: true });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  await prepared.close();
});

test("a CRLF-delimited Codex terminal frame completes through the Adapter", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ terminalLineEnding: "crlf" });
  const capture = createCodexRecordingCapture();
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    recordingObserver: capture.observer,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const result = await preparedResult.harness.startTurn(turnRequest()).result();
  assert.equal(result.kind, "completed");
  await preparedResult.harness.close();

  const terminal = capture.traffic.find(
    (entry) =>
      entry.direction === "stdout" && entry.line.includes('"turn/completed"'),
  );
  assert.ok(terminal !== undefined);
  assert.equal(terminal.line.endsWith("\r\n"), true);
});

test("supported Codex item lifecycles use semantic Harness events", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ fullActivity: true });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  assert.equal((await turn.result()).kind, "completed");
  const tools = events
    .filter((event) => event.kind === "tool-call")
    .map((event) => event.call.tool);
  assert.deepEqual(new Set(tools), new Set(["command", "file-change", "mcp"]));
  assert.equal(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes("futureDisplayItem"),
    ),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        event.kind === "tool-call" &&
        ["web", "subagent", "other"].includes(event.call.tool),
    ),
    false,
    "unqualified synthetic item shapes stay absent; the fake covers the full semantic vocabulary",
  );
  await prepared.close();
});

test("retrying errors remain nonterminal activity", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ retryingError: "temporary overload" });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  assert.equal((await turn.result()).kind, "completed");
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes("retrying") &&
        event.description.includes("temporary overload"),
    ),
  );
  await prepared.close();
});

test("retry evidence is not reused as terminal failure evidence", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.failTurn("authoritative terminal failure");
  installed.configureTurn({ retryingError: "temporary overload" });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("unreachable");
  assert.equal(
    result.detail.failure.diagnostics,
    "authoritative terminal failure",
  );
  await prepared.close();
});

for (const malformed of ["malformedItem", "malformedTerminal"] as const) {
  test(`${malformed} fails closed as protocol corruption`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({ [malformed]: true });
    const prepared = await prepareCodex(installed.path);
    const result = await prepared.startTurn(turnRequest()).result();
    assert.equal(result.kind, "lost");
    if (result.kind !== "lost") throw new Error("unreachable");
    assert.equal(result.detail.failure?.category, "protocol-corruption");
    await prepared.close();
  });
}

test("only the matching terminal Turn event can settle", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ mismatchedTerminal: true });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "completed");
  await prepared.close();
});

test("later fresh Turns reuse one private thread and continue RPC ids", async () => {
  const installed = installCodexReplayer("two-turns");
  const prepared = await prepareCodex(installed.path);
  // Recorded on codex-cli 0.160.0 (#345): each turn/start carries its Model
  // choice, and thread/read reports each Turn's effort back.
  const first = await prepared
    .startTurn({
      ...turnRequest(undefined, { text: CODEX_RECORDING_INPUT.completion }),
      modelChoice: CODEX_RECORDING_MODEL_CHOICE.first,
    })
    .result();
  assert.deepEqual(effectiveModel(first), {
    known: true,
    ...CODEX_RECORDING_MODEL_CHOICE.first,
  });
  const second = await prepared
    .startTurn({
      ...turnRequest(undefined, {
        text: CODEX_RECORDING_INPUT.secondCompletion,
      }),
      modelChoice: CODEX_RECORDING_MODEL_CHOICE.second,
    })
    .result();
  assert.deepEqual(effectiveModel(second), {
    known: true,
    ...CODEX_RECORDING_MODEL_CHOICE.second,
  });
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const requests = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter((message) => message.id !== undefined);
  assert.deepEqual(
    requests.map((message) => [message.id, message.method]),
    [
      [1, "initialize"],
      [2, "account/read"],
      [3, "model/list"],
      [4, "thread/start"],
      [5, "turn/start"],
      [6, "thread/read"],
      [7, "turn/start"],
      [8, "thread/read"],
    ],
  );
  await prepared.close();
});

test("a second human Turn uses the live Codex thread without a redundant resume", async () => {
  const installed = installCodexReplayer("two-turns");
  const prepared = await prepareCodex(installed.path);
  const firstTurn = prepared.startTurn({
    ...turnRequest(undefined, { text: CODEX_RECORDING_INPUT.completion }),
    modelChoice: CODEX_RECORDING_MODEL_CHOICE.first,
  });
  const events = observeEvents(firstTurn);
  const first = await firstTurn.result();
  assert.equal(first.kind, "completed");
  const coordinate = events.flatMap((event) =>
    event.kind === "session" && event.facts?.recoveryCoordinate !== undefined
      ? [event.facts.recoveryCoordinate]
      : [],
  )[0];
  assert.ok(coordinate !== undefined);

  const second = await prepared
    .startTurn({
      ...turnRequest(undefined, {
        text: CODEX_RECORDING_INPUT.secondCompletion,
      }),
      resume: coordinate,
      modelChoice: CODEX_RECORDING_MODEL_CHOICE.second,
    })
    .result();
  assert.equal(second.kind, "completed");

  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const requests = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter((message) => message.id !== undefined);
  assert.deepEqual(
    requests.map((message) => [
      message.id,
      message.method,
      message.params?.threadId,
    ]),
    [
      [1, "initialize", undefined],
      [2, "account/read", undefined],
      [3, "model/list", undefined],
      [4, "thread/start", undefined],
      [5, "turn/start", coordinate.opaque],
      [6, "thread/read", coordinate.opaque],
      [7, "turn/start", coordinate.opaque],
      [8, "thread/read", coordinate.opaque],
    ],
  );
  await prepared.close();
});

// --- Steer and interrupt -----------------------------------------------------

test("codex-live-controls steers the exact active native Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ withholdTerminal: true });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "inspect the other seam",
    }),
    {
      outcome: "accepted",
    },
  );
  await prepared.close();
  await turn.result();

  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const steer = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .find((message) => message.method === "turn/steer");
  assert.deepEqual(steer?.params, {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    clientUserMessageId:
      "secant-steer-c3562695713f21842df862acee1dcab488dd2668d7d9b6733db29d6a35bc4be9",
    input: [{ type: "text", text: "inspect the other seam" }],
  });
});

test("codex-live-controls interrupts only from matching terminal truth", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");

  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const interrupt = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, {
    threadId: "thread-1",
    turnId: "turn-1",
  });
  await prepared.close();
});

test("codex-live-controls does not turn interrupt acknowledgement into terminal truth", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ withholdTerminal: true });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "already-settled",
  });
  let settled = false;
  void turn.result().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(
    await turn.steer({ steerId: "conformance-steer", text: "too late" }),
    {
      outcome: "rejected",
      reason: "expired",
    },
  );

  await prepared.close();
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
});

test("codex-live-controls child loss before confirmation keeps interruption unknown", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "exit",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
  await prepared.close();
});

test("codex-live-controls native interrupt rejection does not poison later input", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptRpcError: "stale",
    steerTerminal: "completed",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "continue instead",
    }),
    {
      outcome: "accepted",
    },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("codex-live-controls native Interrupt mismatch is expired", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptRpcError: "mismatch",
    steerTerminal: "completed",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "continue instead",
    }),
    {
      outcome: "accepted",
    },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("codex-live-controls refuses a near-miss Interrupt error without losing the Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptRpcError: "near-miss",
    steerTerminal: "completed",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  assert.deepEqual(
    events.filter((event) => event.kind === "activity"),
    [
      {
        kind: "activity",
        description:
          "Codex turn/interrupt control failed. turn/interrupt returned RPC error -32600: expected active turn id turn-1 but found turn-2 unexpectedly",
      },
    ],
  );
  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "continue after refusal",
    }),
    {
      outcome: "accepted",
    },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("codex-live-controls native internal control error preserves its diagnostic and permits later input", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptRpcError: "internal",
    steerTerminal: "completed",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  assert.deepEqual(
    events.filter((event) => event.kind === "activity"),
    [
      {
        kind: "activity",
        description:
          "Codex turn/interrupt control failed. turn/interrupt returned RPC error -32603: internal error",
      },
    ],
  );
  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "continue after refusal",
    }),
    {
      outcome: "accepted",
    },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

for (const terminal of ["completed", "failed"] as const) {
  test(`codex-live-controls ${terminal} terminal truth wins an interrupt acknowledgement race`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      interruptTerminalBeforeResponse: terminal,
    });
    const prepared = await prepareCodex(installed.path);
    const turn = prepared.startTurn(turnRequest());
    await waitForSession(turn);

    assert.deepEqual(await turn.interrupt(), {
      outcome: "rejected",
      reason: "expired",
    });
    assert.equal((await turn.result()).kind, terminal);
    await prepared.close();
  });
}

test("codex-live-controls matching interrupted terminal can confirm before acknowledgement", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminalBeforeResponse: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  await prepared.close();
});

test("codex-live-controls rejects a mismatched native Steer response as stale", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    mismatchedSteerResponse: true,
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(
    await turn.steer({ steerId: "conformance-steer", text: "stale guidance" }),
    {
      outcome: "rejected",
      reason: "expired",
    },
  );
  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  await prepared.close();
});

for (const race of ["no-active", "mismatch"] as const) {
  test(`codex-live-controls rejects the native ${race} Steer race as expired`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      steerRpcError: race,
      interruptTerminal: "interrupted",
    });
    const prepared = await prepareCodex(installed.path);
    const turn = prepared.startTurn(turnRequest());
    await waitForSession(turn);

    assert.deepEqual(
      await turn.steer({
        steerId: "conformance-steer",
        text: "racing guidance",
      }),
      {
        outcome: "rejected",
        reason: "expired",
      },
    );
    assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
    assert.equal((await turn.result()).kind, "interrupted");
    await prepared.close();
  });
}

for (const controlCase of [
  { native: "empty", reason: "shape-mismatch" },
  { native: "review", reason: "expired" },
  { native: "compact", reason: "expired" },
  { native: "schema", reason: "expired" },
] as const) {
  test(`codex-live-controls maps native Steer ${controlCase.native} to ${controlCase.reason}`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      steerRpcError: controlCase.native,
      interruptTerminal: "interrupted",
    });
    const prepared = await prepareCodex(installed.path);
    const turn = prepared.startTurn(turnRequest());
    await waitForSession(turn);

    assert.deepEqual(
      await turn.steer({
        steerId: "conformance-steer",
        text: "rejected guidance",
      }),
      {
        outcome: "rejected",
        reason: controlCase.reason,
      },
    );
    assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
    assert.equal((await turn.result()).kind, "interrupted");
    await prepared.close();
  });
}

test("codex-live-controls refuses a near-miss Steer error until native interruption", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    steerRpcError: "near-miss",
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForSession(turn);

  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "refused guidance",
    }),
    {
      outcome: "rejected",
      reason: "expired",
    },
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "activity"),
    [
      {
        kind: "activity",
        description:
          "Codex turn/steer control failed. turn/steer returned RPC error -32600: expected active turn id `turn-1` but found `turn-2` unexpectedly",
      },
    ],
  );
  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  await prepared.close();
});

test("codex-live-controls malformed Steer response fails closed without throwing", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    malformedSteerResponse: true,
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "invalid response",
    }),
    {
      outcome: "rejected",
      reason: "expired",
    },
  );
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  assert.equal(result.detail.failure?.phase, "control");
  assert.ok(result.detail.failure?.cause instanceof Error);
  await prepared.close();
});

test("codex-live-controls Steer timeout keeps the Turn until native interruption", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    stallSteerResponse: true,
    interruptTerminal: "interrupted",
  });
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs: 1_000,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForSession(turn);

  assert.deepEqual(
    await turn.steer({ steerId: "conformance-steer", text: "will time out" }),
    {
      outcome: "rejected",
      reason: "expired",
    },
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "activity"),
    [
      {
        kind: "activity",
        description:
          "Codex turn/steer control failed. turn/steer control exchange timed out",
      },
    ],
  );
  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  await prepared.close();
});

test("codex-live-controls malformed Interrupt stays protocol corruption with interruption unknown", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    malformedInterruptResponse: true,
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
  assert.equal(result.detail.session.state, "detached");
  assert.equal(result.detail.failure?.phase, "control");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  assert.ok(result.detail.failure?.cause instanceof Error);
  await prepared.close();
});

for (const control of ["steer", "interrupt"] as const) {
  for (const refusal of ["native-error", "timeout"] as const) {
    for (const terminal of [
      "completed",
      "failed",
      "interrupted",
      "exit",
      "close",
    ] as const) {
      test(`codex-live-controls refused ${control} ${refusal} waits for native ${terminal}`, async () => {
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({
          approvals: [
            {
              id: "finish",
              kind: "command",
              itemId: "command-1",
              command: "bun test",
            },
          ],
          approvalTerminal: terminal === "close" ? "completed" : terminal,
          steerRpcError:
            control === "steer" && refusal === "native-error"
              ? "near-miss"
              : undefined,
          interruptRpcError: "internal",
          stallSteerResponse: control === "steer" && refusal === "timeout",
          stallInterruptResponse:
            control === "interrupt" && refusal === "timeout",
          respondToStalledControlsOnCompletion: refusal === "timeout",
        });
        const preparedResult = await createCodexAdapter({
          path: installed.path,
          env: {},
          controlTimeoutMs: 1_000,
        }).prepare({ workspace: process.cwd() });
        assert.equal(preparedResult.ok, true);
        if (!preparedResult.ok) throw new Error("unreachable");
        const prepared = preparedResult.harness;
        const turn = prepared.startTurn({ ...turnRequest(), origin: "human" });
        const events = observeEvents(turn);
        await waitForRequestCount(turn, events, 1);
        let settled = false;
        void turn.result().then(() => {
          settled = true;
        });
        turn.subscribe(() =>
          assert.equal(settled, false, "no event follows the result"),
        );

        assert.deepEqual(
          await (control === "steer"
            ? turn.steer({
                steerId: "conformance-steer",
                text: "refused guidance",
              })
            : turn.interrupt()),
          { outcome: "rejected", reason: "expired" },
        );
        assert.equal(
          settled,
          false,
          "the refused call must not settle the Turn",
        );
        const activities = events.filter((event) => event.kind === "activity");
        assert.equal(activities.length, 1);
        assert.equal(
          activities[0]?.description,
          refusal === "timeout"
            ? `Codex turn/${control} control failed. turn/${control} control exchange timed out`
            : control === "steer"
              ? "Codex turn/steer control failed. turn/steer returned RPC error -32600: expected active turn id `turn-1` but found `turn-2` unexpectedly"
              : "Codex turn/interrupt control failed. turn/interrupt returned RPC error -32603: internal error",
        );
        if (control === "interrupt" && refusal === "timeout") {
          assert.deepEqual(await turn.interrupt(), {
            outcome: "rejected",
            reason: "already-settled",
          });
          assert.deepEqual(
            await turn.steer({
              steerId: "conformance-steer",
              text: "cannot race the pending stop",
            }),
            { outcome: "rejected", reason: "expired" },
          );
        }

        if (terminal === "close") await prepared.close();
        else await answerControlApproval(turn, events);
        const result = await turn.result();
        const eventCount = events.length;
        assert.equal(
          result.kind,
          terminal === "exit" || terminal === "close" ? "lost" : terminal,
        );
        if (result.kind === "lost") {
          assert.equal(result.detail.session.state, "detached");
          assert.equal(
            result.detail.unknown,
            control === "interrupt" && refusal === "timeout"
              ? "interruption"
              : "completion",
          );
          assert.equal(result.detail.failure?.phase, "turn");
          assert.equal(
            result.detail.failure?.category,
            control === "interrupt" && refusal === "timeout"
              ? "interruption-unknown"
              : "app-server-closed",
          );
        } else if (result.kind === "failed") {
          assert.equal(result.detail.failure.category, "execution");
          assert.equal(
            result.detail.failure.diagnostics,
            "scripted terminal failure",
          );
        } else if (result.kind === "interrupted") {
          assert.equal(result.detail.session.state, "detached");
        } else if (result.kind === "completed") {
          assert.equal(result.detail.session.state, "open");
          const coordinate = events.flatMap((event) =>
            event.kind === "session" &&
            event.facts?.recoveryCoordinate !== undefined
              ? [event.facts.recoveryCoordinate]
              : [],
          )[0];
          assert.ok(coordinate !== undefined);
          const next = prepared.startTurn({
            ...turnRequest(),
            origin: "human",
            resume: coordinate,
          });
          const nextEvents = observeEvents(next);
          await answerControlApproval(next, nextEvents);
          assert.equal((await next.result()).kind, "completed");
          const appServer = installed
            .invocations()
            .find((invocation) => invocation.args.join(" ") === "app-server");
          assert.ok(appServer !== undefined);
          assert.deepEqual(
            appServer.stdinLines
              .map((line) => JSON.parse(line).method)
              .filter((method) => method !== undefined),
            [
              "initialize",
              "initialized",
              "account/read",
              "model/list",
              "thread/start",
              "turn/start",
              "thread/read",
              `turn/${control}`,
              "turn/start",
              "thread/read",
            ],
          );
        }
        await prepared.close();
        assert.strictEqual(await turn.result(), result);
        assert.equal(
          events.length,
          eventCount,
          "late responses and close cannot publish after the result",
        );
      });
    }
  }
}

async function answerControlApproval(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
): Promise<void> {
  await waitForRequestCount(turn, events, 1);
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  assert.deepEqual(
    await turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "accepted" },
  );
}

for (const control of ["steer", "interrupt"] as const) {
  test(`codex-live-controls ${control} transport write failure still loses and detaches the Turn`, async () => {
    const installed = installSyntheticCodexReplayer();
    const controlled = approvalRaceProcess();
    const cause = new Error(`scripted turn/${control} write failure`);
    const preparedResult = await createCodexAdapter(
      { path: installed.path, env: {} },
      processWithSpawn(() =>
        Promise.resolve({
          ok: true,
          process: {
            ...controlled.process,
            writeStdin(bytes) {
              const message = JSON.parse(new TextDecoder().decode(bytes));
              return message.method === `turn/${control}`
                ? Promise.reject(cause)
                : controlled.process.writeStdin(bytes);
            },
          },
        }),
      ),
    ).prepare({ workspace: process.cwd() });
    assert.equal(preparedResult.ok, true);
    if (!preparedResult.ok) throw new Error("unreachable");
    const prepared = preparedResult.harness;
    const turn = prepared.startTurn(turnRequest());
    const events = observeEvents(turn);
    await waitForRequestCount(turn, events, 1);

    assert.deepEqual(
      await (control === "steer"
        ? turn.steer({
            steerId: "conformance-steer",
            text: "unwritable guidance",
          })
        : turn.interrupt()),
      { outcome: "rejected", reason: "expired" },
    );
    const result = await turn.result();
    assert.equal(result.kind, "lost");
    if (result.kind !== "lost") throw new Error("unreachable");
    assert.equal(
      result.detail.unknown,
      control === "interrupt" ? "interruption" : "completion",
    );
    assert.equal(result.detail.session.state, "detached");
    assert.equal(result.detail.failure?.phase, "control");
    assert.equal(result.detail.failure?.category, "control-transport");
    assert.strictEqual(result.detail.failure?.cause, cause);
    assert.equal(
      events.filter((event) => event.kind === "request-expired").length,
      1,
    );
    assert.equal(events.filter((event) => event.kind === "activity").length, 0);
    const eventCount = events.length;
    controlled.emitTerminal();
    await prepared.close();
    assert.strictEqual(await turn.result(), result);
    assert.equal(events.length, eventCount);
  });
}

test("codex-live-controls close interrupts live work before app-server shutdown", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  const first = await prepared.close();
  assert.equal((await turn.result()).kind, "interrupted");
  assert.equal(first.clean, true);
  assert.strictEqual(await prepared.close(), first);

  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  assert.equal(
    appServer.stdinLines.at(-1) === undefined
      ? undefined
      : JSON.parse(appServer.stdinLines.at(-1)!).method,
    "turn/interrupt",
  );
});

test("codex-live-controls close stays bounded before a native Turn exists", async () => {
  const installed = installSyntheticCodexReplayer();
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs: 5_000,
    cleanupTimeoutMs: 500,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  let admissionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    admissionStarted = resolve;
  });
  const turn = prepared.startTurn(
    turnRequest({
      admit: () => {
        admissionStarted();
        return new Promise(() => undefined);
      },
      checkpoint: () => Promise.resolve({ recorded: true }),
    }),
  );
  await started;

  const closeStartedAt = Date.now();
  assert.equal((await prepared.close()).clean, true);
  assert.ok(
    Date.now() - closeStartedAt < 2_000,
    "close must use its cleanup bound before the native Turn exists",
  );
  assert.equal((await turn.result()).kind, "not-started");
});

test("codex-live-controls close bounds an already in-flight Interrupt", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    stallInterruptResponse: true,
  });
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs: 5_000,
    cleanupTimeoutMs: 500,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);
  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "establish active target",
    }),
    {
      outcome: "accepted",
    },
  );

  const interrupt = turn.interrupt();
  const closeStartedAt = Date.now();
  assert.equal((await prepared.close()).clean, true);
  assert.ok(
    Date.now() - closeStartedAt < 2_000,
    "close must use its cleanup bound instead of the in-flight control bound",
  );
  assert.deepEqual(await interrupt, {
    outcome: "rejected",
    reason: "expired",
  });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
});

test("codex-live-controls close rejects an in-flight Steer receipt", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    stallSecondSteerResponse: true,
    interruptTerminal: "interrupted",
  });
  let sent!: () => void;
  const sending = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const capture = createCodexRecordingCapture();
  const prepared = await prepareCodex(installed.path, {
    ...capture.observer,
    stdin(bytes) {
      capture.observer.stdin(bytes);
      if (
        new TextDecoder()
          .decode(bytes)
          .includes('"text":"must expire during close"')
      )
        sent();
    },
  });
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);
  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: "establish active target",
    }),
    {
      outcome: "accepted",
    },
  );

  const racingSteer = turn.steer({
    steerId: "in-flight-close-steer",
    text: "must expire during close",
  });
  await sending;
  await prepared.close();
  assert.deepEqual(await racingSteer, {
    outcome: "rejected",
    reason: "expired",
  });
  assert.equal((await turn.result()).kind, "interrupted");
});

test("cleanup failure cannot rewrite an already-settled Codex Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.failCleanup(9);
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const settled = await turn.result();
  assert.equal(settled.kind, "completed");

  const cleanup = await prepared.close();
  assert.equal(cleanup.clean, false);
  assert.strictEqual(await turn.result(), settled);
});

// --- Recovery ----------------------------------------------------------------

test("codex replacement resumes two Sessions on one new app-server before admission", async () => {
  const installed = installSyntheticCodexReplayer();
  const writableDirectory = makeTempDir("secant-replacement-writable-");
  const agentCalls = [
    { id: "step_done", description: "End the Step", maxReasonLength: 400 },
  ];
  let end: (() => Promise<CleanupReport>) | undefined;
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
    observeAppServerLifecycle: (control) => {
      end = control.end;
    },
  }).prepare({ workspace: process.cwd(), writableDirectory });
  assert.ok(result.ok);
  const prepared = result.harness;
  try {
    for (const session of ["one", "two"]) {
      assert.equal(
        (
          await prepared
            .startTurn({ ...turnRequest(), agentCalls, session })
            .result()
        ).kind,
        "completed",
      );
    }
    assert.ok(end);
    const ended = await end();
    assert.equal(ended.clean, true);
    assert.deepEqual(
      ended.sessions?.map((session) => session.availability),
      [
        { state: "detached", coordinate: { opaque: "thread-1" } },
        { state: "detached", coordinate: { opaque: "thread-2" } },
      ],
    );
    const unsupported = await prepared
      .startTurn({
        ...turnRequest(),
        agentCalls,
        session: "one",
        modelChoice: { model: "unlisted-model" },
      })
      .result();
    assert.equal(unsupported.kind, "not-started");
    if (unsupported.kind !== "not-started") throw new Error("unreachable");
    assert.equal(unsupported.detail.failure.category, "model-unavailable");
    assert.equal(
      installed
        .invocations()
        .filter((entry) => entry.args.join(" ") === "app-server").length,
      1,
    );
    for (const session of ["two", "one"]) {
      const next = prepared.startTurn({
        ...turnRequest({
          admit: () => {
            const servers = installed
              .invocations()
              .filter((entry) => entry.args.join(" ") === "app-server");
            assert.equal(servers.length, 2);
            assert.equal(
              JSON.parse(servers[1]!.stdinLines.at(-1)!).method,
              "thread/resume",
            );
            return Promise.resolve({ recorded: true });
          },
          checkpoint: () => Promise.resolve({ recorded: true }),
        }),
        agentCalls,
        session,
        modelChoice: {
          model: session === "two" ? "gpt-5.6-sol" : "gpt-6-astra",
        },
      });
      assert.equal((await next.result()).kind, "completed");
    }
    const servers = installed
      .invocations()
      .filter((entry) => entry.args.join(" ") === "app-server");
    assert.equal(servers.length, 2);
    const starts = servers[0]!.stdinLines
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.method === "thread/start");
    assert.notDeepEqual(
      starts[0].params.config["mcp_servers.secant.http_headers"],
      starts[1].params.config["mcp_servers.secant.http_headers"],
    );
    for (const start of starts) {
      assert.equal(start.params.approvalsReviewer, "user");
      assert.equal(
        start.params.config["mcp_servers.secant.default_tools_approval_mode"],
        "approve",
      );
    }
    const frames = servers[1]!.stdinLines.map((line) => JSON.parse(line));
    assert.deepEqual(
      frames.map((frame) => frame.method),
      [
        "initialize",
        "initialized",
        "account/read",
        "model/list",
        "thread/resume",
        "turn/start",
        "thread/read",
        "thread/resume",
        "turn/start",
        "thread/read",
      ],
    );
    assert.deepEqual(
      frames
        .filter((frame) => frame.method === "thread/resume")
        .map((frame) => frame.params),
      [
        {
          threadId: "thread-2",
          approvalsReviewer: "user",
          config: {
            "mcp_servers.secant.url":
              starts[1].params.config["mcp_servers.secant.url"],
            "mcp_servers.secant.http_headers":
              starts[1].params.config["mcp_servers.secant.http_headers"],
            "mcp_servers.secant.default_tools_approval_mode": "approve",
            "sandbox_workspace_write.writable_roots": [writableDirectory],
          },
        },
        {
          threadId: "thread-1",
          approvalsReviewer: "user",
          config: {
            "mcp_servers.secant.url":
              starts[0].params.config["mcp_servers.secant.url"],
            "mcp_servers.secant.http_headers":
              starts[0].params.config["mcp_servers.secant.http_headers"],
            "mcp_servers.secant.default_tools_approval_mode": "approve",
            "sandbox_workspace_write.writable_roots": [writableDirectory],
          },
        },
      ],
    );
    assert.deepEqual(
      frames
        .filter((frame) => frame.method === "turn/start")
        .map((frame) => frame.params.threadId),
      ["thread-2", "thread-1"],
    );
    assert.deepEqual(
      frames
        .filter((frame) => frame.method === "turn/start")
        .map((frame) => frame.params.model),
      ["gpt-5.6-sol", "gpt-6-astra"],
    );
  } finally {
    await prepared.close();
  }
});

for (const drift of ["digest", "version", "path"] as const) {
  test(`codex replacement refuses ${drift} drift and retries with Sessions still detached`, async () => {
    const installed = installSyntheticCodexReplayer();
    const other = installSyntheticCodexReplayer();
    const env: NodeJS.ProcessEnv = {
      [CODEX_EXECUTABLE_ENV]: installed.executablePath,
    };
    const { prepared, end } = await prepareReplaceableCodex(
      installed,
      {},
      { env },
    );
    const bytes = readFileSync(installed.identityPath);
    try {
      for (const session of ["one", "two"]) {
        assert.equal(
          (await prepared.startTurn({ ...turnRequest(), session }).result())
            .kind,
          "completed",
        );
      }
      await end();
      if (drift === "digest") installed.driftBytesWithoutMetadataChange();
      if (drift === "version") installed.changeVersionOnly("codex-cli changed");
      if (drift === "path") env[CODEX_EXECUTABLE_ENV] = other.executablePath;
      let admitted = false;
      const result = await prepared
        .startTurn({
          ...turnRequest({
            admit: () => {
              admitted = true;
              return Promise.resolve({ recorded: true });
            },
            checkpoint: () => Promise.resolve({ recorded: true }),
          }),
          session: "one",
        })
        .result();
      assert.equal(result.kind, "failed");
      if (result.kind !== "failed") throw new Error("unreachable");
      assert.equal(result.detail.failure.phase, "recovery");
      assert.equal(result.detail.failure.category, "recovery-identity");
      assert.equal(result.detail.failure.possibleEffects, "none");
      assert.deepEqual(result.detail.session, {
        state: "detached",
        coordinate: { opaque: "thread-1" },
      });
      assert.equal(admitted, false);
      assert.equal(
        installed
          .invocations()
          .filter((entry) => entry.args.join(" ") === "app-server").length,
        1,
      );
      writeFileSync(installed.identityPath, bytes);
      installed.changeVersionOnly(prepared.profile.executableVersion);
      env[CODEX_EXECUTABLE_ENV] = installed.executablePath;
      for (const session of ["two", "one"]) {
        assert.equal(
          (await prepared.startTurn({ ...turnRequest(), session }).result())
            .kind,
          "completed",
        );
      }
    } finally {
      await prepared.close();
    }
  });
}

for (const refused of [
  "launch",
  "version-probe",
  "authentication",
  "model-list",
] as const) {
  test(`codex replacement ${refused} failure is typed and leaves recovery retryable`, async () => {
    const installed = installSyntheticCodexReplayer();
    const native = createProcessAdapter(withRunnerObserver());
    let refuseLaunch = false;
    let refuseVersion = false;
    const processAdapter: ProcessAdapter = {
      resolveExecutable: (name, options) =>
        native.resolveExecutable(name, options),
      spawnCommandSync: (options) => native.spawnCommandSync(options),
      spawnCommand: (options) =>
        refuseVersion && options.args.includes("--version")
          ? Promise.resolve({
              kind: "spawn-error",
              cause: new Error("version probe refused"),
            })
          : native.spawnCommand(options),
      spawnOwnedProcess: (options) =>
        refuseLaunch
          ? Promise.resolve({
              ok: false,
              failure: {
                kind: "spawn-error",
                cause: new Error("replacement launch refused"),
              },
            })
          : native.spawnOwnedProcess(options),
    };
    const casePath = join(installed.identityPath, "..", "fixture", "case.json");
    const original = readFileSync(casePath);
    const { prepared, end } = await prepareReplaceableCodex(installed, {
      process: processAdapter,
    });
    try {
      assert.equal(
        (await prepared.startTurn(turnRequest()).result()).kind,
        "completed",
      );
      await end();
      if (refused === "launch") refuseLaunch = true;
      if (refused === "version-probe") refuseVersion = true;
      if (refused === "authentication") installed.requireLogin();
      if (refused === "model-list") {
        const scenario = JSON.parse(original.toString());
        scenario.responses["model/list"] = {};
        delete scenario.traffic;
        writeFileSync(casePath, JSON.stringify(scenario));
      }
      const result = await prepared.startTurn(turnRequest()).result();
      assert.equal(result.kind, "failed");
      if (result.kind !== "failed") throw new Error("unreachable");
      assert.equal(result.detail.failure.phase, "recovery");
      assert.equal(result.detail.failure.category, "recovery-app-server");
      assert.equal(result.detail.failure.possibleEffects, "none");
      assert.equal(result.detail.session.state, "detached");
      refuseLaunch = false;
      refuseVersion = false;
      writeFileSync(casePath, original);
      assert.equal(
        (await prepared.startTurn(turnRequest()).result()).kind,
        "completed",
      );
    } finally {
      await prepared.close();
    }
  });
}

test("codex replacement resume refusal fences only that Session", async () => {
  const installed = installSyntheticCodexReplayer();
  const { prepared, end } = await prepareReplaceableCodex(installed);
  try {
    for (const session of ["one", "two"]) {
      assert.equal(
        (await prepared.startTurn({ ...turnRequest(), session }).result()).kind,
        "completed",
      );
    }
    await end();
    // Only Session one receives the deliberately wrong acknowledgement.
    installed.configureRecovery({ refuseThreadId: "thread-1" });
    const refused = await prepared
      .startTurn({ ...turnRequest(), session: "one" })
      .result();
    assert.equal(refused.kind, "failed");
    if (refused.kind !== "failed") throw new Error("unreachable");
    assert.equal(refused.detail.failure.category, "recovery-unacknowledged");
    assert.equal(refused.detail.session.state, "unusable");
    assert.equal(
      (await prepared.startTurn({ ...turnRequest(), session: "two" }).result())
        .kind,
      "completed",
    );
    assert.deepEqual(
      await prepared.startTurn({ ...turnRequest(), session: "one" }).result(),
      refused,
    );
    await end();
    installed.changeVersionOnly("codex-cli changed");
    assert.deepEqual(
      await prepared.startTurn({ ...turnRequest(), session: "one" }).result(),
      refused,
    );
  } finally {
    await prepared.close();
  }
});

test("codex replacement ignores retired callbacks and preserves an interrupted Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "interrupted",
  });
  const native = createProcessAdapter(withRunnerObserver());
  let first = true;
  let releaseOld!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldConsumed!: () => void;
  const consumed = new Promise<void>((resolve) => {
    oldConsumed = resolve;
  });
  const processAdapter: ProcessAdapter = {
    resolveExecutable: (name, options) =>
      native.resolveExecutable(name, options),
    spawnCommandSync: (options) => native.spawnCommandSync(options),
    spawnCommand: (options) => native.spawnCommand(options),
    spawnOwnedProcess: async (options) => {
      const launched = await native.spawnOwnedProcess(options);
      if (!launched.ok || !first) return launched;
      first = false;
      const owned = launched.process;
      return {
        ok: true,
        process: {
          stderr: owned.stderr,
          writeStdin: (bytes) => owned.writeStdin(bytes),
          closeStdin: (timeout) => owned.closeStdin(timeout),
          interrupt: (timeout) => owned.interrupt(timeout),
          closed: () => owned.closed(),
          stdout: (async function* () {
            yield* owned.stdout;
            await released;
            // The replacement reuses these native ids, so an unguarded callback
            // would complete its live Turn or lose it on the following EOF.
            yield new TextEncoder().encode(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "thread-1",
                  turn: { id: "turn-1", items: [], status: "completed" },
                },
              }) + "\n",
            );
            oldConsumed();
          })(),
        },
      };
    },
  };
  const { prepared, end } = await prepareReplaceableCodex(installed, {
    process: processAdapter,
  });
  try {
    const interrupted = prepared.startTurn(turnRequest());
    await waitForSession(interrupted);
    assert.equal((await interrupted.interrupt()).outcome, "accepted");
    const settled = await interrupted.result();
    assert.equal(settled.kind, "interrupted");
    await end();
    installed.configureTurn({
      approvals: [
        { id: "held", kind: "command", itemId: "tool", command: "bun test" },
      ],
    });
    const next = prepared.startTurn(turnRequest());
    const events = observeEvents(next);
    await waitForRequestCount(next, events, 1);
    releaseOld();
    await consumed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(await interrupted.result(), settled);
    const request = events.find((event) => event.kind === "request-raised");
    assert.ok(request?.kind === "request-raised");
    assert.equal(
      (
        await next.answerRequest({
          requestId: request.request.requestId,
          kind: "approval",
          decision: "allow",
        })
      ).outcome,
      "accepted",
    );
    assert.equal((await next.result()).kind, "completed");
  } finally {
    releaseOld();
    await prepared.close();
  }
});

test("codex replacement close waits for an in-flight spawn and sends no Turn content", async () => {
  const installed = installSyntheticCodexReplayer();
  const native = createProcessAdapter(withRunnerObserver());
  let hold = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began!: () => void;
  const beganSpawn = new Promise<void>((resolve) => {
    began = resolve;
  });
  const processAdapter: ProcessAdapter = {
    resolveExecutable: (name, options) =>
      native.resolveExecutable(name, options),
    spawnCommand: (options) => native.spawnCommand(options),
    spawnCommandSync: (options) => native.spawnCommandSync(options),
    spawnOwnedProcess: async (options) => {
      if (hold) {
        began();
        await released;
      }
      return native.spawnOwnedProcess(options);
    },
  };
  const { prepared, end } = await prepareReplaceableCodex(installed, {
    process: processAdapter,
  });
  try {
    assert.equal(
      (await prepared.startTurn(turnRequest()).result()).kind,
      "completed",
    );
    await end();
    hold = true;
    const next = prepared.startTurn(turnRequest());
    await beganSpawn;
    const closing = prepared.close();
    release();
    assert.equal((await next.result()).kind, "not-started");
    const report = await closing;
    assert.equal(report.clean, true);
    assert.strictEqual(await prepared.close(), report);
    const replacement = installed
      .invocations()
      .filter((entry) => entry.args.join(" ") === "app-server")[1];
    assert.ok(replacement);
    assert.deepEqual(
      replacement.stdinLines.map((line) => JSON.parse(line).method),
      ["initialize", "initialized", "account/read", "model/list"],
    );
  } finally {
    release();
    await prepared.close();
  }
});

test("codex replacement lifecycle close settles a Turn without interrupt confirmation", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    stallInterruptResponse: true,
  });
  const { prepared } = await prepareReplaceableCodex(
    installed,
    {},
    { controlTimeoutMs: 100, cleanupTimeoutMs: 100 },
  );
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);
  await prepared.close();
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
});

test("codex replacement retains an earlier cleanup failure in the final close report", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.failCleanup(9);
  const { prepared, end } = await prepareReplaceableCodex(installed);
  try {
    const first = prepared.startTurn(turnRequest());
    const settled = await first.result();
    assert.equal(settled.kind, "completed");
    assert.equal((await end()).clean, false);
    installed.failCleanup(0);
    assert.equal(
      (await prepared.startTurn(turnRequest()).result()).kind,
      "completed",
    );
    const report = await prepared.close();
    assert.equal(report.clean, false);
    assert.equal(report.failure?.category, "cleanup");
    assert.strictEqual(await first.result(), settled);
    assert.strictEqual(await prepared.close(), report);
  } finally {
    await prepared.close();
  }
});

for (const observation of ["cleanup-timeout", "cleanup-error"] as const) {
  for (const failedQualification of [false, true]) {
    test(`codex replacement cannot spawn after ${failedQualification ? "failed qualification" : "retirement"} cleanup reports ${observation}`, async () => {
      const installed = installSyntheticCodexReplayer();
      const casePath = join(
        installed.identityPath,
        "..",
        "fixture",
        "case.json",
      );
      const original = readFileSync(casePath);
      const native = createProcessAdapter(withRunnerObserver());
      let unreaped: OwnedProcess | undefined;
      let runtimeSpawns = 0;
      const processAdapter: ProcessAdapter = {
        resolveExecutable: (name, options) =>
          native.resolveExecutable(name, options),
        spawnCommand: (options) => native.spawnCommand(options),
        spawnCommandSync: (options) => native.spawnCommandSync(options),
        spawnOwnedProcess: async (options) => {
          runtimeSpawns += 1;
          const launched = await native.spawnOwnedProcess(options);
          if (!launched.ok || runtimeSpawns !== (failedQualification ? 2 : 1))
            return launched;
          const owned = launched.process;
          unreaped = owned;
          const cachedShutdown = Promise.resolve(
            observation === "cleanup-timeout"
              ? { kind: "cleanup-timeout" as const }
              : {
                  kind: "cleanup-error" as const,
                  cause: new Error("cannot reap app-server"),
                },
          );
          return {
            ok: true,
            process: {
              stdout: owned.stdout,
              stderr: owned.stderr,
              writeStdin: (bytes) => owned.writeStdin(bytes),
              interrupt: (timeout) => owned.interrupt(timeout),
              closed: () => owned.closed(),
              // Match the Process Interface: the shutdown receipt never changes.
              closeStdin: () => cachedShutdown,
            },
          };
        },
      };
      const { prepared, end } = await prepareReplaceableCodex(
        installed,
        { process: processAdapter },
        { cleanupTimeoutMs: 100 },
      );
      try {
        assert.equal(
          (await prepared.startTurn(turnRequest()).result()).kind,
          "completed",
        );
        assert.equal((await end()).clean, !failedQualification ? false : true);
        if (failedQualification) installed.requireLogin();
        const refused = await prepared.startTurn(turnRequest()).result();
        assert.equal(refused.kind, "failed");
        if (refused.kind !== "failed") throw new Error("unreachable");
        assert.equal(refused.detail.failure.phase, "recovery");
        assert.equal(refused.detail.failure.category, "recovery-app-server");
        assert.equal(refused.detail.failure.possibleEffects, "none");
        assert.deepEqual(refused.detail.session, {
          state: "detached",
          coordinate: { opaque: "thread-1" },
        });
        const refusedAgain = await prepared.startTurn(turnRequest()).result();
        assert.equal(refusedAgain.kind, "failed");
        assert.equal(runtimeSpawns, failedQualification ? 2 : 1);
        assert.ok(unreaped);
        // A final process exit is separate evidence from the cached shutdown
        // receipt. Only that exit allows the next Turn to replace the server.
        assert.equal((await unreaped.closeStdin(5_000)).kind, "exited");
        writeFileSync(casePath, original);
        assert.equal(
          (await prepared.startTurn(turnRequest()).result()).kind,
          "completed",
        );
        assert.equal(runtimeSpawns, failedQualification ? 3 : 2);
        assert.equal((await prepared.close()).clean, false);
      } finally {
        await unreaped?.closeStdin(5_000);
        await prepared.close();
      }
    });
  }
}

test("codex replacement close during retired cleanup cannot start another app-server", async () => {
  const installed = installSyntheticCodexReplayer();
  const native = createProcessAdapter(withRunnerObserver());
  let owned: OwnedProcess | undefined;
  let runtimeSpawns = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began!: () => void;
  const beganObservation = new Promise<void>((resolve) => {
    began = resolve;
  });
  const processAdapter: ProcessAdapter = {
    resolveExecutable: (name, options) =>
      native.resolveExecutable(name, options),
    spawnCommand: (options) => native.spawnCommand(options),
    spawnCommandSync: (options) => native.spawnCommandSync(options),
    spawnOwnedProcess: async (options) => {
      runtimeSpawns += 1;
      const launched = await native.spawnOwnedProcess(options);
      if (!launched.ok || runtimeSpawns !== 1) return launched;
      owned = launched.process;
      const first = launched.process;
      return {
        ok: true,
        process: {
          stdout: first.stdout,
          stderr: first.stderr,
          writeStdin: (bytes) => first.writeStdin(bytes),
          interrupt: (timeout) => first.interrupt(timeout),
          closeStdin: () => Promise.resolve({ kind: "cleanup-timeout" }),
          closed: async () => {
            began();
            await released;
            return first.closed();
          },
        },
      };
    },
  };
  const { prepared, end } = await prepareReplaceableCodex(
    installed,
    { process: processAdapter },
    { cleanupTimeoutMs: 500, controlTimeoutMs: 100 },
  );
  try {
    assert.equal(
      (await prepared.startTurn(turnRequest()).result()).kind,
      "completed",
    );
    assert.equal((await end()).clean, false);
    assert.ok(owned);
    await owned.closeStdin(5_000);
    const next = prepared.startTurn(turnRequest());
    await beganObservation;
    const interrupt = next.interrupt();
    const closing = prepared.close();
    await interrupt;
    release();
    await closing;
    assert.equal((await next.result()).kind, "not-started");
    assert.equal(runtimeSpawns, 1);
  } finally {
    release();
    await owned?.closeStdin(5_000);
    await prepared.close();
  }
});

async function prepareReplaceableCodex(
  installed: InstalledCodexReplayer,
  options: Omit<PrepareOptions, "process" | "workspace"> & {
    readonly process?: ProcessAdapter;
  } = {},
  overrides: Parameters<typeof createCodexAdapter>[0] = {},
): Promise<{
  readonly prepared: PreparedHarness;
  readonly end: () => Promise<CleanupReport>;
}> {
  let end: (() => Promise<CleanupReport>) | undefined;
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
    ...overrides,
    observeAppServerLifecycle: (control) => {
      end = control.end;
    },
  }).prepare({ workspace: process.cwd(), ...options });
  assert.ok(result.ok);
  assert.ok(end);
  return { prepared: result.harness, end };
}

test("codex-exact-thread-recovery acknowledges the same thread before admission and prompt", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  const { prepared, coordinate } = await prepareDetachedCodex(installed);
  const methodsAtAdmission: string[] = [];
  const second = await prepared
    .startTurn({
      ...turnRequest({
        admit: () => {
          const appServer = installed
            .invocations()
            .find((invocation) => invocation.args.join(" ") === "app-server");
          assert.ok(appServer !== undefined);
          methodsAtAdmission.push(
            ...appServer.stdinLines.map(
              (line) => JSON.parse(line).method as string,
            ),
          );
          return Promise.resolve({ recorded: true });
        },
        checkpoint: () => Promise.resolve({ recorded: true }),
      }),
      resume: coordinate,
    })
    .result();

  assert.equal(second.kind, "completed");
  assert.deepEqual(methodsAtAdmission.slice(-1), ["thread/resume"]);
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const runtimeRequests = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter((message) =>
      ["thread/start", "thread/resume", "turn/start"].includes(message.method),
    );
  assert.deepEqual(
    runtimeRequests.map((message) => [message.method, message.params.threadId]),
    [
      ["thread/start", undefined],
      ["turn/start", "thread-1"],
      ["thread/resume", "thread-1"],
      ["turn/start", "thread-1"],
    ],
  );
  await prepared.close();
});

test("a newly materialized Codex Session resumes from the caller coordinate without starting fresh", async () => {
  const installed = installSyntheticCodexReplayer();
  const prepared = await prepareCodex(installed.path);
  const result = await prepared
    .startTurn({
      ...turnRequest(),
      resume: { opaque: "thread-1" },
    })
    .result();

  assert.equal(result.kind, "completed");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const runtimeMethods = appServer.stdinLines
    .map((line) => JSON.parse(line).method)
    .filter(
      (method) => method.startsWith("thread/") || method === "turn/start",
    );
  assert.deepEqual(runtimeMethods, [
    "thread/resume",
    "turn/start",
    "thread/read",
  ]);
  await prepared.close();
});

test("a detached Codex Session recovers its private coordinate when resume is omitted", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  const { prepared } = await prepareDetachedCodex(installed);
  assert.equal(
    (await prepared.startTurn(turnRequest()).result()).kind,
    "completed",
  );
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  assert.equal(
    appServer.stdinLines.filter(
      (line) => JSON.parse(line).method === "thread/resume",
    ).length,
    1,
  );
  await prepared.close();
});

test("a mismatched Codex recovery acknowledgement permanently fences the Session", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  installed.configureRecovery({ threadId: "different-thread" });
  const { prepared, coordinate } = await prepareDetachedCodex(installed);
  let admissions = 0;
  const recorder: DurableTurnRecorder = {
    admit: () => {
      admissions += 1;
      return Promise.resolve({ recorded: true });
    },
    checkpoint: () => Promise.resolve({ recorded: true }),
  };
  const second = await prepared
    .startTurn({
      ...turnRequest(recorder),
      resume: coordinate,
    })
    .result();
  assert.equal(second.kind, "failed");
  if (second.kind !== "failed") throw new Error("unreachable");
  assert.equal(second.detail.failure.phase, "recovery");
  assert.equal(second.detail.failure.category, "recovery-unacknowledged");
  assert.equal(second.detail.failure.possibleEffects, "none");
  assert.equal(second.detail.session.state, "unusable");

  const third = await prepared.startTurn(turnRequest(recorder)).result();
  assert.deepEqual(third, second);
  assert.equal(admissions, 0);
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const runtimeMethods = appServer.stdinLines
    .map((line) => JSON.parse(line).method)
    .filter((method) =>
      ["thread/start", "thread/resume", "turn/start"].includes(method),
    );
  assert.deepEqual(runtimeMethods, [
    "thread/start",
    "turn/start",
    "thread/resume",
  ]);
  await prepared.close();
});

test("a Codex recovery response without a thread acknowledgement fails before admission", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  installed.configureRecovery({ threadId: null });
  const { prepared, coordinate } = await prepareDetachedCodex(installed);
  let admitted = false;
  const result = await prepared
    .startTurn({
      ...turnRequest({
        admit: () => {
          admitted = true;
          return Promise.resolve({ recorded: true });
        },
        checkpoint: () => Promise.resolve({ recorded: true }),
      }),
      resume: coordinate,
    })
    .result();

  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("unreachable");
  assert.equal(result.detail.failure.phase, "recovery");
  assert.equal(result.detail.failure.category, "recovery-unacknowledged");
  assert.ok(result.detail.failure.cause instanceof Error);
  assert.equal(result.detail.session.state, "unusable");
  assert.equal(admitted, false);
  await prepared.close();
});

test("malformed transport during Codex recovery is a sticky recovery failure", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  installed.configureRecovery({ malformedFrame: true });
  const { prepared, coordinate } = await prepareDetachedCodex(installed);
  const failed = await prepared
    .startTurn({
      ...turnRequest(),
      resume: coordinate,
    })
    .result();

  assert.equal(failed.kind, "failed");
  if (failed.kind !== "failed") throw new Error("unreachable");
  assert.equal(failed.detail.failure.phase, "recovery");
  assert.equal(failed.detail.failure.category, "recovery-unacknowledged");
  assert.equal(failed.detail.session.state, "unusable");
  assert.ok(failed.detail.failure.cause instanceof Error);
  assert.deepEqual(await prepared.startTurn(turnRequest()).result(), failed);
  await prepared.close();
});

test("a detached Codex Session cannot be rebound to another recovery coordinate", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true, stopAfter: "accepted" });
  installed.configureRecovery({ threadId: "different-thread" });
  const { prepared } = await prepareDetachedCodex(installed);
  const failed = await prepared
    .startTurn({
      ...turnRequest(),
      resume: { opaque: "different-thread" },
    })
    .result();

  assert.equal(failed.kind, "failed");
  if (failed.kind !== "failed") throw new Error("unreachable");
  assert.equal(failed.detail.failure.phase, "recovery");
  assert.equal(failed.detail.session.state, "unusable");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  assert.equal(
    appServer.stdinLines.some(
      (line) => JSON.parse(line).method === "thread/resume",
    ),
    false,
  );
  await prepared.close();
});

async function prepareDetachedCodex(
  installed: InstalledCodexReplayer,
): Promise<{
  readonly prepared: PreparedHarness;
  readonly coordinate: RecoveryCoordinate;
}> {
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs: 500,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const first = await prepared.startTurn(turnRequest()).result();
  assert.equal(first.kind, "lost");
  if (first.kind !== "lost" || first.detail.session.state !== "detached") {
    throw new Error("unreachable");
  }
  return { prepared, coordinate: first.detail.session.coordinate };
}

// --- Shared helpers (hoisted; used by every group) ---------------------------

async function prepareCodex(
  path: string,
  recordingObserver?: CodexRecordingObserver,
): Promise<PreparedHarness> {
  const result = await createCodexAdapter({
    path,
    env: {},
    ...(recordingObserver !== undefined ? { recordingObserver } : {}),
  }).prepare({
    workspace: process.cwd(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.harness;
}

function turnRequest(
  recorder: DurableTurnRecorder = successfulRecorder(),
  overrides?: { readonly text?: string; readonly session?: string },
): TurnRequest {
  return {
    session: overrides?.session ?? "codex-test",
    origin: "managed",
    correlationKey: { opaque: "codex-correlation" },
    recorder,
    input: { text: overrides?.text ?? "private prompt" },
  };
}

function successfulRecorder(): DurableTurnRecorder {
  return {
    admit: () => Promise.resolve({ recorded: true }),
    checkpoint: () => Promise.resolve({ recorded: true }),
  };
}

function observeEvents(
  turn: ReturnType<PreparedHarness["startTurn"]>,
): TurnEvent[] {
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  return events;
}

function waitForSession(
  turn: ReturnType<PreparedHarness["startTurn"]>,
): Promise<void> {
  return new Promise((resolve) => {
    turn.subscribe((event) => {
      if (event.kind === "session") resolve();
    });
  });
}

async function waitForRequestCount(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
  count: number,
): Promise<void> {
  await waitForEventCount(turn, events, "request-raised", count);
}

async function waitForExpiredRequestCount(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
  count: number,
): Promise<void> {
  await waitForEventCount(turn, events, "request-expired", count);
}

async function waitForEventCount(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
  kind: TurnEvent["kind"],
  count: number,
): Promise<void> {
  if (events.filter((event) => event.kind === kind).length >= count) return;
  await new Promise<void>((resolve) => {
    const subscription = turn.subscribe(() => {
      if (events.filter((event) => event.kind === kind).length < count) return;
      subscription.unsubscribe();
      resolve();
    });
  });
}

// --- Replay: recorded conformance --------------------------------------------

test("[codex-recorded-conformance] qualification initializes once and reads the defaults without creating a conversation", async () => {
  const installed = installCodexReplayer("codex-qualification");
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.deepEqual(await result.harness.readDefaults(), {
    kind: "reported",
    choice: { model: "gpt-5.5", effort: "high" },
  });
  const invocations = installed.invocations();
  assert.deepEqual(
    invocations.map((invocation) => invocation.args),
    [
      ["--version"],
      ["app-server", "generate-json-schema", "--out", invocations[1]?.args[3]],
      ["app-server"],
    ],
  );

  const appServer = invocations[2];
  assert.ok(appServer !== undefined);
  const messages = appServer.stdinLines.map((line) => JSON.parse(line));
  assert.deepEqual(
    messages.map((message) => message.method),
    ["initialize", "initialized", "account/read", "model/list", "config/read"],
  );
  assert.equal(
    messages.filter((message) => message.method === "initialize").length,
    1,
  );
  assert.equal(messages[0]?.params.capabilities?.experimentalApi, false);
  assert.ok(
    messages.every(
      (message) =>
        !message.method.startsWith("thread/") &&
        !message.method.startsWith("turn/") &&
        message.params?.input === undefined,
    ),
  );
  const recordedCase = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "fixtures",
        "codex",
        "codex-qualification",
        "case.json",
      ),
      "utf8",
    ),
  );
  const recordedStdin = recordedCase.traffic
    .filter((entry: { direction: string }) => entry.direction === "stdin")
    .map((entry: { line: string }) =>
      replayRecordedLine(entry.line, process.cwd()),
    );
  assert.deepEqual(
    appServer.stdinLines.map((line) => `${line}\n`),
    recordedStdin,
  );

  await result.harness.close();
});

test("the recorder observer captures runtime traffic and shutdown through the production Adapter", async () => {
  const installed = installSyntheticCodexReplayer();
  const observed: {
    direction: "stdin" | "stdout" | "stderr";
    line: string;
  }[] = [];
  const closes: { kind: string; status: number | undefined }[] = [];
  let schemaBytes = 0;
  let executableVersion: string | undefined;
  let protocolVersion: string | undefined;
  const decoder = new TextDecoder();
  const observer: CodexRecordingObserver = {
    version(version) {
      executableVersion = version;
    },
    schema(schema, revision) {
      schemaBytes = Buffer.byteLength(schema);
      protocolVersion = revision;
    },
    stdin(bytes) {
      observed.push({ direction: "stdin", line: decoder.decode(bytes) });
    },
    stdout(bytes) {
      observed.push({ direction: "stdout", line: decoder.decode(bytes) });
    },
    stderr(bytes) {
      observed.push({ direction: "stderr", line: decoder.decode(bytes) });
    },
    closed(kind, status) {
      closes.push({ kind, status });
    },
  };
  const prepared = await createCodexAdapter({
    path: installed.path,
    env: {},
    recordingObserver: observer,
  }).prepare({ workspace: process.cwd() });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const result = await prepared.harness.startTurn(turnRequest()).result();
  assert.equal(result.kind, "completed");
  await prepared.harness.close();

  const runtimeMethods = observed
    .filter((entry) => entry.direction === "stdin")
    .map((entry) => JSON.parse(entry.line).method)
    .filter(
      (method) => method?.startsWith("thread/") || method?.startsWith("turn/"),
    );
  assert.deepEqual(runtimeMethods, [
    "thread/start",
    "turn/start",
    "thread/read",
  ]);
  // A Run's own prepare never pays for the defaults read.
  assert.ok(
    observed.every(
      (entry) =>
        entry.direction !== "stdin" ||
        JSON.parse(entry.line).method !== "config/read",
    ),
  );
  assert.equal(executableVersion, "codex-cli 0.160.0");
  assert.equal(protocolVersion, "codex-probe-5");
  assert.ok(schemaBytes > 0);
  assert.ok(
    observed.some(
      (entry) =>
        entry.direction === "stdout" &&
        JSON.parse(entry.line).method === "turn/completed",
    ),
  );
  assert.deepEqual(closes, [{ kind: "exited", status: 0 }]);

  const failedCapture = createCodexRecordingCapture();
  const failed = await createCodexAdapter({
    path: installCodexReplayer("authentication").path,
    env: {},
    recordingObserver: failedCapture.observer,
  }).prepare({ workspace: process.cwd() });
  assert.equal(failed.ok, false);
  assert.deepEqual(failedCapture.exit, { kind: "exited", status: 0 });

  const stderrCapture = createCodexRecordingCapture();
  const stderrPreparedResult = await createCodexAdapter({
    path: installCodexReplayer("interrupt").path,
    env: {},
    recordingObserver: stderrCapture.observer,
  }).prepare({ workspace: process.cwd() });
  assert.equal(stderrPreparedResult.ok, true);
  if (!stderrPreparedResult.ok) throw new Error("unreachable");
  const stderrTurn = stderrPreparedResult.harness.startTurn(
    recordedSleepRequest("interrupt"),
  );
  const stderrEvents = observeEvents(stderrTurn);
  await waitForToolOrRequest(stderrTurn, stderrEvents);
  await stderrTurn.interrupt();
  await stderrTurn.result();
  await stderrPreparedResult.harness.close();
  assert.ok(
    stderrCapture.traffic.some(
      (entry) => entry.direction === "stderr" && entry.line.length > 0,
    ),
  );
});

test("[codex-recorded-conformance] completion replays exact client traffic", async () => {
  const installed = installCodexReplayer("completion");
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn({
    ...turnRequest(),
    session: "completion",
    correlationKey: { opaque: "record-completion" },
    input: { text: CODEX_RECORDING_INPUT.completion },
  });
  const events = observeEvents(turn);
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.equal(result.detail.finalContent, "recorded completion.");
  // A Turn requesting no Model choice observes the configured model and effort
  // thread/read recorded (codex-cli 0.160.0, #345).
  assert.deepEqual(result.detail.effectiveModel, {
    known: true,
    model: "gpt-6.1-sol",
    effort: "high",
  });
  assert.ok(events.some((event) => event.kind === "message-preview"));
  assert.deepEqual(
    events.filter((event) => event.kind === "assistant-content"),
    [
      {
        kind: "assistant-content",
        messageId: "msg_0214542d048c1195016ac157d3445887d080ed80b75390354f",
        content: "recorded completion.",
      },
    ],
  );
  const replayed: TurnEvent[] = [];
  turn.subscribe((event) => replayed.push(event));
  assert.ok(replayed.every((event) => event.kind !== "message-preview"));
  await prepared.close();
  assert.deepEqual(
    installed
      .invocations()
      .find((invocation) => invocation.args.join(" ") === "app-server")
      ?.stdinLines.map((line) => JSON.parse(line).method),
    [
      "initialize",
      "initialized",
      "account/read",
      "model/list",
      "thread/start",
      "turn/start",
      "thread/read",
    ],
  );
});

test("strict Codex replay refuses client traffic that diverges from recorded bytes", async () => {
  const prepared = await prepareCodex(installCodexReplayer("completion").path);
  const result = await prepared
    .startTurn({
      ...turnRequest(),
      session: "completion",
      correlationKey: { opaque: "record-completion" },
      input: { text: "different unrecorded input" },
    })
    .result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "acceptance");
  await prepared.close();
});

test("[codex-recorded-conformance] native Steer replays its exact active Turn", async () => {
  const prepared = await prepareCodex(installCodexReplayer("steer").path);
  const turn = prepared.startTurn({
    ...turnRequest(),
    session: "steer",
    correlationKey: { opaque: "record-steer" },
    input: {
      text: CODEX_RECORDING_INPUT.steer,
    },
  });
  await waitForSession(turn);
  assert.deepEqual(
    await turn.steer({
      steerId: "conformance-steer",
      text: CODEX_RECORDING_INPUT.steerGuidance,
    }),
    { outcome: "accepted" },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

for (const recorded of [
  { fixture: "steer-leftover", redelivery: [[]] },
  {
    fixture: "steer-leftover-resend",
    redelivery: [
      [],
      [{ type: "text", text: CODEX_RECORDING_INPUT.leftoverGuidance }],
    ],
  },
] as const) {
  test(`[codex-recorded-conformance] ${recorded.fixture} re-delivers a leftover Steer within one Secant Turn`, async () => {
    const installed = installCodexReplayer(recorded.fixture);
    const prepared = await prepareCodex(installed.path);
    const turn = prepared.startTurn({
      ...turnRequest(),
      session: recorded.fixture,
      correlationKey: { opaque: `record-${recorded.fixture}` },
      input: { text: CODEX_RECORDING_INPUT.leftover },
    });
    const events = observeEvents(turn);
    await waitForSession(turn);
    assert.deepEqual(
      await turn.steer({
        steerId: "conformance-leftover",
        text: CODEX_RECORDING_INPUT.leftoverGuidance,
      }),
      { outcome: "accepted" },
    );

    const result = await turn.result();
    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") throw new Error("unreachable");
    assert.equal(result.detail.finalContent, "recorded re-delivery.");
    assert.deepEqual(
      events.flatMap((event) =>
        event.kind === "steer" ? [event.settlement] : [],
      ),
      [{ kind: "delivered", delivery: "re-delivered" }],
    );
    const threadId = (turnStarts(installed)[0] as { threadId: string })
      .threadId;
    assert.deepEqual(turnStarts(installed), [
      {
        threadId,
        input: [{ type: "text", text: CODEX_RECORDING_INPUT.leftover }],
      },
      ...recorded.redelivery.map((input) => ({ threadId, input })),
    ]);
    assert.equal(threadReads(installed), 1);
    await prepared.close();
  });
}

/** How many `thread/read` requests the replayer received (#345). */
function threadReads(installed: InstalledCodexReplayer): number {
  return installed
    .invocations()
    .flatMap((invocation) => invocation.stdinLines)
    .filter((line) => JSON.parse(line).method === "thread/read").length;
}

test("[codex-recorded-conformance] approval exposes the action and replays allow once", async () => {
  const prepared = await prepareCodex(installCodexReplayer("approval").path);
  const turn = prepared.startTurn({
    ...turnRequest(),
    session: "approval",
    correlationKey: { opaque: "record-approval" },
    input: {
      text: CODEX_RECORDING_INPUT.approval,
    },
  });
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  const raised = events.find((event) => event.kind === "request-raised");
  assert.equal(raised?.kind, "request-raised");
  if (raised?.kind !== "request-raised") throw new Error("unreachable");
  assert.equal(raised.request.shape.kind, "approval");
  if (raised.request.shape.kind !== "approval") throw new Error("unreachable");
  assert.match(
    raised.request.shape.input,
    /touch \/tmp\/secant-codex-recording-approval/,
  );
  assert.deepEqual(
    await turn.answerRequest({
      requestId: raised.request.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "accepted" },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("[codex-recorded-conformance] Interrupt waits for recorded terminal truth", async () => {
  const prepared = await prepareCodex(installCodexReplayer("interrupt").path);
  const turn = prepared.startTurn(recordedSleepRequest("interrupt"));
  const events = observeEvents(turn);
  await waitForToolOrRequest(turn, events);
  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  await prepared.close();
});

test(
  "[codex-recorded-conformance] Resume reattaches the exact recorded thread",
  { skip: process.platform === "win32" },
  async () => {
    const prepared = await prepareCodex(installCodexReplayer("resume").path);
    const first = prepared.startTurn(recordedSleepRequest("resume"));
    const events = observeEvents(first);
    await waitForToolOrRequest(first, events);
    assert.deepEqual(await first.interrupt(), { outcome: "accepted" });
    const interrupted = await first.result();
    assert.equal(interrupted.kind, "interrupted");
    if (
      interrupted.kind !== "interrupted" ||
      interrupted.detail.session.state !== "detached"
    ) {
      throw new Error("unreachable");
    }
    const second = prepared.startTurn({
      ...turnRequest(),
      session: "resume",
      correlationKey: { opaque: "record-resume" },
      input: { text: CODEX_RECORDING_INPUT.resume },
      resume: interrupted.detail.session.coordinate,
    });
    assert.equal((await second.result()).kind, "completed");
    await prepared.close();
  },
);

test("[codex-recorded-conformance] authentication stays a typed prepare failure", async () => {
  const result = await createCodexAdapter({
    path: installCodexReplayer("authentication").path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "authentication");
  assert.match(
    result.failure.diagnostics ?? "",
    /Log in separately through Codex/,
  );
});

test("[codex-recorded-conformance] synthetic incompatible init fails closed", async () => {
  const result = await createCodexAdapter({
    path: installCodexReplayer("incompatibility").path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(
    result.failure.diagnostics ?? "",
    /initialize returned an incompatible result/,
  );
});

test("m10-observed-harness-facts: [codex-recorded-conformance] Test Repair applies its recorded Workspace patch", async () => {
  const workspace = makeTempDir("secant-codex-recorded-repair-");
  seedTestRepairWorkspace(workspace);
  const preparedResult = await createCodexAdapter({
    path: installCodexReplayer("test-repair").path,
    env: {},
  }).prepare({ workspace });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const turn = preparedResult.harness.startTurn({
    ...turnRequest(),
    session: "test-repair",
    correlationKey: { opaque: "record-test-repair" },
    input: { text: codexTestRepairPrompt(workspace) },
    modelChoice: CODEX_TEST_REPAIR_MODEL_CHOICE,
  });
  const events = observeEvents(turn);
  const result = await turn.result();
  assert.equal(result.kind, "completed", JSON.stringify(result));
  // Codex refused the first thread/read while the fresh thread's rollout was
  // empty; the read sent again at the Turn's next item answered (#345). It
  // reports the Model choice the Turn requested (#342), not the thread default.
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.deepEqual(result.detail.effectiveModel, {
    known: true,
    model: CODEX_TEST_REPAIR_MODEL_CHOICE.model,
    effort: CODEX_TEST_REPAIR_MODEL_CHOICE.effort,
  });
  assert.deepEqual(events.filter((event) => event.kind === "context").at(-1), {
    kind: "context",
    observation: { limitTokens: 258400 },
  });
  assert.equal(events.filter((event) => event.kind === "usage").length, 5);
  const activities = events.filter((event) => event.kind === "activity");
  assert.equal(
    activities.length,
    1,
    "the recorded thread/read failure keeps its semantic diagnostic",
  );
  assert.match(
    activities[0]?.description ?? "",
    /Codex did not report this Turn's effective model and effort yet/,
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /Codex activity:|Codex futureDisplayItem/,
  );
  const countAtResult = events.length;
  execFileSync(process.execPath, ["test", "sum.test.mjs"], {
    cwd: workspace,
    stdio: "pipe",
  });
  await preparedResult.harness.close();
  assert.equal(events.length, countAtResult);
});

function recordedSleepRequest(session: "interrupt" | "resume"): TurnRequest {
  return {
    ...turnRequest(),
    session,
    correlationKey: { opaque: `record-${session}` },
    input: {
      text: CODEX_RECORDING_INPUT.sleep,
    },
  };
}

async function waitForToolOrRequest(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
): Promise<void> {
  if (
    events.some(
      (event) => event.kind === "tool-call" || event.kind === "request-raised",
    )
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    const subscription = turn.subscribe((event) => {
      if (event.kind !== "tool-call" && event.kind !== "request-raised") {
        return;
      }
      subscription.unsubscribe();
      resolve();
    });
  });
}

// --- Discovery ---------------------------------------------------------------

test("configured Codex wins over PATH and Claude Code is never a fallback", async () => {
  const configured = installSyntheticCodexReplayer();
  const onPath = installSyntheticCodexReplayer();
  onPath.drift("codex-cli 0.146.0");
  const result = await createCodexAdapter({
    path: onPath.path,
    env: { [CODEX_EXECUTABLE_ENV]: configured.executablePath },
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.harness.profile.executableVersion, "codex-cli 0.160.0");
  assert.match(result.harness.profile.executable, /configured command/);
  await result.harness.close();

  const missing = await createCodexAdapter({
    path: makeTempDir("secant-codex-no-fallback-"),
    env: {},
    resolve: () => undefined,
  }).prepare({ workspace: process.cwd() });
  assert.equal(missing.ok, false);
  if (missing.ok) throw new Error("unreachable");
  assert.equal(missing.failure.category, "not-found");
  assert.match(missing.failure.diagnostics ?? "", /PATH name 'codex'/);
  assert.doesNotMatch(missing.failure.diagnostics ?? "", /Claude/);
});

test("an unsupported Windows shim is a typed Codex outcome", async () => {
  const directory = makeTempDir("secant-codex-shim-");
  const shim = join(directory, "codex.cmd");
  writeFileSync(shim, "@echo off\r\necho unsupported\r\n");
  const result = await createCodexAdapter({
    platform: "win32",
    env: {},
    resolve: (name) => (name === "codex" ? shim : undefined),
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "unsupported-shim");
});

test("an unsupported host platform is a typed Codex outcome", async () => {
  const result = await createCodexAdapter({
    platform: "aix",
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "unsupported-platform");
});

// --- Qualification: profile, requested model, schema, handshake, and cache ---

test("Codex profile is truthful and user-compatible", async () => {
  const installed = installSyntheticCodexReplayer();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const { profile } = result.harness;
  assert.equal(profile.harness, "codex");
  assert.equal(profile.adapterRevision, "codex-probe-5");
  assert.equal(profile.recovery.mode, "native-reattach");
  assert.match(profile.recovery.evidence, /thread\/resume.*exact/i);
  assert.equal(profile.interruption.mode, "active-turn");
  assert.equal(profile.approvals.available, true);
  assert.equal(profile.clarifications.available, false);
  assert.equal(profile.steer.available, true);
  // Every turn/start carries the Model choice, so a change waits for it (#348).
  assert.equal(profile.modelChange.reach, "next-turn");
  assert.equal(profile.modelSelection.at, "launch-and-per-turn");
  if (profile.modelSelection.at !== "launch-and-per-turn") {
    throw new Error("unreachable");
  }
  // Codex declares the supported-model list its qualification observed, each
  // model with the efforts and default effort `model/list` reports, and a
  // source for the effective-model observation.
  assert.equal(profile.modelSelection.declaration.kind, "list");
  if (profile.modelSelection.declaration.kind !== "list") {
    throw new Error("unreachable");
  }
  assert.deepEqual(
    profile.modelSelection.declaration.models.find(
      (entry) => entry.model === "gpt-6-luna",
    ),
    {
      model: "gpt-6-luna",
      label: "GPT-6-Luna",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    },
  );
  assert.equal(profile.modelObservation.available, true);
  assert.equal(profile.recoveryCoordinate.timing, "before-submission");
  assert.equal(profile.skillDelivery.mode, "plain-path");
  assert.equal(profile.fileDelivery.mode, "plain-path");
  assert.match(profile.configurationPosture, /user-compatible/);
  assert.match(profile.configurationPosture, /experimental.*disabled/i);
  await result.harness.close();
});

/** Prepare the synthetic Codex replayer, run one Turn requesting `modelChoice`,
 *  and return its result, its `model` and `activity` events, and the stdin frames
 *  of its app-server (#345). */
async function effectiveValuesTurn(
  configure: (installed: InstalledCodexReplayer) => void,
  // `null` requests no Model choice.
  modelChoice: ModelChoice | null = {
    model: "gpt-5.6-sol",
    effort: "high",
  },
) {
  const installed = installSyntheticCodexReplayer();
  configure(installed);
  const prepared = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const turn = prepared.harness.startTurn({
    ...turnRequest(),
    ...(modelChoice !== null ? { modelChoice } : {}),
  });
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  const result = await turn.result();
  await prepared.harness.close();
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  return {
    result,
    observations: events.flatMap((event) =>
      event.kind === "model" ? [event.observation] : [],
    ),
    activity: events.flatMap((event) =>
      event.kind === "activity" ? [event.description] : [],
    ),
    frames: appServer.stdinLines.map(
      (line) =>
        JSON.parse(line) as {
          readonly method?: string;
          readonly params?: Record<string, unknown>;
        },
    ),
  };
}

function effectiveModel(result: TurnResult): ModelObservation {
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  return result.detail.effectiveModel;
}

test("each Turn's model and effort reach its turn/start, and thread/read after acceptance reports what Codex applied", async () => {
  // Codex reports a configured model and effort other than the request, so the
  // observation is evidence, never the request copied back.
  const { result, observations, frames } = await effectiveValuesTurn(
    (installed) =>
      installed.configureThreadRead({ model: "gpt-6-astra", effort: "medium" }),
  );
  const applied = { known: true, model: "gpt-6-astra", effort: "medium" };
  assert.deepEqual(effectiveModel(result), applied);
  // One observation, from thread/read: thread/start's model never reads as
  // effective, and nothing is observed before the Turn starts.
  assert.deepEqual(observations, [applied]);
  const runtime = frames.filter(
    (frame) =>
      frame.method?.startsWith("thread/") || frame.method?.startsWith("turn/"),
  );
  assert.deepEqual(
    runtime.map((frame) => frame.method),
    ["thread/start", "turn/start", "thread/read"],
  );
  assert.equal(runtime[1]!.params?.model, "gpt-5.6-sol");
  assert.equal(runtime[1]!.params?.effort, "high");
  assert.deepEqual(runtime[2]!.params, { threadId: "thread-1" });
});

test("a Turn requesting no Model choice sends neither model nor effort and observes Codex's configured values", async () => {
  const { result, frames } = await effectiveValuesTurn(() => {}, null);
  // thread/read names the thread's configured model and no effort.
  assert.deepEqual(effectiveModel(result), {
    known: true,
    model: "recorded-model",
  });
  const turnStart = frames.find((frame) => frame.method === "turn/start");
  assert.ok(turnStart?.params !== undefined);
  assert.equal("model" in turnStart.params, false);
  assert.equal("effort" in turnStart.params, false);
});

test("a thread/read reporting a model that is not a string is incompatible: the values stay unknown with a diagnostic", async () => {
  const { result, observations, activity } = await effectiveValuesTurn(
    (installed) =>
      installed.configureThreadRead({ model: 42 as never, effort: "high" }),
  );
  assert.deepEqual(effectiveModel(result), { known: false });
  assert.deepEqual(observations, []);
  assert.ok(
    activity.some((description) =>
      /thread\/read returned incompatible data/.test(description),
    ),
    activity.join("; "),
  );
});

test("a thread/read reporting no model leaves the observation unknown, and one reporting no effort leaves only the effort unknown", async () => {
  const noEffort = await effectiveValuesTurn((installed) =>
    installed.configureThreadRead({ model: "gpt-6-astra", effort: null }),
  );
  assert.deepEqual(effectiveModel(noEffort.result), {
    known: true,
    model: "gpt-6-astra",
  });
  const noModel = await effectiveValuesTurn((installed) =>
    installed.configureThreadRead({ model: null, effort: "medium" }),
  );
  assert.deepEqual(effectiveModel(noModel.result), { known: false });
  assert.deepEqual(noModel.observations, []);
});

for (const at of ["after-read", "before-read"] as const) {
  test(`a model/rerouted for this Turn ${at === "after-read" ? "after" : "before"} thread/read answers replaces the model and keeps the read effort`, async () => {
    const { result, observations } = await effectiveValuesTurn((installed) => {
      installed.configureThreadRead({ model: "gpt-6-astra", effort: "medium" });
      installed.configureTurn({ reroute: { toModel: "gpt-5.5", at } });
    });
    const rerouted = { known: true, model: "gpt-5.5", effort: "medium" };
    assert.deepEqual(effectiveModel(result), rerouted);
    // A later thread/read reports the configured model, which never undoes a
    // reroute; before it answers, the rerouted model's effort is unknown.
    assert.deepEqual(
      observations,
      at === "after-read"
        ? [{ known: true, model: "gpt-6-astra", effort: "medium" }, rerouted]
        : [{ known: true, model: "gpt-5.5" }, rerouted],
    );
  });
}

test("a model/rerouted naming another Turn changes nothing", async () => {
  const { result, observations } = await effectiveValuesTurn((installed) => {
    installed.configureThreadRead({ model: "gpt-6-astra", effort: "medium" });
    installed.configureTurn({
      reroute: { toModel: "gpt-5.5", at: "after-read", foreignTurn: true },
    });
  });
  const applied = { known: true, model: "gpt-6-astra", effort: "medium" };
  assert.deepEqual(effectiveModel(result), applied);
  assert.deepEqual(observations, [applied]);
});

for (const fault of ["rpc-error", "malformed"] as const) {
  test(`a thread/read answered with ${fault === "rpc-error" ? "an RPC error, twice," : "something other than a thread"} leaves the effective values unknown and the Turn's outcome alone`, async () => {
    const { result, observations, activity, frames } =
      await effectiveValuesTurn((installed) =>
        installed.configureThreadRead(fault),
      );
    assert.deepEqual(effectiveModel(result), { known: false });
    assert.deepEqual(observations, []);
    // Only a refusal is read again, and only once.
    assert.equal(
      frames.filter((frame) => frame.method === "thread/read").length,
      fault === "rpc-error" ? 2 : 1,
    );
    assert.ok(
      activity.some((description) =>
        /did not report this Turn's effective model and effort/.test(
          description,
        ),
      ),
      activity.join("; "),
    );
  });
}

test("a first thread/read Codex refuses is read again at the Turn's next item", async () => {
  const { result, observations, activity, frames } = await effectiveValuesTurn(
    (installed) => installed.configureThreadRead("rpc-error-once"),
  );
  const applied = { known: true, model: "gpt-5.6-sol", effort: "high" };
  assert.deepEqual(effectiveModel(result), applied);
  assert.deepEqual(observations, [applied]);
  assert.equal(
    frames.filter((frame) => frame.method === "thread/read").length,
    2,
  );
  assert.ok(
    activity.some((description) =>
      /effective model and effort yet, so its next item reads them again/.test(
        description,
      ),
    ),
    activity.join("; "),
  );
});

test("an unanswered thread/read never holds the Turn: it settles on its own terminal with the effective values unknown", async () => {
  const { result, observations } = await effectiveValuesTurn((installed) =>
    installed.configureThreadRead("stall"),
  );
  assert.deepEqual(effectiveModel(result), { known: false });
  assert.deepEqual(observations, []);
});

test("a Turn requesting a model the observed list rejects settles not-started before any thread exchange", async () => {
  const installed = installSyntheticCodexReplayer();
  const prepared = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  // The model is no longer a prepare option, so qualification succeeds.
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  let admitted = false;
  const result = await prepared.harness
    .startTurn({
      ...turnRequest({
        admit: () => {
          admitted = true;
          return Promise.resolve({ recorded: true });
        },
        checkpoint: () => Promise.resolve({ recorded: true }),
      }),
      modelChoice: { model: "no-such-secant-model" },
    })
    .result();
  assert.equal(result.kind, "not-started");
  if (result.kind !== "not-started") throw new Error("unreachable");
  assert.equal(result.detail.failure.phase, "turn");
  assert.equal(result.detail.failure.category, "model-unavailable");
  assert.match(result.detail.failure.diagnostics ?? "", /no-such-secant-model/);
  // The refusal names the models Codex does offer, by name.
  assert.match(
    result.detail.failure.diagnostics ?? "",
    /Available models: gpt-6\.1-sol, gpt-6-astra, /,
  );
  assert.equal(admitted, false, "a refused Turn is never admitted");
  await prepared.harness.close();

  const methods = installed
    .invocations()
    .flatMap((invocation) => invocation.stdinLines)
    .map((line) => JSON.parse(line).method);
  assert.ok(!methods.includes("thread/start"), methods.join(", "));
  assert.ok(!methods.includes("turn/start"), methods.join(", "));
});

// The effective-value exchange (#345) is as required as the Turn terminal.
for (const method of ["turn/completed", "thread/read", "model/rerouted"]) {
  test(`required schema drift (${method}) fails closed before app-server launch`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.removeSchemaMethod(method);
    const result = await createCodexAdapter({
      path: installed.path,
      env: {},
    }).prepare({ workspace: process.cwd() });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.failure.category, "protocol-incompatible");
    assert.ok(
      (result.failure.diagnostics ?? "").includes(method),
      result.failure.diagnostics,
    );
    assert.equal(
      installed
        .invocations()
        .filter(
          (invocation) =>
            invocation.args.length === 1 && invocation.args[0] === "app-server",
        ).length,
      0,
    );
  });
}

test("a schema whose turn/start no longer takes an effort fails closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.removeTurnStartEffort();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /turn\/start effort/);
});

test("a changed required schema field type fails closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.changeTurnStatusShape();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /Turn status/);
});

for (const field of [
  "path",
  "kind",
  "move-path",
  "file-items",
  "command",
  "command-kind",
  "resolved-id",
  "resolved-thread",
  "command-kind-values",
  "request-id-types",
  "server-request-id",
] as const) {
  test(`changed approval ${field} schema fails qualification closed`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.changeApprovalSchemaShape(field);
    const result = await createCodexAdapter({
      path: installed.path,
      env: {},
    }).prepare({ workspace: process.cwd() });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.failure.category, "protocol-incompatible");
    assert.match(
      result.failure.diagnostics ?? "",
      /file.?change|command approval|request resolution|request id|server request/i,
    );
  });
}

test("version and generated-schema probe failures stay typed", async () => {
  const versionFailure = installSyntheticCodexReplayer();
  versionFailure.failVersion(7);
  const versionResult = await createCodexAdapter({
    path: versionFailure.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(versionResult.ok, false);
  if (versionResult.ok) throw new Error("unreachable");
  assert.equal(versionResult.failure.category, "version-probe");
  assert.equal(versionResult.failure.nativeCode, "7");

  const malformedSchema = installSyntheticCodexReplayer();
  malformedSchema.corruptSchema();
  const schemaResult = await createCodexAdapter({
    path: malformedSchema.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(schemaResult.ok, false);
  if (schemaResult.ok) throw new Error("unreachable");
  assert.equal(schemaResult.failure.category, "protocol-incompatible");
  assert.ok(schemaResult.failure.cause instanceof Error);
});

// --- Defaults: config/read, its fallback, and the declared efforts (#341) ----

async function defaultsAfter(
  configure: (
    installed: ReturnType<typeof installSyntheticCodexReplayer>,
  ) => void,
  controlTimeoutMs = 5_000,
) {
  const installed = installSyntheticCodexReplayer();
  configure(installed);
  const prepared = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs,
  }).prepare({ workspace: process.cwd() });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  try {
    return await prepared.harness.readDefaults();
  } finally {
    await prepared.harness.close();
  }
}

const FALLBACK_DEFAULT = { model: "gpt-6.1-sol", effort: "low" };

test("a configured model without an effort reports that model at its own default effort", async () => {
  assert.deepEqual(
    await defaultsAfter((installed) =>
      installed.configureConfigRead({ model: "gpt-6-astra", effort: null }),
    ),
    { kind: "reported", choice: { model: "gpt-6-astra", effort: "medium" } },
  );
});

test("a configured effort the model does not offer gives way to the model's default effort", async () => {
  assert.deepEqual(
    await defaultsAfter((installed) =>
      installed.configureConfigRead({ model: "gpt-5.5", effort: "ultra" }),
    ),
    { kind: "reported", choice: { model: "gpt-5.5", effort: "medium" } },
  );
});

test("a configured model model/list does not offer falls back and names it", async () => {
  const defaults = await defaultsAfter((installed) =>
    installed.configureConfigRead({ model: "gpt-private", effort: "high" }),
  );
  assert.equal(defaults.kind, "fallback");
  if (defaults.kind !== "fallback") throw new Error("unreachable");
  assert.deepEqual(defaults.choice, FALLBACK_DEFAULT);
  assert.match(
    defaults.reason,
    /^Codex's configuration names 'gpt-private', which is not one of Codex's listed models\. Starting from Codex's default model at its default effort\.$/,
  );
});

for (const [answer, reason] of [
  ["rpc-error", "Codex could not report its configuration."],
  ["malformed", "Codex could not report its configuration."],
  ["stall", "Codex did not report its configuration in time."],
] as const) {
  test(`a config/read ${answer} falls back to the model/list default with the reason`, async () => {
    const defaults = await defaultsAfter(
      (installed) => installed.configureConfigRead(answer),
      answer === "stall" ? 300 : 5_000,
    );
    assert.equal(defaults.kind, "fallback");
    if (defaults.kind !== "fallback") throw new Error("unreachable");
    assert.deepEqual(defaults.choice, FALLBACK_DEFAULT);
    // A person reads the reason: no RPC name and no raw native message.
    assert.equal(
      defaults.reason,
      `${reason} Starting from Codex's default model at its default effort.`,
    );
  });
}

test("with no configured model and no model/list default, Codex has nothing to start from", async () => {
  const defaults = await defaultsAfter((installed) => {
    installed.configureConfigRead({ model: null, effort: null });
    installed.clearDefaultModel();
  });
  assert.equal(defaults.kind, "unavailable");
  if (defaults.kind !== "unavailable") throw new Error("unreachable");
  assert.match(
    defaults.reason,
    /^Codex's configuration names no model\. Codex lists no default model to start from\.$/,
  );
});

test("the defaults are read once per prepared Harness", async () => {
  const installed = installSyntheticCodexReplayer();
  const prepared = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  if (!prepared.ok) throw new Error("expected a prepared Harness");
  const first = await prepared.harness.readDefaults();
  assert.deepEqual(await prepared.harness.readDefaults(), first);
  await prepared.harness.close();
  const sent = installed
    .invocations()
    .flatMap((invocation) => invocation.stdinLines)
    .filter((line) => JSON.parse(line).method === "config/read");
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]!).params, {
    cwd: process.cwd(),
    includeLayers: false,
  });
});

test("required live response drift fails closed and reaps the child", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.removeResponseField("model/list", "data");
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /model\/list/);
  const appServer = installed
    .invocations()
    .find(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    );
  assert.ok(appServer !== undefined);
  assert.deepEqual(
    appServer.stdinLines.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "account/read", "model/list"],
  );
});

test("a child that stops draining stdin cannot outlive the handshake bound", async () => {
  const installed = installSyntheticCodexReplayer();
  const stalled = stalledProcess();
  const result = await createCodexAdapter(
    { path: installed.path, env: {}, handshakeTimeoutMs: 20 },
    processWithSpawn(() => Promise.resolve({ ok: true, process: stalled })),
  ).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /timed out/);
});

test("a notification flood cannot extend the whole-RPC deadline", async () => {
  const installed = installSyntheticCodexReplayer();
  const flooding = notificationFloodProcess();
  const result = await createCodexAdapter(
    { path: installed.path, env: {}, handshakeTimeoutMs: 20 },
    processWithSpawn(() => Promise.resolve({ ok: true, process: flooding })),
  ).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.failure.diagnostics ?? "", /initialize.*timed out/);
});

test("app-server launch and cleanup failures preserve their own evidence", async () => {
  const launchReplayer = installSyntheticCodexReplayer();
  const launchCause = new Error("scripted app-server launch failure");
  const launchResult = await createCodexAdapter(
    { path: launchReplayer.path, env: {} },
    processWithSpawn(() =>
      Promise.resolve({
        ok: false,
        failure: { kind: "spawn-error", cause: launchCause },
      }),
    ),
  ).prepare({ workspace: process.cwd() });
  assert.equal(launchResult.ok, false);
  if (launchResult.ok) throw new Error("unreachable");
  assert.equal(launchResult.failure.category, "app-server-launch");
  assert.equal(launchResult.failure.cause, launchCause);

  const cleanupReplayer = installSyntheticCodexReplayer();
  cleanupReplayer.failCleanup(9);
  const prepared = await createCodexAdapter({
    path: cleanupReplayer.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const first = await prepared.harness.close();
  assert.equal(first.clean, false);
  assert.equal(first.failure?.category, "cleanup");
  assert.strictEqual(await prepared.harness.close(), first);

  const evidenceReplayer = installSyntheticCodexReplayer();
  const stderrCause = new Error("scripted stderr read failure");
  const cleanupCause = new Error("scripted cleanup failure");
  const evidenceProcess = qualificationProcess({ stderrCause, cleanupCause });
  const evidencePrepared = await createCodexAdapter(
    { path: evidenceReplayer.path, env: {} },
    processWithSpawn(() =>
      Promise.resolve({ ok: true, process: evidenceProcess }),
    ),
  ).prepare({ workspace: process.cwd() });
  assert.equal(evidencePrepared.ok, true);
  if (!evidencePrepared.ok) throw new Error("unreachable");
  const evidence = await evidencePrepared.harness.close();
  assert.equal(evidence.clean, false);
  assert.ok(evidence.failure?.cause instanceof AggregateError);
  assert.deepEqual(evidence.failure.cause.errors, [cleanupCause, stderrCause]);
});

test("authentication remains Codex-owned with separate-login remediation", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.requireLogin();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "authentication");
  assert.match(
    result.failure.diagnostics ?? "",
    /Log in separately through Codex/,
  );
  assert.doesNotMatch(result.failure.diagnostics ?? "", /recorded@example/);

  const appServer = installed
    .invocations()
    .find(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    );
  assert.ok(appServer !== undefined);
  assert.deepEqual(
    appServer.stdinLines.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "account/read"],
  );
});

test("cached schema evidence is reused but every prepare initializes a fresh child", async () => {
  const installed = installSyntheticCodexReplayer();
  const adapter = createCodexAdapter({ path: installed.path, env: {} });
  const first = await adapter.prepare({ workspace: process.cwd() });
  const second = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) throw new Error("unreachable");

  const invocations = installed.invocations();
  assert.equal(
    invocations.filter((invocation) =>
      invocation.args.includes("generate-json-schema"),
    ).length,
    1,
  );
  assert.equal(
    invocations.filter(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    ).length,
    2,
  );
  await first.harness.close();
  await second.harness.close();

  installed.driftBytesWithoutMetadataChange();
  const byteDrifted = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(byteDrifted.ok, true);
  if (!byteDrifted.ok) throw new Error("unreachable");
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    2,
  );
  await byteDrifted.harness.close();

  installed.drift("codex-cli 0.155.0");
  const drifted = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(drifted.ok, true);
  if (!drifted.ok) throw new Error("unreachable");
  assert.equal(drifted.harness.profile.executableVersion, "codex-cli 0.155.0");
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    3,
  );
  await drifted.harness.close();
});

test("cache evidence invalidates on source, path, version, platform, and probe revision", async () => {
  const installed = installSyntheticCodexReplayer();
  let cachePlatform: HarnessPlatform = "windows";
  let probeRevision = "codex-probe-2";
  const adapter = createCodexAdapter({
    path: installed.path,
    env: {},
    platform: "win32",
    qualificationCachePlatform: () => cachePlatform,
    probeRevision: () => probeRevision,
    resolve(name) {
      if (name === "codex") return installed.executablePath;
      if (name === "bun") return process.execPath;
      if (name.endsWith("codex.cmd")) return name;
      return undefined;
    },
  });

  const prepared: { harness: { close(): Promise<unknown> } }[] = [];
  const qualify = async (configuredExecutable?: string): Promise<void> => {
    const options: { workspace: string; configuredExecutable?: string } = {
      workspace: process.cwd(),
    };
    if (configuredExecutable !== undefined) {
      options.configuredExecutable = configuredExecutable;
    }
    const result = await adapter.prepare(options);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    prepared.push(result);
  };

  await qualify();
  await qualify(installed.windowsShimPath);
  installed.changeVersionOnly("codex-cli 0.154.1");
  await qualify(installed.windowsShimPath);
  cachePlatform = "linux";
  await qualify(installed.windowsShimPath);
  probeRevision = "codex-probe-3";
  await qualify(installed.windowsShimPath);

  const another = installSyntheticCodexReplayer();
  await qualify(another.windowsShimPath);
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    5,
  );
  assert.equal(
    another
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    1,
  );
  await Promise.all(prepared.map((result) => result.harness.close()));
});

function stalledProcess(): OwnedProcess {
  const noBytes = async function* (): AsyncIterable<Uint8Array> {};
  const never = new Promise<void>(() => undefined);
  return {
    stdout: noBytes(),
    stderr: noBytes(),
    writeStdin: () => never,
    closeStdin: () => Promise.resolve({ kind: "exited", status: 0 }),
    interrupt: () =>
      Promise.resolve({
        close: { kind: "exited", status: 0 },
        escalated: false,
      }),
    closed: () => Promise.resolve({ kind: "exited", status: 0 }),
  };
}

async function approvalRaceFixture() {
  const installed = installSyntheticCodexReplayer();
  const controlled = approvalRaceProcess();
  const preparedResult = await createCodexAdapter(
    { path: installed.path, env: {} },
    processWithSpawn(() =>
      Promise.resolve({ ok: true, process: controlled.process }),
    ),
  ).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  return { controlled, prepared, turn, events, request };
}

interface TControlledApprovalProcess {
  readonly process: OwnedProcess;
  readonly responseWriteStarted: Promise<void>;
  readonly responseWriteCount: number;
  emitResolution(): void;
  endConnection(): void;
  emitCorruption(): void;
  emitTerminal(
    status?: "completed" | "interrupted" | "failed" | "inProgress",
  ): void;
  releaseResponseWrite(): void;
  rejectResponseWrite(cause: unknown): void;
}

function approvalRaceProcess(): TControlledApprovalProcess {
  const output = asyncByteQueue();
  const responseWriteStarted = deferred<void>();
  const responseWrite = deferred<void>();
  let responseWriteCount = 0;
  const encoder = new TextEncoder();
  const enqueue = (message: object): void => {
    output.push(encoder.encode(`${JSON.stringify(message)}\n`));
  };
  const writeStdin = (bytes: Uint8Array): Promise<void> => {
    const message = JSON.parse(new TextDecoder().decode(bytes));
    switch (message.method) {
      case "initialize":
        enqueue({
          id: message.id,
          result: {
            userAgent: "recorded",
            codexHome: "/recorded",
            platformFamily: "unix",
            platformOs: "linux",
          },
        });
        return Promise.resolve();
      case "initialized":
        return Promise.resolve();
      case "account/read":
        enqueue({
          id: message.id,
          result: {
            account: { type: "apiKey" },
            requiresOpenaiAuth: true,
          },
        });
        return Promise.resolve();
      case "model/list":
        enqueue({
          id: message.id,
          result: {
            data: [
              {
                id: "model",
                model: "model",
                displayName: "Model",
                hidden: false,
                isDefault: true,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: "medium",
              },
            ],
          },
        });
        return Promise.resolve();
      case "thread/start":
        enqueue({
          id: message.id,
          result: { model: "model", thread: { id: "thread-1" } },
        });
        return Promise.resolve();
      case "turn/start":
        enqueue({
          id: "native-approval",
          method: "item/commandExecution/requestApproval",
          params: {
            command: "bun test",
            itemId: "command-1",
            kind: "command",
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        });
        enqueue({
          id: message.id,
          result: { turn: { id: "turn-1", items: [], status: "inProgress" } },
        });
        return Promise.resolve();
      case "turn/interrupt":
        enqueue({ id: message.id, result: {} });
        return Promise.resolve();
      default:
        if (message.id === "native-approval" && message.result !== undefined) {
          responseWriteCount += 1;
          responseWriteStarted.resolve();
          return responseWrite.promise;
        }
        return Promise.resolve();
    }
  };
  const noBytes = async function* (): AsyncIterable<Uint8Array> {};
  const process: OwnedProcess = {
    stdout: output.iterable,
    stderr: noBytes(),
    writeStdin,
    closeStdin: () => {
      output.end();
      return Promise.resolve({ kind: "exited", status: 0 });
    },
    interrupt: () =>
      Promise.resolve({
        close: { kind: "exited", status: 0 },
        escalated: false,
      }),
    closed: () => Promise.resolve({ kind: "exited", status: 0 }),
  };
  return {
    process,
    responseWriteStarted: responseWriteStarted.promise,
    get responseWriteCount() {
      return responseWriteCount;
    },
    emitResolution() {
      enqueue({
        method: "serverRequest/resolved",
        params: { requestId: "native-approval", threadId: "thread-1" },
      });
    },
    emitTerminal(status = "completed") {
      enqueue({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status,
            ...(status === "failed"
              ? { error: { message: "scripted native Turn failure" } }
              : {}),
          },
        },
      });
    },
    endConnection: () => output.end(),
    emitCorruption: () => output.push(encoder.encode("{malformed\n")),
    releaseResponseWrite: () => responseWrite.resolve(),
    rejectResponseWrite: (cause) => responseWrite.reject(cause),
  };
}

interface TDeferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

function deferred<T>(): TDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asyncByteQueue(): {
  readonly iterable: AsyncIterable<Uint8Array>;
  push(bytes: Uint8Array): void;
  end(): void;
} {
  const buffered: Uint8Array[] = [];
  const waiting: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  let ended = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            const bytes = buffered.shift();
            if (bytes !== undefined) {
              return Promise.resolve({ done: false, value: bytes });
            }
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => waiting.push(resolve));
          },
        };
      },
    },
    push(bytes) {
      const resolve = waiting.shift();
      if (resolve !== undefined) resolve({ done: false, value: bytes });
      else buffered.push(bytes);
    },
    end() {
      ended = true;
      for (const resolve of waiting.splice(0)) {
        resolve({ done: true, value: undefined });
      }
    },
  };
}

function notificationFloodProcess(): OwnedProcess {
  let closed = false;
  const stdout = async function* (): AsyncIterable<Uint8Array> {
    while (!closed) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (closed) return;
      yield new TextEncoder().encode(
        `${JSON.stringify({ method: "account/updated", params: {} })}\n`,
      );
    }
  };
  const noBytes = async function* (): AsyncIterable<Uint8Array> {};
  return {
    stdout: stdout(),
    stderr: noBytes(),
    writeStdin: () => Promise.resolve(),
    closeStdin: () => {
      closed = true;
      return Promise.resolve({ kind: "exited", status: 0 });
    },
    interrupt: () =>
      Promise.resolve({
        close: { kind: "exited", status: 0 },
        escalated: false,
      }),
    closed: () => Promise.resolve({ kind: "exited", status: 0 }),
  };
}

interface TQualificationProcess {
  readonly stderrCause: Error;
  readonly cleanupCause: Error;
}

function qualificationProcess(options: TQualificationProcess): OwnedProcess {
  const encoder = new TextEncoder();
  const stdout = async function* (): AsyncIterable<Uint8Array> {
    yield encoder.encode(
      `${JSON.stringify({ id: 1, result: { userAgent: "recorded", codexHome: "/recorded", platformFamily: "unix", platformOs: "linux" } })}\n`,
    );
    yield encoder.encode(
      `${JSON.stringify({ id: 2, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } })}\n`,
    );
    yield encoder.encode(
      `${JSON.stringify({ id: 3, result: { data: [{ id: "model", model: "model", displayName: "Model", hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: "medium" }] } })}\n`,
    );
  };
  const stderr: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(options.stderrCause),
      };
    },
  };
  return {
    stdout: stdout(),
    stderr,
    writeStdin: () => Promise.resolve(),
    closeStdin: () =>
      Promise.resolve({
        kind: "cleanup-error",
        cause: options.cleanupCause,
      }),
    interrupt: () =>
      Promise.resolve({
        close: { kind: "cleanup-error", cause: options.cleanupCause },
        escalated: true,
      }),
    closed: () =>
      Promise.resolve({
        kind: "cleanup-error",
        cause: options.cleanupCause,
      }),
  };
}

for (const order of ["before-response", "after-response"] as const) {
  test(`codex-live-controls correlates Steer delivery ${order} exactly once`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      deliverSteer: order,
      steerTerminal: "completed",
    });
    const prepared = await prepareCodex(installed.path);
    const turn = prepared.startTurn(turnRequest());
    const events: TurnEvent[] = [];
    turn.subscribe((event) => events.push(event));
    await waitForSession(turn);
    assert.deepEqual(
      await turn.steer({
        steerId: "delivery-race",
        text: "guidance before finish",
      }),
      { outcome: "accepted" },
    );
    assert.equal((await turn.result()).kind, "completed");
    const settlements = events.filter((event) => event.kind === "steer");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]?.steerId, "delivery-race");
    assert.equal(settlements[0]?.text, "guidance before finish");
    assert.deepEqual(settlements[0]?.settlement, {
      kind: "delivered",
      delivery: "within-turn",
    });
    await prepared.close();
  });
}

for (const terminal of ["leftover", "leftover-failed"] as const) {
  test(`codex-live-controls re-delivers a ${terminal} Steer by empty turn/start inside the same Turn`, async () => {
    const { installed, prepared, turn, events } = await steerLeftover({
      steerTerminal: terminal,
    });

    const result = await turn.result();
    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") throw new Error("unreachable");
    assert.equal(result.detail.finalContent, "re-delivered answer");
    assert.deepEqual(
      events.flatMap((event) => (event.kind === "steer" ? [event] : [])),
      [
        {
          kind: "steer",
          steerId: "leftover",
          text: "answer me too",
          sentAt: steerSentAt(events),
          settlement: { kind: "delivered", delivery: "re-delivered" },
        },
      ],
    );
    assert.deepEqual(turnStarts(installed), [
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "private prompt" }],
      },
      { threadId: "thread-1", input: [] },
    ]);
    // The re-delivery's native turn carries the same Model choice, so the
    // Turn reads its effective values once (#345).
    assert.equal(threadReads(installed), 1);
    await prepared.close();
  });
}

test("codex-live-controls counts compaction after a Steer as no model output", async () => {
  const { installed, prepared, turn, events } = await steerLeftover({
    steerTerminal: "leftover",
    leftoverCompaction: true,
  });

  assert.equal((await turn.result()).kind, "completed");
  assert.deepEqual(steerSettlements(events), [
    { kind: "delivered", delivery: "re-delivered" },
  ]);
  assert.equal(turnStarts(installed).length, 2);
  await prepared.close();
});

test("codex-live-controls re-sends a leftover Steer's text when Codex refuses empty input", async () => {
  const { installed, prepared, turn, events } = await steerLeftover({
    steerTerminal: "leftover",
    redelivery: "refuse-empty",
  });

  assert.equal((await turn.result()).kind, "completed");
  assert.deepEqual(steerSettlements(events), [
    { kind: "delivered", delivery: "re-delivered" },
  ]);
  assert.deepEqual(turnStarts(installed).slice(1), [
    { threadId: "thread-1", input: [] },
    {
      threadId: "thread-1",
      input: [{ type: "text", text: "answer me too" }],
    },
  ]);
  await prepared.close();
});

test("codex-live-controls keeps the leftover's native terminal when Codex refuses every re-delivery", async () => {
  const { installed, prepared, turn, events } = await steerLeftover({
    steerTerminal: "leftover",
    redelivery: "refuse-all",
  });

  const result = await turn.result();
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.equal(result.detail.session.state, "open");
  assert.deepEqual(steerSettlements(events), [
    { kind: "delivered", delivery: "within-turn" },
  ]);
  assert.deepEqual(
    events.filter((event) => event.kind === "activity"),
    [
      {
        kind: "activity",
        description:
          "Codex refused to re-deliver a Steer. turn/start returned RPC error -32603: failed to submit turn input: EmptyInput",
      },
    ],
  );
  assert.equal(turnStarts(installed).length, 3);
  await prepared.close();
});

test("codex-live-controls loses the Turn when the re-delivery turn/start goes unanswered", async () => {
  const { prepared, turn, events } = await steerLeftover(
    { steerTerminal: "leftover", redelivery: "stall" },
    { controlTimeoutMs: 300 },
  );

  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "acceptance");
  assert.equal(result.detail.failure?.category, "turn-start");
  assert.equal(result.detail.session.state, "detached");
  assert.deepEqual(steerSettlements(events), [
    { kind: "delivered", delivery: "within-turn" },
  ]);
  await prepared.close();
});

test("codex-live-controls interrupts the re-delivery's native Turn", async () => {
  const redelivery = stdinWatch((message) => message.method === "turn/start");
  const { installed, prepared, turn, events } = await steerLeftover(
    {
      steerTerminal: "leftover",
      redelivery: "withhold",
      interruptTerminal: "interrupted",
    },
    { recordingObserver: redelivery.observer },
  );
  await redelivery.seen(2);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  assert.deepEqual(steerSettlements(events), [
    { kind: "delivered", delivery: "re-delivered" },
  ]);
  const interrupt = appServerMessages(installed).find(
    (message) => message.method === "turn/interrupt",
  );
  assert.deepEqual(interrupt?.params, {
    threadId: "thread-1",
    turnId: "turn-2",
  });
  await prepared.close();
});

for (const terminal of ["interrupted", "completed"] as const) {
  test(`codex-live-controls settles a Steer in history delivered without re-delivery on an Interrupt's ${terminal} terminal`, async () => {
    const { installed, prepared, turn, events } = await steerLeftover({
      steerTerminal: "history-only",
      ...(terminal === "interrupted"
        ? { interruptTerminal: "interrupted" }
        : { interruptTerminalBeforeResponse: "completed" }),
    });

    assert.deepEqual(
      await turn.interrupt(),
      terminal === "interrupted"
        ? { outcome: "accepted" }
        : { outcome: "rejected", reason: "expired" },
    );
    assert.equal((await turn.result()).kind, terminal);
    assert.deepEqual(steerSettlements(events), [
      { kind: "delivered", delivery: "within-turn" },
    ]);
    assert.equal(turnStarts(installed).length, 1);
    await prepared.close();
  });
}

/** A live synthetic Turn whose accepted Steer the scenario leaves in history. */
async function steerLeftover(
  options: Parameters<InstalledCodexReplayer["configureTurn"]>[0],
  adapter: {
    readonly controlTimeoutMs?: number;
    readonly recordingObserver?: CodexRecordingObserver;
  } = {},
) {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ withholdTerminal: true, ...options });
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    ...adapter,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForSession(turn);
  assert.deepEqual(
    await turn.steer({ steerId: "leftover", text: "answer me too" }),
    { outcome: "accepted" },
  );
  return { installed, prepared, turn, events };
}

function steerSettlements(events: readonly TurnEvent[]): unknown[] {
  return events.flatMap((event) =>
    event.kind === "steer" ? [event.settlement] : [],
  );
}

function appServerMessages(
  installed: InstalledCodexReplayer,
): { readonly method?: string; readonly params?: unknown }[] {
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  return appServer.stdinLines.map((line) => JSON.parse(line));
}

function turnStarts(installed: InstalledCodexReplayer): unknown[] {
  return appServerMessages(installed)
    .filter((message) => message.method === "turn/start")
    .map((message) => message.params);
}

function steerSentAt(events: readonly TurnEvent[]): string {
  const steer = events.find((event) => event.kind === "steer");
  assert.equal(steer?.kind, "steer");
  if (steer?.kind !== "steer") throw new Error("unreachable");
  return steer.sentAt;
}

/** Observe the Adapter's stdin frames, resolving once `count` match. */
function stdinWatch(
  matches: (message: { readonly method?: string }) => boolean,
): {
  readonly observer: CodexRecordingObserver;
  seen(count: number): Promise<void>;
} {
  const decoder = new TextDecoder();
  let matched = 0;
  const waiters: { readonly count: number; readonly resolve: () => void }[] =
    [];
  const ignore = () => undefined;
  return {
    observer: {
      version: ignore,
      schema: ignore,
      stdout: ignore,
      stderr: ignore,
      closed: ignore,
      stdin(bytes) {
        for (const line of decoder.decode(bytes).split("\n")) {
          if (line.trim().length === 0 || !matches(JSON.parse(line))) continue;
          matched += 1;
        }
        for (const waiter of waiters.filter(
          (entry) => entry.count <= matched,
        )) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      },
    },
    seen(count) {
      if (matched >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

test("[codex] Turn producer trace parity: seal precedes held native reap and preserves final facts", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "interrupted",
    steerTerminal: "history-only",
    approvals: [
      { id: "held", kind: "command", itemId: "tool", command: "bun test" },
    ],
  });
  const native = createProcessAdapter(withRunnerObserver());
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began!: () => void;
  const reaping = new Promise<void>((resolve) => {
    began = resolve;
  });
  const processAdapter: ProcessAdapter = {
    resolveExecutable: (name, options) =>
      native.resolveExecutable(name, options),
    spawnCommand: (options) => native.spawnCommand(options),
    spawnCommandSync: (options) => native.spawnCommandSync(options),
    spawnOwnedProcess: async (options) => {
      const launched = await native.spawnOwnedProcess(options);
      if (!launched.ok) return launched;
      const owned = launched.process;
      return {
        ok: true,
        // Exercise confirm-then-reap on every host through launch evidence.
        containment: { kind: "contained" },
        process: {
          stdout: owned.stdout,
          stderr: owned.stderr,
          writeStdin: (bytes) => owned.writeStdin(bytes),
          closed: () => owned.closed(),
          interrupt: (timeout) => owned.interrupt(timeout),
          closeStdin: async (timeout) => {
            began();
            await held;
            return owned.closeStdin(timeout);
          },
        },
      };
    },
  };
  const preparedResult = await createCodexAdapter(
    { path: installed.path, env: {} },
    processAdapter,
  ).prepare({ workspace: process.cwd() });
  assert.ok(preparedResult.ok);
  const prepared = preparedResult.harness;
  try {
    const turn = prepared.startTurn(turnRequest());
    const events = observeEvents(turn);
    await waitForRequestCount(turn, events, 1);
    assert.deepEqual(
      await turn.steer({ steerId: "pending", text: "queued guidance" }),
      { outcome: "accepted" },
    );
    let settled = false;
    void turn.result().then(() => {
      settled = true;
    });
    const interrupted = turn.interrupt();
    await reaping;
    assert.equal(
      settled,
      false,
      "producer seals while authoritative result awaits reap",
    );
    const finalFacts = events
      .filter(
        (event) => event.kind === "steer" || event.kind === "request-expired",
      )
      .map((event) =>
        event.kind === "steer"
          ? {
              kind: event.kind,
              steerId: event.steerId,
              text: event.text,
              settlement: event.settlement,
            }
          : { kind: event.kind },
      );
    assert.deepEqual(finalFacts, [
      {
        kind: "steer",
        steerId: "pending",
        text: "queued guidance",
        settlement: { kind: "delivered", delivery: "within-turn" },
      },
      { kind: "request-expired" },
    ]);
    const history: TurnEvent[] = [];
    turn.subscribe((event) => history.push(event));
    assert.deepEqual(
      history,
      events.filter((event) => event.kind !== "message-preview"),
    );
    const sealed = [...history];
    release();
    assert.equal((await interrupted).outcome, "accepted");
    assert.equal((await turn.result()).kind, "interrupted");
    assert.deepEqual(history, sealed, "settlement appends no live facts");
    const terminal: TurnEvent[] = [];
    turn.subscribe((event) => terminal.push(event)).unsubscribe();
    assert.deepEqual(
      terminal,
      sealed,
      "late replay keeps final expiry and Steer order",
    );
  } finally {
    release();
    await prepared.close();
  }
});

test("Codex descendant startup does not hold Turn acceptance past the effective-model read deadline", async () => {
  const workspace = makeTempDir("codex-gated-tree-");
  const worker = join(workspace, "worker.mjs");
  const report = join(workspace, "tree.json");
  const server = createServer();
  let peer: Socket | undefined;
  let harness: PreparedHarness | undefined;
  const connected = new Promise<Socket>((resolve) => {
    server.once("connection", (socket) => {
      peer = socket;
      resolve(socket);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    writeFileSync(
      worker,
      `
      import { connect } from "node:net";
      const gate = connect({ host: "127.0.0.1", port: ${address.port} });
      await new Promise((resolve, reject) => {
        gate.once("error", reject);
        gate.once("data", resolve);
      });
      gate.destroy();
      process.stdout.write(JSON.stringify({ harnessPid: process.pid, pids: [] }) + "\\n");
      setInterval(() => {}, 1000);
    `,
    );
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({ backgroundTree: { worker, report } });
    const prepared = await createCodexAdapter({
      path: installed.path,
      env: {},
      controlTimeoutMs: 500,
    }).prepare({ workspace });
    assert.ok(prepared.ok);
    if (!prepared.ok) throw new Error("unreachable");
    harness = prepared.harness;
    const turn = harness.startTurn(turnRequest());
    const unreadModel = new Promise<void>((resolve) => {
      turn.subscribe((event) => {
        if (
          event.kind === "activity" &&
          event.description.includes("did not report this Turn's effective")
        )
          resolve();
      });
    });
    // The descendant is held until the observed read deadline, never a sleep.
    await Promise.race([Promise.all([unreadModel, connected]), turn.result()]);
    (await connected).write("release");
    const result = await turn.result();
    assert.equal(
      result.kind,
      "completed",
      `tool startup must not consume Turn acceptance: ${JSON.stringify(result)}`,
    );
    assert.deepEqual(effectiveModel(result), { known: false });
    assert.equal(existsSync(report), true);
  } finally {
    try {
      await harness?.close();
    } finally {
      peer?.destroy();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
  }
});

test("m10-observed-harness-facts: authentic Codex completed items identify each message before terminal settlement", async () => {
  const installed = installCodexReplayer("two-turns");
  const prepared = await prepareCodex(installed.path);
  try {
    const cases = [
      {
        text: CODEX_RECORDING_INPUT.completion,
        modelChoice: CODEX_RECORDING_MODEL_CHOICE.first,
        id: "msg_032693b4cf0c7756016ac158079ba487d092335d80826798fb",
        content: "recorded completion",
      },
      {
        text: CODEX_RECORDING_INPUT.secondCompletion,
        modelChoice: CODEX_RECORDING_MODEL_CHOICE.second,
        id: "msg_032693b4cf0c7756016ac15809c53c87d0ae4fb1799d9eeb7c",
        content: "recorded second completion",
      },
    ];
    for (const c of cases) {
      const turn = prepared.startTurn({
        ...turnRequest(undefined, { text: c.text }),
        modelChoice: c.modelChoice,
      });
      const events = observeEvents(turn);
      const settled = await turn.result();
      assert.equal(settled.kind, "completed", JSON.stringify(settled));
      assert.deepEqual(
        events.filter((e) => e.kind === "assistant-content"),
        [{ kind: "assistant-content", messageId: c.id, content: c.content }],
      );
      const count = events.length;
      await Promise.resolve();
      assert.equal(events.length, count);
    }
  } finally {
    await prepared.close();
  }
});

test("m10-observed-harness-facts: authentic Codex delta identity retains text when its final item is withheld", async () => {
  const installed = installCodexReplayer("completion");
  const path = join(installed.identityPath, "..", "fixture", "case.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  // Synthetic semantic omission only. Every remaining wire frame is unchanged
  // authentic codex-cli 0.160.0 traffic; no native field is fabricated.
  original.traffic = original.traffic.filter(
    (entry: { direction: string; line: string }) =>
      !(
        entry.direction === "stdout" &&
        entry.line.includes('"method":"item/completed"') &&
        entry.line.includes('"type":"agentMessage"')
      ),
  );
  writeFileSync(path, JSON.stringify(original));
  const prepared = await prepareCodex(installed.path);
  try {
    const turn = prepared.startTurn({
      ...turnRequest(undefined, { text: CODEX_RECORDING_INPUT.completion }),
    });
    const events = observeEvents(turn);
    const settled = await turn.result();
    assert.equal(settled.kind, "completed", JSON.stringify(settled));
    assert.deepEqual(
      events.filter((e) => e.kind === "assistant-content"),
      [
        {
          kind: "assistant-content",
          messageId: "msg_0214542d048c1195016ac157d3445887d080ed80b75390354f",
          content: "recorded completion.",
          incomplete: true,
        },
      ],
    );
  } finally {
    await prepared.close();
  }
});
