import { findOffer, readRun, requireOffer } from "./run-test-helpers.js";

import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ProjectionPort } from "../../src/application/projection-port.js";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
} from "../../src/harness/harness.js";
import type { FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled, followRun } from "../helpers/settleOperation.js";
import {
  COMPLETED_DETACHED,
  FAULT,
  INTERRUPTIBLE_TURN,
  launchInteractive,
  scriptedAdapter,
  writeInteractiveBundle,
} from "./interactive-agent-fixture.js";

// M11 slice 1 (#528, spec #527 decisions 20 and 21): Secant faults after a Turn
// was admitted. Before this slice a launch or resume left the Run `running` with
// no owner, which no restart repaired and resume refused, and an interactive send
// kept it `running`. Each drive now rests the Run `halted` with its cause.

const LOST: FakeScript["turns"][number] = {
  result: {
    kind: "lost",
    detail: {
      unknown: "completion",
      lastObservation: "transport closed",
      session: { state: "detached", coordinate: { opaque: "coord-lost" } },
    },
  },
};

const AGENT_ROUTING: readonly unknown[] = [
  {
    id: "apply",
    kind: "agent",
    session: "s",
    prompt: { asset: "prompts/apply.md" },
  },
];

interface AgentRun {
  readonly runId: string;
  readonly port: () => ProjectionPort;
  readonly wired: () => Wiring;
  /** Stand in for a crash and restart: drop this process's handles without a
   *  shutdown, then open the same home, whose startup reconciliation runs. */
  readonly restart: () => void;
}

/** Wire an Application over a fresh home and launch a one-Agent-Step Run. */
async function launchAgent(
  t: TestContext,
  adapter: (wired: () => Wiring) => HarnessAdapter,
  /** Drives the launch before its settlement is awaited. */
  whileLaunching?: (port: ProjectionPort, runId: string) => Promise<void>,
): Promise<
  AgentRun & { readonly launched: Awaited<ReturnType<typeof awaitSettled>> }
> {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const workspace = makeTempDir("secant-fault-rest-ws-");
  const home = makeTempDir("secant-fault-rest-home-");
  const current = (): Wiring => wired;
  const options = {
    secantHome: home,
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    harnessAdapter: adapter(current),
    process: createFakeBundleProcess({ executables: [process.execPath] }),
  } satisfies Parameters<typeof wireApplication>[0];
  let wired = wireApplication(options);
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const bundle = writeInteractiveBundle(AGENT_ROUTING);
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
  const runId = admission.runId!;
  await whileLaunching?.(wired.projectionPort, runId);
  const launched = await awaitSettled(wired.projectionPort, "op-launch");
  return {
    runId,
    launched,
    port: () => wired.projectionPort,
    wired: current,
    restart: () => {
      wired.runGroup.close();
      wired.catalog.close();
      wired = wireApplication(options);
    },
  };
}

async function resume(port: ProjectionPort, runId: string, id: string) {
  const admission = port.submit({
    operationId: id,
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  return awaitSettled(port, id);
}

/** The halted rest every faulting drive now reaches: owner released, resume
 *  offered, and the stored cause read back with its diagnostic. */
function assertFaultRest(port: ProjectionPort, runId: string): void {
  const run = readRun(port, runId);
  assert.equal(run.state, "halted", JSON.stringify(run));
  assert.deepEqual(run.liveness, { state: "not-live" });
  assert.equal(requireOffer(run, "resume-run").available, true);
  const cause = run.restingCause;
  assert.equal(cause?.code, "execution-fault", JSON.stringify(cause));
  assert.equal(
    cause.explanation,
    "Secant hit an internal error. It may have changed files before it stopped.",
  );
  assert.equal(
    cause.nextStep,
    "Resume the Run to try again. If it happens again, open the details section for the cause.",
  );
  assert.equal(cause.possibleEffects, "unknown");
  assert.ok(cause.diagnostic);
  const diagnostic = port.readResource(cause.diagnostic);
  assert.ok(diagnostic.found, JSON.stringify(diagnostic));
  assert.match(
    diagnostic.content,
    new RegExp(
      `^Kind: execution-fault\\n\\nCause: Error\\nMessage: ${FAULT}\\nStack:\\n`,
    ),
  );
}

test("m11-execution-fault-rest: a launch that faults after an admitted Turn rests halted and stays resumable after a restart", async (t) => {
  const run = await launchAgent(t, () =>
    scriptedAdapter([
      { turns: [COMPLETED_DETACHED], fault: true },
      { turns: [COMPLETED_DETACHED] },
    ]),
  );
  // The Operation still carries its transient Problem.
  assert.equal(run.launched.status, "not-applied");
  if (run.launched.status === "not-applied") {
    assert.equal(run.launched.problem.code, "run-execution-fault");
  }
  assertFaultRest(run.port(), run.runId);

  run.restart();
  assertFaultRest(run.port(), run.runId);
  assert.equal(
    (await resume(run.port(), run.runId, "op-resume")).status,
    "applied",
  );
  const succeeded = readRun(run.port(), run.runId);
  assert.equal(succeeded.state, "succeeded");
  assert.equal(succeeded.restingCause, undefined);
});

test("m11-execution-fault-rest: a resume that faults after an admitted Turn rests halted again", async (t) => {
  const run = await launchAgent(t, () =>
    scriptedAdapter([
      { turns: [LOST] },
      { turns: [COMPLETED_DETACHED], fault: true },
    ]),
  );
  assert.equal(run.launched.status, "applied");
  // A lost Turn's halt records no cause until a later M11 slice: it reads unknown.
  const lost = readRun(run.port(), run.runId);
  assert.equal(lost.state, "halted");
  assert.deepEqual(lost.restingCause, {
    code: "unknown",
    explanation: "This Step failed for unknown reasons.",
    nextStep: "Resume the Run to try again, or delete it.",
  });

  const resumed = await resume(run.port(), run.runId, "op-resume");
  assert.equal(resumed.status, "not-applied");
  if (resumed.status === "not-applied") {
    assert.equal(resumed.problem.code, "run-execution-fault");
  }
  assertFaultRest(run.port(), run.runId);

  run.restart();
  assertFaultRest(run.port(), run.runId);
});

test("m11-execution-fault-rest: an interactive send that faults after admission rests halted and releases its owner", async (t) => {
  const { wired, runId } = await launchInteractive(
    t,
    scriptedAdapter([{ turns: [COMPLETED_DETACHED], fault: true }]),
  );
  const sent = wired.projectionPort.submit({
    operationId: "op-send-faults",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "go" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  // Admission already settled the send; the fault reaches the Run.
  assert.equal(
    (await awaitSettled(wired.projectionPort, sent.operationId)).status,
    "applied",
  );
  // The halted rest is pushed first; the send's transient Problem follows it.
  const rested = await followRun(wired.projectionPort, runId, (run) =>
    run.problem !== undefined ? run : undefined,
  );
  // The pushed snapshot already carries the cause: open clients refresh.
  assert.equal(rested.state, "halted");
  assert.equal(rested.restingCause?.code, "execution-fault");
  assert.equal(rested.problem?.code, "run-execution-fault");
  assertFaultRest(wired.projectionPort, runId);
});

test("m11-execution-fault-rest: a follow-up that faults after admission rests halted and releases its owner", async (t) => {
  const run = await launchAgent(
    t,
    () =>
      scriptedAdapter([
        {
          turns: [INTERRUPTIBLE_TURN, COMPLETED_DETACHED],
          fault: true,
          faultFrom: 1,
        },
      ]),
    // The launch drive's Agent Turn works until it is interrupted, leaving the
    // Step waiting on the person's follow-up.
    async (port, runId) => {
      const live = await followRun(port, runId, (view) =>
        findOffer(view, "interrupt-turn"),
      );
      assert.ok(
        port.submit({
          operationId: "op-interrupt",
          operation: "interrupt-turn",
          input: { runId, turnId: live.turnId },
        }).admitted,
      );
    },
  );
  assert.equal(run.launched.status, "applied");
  const port = run.port();
  const offer = requireOffer(readRun(port, run.runId), "send-follow-up-turn");
  const sent = port.submit({
    operationId: "op-follow-up",
    operation: "send-follow-up-turn",
    input: { runId: run.runId, turnId: offer.turnId, text: "carry on" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  assert.equal((await awaitSettled(port, "op-follow-up")).status, "applied");
  const rested = await followRun(port, run.runId, (view) =>
    view.problem !== undefined ? view : undefined,
  );
  assert.equal(rested.problem?.code, "run-execution-fault");
  assertFaultRest(port, run.runId);
});

test("m11-execution-fault-rest: a halting write that fails keeps the owner, and the restart rests the Run", async (t) => {
  const run = await launchAgent(t, (wired) =>
    scriptedAdapter(
      [
        { turns: [COMPLETED_DETACHED], fault: true },
        { turns: [COMPLETED_DETACHED] },
      ],
      // Fence the executing owner, so the drive's halting write is refused.
      () => {
        const group = wired().runGroup;
        const [only] = group.listRuns();
        assert.ok(only);
        group.acquireRun(only.runId)?.close();
      },
    ),
  );
  assert.equal(run.launched.status, "not-applied");
  // The fenced drive kept its claim: the Run is still owned by this process.
  const held = readRun(run.port(), run.runId);
  assert.equal(held.state, "running");
  assert.equal(held.liveness.state, "live-here");
  assert.equal(findOffer(held, "resume-run"), undefined);
  assert.equal(held.restingCause, undefined);

  // The next start's reconciliation rests it with the crash cause.
  run.restart();
  const rested = readRun(run.port(), run.runId);
  assert.equal(rested.state, "halted");
  assert.deepEqual(rested.liveness, { state: "not-live" });
  assert.equal(requireOffer(rested, "resume-run").available, true);
  assert.deepEqual(rested.restingCause, {
    code: "secant-stopped",
    explanation:
      "Secant stopped while this Step was running, so whether the Step finished is unknown. It may have changed files before it stopped.",
    nextStep: "Resume the Run to continue.",
    possibleEffects: "unknown",
  });
});

test("m11-execution-fault-rest: a fault before the walk writes running keeps today's rest", async (t) => {
  const run = await launchAgent(t, () =>
    ownPreparations({
      prepare() {
        throw new Error("scripted fault while preparing the Harness");
      },
    }),
  );
  assert.equal(run.launched.status, "not-applied");
  if (run.launched.status === "not-applied") {
    assert.equal(run.launched.problem.code, "run-execution-fault");
  }
  // The record still reads `created`, which the Projection shows as `running`:
  // nothing rested it, and resume is not offered (decision 20 keeps this).
  const created = readRun(run.port(), run.runId);
  assert.equal(created.state, "running");
  assert.deepEqual(created.liveness, { state: "not-live" });
  assert.equal(findOffer(created, "resume-run"), undefined);
  assert.equal(created.restingCause, undefined);
});
