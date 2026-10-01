import stringWidth from "string-width";
import { RUN_TIMELINE_TRUNCATION_MARKER } from "../application/projection-port.js";

// Word wrap in display columns (D5), the counterpart of `clip.ts` for the rows
// that must never be cut (#288): the Session transcript and the Workbench
// timeline. Why the wrap is ours and not OpenTUI's is in tui/AGENTS.md.
//
// A break consumes the spaces it lands on; every other character is kept, so
// leading indentation and aligned runs of spaces survive. A word wider than the
// line breaks by grapheme. Tabs become two spaces before measuring, because
// `string-width` counts a tab as zero columns while the terminal draws it wider.
// A trailing truncation marker wraps as one word, so it always ends the last line.

const TAB = "  ";
const segmenter = new Intl.Segmenter();

/** Wrap `text` (one logical line) to lines of at most `width` display columns.
 *  Continuation lines start with `hang` spaces, reduced when the width leaves no
 *  room for text after them. Always returns at least one line. */
export function wrap(text: string, width: number, hang = 0): string[] {
  const columns = Math.max(1, width);
  const indent = " ".repeat(Math.max(0, Math.min(hang, columns - 1)));
  const lines: string[] = [];
  let line = "";
  let used = 0;
  // `fresh` is a continuation line holding only its indent, where the spaces a
  // break landed on are dropped; the first line keeps its leading spaces.
  let fresh = false;
  let spaces = "";
  const breakLine = () => {
    lines.push(line);
    line = indent;
    used = indent.length;
    fresh = true;
  };
  for (const token of tokens(text.replaceAll("\t", TAB))) {
    if (token === "") continue;
    if (token.startsWith(" ")) {
      spaces += token;
      continue;
    }
    let piece = fresh ? token : spaces + token;
    spaces = "";
    if (used + stringWidth(piece) > columns && !fresh && used > 0) {
      breakLine();
      piece = token;
    }
    // Break a piece still too wide for a whole line by grapheme.
    while (used + stringWidth(piece) > columns) {
      let head = "";
      let headWidth = 0;
      for (const { segment } of segmenter.segment(piece)) {
        const segmentWidth = stringWidth(segment);
        // Always take one grapheme, so a glyph wider than the line still advances.
        if (head !== "" && used + headWidth + segmentWidth > columns) break;
        head += segment;
        headWidth += segmentWidth;
      }
      line += head;
      used += headWidth;
      piece = piece.slice(head.length);
      if (piece === "") break;
      breakLine();
    }
    line += piece;
    used += stringWidth(piece);
    fresh = false;
  }
  lines.push(line);
  return lines;
}

/** Split on runs of spaces, keeping them, with a trailing truncation marker kept
 *  whole as the last word. */
function tokens(text: string): string[] {
  const suffix = ` ${RUN_TIMELINE_TRUNCATION_MARKER}`;
  if (!text.endsWith(suffix)) return text.split(/( +)/);
  return text
    .slice(0, -suffix.length)
    .split(/( +)/)
    .concat(" ", RUN_TIMELINE_TRUNCATION_MARKER);
}

/** A divider: a run of one `glyph` across the line with `title` centred in it. */
export interface Rule {
  readonly glyph: string;
  readonly title: string;
}

/** Draw `rule` across `width` display columns. It fits on one line while at least
 *  two glyphs flank each side of the title; narrower, the title's words wrap and
 *  the glyph leads each line, so the words are never lost (#289). */
function ruleLines(rule: Rule, width: number): string[] {
  const columns = Math.max(1, width);
  const room = columns - stringWidth(rule.title) - 2;
  if (room >= 4) {
    const left = Math.floor(room / 2);
    return [
      `${rule.glyph.repeat(left)} ${rule.title} ${rule.glyph.repeat(room - left)}`,
    ];
  }
  if (columns < 3) return wrap(`${rule.glyph} ${rule.title}`, columns);
  return wrap(rule.title, columns - 2).map((line) => `${rule.glyph} ${line}`);
}

/** A row laid out under the rules that lead it: each rule's lines, then the row's
 *  wrapped text, counted as one row. */
export interface RuledRow {
  readonly rules: readonly Rule[];
  readonly text: string;
}

/** Rows wrapped at one width: every row's display lines in order, and each row's
 *  line count — the `heights` the scroll reducer windows over. */
interface WrappedRows {
  readonly lines: readonly string[];
  readonly heights: readonly number[];
}

/** Wrap each row with `wrap`, laying the results out top to bottom. A row's rules
 *  are drawn at the same width above it and count toward its height, so a divider
 *  scrolls, anchors, and counts as part of the row it leads. */
export function wrapRows(
  rows: readonly (string | RuledRow)[],
  width: number,
  hang = 0,
): WrappedRows {
  const lines: string[] = [];
  const heights: number[] = [];
  for (const row of rows) {
    const { rules, text } =
      typeof row === "string" ? { rules: [], text: row } : row;
    const wrapped = [
      ...rules.flatMap((rule) => ruleLines(rule, width)),
      ...wrap(text, width, hang),
    ];
    for (const line of wrapped) lines.push(line);
    heights.push(wrapped.length);
  }
  return { lines, heights };
}
