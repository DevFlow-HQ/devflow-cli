// PROTOTYPE — throwaway (#247). Three structurally different Run Workbench layouts.
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show } from "solid-js";
import {
  BottomRegion,
  ItemView,
  Line,
  agent,
  expanded,
  theme,
} from "./parts.js";
import type { Item, Scene } from "./scenes.js";

export interface VariantProps {
  scene: Scene;
  items: Item[];
  onSubmit: (text: string) => void;
  scrollRef: (r: unknown) => void;
}

function Transcript(props: {
  items: Item[];
  stepStyle: "rule" | "heading" | "none";
  scrollRef: (r: unknown) => void;
}) {
  return (
    <scrollbox
      ref={props.scrollRef as never}
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      scrollbarOptions={{ visible: false }}
    >
      <For each={props.items}>
        {(item) => <ItemView item={item} stepStyle={props.stepStyle} />}
      </For>
      <box height={1} flexShrink={0} />
    </scrollbox>
  );
}

// ── A — Pure OpenCode mirror: no header, the transcript fills the screen, progress lives in the prompt's meta row. ──
export function VariantA(props: VariantProps) {
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2}>
      <Transcript
        items={props.items}
        stepStyle="rule"
        scrollRef={props.scrollRef}
      />
      <BottomRegion
        bottom={props.scene.bottom}
        progress={props.scene.progress}
        meta="full"
        onSubmit={props.onSubmit}
        draftKey={props.scene.key}
      />
    </box>
  );
}

// ── B — Transcript plus sidebar: Steps, Session, model and context in a 42-column column above 120 columns. ──
export function VariantB(props: VariantProps) {
  const dims = useTerminalDimensions();
  const wide = () => dims().width > 120;
  const t = theme;
  const p = () => props.scene.progress;
  return (
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2}>
        <Transcript
          items={props.items}
          stepStyle="rule"
          scrollRef={props.scrollRef}
        />
        <BottomRegion
          bottom={props.scene.bottom}
          progress={p()}
          meta={wide() ? "model" : "full"}
          onSubmit={props.onSubmit}
          draftKey={props.scene.key}
        />
      </box>
      <Show when={wide()}>
        <box
          width={42}
          flexShrink={0}
          backgroundColor={t().backgroundPanel}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          flexDirection="column"
          gap={1}
        >
          <text fg={t().text} attributes={1}>
            {p().bundle}
          </text>
          <box flexDirection="column">
            <For each={p().steps}>
              {(s) => (
                <Line
                  parts={[
                    [
                      s.state === "done"
                        ? "✓ "
                        : s.state === "current"
                          ? "▸ "
                          : "· ",
                      s.state === "done"
                        ? t().success
                        : s.state === "current"
                          ? agent()
                          : t().textMuted,
                    ],
                    [
                      s.title +
                        (s.state === "current" && p().iteration
                          ? " · " + p().iteration
                          : ""),
                      s.state === "current" ? t().text : t().textMuted,
                      { bold: s.state === "current" },
                    ],
                  ]}
                />
              )}
            </For>
          </box>
          <box flexDirection="column">
            <text fg={t().text} attributes={1}>
              Agent
            </text>
            <Line
              parts={[
                [p().harness + " · " + p().model + " ", t().textMuted],
                [p().effort, t().warning, { bold: true }],
              ]}
            />
            <Show when={p().modelNote}>
              <text fg={t().textMuted}>{"→ " + p().modelNote}</text>
            </Show>
          </box>
          <Show when={p().context}>
            <box flexDirection="column">
              <text fg={t().text} attributes={1}>
                Context
              </text>
              <text fg={t().textMuted}>{p().context! + " used"}</text>
            </box>
          </Show>
          <box flexGrow={1} />
          <text fg={t().textMuted} paddingBottom={1}>
            ctrl+g details
          </text>
        </box>
      </Show>
    </box>
  );
}

// ── C — Step-sectioned: a sticky breadcrumb, a heading per Step, earlier Steps folded to one line each. ──
export function VariantC(props: VariantProps) {
  const t = theme;
  const p = () => props.scene.progress;
  // Fold every Step but the last into its heading plus its closing line.
  const folded = (): Item[] => {
    if (expanded()) return props.items;
    const out: Item[] = [];
    const idx = props.items
      .map((it, i) => (it.kind === "step" ? i : -1))
      .filter((i) => i >= 0);
    const lastStep = idx.at(-1) ?? 0;
    let i = 0;
    while (i < props.items.length) {
      const it = props.items[i]!;
      if (it.kind === "step" && i < lastStep) {
        const next = idx.find((j) => j > i) ?? props.items.length;
        const body = props.items.slice(i + 1, next);
        const close = [...body]
          .reverse()
          .find(
            (b) =>
              b.kind === "agent-call" ||
              b.kind === "gate-answered" ||
              (b.kind === "tool" && b.state === "done"),
          );
        const summary =
          close?.kind === "agent-call"
            ? close.reason
            : close?.kind === "gate-answered"
              ? "You chose " + close.answer
              : close?.kind === "tool"
                ? close.label
                : "";
        out.push({
          kind: "tool",
          icon: "▸",
          label: it.title + " — " + summary,
          state: "done",
        });
        i = next;
        continue;
      }
      out.push(it);
      i++;
    }
    return out;
  };
  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        flexShrink={0}
        flexDirection="row"
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={t().backgroundPanel}
        height={1}
      >
        <For each={p().steps}>
          {(s, i) => (
            <Line
              parts={[
                [i() ? " ▸ " : "", t().textMuted],
                [
                  s.title +
                    (s.state === "current" && p().iteration
                      ? " · " + p().iteration
                      : ""),
                  s.state === "current"
                    ? agent()
                    : s.state === "done"
                      ? t().text
                      : t().textMuted,
                  { bold: s.state === "current" },
                ],
              ]}
            />
          )}
        </For>
        <box flexGrow={1} />
        <text fg={t().textMuted}>{p().bundle}</text>
      </box>
      <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2}>
        <Transcript
          items={folded()}
          stepStyle="heading"
          scrollRef={props.scrollRef}
        />
        <BottomRegion
          bottom={props.scene.bottom}
          progress={p()}
          meta="model"
          onSubmit={props.onSubmit}
          draftKey={props.scene.key}
        />
      </box>
    </box>
  );
}

export const VARIANTS = [
  { key: "A", name: "OpenCode mirror", View: VariantA },
  { key: "B", name: "Transcript + sidebar", View: VariantB },
  { key: "C", name: "Step-sectioned", View: VariantC },
];
