import assert from "node:assert/strict";
import test from "node:test";
import type { FakeScript } from "../harness/fake-adapter.js";
import { awaitSettled, followRun } from "../helpers/settleOperation.js";
import {
  launchAgentCompletionRun as setup,
  readCompletionRun as readRun,
  completed,
  call,
} from "../helpers/agentCompletion.js";

test("a clean Entry Turn applies the latest step done through the Projection Port", async (t) => {
  const { wired, runId, requests, answers } = await setup(t, [
    { agentCalls: [call("first"), call("last")], result: completed },
  ]);
  assert.equal(
    (await awaitSettled(wired.projectionPort, "launch")).status,
    "applied",
  );
  const run = readRun(wired, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.completion, "agent-declared");
  assert.deepEqual(
    answers.map((a) => a.outcome),
    ["accepted", "accepted"],
  );
  assert.deepEqual(
    requests[0]?.agentCalls?.map((c) => c.id),
    ["step_done"],
  );
  assert.match(
    requests[0]?.input.text ?? "",
    /Discuss the plan\.[\s\S]*step_done[\s\S]*one-line reason/,
  );
  const ended = run.timeline.find((e) => e.event === "interactive-step-ended");
  assert.equal(ended?.endedBy, "agent");
  assert.equal(ended?.reason, "last");
});

for (const kind of ["failed", "interrupted"] as const) {
  test(`${kind} Turns drop their calls and keep the Step waiting`, async (t) => {
    const result: FakeScript["turns"][number]["result"] =
      kind === "interrupted"
        ? {
            kind,
            detail: {
              interruption: { mode: "process-only", evidence: "fake stop" },
              session: { state: "open" },
            },
          }
        : {
            kind,
            detail: {
              failure: {
                phase: "turn",
                category: "fake-failure",
                possibleEffects: "possible",
              },
              effectiveModel: { known: false },
              session: { state: "open" },
            },
          };
    const { wired, runId, answers } = await setup(t, [
      { agentCalls: [call("done")], result },
    ]);
    assert.equal(
      (await awaitSettled(wired.projectionPort, "launch")).status,
      "applied",
    );
    const run = readRun(wired, runId);
    assert.equal(run.state, "blocked");
    assert.equal(run.completion, undefined);
    assert.equal(
      run.timeline.filter((e) => e.event === "interactive-step-ended").length,
      0,
    );
    assert.equal(
      run.timeline.find((e) => e.agentCall !== undefined)?.agentCall
        ?.disposition,
      "dropped",
    );
    assert.equal(answers[0]?.outcome, "accepted");
    assert.ok(
      run.actionOffers.some((o) => o.action === "end-interactive-step"),
    );
  });
}

test("without a call the Step waits; a human Turn can call done without added instructions", async (t) => {
  const { wired, runId, requests } = await setup(t, [
    { result: completed },
    { agentCalls: [call("human follow-up done")], result: completed },
  ]);
  await awaitSettled(wired.projectionPort, "launch");
  assert.equal(readRun(wired, runId).state, "blocked");
  const admission = wired.projectionPort.submit({
    operationId: "send",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "Keep going." },
  });
  assert.ok(admission.admitted);
  await awaitSettled(wired.projectionPort, "send");
  await followRun(wired.projectionPort, runId, (r) =>
    r.state === "succeeded" ? r : undefined,
  );
  assert.equal(requests[1]?.input.text, "Keep going.");
  assert.deepEqual(requests[1]?.agentCalls, requests[0]?.agentCalls);
  assert.equal(
    readRun(wired, runId).timeline.find((e) => e.endedBy === "agent")?.reason,
    "human follow-up done",
  );
});

test("a call stays pending until a clean boundary; cancelling drops it", async (t) => {
  const { wired, runId, answers } = await setup(t, [
    { agentCalls: [call("pending")], block: true, result: completed },
  ]);
  const pending = await followRun(wired.projectionPort, runId, (r) =>
    r.pendingAgentCompletion !== undefined ? r : undefined,
  );
  assert.equal(pending.state, "running");
  assert.equal(pending.pendingAgentCompletion?.reason, "pending");
  assert.equal(
    pending.timeline.some((e) => e.endedBy === "agent"),
    false,
  );
  assert.equal(answers[0]?.outcome, "accepted");
  assert.ok(
    wired.projectionPort.submit({
      operationId: "cancel",
      operation: "cancel-run",
      input: { runId },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "cancel");
  const run = readRun(wired, runId);
  assert.equal(run.state, "cancelled");
  assert.equal(
    run.timeline.some((e) => e.endedBy === "agent"),
    false,
  );
  assert.equal(run.pendingAgentCompletion, undefined);
});

test("the next Entry Turn is settled by the same Application loop", async (t) => {
  const steps = ["first", "second"].map((id) => ({
    id,
    kind: "interactive-agent",
    session: id,
    entryTurn: true,
    agentCompletion: ["step"],
    prompt: { asset: "prompt.md" },
  }));
  const { wired, runId, requests } = await setup(
    t,
    [{ agentCalls: [call("done")], result: completed }],
    steps,
  );
  await awaitSettled(wired.projectionPort, "launch");
  assert.equal(readRun(wired, runId).state, "succeeded");
  assert.deepEqual(
    requests.map((r) => r.session),
    ["first", "second"],
  );
  assert.equal(
    readRun(wired, runId).timeline.filter((e) => e.endedBy === "agent").length,
    2,
  );
});

test("author sentences follow the prompt and skill lines verbatim", async (t) => {
  const sentence =
    "Call step_done when the plan is agreed. Give a one-line reason.";
  const { wired, requests } = await setup(
    t,
    [{ result: completed }],
    [
      {
        id: "discuss",
        kind: "interactive-agent",
        session: "s",
        entryTurn: true,
        agentCompletion: ["step"],
        stepDoneWhen: sentence,
        prompt: { asset: "prompt.md" },
        uses: [{ asset: "skill" }],
      },
    ],
  );
  await awaitSettled(wired.projectionPort, "launch");
  const input = requests[0]?.input.text;
  assert.ok(input);
  assert.match(
    input,
    /^Discuss the plan\.\n\nRead the skill instructions at .*SKILL\.md before you begin\.\n\n/,
  );
  assert.equal(input.slice(input.lastIndexOf("\n\n") + 2), sentence);
});

test("a Step without an Entry Turn gets no injected input", async (t) => {
  const { wired, runId, requests } = await setup(
    t,
    [{ agentCalls: [call("done")], result: completed }],
    [
      {
        id: "discuss",
        kind: "interactive-agent",
        session: "s",
        agentCompletion: ["step"],
        prompt: { asset: "prompt.md" },
      },
    ],
  );
  await awaitSettled(wired.projectionPort, "launch");
  assert.equal(requests.length, 0);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "send",
      operation: "send-interactive-turn",
      input: { runId, stepId: "discuss", text: "Begin." },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "send");
  await followRun(wired.projectionPort, runId, (r) =>
    r.state === "succeeded" ? r : undefined,
  );
  assert.equal(requests[0]?.input.text, "Begin.");
});

test("Steers settle before an accepted call can apply", async (t) => {
  let finish!: () => void;
  let deliver!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const { wired, runId } = await setup(t, [
    {
      agentCalls: [call("done")],
      block: true,
      finish: finished,
      steerBoundary: delivered,
      result: completed,
    },
  ]);
  const pending = await followRun(wired.projectionPort, runId, (r) =>
    r.pendingAgentCompletion !== undefined ? r : undefined,
  );
  const steer = pending.actionOffers.find((o) => o.action === "steer-turn");
  assert.ok(steer?.available);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "steer",
      operation: "steer-turn",
      input: {
        runId,
        turnId: steer.turnId,
        text: "Check the last requirement.",
      },
    }).admitted,
  );
  assert.equal(
    (await awaitSettled(wired.projectionPort, "steer")).status,
    "applied",
  );
  finish();
  assert.equal(readRun(wired, runId).state, "running");
  assert.equal(
    readRun(wired, runId).timeline.some((e) => e.endedBy === "agent"),
    false,
  );
  deliver();
  const run = await followRun(wired.projectionPort, runId, (r) =>
    r.state === "succeeded" ? r : undefined,
  );
  const steerIndex = run.timeline.findIndex((e) => e.event === "steer");
  const endIndex = run.timeline.findIndex((e) => e.endedBy === "agent");
  assert.ok(steerIndex >= 0 && endIndex > steerIndex);
  assert.equal(run.timeline[steerIndex]?.steer?.settlement.kind, "delivered");
});

test("a shared Session keeps its tools but refuses a call on a Step not opted in", async (t) => {
  const steps = [
    {
      id: "discuss",
      kind: "interactive-agent",
      session: "s",
      entryTurn: true,
      agentCompletion: ["step"],
      prompt: { asset: "prompt.md" },
    },
    {
      id: "apply",
      kind: "agent",
      session: "s",
      prompt: { asset: "prompt.md" },
    },
  ];
  const { wired, runId, answers, requests } = await setup(
    t,
    [{ agentCalls: [call("done")], result: completed }],
    steps,
  );
  await awaitSettled(wired.projectionPort, "launch");
  assert.equal(readRun(wired, runId).state, "succeeded");
  assert.deepEqual(
    answers.map((a) => a.outcome),
    ["accepted", "refused"],
  );
  assert.equal(
    answers[1]?.outcome === "refused" ? answers[1].reason : "",
    "call-not-enabled",
  );
  assert.deepEqual(requests[1]?.agentCalls, requests[0]?.agentCalls);
  assert.equal(requests[1]?.input.text, "Discuss the plan.");
});

for (const state of ["running", "blocked"] as const) {
  test(`resume applies a clean call once after a crash with state ${state}`, async (t) => {
    const { wired, runId, reopen } = await setup(t, [{ result: completed }]);
    await awaitSettled(wired.projectionPort, "launch");
    await wired.shutdown();
    assert.equal(wired.runGroup.resumeRun(runId).outcome, "resumed");
    const owner = wired.runGroup.acquireRun(runId);
    assert.ok(owner);
    const last = owner.turns().at(-1);
    assert.ok(last);
    assert.ok(
      owner.appendTurnEvent({
        turnId: last.turnId,
        kind: "agent-call",
        payload: JSON.stringify({
          callId: "crash-call",
          id: "step_done",
          reason: "finished before crash",
          answer: { outcome: "accepted" },
        }),
        at: new Date(),
      }).ok,
    );
    assert.ok(owner.writeState(state).ok);
    owner.close();
    const recovered = reopen();
    const admission = recovered.projectionPort.submit({
      operationId: "resume",
      operation: "resume-run",
      input: { runId },
    });
    assert.ok(admission.admitted, JSON.stringify(admission));
    assert.equal(
      (await awaitSettled(recovered.projectionPort, "resume")).status,
      "applied",
    );
    const run = readRun(recovered, runId);
    assert.equal(run.state, "succeeded");
    assert.equal(run.timeline.filter((e) => e.endedBy === "agent").length, 1);
    assert.equal(
      run.timeline.find((e) => e.endedBy === "agent")?.reason,
      "finished before crash",
    );
    assert.ok(
      recovered.projectionPort.submit({
        operationId: "resume",
        operation: "resume-run",
        input: { runId },
      }).admitted,
    );
    assert.equal(
      readRun(recovered, runId).timeline.filter((e) => e.endedBy === "agent")
        .length,
      1,
    );
  });
}

test("Interrupt drops a pending call and a later no-call Turn keeps waiting", async (t) => {
  const { wired, runId } = await setup(t, [
    { agentCalls: [call("pending")], block: true, result: completed },
    { result: completed },
  ]);
  const pending = await followRun(wired.projectionPort, runId, (r) =>
    r.pendingAgentCompletion !== undefined ? r : undefined,
  );
  const interrupt = pending.actionOffers.find(
    (o) => o.action === "interrupt-turn",
  );
  assert.ok(interrupt);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "interrupt",
      operation: "interrupt-turn",
      input: { runId, turnId: interrupt.turnId },
    }).admitted,
  );
  assert.equal(
    (await awaitSettled(wired.projectionPort, "interrupt")).status,
    "applied",
  );
  await awaitSettled(wired.projectionPort, "launch");
  const waiting = readRun(wired, runId);
  assert.equal(waiting.state, "blocked");
  assert.equal(waiting.pendingAgentCompletion, undefined);
  assert.ok(
    waiting.actionOffers.some((o) => o.action === "end-interactive-step"),
  );
  assert.ok(
    wired.projectionPort.submit({
      operationId: "send",
      operation: "send-interactive-turn",
      input: { runId, stepId: "discuss", text: "Try again." },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "send");
  const run = await followRun(wired.projectionPort, runId, (r) =>
    r.state === "blocked" ? r : undefined,
  );
  assert.equal(
    run.timeline.some((e) => e.endedBy === "agent"),
    false,
  );
  assert.equal(
    run.timeline.filter((e) => e.event === "turn-settled").at(-1)?.detail,
    "completed",
  );
});

test("completion after an Agent follow-up never reuses its closed Harness or input", async (t) => {
  const interrupted: FakeScript["turns"][number]["result"] = {
    kind: "interrupted",
    detail: {
      interruption: { mode: "process-only", evidence: "fake stop" },
      session: { state: "open" },
    },
  };
  const steps = [
    {
      id: "before",
      kind: "agent",
      session: "s",
      prompt: { asset: "prompt.md" },
    },
    {
      id: "discuss",
      kind: "interactive-agent",
      session: "s",
      entryTurn: true,
      agentCompletion: ["step"],
      prompt: { asset: "prompt.md" },
    },
    {
      id: "after",
      kind: "agent",
      session: "s",
      prompt: { asset: "prompt.md" },
    },
  ];
  const { wired, runId, requests } = await setup(
    t,
    (prepare) =>
      prepare === 0
        ? [
            { result: interrupted },
            { result: completed },
            { agentCalls: [call("done")], result: completed },
          ]
        : [{ result: completed }],
    steps,
  );
  await awaitSettled(wired.projectionPort, "launch");
  const followUp = readRun(wired, runId).actionOffers.find(
    (o) => o.action === "send-follow-up-turn",
  );
  assert.ok(followUp);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "follow-up",
      operation: "send-follow-up-turn",
      input: { runId, turnId: followUp.turnId, text: "Finish the first Step." },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "follow-up");
  const run = await followRun(wired.projectionPort, runId, (r) =>
    r.state === "succeeded" || r.problem !== undefined ? r : undefined,
  );
  assert.equal(run.problem, undefined);
  assert.equal(run.state, "succeeded");
  assert.equal(requests[1]?.input.text, "Finish the first Step.");
  assert.equal(requests[3]?.input.text, "Discuss the plan.");
  assert.equal(run.timeline.filter((e) => e.endedBy === "agent").length, 1);
});

for (const scope of ["fresh", "repeat"] as const) {
  test(`${scope} completion tools belong only to the actual opted-in Session`, async (t) => {
    const interactive = {
      id: "discuss",
      kind: "interactive-agent",
      session: scope === "fresh" ? "fresh" : "s",
      entryTurn: true,
      agentCompletion: ["step"],
      prompt: { asset: "prompt.md" },
    };
    const steps = [
      {
        id: "before",
        kind: "agent",
        session: scope === "fresh" ? "fresh" : "s",
        prompt: { asset: "prompt.md" },
      },
      ...(scope === "repeat"
        ? [{ repeat: { control: "human", steps: [interactive] } }]
        : [interactive]),
    ];
    const { wired, runId, requests } = await setup(
      t,
      [{ result: completed }, { result: completed }],
      steps,
    );
    await awaitSettled(wired.projectionPort, "launch");
    assert.equal(readRun(wired, runId).state, "blocked");
    assert.notEqual(requests[0]?.session, requests[1]?.session);
    assert.deepEqual(requests[0]?.agentCalls, []);
    assert.deepEqual(
      requests[1]?.agentCalls?.map((c) => c.id),
      ["step_done"],
    );
  });
}
