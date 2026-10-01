import assert from "node:assert/strict";
import { test } from "node:test";
import stringWidth from "string-width";
import { wrap } from "../../src/tui/tui.js";

// `wrap` breaks one logical line into display lines no wider than the width, in
// display columns (D5), so the Workbench can count exactly the lines it renders
// (#288). Nothing is dropped except the whitespace a break consumes.

function fits(lines: readonly string[], width: number) {
  for (const line of lines) {
    assert.ok(stringWidth(line) <= width, `${JSON.stringify(line)} > ${width}`);
  }
}

test("text within the width is one unchanged line, and empty text is one empty line", () => {
  assert.deepEqual(wrap("hello world", 11), ["hello world"]);
  assert.deepEqual(wrap("", 10), [""]);
});

test("a line that exactly fills the width is not broken", () => {
  assert.deepEqual(wrap("alpha beta gamma delta epsilon", 30), [
    "alpha beta gamma delta epsilon",
  ]);
});

test("words wrap at spaces, and the break consumes the space", () => {
  assert.deepEqual(wrap("alpha beta gamma delta epsilon", 29), [
    "alpha beta gamma delta",
    "epsilon",
  ]);
  assert.deepEqual(wrap("aa bb cc dd", 5), ["aa bb", "cc dd"]);
});

test("an over-long word breaks by characters", () => {
  assert.deepEqual(wrap("x".repeat(12), 5), ["xxxxx", "xxxxx", "xx"]);
  assert.deepEqual(wrap("ab abcdefgh", 4), ["ab", "abcd", "efgh"]);
});

test("wide glyphs count two columns and never split past the width", () => {
  const lines = wrap("你好世界你好", 5);
  assert.deepEqual(lines, ["你好", "世界", "你好"]);
  fits(lines, 5);
  // A glyph wider than a one-column line still advances, one per line, with no
  // empty line left behind.
  assert.deepEqual(wrap("你好", 1), ["你", "好"]);
});

test("leading indentation and inner runs of spaces are kept when they fit", () => {
  assert.deepEqual(wrap("    if (a)  b", 20), ["    if (a)  b"]);
});

test("tabs expand to spaces so the measured width is the rendered width", () => {
  const lines = wrap("a\tb", 10);
  assert.deepEqual(lines, ["a  b"]);
  assert.ok(!lines.some((line) => line.includes("\t")));
});

test("continuation lines hang under the given indent", () => {
  const lines = wrap("  alpha beta gamma delta", 12, 4);
  assert.deepEqual(lines, ["  alpha beta", "    gamma", "    delta"]);
  fits(lines, 12);
});

test("a hang that leaves no room collapses so the text still advances", () => {
  const lines = wrap("abcdef", 2, 4);
  assert.deepEqual(lines, ["ab", " c", " d", " e", " f"]);
  fits(lines, 2);
});

test("a capped row's truncation marker is never split and ends its last display line", () => {
  // Word by word, "… output" would fit beside the content and leave "truncated"
  // alone on the next line; the marker moves down whole instead.
  assert.deepEqual(wrap(`${"y".repeat(10)} … output truncated`, 20), [
    "yyyyyyyyyy",
    "… output truncated",
  ]);
  assert.deepEqual(wrap(`${"y".repeat(10)} … output truncated`, 40), [
    "yyyyyyyyyy … output truncated",
  ]);
  // Only a line narrower than the marker itself breaks it, by grapheme.
  fits(wrap(`yy … output truncated`, 12), 12);
});
