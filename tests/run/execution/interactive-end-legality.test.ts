import assert from "node:assert/strict";
import test from "node:test";
import {
  interactiveEndLegality,
  type InteractiveEndLegality,
} from "../../../src/run/execution/execution.js";
import type { AttemptLogEntry } from "../../../src/run/store/store.js";
import type { AgentStep, RoutingNode } from "../../../src/workflow/workflow.js";

const step: AgentStep = {
  id: "implement",
  kind: "interactive-agent",
  prompt: { asset: "prompt.md" },
  session: "implementation",
};

test("End Step is legal outside a human-controlled Repeat at a Turn boundary", () => {
  assert.deepEqual(
    interactiveEndLegality({
      routing: [step],
      step,
      control: "end-interactive-step",
      turnLive: false,
      attemptLog: [],
    }),
    { kind: "legal" },
  );
});

const otherStep: AgentStep = { ...step, id: "other" };
const humanRouting: readonly RoutingNode[] = [
  { repeat: { control: "human", steps: [step] } },
];
const verdictRouting: readonly RoutingNode[] = [
  {
    repeat: {
      until: "passing",
      reviewCheckpoint: { interval: 5, message: "Review the work." },
      steps: [step],
    },
  },
];
const positions = [
  {
    name: "outside a human-controlled Repeat",
    routing: [step],
    expected: [
      { kind: "legal" },
      { kind: "refused", reason: "continue-outside-human-repeat" },
      { kind: "refused", reason: "end-stage-outside-human-repeat" },
    ],
  },
  {
    name: "inside a human-controlled Repeat",
    routing: humanRouting,
    expected: [
      { kind: "refused", reason: "end-step-in-human-repeat" },
      { kind: "legal" },
      { kind: "legal" },
    ],
  },
  {
    name: "inside a Verdict-driven Repeat",
    routing: verdictRouting,
    expected: [
      { kind: "legal" },
      { kind: "refused", reason: "continue-outside-human-repeat" },
      { kind: "refused", reason: "end-stage-outside-human-repeat" },
    ],
  },
  {
    name: "beside an unrelated human-controlled Repeat",
    routing: [step, { repeat: { control: "human", steps: [otherStep] } }],
    expected: [
      { kind: "legal" },
      { kind: "refused", reason: "continue-outside-human-repeat" },
      { kind: "refused", reason: "end-stage-outside-human-repeat" },
    ],
  },
] satisfies readonly {
  name: string;
  routing: readonly RoutingNode[];
  expected: readonly InteractiveEndLegality[];
}[];
const controls = [
  "end-interactive-step",
  "continue-repeat",
  "end-stage",
] as const;

for (const position of positions) {
  for (const [index, control] of controls.entries()) {
    test(`${control} at a Turn boundary ${position.name}`, () => {
      assert.deepEqual(
        interactiveEndLegality({
          routing: position.routing,
          step,
          control,
          turnLive: false,
          attemptLog: [],
        }),
        position.expected[index],
      );
    });
  }
}

for (const position of positions) {
  for (const control of controls) {
    test(`${control} is refused mid-Turn ${position.name}, before any position mismatch`, () => {
      assert.deepEqual(
        interactiveEndLegality({
          routing: position.routing,
          step,
          control,
          turnLive: true,
          attemptLog: [],
        }),
        { kind: "refused", reason: "mid-turn" },
      );
    });
  }
}

test("agent step done requires a live Turn and the current Step's opt-in", () => {
  const optedIn: AgentStep = { ...step, agentCompletion: ["step"] };
  assert.deepEqual(
    interactiveEndLegality({
      routing: [optedIn],
      step: optedIn,
      control: "step_done",
      turnLive: true,
      attemptLog: [],
    }),
    { kind: "legal" },
  );
  assert.deepEqual(
    interactiveEndLegality({
      routing: [optedIn],
      step: optedIn,
      control: "step_done",
      turnLive: false,
      attemptLog: [],
    }),
    { kind: "refused", reason: "no-live-turn" },
  );
  assert.deepEqual(
    interactiveEndLegality({
      routing: [step],
      step,
      control: "step_done",
      turnLive: true,
      attemptLog: [],
    }),
    { kind: "refused", reason: "call-not-enabled" },
  );
  assert.deepEqual(
    interactiveEndLegality({
      routing: [optedIn],
      step: optedIn,
      control: "stage_done",
      turnLive: true,
      attemptLog: [],
    }),
    { kind: "refused", reason: "call-not-enabled" },
  );
});

const reviewed: AgentStep = { ...step, agentCompletion: true };
const reviewedRouting = (reviewCheckpoint?: {
  interval?: number;
  message?: string;
}): readonly RoutingNode[] => [
  {
    repeat: {
      control: "human",
      ...(reviewCheckpoint !== undefined ? { reviewCheckpoint } : {}),
      steps: [reviewed],
    },
  },
];
const settled = (
  iteration: number,
  entry: Partial<AttemptLogEntry> = {},
): AttemptLogEntry => ({
  attemptId: `${iteration}.0:implement`,
  outcome: "succeeded",
  at: "2026-10-04T00:00:00.000Z",
  ...entry,
});
const agentContinues = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) =>
    settled(from + i, { endedBy: "agent" }),
  );
const callLegality = (
  control: "step_done" | "stage_done",
  attemptLog: readonly AttemptLogEntry[],
  routing = reviewedRouting({ interval: 2, message: "Look it over." }),
) =>
  interactiveEndLegality({
    routing,
    step: reviewed,
    control,
    turnLive: true,
    attemptLog,
  });
const held = { kind: "held-for-review" } as const;

test("agent Continues up to the interval apply and the next is held for review", () => {
  assert.deepEqual(callLegality("step_done", []), { kind: "legal" });
  assert.deepEqual(callLegality("step_done", agentContinues(1)), {
    kind: "legal",
  });
  assert.deepEqual(callLegality("step_done", agentContinues(2)), held);
});

test("the person's Continue resets the consecutive agent count", () => {
  assert.deepEqual(
    callLegality("step_done", [
      ...agentContinues(2),
      settled(2),
      ...agentContinues(1, 3),
    ]),
    { kind: "legal" },
  );
  assert.deepEqual(
    callLegality("step_done", [
      ...agentContinues(2),
      settled(2),
      ...agentContinues(2, 3),
    ]),
    held,
  );
});

test("only the group's settled Continues count toward the checkpoint", () => {
  assert.deepEqual(
    callLegality("step_done", [
      settled(0, { endedBy: "agent" }),
      settled(1, { attemptId: "0.0:other", endedBy: "agent" }),
    ]),
    { kind: "legal" },
  );
  assert.deepEqual(
    callLegality("step_done", [
      settled(0, { endedBy: "agent" }),
      settled(1, { outcome: "failed" }),
      settled(1, { attemptId: "6a1c2f0e-reconciled", outcome: "failed" }),
      settled(1, { attemptId: "1.1:implement", endedBy: "agent" }),
    ]),
    held,
  );
});

test("stage done is never held, even past the interval", () => {
  assert.deepEqual(callLegality("stage_done", agentContinues(5)), {
    kind: "legal",
  });
});

test("the checkpoint defaults to 100 agent Continues", () => {
  const routing = reviewedRouting();
  assert.deepEqual(callLegality("step_done", agentContinues(99), routing), {
    kind: "legal",
  });
  assert.deepEqual(
    callLegality("step_done", agentContinues(100), routing),
    held,
  );
});

test("a checkpoint never changes the person's Continue or End Stage", () => {
  for (const control of ["continue-repeat", "end-stage"] as const)
    assert.deepEqual(
      interactiveEndLegality({
        routing: reviewedRouting({ interval: 1 }),
        step: reviewed,
        control,
        turnLive: false,
        attemptLog: agentContinues(3),
      }),
      { kind: "legal" },
    );
});
