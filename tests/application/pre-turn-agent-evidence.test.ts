import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  launch,
  receiptAgent,
  writeBundle,
  refusedPromptBundle,
} from "./agent-receipt-fixture.js";
import { readRun } from "./run-test-helpers.js";
import { fakeHarnessProfile } from "../harness/fake-adapter.js";
import { wireApplication } from "../../src/composition/main.js";
import { storedProcess } from "../helpers/wiringDoubles.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import type { RunView } from "../../src/application/projection-port.js";
import { awaitSettled, followRun } from "../helpers/settleOperation.js";

for (const kind of ["agent", "interactive-agent"] as const) {
  test(`m11-pre-turn-agent-evidence: a refused ${kind} prompt projects in Workflow order and retains its diagnostic`, async (t) => {
    const bundle = refusedPromptBundle(kind);
    const agent = receiptAgent(["/MODEL unsafe"]);
    let pushed: Promise<RunView> | undefined;
    const { wired, runId } = await launch(
      t,
      agent.adapter,
      bundle,
      true,
      (wiring, id) => {
        pushed = followRun(wiring.projectionPort, id, (run) =>
          run.timeline.some(
            (e) =>
              e.failure !== undefined &&
              "code" in e.failure &&
              e.failure.code === "prompt-refused",
          )
            ? run
            : undefined,
        );
      },
    );
    const run = readRun(wired.projectionPort, runId);
    assert.equal(run.state, kind === "agent" ? "failed" : "blocked");
    assert.ok(pushed);
    const pushedFailure = (await pushed).timeline.at(-1)?.failure;
    assert.ok(pushedFailure && "explanation" in pushedFailure);
    assert.equal(pushedFailure.code, "prompt-refused");
    assert.equal(agent.inputs.length, 1);
    const failed = run.timeline.find((event) => event.step === "tickets");
    assert.equal(
      failed?.event,
      kind === "agent" ? "attempt-settled" : "attempt-failure",
    );
    assert.ok(failed?.failure && "explanation" in failed.failure);
    assert.equal(failed?.failure?.code, "prompt-refused");
    assert.equal(failed.failure.source, "agent");
    assert.equal(failed.failure.possibleEffects, "none");
    assert.equal(
      failed.failure.explanation,
      "Secant did not send the prompt because it starts with a word the Harness reserves.",
    );
    assert.equal(
      failed.failure.nextStep,
      "Fix the Bundle prompt or choose another Harness.",
    );
    assert.ok(
      run.timeline.indexOf(failed) >
        run.timeline.findIndex(
          (event) =>
            event.event === "attempt-settled" && event.step === "publish",
        ),
    );
    assert.ok(failed.failure.diagnostic);
    const read = wired.projectionPort.readResource(failed.failure.diagnostic);
    assert.ok(read.found);
    assert.match(read.content, /starts with "\/model"/);
    assert.doesNotMatch(read.content, /unsafe|Publish the spec/);
    if (kind === "interactive-agent") {
      const end = wired.projectionPort.submit({
        operationId: "op-end-entry",
        operation: "end-interactive-step",
        input: { runId, stepId: "tickets" },
      });
      assert.ok(end.admitted, JSON.stringify(end));
      await awaitSettled(wired.projectionPort, "op-end-entry");
      const ended = readRun(wired.projectionPort, runId);
      assert.equal(ended.state, "succeeded");
      assert.equal(
        ended.timeline.filter((event) => event.event === "attempt-failure")
          .length,
        0,
      );
      const settledOwner = wired.runGroup.acquireRun(runId);
      assert.ok(settledOwner);
      assert.equal(
        settledOwner.failureEvidence()[0]?.diagnosticId,
        failed.failure.diagnostic.diagnosticId,
      );
      settledOwner.close();
    }
    await wired.shutdown();
  });
}

for (const delivery of ["skill", "file"] as const) {
  test(`m11-pre-turn-agent-evidence: unsupported ${delivery} delivery projects a render reason without admission`, async (t) => {
    const profile = fakeHarnessProfile({
      [delivery === "skill" ? "skillDelivery" : "fileDelivery"]: {
        mode: "native",
        evidence: "only native delivery",
      },
    });
    const agent = receiptAgent([undefined], { profile });
    const { wired, runId } = await launch(
      t,
      agent.adapter,
      writeBundle("none"),
    );
    const run = readRun(wired.projectionPort, runId);
    assert.equal(run.state, "failed");
    assert.deepEqual(agent.inputs, []);
    const failure = run.timeline.find(
      (e) => e.event === "attempt-settled",
    )?.failure;
    assert.ok(failure && "explanation" in failure);
    assert.equal(failure?.code, "prompt-render-failed");
    assert.equal(failure.category, "unsupported-delivery-mode");
    assert.equal(failure.possibleEffects, "none");
    assert.ok(failure.diagnostic);
    const read = wired.projectionPort.readResource(failure.diagnostic);
    assert.ok(read.found);
    assert.match(read.content, /plain-path delivery only/);
    assert.ok(read.content.includes(`${delivery}:native`));
    await wired.shutdown();
  });
}

for (const slot of [false, true]) {
  test(`m11-pre-turn-agent-evidence: unusable working area with slot ${slot} retains the translated cause`, async (t) => {
    const bundle = writeBundle("none");
    if (slot)
      writeFileSync(
        join(bundle.folder, "prompts/publish.md"),
        "Use {{run:working-area}}.",
      );
    const agent = receiptAgent([undefined], {
      prepareDirectory(path) {
        rmSync(path, { recursive: true });
        writeFileSync(path, "squatter");
      },
    });
    const { wired, runId } = await launch(t, agent.adapter, bundle);
    const run = readRun(wired.projectionPort, runId);
    assert.equal(run.state, "failed");
    assert.deepEqual(agent.inputs, []);
    const failure = run.timeline.find(
      (e) => e.event === "attempt-settled",
    )?.failure;
    assert.ok(failure && "explanation" in failure);
    assert.equal(failure?.code, slot ? "prompt-render-failed" : "not-started");
    assert.equal(failure.category, "working-area-unavailable");
    assert.equal(failure.possibleEffects, "none");
    assert.ok(failure.diagnostic);
    const read = wired.projectionPort.readResource(failure.diagnostic);
    assert.ok(read.found);
    assert.match(read.content, /Cause:|Message:/);
    assert.match(read.content, /Harness diagnostics:/);
    await wired.shutdown();
  });
}

test("m11-pre-turn-agent-evidence: receipt preparation fails before admission and keeps each retry's evidence", async (t) => {
  const agent = receiptAgent([undefined], { squatReceiptRoot: true });
  const { wired, runId } = await launch(
    t,
    agent.adapter,
    writeBundle("none", 1),
  );
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "failed");
  assert.deepEqual(agent.inputs, []);
  const failures = run.timeline
    .filter((e) => e.event === "attempt-settled")
    .map((e) => e.failure);
  assert.equal(failures.length, 2);
  for (const failure of failures) {
    assert.ok(failure && "explanation" in failure);
    assert.equal(failure?.code, "not-started");
    assert.equal(failure.category, "output-receipt-directory-unavailable");
    assert.equal(failure.possibleEffects, "none");
    assert.ok(failure.diagnostic);
    const read = wired.projectionPort.readResource(failure.diagnostic);
    assert.ok(read.found);
    assert.match(read.content, /Cause:|Message:/);
  }
  await wired.shutdown();
});

test("m11-pre-turn-agent-evidence: an unusable Session fails the retry without another Turn", async (t) => {
  const agent = receiptAgent([undefined], {
    results: [
      {
        kind: "failed",
        detail: {
          failure: {
            phase: "recovery",
            category: "recovery-failed",
            possibleEffects: "none",
          },
          effectiveModel: { known: false },
          session: { state: "unusable", reason: "cannot recover" },
        },
      },
    ],
  });
  const { wired, runId } = await launch(
    t,
    agent.adapter,
    writeBundle("none", 1),
  );
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "failed");
  assert.equal(agent.inputs.length, 1);
  assert.equal(
    run.timeline.filter((e) => e.event === "turn-started").length,
    1,
  );
  const failure = run.timeline
    .filter((e) => e.event === "attempt-settled")
    .at(-1)?.failure;
  assert.ok(failure && "explanation" in failure);
  assert.equal(failure?.code, "session-unusable");
  assert.equal(failure.possibleEffects, "none");
  assert.equal(
    failure.explanation,
    "This Step's agent conversation can no longer continue.",
  );
  assert.equal(failure.nextStep, "Delete the Run or start a new one.");
  assert.equal(failure.diagnostic, undefined);
  await wired.shutdown();
});

test("m11-pre-turn-agent-evidence: blocked Entry evidence stays visible after shutdown and reopen", async (t) => {
  const { wired, runId, home, workspace } = await launch(
    t,
    receiptAgent(["/model unsafe"]).adapter,
    refusedPromptBundle("interactive-agent"),
    true,
  );
  const before = readRun(wired.projectionPort, runId);
  await wired.shutdown();
  wired.runGroup.close();
  wired.catalog.close();
  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: storedProcess({ git: createFakeGitProcess() }),
    supportsInteractiveTurns: true,
    harnessAdapter: receiptAgent([]).adapter,
  });
  t.after(async () => {
    await reopened.shutdown();
    reopened.runGroup.close();
    reopened.catalog.close();
  });
  const run = readRun(reopened.projectionPort, runId);
  assert.equal(run.state, "blocked");
  assert.deepEqual(run.timeline, before.timeline);
  assert.equal(run.restingCause, undefined);
  assert.ok(
    run.actionOffers.some((offer) => offer.action === "end-interactive-step"),
  );
});

test("m11-pre-turn-agent-evidence: an unpreparable Entry stays blocked without a Turn or settled Attempt", async (t) => {
  const bundle = writeBundle("none");
  const path = join(bundle.folder, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.routing[0].kind = "interactive-agent";
  manifest.routing[0].entryTurn = true;
  delete manifest.routing[0].produces;
  writeFileSync(path, JSON.stringify(manifest));
  const profile = fakeHarnessProfile({
    fileDelivery: { mode: "native", evidence: "native only" },
  });
  const agent = receiptAgent([], { profile });
  const { wired, runId } = await launch(t, agent.adapter, bundle, true);
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "blocked");
  assert.deepEqual(agent.inputs, []);
  assert.equal(run.restingCause, undefined);
  assert.equal(
    run.timeline.filter(
      (e) => e.event === "attempt-settled" || e.event.startsWith("turn-"),
    ).length,
    0,
  );
  const failure = run.timeline.find((e) => e.event === "attempt-failure");
  assert.equal(failure?.step, "publish");
  assert.ok(failure?.failure && "explanation" in failure.failure);
  assert.equal(failure.failure?.code, "prompt-render-failed");
  assert.equal(failure.failure.category, "unsupported-delivery-mode");
  await wired.shutdown();
});

test("m11-pre-turn-agent-evidence: a missing prompt asset still rests halted with execution-fault", async (t) => {
  const bundle = writeBundle("consume");
  let missing: string | undefined;
  const agent = receiptAgent([
    (path) => {
      writeFileSync(path, "valid output");
      assert.ok(missing);
      rmSync(missing);
    },
  ]);
  const { wired, runId, launched } = await launch(
    t,
    agent.adapter,
    bundle,
    false,
    (wiring) => {
      const entry = wiring.catalog
        .listEntries()
        .find((e) => e.id === bundle.id);
      assert.ok(entry);
      const root = wiring.catalog.assetRoot(entry.digest);
      assert.ok(root);
      missing = join(root, "prompts/tickets.md");
    },
  );
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "halted");
  assert.equal(run.restingCause?.code, "execution-fault");
  assert.ok("problem" in launched);
  assert.equal(launched.problem?.code, "run-execution-fault");
  assert.equal(
    run.timeline.filter(
      (e) =>
        e.failure !== undefined &&
        "source" in e.failure &&
        e.failure.source === "agent",
    ).length,
    0,
  );
  assert.ok(run.actionOffers.some((offer) => offer.action === "resume-run"));
  assert.equal(agent.inputs.length, 1);
  await wired.shutdown();
});
