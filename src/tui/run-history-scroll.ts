import { timelineWindow, type TimelineAction } from "./run-timeline.js";

export type HistoryScroll =
  | { readonly mode: "live" }
  | {
      readonly mode: "paused";
      readonly id?: string;
      readonly offset: number;
      readonly prior: readonly string[];
    };
interface Rows {
  readonly keys: readonly string[];
  readonly heights: readonly number[];
}

/** The anchor always names a content row. Ordinals are temporary layout coordinates. */
function anchor(
  scroll: Extract<HistoryScroll, { mode: "paused" }>,
  rows: Rows,
): { row: number; offset: number } {
  const retained = scroll.id === undefined ? -1 : rows.keys.indexOf(scroll.id);
  if (retained >= 0)
    return {
      row: retained,
      offset: Math.min(
        scroll.offset,
        Math.max(0, (rows.heights[retained] ?? 1) - 1),
      ),
    };
  const previous =
    scroll.id === undefined ? -1 : scroll.prior.indexOf(scroll.id);
  let distance = Infinity;
  let chosen = 0;
  if (previous >= 0)
    for (const [index, key] of scroll.prior.entries()) {
      const current = rows.keys.indexOf(key);
      const next = Math.abs(index - previous);
      if (current >= 0 && next <= distance) {
        distance = next;
        chosen = current;
      }
    }
  return { row: chosen, offset: 0 };
}
export function historyWindow(
  scroll: HistoryScroll,
  rows: Rows,
  viewport: number,
): ReturnType<typeof timelineWindow> {
  if (scroll.mode === "live")
    return timelineWindow(scroll, rows.heights, viewport);
  const pinned = anchor(scroll, rows);
  const top =
    rows.heights.slice(0, pinned.row).reduce((sum, height) => sum + height, 0) +
    pinned.offset;
  const total = rows.heights.reduce((sum, height) => sum + height, 0);
  const height = Math.max(1, viewport);
  const bottom = Math.min(total, top + height);
  let line = 0;
  let newActivity = 0;
  for (const rowHeight of rows.heights) {
    line += rowHeight;
    if (line > bottom) newActivity++;
  }
  return {
    ...pinned,
    top,
    visible: Math.max(0, bottom - top),
    atLive: false,
    newActivity,
  };
}
export function reconcileHistoryScroll(
  scroll: HistoryScroll,
  rows: Rows,
): HistoryScroll {
  if (scroll.mode === "live") return scroll;
  const pinned = anchor(scroll, rows);
  return {
    mode: "paused",
    id: rows.keys[pinned.row],
    offset: pinned.offset,
    prior: rows.keys,
  };
}
export function scrollHistory(
  scroll: HistoryScroll,
  action: TimelineAction,
  rows: Rows,
  viewport: number,
): HistoryScroll {
  if (action === "latest") return { mode: "live" };
  if (action === "top")
    return { mode: "paused", id: rows.keys[0], offset: 0, prior: rows.keys };
  // A paused short page may start below the live top, with blank space below.
  // Move from that actual displayed line; the ordinal inspection reducer clamps
  // to a full last page and would retarget it or resume following on an Up.
  const window = historyWindow(scroll, rows, viewport);
  const page = Math.max(1, Math.floor(Math.max(1, viewport) / 2));
  const delta = { up: -1, down: 1, pageUp: -page, pageDown: page }[action];
  const top = Math.max(0, window.top + delta);
  const total = rows.heights.reduce((sum, height) => sum + height, 0);
  if (delta > 0 && top >= Math.max(0, total - Math.max(1, viewport)))
    return { mode: "live" };
  let row = 0;
  let offset = top;
  while (row + 1 < rows.keys.length && offset >= (rows.heights[row] ?? 1)) {
    offset -= rows.heights[row] ?? 1;
    row++;
  }
  return {
    mode: "paused",
    id: rows.keys[row],
    offset: Math.min(offset, Math.max(0, (rows.heights[row] ?? 1) - 1)),
    prior: rows.keys,
  };
}
