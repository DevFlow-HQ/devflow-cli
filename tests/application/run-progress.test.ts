import { readRun } from "./run-test-helpers.js";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import type { Application } from "../../src/application/application.js";
import type {
  ActionOffer,
  RunGateReference,
  RunView,
} from "../../src/application/projection-port.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import type { SpawnResult } from "../../src/process/process.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import type { RunGroup } from "../../src/run/store/store.js";
import {
  across,
  call,
  completed,
  launchAgentCompletionRun,
  reviewedLoop,
} from "../helpers/agentCompletion.js";
import { createApplication } from "../helpers/application.js";
import {
  commandNode,
  hostPlatform,
  repeatCommandGateRouting,
  repeatNode,
  writeRoutingBundle,
} from "../helpers/commandBundle.js";
import { countingBundleProcess } from "../helpers/fakeBundleProcess.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "../run/store/fake-git-process.js";

// Run progress by Step and Iteration identity (#384): ordinary Bundles built,
// installed, and run through the Application Interface over the Process double,
// asserting the literal progress, Iterations, current interaction, and how often
// each Command ran — never a fabricated Attempt log.

/** How a Step's first Command Attempt goes wrong, before later ones run normally. */
type FirstAttempt = "timeout" | "interrupted";

interface Home {
  readonly catalog: Catalog;
  readonly storeDir: string;
  readonly workspace: string;
  /** Times each `commandNode` Step's Command was spawned, by Step id. */
  readonly runs: Record<string, number>;
  /** Resolves once a Step's interrupted first Attempt is running. */
  readonly interrupted: Promise<void>;
  /** A fresh Run Store and Application over the same home, as a new process. */
  open(): { app: Application; runGroup: RunGroup };
}

function home(
  t: TestContext,
  firstAttempts: Readonly<Record<string, FirstAttempt>> = {},
): Home {
  const catalog = openCatalog(makeTempDir("secant-progress-home-"));
  t.after(() => catalog.close());
  const storeDir = makeTempDir("secant-progress-store-");
  const workspace = realpathSync.native(makeTempDir("secant-progress-ws-"));
  catalog.approveWorkspace(workspace, new Date());
  let started!: () => void;
  const interrupted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { process, runs } = countingBundleProcess((step, options) => {
    if (firstAttempts[step] === "timeout") return { kind: "timeout" };
    if (firstAttempts[step] !== "interrupted") return undefined;
    started();
    return new Promise<SpawnResult>((resolve) =>
      options.cancelSignal?.addEventListener(
        "abort",
        () => resolve({ kind: "cancelled" }),
        { once: true },
      ),
    );
  });
  const open = () => {
    const runGroup = openRunGroup(storeDir, workspace);
    const app = createApplication({
      process,
      catalog,
      launchWorkspacePath: workspace,
      hostPlatform: hostPlatform(),
      runGroup,
      runExecution: ({ routing, owner, cancelSignal }) =>
        executeRouting(routing, {
          owner,
          platform: hostPlatform(),
          resolveAsset: () => undefined,
          process,
          ...(cancelSignal !== undefined ? { cancelSignal } : {}),
        }),
    });
    // Shutdown releases a held Run through the Store, so it runs before close.
    t.after(async () => {
      await app.shutdown();
      runGroup.close();
    });
    return { app, runGroup };
  };
  return { catalog, storeDir, workspace, runs, interrupted, open };
}

/** Build, install, and launch an ordinary Bundle over `routing`; the launch
 *  Operation's id is `launch`. */
function launch(
  h: Home,
  app: Application,
  id: string,
  routing: readonly unknown[],
): string {
  const bundle = writeRoutingBundle({ id, routing });
  const built = app.bundleManagement.build(bundle.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = h.catalog.listEntries().find((e) => e.id === id);
  assert.ok(entry);
  const admission = app.projectionPort.submit({
    operationId: "launch",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: entry.digest },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  return admission.runId!;
}

/** Each Step as `id:status`, the position, and the Iteration marks, in order. */
function progressOf(run: RunView) {
  return {
    state: run.state,
    progress: run.progress.map((step) => `${step.id}:${step.status}`),
    position: run.position,
    iterations: run.timeline
      .filter((event) => event.event === "iteration")
      .map((event) => event.detail),
  };
}

function answerOffer(run: RunView): RunGateReference | undefined {
  const offer = run.actionOffers.find(
    (candidate): candidate is Extract<ActionOffer, { gate: unknown }> =>
      candidate.action === "answer-human-gate",
  );
  return offer?.gate;
}

async function answer(
  app: Application,
  run: RunView,
  operationId: string,
): Promise<void> {
  const gate = run.pendingGate?.gate ?? run.checkpoint?.gate;
  assert.ok(gate);
  const admission = app.projectionPort.submit({
    operationId,
    operation: "answer-human-gate",
    input: { runId: run.runId, gate, answer: "continue" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(await awaitSettled(app.projectionPort, operationId), {
    status: "applied",
  });
}

/** The authored Gate the #384 Routing rests at, and its answer Offer. */
function assertAtGate(run: RunView): void {
  const gate = {
    runId: run.runId,
    stepId: "gate",
    attemptId: "0.0:gate",
    shape: "approve-reject",
  };
  assert.deepEqual(run.pendingGate?.gate, gate);
  assert.equal(run.pendingGate?.message, "approve the outside change");
  assert.equal(run.checkpoint, undefined);
  assert.deepEqual(answerOffer(run), gate);
}

const AT_GATE = [
  "baseline:succeeded",
  "check:succeeded",
  "outside:succeeded",
  "gate:blocked",
  "after:pending",
];
const ALL_SUCCEEDED = [
  "baseline:succeeded",
  "check:succeeded",
  "outside:succeeded",
  "gate:succeeded",
  "after:succeeded",
];

test("Repeat → outside Command → Human Gate projects the stored Gate, and answering re-runs no Command (#384)", async (t) => {
  const h = home(t);
  const { app } = h.open();
  const runId = launch(
    h,
    app,
    "dev.secant.repeat-command-gate",
    repeatCommandGateRouting(),
  );
  await awaitSettled(app.projectionPort, "launch");

  const blocked = readRun(app.projectionPort, runId);
  assert.deepEqual(progressOf(blocked), {
    state: "blocked",
    progress: AT_GATE,
    position: 3,
    // The one Iteration is the group's own; the outside Command is not another.
    iterations: ["1"],
  });
  assertAtGate(blocked);
  assert.deepEqual(h.runs, { baseline: 1, check: 1, outside: 1 });

  await answer(app, blocked, "answer");
  assert.deepEqual(progressOf(readRun(app.projectionPort, runId)), {
    state: "succeeded",
    progress: ALL_SUCCEEDED,
    position: 5,
    iterations: ["1"],
  });
  assert.deepEqual(h.runs, { baseline: 1, check: 1, outside: 1, after: 1 });
});

test("a zero-Iteration group before the outside Command and Gate passes without running (#384)", async (t) => {
  const h = home(t);
  const { app } = h.open();
  const [, ...rest] = repeatCommandGateRouting();
  const runId = launch(h, app, "dev.secant.zero-iteration-gate", [
    commandNode("baseline", "process.exit(0)", [
      { name: "passing", type: "verdict" },
    ]),
    ...rest,
  ]);
  await awaitSettled(app.projectionPort, "launch");

  const blocked = readRun(app.projectionPort, runId);
  assert.deepEqual(progressOf(blocked), {
    state: "blocked",
    progress: AT_GATE,
    position: 3,
    iterations: [],
  });
  assertAtGate(blocked);
  assert.deepEqual(h.runs, { baseline: 1, outside: 1 });

  await answer(app, blocked, "answer");
  assert.deepEqual(progressOf(readRun(app.projectionPort, runId)), {
    state: "succeeded",
    progress: ALL_SUCCEEDED,
    position: 5,
    iterations: [],
  });
  assert.deepEqual(h.runs, { baseline: 1, outside: 1, after: 1 });
});

test("failed retries stay with their own Step instance on both sides of the group (#384)", async (t) => {
  const h = home(t, { check: "timeout", outside: "timeout" });
  const { app, runGroup } = h.open();
  const [baseline, , , gate, after] = repeatCommandGateRouting();
  const runId = launch(h, app, "dev.secant.retried-gate", [
    baseline,
    repeatNode({
      stepId: "check",
      until: "passing",
      interval: 3,
      passAt: 1,
      retry: 1,
    }),
    commandNode("outside", "console.log('outside')", undefined, 1),
    gate,
    after,
  ]);
  await awaitSettled(app.projectionPort, "launch");

  const blocked = readRun(app.projectionPort, runId);
  assert.deepEqual(progressOf(blocked), {
    state: "blocked",
    progress: AT_GATE,
    position: 3,
    iterations: ["1"],
  });
  assertAtGate(blocked);
  assert.deepEqual(h.runs, { baseline: 1, check: 2, outside: 2 });

  await answer(app, blocked, "answer");
  assert.deepEqual(progressOf(readRun(app.projectionPort, runId)), {
    state: "succeeded",
    progress: ALL_SUCCEEDED,
    position: 5,
    iterations: ["1"],
  });
  assert.deepEqual(h.runs, { baseline: 1, check: 2, outside: 2, after: 1 });
  // The rested Run is no longer held, so its log can be read directly.
  const owner = runGroup.acquireRun(runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.deepEqual(
    owner.attemptLog().map((entry) => `${entry.attemptId}:${entry.outcome}`),
    [
      "0.0:baseline:succeeded",
      "0.0:check:failed",
      "0.1:check:succeeded",
      "0.0:outside:failed",
      "0.1:outside:succeeded",
      "0.0:gate:succeeded",
      "0.0:after:succeeded",
    ],
  );
});

test("each of several groups counts its own Iterations and Review grants (#384)", async (t) => {
  const h = home(t);
  const { app } = h.open();
  const runId = launch(h, app, "dev.secant.two-groups", [
    commandNode("baseline", "process.exit(1)", [
      { name: "passing", type: "verdict" },
    ]),
    repeatNode({ stepId: "checkA", until: "passing", interval: 1, passAt: 2 }),
    commandNode("mid", "process.exit(1)", [
      { name: "passing-b", type: "verdict" },
    ]),
    // Trailing; its grant offset is its own, never the first group's.
    repeatNode({
      stepId: "checkB",
      until: "passing-b",
      interval: 2,
      passAt: 5,
    }),
  ]);
  await awaitSettled(app.projectionPort, "launch");

  const atA = readRun(app.projectionPort, runId);
  assert.deepEqual(progressOf(atA), {
    state: "blocked",
    progress: [
      "baseline:succeeded",
      "checkA:blocked",
      "mid:pending",
      "checkB:pending",
    ],
    position: 1,
    iterations: ["1"],
  });
  assert.equal(atA.checkpoint?.completedIterations, 1);
  assert.deepEqual(atA.checkpoint?.gate, {
    runId,
    stepId: "checkA",
    attemptId: "0.0:checkA",
    shape: "approve-reject",
  });
  assert.deepEqual(answerOffer(atA), atA.checkpoint?.gate);

  const blockedAtB = [
    "baseline:succeeded",
    "checkA:succeeded",
    "mid:succeeded",
    "checkB:blocked",
  ];
  await answer(app, atA, "grant-a");
  const atB = readRun(app.projectionPort, runId);
  assert.deepEqual(progressOf(atB), {
    state: "blocked",
    progress: blockedAtB,
    position: 3,
    iterations: ["1", "2", "1", "2"],
  });
  assert.equal(atB.checkpoint?.completedIterations, 2);
  assert.equal(atB.checkpoint?.gate.attemptId, "1.0:checkB");
  assert.deepEqual(answerOffer(atB), atB.checkpoint?.gate);

  await answer(app, atB, "grant-b");
  const atBAgain = readRun(app.projectionPort, runId);
  assert.deepEqual(progressOf(atBAgain), {
    state: "blocked",
    progress: blockedAtB,
    position: 3,
    iterations: ["1", "2", "1", "2", "3", "4"],
  });
  assert.equal(atBAgain.checkpoint?.completedIterations, 2);
  assert.equal(atBAgain.checkpoint?.gate.attemptId, "3.0:checkB");

  await answer(app, atBAgain, "grant-b-again");
  assert.deepEqual(progressOf(readRun(app.projectionPort, runId)), {
    state: "succeeded",
    progress: [
      "baseline:succeeded",
      "checkA:succeeded",
      "mid:succeeded",
      "checkB:succeeded",
    ],
    position: 4,
    // Both groups' Iterations, the non-trailing group's included.
    iterations: ["1", "2", "1", "2", "3", "4", "5"],
  });
  assert.deepEqual(h.runs, { baseline: 1, checkA: 2, mid: 1, checkB: 5 });
});

test("a group whose Verdict a later Command rebinds stays complete, and answering its Gate re-runs no Command (#384)", async (t) => {
  const h = home(t);
  const { app } = h.open();
  const [baseline, group, , gate, after] = repeatCommandGateRouting();
  const runId = launch(h, app, "dev.secant.rebound-verdict", [
    baseline,
    group,
    // Rebinds the group's `until` Verdict to `fail`: the group is complete because
    // a later node ran, not because its Verdict still passes.
    commandNode("outside", "process.exit(1)", [
      { name: "passing", type: "verdict" },
    ]),
    gate,
    after,
  ]);
  await awaitSettled(app.projectionPort, "launch");

  const blocked = readRun(app.projectionPort, runId);
  assert.deepEqual(progressOf(blocked), {
    state: "blocked",
    progress: AT_GATE,
    position: 3,
    iterations: ["1"],
  });
  assertAtGate(blocked);
  assert.deepEqual(h.runs, { baseline: 1, check: 1, outside: 1 });

  await answer(app, blocked, "answer");
  assert.deepEqual(progressOf(readRun(app.projectionPort, runId)), {
    state: "succeeded",
    progress: ALL_SUCCEEDED,
    position: 5,
    iterations: ["1"],
  });
  assert.deepEqual(h.runs, { baseline: 1, check: 1, outside: 1, after: 1 });
});

test("a reopened Run at the Gate projects the same Gate and answers from the new process (#384)", async (t) => {
  const h = home(t);
  const first = h.open();
  const runId = launch(
    h,
    first.app,
    "dev.secant.reopened-gate",
    repeatCommandGateRouting(),
  );
  await awaitSettled(first.app.projectionPort, "launch");
  await first.app.shutdown();

  const second = h.open();
  const reopened = readRun(second.app.projectionPort, runId);
  assert.deepEqual(progressOf(reopened), {
    state: "blocked",
    progress: AT_GATE,
    position: 3,
    iterations: ["1"],
  });
  assertAtGate(reopened);

  await answer(second.app, reopened, "answer");
  assert.deepEqual(progressOf(readRun(second.app.projectionPort, runId)), {
    state: "succeeded",
    progress: ALL_SUCCEEDED,
    position: 5,
    iterations: ["1"],
  });
  assert.deepEqual(h.runs, { baseline: 1, check: 1, outside: 1, after: 1 });
});

test("a reconciliation marker after a passed group is no Step's success or Iteration (#384)", async (t) => {
  const h = home(t, { outside: "interrupted" });
  const first = h.open();
  const runId = launch(
    h,
    first.app,
    "dev.secant.marker-gate",
    repeatCommandGateRouting(),
  );
  await h.interrupted;
  // Shutdown aborts the live outside Command and leaves the claim live, so the
  // next open reconciles the Run `halted` with one indeterminate marker.
  await first.app.shutdown();

  const second = h.open();
  const halted = readRun(second.app.projectionPort, runId);
  assert.deepEqual(progressOf(halted), {
    state: "halted",
    progress: [
      "baseline:succeeded",
      "check:succeeded",
      "outside:blocked",
      "gate:pending",
      "after:pending",
    ],
    position: 2,
    iterations: ["1"],
  });

  const resume = second.app.projectionPort.submit({
    operationId: "resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted);
  await awaitSettled(second.app.projectionPort, "resume");
  const blocked = readRun(second.app.projectionPort, runId);
  assert.deepEqual(progressOf(blocked), {
    state: "blocked",
    progress: AT_GATE,
    position: 3,
    iterations: ["1"],
  });
  assertAtGate(blocked);

  await answer(second.app, blocked, "answer");
  assert.equal(readRun(second.app.projectionPort, runId).state, "succeeded");
  assert.deepEqual(h.runs, { baseline: 1, check: 1, outside: 2, after: 1 });
});

const continueOnce = (key: string) => ({
  agentCalls: [call(`ticket ${key} done`, key)],
  result: completed,
});

for (const { declared, turns, endStage, iterations, completion } of [
  {
    declared: "a person's End Stage",
    turns: across([continueOnce("1"), { result: completed }]),
    endStage: true,
    iterations: ["1", "2"],
    completion: "human-declared",
  },
  {
    declared: "an agent's stage done",
    turns: across([
      {
        agentCalls: [call("tracker empty", "1", "stage_done")],
        result: completed,
      },
    ]),
    endStage: false,
    iterations: ["1"],
    completion: "agent-declared",
  },
] as const) {
  test(`${declared} ends the group before the outside Command and Gate (#384)`, async (t) => {
    const [, , outside, gate, after] = repeatCommandGateRouting();
    const { wired, runId } = await launchAgentCompletionRun(t, turns, [
      ...reviewedLoop(),
      outside,
      gate,
      after,
    ]);
    await awaitSettled(wired.projectionPort, "launch");
    if (endStage) {
      assert.ok(
        wired.projectionPort.submit({
          operationId: "end",
          operation: "end-stage",
          input: { runId, stepId: "implement" },
        }).admitted,
      );
      await awaitSettled(wired.projectionPort, "end");
    }

    const blocked = readRun(wired.projectionPort, runId);
    assert.deepEqual(progressOf(blocked), {
      state: "blocked",
      progress: [
        "implement:succeeded",
        "outside:succeeded",
        "gate:blocked",
        "after:pending",
      ],
      position: 2,
      iterations,
    });
    assertAtGate(blocked);

    assert.ok(
      wired.projectionPort.submit({
        operationId: "answer",
        operation: "answer-human-gate",
        input: { runId, gate: blocked.pendingGate!.gate, answer: "continue" },
      }).admitted,
    );
    await awaitSettled(wired.projectionPort, "answer");
    const done = readRun(wired.projectionPort, runId);
    assert.deepEqual(progressOf(done), {
      state: "succeeded",
      progress: [
        "implement:succeeded",
        "outside:succeeded",
        "gate:succeeded",
        "after:succeeded",
      ],
      position: 4,
      iterations,
    });
    assert.equal(done.completion, completion);
  });
}

test("a person's End Stage before an interactive Step holds that Step, not the group (#384)", async (t) => {
  const { wired, runId } = await launchAgentCompletionRun(
    t,
    across([continueOnce("1"), { result: completed }, { result: completed }]),
    [
      ...reviewedLoop(),
      {
        id: "discuss",
        kind: "interactive-agent",
        session: "d",
        entryTurn: true,
        prompt: { asset: "prompt.md" },
      },
    ],
  );
  await awaitSettled(wired.projectionPort, "launch");
  assert.ok(
    wired.projectionPort.submit({
      operationId: "end",
      operation: "end-stage",
      input: { runId, stepId: "implement" },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "end");

  const held = readRun(wired.projectionPort, runId);
  assert.deepEqual(progressOf(held), {
    state: "blocked",
    progress: ["implement:succeeded", "discuss:blocked"],
    position: 1,
    iterations: ["1", "2"],
  });
  assert.deepEqual(
    held.actionOffers
      .filter((offer) => "stepId" in offer)
      .map((offer) => `${offer.action}:${"stepId" in offer && offer.stepId}`),
    ["send-interactive-turn:discuss", "end-interactive-step:discuss"],
  );
});
