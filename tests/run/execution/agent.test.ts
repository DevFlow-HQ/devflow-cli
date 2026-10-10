import {
  openAgentAttemptTurn,
  waitingAgentTurn,
} from "../../../src/run/store/store.js";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import {
  translateCause,
  type HarnessProfile,
  type PreparedHarness,
  type TurnRequest,
  type TurnResult,
} from "../../../src/harness/harness.js";
import {
  executeRouting,
  SIGNAL_ABORT,
  type AssetResolver,
  type ExecutionDeps,
  type ExecutionEvent,
  type ExecutionObserver,
} from "../../../src/run/execution/execution.js";
import type {
  RunOwner,
  TurnFact,
  TurnRecord,
} from "../../../src/run/store/store.js";
import type {
  AgentStep,
  ArtifactType,
  AssetKind,
  Platform,
} from "../../../src/workflow/workflow.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeTurnScript,
} from "../../harness/fake-adapter.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { createFakeProcess } from "../../process/fake-adapter.js";
import { openFakeRunGroup as openRunGroup } from "../store/fake-git-process.js";

const AT = new Date("2026-09-18T08:00:00.000Z");
const HOST: Platform = process.platform === "win32" ? "windows" : "linux";
const SESSION = "shared-session";
const executionProcess = createFakeProcess({});

const PROFILE_OVERRIDES = {
  harness: "fake",
  executable: "fake-harness",
  platform: HOST,
  recovery: { mode: "native-reattach", evidence: "fake resumes by id" },
  interruption: { mode: "process-only", evidence: "fake stops its process" },
  approvals: { available: true, evidence: "fake approvals" },
  clarifications: { available: false, evidence: "fake has no questions" },
  steer: { available: false, evidence: "fake has no steer" },
  modelSelection: { at: "unavailable", evidence: "fake selects no model" },
  modelObservation: {
    available: true,
    evidence: "fake observes its own model",
  },
  recoveryCoordinate: {
    timing: "before-submission",
    evidence: "fake records before submission",
  },
  skillDelivery: {
    mode: "plain-path",
    evidence: "fake reads a SKILL.md path",
  },
  fileDelivery: {
    mode: "plain-path",
    evidence: "fake reads absolute paths",
  },
} satisfies Partial<HarnessProfile>;

interface Fixture {
  readonly owner: RunOwner;
  readonly workspace: string;
  /** The Run's canonical state as the Store records it right now. */
  readonly state: () => string;
}

function fixture(
  t: TestContext,
  launch: Readonly<Record<string, string>> = {},
): Fixture {
  const workspace = makeTempDir("secant-agent-workspace-");
  const group = openRunGroup(makeTempDir("secant-agent-home-"), workspace);
  t.after(() => group.close());
  const created = group.createRun({
    operationId: "op-1",
    bundleSnapshotDigest: "sha256:agent",
    launch,
    at: AT,
  });
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  const state = () => {
    const read = group.readRun(created.runId);
    assert.ok(read.ok);
    return read.run.state;
  };
  return { owner, workspace, state };
}

function promptAssets(
  workspace: string,
  prompt: string,
): {
  readonly resolveAsset: AssetResolver;
  readonly promptPath: string;
  readonly skillDirectory: string;
} {
  const promptPath = join(workspace, "prompt.md");
  writeFileSync(promptPath, prompt);
  const skillDirectory = join(workspace, "skill");
  mkdirSync(skillDirectory);
  writeFileSync(join(skillDirectory, "SKILL.md"), "Use the fake skill.\n");
  const paths = new Map([
    ["prompt.md", promptPath],
    ["skill", skillDirectory],
  ]);
  return {
    resolveAsset: (assetPath) => paths.get(assetPath),
    promptPath,
    skillDirectory,
  };
}

function agentStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: "agent",
    kind: "agent",
    prompt: { asset: "prompt.md" },
    session: SESSION,
    retry: 0,
    ...overrides,
  };
}

async function preparedHarness(
  harnessProfile: HarnessProfile,
  turns: readonly FakeTurnScript[],
): Promise<PreparedHarness> {
  const result = await createFake({ profile: harnessProfile, turns })().prepare(
    {
      workspace: "/unused",
    },
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  return result.harness;
}

interface ResultCase {
  readonly result: TurnResult;
  readonly expectedAttempts: readonly (
    "succeeded" | "failed" | "cancelled" | "indeterminate"
  )[];
  readonly expectedAvailability: "open" | "detached" | "unusable";
  readonly expectedRunOutcome: "succeeded" | "failed" | "blocked" | "halted";
  readonly starts: number;
}

const RESULT_CASES = {
  "not-started": {
    result: {
      kind: "not-started",
      detail: {
        failure: {
          phase: "launch",
          category: "spawn-error",
          possibleEffects: "none",
          diagnostics: "the fake executable did not launch",
        },
      },
    },
    expectedAttempts: ["failed", "failed", "failed"],
    expectedAvailability: "open",
    expectedRunOutcome: "failed",
    starts: 3,
  },
  completed: {
    result: {
      kind: "completed",
      detail: {
        effectiveModel: { known: true, model: "fake-model" },
        session: { state: "open" },
      },
    },
    expectedAttempts: ["succeeded"],
    expectedAvailability: "open",
    expectedRunOutcome: "succeeded",
    starts: 1,
  },
  failed: {
    result: {
      kind: "failed",
      detail: {
        failure: {
          phase: "turn",
          category: "native-failure",
          possibleEffects: "possible",
          diagnostics: "the fake Turn failed",
        },
        effectiveModel: { known: false },
        session: {
          state: "detached",
          coordinate: { opaque: "failed-coordinate" },
        },
      },
    },
    expectedAttempts: ["failed"],
    expectedAvailability: "detached",
    expectedRunOutcome: "failed",
    starts: 1,
  },
  interrupted: {
    result: {
      kind: "interrupted",
      detail: {
        interruption: {
          mode: "process-only",
          evidence: "the fake process stopped",
        },
        session: {
          state: "detached",
          coordinate: { opaque: "interrupted-coordinate" },
        },
      },
    },
    // An Interrupt ends only the Turn: the Attempt stays open and the Run waits for
    // the person's follow-up (#354, ADR 0035).
    expectedAttempts: [],
    expectedAvailability: "detached",
    expectedRunOutcome: "blocked",
    starts: 1,
  },
  lost: {
    result: {
      kind: "lost",
      detail: {
        unknown: "completion",
        lastObservation: "the fake transport closed",
        session: {
          state: "unusable",
          reason: "the fake Session cannot recover",
        },
      },
    },
    expectedAttempts: ["indeterminate"],
    expectedAvailability: "unusable",
    expectedRunOutcome: "halted",
    starts: 1,
  },
} as const satisfies Record<TurnResult["kind"], ResultCase>;

for (const [kind, scenario] of Object.entries(RESULT_CASES)) {
  test(`m12-harness-run-test-helpers: an Agent Turn result ${kind} maps to its Attempt and Session availability`, async (t) => {
    const f = fixture(t);
    const assets = promptAssets(f.workspace, "Do the work.\n");
    const turns = Array.from({ length: scenario.starts }, () => ({
      result: scenario.result,
    }));
    const prepared = await preparedHarness(
      fakeHarnessProfile(PROFILE_OVERRIDES),
      turns,
    );
    t.after(() => prepared.close());
    let starts = 0;
    const availabilityBeforeStarts: string[] = [];
    const counted: PreparedHarness = {
      profile: prepared.profile,
      readDefaults: () => prepared.readDefaults(),
      startTurn(request) {
        starts++;
        const recorded = f.owner
          .harnessSessions()
          .find((session) => session.session === SESSION);
        if (recorded !== undefined) {
          availabilityBeforeStarts.push(recorded.availability);
        }
        return prepared.startTurn(request);
      },
      close: () => prepared.close(),
    };

    const report = await executeRouting(
      [agentStep({ retry: kind === "not-started" ? 2 : 0 })],
      {
        owner: f.owner,
        platform: HOST,
        resolveAsset: assets.resolveAsset,
        now: () => AT,
        process: executionProcess,
        inputTypes: {},
        harness: {
          inputRules: [],
          prepared: counted,
          assetKinds: { "prompt.md": "prompt" },
        },
      },
    );

    assert.equal(report.outcome, scenario.expectedRunOutcome);
    assert.deepEqual(
      f.owner.attemptLog().map((attempt) => attempt.outcome),
      scenario.expectedAttempts,
    );
    assert.equal(starts, scenario.starts);
    assert.equal(f.owner.turns().length, scenario.starts);
    assert.ok(
      availabilityBeforeStarts.every(
        (availability) => availability !== "unusable",
      ),
    );
    const session = f.owner
      .harnessSessions()
      .find((candidate) => candidate.session === SESSION);
    assert.equal(session?.availability, scenario.expectedAvailability);
  });
}

// An Entry Turn is sent once: a later walk finds the admitted Entry Turn in history
// and rests `blocked` for the human without re-sending it (#212, A24). An interrupted
// Entry Turn returns the Step to waiting with no Attempt (#353, ADR 0035); a lost one,
// or one a process signal stopped, rests the Run `halted` instead (ADR 0019).
const ENTRY_CASES = {
  interrupted: {
    turn: { result: RESULT_CASES.interrupted.result },
    signal: false,
    firstWalk: "blocked",
  },
  lost: {
    turn: { result: RESULT_CASES.lost.result },
    signal: false,
    firstWalk: "halted",
  },
  "signal-stopped": {
    turn: {
      block: true,
      result: RESULT_CASES.completed.result,
      interruptResult: RESULT_CASES.interrupted.result,
    },
    signal: true,
    firstWalk: "halted",
  },
} as const satisfies Record<
  string,
  {
    turn: FakeTurnScript;
    signal: boolean;
    firstWalk: "blocked" | "halted";
  }
>;

for (const [name, scenario] of Object.entries(ENTRY_CASES)) {
  test(`Entry Turn ${name}: the Run rests ${scenario.firstWalk} with no Attempt, and a later walk never re-sends it (#212, #353)`, async (t) => {
    const f = fixture(t);
    const assets = promptAssets(f.workspace, "Grill the idea.\n");
    const prepared = await preparedHarness(
      fakeHarnessProfile(PROFILE_OVERRIDES),
      [scenario.turn],
    );
    t.after(() => prepared.close());
    const controller = new AbortController();
    let starts = 0;
    const counted: PreparedHarness = {
      profile: prepared.profile,
      readDefaults: () => prepared.readDefaults(),
      startTurn(request) {
        starts++;
        const turn = prepared.startTurn(request);
        // The signal reaches the live Turn, which settles `interrupted` (ADR 0019).
        if (scenario.signal) controller.abort(SIGNAL_ABORT);
        return turn;
      },
      close: () => prepared.close(),
    };
    const walk = (cancelSignal?: AbortSignal) =>
      executeRouting(
        [agentStep({ kind: "interactive-agent", entryTurn: true })],
        {
          owner: f.owner,
          platform: HOST,
          resolveAsset: assets.resolveAsset,
          now: () => AT,
          process: executionProcess,
          inputTypes: {},
          harness: {
            inputRules: [],
            prepared: counted,
            assetKinds: { "prompt.md": "prompt" },
          },
          ...(cancelSignal !== undefined ? { cancelSignal } : {}),
        },
      );

    assert.deepEqual(await walk(controller.signal), {
      outcome: scenario.firstWalk,
    });
    assert.equal(f.state(), scenario.firstWalk);
    assert.deepEqual(f.owner.attemptLog(), []);
    assert.equal(starts, 1);
    assert.deepEqual(
      f.owner.turns().map((turn) => turn.resultKind),
      [scenario.signal ? "interrupted" : scenario.turn.result.kind],
    );

    assert.deepEqual(await walk(), { outcome: "blocked" });
    assert.equal(f.state(), "blocked");
    assert.deepEqual(f.owner.attemptLog(), []);
    assert.equal(starts, 1);
    assert.deepEqual(
      f.owner.turns().map((turn) => [turn.turnId, turn.origin]),
      [["0.0:agent#entry", "managed"]],
    );
  });
}

// A crash mid-Agent-Turn leaves the Turn admitted; startup reconciliation settles it
// `lost` behind a UUID marker the resume cursor skips, so the resumed walk re-mints
// the same Attempt id. Its Turn joins that Attempt under the next id in order rather
// than colliding with the abandoned row (#352).
test("a Turn resumed into an open Agent Attempt takes the next id in order, and the open-Attempt read returns its latest Turn (#352)", async (t) => {
  const home = makeTempDir("secant-agent-home-");
  const workspace = makeTempDir("secant-agent-workspace-");
  const assets = promptAssets(workspace, "Do the work.\n");
  const walk = (
    owner: RunOwner,
    prepared: PreparedHarness,
    observe: ExecutionObserver,
  ) =>
    executeRouting([agentStep()], {
      owner,
      platform: HOST,
      resolveAsset: assets.resolveAsset,
      now: () => AT,
      process: executionProcess,
      inputTypes: {},
      harness: {
        prepared,
        inputRules: [],
        assetKinds: { "prompt.md": "prompt" },
      },
      observe,
    });

  // The first walk admits its Turn, then the process dies mid-Turn: the Turn blocks,
  // is never settled, and the group closes without ending the Run.
  const crashedGroup = openRunGroup(home, workspace);
  const created = crashedGroup.createRun({
    operationId: "op-1",
    bundleSnapshotDigest: "sha256:agent",
    launch: {},
    at: AT,
  });
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const crashedOwner = crashedGroup.acquireRun(created.runId);
  assert.ok(crashedOwner);
  const crashed = await preparedHarness(fakeHarnessProfile(PROFILE_OVERRIDES), [
    { block: true, result: RESULT_CASES.completed.result },
  ]);
  let admitted: () => void = () => undefined;
  const firstAdmission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  // A dead process never settles its Turn or closes its Harness, so this walk
  // stays pending for good.
  void walk(crashedOwner, crashed, (event) => {
    if (event.kind === "turn-start") admitted();
  });
  await firstAdmission;
  crashedOwner.close();
  crashedGroup.close();

  const group = openRunGroup(home, workspace);
  t.after(() => group.close());
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  const abandoned = openAgentAttemptTurn(owner);
  assert.equal(abandoned?.attemptId, "0.0:agent");
  assert.equal(abandoned.turnId, "0.0:agent#turn-1");
  assert.equal(abandoned.resultKind, "lost");

  const resumed = await preparedHarness(fakeHarnessProfile(PROFILE_OVERRIDES), [
    { result: RESULT_CASES.completed.result },
  ]);
  t.after(() => resumed.close());
  let whileAdmitted: TurnRecord | undefined;
  const report = await walk(owner, resumed, (event) => {
    if (event.kind === "turn-start") {
      whileAdmitted = openAgentAttemptTurn(owner);
    }
  });

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(whileAdmitted?.attemptId, "0.0:agent");
  assert.equal(whileAdmitted.turnId, "0.0:agent#turn-2");
  assert.equal(whileAdmitted.resultKind, undefined);
  assert.deepEqual(
    owner.turns().map((turn) => [turn.turnId, turn.attemptId, turn.resultKind]),
    [
      ["0.0:agent#turn-1", "0.0:agent", "lost"],
      ["0.0:agent#turn-2", "0.0:agent", "completed"],
    ],
  );
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["indeterminate", "succeeded"],
  );
  assert.equal(owner.attemptLog()[1]?.attemptId, "0.0:agent");
  // The published Attempt is closed, so no open Attempt remains.
  assert.equal(openAgentAttemptTurn(owner), undefined);
});

// --- An Interrupt holds the Agent Attempt open (#354) -----------------------
//
// A Port Interrupt settles the Turn `interrupted` with the Run's cancel signal
// untouched, which is how these walks drive it: the fake Turn settles
// `interrupted`. The follow-up rides `ExecutionDeps.followUp` into a re-walk.

const FAILED_TURN: TurnResult = {
  kind: "failed",
  detail: {
    failure: {
      phase: "turn",
      category: "native-failure",
      possibleEffects: "possible",
      diagnostics: "the follow-up failed",
    },
    effectiveModel: { known: false },
    session: { state: "detached", coordinate: { opaque: "failed-coordinate" } },
  },
};

const FOLLOW_UP_TEXT = "Keep going, but skip the docs.";

/** A held Harness whose Turns run in script order, recording each request; the
 *  `onStart` hook runs as a Turn starts (to write a receipt, or abort a signal). */
async function recordingHarness(
  t: TestContext,
  turns: readonly FakeTurnScript[],
  onStart?: (request: TurnRequest, index: number) => void,
): Promise<{
  readonly prepared: PreparedHarness;
  readonly requests: readonly TurnRequest[];
}> {
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    turns,
  );
  t.after(() => prepared.close());
  const requests: TurnRequest[] = [];
  return {
    requests,
    prepared: {
      profile: prepared.profile,
      readDefaults: () => prepared.readDefaults(),
      startTurn(request) {
        requests.push(request);
        onStart?.(request, requests.length - 1);
        return prepared.startTurn(request);
      },
      close: () => prepared.close(),
    },
  };
}

function walkAgent(
  f: Fixture,
  step: AgentStep,
  prepared: PreparedHarness,
  extra: Partial<
    Pick<ExecutionDeps, "followUp" | "cancelSignal" | "observe">
  > = {},
) {
  const assets = promptAssets(
    makeTempDir("secant-agent-assets-"),
    "Do the work.\n",
  );
  return executeRouting([step], {
    owner: f.owner,
    platform: HOST,
    resolveAsset: assets.resolveAsset,
    now: () => AT,
    process: executionProcess,
    inputTypes: {},
    harness: {
      prepared,
      inputRules: [],
      assetKinds: { "prompt.md": "prompt" },
    },
    ...extra,
  });
}

/** The receipt path a rendered prompt names for a declared output. */
function receiptPath(request: TurnRequest, name: string): string {
  const match = new RegExp(
    `"${name}" as UTF-8 text to (.+) before you finish`,
  ).exec(request.input.text);
  assert.ok(match, request.input.text);
  return match[1]!;
}

function turnRows(owner: RunOwner) {
  return owner
    .turns()
    .map((turn) => [turn.turnId, turn.origin, turn.kind, turn.resultKind]);
}

test("an interrupted Agent Turn holds its Attempt open and the Run blocked, and a walk without its follow-up sends nothing (#354)", async (t) => {
  const f = fixture(t);
  const { prepared, requests } = await recordingHarness(t, [
    { result: RESULT_CASES.interrupted.result },
  ]);
  const events: ExecutionEvent[] = [];

  assert.deepEqual(
    await walkAgent(f, agentStep(), prepared, {
      observe: (event) => events.push(event),
    }),
    { outcome: "blocked" },
  );

  assert.equal(f.state(), "blocked");
  assert.deepEqual(f.owner.attemptLog(), []);
  assert.equal(waitingAgentTurn(f.owner)?.turnId, "0.0:agent#turn-1");
  assert.deepEqual(
    events
      .filter((event) => event.kind.startsWith("attempt-"))
      .map((event) => event.kind),
    ["attempt-start", "attempt-pause"],
  );
  // No follow-up, or one naming another Turn, waits again: the prompt is never
  // re-sent as a managed Turn and no retry is counted.
  for (const followUp of [
    undefined,
    { turnId: "0.0:agent#turn-0", text: FOLLOW_UP_TEXT },
  ]) {
    assert.deepEqual(
      await walkAgent(f, agentStep(), prepared, {
        ...(followUp !== undefined ? { followUp } : {}),
      }),
      { outcome: "blocked" },
    );
  }
  assert.equal(requests.length, 1);
  assert.deepEqual(f.owner.attemptLog(), []);
  assert.equal(waitingAgentTurn(f.owner)?.turnId, "0.0:agent#turn-1");
});

test("the follow-up is a human Turn in the same Session and Attempt; a clean one keeps and validates the receipts and advances (#354)", async (t) => {
  const f = fixture(t);
  const step = agentStep({
    session: "fresh",
    produces: [{ name: "summary", type: "text" }],
  });
  const { prepared, requests } = await recordingHarness(
    t,
    [
      { result: RESULT_CASES.interrupted.result },
      { result: RESULT_CASES.completed.result },
    ],
    (request, index) => {
      // The agent wrote its receipt during the interrupted Turn.
      if (index === 0) writeFileSync(receiptPath(request, "summary"), "done");
    },
  );
  assert.deepEqual(await walkAgent(f, step, prepared), { outcome: "blocked" });

  const report = await walkAgent(f, step, prepared, {
    followUp: { turnId: "0.0:agent#turn-1", text: FOLLOW_UP_TEXT },
  });

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.deepEqual(turnRows(f.owner), [
    ["0.0:agent#turn-1", "managed", "agent", "interrupted"],
    ["0.0:agent#turn-2", "human", "agent", "completed"],
  ]);
  // The human's text is sent verbatim, in the Attempt's own fresh Session.
  assert.equal(requests[1]?.input.text, FOLLOW_UP_TEXT);
  assert.equal(requests[1]?.origin, "human");
  assert.equal(requests[1]?.session, requests[0]?.session);
  assert.equal(requests[0]?.session, "fresh-0.0:agent");
  assert.deepEqual(
    f.owner.attemptLog().map((entry) => [entry.attemptId, entry.outcome]),
    [["0.0:agent", "succeeded"]],
  );
  const version = f.owner.currentVersion("summary");
  assert.ok(version !== undefined);
  assert.equal(
    new TextDecoder().decode(f.owner.readArtifact(version, "summary")),
    "done",
  );
  assert.equal(waitingAgentTurn(f.owner), undefined);
});

test("a failed follow-up takes the ordinary retry, whose fresh Attempt re-sends the prompt (#354)", async (t) => {
  const f = fixture(t);
  const step = agentStep({ retry: 1 });
  const { prepared, requests } = await recordingHarness(t, [
    { result: RESULT_CASES.interrupted.result },
    { result: FAILED_TURN },
    { result: RESULT_CASES.completed.result },
  ]);
  assert.deepEqual(await walkAgent(f, step, prepared), { outcome: "blocked" });

  // The retry budget counts within one walk, as resume's does: the follow-up's
  // re-walk starts a fresh budget, so `retry: 1` still buys one more Attempt.
  const report = await walkAgent(f, step, prepared, {
    followUp: { turnId: "0.0:agent#turn-1", text: FOLLOW_UP_TEXT },
  });

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.deepEqual(
    f.owner.attemptLog().map((entry) => [entry.attemptId, entry.outcome]),
    [
      ["0.0:agent", "failed"],
      ["0.1:agent", "succeeded"],
    ],
  );
  assert.deepEqual(turnRows(f.owner), [
    ["0.0:agent#turn-1", "managed", "agent", "interrupted"],
    ["0.0:agent#turn-2", "human", "agent", "failed"],
    ["0.1:agent#turn-1", "managed", "agent", "completed"],
  ]);
  assert.equal(requests[2]?.input.text, "Do the work.\n");
});

test("a second Interrupt holds the Step again, and a lost follow-up halts (#354)", async (t) => {
  const f = fixture(t);
  const { prepared } = await recordingHarness(t, [
    { result: RESULT_CASES.interrupted.result },
    { result: RESULT_CASES.interrupted.result },
    { result: RESULT_CASES.lost.result },
  ]);
  assert.deepEqual(await walkAgent(f, agentStep(), prepared), {
    outcome: "blocked",
  });

  assert.deepEqual(
    await walkAgent(f, agentStep(), prepared, {
      followUp: { turnId: "0.0:agent#turn-1", text: "first correction" },
    }),
    { outcome: "blocked" },
  );
  assert.deepEqual(f.owner.attemptLog(), []);
  assert.equal(waitingAgentTurn(f.owner)?.turnId, "0.0:agent#turn-2");

  assert.deepEqual(
    await walkAgent(f, agentStep(), prepared, {
      followUp: { turnId: "0.0:agent#turn-2", text: "second correction" },
    }),
    { outcome: "halted" },
  );
  assert.equal(f.state(), "halted");
  assert.deepEqual(
    f.owner.attemptLog().map((entry) => entry.outcome),
    ["indeterminate"],
  );
  assert.deepEqual(
    turnRows(f.owner).map(([turnId, origin, , result]) => [
      turnId,
      origin,
      result,
    ]),
    [
      ["0.0:agent#turn-1", "managed", "interrupted"],
      ["0.0:agent#turn-2", "human", "interrupted"],
      ["0.0:agent#turn-3", "human", "lost"],
    ],
  );
});

test("a process signal stopping an Agent Turn still cancels the Attempt and halts (#354, ADR 0019)", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const { prepared } = await recordingHarness(
    t,
    [
      {
        block: true,
        result: RESULT_CASES.completed.result,
        interruptResult: RESULT_CASES.interrupted.result,
      },
    ],
    () => controller.abort(SIGNAL_ABORT),
  );

  assert.deepEqual(
    await walkAgent(f, agentStep(), prepared, {
      cancelSignal: controller.signal,
    }),
    { outcome: "halted" },
  );

  assert.equal(f.state(), "halted");
  assert.deepEqual(
    f.owner.attemptLog().map((entry) => entry.outcome),
    ["cancelled"],
  );
  assert.equal(waitingAgentTurn(f.owner), undefined);
});

// A Run written before #352 holds its Agent Turn under the one-per-Attempt id. A Turn
// joining that Attempt counts the old row, never reusing its id (#352).
test("a Turn joining an Attempt that holds a pre-change `#turn` row takes the next id (#352)", async (t) => {
  const f = fixture(t);
  const assets = promptAssets(f.workspace, "Do the work.\n");
  assert.deepEqual(
    f.owner.admitTurn({
      turnId: "0.0:agent#turn",
      attemptId: "0.0:agent",
      session: SESSION,
      origin: "managed",
      kind: "agent",
      input: "Do the work.\n",
      recoveryCoordinate: "native-1",
      harness: "fake",
      at: AT,
    }),
    { ok: true },
  );
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: RESULT_CASES.completed.result }],
  );
  t.after(() => prepared.close());

  const report = await executeRouting([agentStep()], {
    owner: f.owner,
    platform: HOST,
    resolveAsset: assets.resolveAsset,
    now: () => AT,
    process: executionProcess,
    inputTypes: {},
    harness: {
      prepared,
      inputRules: [],
      assetKinds: { "prompt.md": "prompt" },
    },
  });

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.deepEqual(
    f.owner.turns().map((turn) => [turn.turnId, turn.resultKind]),
    [
      ["0.0:agent#turn", undefined],
      ["0.0:agent#turn-2", "completed"],
    ],
  );
});

for (const delivery of ["skill", "file"] as const) {
  test(`a non-plain-path ${delivery} delivery is a typed failure before a Turn starts`, async (t) => {
    const launch: Readonly<Record<string, string>> =
      delivery === "file" ? { report: "reports/input.md" } : {};
    const f = fixture(t, launch);
    const prompt =
      delivery === "file" ? "Read {{artifact:report}}.\n" : "Use the skill.\n";
    const assets = promptAssets(f.workspace, prompt);
    const harnessProfile = fakeHarnessProfile({
      ...PROFILE_OVERRIDES,
      ...(delivery === "skill"
        ? {
            skillDelivery: {
              mode: "native",
              evidence: "the fake accepts native skills only",
            },
          }
        : {
            fileDelivery: {
              mode: "native",
              evidence: "the fake accepts native files only",
            },
          }),
    });
    const prepared = await preparedHarness(harnessProfile, []);
    t.after(() => prepared.close());
    let starts = 0;
    const counted: PreparedHarness = {
      profile: prepared.profile,
      readDefaults: () => prepared.readDefaults(),
      startTurn(request) {
        starts++;
        return prepared.startTurn(request);
      },
      close: () => prepared.close(),
    };
    const inputTypes: Readonly<Record<string, ArtifactType>> =
      delivery === "file" ? { report: "file" } : {};
    const assetKinds: Readonly<Record<string, AssetKind>> = {
      "prompt.md": "prompt",
      skill: "skill",
    };

    const report = await executeRouting(
      [
        agentStep({
          uses: delivery === "skill" ? [{ asset: "skill" }] : [],
        }),
      ],
      {
        owner: f.owner,
        platform: HOST,
        resolveAsset: assets.resolveAsset,
        now: () => AT,
        process: executionProcess,
        inputTypes,
        harness: {
          inputRules: [],
          prepared: counted,
          assetKinds,
        },
      },
    );

    assert.deepEqual(report, { outcome: "failed" });
    assert.deepEqual(
      f.owner.attemptLog().map((attempt) => attempt.outcome),
      ["failed"],
    );
    assert.equal(starts, 0);
    assert.deepEqual(f.owner.turns(), []);
  });
}

test("plain-path delivery keeps the rendered prompt byte-identical", async (t) => {
  const f = fixture(t, { report: "reports/input.md" });
  const assets = promptAssets(
    f.workspace,
    "Review {{artifact:report}} before acting.\n",
  );
  const completed = RESULT_CASES.completed.result;
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: completed }],
  );
  t.after(() => prepared.close());

  await executeRouting(
    [
      agentStep({
        uses: [{ asset: "skill" }],
      }),
    ],
    {
      owner: f.owner,
      platform: HOST,
      resolveAsset: assets.resolveAsset,
      now: () => AT,
      process: executionProcess,
      inputTypes: { report: "file" },
      harness: {
        prepared,
        inputRules: [],
        assetKinds: { "prompt.md": "prompt", skill: "skill" },
      },
    },
  );

  assert.equal(
    f.owner.transcript()[0]?.content,
    `Review ${join(f.workspace, "reports", "input.md")} before acting.\n\n\nRead the skill instructions at ${join(assets.skillDirectory, "SKILL.md")} before you begin.`,
  );
});

// --- Required text output receipts (#215) ----------------------------------

const RECEIPT_LINE =
  /Write the required output "([^"]+)" as UTF-8 text to (.+) before you finish;/g;

/** The receipt paths execution appended to a rendered prompt, by output name. */
function receiptPaths(input: string): ReadonlyMap<string, string> {
  return new Map(
    [...input.matchAll(RECEIPT_LINE)].map((match) => [match[1]!, match[2]!]),
  );
}

/** Wrap a prepared fake so each Turn plays the agent: `write` decides, per Turn,
 *  what to leave at the receipt paths the prompt named (nothing when undefined). */
function receiptWriting(
  prepared: PreparedHarness,
  write: (paths: ReadonlyMap<string, string>, turn: number) => void | undefined,
): { harness: PreparedHarness; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    harness: {
      profile: prepared.profile,
      readDefaults: () => prepared.readDefaults(),
      startTurn(request) {
        inputs.push(request.input.text);
        write(receiptPaths(request.input.text), inputs.length - 1);
        return prepared.startTurn(request);
      },
      close: () => prepared.close(),
    },
  };
}

const COMPLETED: TurnResult = RESULT_CASES.completed.result;

function producingStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return agentStep({
    produces: [{ name: "spec-ref", type: "text" }],
    ...overrides,
  });
}

function executeWith(
  f: Fixture,
  step: AgentStep,
  harness: PreparedHarness,
): ReturnType<typeof executeRouting> {
  const assets = promptAssets(f.workspace, "Publish the spec.\n");
  return executeRouting([step], {
    owner: f.owner,
    platform: HOST,
    resolveAsset: assets.resolveAsset,
    now: () => AT,
    process: executionProcess,
    inputTypes: {},
    harness: {
      inputRules: [],
      prepared: harness,
      assetKinds: { "prompt.md": "prompt" },
    },
  });
}

function boundText(owner: RunOwner, name: string): string | undefined {
  const versionId = owner.currentVersion(name);
  if (versionId === undefined) return undefined;
  const bytes = owner.readArtifact(versionId, name);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/** Bind an earlier version of `spec-ref`, as a previous Step would have. */
function bindEarlier(owner: RunOwner, text: string): string {
  const published = owner.publishAttempt({
    attemptId: "earlier",
    outcome: "succeeded",
    required: [{ name: "spec-ref", type: "text" }],
    outputs: [
      {
        name: "spec-ref",
        type: "text",
        content: new TextEncoder().encode(text),
      },
    ],
    at: AT,
  });
  assert.ok(published.ok && published.versionId);
  return published.versionId;
}

test("a completed Turn's validated receipt is published as the declared text output", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: COMPLETED }],
  );
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, (paths) => {
    const path = paths.get("spec-ref");
    assert.ok(path, "the prompt names the receipt path");
    writeFileSync(path, "  https://github.com/example/repo/issues/12\n");
  });

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.deepEqual(
    f.owner.attemptLog().map((attempt) => attempt.outcome),
    ["succeeded"],
  );
  // The reference is bound verbatim, trimmed of the surrounding whitespace a file
  // write leaves, so a later prompt slot substitutes it cleanly.
  assert.equal(
    boundText(f.owner, "spec-ref"),
    "https://github.com/example/repo/issues/12",
  );
  // The receipt path is an absolute, Run-owned location outside the Workspace.
  const path = receiptPaths(agent.inputs[0]!).get("spec-ref")!;
  assert.ok(isAbsolute(path));
  assert.ok(relative(f.workspace, path).startsWith(".."));
  // The instruction is appended after the authored prompt; the prompt stays first.
  assert.ok(agent.inputs[0]!.startsWith("Publish the spec.\n"));
});

test("a completed Turn with no receipt fails the Step and leaves the earlier binding intact", async (t) => {
  const f = fixture(t);
  const earlier = bindEarlier(f.owner, "LOCAL:spec.md");
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: COMPLETED }],
  );
  t.after(() => prepared.close());
  // The agent's prose may claim publication; only the receipt file counts.
  const agent = receiptWriting(prepared, () => undefined);

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "failed" });
  assert.deepEqual(
    f.owner.attemptLog().map((attempt) => attempt.outcome),
    ["succeeded", "failed"],
  );
  assert.equal(f.owner.currentVersion("spec-ref"), earlier);
  assert.equal(boundText(f.owner, "spec-ref"), "LOCAL:spec.md");
  // The Turn itself completed: its durable record says so, distinct from the Step.
  assert.equal(f.owner.turns()[0]?.resultKind, "completed");
});

const INVALID_RECEIPTS: Readonly<Record<string, (path: string) => void>> = {
  "an empty receipt": (path) => writeFileSync(path, ""),
  "a whitespace-only receipt": (path) => writeFileSync(path, " \n\t\n"),
  "a receipt that is not UTF-8": (path) =>
    writeFileSync(path, Uint8Array.from([0x68, 0xff, 0xfe, 0x69])),
  "an oversized receipt": (path) =>
    writeFileSync(path, "x".repeat(64 * 1024 + 1)),
  "a directory in place of the receipt file": (path) => mkdirSync(path),
};

for (const [title, write] of Object.entries(INVALID_RECEIPTS)) {
  test(`${title} fails the Step and moves no binding`, async (t) => {
    const f = fixture(t);
    const earlier = bindEarlier(f.owner, "LOCAL:spec.md");
    const prepared = await preparedHarness(
      fakeHarnessProfile(PROFILE_OVERRIDES),
      [{ result: COMPLETED }],
    );
    t.after(() => prepared.close());
    const agent = receiptWriting(prepared, (paths) =>
      write(paths.get("spec-ref")!),
    );

    const report = await executeWith(f, producingStep(), agent.harness);

    assert.deepEqual(report, { outcome: "failed" });
    assert.equal(f.owner.currentVersion("spec-ref"), earlier);
  });
}

test("a receipt of exactly the size limit is accepted", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: COMPLETED }],
  );
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, (paths) =>
    writeFileSync(paths.get("spec-ref")!, "x".repeat(64 * 1024)),
  );

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(boundText(f.owner, "spec-ref")?.length, 64 * 1024);
});

test("a retried Attempt names a fresh receipt path, so an earlier receipt never satisfies it", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: COMPLETED }, { result: COMPLETED }],
  );
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, (paths, turn) => {
    // The first Turn writes nothing; the retry writes its own receipt.
    if (turn === 1) writeFileSync(paths.get("spec-ref")!, "gh#12");
  });

  const report = await executeWith(
    f,
    producingStep({ retry: 1 }),
    agent.harness,
  );

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.deepEqual(
    f.owner.attemptLog().map((attempt) => attempt.outcome),
    ["failed", "succeeded"],
  );
  const [first, second] = agent.inputs.map((input) =>
    receiptPaths(input).get("spec-ref")!,
  );
  assert.notEqual(first, second);
  assert.equal(boundText(f.owner, "spec-ref"), "gh#12");
});

test("a receipt left by a Turn that did not complete is never published", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: RESULT_CASES.failed.result }],
  );
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, (paths) =>
    writeFileSync(paths.get("spec-ref")!, "gh#12"),
  );

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "failed" });
  assert.equal(f.owner.currentVersion("spec-ref"), undefined);
});

test("an Agent Step with no declared output gets no receipt instruction", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: COMPLETED }],
  );
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, () => undefined);

  const report = await executeWith(f, agentStep(), agent.harness);

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(agent.inputs[0], "Publish the spec.\n");
});

test("a producing Step whose working area is unusable fails typed before any Turn (#220)", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: COMPLETED }],
  );
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, () => undefined);
  // Receipts live in the working area; a squatted area is typed, never a throw.
  const area = f.owner.workingArea();
  assert.ok(area.ok);
  rmSync(area.path, { recursive: true });
  writeFileSync(area.path, "squatter");

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "failed" });
  assert.deepEqual(agent.inputs, []);
  assert.deepEqual(f.owner.turns(), []);
});

test("a receipt root conflict in a usable working area fails each Attempt before any Turn and binds nothing (#305)", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: COMPLETED }, { result: COMPLETED }],
  );
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, () => undefined);
  // The area itself is a usable directory, so only receipt preparation can fail.
  const area = f.owner.workingArea();
  assert.ok(area.ok);
  writeFileSync(join(area.path, ".receipts"), "squatter");

  const report = await executeWith(
    f,
    producingStep({ retry: 1 }),
    agent.harness,
  );

  // The existing failed-Attempt policy: retried within budget, then the Run fails.
  assert.deepEqual(report, { outcome: "failed" });
  assert.deepEqual(
    f.owner.attemptLog().map((attempt) => attempt.outcome),
    ["failed", "failed"],
  );
  assert.equal(f.state(), "failed");
  // No Turn was admitted or sent, and no output moved.
  assert.deepEqual(agent.inputs, []);
  assert.deepEqual(f.owner.turns(), []);
  assert.equal(f.owner.currentVersion("spec-ref"), undefined);
  // The failed Attempt still ran under a qualified Harness, so it keeps the identity.
  const evidence = f.owner.harnessEvidence();
  assert.equal(evidence?.identity?.harness, "fake");
  assert.equal(evidence?.effectiveModel, undefined);
});

test("m10-commands-and-input-rules: substituted reserved Agent prompts fail with no Turn or output", async (t) => {
  const f = fixture(t, { task: "\u2003/MODEL\nunsafe" });
  const assets = promptAssets(f.workspace, "{{artifact:task}}");
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [],
  );
  t.after(() => prepared.close());
  const report = await executeRouting(
    [
      agentStep({
        requires: ["task"],
        retry: 2,
        produces: [{ name: "summary", type: "text" }],
      }),
    ],
    {
      owner: f.owner,
      platform: HOST,
      process: executionProcess,
      resolveAsset: assets.resolveAsset,
      inputTypes: { task: "text" },
      harness: {
        prepared,
        inputRules: [{ kind: "reserved-leading-words", words: ["/model"] }],
        assetKinds: { "prompt.md": "prompt" },
      },
    },
  );
  assert.equal(report.outcome, "failed");
  assert.equal(f.state(), "failed");
  assert.deepEqual(
    f.owner.attemptLog().map((a) => a.outcome),
    ["failed", "failed", "failed"],
  );
  assert.equal(f.owner.currentVersion("summary"), undefined);
  assert.deepEqual(f.owner.turns(), []);
  assert.deepEqual(f.owner.harnessSessions(), []);
});

for (const kind of ["agent", "interactive-agent"] as const) {
  for (const source of ["asset", "artifact"] as const) {
    test(`m10-commands-and-input-rules: ${kind} ${source} prompt refuses before admission`, async (t) => {
      const f = fixture(t, { task: "\u2003/MODEL\nunsafe" });
      const assets = promptAssets(f.workspace, "{{artifact:task}}");
      if (source === "artifact") bindEarlier(f.owner, "\u2003/MODEL\nunsafe");
      const prepared = await preparedHarness(
        fakeHarnessProfile(PROFILE_OVERRIDES),
        [],
      );
      t.after(() => prepared.close());
      const report = await executeRouting(
        [
          agentStep({
            kind,
            entryTurn: true,
            requires: source === "asset" ? ["task"] : ["spec-ref"],
            prompt:
              source === "asset"
                ? { asset: "prompt.md" }
                : { artifact: "spec-ref" },
          }),
        ],
        {
          owner: f.owner,
          platform: HOST,
          process: executionProcess,
          resolveAsset: assets.resolveAsset,
          inputTypes: { task: "text" },
          harness: {
            prepared,
            inputRules: [{ kind: "reserved-leading-words", words: ["/model"] }],
            assetKinds: { "prompt.md": "prompt" },
          },
        },
      );
      assert.equal(report.outcome, kind === "agent" ? "failed" : "blocked");
      assert.equal(f.state(), kind === "agent" ? "failed" : "blocked");
      assert.equal(
        f.owner.attemptLog().filter((a) => a.attemptId !== "earlier").length,
        kind === "agent" ? 1 : 0,
      );
      assert.deepEqual(f.owner.turns(), []);
      assert.deepEqual(f.owner.harnessSessions(), []);
      if (kind === "interactive-agent") {
        // Rewalking an unadmitted Entry stays blocked without fabricating a Turn.
        const again = await executeRouting(
          [agentStep({ kind, entryTurn: true, requires: ["task"] })],
          {
            owner: f.owner,
            platform: HOST,
            process: executionProcess,
            resolveAsset: assets.resolveAsset,
            inputTypes: { task: "text" },
            harness: {
              prepared,
              inputRules: [
                { kind: "reserved-leading-words", words: ["/model"] },
              ],
              assetKinds: { "prompt.md": "prompt" },
            },
          },
        );
        assert.equal(again.outcome, "blocked");
        assert.deepEqual(f.owner.turns(), []);
      }
    });
  }
}

test("m10-commands-and-input-rules: a compatible Harness receives a reserved substituted word unchanged", async (t) => {
  const f = fixture(t, { task: " /MODEL\nwork" });
  const assets = promptAssets(f.workspace, "{{artifact:task}}");
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [{ result: RESULT_CASES.completed.result }],
  );
  t.after(() => prepared.close());
  const report = await executeRouting([agentStep({ requires: ["task"] })], {
    owner: f.owner,
    platform: HOST,
    process: executionProcess,
    resolveAsset: assets.resolveAsset,
    inputTypes: { task: "text" },
    harness: {
      prepared,
      inputRules: [],
      assetKinds: { "prompt.md": "prompt" },
    },
  });
  assert.equal(report.outcome, "succeeded");
  assert.equal(f.owner.turns().length, 1);
  assert.equal(f.owner.turns()[0]?.input, " /MODEL\nwork");
});

test("m10-interruption-and-transcript: fake identified messages reach stored conversation without the final aggregate", async (t) => {
  const f = fixture(t);
  const assets = promptAssets(f.workspace, "Discuss");
  const prepared = await preparedHarness(
    fakeHarnessProfile(PROFILE_OVERRIDES),
    [
      {
        events: [
          { kind: "assistant-content", messageId: "first", content: "First" },
          { kind: "assistant-content", messageId: "second", content: "Second" },
        ],
        result: RESULT_CASES.completed.result,
      },
    ],
  );
  t.after(() => prepared.close());
  const report = await executeRouting([agentStep()], {
    owner: f.owner,
    platform: HOST,
    resolveAsset: assets.resolveAsset,
    now: () => AT,
    process: executionProcess,
    inputTypes: {},
    harness: {
      inputRules: [],
      prepared,
      assetKinds: { "prompt.md": "prompt" },
    },
  });
  assert.equal(report.outcome, "succeeded");
  assert.deepEqual(
    f.owner.transcript().map((e) => e.content),
    ["Discuss", "First", "Second"],
  );
  assert.equal(
    f.owner.transcript().filter((e) => e.role === "assistant").length,
    2,
  );
  assert.equal(
    f.owner.turnEvents().filter((e) => e.kind === "assistant-content").length,
    2,
  );
});

for (const name of ["completed", "failed", "interrupted", "lost"] as const) {
  test(`m10-interruption-and-transcript: unfinished Thoughts settle once as incomplete at ${name}, outside the transcript`, async (t) => {
    const f = fixture(t);
    const assets = promptAssets(f.workspace, "Discuss");
    const prepared = await preparedHarness(
      fakeHarnessProfile(PROFILE_OVERRIDES),
      [
        {
          events: [
            { kind: "thought-preview", summaryId: "first", content: "First" },
            {
              kind: "message-preview",
              messageId: "same-id",
              content: "Answer",
            },
            { kind: "thought-preview", summaryId: "second", content: "Second" },
            {
              kind: "thought",
              summaryId: "second",
              content: "Final second",
              durationMs: 0,
            },
            {
              kind: "thought-preview",
              summaryId: "first",
              content: "First complete preview",
            },
          ],
          result: RESULT_CASES[name].result,
        },
      ],
    );
    t.after(() => prepared.close());
    await executeRouting([agentStep()], {
      owner: f.owner,
      platform: HOST,
      resolveAsset: assets.resolveAsset,
      now: () => AT,
      process: executionProcess,
      inputTypes: {},
      harness: {
        inputRules: [],
        prepared,
        assetKinds: { "prompt.md": "prompt" },
      },
    });
    const summaries = f.owner
      .turnEvents()
      .filter((event) => event.kind === "thought")
      .map((event) => JSON.parse(event.payload));
    assert.deepEqual(summaries, [
      { summaryId: "second", content: "Final second", durationMs: 0 },
      {
        summaryId: "first",
        content: "First complete preview",
        incomplete: true,
      },
    ]);
    assert.deepEqual(
      f.owner.transcript().map((entry) => entry.content),
      ["Discuss", "Answer"],
    );
    assert.equal(
      f.owner.turnEvents().some((event) => event.kind === "thought-preview"),
      false,
    );
    assert.equal(f.owner.turns()[0]?.resultKind, name);
  });
}

for (const name of ["completed", "failed", "interrupted", "lost"] as const) {
  test(`m10-interruption-and-transcript: supplied diffs drain exactly once at orderly ${name}, without preview persistence`, async (t) => {
    const f = fixture(t);
    const assets = promptAssets(f.workspace, "Discuss");
    const diff = {
      content:
        "FULL_DIFF_START\n" + "supplied diff\n".repeat(3000) + "FULL_DIFF_END",
      files: [{ path: "file.ts" }],
    };
    const prepared = await preparedHarness(
      fakeHarnessProfile(PROFILE_OVERRIDES),
      [
        {
          events: [
            {
              kind: "turn-diff-preview",
              diff: { content: "Old snapshot", files: [] },
            },
            {
              kind: "tool-call",
              call: {
                callId: "file",
                tool: "file-change",
                input: "file.ts",
                outcome: { kind: "running" },
              },
            },
            { kind: "turn-diff-preview", diff },
          ],
          result: RESULT_CASES[name].result,
        },
      ],
    );
    t.after(() => prepared.close());
    await executeRouting([agentStep()], {
      owner: f.owner,
      platform: HOST,
      resolveAsset: assets.resolveAsset,
      now: () => AT,
      process: executionProcess,
      inputTypes: {},
      harness: {
        inputRules: [],
        prepared,
        assetKinds: { "prompt.md": "prompt" },
      },
    });
    assert.deepEqual(
      f.owner
        .turnEvents()
        .filter((event) => event.kind === "turn-diff")
        .map((event) => JSON.parse(event.payload)),
      [diff],
    );
    assert.equal(
      f.owner.turnEvents().some((event) => event.kind === "turn-diff-preview"),
      false,
    );
    assert.deepEqual(
      f.owner.transcript().map((entry) => entry.content),
      ["Discuss"],
    );
    assert.equal(f.owner.turns()[0]?.resultKind, name);
    const call = f.owner
      .turnEvents()
      .find((event) => event.kind === "tool-call");
    assert.ok(call);
    assert.deepEqual(JSON.parse(call.payload).outcome, { kind: "running" });
  });
}

for (const name of ["completed", "failed", "interrupted", "lost"] as const)
  test(`m10-interruption-and-transcript: orderly ${name} stores each unmatched command tail through admitted partial evidence, never chunks`, async (t) => {
    const f = fixture(t);
    const assets = promptAssets(f.workspace, "Discuss");
    const call = {
      callId: "command",
      tool: "command" as const,
      input: "build",
      outcome: { kind: "running" as const },
    };
    const prepared = await preparedHarness(
      fakeHarnessProfile(PROFILE_OVERRIDES),
      [
        {
          events: [
            { kind: "tool-call", call },
            {
              kind: "tool-preview",
              call: { ...call, output: { text: "earlier" } },
            },
            {
              kind: "tool-preview",
              call: {
                ...call,
                output: { text: "OLD" + "x".repeat(30_000) },
                nativeOmission: "reported omission",
              },
            },
          ],
          result: RESULT_CASES[name].result,
        },
      ],
    );
    t.after(() => prepared.close());
    await executeRouting([agentStep()], {
      owner: f.owner,
      platform: HOST,
      resolveAsset: assets.resolveAsset,
      now: () => AT,
      process: executionProcess,
      inputTypes: {},
      harness: {
        inputRules: [],
        prepared,
        assetKinds: { "prompt.md": "prompt" },
      },
    });
    const facts = f.owner
      .turnEvents()
      .filter((event) => event.kind.startsWith("tool-"))
      .map((event) => [event.kind, JSON.parse(event.payload)]);
    assert.deepEqual(facts, [
      ["tool-call", call],
      [
        "tool-partial",
        {
          ...call,
          output: {
            text: "x".repeat(30_000),
            secantDropped: true,
            incomplete: true,
          },
          nativeOmission: "reported omission",
        },
      ],
    ]);
    assert.deepEqual(
      f.owner.transcript().map((entry) => entry.content),
      ["Discuss"],
    );
    assert.equal(f.owner.turns()[0]?.resultKind, name);
  });

for (const kind of ["agent", "interactive-agent"] as const) {
  test(`m10-audit-file-input-resolution: ${kind} prompt slots keep Workspace paths, opaque text, and bound-artifact precedence`, async (t) => {
    const absolute = join(makeTempDir("secant-agent-external-"), "outside.ts");
    const f = fixture(t, {
      target: "src/a.ts",
      docs: ` src/b.ts \r\n\n${absolute}\n`,
      absolute,
      note: "src/text.ts",
      bound: "src/launch.ts",
    });
    assert.ok(
      f.owner.publishAttempt({
        attemptId: "earlier",
        outcome: "succeeded",
        at: AT,
        outputs: [
          {
            name: "bound",
            type: "text",
            content: new TextEncoder().encode("src/bound.ts"),
          },
        ],
        required: [{ name: "bound", type: "text" }],
      }).ok,
    );
    const assets = promptAssets(
      f.workspace,
      "{{artifact:target}}\n{{artifact:docs}}\n{{artifact:absolute}}\n{{artifact:note}}\n{{artifact:bound}}",
    );
    const { prepared, requests } = await recordingHarness(t, [
      { result: RESULT_CASES.completed.result },
    ]);
    const report = await executeRouting(
      [
        agentStep({
          kind,
          ...(kind === "interactive-agent" ? { entryTurn: true } : {}),
        }),
      ],
      {
        owner: f.owner,
        platform: HOST,
        resolveAsset: assets.resolveAsset,
        now: () => AT,
        process: executionProcess,
        inputTypes: {
          target: "file",
          docs: "file-set",
          absolute: "file",
          note: "text",
          bound: "file",
        },
        harness: {
          inputRules: [],
          prepared,
          assetKinds: { "prompt.md": "prompt" },
        },
      },
    );
    assert.deepEqual(report, {
      outcome: kind === "agent" ? "succeeded" : "blocked",
    });
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.input.text,
      `${join(f.workspace, "src", "a.ts")}\n${join(f.workspace, "src", "b.ts")}\n${absolute}\n${absolute}\nsrc/text.ts\nsrc/bound.ts`,
    );
  });
}

for (const fault of ["invalid", "storage", "malformed", "fenced"] as const) {
  test(`m10-audit-turn-event-refusal: ${fault} refusal drains later events and settles the Turn`, async (t) => {
    const f = fixture(t);
    const assets = promptAssets(f.workspace, "Work");
    const cause = new Error("injected storage fault");
    const owner: RunOwner =
      fault === "invalid"
        ? f.owner
        : {
            ...f.owner,
            appendTurnEvent(request) {
              if (request.fact.kind === "tool-call" && fault === "malformed") {
                // An unchecked caller's data that does not match its kind.
                return f.owner.appendTurnEvent({
                  ...request,
                  fact: {
                    kind: "tool-call",
                    data: "private_turn_text_432",
                  } as unknown as TurnFact,
                });
              }
              if (request.fact.kind === "tool-call")
                return fault === "fenced"
                  ? { ok: false, reason: "fenced" }
                  : {
                      ok: false,
                      reason: "unrecordable",
                      cause,
                      safeCause: translateCause(cause),
                    };
              return f.owner.appendTurnEvent(request);
            },
          };
    const prepared = await preparedHarness(
      fakeHarnessProfile(PROFILE_OVERRIDES),
      [
        {
          events: [
            {
              kind: "tool-call",
              call: {
                callId: "bad",
                tool: "file-change",
                input: "file",
                files: [{ path: "" }],
                outcome: { kind: "completed" },
              },
            },
            {
              kind: "assistant-content",
              messageId: "later",
              content: "Still reading",
            },
          ],
          result: {
            kind: "completed",
            detail: {
              effectiveModel: { known: false },
              session: { state: "open" },
            },
          },
        },
      ],
    );
    t.after(() => prepared.close());
    const events: ExecutionEvent[] = [];
    const report = await executeRouting([agentStep()], {
      owner,
      platform: HOST,
      resolveAsset: assets.resolveAsset,
      now: () => AT,
      process: executionProcess,
      inputTypes: {},
      observe: (event) => events.push(event),
      harness: {
        inputRules: [],
        prepared,
        assetKinds: { "prompt.md": "prompt" },
      },
    });
    assert.equal(report.outcome, "succeeded");
    assert.equal(f.owner.turns()[0]?.resultKind, "completed");
    assert.deepEqual(
      f.owner.transcript().map((entry) => entry.content),
      ["Work", "Still reading"],
    );
    assert.deepEqual(
      f.owner.turnEvents().map((event) => event.kind),
      ["assistant-content"],
    );
    const refusals = events.filter(
      (event) => event.kind === "turn-event-refused",
    );
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]?.eventKind, "tool-call");
    assert.equal(
      refusals[0]?.refusal.reason,
      fault === "fenced" ? "fenced" : "unrecordable",
    );
    const refusal = refusals[0]?.refusal;
    if (refusal?.reason === "unrecordable") {
      assert.equal(
        JSON.stringify(refusal.safeCause).includes("private_turn_text_432"),
        false,
      );
      if (fault === "storage") assert.equal(refusal.cause, cause);
    }
  });
}
