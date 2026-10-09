import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AT_LIVE,
  scrollTimeline,
  timelineWindow,
  type TimelineScroll,
} from "../../src/tui/tui.js";

// The ordinal scroll model used by resource inspection (#91 AC4, #288):
// display-line paging, append and rewrap anchoring, and jumping to the latest
// content. Live Workbench history uses semantic row ids instead, covered by
// run-workbench-history-scroll.test.tsx.

/** `count` single-line rows — the pre-wrap timeline. */
function ones(count: number): number[] {
  return Array.from({ length: count }, () => 1);
}

test("live edge shows the newest viewport of lines and counts no new activity", () => {
  const w = timelineWindow(AT_LIVE, ones(20), 5);
  assert.deepEqual(w, {
    top: 15,
    visible: 5,
    newActivity: 0,
    atLive: true,
    row: 15,
    offset: 0,
  });
});

test("a short timeline (fewer lines than the viewport) is fully visible at the top", () => {
  const w = timelineWindow(AT_LIVE, ones(3), 10);
  assert.deepEqual(w, {
    top: 0,
    visible: 3,
    newActivity: 0,
    atLive: true,
    row: 0,
    offset: 0,
  });
});

test("scrolling up from the live edge pauses and counts the rows below the viewport", () => {
  const up = scrollTimeline(AT_LIVE, "up", ones(20), 5); // live top was 15 → 14
  assert.deepEqual(up, { mode: "paused", row: 14, offset: 0 });
  const w = timelineWindow(up, ones(20), 5);
  assert.equal(w.top, 14);
  assert.equal(w.visible, 5); // rows 14..18
  assert.equal(w.newActivity, 1); // row 19 sits below the viewport
  assert.equal(w.atLive, false);
});

test("the first visible row stays anchored as newer rows append, and new-activity grows", () => {
  const paused: TimelineScroll = { mode: "paused", row: 4, offset: 0 };
  const before = timelineWindow(paused, ones(20), 5);
  assert.equal(before.top, 4);
  assert.equal(before.newActivity, 20 - (4 + 5)); // 11 below
  // Three rows land at the end, one of them wrapped over three lines: the pinned
  // row still names the same first visible row, and the count rises by three rows.
  const after = timelineWindow(paused, [...ones(20), 1, 3, 1], 5);
  assert.equal(after.top, 4, "first visible row anchored under append");
  assert.equal(after.newActivity, before.newActivity + 3);
});

test("wrapped rows scroll by display line and keep the line offset inside a row", () => {
  // Rows of 1, 3, 1, 1 lines → display lines 0 | 1 2 3 | 4 | 5; maxTop is 3.
  const heights = [1, 3, 1, 1];
  const start: TimelineScroll = { mode: "paused", row: 0, offset: 0 };
  const down = scrollTimeline(start, "down", heights, 3);
  assert.deepEqual(down, { mode: "paused", row: 1, offset: 0 });
  const inside = scrollTimeline(down, "down", heights, 3);
  assert.deepEqual(inside, { mode: "paused", row: 1, offset: 1 });
  const w = timelineWindow(inside, heights, 3);
  assert.equal(w.top, 2);
  assert.equal(w.visible, 3); // lines 2, 3, 4
  assert.deepEqual([w.row, w.offset], [1, 1]);
  // Row 1's last line is visible, so only row 3 is below: rows, not lines, count.
  assert.equal(w.newActivity, 1);
});

test("a row cut by the viewport bottom counts as new activity until it is fully shown", () => {
  // Rows of 1 and 4 lines in a 3-line viewport paused at the top: row 1 shows two
  // of its four lines, so one row still has content below.
  const w = timelineWindow({ mode: "paused", row: 0, offset: 0 }, [1, 4], 3);
  assert.equal(w.newActivity, 1);
});

test("a rewrap keeps the same first visible row", () => {
  // Paused on row 2 with every row two lines tall puts it at line 4. A resize
  // rewraps every row to one line; the anchor still names row 2, now at line 2.
  const paused: TimelineScroll = { mode: "paused", row: 2, offset: 0 };
  assert.equal(timelineWindow(paused, [2, 2, 2, 2, 2, 2], 3).top, 4);
  const rewrapped = timelineWindow(paused, ones(6), 3);
  assert.equal(rewrapped.top, 2);
  assert.equal(rewrapped.row, 2);
  // An offset past a row that shrank clamps to the row's last line.
  const shrunk = timelineWindow(
    { mode: "paused", row: 1, offset: 2 },
    [1, 2, 1, 1, 1],
    2,
  );
  assert.deepEqual([shrunk.top, shrunk.row, shrunk.offset], [2, 1, 1]);
});

test("an anchor past the last row clamps into the timeline", () => {
  const w = timelineWindow({ mode: "paused", row: 40, offset: 0 }, ones(10), 4);
  assert.equal(w.top, 6);
  assert.equal(w.newActivity, 0);
});

test("jump-to-latest returns to the live edge and clears the new-activity count", () => {
  const paused: TimelineScroll = { mode: "paused", row: 2, offset: 0 };
  const latest = scrollTimeline(paused, "latest", ones(40), 6);
  assert.deepEqual(latest, AT_LIVE);
  assert.equal(timelineWindow(latest, ones(40), 6).newActivity, 0);
});

test("scrolling down to the bottom re-attaches to the live edge so rows follow again", () => {
  // One line above the bottom, a down lands on the last page → re-follow.
  const nearBottom: TimelineScroll = { mode: "paused", row: 14, offset: 0 }; // maxTop for 20/5 is 15
  assert.deepEqual(scrollTimeline(nearBottom, "down", ones(20), 5), AT_LIVE);
});

test("a page moves half the viewport, so consecutive pages overlap, and clamps at the top", () => {
  const start = scrollTimeline(AT_LIVE, "up", ones(100), 10); // paused top 89
  const up = scrollTimeline(start, "pageUp", ones(100), 10);
  assert.deepEqual(up, { mode: "paused", row: 84, offset: 0 });
  const down = scrollTimeline(up, "pageDown", ones(100), 10);
  assert.deepEqual(down, { mode: "paused", row: 89, offset: 0 });
  // An odd viewport rounds down; a one-line viewport still moves one line.
  const at20: TimelineScroll = { mode: "paused", row: 20, offset: 0 };
  assert.deepEqual(scrollTimeline(at20, "pageUp", ones(100), 7), {
    mode: "paused",
    row: 17,
    offset: 0,
  });
  assert.deepEqual(scrollTimeline(at20, "pageUp", ones(100), 1), {
    mode: "paused",
    row: 19,
    offset: 0,
  });
  const near: TimelineScroll = { mode: "paused", row: 4, offset: 0 };
  assert.deepEqual(
    scrollTimeline(near, "pageUp", ones(100), 10),
    { mode: "paused", row: 0, offset: 0 },
    "clamps at the first row",
  );
});

test("top jumps to the oldest row; on a short timeline it stays at the live edge", () => {
  assert.deepEqual(scrollTimeline(AT_LIVE, "top", ones(50), 10), {
    mode: "paused",
    row: 0,
    offset: 0,
  });
  assert.deepEqual(scrollTimeline(AT_LIVE, "top", ones(4), 10), AT_LIVE);
});

test("an empty timeline stays at the live edge with nothing visible", () => {
  const w = timelineWindow(AT_LIVE, [], 8);
  assert.deepEqual(w, {
    top: 0,
    visible: 0,
    newActivity: 0,
    atLive: true,
    row: 0,
    offset: 0,
  });
  assert.deepEqual(scrollTimeline(AT_LIVE, "up", [], 8), AT_LIVE);
});
