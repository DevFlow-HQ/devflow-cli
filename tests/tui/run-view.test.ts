import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "solid-js";
import type {
  SettledOperationSnapshot,
  ProjectionPort,
  ProjectionSelector,
  ProjectionUpdate,
  RunGateReference,
  RunLiveOverlay,
  RunSnapshot,
  RunView,
  SessionHistoryRow,
} from "../../src/application/projection-port.js";
import {
  createLiveRunWorkbenchView,
  createLivePreferencesView,
  type TRunViewFreshness,
  type RunWorkbenchProjection,
} from "../../src/tui/tui.js";
import { realpathSync } from "node:fs";
import { openCatalog } from "../../src/catalog/catalog.js";
import { createApplication } from "../helpers/application.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { openLiveRun, UNREAD_UPDATE_BOUND } from "../helpers/liveRun.js";

class UpdateQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;

  push(value: T): void {
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.ended)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function runOf(over: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    bundle: {
      id: "dev.alpha",
      version: "1.0.0",
      name: "Alpha",
      digest: "abc123",
    },
    workspacePath: "/tmp/ws",
    launchedAt: "2026-01-01T00:00:00.000Z",
    state: "running",
    liveness: { state: "live-here", ownerPid: 42 },
    progress: [{ id: "repair", kind: "agent", status: "running" }],
    position: 0,
    timeline: [],
    outputs: [],
    actionOffers: [],
    ...over,
  };
}

function snapshotOf(run: RunView): RunSnapshot {
  return {
    family: "run",
    runId: run.runId,
    result: { found: true, run },
  };
}

const WORKING: RunLiveOverlay = {
  runId: "run-1",
  generation: 1,
  phase: "working",
  outstanding: [],
  offers: [],
};

async function flushUpdates(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Drain microtasks until `reached` holds, bounded so a regression fails fast
 *  rather than hanging; no timer is involved. */
async function microtasksUntil(reached: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !reached(); turn += 1) {
    await Promise.resolve();
  }
}

function healthKind(projection: RunWorkbenchProjection): string {
  return projection.freshness().kind;
}

/** Open a live Run projection over a hand-driven update queue, so a test can push each
 *  update lane (durable, live, preview, closed) and read the joined view. */
function openLiveProjection(initial: RunSnapshot): {
  projection: RunWorkbenchProjection;
  updates: UpdateQueue<ProjectionUpdate<RunSnapshot>>;
  dispose: () => void;
} {
  const updates = new UpdateQueue<ProjectionUpdate<RunSnapshot>>();
  const opened = {
    snapshot: initial,
    catchUp: "fresh" as const,
    updates,
    close() {},
  };
  const port = {
    openProjection: () => opened,
    submit() {
      throw new Error("submit is not used");
    },
    readResource() {
      throw new Error("readResource is not used");
    },
  } as unknown as ProjectionPort;
  let projection!: RunWorkbenchProjection;
  const dispose = createRoot((dispose) => {
    projection = createLiveRunWorkbenchView(port).openRun("run-1");
    return dispose;
  });
  return { projection, updates, dispose };
}

/** A live overlay holding one outstanding approval Harness Request (#117): the view a
 *  lost Turn must not leave standing (A8). */
const REQUESTING: RunLiveOverlay = {
  runId: "run-1",
  generation: 3,
  phase: "working",
  outstanding: [
    {
      requestId: "req-1",
      tool: "Edit",
      input: '{"path":"a.ts"}',
      decisions: ["allow", "deny"],
    },
  ],
  offers: [
    {
      action: "answer-harness-request",
      runId: "run-1",
      requestId: "req-1",
      generation: 3,
      decisions: ["allow", "deny"],
      basis: "ephemeral Harness Request",
    },
  ],
};

test("a closed update clears the live overlay and preview so a lost Turn leaves no dead control (A8) — fails at HEAD", async () => {
  const { projection, updates, dispose } = openLiveProjection(
    snapshotOf(runOf()),
  );
  updates.push({ kind: "live", overlay: REQUESTING });
  await flushUpdates();
  assert.equal(projection.live()?.outstanding.length, 1);
  // The follow loop breaks (subject gone) with the last overlay still in state; HEAD
  // returned the state untouched, keeping a dead request control standing.
  updates.push({ kind: "closed", reason: "subject-gone" });
  await flushUpdates();
  assert.equal(projection.live(), undefined);
  dispose();
  updates.end();
});

test("the Run follow seam reports loss and reopens through loading and catching-up to current", async () => {
  const first = new UpdateQueue<ProjectionUpdate<RunSnapshot>>();
  const second = new UpdateQueue<ProjectionUpdate<RunSnapshot>>();
  const opened = [
    {
      snapshot: snapshotOf(runOf()),
      catchUp: "fresh" as const,
      updates: first,
      close() {},
    },
    {
      snapshot: snapshotOf(runOf({ state: "halted" })),
      catchUp: "rebased" as const,
      updates: second,
      close() {},
    },
  ];
  let opens = 0;
  const port = {
    openProjection() {
      const projection = opened[opens];
      opens += 1;
      if (projection === undefined) throw new Error("unexpected third open");
      return projection;
    },
    submit() {
      throw new Error("submit is not used");
    },
    readResource() {
      throw new Error("readResource is not used");
    },
  } as unknown as ProjectionPort;
  const observed: TRunViewFreshness[] = [];
  let projection!: RunWorkbenchProjection;
  const dispose = createRoot((dispose) => {
    projection = createLiveRunWorkbenchView(port).openRun("run-1");
    return dispose;
  });

  assert.equal(healthKind(projection), "current");
  const lastConfirmedAt = projection.freshness().lastConfirmedAt;
  first.push({ kind: "closed", reason: "observer-lagged" });
  await flushUpdates();
  assert.deepEqual(projection.freshness(), {
    kind: "disconnected",
    reason: "observer-lagged",
    lastConfirmedAt,
  });

  projection.reconnect();
  observed.push(projection.freshness());
  await Promise.resolve();
  observed.push(projection.freshness());
  await Promise.resolve();
  observed.push(projection.freshness());
  assert.deepEqual(
    observed.map((health) => health.kind),
    ["loading", "catching-up", "current"],
  );
  const result = projection.snapshot().result;
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.run.state, "halted");
  }
  assert.equal(opens, 2);

  dispose();
  first.end();
  second.end();
});

test("a real Run stream that lags reports loss, and reconnect restores the current snapshot and live overlay (#306)", async (t) => {
  const run = await openLiveRun(t);
  let projection!: RunWorkbenchProjection;
  const dispose = createRoot((dispose) => {
    projection = createLiveRunWorkbenchView(run.port).openRun(run.runId);
    return dispose;
  });
  t.after(dispose);
  run.channel.raised({
    requestId: "req-edit",
    tool: "Edit",
    input: "change file",
    decisions: ["allow", "deny"],
  });
  await flushUpdates();
  assert.equal(projection.live()?.outstanding.length, 1);

  // One synchronous burst past the unread bound overflows the view's subscription
  // before its follow loop can read.
  const burst = UNREAD_UPDATE_BOUND + 100;
  for (let index = 0; index < burst; index += 1) {
    run.channel.observe({ usage: `p${index}` });
  }
  await microtasksUntil(() => healthKind(projection) === "disconnected");
  const lost = projection.freshness();
  assert.equal(lost.kind, "disconnected");
  if (lost.kind === "disconnected")
    assert.equal(lost.reason, "observer-lagged");
  // The lost overlay leaves no dead request control standing.
  assert.equal(projection.live(), undefined);

  projection.reconnect();
  await microtasksUntil(() => projection.live() !== undefined);
  assert.equal(healthKind(projection), "current");
  const result = projection.snapshot().result;
  assert.ok(result.found);
  if (result.found) assert.equal(result.run.state, "running");
  assert.deepEqual(
    projection.live()?.outstanding.map((request) => request.requestId),
    ["req-edit"],
  );
  await run.finish();
});

test("m10-audit-operation-settlement-owner: a TUI answer waits on the Port receipt without opening an Operation Projection", async () => {
  let resolve!: (snapshot: SettledOperationSnapshot) => void;
  const receipt = new Promise<SettledOperationSnapshot>((settle) => {
    resolve = settle;
  });
  const port = {
    submit() {
      return { admitted: true, operationId: "op-1" } as const;
    },
    settledOperation(operationId: string) {
      assert.equal(operationId, "op-1");
      return receipt;
    },
    openProjection() {
      throw new Error("settlement must not open a Projection");
    },
  } as unknown as ProjectionPort;
  const gate: RunGateReference = {
    runId: "run-1",
    stepId: "review",
    attemptId: "attempt-1",
    shape: "approve-reject",
  };
  const outcome = createLiveRunWorkbenchView(port).answer(gate, "continue");
  assert.equal(outcome().kind, "pending");
  await flushUpdates();
  assert.equal(outcome().kind, "pending");
  resolve({
    family: "operation",
    operationId: "op-1",
    outcome: { status: "applied" },
  });
  await flushUpdates();
  assert.equal(outcome().kind, "applied");
});

test("m10-audit-operation-settlement-owner: shutdown disconnects the Run view, clears live controls, and ends a pending TUI Operation", async (t) => {
  const live = openLiveProjection(snapshotOf(runOf()));
  live.updates.push({ kind: "live", overlay: REQUESTING });
  await flushUpdates();
  assert.ok(live.projection.live());
  live.updates.push({ kind: "closed", reason: "application-shutdown" });
  await flushUpdates();
  const freshness = live.projection.freshness();
  assert.equal(freshness.kind, "disconnected");
  if (freshness.kind === "disconnected")
    assert.equal(freshness.reason, "application-shutdown");
  assert.equal(live.projection.live(), undefined);
  live.dispose();
  live.updates.end();

  const catalog = openCatalog(makeTempDir("secant-tui-settle-home-"));
  t.after(() => catalog.close());
  const held: (() => void | Promise<void>)[] = [];
  const app = createApplication({
    catalog,
    launchWorkspacePath: realpathSync.native(
      makeTempDir("secant-tui-settle-ws-"),
    ),
    scheduleSettlement: (settle) => {
      held.push(settle);
    },
  });
  let dispose!: () => void;
  const preferences = createRoot((end) => {
    dispose = end;
    return createLivePreferencesView(app.projectionPort);
  });
  t.after(() => dispose());
  const outcome = preferences.save({ theme: "aura", appearance: "light" });
  assert.equal(outcome().kind, "pending");
  await app.shutdown();
  await flushUpdates();
  const ended = outcome();
  assert.equal(ended.kind, "refused");
  if (ended.kind === "refused") {
    assert.equal(ended.problem.code, "operation-observation-ended");
    assert.equal(ended.problem.possibleEffects, "unknown");
    assert.match(ended.problem.explanation, /application-shutdown/);
  }
  // The end of observation never changes the effect's eventual ledger receipt.
  await held.shift()?.();
  await flushUpdates();
  assert.deepEqual(outcome(), ended);
});

test("a durable update whose liveness leaves live-here drops the live overlay (A8) — fails at HEAD", async () => {
  const { projection, updates, dispose } = openLiveProjection(
    snapshotOf(runOf()),
  );
  updates.push({ kind: "live", overlay: REQUESTING });
  await flushUpdates();
  assert.equal(projection.live()?.outstanding.length, 1);
  // Durable liveness leaves live-here (the Turn is no longer live in this instance);
  // HEAD kept the overlay, so the request control kept standing over a dead Turn.
  updates.push({
    kind: "durable",
    snapshot: snapshotOf(
      runOf({ state: "halted", liveness: { state: "not-live" } }),
    ),
  });
  await flushUpdates();
  assert.equal(projection.live(), undefined);
  dispose();
  updates.end();
});

test("the live Run view follows durable and control-overlay lanes and clears only after authoritative settlement", async () => {
  const initial = snapshotOf(runOf());
  const updates = new UpdateQueue<ProjectionUpdate<RunSnapshot>>();
  let closes = 0;
  const opened = {
    snapshot: initial,
    updates,
    close() {
      closes += 1;
    },
  };
  const port = {
    openProjection(selector: ProjectionSelector) {
      assert.deepEqual(selector, {
        family: "run",
        runId: "run-1",
        prepareModelChoice: true,
      });
      return opened;
    },
    submit() {
      throw new Error("submit is not used");
    },
    readResource() {
      throw new Error("readResource is not used");
    },
  } as unknown as ProjectionPort;

  let projection!: RunWorkbenchProjection;
  const dispose = createRoot((dispose) => {
    projection = createLiveRunWorkbenchView(port).openRun("run-1");
    return dispose;
  });

  updates.push({
    kind: "live",
    overlay: { ...WORKING, usage: "First report" },
  });
  await flushUpdates();
  assert.equal(projection.live()?.usage, "First report");

  updates.push({ kind: "live", overlay: WORKING });
  await flushUpdates();
  assert.equal(projection.live()?.phase, "working");

  updates.push({ kind: "live", overlay: { ...WORKING, usage: "" } });
  await flushUpdates();

  updates.push({
    kind: "live",
    overlay: { ...WORKING, phase: "settling" },
  });
  updates.push({
    kind: "durable",
    snapshot: snapshotOf(
      runOf({
        timeline: [
          { at: "T000", event: "assistant-content", detail: "Final answer" },
        ],
      }),
    ),
  });
  await flushUpdates();
  assert.equal(projection.live()?.phase, "settling");

  const settled = snapshotOf(
    runOf({
      state: "succeeded",
      progress: [{ id: "repair", kind: "agent", status: "succeeded" }],
      position: 1,
      timeline: [
        { at: "T000", event: "assistant-content", detail: "Final answer" },
        { at: "T001", event: "turn-settled", detail: "completed" },
      ],
    }),
  );
  updates.push({ kind: "durable", snapshot: settled });
  await flushUpdates();
  assert.deepEqual(projection.snapshot(), settled);
  assert.equal(projection.live(), undefined);

  const beforeDispose = projection.snapshot();
  dispose();
  assert.equal(closes, 1);
  updates.push({
    kind: "durable",
    snapshot: snapshotOf(runOf({ state: "failed" })),
  });
  await flushUpdates();
  assert.deepEqual(projection.snapshot(), beforeDispose);
  updates.end();
});

test("m10-session-history: an immediate durable Turn settlement clears control overlay before its trailing settling observation", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  run.owner.admitTurn({
    turnId: "turn",
    attemptId: "0.0:echo",
    session: "s",
    origin: "human",
    kind: "interactive-agent",
    input: "Hello",
    recoveryCoordinate: "private",
    harness: "codex",
    at: new Date(),
  });
  let projection!: RunWorkbenchProjection;
  const dispose = createRoot((dispose) => {
    projection = createLiveRunWorkbenchView(run.port).openRun(run.runId);
    return dispose;
  });
  t.after(dispose);
  run.channel.bindAnswer(async () => ({ outcome: "accepted" }));
  await flushUpdates();
  assert.equal(projection.live()?.phase, "working");
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "detached",
    at: new Date(),
  });
  run.channel.bindAnswer(undefined);
  await flushUpdates();
  assert.equal(projection.live(), undefined);
  await run.finish();
});

for (const result of ["applied", "refused"] as const) {
  test(`m10-audit-draft-recovery: a production Steer keeps its Operation id while pending and ${result}`, async (t) => {
    const catalog = openCatalog(makeTempDir("secant-steer-receipt-"));
    t.after(() => catalog.close());
    const app = createApplication({
      catalog,
      launchWorkspacePath: makeTempDir("secant-steer-ws-"),
    });
    t.after(() => app.shutdown());
    const submitted: string[] = [];
    const settlements: ((value: SettledOperationSnapshot) => void)[] = [];
    const port: ProjectionPort = {
      ...app.projectionPort,
      submit(submission) {
        assert.equal(submission.operation, "steer-turn");
        submitted.push(submission.operationId);
        return { admitted: true, operationId: submission.operationId };
      },
      settledOperation(operationId) {
        assert.ok(submitted.includes(operationId));
        return new Promise((resolve) => settlements.push(resolve));
      },
    };
    const view = createLiveRunWorkbenchView(port);
    const first = view.steer("run-1", "turn-1", "identical text");
    const second = view.steer("run-1", "turn-1", "identical text");
    assert.equal(first().kind, "pending");
    assert.equal(second().kind, "pending");
    assert.ok(first().steerId);
    assert.notEqual(first().steerId, second().steerId);
    assert.deepEqual(submitted, [first().steerId, second().steerId]);
    const secondId = second().steerId;
    const outcome: SettledOperationSnapshot["outcome"] =
      result === "applied"
        ? { status: "applied" }
        : {
            status: "not-applied",
            problem: {
              code: "turn-control-rejected",
              explanation: "Too late",
              remediation: "Send again",
              possibleEffects: "none",
            },
          };
    settlements[1]?.({ family: "operation", operationId: secondId, outcome });
    await flushUpdates();
    assert.equal(second().kind, result);
    assert.equal(second().steerId, secondId);
    assert.equal(first().kind, "pending");
    const firstId = first().steerId;
    settlements[0]?.({ family: "operation", operationId: firstId, outcome });
    await flushUpdates();
    assert.equal(first().kind, result);
    assert.equal(first().steerId, firstId);
  });
}

test("m10-audit-history-latest-delivery: the production history client reads whole latest values across synchronous bursts and reconnects", async (t) => {
  let flush: (() => void) | undefined;
  const run = await openLiveRun(t, {
    scheduleHistoryPreview: (next) => {
      flush = next;
      return () => {
        flush = undefined;
      };
    },
  });
  t.after(run.finish);
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
      at: new Date(),
    }).ok,
  );
  const { history, dispose } = createRoot((dispose) => ({
    history: createLiveRunWorkbenchView(run.port).openHistory(run.runId, "s"),
    dispose,
  }));
  t.after(dispose);
  const preview = (messageId: string, content: string) => {
    run.channel.observe({
      message: { turnId: "turn", session: "s", messageId, content },
    });
    const next = flush;
    flush = undefined;
    next?.();
  };
  preview("one", "First");
  await microtasksUntil(() => {
    const page = history.snapshot();
    return page.result.found && page.result.history.rows.length === 2;
  });
  const first = history.snapshot();
  assert.ok(first.result.found);
  const original = first.result.history.rows[1]!;
  preview("one", "Unread first");
  preview("one", "Unread second");
  assert.ok(
    run.owner.appendTurnEvent({
      turnId: "turn",
      kind: "assistant-content",
      payload: JSON.stringify({ messageId: "one", content: "Settled" }),
      at: new Date(),
    }).ok,
  );
  preview("two", "Old second row");
  preview("two", "Latest second row");
  await microtasksUntil(() => {
    const page = history.snapshot();
    const value = page.result.found
      ? page.result.history.rows.at(-1)?.value
      : undefined;
    return value?.kind === "message" && value.content === "Latest second row";
  });
  const latest = history.snapshot();
  assert.ok(latest.result.found);
  const rows: readonly SessionHistoryRow[] = latest.result.history.rows;
  assert.deepEqual(
    rows.map((row) => row.value),
    [
      { kind: "message", role: "user", content: "Input" },
      { kind: "message", role: "assistant", content: "Settled" },
      { kind: "message", role: "assistant", content: "Latest second row" },
    ],
  );
  assert.equal(rows[1]?.id, original.id);
  assert.equal(rows[1]?.position, original.position);
  assert.equal(rows[1]?.source, "stored");
  assert.equal(history.freshness().kind, "current");
  preview("trigger", "Before loss");
  preview("oversized", "X".repeat(8 * 1024 * 1024 + 1));
  preview("overflow", "After loss");
  await microtasksUntil(() => history.freshness().kind === "disconnected");
  const lost = history.freshness();
  assert.ok(lost.kind === "disconnected");
  assert.equal(lost.reason, "observer-lagged");
  const lastKnown = history.snapshot();
  assert.ok(lastKnown.result.found);
  assert.equal(
    lastKnown.result.history.rows.length,
    4,
    "terminal must discard the oversized queued preview",
  );
  history.reconnect();
  await microtasksUntil(() => {
    const page = history.snapshot();
    return page.result.found && page.result.history.rows[1]?.id !== original.id;
  });
  const reopened = history.snapshot();
  assert.ok(reopened.result.found);
  assert.deepEqual(
    reopened.result.history.rows.slice(0, 3).map((row) => row.value),
    rows.map((row) => row.value),
  );
  assert.deepEqual(reopened.result.history.rows.at(-1)?.value, {
    kind: "message",
    role: "assistant",
    content: "After loss",
  });
  const large = reopened.result.history.rows.at(-2)?.value;
  assert.ok(large?.kind === "message");
  assert.equal(large.content.length, 8 * 1024 * 1024 + 1);
  assert.notEqual(reopened.result.history.rows[1]?.id, original.id);
});
