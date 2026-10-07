import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import { createApplication } from "../helpers/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import type { TurnResult } from "../../src/harness/harness.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import type {
  ProjectionPort,
  ProjectionUpdate,
  RunLiveOverlay,
  RunSnapshot,
} from "../../src/application/projection-port.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
} from "../harness/fake-adapter.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  createFakeGitProcess,
  openFakeRunGroup as openRunGroup,
} from "../run/store/fake-git-process.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { usageEvents, UNREAD_UPDATE_BOUND } from "../helpers/liveRun.js";
import { hostPlatform, writeCommandBundle } from "../helpers/commandBundle.js";

// #117 AC2: through the Port, the live overlay of a Run executing an Agent Turn
// shows the outstanding approval request with decisions `allow`/`deny` and a
// generation; answering with the current offer is accepted (the Operation is
// applied); answering with a stale generation or an expired id is rejected with the
// precise Problem; and the overlay clears the request when the Turn ends. Driven
// straight against the Projection Port (no headless follower) so the request stays
// outstanding to observe and answer by hand — against the deterministic fake Claude
// Code Harness and an injected fake Process, so no child spawns (#184).

/** The fake Claude Code profile: it hosts a permission bridge, so an Agent Turn can
 *  raise an approval Harness Request. */
// Every Agent-bearing launch names its Model choice (ADR 0034); the fake selects
// no model, so any name is admitted.
const FAKE_MODEL = "fake-model";

const COMPLETED_OPEN: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: "repaired the workspace",
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

/** The single-Turn script the live-overlay case drives: one awaited Edit approval
 *  request holds the Turn open until it is answered, then the Turn completes. */
function overlayScript(): FakeScript {
  return {
    profile: fakeHarnessProfile({
      executable: "claude",
      executableVersion: "2.1.273",
      adapterRevision: "fake-claude-1",
      recovery: {
        mode: "native-reattach",
        evidence: "fake claude resumes by id",
      },
      interruption: {
        mode: "process-only",
        evidence: "fake claude stops the process",
      },
      approvals: {
        available: true,
        evidence: "fake claude hosts a permission bridge",
      },
      clarifications: {
        available: false,
        evidence: "fake claude offers no clarifications",
      },
      steer: {
        available: false,
        evidence: "fake claude has no same-Turn guidance frame",
      },
      modelSelection: {
        at: "unavailable",
        evidence: "fake claude selects no model",
      },
      modelObservation: {
        available: true,
        evidence: "fake claude observes its own model",
      },
      recoveryCoordinate: {
        timing: "before-submission",
        evidence: "fake claude mints a session id",
      },
      skillDelivery: {
        mode: "plain-path",
        evidence: "fake claude reads a SKILL.md path",
      },
      fileDelivery: {
        mode: "plain-path",
        evidence: "fake claude reads an absolute path",
      },
    }),
    turns: [
      {
        requests: [
          {
            id: "req-edit",
            shape: {
              kind: "approval",
              tool: "Edit",
              input: "change file",
              decisions: ["allow", "deny"],
            },
            awaited: true,
          },
        ],
        result: COMPLETED_OPEN,
      },
    ],
  };
}

/** A fake Process that resolves any executable and reaches no real child; Git store
 *  operations run through the deterministic fake Git process. */
function fakeProcess(): ProcessAdapter {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: () => ({
      kind: "exited",
      status: 0,
      text: new Uint8Array(),
    }),
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => git.spawnCommandSync(options),
  };
}

function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-ovl-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "fix.md"), "Repair the workspace.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.ovl-e2e",
      version: "1.0.0",
      name: "Overlay E2E",
      description: "A single Agent Step Bundle for the live-overlay slice.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/fix.md", kind: "prompt" }],
    routing: [
      {
        id: "fix",
        kind: "agent",
        session: "s",
        prompt: { asset: "prompts/fix.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

function wire(
  t: TestContext,
  script: FakeScript = overlayScript(),
): {
  wired: Wiring;
  bundleId: string;
  digest: string;
} {
  const workspace = makeTempDir("secant-ovl-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-ovl-home-"),
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: createFake(script)(),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "claude",
        description: "PATH name 'claude'",
      },
    }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeAgentBundle();
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);
  const approve = wired.projectionPort.submit({
    operationId: "op-approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approve.admitted);
  return { wired, bundleId: bundle.id, digest: entry.digest };
}

/** Await the next live overlay on the stream that matches `predicate`. The Run's
 *  update stream is single-consumer, so these are called sequentially. */
async function nextOverlay(
  updates: AsyncIterable<ProjectionUpdate<RunSnapshot>>,
  predicate: (overlay: RunLiveOverlay) => boolean,
): Promise<RunLiveOverlay> {
  for await (const update of updates) {
    if (update.kind === "live" && predicate(update.overlay)) {
      return update.overlay;
    }
  }
  throw new Error("the run stream closed before a matching live overlay");
}

test("the live overlay shows the outstanding request; answering is accepted, stale/expired are rejected, and the overlay clears (#117 AC2)", async (t) => {
  const { wired, bundleId, digest } = wire(t);
  const port: ProjectionPort = wired.projectionPort;

  // Launch directly through the Port (no headless follower answers), so the Edit
  // approval stays outstanding for us to observe and answer by hand.
  const admission = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundleId },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: FAKE_MODEL,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId!;

  const opened = port.openProjection({ family: "run", runId });
  try {
    // The overlay carrying the outstanding approval, once the Turn raises it.
    const raised = await nextOverlay(
      opened.updates,
      (overlay) => overlay.outstanding.length > 0,
    );
    assert.equal(raised.outstanding.length, 1);
    const request = raised.outstanding[0]!;
    assert.equal(request.tool, "Edit");
    assert.deepEqual([...request.decisions], ["allow", "deny"]);
    assert.ok(raised.generation > 0);
    assert.equal(raised.phase, "awaiting-approval");
    // The answer Offer carries the live generation and names the ephemeral basis.
    assert.equal(raised.offers.length, 1);
    assert.equal(raised.offers[0]!.requestId, request.requestId);
    assert.equal(raised.offers[0]!.generation, raised.generation);
    assert.equal(raised.offers[0]!.basis, "ephemeral Harness Request");

    // An expired id (a request that is not outstanding) is rejected precisely,
    // answering nothing — the real request stays outstanding.
    const expired = port.submit({
      operationId: "op-expired",
      operation: "answer-harness-request",
      input: {
        runId,
        requestId: "not-a-real-request",
        generation: raised.generation,
        decision: "allow",
        by: "human",
      },
    });
    assert.ok(expired.admitted);
    const expiredOutcome = await awaitSettled(port, "op-expired");
    assert.equal(expiredOutcome.status, "not-applied");
    if (expiredOutcome.status === "not-applied") {
      assert.equal(expiredOutcome.problem.code, "harness-request-expired");
    }

    // A stale generation (the real request, an older generation) is rejected
    // precisely, answering nothing.
    const stale = port.submit({
      operationId: "op-stale",
      operation: "answer-harness-request",
      input: {
        runId,
        requestId: request.requestId,
        generation: raised.generation + 1,
        decision: "allow",
        by: "human",
      },
    });
    assert.ok(stale.admitted);
    const staleOutcome = await awaitSettled(port, "op-stale");
    assert.equal(staleOutcome.status, "not-applied");
    if (staleOutcome.status === "not-applied") {
      assert.equal(staleOutcome.problem.code, "harness-request-stale");
    }

    // Answering with the current offer is accepted (the Operation is applied) and
    // unblocks the Turn.
    const answer = port.submit({
      operationId: "op-answer",
      operation: "answer-harness-request",
      input: {
        runId,
        requestId: request.requestId,
        generation: raised.generation,
        decision: "allow",
        by: "human",
      },
    });
    assert.ok(answer.admitted);
    const answerOutcome = await awaitSettled(port, "op-answer");
    assert.equal(
      answerOutcome.status,
      "applied",
      JSON.stringify(answerOutcome),
    );

    // The overlay clears the request when the Turn moves on (a later generation).
    const cleared = await nextOverlay(
      opened.updates,
      (overlay) => overlay.outstanding.length === 0,
    );
    assert.ok(cleared.generation > raised.generation);
  } finally {
    opened.close();
  }

  // The launch settles once the answered Turn runs to completion.
  const outcome = await awaitSettled(port, "op-launch");
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  const final = port.openProjection({ family: "run", runId });
  try {
    assert.ok(final.snapshot.result.found);
    if (final.snapshot.result.found) {
      assert.equal(final.snapshot.result.run.state, "succeeded");
    }
  } finally {
    final.close();
  }
});

test("an indeterminate request-answer receipt settles not-applied with unknown effects (#134 A20)", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-indeterminate-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(
    makeTempDir("secant-indeterminate-workspace-"),
  );
  const runGroup = openRunGroup(
    makeTempDir("secant-indeterminate-store-"),
    workspace,
  );
  t.after(() => runGroup.close());
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const app = createApplication({
    catalog,
    process: fakeProcess(),
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: async ({ owner, requestChannel }) => {
      owner.writeState("running");
      assert.ok(requestChannel);
      requestChannel.bindAnswer(async () => ({ outcome: "indeterminate" }));
      requestChannel.raised({
        requestId: "request-unknown",
        tool: "Edit",
        input: "change file",
        decisions: ["allow", "deny"],
      });
      await finished;
      requestChannel.settled("request-unknown");
      requestChannel.bindAnswer(undefined);
      owner.writeState("succeeded");
      return { outcome: "succeeded" };
    },
  });
  const bundle = writeCommandBundle({ id: "dev.secant.indeterminate" });
  assert.ok(app.bundleManagement.build(bundle.folder, { noInstall: false }).ok);
  const entry = catalog.listEntries().find((item) => item.id === bundle.id)!;
  catalog.approveWorkspace(workspace, new Date());
  const launched = app.projectionPort.submit({
    operationId: "launch-indeterminate",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(launched.admitted, JSON.stringify(launched));

  const opened = app.projectionPort.openProjection({
    family: "run",
    runId: launched.runId!,
  });
  const raised = await nextOverlay(
    opened.updates,
    (overlay) => overlay.outstanding.length === 1,
  );
  const answer = app.projectionPort.submit({
    operationId: "answer-indeterminate",
    operation: "answer-harness-request",
    input: {
      runId: launched.runId!,
      requestId: "request-unknown",
      generation: raised.generation,
      decision: "allow",
      by: "human",
    },
  });
  assert.ok(answer.admitted);
  const outcome = await awaitSettled(app.projectionPort, answer.operationId);
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "harness-request-indeterminate");
    assert.equal(outcome.problem.possibleEffects, "unknown");
    assert.match(
      outcome.problem.remediation,
      /may or may not have been answered/,
    );
  }

  finish();
  await awaitSettled(app.projectionPort, launched.operationId);
  opened.close();
});

test("a slow Run observer ends observer-lagged while a healthy one follows the same Turn; the Run continues and a reopen sees current truth (#306)", async (t) => {
  // More previews than any one subscription retains unread.
  const previews = UNREAD_UPDATE_BOUND + 50;
  const healthyPreviews: string[] = [];
  const previewWaiters: (() => void)[] = [];
  let observersOpen!: () => void;
  const opened = new Promise<void>((resolve) => {
    observersOpen = resolve;
  });
  // Emit each preview only once the healthy observer read the one before it, so
  // the healthy backlog stays near-empty while the slow observer never reads.
  const healthyRead = (count: number): Promise<void> =>
    healthyPreviews.length >= count
      ? Promise.resolve()
      : new Promise((resolve) => previewWaiters.push(resolve));
  const script = overlayScript();
  const turn = script.turns[0]!;
  const { wired, bundleId, digest } = wire(t, {
    ...script,
    turns: [
      {
        ...turn,
        events: usageEvents(previews),
        pace: async (index) => {
          await opened;
          await healthyRead(index);
        },
      },
    ],
  });
  const port: ProjectionPort = wired.projectionPort;
  const admission = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundleId },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: FAKE_MODEL,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId!;

  const slow = port.openProjection({ family: "run", runId });
  t.after(() => slow.close());
  const healthy = port.openProjection({ family: "run", runId });
  t.after(() => healthy.close());
  let raisedOnHealthy!: (overlay: RunLiveOverlay) => void;
  const healthyRaised = new Promise<RunLiveOverlay>((resolve) => {
    raisedOnHealthy = resolve;
  });
  const healthyEnded = (async () => {
    for await (const update of healthy.updates) {
      if (
        update.kind === "live" &&
        update.overlay.usage !== undefined &&
        healthyPreviews.at(-1) !== update.overlay.usage
      ) {
        healthyPreviews.push(update.overlay.usage!);
        while (previewWaiters.length > 0) previewWaiters.shift()?.();
      }
      if (update.kind === "live" && update.overlay.outstanding.length) {
        raisedOnHealthy(update.overlay);
      } else if (update.kind === "closed") {
        return update.reason;
      }
    }
    return "done";
  })();
  observersOpen();

  // The healthy observer followed every preview in order and reached the request.
  const raised = await healthyRaised;
  assert.equal(healthyPreviews.length, previews);
  assert.deepEqual(
    healthyPreviews,
    Array.from({ length: previews }, (_, index) => `p${index}`),
  );
  assert.equal(raised.outstanding[0]?.requestId, "req-edit");

  // The slow observer, which never read, ends observer-lagged and completes.
  const slowUpdates = slow.updates[Symbol.asyncIterator]();
  assert.deepEqual(await slowUpdates.next(), {
    done: false,
    value: { kind: "closed", reason: "observer-lagged" },
  });
  assert.deepEqual(await slowUpdates.next(), { done: true, value: undefined });
  slow.close();

  // Reopening reads canonical truth (the Run is still running) and the current
  // live overlay: the outstanding request and the latest preview.
  const reopened = port.openProjection({ family: "run", runId });
  t.after(() => reopened.close());
  assert.ok(reopened.snapshot.result.found);
  if (reopened.snapshot.result.found) {
    assert.equal(reopened.snapshot.result.run.state, "running");
  }
  const current = await nextOverlay(reopened.updates, () => true);
  assert.equal(current.generation, raised.generation);
  assert.deepEqual(
    current.outstanding.map((request) => request.requestId),
    ["req-edit"],
  );
  assert.equal(current.usage, `p${previews - 1}`);

  // The reopened Offer still answers the live Turn, and the Run rests succeeded.
  const offer = current.offers[0]!;
  const answer = port.submit({
    operationId: "op-answer",
    operation: "answer-harness-request",
    input: {
      runId,
      requestId: offer.requestId,
      generation: offer.generation,
      decision: "allow",
      by: "human",
    },
  });
  assert.ok(answer.admitted);
  assert.equal((await awaitSettled(port, "op-answer")).status, "applied");
  const outcome = await awaitSettled(port, "op-launch");
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  healthy.close();
  assert.equal(await healthyEnded, "done");
  const final = port.openProjection({ family: "run", runId });
  try {
    assert.ok(final.snapshot.result.found);
    if (final.snapshot.result.found) {
      assert.equal(final.snapshot.result.run.state, "succeeded");
    }
  } finally {
    final.close();
  }
});
