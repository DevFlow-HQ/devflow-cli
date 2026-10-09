import { screenText, type ScreenedText } from "./screen-text.js";
import stringWidth from "string-width";

// Single-line truncation with an ellipsis affordance, shared by the screens that
// want to *show* a row was cut — one implementation so that ellipsis behaviour
// stays identical across screens. Why its column budget must be exact is in
// tui/AGENTS.md.
//
// Width is measured in *display columns* (D5), one whole grapheme at a time, as
// `wrap.ts` does: summing code points undercounts a keycap (1 + U+FE0F + U+20E3
// draws two columns, not one), and a cut between code points strands the head of
// a skin-toned emoji, drawing a different glyph. Format characters, including
// emoji joiners, are removed by the display rule before measuring. `string-width` is the
// runtime-neutral column measure (a direct npm dependency, not OpenCode-vendored).

const segmenter = new Intl.Segmenter();

/** Truncate `text` to `width` display columns, marking a cut with a trailing
 *  ellipsis. The result never exceeds `width` columns. */
export function clip(text: string, width: number): string {
  return clipScreened(screenText(text), width).text;
}

/** Clip already-screened content while preserving its display-only status. */
export function clipScreened(value: ScreenedText, width: number): ScreenedText {
  return { text: clipLine(value.text.replace(/[\n\t]/g, " "), width) };
}

function clipLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  // Reserve one column for the "…" marker; fill the rest with as many leading
  // graphemes as fit, measured by column, so a trailing wide glyph never spills
  // past the budget.
  const budget = width - 1;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const columns = stringWidth(segment);
    if (used + columns > budget) break;
    out += segment;
    used += columns;
  }
  return `${out}…`;
}
