// The Run Workbench timeline's scroll model as a pure reducer over row heights —
// deliberately NOT OpenTUI's `<scrollbox>`. Upstream OpenCode
// (routes/session/index.tsx @ 1ead9e3d7f) follows the live edge with the
// scrollbox's `stickyScroll`/`stickyStart="bottom"` and has no new-activity
// counter or prepend anchor; those are net-new here (#91 AC3). The window scrolls
// display lines, because a row wraps to as many lines as its width needs (#288),
// but the anchor is held as a row and a line offset inside it: the timeline is
// append-only (durable rows land at the end as each publication commits), so a
// held row keeps naming the same row as newer ones arrive, and it survives a
// resize that rewraps every row. The new-activity count is in rows too, since it
// counts activities, not lines.

/** A display line named by its row and its line offset inside that row. */
interface TimelineAnchor {
  readonly row: number;
  readonly offset: number;
}

/** `live` sticks to the newest rows (the live edge); `paused` pins the first
 *  visible display line to an anchor while the user reads older activity. */
export type TimelineScroll =
  { readonly mode: "live" } | ({ readonly mode: "paused" } & TimelineAnchor);

export const AT_LIVE: TimelineScroll = { mode: "live" };

/** Paused on the first line of the oldest row. */
export const AT_TOP: TimelineScroll = { mode: "paused", row: 0, offset: 0 };

/** `row` and `offset` anchor the first visible line. */
export interface TimelineWindow extends TimelineAnchor {
  /** Index of the first visible display line. */
  readonly top: number;
  /** Count of visible display lines (at most the viewport height). */
  readonly visible: number;
  /** Rows with any line below the viewport bottom — the newest activity not yet
   *  fully scrolled to; 0 while following the live edge. */
  readonly newActivity: number;
  readonly atLive: boolean;
}

export type TimelineAction =
  "up" | "down" | "pageUp" | "pageDown" | "top" | "latest";

/** Key name → scroll action, shared by the timeline and the inspection overlay
 *  (both window over this same reducer): arrows step one line, the page keys jump
 *  half the viewport, `home`/`g` reach the top, `end` jumps to the live edge. */
export const SCROLL_KEYS: Record<string, TimelineAction> = {
  up: "up",
  down: "down",
  pageup: "pageUp",
  pagedown: "pageDown",
  home: "top",
  end: "latest",
  g: "top",
};

/** The visible window for a scroll state over rows of the given display-line
 *  `heights` in a `viewport`-tall area. `live` shows the newest `viewport` lines;
 *  `paused` shows `viewport` lines from its pinned row, clamped so it never
 *  scrolls past the ends. */
export function timelineWindow(
  scroll: TimelineScroll,
  heights: readonly number[],
  viewport: number,
): TimelineWindow {
  const layout = lineLayout(heights, viewport);
  const top = currentTop(scroll, layout);
  const bottom = Math.min(layout.total, top + layout.height);
  const anchor = rowAt(top, layout);
  return {
    top,
    visible: bottom - top,
    newActivity: scroll.mode === "live" ? 0 : rowsBelow(bottom, layout),
    atLive: scroll.mode === "live",
    row: anchor.row,
    offset: anchor.offset,
  };
}

/** Apply one scroll action. A line step moves one display line and a page half
 *  the viewport (OpenCode's page), so consecutive pages overlap and no line is
 *  skipped. Reaching the bottom re-attaches to the live edge so later rows follow
 *  again; `latest` jumps straight there. */
export function scrollTimeline(
  scroll: TimelineScroll,
  action: TimelineAction,
  heights: readonly number[],
  viewport: number,
): TimelineScroll {
  const layout = lineLayout(heights, viewport);
  const top = currentTop(scroll, layout);
  const page = Math.max(1, Math.floor(layout.height / 2));
  switch (action) {
    case "latest":
      return AT_LIVE;
    case "top":
      return layout.maxTop === 0 ? AT_LIVE : pauseAt(0, layout);
    case "up":
      return pauseAt(top - 1, layout);
    case "down":
      return pauseAt(top + 1, layout);
    case "pageUp":
      return pauseAt(top - page, layout);
    case "pageDown":
      return pauseAt(top + page, layout);
  }
}

interface LineLayout {
  readonly heights: readonly number[];
  /** The first display line of each row. */
  readonly starts: readonly number[];
  readonly total: number;
  readonly height: number;
  readonly maxTop: number;
}

function lineLayout(heights: readonly number[], viewport: number): LineLayout {
  const starts: number[] = [];
  let total = 0;
  for (const rowHeight of heights) {
    starts.push(total);
    total += rowHeight;
  }
  const height = Math.max(1, viewport);
  return {
    heights,
    starts,
    total,
    height,
    maxTop: Math.max(0, total - height),
  };
}

/** The first visible line: the live edge's, or the pinned anchor's. */
function currentTop(scroll: TimelineScroll, layout: LineLayout): number {
  return scroll.mode === "live" ? layout.maxTop : pinnedTop(scroll, layout);
}

function pinnedTop(scroll: TimelineAnchor, layout: LineLayout): number {
  const last = layout.heights.length - 1;
  if (last < 0) return 0;
  const row = clamp(scroll.row, 0, last);
  // A row that shrank under a rewrap keeps the anchor on its last line.
  const offset = clamp(scroll.offset, 0, Math.max(0, layout.heights[row]! - 1));
  return clamp(layout.starts[row]! + offset, 0, layout.maxTop);
}

function rowAt(line: number, layout: LineLayout): TimelineAnchor {
  let row = 0;
  while (row + 1 < layout.starts.length && layout.starts[row + 1]! <= line) {
    row += 1;
  }
  return { row, offset: line - (layout.starts[row] ?? 0) };
}

function rowsBelow(bottom: number, layout: LineLayout): number {
  let count = 0;
  for (let row = layout.heights.length - 1; row >= 0; row -= 1) {
    if (layout.starts[row]! + layout.heights[row]! <= bottom) break;
    count += 1;
  }
  return count;
}

function pauseAt(line: number, layout: LineLayout): TimelineScroll {
  const clamped = clamp(line, 0, layout.maxTop);
  // At (or past) the bottom, re-follow the live edge; otherwise pin the row.
  if (clamped >= layout.maxTop) return AT_LIVE;
  return { mode: "paused", ...rowAt(clamped, layout) };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
