import stripAnsi from "strip-ansi";
import type {
  HistoryContentRead,
  HistoryTextEdgeResume,
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

interface OscAttempt {
  readonly start: number;
  escape: boolean;
  /** The introducer's `crBefore`, and its `crAt` for a later portion. */
  readonly crBefore: boolean;
  readonly crAt: boolean;
}
interface CsiAttempt {
  readonly start: number;
  phase: "intermediates" | "digits" | "separator";
  digits: number;
  fallback?: number;
}
/** Scanner state captured at a portion's end, carried as opaque JSON data. */
interface EdgeScan {
  readonly position: number;
  readonly previous: string;
  readonly cr: boolean;
  readonly osc?: OscAttempt;
  readonly csi?: CsiAttempt;
}

/** Match strip-ansi's control grammar without retaining an unbounded OSC string.
 * Application supplies bounded transient portions; only crossing spans survive.
 * `dropLeadingLf` reports that the last unit before `start` surviving ANSI
 * removal is CR, so the portion's first surviving LF already rendered. With
 * `resume`, `source` starts at that captured position; every capture reads as
 * if `end` were the next portion's `start`, so resumed edges equal fresh ones. */
export const historyTextEdges: (
  source: Iterable<string>,
  start: number,
  end: number,
  resume?: HistoryTextEdgeResume,
) => {
  readonly edges: HistoryTextEdges;
  readonly resume?: HistoryTextEdgeResume;
} = (source, start, end, resume) => {
  const from = resume as EdgeScan | undefined;
  let dropLeading = 0,
    dropTrailing = 0,
    crBefore = from?.cr ?? false,
    // `crBefore` for a portion starting at the current position.
    crAt = crBefore;
  let position = from?.position ?? 0,
    previous = from?.previous ?? "";
  // Open attempts defer `crBefore`: CSI units are never CR, and a terminated
  // OSC restores the value from its introducer.
  let osc: OscAttempt | undefined = from?.osc && { ...from.osc };
  let csi: CsiAttempt | undefined = from?.csi && { ...from.csi };
  let captured: EdgeScan | undefined;
  const final = /[0-9A-PR-TZcf-nq-uy=><~]/;
  const intermediate = new Set(["[", "]", "(", ")", "#", ";", "?"]);
  const digit = /[0-9]/;
  const special = /[\p{Cc}]/gu;
  const result = () => ({
    edges: { dropLeading, dropTrailing, dropLeadingLf: crBefore },
    ...(captured === undefined ? {} : { resume: { ...captured } }),
  });
  function capture(): void {
    if (position !== end || captured !== undefined) return;
    captured = {
      position,
      previous,
      cr: crAt,
      ...(osc === undefined ? {} : { osc: { ...osc, crBefore: osc.crAt } }),
      ...(csi === undefined ? {} : { csi: { ...csi } }),
    };
  }
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
    if ((csi.fallback ?? csi.start) < position) crAt = false;
    csi = undefined;
  }
  function terminate(terminated: OscAttempt): void {
    span(terminated.start, position + 1);
    // Everything since the introducer is removed, including nested attempts.
    crBefore = terminated.crBefore;
    crAt = terminated.crAt;
    osc = undefined;
    csi = undefined;
  }
  for (const portion of source) {
    let at = 0;
    while (at < portion.length) {
      capture();
      if (
        position >= end &&
        (!osc || osc.start >= end) &&
        (!csi || csi.start >= end)
      )
        return result();
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
          crAt = false;
          previous = portion[stop - 1]!;
          position += stop - at;
          at = stop;
          if (at >= portion.length) break;
          capture();
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
          osc = { start: csi.start, escape: false, crBefore, crAt };
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
        else {
          if (position < start) crBefore = char === "\r";
          crAt = char === "\r";
        }
      }
      previous = char;
      position++;
      at++;
    }
  }
  capture();
  fallback();
  return result();
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
