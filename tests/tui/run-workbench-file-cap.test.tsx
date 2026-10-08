import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionHistorySnapshot,
  SessionHistoryValue,
} from "../../src/application/projection-port.js";
import type { PreferencesView } from "../../src/tui/tui.js";
import { PALETTES } from "./palette-expectations.js";
import {
  hexRgb,
  mountWorkbench,
  noOverflow,
  press,
  previewPreferences,
  resizeWorkbench,
  runOf,
  type,
} from "./run-workbench-fixture.js";

// Descending names make a presentation re-sort observable; each path wraps at 40 columns.
const files = Array.from({ length: 300 }, (_, index) => ({
  path: `reported/${String(300 - index).padStart(3, "0")}/a-long-directory-name/exact-file.ts`,
  kind: "update" as const,
  patch: { kind: "unified" as const, content: `+PATCH_${index}\n` },
}));
const content = files
  .map((file) => `${file.path}\n${file.patch.content}`)
  .join("\n");

function history(
  value: SessionHistoryValue,
  source: "stored" | "preview",
): SessionHistorySnapshot {
  return {
    family: "session-history",
    runId: "run-1",
    session: "s",
    result: {
      found: true,
      history: {
        rows: [
          {
            id: "file-row",
            position: "one",
            source,
            turn: "turn",
            turnStartedAt: "2026-10-08T00:00:00Z",
            value,
          },
        ],
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

function value(
  kind: "turn-diff" | "tool",
  count: number,
  running: boolean,
): SessionHistoryValue {
  const selected = files.slice(0, count);
  return kind === "turn-diff"
    ? { kind, files: selected, content }
    : {
        kind,
        tool: "file-change",
        input: selected.map((file) => `update ${file.path}`).join("; "),
        files: running ? selected.map(({ path }) => ({ path })) : selected,
        outcome: { kind: running ? "running" : "completed" },
      };
}

function assertNames(frame: string, count: number) {
  const compact = frame.replace(/\s/g, "");
  assert.deepEqual(
    compact.match(/reported\/\d{3}\/a-long-directory-name\/exact-file\.ts/g),
    files.slice(0, Math.min(count, 10)).map((file) => file.path),
  );
  assert.doesNotMatch(frame, /PATCH_/);
}

for (const appearance of ["dark", "light"] as const) {
  for (const kind of ["turn-diff", "tool"] as const) {
    test(`m10-audit-changed-file-cap: ${appearance} ${kind} caps live and final lists across narrow, 120/121 and wide resize`, async () => {
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
          sessions: [
            { session: "s", name: "Conversation", availability: "open" },
          ],
        }),
        100,
        80,
        undefined,
        true,
        undefined,
        preferences,
      );
      for (const width of [40, 120, 121, 160]) {
        resizeWorkbench(wb.t, wb.renderer, width, 80);
        for (const count of [0, 10, 11, 300]) {
          wb.control.setHistory(history(value(kind, count, true), "preview"));
          await wb.t.renderOnce();
          const frame = wb.t.captureCharFrame();
          if (count === 0) assert.match(frame, /Changed files not reported/);
          else assertNames(frame, count);
          const compact = frame.replace(/\s/g, "");
          if (count <= 10) assert.doesNotMatch(frame, /more files/);
          else
            assert.ok(
              compact.includes(
                `${kind === "turn-diff" ? "Turndiff·updating" : "Tool·filechange·running"}·${count - 10}morefiles`,
              ),
            );
          noOverflow(frame, width);
        }
        wb.control.setHistory(history(value(kind, 300, false), "stored"));
        await wb.t.renderOnce();
        const final = wb.t.captureCharFrame();
        assertNames(final, 300);
        assert.match(final, /290 more files/);
        assert.doesNotMatch(
          final.replace(/\s/g, ""),
          /Turndiff·updating|filechange·running/,
        );
        assert.ok(
          final
            .replace(/\s/g, "")
            .includes(
              `${kind === "turn-diff" ? "▸Turndiff" : "▸Tool·filechange·completed"}·290morefiles`,
            ),
        );
        const span = wb.t
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("reported/300/"));
        assert.ok(span);
        assert.deepEqual(
          [span.fg.r, span.fg.g, span.fg.b].map((v) => Math.round(v * 255)),
          hexRgb(PALETTES.find((p) => p.name === "everforest")![appearance]),
        );
      }
      // Short terminals still window full wrapped rows and preserve the prompt's native focus.
      resizeWorkbench(wb.t, wb.renderer, 40, 12);
      await wb.t.renderOnce();
      noOverflow(wb.t.captureCharFrame(), 40);
      await type(wb.t, "draft");
      assert.match(wb.t.captureCharFrame(), /> draft/);
      await press(wb.t, wb.renderer, "home", { alt: true });
      assert.match(wb.t.captureCharFrame(), /Jump to latest/);
      await press(wb.t, wb.renderer, "end", { alt: true });
      assert.doesNotMatch(wb.t.captureCharFrame(), /Jump to latest/);
    });
  }
}

for (const kind of ["turn-diff", "tool"] as const) {
  test(`m10-audit-changed-file-cap: ${kind} keyboard and click inspect all 300 files and complete supplied patches`, async () => {
    const wb = await mountWorkbench(
      runOf({
        sessions: [
          { session: "s", name: "Conversation", availability: "open" },
        ],
      }),
      120,
      40,
    );
    wb.control.setHistory(history(value(kind, 300, false), "stored"));
    await wb.t.renderOnce();
    for (const route of ["key", "click"]) {
      if (route === "key") await press(wb.t, wb.renderer, "o", { ctrl: true });
      else {
        const heading = wb.t
          .captureCharFrame()
          .split("\n")
          .findIndex((line) =>
            line.includes(kind === "turn-diff" ? "▸ Turn diff" : "▸ Tool"),
          );
        assert.ok(heading >= 0);
        await wb.t.mockMouse.click(10, heading);
        await wb.t.renderOnce();
      }
      assert.match(wb.t.captureCharFrame(), /PATCH_0\b/);
      const seen = new Set<string>();
      let previous = "";
      for (;;) {
        const frame = wb.t.captureCharFrame();
        for (const path of frame.match(
          /reported\/\d{3}\/a-long-directory-name\/exact-file\.ts/g,
        ) ?? [])
          seen.add(path);
        assert.doesNotMatch(frame, /truncated|omitted/);
        if (frame === previous) break;
        previous = frame;
        await press(wb.t, wb.renderer, "pagedown");
      }
      assert.deepEqual(
        [...seen],
        files.map((file) => file.path),
      );
      assert.match(wb.t.captureCharFrame(), /PATCH_299\b/);
      resizeWorkbench(wb.t, wb.renderer, 40, 12);
      await wb.t.renderOnce();
      await press(wb.t, wb.renderer, "end");
      assert.match(wb.t.captureCharFrame(), /PATCH_299\b/);
      await press(wb.t, wb.renderer, "escape");
      resizeWorkbench(wb.t, wb.renderer, 120, 40);
      await wb.t.renderOnce();
      assertNames(wb.t.captureCharFrame(), 300);
    }
  });
}
