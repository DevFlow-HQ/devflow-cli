import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { RendererKeyEvent } from "./renderer/renderer.js";
import { clip } from "./clip.js";
import { useBindings } from "./keymap.js";
import { useTheme } from "./vendor/theme-context.js";

export interface SearchEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly keyHint?: string;
  readonly slash?: string;
  readonly aliases?: readonly string[];
  run(): void;
}

/** Every term must match. Name matches precede description matches, with the
 * caller's fixed order breaking ties. Locale and past use never change rank. */
export function searchCommands<T extends SearchEntry>(
  entries: readonly T[],
  query: string,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...entries];
  return entries
    .map((entry, order) => {
      const name = entry.name.toLowerCase();
      const names = [name, entry.slash, ...(entry.aliases ?? [])].filter(
        (name): name is string => name !== undefined,
      );
      const description = entry.description.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (names.some((name) => name === term)) score += 4;
        else if (names.some((name) => name.startsWith(term))) score += 3;
        else if (names.some((name) => name.includes(term))) score += 2;
        else if (description.includes(term)) score += 1;
        else return { entry, order, score: -1 };
      }
      return { entry, order, score };
    })
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((row) => row.entry);
}

export function createCommandSearch(props: {
  entries: Accessor<readonly SearchEntry[]>;
  initial?: string;
  preview?: (entry: SearchEntry) => void;
  modal?: boolean;
  escape(): void;
  quit(): void;
  tab?: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [pane, setPane] = createSignal<"search" | "results">("search");
  const [selected, setSelected] = createSignal<string | undefined>(
    props.initial,
  );
  const matching = createMemo(() => searchCommands(props.entries(), query()));
  const active = () => matching().find((entry) => entry.id === selected());
  const select = (entry: SearchEntry) => {
    setSelected(entry.id);
    props.preview?.(entry);
  };
  const move = (delta: number) => {
    const rows = matching();
    const index =
      pane() === "search"
        ? -1
        : rows.findIndex((entry) => entry.id === selected());
    const entry = rows[Math.max(0, Math.min(index + delta, rows.length - 1))];
    if (entry) {
      setPane("results");
      select(entry);
    }
  };
  const input = (value: string) => {
    setQuery(value);
    setSelected(undefined);
    const first = matching()[0];
    if (props.preview && first) select(first);
  };
  const key = (event: RendererKeyEvent) => {
    if (event.ctrl) {
      if (event.name === "c") {
        if (props.modal) {
          props.quit();
          return;
        }
        if (query().length) {
          input("");
          setPane("search");
        } else props.quit();
      }
      return;
    }
    switch (event.name) {
      case "up":
        move(-1);
        break;
      case "down":
        move(1);
        break;
      case "return":
        active()?.run();
        break;
      case "escape":
        if (props.modal) props.escape();
        else if (pane() === "results") {
          setPane("search");
          setSelected(undefined);
        } else if (query().length) input("");
        else props.escape();
        break;
      case "tab":
        if (props.tab) props.tab();
        else move(1);
        break;
    }
  };
  return {
    query,
    pane,
    matching,
    active,
    input,
    key,
    click(entry: SearchEntry) {
      select(entry);
      entry.run();
    },
  };
}

export function CommandSearch(props: {
  search: ReturnType<typeof createCommandSearch>;
  enabled: boolean;
  portDriven: boolean;
  width: number;
  rows: number;
  hint: string;
}) {
  const { theme } = useTheme();
  const s = props.search;
  useBindings(() => ({
    enabled: props.enabled && !props.portDriven,
    bindings: ["up", "down", "return", "escape", "tab", "ctrl+c"].map(
      (name) => ({
        key: name,
        desc: name,
        group: "Command search",
        cmd: () =>
          s.key(name === "ctrl+c" ? { name: "c", ctrl: true } : { name }),
      }),
    ),
  }));
  const start = () => {
    const index = s
      .matching()
      .findIndex((entry) => entry.id === s.active()?.id);
    return Math.max(0, index - Math.max(1, props.rows) + 1);
  };
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <text fg={theme.textMuted} flexShrink={0}>
        {s.pane() === "search"
          ? "Search commands [focused]"
          : "Search commands"}
      </text>
      <input
        focused={props.enabled}
        value={s.query()}
        onInput={s.input}
        placeholder="Type a name or description"
        placeholderColor={theme.textMuted}
        cursorColor={theme.accent}
        focusedBackgroundColor={theme.backgroundElement}
        focusedTextColor={theme.text}
        flexShrink={0}
      />
      <box flexGrow={1} overflow="hidden">
        <Show
          when={s.matching().length}
          fallback={
            <text fg={theme.textMuted}>
              No matches. Clear or change search.
            </text>
          }
        >
          <For
            each={s
              .matching()
              .slice(start(), start() + Math.max(1, props.rows))}
          >
            {(entry) => (
              <text
                fg={theme.text}
                flexShrink={0}
                wrapMode="none"
                onMouseUp={() => s.click(entry)}
              >
                {clip(
                  `${s.active()?.id === entry.id ? "› " : "  "}${entry.name}${entry.keyHint ? ` (${entry.keyHint})` : ""} · ${entry.description}`,
                  props.width,
                )}
              </text>
            )}
          </For>
        </Show>
      </box>
      <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
        {clip(props.hint, props.width)}
      </text>
    </box>
  );
}
