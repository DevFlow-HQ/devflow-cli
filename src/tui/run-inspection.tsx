import { TextAttributes } from "@opentui/core";
import { createMemo, createSignal, For, type Accessor } from "solid-js";
import stripAnsi from "strip-ansi";
import type {
  DiagnosticReference,
  Problem,
  ResourceRead,
  ResourceReference,
} from "../application/projection-port.js";
import { RUN_TIMELINE_TRUNCATION_MARKER } from "../application/projection-port.js";
import { clip } from "./clip.js";
import {
  AT_TOP,
  SCROLL_KEYS,
  scrollTimeline,
  timelineWindow,
  type TimelineScroll,
} from "./run-timeline.js";
import { useTheme } from "./vendor/theme-context.js";
import { wrapRows } from "./wrap.js";

// Artifact and output inspection owns bounded, wrapped text and modal navigation.
type Theme = ReturnType<typeof useTheme>["theme"];

/** One openable piece of Run evidence, reached through its reference (#91 AC4):
 *  a bound output, the blocked checkpoint's latest Verdict, the halt diagnostic,
 *  or captured content. Timeline links exist only where they
 *  open real evidence. Exactly one source is set (the union makes that explicit
 *  at the Workbench seam). */
export type Openable =
  | {
      readonly label: string;
      readonly reference: ResourceReference | DiagnosticReference;
      readonly content?: never;
    }
  | {
      readonly label: string;
      readonly content: string;
      readonly reference?: never;
    };

interface BlobInspection {
  readonly kind: "blob";
  readonly title: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly problem?: Problem;
}

/** Large blob content is bounded: at most this many lines are inspected, with an
 *  explicit truncation marker past it (#91 AC4). A transcript is bounded instead
 *  by paging, so it has no such cap. */
const MAX_INSPECT_LINES = 500;

type InspectionKey = "ignored" | "consumed" | "quit";

export interface InspectionController {
  /** The open inspection, or undefined when the overlay is closed. */
  readonly inspecting: Accessor<BlobInspection | undefined>;
  /** Resolve the reference or captured content, strip
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
 *  output/diagnostic reference to its bytes; `interiorH` is the interior height, which the
 *  overlay windows its content over (title + footer subtracted); `width` is the
 *  interior width every line wraps at. */
export function createInspection(deps: {
  readResource: (
    reference: ResourceReference | DiagnosticReference,
  ) => ResourceRead;
  interiorH: Accessor<number>;
  width: Accessor<number>;
}): InspectionController {
  const [inspecting, setInspecting] = createSignal<
    BlobInspection | undefined
  >();
  const [scroll, setScroll] = createSignal<TimelineScroll>(AT_TOP);

  const open = (target: Openable): void => {
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

  // Display lines include an explicit truncation marker as the final row when a
  // blob was capped, so it scrolls into view like any other line (#91 AC4).
  const logicalLines = (): readonly string[] => {
    const current = inspecting();
    if (current === undefined) return [];
    if (current.problem !== undefined) {
      return [
        `Error [${current.problem.code}]: ${current.problem.explanation}`,
        current.problem.remediation,
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
    setScroll((prev) =>
      scrollTimeline(prev, action, wrapped().heights, viewportH()),
    );
    return "consumed";
  };

  return { inspecting, open, handleKey, lines, window };
}

export function InspectionView(props: {
  inspection: BlobInspection;
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
  const footer = () => "↑/↓ scroll · esc close · q quit";
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
