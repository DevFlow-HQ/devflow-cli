import assert from "node:assert/strict";
import test from "node:test";
import { readHistoryText } from "./history-content-fixture.js";
import { openLiveRun } from "../helpers/liveRun.js";

test("m10-audit-history-tool-content: huge supplied diffs reconstruct exactly through bounded exact-version reads", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  run.owner.admitTurn({
    turnId: "turn",
    session: "s",
    attemptId: "0.0:echo",
    origin: "human",
    kind: "interactive-agent",
    input: "Input",
    recoveryCoordinate: "private",
    harness: "codex",
    at: new Date(),
  });
  const patch = '界😀\\"\n'.repeat(1_000_000) + "LAST PATCH LINE";
  assert.ok(Buffer.byteLength(patch) > 9 * 1024 * 1024);
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "turn-diff",
      data: {
        content: patch,
        files: [{ path: "src/file.ts", kind: "update" }],
      },
    },
    at: new Date(),
  });
  const opened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(() => opened.close());
  assert.ok(opened.snapshot.result.found);
  assert.ok(Buffer.byteLength(JSON.stringify(opened.snapshot)) < 32_768);
  const value = opened.snapshot.result.history.rows.at(-1)!.value;
  assert.equal(value.kind, "turn-diff");
  assert.ok(value.kind === "turn-diff" && value.detail);
  let escaped = false;
  const callerRequest = {
    reference: value.detail,
    textEdges: () => {
      escaped = true;
      return { dropLeading: 0, dropTrailing: 0, dropLeadingLf: false };
    },
  };
  const bounded = await run.port.readHistoryContent(callerRequest);
  assert.ok(bounded.found && bounded.type === "history-text");
  assert.equal(
    escaped,
    false,
    "Port callers cannot receive a retained source iterator",
  );
  assert.ok(bounded.content.length <= 4096);
  run.port.releaseHistoryRead(bounded.readId);
  let continuation: string | undefined;
  let reconstructed = "";
  let readId: string | undefined;
  do {
    const read = await run.port.readHistoryContent({
      reference: value.detail,
      continuation,
    });
    assert.ok(read.found && read.type === "history-text");
    assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 32_768);
    reconstructed += read.content;
    continuation = read.next;
    readId = read.readId;
  } while (continuation);
  assert.equal(reconstructed, patch);
  run.port.releaseHistoryRead(readId!);
});

function admit(run: Awaited<ReturnType<typeof openLiveRun>>) {
  run.owner.admitTurn({
    turnId: "turn",
    session: "s",
    attemptId: "0.0:echo",
    origin: "human",
    kind: "interactive-agent",
    input: "Input",
    recoveryCoordinate: "private",
    harness: "codex",
    at: new Date(),
  });
}
function current(run: Awaited<ReturnType<typeof openLiveRun>>) {
  return run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
}
function text(
  run: Awaited<ReturnType<typeof openLiveRun>>,
  reference: import("../../src/application/projection-port.js").HistoryTextReference,
) {
  return readHistoryText(run.port, reference);
}

test("m10-audit-history-tool-content: every tool field and 200 maximum command tails stay compact and retain exact values", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run);
  const tail = '😀\\"\n'.repeat(10000);
  for (let i = 0; i < 200; i++)
    run.owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "tool-call",
        data: {
          callId: `c${i}`,
          tool: "command",
          input: `cmd ${i}`,
          outcome: { kind: "completed" },
          output: { text: tail },
        },
      },
      at: new Date(),
    });
  const opened = current(run);
  t.after(opened.close);
  assert.ok(opened.snapshot.result.found);
  assert.equal(opened.snapshot.result.history.rows.length, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(opened.snapshot)) < 1024 * 1024);
  for (const row of opened.snapshot.result.history.rows) {
    assert.ok(row.value.kind === "tool" && row.value.output?.reference);
    assert.equal(
      await text(run, row.value.output.reference),
      tail.slice(-30000),
    );
    assert.equal(row.value.output.secantDropped, true);
  }
  const input = "COMMAND " + "界".repeat(25000),
    cwd = "DIR " + "x".repeat(25000),
    error = "ERROR " + "e".repeat(25000),
    omission = "OMITTED " + "o".repeat(25000),
    unit = "UNIT " + "u".repeat(25000);
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "tool-call",
      data: {
        callId: "metadata",
        tool: "other",
        input,
        cwd,
        outcome: { kind: "failed", error },
        nativeOmission: omission,
        count: { value: 3, unit },
        files: Array.from({ length: 500 }, (_, i) => ({
          path: `FILE ${i} ` + "p".repeat(3000),
          kind: "update",
          additions: i,
          removals: 2,
          patch: {
            kind: "structured",
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-界", "+😀"],
              },
            ],
          },
        })),
      },
    },
    at: new Date(),
  });
  const updated = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(
    updated.value?.kind === "durable" && updated.value.snapshot.result.found,
  );
  const value = updated.value.snapshot.result.history.rows.at(-1)!.value;
  assert.ok(value.kind === "tool" && value.detail && value.filesReference);
  assert.equal(value.fileCount, 500);
  assert.equal(value.files?.length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 32768);
  const detail = await text(run, value.detail);
  for (const supplied of [
    input,
    cwd,
    error,
    omission,
    unit,
    "FILE 499 " + "p".repeat(3000),
  ])
    assert.ok(detail.includes(supplied));
  const list = await run.port.readHistoryContent({
    reference: value.filesReference,
  });
  assert.ok(list.found && list.type === "history-items");
  assert.equal(list.items.length, 8);
  const first = list.items[0]!;
  assert.ok(first.kind === "file" && first.patch?.kind === "structured");
  assert.equal(await text(run, first.path), "FILE 0 " + "p".repeat(3000));
  assert.equal(first.change, "update");
  assert.equal(first.additions, 0);
  assert.equal(first.removals, 2);
  const hunks = await run.port.readHistoryContent({
    reference: first.patch.hunks,
  });
  assert.ok(hunks.found && hunks.type === "history-items");
  const hunk = hunks.items[0]!;
  assert.ok(hunk.kind === "hunk");
  assert.equal(hunk.oldStart, 1);
  assert.equal(hunk.newLines, 1);
  const lines = await run.port.readHistoryContent({ reference: hunk.lines });
  assert.ok(lines.found && lines.type === "history-items");
  for (const [i, line] of lines.items.entries()) {
    assert.ok(line.kind === "line");
    assert.equal(await text(run, line.content), ["-界", "+😀"][i]);
  }
  for (const read of [list, hunks, lines])
    run.port.releaseHistoryRead(read.readId);
});

for (const length of [29999, 30000, 30001])
  test(`m10-audit-history-tool-content: command retention at ${length} characters`, async (t) => {
    const run = await openLiveRun(t);
    t.after(run.finish);
    admit(run);
    const supplied = "x".repeat(length - 1) + "Z";
    run.owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "tool-call",
        data: {
          callId: "c",
          tool: "command",
          input: "cmd",
          outcome: { kind: "completed" },
          output: { text: supplied },
        },
      },
      at: new Date(),
    });
    const opened = current(run);
    t.after(opened.close);
    assert.ok(opened.snapshot.result.found);
    const value = opened.snapshot.result.history.rows.at(-1)!.value;
    assert.ok(value.kind === "tool" && value.output?.reference);
    assert.equal(
      await text(run, value.output.reference),
      supplied.slice(-30000),
    );
    assert.equal(value.output.secantDropped, length > 30000 ? true : undefined);
  });

test("m10-audit-history-tool-content: live versions pin only active reads; reclamation, mismatch, settlement and independent close are precise", async (t) => {
  let flush = () => {};
  const run = await openLiveRun(t, {
    scheduleHistoryPreview: (callback) => {
      flush = callback;
      return () => {
        flush = () => {};
      };
    },
  });
  t.after(run.finish);
  admit(run);
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "tool-call",
      data: {
        callId: "c",
        tool: "command",
        input: "cmd",
        outcome: { kind: "running" },
      },
    },
    at: new Date(),
  });
  const one = current(run),
    two = current(run);
  t.after(one.close);
  t.after(two.close);
  const preview = (content: string) => {
    run.channel.observe({
      tool: {
        turnId: "turn",
        session: "s",
        call: {
          callId: "c",
          tool: "command",
          input: "cmd",
          outcome: { kind: "running" },
          output: { text: content },
        },
      },
    });
    flush();
  };
  preview("A".repeat(10000));
  const page = await one.updates[Symbol.asyncIterator]().next();
  assert.ok(page.value?.kind === "history-preview");
  const a = page.value.row.value;
  assert.ok(a.kind === "tool" && a.output?.reference);
  const first = await run.port.readHistoryContent({
    reference: a.output.reference,
  });
  assert.ok(first.found && first.type === "history-text" && first.next);
  preview("B".repeat(10000));
  const next = await two.updates[Symbol.asyncIterator]().next();
  assert.ok(next.value?.kind === "history-preview");
  const b = next.value.row.value;
  assert.ok(b.kind === "tool" && b.output?.reference);
  const pinned = await run.port.readHistoryContent({
    reference: a.output.reference,
    continuation: first.next,
  });
  assert.ok(pinned.found && pinned.type === "history-text");
  assert.equal(pinned.content, "A".repeat(4095));
  const mismatched = await run.port.readHistoryContent({
    reference: b.output.reference,
    continuation: first.next,
  });
  assert.ok(!mismatched.found);
  assert.equal(mismatched.problem.code, "history-continuation-mismatch");
  const second = await run.port.readHistoryContent({
    reference: b.output.reference,
  });
  assert.ok(second.found);
  one.close();
  assert.ok(second.next);
  const independent = await run.port.readHistoryContent({
    reference: b.output.reference,
    continuation: second.next,
  });
  assert.ok(independent.found);
  const released = await run.port.readHistoryContent({
    reference: a.output.reference,
    continuation: first.next,
  });
  assert.ok(!released.found);
  preview("C".repeat(10000));
  run.port.releaseHistoryRead(second.readId);
  assert.ok(
    !(await run.port.readHistoryContent({ reference: b.output.reference }))
      .found,
  );
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "tool-call",
      data: {
        callId: "c",
        tool: "command",
        input: "cmd",
        outcome: { kind: "completed" },
        output: { text: "FINAL".repeat(2000) },
      },
    },
    at: new Date(),
  });
  const final = await two.updates[Symbol.asyncIterator]().next();
  assert.ok(
    final.value?.kind === "durable" && final.value.snapshot.result.found,
  );
  const stored = final.value.snapshot.result.history.rows.at(-1)!.value;
  assert.ok(stored.kind === "tool" && stored.output?.reference);
  two.close();
  assert.equal(await text(run, stored.output.reference), "FINAL".repeat(2000));
  const invalid = await run.port.readHistoryContent({
    reference: { ...stored.output.reference, id: "unknown" },
  });
  assert.ok(!invalid.found);
  const wrongRun = await run.port.readHistoryContent({
    reference: { ...stored.output.reference, runId: "wrong" },
  });
  assert.ok(!wrongRun.found);
  const wrongType = await run.port.readHistoryContent({
    reference: { ...stored.output.reference, type: "history-items" },
  });
  assert.ok(!wrongType.found);
});

for (const final of ["empty", "absent"] as const)
  test(`m10-audit-history-tool-content: ${final} final preserves tail semantics and never revives a preview`, async (t) => {
    const run = await openLiveRun(t);
    t.after(run.finish);
    admit(run);
    run.owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "tool-call",
        data: {
          callId: "c",
          tool: "command",
          input: "cmd",
          outcome: { kind: "running" },
        },
      },
      at: new Date(),
    });
    const opened = current(run);
    t.after(opened.close);
    run.channel.observe({
      tool: {
        turnId: "turn",
        session: "s",
        call: {
          callId: "c",
          tool: "command",
          input: "cmd",
          outcome: { kind: "running" },
          output: { text: "PREVIEW".repeat(4000) },
        },
      },
    });
    run.owner.appendTurnEvent({
      turnId: "turn",
      fact: {
        kind: "tool-call",
        data: {
          callId: "c",
          tool: "command",
          input: "cmd",
          outcome: { kind: "completed" },
          ...(final === "empty" ? { output: { text: "" } } : {}),
        },
      },
      at: new Date(),
    });
    const page = await opened.updates[Symbol.asyncIterator]().next();
    assert.ok(
      page.value?.kind === "durable" && page.value.snapshot.result.found,
    );
    const value = page.value.snapshot.result.history.rows.at(-1)!.value;
    assert.ok(value.kind === "tool" && value.output);
    if (final === "empty") {
      assert.equal(value.output.text, "");
      assert.equal(value.output.reference, undefined);
    } else {
      assert.ok(value.output.reference);
      assert.equal(
        await text(run, value.output.reference),
        "PREVIEW".repeat(4000),
      );
      assert.equal(value.output.incomplete, true);
    }
    assert.equal(
      run.owner.turnEvents().filter((event) => event.kind === "tool-call")
        .length,
      2,
    );
  });

test("m10-audit-history-tool-content: reverse Unicode boundaries, bounded read leases, abort, stored release and deletion", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run);
  const patch = "a".repeat(4094) + "😀" + "界".repeat(9000);
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: { kind: "turn-diff", data: { content: patch, files: [] } },
    at: new Date(),
  });
  const opened = current(run);
  t.after(opened.close);
  assert.ok(opened.snapshot.result.found);
  const value = opened.snapshot.result.history.rows.at(-1)!.value;
  assert.ok(value.kind === "turn-diff" && value.detail);
  const first = await run.port.readHistoryContent({ reference: value.detail });
  assert.ok(first.found && first.type === "history-text" && first.next);
  assert.equal(first.content, "a".repeat(4094));
  const second = await run.port.readHistoryContent({
    reference: value.detail,
    continuation: first.next,
  });
  assert.ok(second.found && second.type === "history-text" && second.previous);
  assert.ok(second.content.startsWith("😀"));
  const back = await run.port.readHistoryContent({
    reference: value.detail,
    continuation: second.previous,
  });
  assert.ok(back.found && back.type === "history-text");
  assert.equal(back.content, first.content);
  run.port.releaseHistoryRead(first.readId);
  const leases: string[] = [];
  for (let i = 0; i < 32; i++) {
    const read = await run.port.readHistoryContent({ reference: value.detail });
    assert.ok(read.found);
    leases.push(read.readId);
  }
  const limit = await run.port.readHistoryContent({ reference: value.detail });
  assert.ok(!limit.found);
  assert.equal(limit.problem.code, "history-read-limit");
  for (const lease of leases) run.port.releaseHistoryRead(lease);
  const abort = new AbortController();
  const active = await run.port.readHistoryContent({
    reference: value.detail,
    signal: abort.signal,
  });
  assert.ok(active.found && active.next);
  abort.abort();
  const ended = await run.port.readHistoryContent({
    reference: value.detail,
    continuation: active.next,
  });
  assert.ok(!ended.found);
  assert.equal(await text(run, value.detail), patch);
  await run.finish();
  const deleted = run.port.submit({
    operation: "delete-run",
    operationId: "delete-content",
    input: { runId: run.runId },
  });
  assert.ok(deleted.admitted);
  const receipt = await run.port.settledOperation("delete-content");
  assert.equal(receipt.outcome.status, "applied");
  assert.ok(
    !(await run.port.readHistoryContent({ reference: value.detail })).found,
  );
});

test("m10-audit-history-tool-content: an unmatched large stored start remains readable after a preview and lost settlement", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  admit(run);
  const input = "CANONICAL_INPUT_" + "x".repeat(10000);
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "tool-call",
      data: {
        callId: "c",
        tool: "other",
        input,
        outcome: { kind: "running" },
      },
    },
    at: new Date(),
  });
  const opened = current(run);
  t.after(opened.close);
  run.channel.observe({
    tool: {
      turnId: "turn",
      session: "s",
      call: {
        callId: "c",
        tool: "other",
        input,
        outcome: { kind: "running" },
        output: { text: "LIVE_ONLY" },
      },
    },
  });
  run.owner.settleTurn({
    turnId: "turn",
    session: "s",
    resultKind: "lost",
    resultDetail: "{}",
    availability: "unusable",
    at: new Date(),
  });
  const page = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(page.value?.kind === "durable" && page.value.snapshot.result.found);
  assert.ok(!page.done);
  const value = page.value.snapshot.result.history.rows.find(
    (row) => row.value.kind === "tool",
  )?.value;
  assert.ok(value?.kind === "tool" && value.detail);
  assert.equal(value.outcome.kind, "unconfirmed");
  assert.equal(await text(run, value.detail), "Input\n" + input);
  assert.equal(value.output, undefined);
});

test("m10-audit-history-tool-content: stored-read failures preserve their cause and remain local and retryable", async (t) => {
  const cause = new Error("retained-read failed");
  let fail = true;
  const run = await openLiveRun(t, {
    onRetainedEventRead: () => {
      if (fail) throw cause;
    },
  });
  t.after(run.finish);
  admit(run);
  run.owner.appendTurnEvent({
    turnId: "turn",
    fact: {
      kind: "turn-diff",
      data: { content: "PATCH".repeat(2000), files: [] },
    },
    at: new Date(),
  });
  const opened = current(run);
  t.after(opened.close);
  assert.ok(opened.snapshot.result.found);
  const value = opened.snapshot.result.history.rows.at(-1)!.value;
  assert.ok(value.kind === "turn-diff" && value.detail);
  const refused = await run.port.readHistoryContent({
    reference: value.detail,
  });
  assert.ok(!refused.found);
  assert.equal(refused.problem.code, "run-store-damaged");
  assert.equal(refused.problem.cause, cause);
  fail = false;
  assert.equal(await text(run, value.detail), "PATCH".repeat(2000));
  const reopened = current(run);
  t.after(reopened.close);
  assert.ok(reopened.snapshot.result.found);
  assert.equal(
    reopened.snapshot.result.history.rows.at(-1)?.id ===
      opened.snapshot.result.history.rows.at(-1)?.id,
    false,
  );
});
