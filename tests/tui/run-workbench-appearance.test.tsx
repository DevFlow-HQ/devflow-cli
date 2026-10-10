import { PALETTES } from "./palette-expectations.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import {
  resizeWorkbench,
  runOf,
  events,
  wrappingEvents,
  blockedRunOf,
  mountWorkbench,
  mountApp,
  makeRunView,
  snapshotOf,
  workbenchShown,
  press,
  type,
  noOverflow,
  PROGRESS,
  RESUME_OFFER,
  okActions,
  interactiveRunOf,
  requestOverlay,
  liveTurnRunOf,
  liveInteractiveRunOf,
  previewPreferences,
  openAppThemes,
  hexRgb,
} from "./run-workbench-fixture.js";

test("[selected-versus-observed-evidence] selected and observed Harness facts stay distinct through a live Turn", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
      selectedHarness: "codex",
      effectiveModel: "claude-sonnet-4-5",
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "fixture-preview",
          session: "fixture-preview",
          sessionName: "Live conversation",
          step: "repair",
          turnKind: "agent",
        },
      ],
    }),
    110,
    24,
  );

  control.setPreview("I am checking the failing assertion");
  control.setLive({
    runId: "run-1",
    generation: 2,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  // Selected and observed facts live in the details panel now (#194 story 35); open
  // it and confirm the two read as visibly distinct lines (AC1), through the live Turn.
  await press(t, renderer, "g", { ctrl: true });
  const streaming = t.captureCharFrame();
  assert.match(streaming, /Selected Harness · codex/);
  assert.match(
    streaming,
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3/,
  );
  assert.match(streaming, /model claude-sonnet-4-5/);
  assert.match(streaming, /Assistant · streaming/);
  assert.match(streaming, /Assistant · streaming[\s\S]*I am checking/);

  // Below the panel's width breakpoint the panel hides (its facts with it), but the
  // screen still relays out without overflow.
  resizeWorkbench(t, renderer, 40, 24);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 40);
  resizeWorkbench(t, renderer, 110, 24);
  await t.renderOnce();

  control.setRun(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "succeeded" }],
      selectedHarness: "codex",
      effectiveModel: "claude-sonnet-4-5",
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "fixture-preview",
          session: "fixture-preview",
          sessionName: "Live conversation",
          step: "repair",
          turnKind: "agent",
        },
        {
          at: "T001",
          event: "assistant-content",
          detail: "The assertion is fixed.",
        },
        {
          at: "T002",
          event: "turn-settled",
          detail: "completed",
          turnKind: "agent",
        },
      ],
    }),
  );
  control.setLive(undefined);
  await t.renderOnce();
  const settled = t.captureCharFrame();
  assert.doesNotMatch(settled, /Assistant preview/);
  assert.match(settled, /Assistant · The assertion is fixed\./);
  assert.match(settled, /Agent Turn settled · completed/);
});

test("m10-observed-harness-facts: context and usage appear only when reported, without calculated percentages", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Context ·|Usage ·/);

  control.setLive({
    runId: "run-1",
    generation: 2,
    phase: "working",
    outstanding: [],
    offers: [],
    context: { usedTokens: 12_500, limitTokens: 200_000 },
    usage: "estimated $0.04",
  });
  await t.renderOnce();
  const observed = t.captureCharFrame();
  assert.match(observed, /Context · used 12500 tokens, capacity 200000 tokens/);
  assert.match(observed, /Usage · estimated \$0\.04/);
});

// --- layout (AC6) ----------------------------------------------------------

test("m10-workbench-interaction: the sidebar shows at 121 columns, the meta row at 120, and the panel hides below its breakpoint without overflow", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      progress: PROGRESS,
      timeline: events(6),
      modelChoice: { model: "fake-opus", effort: "high" },
    }),
    121,
    30,
  );
  const wide = t.captureCharFrame();
  // 121 columns: the 42-column sidebar carries the Bundle, Steps, and model.
  assert.match(wide, /Alpha Flow/);
  assert.match(wide, /▸ ✓ plan/);
  assert.match(wide, /fake-opus · high effort/);
  assert.doesNotMatch(wide, /Step plan/);
  noOverflow(wide, 121);

  // 120 columns: no sidebar; the prompt's meta row names Step and Model choice.
  resizeWorkbench(t, renderer, 120, 30);
  await t.renderOnce();
  const boundary = t.captureCharFrame();
  assert.doesNotMatch(boundary, /Alpha Flow/);
  assert.match(boundary, /Step plan · fake-opus · high effort/);
  noOverflow(boundary, 120);

  await press(t, renderer, "g", { ctrl: true });
  resizeWorkbench(t, renderer, 70, 30);
  await t.renderOnce();
  const compact = t.captureCharFrame();
  assert.match(compact, /Workspace:/);
  noOverflow(compact, 70);

  // Below the details breakpoint the inline panel gives way to the focused list.
  resizeWorkbench(t, renderer, 50, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  assert.doesNotMatch(narrow, /Workspace:/);
  assert.match(narrow, /Details · Resources/);
  assert.doesNotMatch(narrow, /run-1/);
  noOverflow(narrow, 50);
});

test("a live-state Run shows no Run id or process at any width; the id shows once the Run leaves an active state", async () => {
  for (const state of ["running", "blocked"] as const) {
    const { t, control, renderer } = await mountWorkbench(
      runOf({
        state,
        progress: PROGRESS,
        position: 1,
        timeline: events(60),
        liveness: { state: "live-here", ownerPid: 4101 },
      }),
      140,
      40,
    );
    // The panel is closed, so the whole frame stands for the everyday screen.
    for (const width of [140, 100, 70, 50]) {
      resizeWorkbench(t, renderer, width, 40);
      await t.renderOnce();
      const frame = t.captureCharFrame();
      assert.doesNotMatch(frame, /run-1/, `${state} at ${width}: no Run id`);
      assert.doesNotMatch(frame, /4101|process/, `${state} at ${width}`);
      assert.doesNotMatch(frame, /live in|not live/, `${state} at ${width}`);
    }
    resizeWorkbench(t, renderer, 140, 40);
    await t.renderOnce();
    // The sidebar names the state in words.
    assert.match(
      t.captureCharFrame(),
      new RegExp(state[0]!.toUpperCase() + state.slice(1)),
    );

    // Leaving the live state brings the Run id back in the resting view, with
    // why the Run rests, and the bottom region counts its rows: the full timeline
    // still leaves the resting view's keys on screen.
    control.setRun(
      runOf({
        state: "halted",
        progress: PROGRESS,
        position: 1,
        timeline: events(60),
      }),
    );
    resizeWorkbench(t, renderer, 100, 40);
    await t.waitForFrame((f) => f.includes("halted"));
    const resting = t.captureCharFrame();
    assert.match(
      resting,
      /⏸ Run halted — This Step failed for unknown reasons\./,
    );
    assert.match(resting, /^\s*Run run-1\s*$/m);
    assert.match(resting, /ctrl\+g details to resume or delete · esc back/);
    resizeWorkbench(t, renderer, 50, 40);
    await t.renderOnce();
    assert.match(t.captureCharFrame(), /⏸ Run halted/);
    assert.match(t.captureCharFrame(), /^\s*Run run-1\s*$/m);
  }

  for (const state of ["failed", "succeeded", "cancelled"] as const) {
    const { t, renderer } = await mountWorkbench(runOf({ state }));
    assert.match(t.captureCharFrame(), /^\s*Run run-1\s*$/m);
    resizeWorkbench(t, renderer, 60, 40);
    await t.renderOnce();
    const compact = t.captureCharFrame();
    assert.match(compact, /^\s*Run run-1\s*$/m, `${state} compact`);
    assert.match(compact, new RegExp(`Run ${state}`)); // never colour alone
  }
});

test("a resting Run's long id wraps in full in its resting view and clips with an ellipsis in the details panel", async () => {
  const runId = `run-${"x".repeat(120)}`;
  /** The resting view wraps, never cuts (#528): the id reads whole once joined. */
  const wholeId = (frame: string) =>
    frame.replace(/\s+/g, "").includes(`Run${runId}ctrl+g`);
  const { t, renderer } = await mountWorkbench(
    runOf({ runId, state: "failed" }),
    100,
    30,
  );
  assert.ok(wholeId(t.captureCharFrame()));
  await press(t, renderer, "g", { ctrl: true });
  const panel = t.captureCharFrame();
  noOverflow(panel, 100);
  const clipped = panel
    .split("\n")
    .filter((line) => /^\s*Run run-x+…\s*$/.test(line));
  assert.equal(clipped.length, 1); // the panel's Run row

  await press(t, renderer, "escape"); // focus returns to the resting view
  resizeWorkbench(t, renderer, 50, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  noOverflow(narrow, 50);
  assert.ok(wholeId(narrow));
});

test("resize relayouts the timeline without overflow and keeps every state readable without colour", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "failed", progress: PROGRESS, timeline: events(20) }),
    90,
    24,
  );
  noOverflow(t.captureCharFrame(), 90);
  assert.match(t.captureCharFrame(), /✗ Run failed/); // word, not just colour
  resizeWorkbench(t, renderer, 60, 18);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 60);
  assert.match(t.captureCharFrame(), /✗ Run failed/);
});

test("the details panel carries the Run id and names whether the Run is live here or in another owner process", async () => {
  const here = await mountWorkbench(
    runOf({ liveness: { state: "live-here", ownerPid: 4101 } }),
  );
  assert.doesNotMatch(here.t.captureCharFrame(), /process 4101/); // not the header
  await press(here.t, here.renderer, "g", { ctrl: true });
  const hereFrame = here.t.captureCharFrame();
  assert.match(hereFrame, /^\s*Run run-1\s*$/m);
  assert.match(hereFrame, /Live · in this instance \(process 4101\)/);

  const elsewhere = await mountWorkbench(
    runOf({ liveness: { state: "live-elsewhere", ownerPid: 5202 } }),
  );
  await press(elsewhere.t, elsewhere.renderer, "g", { ctrl: true });
  assert.match(
    elsewhere.t.captureCharFrame(),
    /Live · in another instance \(process 5202\)/,
  );

  // A Run that is not live has no owner to name, so the panel says nothing of one;
  // its id, digest, and recovery evidence stay.
  const rested = await mountWorkbench(
    runOf({
      state: "halted",
      conflict: {
        artifactName: "plan",
        path: "docs/plan.md",
        reference: {
          runId: "run-1",
          diagnosticId: "diag-1",
          type: "diagnostic",
        },
      },
    }),
  );
  await press(rested.t, rested.renderer, "g", { ctrl: true });
  const restedFrame = rested.t.captureCharFrame();
  assert.match(restedFrame, /^\s*Run run-1\s*$/m);
  assert.doesNotMatch(restedFrame, /Live ·|process/);
  assert.match(restedFrame, /sha256:abc123/);
  assert.match(restedFrame, /Resting reason · A required file changed/);
  assert.match(
    restedFrame,
    /Materialization conflict · restore docs\/plan\.md/,
  );
});

test("every terminal resting state carries its prose beside the state word (#194 story 38)", async () => {
  for (const [state, prose] of [
    ["succeeded", "Workflow completed."],
    ["failed", "This Step failed for unknown reasons."],
    ["cancelled", "You cancelled this Run."],
    ["halted", "This Step failed for unknown reasons."],
  ] as const) {
    const { t } = await mountWorkbench(runOf({ state }), 100, 30);
    assert.match(
      t.captureCharFrame(),
      new RegExp(prose.replace(/[.]/g, "\\.")),
      `resting prose for ${state}`,
    );
  }
});

test("m10-audit-workbench-test-domains: who holds the Turn reads in words and glyphs at any width and across a resize (#290)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 24, okActions());
  let frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /◆ The agent is working — wait for its reply or interrupt it/,
  );
  noOverflow(frame, 100);

  // Clipped narrow, the working label still names the agent before its ellipsis;
  // its glyph and words differ from the human's move, so colour is never the signal.
  resizeWorkbench(wb.t, wb.renderer, 40, 16);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /◆ The agent is working/);
  noOverflow(frame, 40);

  // The Turn ends: the Run is back at the boundary, and the label hands the move over.
  wb.control.setRun(interactiveRunOf());
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /◇ Your move/);
  noOverflow(wb.t.captureCharFrame(), 40);
  resizeWorkbench(wb.t, wb.renderer, 100, 24);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /◇ Your move — the agent is waiting for your next Turn/);
  assert.doesNotMatch(frame, /The agent is working/);
  noOverflow(frame, 100);
});

// --- working scanner (#292) ------------------------------------------------

/** The scanner's eight cells on a frame's working line (the Workbench's one-column
 *  margin, then the row's two-space indent), or undefined when none shows. */
function scannerOf(frame: string): string | undefined {
  return /^ {3}([■⬝]{8}) /m.exec(frame)?.[1];
}

test("a live interactive Turn leads its interrupt hint with a moving scanner beside the working words (#292)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, okActions());
  const frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /◆ The agent is working — wait for its reply or interrupt it/,
  );
  assert.match(
    frame,
    /^ {3}[■⬝]{8} working · esc esc interrupt — stop the live Turn/m,
  );
  // It moves on its own 40 ms clock: a later frame shows the cells changed.
  const first = scannerOf(frame);
  await until(() => {
    const next = scannerOf(wb.t.captureCharFrame());
    return next !== undefined && next !== first;
  });
  // The field keeps the keys while it moves, and the armed Esc replaces its line.
  await type(wb.t, "next");
  assert.match(wb.t.captureCharFrame(), /> next/);
  await press(wb.t, wb.renderer, "escape");
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /⚠ Press esc again to interrupt/);
  assert.equal(scannerOf(armed), undefined);
  assert.match(armed, /> next/); // the draft stays beside the armed confirm
});

test("an Agent-step live Turn leads the prompt's hint with the scanner and the word working (#292)", async () => {
  const wb = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  const frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /^ {3}[■⬝]{8} working · esc esc interrupt — stop the live Turn/m,
  );
  assert.equal(frame.match(/[■⬝]{8}/g)?.length, 1);
  const first = scannerOf(frame);
  await until(() => {
    const next = scannerOf(wb.t.captureCharFrame());
    return next !== undefined && next !== first;
  });
  // Arming replaces the hint with the confirm; the prompt still says who works.
  await press(wb.t, wb.renderer, "escape");
  const armed = wb.t.captureCharFrame();
  assert.equal(scannerOf(armed), undefined);
  assert.match(armed, /◆ The agent is working/);
  assert.match(armed, /⚠ Press esc again to interrupt/);
});

test("the scanner stops when the Turn ends, leaving the boundary's words (#292)", async () => {
  const interactive = await mountWorkbench(
    liveInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  assert.notEqual(scannerOf(interactive.t.captureCharFrame()), undefined);
  interactive.control.setRun(interactiveRunOf());
  await interactive.t.renderOnce();
  let frame = interactive.t.captureCharFrame();
  assert.doesNotMatch(frame, /[■⬝]|\[⋯\]/);
  assert.match(frame, /◇ Your move/);
  assert.match(frame, /enter send Turn/);

  const agent = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  assert.notEqual(scannerOf(agent.t.captureCharFrame()), undefined);
  agent.control.setRun(
    liveTurnRunOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
  );
  await agent.t.renderOnce();
  frame = agent.t.captureCharFrame();
  assert.doesNotMatch(frame, /[■⬝]|\[⋯\]|working ·/);
  assert.match(frame, /⏸ Run halted/);
});

test("with reduced motion the scanner is a static [⋯] and the working words stay (#292)", async () => {
  const interactive = await mountWorkbench(
    liveInteractiveRunOf(),
    100,
    40,
    okActions(),
    true,
  );
  let frame = interactive.t.captureCharFrame();
  assert.match(frame, /◆ The agent is working/);
  assert.match(
    frame,
    /^ {3}\[⋯\] working · esc esc interrupt — stop the live Turn/m,
  );
  assert.doesNotMatch(frame, /[■⬝]/);

  const agent = await mountWorkbench(
    liveTurnRunOf(),
    40,
    16,
    okActions(),
    true,
  );
  frame = agent.t.captureCharFrame();
  assert.match(frame, /^ {3}\[⋯\] working · esc esc interrupt/m);
  assert.doesNotMatch(frame, /[■⬝]/);
  noOverflow(frame, 40);
  agent.control.setRun(
    liveTurnRunOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
  );
  await agent.t.renderOnce();
  assert.doesNotMatch(agent.t.captureCharFrame(), /\[⋯\]/);
});

test("a request owns the bottom region, so no scanner shows while the agent waits on the human (#292)", async () => {
  const interactive = await mountWorkbench(
    liveInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  interactive.control.setLive(requestOverlay());
  await interactive.t.renderOnce();
  assert.doesNotMatch(interactive.t.captureCharFrame(), /[■⬝]/);

  const agent = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  agent.control.setLive(requestOverlay());
  await agent.t.renderOnce();
  assert.doesNotMatch(agent.t.captureCharFrame(), /[■⬝]|working ·/);
});

test("the scanner and its words fit a small terminal, long history, and a resize (#292)", async () => {
  const agent = await mountWorkbench(
    liveTurnRunOf({ timeline: wrappingEvents(200) }),
    40,
    16,
    okActions(),
  );
  // At 40 columns the hint's words and the cells do not both fit, so the cells
  // yield and the words stay whole: meaning never rides on the scanner.
  let frame = agent.t.captureCharFrame();
  assert.match(frame, /^ {3}working · esc esc interrupt — /m);
  assert.doesNotMatch(frame, /[■⬝]/);
  noOverflow(frame, 40);

  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 24, okActions());
  resizeWorkbench(wb.t, wb.renderer, 40, 16);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /^ {3}working · esc esc interrupt — /m);
  assert.doesNotMatch(frame, /[■⬝]/);
  assert.match(frame, /◆ The agent is working/);
  noOverflow(frame, 40);
  resizeWorkbench(wb.t, wb.renderer, 100, 24);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /^ {3}[■⬝]{8} working · esc esc interrupt — stop the live Turn/m,
  );
  noOverflow(frame, 100);
});

// --- working scanner colours and narrow rows (#308) -------------------------

// The scanner's drawing is a private leaf, so its colours are asserted against the
// Workbench's own colours rather than the theme it is handed: below 80 columns the
// compact header draws a running Run in the accent the trail derives from, and the
// full header's position line is in the muted colour.

type TRendered = Awaited<ReturnType<typeof mountWorkbench>>["t"];

const rgb = (color: { r: number; g: number; b: number }) =>
  [color.r, color.g, color.b].map((v) => Math.round(v * 255)).join(",");

/** The styled spans of the rail's working row, the line naming `working ·`. */
function railSpans(t: TRendered) {
  const line = t
    .captureSpans()
    .lines.find((candidate) =>
      candidate.spans.some((span) => span.text.includes("working ·")),
    );
  assert.ok(line, "no working row");
  return line.spans;
}

/** The colour of the first span whose own text matches `text`. */
function colorOf(spans: ReturnType<typeof railSpans>, text: RegExp): string {
  const span = spans.find((candidate) => text.test(candidate.text));
  assert.ok(span, `no span matching ${String(text)}`);
  return rgb(span.fg);
}

/** The colour of the first span anywhere in the frame whose text matches `text`. */
function frameColorOf(t: TRendered, text: RegExp): string {
  return colorOf(
    t.captureSpans().lines.flatMap((line) => line.spans),
    text,
  );
}

/** Each scanner cell on the working row, in order, with the colour it draws in. */
function scannerCells(t: TRendered) {
  return railSpans(t).flatMap((span) =>
    [...span.text]
      .filter((glyph) => glyph === "■" || glyph === "⬝")
      .map((glyph) => ({ glyph, color: rgb(span.fg) })),
  );
}

/** The frame line holding the prompt's working row, trailing blanks trimmed. */
function workingLine(frame: string): string {
  const line = frame
    .split("\n")
    .find((candidate) => candidate.includes("working ·"));
  assert.ok(line !== undefined, "no working row");
  return line.trimEnd();
}

test("the scanner's lead draws in the running accent, its trail and inactive cells dimmer, its words apart (#292, #308)", async () => {
  const wb = await mountWorkbench(liveTurnRunOf(), 60, 24, okActions());
  // The prompt bar draws in the agent accent (ADR 0036).
  const accent = frameColorOf(wb.t, /^> $/);
  // Over half the cycle lights no cell, so wait for a frame whose lead and at
  // least one trail step are lit; a cycle is 2.16 s, inside the budget.
  let cells = scannerCells(wb.t);
  const lit = () => cells.filter((cell) => cell.glyph === "■");
  await until(() => {
    cells = scannerCells(wb.t);
    const colors = lit().map((cell) => cell.color);
    return colors.includes(accent) && new Set(colors).size >= 2;
  }, 3000);
  assert.equal(cells.length, 8);
  // One lead in the accent itself; every other lit step and every inactive cell
  // falls off from it, so the trail reads as a sweep, not a flat bar.
  assert.equal(lit().filter((cell) => cell.color === accent).length, 1);
  for (const cell of cells.filter((cell) => cell.glyph === "⬝"))
    assert.notEqual(cell.color, accent);
  assert.notEqual(colorOf(railSpans(wb.t), /working ·/), accent);
});

test("with reduced motion the static [⋯] draws in the muted colour, apart from the hint's words (#292, #308)", async () => {
  const wb = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions(), true);
  const muted = frameColorOf(wb.t, /^Step repair/); // the muted meta row
  const spans = railSpans(wb.t);
  assert.equal(colorOf(spans, /^\[⋯\]$/), muted);
  assert.notEqual(colorOf(spans, /working ·/), muted);
  // The mark replaces the cells rather than leading them.
  const frame = wb.t.captureCharFrame();
  assert.match(workingLine(frame), /^ {3}\[⋯\] working · esc esc interrupt — /);
  assert.doesNotMatch(frame, /[■⬝]/);
});

test("on a narrow row the detail clips first, then the mark yields so the interrupt words stay whole (#292, #308)", async () => {
  // The rail row is 38 columns inside a 40-column terminal's one-column margins:
  // indent, eight cells, a space, the 27-column words, and the clip's ellipsis is
  // 39, so the next column up is the last width the cells keep.
  const wb = await mountWorkbench(liveTurnRunOf(), 41, 16, okActions());
  const line = () => workingLine(wb.t.captureCharFrame());
  // Exact, not just within width: a one-column overrun would wrap the ellipsis.
  assert.match(line(), /^ {3}[■⬝]{8} working · esc esc interrupt…$/);
  resizeWorkbench(wb.t, wb.renderer, 40, 16);
  await wb.t.renderOnce();
  assert.equal(line(), "   working · esc esc interrupt — stop …");
  resizeWorkbench(wb.t, wb.renderer, 41, 16);
  await wb.t.renderOnce();
  assert.match(line(), /^ {3}[■⬝]{8} working · esc esc interrupt…$/);

  // The static mark is narrower, so it holds on at widths the cells cannot.
  const reduced = await mountWorkbench(
    liveTurnRunOf(),
    40,
    16,
    okActions(),
    true,
  );
  assert.equal(
    workingLine(reduced.t.captureCharFrame()),
    "   [⋯] working · esc esc interrupt — s…",
  );
});

test("the corrected INTERACTIVE_HEIGHT reclaims one timeline row at a fixed height (A33) with reported metadata (#418)", async () => {
  // #418 reserves two metadata slots, so height 26 retains the predecessor's
  // 15-row viewport. An input that reserves 4 instead of 3 rows still evicts e0.
  // Keep both oldest/newest assertions to detect the original A33 defect.
  const wb = await mountWorkbench(
    interactiveRunOf({ timeline: events(15) }),
    100,
    26,
  );
  const frame = wb.t.captureCharFrame();
  assert.match(frame, / e0 /); // the reclaimed row: the oldest event is visible
  assert.match(frame, / e14/); // the newest event still sits at the live edge
  noOverflow(frame, 100);
});

test("the corrected CHECKPOINT_HEIGHT reclaims one timeline row at a fixed height (A33) with reported metadata (#418)", async () => {
  // The same two metadata slots leave 10 history rows at height 26. A checkpoint
  // that reserves 8 instead of 7 rows still evicts e0, preserving A33 coverage.
  const wb = await mountWorkbench(
    blockedRunOf({ timeline: events(10) }),
    100,
    26,
  );
  const frame = wb.t.captureCharFrame();
  assert.match(frame, / e0 /); // the reclaimed row: the oldest event is visible
  assert.match(frame, / e9/); // the newest event still sits at the live edge
  noOverflow(frame, 100);
});

test("[windows-cleanup-notice] the Workbench shows one informational notice across updates and resize", async () => {
  const notice =
    "Secant will use its usual Windows cleanup. Some tool processes may continue after you stop or close it.";
  const run = runOf({ windowsCleanupNotice: notice });
  const { t, control, renderer } = await mountWorkbench(run, 40, 16);

  for (const width of [40, 70, 110, 40]) {
    resizeWorkbench(t, renderer, width, 16);
    control.setRun({ ...run });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    const text = frame.replace(/\s+/g, " ");
    assert.equal(text.match(/Info: Secant/g)?.length, 1);
    assert.match(
      text,
      /Secant will use its usual Windows cleanup\. Some tool processes may continue after you stop or close it\./,
    );
    assert.doesNotMatch(text, /Warning/);
    noOverflow(frame, width);
  }
});

for (const [width, height] of [
  [40, 12],
  [80, 18],
  [120, 24],
] as const) {
  test(`m10-observed-harness-facts: metadata remains bounded and leaves keyboard controls visible at ${width}x${height}`, async () => {
    const { t, control, renderer } = await mountWorkbench(
      runOf({
        timeline: events(30),
        progress: [{ id: "repair", kind: "agent", status: "running" }],
      }),
      width,
      height,
    );
    control.setLive({
      runId: "run-1",
      generation: 1,
      phase: "working",
      outstanding: [],
      offers: [],
      context: { limitTokens: 258400 },
      usage: "last output 0 tokens",
    });
    await t.renderOnce();
    assert.match(t.captureCharFrame(), /Context · capacity 258400 tokens/);
    assert.match(t.captureCharFrame(), /Usage · last output 0 tokens/);
    assert.match(t.captureCharFrame(), /\^G details/);
    await press(t, renderer, "up", { alt: true });
    assert.match(t.captureCharFrame(), /Jump to latest/);
    resizeWorkbench(t, renderer, width + 2, height);
    await t.renderOnce();
    await press(t, renderer, "end", { alt: true });
    assert.doesNotMatch(
      t.captureCharFrame(),
      /Jump to latest|Thinking|duration|%/,
    );
    assert.match(t.captureCharFrame(), /e29/);
  });
}

test("m10-home-and-preferences: all 25×2 previews recolor the mounted Workbench through Port keys", async () => {
  // The sidebar draws the Bundle name in the theme's text role (ADR 0036).
  const wb = await mountWorkbench(
    runOf(),
    140,
    40,
    undefined,
    true,
    0,
    previewPreferences(),
  );
  const header = () => {
    const span = wb.t
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Alpha"));
    assert.ok(span, wb.t.captureCharFrame());
    return [span.fg.r, span.fg.g, span.fg.b].map((v) => Math.round(v * 255));
  };
  const initial = header();
  for (const palette of PALETTES) {
    await openAppThemes(wb);
    await type(wb.t, palette.name);
    assert.deepEqual(
      header(),
      hexRgb(palette.dark).map((v) => Math.round((v * 105) / 255)),
      palette.name + " dark",
    );
    await press(wb.t, wb.renderer, "tab");
    assert.deepEqual(
      header(),
      hexRgb(palette.light).map((v) => Math.round((v * 105) / 255)),
      palette.name + " light",
    );
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(header(), initial);
  }
  resizeWorkbench(wb.t, wb.renderer, 40, 16);
  await wb.t.renderOnce();
  await openAppThemes(wb);
  await type(wb.t, "zenburn");
  await press(wb.t, wb.renderer, "return");
  noOverflow(wb.t.captureCharFrame(), 40);
  resizeWorkbench(wb.t, wb.renderer, 140, 32);
  await wb.t.renderOnce();
  assert.deepEqual(
    header(),
    hexRgb(PALETTES.find((p) => p.name === "zenburn")!.dark),
  );
});

test("m10-home-and-preferences: Workbench picker size and resize come from the Renderer Port", async () => {
  // Start with independent geometry to prove its source without a partial resize.
  // The captured canvas has rows below the Port's advertised boundary.
  const control = makeRunView(snapshotOf(runOf()));
  const renderer = makeFakeRenderer(40, 16);
  const { t, exits } = await mountApp(
    control,
    renderer,
    "run-1",
    100,
    40,
    undefined,
    true,
    0,
    previewPreferences(),
  );
  const wb = { t, exits, control, renderer };
  await t.waitForFrame(workbenchShown);
  assert.equal(t.captureSpans().rows, 40);
  await openAppThemes(wb);
  const narrow = wb.t.captureCharFrame();
  assert.match(narrow, /Themes · Dark/);
  assert.ok(
    narrow
      .split("\n")
      .slice(16)
      .every((line) => !/Preview theme|tab Dark/.test(line)),
  );
  resizeWorkbench(wb.t, wb.renderer, 100, 40);
  await wb.t.renderOnce();
  const wide = wb.t.captureCharFrame();
  assert.ok(
    wide.split("\n").filter((line) => line.includes("Preview theme")).length >
      narrow.split("\n").filter((line) => line.includes("Preview theme"))
        .length,
  );
  await type(wb.t, "zenburn");
  await press(wb.t, wb.renderer, "return");
  assert.doesNotMatch(wb.t.captureCharFrame(), /Themes · Dark/);
});

for (const appearance of ["dark", "light"] as const) {
  test(`m10-audit-truthful-keys: ${appearance} Request and Details cues retain theme roles and reduced-motion focus`, async () => {
    const preferences = previewPreferences();
    const wb = await mountWorkbench(
      liveInteractiveRunOf(),
      121,
      32,
      undefined,
      true,
      0,
      {
        ...preferences,
        snapshot: () => ({
          ...preferences.snapshot(),
          preferences: { theme: "everforest", appearance },
        }),
      },
    );
    wb.control.setLive(requestOverlay());
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /Permission required/);
    assert.equal(
      frameColorOf(wb.t, /Permission required/),
      appearance === "dark" ? "230,152,117" : "245,125,38",
    );
    assert.equal(
      frameColorOf(wb.t, /ctrl\+g details/),
      appearance === "dark" ? "122,132,120" : "166,176,160",
    );
    await press(wb.t, wb.renderer, "g", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /› Details/);
    await type(wb.t, "ignored details typing");
    resizeWorkbench(wb.t, wb.renderer, 48, 18);
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /Details · Resources/);
    noOverflow(wb.t.captureCharFrame(), 48);
    await press(wb.t, wb.renderer, "escape");
    assert.match(wb.t.captureCharFrame(), /Permission required/);
    assert.deepEqual(wb.control.requests, []);
    wb.control.setLive(undefined);
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /ignored details typing|[■⬝]/);
    assert.match(wb.t.captureCharFrame(), /\[⋯\]/);
  });
}
