import { historyTextEdges, screenHistoryPortion } from "../../src/tui/tui.js";
import type { RunWorkbenchView } from "../../src/tui/tui.js";
import assert from "node:assert/strict";
import test from "node:test";
import { openLiveRun } from "../helpers/liveRun.js";
import {
  mountWorkbench,
  runOf,
  press,
  resizeWorkbench,
  noOverflow,
  previewPreferences,
} from "./run-workbench-fixture.js";
import type {
  HistoryContentRead,
  HistoryContentRequest,
} from "../../src/application/projection-port.js";

async function fixture(
  t: Parameters<typeof openLiveRun>[0],
  kind: "turn-diff" | "tool-call",
  payload: object,
  appearance: "dark" | "light" = "dark",
) {
  let pendingPreview: (() => void) | undefined;
  const run = await openLiveRun(t, {
    historyTextEdges,
    scheduleHistoryPreview(next) {
      pendingPreview = next;
      return () => {
        pendingPreview = undefined;
      };
    },
  });
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
  run.owner.appendTurnEvent({
    turnId: "turn",
    kind,
    payload: JSON.stringify(payload),
    at: new Date(),
  });
  const opened = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(opened.close);
  const preferences = previewPreferences();
  const wb = await mountWorkbench(
    runOf({
      runId: run.runId,
      sessions: [{ session: "s", name: "Conversation", availability: "open" }],
    }),
    100,
    30,
    undefined,
    true,
    undefined,
    {
      ...preferences,
      snapshot: () => ({
        ...preferences.snapshot(),
        preferences: { theme: "everforest", appearance },
      }),
    },
  );
  const reads: HistoryContentRequest[] = [],
    released: string[] = [];
  wb.control.setContentReader(
    (request) => {
      reads.push(request);
      return run.port.readHistoryContent(request);
    },
    (id) => {
      released.push(id);
      run.port.releaseHistoryRead(id);
    },
  );
  wb.control.setHistory(opened.snapshot);
  await wb.t.renderOnce();
  return {
    ...wb,
    run,
    opened,
    reads,
    released,
    flushPreview: () => {
      const next = pendingPreview;
      pendingPreview = undefined;
      next?.();
    },
  };
}
for (const appearance of ["dark", "light"] as const)
  test(`m10-audit-history-tool-content: ${appearance} huge patch inspection reads first and last portions through keyboard and click, resizes, and releases`, async (t) => {
    const patch =
      "PATCH_FIRST\n" + "x".repeat(10 * 1024 * 1024) + "\nPATCH_LAST";
    const wb = await fixture(
      t,
      "turn-diff",
      {
        content: patch,
        files: [
          { path: "observed.ts", kind: "update", additions: 0, removals: 7 },
        ],
      },
      appearance,
    );
    assert.match(wb.t.captureCharFrame(), /Turn diff/);
    assert.equal(wb.reads.length, 0);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    await wb.t.waitForFrame((frame) => frame.includes("PATCH_FIRST"));
    assert.equal(wb.reads.length, 1);
    for (const width of [40, 120, 121]) {
      resizeWorkbench(wb.t, wb.renderer, width, 15);
      await wb.t.renderOnce();
      noOverflow(wb.t.captureCharFrame(), width);
    }
    await press(wb.t, wb.renderer, "end");
    await wb.t.waitForFrame((frame) => frame.includes("PATCH_LAST"));
    assert.equal(wb.reads.length, 2);
    await press(wb.t, wb.renderer, "home");
    await wb.t.waitForFrame((frame) => frame.includes("PATCH_FIRST"));
    await press(wb.t, wb.renderer, "escape");
    assert.ok(wb.released.length > 0);
    resizeWorkbench(wb.t, wb.renderer, 100, 30);
    await wb.t.renderOnce();
    const y = wb.t
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Turn diff"));
    assert.ok(y >= 0);
    await wb.t.mockMouse.click(10, y);
    await wb.t.waitForFrame((frame) => frame.includes("PATCH_FIRST"));
  });

test("m10-audit-history-tool-content: output expansion loads locally, retries in place and discards dismissed and superseded replies", async (t) => {
  const wb = await fixture(t, "tool-call", {
    callId: "c",
    tool: "command",
    input: "build",
    outcome: { kind: "completed" },
    output: { text: "OUTPUT_FIRST\n" + "x".repeat(12000) + "\nOUTPUT_LAST" },
  });
  let reply: ((read: HistoryContentRead) => void) | undefined;
  let pendingRequest:
    Parameters<RunWorkbenchView["readHistoryContent"]>[0] | undefined;
  wb.control.setContentReader(
    (request) => {
      pendingRequest = request;
      return new Promise((resolve) => {
        reply = resolve;
      });
    },
    (id) => {
      wb.released.push(id);
      wb.run.port.releaseHistoryRead(id);
    },
  );
  assert.equal(wb.reads.length, 0);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /Loading retained content/);
  const selected = pendingRequest;
  assert.ok(selected);
  assert.ok(reply);
  reply({
    found: false,
    problem: {
      code: "test-read-failure",
      explanation: "Unavailable",
      remediation: "Retry",
      possibleEffects: "none",
    },
  });
  await wb.t.waitForFrame((frame) => frame.includes("test-read-failure"));
  assert.equal(
    wb.control.view.openRun(wb.run.runId).freshness().kind,
    "current",
  );
  assert.doesNotMatch(wb.t.captureCharFrame(), /disconnected/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /▸ Output/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /test-read-failure/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.ok(reply);
  reply({
    found: false,
    problem: {
      code: "test-read-failure",
      explanation: "Unavailable",
      remediation: "Retry",
      possibleEffects: "none",
    },
  });
  await wb.t.waitForFrame((frame) => frame.includes("test-read-failure"));
  wb.control.setContentReader(
    wb.run.port.readHistoryContent,
    wb.run.port.releaseHistoryRead,
  );
  const retryLine = wb.t
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes("Error [test-read-failure]"));
  assert.ok(retryLine >= 0);
  await wb.t.mockMouse.click(10, retryLine);
  await wb.t.waitForFrame(
    (frame) =>
      !frame.includes("test-read-failure") &&
      !frame.includes("Loading retained content"),
  );
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  wb.control.setContentReader(
    (request) => {
      pendingRequest = request;
      return new Promise((resolve) => {
        reply = resolve;
      });
    },
    (id) => {
      wb.released.push(id);
      wb.run.port.releaseHistoryRead(id);
    },
  );
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  const delayed = pendingRequest;
  assert.ok(delayed);
  const deliver = reply;
  assert.ok(deliver);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.equal(delayed.signal?.aborted, true);
  deliver({
    found: true,
    type: "history-text",
    content: "DISMISSED_REPLY",
    readId: "late",
  });
  await wb.t.renderOnce();
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /DISMISSED_REPLY/);
  assert.ok(wb.released.includes("late"));
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  const older = reply;
  assert.ok(older);
  wb.run.owner.appendTurnEvent({
    turnId: "turn",
    kind: "assistant-content",
    payload: JSON.stringify({ messageId: "m", content: "Other row" }),
    at: new Date(),
  });
  const updated = await wb.opened.updates[Symbol.asyncIterator]().next();
  assert.ok(updated.value?.kind === "durable");
  // Eviction/removal disposes the reader instead of resurrecting its old row.
  wb.control.setHistory({
    ...updated.value.snapshot,
    result: {
      found: true,
      history: {
        ...(updated.value.snapshot.result.found
          ? updated.value.snapshot.result.history
          : (() => {
              throw new Error("missing");
            })()),
        rows: [],
      },
    },
  });
  older({
    found: true,
    type: "history-text",
    content: "REMOVED_REPLY",
    readId: "removed",
  });
  await wb.t.renderOnce();
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /REMOVED_REPLY/);
  assert.ok(wb.released.includes("removed"));
});

test("m10-audit-history-tool-content: visible large paths and complete file metadata load on demand without changing the ten-file display policy", async (t) => {
  const firstPath = "FIRST_PATH_" + "x".repeat(5000) + "_PATH_END";
  const files = Array.from({ length: 300 }, (_, i) => ({
    path: i === 0 ? firstPath : `supplied-${i}.ts`,
    kind: "update",
    additions: i,
    removals: 2,
  }));
  const wb = await fixture(t, "turn-diff", {
    content: "SUPPLIED_PATCH",
    files,
  });
  await press(wb.t, wb.renderer, "home", { alt: true });
  await wb.t.waitForFrame(
    (frame) => frame.includes("FIRST_PATH") && !frame.includes("…"),
  );
  assert.ok(wb.reads.length > 0);
  assert.match(wb.t.captureCharFrame(), /290 more files/);
  // The first long name is readable in its own bounded inspection via click.
  await press(wb.t, wb.renderer, "home", { alt: true });
  const y = wb.t
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes("FIRST_PATH"));
  assert.ok(y >= 0);
  await wb.t.mockMouse.click(12, y);
  await wb.t.waitForFrame((frame) => frame.includes("Supplied file path"));
  await press(wb.t, wb.renderer, "end");
  await wb.t.waitForFrame((frame) => frame.includes("_PATH_END"));
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "home", { alt: true });
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  await wb.t.waitForFrame((frame) => frame.includes("SUPPLIED_PATCH"));
  await press(wb.t, wb.renderer, "f");
  await wb.t.waitForFrame((frame) => frame.includes("FIRST_PATH"));
  await press(wb.t, wb.renderer, "end");
  await wb.t.waitForFrame((frame) => frame.includes("supplied-299.ts +299 -2"));
  await press(wb.t, wb.renderer, "f");
  await wb.t.waitForFrame((frame) => frame.includes("SUPPLIED_PATCH"));
  assert.ok(wb.released.length > 0);
});

for (const source of [
  ...Array.from(
    { length: 4 },
    (_, i) => "x".repeat(4094 - i) + "\x1b[31mMARK\x1b[0m",
  ),
  "x".repeat(4094) + "\x1b]8;;" + "url".repeat(3000) + "\x07MARK",
  "x".repeat(4094) + "\r\nMARK",
  "x".repeat(4094) + "\x1b]8;;UNTERMINATED_MARK",
])
  test(`m10-audit-history-tool-content: bounded inspection preserves sanitizer context at ${source.length} units`, async (t) => {
    const wb = await fixture(t, "turn-diff", { content: source, files: [] });
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    await wb.t.waitForFrame(
      (frame) => frame.includes("Turn diff") && wb.reads.length === 1,
    );
    await press(wb.t, wb.renderer, "end");
    await wb.t.waitForFrame((frame) => frame.includes("MARK"));
    assert.equal(wb.t.captureCharFrame().includes("\x1b"), false);
    assert.doesNotMatch(wb.t.captureCharFrame(), /\[31mMARK|31mMARK|urlurl|\r/);
  });

test("m10-audit-history-tool-content: cumulative supplied file patches remain readable separately from call patches", async (t) => {
  const wb = await fixture(t, "turn-diff", {
    content: "CUMULATIVE",
    files: [
      {
        path: "observed.ts",
        kind: "update",
        patch: {
          kind: "structured",
          hunks: [
            {
              oldStart: 4,
              oldLines: 1,
              newStart: 9,
              newLines: 2,
              lines: ["-BEFORE", "+ONLY_FILE_PATCH", "+AFTER"],
            },
          ],
        },
      },
    ],
  });
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  await wb.t.waitForFrame((frame) => frame.includes("+ONLY_FILE_PATCH"));
  assert.match(wb.t.captureCharFrame(), /@@ -4,1 \+9,2 @@/);
  assert.match(wb.t.captureCharFrame(), /CUMULATIVE/);
});

test("m10-audit-history-tool-content: every rendered boundary reconstructs existing sanitizer output, including arbitrary seeking", async (t) => {
  const prefix = "x".repeat(4094);
  const cases = [
    { source: prefix + "\x1b[31mMARK\x1b[0m", expected: prefix + "MARK" },
    {
      source: prefix + "\x1b]8;;" + "url".repeat(3000) + "\x07MARK",
      expected: prefix + "MARK",
    },
    {
      source: prefix + "\x1b]8;;UNTERMINATED_MARK",
      expected: prefix + ";;UNTERMINATED_MARK",
    },
    { source: prefix + "\r\nMARK", expected: prefix + "\nMARK" },
    { source: prefix + "\x1b[12345mMARK", expected: prefix + "mMARK" },
    {
      source: prefix + "\x1b]8;;https://body\x1b[31mMARK",
      expected: prefix + "ttps://bodyMARK",
    },
  ];
  const wb = await fixture(t, "turn-diff", {
    content: cases[0]!.source,
    files: [],
  });
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  await wb.t.waitForFrame(() => wb.reads.length === 1);
  const analyser = historyTextEdges;
  assert.ok(analyser);
  for (const entry of cases) {
    // The public Port invokes the actual presentation analyser with transient bounded portions.
    const edges = analyser(
      (function* () {
        for (let i = 0; i < entry.source.length; i += 4095)
          yield entry.source.slice(i, i + 4095);
      })(),
      4095,
      Math.min(8190, entry.source.length),
    );
    assert.ok(edges.dropLeading >= 0 && edges.dropLeading <= 4095);
    let reconstructed = "";
    for (let offset = 0; offset < entry.source.length; offset += 4095) {
      const end = Math.min(entry.source.length, offset + 4095);
      const context = analyser(
        (function* () {
          for (let i = 0; i < entry.source.length; i += 4095)
            yield entry.source.slice(i, i + 4095);
        })(),
        offset,
        end,
      );
      const part = entry.source.slice(offset, end);
      reconstructed += screenHistoryPortion({
        found: true,
        type: "history-text",
        content: part,
        edges: context,
        readId: "compatibility",
      }).text;
    }
    assert.equal(reconstructed, entry.expected);
  }
});

test("m10-audit-history-tool-content: wrapped file clicks use file identity even when directory prefixes match", async (t) => {
  const common = "shared-directory-prefix/" + "p".repeat(160);
  const wb = await fixture(t, "turn-diff", {
    content: "PATCH",
    files: [{ path: common + "FIRST_END" }, { path: common + "SECOND_END" }],
  });
  await press(wb.t, wb.renderer, "home", { alt: true });
  await wb.t.waitForFrame((frame) => frame.includes("SECOND"));
  const y = wb.t
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes("SECOND"));
  assert.ok(y >= 0);
  await wb.t.mockMouse.click(10, y);
  await wb.t.waitForFrame((frame) => frame.includes("Supplied file path"));
  assert.match(wb.t.captureCharFrame(), /SECOND/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /FIRST/);
});

test("m10-audit-history-tool-content: a newer live version keeps row identity and ignores an older delayed read", async (t) => {
  const wb = await fixture(t, "tool-call", {
    callId: "c",
    tool: "other",
    input: "input",
    outcome: { kind: "running" },
    output: { text: "OLD_VALUE\n" + "a".repeat(10000) },
  });
  const pending: {
    request: HistoryContentRequest;
    real: Promise<HistoryContentRead>;
    deliver: (read: HistoryContentRead) => void;
  }[] = [];
  wb.control.setContentReader((request) => {
    const real = wb.run.port.readHistoryContent(request);
    return new Promise((resolve) =>
      pending.push({ request, real, deliver: resolve }),
    );
  }, wb.run.port.releaseHistoryRead);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.equal(pending.length, 1);
  const oldRead = await pending[0]!.real;
  assert.ok(oldRead.found);
  wb.run.channel.observe({
    tool: {
      turnId: "turn",
      session: "s",
      call: {
        callId: "c",
        tool: "other",
        input: "input",
        outcome: { kind: "running" },
        output: { text: "CURRENT_VALUE\n" + "b".repeat(10000) },
      },
    },
  });
  wb.flushPreview();
  const update = await wb.opened.updates[Symbol.asyncIterator]().next();
  assert.ok(!update.done && update.value.kind === "history-preview");
  assert.ok(wb.opened.snapshot.result.found);
  const history = wb.opened.snapshot.result.history;
  const updatedRow = update.value.row;
  assert.ok(history.rows.some((row) => row.id === updatedRow.id));
  wb.control.setHistory({
    ...wb.opened.snapshot,
    result: {
      found: true,
      history: {
        ...history,
        rows: history.rows.map((row) =>
          row.id === updatedRow.id ? updatedRow : row,
        ),
      },
    },
  });
  await wb.t.renderOnce();
  assert.equal(pending.length, 2);
  assert.equal(pending[0]?.request.signal?.aborted, true);
  pending[1]!.deliver(await pending[1]!.real);
  await press(wb.t, wb.renderer, "home", { alt: true });
  await wb.t.waitForFrame((frame) => frame.includes("CURRENT_VALUE"));
  pending[0]!.deliver(oldRead);
  await wb.t.renderOnce();
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /CURRENT_VALUE/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /OLD_VALUE/);
  assert.equal(
    wb.control.view.openRun(wb.run.runId).freshness().kind,
    "current",
  );
});
