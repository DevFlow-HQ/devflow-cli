import { readRun } from "./run-test-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { FakeScript } from "../harness/fake-adapter.js";
import { awaitSettled, followRun } from "../helpers/settleOperation.js";
import {
  launchAgentCompletionRun as setup,
  completed,
  call,
  reviewedLoop,
  across,
  type TurnEventRead,
} from "../helpers/agentCompletion.js";

test("a clean Entry Turn applies the latest step done through the Projection Port", async (t) => {
  const { wired, runId, requests, answers } = await setup(t, [
    { agentCalls: [call("first"), call("last")], result: completed },
  ]);
  assert.equal(
    (await awaitSettled(wired.projectionPort, "launch")).status,
    "applied",
  );
  const run = readRun(wired.projectionPort, runId);
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
  assert.equal(
    requests[0]?.input.text,
    "Discuss the plan.\n\nWhen the work this step asked of you is finished, call step done with a one-line reason.",
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
    const run = readRun(wired.projectionPort, runId);
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
  assert.equal(readRun(wired.projectionPort, runId).state, "blocked");
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
    readRun(wired.projectionPort, runId).timeline.find(
      (e) => e.endedBy === "agent",
    )?.reason,
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
  const run = readRun(wired.projectionPort, runId);
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
  assert.equal(readRun(wired.projectionPort, runId).state, "succeeded");
  assert.deepEqual(
    requests.map((r) => r.session),
    ["first", "second"],
  );
  assert.equal(
    readRun(wired.projectionPort, runId).timeline.filter(
      (e) => e.endedBy === "agent",
    ).length,
    2,
  );
});

for (const agentCompletion of [
  true,
  ["stage", "step"],
  ["stage", "step", "stage"],
]) {
  test(`Entry Turn defaults follow skill lines in step-then-stage order for ${JSON.stringify(agentCompletion)}`, async (t) => {
    const routing = [
      {
        repeat: {
          control: "human",
          steps: [
            {
              id: "implement",
              kind: "interactive-agent",
              session: "s",
              entryTurn: true,
              agentCompletion,
              prompt: { asset: "prompt.md" },
              uses: [{ asset: "skill" }],
            },
          ],
        },
      },
    ];
    const { wired, requests } = await setup(
      t,
      [{ result: completed }],
      routing,
    );
    await awaitSettled(wired.projectionPort, "launch");
    const input = requests[0]?.input.text;
    assert.ok(input);
    const skillLine = input.split("\n")[2];
    assert.match(
      skillLine ?? "",
      /^Read the skill instructions at .*SKILL\.md before you begin\.$/,
    );
    assert.equal(
      input,
      `Discuss the plan.\n\n${skillLine}\n\nWhen the work this step asked of you is finished, call step done with a one-line reason.\nWhen no work is left for this stage, call stage done with a one-line reason instead.`,
    );
  });
}

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

for (const { name, fields, expected } of [
  {
    name: "step author text beside the stage default",
    fields: {
      stepDoneWhen: "Call step done once the plan is agreed. Give one reason.",
    },
    expected:
      "Discuss the plan.\n\nCall step done once the plan is agreed. Give one reason.\nWhen no work is left for this stage, call stage done with a one-line reason instead.",
  },
  {
    name: "stage author text beside the step default",
    fields: {
      stageDoneWhen:
        "Call stage done if no tickets remain. Give a one-line reason instead.",
    },
    expected:
      "Discuss the plan.\n\nWhen the work this step asked of you is finished, call step done with a one-line reason.\nCall stage done if no tickets remain. Give a one-line reason instead.",
  },
  {
    name: "both author texts",
    fields: {
      stepDoneWhen: "Call step done. Explain why.",
      stageDoneWhen: "Call stage done. Explain why instead.",
    },
    expected:
      "Discuss the plan.\n\nCall step done. Explain why.\nCall stage done. Explain why instead.",
  },
  {
    name: "only the stage default when step done is off",
    fields: { agentCompletion: ["stage"] },
    expected:
      "Discuss the plan.\n\nWhen no work is left for this stage, call stage done with a one-line reason instead.",
  },
  {
    name: "no instructions when completion is off",
    fields: { agentCompletion: false },
    expected: "Discuss the plan.",
  },
]) {
  test(`Entry Turn sends ${name} verbatim`, async (t) => {
    const routing = reviewedLoop().map(({ repeat }) => ({
      repeat: {
        ...repeat,
        steps: repeat.steps.map((step) => ({ ...step, ...fields })),
      },
    }));
    const { wired, requests } = await setup(
      t,
      [{ result: completed }],
      routing,
    );
    await awaitSettled(wired.projectionPort, "launch");
    assert.equal(requests[0]?.input.text, expected);
  });
}

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
  assert.equal(readRun(wired.projectionPort, runId).state, "running");
  assert.equal(
    readRun(wired.projectionPort, runId).timeline.some(
      (e) => e.endedBy === "agent",
    ),
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
  assert.equal(readRun(wired.projectionPort, runId).state, "succeeded");
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
        fact: {
          kind: "agent-call",
          data: {
            callId: "crash-call",
            id: "step_done",
            reason: "finished before crash",
            answer: { outcome: "accepted" },
          },
        },
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
    const run = readRun(recovered.projectionPort, runId);
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
      readRun(recovered.projectionPort, runId).timeline.filter(
        (e) => e.endedBy === "agent",
      ).length,
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
  const waiting = readRun(wired.projectionPort, runId);
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
  const followUp = readRun(wired.projectionPort, runId).actionOffers.find(
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
    assert.equal(readRun(wired.projectionPort, runId).state, "blocked");
    assert.notEqual(requests[0]?.session, requests[1]?.session);
    assert.deepEqual(requests[0]?.agentCalls, []);
    assert.deepEqual(
      requests[1]?.agentCalls?.map((c) => c.id),
      ["step_done"],
    );
  });
}

const continueOnce = (key: string) => ({
  agentCalls: [call(`ticket ${key} done`, key)],
  result: completed,
});

test("agent Continues apply up to the Review checkpoint and the next is held", async (t) => {
  const { wired, runId, answers, requests } = await setup(
    t,
    across([continueOnce("1"), continueOnce("2"), continueOnce("3")]),
    reviewedLoop({ interval: 2, message: "Look over the tracker." }),
  );
  assert.equal(
    (await awaitSettled(wired.projectionPort, "launch")).status,
    "applied",
  );
  assert.deepEqual(
    answers.map((a) => a.outcome),
    ["accepted", "accepted", "held-for-review"],
  );
  assert.equal(new Set(requests.map((r) => r.session)).size, 3);
  assert.deepEqual(requests[0]?.agentCalls?.map((c) => c.id).sort(), [
    "stage_done",
    "step_done",
  ]);
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "blocked");
  assert.deepEqual(run.heldForReview, {
    interval: 2,
    message: "Look over the tracker.",
    reason: "ticket 3 done",
  });
  const continued = run.timeline.filter((e) => e.event === "repeat-continued");
  assert.deepEqual(
    continued.map((e) => [e.endedBy, e.reason]),
    [
      ["agent", "ticket 1 done"],
      ["agent", "ticket 2 done"],
    ],
  );
  assert.deepEqual(
    run.timeline.filter((e) => e.agentCall !== undefined).at(-1)?.agentCall
      ?.answer,
    { outcome: "held-for-review" },
  );
  for (const action of [
    "send-interactive-turn",
    "continue-repeat",
    "end-stage",
  ])
    assert.ok(run.actionOffers.some((o) => o.action === action));
});

test("the person's Continue resets the count and stage done is never held", async (t) => {
  const { wired, runId, answers } = await setup(
    t,
    across([
      continueOnce("1"),
      continueOnce("2"),
      continueOnce("3"),
      continueOnce("4"),
      continueOnce("5"),
      continueOnce("6"),
      {
        agentCalls: [call("tracker empty", "7", "stage_done")],
        result: completed,
      },
    ]),
    reviewedLoop({ interval: 2 }),
  );
  await awaitSettled(wired.projectionPort, "launch");
  assert.equal(
    readRun(wired.projectionPort, runId).heldForReview?.reason,
    "ticket 3 done",
  );
  assert.ok(
    wired.projectionPort.submit({
      operationId: "continue",
      operation: "continue-repeat",
      input: { runId, stepId: "implement" },
    }).admitted,
  );
  assert.equal(
    (await awaitSettled(wired.projectionPort, "continue")).status,
    "applied",
  );
  const held = await followRun(wired.projectionPort, runId, (r) =>
    r.heldForReview?.reason === "ticket 6 done" ? r : undefined,
  );
  assert.equal(held.state, "blocked");
  assert.match(held.heldForReview?.message ?? "", /2 Iterations in a row/);
  assert.equal(held.completion, undefined);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "send",
      operation: "send-interactive-turn",
      input: { runId, stepId: "implement", text: "Anything left?" },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "send");
  const run = await followRun(wired.projectionPort, runId, (r) =>
    r.state === "succeeded" ? r : undefined,
  );
  assert.deepEqual(
    answers.map((a) => a.outcome),
    [
      "accepted",
      "accepted",
      "held-for-review",
      "accepted",
      "accepted",
      "held-for-review",
      "accepted",
    ],
  );
  assert.equal(run.completion, "agent-declared");
  assert.equal(run.heldForReview, undefined);
  const ended = run.timeline.find((e) => e.event === "stage-ended");
  assert.equal(ended?.endedBy, "agent");
  assert.equal(ended?.reason, "tracker empty");
  assert.deepEqual(
    run.timeline
      .filter((e) => e.event === "repeat-continued")
      .map((e) => e.endedBy ?? "person"),
    ["agent", "agent", "person", "agent", "agent"],
  );
});

test("a person's End Stage after agent Continues is a human-declared completion", async (t) => {
  const { wired, runId } = await setup(
    t,
    across([continueOnce("1"), { result: completed }]),
    reviewedLoop(),
  );
  await awaitSettled(wired.projectionPort, "launch");
  assert.equal(readRun(wired.projectionPort, runId).heldForReview, undefined);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "end",
      operation: "end-stage",
      input: { runId, stepId: "implement" },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "end");
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.completion, "human-declared");
});

test("resume applies a clean stage done recorded before a crash", async (t) => {
  const { wired, runId, reopen } = await setup(
    t,
    [{ result: completed }],
    reviewedLoop({ interval: 1 }),
  );
  await awaitSettled(wired.projectionPort, "launch");
  await wired.shutdown();
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  const last = owner.turns().at(-1);
  assert.ok(last);
  assert.ok(
    owner.appendTurnEvent({
      turnId: last.turnId,
      fact: {
        kind: "agent-call",
        data: {
          callId: "crash-call",
          id: "stage_done",
          reason: "no ticket left",
          answer: { outcome: "accepted" },
        },
      },
      at: new Date(),
    }).ok,
  );
  owner.close();
  const recovered = reopen();
  const before = readRun(recovered.projectionPort, runId);
  assert.equal(before.state, "blocked");
  assert.ok(before.actionOffers.some((o) => o.action === "resume-run"));
  assert.ok(
    recovered.projectionPort.submit({
      operationId: "resume",
      operation: "resume-run",
      input: { runId },
    }).admitted,
  );
  assert.equal(
    (await awaitSettled(recovered.projectionPort, "resume")).status,
    "applied",
  );
  const run = readRun(recovered.projectionPort, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.completion, "agent-declared");
  assert.equal(
    run.timeline.find((e) => e.event === "stage-ended")?.reason,
    "no ticket left",
  );
});

test("m10-followup-bounded-run-snapshot: settling agent Continues reads only the judged Turn's Agent-call rows", async (t) => {
  const reads: TurnEventRead[] = [];
  const withBodies = (key: string) => ({
    ...continueOnce(key),
    events: [
      { kind: "thought" as const, summaryId: `t-${key}`, content: "Thinking" },
      { kind: "turn-diff" as const, diff: { content: "diff", files: [] } },
    ],
  });
  const { wired, runId, answers } = await setup(
    t,
    across([withBodies("1"), withBodies("2"), withBodies("3")]),
    reviewedLoop({ interval: 2, message: "Look over the tracker." }),
    { onTurnEventRead: (read) => reads.push(read) },
  );
  assert.equal(
    (await awaitSettled(wired.projectionPort, "launch")).status,
    "applied",
  );
  assert.deepEqual(
    answers.map((a) => a.outcome),
    ["accepted", "accepted", "held-for-review"],
  );
  assert.equal(
    readRun(wired.projectionPort, runId).heldForReview?.reason,
    "ticket 3 done",
  );
  const perTurn = reads.filter((read) => read.turnId !== undefined);
  // Each judged Turn holds one call, and each read returns that row alone.
  assert.deepEqual(
    [...new Set(perTurn.map((read) => read.turnId))],
    ["0.0:implement#entry", "1.0:implement#entry", "2.0:implement#entry"],
  );
  for (const read of perTurn)
    assert.deepEqual(read.kindsRead, ["agent-call"], JSON.stringify(read));
  for (const read of reads) {
    assert.notEqual(read.kinds, undefined, "no read takes every kind");
    assert.ok(
      !read.kindsRead.some(
        (kind) => kind === "thought" || kind === "turn-diff",
      ),
      JSON.stringify(read),
    );
  }
});
