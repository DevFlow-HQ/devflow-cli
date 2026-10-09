import {
  UNTRUSTED_TERMINAL_TEXT as unsafe,
  UNSAFE_TERMINAL_CHARACTERS as bad,
} from "../helpers/terminalText.js";
import type { PreferencesView } from "../../src/tui/tui.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionHistorySnapshot,
  SessionHistoryValue,
} from "../../src/application/projection-port.js";
import {
  mountWorkbench,
  runOf,
  press,
  resizeWorkbench,
  noOverflow,
  requestOverlay,
  type,
  inspectableRun,
  transcriptRun,
  txEntries,
  previewPreferences,
  freeTextRunOf,
} from "./run-workbench-fixture.js";

function history(value: SessionHistoryValue): SessionHistorySnapshot {
  return {
    family: "session-history",
    runId: "run-1",
    session: "s",
    result: {
      found: true,
      history: {
        rows: [
          {
            id: "row",
            position: "pos",
            turn: "turn",
            turnStartedAt: "2026-10-08T00:00:00Z",
            source: "stored",
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

test("m10-audit-screen-control-bytes: messages screen controls and formats before wrapping and preserve bare CR lines", async () => {
  const wb = await mountWorkbench(
    runOf({
      sessions: [{ session: "s", name: "Conversation", availability: "open" }],
    }),
    100,
    30,
  );
  const page = history({
    kind: "message",
    role: "assistant",
    content: unsafe + "\rNEXT\r\nLAST\tTAB",
  });
  wb.control.setHistory(page);
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, bad);
  assert.match(frame, /ABC/);
  assert.match(frame, /NEXT/);
  assert.match(frame, /LAST {2}TAB/);
  const rows = frame.split("\n");
  const message = rows.findIndex((line) => line.includes("ABC"));
  assert.equal(rows[message + 2]?.trim(), "NEXT");
  assert.equal(rows[message + 3]?.trim(), "LAST  TAB");
  assert.doesNotMatch(frame, /example\.com|31m/);
  assert.equal(
    page.result.found &&
      page.result.history.rows[0]?.value.kind === "message" &&
      page.result.history.rows[0].value.content,
    unsafe + "\rNEXT\r\nLAST\tTAB",
  );
  resizeWorkbench(wb.t, wb.renderer, 40, 12);
  await wb.t.renderOnce();
  noOverflow(wb.t.captureCharFrame(), 40);
  await type(wb.t, "draft");
  assert.match(wb.t.captureCharFrame(), /> draft/);
  await press(wb.t, wb.renderer, "home", { alt: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), bad);
});

const fields: readonly {
  field: string;
  value: SessionHistoryValue;
  expand?: true;
  inspect?: true;
}[] = [
  {
    field: "user message",
    value: { kind: "message", role: "user", content: unsafe },
  },
  {
    field: "Steer",
    value: { kind: "steer", content: unsafe, delivery: "waiting" },
  },
  {
    field: "agent call",
    value: {
      kind: "agent-call",
      call: unsafe,
      reason: unsafe,
      reply: "refused",
      refusal: unsafe,
      disposition: "dropped",
    },
  },
  { field: "Request history", value: { kind: "request", description: unsafe } },
  { field: "activity", value: { kind: "activity", description: unsafe } },
  {
    field: "Turn result",
    value: {
      kind: "turn-result",
      origin: "human",
      result: unsafe,
      harness: unsafe,
      model: unsafe,
    },
  },
  {
    field: "Thought body",
    value: { kind: "thought", content: "Summary\n" + unsafe + "\rSECOND" },
    expand: true,
  },
  {
    field: "Thought heading",
    value: { kind: "thought", content: unsafe + "\nBody" },
  },
  {
    field: "command input",
    value: {
      kind: "tool",
      tool: "command",
      input: unsafe,
      outcome: { kind: "completed" },
    },
  },
  {
    field: "tool cwd",
    value: {
      kind: "tool",
      tool: "read",
      input: "file",
      cwd: unsafe,
      outcome: { kind: "completed" },
    },
  },
  {
    field: "tool failure",
    value: {
      kind: "tool",
      tool: "read",
      input: "file",
      outcome: { kind: "failed", error: unsafe },
    },
  },
  {
    field: "tool decline",
    value: {
      kind: "tool",
      tool: "read",
      input: "file",
      outcome: { kind: "declined", reason: unsafe },
    },
  },
  {
    field: "tool count unit",
    value: {
      kind: "tool",
      tool: "search",
      input: "file",
      count: { value: 1, unit: unsafe },
      outcome: { kind: "completed" },
    },
  },
  {
    field: "native omission",
    value: {
      kind: "tool",
      tool: "command",
      input: "build",
      nativeOmission: unsafe,
      outcome: { kind: "completed" },
    },
  },
  {
    field: "command output",
    value: {
      kind: "tool",
      tool: "command",
      input: "build",
      output: { text: unsafe + "\rSECOND\r\nTHIRD\tTAB" },
      outcome: { kind: "completed" },
    },
  },
  {
    field: "structured file name",
    value: {
      kind: "tool",
      tool: "file-change",
      input: "change",
      files: [{ path: unsafe }],
      outcome: { kind: "completed" },
    },
  },
  {
    field: "Turn diff file name",
    value: { kind: "turn-diff", content: "patch", files: [{ path: unsafe }] },
  },
  {
    field: "Turn diff inspection",
    value: {
      kind: "turn-diff",
      content: unsafe + "\rSECOND",
      files: [{ path: "file.ts" }],
    },
    inspect: true,
  },
  {
    field: "call patch inspection",
    value: {
      kind: "tool",
      tool: "file-change",
      input: "change",
      files: [
        {
          path: "file.ts",
          patch: { kind: "unified", content: unsafe + "\rSECOND" },
        },
      ],
      outcome: { kind: "completed" },
    },
    inspect: true,
  },
];

for (const { field, value, expand, inspect } of fields) {
  test(`m10-audit-screen-control-bytes: ${field} screens through Renderer Port frames`, async () => {
    const wb = await mountWorkbench(
      runOf({
        sessions: [
          { session: "s", name: "Conversation", availability: "open" },
        ],
      }),
      100,
      38,
    );
    wb.control.setHistory(history(value));
    await wb.t.renderOnce();
    if (expand || inspect) await press(wb.t, wb.renderer, "o", { ctrl: true });
    const frame = wb.t.captureCharFrame();
    assert.doesNotMatch(frame, bad);
    assert.match(frame, /ABC/);
    assert.doesNotMatch(frame, /example\.com|31m/);
  });
}

for (const appearance of ["dark", "light"] as const) {
  test(`m10-audit-screen-control-bytes: ${appearance} Request input and metadata keep key focus and theme roles across small, 120/121 and wide resize`, async () => {
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
        sessions: [{ session: "s", name: unsafe, availability: "open" }],
        harness: {
          name: unsafe,
          executable: unsafe,
          executableVersion: unsafe,
        },
        effectiveModel: unsafe,
        modelChoice: { model: unsafe, effort: unsafe },
        progress: [{ id: "repair", kind: "agent", status: "running" }],
      }),
      120,
      30,
      undefined,
      true,
      undefined,
      preferences,
    );
    const overlay = requestOverlay();
    wb.control.setLive({
      ...overlay,
      outstanding: [
        { ...overlay.outstanding[0]!, tool: unsafe, input: unsafe + "\rNEXT" },
      ],
      usage: unsafe,
      context: { modelWindows: [{ model: unsafe, limitTokens: 100 }] },
    });
    await wb.t.renderOnce();
    for (const [width, height] of [
      [32, 12],
      [40, 20],
      [80, 30],
      [120, 30],
      [121, 30],
      [160, 30],
    ]) {
      resizeWorkbench(wb.t, wb.renderer, width!, height!);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      assert.doesNotMatch(frame, bad);
      assert.match(frame, /Tool: ABC/);
      assert.match(frame, /Input: ABC NEXT/);
      assert.match(frame, /Allow|Deny/);
      noOverflow(frame, width!);
      await press(wb.t, wb.renderer, "right");
      assert.match(wb.t.captureCharFrame(), /› \[ Deny \]/);
      await press(wb.t, wb.renderer, "left");
      assert.match(wb.t.captureCharFrame(), /› \[ Allow \]/);
    }
    const spans = wb.t.captureSpans().lines.flatMap((line) => line.spans);
    const tool = spans.find((span) => span.text.includes("Tool: ABC"));
    const input = spans.find((span) => span.text.includes("Input: ABC"));
    assert.ok(tool && input);
    assert.notDeepEqual(
      tool.fg,
      input.fg,
      "tool and input retain text and muted theme roles",
    );
    assert.match(wb.t.captureCharFrame(), /Usage · ABC/);
    assert.match(wb.t.captureCharFrame(), /ABC capacity 100 tokens/);
    await press(wb.t, wb.renderer, "g", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), bad);
    assert.match(wb.t.captureCharFrame(), /Observed Harness · ABC/);
    await press(wb.t, wb.renderer, "g", { ctrl: true });
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.requests, [
      { requestId: "req-1", generation: 3, decision: "allow" },
    ]);
  });
}

test("m10-audit-screen-control-bytes: large expanded output, inspection and retained transcript screen content without changing Resource truth", async () => {
  const wb = await mountWorkbench(inspectableRun(), 100, 28);
  const content =
    unsafe + "\rSECOND\r\n" + "large output\n".repeat(2000) + "TAIL" + unsafe;
  const resource = { found: true, type: "text", content } as const;
  wb.control.setRead("log", resource);
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /ABC/);
  assert.match(wb.t.captureCharFrame(), /SECOND/);
  assert.doesNotMatch(wb.t.captureCharFrame(), bad);
  assert.equal(resource.content, content);
  await press(wb.t, wb.renderer, "end");
  assert.match(wb.t.captureCharFrame(), /output truncated/);
  assert.doesNotMatch(wb.t.captureCharFrame(), bad);
  resizeWorkbench(wb.t, wb.renderer, 40, 12);
  await wb.t.renderOnce();
  noOverflow(wb.t.captureCharFrame(), 40);
  assert.doesNotMatch(wb.t.captureCharFrame(), bad);
  await press(wb.t, wb.renderer, "escape");

  wb.control.setRun(transcriptRun());
  wb.control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", unsafe + "\rSECOND\r\nTHIRD\tTAB"),
  });
  resizeWorkbench(wb.t, wb.renderer, 100, 28);
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /Session transcript/);
  assert.match(wb.t.captureCharFrame(), /ABC/);
  assert.match(wb.t.captureCharFrame(), /SECOND/);
  assert.match(wb.t.captureCharFrame(), /THIRD {2}TAB/);
  assert.doesNotMatch(wb.t.captureCharFrame(), bad);
});

test("m10-audit-screen-control-bytes: expanding a large command screens its full output and retains scroll position through resize", async () => {
  const wb = await mountWorkbench(
    runOf({
      sessions: [{ session: "s", name: "Conversation", availability: "open" }],
    }),
    100,
    26,
  );
  wb.control.setHistory(
    history({
      kind: "tool",
      tool: "command",
      input: "build",
      output: {
        text: unsafe + "\n" + "output\n".repeat(1500) + "TAIL" + unsafe,
      },
      outcome: { kind: "completed" },
    }),
  );
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /hidden lines/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /TAILABC/);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  await press(wb.t, wb.renderer, "end", { alt: true });
  assert.match(wb.t.captureCharFrame(), /TAILABC/);
  assert.doesNotMatch(wb.t.captureCharFrame(), bad);
  resizeWorkbench(wb.t, wb.renderer, 40, 12);
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "end", { alt: true });
  noOverflow(wb.t.captureCharFrame(), 40);
  assert.match(wb.t.captureCharFrame(), /TAILABC/);
  assert.doesNotMatch(wb.t.captureCharFrame(), bad);
});

test("m10-audit-screen-control-bytes: authored Gate suggestions screen their native field while submitting the original value", async () => {
  const initial = freeTextRunOf();
  assert.ok(initial.pendingGate);
  const wb = await mountWorkbench(
    runOf({
      ...initial,
      pendingGate: {
        ...initial.pendingGate,
        message: unsafe,
        suggestions: [unsafe],
      },
    }),
    100,
    30,
  );
  await press(wb.t, wb.renderer, "down");
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, bad);
  assert.match(frame, /> ABC/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.texts[0]?.text, unsafe);
});
