import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreferencesView } from "../../src/tui/tui.js";
import type {
  SessionHistoryRow,
  SessionHistorySnapshot,
  SessionHistoryValue,
} from "../../src/application/projection-port.js";
import {
  mountWorkbench,
  previewPreferences,
  freeTextRunOf,
  interactiveRunOf,
  requestOverlay,
  type,
  noOverflow,
  press,
  resizeWorkbench,
  runOf,
} from "./run-workbench-fixture.js";

function row(id: string, value: SessionHistoryValue): SessionHistoryRow {
  return {
    id,
    position: id,
    source: "stored",
    turn: "turn",
    turnStartedAt: "2026-10-08T00:00:00Z",
    value,
  };
}
function thought(id: string): SessionHistoryRow {
  return row(id, { kind: "thought", content: `${id} heading\n${id} body` });
}
function output(id: string, text: string): SessionHistoryRow {
  return row(id, {
    kind: "tool",
    tool: "command",
    input: id,
    outcome: { kind: "completed" },
    output: { text },
  });
}
function history(rows: readonly SessionHistoryRow[]): SessionHistorySnapshot {
  return {
    family: "session-history",
    runId: "run-1",
    session: "s",
    result: {
      found: true,
      history: {
        rows,
        hasEarlier: false,
        transcriptPage: {
          type: "transcript-page",
          runId: "run-1",
          session: "s",
        },
        transcriptExport: {
          type: "transcript-export",
          runId: "run-1",
          session: "s",
        },
      },
    },
  };
}
async function mount(
  rows: readonly SessionHistoryRow[],
  width = 100,
  height = 40,
  appearance: "dark" | "light" = "dark",
) {
  const base = previewPreferences();
  const preferences: PreferencesView = {
    ...base,
    snapshot: () => ({
      ...base.snapshot(),
      preferences: { theme: "everforest", appearance },
    }),
  };
  const wb = await mountWorkbench(
    runOf({
      sessions: [{ session: "s", name: "Conversation", availability: "open" }],
    }),
    width,
    height,
    undefined,
    true,
    undefined,
    preferences,
  );
  wb.control.setHistory(history(rows));
  await wb.t.renderOnce();
  return wb;
}

for (const appearance of ["dark", "light"] as const) {
  for (const width of [40, 120, 121, 160]) {
    for (const paused of [false, true]) {
      test(`m10-audit-ctrl-o-one-row: ${appearance} ${width} columns ${paused ? "paused" : "live"} opens the bottom qualifying row and skips empty detail`, async () => {
        const wb = await mount(
          [
            thought("older"),
            thought("newer"),
            output("short", "one\ntwo\nthree"),
            row("empty", { kind: "thought", content: "\u001b[31m\u001b[0m" }),
            row("empty-entry", { kind: "entry-prompt", content: "" }),
          ],
          width,
          40,
          appearance,
        );
        if (paused) await press(wb.t, wb.renderer, "home", { alt: true });
        const before = wb.t.captureCharFrame();
        await press(wb.t, wb.renderer, "o", { ctrl: true });
        const opened = wb.t.captureCharFrame();
        assert.match(opened, /newer body/);
        assert.doesNotMatch(opened, /older body|▾ Output/);
        assert.equal(/Paused|Jump to latest/.test(opened), paused);
        await press(wb.t, wb.renderer, "o", { ctrl: true });
        assert.equal(wb.t.captureCharFrame(), before);
        noOverflow(opened, width);
      });
    }
  }
}
for (const width of [40, 160]) {
  test(`m10-audit-ctrl-o-one-row: ${width} remembered close survives arrival and scrolling out of view`, async () => {
    const original = [thought("older"), thought("opened")];
    const wb = await mount(original, width, 20);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /opened body/);
    const rows = [
      ...original,
      ...Array.from({ length: 30 }, (_, index) =>
        row(`plain-${index}`, {
          kind: "message",
          role: "assistant",
          content: `arrival ${index}`,
        }),
      ),
      thought("latest"),
    ];
    wb.control.setHistory(history(rows));
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /opened heading|opened body/);
    assert.match(wb.t.captureCharFrame(), /latest headi/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /latest body/);
    await press(wb.t, wb.renderer, "home", { alt: true });
    assert.match(wb.t.captureCharFrame(), /opened headi/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /opened body|older body/);
    await press(wb.t, wb.renderer, "end", { alt: true });
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /latest body/);
    // Scrolling away without new history must also leave the remembered close first.
    await press(wb.t, wb.renderer, "home", { alt: true });
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /opened body|older body/);
    await press(wb.t, wb.renderer, "end", { alt: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /latest body/);
  });
}

test("m10-audit-ctrl-o-one-row: click close and row eviction reset the remembered target", async () => {
  const original = [thought("older"), thought("opened")];
  const wb = await mount(original);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  const line = wb.t
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes("▾ Thought") && line.includes("opened"));
  assert.ok(line >= 0);
  await wb.t.mockMouse.click(10, line);
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /opened body/);
  wb.control.setHistory(history([...original, thought("latest")]));
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /latest body/);
  // Removing and later reintroducing the same id does not restore a remembered expansion.
  wb.control.setHistory(history(original));
  await wb.t.renderOnce();
  wb.control.setHistory(
    history([...original, thought("latest"), thought("newest")]),
  );
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /newest body/);
  assert.doesNotMatch(
    wb.t.captureCharFrame(),
    /latest body|opened body|older body/,
  );
  wb.control.setHistory(history([]));
  await wb.t.renderOnce();
  const empty = wb.t.captureCharFrame();
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.equal(wb.t.captureCharFrame(), empty);
});

for (const width of [40, 120, 121, 160]) {
  for (const paused of [false, true]) {
    test(`m10-audit-ctrl-o-one-row: ${width} ${paused ? "paused anchor" : "live edge"} survives output growth and dual resize`, async () => {
      const text = Array.from(
        { length: 80 },
        (_, index) => `OUTPUT_${index}`,
      ).join("\n");
      const wb = await mount(
        [thought("older"), output("stream", text)],
        width,
        28,
      );
      if (paused) await press(wb.t, wb.renderer, "home", { alt: true });
      const top = () => wb.t.captureCharFrame().split("\n").slice(1, 4);
      const before = top();
      await press(wb.t, wb.renderer, "o", { ctrl: true });
      const frame = wb.t.captureCharFrame();
      assert.equal(/Paused|Jump to latest/.test(frame), paused);
      if (paused) {
        assert.deepEqual(top(), before);
        assert.doesNotMatch(frame, /OUTPUT_79/);
      } else assert.match(frame, /OUTPUT_79/);
      for (const resized of [40, 120, 121, 160, width]) {
        resizeWorkbench(wb.t, wb.renderer, resized, 28);
        await wb.t.renderOnce();
        const resizedFrame = wb.t.captureCharFrame();
        assert.equal(/Paused|Jump to latest/.test(resizedFrame), paused);
        if (paused) assert.match(resizedFrame.split("\n")[1]!, /Conversation/);
        else assert.match(resizedFrame, /OUTPUT_79/);
        noOverflow(resizedFrame, resized);
      }
      await press(wb.t, wb.renderer, "o", { ctrl: true });
      assert.match(wb.t.captureCharFrame(), /70 hidden lines/);
      assert.doesNotMatch(wb.t.captureCharFrame(), /older body/);
    });
  }
}

test("m10-audit-ctrl-o-one-row: sanitized code-point collapse and resize decide eligibility without changing a short output glyph", async () => {
  const long = output("characters", "😀".repeat(500));
  const short = output(
    "short",
    "\u001b[31mone\u001b[0m\ntwo\nthree" + "\u0000".repeat(3000),
  );
  const wb = await mount([long, short], 40, 50);
  assert.match(wb.t.captureCharFrame().replace(/\s/g, ""), /hiddencharacters/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.doesNotMatch(
    wb.t.captureCharFrame().replace(/\s/g, ""),
    /hiddencharacters/,
  );
  assert.match(wb.t.captureCharFrame(), /▾ Output/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  resizeWorkbench(wb.t, wb.renderer, 160, 50);
  await wb.t.renderOnce();
  assert.doesNotMatch(
    wb.t.captureCharFrame().replace(/\s/g, ""),
    /hiddencharacters/,
  );
  const wide = wb.t.captureCharFrame();
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.equal(wb.t.captureCharFrame(), wide);
  resizeWorkbench(wb.t, wb.renderer, 40, 50);
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.doesNotMatch(
    wb.t.captureCharFrame().replace(/\s/g, ""),
    /hiddencharacters/,
  );
});

for (const kind of ["turn-diff", "tool"] as const) {
  test(`m10-audit-ctrl-o-one-row: capped ${kind} opens complete inspection, consumes Ctrl+O, and leaves no remembered row`, async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      path: `file-${index}.ts`,
      patch: { kind: "unified" as const, content: `+PATCH_${index}` },
    }));
    const value: SessionHistoryValue =
      kind === "turn-diff"
        ? {
            kind,
            files,
            content: files
              .map((file) => `${file.path}\n${file.patch.content}`)
              .join("\n"),
          }
        : {
            kind,
            tool: "file-change",
            input: "requested",
            files,
            outcome: { kind: "completed" },
          };
    const original = [thought("older"), thought("opened")];
    const wb = await mount(original, 100, 40);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /opened body/);
    wb.control.setHistory(history([...original, row("patch", value)]));
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /290 more files/);
    // Closing the remembered in-place row takes precedence over opening a new inspection.
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /opened body|PATCH_0/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /PATCH_0/);
    const inspecting = wb.t.captureCharFrame();
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.equal(wb.t.captureCharFrame(), inspecting);
    await press(wb.t, wb.renderer, "end");
    assert.match(wb.t.captureCharFrame(), /file-299.ts|PATCH_299/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /truncated|omitted/);
    await press(wb.t, wb.renderer, "escape");
    assert.doesNotMatch(wb.t.captureCharFrame(), /PATCH_299/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /PATCH_0/);
    await press(wb.t, wb.renderer, "escape");
    wb.control.setHistory(
      history([
        ...original,
        row("running", {
          kind: "tool",
          tool: "file-change",
          input: "requested",
          files: files.map(({ path }) => ({ path })),
          outcome: { kind: "running" },
        }),
      ]),
    );
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /opened body/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /PATCH_0/);
  });
}

for (const kind of ["request", "gate"] as const) {
  test(`m10-audit-ctrl-o-one-row: ${kind} routes bottom-most Entry expansion while retaining native control focus`, async () => {
    const sessions = [
      { session: "s", name: "Conversation", availability: "open" as const },
    ];
    const wb = await mountWorkbench(
      kind === "gate"
        ? freeTextRunOf({ sessions })
        : interactiveRunOf({ sessions }),
      121,
      32,
    );
    wb.control.setHistory(
      history([
        thought("older"),
        row("entry", {
          kind: "entry-prompt",
          content: "ENTRY_FIRST\nENTRY_LAST",
        }),
        output("short", "one\ntwo\nthree"),
      ]),
    );
    if (kind === "request") wb.control.setLive(requestOverlay());
    await wb.t.renderOnce();
    if (kind === "gate") await type(wb.t, "gate draft");
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /ENTRY_LAST/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /older body|▾ Output/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /ENTRY_FIRST|ENTRY_LAST/);
    if (kind === "gate") {
      await type(wb.t, " preserved");
      assert.match(wb.t.captureCharFrame(), /gate draft preserved/);
    }
    assert.deepEqual(wb.control.requests, []);
    assert.deepEqual(wb.control.texts, []);
    assert.deepEqual(wb.control.sends, []);
  });
}

test("m10-audit-ctrl-o-one-row: paused targeting includes a partial output row and skips newer rows below the viewport", async () => {
  const text = Array.from({ length: 13 }, (_, index) => `PART_${index}`).join(
    "\n",
  );
  const wb = await mount(
    [thought("older"), output("partial", text), thought("newer")],
    40,
    12,
  );
  await press(wb.t, wb.renderer, "home", { alt: true });
  assert.match(wb.t.captureCharFrame(), /Command · partial/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /newer headi/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /▾ Output/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /older body|newer body/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /▸ Output/);
  await press(wb.t, wb.renderer, "end", { alt: true });
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /newer body/);
  noOverflow(wb.t.captureCharFrame(), 40);
});
