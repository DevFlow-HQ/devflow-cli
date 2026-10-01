import assert from "node:assert/strict";
import { test } from "node:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
  SCANNER_FRAMES,
  scannerGlyphs,
  WorkingScanner,
} from "../../src/tui/tui.js";

// The scanner's pure frame builder (#292), rebuilt against OpenCode's `createFrames`
// (`ui/spinner.ts`) with its default constants: 8 cells, a 6-step trail, 9 frames
// held at the far end and 30 at the start. No clock — the frames are a fixed cycle.

test("the cycle is 8 forward, 9 held, 7 back, and 30 held frames of 8 cells", () => {
  assert.equal(SCANNER_FRAMES.length, 8 + 9 + 7 + 30);
  for (const frame of SCANNER_FRAMES) {
    assert.equal(frame.length, 8);
    assert.match(scannerGlyphs(frame), /^[■⬝]{8}$/);
  }
});

test("the lead sweeps right with its trail behind, then back with the trail reversed", () => {
  const glyphs = SCANNER_FRAMES.map(scannerGlyphs);
  assert.equal(glyphs[0], "■⬝⬝⬝⬝⬝⬝⬝");
  assert.equal(glyphs[3], "■■■■⬝⬝⬝⬝");
  assert.equal(glyphs[7], "⬝⬝■■■■■■");
  // The far-end hold keeps the lead and fades the trail out one cell a frame.
  assert.equal(glyphs[8], "⬝⬝■■■■■■");
  assert.equal(glyphs[9], "⬝⬝⬝■■■■■");
  assert.equal(glyphs[14], "⬝⬝⬝⬝⬝⬝⬝⬝");
  assert.equal(glyphs[16], "⬝⬝⬝⬝⬝⬝⬝⬝");
  // Back from the second-last cell, trail to the right.
  assert.equal(glyphs[17], "⬝⬝⬝⬝⬝⬝■■");
  assert.equal(glyphs[23], "■■■■■■⬝⬝");
  // The start hold fades the trail again, then rests empty until the next sweep.
  assert.equal(glyphs[24], "■■■■■■⬝⬝");
  assert.equal(glyphs[29], "■⬝⬝⬝⬝⬝⬝⬝");
  assert.equal(glyphs[30], "⬝⬝⬝⬝⬝⬝⬝⬝");
  assert.equal(glyphs[53], "⬝⬝⬝⬝⬝⬝⬝⬝");
});

test("a cell's trail step names its place behind the lead, at most six cells lit", () => {
  // Frame 7: the lead at the last cell is step 0, each cell behind one step dimmer.
  assert.deepEqual(
    SCANNER_FRAMES[7]?.map((cell) => cell.trail),
    [undefined, undefined, 5, 4, 3, 2, 1, 0],
  );
  for (const frame of SCANNER_FRAMES) {
    assert.ok(frame.filter((cell) => cell.trail !== undefined).length <= 6);
  }
});

test("inactive cells fade in while the lead moves and out while it holds", () => {
  const fade = (index: number) => SCANNER_FRAMES[index]?.[0]?.fade;
  // Forward: from the minimum to full across the sweep.
  assert.equal(fade(0), 0.3);
  assert.equal(fade(7), 1);
  // Held at the far end: back down toward the minimum, never below it.
  assert.equal(fade(8), 1);
  assert.ok((fade(16) ?? 0) < (fade(12) ?? 0));
  for (const frame of SCANNER_FRAMES) {
    const value = frame[0]?.fade ?? 0;
    assert.ok(value >= 0.3 && value <= 1, `fade ${value}`);
  }
});

// The leaf drawn alone, so its colours compare to the ones it is given.

const ACCENT = RGBA.fromHex("#88c0d0");
const MUTED = RGBA.fromHex("#4c566a");
const LABEL = RGBA.fromHex("#eceff4");

async function renderLeaf(reducedMotion: boolean, width: number) {
  const t = await testRender(
    () => (
      <WorkingScanner
        label="esc esc interrupt"
        detail="stop this Turn"
        labelColor={LABEL}
        accent={ACCENT}
        muted={MUTED}
        reducedMotion={reducedMotion}
        width={width}
      />
    ),
    { width: 60, height: 3 },
  );
  await t.renderOnce();
  return t;
}

const rgb = (color: RGBA) =>
  [color.r, color.g, color.b].map((v) => Math.round(v * 255)).join(",");

test("the lead cell is drawn in the accent and the inactive cells dimmer", async () => {
  const t = await renderLeaf(false, 60);
  const spans = t.captureSpans().lines[0]?.spans ?? [];
  // The first frame lights only the first cell: the lead, at full strength.
  const lead = spans.find((span) => span.text.startsWith("■"));
  assert.equal(lead?.text, "■");
  assert.equal(rgb(lead.fg), rgb(ACCENT));
  const inactive = spans.find((span) => span.text.startsWith("⬝"));
  assert.ok(inactive);
  assert.notEqual(rgb(inactive.fg), rgb(ACCENT));
  assert.match(
    t.captureCharFrame(),
    /^ {2}■⬝{7} esc esc interrupt — stop this Turn/,
  );
  t.renderer.destroy();
});

test("with reduced motion the leaf draws the static [⋯] in the muted colour", async () => {
  const t = await renderLeaf(true, 60);
  const frame = t.captureCharFrame();
  assert.match(frame, /^ {2}\[⋯\] esc esc interrupt — stop this Turn/);
  assert.doesNotMatch(frame, /[■⬝]/);
  const mark = t
    .captureSpans()
    .lines[0]?.spans.find((span) => span.text.includes("[⋯]"));
  assert.ok(mark);
  assert.equal(rgb(mark.fg), rgb(MUTED));
  t.renderer.destroy();
});

test("the detail clips first, then the mark yields so the label stays whole", async () => {
  // 2 indent + 8 cells + space + 17-column label + the clip's `…` is 29 columns.
  let t = await renderLeaf(false, 29);
  let line = t.captureCharFrame().split("\n")[0]?.trimEnd() ?? "";
  assert.match(line, /^ {2}[■⬝]{8} esc esc interrupt…$/);
  t.renderer.destroy();

  // One column fewer: the mark goes, never the words.
  t = await renderLeaf(false, 28);
  line = t.captureCharFrame().split("\n")[0]?.trimEnd() ?? "";
  assert.equal(line, "  esc esc interrupt — stop …");
  t.renderer.destroy();

  // The static mark is narrower, so it holds on at widths the cells cannot.
  t = await renderLeaf(true, 24);
  line = t.captureCharFrame().split("\n")[0]?.trimEnd() ?? "";
  assert.equal(line, "  [⋯] esc esc interrupt…");
  t.renderer.destroy();
});
