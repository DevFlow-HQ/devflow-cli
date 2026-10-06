import { TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
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
import { wrapRows, type Rule } from "./wrap.js";
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
  | { readonly mode: "latest" }
  | {
      readonly mode: "paused";
      readonly id: string | undefined;
      readonly offset: number;
    };

/** Retained entries own their wrapped content and attached dividers. Offset zero
 * names the role header; negative offsets name its leading divider lines. Adding
 * a newly known Step/Session divider cannot change the anchored content line. */
function entryLayout(reader: Reader, width: number) {
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
    const header = `${entry.role === "user" ? "◇ User Turn" : "◆ Assistant"}${entryAnnotation(entry)}`;
    const ruled = wrapRows([{ rules, text: header }], width).lines;
    const headerLines = wrapRows([header], width).lines.length;
    const prefix = ruled.length - headerLines;
    const lines = [
      ...ruled,
      ...wrapRows(stripAnsi(entry.content).split(/\r?\n/).concat(""), width)
        .lines,
    ];
    const result = { id: entry.id, start, prefix, lines };
    start += lines.length;
    return result;
  });
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
  const [reader, setReader] = createSignal<Reader>();
  const [anchor, setAnchor] = createSignal<Anchor>({ mode: "latest" });
  const [exportNotice, setExportNotice] = createSignal<string>();
  const layout = createMemo(() => {
    const current = reader();
    return current === undefined ? [] : entryLayout(current, deps.width());
  });
  const lines = () => layout().flatMap((entry) => entry.lines);
  const height = () =>
    Math.max(
      1,
      deps.interiorH() -
        2 -
        (deps.interiorH() >= 4 ? 1 : 0) -
        (deps.interiorH() >= 5 ? 1 : 0),
    );
  const anchorAt = (top: number): Anchor => {
    const entries = layout();
    const entry = entries
      .slice()
      .reverse()
      .find((entry) => entry.start <= top);
    return {
      mode: "paused",
      id: entry?.id,
      offset: entry === undefined ? 0 : top - entry.start - entry.prefix,
    };
  };
  const position = createMemo(() => {
    const entries = layout();
    const held = anchor();
    const total = entries.reduce((sum, entry) => sum + entry.lines.length, 0);
    if (held.mode === "latest") {
      const top = Math.max(0, total - height());
      return { top, total, anchor: anchorAt(top) };
    }
    const entry = entries.find((entry) => entry.id === held.id) ?? entries[0];
    const offset =
      entry === undefined
        ? 0
        : Math.max(
            -entry.prefix,
            Math.min(held.offset, entry.lines.length - entry.prefix - 1),
          );
    return {
      top: entry === undefined ? 0 : entry.start + entry.prefix + offset,
      total,
      anchor: { mode: "paused", id: entry?.id, offset } satisfies Anchor,
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
        ? layout().findIndex((entry) => entry.id === held.id)
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
    visible: () => lines().slice(position().top, position().top + height()),
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
        <For each={props.visible()}>
          {(line) => (
            <text fg={props.theme.text} flexShrink={0} wrapMode="none">
              {line}
            </text>
          )}
        </For>
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
