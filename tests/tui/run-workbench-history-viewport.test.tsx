import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HistoryContentRead,
  HistoryTextReference,
  SessionHistoryRow,
  SessionHistorySnapshot,
  SessionHistoryValue,
} from "../../src/application/projection-port.js";
import type { App } from "../../src/tui/tui.js";
import {
  mountWorkbench,
  noOverflow,
  press,
  resizeWorkbench,
  runOf,
  type,
} from "./run-workbench-fixture.js";

type Observe = NonNullable<Parameters<typeof App>[0]["observeLayout"]>;

const reference = (id: string): HistoryTextReference => ({
  type: "history-text",
  runId: "run-1",
  id,
});

function row(id: string, value: SessionHistoryValue): SessionHistoryRow {
  return {
    id,
    position: id,
    source: "stored",
    turn: "turn",
    turnStartedAt: "2026-10-08T00:00:00Z",
    value,
  };
}

function history(rows: readonly SessionHistoryRow[]): SessionHistorySnapshot {
  return {
    family: "session-history",
    runId: "run-1",
    session: "s",
    result: {
      found: true,
      history: {
        rows,
        hasEarlier: false,
        transcriptPage: {
          type: "transcript-page",
          runId: "run-1",
          session: "s",
        },
        transcriptExport: {
          type: "transcript-export",
          runId: "run-1",
          session: "s",
        },
      },
    },
  };
}

/** Thoughts draw one collapsed line; every wrapped message line names its row. */
function mixed(count: number): SessionHistoryRow[] {
  return Array.from({ length: count }, (_, index) => {
    const id = String(index).padStart(3, "0");
    return index % 2 === 0
      ? row(`t${id}`, {
          kind: "thought",
          content: `T${id} heading\nT${id} body`,
        })
      : row(`m${id}`, {
          kind: "message",
          role: "assistant",
          content: Array.from({ length: 8 + (index % 5) }, () => `M${id}`).join(
            " ",
          ),
        });
  });
}

const sessionRun = () =>
  runOf({
    sessions: [{ session: "s", name: "Conversation", availability: "open" }],
  });

async function mount(width: number, height: number, observe?: Observe) {
  return mountWorkbench(
    sessionRun(),
    width,
    height,
    undefined,
    true,
    undefined,
    undefined,
    observe,
  );
}

const lines = (frame: string) => frame.split("\n");
const marker = (line: string) => /\b([TM]\d{3})\b/.exec(line)?.[1];

test("m10-followup-history-viewport: every line toggles the row drawn there, and each click resolves its row once", async () => {
  const lookups: string[] = [];
  const wb = await mount(100, 30, (event) => {
    if (event.kind === "history-row-at") lookups.push(event.id);
  });
  wb.control.setHistory(history(mixed(400)));
  await wb.t.renderOnce();
  for (const action of ["home", "pagedown"] as const) {
    await press(
      wb.t,
      wb.renderer,
      action,
      action === "home" ? { alt: true } : {},
    );
    const before = wb.t.captureCharFrame();
    const drawn = lines(before)
      .map((line, y) => ({ y, id: marker(line), line }))
      .filter((line) => line.id !== undefined);
    assert.ok(drawn.length > 10);
    for (const { y, id, line } of drawn) {
      lookups.length = 0;
      await wb.t.mockMouse.click(10, y);
      await wb.t.renderOnce();
      const after = wb.t.captureCharFrame();
      if (id!.startsWith("M")) {
        // A row without detail ignores the click, which looked up one line.
        assert.equal(after, before, line);
        assert.equal(lookups.length, 1, line);
        continue;
      }
      // The opened row keeps its anchor, so the same line closes it again.
      assert.equal(lines(after)[y], line.replace("▸", "▾"));
      await wb.t.mockMouse.click(10, y);
      await wb.t.renderOnce();
      assert.equal(wb.t.captureCharFrame(), before, line);
    }
  }
});

test("m10-followup-history-viewport: a tool heading, a file name and a failed portion's notice each resolve their row once", async () => {
  const lookups: string[] = [];
  const wb = await mount(100, 40, (event) => {
    if (event.kind === "history-row-at") lookups.push(event.id);
  });
  let fail = true;
  const reads: string[] = [];
  wb.control.setContentReader(
    async (request) => {
      reads.push(request.reference.id);
      if (fail && request.reference.id === "long")
        return {
          found: false,
          problem: {
            code: "test-read-failure",
            explanation: "Unavailable",
            remediation: "Retry",
            possibleEffects: "none",
          },
        };
      const read: HistoryContentRead = {
        found: true,
        type: "history-text",
        content:
          request.reference.id === "path"
            ? "src/FILE_TARGET.ts"
            : `READ ${request.reference.id}`,
        readId: `read-${reads.length}`,
      };
      return read;
    },
    () => {},
  );
  wb.control.setHistory(
    history([
      ...mixed(40),
      row("long", {
        kind: "message",
        role: "assistant",
        content: "LONG preview",
        reference: reference("long"),
      }),
      row("cmd", {
        kind: "tool",
        tool: "command",
        input: "COMMAND_HEAD",
        detail: reference("detail"),
        outcome: { kind: "completed" },
        output: { text: "out 1\nout 2" },
      }),
      row("files", {
        kind: "tool",
        tool: "file-change",
        input: "edit",
        files: [{ path: "src/FILE_TARGET.ts", pathContent: reference("path") }],
        outcome: { kind: "completed" },
      }),
      // Trailing rows keep the clicked lines off the window's edges.
      ...["tail-1", "tail-2", "tail-3"].map((id) =>
        row(id, { kind: "message", role: "assistant", content: id }),
      ),
    ]),
  );
  await wb.t.waitForFrame((frame) =>
    frame.includes("Error [test-read-failure] · click to retry"),
  );
  const yOf = (text: string) => {
    const y = lines(wb.t.captureCharFrame()).findIndex((line) =>
      line.includes(text),
    );
    assert.ok(y >= 0, text);
    return y;
  };

  for (const [target, opened] of [
    ["Tool · command · completed", "Tool detail"],
    ["FILE_TARGET", "Supplied file path"],
  ] as const) {
    const y = yOf(target);
    lookups.length = 0;
    await wb.t.mockMouse.click(10, y);
    // Opening an inspection releases visible readers, which re-windows history
    // at its edges; the clicked line itself is resolved exactly once.
    assert.ok(lookups.length >= 1, target);
    assert.equal(
      lookups.filter((line) => line === lookups[0]).length,
      1,
      target,
    );
    await wb.t.waitForFrame((frame) => frame.includes(opened));
    await press(wb.t, wb.renderer, "escape");
    await wb.t.waitForFrame((frame) => frame.includes(target));
  }

  fail = false;
  const before = reads.filter((id) => id === "long").length;
  const notice = yOf("Error [test-read-failure]");
  await wb.t.mockMouse.click(10, notice);
  await wb.t.waitForFrame((frame) => frame.includes("READ long"));
  assert.equal(reads.filter((id) => id === "long").length, before + 1);
  assert.doesNotMatch(wb.t.captureCharFrame(), /test-read-failure/);
});

test("m10-followup-history-viewport: Ctrl+O, paging and paused anchors hold across 40, 120/121 and wide columns while both renderers resize", async () => {
  const wb = await mount(160, 40);
  wb.control.setHistory(history(mixed(600)));
  await wb.t.renderOnce();
  for (const width of [160, 121, 120, 40]) {
    resizeWorkbench(wb.t, wb.renderer, width, 40);
    await press(wb.t, wb.renderer, "end", { alt: true });
    noOverflow(wb.t.captureCharFrame(), width);
    // Following: Ctrl+O opens the bottom-most visible Thought, then only closes it.
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /T598 body/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /T598 body/);

    // Paused: oldest, then two half-viewport pages down.
    await press(wb.t, wb.renderer, "home", { alt: true });
    assert.match(wb.t.captureCharFrame(), /Beginning of Run history/);
    await press(wb.t, wb.renderer, "pagedown");
    await press(wb.t, wb.renderer, "pagedown");
    const paused = wb.t.captureCharFrame();
    assert.doesNotMatch(paused, /Beginning of Run history/);
    assert.match(paused, /Jump to latest/);
    const drawn = lines(paused)
      .map(marker)
      .filter((id) => id !== undefined);
    const thoughts = drawn.filter((id) => id.startsWith("T"));
    const last = thoughts[thoughts.length - 1]!;
    const top = drawn[0]!;
    // Ctrl+O while paused opens the bottom-most visible Thought in place.
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    const opened = wb.t.captureCharFrame();
    // Paused content keeps its anchor, so the opened body may lie below the page.
    assert.ok(opened.includes(`▾ Thought · complete · ${last} heading`));
    assert.equal(lines(opened).map(marker).find(Boolean), top);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.equal(wb.t.captureCharFrame(), paused);

    // A paused page keeps its top row through both renderers' resize.
    const next = width === 40 ? 160 : 40;
    resizeWorkbench(wb.t, wb.renderer, next, 40);
    await wb.t.renderOnce();
    const resized = wb.t.captureCharFrame();
    noOverflow(resized, next);
    assert.equal(lines(resized).map(marker).find(Boolean), top);
    assert.match(resized, /Jump to latest/);
    resizeWorkbench(wb.t, wb.renderer, width, 40);
    await wb.t.renderOnce();
    assert.equal(lines(wb.t.captureCharFrame()).map(marker).find(Boolean), top);
  }
  // The prompt keeps native focus through scrolling, clicks and Ctrl+O.
  await type(wb.t, "draft");
  assert.match(wb.t.captureCharFrame(), /> draft/);
});
