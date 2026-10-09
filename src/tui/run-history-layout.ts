import { screenText, type ScreenedText } from "./screen-text.js";
import { clipScreened } from "./clip.js";
import type { LayoutObserver } from "./layout-observer.js";
import type { TimelineRow } from "./run-timeline-rows.js";
import { wrapScreenedRows, wrapRules, type Rule } from "./wrap.js";

const HANG = 4;
const BEGINNING = { glyph: "─", title: "Beginning of Run history" };

function sameRules(a: readonly Rule[], b: readonly Rule[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (rule, i) => rule.glyph === b[i]?.glyph && rule.title === b[i]?.title,
    )
  );
}

function sameContent(a: TimelineRow, b: TimelineRow): boolean {
  return (
    a.text === b.text &&
    a.oneLine === b.oneLine &&
    (a.inspection !== undefined) === (b.inspection !== undefined) &&
    a.output?.text === b.output?.text &&
    a.output?.live === b.output?.live &&
    a.output?.incomplete === b.output?.incomplete &&
    a.output?.secantDropped === b.output?.secantDropped &&
    a.thought?.content === b.thought?.content &&
    a.thought?.live === b.thought?.live
  );
}

/** OpenCode's line/character collapse policy, adapted to truthful omission units.
 * Studied at 228e9095ba3988a02664c3816cb51f98584e86c2; see UPSTREAM. */
function collapsedOutput(output: string, width: number) {
  const maxLines = 10;
  const maxChars = maxLines * Math.max(20, width - 6);
  const lines = output.split(/\r?\n/);
  const preview = lines.slice(0, maxLines).join("\n");
  const characters = Array.from(preview);
  if (characters.length > maxChars) {
    const shown = maxChars - 1;
    return {
      text: characters.slice(0, shown).join("") + "…",
      hidden: `${Array.from(output).length - shown} hidden characters`,
    };
  }
  const hidden = Math.max(0, lines.length - maxLines);
  return {
    text: preview,
    hidden: hidden === 0 ? "" : `${hidden} hidden lines`,
  };
}

function rowText(
  row: TimelineRow,
  expanded: boolean,
  width: number,
  reducedMotion: boolean,
): ScreenedText {
  const prefix = "  ";
  if (row.inspection !== undefined) return screenText(`  ▸ ${row.text}`);
  if (row.output !== undefined) {
    const output = screenText(row.output.text).text;
    const heading = screenText(row.text).text;
    // Apply both limits before wrapping. Hidden output is never laid out.
    const preview = expanded
      ? { text: output, hidden: "" }
      : collapsedOutput(output, width);
    const label = row.output.live
      ? "live"
      : row.output.incomplete
        ? "potentially incomplete"
        : "final";
    return {
      text: `${prefix}${heading}\n  ${expanded ? "▾" : "▸"} Output · ${label}${output === "" ? " · empty" : ""}${preview.hidden === "" ? "" : ` · ${preview.hidden}`}${row.output.secantDropped ? "\nSecant · earlier output dropped" : ""}${output === "" ? "" : `\n${preview.text}`}`,
    };
  }
  if (row.thought === undefined)
    return row.oneLine
      ? clipScreened(screenText(prefix + row.text), width)
      : screenText(prefix + row.text);
  const label = row.thought.live
    ? row.text.replace(
        "Thought · Thinking",
        `Thought · Thinking ${reducedMotion ? "[.]" : "|"}`,
      )
    : row.text;
  const header = clipScreened(
    screenText(`  ${expanded ? "▾" : "▸"} ${label}`),
    width,
  );
  return expanded
    ? { text: `${header.text}\n${screenText(row.thought.content).text}` }
    : header;
}

/** Row identity owns per-width and expansion layouts of its current value.
 * Eviction or a value/divider change releases every variant. */
export function createHistoryLayout(
  observe: LayoutObserver,
  reducedMotion: boolean,
) {
  type Layout = {
    readonly key: string;
    readonly lines: readonly string[];
    readonly height: number;
    readonly prefix: number;
    readonly thoughtHeader: number;
  };
  type Cached = {
    row: TimelineRow;
    readonly rules: readonly Rule[];
    readonly widths: Map<number, Map<boolean, Layout>>;
  };
  const cache = new Map<string, Cached>();
  return (
    rows: readonly TimelineRow[],
    width: number,
    expanded: ReadonlySet<string>,
  ) => {
    const retained = new Set(rows.map((row) => row.key));
    for (const key of cache.keys()) if (!retained.has(key)) cache.delete(key);
    const layouts = rows.map((row, index) => {
      const first = index === 0;
      const rules = first
        ? [...(row.dividers ?? []), BEGINNING]
        : (row.dividers ?? []);
      let cached = cache.get(row.key);
      if (
        cached === undefined ||
        !sameRules(cached.rules, rules) ||
        !sameContent(cached.row, row)
      ) {
        cached = { row, rules, widths: new Map() };
        cache.set(row.key, cached);
      }
      // Inspection bodies may change without changing their collapsed label.
      // Retain the current row rather than an obsolete supplied patch.
      cached.row = row;
      const isExpanded = expanded.has(row.key);
      let variants = cached.widths.get(width);
      if (variants === undefined) {
        variants = new Map();
        cached.widths.set(width, variants);
      }
      let layout = variants.get(isExpanded);
      if (layout === undefined) {
        observe({ kind: "history", id: row.key, width });
        const text = rowText(row, isExpanded, width, reducedMotion);
        const leading = wrapRules(rules, width);
        const lines = [
          ...leading,
          ...wrapScreenedRows([text], width, HANG).lines,
        ];
        const prefix = leading.length;
        const thoughtHeader = row.thought?.live ? leading.length : -1;
        layout = {
          key: row.key,
          lines,
          height: lines.length,
          prefix,
          thoughtHeader,
        };
        variants.set(isExpanded, layout);
      }
      return layout;
    });
    return { rows: layouts, heights: layouts.map((row) => row.lines.length) };
  };
}
