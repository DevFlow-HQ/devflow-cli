import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "./renderer-fixture.js";
import type { App } from "../../src/tui/tui.js";
import type {
  SessionHistoryRow,
  SessionHistorySnapshot,
  SessionHistoryValue,
} from "../../src/application/projection-port.js";
import {
  hexRgb,
  mountWorkbench,
  noOverflow,
  previewPreferences,
  resizeWorkbench,
  runOf,
  press,
  type,
  interactiveRunOf,
  openAppThemes,
  freeTextRunOf,
  requestOverlay,
} from "./run-workbench-fixture.js";

function row(
  id: string,
  value: SessionHistoryValue,
  source: SessionHistoryRow["source"] = "stored",
): SessionHistoryRow {
  return {
    id,
    position: id,
    turn: "turn",
    turnStartedAt: "2026-10-08T00:00:00Z",
    source,
    value,
  };
}

function page(rows: readonly SessionHistoryRow[]): SessionHistorySnapshot {
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

const conversation = () =>
  runOf({
    sessions: [{ session: "s", name: "Conversation", availability: "open" }],
  });
const presentationRows = () => [
  row("entry", { kind: "entry-prompt", content: "BUNDLE_FIRST\nBUNDLE_LAST" }),
  row("human", { kind: "message", role: "user", content: "HUMAN_MESSAGE" }),
  row("steer", { kind: "steer", delivery: "waiting", content: "HUMAN_STEER" }),
  row("assistant", {
    kind: "message",
    role: "assistant",
    content: "ASSISTANT_TEXT",
  }),
  row(
    "running",
    {
      kind: "tool",
      tool: "read",
      input: "RUNNING_TOOL",
      outcome: { kind: "running" },
    },
    "preview",
  ),
  row("completed", {
    kind: "tool",
    tool: "search",
    input: "SETTLED_TOOL",
    outcome: { kind: "completed" },
  }),
  row("failed", {
    kind: "tool",
    tool: "command",
    input: "FAILED_TOOL",
    outcome: { kind: "failed", error: "TOOL_FAILURE" },
  }),
  row("declined", {
    kind: "tool",
    tool: "web",
    input: "DECLINED_TOOL",
    outcome: { kind: "declined", reason: "Permission declined" },
  }),
  row("unconfirmed", {
    kind: "tool",
    tool: "mcp",
    input: "UNCONFIRMED_TOOL",
    outcome: { kind: "unconfirmed" },
  }),
  row("thought", { kind: "thought", content: "THOUGHT_SUMMARY" }),
  row("call", {
    kind: "agent-call",
    call: "step_done",
    reason: "AGENT_REASON",
    reply: "accepted",
    disposition: "completed",
  }),
  row("turn", {
    kind: "turn-result",
    origin: "human",
    result: "completed",
    harness: "Fake Harness",
    model: "fake-model",
    durationMs: 123,
  }),
];

type Workbench = Awaited<ReturnType<typeof mountWorkbench>>;
function span(wb: Workbench, text: string) {
  const found = wb.t
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  assert.ok(found, `missing span ${text}\n${wb.t.captureCharFrame()}`);
  return found;
}
function rgb(color: { r: number; g: number; b: number }) {
  return [color.r, color.g, color.b].map((channel) =>
    Math.round(channel * 255),
  );
}

for (const appearance of ["dark", "light"] as const) {
  test(`m10-audit-row-presentation: semantic row colours and human panels survive resize in ${appearance}`, async () => {
    const preferences = previewPreferences();
    const wb = await mountWorkbench(
      conversation(),
      160,
      52,
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
    wb.control.setHistory(page(presentationRows()));
    const colors =
      appearance === "dark"
        ? {
            accent: "#d699b6",
            panel: "#333c43",
            muted: "#7a8478",
            error: "#e67e80",
            warning: "#e69875",
            success: "#a7c080",
            text: "#d3c6aa",
          }
        : {
            accent: "#df69ba",
            panel: "#efebd4",
            muted: "#a6b0a0",
            error: "#f85552",
            warning: "#f57d26",
            success: "#8da101",
            text: "#5c6a72",
          };
    for (const width of [160, 121, 120, 40]) {
      resizeWorkbench(wb.t, wb.renderer, width, 52);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      noOverflow(frame, width);
      assert.deepEqual(rgb(span(wb, "┃").fg), hexRgb(colors.accent));
      assert.deepEqual(rgb(span(wb, "HUMAN_MESSAGE").bg), hexRgb(colors.panel));
      assert.deepEqual(rgb(span(wb, "HUMAN_STEER").bg), hexRgb(colors.panel));
      assert.deepEqual(rgb(span(wb, "ASSISTANT_TEXT").fg), hexRgb(colors.text));
      for (const text of [
        "SETTLED_TOOL",
        "DECLINED_TOOL",
        "UNCONFIRMED_TOOL",
        "Secant started the Step",
      ])
        assert.deepEqual(rgb(span(wb, text).fg), hexRgb(colors.muted), text);
      for (const text of ["FAILED_TOOL", "TOOL_FAILURE"])
        assert.deepEqual(rgb(span(wb, text).fg), hexRgb(colors.error), text);
      assert.deepEqual(
        rgb(span(wb, "Thought · complete").fg),
        hexRgb(colors.warning),
      );
      assert.deepEqual(rgb(span(wb, "Agent call").fg), hexRgb(colors.success));
      assert.deepEqual(rgb(span(wb, "Turn ·").fg), hexRgb(colors.accent));
      for (const cue of [
        "You",
        "Steer · waiting",
        "[.] Tool",
        "completed",
        "failed",
        "declined",
        "unconfirmed",
        "Thought · complete",
        "Agent call",
        "Fake Harness",
        "123 ms",
      ])
        assert.ok(frame.includes(cue), cue);
      assert.doesNotMatch(frame, /BUNDLE_FIRST|BUNDLE_LAST/);
    }
  });
}

for (const width of [40, 120, 121]) {
  test(`m10-audit-row-presentation: Entry prompt toggles by key and click without consuming compose input at ${width}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ sessions: conversation().sessions }),
      width,
      32,
      undefined,
      true,
    );
    wb.control.setHistory(
      page([
        row("entry", {
          kind: "entry-prompt",
          content: "FIRST_PROMPT_LINE\nSECOND_PROMPT_LINE\nLAST_PROMPT_LINE",
        }),
      ]),
    );
    await wb.t.renderOnce();
    const collapsed = wb.t.captureCharFrame();
    assert.match(collapsed, /▸ Secant started the Step/);
    assert.doesNotMatch(collapsed, /PROMPT_LINE/);
    await type(wb.t, "draft stays");
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    for (const line of [
      "FIRST_PROMPT_LINE",
      "SECOND_PROMPT_LINE",
      "LAST_PROMPT_LINE",
    ])
      assert.ok(wb.t.captureCharFrame().includes(line), line);
    assert.match(wb.t.captureCharFrame(), /▾ Secant started the Step/);
    assert.match(wb.t.captureCharFrame(), /draft stays/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /PROMPT_LINE/);
    const clickEntry = async () => {
      const heading = wb.t
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Secant started the Step"));
      assert.ok(heading >= 0);
      await wb.t.mockMouse.click(10, heading);
      await wb.t.renderOnce();
    };
    await clickEntry();
    assert.match(wb.t.captureCharFrame(), /LAST_PROMPT_LINE/);
    await clickEntry();
    assert.doesNotMatch(wb.t.captureCharFrame(), /PROMPT_LINE/);
    await press(wb.t, wb.renderer, "g", { ctrl: true });
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /LAST_PROMPT_LINE/,
      "focused details own Ctrl+O",
    );
    await type(wb.t, "must not type");
    await press(wb.t, wb.renderer, "g", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /draft stays/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /must not type/);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /LAST_PROMPT_LINE/);
    await openAppThemes(wb);
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    await press(wb.t, wb.renderer, "escape");
    assert.match(
      wb.t.captureCharFrame(),
      /LAST_PROMPT_LINE/,
      "modal owns Ctrl+O",
    );
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    await press(wb.t, wb.renderer, "return");
    assert.equal(wb.control.sends[0]?.text, "draft stays");
    noOverflow(wb.t.captureCharFrame(), width);
  });
}

test("m10-audit-row-presentation: expanded large Entry content stays complete under scroll, updates and cached resize", async () => {
  const layouts: string[] = [];
  const observe: NonNullable<Parameters<typeof App>[0]["observeLayout"]> = (
    event,
  ) => {
    if (event.kind === "history") layouts.push(event.id);
  };
  const wb = await mountWorkbench(
    conversation(),
    121,
    16,
    undefined,
    true,
    0,
    undefined,
    observe,
  );
  const content = "ENTRY_BEGIN\n" + "界🙂".repeat(8000) + "\nENTRY_END";
  const entry = row("entry", { kind: "entry-prompt", content });
  wb.control.setHistory(page([entry]));
  await wb.t.renderOnce();
  assert.deepEqual(layouts, ["entry"]);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /ENTRY_END/);
  await press(wb.t, wb.renderer, "home", { alt: true });
  assert.match(wb.t.captureCharFrame(), /ENTRY_BEGIN/);
  for (let i = 0; i < 4; i++)
    await press(wb.t, wb.renderer, "down", { alt: true });
  const anchor = wb.t.captureCharFrame().split("\n")[1]?.slice(0, 77);
  assert.match(anchor ?? "", /界🙂/);
  layouts.length = 0;
  wb.control.setHistory(
    page([
      entry,
      row("tail", { kind: "activity", description: "NEW_ACTIVITY" }),
    ]),
  );
  await wb.t.renderOnce();
  assert.equal(wb.t.captureCharFrame().split("\n")[1]?.slice(0, 77), anchor);
  assert.match(wb.t.captureCharFrame(), /Jump to latest/);
  assert.deepEqual(layouts, ["tail"]);
  layouts.length = 0;
  resizeWorkbench(wb.t, wb.renderer, 121, 20);
  await wb.t.renderOnce();
  assert.deepEqual(layouts, [], "height-only resize reuses layout");
  for (const width of [40, 120, 121]) {
    resizeWorkbench(wb.t, wb.renderer, width, 16);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "end", { alt: true });
    assert.match(wb.t.captureCharFrame(), /ENTRY_END/);
    noOverflow(wb.t.captureCharFrame(), width);
  }
  layouts.length = 0;
  wb.control.setHistory(
    page([
      row("entry", {
        kind: "entry-prompt",
        content: "REPLACED_BEGIN\nREPLACED_END",
      }),
    ]),
  );
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /REPLACED_BEGIN[\s\S]*REPLACED_END/);
  assert.deepEqual(layouts, ["entry"]);
  await press(wb.t, wb.renderer, "o", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /REPLACED_BEGIN|REPLACED_END/);
});

test("m10-audit-row-presentation: running tools animate without layout work and settle in place using semantic state", async () => {
  const layouts: string[] = [];
  const observe: NonNullable<Parameters<typeof App>[0]["observeLayout"]> = (
    event,
  ) => {
    if (event.kind === "history") layouts.push(event.id);
  };
  const wb = await mountWorkbench(
    conversation(),
    100,
    24,
    undefined,
    false,
    0,
    undefined,
    observe,
  );
  const tool = row(
    "tool",
    {
      kind: "tool",
      tool: "read",
      input: "STABLE_TOOL",
      outcome: { kind: "running" },
    },
    "preview",
  );
  const assistant = row("assistant", {
    kind: "message",
    role: "assistant",
    content: "Tool · command · failed\nSecant started the Step",
  });
  wb.control.setHistory(page([tool, assistant]));
  await wb.t.renderOnce();
  layouts.length = 0;
  const firstMark = wb.t
    .captureCharFrame()
    .match(/([|/\\-]) Tool · read · running/)?.[1];
  assert.ok(firstMark);
  wb.t.renderer.start();
  await until(() => {
    const mark = wb.t
      .captureCharFrame()
      .match(/([|/\\-]) Tool · read · running/)?.[1];
    return mark !== undefined && mark !== firstMark;
  });
  assert.deepEqual(layouts, [], "spinner ticks do not rewrap history");
  wb.control.setHistory(
    page([
      row("tool", {
        kind: "tool",
        tool: "read",
        input: "STABLE_TOOL",
        outcome: { kind: "completed" },
      }),
      assistant,
    ]),
  );
  await wb.t.renderOnce();
  assert.deepEqual(layouts, ["tool"]);
  await wb.t.waitForFrame((frame) => frame.includes("Tool · read · completed"));
  assert.doesNotMatch(wb.t.captureCharFrame(), /Tool · read · running/);
  assert.match(wb.t.captureCharFrame(), /Tool · read · completed/);
  assert.deepEqual(rgb(span(wb, "STABLE_TOOL").fg), hexRgb("#7a8478"));
  assert.deepEqual(
    rgb(span(wb, "Tool · command · failed").fg),
    hexRgb("#d3c6aa"),
    "message wording never determines its colour",
  );
  layouts.length = 0;
  resizeWorkbench(wb.t, wb.renderer, 100, 28);
  await wb.t.renderOnce();
  assert.deepEqual(layouts, []);
});

for (const interaction of ["request", "gate"] as const) {
  test(`m10-audit-row-presentation: Entry controls remain reachable while a ${interaction} owns the bottom`, async () => {
    const wb = await mountWorkbench(
      interaction === "gate"
        ? freeTextRunOf({ sessions: conversation().sessions })
        : conversation(),
      100,
      32,
      undefined,
      true,
    );
    if (interaction === "request") wb.control.setLive(requestOverlay());
    wb.control.setHistory(
      page([
        row("entry", { kind: "entry-prompt", content: "ENTRY_WITH_CONTROL" }),
      ]),
    );
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "o", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /ENTRY_WITH_CONTROL/);
    const heading = wb.t
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Secant started the Step"));
    await wb.t.mockMouse.click(10, heading);
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /ENTRY_WITH_CONTROL/);
    assert.equal(wb.control.sends.length, 0);
    assert.equal(wb.control.requests.length, 0);
    assert.equal(wb.control.texts.length, 0);
    if (interaction === "gate") {
      await type(wb.t, "gate answer");
      await press(wb.t, wb.renderer, "return");
      assert.equal(wb.control.texts[0]?.text, "gate answer");
    } else {
      await press(wb.t, wb.renderer, "return");
      assert.equal(wb.control.requests[0]?.decision, "allow");
    }
  });
}
