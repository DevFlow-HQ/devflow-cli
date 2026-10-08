import type { App } from "../../src/tui/tui.js";
import { PALETTES } from "./palette-expectations.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionHistoryRow,
  SessionHistorySnapshot,
} from "../../src/application/projection-port.js";
import {
  mountWorkbench,
  runOf,
  press,
  transcriptRun,
  openTranscriptDetails,
  resizeWorkbench,
  noOverflow,
  type,
  previewPreferences,
  hexRgb,
} from "./run-workbench-fixture.js";

function page(rows: readonly SessionHistoryRow[]): SessionHistorySnapshot {
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

function command(id: string, text: string): SessionHistoryRow {
  return {
    id,
    position: id,
    turn: "turn",
    source: "preview",
    turnStartedAt: "2026-10-06T00:00:00Z",
    value: {
      kind: "tool",
      tool: "command",
      input: `COMMAND_${id}`,
      outcome: { kind: "running" },
      output: { text },
    },
  };
}

const sessionRun = () =>
  runOf({
    sessions: [{ session: "s", name: "Conversation", availability: "open" }],
  });

test("m10-audit-row-layout-once: a preview lays out only its changed row among 199 bounded command outputs within one frame", async () => {
  const laidOut: string[] = [];
  const observe: NonNullable<Parameters<typeof App>[0]["observeLayout"]> = (
    event,
  ) => {
    if (event.kind === "history") laidOut.push(event.id);
  };
  const wb = await mountWorkbench(
    sessionRun(),
    100,
    40,
    undefined,
    true,
    undefined,
    undefined,
    observe,
  );
  const output = "line\n".repeat(6000);
  assert.equal(output.length, 30_000);
  const rows = Array.from({ length: 199 }, (_, i) =>
    command(String(i), output),
  );
  wb.control.setHistory(page(rows));
  await wb.t.renderOnce();
  assert.equal(laidOut.length, 199);
  laidOut.length = 0;
  const before = performance.now();
  wb.control.setHistory(
    page([...rows.slice(0, -1), command("198", "LAST\n" + output.slice(5))]),
  );
  const elapsed = performance.now() - before;
  assert.deepEqual(laidOut, ["198"]);
  assert.ok(elapsed < 16.7, `layout update took ${elapsed.toFixed(2)} ms`);
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /COMMAND_198/);
  assert.match(wb.t.captureCharFrame(), /LAST/);
  assert.match(wb.t.captureCharFrame(), /5991 hidden lines/);
  // An unchanged complete replacement page and ordinary input reuse the layouts.
  laidOut.length = 0;
  wb.control.setRun({ ...sessionRun(), requestedModel: "new-model" });
  await press(wb.t, wb.renderer, "left");
  assert.deepEqual(laidOut, []);
});

test("m10-audit-row-layout-once: 30 Sessions retain only the current and distinct live Turn subscriptions and release them on transition", async () => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({
    session: `s${i}`,
    name: `Conversation ${i}`,
    availability: "open" as const,
  }));
  const run = runOf({
    sessions,
    progress: [{ id: "current", kind: "agent", status: "running" }],
    timeline: [
      {
        at: "2026-10-06T00:00:00Z",
        event: "turn-started",
        step: "current",
        session: "s15",
      },
      {
        at: "2026-10-06T00:01:00Z",
        event: "turn-started",
        step: "other",
        session: "s29",
      },
    ],
  });
  const wb = await mountWorkbench(run);
  assert.deepEqual(wb.control.historyOpens, ["s15"]);
  wb.control.setLive({
    runId: run.runId,
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await wb.t.renderOnce();
  assert.deepEqual([...wb.control.historyActive], ["s15", "s29"]);
  wb.control.setRun({ ...run, requestedModel: "other-model" });
  await wb.t.renderOnce();
  assert.deepEqual(wb.control.historyOpens, ["s15", "s29"]);
  wb.control.setLive(undefined);
  wb.control.setRun({
    ...run,
    timeline: [
      ...run.timeline,
      {
        at: "2026-10-06T00:02:00Z",
        event: "turn-started",
        step: "current",
        session: "s16",
      },
    ],
  });
  await wb.t.renderOnce();
  assert.deepEqual([...wb.control.historyActive], ["s16"]);
  wb.t.renderer.destroy();
  assert.deepEqual([...wb.control.historyActive], []);
});

test("m10-audit-row-layout-once: the 150th older transcript page lays out only 20 new entries and its junction", async () => {
  const laidOut: string[] = [];
  const wb = await mountWorkbench(
    transcriptRun(),
    100,
    26,
    undefined,
    true,
    undefined,
    undefined,
    (event) => {
      if (event.kind === "transcript") laidOut.push(event.id);
    },
  );
  for (let pageIndex = 0; pageIndex <= 150; pageIndex++) {
    wb.control.setTranscript(pageIndex === 0 ? "" : String(pageIndex), {
      found: true,
      type: "transcript-page",
      entries: Array.from({ length: 20 }, (_, i) => ({
        id: `${pageIndex}:${i}`,
        session: "s",
        role: "assistant" as const,
        content: `PAGE_${pageIndex}_ENTRY_${i}`,
        step: `step-${pageIndex}`,
      })),
      ...(pageIndex === 150 ? {} : { older: String(pageIndex + 1) }),
    });
  }
  await openTranscriptDetails(wb);
  assert.equal(laidOut.length, 20);
  for (let i = 1; i < 150; i++) await press(wb.t, wb.renderer, "p");
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /PAGE_0_ENTRY_19/);
  laidOut.length = 0;
  await press(wb.t, wb.renderer, "p");
  assert.deepEqual(laidOut, [
    ...Array.from({ length: 20 }, (_, i) => `150:${i}`),
    "149:0",
  ]);
  assert.match(wb.t.captureCharFrame(), /PAGE_0_ENTRY_19/);
  laidOut.length = 0;
  await press(wb.t, wb.renderer, "home");
  assert.match(wb.t.captureCharFrame(), /Conversation.*s/);
  assert.match(wb.t.captureCharFrame(), /Step.*step-150/);
  assert.match(wb.t.captureCharFrame(), /PAGE_150_ENTRY_0/);
  assert.deepEqual(laidOut, []);
  resizeWorkbench(wb.t, wb.renderer, 99, 26);
  await wb.t.renderOnce();
  assert.equal(laidOut.length, 3020);
  laidOut.length = 0;
  resizeWorkbench(wb.t, wb.renderer, 100, 26);
  await wb.t.renderOnce();
  assert.deepEqual(laidOut, [], "retained entries reuse their prior width");
});

test("m10-audit-row-layout-once: a supplied 2 MB diff lays out once at each width and keeps complete content through modal keys and resize", async () => {
  const layouts: number[] = [];
  const wb = await mountWorkbench(
    sessionRun(),
    100,
    26,
    undefined,
    true,
    undefined,
    undefined,
    (event) => {
      if (event.kind === "inspection") layouts.push(event.width);
    },
  );
  const edge = "DIFF_FIRST\n\nDIFF_LAST";
  const content =
    "DIFF_FIRST\n" + "x".repeat(2 * 1024 * 1024 - edge.length) + "\nDIFF_LAST";
  assert.equal(content.length, 2 * 1024 * 1024);
  wb.control.setHistory(
    page([
      {
        ...command("diff", ""),
        value: { kind: "turn-diff", content, files: [{ path: "supplied.ts" }] },
      },
    ]),
  );
  await wb.t.renderOnce();
  assert.deepEqual(layouts, []);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /DIFF_FIRST/);
  assert.equal(layouts.length, 1);
  await press(wb.t, wb.renderer, "end");
  assert.match(wb.t.captureCharFrame(), /DIFF_LAST/);
  assert.equal(layouts.length, 1);
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /Turn diff/);
  assert.equal(layouts.length, 1);
  resizeWorkbench(wb.t, wb.renderer, 100, 30);
  await wb.t.renderOnce();
  assert.equal(layouts.length, 1);
  for (const width of [40, 120, 121]) {
    resizeWorkbench(wb.t, wb.renderer, width, 26);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "end");
    assert.match(wb.t.captureCharFrame(), /DIFF_LAST/);
    noOverflow(wb.t.captureCharFrame(), width);
    assert.equal(layouts.length, width === 40 ? 2 : width === 120 ? 3 : 4);
    resizeWorkbench(wb.t, wb.renderer, width, 30);
    await wb.t.renderOnce();
    assert.equal(layouts.length, width === 40 ? 2 : width === 120 ? 3 : 4);
  }
  resizeWorkbench(wb.t, wb.renderer, 100, 26);
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "end");
  assert.match(wb.t.captureCharFrame(), /DIFF_LAST/);
  assert.equal(
    layouts.length,
    4,
    "returning to a retained width reuses the 2 MB layout",
  );
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /DIFF_FIRST|DIFF_LAST/);
  await type(wb.t, "still editable");
  assert.match(wb.t.captureCharFrame(), /still editable/);
});

for (const appearance of ["dark", "light"] as const) {
  for (const width of [40, 100, 120, 121]) {
    test(`m10-audit-row-layout-once: ${appearance} output at ${width} keeps logical collapse, theme roles, input focus and cached expansion`, async () => {
      const laidOut: string[] = [];
      const base = previewPreferences();
      const wb = await mountWorkbench(
        sessionRun(),
        width,
        44,
        undefined,
        true,
        undefined,
        {
          ...base,
          snapshot: () => ({
            ...base.snapshot(),
            preferences: { theme: "everforest", appearance },
          }),
        },
        (event) => {
          if (event.kind === "history") laidOut.push(event.id);
        },
      );
      const output = Array.from(
        { length: 12 },
        (_, i) => `LINE_${i + 1} ` + "words ".repeat(8),
      ).join("\n");
      wb.control.setHistory(page([command("one", output)]));
      await wb.t.renderOnce();
      assert.deepEqual(laidOut, ["one"]);
      if (width === 40) {
        // The character limit wins before the tenth logical line at this width.
        assert.ok(
          wb.t
            .captureCharFrame()
            .replace(/\s+/g, "")
            .includes("355hiddencharacters"),
        );
        assert.match(wb.t.captureCharFrame(), /LINE_6/);
        assert.doesNotMatch(wb.t.captureCharFrame(), /LINE_7/);
      } else {
        assert.match(wb.t.captureCharFrame(), /▸ Output.*live.*2 hidden lines/);
        assert.match(wb.t.captureCharFrame(), /LINE_10/);
        assert.doesNotMatch(wb.t.captureCharFrame(), /LINE_11|LINE_12/);
      }
      noOverflow(wb.t.captureCharFrame(), width);
      const span = wb.t
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("LINE_5"));
      assert.ok(span);
      assert.deepEqual(
        [span.fg.r, span.fg.g, span.fg.b].map((v) => Math.round(v * 255)),
        hexRgb(PALETTES.find((p) => p.name === "everforest")![appearance]),
      );
      laidOut.length = 0;
      await press(wb.t, wb.renderer, "o", { ctrl: true });
      assert.deepEqual(laidOut, ["one"]);
      assert.match(wb.t.captureCharFrame(), /▾ Output.*live/);
      assert.match(wb.t.captureCharFrame(), /LINE_12/);
      laidOut.length = 0;
      await press(wb.t, wb.renderer, "o", { ctrl: true });
      assert.deepEqual(laidOut, []);
      await press(wb.t, wb.renderer, "o", { ctrl: true });
      assert.deepEqual(laidOut, []);
      wb.control.setHistory(
        page([
          {
            ...command("one", output.replaceAll("LINE", "FINAL")),
            source: "stored",
          },
        ]),
      );
      await wb.t.renderOnce();
      assert.deepEqual(laidOut, ["one"]);
      assert.match(wb.t.captureCharFrame(), /▾ Output.*final/);
      assert.match(wb.t.captureCharFrame(), /FINAL_12/);
      laidOut.length = 0;
      await type(wb.t, "draft");
      assert.match(wb.t.captureCharFrame(), /draft/);
      await press(wb.t, wb.renderer, "up", { alt: true });
      assert.match(wb.t.captureCharFrame(), /Paused/);
      await press(wb.t, wb.renderer, "end", { alt: true });
      assert.doesNotMatch(wb.t.captureCharFrame(), /Paused/);
      assert.deepEqual(laidOut, []);
      resizeWorkbench(wb.t, wb.renderer, width + 1, 44);
      await wb.t.renderOnce();
      assert.deepEqual(laidOut, ["one"]);
      laidOut.length = 0;
      resizeWorkbench(wb.t, wb.renderer, width, 44);
      await wb.t.renderOnce();
      assert.deepEqual(
        laidOut,
        [],
        "returning to a retained width reuses the row layout",
      );
      assert.match(wb.t.captureCharFrame(), /FINAL_12/);
    });
  }
}

for (const [width, hidden] of [
  [40, 29681],
  [120, 28881],
] as const) {
  test(`m10-audit-row-layout-once: one unbroken 30000-character output collapses by character budget and expands completely at ${width}`, async () => {
    const wb = await mountWorkbench(sessionRun(), width, 44, undefined, true);
    const text = "BEGIN" + "x".repeat(29992) + "END";
    assert.equal(text.length, 30_000);
    wb.control.setHistory(page([command("unbroken", text)]));
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "home", { alt: true });
    const collapsed = wb.t.captureCharFrame();
    assert.ok(
      collapsed.replace(/\s+/g, "").includes(`${hidden}hiddencharacters`),
    );
    assert.match(collapsed, /BEGIN/);
    assert.ok(!collapsed.replace(/\s+/g, "").includes("xxxEND"));
    assert.match(collapsed, /…/);
    noOverflow(collapsed, width);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    await press(wb.t, wb.renderer, "end", { alt: true });
    const expanded = wb.t.captureCharFrame();
    assert.ok(expanded.replace(/\s+/g, "").includes("xxxEND"));
    noOverflow(expanded, width);
    await press(wb.t, wb.renderer, "home", { alt: true });
    assert.match(wb.t.captureCharFrame(), /▾ Output/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /hidden characters/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.ok(
      wb.t
        .captureCharFrame()
        .replace(/\s+/g, "")
        .includes(`${hidden}hiddencharacters`),
    );
  });
}

for (const glyph of ["é", "漢"]) {
  test(`m10-audit-row-layout-once: a live unbroken 30000-character ${glyph} row stays responsive on load, first expansion and expanded preview replacement`, async () => {
    const wb = await mountWorkbench(sessionRun(), 100, 44, undefined, true);
    const text = glyph.repeat(30_000);
    let before = performance.now();
    wb.control.setHistory(page([command("unicode", text)]));
    assert.ok(
      performance.now() - before < 100,
      "collapsed Unicode layout exceeded 100 ms",
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /hidden characters/);
    before = performance.now();
    wb.renderer.key("o", { ctrl: true });
    assert.ok(
      performance.now() - before < 100,
      "first Unicode expansion exceeded 100 ms",
    );
    await wb.t.renderOnce();
    before = performance.now();
    wb.control.setHistory(
      page([command("unicode", glyph.repeat(29999) + "Z")]),
    );
    assert.ok(
      performance.now() - before < 100,
      "expanded Unicode preview replacement exceeded 100 ms",
    );
    await wb.t.renderOnce();
    assert.ok(
      wb.t
        .captureCharFrame()
        .replace(/\s+/g, "")
        .includes(glyph + "Z"),
    );
    await press(wb.t, wb.renderer, "home", { alt: true });
    assert.match(wb.t.captureCharFrame(), /▾ Output.*live/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /hidden characters/);
  });
}
