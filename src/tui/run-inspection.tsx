import { createHistoryContentReader } from "./run-history-content.js";
import { useLayoutObserver } from "./layout-observer.js";
import { TextAttributes } from "@opentui/core";
import { createMemo, createSignal, For, type Accessor } from "solid-js";
import {
  screenText,
  screenHistoryPortion,
  type ScreenedText,
} from "./screen-text.js";
import type {
  DiagnosticReference,
  HistoryTextReference,
  ProjectionPort,
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
import { wrapScreenedRows } from "./wrap.js";

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
      readonly historyContent: HistoryTextReference;
      readonly historyFiles?: HistoryTextReference;
      readonly content?: never;
      readonly reference?: never;
    }
  | {
      readonly label: string;
      readonly reference: ResourceReference | DiagnosticReference;
      readonly content?: never;
    }
  | {
      readonly label: string;
      readonly content: string;
      /** Supplied diffs stay complete, independent of the artifact inspection cap. */
      readonly format?: "diff";
      readonly reference?: never;
    };

interface BlobInspection {
  readonly kind: "blob";
  readonly title: string;
  readonly lines: readonly ScreenedText[];
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
  reconcile(target: Openable | undefined): void;
  /** Handle a key: `ignored` while closed, `quit` for the footer's `q` (#392),
   *  else `consumed`, so every other key stays inside the overlay. */
  handleKey(name: string): InspectionKey;
  /** The display lines, wrapped at the width, including a truncation marker or a
   *  Problem's text. */
  readonly lines: Accessor<readonly string[]>;
  /** The scrolled window over `lines`. */
  readonly window: Accessor<ReturnType<typeof timelineWindow>>;
  readonly footer: Accessor<string>;
}

/** The Workbench's inspection overlay controller. `readResource` resolves an
 *  output/diagnostic reference to its bytes; `interiorH` is the interior height, which the
 *  overlay windows its content over (title + footer subtracted); `width` is the
 *  interior width every line wraps at. */
export function createInspection(deps: {
  readResource: (
    reference: ResourceReference | DiagnosticReference,
  ) => ResourceRead;
  readHistoryContent: ProjectionPort["readHistoryContent"];
  releaseHistoryRead: ProjectionPort["releaseHistoryRead"];
  interiorH: Accessor<number>;
  width: Accessor<number>;
}): InspectionController {
  const observe = useLayoutObserver();
  const content = createHistoryContentReader(deps);
  const [historyTarget, setHistoryTarget] =
    createSignal<HistoryTextReference>();
  let patchTarget: HistoryTextReference | undefined;
  let filesTarget: HistoryTextReference | undefined;
  let showingFiles = false;
  const [inspecting, setInspecting] = createSignal<
    BlobInspection | undefined
  >();
  const [scroll, setScroll] = createSignal<TimelineScroll>(AT_TOP);

  const open = (target: Openable): void => {
    content.close();
    setHistoryTarget(undefined);
    patchTarget = undefined;
    filesTarget = undefined;
    showingFiles = false;
    if ("historyContent" in target) {
      patchTarget = target.historyContent;
      filesTarget = target.historyFiles;
      setHistoryTarget(target.historyContent);
      setInspecting({
        kind: "blob",
        title: target.label,
        lines: [],
        truncated: false,
      });
      setScroll(AT_TOP);
      content.open(target.historyContent);
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
      const all = screenText(read.content)
        .text.split("\n")
        .map((text) => ({ text }));
      const truncated =
        !("format" in target && target.format === "diff") &&
        all.length > MAX_INSPECT_LINES;
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
  const logicalLines = (): readonly ScreenedText[] => {
    const current = inspecting();
    if (current === undefined) return [];
    if (historyTarget() !== undefined) {
      const loaded = content.state();
      if (loaded.loading && !loaded.read)
        return [screenText("Loading retained content…")];
      if (loaded.read?.found === false)
        return [
          screenText(
            `Error [${loaded.read.problem.code}]: ${loaded.read.problem.explanation}`,
          ),
          screenText(`${loaded.read.problem.remediation} · r retry`),
        ];
      if (loaded.read?.found && loaded.read.type === "history-text")
        return [screenHistoryPortion(loaded.read)];
      return [];
    }
    if (current.problem !== undefined) {
      return [
        screenText(
          `Error [${current.problem.code}]: ${current.problem.explanation}`,
        ),
        screenText(current.problem.remediation),
      ];
    }
    if (!current.truncated) return current.lines;
    const last = current.lines.at(-1);
    if (last === undefined) return [{ text: RUN_TIMELINE_TRUNCATION_MARKER }];
    return current.lines
      .slice(0, -1)
      .concat({ text: `${last.text} ${RUN_TIMELINE_TRUNCATION_MARKER}` });
  };
  const layoutAtWidth = createMemo(() => {
    const current = inspecting();
    const logical = logicalLines();
    const widths = new Map<number, ReturnType<typeof wrapScreenedRows>>();
    return (width: number) => {
      let layout = widths.get(width);
      if (layout === undefined) {
        if (current !== undefined)
          observe({ kind: "inspection", id: current.title, width });
        layout = wrapScreenedRows(logical, width);
        if (widths.size >= 2) widths.delete(widths.keys().next().value!);
        widths.set(width, layout);
      }
      return layout;
    };
  });
  const width = createMemo(deps.width);
  const wrapped = createMemo(() => layoutAtWidth()(width()));
  const lines = () => wrapped().lines;
  const viewportH = () => Math.max(1, deps.interiorH() - 2); // title + footer
  const window = () => timelineWindow(scroll(), wrapped().heights, viewportH());

  const handleKey = (name: string): InspectionKey => {
    const current = inspecting();
    if (current === undefined) return "ignored";
    if (name === "escape") {
      content.close();
      setHistoryTarget(undefined);
      setInspecting(undefined);
      return "consumed";
    }
    // The footer advertises `q quit`; the overlay stays open so a declined quit
    // confirmation returns to the same view.
    if (name === "q") return "quit";
    if (historyTarget() && name === "f" && filesTarget && patchTarget) {
      showingFiles = !showingFiles;
      const reference = showingFiles ? filesTarget : patchTarget;
      setHistoryTarget(reference);
      content.open(reference);
      setScroll(AT_TOP);
      return "consumed";
    }
    if (historyTarget() && name === "r") {
      content.retry();
      return "consumed";
    }
    const action = SCROLL_KEYS[name];
    if (action === undefined) return "consumed";
    if (historyTarget() && (action === "latest" || action === "top")) {
      if (content.move(action === "latest" ? "last" : "first")) {
        setScroll(action === "latest" ? { mode: "live" } : AT_TOP);
        return "consumed";
      }
    }
    const before = window();
    if (
      historyTarget() &&
      (((action === "down" || action === "pageDown") &&
        before.top + before.visible >= lines().length) ||
        ((action === "up" || action === "pageUp") && before.top === 0))
    ) {
      if (
        content.move(
          action === "up" || action === "pageUp" ? "previous" : "next",
        )
      ) {
        setScroll(AT_TOP);
        return "consumed";
      }
    }
    setScroll((prev) =>
      scrollTimeline(prev, action, wrapped().heights, viewportH()),
    );
    return "consumed";
  };

  function reconcile(target: Openable | undefined): void {
    const previous = historyTarget();
    if (previous === undefined) return;
    if (target === undefined || !("historyContent" in target)) {
      content.close();
      setHistoryTarget(undefined);
      setInspecting(undefined);
      return;
    }
    patchTarget = target.historyContent;
    filesTarget = target.historyFiles;
    const reference = showingFiles && filesTarget ? filesTarget : patchTarget;
    if (reference.id === previous.id) return;
    setHistoryTarget(reference);
    content.open(reference);
  }
  return {
    inspecting,
    open,
    reconcile,
    handleKey,
    lines,
    window,
    footer: () =>
      historyTarget()
        ? `↑/↓ scroll · home/end · ${filesTarget ? "f files · " : ""}r retry · esc close · q quit`
        : "↑/↓ scroll · esc close · q quit",
  };
}

export function InspectionView(props: {
  inspection: BlobInspection;
  lines: Accessor<readonly string[]>;
  window: Accessor<ReturnType<typeof timelineWindow>>;
  width: Accessor<number>;
  footer: Accessor<string>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const visible = () => {
    const win = props.window();
    return props.lines().slice(win.top, win.top + win.visible);
  };
  const footer = props.footer;
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
