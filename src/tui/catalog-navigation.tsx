import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { useBindings } from "./keymap.js";
import { useDialog } from "./vendor/dialog.js";
import { useExit } from "./vendor/exit.js";
import { Panel } from "./vendor/panels.js";
import { scrollVertically } from "./vendor/scroll.js";
import { useTheme } from "./vendor/theme-context.js";

// The navigation both catalogs share (Bundle and Harness, A4): the search query,
// focus across the search, results, and inspector panes, the selection, and the
// bindings. Selection can be empty: arriving from Home focuses search with
// nothing selected, and only Down/PgDn/Tab from search, a list move, or a click
// selects a row. Search keeps ←, →, Home, End, and `/` for its text cursor, so
// every binding that would take one is gated off while search has focus. Rows,
// focus derivation, filters, and inspectors stay with each screen.

type TCatalogEntry = { readonly index: number };

type TCatalogPane = "search" | "list" | "inspector";

type TCatalogNavigationParams<TEntry extends TCatalogEntry> = {
  /** The screen's entries matching `query`, each carrying its row index. */
  filter: (query: string) => readonly TEntry[];
  /** The row selected on arrival; absent, the catalog opens on search with nothing selected. */
  selected?: number;
  /** Told each row the user selects; never told "nothing selected". */
  onSelect?: (index: number) => void;
  onBack: () => void;
  /** The key-group label, e.g. "Harnesses". */
  group: string;
  /** The row noun in the list-pane key descriptions, e.g. "Harness". */
  item: string;
  inspector: () => ScrollBoxRenderable | undefined;
};

const HINTS: Record<TCatalogPane, string> = {
  search: "↓ results · tab switch pane · esc back · ctrl+c quit",
  list: "/ search · ↑/↓ move · tab/→ inspector · esc back · ctrl+c quit",
  inspector:
    "/ search · ↑/↓ scroll · ← results · tab switch pane · esc back · ctrl+c quit",
};

export function useCatalogNavigation<TEntry extends TCatalogEntry>(
  params: TCatalogNavigationParams<TEntry>,
) {
  const exit = useExit();
  const dialog = useDialog();
  const arrival = params.selected;
  const [query, setQuery] = createSignal("");
  const [pane, setPane] = createSignal<TCatalogPane>(
    arrival === undefined ? "search" : "list",
  );
  const [selected, setSelected] = createSignal<number | undefined>(arrival);
  const matching = createMemo(() => params.filter(query()));
  const activeEntry = () => {
    const index = selected();
    return index === undefined
      ? undefined
      : matching().find((entry) => entry.index === index);
  };

  const select = (index: number) => {
    setSelected(index);
    params.onSelect?.(index);
  };
  /** A clicked row: select it and give the list focus. */
  const focusRow = (index: number) => {
    select(index);
    setPane("list");
  };
  /** Down/PgDn from search: the list, selecting the top result even over a kept one. */
  const focusTopResult = () => {
    const first = matching()[0];
    if (first !== undefined) select(first.index);
    setPane("list");
  };
  /** Tab from search: the list, keeping a kept selection and otherwise taking the top. */
  const focusResults = () => {
    if (activeEntry() === undefined) focusTopResult();
    else setPane("list");
  };
  const moveSelection = (delta: number) => {
    const entries = matching();
    const position = entries.findIndex(
      (entry) => entry.index === activeEntry()?.index,
    );
    if (delta < 0 && position <= 0) {
      setPane("search");
      return;
    }
    const entry = entries[Math.min(position + delta, entries.length - 1)];
    if (entry !== undefined) select(entry.index);
  };
  const updateQuery = (value: string) => {
    setQuery(value);
    const index = selected();
    if (!params.filter(value).some((entry) => entry.index === index)) {
      setSelected(undefined);
    }
  };
  const scroll = (delta: number) => scrollVertically(params.inspector(), delta);
  const page = () => Math.max(1, params.inspector()?.viewport.height ?? 1);
  const group = params.group;
  const idle = () => dialog.stack.length === 0;

  useBindings(() => ({
    enabled: idle(),
    bindings: [
      {
        key: "tab",
        desc: "Switch pane",
        group,
        cmd: () => {
          const current = pane();
          if (current === "search") focusResults();
          else setPane(current === "list" ? "inspector" : "search");
        },
      },
      { key: "escape", desc: "Back", group, cmd: params.onBack },
      { key: "ctrl+c", desc: "Quit", group, cmd: () => exit() },
    ],
  }));
  useBindings(() => ({
    enabled: pane() === "search" && idle() && matching().length > 0,
    bindings: [
      {
        key: "down",
        desc: "Focus results",
        group,
        cmd: focusTopResult,
      },
      {
        key: "pagedown",
        desc: "Focus results",
        group,
        cmd: focusTopResult,
      },
    ],
  }));
  useBindings(() => ({
    enabled: pane() !== "search" && idle(),
    bindings: [
      {
        key: "/",
        desc: "Focus search",
        group,
        cmd: () => setPane("search"),
      },
    ],
  }));
  useBindings(() => ({
    enabled: pane() === "list" && idle(),
    bindings: [
      {
        key: "up",
        desc: `Previous ${params.item}`,
        group,
        cmd: () => moveSelection(-1),
      },
      {
        key: "down",
        desc: `Next ${params.item}`,
        group,
        cmd: () => moveSelection(1),
      },
      {
        key: "right",
        desc: "Focus inspector",
        group,
        cmd: () => setPane("inspector"),
      },
    ],
  }));
  useBindings(() => ({
    enabled: pane() === "inspector" && idle(),
    bindings: [
      { key: "up", desc: "Scroll up", group, cmd: () => scroll(-1) },
      { key: "down", desc: "Scroll down", group, cmd: () => scroll(1) },
      {
        key: "pageup",
        desc: "Page inspector up",
        group,
        cmd: () => scroll(-page()),
      },
      {
        key: "pagedown",
        desc: "Page inspector down",
        group,
        cmd: () => scroll(page()),
      },
      {
        key: "left",
        desc: "Focus results",
        group,
        cmd: () => setPane("list"),
      },
    ],
  }));

  return {
    query,
    pane,
    matching,
    activeEntry,
    updateQuery,
    focusRow,
    hint: () => HINTS[pane()],
    /** What the inspector says while no matching row is selected. */
    emptyInspector: () =>
      matching().length === 0
        ? `Clear or change the search to inspect a ${params.item}.`
        : `No ${params.item} selected · ↓ or tab selects a result.`,
  };
}

/**
 * The search pane above the results pane. Search is its own bordered Panel, so
 * its bottom edge is the drawn separator, and each title carries the focus glyph.
 */
export function CatalogSearchAndResults(props: {
  title: string;
  placeholder: string;
  pane: TCatalogPane;
  query: string;
  onInput: (value: string) => void;
  /** The column width beside the inspector; undefined while stacked. */
  width: number | undefined;
  stacked: boolean;
  /** Shown in place of `children` when nothing matches. */
  empty: JSX.Element;
  hasResults: boolean;
  children: JSX.Element;
}) {
  const { theme } = useTheme();
  return (
    <box
      flexDirection="column"
      width={props.stacked ? undefined : props.width}
      height={props.stacked ? 11 : undefined}
      flexShrink={0}
      overflow="hidden"
    >
      <Panel
        title={props.title}
        focused={props.pane === "search"}
        height={3}
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
      >
        <input
          focused={props.pane === "search"}
          value={props.query}
          onInput={props.onInput}
          placeholder={props.placeholder}
          placeholderColor={theme.textMuted}
          cursorColor={theme.accent}
          focusedBackgroundColor={theme.backgroundElement}
          focusedTextColor={theme.text}
        />
      </Panel>
      <Panel
        title="Results"
        focused={props.pane === "list"}
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
      >
        <Show when={props.hasResults} fallback={props.empty}>
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            {props.children}
          </box>
        </Show>
      </Panel>
    </box>
  );
}

export function CatalogEmptyState(props: { title: string; hint: string }) {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" paddingTop={1} flexShrink={0}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.title}
      </text>
      <text fg={theme.textMuted}>{props.hint}</text>
    </box>
  );
}

/**
 * A result row. The selected row follows OpenCode's select dialog: a filled,
 * bold title line (`theme.primary` behind `selectedListItemText` while the list
 * has focus, a muted `backgroundElement` fill otherwise), and it keeps the `› `
 * glyph in every pane so selection never depends on colour.
 */
export function CatalogRow(props: {
  title: string;
  details: readonly string[];
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
}) {
  const { theme } = useTheme();
  const fill = () => {
    if (!props.selected) return undefined;
    return props.focused ? theme.primary : theme.backgroundElement;
  };
  const titleColor = () => {
    if (!props.selected) return theme.textMuted;
    return props.focused ? theme.selectedListItemText : theme.text;
  };
  return (
    <box flexDirection="column" flexShrink={0} onMouseUp={props.onSelect}>
      <box backgroundColor={fill()}>
        <text
          fg={titleColor()}
          attributes={props.selected ? TextAttributes.BOLD : 0}
        >
          {`${props.selected ? "› " : "  "}${props.title}`}
        </text>
      </box>
      <For each={props.details}>
        {(detail) => <text fg={theme.textMuted}>{`  ${detail}`}</text>}
      </For>
    </box>
  );
}
