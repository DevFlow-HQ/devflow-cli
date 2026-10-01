import assert from "node:assert/strict";
import { test } from "node:test";
import { SCANNER_FRAMES, scannerGlyphs } from "../../src/tui/tui.js";

// The scanner's pure frame builder (#292), rebuilt against OpenCode's `createFrames`
// (`ui/spinner.ts`) with its default constants: 8 cells, a 6-step trail, 9 frames
// held at the far end and 30 at the start. No clock — the frames are a fixed cycle.
// The drawing leaf is private to the TUI Module; its colours, static mark, and
// narrow-row priority are asserted through the Run Workbench (#308).

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
