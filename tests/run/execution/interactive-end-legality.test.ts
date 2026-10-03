import assert from "node:assert/strict";
import test from "node:test";
import {
  interactiveEndLegality,
  type InteractiveEndLegality,
} from "../../../src/run/execution/execution.js";
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
        }),
        { kind: "refused", reason: "mid-turn" },
      );
    });
  }
}
