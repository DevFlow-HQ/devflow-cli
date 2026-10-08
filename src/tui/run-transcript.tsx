import {
  contentAnchorAt,
  resolveContentAnchor,
  type ContentAnchor,
} from "./run-content-anchor.js";
import { useLayoutObserver, type LayoutObserver } from "./layout-observer.js";
import { TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  Index,
  Show,
  untrack,
  type Accessor,
} from "solid-js";
import stripAnsi from "strip-ansi";
import type {
  Problem,
  RunTranscriptEntryView,
  TranscriptPageReference,
  TranscriptExportReference,
  TranscriptRead,
} from "../application/projection-port.js";
import { clip } from "./clip.js";
import { SCROLL_KEYS } from "./run-timeline.js";
import { sessionDivider, stepDivider } from "./run-timeline-rows.js";
import { wrapRows, wrapRules, type Rule } from "./wrap.js";
import type { Theme } from "./vendor/theme.js";

export interface TranscriptTarget {
  readonly label: string;
  readonly sessionName: string;
  readonly transcript: TranscriptPageReference;
  readonly exportReference?: TranscriptExportReference;
}

type Reader = { readonly target: TranscriptTarget } & (
  | {
      readonly kind: "unread";
      readonly entries: readonly [];
      readonly problem: Problem;
      readonly older?: never;
    }
  | {
      readonly kind: "loaded";
      readonly entries: readonly RunTranscriptEntryView[];
      readonly older?: string;
      readonly problem?: Problem;
    }
);

function entryAnnotation(entry: RunTranscriptEntryView): string {
  return `${entry.kind === "steer" ? " · Steer" : entry.kind === "entry-prompt" ? " · Entry prompt" : ""}${entry.incomplete === true ? " · incomplete" : ""}`;
}

type Anchor =
  { readonly mode: "latest" } | ({ readonly mode: "paused" } & ContentAnchor);

/** Retained entries own their wrapped content and attached dividers. Offset zero
 * names the role header; negative offsets name its leading divider lines. Adding
 * a newly known Step/Session divider cannot change the anchored content line. */
function createEntryLayout(observe: LayoutObserver) {
  type Layout = { readonly prefix: number; readonly lines: readonly string[] };
  type Cached = {
    readonly entry: RunTranscriptEntryView;
    readonly rules: readonly Rule[];
    readonly widths: Map<number, Layout>;
  };
  const cache = new Map<string, Cached>();
  return (reader: Reader | undefined, width: number) => {
    if (reader === undefined) {
      cache.clear();
      return [];
    }
    const retained = new Set(reader.entries.map((entry) => entry.id));
    for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id);
    let step: string | undefined;
    let start = 0;
    return reader.entries.map((entry, index) => {
      const rules: Rule[] = [];
      const fromStart = reader.older === undefined;
      if (index === 0 && fromStart)
        rules.push(sessionDivider(reader.target.sessionName));
      if (
        (index > 0 || fromStart) &&
        entry.step !== undefined &&
        entry.step !== step
      )
        rules.push(stepDivider(entry.step));
      step = entry.step ?? step;
      let cached = cache.get(entry.id);
      if (
        cached === undefined ||
        cached.entry !== entry ||
        cached.rules.length !== rules.length ||
        rules.some(
          (rule, i) =>
            rule.glyph !== cached?.rules[i]?.glyph ||
            rule.title !== cached?.rules[i]?.title,
        )
      ) {
        cached = { entry, rules, widths: new Map() };
        cache.set(entry.id, cached);
      }
      let layout = cached.widths.get(width);
      if (layout === undefined) {
        observe({ kind: "transcript", id: entry.id, width });
        const leading = wrapRules(rules, width);
        const header = `${entry.role === "user" ? "◇ User Turn" : "◆ Assistant"}${entryAnnotation(entry)}`;
        const lines = [
          ...leading,
          ...wrapRows([header], width).lines,
          ...wrapRows(stripAnsi(entry.content).split(/\r?\n/).concat(""), width)
            .lines,
        ];
        layout = { prefix: leading.length, lines };
        cached.widths.set(width, layout);
      }
      const result = {
        key: entry.id,
        height: layout.lines.length,
        start,
        prefix: layout.prefix,
        lines: layout.lines,
      };
      start += layout.lines.length;
      return result;
    });
  };
}

/** Only this details reader requests older pages. Its loaded page remains a
 * snapshot while new entries append; every retry reuses the retained cursor. */
export function createTranscriptReader(deps: {
  readTranscript: (
    reference: TranscriptPageReference | TranscriptExportReference,
  ) => TranscriptRead;
  width: Accessor<number>;
  interiorH: Accessor<number>;
}) {
  const renderer = useRenderer();
  const observe = useLayoutObserver();
  const [reader, setReader] = createSignal<Reader>();
  const [anchor, setAnchor] = createSignal<Anchor>({ mode: "latest" });
  const [exportNotice, setExportNotice] = createSignal<string>();
  const entryLayout = createEntryLayout(observe);
  const layout = createMemo(() => entryLayout(reader(), deps.width()));
  const height = () =>
    Math.max(
      1,
      deps.interiorH() -
        2 -
        (deps.interiorH() >= 4 ? 1 : 0) -
        (deps.interiorH() >= 5 ? 1 : 0),
    );
  const anchorAt = (top: number): Anchor => ({
    mode: "paused",
    ...contentAnchorAt(top, layout()),
  });
  const position = createMemo(() => {
    const entries = layout();
    const held = anchor();
    const total = entries.reduce((sum, entry) => sum + entry.lines.length, 0);
    if (held.mode === "latest") {
      const top = Math.max(0, total - height());
      return { top, total, anchor: anchorAt(top) };
    }
    const resolved = resolveContentAnchor(held, entries);
    return {
      top: resolved.top,
      total,
      anchor: { mode: "paused", ...resolved.anchor } satisfies Anchor,
    };
  });
  // Commit a resize clamp within the surviving entry, so widening later cannot
  // restore a discarded offset. Never clamp a paused anchor to the live edge.
  createEffect(() => {
    const current = position().anchor;
    untrack(() => {
      const held = anchor();
      if (
        held.mode === "paused" &&
        current.mode === "paused" &&
        (held.id !== current.id || held.offset !== current.offset)
      )
        setAnchor(current);
    });
  });
  const open = (target: TranscriptTarget) => {
    const read = deps.readTranscript(target.transcript);
    batch(() => {
      setExportNotice(undefined);
      setAnchor({ mode: "latest" });
      setReader(
        !read.found
          ? { kind: "unread", target, entries: [], problem: read.problem }
          : {
              kind: "loaded",
              target,
              entries: read.entries,
              ...(read.type === "transcript-page" && read.older !== undefined
                ? { older: read.older }
                : {}),
            },
      );
    });
  };
  const loadOlder = () => {
    const current = reader();
    if (current === undefined) return;
    if (current.kind === "unread") {
      open(current.target);
      return;
    }
    if (current.older === undefined) return;
    const held = position().anchor;
    const read = deps.readTranscript({
      ...current.target.transcript,
      older: current.older,
    });
    if (!read.found) {
      setReader({ ...current, problem: read.problem });
      return;
    }
    if (read.type !== "transcript-page") return;
    batch(() => {
      setAnchor(held);
      setReader({
        kind: "loaded",
        target: current.target,
        entries: [...read.entries, ...current.entries],
        ...(read.older === undefined ? {} : { older: read.older }),
      });
    });
  };
  const exportTranscript = () => {
    const reference = reader()?.target.exportReference;
    if (reference === undefined) return;
    const read = deps.readTranscript(reference);
    if (!read.found) {
      setExportNotice(
        `Export [${read.problem.code}]: ${read.problem.explanation} ${read.problem.remediation}`,
      );
      return;
    }
    const text = read.entries
      .map(
        (entry) =>
          `${entry.role === "user" ? "User" : "Assistant"}${entryAnnotation(entry)}\n${stripAnsi(entry.content)}\n`,
      )
      .join("\n");
    setExportNotice(
      renderer.copyToClipboardOSC52(text)
        ? `Export sent to terminal clipboard · ${read.entries.length} entries`
        : "Export unavailable in this terminal. Use secant run read <run-id> --transcript.",
    );
  };
  const handleKey = (name: string): "ignored" | "consumed" | "quit" => {
    if (reader() === undefined) return "ignored";
    if (name === "escape") {
      setReader(undefined);
      return "consumed";
    }
    if (name === "q") return "quit";
    if (name === "p") {
      loadOlder();
      return "consumed";
    }
    if (name === "e") {
      exportTranscript();
      return "consumed";
    }
    const action = SCROLL_KEYS[name];
    if (action === undefined) return "consumed";
    const { top, total } = position();
    if (
      (action === "up" || action === "pageUp" || action === "top") &&
      top === 0 &&
      reader()?.older !== undefined
    ) {
      loadOlder();
      return "consumed";
    }
    if (action === "latest") {
      setAnchor({ mode: "latest" });
      return "consumed";
    }
    const page = Math.max(1, Math.floor(height() / 2));
    const next =
      action === "top"
        ? 0
        : top +
          (action === "up"
            ? -1
            : action === "down"
              ? 1
              : action === "pageUp"
                ? -page
                : page);
    if (
      (action === "down" || action === "pageDown") &&
      next >= Math.max(0, total - height())
    )
      setAnchor({ mode: "latest" });
    else
      setAnchor(anchorAt(Math.max(0, Math.min(next, Math.max(0, total - 1)))));
    return "consumed";
  };
  const location = () => {
    const held = position().anchor;
    const index =
      held.mode === "paused"
        ? layout().findIndex((entry) => entry.key === held.id)
        : -1;
    return index < 0
      ? "Empty conversation"
      : `Entry ${index + 1} · line ${held.mode === "paused" ? (held.offset < 0 ? "divider" : held.offset + 1) : 1}${anchor().mode === "latest" ? " · latest" : ""}`;
  };
  const notice = () => {
    const current = reader();
    if (current?.problem !== undefined)
      return `Notice [${current.problem.code}]: ${current.problem.explanation} ${current.problem.remediation}`;
    return (
      exportNotice() ??
      (current?.older === undefined
        ? "Beginning of retained conversation"
        : "Older entries retained · p load older")
    );
  };
  return {
    reader,
    open,
    handleKey,
    visible: createMemo(() => {
      const top = position().top;
      const bottom = top + height();
      const lines: string[] = [];
      for (const entry of layout()) {
        if (entry.start >= bottom) break;
        if (entry.start + entry.lines.length <= top) continue;
        lines.push(
          ...entry.lines.slice(
            Math.max(0, top - entry.start),
            bottom - entry.start,
          ),
        );
      }
      return lines;
    }),
    location,
    notice,
  };
}

export function TranscriptReaderView(props: {
  title: string;
  problem: Problem | undefined;
  interiorH: Accessor<number>;
  visible: Accessor<readonly string[]>;
  location: Accessor<string>;
  notice: Accessor<string>;
  width: Accessor<number>;
  theme: Theme;
}) {
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <text
        fg={props.theme.text}
        attributes={TextAttributes.BOLD}
        flexShrink={0}
      >
        {clip(
          props.interiorH() < 4 && props.problem !== undefined
            ? `Notice [${props.problem.code}]: ${props.problem.explanation}`
            : props.title,
          props.width(),
        )}
      </text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <Index each={props.visible()}>
          {(line) => (
            <text fg={props.theme.text} flexShrink={0} wrapMode="none">
              {line()}
            </text>
          )}
        </Index>
      </box>
      <Show when={props.interiorH() >= 5}>
        <text fg={props.theme.textMuted} flexShrink={0}>
          {clip(props.location(), props.width())}
        </text>
      </Show>
      <Show when={props.interiorH() >= 4}>
        <text fg={props.theme.textMuted} flexShrink={0}>
          {clip(props.notice(), props.width())}
        </text>
      </Show>
      <text fg={props.theme.textMuted} flexShrink={0}>
        {clip(
          props.width() < 50
            ? "p older · e export · esc · q quit"
            : "p older · e export · esc close · q quit",
          props.width(),
        )}
      </text>
    </box>
  );
}
