import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignal } from "solid-js";
import type { RunActionOutcome } from "../../src/tui/tui.js";
import type {
  RunLiveOverlay,
  ResumeRunOffer,
  RunTimelineEvent,
  RunView,
  SessionHistorySnapshot,
  SessionHistoryRow,
} from "../../src/application/projection-port.js";
import {
  resizeWorkbench,
  previewPreferences,
  runOf,
  events,
  wrappingEvents,
  timelineLines,
  conversationText,
  ANSWER_OFFER,
  blockedRunOf,
  mountWorkbench,
  press,
  type,
  noOverflow,
  dividers,
  transcriptRun,
  txEntries,
  okActions,
  interactiveRunOf,
  requestOverlay,
  freeTextRunOf,
  openTranscriptDetails,
} from "./run-workbench-fixture.js";

test("workbench-view-freshness: four stream-health tokens replace scroll-live and gate Operations", async () => {
  const resumeOffer: ResumeRunOffer = {
    action: "resume-run",
    runId: "run-1",
    available: true,
    consequence: "continue from the resting Step.",
  };
  const [pendingResume] = createSignal<RunActionOutcome>({ kind: "pending" });
  const mounted = await mountWorkbench(
    runOf({
      state: "halted",
      actionOffers: [resumeOffer],
      timeline: events(2),
    }),
    100,
    40,
    okActions({ resume: () => pendingResume }),
  );
  const { t, control, renderer } = mounted;
  // A current view adds no notice; the headerless screen states only departures.
  assert.doesNotMatch(t.captureCharFrame(), /not Run state/);
  assert.doesNotMatch(t.captureCharFrame(), /\(live\)/);
  // Resume lives in focused details now (ADR 0036).
  await press(t, renderer, "g", { ctrl: true });
  renderer.key("r");
  await t.renderOnce();

  control.setFreshness({
    kind: "loading",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /View loading · not Run state/);

  control.setFreshness({
    kind: "catching-up",
    catchUp: "continuous",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /View catching up · not Run state/);

  control.setFreshness({
    kind: "disconnected",
    reason: "observer-lagged",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  const disconnected = t.captureCharFrame();
  assert.match(disconnected, /View disconnected · not Run state/);
  assert.match(disconnected, /last confirmed 2026-09-22 10:30:00Z/);
  assert.match(disconnected, /ctrl\+r reconnect/);
  assert.match(disconnected, /Operation pending · resume/);
  assert.doesNotMatch(disconnected, /r resume/);

  // A bare `r` is never a Workbench command beside the prompt; Ctrl+R reconnects.
  renderer.key("r");
  await t.renderOnce();
  assert.deepEqual(control.reconnects, []);
  renderer.key("r", { ctrl: true });
  await t.renderOnce();
  assert.deepEqual(control.reconnects, ["reconnect"]);
});

test("m10-audit-workbench-test-domains: the timeline follows the live edge as durable updates append events", async () => {
  const { t, control } = await mountWorkbench(
    runOf({ timeline: events(6) }),
    100,
    16,
  );
  const first = t.captureCharFrame();
  assert.doesNotMatch(first, /not Run state/);
  assert.match(first, / e5/); // newest visible
  control.setRun(runOf({ timeline: events(9) }));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), / e8/); // followed to the newest
});

test("reopened durable Turn rows label kind by words, colour removed, legacy neutral (#126)", async () => {
  // One reopened Session with an Interactive Turn, a following Agent Turn, and a
  // legacy row whose kind is unknown — the Workbench distinguishes each by glyph
  // plus words alone, with no live overlay (a settled, reopened Run).
  const { t } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: [
        { id: "discuss", kind: "interactive-agent", status: "succeeded" },
      ],
      position: 1,
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "shared",
          turnKind: "interactive-agent",
        },
        {
          at: "T001",
          event: "turn-settled",
          detail: "completed",
          turnKind: "interactive-agent",
        },
        {
          at: "T002",
          event: "turn-started",
          detail: "shared",
          turnKind: "agent",
        },
        {
          at: "T003",
          event: "turn-settled",
          detail: "completed",
          turnKind: "agent",
        },
        // A legacy row (admitted before the kind column): no turnKind, so it reads a
        // neutral "Turn" rather than a fabricated kind.
        { at: "T004", event: "turn-started", detail: "shared" },
      ],
    }),
    110,
    24,
  );
  const frame = t.captureCharFrame();
  // The recorded Session name never labels a row (#289); dividers name it.
  assert.match(frame, /Interactive Turn started/);
  assert.match(frame, /Interactive Turn settled · completed/);
  assert.match(frame, /Agent Turn started/);
  assert.match(frame, /Agent Turn settled · completed/);
  assert.match(frame, /● Turn started/); // legacy: neither kind claimed
  assert.doesNotMatch(frame, /shared/);
});

test("durable tool activity keeps Projection order beneath the live Turn", async () => {
  const { t } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
      timeline: [
        { at: "T000", event: "turn-started", detail: "repair" },
        { at: "T001", event: "tool-activity", detail: "Bash started" },
        { at: "T002", event: "tool-activity", detail: "Edit completed" },
        { at: "T003", event: "assistant-content", detail: "Done." },
      ],
    }),
  );
  const frame = t.captureCharFrame();
  const bash = frame.indexOf("Tool activity · Bash started");
  const edit = frame.indexOf("Tool activity · Edit completed");
  const assistant = frame.indexOf("Assistant · Done.");
  assert.ok(bash >= 0 && edit > bash && assistant > edit, frame);
});

test("preview-only updates render before a full live overlay exists", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  control.setPreview("First streamed words");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Assistant · streaming/);
  assert.match(frame, /Assistant · streaming[\s\S]*First streamed words/);
});

test("live rows respect paused timeline following and contribute to the new-activity count", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  await press(t, renderer, "up", { alt: true });
  const before = t.captureCharFrame();
  const topLine = before.split("\n").find((line) => / e\d/.test(line));
  assert.ok(topLine);

  control.setPreview("new streamed content");
  await t.renderOnce();
  const paused = t.captureCharFrame();
  assert.equal(
    paused.split("\n").find((line) => / e\d/.test(line)),
    topLine,
  );
  assert.match(paused, /\d+ new activities · Jump to latest/);

  await press(t, renderer, "end", { alt: true });
  const latest = t.captureCharFrame();
  assert.match(latest, /Assistant · streaming[\s\S]*new streamed content/);
  assert.doesNotMatch(latest, /Jump to latest/);
});

test("gate, request, interactive Turn, and agent Turn have colour-independent labels", async () => {
  const gate = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: [{ id: "approve", kind: "human-gate", status: "blocked" }],
      pendingGate: {
        gate: {
          runId: "run-1",
          stepId: "approve",
          attemptId: "a1",
          shape: "approve-reject",
        },
        message: "Approve the change?",
      },
      actionOffers: [
        {
          ...ANSWER_OFFER,
          gate: {
            runId: "run-1",
            stepId: "approve",
            attemptId: "a1",
            shape: "approve-reject",
          },
          basis: "durable Human Gate",
        },
      ],
    }),
  );
  // ADR 0036 keeps a Workflow decision, Permission required, and the human's
  // Turn distinct in words; an authored approve-reject gate keeps its headless
  // answer path, so the prompt names what the Run waits on.
  assert.match(
    gate.t.captureCharFrame(),
    /◆ Workflow decision · Approve the change\?/,
  );

  const request = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  request.control.setLive({
    runId: "run-1",
    generation: 3,
    phase: "awaiting-approval",
    outstanding: [
      {
        requestId: "req-1",
        tool: "Edit",
        input: '{"path":"src/a.ts"}',
        decisions: ["allow", "deny"],
      },
    ],
    offers: [
      {
        action: "answer-harness-request",
        runId: "run-1",
        requestId: "req-1",
        generation: 1,
        decisions: ["allow", "deny"],
        basis: "ephemeral Harness Request",
      },
    ],
  });
  await request.t.renderOnce();
  assert.match(request.t.captureCharFrame(), /Tool: Edit/);
  assert.match(
    request.t.captureCharFrame(),
    /△ Permission required · awaiting your approval/,
  );

  const interactive = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: [
        { id: "discuss", kind: "interactive-agent", status: "running" },
      ],
    }),
  );
  interactive.control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await interactive.t.renderOnce();
  const interactiveFrame = interactive.t.captureCharFrame();
  assert.match(interactiveFrame, /Your move/);
  assert.doesNotMatch(
    interactiveFrame,
    /Workflow decision|Permission required/,
  );
});

test("scrolling up anchors the first visible row, counts new activity, and jump-to-latest returns to the live edge", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  await press(t, renderer, "up", { alt: true });
  await press(t, renderer, "up", { alt: true });
  const scrolled = t.captureCharFrame();
  const topLine = scrolled.split("\n").find((line) => / e\d/.test(line));
  assert.ok(topLine, "a timeline row is visible");
  assert.doesNotMatch(scrolled, /not Run state/); // freshness is independent of scrolling

  // New events append; the first visible row stays anchored and the count grows.
  control.setRun(runOf({ timeline: events(36) }));
  await t.renderOnce();
  const anchored = t.captureCharFrame();
  assert.equal(
    anchored.split("\n").find((line) => / e\d/.test(line)),
    topLine,
    "first visible row anchored under append",
  );
  assert.match(anchored, /\d+ new/); // a new-activity badge

  await press(t, renderer, "end", { alt: true }); // jump to the live edge
  const live = t.captureCharFrame();
  assert.doesNotMatch(live, /not Run state/);
  assert.match(live, / e35/); // the newest event
  assert.doesNotMatch(live, /new activit(?:y|ies) · Jump to latest/);
});

test("timeline paging is wired: home reaches the oldest event, end returns to the live edge", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  assert.doesNotMatch(t.captureCharFrame(), /not Run state/);
  await press(t, renderer, "pageup"); // detaches from the live edge
  assert.doesNotMatch(t.captureCharFrame(), /not Run state/);
  await press(t, renderer, "home", { alt: true }); // jump to the oldest
  assert.match(t.captureCharFrame(), / e0 /);
  await press(t, renderer, "end", { alt: true }); // back to the live edge
  const live = t.captureCharFrame();
  assert.doesNotMatch(live, /not Run state/);
  assert.match(live, / e29/);
});

test("workbench-timeline-inspection: the bounded window marks its beginning and counts Jump to latest activity", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  assert.doesNotMatch(t.captureCharFrame(), /Beginning of Run history/);

  await press(t, renderer, "home", { alt: true });
  const beginning = t.captureCharFrame();
  assert.match(beginning, /Beginning of Run history/);
  assert.match(beginning, / e0 /);

  await press(t, renderer, "down", { alt: true });
  assert.doesNotMatch(t.captureCharFrame(), /Beginning of Run history/);

  await press(t, renderer, "end", { alt: true });
  await press(t, renderer, "up", { alt: true });
  assert.match(t.captureCharFrame(), /1 new activity · Jump to latest/);

  control.setRun(runOf({ timeline: events(32) }));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /3 new activities · Jump to latest/);

  await press(t, renderer, "end", { alt: true });
  assert.doesNotMatch(t.captureCharFrame(), /new activit(?:y|ies)/);

  // A full live window still begins at index zero: the marker is presentation only,
  // so it neither hides an activity nor manufactures a new-activity count.
  const exact = await mountWorkbench(runOf({ timeline: events(7) }), 100, 14);
  const exactFrame = exact.t.captureCharFrame();
  assert.match(exactFrame, /Beginning of Run history/);
  assert.match(exactFrame, / e0 /);
  assert.match(exactFrame, / e6 /);
  assert.doesNotMatch(exactFrame, /new activit(?:y|ies)/);

  const narrow = await mountWorkbench(runOf({ timeline: events(30) }), 40, 14);
  await press(narrow.t, narrow.renderer, "home", { alt: true });
  const narrowBeginning = narrow.t.captureCharFrame();
  assert.match(narrowBeginning, /Beginning of Run history/);
  assert.match(narrowBeginning, /\d+ · Jump to latest/);
  noOverflow(narrowBeginning, 40);
});

test("timeline rows wrap at the width instead of clipping and rewrap on resize (#288)", async () => {
  const words =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
  const { t, renderer } = await mountWorkbench(
    runOf({
      timeline: [{ at: "T000", event: "assistant-content", detail: words }],
    }),
    100,
    20,
  );
  // The row's display lines: the non-blank run under the label.
  const rowLines = () => {
    const lines = timelineLines(t.captureCharFrame());
    return lines.slice(
      0,
      lines.findIndex((line) => line.trim() === ""),
    );
  };
  const counts: number[] = [];
  for (const width of [100, 60, 40]) {
    resizeWorkbench(t, renderer, width, 20);
    await t.renderOnce();
    noOverflow(t.captureCharFrame(), width);
    const text = rowLines().join(" ");
    for (const word of words.split(" ")) {
      assert.match(text, new RegExp(`\\b${word}\\b`), `${word} at ${width}`);
    }
    // Continuation lines hang under the row's first line.
    for (const line of rowLines().slice(1)) assert.match(line, /^ {5}\S/);
    counts.push(rowLines().length);
  }
  assert.ok(
    counts[0]! < counts[1]! && counts[1]! < counts[2]!,
    `a narrower width wraps over more lines: ${counts.join(", ")}`,
  );
});

test("scrolling over wrapped rows steps by line, keeps its anchor under append and resize, and counts rows (#288)", async () => {
  // Mount at the widest size the test draws (the captured frame keeps its mount
  // size), then narrow to 60 so every row wraps over two lines.
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: wrappingEvents(30) }),
    100,
    14,
  );
  resizeWorkbench(t, renderer, 60, 14);
  await t.renderOnce();
  // One line above the live edge hides only the newest row's last line: the badge
  // counts that one row, not lines.
  await press(t, renderer, "up", { alt: true });
  const scrolled = t.captureCharFrame();
  noOverflow(scrolled, 60);
  assert.match(scrolled, /▼ 1 · Jump to latest/);
  const first = timelineLines(scrolled)[0];

  // Three two-line rows append: the first visible line holds, and the count rises
  // by three rows (six lines would read 7).
  control.setRun(runOf({ timeline: wrappingEvents(33) }));
  await t.renderOnce();
  const appended = t.captureCharFrame();
  assert.equal(timelineLines(appended)[0], first);
  assert.match(appended, /▼ 4 · Jump to latest/);

  // From the top, down steps one display line at a time: reach row e1's first
  // line, then one more step shows its continuation line first.
  await press(t, renderer, "home", { alt: true });
  for (let i = 0; i < 6; i++) {
    if (/ e1 /.test(timelineLines(t.captureCharFrame())[0]!)) break;
    await press(t, renderer, "down", { alt: true });
  }
  assert.match(timelineLines(t.captureCharFrame())[0]!, / e1 /);
  await press(t, renderer, "down", { alt: true });
  const continuation = timelineLines(t.captureCharFrame())[0]!;
  assert.match(continuation, /^ {5}\S/);
  assert.doesNotMatch(continuation, / e\d+ /);

  // Widening rewraps each row onto one line, and e1 stays the first visible row.
  resizeWorkbench(t, renderer, 100, 14);
  await t.renderOnce();
  const widened = t.captureCharFrame();
  noOverflow(widened, 100);
  assert.match(timelineLines(widened)[0]!, / e1 /);
  // Narrowing again restores the exact line: the anchor kept its offset in e1.
  resizeWorkbench(t, renderer, 60, 14);
  await t.renderOnce();
  assert.match(timelineLines(t.captureCharFrame())[0]!, / e1 /);
});

// --- Step and Session dividers (#289) ---------------------------------------

/** One Turn-scoped event as the Application names it: its Step, its recorded
 *  Session, and the Session's plain name. */
function turnEvent(
  at: string,
  step: string,
  session: string,
  sessionName: string,
  event: RunTimelineEvent["event"] = "turn-started",
): RunTimelineEvent {
  return {
    at,
    event,
    detail: event === "turn-started" ? session : "completed",
    turnKind: "agent",
    step,
    session,
    sessionName,
  };
}

/** A reopened Run crossing Steps and Sessions: grill and write-spec share the
 *  `spec` conversation, a Command step has none, and each Iteration of implement
 *  opens a `fresh` one the Application names with its Iteration. */
function dividedRun(): RunView {
  return runOf({
    state: "succeeded",
    timeline: [
      { at: "T00", event: "run-created" },
      { at: "T01", event: "trust-granted", detail: "op-trust-1" },
      turnEvent("T02", "grill", "spec", "spec"),
      {
        at: "T03",
        event: "assistant-content",
        detail: "Questions answered",
        step: "grill",
        session: "spec",
        sessionName: "spec",
      },
      {
        at: "T04",
        event: "attempt-settled",
        detail: "succeeded",
        step: "grill",
      },
      turnEvent("T05", "write-spec", "spec", "spec"),
      {
        at: "T06",
        event: "attempt-settled",
        detail: "succeeded",
        step: "write-spec",
      },
      {
        at: "T07",
        event: "attempt-settled",
        detail: "succeeded",
        step: "baseline",
      },
      turnEvent(
        "T08",
        "implement",
        "fresh-0.1:implement",
        "fresh, iteration 1",
      ),
      {
        at: "T09",
        event: "attempt-settled",
        detail: "succeeded",
        step: "implement",
      },
      { at: "T10", event: "iteration", detail: "1" },
      turnEvent(
        "T11",
        "implement",
        "fresh-1.1:implement",
        "fresh, iteration 2",
      ),
      {
        at: "T12",
        event: "request-expired",
        detail: "req-42",
        step: "implement",
        session: "fresh-1.1:implement",
        sessionName: "fresh, iteration 2",
      },
      { at: "T13", event: "materialization-conflict", detail: "docs/spec.md" },
    ],
  });
}

test("[step-session-dividers] the timeline marks each Step and Harness Session with distinct plain-word dividers (#289)", async () => {
  // #23 evidence for this slice: meaning without colour (every assertion reads the
  // colourless character frame: the two dividers differ by glyph and words), large
  // content and small terminals in the tests below, and renderer and platform
  // evidence through the fake Renderer Port in the three-OS canonical suite.
  const { t } = await mountWorkbench(dividedRun(), 100, 50);
  const frame = t.captureCharFrame();
  noOverflow(frame, 100);
  const lines = timelineLines(frame);
  // A Session divider on every change of conversation, before the Step divider
  // when both begin at once; a Step divider on every change of Step, and again
  // after an Iteration completes. A shared Session draws no second Session divider.
  assert.deepEqual(dividers(lines), [
    "═ Conversation · spec",
    "─ Step · grill",
    "─ Step · write-spec",
    "─ Step · baseline",
    "═ Conversation · fresh, iteration 1",
    "─ Step · implement",
    "═ Conversation · fresh, iteration 2",
    "─ Step · implement",
  ]);
  // Each divider sits directly above the event row that begins its Step.
  const grill = lines.findIndex((line) => /Step · grill/.test(line));
  assert.match(lines[grill - 1]!, /Conversation · spec/);
  assert.match(lines[grill + 1]!, /Agent Turn started/);
  const baseline = lines.findIndex((line) => /Step · baseline/.test(line));
  assert.match(lines[baseline + 1]!, /▸ Step Attempt succeeded/);

  // Everyday rows read in plain words: no raw event kind, no recorded Session
  // name, no Session label, no ids, and no Session availability word.
  const text = lines.join("\n");
  for (const label of [
    /○ Run created/,
    /✓ Trust granted/,
    /Assistant[\s\S]*Questions answered/,
    /↻ Iteration 1 complete/,
    /\? Harness Request expired/,
    /! Materialization conflict · docs\/spec\.md/,
  ]) {
    assert.match(text, label);
  }
  assert.doesNotMatch(
    text,
    /run-created|trust-granted|attempt-settled|request-expired|materialization-conflict|iteration 1 1/,
  );
  assert.doesNotMatch(text, /fresh-\d|op-trust-1|req-42|session/);
  assert.doesNotMatch(text, /\b(?:open|detached|unusable)\b/);
});

test("[step-session-dividers] a divider wraps its words behind its glyph on a narrow terminal and rewraps on resize (#289)", async () => {
  const { t, renderer } = await mountWorkbench(dividedRun(), 100, 50);
  for (const width of [30, 22, 100]) {
    resizeWorkbench(t, renderer, width, 50);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    noOverflow(frame, width);
    const lines = timelineLines(frame).map((line) => line.trim());
    // Every word of each title survives, on lines the divider's glyph leads.
    const words = (glyph: string) =>
      lines
        .filter((line) => line.startsWith(glyph))
        .join(" ")
        .split(/[\s─═]+/);
    for (const word of ["Conversation", "fresh,", "iteration", "2"]) {
      assert.ok(words("═").includes(word), `${word} at ${width}`);
    }
    for (const word of ["Step", "write-spec", "baseline", "implement"]) {
      assert.ok(words("─").includes(word), `${word} at ${width}`);
    }
  }
  // Narrow, the title wraps over lines that each begin with the glyph.
  resizeWorkbench(t, renderer, 22, 50);
  await t.renderOnce();
  const narrow = timelineLines(t.captureCharFrame()).map((line) => line.trim());
  const at = narrow.indexOf("═ fresh, iteration 1");
  assert.ok(at > 0, narrow.join("\n"));
  assert.equal(narrow[at - 1], "═ Conversation ·");
});

test("[step-session-dividers] dividers scroll with their rows: the anchor holds and the new-activity count counts events (#289)", async () => {
  // Every row begins a new Step, so each is a divider line plus its event line.
  const stepped = (count: number): RunTimelineEvent[] =>
    events(count).map((event, index) => ({ ...event, step: `s${index}` }));
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: stepped(30) }),
    100,
    14,
  );
  // One line above the live edge hides only the newest row's last line.
  await press(t, renderer, "up", { alt: true });
  const scrolled = t.captureCharFrame();
  assert.match(scrolled, /▼ 1 new activity · Jump to latest/);
  const first = timelineLines(scrolled)[0];

  // Three rows append, each led by its divider: the first visible line holds, and
  // the count rises by three events (six lines would read 7).
  control.setRun(runOf({ timeline: stepped(33) }));
  await t.renderOnce();
  const appended = t.captureCharFrame();
  assert.equal(timelineLines(appended)[0], first);
  assert.match(appended, /▼ 4 new activities · Jump to latest/);

  // From the top, a divider scrolls one line at a time like any row's line.
  await press(t, renderer, "home", { alt: true });
  const top = timelineLines(t.captureCharFrame());
  assert.deepEqual(dividers(top.slice(0, 1)), ["─ Step · s0"]);
  await press(t, renderer, "down", { alt: true });
  assert.match(timelineLines(t.captureCharFrame())[0]!, /Step Attempt e0/);
  await press(t, renderer, "end", { alt: true });
  assert.doesNotMatch(t.captureCharFrame(), /new activit/);
});

test("a long live preview wraps in full at the live edge (#288)", async () => {
  const { t, control } = await mountWorkbench(
    runOf({ timeline: events(3) }),
    60,
    20,
  );
  const preview = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  control.setPreview(preview);
  control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  noOverflow(frame, 60);
  const text = timelineLines(frame).join(" ");
  for (const word of preview.split(" ")) {
    assert.match(text, new RegExp(`\\b${word}\\b`));
  }
});

test("a streamed preview longer than the viewport wraps in full and scrolls (#288)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(2) }),
    60,
    14,
  );
  const preview = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
  control.setPreview(preview);
  control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  // The live edge shows the newest streamed words; the row runs past the top.
  const live = t.captureCharFrame();
  noOverflow(live, 60);
  assert.match(live, /\bw199\b/);
  assert.doesNotMatch(live, /Assistant preview/);

  // Home reaches the row's first line; every word is reachable by scrolling down.
  await press(t, renderer, "home", { alt: true });
  const seen = new Set<string>();
  for (let i = 0; i < 80; i++) {
    for (const word of timelineLines(t.captureCharFrame())
      .join(" ")
      .match(/\bw\d+\b/g) ?? []) {
      seen.add(word);
    }
    if (seen.has("w199")) break;
    await press(t, renderer, "pagedown");
  }
  assert.equal(seen.size, 200);
});

test("rows that advertise truncation still clip with an ellipsis beside wrapped content (#288)", async () => {
  const timeline = await mountWorkbench(
    runOf({ timeline: wrappingEvents(30) }),
    24,
    14,
  );
  await press(timeline.t, timeline.renderer, "up", { alt: true });
  const frame = timeline.t.captureCharFrame();
  noOverflow(frame, 24);
  assert.match(frame, /▼ 1 · Jump/);
  // The rows beneath it wrap: the lorem words are whole, never cut by "…".
  const rows = timelineLines(frame).filter((line) => /lorem|ipsum/.test(line));
  assert.ok(rows.length > 0);
  for (const line of rows) assert.doesNotMatch(line, /…/);

  const overlay = await mountWorkbench(transcriptRun(), 14, 24);
  overlay.control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "hello"),
  });
  await openTranscriptDetails(overlay);
  const opened = overlay.t.captureCharFrame();
  noOverflow(opened, 14);
  assert.match(opened, /Session tra…/);
});

test("an empty timeline shows the no-activity placeholder", async () => {
  const { t } = await mountWorkbench(runOf({ timeline: [] }));
  assert.match(t.captureCharFrame(), /no activity yet/);
});

test("declined elicitation history shows the question and setup remediation safely", async () => {
  const { t } = await mountWorkbench(
    runOf({
      state: "succeeded",
      timeline: [
        {
          at: "T000",
          event: "elicitation-declined",
          elicitation: {
            harness: "claude-code",
            server: "setup",
            message: "Finish\u0000setup\u001b[31m now\u001b[0m",
            url: "https://example.com/setup",
          },
          detail:
            "Secant cannot show this elicitation. Finish setup in Claude Code directly before continuing.",
        },
      ],
    }),
    140,
    24,
  );
  const frame = conversationText(t.captureCharFrame(), 140);
  assert.match(frame, /Elicitation declined/);
  assert.match(frame, /claude-code\/setup/);
  assert.match(frame, /Finish setup now/);
  assert.doesNotMatch(frame, /\[31m|\[0m/);
  assert.match(frame, /https:\/\/example.com\/setup/);
  assert.match(frame, /Finish setup in Claude Code directly/);
});

test("m10-observed-harness-facts: metadata replacement leaves paused history and its activity badge alone", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({
      timeline: events(40),
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
    100,
    18,
  );
  const overlay: RunLiveOverlay = {
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  };
  control.setLive(overlay);
  await t.renderOnce();
  await press(t, renderer, "up", { alt: true });
  const history = () =>
    t
      .captureCharFrame()
      .split("\n")
      .filter((line) => / e\d|Jump to latest|Paused/.test(line));
  const before = history();
  control.setLive({
    ...overlay,
    context: { limitTokens: 200000 },
    usage: "last output 0 tokens",
  });
  await t.renderOnce();
  assert.deepEqual(history(), before);
  assert.match(t.captureCharFrame(), /Context · capacity 200000 tokens/);
  assert.match(t.captureCharFrame(), /Usage · last output 0 tokens/);
  control.setLive({
    ...overlay,
    context: { usedTokens: 9000, limitTokens: 2, percentage: 150 },
    usage: "input 7 tokens",
  });
  await t.renderOnce();
  assert.deepEqual(history(), before);
  assert.match(
    t.captureCharFrame(),
    /used 9000 tokens, capacity 2 tokens, reported 150%/,
  );
  assert.doesNotMatch(t.captureCharFrame(), /undefined|450000%/);
  control.setLive({ ...overlay, context: {}, usage: "" });
  await t.renderOnce();
  assert.deepEqual(history(), before);
  assert.doesNotMatch(t.captureCharFrame(), /Context ·|Usage ·/);
});

test("m10-session-history H2: row identity survives preview settlement, insertion and complete page replacement while paused", async () => {
  const run = runOf({
    sessions: [
      { session: "conversation", name: "Conversation", availability: "open" },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 14);
  const row = (
    id: string,
    content: string,
    source: "stored" | "preview" = "stored",
  ): SessionHistoryRow => ({
    id,
    position: id,
    source,
    turnStartedAt: "2026-10-06T00:00:00Z",
    turn: "opaque-turn",
    value: { kind: "message", role: "assistant", content },
  });
  const page = (
    rows: readonly SessionHistoryRow[],
  ): SessionHistorySnapshot => ({
    family: "session-history",
    runId: run.runId,
    session: "conversation",
    result: {
      found: true,
      history: {
        rows,
        hasEarlier: false,
        transcriptPage: {
          type: "transcript-page",
          runId: run.runId,
          session: "conversation",
        },
        transcriptExport: {
          type: "transcript-export",
          runId: run.runId,
          session: "conversation",
        },
      },
    },
  });
  const initial = Array.from({ length: 30 }, (_, index) =>
    row(`opaque-${index}`, index === 5 ? "ACTIVITY_ANCHOR" : `row-${index}`),
  );
  control.setHistory(page(initial));
  await t.renderOnce();
  await press(t, renderer, "home", { alt: true });
  for (let step = 0; step < 20; step++) {
    if (
      timelineLines(t.captureCharFrame())
        .find((line) => line.trim() !== "")
        ?.includes("ACTIVITY_ANCHOR")
    )
      break;
    await press(t, renderer, "down", { alt: true });
  }
  assert.match(
    timelineLines(t.captureCharFrame()).find((line) => line.trim() !== "") ??
      "",
    /ACTIVITY_ANCHOR/,
  );
  const firstVisible = timelineLines(t.captureCharFrame()).find(
    (line) => line.trim() !== "",
  );
  assert.ok(firstVisible);
  const inserted = row("opaque-inserted", "PREVIEW_INSERTED", "preview");
  control.setHistory(page([inserted, ...initial]));
  await t.renderOnce();
  assert.equal(
    timelineLines(t.captureCharFrame()).find((line) => line.trim() !== ""),
    firstVisible,
  );
  assert.doesNotMatch(t.captureCharFrame(), /PREVIEW_INSERTED/);
  control.setHistory(
    page([
      row("opaque-inserted", "PREVIEW_SETTLED"),
      ...initial.map((value) => ({ ...value })),
    ]),
  );
  await t.renderOnce();
  assert.equal(
    timelineLines(t.captureCharFrame()).find((line) => line.trim() !== ""),
    firstVisible,
  );
  assert.doesNotMatch(t.captureCharFrame(), /PREVIEW_SETTLED/);
  await press(t, renderer, "end", { alt: true });
  assert.match(t.captureCharFrame(), /row-29/);
});

test("m10-session-history: a history-only observer loss is visible and reconnect resets its viewport", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({
      sessions: [
        {
          session: "fixture-preview",
          name: "Conversation",
          availability: "open",
        },
      ],
    }),
    100,
    20,
  );
  control.setPreview("Last-known content");
  await t.renderOnce();
  control.setHistoryFreshness({
    kind: "disconnected",
    reason: "observer-lagged",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /View disconnected/);
  assert.match(frame, /ctrl\+r reconnect/);
  assert.match(frame, /Last-known content/);
  await press(t, renderer, "r", { ctrl: true });
  assert.deepEqual(control.reconnects, ["history"]);
  control.setHistoryFreshness({
    kind: "current",
    catchUp: "rebased",
    lastConfirmedAt: "2026-09-22T10:30:01.000Z",
  });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /not Run state/);
});

for (const settledAt of ["2026-10-06T00:00:03Z", "2026-10-06T00:00:00Z"])
  test(`m10-session-history: Workflow settlement at ${settledAt} appends below its conversation`, async () => {
    const run = runOf({
      timeline: [
        {
          at: settledAt,
          event: "attempt-settled",
          detail: "succeeded",
          step: "repair",
        },
      ],
      sessions: [
        { session: "s", name: "Conversation", availability: "detached" },
      ],
    });
    const { t, control } = await mountWorkbench(run, 100, 24);
    const rows: SessionHistoryRow[] = [
      {
        id: "opaque-message",
        position: "a",
        source: "stored",
        turnStartedAt: "2026-10-06T00:00:00Z",
        turn: "opaque-turn",
        step: "repair",
        value: {
          kind: "message",
          role: "assistant",
          content: "EARLIER_ASSISTANT_ANSWER",
        },
      },
      {
        id: "opaque-result",
        position: "b",
        source: "stored",
        turnStartedAt: "2026-10-06T00:00:00Z",
        turn: "opaque-turn",
        step: "repair",
        value: { kind: "turn-result", origin: "human", result: "completed" },
      },
    ];
    control.setHistory({
      family: "session-history",
      runId: run.runId,
      session: "s",
      result: {
        found: true,
        history: {
          rows,
          hasEarlier: false,
          transcriptPage: {
            type: "transcript-page",
            runId: run.runId,
            session: "s",
          },
          transcriptExport: {
            type: "transcript-export",
            runId: run.runId,
            session: "s",
          },
        },
      },
    });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    const message = frame.indexOf("EARLIER_ASSISTANT_ANSWER"),
      turn = frame.indexOf("Turn · started by you · completed"),
      workflow = frame.indexOf("Step Attempt succeeded");
    assert.ok(message >= 0 && turn > message && workflow > turn, frame);
    assert.equal(frame.match(/Step · repair/g)?.length, 1);
  });

function historyRow(
  id: string,
  content: string,
  source: "stored" | "preview" = "stored",
): SessionHistoryRow {
  return {
    id,
    position: id,
    source,
    turnStartedAt: "2026-10-06T00:00:00Z",
    turn: "opaque-turn",
    value: { kind: "message", role: "assistant", content },
  };
}

function historyPage(
  rows: readonly SessionHistoryRow[],
  hasEarlier = false,
): SessionHistorySnapshot {
  return {
    family: "session-history",
    runId: "run-1",
    session: "conversation",
    result: {
      found: true,
      history: {
        rows,
        hasEarlier,
        transcriptPage: {
          type: "transcript-page",
          runId: "run-1",
          session: "conversation",
        },
        transcriptExport: {
          type: "transcript-export",
          runId: "run-1",
          session: "conversation",
        },
      },
    },
  };
}

function firstHistoryLine(frame: string): string {
  return timelineLines(frame)[0]?.trim() ?? "";
}

/** The new-activity count on the status row under the conversation. */
function historyBadge(frame: string): number {
  const label =
    frame.split("\n").find((line) => /Jump to latest|Paused ·/.test(line)) ??
    "";
  return Number(label.match(/▼ (\d+)/)?.[1] ?? 0);
}

async function mountHistory(width: number, height = 14, input = false) {
  return mountWorkbench(
    (input ? interactiveRunOf : runOf)({
      sessions: [
        { session: "conversation", name: "Conversation", availability: "open" },
      ],
    }),
    width,
    height,
  );
}

async function seekHistoryLine(
  wb: Awaited<ReturnType<typeof mountWorkbench>>,
  expected: string,
) {
  await press(wb.t, wb.renderer, "home", { alt: true });
  for (
    let line = 0;
    line < 80 && firstHistoryLine(wb.t.captureCharFrame()) !== expected;
    line++
  )
    await press(wb.t, wb.renderer, "down", { alt: true });
  assert.equal(firstHistoryLine(wb.t.captureCharFrame()), expected);
}

for (const width of [40, 100]) {
  test(`m10-paused-history-identity H2: nonzero wrapped offset survives insertion, removal, preview update/settlement, replacement and append at ${width}`, async () => {
    const wb = await mountHistory(width);
    const anchorLine = "ACTIVITY_ANCHOR".padEnd(width - 6, "A");
    const nextLine = "OFFSET_NEXT".padEnd(width - 6, "B");
    const anchor = historyRow(
      "anchor",
      `${"P".repeat(width - 2)} ${anchorLine} ${nextLine}\nANCHOR_LAST`,
      "preview",
    );
    const initial = Array.from({ length: 30 }, (_, i) =>
      i === 5 ? anchor : historyRow(`row-${i}`, `ROW_${i}`),
    );
    wb.control.setHistory(historyPage(initial));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, anchorLine); // offset 2: role header, P line, anchor line
    const badge = historyBadge(wb.t.captureCharFrame());
    assert.equal(badge, 21); // the headerless nine-line viewport shows ROW_8 fully at both widths

    const unchanged = async (rows: readonly SessionHistoryRow[]) => {
      wb.control.setHistory(historyPage(rows));
      await wb.t.renderOnce();
      assert.equal(firstHistoryLine(wb.t.captureCharFrame()), anchorLine);
      assert.equal(historyBadge(wb.t.captureCharFrame()), badge);
      assert.doesNotMatch(wb.t.captureCharFrame(), /PREVIEW_INSERTED/);
    };
    const inserted = historyRow("inserted", "PREVIEW_INSERTED", "preview");
    await unchanged([inserted, ...initial]);
    await unchanged([
      historyRow("inserted", "PREVIEW_UPDATED", "preview"),
      ...initial,
    ]);
    await unchanged(initial.slice(1)); // remove before the surviving anchor
    await unchanged(
      initial.map((row) =>
        row.id === "anchor"
          ? {
              ...anchor,
              value: {
                kind: "message",
                role: "assistant",
                content: `${"P".repeat(width - 2)} ${anchorLine} ${nextLine}\nPREVIEW_UPDATED_LAST`,
              },
            }
          : row,
      ),
    );
    const settled: SessionHistoryRow = { ...anchor, source: "stored" };
    await unchanged(
      initial.map((row) => (row.id === "anchor" ? settled : { ...row })),
    );
    const appended = [
      ...initial.map((row) => (row.id === "anchor" ? settled : { ...row })),
      historyRow("appended", "APPENDED"),
    ];
    wb.control.setHistory(historyPage(appended));
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), anchorLine);
    assert.equal(historyBadge(wb.t.captureCharFrame()), badge + 1);
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), nextLine); // unchanged offset, not just row
    await press(wb.t, wb.renderer, "end", { alt: true });
    assert.match(wb.t.captureCharFrame(), /APPENDED/);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
    wb.control.setHistory(
      historyPage([...appended, historyRow("live", "LIVE_APPEND")]),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /LIVE_APPEND/);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
  });
}

function activityRow(id: string, description = id): SessionHistoryRow {
  return { ...historyRow(id, ""), value: { kind: "activity", description } };
}

for (const width of [40, 100]) {
  for (const fallback of [
    "tie-later",
    "nearest-earlier",
    "no-survivor",
  ] as const) {
    test(`m10-paused-history-identity: ${fallback} uses prior order, offset zero and exact badge at ${width}`, async () => {
      const wb = await mountHistory(width);
      const initial = Array.from({ length: 20 }, (_, i) =>
        i === 5
          ? historyRow(
              "old-5",
              "OFFSET_ONE\nANCHOR_OFFSET_TWO\nANCHOR_END",
              "preview",
            )
          : activityRow(`old-${i}`, `OLD_${i}`),
      );
      wb.control.setHistory(historyPage(initial));
      await wb.t.renderOnce();
      await seekHistoryLine(wb, "ANCHOR_OFFSET_TWO"); // nonzero offset 2
      const added = Array.from({ length: 15 }, (_, i) =>
        activityRow(`new-${i}`, `NEW_${i}`),
      );
      const replacement =
        fallback === "tie-later"
          ? [added[0]!, initial[7]!, initial[3]!, ...added.slice(1)]
          : fallback === "nearest-earlier"
            ? [added[0]!, initial[8]!, initial[4]!, ...added.slice(1)]
            : added;
      wb.control.setHistory(historyPage(replacement));
      await wb.t.renderOnce();
      assert.equal(
        firstHistoryLine(wb.t.captureCharFrame()),
        fallback === "tie-later"
          ? "↳ OLD_7"
          : fallback === "nearest-earlier"
            ? "↳ OLD_4"
            : "═".repeat(width === 40 ? 4 : 34) +
              " Conversation · Conversation " +
              "═".repeat(width === 40 ? 5 : 35),
      );
      // The first current row carries the Session/beginning dividers, never an activity.
      if (fallback !== "no-survivor") {
        // The headerless viewport is nine lines at both widths.
        assert.equal(
          historyBadge(wb.t.captureCharFrame()),
          fallback === "tie-later" ? 7 : 6,
        );
        await press(wb.t, wb.renderer, "down", { alt: true });
        assert.equal(
          firstHistoryLine(wb.t.captureCharFrame()),
          fallback === "tie-later" ? "↳ OLD_3" : "↳ NEW_1",
        );
      } else {
        assert.equal(historyBadge(wb.t.captureCharFrame()), 7);
        await press(wb.t, wb.renderer, "down", { alt: true });
        assert.match(firstHistoryLine(wb.t.captureCharFrame()), /NEW_0/);
      }
    });
  }

  test(`m10-paused-history-identity: empty-to-returning and short pages remain paused; resize and shrink clamp only the row offset at ${width}`, async () => {
    const wb = await mountHistory(width);
    const anchor = historyRow(
      "anchor",
      "START\nOFFSET_ONE\nOFFSET_TWO\nOFFSET_THREE",
    );
    const initial = [
      activityRow("before", "BEFORE"),
      anchor,
      ...Array.from({ length: 20 }, (_, i) => activityRow(`tail-${i}`)),
    ];
    wb.control.setHistory(historyPage(initial));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, "OFFSET_THREE"); // offset 4
    wb.control.setHistory(historyPage([initial[0]!, anchor]));
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "OFFSET_THREE");
    assert.match(wb.t.captureCharFrame(), /Paused · alt\+end latest/);
    const shortLines = timelineLines(wb.t.captureCharFrame())
      .slice(0, 4)
      .map((line) => line.trim());
    assert.deepEqual(shortLines, ["OFFSET_THREE", "", "", ""]);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
    await press(wb.t, wb.renderer, "up", { alt: true });
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "OFFSET_TWO");
    resizeWorkbench(wb.t, wb.renderer, width === 40 ? 100 : 40, 24);
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "OFFSET_TWO");
    wb.control.setHistory(
      historyPage([initial[0]!, historyRow("anchor", "SHRUNK_LAST")]),
    );
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "SHRUNK_LAST"); // offset clamps from 3 to 1
    wb.control.setHistory(
      historyPage([
        ...initial.slice(0, 1),
        historyRow("anchor", "SHRUNK_LAST"),
        activityRow("append", "APPENDED_WHILE_PAUSED"),
      ]),
    );
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "SHRUNK_LAST");
    wb.control.setHistory(historyPage([]));
    await wb.t.renderOnce();
    assert.match(
      firstHistoryLine(wb.t.captureCharFrame()),
      /Beginning of Run history/,
    );
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
    assert.match(wb.t.captureCharFrame(), /Paused · alt\+end latest/);
    wb.control.setHistory(
      historyPage([
        activityRow("return", "RETURNED"),
        activityRow("after-return", "AFTER_RETURN"),
      ]),
    );
    await wb.t.renderOnce();
    assert.match(firstHistoryLine(wb.t.captureCharFrame()), /Conversation/); // earliest row, offset zero
    const returned = firstHistoryLine(wb.t.captureCharFrame());
    wb.control.setHistory(
      historyPage(
        Array.from({ length: 30 }, (_, i) =>
          i === 0
            ? activityRow("return", "RETURNED")
            : activityRow(`returned-${i}`),
        ),
      ),
    );
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), returned);
    // Returning content never silently attaches; the resized 19-line viewport (100
    // or 40 columns, height 24) shows rows up to the badge.
    assert.equal(historyBadge(wb.t.captureCharFrame()), width === 40 ? 12 : 13);
  });
}

for (const width of [40, 100]) {
  test(`m10-paused-history-identity: 200/201-row eviction preserves an offset then falls forward from an evicted anchor at ${width}`, async () => {
    const wb = await mountHistory(width);
    const initial = Array.from({ length: 200 }, (_, i) =>
      i === 5
        ? historyRow("row-5", "ANCHOR_FIRST\nEVICTION_OFFSET\nANCHOR_LAST")
        : activityRow(`row-${i}`, `ROW_${i}`),
    );
    wb.control.setHistory(historyPage(initial));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, "EVICTION_OFFSET"); // offset 2
    assert.equal(historyBadge(wb.t.captureCharFrame()), 187); // nine-line viewport
    const retained = [...initial.slice(1), activityRow("row-200", "ROW_200")];
    wb.control.setHistory(historyPage(retained, true));
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "EVICTION_OFFSET");
    assert.equal(historyBadge(wb.t.captureCharFrame()), 188);
    await press(wb.t, wb.renderer, "home", { alt: true });
    await press(wb.t, wb.renderer, "down", { alt: true });
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.match(firstHistoryLine(wb.t.captureCharFrame()), /ROW_1/); // offset 2, below attached rules
    wb.control.setHistory(
      historyPage(
        [...retained.slice(1), activityRow("row-201", "ROW_201")],
        true,
      ),
    );
    await wb.t.renderOnce();
    assert.match(
      firstHistoryLine(wb.t.captureCharFrame()),
      /Earlier conversation is not shown/,
    ); // fallback row-2, offset zero
    assert.equal(historyBadge(wb.t.captureCharFrame()), 196); // nine-line viewport
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.match(firstHistoryLine(wb.t.captureCharFrame()), /Conversation/);
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.match(firstHistoryLine(wb.t.captureCharFrame()), /ROW_2/);
  });

  test(`m10-paused-history-identity: wheel, Alt, page navigation and explicit latest beside native prompt editing at ${width}`, async () => {
    const wb = await mountHistory(width, 20, true);
    const rows = Array.from({ length: 30 }, (_, i) =>
      historyRow(`row-${i}`, `ROW_${i}`),
    );
    wb.control.setHistory(historyPage(rows));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, "ROW_5");
    const first = firstHistoryLine(wb.t.captureCharFrame());
    await type(wb.t, "draft");
    for (const name of ["up", "down", "home", "end"]) {
      await press(wb.t, wb.renderer, name); // dispatcher lets native field own these
      assert.equal(firstHistoryLine(wb.t.captureCharFrame()), first);
    }
    wb.t.mockInput.pressKey("HOME");
    await type(wb.t, "A");
    wb.t.mockInput.pressKey("END");
    wb.t.mockInput.pressArrow("left");
    await type(wb.t, "B");
    assert.match(wb.t.captureCharFrame(), /AdrafBt/);
    await press(wb.t, wb.renderer, "up", { alt: true });
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "Assistant");
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
    const y = 1; // the conversation's first row, inside the padding
    await wb.t.mockMouse.scroll(5, y, "up");
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "Assistant");
    await wb.t.mockMouse.scroll(5, y, "down");
    await wb.t.renderOnce();
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
    // A 12-line viewport at both widths (an Agent-bearing Run's two reserved
    // metadata slots, #418, sit under it): half pages move 6 displayed lines.
    await press(wb.t, wb.renderer, "pagedown");
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_8");
    await press(wb.t, wb.renderer, "pageup");
    assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
    assert.match(wb.t.captureCharFrame(), /AdrafBt/);
    await press(wb.t, wb.renderer, "end", { alt: true });
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
    await press(wb.t, wb.renderer, "up", { alt: true });
    assert.equal(historyBadge(wb.t.captureCharFrame()), 1); // partly visible final row
    await press(wb.t, wb.renderer, "down", { alt: true });
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0); // deliberate downward reattachment
    wb.control.setHistory(
      historyPage([...rows, historyRow("latest", "FOLLOWED_APPEND")]),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /FOLLOWED_APPEND/);
    assert.equal(historyBadge(wb.t.captureCharFrame()), 0);
  });
}

test("m10-paused-history-identity: one-line viewport pages move at least one displayed line", async () => {
  const wb = await mountHistory(100, 8);
  // Six rows: the status row, the prompt's field and its hint leave one line.
  resizeWorkbench(wb.t, wb.renderer, 100, 6);
  wb.control.setHistory(
    historyPage(
      Array.from({ length: 20 }, (_, i) => historyRow(`row-${i}`, `ROW_${i}`)),
    ),
  );
  await wb.t.renderOnce();
  await seekHistoryLine(wb, "ROW_5");
  await press(wb.t, wb.renderer, "pageup");
  assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "Assistant");
  await press(wb.t, wb.renderer, "pagedown");
  assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
});

for (const width of [40, 100]) {
  test(`m10-paused-history-identity: rewrap keeps a surviving row's nonzero offset and clamps to its last line at ${width}`, async () => {
    const wb = await mountHistory(width);
    const content = `${"P".repeat(width - 2)} ${"REWRAP_OFFSET".padEnd(width - 6, "X")} ${"Z".repeat(width - 6)}`;
    const initial = [
      activityRow("before", "BEFORE"),
      historyRow("anchor", content),
      ...Array.from({ length: 20 }, (_, i) => activityRow(`after-${i}`)),
    ];
    wb.control.setHistory(historyPage(initial));
    await wb.t.renderOnce();
    await seekHistoryLine(wb, "REWRAP_OFFSET".padEnd(width - 6, "X")); // offset 2
    resizeWorkbench(wb.t, wb.renderer, width === 40 ? 100 : 40, 14);
    await wb.t.renderOnce();
    assert.equal(
      firstHistoryLine(wb.t.captureCharFrame()),
      width === 40 ? "Z".repeat(34) : "P".repeat(34),
    );
    // The offset stays 2 despite reflow: at wide width it is the last content line.
    await press(wb.t, wb.renderer, "up", { alt: true });
    assert.equal(
      firstHistoryLine(wb.t.captureCharFrame()),
      width === 40
        ? `${"P".repeat(38)} ${"REWRAP_OFFSET".padEnd(34, "X")}`
        : "P".repeat(38),
    );
    noOverflow(wb.t.captureCharFrame(), width === 40 ? 100 : 40);
  });
}

for (const width of [40, 100]) {
  for (const owner of [
    "dialog",
    "request",
    "gate",
    "checkpoint",
    "confirmation",
    "details",
  ] as const) {
    test(`m10-paused-history-identity: ${owner} owns navigation before history at ${width}`, async () => {
      const wb = await mountHistory(width, 30, true);
      const rows = Array.from({ length: 30 }, (_, i) =>
        historyRow(`row-${i}`, `ROW_${i}`),
      );
      wb.control.setHistory(historyPage(rows));
      await wb.t.renderOnce();
      await seekHistoryLine(wb, "ROW_5");
      const badge = historyBadge(wb.t.captureCharFrame());
      const sessions = [
        {
          session: "conversation",
          name: "Conversation",
          availability: "open" as const,
        },
      ];
      if (owner === "dialog")
        await press(wb.t, wb.renderer, "p", { ctrl: true });
      else if (owner === "request") wb.control.setLive(requestOverlay());
      else if (owner === "gate") wb.control.setRun(freeTextRunOf({ sessions }));
      else if (owner === "checkpoint")
        wb.control.setRun(blockedRunOf({ sessions }));
      else if (owner === "confirmation")
        await press(wb.t, wb.renderer, "e", { ctrl: true });
      else await press(wb.t, wb.renderer, "g", { ctrl: true });
      await wb.t.renderOnce();
      for (const key of ["end", "home", "up", "down"])
        await press(wb.t, wb.renderer, key, { alt: true });
      await press(wb.t, wb.renderer, "pagedown");
      await wb.t.mockMouse.scroll(5, 6, "down");
      await wb.t.renderOnce();
      assert.deepEqual(wb.control.ends, []);
      assert.deepEqual(wb.control.sends, []);
      assert.deepEqual(wb.control.texts, []);
      if (owner === "dialog") {
        // The Port-driven palette takes Escape from the Renderer Port.
        await press(wb.t, wb.renderer, "escape");
        await wb.t.waitForFrame((frame) => !frame.includes("App commands"));
      } else if (owner === "confirmation")
        await press(wb.t, wb.renderer, "escape");
      else if (owner === "details")
        await press(wb.t, wb.renderer, "g", { ctrl: true });
      else {
        wb.control.setLive(undefined);
        wb.control.setRun(interactiveRunOf({ sessions }));
        await wb.t.renderOnce();
      }
      assert.equal(firstHistoryLine(wb.t.captureCharFrame()), "ROW_5");
      assert.equal(historyBadge(wb.t.captureCharFrame()), badge);
      if (owner === "confirmation")
        assert.doesNotMatch(
          wb.t.captureCharFrame(),
          /End this interactive Step/,
        );
    });
  }
}

for (const appearance of ["dark", "light"] as const) {
  test(`m10-audit-entry-prompt-kind: Workbench attributes managed prompts to Secant and human follow-ups to You across widths in ${appearance}`, async () => {
    const preferences = previewPreferences();
    const wb = await mountWorkbench(
      runOf({
        sessions: [
          {
            session: "conversation",
            name: "Conversation",
            availability: "open",
          },
        ],
      }),
      100,
      40,
      undefined,
      true,
      0,
      {
        ...preferences,
        snapshot: () => ({
          ...preferences.snapshot(),
          preferences: { theme: "everforest", appearance },
        }),
      },
    );
    const managed: SessionHistoryRow = {
      ...historyRow("managed", ""),
      value: { kind: "entry-prompt", content: "BUNDLE_PROMPT_BODY" },
    };
    const human: SessionHistoryRow = {
      ...historyRow("human", ""),
      value: { kind: "message", role: "user", content: "HUMAN_FOLLOW_UP" },
    };
    wb.control.setHistory(historyPage([managed, human]));
    for (const width of [40, 80, 120, 121, 160]) {
      resizeWorkbench(wb.t, wb.renderer, width, 40);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      assert.match(frame, /Secant\s+started the Step/);
      assert.match(frame, /You[\s\S]*HUMAN_FOLLOW_UP/);
      assert.equal(frame.match(/\bYou\b/g)?.length, 1);
      assert.doesNotMatch(frame, /BUNDLE_PROMPT_BODY/);
      noOverflow(frame, width);
    }
  });
}
