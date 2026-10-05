import { TextAttributes } from "@opentui/core";
import { createMemo, createSignal, For, type Accessor } from "solid-js";
import stripAnsi from "strip-ansi";
import type {
  DiagnosticReference,
  Problem,
  ResourceRead,
  ResourceReference,
  RunTranscriptEntryView,
  TranscriptPageReference,
  TranscriptRead,
} from "../application/projection-port.js";
import { RUN_TIMELINE_TRUNCATION_MARKER } from "../application/projection-port.js";
import { clip } from "./clip.js";
import {
  AT_LIVE,
  AT_TOP,
  SCROLL_KEYS,
  scrollTimeline,
  timelineWindow,
  type TimelineScroll,
} from "./run-timeline.js";
import { useTheme } from "./vendor/theme-context.js";
import { sessionDivider, stepDivider } from "./run-timeline-rows.js";
import { wrapRows, type Rule, type RuledRow } from "./wrap.js";

// The Run Workbench's reference-inspection overlay, split out of run-workbench.tsx
// (A26): its state, its self-contained modal key branch, and its view interleave
// with nothing else in the Workbench, so they live here as one controller plus the
// `InspectionView` component. The Workbench selects which evidence to open (from
// its Details panel) and hands it here; everything about *showing* the bytes —
// stripping escapes, bounding the line count, scrolling, closing — is owned here.
//
// A Session transcript (#124) is a special evidence kind: it opens the newest
// bounded page through a `page` Resource Reference, and pages older upward on
// demand — never materializing the whole export to inspect a page. Scrolling up at
// the top loads the next older page and preserves the first visible entry by
// bumping the pinned row by the number of lines prepended.
//
// Every line wraps at the view width and is never cut (#288): the Projection
// already carries full content. The reducer anchors on a logical line, so a
// resize that rewraps keeps the same first visible line.

type Theme = ReturnType<typeof useTheme>["theme"];

/** One openable piece of Run evidence, reached through its reference (#91 AC4):
 *  a bound output, the blocked checkpoint's latest Verdict, the halt diagnostic,
 *  or a paged Session transcript (#124). Timeline links exist only where they
 *  open real evidence. Exactly one source is set (the union makes that explicit
 *  at the Workbench seam). */
export type Openable =
  | {
      readonly label: string;
      readonly reference: ResourceReference | DiagnosticReference;
      readonly content?: never;
      readonly transcript?: never;
    }
  | {
      readonly label: string;
      readonly content: string;
      readonly reference?: never;
      readonly transcript?: never;
    }
  | {
      readonly label: string;
      readonly transcript: TranscriptPageReference;
      /** The Session's plain name, which its divider shows (#289). */
      readonly sessionName: string;
      readonly reference?: never;
      readonly content?: never;
    };

interface BlobInspection {
  readonly kind: "blob";
  readonly title: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly problem?: Problem;
}

interface TranscriptInspection {
  readonly kind: "transcript";
  readonly title: string;
  readonly sessionName: string;
  readonly pageRef: TranscriptPageReference;
  readonly entries: readonly RunTranscriptEntryView[];
  /** The opaque cursor for the next older page, absent once the oldest is loaded. */
  readonly older?: string;
  readonly problem?: Problem;
  /** A failed older-page read is visible without discarding the retry cursor or
   * the transcript entries already on screen. */
  readonly olderProblem?: Problem;
}

type Inspection = BlobInspection | TranscriptInspection;

type TTranscriptInspectionParams = {
  readonly title: string;
  readonly sessionName: string;
  readonly pageRef: TranscriptPageReference;
  readonly entries: readonly RunTranscriptEntryView[];
  readonly older?: string;
  readonly olderProblem?: Problem;
};

function transcriptInspection(
  params: TTranscriptInspectionParams,
): TranscriptInspection {
  return {
    kind: "transcript",
    title: params.title,
    sessionName: params.sessionName,
    pageRef: params.pageRef,
    entries: params.entries,
    ...(params.older !== undefined ? { older: params.older } : {}),
    ...(params.olderProblem !== undefined
      ? { olderProblem: params.olderProblem }
      : {}),
  };
}

/** Large blob content is bounded: at most this many lines are inspected, with an
 *  explicit truncation marker past it (#91 AC4). A transcript is bounded instead
 *  by paging, so it has no such cap. */
const MAX_INSPECT_LINES = 500;

type InspectionKey = "ignored" | "consumed" | "quit";

export interface InspectionController {
  /** The open inspection, or undefined when the overlay is closed. */
  readonly inspecting: Accessor<Inspection | undefined>;
  /** Open one Openable: resolve its reference (or newest transcript page), strip
   *  escapes, bound the lines. */
  open(target: Openable): void;
  /** Handle a key: `ignored` while closed, `quit` for the footer's `q` (#392),
   *  else `consumed`, so every other key stays inside the overlay. */
  handleKey(name: string): InspectionKey;
  /** The display lines, wrapped at the width, including a truncation marker or a
   *  Problem's text. */
  readonly lines: Accessor<readonly string[]>;
  /** The scrolled window over `lines`. */
  readonly window: Accessor<ReturnType<typeof timelineWindow>>;
}

/** The Workbench's inspection overlay controller. `readResource` resolves an
 *  output/diagnostic reference to its bytes; `readTranscript` resolves a bounded
 *  transcript page; `interiorH` is the Workbench's interior height, which the
 *  overlay windows its content over (title + footer subtracted); `width` is the
 *  interior width every line wraps at. */
export function createInspection(deps: {
  readResource: (
    reference: ResourceReference | DiagnosticReference,
  ) => ResourceRead;
  readTranscript: (reference: TranscriptPageReference) => TranscriptRead;
  interiorH: Accessor<number>;
  width: Accessor<number>;
}): InspectionController {
  const [inspecting, setInspecting] = createSignal<Inspection | undefined>();
  const [scroll, setScroll] = createSignal<TimelineScroll>(AT_TOP);

  const open = (target: Openable): void => {
    if (target.transcript !== undefined) {
      openTranscript(target.label, target.sessionName, target.transcript);
      return;
    }
    const read =
      target.content !== undefined
        ? ({ found: true, type: "text", content: target.content } as const)
        : deps.readResource(target.reference);
    if (!read.found) {
      setInspecting({
        kind: "blob",
        title: target.label,
        lines: [],
        truncated: false,
        problem: read.problem,
      });
    } else {
      // Captured output can carry colour escapes and bare carriage returns from a
      // command forcing colour or drawing a progress bar (D4): strip the escapes
      // and split on `\r?\n` so a `\r` never corrupts a rendered row.
      const all = stripAnsi(read.content).split(/\r?\n/);
      const truncated = all.length > MAX_INSPECT_LINES;
      setInspecting({
        kind: "blob",
        title: target.label,
        lines: truncated ? all.slice(0, MAX_INSPECT_LINES) : all,
        truncated,
      });
    }
    setScroll(AT_TOP);
  };

  const openTranscript = (
    label: string,
    sessionName: string,
    pageRef: TranscriptPageReference,
  ): void => {
    const read = deps.readTranscript(pageRef);
    if (!read.found) {
      setInspecting({
        kind: "transcript",
        title: label,
        sessionName,
        pageRef,
        entries: [],
        problem: read.problem,
      });
      setScroll(AT_TOP);
      return;
    }
    setInspecting({
      kind: "transcript",
      title: label,
      sessionName,
      pageRef,
      entries: read.entries,
      ...(read.type === "transcript-page" && read.older !== undefined
        ? { older: read.older }
        : {}),
    });
    // Open on the newest page's newest entries (the live edge, the bottom).
    setScroll(AT_LIVE);
  };

  // Load the next older page and prepend it, preserving the first visible entry:
  // every existing logical line shifts down by the number prepended, so the pinned
  // row is bumped by the same amount (#124 AC3). The anchor is a logical line, so
  // the bump holds at any wrap width.
  const loadOlder = (): void => {
    const current = inspecting();
    if (
      current === undefined ||
      current.kind !== "transcript" ||
      current.older === undefined
    ) {
      return;
    }
    const read = deps.readTranscript({
      ...current.pageRef,
      older: current.older,
    });
    if (!read.found) {
      // A failed read (e.g. a raced owner reacquire) leaves the cursor in place so
      // a later scroll-up retries. Keep the current entries and surface the Problem
      // above them instead of silently pretending the oldest was reached.
      setInspecting(
        transcriptInspection({
          title: current.title,
          sessionName: current.sessionName,
          pageRef: current.pageRef,
          entries: current.entries,
          older: current.older,
          olderProblem: read.problem,
        }),
      );
      return;
    }
    if (read.type !== "transcript-page") {
      return;
    }
    // transcriptRows is a per-entry concatenation whose dividers ride on header
    // rows, so the prepended row count is exactly the older page's rows — no need
    // to re-render the whole transcript.
    const old = window();
    const prepended = transcriptRows(
      read.entries,
      current.sessionName,
      false,
    ).length;
    setInspecting(
      transcriptInspection({
        title: current.title,
        sessionName: current.sessionName,
        pageRef: current.pageRef,
        entries: read.entries.concat(current.entries),
        older: read.older,
      }),
    );
    setScroll({
      mode: "paused",
      row: old.row + prepended,
      offset: old.offset,
    });
  };

  // Display lines include an explicit truncation marker as the final row when a
  // blob was capped, so it scrolls into view like any other line (#91 AC4).
  const logicalLines = (): readonly (string | RuledRow)[] => {
    const current = inspecting();
    if (current === undefined) return [];
    if (current.problem !== undefined) {
      return [
        `Error [${current.problem.code}]: ${current.problem.explanation}`,
        current.problem.remediation,
      ];
    }
    if (current.kind === "transcript") {
      const content = transcriptRows(
        current.entries,
        current.sessionName,
        current.older === undefined,
      );
      if (current.olderProblem === undefined) return content;
      return [
        `Notice [${current.olderProblem.code}]: ${current.olderProblem.explanation}`,
        current.olderProblem.remediation,
        ...content,
      ];
    }
    if (!current.truncated) return current.lines;
    const last = current.lines.at(-1);
    if (last === undefined) return [RUN_TIMELINE_TRUNCATION_MARKER];
    return current.lines
      .slice(0, -1)
      .concat(`${last} ${RUN_TIMELINE_TRUNCATION_MARKER}`);
  };
  const wrapped = createMemo(() => wrapRows(logicalLines(), deps.width()));
  const lines = () => wrapped().lines;
  const viewportH = () => Math.max(1, deps.interiorH() - 2); // title + footer
  const window = () => timelineWindow(scroll(), wrapped().heights, viewportH());

  const handleKey = (name: string): InspectionKey => {
    const current = inspecting();
    if (current === undefined) return "ignored";
    if (name === "escape") {
      setInspecting(undefined);
      return "consumed";
    }
    // The footer advertises `q quit`; the overlay stays open so a declined quit
    // confirmation returns to the same view.
    if (name === "q") return "quit";
    const action = SCROLL_KEYS[name];
    if (action === undefined) return "consumed";
    // At the top of a transcript with older history, page older before scrolling,
    // so the upward step reveals the just-loaded older entries.
    if (
      current.kind === "transcript" &&
      current.older !== undefined &&
      (action === "up" || action === "pageUp" || action === "top") &&
      window().top === 0
    ) {
      loadOlder();
    }
    setScroll((prev) =>
      scrollTimeline(prev, action, wrapped().heights, viewportH()),
    );
    return "consumed";
  };

  return { inspecting, open, handleKey, lines, window };
}

/** Render transcript entries as display rows: a role header per entry, then its
 *  content split on `\r?\n` with escapes stripped (captured content can carry
 *  colour), then a blank separator. Whole-entry blocks, so a prepend adds only
 *  leading rows and the anchor bump is exact. Dividers (#289) lead header rows:
 *  the Session divider on the first entry and a Step divider wherever the
 *  Application-supplied Step changes, drawn only where the start is known — the
 *  first entry is the Session's start only once no older page remains. */
function transcriptRows(
  entries: readonly RunTranscriptEntryView[],
  sessionName: string,
  fromStart: boolean,
): readonly (string | RuledRow)[] {
  const out: (string | RuledRow)[] = [];
  let step: string | undefined;
  entries.forEach((entry, index) => {
    const known = index > 0 || fromStart;
    const rules: Rule[] = [];
    if (index === 0 && fromStart) rules.push(sessionDivider(sessionName));
    if (known && entry.step !== undefined && entry.step !== step) {
      rules.push(stepDivider(entry.step));
    }
    step = entry.step ?? step;
    out.push({
      rules,
      text: entry.role === "user" ? "◇ User Turn" : "◆ Assistant",
    });
    for (const line of stripAnsi(entry.content).split(/\r?\n/)) out.push(line);
    out.push("");
  });
  return out;
}

export function InspectionView(props: {
  inspection: Inspection;
  lines: Accessor<readonly string[]>;
  window: Accessor<ReturnType<typeof timelineWindow>>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const visible = () => {
    const win = props.window();
    return props.lines().slice(win.top, win.top + win.visible);
  };
  const footer = () =>
    props.inspection.kind === "transcript"
      ? "↑/↓ scroll · ↑ at top loads older · esc close · q quit"
      : "↑/↓ scroll · esc close · q quit";
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <text fg={theme.text} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip(props.inspection.title, w())}
      </text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={visible()}>
          {(line) => (
            <text fg={theme.text} flexShrink={0} wrapMode="none">
              {line}
            </text>
          )}
        </For>
      </box>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(footer(), w())}
      </text>
    </box>
  );
}
