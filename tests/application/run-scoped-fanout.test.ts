import assert from "node:assert/strict";
import test from "node:test";
import type { AppendTurnEventRequest } from "../../src/run/store/store.js";
import { realpathSync } from "node:fs";
import {
  createApplication,
  type ApplicationHarnessQualification,
} from "../../src/application/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { fakeHarnessProfile } from "../harness/fake-adapter.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";
import { writeAgentBundle } from "../helpers/agentBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { openLiveRun } from "../helpers/liveRun.js";

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let resolved = false;
  void promise.then(() => {
    resolved = true;
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return !resolved;
}

function scheduler() {
  const pending = new Set<() => void>();
  const delays: number[] = [];
  return {
    pending,
    delays,
    schedule(callback: () => void, delayMs: number) {
      delays.push(delayMs);
      pending.add(callback);
      return () => {
        pending.delete(callback);
      };
    },
    flush() {
      for (const callback of [...pending]) {
        pending.delete(callback);
        callback();
      }
    },
  };
}

const AT = new Date("2026-10-09T00:00:00Z");

test("m10-audit-run-scoped-fanout: Turn events and settlement perform zero census reads and coalesce Run updates", async (t) => {
  let census = 0;
  const clock = scheduler();
  const run = await openLiveRun(t, {
    onCensusRead: () => census++,
    scheduleRunUpdate: clock.schedule,
  });
  t.after(run.finish);
  const workspace = run.port.openProjection({ family: "workspace" });
  const list = run.port.openProjection({ family: "run-list" });
  const views = [0, 1].map(() =>
    run.port.openProjection({ family: "run", runId: run.runId }),
  );
  t.after(() => {
    workspace.close();
    list.close();
    for (const view of views) view.close();
  });
  assert.ok(
    run.owner.admitTurn({
      turnId: "turn",
      attemptId: "0.0:echo",
      session: "s",
      origin: "human",
      kind: "interactive-agent",
      input: "Input",
      recoveryCoordinate: "private",
      harness: "codex",
      at: AT,
    }).ok,
  );
  const iterators = views.map((view) => view.updates[Symbol.asyncIterator]());
  for (const iterator of iterators)
    assert.equal((await iterator.next()).value?.kind, "durable");
  const history = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(history.close);
  const workspaceNext = workspace.updates[Symbol.asyncIterator]().next();
  const listNext = list.updates[Symbol.asyncIterator]().next();
  const next = iterators.map((iterator) => iterator.next());
  census = 0;
  for (let i = 0; i < 100; i++) {
    assert.ok(
      run.owner.appendTurnEvent({
        turnId: "turn",
        fact: {
          kind: "tool-call",
          data: {
            callId: `tool-${i}`,
            tool: "read",
            input: `File ${i}`,
            outcome: { kind: "completed" },
          },
        },
        at: AT,
      }).ok,
    );
  }
  assert.equal(census, 0);
  assert.equal(clock.pending.size, 1);
  assert.deepEqual(clock.delays, [50]);
  assert.equal(await isPending(next[0]!), true);
  clock.flush();
  for (const update of await Promise.all(next)) {
    assert.ok(
      update.value?.kind === "durable" && update.value.snapshot.result.found,
    );
    assert.equal(update.value.snapshot.result.run.liveness.state, "live-here");
    assert.equal(update.value.snapshot.result.run.state, "running");
  }
  assert.equal(census, 0);
  assert.equal(await isPending(iterators[0]!.next()), true);
  // Settled facts flush a pending window immediately, including the Turn result.
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "assistant-content",
      data: { messageId: "answer", content: "Done" },
    },
    at: AT,
  });
  const settledNext = iterators[1]!.next();
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "open",
    at: AT,
  });
  const settled = await settledNext;
  assert.ok(
    !settled.done &&
      settled.value.kind === "durable" &&
      settled.value.snapshot.result.found,
  );
  assert.ok(
    settled.value.snapshot.result.run.timeline.some(
      (event) => event.event === "turn-settled" && event.detail === "completed",
    ),
  );
  assert.equal(clock.pending.size, 0);
  assert.equal(census, 0);
  assert.equal(await isPending(workspaceNext), true);
  assert.equal(await isPending(listNext), true);
  const current = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(current.close);
  assert.ok(current.snapshot.result.found);
  assert.ok(
    current.snapshot.result.history.rows.some(
      (row) => row.value.kind === "message" && row.value.content === "Done",
    ),
  );
  await run.finish();
  assert.ok(census > 0);
  const summary = await workspaceNext;
  assert.ok(
    summary.value?.kind === "durable" &&
      summary.value.snapshot.family === "workspace",
  );
  assert.deepEqual(summary.value.snapshot.runSummary.ownedLiveRuns, {
    state: "known",
    count: 1,
  });
  const released = await workspace.updates[Symbol.asyncIterator]().next();
  assert.ok(!released.done && released.value.kind === "durable");
  assert.deepEqual(released.value.snapshot.runSummary.ownedLiveRuns, {
    state: "known",
    count: 0,
  });
  const updatedList = await listNext;
  assert.ok(
    updatedList.value?.kind === "durable" &&
      updatedList.value.snapshot.family === "run-list",
  );
  assert.equal(updatedList.value.snapshot.rows[0]?.runId, run.runId);
  const releasedList = await list.updates[Symbol.asyncIterator]().next();
  assert.ok(!releasedList.done && releasedList.value.kind === "durable");
  assert.equal(releasedList.value.snapshot.rows[0]?.live, false);
});

test("m10-audit-run-scoped-fanout: deduplicated append pushes nothing and closing the last observer cancels its window", async (t) => {
  const clock = scheduler();
  const run = await openLiveRun(t, { scheduleRunUpdate: clock.schedule });
  t.after(run.finish);
  run.owner.admitTurn({
    turnId: "turn",
    attemptId: "0.0:echo",
    session: "s",
    origin: "human",
    kind: "interactive-agent",
    input: "Input",
    recoveryCoordinate: "private",
    harness: "codex",
    at: AT,
  });
  const view = run.port.openProjection({ family: "run", runId: run.runId });
  t.after(view.close);
  const event: AppendTurnEventRequest = {
    turnId: "turn",
    fact: {
      kind: "assistant-content",
      data: { messageId: "answer", content: "Done" },
    },
    at: AT,
  };
  assert.ok(run.owner.appendTurnEvent(event).ok);
  clock.flush();
  const iterator = view.updates[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "durable");
  const next = iterator.next();
  assert.deepEqual(run.owner.appendTurnEvent(event), { ok: true });
  assert.equal(clock.pending.size, 0);
  assert.equal(await isPending(next), true);
  run.owner.appendTurnEvent({
    ...event,
    fact: {
      kind: "assistant-content",
      data: { messageId: "another", content: "Later" },
    },
  });
  assert.equal(clock.pending.size, 1);
  view.close();
  assert.equal(clock.pending.size, 0);
  const reopened = run.port.openProjection({ family: "run", runId: run.runId });
  t.after(reopened.close);
  run.owner.appendTurnEvent({
    ...event,
    fact: {
      kind: "assistant-content",
      data: { messageId: "third", content: "Reopened" },
    },
  });
  clock.flush();
  assert.equal(
    (await reopened.updates[Symbol.asyncIterator]().next()).value?.kind,
    "durable",
  );
  await run.finish();
});

for (const ok of [true, false])
  test(`m10-audit-run-scoped-fanout: ${ok ? "successful" : "failed"} qualification updates each observed Run once, including ordinary readers`, async (t) => {
    const catalog = openCatalog(makeTempDir("secant-fanout-catalog-"));
    const workspace = realpathSync.native(makeTempDir("secant-fanout-ws-"));
    const group = openFakeRunGroup(
      makeTempDir("secant-fanout-store-"),
      workspace,
    );
    t.after(() => {
      group.close();
      catalog.close();
    });
    const reads = new Map<string, number>();
    let census = 0;
    let qualifications = 0;
    let settle!: (result: ApplicationHarnessQualification) => void;
    const pending = new Promise<ApplicationHarnessQualification>((resolve) => {
      settle = resolve;
    });
    const app = createApplication({
      catalog,
      launchWorkspacePath: workspace,
      process: createFakeProcess({}),
      runGroup: {
        ...group,
        listRuns() {
          census++;
          return group.listRuns();
        },
        countRuns() {
          census++;
          return group.countRuns();
        },
        readRun(runId) {
          reads.set(runId, (reads.get(runId) ?? 0) + 1);
          return group.readRun(runId);
        },
      },
      harnessRegistry: [
        {
          choice: { id: "codex", name: "Codex", availability: "available" },
          inputRules: [],
          servedCapabilities: ["agent-turn"],
          discover: () => ({
            kind: "found",
            source: "path",
            description: "fake",
          }),
          qualify: () => {
            qualifications++;
            return pending;
          },
        },
      ],
    });
    const bundle = writeAgentBundle({
      id: "dev.secant.fanout",
      name: "Fanout",
      description: "Fanout fixture",
      prompt: { path: "prompt.md", text: "Work" },
      routing: [
        {
          id: "agent",
          kind: "agent",
          prompt: { asset: "prompt.md" },
          session: "s",
          retry: 0,
        },
      ],
    });
    assert.ok(
      app.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
    );
    const digest = catalog.listEntries()[0]!.digest;
    const ids = Array.from({ length: 5 }, (_, i) => {
      const created = group.createRun({
        operationId: `seed-${i}`,
        bundleSnapshotDigest: digest,
        launch: {},
        selectedHarness: i === 4 ? "claude-code" : "codex",
        modelChoice: { model: "alpha" },
        at: AT,
      });
      assert.equal(created.outcome, "created");
      assert.ok(created.outcome === "created");
      const owner = group.acquireRun(created.runId)!;
      owner.writeState("halted");
      owner.release();
      owner.close();
      return created.runId;
    });
    const views = ids.slice(0, 3).map((runId, i) =>
      app.projectionPort.openProjection({
        family: "run",
        runId,
        ...(i === 0 ? { prepareModelChoice: true } : {}),
      }),
    );
    // Retain an empty observer Set. It must not be refreshed on settlement.
    views[2]!.close();
    const foreign = app.projectionPort.openProjection({
      family: "run",
      runId: ids[4]!,
    });
    const workspaceView = app.projectionPort.openProjection({
      family: "workspace",
    });
    const listView = app.projectionPort.openProjection({ family: "run-list" });
    t.after(() => {
      for (const view of views) view.close();
      foreign.close();
      workspaceView.close();
      listView.close();
    });
    const iterators = views
      .slice(0, 2)
      .map((view) => view.updates[Symbol.asyncIterator]());
    const next = iterators.map((iterator) => iterator.next());
    const foreignNext = foreign.updates[Symbol.asyncIterator]().next();
    const workspaceNext = workspaceView.updates[Symbol.asyncIterator]().next();
    const listNext = listView.updates[Symbol.asyncIterator]().next();
    reads.clear();
    census = 0;
    settle(
      ok
        ? {
            ok: true,
            profile: fakeHarnessProfile({
              modelSelection: {
                at: "launch-and-per-turn",
                declaration: { kind: "free-text", efforts: [] },
                evidence: "fake",
              },
            }),
            defaults: { kind: "reported", choice: { model: "alpha" } },
          }
        : {
            ok: false,
            failure: {
              phase: "prepare",
              category: "authentication",
              possibleEffects: "none",
            },
          },
    );
    for (const update of await Promise.all(next)) {
      assert.ok(
        !update.done &&
          update.value.kind === "durable" &&
          update.value.snapshot.result.found,
      );
      const offer = update.value.snapshot.result.run.actionOffers.find(
        (candidate) => candidate.action === "change-model-choice",
      );
      assert.ok(offer?.action === "change-model-choice");
      assert.equal(offer.available, ok);
      if (!offer.available)
        assert.equal(offer.problem.code, "selected-harness-unavailable");
    }
    assert.equal(census, 0);
    assert.equal(reads.get(ids[2]!), undefined);
    assert.equal(reads.get(ids[3]!), undefined);
    assert.equal(qualifications, 1);
    for (const iterator of iterators)
      assert.equal(await isPending(iterator.next()), true);
    assert.equal(await isPending(foreignNext), true);
    assert.equal(await isPending(workspaceNext), true);
    assert.equal(await isPending(listNext), true);
    // A focus and a later prepared Run reuse the catalog-held result, with no new fan-out.
    const focus = app.projectionPort.openProjection({
      family: "harness-catalog",
      focus: { id: "codex" },
    });
    focus.close();
    const later = app.projectionPort.openProjection({
      family: "run",
      runId: ids[2]!,
      prepareModelChoice: true,
    });
    assert.ok(later.snapshot.result.found);
    later.close();
    for (const iterator of iterators)
      assert.equal(await isPending(iterator.next()), true);
    assert.equal(qualifications, 1);
    await app.shutdown();
  });

test("m10-audit-run-scoped-fanout: shutdown cancels pending Run work and ends observation before draining", async (t) => {
  const clock = scheduler();
  const run = await openLiveRun(t, { scheduleRunUpdate: clock.schedule });
  const view = run.port.openProjection({ family: "run", runId: run.runId });
  run.owner.admitTurn({
    turnId: "turn",
    attemptId: "0.0:echo",
    session: "s",
    origin: "human",
    kind: "interactive-agent",
    input: "Input",
    recoveryCoordinate: "private",
    harness: "codex",
    at: AT,
  });
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "assistant-content",
      data: { messageId: "answer", content: "Done" },
    },
    at: AT,
  });
  assert.equal(clock.pending.size, 1);
  const shutdown = run.shutdown();
  assert.equal(clock.pending.size, 0);
  assert.deepEqual(await view.updates[Symbol.asyncIterator]().next(), {
    done: false,
    value: { kind: "closed", reason: "application-shutdown" },
  });
  await shutdown;
});
