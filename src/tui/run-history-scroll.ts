import {
  contentAnchorAt,
  resolveContentAnchor,
  type ContentAnchor,
  type ContentRow,
} from "./run-content-anchor.js";
import { timelineWindow, type TimelineAction } from "./run-timeline.js";

export type HistoryScroll =
  { readonly mode: "live" } | ({ readonly mode: "paused" } & ContentAnchor);

export function historyWindow(
  scroll: HistoryScroll,
  rows: readonly ContentRow[],
  viewport: number,
): ReturnType<typeof timelineWindow> {
  if (scroll.mode === "live")
    return timelineWindow(
      scroll,
      rows.map((row) => row.height),
      viewport,
    );
  const pinned = resolveContentAnchor(scroll, rows);
  const top = pinned.top;
  const total = rows.reduce((sum, row) => sum + row.height, 0);
  const height = Math.max(1, viewport);
  const bottom = Math.min(total, top + height);
  let line = 0;
  let newActivity = 0;
  for (const row of rows) {
    line += row.height;
    if (line > bottom) newActivity++;
  }
  return {
    row: pinned.row,
    offset: pinned.anchor.offset,
    top,
    visible: Math.max(0, bottom - top),
    atLive: false,
    newActivity,
  };
}
export function reconcileHistoryScroll(
  scroll: HistoryScroll,
  rows: readonly ContentRow[],
): HistoryScroll {
  if (scroll.mode === "live") return scroll;
  return { mode: "paused", ...resolveContentAnchor(scroll, rows).anchor };
}
export function scrollHistory(
  scroll: HistoryScroll,
  action: TimelineAction,
  rows: readonly ContentRow[],
  viewport: number,
): HistoryScroll {
  if (action === "latest") return { mode: "live" };
  if (action === "top") return { mode: "paused", ...contentAnchorAt(0, rows) };
  // A paused short page may start below the live top, with blank space below.
  // Move from that actual displayed line; the ordinal inspection reducer clamps
  // to a full last page and would retarget it or resume following on an Up.
  const window = historyWindow(scroll, rows, viewport);
  const page = Math.max(1, Math.floor(Math.max(1, viewport) / 2));
  const delta = { up: -1, down: 1, pageUp: -page, pageDown: page }[action];
  const top = Math.max(0, window.top + delta);
  const total = rows.reduce((sum, row) => sum + row.height, 0);
  if (delta > 0 && top >= Math.max(0, total - Math.max(1, viewport)))
    return { mode: "live" };
  return { mode: "paused", ...contentAnchorAt(top, rows) };
}
