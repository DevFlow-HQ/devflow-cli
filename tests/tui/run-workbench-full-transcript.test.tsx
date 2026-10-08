import { PALETTES } from "./palette-expectations.js";
import type { PreferencesView } from "../../src/tui/tui.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "./renderer-fixture.js";
import {
  resizeWorkbench,
  runOf,
  mountWorkbench,
  press,
  type,
  noOverflow,
  dividers,
  transcriptRun,
  txEntries,
  interactiveRunOf,
  previewPreferences,
  hexRgb,
  openTranscriptDetails,
} from "./run-workbench-fixture.js";

test("[step-session-dividers] the transcript marks its conversation and each Step once the start is loaded, with plain headers and title (#289)", async () => {
  const run = runOf({
    sessions: [
      {
        session: "spec",
        name: "spec",
        availability: "open",
        transcriptPage: {
          runId: "run-1",
          session: "spec",
          type: "transcript-page",
        },
      },
      {
        session: "fresh-0.1:implement",
        name: "fresh, iteration 1",
        availability: "open",
        transcriptPage: {
          runId: "run-1",
          session: "fresh-0.1:implement",
          type: "transcript-page",
        },
      },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  const entry = (
    role: "user" | "assistant",
    content: string,
    step: string,
  ) => ({ id: `${role}:${content}`, session: "spec", role, content, step });
  // The newest page holds write-spec; the older page reaches the Session's start.
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [
      entry("user", "Write the spec", "write-spec"),
      entry("assistant", "Spec written", "write-spec"),
    ],
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: [
      entry("user", "Grill me", "grill"),
      entry("assistant", "First question", "grill"),
    ],
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  const newest = t.captureCharFrame();
  noOverflow(newest, 100);
  // The title names the conversation in plain words, never its recorded name.
  assert.match(newest, /Session transcript · spec/);
  // Older entries remain, so where the conversation and its Step began is unknown:
  // no divider is drawn yet.
  assert.deepEqual(dividers(newest.split("\n")), []);

  await press(t, renderer, "p"); // loads without retargeting the anchor
  await press(t, renderer, "home"); // explicitly navigate to the Session's start
  const full = t.captureCharFrame();
  noOverflow(full, 100);
  const lines = full.split("\n");
  assert.deepEqual(dividers(lines), [
    "═ Conversation · spec",
    "─ Step · grill",
    "─ Step · write-spec",
  ]);
  const writeSpec = lines.findIndex((line) => /Step · write-spec/.test(line));
  assert.match(lines[writeSpec + 1]!, /◇ User Turn\s*$/);
  assert.match(lines[writeSpec + 2]!, /Write the spec/);
  assert.doesNotMatch(full, /session|fresh-0/);
  assert.doesNotMatch(full, /\b(?:open|detached|unusable)\b/);
});

test("[step-session-dividers] paging older across a Step boundary keeps the first visible transcript entry under its new divider (#289)", async () => {
  // Height 10 → a 6-line viewport, so the anchor, not the whole page, holds N1.
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    40,
    10,
  );
  const entries = (step: string, ...ids: string[]) =>
    ids.map((id) => ({
      id,
      session: "s",
      role: "user" as const,
      content: `${id} text`,
      step,
    }));
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: entries("write-spec", "N1", "N2", "N3"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: entries("grill", "O1", "O2", "O3"),
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /Session transcript · s/);
  assert.match(t.captureCharFrame(), /N1 text/);

  // Up at the top prepends the older page: N1's header row gains its Step divider,
  // and one line up shows that divider with N1 still in view, no older entry yet.
  await press(t, renderer, "up");
  const anchored = t.captureCharFrame();
  noOverflow(anchored, 40);
  assert.match(anchored, /N1 text/);
  assert.equal(anchored.split("\n")[2]!.trimEnd(), " ◇ User Turn");
  await press(t, renderer, "up"); // divider attached above the retained header
  assert.match(t.captureCharFrame(), /─ Step · write-spec ─/);
  assert.doesNotMatch(anchored, /O\d text/);

  // Above it, the older Step and the conversation's start.
  await press(t, renderer, "home");
  assert.deepEqual(dividers(t.captureCharFrame().split("\n")).slice(0, 2), [
    "═ Conversation · s",
    "─ Step · grill",
  ]);
});

test("m10-audit-workbench-test-domains: the Session transcript opens the newest page and restores focused details (#124, #421)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [
      {
        id: "user-1",
        session: "s",
        role: "user",
        content: "Fix the failing test",
      },
      {
        id: "assistant-1",
        session: "s",
        role: "assistant",
        content: "Working on it",
      },
    ],
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  const opened = t.captureCharFrame();
  assert.match(opened, /Session transcript/);
  // The role headers name no Session (#289): the overlay holds one conversation,
  // which its Session divider names.
  assert.match(opened, /◇ User Turn\s*$/m);
  assert.match(opened, /Fix the failing test/);
  assert.match(opened, /◆ Assistant\s*$/m);
  assert.match(opened, /Working on it/);
  assert.doesNotMatch(opened, /session/);

  await press(t, renderer, "escape");
  assert.match(t.captureCharFrame(), /› Details/);
});

test("paging older upward preserves the first visible entry (#124)", async () => {
  // Height 10 → interior 8 → 6-line viewport, smaller than a 12-line page.
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    10,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "N1", "N2", "N3", "N4"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "O1", "O2", "O3", "O4"),
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  // Opens on the newest entries (the live edge, the bottom); older not loaded.
  let f = t.captureCharFrame();
  assert.match(f, /N4/);
  assert.doesNotMatch(f, /O1|O2|O3|O4/);

  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /N1/);

  // Up at the top loads the older page and keeps N1 on screen (anchor preserved):
  // if the view had jumped to the live edge instead, N4 would show and N1 would not.
  await press(t, renderer, "up");
  f = t.captureCharFrame();
  assert.match(f, /N1/);
  assert.doesNotMatch(f, /N4/);

  // Paging further up reaches the just-loaded older entries: each page is half
  // the 6-line viewport, so the 12 prepended lines take a few presses.
  for (let i = 0; i < 7; i++) await press(t, renderer, "pageup");
  assert.match(t.captureCharFrame(), /O1/);
});

test("workbench-timeline-inspection: a failed older-page read is visible and keeps its retry cursor", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    10,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "N1", "N2", "N3", "N4"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: false,
    problem: {
      code: "transcript-page-stale",
      explanation: "The older transcript page could not be read.",
      remediation: "Scroll up to retry.",
      possibleEffects: "none",
    },
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  await press(t, renderer, "home");
  await press(t, renderer, "up");
  const failed = t.captureCharFrame();
  assert.match(failed, /Notice \[transcript-page-stale\]/);
  assert.match(failed, /Scroll up to retry/);

  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "O1", "O2"),
  });
  await press(t, renderer, "up");
  // The retried older page loads beneath the cleared Notice, keeping N1 in view.
  assert.match(t.captureCharFrame(), /N1/);
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /O1/);
  assert.doesNotMatch(t.captureCharFrame(), /transcript-page-stale/);
});

test("a large transcript entry scrolls without truncation (#124)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  const big = Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n");
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [{ id: "big", session: "s", role: "assistant", content: big }],
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  // Opens at the bottom, so the newest lines show; nothing is truncated away.
  assert.match(t.captureCharFrame(), /line-599/);
  assert.doesNotMatch(t.captureCharFrame(), /truncated/);
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /line-0\b/);
});

test("the transcript inspection wraps long lines at the view width and rewraps on resize (#124, #288)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  const long = "a very long single line that exceeds forty columns easily";
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [{ id: "long", session: "s", role: "user", content: long }],
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), new RegExp(long));

  // Narrow the terminal: the line wraps at a word boundary and nothing is cut.
  resizeWorkbench(t, renderer, 40, 24);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  noOverflow(narrow, 40);
  assert.match(narrow, /^ a very long single line that exceeds\s*$/m);
  assert.match(narrow, /^ forty columns easily\s*$/m);

  // Widen it again: it rewraps back onto one line.
  resizeWorkbench(t, renderer, 80, 24);
  await t.renderOnce();
  const wide = t.captureCharFrame();
  noOverflow(wide, 80);
  assert.match(wide, new RegExp(long));
});

test("paging older over wrapped transcript entries preserves the first visible entry (#124, #288)", async () => {
  // Height 10 → a 6-line viewport; at width 40 each entry wraps over three lines,
  // so a page holds more display lines than logical ones.
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    40,
    10,
  );
  const words = "lorem ipsum dolor sit amet ".repeat(3).trim();
  const entries = (...ids: string[]) =>
    txEntries("user", ...ids.map((id) => `${id} ${words}`));
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: entries("N1", "N2", "N3", "N4"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: entries("O1", "O2", "O3", "O4"),
  });

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /N1 lorem/);

  // Up at the top prepends the older page and moves one line up: N1 stays in view,
  // and none of the prepended entries' text above the separator shows.
  await press(t, renderer, "up");
  const anchored = t.captureCharFrame();
  noOverflow(anchored, 40);
  assert.match(anchored, /N1 lorem/);
  assert.doesNotMatch(anchored, /O\d/);

  await press(t, renderer, "pageup");
  await press(t, renderer, "pageup");
  assert.match(t.captureCharFrame(), /O4 lorem/);
});

test("a paused transcript keeps its first visible line across a resize that rewraps it (#288)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    12,
  );
  const words = "lorem ipsum dolor sit amet ".repeat(3).trim();
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries(
      "user",
      ...["A", "B", "C", "D", "E", "F", "G", "H"].map(
        (id) => `${id}1 ${words}`,
      ),
    ),
  });
  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  // Line by line from the top until C1's entry leads the view, well above the
  // live edge so the paused anchor is what holds it.
  await press(t, renderer, "home");
  const firstContent = () => t.captureCharFrame().split("\n")[2]!; // under the padding and title rows
  for (let i = 0; i < 12 && !/C1 lorem/.test(firstContent()); i++) {
    await press(t, renderer, "down");
  }
  assert.match(firstContent(), /^ C1 lorem/);

  // Narrowing rewraps every entry over more lines; C1 still leads the view.
  resizeWorkbench(t, renderer, 40, 12);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 40);
  assert.match(firstContent(), /^ C1 lorem/);
  resizeWorkbench(t, renderer, 100, 12);
  await t.renderOnce();
  assert.match(firstContent(), /^ C1 lorem/);
});

for (const width of [40, 100]) {
  for (const boundary of [false, true]) {
    test(`m10-full-transcript-prepend: retained entry and nonzero wrapped offset survive ${boundary ? "Step-boundary" : "ordinary"} prepend, failure/retry and resize at ${width}`, async () => {
      const wb = await mountWorkbench(transcriptRun(), width, 12);
      const { t, renderer, control } = wb;
      const entries = Array.from({ length: 20 }, (_, index) => ({
        id: `retained-${index}`,
        session: "s",
        role: "assistant" as const,
        content: `ENTRY_${index} ` + `ANCHOR_${index} `.repeat(24),
        step: "write-spec",
      }));
      control.setTranscript("", {
        found: true,
        type: "transcript-page",
        entries,
        older: "c1",
      });
      await openTranscriptDetails(wb);
      await press(t, renderer, "home");
      await press(t, renderer, "down");
      await press(t, renderer, "down");
      const first = () => t.captureCharFrame().split("\n")[2]!.trimEnd();
      const anchored = first();
      assert.equal(
        anchored,
        width === 40
          ? " ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0"
          : " ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0",
      );
      // Loaded page is a snapshot. A later append must not replace it or its opaque cursor.
      control.setTranscript("", {
        found: true,
        type: "transcript-page",
        entries: [
          ...entries.slice(1),
          { id: "later", session: "s", role: "user", content: "LATER_APPEND" },
        ],
        older: "changed",
      });
      control.setTranscript("c1", {
        found: false,
        problem: {
          code: "read-failed",
          explanation: "Older read failed.",
          remediation: "Press p to retry.",
          possibleEffects: "none",
        },
      });
      const before = control.transcriptReads.length;
      await press(t, renderer, "p");
      assert.equal(first(), anchored);
      assert.match(t.captureCharFrame(), /read-failed/);
      assert.equal(control.transcriptReads.length, before + 1);
      assert.equal(control.transcriptReads.at(-1)?.type, "transcript-page");
      assert.deepEqual(control.transcriptReads.at(-1), {
        ...transcriptRun().sessions![0]!.transcriptPage,
        older: "c1",
      });
      control.setTranscript("c1", {
        found: true,
        type: "transcript-page",
        entries: [
          {
            id: "older-entry",
            session: "s",
            role: "user",
            content: "PREPENDED " + "old ".repeat(30),
            step: boundary ? "grill" : "write-spec",
          },
        ],
      });
      await press(t, renderer, "p");
      assert.equal(first(), anchored);
      assert.doesNotMatch(t.captureCharFrame(), /read-failed|LATER_APPEND/);
      // Entry/offset is worded independently of colour and opaque ids stay private.
      assert.match(t.captureCharFrame(), /Entry 2 · line 3/);
      resizeWorkbench(t, renderer, width === 40 ? 100 : 40, 12);
      await t.renderOnce();
      assert.equal(
        first(),
        width === 40
          ? " ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0"
          : " ANCHOR_0 ANCHOR_0 ANCHOR_0 ANCHOR_0",
      );
      assert.match(t.captureCharFrame(), /Entry 2 · line 3/);
      noOverflow(t.captureCharFrame(), width === 40 ? 100 : 40);
      await press(t, renderer, "up");
      assert.match(first(), /^ ENTRY_0 /); // same entry, previous displayed line
      await press(t, renderer, "escape");
      await press(t, renderer, "return"); // same selected details resource
      assert.match(t.captureCharFrame(), /Session transcript/);
    });
  }
}

test("m10-full-transcript-prepend: resize clamps only the offset of a surviving retained entry on a short page", async () => {
  const wb = await mountWorkbench(transcriptRun(), 40, 8);
  const { t, renderer, control } = wb;
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [
      {
        id: "retained",
        session: "s",
        role: "assistant",
        content: "ENTRY " + "ANCHOR ".repeat(24),
      },
    ],
    older: "c1",
  });
  await openTranscriptDetails(wb);
  await press(t, renderer, "home");
  for (let i = 0; i < 4; i++) await press(t, renderer, "down");
  assert.match(t.captureCharFrame(), /Entry 1 · line 5/);
  resizeWorkbench(t, renderer, 100, 30);
  await t.renderOnce();
  // Wide content is header + two content lines + separator; clamp to that separator.
  assert.equal(t.captureCharFrame().split("\n")[2]!.trim(), "");
  assert.match(t.captureCharFrame(), /Entry 1 · line 4/);
  assert.doesNotMatch(t.captureCharFrame(), /· latest/);
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: [{ id: "older", session: "s", role: "user", content: "OLDER" }],
  });
  await press(t, renderer, "p");
  assert.match(t.captureCharFrame(), /Entry 2 · line 4/);
  assert.doesNotMatch(t.captureCharFrame(), /OLDER|· latest/);
  resizeWorkbench(t, renderer, 40, 10);
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Entry 2 · line 4/); // discarded offset stays discarded
  assert.equal(
    t.captureCharFrame().split("\n")[2]!.trimEnd(),
    " ANCHOR ANCHOR ANCHOR ANCHOR ANCHOR",
  );
});

test("m10-full-transcript-prepend: initial read failure can retry and an empty conversation remains readable", async () => {
  const wb = await mountWorkbench(transcriptRun(), 100, 12);
  await openTranscriptDetails(wb);
  assert.match(wb.t.captureCharFrame(), /transcript-gone/);
  wb.control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [],
  });
  await press(wb.t, wb.renderer, "p");
  assert.match(wb.t.captureCharFrame(), /Empty conversation/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /transcript-gone/);
  await press(wb.t, wb.renderer, "home");
  await press(wb.t, wb.renderer, "down");
  assert.match(wb.t.captureCharFrame(), /Empty conversation/);
});

test("m10-full-transcript-prepend: export reads the complete Resource only on demand and preserves paging and position", async () => {
  const wb = await mountWorkbench(transcriptRun(), 100, 12);
  const { t, renderer, control } = wb;
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("assistant", "NEWEST"),
    older: "c1",
  });
  await openTranscriptDetails(wb);
  const before = t.captureCharFrame().split("\n").slice(2, 6);
  const copied: string[] = [];
  const original = t.renderer.copyToClipboardOSC52;
  t.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  try {
    await press(t, renderer, "e"); // read failure, same content and cursor
    assert.match(t.captureCharFrame(), /Export \[transcript-gone\]/);
    assert.deepEqual(t.captureCharFrame().split("\n").slice(2, 6), before);
    assert.deepEqual(copied, []);
    control.setTranscript("export", {
      found: true,
      type: "transcript-export",
      entries: [
        ...txEntries("user", "OLDER"),
        {
          id: "export-only",
          session: "s",
          role: "assistant",
          content: "NEWEST",
          incomplete: true,
        },
      ],
    });
    await press(t, renderer, "e");
    assert.deepEqual(copied, [
      "User\nOLDER\n\nAssistant · incomplete\nNEWEST\n",
    ]);
    assert.match(
      t.captureCharFrame(),
      /Export sent to terminal clipboard · 2 entries/,
    );
    assert.deepEqual(t.captureCharFrame().split("\n").slice(2, 6), before);
    t.renderer.copyToClipboardOSC52 = () => false;
    await press(t, renderer, "e");
    assert.match(t.captureCharFrame(), /Export unavailable/);
    assert.deepEqual(
      control.transcriptReads.map((ref) => ref.type),
      [
        "transcript-page",
        "transcript-export",
        "transcript-export",
        "transcript-export",
      ],
    );
    control.setTranscript("c1", {
      found: true,
      type: "transcript-page",
      entries: txEntries("user", "OLDER"),
    });
    await press(t, renderer, "p");
    assert.deepEqual(control.transcriptReads.at(-1), {
      ...transcriptRun().sessions![0]!.transcriptPage,
      older: "c1",
    });
    assert.deepEqual(t.captureCharFrame().split("\n").slice(2, 6), before);
  } finally {
    t.renderer.copyToClipboardOSC52 = original;
  }
});

for (const size of [
  { width: 40, height: 10 },
  { width: 100, height: 40 },
]) {
  test(`m10-workbench-interaction: details and the transcript own keys and focus at ${size.width}x${size.height}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf(),
      size.width,
      size.height,
    );
    wb.control.setRun({
      ...interactiveRunOf(),
      sessions: transcriptRun().sessions,
    });
    wb.control.setTranscript("", {
      found: true,
      type: "transcript-page",
      entries: txEntries("user", "RETAINED"),
    });
    await type(wb.t, "keep draft");
    await press(wb.t, wb.renderer, "t"); // retired shortcut cannot read older history
    assert.deepEqual(wb.control.transcriptReads, []);
    await openTranscriptDetails(wb);
    assert.match(wb.t.captureCharFrame(), /RETAINED/);
    for (const key of ["r", "c", "x", "y", "s", "m", "return", "g"])
      await press(wb.t, wb.renderer, key);
    assert.deepEqual(wb.control.sends, []);
    assert.deepEqual(wb.control.steers, []);
    assert.deepEqual(wb.control.ends, []);
    await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "return"); // returns to selected details resource, not prompt
    assert.match(wb.t.captureCharFrame(), /RETAINED/);
    await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "tab");
    await press(wb.t, wb.renderer, "tab");
    await type(wb.t, "!");
    assert.match(wb.t.captureCharFrame(), /keep draft/);
  });
}

for (const appearance of ["dark", "light"] as const) {
  test(`m10-workbench-interaction: ${appearance} transcript uses theme roles and palette Quit preserves position with unknown ownership`, async () => {
    const base = previewPreferences();
    const preferences: PreferencesView = {
      ...base,
      snapshot: () => ({
        ...base.snapshot(),
        preferences: { theme: "everforest", appearance },
      }),
    };
    const wb = await mountWorkbench(
      transcriptRun(),
      100,
      16,
      undefined,
      true,
      "unavailable",
      preferences,
    );
    wb.control.setTranscript("", {
      found: true,
      type: "transcript-page",
      entries: txEntries("assistant", "READING " + "word ".repeat(120)),
    });
    await openTranscriptDetails(wb);
    await press(wb.t, wb.renderer, "home");
    await press(wb.t, wb.renderer, "down");
    const before = wb.t.captureCharFrame();
    const span = wb.t
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("READING"));
    assert.ok(span);
    assert.deepEqual(
      [span.fg.r, span.fg.g, span.fg.b].map((v) => Math.round(v * 255)),
      hexRgb(PALETTES.find((p) => p.name === "everforest")![appearance]),
    );
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    await type(wb.t, "Quit");
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
    await wb.t.waitForFrame((frame) =>
      frame.includes("Halt live Runs and quit?"),
    );
    assert.match(wb.t.captureCharFrame(), /could not read/);
    wb.t.mockInput.pressEscape();
    await until(
      () => !wb.t.captureCharFrame().includes("Halt live Runs and quit?"),
    );
    assert.equal(wb.t.captureCharFrame(), before);
    await press(wb.t, wb.renderer, "c", { ctrl: true });
    await wb.t.waitForFrame((frame) =>
      frame.includes("Halt live Runs and quit?"),
    );
    wb.t.mockInput.pressEnter();
    await wb.t.waitForFrame(
      (frame) => !frame.includes("Halt live Runs and quit?"),
    );
    assert.equal(wb.t.captureCharFrame(), before);
    assert.deepEqual(wb.exits, []);
    await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "return");
    assert.match(wb.t.captureCharFrame(), /Session transcript/);
  });
}

test("m10-workbench-interaction: a five-row transcript keeps content and a visible exit hint through dual resize", async () => {
  const wb = await mountWorkbench(transcriptRun(), 40, 12);
  wb.control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("assistant", "READABLE " + "small ".repeat(100)),
    older: "c1",
  });
  await openTranscriptDetails(wb);
  await press(wb.t, wb.renderer, "home");
  await press(wb.t, wb.renderer, "down");
  const first = wb.t.captureCharFrame().split("\n")[2]!.trimEnd();
  resizeWorkbench(wb.t, wb.renderer, 40, 5);
  await wb.t.renderOnce();
  assert.equal(wb.t.captureCharFrame().split("\n")[2]!.trimEnd(), first);
  assert.match(wb.t.captureCharFrame(), /esc · q quit/);
  noOverflow(wb.t.captureCharFrame(), 40);
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /Session transcript/);
});

for (const appearance of ["dark", "light"] as const) {
  for (const width of [40, 100, 120, 121]) {
    test(`m10-audit-anchor-content-offset: ${appearance} retained transcript keeps wrapped content when a prepend attaches its Step divider at ${width}`, async () => {
      const base = previewPreferences();
      const wb = await mountWorkbench(
        transcriptRun(),
        width,
        14,
        undefined,
        true,
        undefined,
        {
          ...base,
          snapshot: () => ({
            ...base.snapshot(),
            preferences: { theme: "everforest", appearance },
          }),
        },
      );
      const columns = width - 2;
      const heldLine = "TRANSCRIPT_ANCHOR".padEnd(columns - 4, "A");
      const nextLine = "TRANSCRIPT_NEXT".padEnd(columns - 4, "B");
      wb.control.setTranscript("", {
        found: true,
        type: "transcript-page",
        older: "c1",
        entries: [
          {
            id: "retained-anchor",
            session: "s",
            role: "assistant",
            step: "repair",
            content:
              `${"P".repeat(columns)} ${heldLine} ${nextLine}\n` +
              "LARGE_TRANSCRIPT\n".repeat(600),
          },
        ],
      });
      wb.control.setTranscript("c1", {
        found: true,
        type: "transcript-page",
        entries: [
          {
            id: "older",
            session: "s",
            role: "user",
            step: "grill",
            content: "OLDER",
          },
        ],
      });
      await openTranscriptDetails(wb);
      await press(wb.t, wb.renderer, "home");
      await press(wb.t, wb.renderer, "down");
      await press(wb.t, wb.renderer, "down");
      const first = () => wb.t.captureCharFrame().split("\n")[2]!.trim();
      assert.equal(first(), heldLine);
      await press(wb.t, wb.renderer, "p");
      assert.equal(first(), heldLine);
      assert.match(wb.t.captureCharFrame(), /Entry 2 · line 3/);
      assert.doesNotMatch(
        wb.t.captureCharFrame(),
        /OLDER|Step ·|Conversation ·/,
      );
      const span = wb.t
        .captureSpans()
        .lines[2]!.spans.find((span) =>
          span.text.includes("TRANSCRIPT_ANCHOR"),
        );
      assert.ok(span);
      assert.deepEqual(
        [span.fg.r, span.fg.g, span.fg.b].map((v) => Math.round(v * 255)),
        hexRgb(PALETTES.find((p) => p.name === "everforest")![appearance]),
      );
      await press(wb.t, wb.renderer, "down");
      assert.equal(first(), nextLine);
      await press(wb.t, wb.renderer, "up");
      resizeWorkbench(wb.t, wb.renderer, width, 18);
      await wb.t.renderOnce();
      assert.equal(first(), heldLine);
      noOverflow(wb.t.captureCharFrame(), width);
      await press(wb.t, wb.renderer, "up");
      assert.equal(first(), "P".repeat(columns));
      await press(wb.t, wb.renderer, "up");
      assert.equal(first(), "◆ Assistant"); // content-relative offset zero
      await press(wb.t, wb.renderer, "up");
      assert.match(first(), /Step · repair/); // negative offset names the attached divider
      assert.match(wb.t.captureCharFrame(), /Entry 2 · line divider/);
      await press(wb.t, wb.renderer, "down");
      assert.equal(first(), "◆ Assistant");
      await press(wb.t, wb.renderer, "home");
      assert.match(first(), /Conversation · s/);
      await press(wb.t, wb.renderer, "end");
      assert.match(wb.t.captureCharFrame(), /LARGE_TRANSCRIPT/);
      await press(wb.t, wb.renderer, "escape");
      assert.match(
        wb.t.captureCharFrame(),
        width === 40 ? /Details · Resources/ : /› Details/,
      );
      await press(wb.t, wb.renderer, "return");
      assert.match(wb.t.captureCharFrame(), /Session transcript/);
    });
  }
}
