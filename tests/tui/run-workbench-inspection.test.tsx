import { PALETTES } from "./palette-expectations.js";
import type { PreferencesView } from "../../src/tui/tui.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionHistorySnapshot,
  SessionHistoryRow,
} from "../../src/application/projection-port.js";
import {
  resizeWorkbench,
  runOf,
  events,
  onWorkbench,
  mountWorkbench,
  press,
  type,
  noOverflow,
  PROGRESS,
  transcriptRun,
  txEntries,
  RESUME_ACK_OFFER,
  okActions,
  liveTurnRunOf,
  inspectableRun,
  mountInspectable,
  INSPECTIONS,
  previewPreferences,
  hexRgb,
  historyText,
  serveHistoryText,
} from "./run-workbench-fixture.js";

test("the details panel shows the observed Harness, executable, version, and model, and the header no longer does (#194 story 35)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      selectedHarness: "claude-code",
      modelChoice: { model: "fake-opus", effort: "high" },
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      effectiveModel: "fake-sonnet",
    }),
    100,
    30,
  );
  // The header no longer carries the Harness/model facts (they moved to the panel).
  assert.doesNotMatch(t.captureCharFrame(), /Observed Harness/);
  await press(t, renderer, "g", { ctrl: true });
  const frame = t.captureCharFrame();
  assert.match(frame, /Selected Harness · claude-code/);
  assert.match(
    frame,
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3 · model fake-sonnet/,
  );
  // Requested and observed models stay visibly distinct (AC1).
  assert.match(frame, /Model choice · fake-opus · high effort/);
  noOverflow(frame, 100);
});

test("the panel drops the long executable path to stay readable at small widths (#194 story 35)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      harness: {
        name: "Claude Code",
        // A long executable path the compact layout drops to fit.
        executable: "/a/very/long/path/to/the/claude/executable/binary/here",
        executableVersion: "1.2.3",
      },
      effectiveModel: "fake-sonnet",
    }),
    100,
    30,
  );
  resizeWorkbench(t, renderer, 70, 30);
  await t.renderOnce();
  await press(t, renderer, "g", { ctrl: true });
  const compact = t.captureCharFrame();
  assert.match(
    compact,
    /Observed Harness · Claude Code · 1\.2\.3 · model fake-sonnet/,
  );
  noOverflow(compact, 70);
});

test("the panel reports no model rather than inventing one, and omits Harness facts for a Command-only Run (#194 story 35)", async () => {
  // Harness present, model unobserved: the fact is stated honestly, not invented.
  const missing = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
    }),
    100,
    30,
  );
  await press(missing.t, missing.renderer, "g", { ctrl: true });
  assert.match(
    missing.t.captureCharFrame(),
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3 · model not reported/,
  );

  // Command-only Run: no Harness identity, so no Harness/model lines at all.
  const commandOnly = await mountWorkbench(
    runOf({ state: "succeeded", progress: PROGRESS }),
    100,
    30,
  );
  await press(commandOnly.t, commandOnly.renderer, "g", { ctrl: true });
  const commandOnlyFrame = commandOnly.t.captureCharFrame();
  assert.doesNotMatch(commandOnlyFrame, /Selected Harness/);
  assert.doesNotMatch(commandOnlyFrame, /Observed Harness/);
  assert.doesNotMatch(commandOnlyFrame, /model/);
});

test("the details panel toggles and shows identity, position, and resources", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      runId: "run-9",
      progress: PROGRESS,
      position: 1,
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-9",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
    }),
  );
  assert.doesNotMatch(t.captureCharFrame(), /Workspace:/); // closed by default
  await press(t, renderer, "g", { ctrl: true });
  const frame = t.captureCharFrame();
  assert.match(frame, /Details/);
  assert.match(frame, /Run run-9/); // the id the active header leaves out
  assert.match(frame, /dev\.alpha@1\.0\.0/); // identity
  assert.match(frame, /sha256:abc123/);
  assert.match(frame, /Workspace: \/tmp\/ws/);
  assert.match(frame, /step 2 of 3/); // position
  assert.match(frame, /report \(text\)/); // a resource to open
});

test("Ctrl+G again closes the details panel and returns focus to the prompt", async () => {
  const { t, renderer } = await mountWorkbench(runOf({ timeline: events(4) }));
  await press(t, renderer, "g", { ctrl: true });
  assert.match(t.captureCharFrame(), /› Details/);
  await press(t, renderer, "g", { ctrl: true }); // toggle it back off
  assert.doesNotMatch(t.captureCharFrame(), /Workspace:/);
  // The prompt holds the keys again: a typed letter reaches its field.
  await type(t, "x");
  assert.match(t.captureCharFrame(), /^ > x/m);
});

test("on a terminal too short for the panel, d does not open a clipped details panel", async () => {
  // Wide enough across, but too few rows for DETAILS_HEIGHT plus a timeline row.
  const { t, renderer } = await mountWorkbench(
    runOf({ progress: PROGRESS, timeline: events(6) }),
    100,
    9,
  );
  await press(t, renderer, "g", { ctrl: true });
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Workspace:/); // panel stayed hidden
  noOverflow(frame, 100);
});

test("m10-audit-workbench-test-domains: opening a large text output shows bounded content with a truncation marker and scrolls", async () => {
  const run = runOf({
    outputs: [
      {
        name: "log",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "log",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  const big = Array.from({ length: 900 }, (_, i) => `line-${i}`).join("\n");
  control.setRead("log", { found: true, type: "text", content: big });

  await press(t, renderer, "g", { ctrl: true }); // focus details
  await press(t, renderer, "return"); // open the selected (log) reference
  const opened = t.captureCharFrame();
  assert.match(opened, /log \(text\)/); // inspection title
  assert.match(opened, /line-0/); // top of the content
  assert.doesNotMatch(opened, /line-800/); // bounded — not everything inlined

  for (let i = 0; i < 3; i++) await press(t, renderer, "pagedown");
  assert.match(t.captureCharFrame(), /line-\d\d/);

  await press(t, renderer, "end");
  assert.match(t.captureCharFrame(), /output truncated/); // explicit marker

  await press(t, renderer, "escape");
  assert.doesNotMatch(t.captureCharFrame(), /output truncated/);
  assert.match(t.captureCharFrame(), /Details/);
});

test("workbench-timeline-inspection: timeline and inspection end truncated content with the same marker", async () => {
  const timeline = await mountWorkbench(
    runOf({
      timeline: [
        {
          at: "T000",
          event: "assistant-content",
          detail: `${"x".repeat(157)} … output truncated`,
        },
        {
          at: "T001",
          event: "assistant-content",
          detail: "Still thinking…",
        },
      ],
    }),
    100,
    30,
  );
  // The capped row wraps rather than clipping: every kept character shows, and the
  // marker ends the row's last display line.
  const timelineFrame = timeline.t.captureCharFrame();
  const kept = (timelineFrame.match(/x{10,}/g) ?? []).join("");
  assert.equal(kept.length, 157);
  assert.match(timelineFrame, /^ {5}x+ … output truncated\s*$/m);
  assert.match(timelineFrame, /Still thinking…/);
  assert.doesNotMatch(timelineFrame, /Still thinking … output truncated/);

  const run = runOf({
    outputs: [
      {
        name: "log",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "log",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const inspection = await mountWorkbench(run, 100, 30);
  inspection.control.setRead("log", {
    found: true,
    type: "text",
    content: Array.from({ length: 501 }, (_, index) => `line-${index}`).join(
      "\n",
    ),
  });
  await press(inspection.t, inspection.renderer, "g", { ctrl: true });
  await press(inspection.t, inspection.renderer, "return");
  await press(inspection.t, inspection.renderer, "end");
  assert.match(inspection.t.captureCharFrame(), /line-499.*… output truncated/);
});

test("captured output with colour escapes and carriage returns renders without them", async () => {
  const run = runOf({
    outputs: [
      {
        name: "log",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "log",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  // A command forcing colour with CRLF line endings: SGR escapes plus `\r\n` (D4).
  const raw = "[31mred line[0m\r\nplain line\r\n[1mbold line[0m";
  control.setRead("log", { found: true, type: "text", content: raw });

  await press(t, renderer, "g", { ctrl: true }); // focus details
  await press(t, renderer, "return"); // open the log reference
  const frame = t.captureCharFrame();
  assert.ok(!frame.includes("["), "no escape sequences survive");
  assert.ok(!frame.includes("\r"), "no carriage returns survive");
  // Split on /\r?\n/: each CRLF started a fresh row, so all three read cleanly.
  assert.match(frame, /red line/);
  assert.match(frame, /plain line/);
  assert.match(frame, /bold line/);
});

test("a Verdict and a diagnostic open through their references", async () => {
  const run = runOf({
    state: "halted",
    outputs: [
      {
        name: "grade",
        type: "verdict",
        reference: {
          runId: "run-1",
          artifactName: "grade",
          versionId: "v1",
          type: "verdict",
        },
      },
    ],
    conflict: {
      artifactName: "out.txt",
      path: "out.txt",
      reference: { runId: "run-1", diagnosticId: "diag-1", type: "diagnostic" },
    },
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  control.setRead("grade", { found: true, type: "verdict", content: "pass" });
  control.setRead("d:diag-1", {
    found: true,
    type: "diagnostic",
    content: "workspace copy of out.txt went missing",
  });

  await press(t, renderer, "g", { ctrl: true }); // details focus, first resource (grade) selected
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /grade \(verdict\)/);
  assert.match(t.captureCharFrame(), /pass/);
  await press(t, renderer, "escape");

  await press(t, renderer, "down"); // select the diagnostic
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /halt diagnostic: out\.txt/);
  assert.match(t.captureCharFrame(), /went missing/);
});

test("a halted Run shows the materialization conflict path as a top-level line, at 40 columns", async () => {
  const run = runOf({
    state: "halted",
    conflict: {
      artifactName: "out.txt",
      path: "sub/out.txt",
      reference: { runId: "run-1", diagnosticId: "d1", type: "diagnostic" },
    },
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  // The Workspace path to restore is a top-level line, not only a details-panel
  // row reachable at width ≥ 60 (A13).
  assert.match(t.captureCharFrame(), /restore sub\/out\.txt/);
  resizeWorkbench(t, renderer, 40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /restore sub\/out\.txt/); // still shown at 40 columns
  noOverflow(frame, 40);
});

test("a selected-Harness preparation Problem is visible without colour and survives narrow resize", async () => {
  const run = runOf({
    state: "halted",
    selectedHarness: "codex",
    problem: {
      code: "selected-harness-unavailable",
      explanation: "Codex could not be prepared (authentication).",
      remediation: "Log in separately through Codex, then resume the Run.",
      possibleEffects: "none",
      details: { harness: "codex" },
    },
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  let frame = t.captureCharFrame();
  // The selected-Harness Problem stays a top-level header block, colour-independent.
  assert.match(frame, /selected-harness-unavailable/);
  assert.match(frame, /authentication/);
  assert.match(frame, /Log in separately through Codex/);
  // A halted Run carries its resting prose beside the state word (#194 story 38).
  assert.match(frame, /Execution stopped outside the Workflow\./);
  resizeWorkbench(t, renderer, 40, 24);
  await t.renderOnce();
  frame = t.captureCharFrame();
  assert.match(frame, /selected-harness-unavailable/);
  noOverflow(frame, 40);
});

test("a missing reference surfaces its Problem rather than throwing", async () => {
  const run = runOf({
    outputs: [
      {
        name: "gone",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "gone",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /resource-gone/);
});

test("the indeterminate Attempt shows as recovery evidence in the panel (#194 story 36/39)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_ACK_OFFER] }),
    100,
    40,
    okActions(),
  );
  await press(t, renderer, "g", { ctrl: true });
  assert.match(
    t.captureCharFrame(),
    /Indeterminate Attempt · the interrupted command may have already run/,
  );
});

for (const inspection of INSPECTIONS) {
  test(`workbench-inspection-quit: q in ${inspection.kind} inspection quits at once with no live Run`, async () => {
    const wb = await mountInspectable();
    await inspection.open(wb);
    const frame = wb.t.captureCharFrame();
    assert.match(frame, inspection.title);
    assert.match(frame, inspection.footer);

    await press(wb.t, wb.renderer, "q");
    assert.deepEqual(wb.exits, [undefined]);
  });

  test(`workbench-inspection-quit: q in ${inspection.kind} inspection asks first with live Runs; Keep Running keeps the inspection`, async () => {
    const wb = await mountInspectable(1);
    await inspection.open(wb);
    await press(wb.t, wb.renderer, "end");
    const before = wb.t.captureCharFrame();

    await press(wb.t, wb.renderer, "q");
    await wb.t.waitForFrame((f) => f.includes("Halt 1 live Run and quit?"));
    assert.deepEqual(wb.exits, []);

    wb.t.mockInput.pressEnter(); // the default, Keep Running
    await wb.t.waitForFrame((f) => !f.includes("Halt 1 live Run and quit?"));
    assert.deepEqual(wb.exits, []);
    assert.equal(wb.t.captureCharFrame(), before); // same overlay, same scroll

    await press(wb.t, wb.renderer, "q");
    await wb.t.waitForFrame((f) => f.includes("Halt 1 live Run and quit?"));
    wb.t.mockInput.pressArrow("right");
    wb.t.mockInput.pressEnter(); // Halt and Quit
    await wb.t.waitFor(() => wb.exits.length === 1);
    assert.deepEqual(wb.exits, [undefined]);
  });

  test(`workbench-inspection-quit: ${inspection.kind} inspection keeps Escape, Ctrl+C and Run-action letters on their routes`, async () => {
    const wb = await mountInspectable();
    await inspection.open(wb);
    const open = wb.t.captureCharFrame();

    // Run-action and screen letters stay inside the modal overlay: none arms,
    // confirms or dispatches beneath it.
    for (const key of ["r", "c", "x", "y", "t", "d", "s", "m"]) {
      await press(wb.t, wb.renderer, key);
    }
    assert.deepEqual(wb.dispatched, []);
    assert.deepEqual(wb.exits, []);
    assert.equal(wb.t.captureCharFrame(), open);

    // Escape closes the overlay only: the Workbench stays, its prompt back.
    await press(wb.t, wb.renderer, "escape");
    const closed = wb.t.captureCharFrame();
    assert.doesNotMatch(closed, inspection.footer);
    assert.ok(onWorkbench(closed));
    assert.match(closed, /\^G details · \^P commands · esc back/);
    assert.deepEqual(wb.exits, []);

    // Ctrl+C keeps its global quit route from inside the overlay.
    await press(wb.t, wb.renderer, inspection.reopen);
    assert.match(wb.t.captureCharFrame(), inspection.footer);
    await press(wb.t, wb.renderer, "c", { ctrl: true });
    assert.deepEqual(wb.exits, [undefined]);
  });
}

test("m10-workbench-interaction: compact output inspection yields drawing and keys and returns to its selected resource", async () => {
  const wb = await mountWorkbench(inspectableRun(), 40, 12);
  wb.control.setRead("log", {
    found: true,
    type: "text",
    content: "OUTPUT\n" + "line\n".repeat(30),
  });
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /log \(text\)/);
  assert.match(wb.t.captureCharFrame(), /OUTPUT/);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Details · Resources/);
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /OUTPUT/);
});

for (const kind of ["transcript", "output"] as const) {
  test(`m10-workbench-interaction: the inline details route preserves ${kind} focus and resource selection during publication and resize`, async () => {
    const run = kind === "transcript" ? transcriptRun() : inspectableRun();
    const wb = await mountWorkbench(run, 100, 40);
    wb.control.setRead("log", {
      found: true,
      type: "text",
      content: "HELD_OUTPUT",
    });
    wb.control.setTranscript("", {
      found: true,
      type: "transcript-page",
      entries: txEntries("assistant", "HELD_TRANSCRIPT"),
    });
    await press(wb.t, wb.renderer, "g", { ctrl: true });
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      kind === "transcript" ? /HELD_TRANSCRIPT/ : /HELD_OUTPUT/,
    );
    const added = {
      name: "new-output",
      type: "text" as const,
      reference: {
        runId: "run-1",
        artifactName: "new-output",
        versionId: "new-version",
        type: "text" as const,
      },
    };
    wb.control.setRead("new-output", {
      found: true,
      type: "text",
      content: "WRONG_RESOURCE",
    });
    wb.control.setRun({ ...run, outputs: [added, ...run.outputs] });
    resizeWorkbench(wb.t, wb.renderer, 40, 12);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "escape");
    assert.match(wb.t.captureCharFrame(), /Details · Resources/);
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      kind === "transcript" ? /HELD_TRANSCRIPT/ : /HELD_OUTPUT/,
    );
    assert.doesNotMatch(wb.t.captureCharFrame(), /WRONG_RESOURCE/);
    resizeWorkbench(wb.t, wb.renderer, 100, 40);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "escape");
    assert.match(wb.t.captureCharFrame(), /› Details/);
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      kind === "transcript" ? /HELD_TRANSCRIPT/ : /HELD_OUTPUT/,
    );
  });
}

test("m10-session-history: tool rows expose color-independent outcomes, input and counts through the Renderer Port", async () => {
  const run = runOf({
    sessions: [{ session: "s", name: "Conversation", availability: "open" }],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 44);
  const row = (
    id: string,
    value: SessionHistoryRow["value"],
  ): SessionHistoryRow => ({
    id,
    position: id,
    source: "stored",
    turn: "turn",
    turnStartedAt: "2026-10-06T00:00:00Z",
    value,
  });
  const values: SessionHistoryRow["value"][] = [
    {
      kind: "tool",
      tool: "read",
      input: "file.ts",
      count: { value: 0, unit: "lines" },
      outcome: { kind: "running" },
    },
    {
      kind: "tool",
      tool: "search",
      input: "needle",
      count: { value: 2, unit: "matches" },
      outcome: { kind: "completed" },
    },
    {
      kind: "tool",
      tool: "command",
      input: "run command",
      outcome: { kind: "failed", error: "Observed error" },
    },
    {
      kind: "tool",
      tool: "file-change",
      input: "changed.ts",
      outcome: { kind: "declined", reason: "Observed refusal" },
    },
    {
      kind: "tool",
      tool: "mcp",
      input: "external/tool",
      outcome: { kind: "unconfirmed" },
    },
  ];
  const page = (
    rows: readonly SessionHistoryRow[],
  ): SessionHistorySnapshot => ({
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
  const rows = values.map((value, i) => row(`opaque-${i}`, value));
  control.setHistory(page(rows));
  await t.renderOnce();
  const frame = t.captureCharFrame();
  for (const label of [
    "read · running · 0 lines",
    "search · completed · 2 matches",
    "command · failed",
    "file change · declined",
    "mcp · unconfirmed",
    "file.ts",
    "needle",
    "Observed error",
    "Observed refusal",
  ])
    assert.ok(frame.includes(label), label);
  const long = row("opaque-long", {
    kind: "tool",
    tool: "other",
    input: "START " + "界".repeat(60) + " END",
    outcome: { kind: "unconfirmed" },
  });
  control.setHistory(page([...rows, long]));
  resizeWorkbench(t, renderer, 40, 14);
  await t.renderOnce();
  await press(t, renderer, "end", { alt: true });
  assert.match(t.captureCharFrame(), /END/);
  assert.doesNotMatch(t.captureCharFrame(), /START.*END/);
  await press(t, renderer, "home", { alt: true });
  assert.match(t.captureCharFrame(), /read/);
});

test("m10-audit-ctrl-o-one-row: bottom-most Thought collapse, keyboard expansion, final replacement and resize preserve full content", async () => {
  const run = runOf({
    sessions: [
      { session: "conversation", name: "Conversation", availability: "open" },
    ],
  });
  const wb = await mountWorkbench(run, 100, 26);
  const page = (
    source: "stored" | "preview",
    content: string,
    incomplete?: true,
  ): SessionHistorySnapshot => ({
    family: "session-history",
    runId: run.runId,
    session: "conversation",
    result: {
      found: true,
      history: {
        rows: [
          {
            id: "older-thought",
            position: "earlier",
            source: "stored",
            turnStartedAt: "2026-10-05T00:00:00Z",
            turn: "older-turn",
            value: { kind: "thought", content: "Older heading\nOLDER_BODY" },
          },
          {
            id: "opaque-thought",
            position: "opaque-position",
            source,
            turnStartedAt: "2026-10-06T00:00:00Z",
            turn: "opaque-turn",
            value: {
              kind: "thought",
              content,
              ...(incomplete ? { incomplete } : {}),
            },
          },
        ],
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
  wb.control.setHistory(
    page("preview", "\n  Summary label\nFull body only after expansion"),
  );
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /Thought.*Thinking.*Summary label/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /Full body only/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /OLDER_BODY/);
  assert.match(wb.t.captureCharFrame(), /Full body only after expansion/);
  wb.control.setHistory(
    page(
      "stored",
      "\nSummary label\nAuthoritative replacement at the end",
      true,
    ),
  );
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /Thought.*incomplete/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /Thinking|Full body only/);
  assert.match(wb.t.captureCharFrame(), /Authoritative replacement/);
  resizeWorkbench(wb.t, wb.renderer, 40, 26);
  await wb.t.renderOnce();
  noOverflow(wb.t.captureCharFrame(), 40);
  assert.match(wb.t.captureCharFrame(), /Authoritative replacement/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /OLDER_BODY/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /Authoritative replacement/);
  assert.match(wb.t.captureCharFrame(), /Summary/);
  const heading = wb.t
    .captureCharFrame()
    .split("\n")
    .findIndex(
      (line) => line.includes("▸ Thought") && line.includes("Summary"),
    );
  assert.ok(heading >= 0);
  await wb.t.mockMouse.click(10, heading);
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /Authoritative replacement/);
  resizeWorkbench(wb.t, wb.renderer, 100, 26);
  wb.control.setHistory(
    page("stored", "Thinking through options\nA complete summary body"),
  );
  await wb.t.renderOnce();
  assert.match(
    wb.t.captureCharFrame(),
    /Thought.*complete.*Thinking through options/,
  );
  assert.doesNotMatch(wb.t.captureCharFrame(), /Thinking \|/);
});

for (const visible of [false, true]) {
  test(`m10-session-history: Ctrl+O disarms Interrupt before the next Escape with a Thought ${visible ? "visible" : "absent"}`, async () => {
    let interrupted = 0;
    const actions = okActions({
      interrupt: () => {
        interrupted++;
        return () => ({ kind: "ok" });
      },
    });
    const run = liveTurnRunOf({
      timeline: events(4),
      sessions: [
        { session: "conversation", name: "Conversation", availability: "open" },
      ],
    });
    const { t, renderer, control } = await mountWorkbench(
      run,
      100,
      40,
      actions,
    );
    if (visible) {
      control.setHistory({
        family: "session-history",
        runId: run.runId,
        session: "conversation",
        result: {
          found: true,
          history: {
            rows: [
              {
                id: "thought",
                position: "position",
                source: "preview",
                turnStartedAt: "2026-10-06T00:00:00Z",
                turn: "opaque",
                value: {
                  kind: "thought",
                  content: "Summary label\nExpanded body",
                },
              },
            ],
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
      await t.renderOnce();
      assert.match(t.captureCharFrame(), /Summary label/);
      assert.doesNotMatch(t.captureCharFrame(), /Expanded body/);
    }
    await press(t, renderer, "escape");
    assert.match(t.captureCharFrame(), /Press esc again/);
    await press(t, renderer, "o", { ctrl: true });
    assert.doesNotMatch(t.captureCharFrame(), /Press esc again/);
    if (visible) assert.match(t.captureCharFrame(), /Expanded body/);
    await press(t, renderer, "escape");
    assert.equal(interrupted, 0);
    assert.match(t.captureCharFrame(), /Press esc again/);
    await press(t, renderer, "escape");
    assert.equal(interrupted, 1);
  });
}

test("m10-audit-ctrl-o-one-row: bottom-most cumulative diff collapse and keyboard/click inspection retain the complete large patch across resize", async () => {
  const run = runOf({
    sessions: [
      { session: "conversation", name: "Conversation", availability: "open" },
    ],
  });
  const wb = await mountWorkbench(run, 100, 26, undefined, false, 1);
  const content =
    "DIFF_FIRST\n" + "supplied patch line\n".repeat(2200) + "DIFF_LAST";
  const page: SessionHistorySnapshot = {
    family: "session-history",
    runId: run.runId,
    session: "conversation",
    result: {
      found: true,
      history: {
        rows: [
          {
            id: "older-thought",
            position: "earlier",
            source: "stored",
            turnStartedAt: "2026-10-05T00:00:00Z",
            turn: "older-turn",
            value: { kind: "thought", content: "Older heading\nOLDER_BODY" },
          },
          {
            id: "opaque-diff",
            position: "position",
            source: "stored",
            turnStartedAt: "2026-10-06T00:00:00Z",
            turn: "turn",
            value: {
              kind: "turn-diff",
              content,
              files: [
                { path: "observed.ts" },
                { path: "counts.ts", additions: 0, removals: 7 },
              ],
            },
          },
        ],
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
  };
  wb.control.setHistory(page);
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /Turn diff/);
  assert.match(wb.t.captureCharFrame(), /observed.ts/);
  assert.match(wb.t.captureCharFrame(), /counts.ts.*\+0.*-7/);
  assert.doesNotMatch(
    wb.t.captureCharFrame(),
    /DIFF_FIRST|supplied patch line/,
  );
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /OLDER_BODY/);
  assert.match(wb.t.captureCharFrame(), /DIFF_FIRST/);
  await press(wb.t, wb.renderer, "end");
  assert.match(wb.t.captureCharFrame(), /DIFF_LAST/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /omitted|truncated/);
  const beforeQuit = wb.t.captureCharFrame();
  await press(wb.t, wb.renderer, "q");
  await wb.t.waitForFrame((frame) =>
    frame.includes("Halt 1 live Run and quit?"),
  );
  wb.t.mockInput.pressEnter();
  await wb.t.waitForFrame(
    (frame) => !frame.includes("Halt 1 live Run and quit?"),
  );
  assert.deepEqual(wb.exits, []);
  assert.equal(wb.t.captureCharFrame(), beforeQuit);
  resizeWorkbench(wb.t, wb.renderer, 40, 12);
  await wb.t.renderOnce();
  noOverflow(wb.t.captureCharFrame(), 40);
  await press(wb.t, wb.renderer, "end");
  assert.match(wb.t.captureCharFrame(), /DIFF_LAST/);
  await press(wb.t, wb.renderer, "escape");
  resizeWorkbench(wb.t, wb.renderer, 100, 26);
  await wb.t.renderOnce();
  const heading = wb.t
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes("Turn diff"));
  assert.ok(heading >= 0);
  await wb.t.mockMouse.click(10, heading);
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /DIFF_FIRST/);
  await press(wb.t, wb.renderer, "end");
  assert.match(wb.t.captureCharFrame(), /DIFF_LAST/);
});

test("m10-session-history: per-call structured patches inspect supplied coordinates and full lines, while requested-only calls have no diff affordance", async () => {
  const run = runOf({
    sessions: [
      { session: "conversation", name: "Conversation", availability: "open" },
    ],
  });
  const wb = await mountWorkbench(run, 80, 24);
  const page = (
    supplied: Partial<
      Extract<SessionHistoryRow["value"], { kind: "tool" }>
    > = {},
  ): SessionHistorySnapshot => ({
    family: "session-history",
    runId: run.runId,
    session: "conversation",
    result: {
      found: true,
      history: {
        rows: [
          {
            id: "opaque-call",
            position: "position",
            source: "stored",
            turnStartedAt: "2026-10-06T00:00:00Z",
            turn: "turn",
            value: {
              kind: "tool",
              tool: "file-change",
              input: "requested.ts",
              outcome: { kind: "unconfirmed" },
              ...supplied,
            },
          },
        ],
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
  wb.control.setHistory(page());
  await wb.t.renderOnce();
  const requested = wb.t.captureCharFrame();
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.equal(wb.t.captureCharFrame(), requested);
  const lines = [
    "-PER_CALL_FIRST",
    ...Array.from({ length: 1700 }, () => "+supplied large per-call content"),
    "+PER_CALL_LAST",
  ];
  // Application delivers the call's supplied patch only through its detail text.
  serveHistoryText(wb.control, {
    "call-detail": [
      "Input\nrequested.ts\n\nobserved.ts\n@@ -7,1 +11,1701 @@\n",
      ...lines.map((line) => `${line}\n`),
    ].join(""),
  });
  wb.control.setHistory(
    page({
      files: [{ path: "observed.ts" }],
      fileCount: 1,
      detail: historyText("call-detail"),
    }),
  );
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /observed.ts/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /PER_CALL_FIRST/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /@@ -7,1 \+11,1701 @@/);
  assert.match(wb.t.captureCharFrame(), /PER_CALL_FIRST/);
  await press(wb.t, wb.renderer, "end");
  assert.match(wb.t.captureCharFrame(), /PER_CALL_LAST/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /omitted|truncated/);
});

for (const appearance of ["dark", "light"] as const)
  test(`m10-audit-ctrl-o-one-row: ${appearance} bottom-most command output stays at ten logical lines until Ctrl+O or click, retaining expansion through final replacement`, async () => {
    const run = runOf({
      sessions: [{ session: "s", name: "Conversation", availability: "open" }],
    });
    const base = previewPreferences();
    const preferences: PreferencesView = {
      ...base,
      snapshot: () => ({
        ...base.snapshot(),
        preferences: { theme: "everforest", appearance },
      }),
    };
    const wb = await mountWorkbench(
      run,
      100,
      44,
      undefined,
      true,
      undefined,
      preferences,
    );
    const page = (
      source: "stored" | "preview",
      text: string,
      outcome: Extract<
        SessionHistoryRow["value"],
        { kind: "tool" }
      >["outcome"] = { kind: "running" },
    ): SessionHistorySnapshot => ({
      family: "session-history",
      runId: run.runId,
      session: "s",
      result: {
        found: true,
        history: {
          rows: [
            {
              id: "older-thought",
              position: "earlier",
              source: "stored",
              turnStartedAt: "2026-10-05T00:00:00Z",
              turn: "older-turn",
              value: { kind: "thought", content: "Older heading\nOLDER_BODY" },
            },
            {
              id: "command",
              position: "one",
              source,
              turn: "turn",
              turnStartedAt: "2026-10-06T00:00:00Z",
              value: {
                kind: "tool",
                tool: "command",
                input: "build",
                cwd: "/workspace",
                outcome,
                output: { text, secantDropped: true, incomplete: true },
                nativeOmission: "Harness cut stdout",
                ...(source === "stored" ? { exitCode: 2 } : {}),
              },
            },
          ],
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
    const text = Array.from(
      { length: 13 },
      (_, i) => `OUTPUT_${String(i + 1).padStart(2, "0")}`,
    ).join("\n");
    wb.control.setHistory(page("preview", text));
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /OUTPUT_10/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /OUTPUT_11/);
    assert.match(wb.t.captureCharFrame(), /3 hidden lines/);
    const span = wb.t
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("OUTPUT_05"));
    assert.ok(span);
    assert.deepEqual(
      [span.fg.r, span.fg.g, span.fg.b].map((v) => Math.round(v * 255)),
      hexRgb(PALETTES.find((p) => p.name === "everforest")![appearance]),
    );
    assert.match(wb.t.captureCharFrame(), /Secant.*earlier output dropped/);
    assert.match(wb.t.captureCharFrame(), /Harness cut stdout/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /OLDER_BODY/);
    assert.match(wb.t.captureCharFrame(), /OUTPUT_13/);
    wb.control.setHistory(
      page("stored", text.replaceAll("OUTPUT", "FINAL"), {
        kind: "failed",
        error: "Reported failure",
      }),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /FINAL_13/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /OUTPUT_13/);
    assert.match(wb.t.captureCharFrame(), /Reported failure/);
    assert.match(wb.t.captureCharFrame(), /Exit.*2/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /OLDER_BODY/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /FINAL_11/);
    const heading = wb.t
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("▸ Output"));
    assert.ok(heading >= 0);
    await wb.t.mockMouse.click(10, heading);
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /FINAL_13/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /OLDER_BODY/);
    resizeWorkbench(wb.t, wb.renderer, 40, 44);
    wb.control.setHistory(
      page(
        "preview",
        Array.from({ length: 6 }, () => "word ".repeat(10)).join("\n"),
      ),
    );
    await wb.t.renderOnce();
    // #441 collapses before wrapping: all six logical lines remain visible even
    // when each wraps, and the hidden-line count must not depend on the width.
    assert.doesNotMatch(wb.t.captureCharFrame(), /hidden lines/);
    assert.equal(
      (
        wb.t.captureCharFrame().match(/word word word word word word word/g) ??
        []
      ).length,
      6,
    );
    noOverflow(wb.t.captureCharFrame(), 40);
    resizeWorkbench(wb.t, wb.renderer, 32, 12);
    await wb.t.renderOnce();
    noOverflow(wb.t.captureCharFrame(), 32);
  });

test("m10-audit-steer-stored-when-sent: waiting Steer history renders and settlement replaces its displayed value", async () => {
  const run = liveTurnRunOf({
    sessions: [{ session: "s", name: "Conversation", availability: "open" }],
  });
  const { t, control } = await mountWorkbench(run, 100, 30);
  const page = (
    delivery: Extract<
      SessionHistoryRow["value"],
      { kind: "steer" }
    >["delivery"],
  ): SessionHistorySnapshot => ({
    family: "session-history",
    runId: run.runId,
    session: "s",
    result: {
      found: true,
      history: {
        rows: [
          {
            id: "opaque-steer",
            position: "opaque-position",
            turn: "turn",
            turnStartedAt: "2026-10-06T00:00:00Z",
            source: "stored",
            value: { kind: "steer", content: "Visible guidance", delivery },
          },
        ],
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
  control.setHistory(page("waiting"));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Steer · waiting/);
  assert.match(t.captureCharFrame(), /Visible guidance/);
  control.setHistory(page("within-turn"));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Steer · within-turn/);
  assert.doesNotMatch(t.captureCharFrame(), /Steer · waiting/);
  assert.equal(t.captureCharFrame().split("Visible guidance").length, 2);
});
