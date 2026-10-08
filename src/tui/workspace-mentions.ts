import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import type {
  ProjectionPort,
  WorkspacePathCandidate,
  WorkspacePathSearch,
} from "../application/projection-port.js";
import type { RendererKeyEvent } from "./renderer/renderer.js";

export interface MentionReplacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Completion owns tokens and reply lifetimes; the native editor owns text/cursor. */
export function createWorkspaceMentions(input: {
  draft: Accessor<string>;
  caret: Accessor<number>;
  runId: Accessor<string | undefined>;
  enabled: Accessor<boolean>;
  search: ProjectionPort["searchWorkspacePaths"];
}) {
  const [dismissed, setDismissed] = createSignal<string>();
  const [reply, setReply] = createSignal<{
    key: string;
    result: WorkspacePathSearch;
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
    return { ...token, runId, key };
  });
  createEffect(() => {
    const value = current();
    setSelection(0);
    if (value === undefined || value.key === dismissed()) return;
    const controller = new AbortController();
    let disposed = false;
    onCleanup(() => {
      disposed = true;
      controller.abort();
    });
    // One queued query replaces typing bursts before filesystem work starts.
    const timer = setTimeout(() => {
      void input
        .search({
          runId: value.runId,
          query: value.query,
          signal: controller.signal,
        })
        .then(
          (result) => {
            if (!disposed) setReply({ key: value.key, result });
          },
          (cause) => {
            if (!disposed)
              setReply({
                key: value.key,
                result: { status: "unavailable", cause },
              });
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
    const candidate = active();
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
    const rangeAt = quoted
      ? quoteEnd > 0
        ? body.indexOf("#", quoteEnd + 1)
        : -1
      : body.indexOf("#");
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
  const quoted = /\s/.test(path)
    ? `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : path;
  return `@${quoted}${candidate.kind === "file" ? range : ""}`;
}
