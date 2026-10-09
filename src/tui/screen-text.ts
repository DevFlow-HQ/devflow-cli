import stripAnsi from "strip-ansi";
import type {
  HistoryContentRead,
  HistoryTextEdges,
} from "../application/projection-port.js";

/** Text already screened at the display boundary. Layout keeps this value separate from raw content. */
export interface ScreenedText {
  readonly text: string;
}

/** CRLF folding and control removal see text after ANSI removal. */
function screenStripped(text: string): ScreenedText {
  return {
    text: text
      .replace(/\r\n?/g, "\n")
      .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
        character === "\n" || character === "\t" ? character : "",
      ),
  };
}

/** Terminal display only. Retained content and JSON keep their original bytes. */
export function screenText(text: string): ScreenedText {
  return screenStripped(stripAnsi(text));
}

/** Match strip-ansi's control grammar without retaining an unbounded OSC string.
 * Application supplies bounded transient portions; only crossing spans survive.
 * `dropLeadingLf` reports that the last unit before `start` surviving ANSI
 * removal is CR, so the portion's first surviving LF already rendered. */
export const historyTextEdges: (
  source: Iterable<string>,
  start: number,
  end: number,
) => HistoryTextEdges = (source, start, end) => {
  let dropLeading = 0,
    dropTrailing = 0,
    crBefore = false;
  let position = 0,
    previous = "";
  // Open attempts defer `crBefore`: CSI units are never CR, and a terminated
  // OSC restores the value from its introducer.
  let osc: { start: number; escape: boolean; crBefore: boolean } | undefined;
  let csi:
    | {
        start: number;
        phase: "intermediates" | "digits" | "separator";
        digits: number;
        fallback?: number;
      }
    | undefined;
  const final = /[0-9A-PR-TZcf-nq-uy=><~]/;
  const intermediate = new Set(["[", "]", "(", ")", "#", ";", "?"]);
  const digit = /[0-9]/;
  const special = /[\p{Cc}]/gu;
  const edges = (): HistoryTextEdges => ({
    dropLeading,
    dropTrailing,
    dropLeadingLf: crBefore,
  });
  function span(from: number, to: number): void {
    if (from < start && to > start)
      dropLeading = Math.max(dropLeading, Math.min(end - start, to - start));
    if (from < end && to > end)
      dropTrailing = Math.max(dropTrailing, end - Math.max(start, from));
  }
  function fallback(): void {
    if (!csi) return;
    if (csi.fallback !== undefined) span(csi.start, csi.fallback);
    // Units after the matched prefix, or a whole unmatched attempt, stay visible.
    if ((csi.fallback ?? csi.start) < Math.min(position, start))
      crBefore = false;
    csi = undefined;
  }
  function terminate(terminated: NonNullable<typeof osc>): void {
    span(terminated.start, position + 1);
    // Everything since the introducer is removed, including nested attempts.
    crBefore = terminated.crBefore;
    osc = undefined;
    csi = undefined;
  }
  for (const portion of source) {
    let at = 0;
    while (at < portion.length) {
      if (
        position >= end &&
        (!osc || osc.start >= end) &&
        (!csi || csi.start >= end)
      )
        return edges();
      if (!csi) {
        // Ordinary content needs no per-character walk, even in a huge line.
        special.lastIndex = at;
        const next = special.exec(portion)?.index ?? portion.length;
        const stop = Math.min(
          next,
          position < end ? at + (end - position) : next,
        );
        if (stop > at) {
          if (position < start) crBefore = false;
          previous = portion[stop - 1]!;
          position += stop - at;
          at = stop;
          if (at >= portion.length) break;
        }
      }
      const char = portion[at]!;
      let consumed = false;
      if (osc) {
        if (osc.escape) {
          if (char === "\\") {
            terminate(osc);
            consumed = true;
          } else osc = undefined;
        } else if (char === "\x07" || char === "\x9c") {
          terminate(osc);
          consumed = true;
        } else if (char === "\x1b") osc.escape = true;
      }
      if (!consumed && csi) {
        if (
          csi.phase === "intermediates" &&
          char === "]" &&
          position === csi.start + 1 &&
          previous === "\x1b"
        )
          osc = { start: csi.start, escape: false, crBefore };
        consumed = true;
        if (csi.phase === "intermediates" && intermediate.has(char)) {
          // Intermediate bytes keep the introducer open.
        } else if (digit.test(char)) {
          if (csi.digits === 4) {
            span(csi.start, position + 1);
            csi = undefined;
          } else {
            csi.phase = "digits";
            csi.digits++;
            csi.fallback = position + 1;
          }
        } else if (
          csi.phase !== "intermediates" &&
          (char === ";" || char === ":")
        ) {
          csi.phase = "separator";
          csi.digits = 0;
        } else if (final.test(char)) {
          span(csi.start, position + 1);
          csi = undefined;
        } else {
          fallback();
          consumed = false;
        }
      }
      if (!consumed) {
        if (char === "\x1b" || char === "\x9b")
          csi = { start: position, phase: "intermediates", digits: 0 };
        else if (position < start) crBefore = char === "\r";
      }
      previous = char;
      position++;
      at++;
    }
  }
  fallback();
  return edges();
};

export function screenHistoryPortion(
  read: Extract<HistoryContentRead, { found: true; type: "history-text" }>,
): ScreenedText {
  const leading = read.edges?.dropLeading ?? 0;
  const trailing = read.edges?.dropTrailing ?? 0;
  const stripped = stripAnsi(
    read.content.slice(
      leading,
      Math.max(leading, read.content.length - trailing),
    ),
  );
  // The previous portion's CR already rendered this CRLF's newline.
  return screenStripped(
    read.edges?.dropLeadingLf && stripped.startsWith("\n")
      ? stripped.slice(1)
      : stripped,
  );
}
