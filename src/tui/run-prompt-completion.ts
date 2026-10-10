import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type Accessor,
} from "solid-js";
import type {
  ProjectionPort,
  WorkspacePathCandidate,
  WorkspacePathSearch,
  WorkspacePathProgress,
} from "../application/projection-port.js";
import type { useAppCommands } from "./app-commands.js";
import { clip } from "./clip.js";
import { searchCommands } from "./command-search.js";
import type { RendererKeyEvent } from "./renderer/renderer.js";
import type {
  MentionReplacement,
  PromptHint,
  PromptModel,
} from "./run-workbench-views.js";

type ListRow = NonNullable<PromptModel["commands"]>[number];

/** What Enter does with the text while a list shows no candidate. */
type EnterAction = "send" | "steer" | "working" | "none";
const ENTER_CUE: Record<EnterAction, string> = {
  send: "↵ send",
  steer: "↵ steer",
  working: "working",
  none: "",
};
const LIST_MAX_ROWS = 6;

/** A Slash entry whose name or alias starts with the typed prefix. */
const namesPrefix = (
  entry: { slash?: string; aliases?: readonly string[] },
  prefix: string,
) =>
  [entry.slash, ...(entry.aliases ?? [])].some((name) =>
    name?.startsWith(prefix),
  );

/** What a key did to an open list: consumed it, or chose a Slash entry the
 *  Workbench dispatches. */
type CompletionKey = { kind: "handled" } | { kind: "run"; id: string };

/** The prompt's two completion lists, the `/` Slash list and the `@` Workspace
 *  path list: open and dismissed state, selection, keys, rows and the list hint.
 *  The Workbench keeps precedence and dispatch, and asks this controller
 *  (tui-compose.md). The native editor owns text and cursor. */
export function createPromptCompletion(props: {
  draft: Accessor<string>;
  caret: Accessor<number>;
  runId: Accessor<string | undefined>;
  /** The prompt's native field holds the keys. */
  enabled: Accessor<boolean>;
  commands: Pick<ReturnType<typeof useAppCommands>, "entries" | "knownSlash">;
  search: ProjectionPort["searchWorkspacePaths"];
  width: Accessor<number>;
  /** Rows left for the list and the hint once the rest is counted. */
  space: Accessor<number>;
  /** The ordinary prompt hint, or none without a prompt. */
  hint: Accessor<PromptHint | undefined>;
  enter: Accessor<EnterAction>;
}) {
  const { draft } = props;

  const [slashDismissed, setSlashDismissed] = createSignal<string>();
  const [slashSelection, setSlashSelection] = createSignal<{
    draft: string;
    id: string;
  }>();
  const slashOpen = () =>
    props.enabled() &&
    draft().startsWith("/") &&
    !/\s/.test(draft()) &&
    slashDismissed() !== draft();
  const slashMatches = () =>
    slashOpen()
      ? searchCommands(
          props.commands.entries().filter((entry) => entry.slash !== undefined),
          draft().slice(1),
        )
      : [];
  const slashActive = () => {
    const rows = slashMatches();
    const selected = slashSelection();
    if (selected?.draft === draft())
      return rows.find((entry) => entry.id === selected.id);
    const prefix = draft().slice(1).toLowerCase();
    return rows.find((entry) => namesPrefix(entry, prefix));
  };
  createEffect(
    on(draft, (text) => {
      setSlashDismissed(undefined);
      const prefix = text.slice(1).toLowerCase();
      const entry = slashMatches().find((entry) => namesPrefix(entry, prefix));
      setSlashSelection(
        entry === undefined ? undefined : { draft: text, id: entry.id },
      );
    }),
  );

  const mentions = createWorkspaceMentions({
    draft,
    caret: props.caret,
    runId: props.runId,
    enabled: () =>
      props.enabled() &&
      !slashOpen() &&
      props.commands.knownSlash(draft()) === undefined,
    selectionVisible: () => drawn().some((row) => row.kind === "candidate"),
    search: props.search,
  });

  const list = (): { hint: PromptHint; rows: readonly ListRow[] } => {
    const hint = props.hint();
    if (hint === undefined)
      return { hint: { kind: "lines", lines: [], tone: "muted" }, rows: [] };
    const width = props.width();
    const mention = mentions.open();
    // An open path list always draws one hint row; the Slash list keeps the
    // ordinary hint and adds its own key row.
    const hintRows = mention || hint.kind === "working" ? 1 : hint.lines.length;
    const budget = Math.min(
      LIST_MAX_ROWS,
      Math.max(0, props.space() - hintRows - (mention ? 1 : 2)),
    );
    if (mention) return mentionView(hint, budget, width);
    const rows = slashMatches();
    const active = slashActive();
    const index = rows.findIndex((entry) => entry.id === active?.id);
    const start = Math.max(0, index - budget + 1);
    const list = rows
      .slice(start, start + budget)
      .map((entry) =>
        clip(
          `${entry.id === active?.id ? "› " : "  "}/${entry.slash} · ${entry.name}${entry.keyHint ? ` (${entry.keyHint})` : ""}`,
          width,
        ),
      );
    return {
      hint,
      rows:
        list.length === 0
          ? []
          : [
              ...list.map((text) => ({ kind: "candidate" as const, text })),
              {
                kind: "status",
                text: clip("↑/↓ select · enter/tab run · esc close", width),
              },
            ],
    };
  };

  const mentionView = (ordinary: PromptHint, budget: number, width: number) => {
    const candidates = mentions.candidates();
    const result = mentions.result();
    const notice = result?.status === "available" ? result.notice : undefined;
    const indexing = result !== undefined && "indexing" in result;
    const indexingLine = "Still indexing Workspace…";
    const statuses = [
      ...(notice === undefined ? [] : [notice]),
      ...(indexing && candidates.length > 0 ? [indexingLine] : []),
    ];
    // A selectable path, or the empty-result explanation, owns the first row.
    const statusBudget = Math.min(statuses.length, Math.max(0, budget - 1));
    const listBudget = Math.max(0, budget - statusBudget);
    const start = Math.max(0, mentions.selection() - listBudget + 1);
    const rows: ListRow[] = candidates
      .slice(start, start + listBudget)
      .map((candidate) => ({
        kind: "candidate",
        text: clip(
          `${candidate === mentions.active() ? "› " : "  "}@${candidate.path}${candidate.kind === "folder" ? "/" : ""} · ${candidate.kind}`,
          width,
        ),
      }));
    if (rows.length === 0 && budget > 0)
      rows.push({
        kind: "status",
        text: clip(
          result?.status === "unavailable"
            ? "Path search unavailable · enter sends text"
            : indexing
              ? indexingLine
              : result === undefined
                ? "Searching Workspace paths…"
                : "No path suggestions · enter sends text",
          width,
        ),
      });
    rows.push(
      ...statuses.slice(0, statusBudget).map((line) => ({
        kind: "status" as const,
        text: clip(line, width),
      })),
    );
    const compact =
      statusBudget < statuses.length
        ? notice !== undefined
          ? "100k cap"
          : "indexing"
        : undefined;
    // The hint promises only what the keys do: insert needs a drawn path.
    const enter = [compact, ENTER_CUE[props.enter()]]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    const line =
      candidates.length > 0
        ? compact !== undefined
          ? `${compact} ↑↓ ↵/tab esc`
          : "↑↓ ↵/tab insert · esc"
        : enter === ""
          ? "esc"
          : `${enter} · esc`;
    return budget === 0
      ? { hint: ordinary, rows: [] }
      : {
          hint: {
            kind: "lines" as const,
            tone: "muted" as const,
            lines: [clip(line, width)],
          },
          rows,
        };
  };

  const drawn = () => list().rows;
  const slashVisible = () => slashOpen() && drawn().length > 0;
  const mentionsVisible = () => mentions.open() && drawn().length > 0;

  function handleKey(key: RendererKeyEvent): CompletionKey | undefined {
    if (key.ctrl || key.alt || key.shift) return undefined;
    if (slashVisible()) {
      if (key.name === "escape") {
        setSlashDismissed(draft());
        return { kind: "handled" };
      }
      if (key.name === "up" || key.name === "down") {
        const rows = slashMatches();
        const index = rows.findIndex((entry) => entry.id === slashActive()?.id);
        const entry =
          rows[
            Math.max(
              0,
              Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1)),
            )
          ];
        if (entry) setSlashSelection({ draft: draft(), id: entry.id });
        return { kind: "handled" };
      }
      if (key.name === "return" || key.name === "tab") {
        const active = slashActive();
        if (active !== undefined) return { kind: "run", id: active.id };
        // A withdrawn selection is refused, never replaced by another entry.
        const held = slashSelection();
        if (held?.draft === draft()) return { kind: "run", id: held.id };
      }
    }
    return mentionsVisible() && mentions.handleKey(key)
      ? { kind: "handled" }
      : undefined;
  }

  return {
    /** The list rows and the hint the prompt draws. */
    list,
    /** A candidate row is drawn, so the Port owns the arrows. */
    listOpen: () => drawn().some((row) => row.kind === "candidate"),
    handleKey,
    replacement: mentions.replacement,
    replaced: mentions.replaced,
  };
}

/** Path completion owns tokens and reply lifetimes; the native editor owns text/cursor. */
function createWorkspaceMentions(input: {
  draft: Accessor<string>;
  caret: Accessor<number>;
  runId: Accessor<string | undefined>;
  enabled: Accessor<boolean>;
  selectionVisible: Accessor<boolean>;
  search: ProjectionPort["searchWorkspacePaths"];
}) {
  const [dismissed, setDismissed] = createSignal<string>();
  const [reply, setReply] = createSignal<{
    key: string;
    result: WorkspacePathSearch | WorkspacePathProgress;
  }>();
  const [selection, setSelection] = createSignal(0);
  const [replacement, setReplacement] = createSignal<MentionReplacement>();
  const current = createMemo(() => {
    const runId = input.runId();
    if (!input.enabled() || runId === undefined) return;
    const text = input.draft();
    const caret = input.caret();
    const token = tokenAt(text, caret);
    if (token === undefined) return;
    const key = JSON.stringify([runId, text, caret, token.start, token.end]);
    return {
      ...token,
      runId,
      key,
      identity: JSON.stringify([
        runId,
        token.start,
        text.slice(0, token.start),
      ]),
    };
  });
  const identity = createMemo(() => {
    const value = current();
    return value === undefined || value.key === dismissed()
      ? undefined
      : value.identity;
  });
  const lifetime = createMemo(() =>
    identity() === undefined ? undefined : new AbortController(),
  );
  createEffect(() => {
    const controller = lifetime();
    onCleanup(() => controller?.abort());
  });
  createEffect(() => {
    const value = current();
    const controller = lifetime();
    setSelection(0);
    if (value === undefined || controller === undefined) return;
    let disposed = false;
    let settled = false;
    onCleanup(() => {
      disposed = true;
    });
    const receive = (result: WorkspacePathSearch | WorkspacePathProgress) => {
      if (disposed || settled) return;
      const selected = active();
      const index =
        result.status === "available" && selected !== undefined
          ? result.candidates.findIndex(
              (candidate) =>
                candidate.path === selected.path &&
                candidate.kind === selected.kind,
            )
          : -1;
      setReply({ key: value.key, result });
      setSelection((previous) =>
        index >= 0
          ? index
          : Math.max(0, Math.min(previous, candidates().length - 1)),
      );
    };
    // Coalesce typing bursts; query cleanup discards replies, never the token list.
    const timer = setTimeout(() => {
      void input
        .search({
          runId: value.runId,
          query: value.query,
          signal: controller.signal,
          onProgress: receive,
        })
        .then(
          (result) => {
            receive(result);
            settled = true;
          },
          (cause) => {
            receive({ status: "unavailable", cause });
            settled = true;
          },
        );
    }, 75);
    onCleanup(() => clearTimeout(timer));
  });
  const open = () => current() !== undefined && current()?.key !== dismissed();
  const result = () =>
    open() && reply()?.key === current()?.key ? reply()?.result : undefined;
  const candidates = () => {
    const value = result();
    return value?.status === "available" ? value.candidates : [];
  };
  const active = () => candidates()[selection()];
  function handleKey(key: RendererKeyEvent): boolean {
    if (!open() || key.ctrl || key.alt || key.shift) return false;
    if (key.name === "escape") {
      setDismissed(current()?.key);
      return true;
    }
    if (key.name === "up" || key.name === "down") {
      if (!input.selectionVisible()) return false;
      setSelection((index) =>
        Math.max(
          0,
          Math.min(
            candidates().length - 1,
            index + (key.name === "up" ? -1 : 1),
          ),
        ),
      );
      return true;
    }
    const candidate = input.selectionVisible() ? active() : undefined;
    const token = current();
    if (
      (key.name === "return" || key.name === "tab") &&
      candidate !== undefined &&
      token !== undefined
    ) {
      setDismissed(token.key);
      setReplacement({
        start: token.start,
        end: token.end,
        text: mentionText(candidate, token.range),
      });
      return true;
    }
    return false;
  }
  const replaced = () => {
    setReplacement(undefined);
    setDismissed(current()?.key);
  };
  return {
    open,
    result,
    candidates,
    selection,
    active,
    replacement,
    replaced,
    handleKey,
  };
}

function tokenAt(text: string, caret: number) {
  // Quoted cues remain one token; a plain word/email never opens completion.
  const pattern = /(?:^|\s)(@(?:"(?:\\.|[^"\n])*"?|[^\s"]*)[^\s]*)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const start = (match.index ?? 0) + match[0].length - raw.length;
    const end = start + raw.length;
    if (caret <= start || caret > end) continue;
    const body = raw.slice(1);
    const quoted = body.startsWith('"');
    let quoteEnd = -1;
    if (quoted) {
      for (let index = 1; index < body.length; index++) {
        if (body[index] === "\\") index++;
        else if (body[index] === '"') {
          quoteEnd = index;
          break;
        }
      }
    }
    const trailingRange = /#L\d+(?:-\d+)?$/.exec(body);
    const rangeAt =
      trailingRange !== null &&
      (!quoted || (quoteEnd > 0 && trailingRange.index > quoteEnd))
        ? trailingRange.index
        : -1;
    const path = rangeAt < 0 ? body : body.slice(0, rangeAt);
    return {
      start,
      end,
      query: quoted
        ? path
            .slice(1, quoteEnd > 0 ? quoteEnd : undefined)
            .replace(/\\(["\\])/g, "$1")
        : path,
      range: rangeAt < 0 ? "" : body.slice(rangeAt),
    };
  }
  return undefined;
}
function mentionText(candidate: WorkspacePathCandidate, range: string): string {
  const path = candidate.path + (candidate.kind === "folder" ? "/" : "");
  const quoted = /[\s#"]/.test(path)
    ? `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : path;
  return `@${quoted}${candidate.kind === "file" ? range : ""}`;
}
