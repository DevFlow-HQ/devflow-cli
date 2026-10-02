// PROTOTYPE — throwaway (#247). Row and panel renderers the three layouts share. A shared row is
// fine; each variant owns its own layout (variants.tsx).
import { RGBA, SyntaxStyle } from "@opentui/core";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  DEFAULT_THEMES,
  resolveTheme,
  type Theme,
} from "../../src/tui/vendor/theme.js";
import type { Bottom, Item, Progress } from "./scenes.js";

// ── Prototype state (in memory only). ──
export const THEME_NAMES = [
  "everforest",
  "nord",
  "tokyonight",
  "catppuccin",
  "gruvbox",
  "one-dark",
  "rosepine",
  "kanagawa",
  "dracula",
  "flexoki",
];
export const [themeName, setThemeName] = createSignal("everforest");
export const theme = createMemo<Theme>(() =>
  resolveTheme(DEFAULT_THEMES[themeName()]!, "dark"),
);
export const [showThoughts, setShowThoughts] = createSignal(true);
export const [expanded, setExpanded] = createSignal(false);
export const [interruptArmed, setInterruptArmed] = createSignal(false);

/** The agent colour: OpenCode's user bar, footer square, prompt bar, and scanner. */
export const agent = () => theme().secondary;

const mdStyle = createMemo(() => {
  const t = theme();
  return SyntaxStyle.fromStyles({
    default: { fg: t.markdownText },
    conceal: { fg: t.textMuted },
    "markup.heading": { fg: t.markdownHeading, bold: true },
    "markup.strong": { fg: t.markdownStrong, bold: true },
    "markup.italic": { fg: t.markdownEmph, italic: true },
    "markup.raw": { fg: t.markdownCode },
    "markup.link": { fg: t.markdownLink, underline: true },
    "markup.link.label": { fg: t.markdownLinkText },
    "markup.link.url": { fg: t.markdownLink, underline: true },
    "markup.list": { fg: t.markdownListItem },
    "markup.quote": { fg: t.markdownBlockQuote, italic: true },
    "markup.strikethrough": { fg: t.textMuted },
  });
});

// One-string <text> per span (src/tui/AGENTS.md: mixed children garble a line), so a multi-colour
// line is a row of single-string texts.
export function Line(props: {
  parts: [string, RGBA?, { bold?: boolean; dim?: boolean }?][];
  indent?: number;
}) {
  return (
    <box flexDirection="row" flexShrink={0} paddingLeft={props.indent ?? 0}>
      <For each={props.parts}>
        {([s, fg, o]) => (
          <text
            fg={fg ?? theme().text}
            attributes={(o?.bold ? 1 : 0) | (o?.dim ? 2 : 0)}
          >
            {s}
          </text>
        )}
      </For>
    </box>
  );
}

// ── Working indicator: OpenCode's 8-cell "Knight Rider" scanner, agent colour with a fading trail. ──
export function Scanner() {
  const [tick, setTick] = createSignal(0);
  const id = setInterval(() => setTick((n) => n + 1), 60);
  onCleanup(() => clearInterval(id));
  const cells = () => {
    const n = 8;
    const period = 2 * (n - 1);
    const p = tick() % period;
    const head = p < n ? p : period - p;
    return Array.from({ length: n }, (_, i) => Math.abs(i - head));
  };
  return (
    <box flexDirection="row" flexShrink={0}>
      <For each={cells()}>
        {(d) => {
          const c = agent();
          const a = d === 0 ? 1 : d === 1 ? 0.6 : d === 2 ? 0.3 : 0.15;
          return (
            <text fg={RGBA.fromValues(c.r, c.g, c.b, a)}>
              {d <= 2 ? "■" : "⬝"}
            </text>
          );
        }}
      </For>
    </box>
  );
}

export function Spinner(props: { fg?: RGBA }) {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const [i, setI] = createSignal(0);
  const id = setInterval(() => setI((n) => (n + 1) % frames.length), 80);
  onCleanup(() => clearInterval(id));
  return <text fg={props.fg ?? theme().text}>{frames[i()]!}</text>;
}

// ── Transcript items. `compactStep` lets a layout draw Step boundaries its own way. ──
export function ItemView(props: {
  item: Item;
  stepStyle: "rule" | "heading" | "none";
}) {
  const t = theme;
  const it = props.item;
  switch (it.kind) {
    case "step":
      if (props.stepStyle === "none") return null;
      if (props.stepStyle === "heading")
        return (
          <box flexShrink={0} marginTop={1} flexDirection="column">
            <Line
              parts={[
                ["━━ ", t().borderActive],
                [it.title, t().text, { bold: true }],
                ["  " + it.detail, t().textMuted],
              ]}
            />
          </box>
        );
      return (
        <box flexShrink={0} marginTop={1}>
          <Line
            parts={[
              ["── " + it.title + " ", t().textMuted],
              ["· " + it.detail, t().textMuted, { dim: true }],
            ]}
          />
        </box>
      );
    case "entry":
      return (
        <box flexShrink={0} marginTop={1} paddingLeft={3}>
          <Line
            parts={[
              ["▸ ", t().textMuted],
              [
                "Secant started the Step with the " + it.step + " prompt",
                t().textMuted,
              ],
              [" · " + it.lines + " lines", t().textMuted, { dim: true }],
            ]}
          />
          <Show when={expanded()}>
            <text fg={t().textMuted} paddingLeft={2}>
              {it.preview}
            </text>
          </Show>
        </box>
      );
    case "user": {
      const badge =
        it.steer === "waiting"
          ? " waiting for the agent"
          : it.steer === "dropped"
            ? " not delivered · back in your draft"
            : it.steer === "delivered"
              ? " read by the agent"
              : "";
      return (
        <box flexShrink={0} marginTop={1} flexDirection="row">
          <box
            width={1}
            backgroundColor={it.steer === "dropped" ? t().textMuted : agent()}
          />
          <box
            flexGrow={1}
            backgroundColor={t().backgroundPanel}
            paddingLeft={2}
            paddingTop={1}
            paddingBottom={1}
            flexDirection="column"
          >
            <text fg={it.steer === "dropped" ? t().textMuted : t().text}>
              {it.text}
            </text>
            <Show when={badge}>
              <text
                fg={it.steer === "waiting" ? t().warning : t().textMuted}
                attributes={it.steer === "waiting" ? 1 : 0}
              >
                {(it.steer === "waiting"
                  ? "◌"
                  : it.steer === "dropped"
                    ? "✗"
                    : "✓") + badge}
              </text>
            </Show>
          </box>
        </box>
      );
    }
    case "assistant":
      return (
        <box flexShrink={0} marginTop={1} paddingLeft={3}>
          <markdown
            content={it.md}
            syntaxStyle={mdStyle()}
            streaming={it.streaming ?? false}
            conceal
          />
        </box>
      );
    case "thought":
      return (
        <Show when={showThoughts()}>
          <box
            flexShrink={0}
            marginTop={1}
            paddingLeft={3}
            flexDirection="column"
          >
            <Show
              when={!it.live}
              fallback={
                <box flexDirection="row">
                  <Spinner fg={t().warning} />
                  <text fg={t().warning}>{" Thinking: " + it.title}</text>
                </box>
              }
            >
              <Line
                parts={[
                  ["+ Thought: ", t().warning, { dim: true }],
                  [it.title, t().warning, { dim: true }],
                  [" · " + it.secs + "s", t().textMuted],
                ]}
              />
            </Show>
            <Show when={expanded()}>
              <text fg={t().textMuted} paddingLeft={2}>
                {it.body}
              </text>
            </Show>
          </box>
        </Show>
      );
    case "tool": {
      const failed = it.state === "failed";
      return (
        <box flexShrink={0} paddingLeft={3} flexDirection="column">
          <box flexDirection="row">
            <Show
              when={it.state === "running"}
              fallback={
                <text fg={failed ? t().error : t().textMuted}>
                  {it.icon + " "}
                </text>
              }
            >
              <Spinner />
              <text> </text>
            </Show>
            <text
              fg={
                failed
                  ? t().error
                  : it.state === "running"
                    ? t().text
                    : t().textMuted
              }
            >
              {it.label}
            </text>
          </box>
          <Show when={failed && it.error}>
            <text fg={t().error} paddingLeft={2}>
              {it.error!}
            </text>
          </Show>
        </box>
      );
    }
    case "shell": {
      const limit = 10;
      const long = it.output.length > limit;
      const shown = expanded() || !long ? it.output : it.output.slice(0, limit);
      const status = it.running
        ? ""
        : it.exit === 0
          ? ""
          : " · exit " + it.exit;
      return (
        <box
          flexShrink={0}
          marginTop={1}
          marginLeft={3}
          backgroundColor={t().backgroundPanel}
          paddingLeft={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexDirection="row">
            <Show when={it.running}>
              <Spinner />
              <text> </text>
            </Show>
            <text fg={t().text}>{"$ " + it.command}</text>
            <text fg={it.exit ? t().error : t().textMuted}>{status}</text>
          </box>
          <For each={shown}>
            {(l) => (
              <text
                fg={
                  l.startsWith("✗") || l.includes("error:")
                    ? t().error
                    : t().text
                }
              >
                {l || " "}
              </text>
            )}
          </For>
          <Show when={long}>
            <text fg={t().textMuted}>
              {expanded()
                ? "ctrl+o collapse"
                : "… " +
                  (it.output.length - limit) +
                  " more lines · ctrl+o expand"}
            </text>
          </Show>
        </box>
      );
    }
    case "edit":
      return (
        <box
          flexShrink={0}
          marginTop={1}
          marginLeft={3}
          backgroundColor={t().backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <text fg={t().textMuted} paddingLeft={2}>
            {"← Edit " + it.path}
          </text>
          <For each={it.diff}>
            {(l) => {
              const add = l.startsWith("+");
              const del = l.startsWith("-");
              const hunk = l.startsWith("@@");
              return (
                <box
                  backgroundColor={
                    add
                      ? t().diffAddedBg
                      : del
                        ? t().diffRemovedBg
                        : t().diffContextBg
                  }
                  paddingLeft={2}
                >
                  <text
                    fg={
                      add
                        ? t().diffAdded
                        : del
                          ? t().diffRemoved
                          : hunk
                            ? t().diffHunkHeader
                            : t().diffContext
                    }
                  >
                    {l}
                  </text>
                </box>
              );
            }}
          </For>
        </box>
      );
    case "turn-end":
      return (
        <box flexShrink={0} marginTop={1} paddingLeft={3}>
          <Line
            parts={[
              ["▣ ", it.interrupted ? t().textMuted : agent()],
              [it.harness, t().text],
              [" · " + it.model + " · " + fmt(it.secs), t().textMuted],
              [it.interrupted ? " · interrupted" : "", t().warning],
            ]}
          />
        </box>
      );
    case "agent-call":
      return (
        <box
          flexShrink={0}
          marginTop={1}
          paddingLeft={3}
          flexDirection="column"
        >
          <Line
            parts={[
              ["✓ ", t().success],
              ["The agent called " + it.call, t().success, { bold: true }],
              ["  " + it.outcome, t().textMuted],
            ]}
          />
          <text fg={t().textMuted} paddingLeft={2}>
            {"“" + it.reason + "”"}
          </text>
        </box>
      );
    case "gate-answered":
      return (
        <box flexShrink={0} marginTop={1} paddingLeft={3}>
          <Line
            parts={[
              ["◆ ", t().primary],
              [it.title + "  ", t().textMuted],
              ["You chose " + it.answer, t().text, { bold: true }],
            ]}
          />
        </box>
      );
    case "notice":
      return (
        <box flexShrink={0} marginTop={1} flexDirection="row">
          <box
            width={1}
            backgroundColor={
              it.tone === "error"
                ? t().error
                : it.tone === "warning"
                  ? t().warning
                  : t().info
            }
          />
          <text fg={t().text} paddingLeft={2}>
            {it.text}
          </text>
        </box>
      );
  }
}

export const fmt = (s: number) =>
  s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";

// ── The bottom region: exactly one control, in fixed precedence (OpenCode's rule, kept by #23). ──
export function BottomRegion(props: {
  bottom: Bottom;
  progress: Progress;
  meta: "full" | "model";
  onSubmit: (text: string) => void;
  draftKey: string;
}) {
  const t = theme;
  return (
    <box flexShrink={0} flexDirection="column">
      <Show when={props.bottom.kind === "prompt"}>
        <Prompt
          bottom={props.bottom as Extract<Bottom, { kind: "prompt" }>}
          progress={props.progress}
          meta={props.meta}
          onSubmit={props.onSubmit}
          draftKey={props.draftKey}
        />
      </Show>
      <Show when={props.bottom.kind === "request"}>
        {(() => {
          const b = props.bottom as Extract<Bottom, { kind: "request" }>;
          return (
            <Panel
              bar={t().warning}
              head={[
                ["△ Permission required  ", t().warning, { bold: true }],
                [b.title, t().text],
              ]}
            >
              <For each={b.body}>
                {(l) => (
                  <text fg={l.startsWith("$") ? t().text : t().textMuted}>
                    {l || " "}
                  </text>
                )}
              </For>
              <Choices choices={b.choices} fg={t().warning} />
              <Line parts={[["←→ choose  enter confirm", t().textMuted]]} />
            </Panel>
          );
        })()}
      </Show>
      <Show when={props.bottom.kind === "gate"}>
        {(() => {
          const b = props.bottom as Extract<Bottom, { kind: "gate" }>;
          return (
            <Panel
              bar={t().primary}
              head={[
                ["◆ Workflow decision  ", t().primary, { bold: true }],
                [b.title, t().text, { bold: true }],
              ]}
            >
              <text fg={t().text}>{b.message}</text>
              <Choices
                choices={[...b.suggestions, "Type another…"]}
                fg={t().primary}
              />
              <Line parts={[["↑↓ choose  enter answer", t().textMuted]]} />
            </Panel>
          );
        })()}
      </Show>
      <Show when={props.bottom.kind === "checkpoint"}>
        {(() => {
          const b = props.bottom as Extract<Bottom, { kind: "checkpoint" }>;
          return (
            <Panel
              bar={t().primary}
              head={[["◆ Review checkpoint", t().primary, { bold: true }]]}
            >
              <text fg={t().text}>{b.message}</text>
              <For each={b.facts}>
                {(f) => <text fg={t().textMuted}>{"· " + f}</text>}
              </For>
              <Choices
                choices={["Continue 50 more", "Stop the Run"]}
                fg={t().primary}
              />
            </Panel>
          );
        })()}
      </Show>
      <Show when={props.bottom.kind === "finished"}>
        {(() => {
          const b = props.bottom as Extract<Bottom, { kind: "finished" }>;
          return (
            <Panel
              bar={t().success}
              head={[["✓ " + b.outcome, t().success, { bold: true }]]}
            >
              <For each={b.facts}>{(f) => <text fg={t().text}>{f}</text>}</For>
              <Line
                parts={[
                  ["Run ", t().textMuted],
                  [b.runId, t().text],
                ]}
              />
              <Line
                parts={[["enter Previous Runs  ·  q quit", t().textMuted]]}
              />
            </Panel>
          );
        })()}
      </Show>
    </box>
  );
}

function Panel(props: {
  bar: RGBA;
  head: [string, RGBA?, { bold?: boolean }?][];
  children: unknown;
}) {
  return (
    <box flexDirection="row" flexShrink={0} marginTop={1}>
      <box width={1} backgroundColor={props.bar} />
      <box
        flexGrow={1}
        backgroundColor={theme().backgroundPanel}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        gap={1}
      >
        <Line parts={props.head} />
        {props.children as never}
      </box>
    </box>
  );
}

function Choices(props: { choices: string[]; fg: RGBA }) {
  return (
    <box flexDirection="row" gap={2}>
      <For each={props.choices}>
        {(c, i) => (
          <box
            backgroundColor={i() === 0 ? props.fg : theme().backgroundElement}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={i() === 0 ? theme().background : theme().textMuted}>
              {c}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

function Prompt(props: {
  bottom: Extract<Bottom, { kind: "prompt" }>;
  progress: Progress;
  meta: "full" | "model";
  onSubmit: (text: string) => void;
  draftKey: string;
}) {
  const t = theme;
  let ref:
    { plainText: string; setText(s: string): void; focus(): void } | undefined;
  const p = () => props.progress;
  const modelLine = (): [string, RGBA?, { bold?: boolean }?][] => [
    [p().harness + " ", t().text],
    [p().model + " ", t().textMuted],
    [p().effort, t().warning, { bold: true }],
    [p().modelNote ? "  → " + p().modelNote : "", t().textMuted],
  ];
  return (
    <box flexShrink={0} flexDirection="column" marginTop={1}>
      <Show when={props.bottom.note}>
        <box flexDirection="row" marginBottom={1}>
          <box width={1} backgroundColor={t().warning} />
          <text fg={t().text} paddingLeft={2}>
            {props.bottom.note!}
          </text>
        </box>
      </Show>
      <box flexDirection="row">
        <box width={1} backgroundColor={agent()} />
        <box
          flexGrow={1}
          backgroundColor={t().backgroundElement}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          flexDirection="column"
        >
          <textarea
            ref={(r: unknown) => {
              ref = r as typeof ref;
              queueMicrotask(() => {
                ref?.setText(props.bottom.draft ?? "");
                ref?.focus();
              });
            }}
            placeholder={props.bottom.placeholder}
            placeholderColor={t().textMuted}
            textColor={t().text}
            focusedTextColor={t().text}
            backgroundColor={t().backgroundElement}
            focusedBackgroundColor={t().backgroundElement}
            minHeight={1}
            maxHeight={6}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
              { name: "j", ctrl: true, action: "newline" },
            ]}
            onSubmit={() => {
              const text = ref?.plainText.trim() ?? "";
              if (!text) return;
              ref?.setText(""); // clears at once: no "sending…" state
              props.onSubmit(text);
            }}
          />
          <box paddingTop={1} paddingBottom={1} flexDirection="row">
            <Show
              when={props.meta === "full"}
              fallback={<Line parts={modelLine()} />}
            >
              <Line
                parts={[
                  [
                    p().step +
                      (p().iteration ? " · " + p().iteration : "") +
                      "  ",
                    agent(),
                    { bold: true },
                  ],
                  ...modelLine(),
                ]}
              />
            </Show>
          </box>
        </box>
      </box>
      <box flexDirection="row" height={1} paddingLeft={1}>
        <Show when={props.bottom.working}>
          <Scanner />
          <text> </text>
        </Show>
        <Show
          when={!interruptArmed()}
          fallback={<text fg={t().primary}>esc again to interrupt</text>}
        >
          <Line
            parts={props.bottom.hints.flatMap((h, i) => {
              const [k, ...rest] = h.split(" ");
              return [
                [(i ? "   " : "") + k + " ", t().text],
                [rest.join(" "), t().textMuted],
              ] as [string, RGBA][];
            })}
          />
        </Show>
        <box flexGrow={1} />
        <Show when={p().context && props.meta === "full"}>
          <text fg={t().textMuted}>{p().context!}</text>
        </Show>
      </box>
    </box>
  );
}
