import assert from "node:assert/strict";
import test from "node:test";
import {
  createTurnEventProducerForTest,
  type PrepareOptions,
  type HarnessPhaseFact,
  type PrepareResult,
  type PreparedHarness,
  type TurnEvent,
} from "../../src/harness/harness.js";
import { createFake, fakeHarnessProfile } from "./fake-adapter.js";
import { turnRequest } from "./scripted-claude.js";

import { ownPreparations } from "./preparation-double.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  preparationClock,
  scriptedPreparation,
} from "./scripted-preparation.js";

async function trace(script: readonly TurnEvent[]) {
  const adapter = createFake({
    profile: fakeHarnessProfile(),
    turns: [
      {
        events: script,
        result: {
          kind: "interrupted",
          detail: {
            interruption: { mode: "process-only", evidence: "script" },
            session: { state: "detached", coordinate: { opaque: "s" } },
          },
        },
      },
    ],
  })();
  const prepared = await adapter.prepare({ workspace: process.cwd() });
  assert.ok(prepared.ok);
  try {
    const turn = prepared.harness.startTurn(turnRequest("facts"));
    const live: TurnEvent[] = [];
    turn.subscribe((event) => live.push(event));
    await turn.result();
    const retained: TurnEvent[] = [];
    turn.subscribe((event) => retained.push(event)).unsubscribe();
    const producer = createTurnEventProducerForTest();
    const productionLive: TurnEvent[] = [];
    producer.subscribe((event) => productionLive.push(event));
    for (const event of script) producer.emit(event);
    producer.settlePreview();
    producer.seal();
    const productionRetained: TurnEvent[] = [];
    producer.subscribe((event) => productionRetained.push(event));
    assert.deepEqual(
      live,
      productionLive,
      "fake emits the production trace for identical normalized inputs",
    );
    assert.deepEqual(
      retained,
      productionRetained,
      "fake retains the production trace for identical normalized inputs",
    );
    return { live, retained };
  } finally {
    await prepared.harness.close();
    await adapter.close();
  }
}

test(`m10-audit-production-harness-parts-in-doubles: fake retains one running start and ignores previews after a settled call`, async () => {
  const call = {
    callId: "c",
    tool: "command",
    input: "command",
    outcome: { kind: "running" },
  } as const;
  const running: TurnEvent = { kind: "tool-call", call };
  const settled: TurnEvent = {
    kind: "tool-call",
    call: { ...call, outcome: { kind: "completed" } },
  };
  assert.deepEqual(
    await trace([
      running,
      running,
      settled,
      { kind: "tool-preview", call: { ...call, output: { text: "late" } } },
    ]),
    {
      live: [running, settled],
      retained: [running, settled],
    },
  );
});

test(`m10-audit-production-harness-parts-in-doubles: fake settles a Thought once and refuses a late preview`, async () => {
  const thought: TurnEvent = {
    kind: "thought",
    summaryId: "t",
    content: "summary",
  };
  assert.deepEqual(
    await trace([
      { kind: "thought-preview", summaryId: "t", content: "preview" },
      thought,
      thought,
      { kind: "thought-preview", summaryId: "t", content: "late" },
    ]),
    {
      live: [
        { kind: "thought-preview", summaryId: "t", content: "preview" },
        thought,
      ],
      retained: [thought],
    },
  );
});

test(`m10-audit-production-harness-parts-in-doubles: fake drops unobserved whitespace Thoughts`, async () => {
  assert.deepEqual(
    await trace([{ kind: "thought", summaryId: "blank", content: " \n " }]),
    { live: [], retained: [] },
  );
});

test(`m10-audit-production-harness-parts-in-doubles: fake drains command tails, diff, and partial content before sealing`, async () => {
  const call = {
    callId: "c",
    tool: "command",
    input: "command",
    outcome: { kind: "running" },
  } as const;
  const diff = { content: "supplied patch", files: [] };
  const { live, retained } = await trace([
    { kind: "message-preview", messageId: "m", content: "answer" },
    { kind: "thought-preview", summaryId: "t", content: "summary" },
    { kind: "turn-diff-preview", diff },
    {
      kind: "tool-preview",
      call: { ...call, output: { text: "head" + "z".repeat(30_000) } },
    },
  ]);
  const terminal: TurnEvent[] = [
    {
      kind: "tool-partial",
      call: {
        ...call,
        output: {
          text: "z".repeat(30_000),
          secantDropped: true,
          incomplete: true,
        },
      },
    },
    { kind: "turn-diff", diff },
    {
      kind: "assistant-content",
      messageId: "m",
      content: "answer",
      incomplete: true,
    },
    { kind: "thought", summaryId: "t", content: "summary", incomplete: true },
  ];
  assert.deepEqual(live.slice(-4), terminal);
  assert.deepEqual(retained, terminal);
});

test(`m10-audit-production-harness-parts-in-doubles: success handoff stays exclusive against a queued shutdown`, async () => {
  const scripted = scriptedPreparation();
  const success = Promise.withResolvers<PrepareResult>();
  const shutdown = Promise.withResolvers<void>();
  let scoped: PrepareOptions | undefined;
  const adapter = ownPreparations({
    prepare(options) {
      scoped = options;
      return success.promise;
    },
  });
  const pending = adapter.prepare({
    workspace: process.cwd(),
    process: scripted.process,
  });
  assert.ok(scoped);
  const acquired = await scoped.process.spawnOwnedProcess({
    role: "harness-runtime",
    executable: "scripted",
    args: [],
    cwd: process.cwd(),
    env: {},
    launchTimeoutMs: 100,
  });
  assert.ok(acquired.ok);
  const harness: PreparedHarness = {
    profile: fakeHarnessProfile(),
    readDefaults: async () => ({ kind: "unavailable", reason: "unused" }),
    startTurn() {
      throw new Error("no Turn");
    },
    async close() {
      await acquired.process.closeStdin(0);
      return { clean: true, detail: "closed" };
    },
  };
  // The owner observes success first. Shutdown is the immediately following
  // microtask, which must never see an acquisition the caller already owns.
  void success.promise.then(() => {
    void adapter.close().then(() => shutdown.resolve());
  });
  success.resolve({ ok: true, harness });
  try {
    const result = await pending;
    assert.ok(result.ok);
    await shutdown.promise;
    assert.deepEqual(
      scripted.closes,
      [],
      "no initial owner cleanup after transfer",
    );
    assert.deepEqual((await adapter.close()).preparations, []);
  } finally {
    await harness.close();
    await adapter.close();
  }
  assert.equal(
    scripted.closes.length,
    1,
    "only the Prepared Harness closes its resource",
  );
});

test(`m10-audit-production-harness-parts-in-doubles: initial preparation stops reporting after its deadline snapshot`, async () => {
  const clock = preparationClock();
  const result = Promise.withResolvers<PrepareResult>();
  const phases: HarnessPhaseFact[] = [];
  const containment: string[] = [];
  let scoped: PrepareOptions | undefined;
  const adapter = ownPreparations(
    {
      prepare(options) {
        scoped = options;
        return result.promise;
      },
    },
    clock.clock,
  );
  const pending = adapter.prepare({
    workspace: process.cwd(),
    process: createFakeProcess({}),
    phases: (fact) => phases.push(fact),
    containment: (fact) => containment.push(fact.kind),
  });
  assert.ok(scoped);
  const fact: HarnessPhaseFact = { kind: "phase-start", phase: "launch" };
  scoped.phases?.(fact);
  scoped.containment?.({ kind: "contained" });
  assert.deepEqual(phases, [fact]);
  assert.deepEqual(containment, ["contained"]);
  const closing = adapter.close();
  assert.deepEqual(clock.scheduled(), [5000]);
  clock.advance(5000);
  const report = await closing;
  assert.equal(report.status, "unresolved");
  scoped.phases?.(fact);
  scoped.containment?.({ kind: "contained" });
  assert.deepEqual(phases, [fact]);
  assert.deepEqual(containment, ["contained"]);
  result.resolve({
    ok: false,
    failure: {
      phase: "prepare",
      category: "preparation-cancelled",
      possibleEffects: "none",
    },
  });
  assert.equal((await pending).ok, false);
  assert.strictEqual(await adapter.close(), report);
});
