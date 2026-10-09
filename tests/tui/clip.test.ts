import assert from "node:assert/strict";
import { test } from "node:test";
import stringWidth from "string-width";
import { clip } from "../../src/tui/tui.js";

// `clip` truncates to display columns, not UTF-16 code units (D5). A wide glyph
// occupies two columns, so a `.length`-based clip would miscount and overflow the
// terminal width (tui/AGENTS.md: an overflowing row is corrupted, not clipped).

test("text within the width is returned unchanged", () => {
  assert.equal(clip("hello", 10), "hello");
  assert.equal(clip("hello", 5), "hello");
});

test("ASCII over the width truncates to exactly the width with an ellipsis", () => {
  const out = clip("hello world", 5);
  assert.equal(out, "hell…");
  assert.equal(stringWidth(out), 5);
});

test("a row of wide glyphs clips to the terminal width exactly", () => {
  // "你好世界" is four 2-column glyphs (8 columns). Clipped to 5 it must occupy
  // exactly 5 columns, never 6 — two glyphs (4) plus the 1-column ellipsis.
  const out = clip("你好世界", 5);
  assert.equal(stringWidth(out), 5);
  assert.equal(out, "你好…");
});

test("a trailing wide glyph never spills past the budget", () => {
  // Budget after the ellipsis is 3 columns; a second wide glyph (to column 4) must
  // not fit, so only one glyph precedes the marker.
  const out = clip("你a好", 4);
  assert.ok(stringWidth(out) <= 4, `width ${stringWidth(out)} exceeds 4`);
});

test("width of one or zero never overflows", () => {
  assert.equal(stringWidth(clip("你好", 1)), 1); // the ellipsis alone, not a 2-col glyph
  assert.equal(clip("anything", 0), "");
});

// Whole graphemes (#307): a cut lands between user-perceived characters, never
// inside one, and the budget counts each grapheme's own width. Summing code points
// undercounts a keycap (`1` + U+FE0F + U+20E3 is 1 + 0 + 0, but draws 2 columns)
// and can strand the head of a joined or modified emoji before the ellipsis.

const graphemes = (text: string) =>
  [...new Intl.Segmenter().segment(text)].map(({ segment }) => segment);

/** Assert `out` is within `width` columns and is a whole-grapheme prefix of
 *  `text` followed by the ellipsis. */
function assertWholeCut(text: string, width: number, out: string) {
  assert.ok(
    stringWidth(out) <= width,
    `width ${stringWidth(out)} exceeds ${width}`,
  );
  assert.ok(out.endsWith("…"), `no ellipsis: ${JSON.stringify(out)}`);
  const kept = graphemes(out.slice(0, -1));
  assert.deepEqual(kept, graphemes(text).slice(0, kept.length));
}

const KEYCAP = "1️⃣"; // 1, U+FE0F, U+20E3 — one 2-column grapheme
const FAMILY = "👨‍👩‍👧‍👦"; // four emoji joined by ZWJ — one 2-column grapheme
const THUMB = "👍🏽"; // thumbs-up plus a skin-tone modifier — one 2-column grapheme
const ACCENT = "é"; // e plus a combining acute — one 1-column grapheme

test("a keycap counts its drawn two columns, so the cut stays within the budget", () => {
  const out = clip(`ab${KEYCAP}cd`, 4);
  assertWholeCut(`ab${KEYCAP}cd`, 4, out);
  assert.equal(out, "ab…");
  // A run of keycaps (the audit's 30-column repro) never exceeds the width.
  const keycaps = KEYCAP.repeat(20);
  assertWholeCut(keycaps, 30, clip(keycaps, 30));
  assert.equal(stringWidth(clip(keycaps, 30)), 29);
});

test("format characters are removed before measuring and clipping emoji", () => {
  assert.equal(clip(`ab${FAMILY}cd`, 5), "ab👨…");
  assert.equal(clip(`a${FAMILY}bc`, 3), "a…");
  assert.equal(clip(FAMILY, 8), "👨👩👧👦");
  assert.equal(stringWidth(clip(`ab${FAMILY}cd`, 5)), 5);
});

test("a skin-tone modifier stays attached to its emoji", () => {
  assert.equal(clip(`a${THUMB}bc`, 4), `a${THUMB}…`);
  assert.equal(clip(`a${THUMB}bc`, 3), "a…");
});

test("a combining mark stays attached to its base letter", () => {
  const out = clip(`ab${ACCENT}de`, 4);
  assertWholeCut(`ab${ACCENT}de`, 4, out);
  assert.equal(out, `ab${ACCENT}…`);
});

test("multi-code-point graphemes that fit are returned unchanged", () => {
  for (const text of [KEYCAP, THUMB, ACCENT, `你${KEYCAP}`]) {
    assert.equal(clip(text, stringWidth(text)), text);
  }
});

test("a two-column grapheme never fits a one- or zero-column budget", () => {
  for (const text of [`${KEYCAP}x`, `${FAMILY}x`, `${THUMB}x`, "你x"]) {
    assert.equal(clip(text, 1), "…");
    assert.equal(clip(text, 0), "");
  }
  assert.equal(clip(`${KEYCAP}ab`, 2), "…");
});
