import { readRun, findOffer, requireOffer } from "./run-test-helpers.js";
import { writeAgentBundle as authorAgentBundle } from "../helpers/agentBundle.js";
import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type {
  HarnessAdapter,
  HarnessFailure,
} from "../../src/harness/harness.js";
import type {
  OperationOutcome,
  RunSnapshot,
  RunView,
  Submission,
} from "../../src/application/projection-port.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
} from "../harness/fake-adapter.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// A Harness that prepares at launch and refuses preparation on the next drive
// (#304, M7 audit A1). Every control that re-drives a Run — an authored approve or
// free-text Gate answer, a derived Review-checkpoint Continue, End Step, Continue,
// and End Stage — must settle not-applied with the selected-Harness Problem and
// rest the Run halted and resumable, exactly as launch and resume already do,
// while keeping the answer or interactive Attempt it committed first. Driven
// through the composition wiring and the Projection Port over temporary Catalog
// and Run Stores, with the Process and Harness both injected doubles.

const PREPARE_FAILURE: HarnessFailure = {
  phase: "prepare",
  category: "protocol-incompatible",
  possibleEffects: "none",
  nativeCode: "not-qualified",
  diagnostics: "The pinned protocol subset did not qualify on the next drive.",
};

/** Every prepared Harness replays this one completing Turn from the start. */
const SCRIPT: FakeScript = {
  profile: fakeHarnessProfile(),
  turns: [
    {
      result: {
        kind: "completed",
        detail: {
          effectiveModel: { known: true, model: "fake-sonnet" },
          session: { state: "detached", coordinate: { opaque: "coord" } },
        },
      },
    },
  ],
};

/** What the Harness and Process doubles observed. */
interface Evidence {
  prepares: number;
  closes: number;
  turns: number;
  commands: number;
}

/** The second `prepare` refuses with `PREPARE_FAILURE`; every other prepare is a
 *  fresh fake that counts its Turns and closes. `onRefuse` runs inside the refused
 *  prepare, while the advancing Operation still holds the Run. */
function secondPrepareRefuses(
  evidence: Evidence,
  onRefuse?: () => void,
): HarnessAdapter {
  return ownPreparations({
    async prepare(options) {
      evidence.prepares += 1;
      if (evidence.prepares === 2) {
        onRefuse?.();
        return { ok: false, failure: PREPARE_FAILURE };
      }
      const prepared = await createFake(SCRIPT)().prepare(options);
      if (!prepared.ok) return prepared;
      const harness = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          readDefaults: () => harness.readDefaults(),
          startTurn(request) {
            evidence.turns += 1;
            return harness.startTurn(request);
          },
          async close() {
            evidence.closes += 1;
            return harness.close();
          },
        },
      };
    },
  });
}

/** The shared Command double, counting every Command Step spawn. */
function countingProcess(evidence: Evidence): ProcessAdapter {
  const process = createFakeBundleProcess();
  return {
    resolveExecutable: (name, options) =>
      process.resolveExecutable(name, options),
    spawnCommand(options) {
      evidence.commands += 1;
      return process.spawnCommand(options);
    },
    spawnOwnedProcess: (options) => process.spawnOwnedProcess(options),
    spawnCommandSync: (options) => process.spawnCommandSync(options),
  };
}

const AGENT_AFTER = {
  id: "work",
  kind: "agent",
  session: "s",
  prompt: { asset: "prompts/go.md" },
};

const ROUTINGS = {
  approveGate: [
    command("before"),
    { id: "gate", kind: "human-gate", shape: "approve-reject", message: "ok?" },
    AGENT_AFTER,
  ],
  freeTextGate: [
    command("before"),
    {
      id: "gate",
      kind: "human-gate",
      shape: "free-text",
      message: "name it",
      produces: [{ name: "answer", type: "text" }],
    },
    AGENT_AFTER,
  ],
  checkpoint: [
    {
      id: "baseline",
      kind: "command",
      produces: [{ name: "passing", type: "verdict" }],
      command: {
        executable: RUNTIME_NAME,
        arguments: ["-e", "process.exit(1)"],
      },
    },
    {
      repeat: {
        until: "passing",
        reviewCheckpoint: { interval: 1, message: "review the loop" },
        steps: [
          {
            id: "check",
            kind: "command",
            produces: [{ name: "passing", type: "verdict" }],
            command: {
              executable: RUNTIME_NAME,
              arguments: ["-e", "process.exit(1)"],
            },
          },
        ],
      },
    },
    AGENT_AFTER,
  ],
  interactive: [
    {
      id: "discuss",
      kind: "interactive-agent",
      session: "s",
      prompt: { asset: "prompts/go.md" },
    },
    AGENT_AFTER,
  ],
  humanRepeat: [
    {
      repeat: {
        control: "human",
        steps: [
          {
            id: "implement",
            kind: "interactive-agent",
            session: "impl",
            prompt: { asset: "prompts/go.md" },
          },
        ],
      },
    },
    AGENT_AFTER,
  ],
} as const;

function command(id: string) {
  return {
    id,
    kind: "command",
    produces: [{ name: `${id}-log`, type: "text" }],
    command: {
      executable: RUNTIME_NAME,
      arguments: ["-e", `console.log('${id}')`],
    },
  };
}

function writeBundle(routing: readonly unknown[]): {
  folder: string;
  id: string;
} {
  const { folder } = authorAgentBundle({
    id: "dev.secant.continuation-failure",
    name: "Continuation Failure",
    description: "A control followed by a drive that must prepare a Harness.",
    prompt: { path: "prompts/go.md", text: "Do the work.\n" },
    routing: routing,
  });
  return { folder, id: "dev.secant.continuation-failure" };
}

interface Launched {
  readonly wired: Wiring;
  readonly runId: string;
  readonly run: RunView;
  readonly evidence: Evidence;
}

/** Wire, install, approve, and launch the routing to its first `blocked` rest. */
async function launchBlocked(
  t: TestContext,
  routing: readonly unknown[],
  options: { readonly onRefuse?: (runId: string, wired: Wiring) => void } = {},
): Promise<Launched> {
  const evidence: Evidence = { prepares: 0, closes: 0, turns: 0, commands: 0 };
  const workspace = makeTempDir("secant-continuation-failure-ws-");
  let launched: { runId: string; wired: Wiring } | undefined;
  const wired = wireApplication({
    secantHome: makeTempDir("secant-continuation-failure-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    process: countingProcess(evidence),
    harnessAdapter: secondPrepareRefuses(evidence, () => {
      if (launched !== undefined)
        options.onRefuse?.(launched.runId, launched.wired);
    }),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "configured",
        name: "fake-claude",
        description: "fake",
      },
    }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const bundle = writeBundle(routing);
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: "claude-code",
      requestedModel: "fake-model",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-launch")).status,
    "applied",
  );
  launched = { runId, wired };
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "blocked", JSON.stringify(run.problem));
  assert.equal(evidence.prepares, 1);
  return { wired, runId, run, evidence };
}

/** Open the `run` Projection and collect every durable snapshot it is pushed. */
function observe(wired: Wiring, runId: string) {
  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  const pushed: RunSnapshot[] = [];
  const draining = (async () => {
    for await (const update of opened.updates) {
      if (update.kind === "durable") pushed.push(update.snapshot);
    }
  })();
  return {
    pushed,
    async close() {
      opened.close();
      await draining;
    },
  };
}

async function submit(
  wired: Wiring,
  request: Submission,
): Promise<OperationOutcome> {
  const admission = wired.projectionPort.submit(request);
  assert.ok(admission.admitted, JSON.stringify(admission));
  return awaitSettled(wired.projectionPort, request.operationId);
}

function answerGate(
  run: RunView,
  operationId: string,
  answer: { readonly answer: "continue" } | { readonly text: string },
): Submission {
  const gate = requireOffer(run, "answer-human-gate")?.gate;
  assert.ok(gate, JSON.stringify(run.actionOffers));
  return {
    operationId,
    operation: "answer-human-gate",
    input: { runId: run.runId, gate, ...answer },
  };
}

function interactiveControl(
  run: RunView,
  operationId: string,
  operation: "end-interactive-step" | "continue-repeat" | "end-stage",
  stepId: string,
): Submission {
  return { operationId, operation, input: { runId: run.runId, stepId } };
}

/** The refused drive's shared contract: the Operation and the Run carry the same
 *  selected-Harness Problem, the Run rests halted and resumable with ownership
 *  released, no Turn or Command started after the refusal, the launch Harness
 *  closed exactly once, and an open observer saw the halted Problem. */
async function assertRefusedDrive(
  launched: Launched,
  outcome: OperationOutcome,
  before: { readonly turns: number; readonly commands: number },
  observed: ReturnType<typeof observe>,
): Promise<RunView> {
  const { wired, runId, evidence } = launched;
  assert.equal(outcome.status, "not-applied", JSON.stringify(outcome));
  if (outcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(outcome.problem.code, "selected-harness-unavailable");
  assert.equal(outcome.problem.details?.harness, "claude-code");
  assert.equal(outcome.problem.details?.category, "protocol-incompatible");
  assert.equal(outcome.problem.details?.nativeCode, "not-qualified");
  assert.equal(outcome.problem.possibleEffects, "none");

  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "halted");
  assert.equal(run.problem?.code, "selected-harness-unavailable");
  assert.equal(run.liveness.state, "not-live");
  const resume = requireOffer(run, "resume-run");
  assert.ok(resume.available, JSON.stringify(run.actionOffers));
  assert.equal(findOffer(run, "answer-human-gate"), undefined);
  assert.equal(findOffer(run, "end-interactive-step"), undefined);
  assert.equal(
    wired.runGroup.listRuns().find((entry) => entry.runId === runId)?.live,
    false,
    "the refused drive releases ownership",
  );

  assert.equal(evidence.prepares, 2);
  assert.equal(evidence.closes, 1, "no prepared Harness is left open");
  assert.equal(
    evidence.turns,
    before.turns,
    "no Turn starts after the refusal",
  );
  assert.equal(
    evidence.commands,
    before.commands,
    "no Command starts after the refusal",
  );

  await observed.close();
  const halted = observed.pushed
    .map((snapshot) =>
      snapshot.result.found ? snapshot.result.run : undefined,
    )
    .find((view) => view?.state === "halted");
  assert.ok(halted, "an open observer receives the halted snapshot");
  assert.equal(halted.problem?.code, "selected-harness-unavailable");
  return run;
}

function stepStatuses(run: RunView): [string, string][] {
  return run.progress.map((step) => [step.id, step.status]);
}

/** Resume the halted Run once the Harness prepares again. */
async function resume(launched: Launched): Promise<RunView> {
  const outcome = await submit(launched.wired, {
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId: launched.runId },
  });
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  assert.equal(launched.evidence.prepares, 3);
  return readRun(launched.wired.projectionPort, launched.runId);
}

test("[continuation-preparation-failure] an approved authored Gate halts on a refused preparation and keeps the approval", async (t) => {
  const launched = await launchBlocked(t, ROUTINGS.approveGate);
  const before = { ...launched.evidence };
  const observed = observe(launched.wired, launched.runId);
  const request = answerGate(launched.run, "op-approve-gate", {
    answer: "continue",
  });
  const outcome = await submit(launched.wired, request);
  const halted = await assertRefusedDrive(launched, outcome, before, observed);
  assert.deepEqual(stepStatuses(halted), [
    ["before", "succeeded"],
    ["gate", "succeeded"],
    ["work", "blocked"],
  ]);
  // The same Operation id replays the recorded refusal and changes nothing.
  assert.deepEqual(await submit(launched.wired, request), outcome);
  assert.equal(launched.evidence.prepares, 2);

  const resumed = await resume(launched);
  assert.equal(resumed.state, "succeeded");
  assert.deepEqual(stepStatuses(resumed), [
    ["before", "succeeded"],
    ["gate", "succeeded"],
    ["work", "succeeded"],
  ]);
  assert.equal(launched.evidence.commands, before.commands, "before ran once");
});

test("[continuation-preparation-failure] a free-text Gate answer stays published and bound after a refused preparation", async (t) => {
  const launched = await launchBlocked(t, ROUTINGS.freeTextGate);
  const before = { ...launched.evidence };
  const observed = observe(launched.wired, launched.runId);
  const outcome = await submit(
    launched.wired,
    answerGate(launched.run, "op-text-gate", { text: "v2.0.0" }),
  );
  const halted = await assertRefusedDrive(launched, outcome, before, observed);
  assert.deepEqual(stepStatuses(halted), [
    ["before", "succeeded"],
    ["gate", "succeeded"],
    ["work", "blocked"],
  ]);
  assert.equal(
    halted.outputs.filter((output) => output.name === "answer").length,
    1,
    "the answer is published before preparation",
  );

  const resumed = await resume(launched);
  assert.equal(resumed.state, "succeeded");
  assert.equal(
    resumed.outputs.filter((output) => output.name === "answer").length,
    1,
    "the answer is published exactly once",
  );
});

test("[continuation-preparation-failure] a derived Review-checkpoint Continue keeps its recorded grant after a refused preparation", async (t) => {
  const launched = await launchBlocked(t, ROUTINGS.checkpoint);
  assert.ok(launched.run.checkpoint, "the Run rests at a derived checkpoint");
  const before = { ...launched.evidence };
  const observed = observe(launched.wired, launched.runId);
  const outcome = await submit(
    launched.wired,
    answerGate(launched.run, "op-checkpoint", { answer: "continue" }),
  );
  const halted = await assertRefusedDrive(launched, outcome, before, observed);
  assert.equal(halted.checkpoint, undefined, "the grant is recorded");

  // Resume honours the one recorded grant: one more interval, then the checkpoint.
  const resumed = await resume(launched);
  assert.equal(resumed.state, "blocked");
  assert.ok(resumed.checkpoint);
  assert.equal(launched.evidence.commands, before.commands + 1);
  const owner = launched.wired.runGroup.acquireRun(launched.runId);
  assert.ok(owner);
  try {
    assert.equal(owner.gateAnswers().length, 1);
  } finally {
    owner.close();
  }
});

test("[continuation-preparation-failure] End Step keeps the settled interactive Attempt after a refused preparation", async (t) => {
  const launched = await launchBlocked(t, ROUTINGS.interactive);
  const before = { ...launched.evidence };
  const observed = observe(launched.wired, launched.runId);
  const outcome = await submit(
    launched.wired,
    interactiveControl(
      launched.run,
      "op-end",
      "end-interactive-step",
      "discuss",
    ),
  );
  const halted = await assertRefusedDrive(launched, outcome, before, observed);
  assert.deepEqual(stepStatuses(halted), [
    ["discuss", "succeeded"],
    ["work", "blocked"],
  ]);

  const resumed = await resume(launched);
  assert.equal(resumed.state, "succeeded");
  assert.equal(launched.evidence.turns, 1, "only the following Agent Turn ran");
});

test("[continuation-preparation-failure] Continue keeps the settled iteration after a refused preparation", async (t) => {
  const launched = await launchBlocked(t, ROUTINGS.humanRepeat);
  const before = { ...launched.evidence };
  const observed = observe(launched.wired, launched.runId);
  const outcome = await submit(
    launched.wired,
    interactiveControl(
      launched.run,
      "op-continue",
      "continue-repeat",
      "implement",
    ),
  );
  await assertRefusedDrive(launched, outcome, before, observed);

  // Resume opens exactly the next iteration: one settled, the second blocked.
  const resumed = await resume(launched);
  assert.equal(resumed.state, "blocked");
  assert.ok(requireOffer(resumed, "continue-repeat"));
  const owner = launched.wired.runGroup.acquireRun(launched.runId);
  assert.ok(owner);
  try {
    assert.deepEqual(
      owner.attemptLog().map((entry) => [entry.attemptId, entry.outcome]),
      [["0.0:implement", "succeeded"]],
    );
  } finally {
    owner.close();
  }
});

test("[continuation-preparation-failure] End Stage keeps its Stage mark after a refused preparation", async (t) => {
  const launched = await launchBlocked(t, ROUTINGS.humanRepeat);
  const before = { ...launched.evidence };
  const observed = observe(launched.wired, launched.runId);
  const outcome = await submit(
    launched.wired,
    interactiveControl(launched.run, "op-end-stage", "end-stage", "implement"),
  );
  const halted = await assertRefusedDrive(launched, outcome, before, observed);
  assert.deepEqual(stepStatuses(halted), [
    ["implement", "succeeded"],
    ["work", "blocked"],
  ]);

  const resumed = await resume(launched);
  assert.equal(resumed.state, "succeeded");
  assert.equal(resumed.completion, "human-declared");
  assert.equal(launched.evidence.turns, 1, "only the following Agent Turn ran");
});

test("[continuation-preparation-failure] a stale fenced owner cannot rest a replacement owner's Run halted", async (t) => {
  let replacement: ReturnType<Wiring["runGroup"]["acquireRun"]>;
  const launched = await launchBlocked(t, ROUTINGS.approveGate, {
    // Another owner fences the answering one while its preparation is refused.
    onRefuse: (runId, wired) => {
      replacement = wired.runGroup.acquireRun(runId, { takeover: true });
    },
  });
  const observed = observe(launched.wired, launched.runId);
  const outcome = await submit(
    launched.wired,
    answerGate(launched.run, "op-fenced", { answer: "continue" }),
  );
  assert.ok(replacement);
  try {
    assert.equal(outcome.status, "not-applied");
    if (outcome.status !== "not-applied") throw new Error("unreachable");
    assert.equal(outcome.problem.code, "selected-harness-unavailable");
    // The stale drive publishes neither its halted rest nor its Problem.
    await observed.close();
    const views = observed.pushed.flatMap((snapshot) =>
      snapshot.result.found ? [snapshot.result.run] : [],
    );
    assert.ok(views.length > 0);
    assert.ok(views.every((view) => view.state !== "halted"));
    assert.ok(views.every((view) => view.problem === undefined));
    // The approval committed before preparation stays; the rest is the
    // replacement owner's to write, not the fenced drive's.
    const stored = launched.wired.runGroup.readRun(launched.runId);
    assert.ok(stored.ok);
    assert.equal(stored.run.state, "running");
  } finally {
    replacement.release();
    replacement.close();
  }
});
