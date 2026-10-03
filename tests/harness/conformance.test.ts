// Runs the shared conformance suite against the deterministic fake Adapter. The
// same suite runs against the Claude Code Adapter over the replayer from #112
// on; running both keeps the fake honest to the Interface.

import test from "node:test";
import type {
  ApprovalDecision,
  HarnessDefaults,
  HarnessProfile,
  LostUnknown,
  ModelDeclaration,
  ModelEntry,
  RequestShape,
  TurnEvent,
  TurnResult,
} from "../../src/harness/harness.js";
import {
  type ConformanceScenarios,
  type ModelDeclarationScenarios,
  runConformanceSuite,
  runModelDeclarationCases,
  runPendingSteerCases,
  runStretchingSteerCases,
} from "./conformance.js";
import {
  createFake,
  REPLAY_BARRIER,
  type FakeRequestSpec,
  type FakeScript,
  type FakeTurnRequestRecord,
  type FakeTurnScript,
} from "./fake-adapter.js";

const DECISIONS: readonly ApprovalDecision[] = ["allow", "deny"];

const FAKE_MODEL_A: ModelEntry = {
  model: "fake-model-a",
  label: "Fake Model A",
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
};
/** A listed model without an effort setting. */
const FAKE_MODEL_B: ModelEntry = {
  model: "fake-model-b",
  label: "Fake Model B",
  efforts: [],
};
const FIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function profile(overrides?: Partial<HarnessProfile>): HarnessProfile {
  return {
    harness: "fake",
    executable: "fake-harness",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "load-with-replay", evidence: "fake replays history" },
    interruption: { mode: "process-only", evidence: "fake stops the process" },
    approvals: { available: true, evidence: "fake hosts a bridge" },
    clarifications: {
      available: true,
      evidence: "fake offers a question shape",
    },
    steer: { available: false, evidence: "fake rejects steer unless scripted" },
    modelSelection: {
      at: "launch",
      declaration: { kind: "list", models: [FAKE_MODEL_A, FAKE_MODEL_B] },
      evidence: "fake declares a supported-model list",
    },
    modelObservation: {
      available: true,
      evidence: "fake observes the effective model from its script",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "fake mints the id before submission",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence: "fake reads a SKILL.md path",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "fake reads an absolute path",
    },
    ...overrides,
  };
}

function approval(id: string, awaited: boolean): FakeRequestSpec {
  const shape: RequestShape = {
    kind: "approval",
    tool: "Edit",
    input: `edit ${id}`,
    decisions: DECISIONS,
  };
  return { id, shape, awaited };
}

const COMPLETED_OPEN: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: "done",
    effectiveModel: { known: true, model: "fake-model" },
    session: { state: "open" },
  },
};

const SESSION_OPEN = {
  kind: "session",
  availability: { state: "open" },
} as const;

const DETACHED = {
  state: "detached",
  coordinate: { opaque: "conformance" },
} as const;

const LOST_INTERRUPTION: TurnResult = {
  kind: "lost",
  detail: {
    unknown: "interruption",
    lastObservation: "blocked before the interruption completed",
    session: DETACHED,
  },
};

const LOST_COMPLETION: TurnResult = {
  kind: "lost",
  detail: {
    unknown: "completion",
    lastObservation: "the producer closed before a result",
    session: DETACHED,
  },
};

const FAILED_RECOVERY: TurnResult = {
  kind: "failed",
  detail: {
    failure: {
      phase: "recovery",
      category: "recovery-unacknowledged",
      possibleEffects: "possible",
      diagnostics: "the resumed Session was not acknowledged",
    },
    effectiveModel: { known: false },
    session: {
      state: "unusable",
      reason: "the resumed Session was not acknowledged",
    },
  },
};

function fake(...turns: FakeTurnScript[]): FakeScript {
  return {
    profile: profile(),
    turns,
    defaults: {
      kind: "reported",
      choice: { model: "fake-model-a", effort: "high" },
    },
  };
}

const scenarios: ConformanceScenarios = {
  label: "fake",
  concurrentCount: 3,
  // The fake declares a supported-model list, so the declaration case sees a list
  // and the requested-model cases exercise both admission and typed rejection.
  expectedDeclaration: { kind: "list", includes: [FAKE_MODEL_A, FAKE_MODEL_B] },
  expectedDefaults: {
    kind: "reported",
    choice: { model: "fake-model-a", effort: "high" },
  },
  requestedModel: "fake-model-a",
  // The fake records each request's effort, so the opaque effort path is proven
  // here before any Run carries one (#342).
  requestedEffort: "high",
  unknownModel: "fake-model-z",
  requesting: () => {
    const turnRequests: FakeTurnRequestRecord[] = [];
    return {
      factory: createFake({
        ...fake({
          events: [{ kind: "assistant-content", content: "hello" }],
          result: COMPLETED_OPEN,
        }),
        turnRequests,
      }),
      requests: () => turnRequests.map((request) => request.modelChoice),
    };
  },
  baseline: () =>
    createFake(
      fake({
        events: [
          { kind: "assistant-content", content: "hello" },
          {
            kind: "tool-activity",
            activity: {
              tool: "Read",
              phase: "completed",
              summary: "read a file",
            },
          },
        ],
        result: COMPLETED_OPEN,
      }),
    ),
  prepareFailure: () =>
    createFake({
      profile: profile(),
      prepareFailure: {
        phase: "prepare",
        category: "authentication",
        possibleEffects: "none",
        cause: "Authentication required for the fake Harness.",
      },
      turns: [],
    }),
  concurrentRequests: () =>
    createFake(
      fake({
        requests: [
          approval("req-a", true),
          approval("req-b", true),
          approval("req-c", true),
        ],
        result: COMPLETED_OPEN,
      }),
    ),
  awaitedApproval: () =>
    createFake(
      fake({ requests: [approval("req-1", true)], result: COMPLETED_OPEN }),
    ),
  expiringRequest: () =>
    createFake(
      fake({ requests: [approval("req-x", false)], result: COMPLETED_OPEN }),
    ),
  interruptible: () =>
    createFake(
      fake({ requests: [approval("req-i", true)], result: COMPLETED_OPEN }),
    ),
  failedTurn: () =>
    createFake(
      fake({
        events: [{ kind: "assistant-content", content: "partial work" }],
        result: {
          kind: "failed",
          detail: {
            failure: {
              phase: "turn",
              category: "max-turns",
              possibleEffects: "possible",
              partialOutput: "partial work",
            },
            effectiveModel: { known: true, model: "fake-model" },
            session: { state: "open" },
          },
        },
      }),
    ),
  lost: (unknown: LostUnknown) =>
    createFake(
      fake({
        result: {
          kind: "lost",
          detail: {
            unknown,
            lastObservation: `last authoritative observation before ${unknown} lost`,
            session: {
              state: "detached",
              coordinate: { opaque: "lost-session" },
            },
          },
        },
      }),
    ),
  resumable: () =>
    createFake(
      fake(
        { requests: [approval("req-r", true)], result: COMPLETED_OPEN },
        { result: COMPLETED_OPEN },
      ),
    ),
  blockingTurn: () =>
    createFake(
      fake({ events: [SESSION_OPEN], block: true, result: COMPLETED_OPEN }),
    ),
  unresponsiveInterrupt: () =>
    createFake(
      fake({
        events: [SESSION_OPEN],
        block: true,
        result: COMPLETED_OPEN,
        interruptResult: LOST_INTERRUPTION,
      }),
    ),
  lostCompletion: () =>
    createFake(fake({ events: [SESSION_OPEN], result: LOST_COMPLETION })),
  resumeAcknowledged: () =>
    createFake(
      fake(
        { events: [SESSION_OPEN], block: true, result: COMPLETED_OPEN },
        { events: [SESSION_OPEN], result: COMPLETED_OPEN },
      ),
    ),
  resumeUnacknowledged: () =>
    createFake(
      fake(
        { events: [SESSION_OPEN], block: true, result: COMPLETED_OPEN },
        { result: FAILED_RECOVERY },
      ),
    ),
  loadWithReplay: () => {
    const said: TurnEvent = { kind: "assistant-content", content: "earlier" };
    const read: TurnEvent = {
      kind: "tool-activity",
      activity: { tool: "Read", phase: "completed", summary: "read a file" },
    };
    const progress: TurnEvent = {
      kind: "assistant-content",
      content: "continuing after reattach",
    };
    return {
      // Turn 1 emits the history then blocks; on resume the Harness "re-sends"
      // the last entry (`read`) alongside its new progress, and the fake must
      // reconcile that repeat into the one replayed copy.
      factory: createFake(
        fake(
          {
            events: [SESSION_OPEN, said, read],
            block: true,
            result: COMPLETED_OPEN,
          },
          { events: [read, SESSION_OPEN, progress], result: COMPLETED_OPEN },
        ),
      ),
      history: [said, read],
      repeated: read,
      live: [SESSION_OPEN, progress],
      barrier: REPLAY_BARRIER,
    };
  },
};

runConformanceSuite(scenarios, test);

// Every declaration kind and defaults outcome the Interface admits (#341), so the
// shared declaration cases cover what neither native Adapter scripts on demand.
function declaring(
  label: string,
  declaration: ModelDeclaration,
  defaults: HarnessDefaults,
): ModelDeclarationScenarios {
  return {
    label,
    baseline: () =>
      createFake({
        profile: profile({
          modelSelection: {
            at: "launch",
            declaration,
            evidence: "fake declares what its script names",
          },
        }),
        turns: [],
        defaults,
      }),
    expectedDeclaration:
      declaration.kind === "free-text"
        ? declaration
        : declaration.kind === "suggested"
          ? {
              kind: "suggested",
              includes: declaration.models,
              efforts: declaration.efforts,
            }
          : { kind: "list", includes: declaration.models },
    expectedDefaults: defaults,
  };
}

const FAKE_LATEST: ModelEntry = {
  model: "fake-latest",
  label: "Fake (latest)",
  efforts: FIVE_EFFORTS,
};

for (const scenario of [
  declaring(
    "fake suggested, fallback",
    { kind: "suggested", models: [FAKE_LATEST], efforts: FIVE_EFFORTS },
    {
      kind: "fallback",
      choice: { model: "fake-latest", effort: "medium" },
      reason: "The fake Harness did not report its settings.",
    },
  ),
  declaring(
    "fake free-text, locked effort",
    { kind: "free-text", efforts: FIVE_EFFORTS },
    {
      kind: "reported",
      choice: { model: "any-typed-model", effort: "xhigh" },
      effortLock: { effort: "xhigh", source: "FAKE_EFFORT_LEVEL=xhigh" },
    },
  ),
  declaring(
    "fake list, default without effort",
    { kind: "list", models: [FAKE_MODEL_A, FAKE_MODEL_B] },
    { kind: "reported", choice: { model: "fake-model-b" } },
  ),
  declaring(
    "fake list, nothing to fall back to",
    { kind: "list", models: [FAKE_MODEL_A] },
    { kind: "unavailable", reason: "The fake Harness names no default model." },
  ),
]) {
  runModelDeclarationCases(scenario, test);
}
const STEER_PROFILE = profile({
  steer: {
    available: true,
    evidence: "fake exposes guidance at scripted boundaries",
  },
});
runPendingSteerCases(
  {
    label: "fake-steer",
    pendingTurn: () =>
      createFake({
        profile: STEER_PROFILE,
        turns: [
          { events: [SESSION_OPEN], block: true, result: COMPLETED_OPEN },
        ],
      }),
  },
  test,
);
runStretchingSteerCases(
  {
    label: "fake-steer",
    stretchingTurn: () => {
      let boundary!: () => void;
      let deliver!: () => void;
      const finish = new Promise<void>((resolve) => {
        boundary = resolve;
      });
      const steerBoundary = new Promise<void>((resolve) => {
        deliver = resolve;
      });
      return {
        adapter: createFake({
          profile: STEER_PROFILE,
          turns: [
            {
              events: [SESSION_OPEN],
              block: true,
              finish,
              steerBoundary,
              result: COMPLETED_OPEN,
            },
          ],
        }),
        boundary,
        deliver,
      };
    },
  },
  test,
);
