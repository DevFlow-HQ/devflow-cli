import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import type {
  HistoryTextReference,
  ProjectionPort,
  RunView,
} from "../application/projection-port.js";
import { useLayoutObserver } from "./layout-observer.js";
import { createHistoryContentReaders } from "./run-history-content.js";
import { createHistoryLayout } from "./run-history-layout.js";
import {
  historyWindow,
  reconcileHistoryScroll,
  scrollHistory,
  type HistoryScroll,
} from "./run-history-scroll.js";
import type { InspectionController } from "./run-inspection.js";
import type { TimelineAction } from "./run-timeline.js";
import {
  buildTimelineRows,
  historyFileSpans,
  historyLabel,
  rowContentReference,
  type TimelineRow,
} from "./run-timeline-rows.js";
import { screenHistoryPortion } from "./screen-text.js";

/** The Run Workbench's history viewport: content readers, displayed rows, the
 *  spinner, the scroll window and its lines, and what a click, Ctrl+O or a scroll
 *  key does to them. The Workbench keeps focus, interaction and key dispatch, and
 *  asks this controller (tui-history.md). */
export function createHistoryViewport(props: {
  view: Pick<ProjectionPort, "readHistoryContent" | "releaseHistoryRead">;
  run: Accessor<RunView | undefined>;
  histories: Accessor<Parameters<typeof buildTimelineRows>[1]>;
  width: Accessor<number>;
  height: Accessor<number>;
  reducedMotion: boolean;
  inspection: InspectionController;
  /** A full-screen reader covers history, so its readers release. */
  covered: Accessor<boolean>;
  /** A dialog or confirmation holds the keys; covered history is blocked too. */
  blocked: Accessor<boolean>;
}) {
  const { inspection } = props;
  /** Clicks and Ctrl+O wait while history is covered or blocked. */
  const historyBlocked = () => props.covered() || props.blocked();
  const timelineRows = createMemo<readonly TimelineRow[]>(() => {
    const current = props.run();
    if (current === undefined) return [];
    return buildTimelineRows(current, props.histories());
  });
  const [scroll, setScroll] = createSignal<HistoryScroll>({ mode: "live" });
  const [expandedHistory, setExpandedHistory] = createSignal<
    ReadonlySet<string>
  >(new Set());
  let expandedByKey: string | undefined;
  const [inspectionRow, setInspectionRow] = createSignal<{
    key: string;
    file?: number;
  }>();

  // Visible long messages and Steers read their content; Thoughts, Entry prompts
  // and command output read only while expanded. Each shows one bounded portion.
  const rowContent = createHistoryContentReaders(props.view, 8);
  const pathContent = createHistoryContentReaders(props.view, 16);
  const displayTimelineRows = createMemo(() =>
    timelineRows().map((row) => {
      const value = row.value;
      if (value?.kind === "tool" || value?.kind === "turn-diff") {
        const files = value.files?.map((file, index) => {
          const read = pathContent.get(pathKey(row.key, index))?.state().read;
          return read?.found && read.type === "history-text"
            ? {
                ...file,
                path:
                  screenHistoryPortion(read).text +
                  (read.next ? " · more path, click to read" : ""),
              }
            : file;
        });
        const shown =
          value.kind === "turn-diff"
            ? { ...value, files: files ?? [] }
            : { ...value, files };
        row = {
          ...row,
          text: historyLabel(shown, row.preview ?? false),
          fileSpans: historyFileSpans(shown, row.preview ?? false),
        };
      }
      const reader = rowContent.get(row.key);
      if (!reader) return row;
      const state = reader.state();
      const read = state.read;
      row = {
        ...row,
        contentNotice: state.loading
          ? "Loading retained content…"
          : read?.found === false
            ? `Error [${read.problem.code}] · click to retry`
            : read?.found && read.next
              ? row.output
                ? "More retained output below"
                : "More retained text below"
              : undefined,
      };
      if (!read?.found || read.type !== "history-text") return row;
      const portion = screenHistoryPortion(read).text;
      if (row.output)
        return { ...row, output: { ...row.output, text: portion } };
      if (row.thought)
        return { ...row, thought: { ...row.thought, content: portion } };
      if (value?.kind === "entry-prompt")
        return { ...row, value: { ...value, content: portion } };
      if (value?.kind === "message" || value?.kind === "steer") {
        const shown = { ...value, content: portion };
        return {
          ...row,
          value: shown,
          text: historyLabel(shown, row.preview ?? false),
        };
      }
      return row;
    }),
  );

  const [spinnerFrame, setSpinnerFrame] = createSignal(0);
  const liveSpinnerShown = createMemo(() =>
    timelineRows().some(
      (row) =>
        row.thought?.live ||
        (row.value?.kind === "tool" && row.value.outcome.kind === "running"),
    ),
  );
  createEffect(() => {
    if (!liveSpinnerShown() || props.reducedMotion) return;
    const timer = setInterval(
      () => setSpinnerFrame((frame) => (frame + 1) % 4),
      120,
    );
    timer.unref();
    onCleanup(() => clearInterval(timer));
  });
  const spinnerMark = () =>
    props.reducedMotion ? "[.]" : ["|", "/", "-", "\\"][spinnerFrame()];

  createEffect(() => {
    const retained = new Set(timelineRows().map((row) => row.key));
    if (expandedByKey !== undefined && !retained.has(expandedByKey))
      expandedByKey = undefined;
    setExpandedHistory((previous) => {
      const next = new Set([...previous].filter((key) => retained.has(key)));
      return next.size === previous.size ? previous : next;
    });
  });
  const layoutHistory = createHistoryLayout(
    useLayoutObserver(),
    props.reducedMotion,
  );
  const layout = createMemo(() =>
    layoutHistory(displayTimelineRows(), props.width(), expandedHistory()),
  );
  createEffect(
    on(
      () => layout().rows,
      (rows) => setScroll((current) => reconcileHistoryScroll(current, rows)),
    ),
  );
  const win = () => historyWindow(scroll(), layout().rows, props.height());
  /** The rows with any line in the window, oldest first, from row index `from`. */
  const shown = createMemo(() => {
    const w = win();
    const first = layout().at(w.top);
    const last = layout().at(w.top + w.visible - 1);
    return first === undefined || last === undefined || w.visible <= 0
      ? { from: 0, rows: [] }
      : {
          from: first.index,
          rows: layout().rows.slice(first.index, last.index + 1),
        };
  });
  const visibleKeys = createMemo(
    () => new Set(shown().rows.map((layout) => layout.key)),
  );
  createEffect(() => {
    const visible = visibleKeys();
    const expanded = expandedHistory();
    rowContent.sync(
      props.covered()
        ? []
        : timelineRows().flatMap((row) => {
            const reference = visible.has(row.key)
              ? rowContentReference(row, expanded.has(row.key))
              : undefined;
            if (reference === undefined) return [];
            // While following, a growing preview shows its newest portion.
            const from =
              row.preview && untrack(scroll).mode === "live"
                ? ("last" as const)
                : ("first" as const);
            return [{ key: row.key, reference, from }];
          }),
    );
  });
  createEffect(() => {
    const visible = visibleKeys();
    pathContent.sync(
      props.covered()
        ? []
        : timelineRows().flatMap((row) => {
            const value = row.value;
            if (
              !visible.has(row.key) ||
              (value?.kind !== "tool" && value?.kind !== "turn-diff")
            )
              return [];
            return (value.files ?? []).flatMap((file, index) =>
              file.pathContent
                ? [
                    {
                      key: pathKey(row.key, index),
                      reference: file.pathContent,
                    },
                  ]
                : [],
            );
          }),
    );
  });
  const lines = createMemo(() => {
    const w = win();
    const bottom = w.top + w.visible;
    const { from: first, rows } = shown();
    return rows.flatMap((row, offset) => {
      const source = timelineRows()[first + offset]!;
      const from = Math.max(0, w.top - row.top);
      const to = Math.min(row.height, bottom - row.top);
      return row.lines.slice(from, to).map((line, at) => {
        const local = from + at;
        const content = local >= row.prefix;
        return {
          text: !props.reducedMotion
            ? local === row.thoughtHeader
              ? line.replace("Thinking |", `Thinking ${spinnerMark()}`)
              : local === row.toolHeader
                ? line.replace("  | ", `  ${spinnerMark()} `)
                : line
            : line,
          value: content ? source.value : undefined,
          event: content ? source.event : undefined,
          humanPanel: content && row.humanPanel,
          failurePanel: content && row.failurePanel,
        };
      });
    });
  });

  const openRowDetail = (row: TimelineRow | undefined): void => {
    if (
      row === undefined ||
      (row.thought === undefined &&
        row.inspection === undefined &&
        row.output === undefined &&
        row.value?.kind !== "entry-prompt") ||
      historyBlocked()
    )
      return;
    if (row.inspection !== undefined) {
      expandedByKey = undefined;
      setInspectionRow({ key: row.key });
      inspection.open(row.inspection);
      return;
    }
    setExpandedHistory((previous) => {
      const next = new Set(previous);
      if (next.has(row.key)) {
        next.delete(row.key);
        if (expandedByKey === row.key) expandedByKey = undefined;
      } else next.add(row.key);
      return next;
    });
  };
  createEffect(() => {
    const key = inspectionRow();
    if (key === undefined || !inspection.inspecting()) return;
    const row = timelineRows().find((row) => row.key === key.key);
    const value = row?.value;
    const path =
      (value?.kind === "tool" || value?.kind === "turn-diff") &&
      key.file !== undefined
        ? value.files?.[key.file]?.pathContent
        : undefined;
    inspection.reconcile(
      key.file !== undefined
        ? path
          ? pathInspection(path)
          : undefined
        : (row?.inspection ??
            (row?.value?.kind === "tool" && row.value.detail
              ? toolDetailInspection(row.value.detail, row.value.filesDetail)
              : undefined)),
    );
  });

  return {
    /** The window's display lines, already wrapped to the width. */
    lines,
    atBeginning: () => win().top === 0,
    /** The paused badge under the conversation; empty while following. */
    status: (): string => {
      const activity = win();
      if (activity.atLive) return "";
      return activity.newActivity > 0
        ? props.width() < 60
          ? `  ▼ ${activity.newActivity} · Jump to latest`
          : `  ▼ ${activity.newActivity} ${activity.newActivity === 1 ? "new activity" : "new activities"} · Jump to latest · alt+end`
        : "  Paused · alt+end latest";
    },
    /** Ctrl+O: close the remembered in-place row, else open the bottom-most
     *  visible row with hidden detail. */
    toggleDetail(): void {
      const remembered = timelineRows().find(
        (row) => row.key === expandedByKey,
      );
      expandedByKey = undefined;
      if (remembered !== undefined && expandedHistory().has(remembered.key)) {
        openRowDetail(remembered);
        return;
      }
      const { from, rows } = shown();
      let index = rows.length - 1;
      while (index >= 0 && !rows[index]!.hasDetail) index--;
      if (index < 0) return;
      const row = timelineRows()[from + index]!;
      openRowDetail(row);
      if (row.inspection === undefined && expandedHistory().has(row.key))
        expandedByKey = row.key;
    },
    /** A click on window line `index`, resolving its row once. */
    click(index: number): void {
      const hit = layout().at(win().top + index);
      if (hit === undefined) return;
      const row = timelineRows()[hit.index]!;
      const local = hit.line;
      // Only the drawn Error notice retries; the rest of the row still toggles.
      const contentRead = rowContent.get(row.key);
      if (
        contentRead?.state().read?.found === false &&
        !historyBlocked() &&
        hit.row.noticeFrom >= 0 &&
        local >= hit.row.noticeFrom
      ) {
        contentRead.retry();
        return;
      }
      const value = row.value;
      if (value?.kind === "tool" || value?.kind === "turn-diff") {
        const fileIndex =
          hit.row.fileTargets.find(
            (target) => local >= target.from && local <= target.to,
          )?.index ?? -1;
        const file = value.files?.[fileIndex];
        if (file?.pathContent) {
          setInspectionRow({ key: row.key, file: fileIndex });
          inspection.open(pathInspection(file.pathContent));
          return;
        }
      }
      if (
        value?.kind === "tool" &&
        value.detail &&
        row.output &&
        local === hit.row.prefix
      ) {
        setInspectionRow({ key: row.key });
        inspection.open(toolDetailInspection(value.detail, value.filesDetail));
        return;
      }
      openRowDetail(row);
    },
    scrollBy(action: TimelineAction): void {
      const down = action === "down" || action === "pageDown";
      if (down || action === "up" || action === "pageUp") {
        // A visible row whose drawn edge is in view and has another portion pages in
        // place, anchored at its top. A page key can jump past an edge, so the edge
        // need only be visible; loading and failed rows scroll as usual.
        const w = win();
        const bottom = w.top + w.visible;
        const spans = down ? shown().rows : [...shown().rows].reverse();
        for (const span of spans) {
          const reader = rowContent.get(span.key);
          const read = reader?.state().read;
          const edge = down
            ? span.top + span.height <= bottom
            : span.top >= w.top;
          if (
            reader &&
            edge &&
            read?.found &&
            read[down ? "next" : "previous"] !== undefined &&
            reader.move(down ? "next" : "previous")
          ) {
            setScroll({
              mode: "paused",
              id: span.key,
              offset: 0,
              prior: layout().rows.map((row) => row.key),
            });
            return;
          }
        }
      }
      setScroll((prev) =>
        scrollHistory(prev, action, layout().rows, props.height()),
      );
    },
    /** A details-opened inspection belongs to no history row. */
    detachInspection: () => setInspectionRow(undefined),
  };
}

/** Each long file path reads through its own keyed reader. */
const pathKey = (row: string, file: number) => `${row}:${file}`;

const pathInspection = (path: HistoryTextReference) => ({
  label: "Supplied file path",
  historyContent: path,
});

const toolDetailInspection = (
  detail: HistoryTextReference,
  files: HistoryTextReference | undefined,
) => ({ label: "Tool detail", historyContent: detail, historyFiles: files });
