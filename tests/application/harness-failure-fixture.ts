import type { RunFailureView } from "../../src/application/projection-port.js";
import type { TurnResult } from "../../src/harness/harness.js";
import { createFake, fakeHarnessProfile } from "../harness/fake-adapter.js";
import { launch, writeBundle } from "./agent-receipt-fixture.js";
import type { TestContext } from "node:test";

const failure = {
  phase: "turn",
  category: "provider-new-category",
  possibleEffects: "possible",
  nativeCode: "ENATIVE",
  cause: new Error("sign in: native prose does not classify this failure"),
  partialOutput: "partial",
  retryEvidence: "retry",
  diagnostics: "diagnostic",
} as const;
const session = { state: "open" } as const;
const effectiveModel = { known: false } as const;
const generic =
  "Claude Code reported an error. Open the details section for the cause.";
const effects = " It may have changed files before it stopped.";
export const harnessFailureCases: readonly {
  name: string;
  result: TurnResult;
  explanation: string;
  effects: RunFailureView["possibleEffects"];
}[] = [
  {
    name: "authentication",
    result: {
      kind: "failed",
      detail: {
        session,
        effectiveModel,
        failure: {
          ...failure,
          category: "authentication",
          possibleEffects: "none",
        },
      },
    },
    explanation: "Claude Code is not signed in.",
    effects: "none",
  },
  {
    name: "generic",
    result: { kind: "failed", detail: { session, effectiveModel, failure } },
    explanation: generic + effects,
    effects: "unknown",
  },
  {
    name: "committed",
    result: {
      kind: "failed",
      detail: {
        session,
        effectiveModel,
        failure: { ...failure, possibleEffects: "committed" },
      },
    },
    explanation: generic + effects,
    effects: "partial",
  },
  {
    name: "not-started",
    result: {
      kind: "not-started",
      detail: {
        failure: { ...failure, phase: "launch", possibleEffects: "none" },
      },
    },
    explanation: generic,
    effects: "none",
  },
  ...(["acceptance", "completion", "interruption"] as const).map((unknown) => ({
    name: `lost-${unknown}`,
    result: {
      kind: "lost",
      detail: {
        unknown,
        lastObservation: `last ${unknown} observation`,
        session,
        failure,
      },
    } satisfies TurnResult,
    explanation:
      `Claude Code exited or lost contact. Secant does not know ${unknown === "acceptance" ? "whether it accepted the Turn" : unknown === "completion" ? "whether the Turn finished" : "whether the Turn stopped after the interrupt"}.` +
      effects,
    effects: "unknown" as const,
  })),
  {
    name: "lost-no-failure",
    result: {
      kind: "lost",
      detail: {
        unknown: "completion",
        lastObservation: "last observation without failure",
        session,
      },
    },
    explanation:
      "Claude Code exited or lost contact. Secant does not know whether the Turn finished." +
      effects,
    effects: "unknown",
  },
];

export function launchHarnessFailure(t: TestContext, result: TurnResult) {
  return launch(
    t,
    createFake({ profile: fakeHarnessProfile(), turns: [{ result }] })(),
    writeBundle("none"),
  );
}
