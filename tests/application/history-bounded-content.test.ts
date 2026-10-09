import assert from "node:assert/strict";
import test from "node:test";
import type {
  HistoryTextReference,
  ProjectionUpdate,
  SessionHistoryRow,
  SessionHistorySnapshot,
  SessionHistoryValue,
} from "../../src/application/projection-port.js";
import { readHistoryText } from "./history-content-fixture.js";
import { openLiveRun, UNREAD_UNIT_BOUND } from "../helpers/liveRun.js";

type LiveRun = Awaited<ReturnType<typeof openLiveRun>>;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// The worst-case escaped, multibyte and control text each retained field carries.
const hostile = '界😀\\"\n\u0001 \ud800';
const huge = (label: string, repeat = 20_000) =>
  `${label} ` + hostile.repeat(repeat) + ` END ${label}`;

function clock() {
  let callback: (() => void) | undefined;
  return {
    schedule: (next: () => void) => {
      callback = next;
      return () => {
        callback = undefined;
      };
    },
    flush: () => {
      const next = callback;
      callback = undefined;
      next?.();
    },
  };
}
function admit(
  run: LiveRun,
  turnId: string,
  input: string,
  origin: "human" | "managed" = "human",
) {
  assert.ok(
    run.owner.admitTurn({
      turnId,
      session: "s",
      attemptId: "0.0:echo",
      origin,
      kind: "interactive-agent",
      input,
      recoveryCoordinate: "private",
      harness: "codex",
      at: new Date("2026-10-09T00:00:00Z"),
    }).ok,
  );
}
function append(run: LiveRun, kind: string, data: object, turnId = "turn") {
  assert.ok(
    run.owner.appendTurnEvent({
      turnId,
      kind,
      payload: JSON.stringify(data),
      at: new Date("2026-10-09T00:00:01Z"),
    }).ok,
  );
}
function open(t: test.TestContext, run: LiveRun) {
  const opened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => opened.close());
  return opened;
}
function rowsOf(
  snapshot: SessionHistorySnapshot,
): readonly SessionHistoryRow[] {
  assert.ok(snapshot.result.found);
  return snapshot.result.history.rows;
}
/** Every string a value carries inline must fit its private preview bound. */
function assertCompact(value: SessionHistoryValue): void {
  assert.ok(bytes(value) <= 16 * 1024, `${value.kind} row stays compact`);
}

test("m10-audit-history-bounded-content: messages, Thoughts, prompts, Steers, Agent calls and metadata reconstruct exactly from bounded previews", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  const input = huge("INPUT");
  const prompt = huge("PROMPT");
  admit(run, "turn", input);
  const assistant = huge("ASSISTANT");
  const thought = huge("THOUGHT");
  const steer = huge("STEER");
  const refusal = huge("REFUSAL");
  const call = huge("CALL", 2_000);
  const tool = huge("REQUEST TOOL", 2_000);
  const requestInput = huge("REQUEST INPUT", 2_000);
  const activity = huge("ACTIVITY", 2_000);
  const elicitation = huge("ELICITATION", 2_000);
  const model = huge("MODEL", 2_000);
  const step = "x".repeat(40_000);
  append(run, "assistant-content", { messageId: "m", content: assistant });
  append(run, "thought", { summaryId: "t", content: thought, durationMs: 4 });
  append(run, "steer", {
    steerId: "s",
    text: steer,
    sentAt: "2026-10-09T00:00:01.000Z",
    settlement: { kind: "delivered", delivery: "within-turn" },
  });
  append(run, "agent-call", {
    callId: "c",
    id: call,
    reason: "R".repeat(400),
    answer: { outcome: "refused", reason: refusal },
  });
  append(run, "request-raised", { requestId: "r", tool, input: requestInput });
  append(run, "tool-activity", { tool: activity, summary: activity });
  append(run, "elicitation-declined", { message: elicitation });
  append(run, "model", { model });
  assert.ok(
    run.owner.settleTurn({
      turnId: "turn",
      session: "s",
      resultKind: "completed",
      resultDetail: "{}",
      availability: "open",
      at: new Date("2026-10-09T00:00:02Z"),
    }).ok,
  );
  assert.ok(
    run.owner.admitTurn({
      turnId: "managed",
      session: "s",
      attemptId: `0.0:${step}`,
      origin: "managed",
      kind: "agent",
      input: prompt,
      recoveryCoordinate: "private",
      harness: "codex",
      at: new Date("2026-10-09T00:00:03Z"),
    }).ok,
  );
  const opened = open(t, run);
  const rows = rowsOf(opened.snapshot);
  assert.ok(bytes(opened.snapshot) < 256 * 1024);
  const byKind = (kind: SessionHistoryValue["kind"]) =>
    rows.filter((row) => row.value.kind === kind).map((row) => row.value);
  for (const row of rows) {
    assertCompact(row.value);
    assert.ok(bytes(row) <= 18 * 1024, "row headers are bounded too");
  }
  const text = (reference: HistoryTextReference | undefined) => {
    assert.ok(reference, "a truncated value names its retained content");
    return readHistoryText(run.port, reference);
  };
  const [user] = byKind("message").filter(
    (value) => value.kind === "message" && value.role === "user",
  );
  const [reply] = byKind("message").filter(
    (value) => value.kind === "message" && value.role === "assistant",
  );
  assert.ok(user?.kind === "message" && reply?.kind === "message");
  assert.equal(await text(user.reference), input);
  assert.equal(await text(reply.reference), assistant);
  assert.ok(input.startsWith(user.content.slice(0, -1)));
  const [thoughtValue] = byKind("thought");
  assert.ok(thoughtValue?.kind === "thought");
  assert.equal(thoughtValue.durationMs, 4);
  assert.equal(await text(thoughtValue.reference), thought);
  const [steerValue] = byKind("steer");
  assert.ok(steerValue?.kind === "steer");
  assert.equal(steerValue.delivery, "within-turn");
  assert.equal(await text(steerValue.reference), steer);
  const [prompted] = byKind("entry-prompt");
  assert.ok(prompted?.kind === "entry-prompt");
  assert.equal(await text(prompted.reference), prompt);
  const managedRow = rows.find((row) => row.value.kind === "entry-prompt")!;
  // A cut Step id keeps a digest so a Step sharing the prefix stays distinct.
  const header = /^(x+)… #[0-9a-f]{8}$/.exec(managedRow.step ?? "");
  assert.ok(header && step.startsWith(header[1]!));
  assert.ok(Buffer.byteLength(JSON.stringify(managedRow.step)) <= 1024);
  const [agent] = byKind("agent-call");
  assert.ok(agent?.kind === "agent-call");
  assert.equal(agent.reply, "refused");
  assert.equal(agent.disposition, "completed");
  assert.equal(agent.reason, "R".repeat(400));
  const agentDetail = await text(agent.detail);
  for (const supplied of [call, "R".repeat(400), refusal])
    assert.ok(agentDetail.includes(supplied));
  const descriptions = [...byKind("request"), ...byKind("activity")];
  const full = [
    `Harness Request raised · ${tool} · ${requestInput}`,
    `${activity}  · ${activity}`,
    `Elicitation declined · ${elicitation}`,
  ];
  for (const expected of full) {
    const value = descriptions.find(
      (value) =>
        (value.kind === "request" || value.kind === "activity") &&
        expected.startsWith(value.description.slice(0, -1)) &&
        value.description.endsWith("…"),
    );
    assert.ok(
      value?.kind === "request" || value?.kind === "activity",
      expected.slice(0, 40),
    );
    assert.equal(await text(value.detail), expected);
  }
  const [result] = byKind("turn-result");
  assert.ok(result?.kind === "turn-result");
  assert.equal(result.result, "completed");
  assert.ok(model.startsWith(result.model!.slice(0, -1)));
  assert.ok((await text(result.detail)).includes(model));
});

test("m10-audit-history-bounded-content: small values remain complete inline values without references", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run, "turn", "Short input");
  append(run, "assistant-content", { messageId: "m", content: "Short reply" });
  append(run, "thought", { summaryId: "t", content: "Short thought" });
  const rows = rowsOf(open(t, run).snapshot);
  assert.deepEqual(
    rows.map((row) => row.value),
    [
      { kind: "message", role: "user", content: "Short input" },
      { kind: "message", role: "assistant", content: "Short reply" },
      { kind: "thought", content: "Short thought" },
    ],
  );
});

test("m10-audit-history-bounded-content: a 150/200 mixed burst keeps the complete page and unread previews within the encoded allowance", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run, "turn", huge("INPUT"));
  const slow = open(t, run);
  const tail = hostile.repeat(30_000 / hostile.length + 1).slice(-30_000);
  const separate = [
    () =>
      append(run, "assistant-content", { messageId: "m", content: huge("M") }),
    () => append(run, "thought", { summaryId: "t", content: huge("T") }),
    () =>
      append(run, "tool-call", {
        callId: "error",
        tool: "other",
        input: huge("IN"),
        outcome: { kind: "failed", error: huge("ERROR") },
        files: Array.from({ length: 40 }, (_, i) => ({
          path: `${i} ${huge("PATH", 200)}`,
          patch: { kind: "unified", content: huge("PATCH") },
        })),
      }),
    () =>
      append(run, "agent-call", {
        callId: "c",
        id: huge("ID", 2_000),
        reason: "Reason",
        answer: { outcome: "refused", reason: huge("REASON") },
      }),
    () =>
      append(run, "steer", {
        steerId: "s",
        text: huge("STEER"),
        sentAt: "2026-10-09T00:00:01.000Z",
        settlement: { kind: "waiting" },
      }),
  ];
  for (const write of separate) write();
  for (let i = 0; i < 150; i++)
    append(run, "tool-call", {
      callId: `command-${i}`,
      tool: "command",
      input: `build ${i}`,
      outcome: { kind: "completed" },
      output: { text: tail },
    });
  // Fill the newest-200 window, then pass it by one stored row.
  for (let i = 0; i < 45; i++)
    append(run, "assistant-content", {
      messageId: `extra-${i}`,
      content: huge(`EXTRA ${i}`, 1_000),
    });
  // Each retained row gets one later live preview while the observer is not reading.
  for (let i = 0; i < 200; i++) {
    run.channel.observe({
      message: {
        turnId: "turn",
        session: "s",
        messageId: `live-${i}`,
        content: huge(`LIVE ${i}`),
      },
    });
    timer.flush();
  }
  const late = open(t, run);
  const lateRows = rowsOf(late.snapshot);
  assert.equal(lateRows.length, 200);
  assert.ok(
    late.snapshot.result.found && late.snapshot.result.history.hasEarlier,
  );
  assert.ok(bytes(late.snapshot) <= UNREAD_UNIT_BOUND);
  // Drain everything the slow observer retained: none of it ended the subscription.
  const unread: ProjectionUpdate<SessionHistorySnapshot>[] = [];
  const reader = slow.updates[Symbol.asyncIterator]();
  for (;;) {
    let ready = false;
    const next = reader.next().then((result) => {
      ready = true;
      return result;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    if (!ready) break;
    const result = await next;
    assert.ok(!result.done);
    unread.push(result.value);
  }
  assert.ok(unread.length > 0);
  assert.ok(unread.every((update) => update.kind !== "closed"));
  assert.ok(
    unread.reduce((sum, update) => sum + bytes(update), 0) <= UNREAD_UNIT_BOUND,
    "complete unread page plus later previews fit 8 MiB",
  );
  const pages = unread.filter((update) => update.kind === "durable");
  assert.ok(pages.length <= 1, "at most one unread page is retained");
  const lastLive = lateRows.at(-1)!.value;
  assert.ok(lastLive.kind === "message" && lastLive.reference);
  assert.equal(
    await readHistoryText(run.port, lastLive.reference),
    huge("LIVE 199"),
  );
});

test("m10-audit-history-bounded-content: worst-case rows in every field keep a full page and a later preview per row within the allowance", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run, "turn", "Input");
  const slow = open(t, run);
  const maximal = (callId: string) => ({
    callId,
    tool: "other" as const,
    input: huge("IN", 300),
    cwd: huge("CWD", 300),
    nativeOmission: huge("OMIT", 300),
    count: { value: 1, unit: huge("UNIT", 300) },
    outcome: { kind: "running" as const },
    output: { text: huge("OUT", 300) },
    files: Array.from({ length: 12 }, (_, i) => ({
      path: `${i} ${huge("PATH", 100)}`,
      kind: "update" as const,
      additions: 123_456_789,
      removals: 123_456_789,
      patch: { kind: "unified" as const, content: "x" },
    })),
  });
  // Running stored starts accept one later live preview each.
  for (let i = 0; i < 200; i++)
    append(run, "tool-call", maximal(`stored-${i}`));
  for (let i = 0; i < 200; i++) {
    run.channel.observe({
      tool: { turnId: "turn", session: "s", call: maximal(`stored-${i}`) },
    });
    timer.flush();
  }
  const unread: ProjectionUpdate<SessionHistorySnapshot>[] = [];
  const reader = slow.updates[Symbol.asyncIterator]();
  for (;;) {
    let ready = false;
    const next = reader.next().then((result) => {
      ready = true;
      return result;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    if (!ready) break;
    const result = await next;
    assert.ok(!result.done && result.value.kind !== "closed");
    unread.push(result.value);
  }
  const page = unread.find((update) => update.kind === "durable");
  assert.ok(page?.kind === "durable");
  for (const row of rowsOf(page.snapshot))
    assert.ok(bytes(row) <= 18 * 1024, `${bytes(row)} bytes`);
  const previews = unread.filter((update) => update.kind === "history-preview");
  assert.equal(previews.length, 200);
  for (const update of previews) assert.ok(bytes(update) <= 18 * 1024);
  assert.ok(
    unread.reduce((sum, update) => sum + bytes(update), 0) <= UNREAD_UNIT_BOUND,
  );
  // A settled failure adds its error inside the same per-row bound.
  append(run, "tool-call", {
    ...maximal("failed"),
    outcome: { kind: "failed", error: huge("ERROR", 300) },
  });
  const failed = rowsOf(open(t, run).snapshot).at(-1)!;
  assert.ok(
    failed.value.kind === "tool" && failed.value.outcome.kind === "failed",
  );
  assert.ok(bytes(failed) <= 18 * 1024, `${bytes(failed)} bytes`);
});

test("m10-audit-history-bounded-content: a live preview over a stored running start reads its own live value", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  admit(run, "turn", "Input");
  const call = (output: string) => ({
    callId: "c",
    tool: "command" as const,
    input: "cmd",
    outcome: { kind: "running" as const },
    output: { text: output },
  });
  append(run, "tool-call", call(huge("STORED", 1_500)));
  const opened = open(t, run);
  const stored = rowsOf(opened.snapshot).at(-1)!.value;
  assert.ok(stored.kind === "tool" && stored.output?.reference);
  run.channel.observe({
    tool: { turnId: "turn", session: "s", call: call(huge("LIVE", 1_500)) },
  });
  timer.flush();
  const update = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(!update.done && update.value.kind === "history-preview");
  const live = update.value.row.value;
  assert.ok(live.kind === "tool" && live.output?.reference);
  assert.equal(
    await readHistoryText(run.port, live.output.reference),
    huge("LIVE", 1_500),
  );
  assert.equal(
    await readHistoryText(run.port, stored.output.reference),
    huge("STORED", 1_500),
  );
});

test("m10-audit-history-bounded-content: message content keeps exact versions through stale, delayed, live-to-stored, reopen and deletion", async (t) => {
  const timer = clock();
  const run = await openLiveRun(t, { scheduleHistoryPreview: timer.schedule });
  t.after(run.finish);
  const input = huge("INPUT", 2_000);
  admit(run, "turn", input);
  const first = open(t, run);
  const userRef = rowsOf(first.snapshot)[0]!.value;
  assert.ok(userRef.kind === "message" && userRef.reference);
  const live = (content: string) => {
    run.channel.observe({
      message: { turnId: "turn", session: "s", messageId: "m", content },
    });
    timer.flush();
  };
  const reader = first.updates[Symbol.asyncIterator]();
  const latest = async () => {
    const update = await reader.next();
    assert.ok(
      !update.done &&
        (update.value.kind === "history-preview" ||
          update.value.kind === "durable"),
    );
    const row =
      update.value.kind === "history-preview"
        ? update.value.row
        : rowsOf(update.value.snapshot).at(-1)!;
    assert.ok(row.value.kind === "message" && row.value.reference);
    return row.value.reference;
  };
  live(huge("LIVE ONE", 2_000));
  const one = await latest();
  // A delayed traversal pins its exact live version across a newer preview.
  const delayed = await run.port.readHistoryContent({ reference: one });
  assert.ok(delayed.found && delayed.type === "history-text" && delayed.next);
  live(huge("LIVE TWO", 2_000));
  const two = await latest();
  const continued = await run.port.readHistoryContent({
    reference: one,
    continuation: delayed.next,
  });
  assert.ok(continued.found && continued.type === "history-text");
  assert.equal(
    huge("LIVE ONE", 2_000).slice(
      0,
      delayed.content.length + continued.content.length,
    ),
    delayed.content + continued.content,
  );
  run.port.releaseHistoryRead(continued.readId);
  const stale = await run.port.readHistoryContent({ reference: one });
  assert.ok(!stale.found);
  assert.equal(stale.problem.code, "history-content-stale");
  assert.equal(await readHistoryText(run.port, two), huge("LIVE TWO", 2_000));
  // Settlement replaces the live version with the stored one.
  append(run, "assistant-content", {
    messageId: "m",
    content: huge("STORED", 2_000),
  });
  const stored = await latest();
  assert.equal(await readHistoryText(run.port, stored), huge("STORED", 2_000));
  const reclaimed = await run.port.readHistoryContent({ reference: two });
  assert.ok(!reclaimed.found);
  // The Turn input's index-fact coordinate stays exact for a later observer.
  first.close();
  const later = rowsOf(open(t, run).snapshot)[0]!.value;
  assert.ok(later.kind === "message" && later.reference);
  assert.equal(await readHistoryText(run.port, later.reference), input);
  assert.equal(await readHistoryText(run.port, userRef.reference), input);
  await run.finish();
  const deleted = run.port.submit({
    operation: "delete-run",
    operationId: "delete-message-content",
    input: { runId: run.runId },
  });
  assert.ok(deleted.admitted);
  const receipt = await run.port.settledOperation("delete-message-content");
  assert.equal(receipt.outcome.status, "applied");
  for (const reference of [later.reference, stored])
    assert.ok(!(await run.port.readHistoryContent({ reference })).found);
});
