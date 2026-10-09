import type {
  HistoryTextReference,
  RunLiveOverlay,
  RunTimelineEvent,
  RunView,
  SessionHistoryView,
  SessionHistoryValue,
} from "../application/projection-port.js";
import type { Openable } from "./run-inspection.js";
import type { Rule } from "./wrap.js";

/** One row in the Workbench's combined durable + live timeline: one logical line,
 *  which the Workbench wraps at its width (#288), under the dividers that lead it
 *  (#289). */
export interface TimelineRow {
  readonly key: string;
  readonly text: string;
  readonly value?: SessionHistoryValue;
  readonly preview?: boolean;
  readonly event?: RunTimelineEvent["event"];
  readonly at?: string;
  readonly placementRank?: number;
  readonly step?: string;
  readonly session?: string;
  readonly sessionName?: string;
  readonly iterationEnd?: true;
  readonly oneLine?: boolean;
  readonly inspection?: Openable;
  readonly contentNotice?: string;
  readonly fileSpans?: readonly { index: number; start: number; end: number }[];
  readonly output?: NonNullable<
    Extract<SessionHistoryValue, { kind: "tool" }>["output"]
  > & { readonly live: boolean };
  readonly thought?: Extract<SessionHistoryValue, { kind: "thought" }> & {
    readonly live: boolean;
  };
  /** Live rows have none: they carry no Step or Session of their own. */
  readonly dividers?: readonly Rule[];
}

/** Where a Step begins: a thin rule naming the Step (#289). */
export function stepDivider(step: string): Rule {
  return { glyph: "─", title: `Step · ${step}` };
}

/** Where a Harness Session begins: a double rule naming the conversation in plain
 *  words. It differs from the Step divider in glyph and wording, not only colour. */
export function sessionDivider(name: string): Rule {
  return { glyph: "═", title: `Conversation · ${name}` };
}

/** Display complete history values in their supplied order beside timestamped Workflow facts. */
export function buildTimelineRows(
  run: RunView,
  histories: readonly {
    readonly name: string;
    readonly session: string;
    readonly history: SessionHistoryView;
  }[],
): readonly TimelineRow[] {
  const subscribed = new Set(histories.map((history) => history.session));
  const conversation = [
    ...durableTimelineRows(
      run.timeline.filter(
        (event) =>
          event.session === undefined ||
          (!subscribed.has(event.session) &&
            ["turn-started", "turn-settled"].includes(event.event)),
      ),
    ),
    ...histories.flatMap(({ name, session, history }) =>
      historyTimelineRows(history, name, session),
    ),
  ].sort(
    (a, b) =>
      (a.at ?? "").localeCompare(b.at ?? "") ||
      (a.placementRank ?? 1) - (b.placementRank ?? 1),
  );
  return [
    ...attachDividers(conversation),
    ...(run.pendingAgentCompletion !== undefined
      ? [
          {
            key: "agent-completion:pending",
            text: `The agent has asked to end this ${run.pendingAgentCompletion.call === "stage_done" ? "Stage" : "Step"} · ${oneLine(run.pendingAgentCompletion.reason)}`,
            oneLine: true,
          },
        ]
      : []),
    // The checkpoint message is authored and may run long, so it wraps.
    ...(run.heldForReview !== undefined
      ? [
          {
            key: "agent-completion:held",
            text: `◆ Held for review · the agent's Continue waits for you · ${oneLine(run.heldForReview.message)}`,
          },
        ]
      : []),
    ...(run.windowsCleanupNotice === undefined
      ? []
      : [
          {
            key: "notice:windows-cleanup-fallback",
            text: `Info: ${run.windowsCleanupNotice}`,
          },
        ]),
    ...(run.preferenceNotice === undefined
      ? []
      : [
          { key: "notice:model-choice-preference", text: run.preferenceNotice },
        ]),
    ...(run.modelChoiceNotice === undefined
      ? []
      : [{ key: "notice:model-choice-refused", text: run.modelChoiceNotice }]),
  ];
}

/** Durable rows under their dividers (#289). A Session divider leads a row whose
 *  Session differs from the last row that named one, so a return to an earlier
 *  conversation is marked too; a Step divider leads a row whose Step differs from
 *  the last Step-scoped row, or follows a completed Iteration. When both begin at
 *  once the Session divider comes first. The Step and Session come from the
 *  Application; nothing here parses a name or an id. */
function durableTimelineRows(
  timeline: readonly RunTimelineEvent[],
): TimelineRow[] {
  return timeline.map((event, index) => {
    return {
      key: `durable:${event.at}:${event.event}:${index}`,
      at: event.at,
      event: event.event,
      placementRank:
        event.event === "run-created" || event.event === "trust-granted"
          ? 0
          : 2,
      step: event.step,
      session: event.session,
      sessionName: event.sessionName,
      ...(event.event === "iteration" ? { iterationEnd: true } : {}),
      text:
        event.endedBy === "agent"
          ? durableLabel(event)
          : `${event.at} ${durableLabel(event)}`,
      ...(event.agentCall !== undefined || event.endedBy === "agent"
        ? { oneLine: true }
        : {}),
    };
  });
}

/** A durable event in plain words, each with a glyph so its category survives
 * colour removal. The raw kinds and ids stay on headless `run show`, the
 * diagnostic surface. */
function durableLabel(event: RunTimelineEvent): string {
  const detail = event.detail !== undefined ? ` · ${event.detail}` : "";
  // The durable Turn label is driven by the recorded Turn kind (#126), so reopened
  // history distinguishes an Interactive Turn from an Agent Turn by words alone
  // (colour removed). A legacy row with no kind reads a neutral "Turn" — truthful
  // where the kind is genuinely unknown rather than a guess.
  const turnLabel =
    event.turnKind === "interactive-agent"
      ? "Interactive Turn"
      : event.turnKind === "agent"
        ? "Agent Turn"
        : "Turn";
  // A human control's settle reads only an unexpected outcome.
  const unusual =
    event.detail !== undefined && event.detail !== "succeeded"
      ? ` · ${event.detail}`
      : "";
  if (event.endedBy === "agent")
    return `${
      event.event === "repeat-continued"
        ? "↻ Continued by the agent"
        : event.event === "stage-ended"
          ? "▸ Stage ended by the agent"
          : "▸ Step ended by the agent"
    } · ${oneLine(event.reason ?? "")}`;
  switch (event.event) {
    case "agent-call": {
      const call = event.agentCall;
      if (call === undefined) return "Agent call";
      return `Agent call ${call.id} · ${call.answer.outcome === "refused" ? `refused · ${call.answer.reason}` : call.disposition === "dropped" ? "dropped" : call.answer.outcome === "held-for-review" ? "held for review" : "accepted, takes effect when this Turn finishes"} · ${oneLine(call.reason)}`;
    }
    case "run-created":
      return "○ Run created";
    case "trust-granted":
      return "✓ Trust granted";
    case "attempt-settled":
      return `▸ Step Attempt ${event.detail ?? "settled"}`;
    case "iteration":
      return `↻ Iteration ${event.detail ?? ""} complete`;
    case "interactive-step-ended":
      return `▸ Step ended by the person${unusual}`;
    case "repeat-continued":
      return `↻ Continued to the next Iteration${unusual}`;
    case "stage-ended":
      return `▸ Stage ended${unusual}`;
    case "materialization-conflict":
      return `! Materialization conflict${detail}`;
    case "assistant-content":
      return `◆ Assistant${detail}`;
    case "steer":
      return `↳ Steer${detail}`;
    case "tool-activity":
      return `↳ Tool activity${detail}`;
    // The Session names the conversation, so a divider carries it, not the row.
    case "turn-started":
      return `● ${turnLabel} started`;
    case "turn-settled":
      return `● ${turnLabel} settled${detail}`;
    case "effective-model":
      return `◇ Effective model${detail}`;
    case "request-raised":
      return `? Harness Request raised${detail}`;
    case "request-answered":
      return `? Harness Request answered${detail}`;
    case "elicitation-declined": {
      const asked = event.elicitation;
      const evidence =
        asked === undefined
          ? ""
          : ` · ${asked.harness}/${asked.server} · ${asked.message}${asked.url === undefined ? "" : ` · ${asked.url}`}`;
      return `? Elicitation declined${evidence}${detail}`;
    }
    case "request-expired":
      return "? Harness Request expired";
    case "checkpoint-blocked":
      return `◆ Human Gate · review checkpoint${detail}`;
    case "gate-answered":
      return `◆ Human Gate answered${detail}`;
  }
}

function historyTimelineRows(
  history: SessionHistoryView,
  name: string,
  session: string,
): readonly TimelineRow[] {
  return history.rows.map((row, index) => {
    const dividers: Rule[] = [];
    if (index === 0 && history.hasEarlier)
      dividers.push({ glyph: "─", title: "Earlier conversation is not shown" });
    return {
      key: row.id,
      at: row.turnStartedAt,
      step: row.step,
      session,
      sessionName: name,
      value: row.value,
      preview: row.source === "preview",
      text: historyLabel(row.value, row.source === "preview"),
      fileSpans: historyFileSpans(row.value, row.source === "preview"),
      inspection: fileInspection(row.value) ?? previewInspection(row.value),
      ...(row.value.kind === "agent-call" ? { oneLine: true } : {}),
      ...(row.value.kind === "tool" && row.value.output !== undefined
        ? { output: { ...row.value.output, live: row.source === "preview" } }
        : {}),
      ...(row.value.kind === "thought"
        ? { thought: { ...row.value, live: row.source === "preview" } }
        : {}),
      dividers,
    };
  });
}
/** The retained text a row reads in place: fully shown messages and Steers always,
 * Thoughts, Entry prompts and command output only while expanded. */
export function rowContentReference(
  row: TimelineRow,
  expanded: boolean,
): HistoryTextReference | undefined {
  const value = row.value;
  if (value?.kind === "message" || value?.kind === "steer")
    return value.reference;
  if (!expanded) return undefined;
  if (row.output !== undefined) return row.output.reference;
  return value?.kind === "thought" || value?.kind === "entry-prompt"
    ? value.reference
    : undefined;
}
/** A cut Agent call, Request, activity or Turn result opens its complete text (#490). */
function previewInspection(value: SessionHistoryValue): Openable | undefined {
  switch (value.kind) {
    case "agent-call":
    case "request":
    case "activity":
    case "turn-result":
      return value.detail === undefined
        ? undefined
        : {
            label: {
              "agent-call": "Agent call",
              request: "Harness Request",
              activity: "Activity",
              "turn-result": "Turn result",
            }[value.kind],
            historyContent: value.detail,
          };
    default:
      return undefined;
  }
}
/** Formats only supplied patch data. Requested inputs never create an inspection. */
function fileInspection(value: SessionHistoryValue): Openable | undefined {
  if (
    (value.kind === "turn-diff" ||
      (value.kind === "tool" && value.output === undefined)) &&
    value.detail !== undefined
  )
    return {
      label: value.kind === "turn-diff" ? "Turn diff" : "Supplied call detail",
      historyContent: value.detail,
      historyFiles: value.filesDetail,
    };
  if (value.kind === "turn-diff")
    return { label: "Turn diff", content: value.content, format: "diff" };
  if (
    value.kind !== "tool" ||
    !value.files?.some((file) => file.patch !== undefined)
  )
    return undefined;
  const content = value.files
    .map((file) => {
      const patch = file.patch;
      if (patch === undefined) return `${file.path}\nNo patch supplied`;
      if (patch.kind === "unified") return `${file.path}\n${patch.content}`;
      const hunks = patch.hunks
        .map(
          (hunk) =>
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
        )
        .join("\n");
      return `${file.path}\n${patch.hunks.length === 0 ? "No patch hunks supplied" : hunks}`;
    })
    .join("\n\n");
  return { label: "Supplied call patches", content, format: "diff" };
}

function attachDividers(rows: readonly TimelineRow[]): TimelineRow[] {
  let step: string | undefined;
  let session: string | undefined;
  return rows.map((row) => {
    const dividers: Rule[] = [...(row.dividers ?? [])];
    if (row.session !== undefined && row.session !== session) {
      dividers.push(sessionDivider(row.sessionName ?? row.session));
      session = row.session;
    }
    if (row.step !== undefined && row.step !== step)
      dividers.push(stepDivider(row.step));
    step = row.iterationEnd === true ? undefined : (row.step ?? step);
    return { ...row, dividers };
  });
}

export function historyLabel(
  value: SessionHistoryValue,
  preview: boolean,
): string {
  switch (value.kind) {
    case "turn-diff":
      return fileLead(value, preview) + fileLabels(value.files);
    case "thought": {
      const label = oneLine(
        value.content
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.trim() ?? "",
      );
      return `Thought · ${preview ? "Thinking" : value.incomplete ? "incomplete" : "complete"}${value.durationMs === undefined ? "" : ` · ${value.durationMs} ms`} · ${label}`;
    }
    case "message":
      return `${value.role === "user" ? "You" : "Assistant"}${preview ? " · streaming" : value.incomplete ? " · incomplete" : ""}\n${value.content}`;
    case "entry-prompt":
      return "Secant started the Step";
    case "steer":
      return `Steer · ${value.delivery}\n${value.content}`;
    case "agent-call":
      return `Agent call ${value.call} · ${value.reply.replaceAll("-", " ")}${value.refusal === undefined ? "" : ` · ${value.refusal}`} · ${oneLine(value.reason)} · ${value.disposition}`;
    case "tool": {
      const detail =
        value.outcome.kind === "failed"
          ? value.outcome.error
          : value.outcome.kind === "declined"
            ? value.outcome.reason
            : undefined;
      return `${fileLead(value, preview)}${value.files === undefined ? "" : fileLabels(value.files)}${value.cwd === undefined ? "" : `\nCwd · ${value.cwd}`}${value.exitCode === undefined ? "" : `\nExit · ${value.exitCode}`}${detail === undefined ? "" : `\n${detail}`}${value.nativeOmission === undefined ? "" : `\nHarness omission · ${value.nativeOmission}`}${value.tool === "command" && value.output === undefined ? "\nOutput unavailable" : ""}`;
    }
    case "request":
      return `? ${value.description}`;
    case "activity":
      return `↳ ${value.description}`;
    case "turn-result":
      return `Turn · ${value.origin === "managed" ? "Secant started the Step" : value.origin === "human" ? "started by you" : "origin unknown"} · ${value.result}${value.harness === undefined ? "" : ` · ${value.harness}`}${value.model === undefined ? "" : ` · ${value.model}`}${value.durationMs === undefined ? "" : ` · ${value.durationMs} ms`}`;
  }
}

/** The typed file group owns its label positions; text prefixes never identify a file. */
function fileLead(
  value: Extract<SessionHistoryValue, { kind: "tool" | "turn-diff" }>,
  preview: boolean,
): string {
  if (value.kind === "turn-diff")
    return `Turn diff${preview ? " · updating" : ""}${fileRemainder(value.files, value.fileCount)}\n`;
  return `Tool · ${value.tool.replaceAll("-", " ")} · ${value.outcome.kind}${value.count === undefined ? "" : ` · ${value.count.value} ${value.count.unit}`}${fileRemainder(value.files, value.fileCount)}${value.tool === "file-change" && value.files !== undefined ? "" : `\n${value.tool === "command" ? "Command · " : ""}${value.input}`}${value.files === undefined ? "" : "\n"}`;
}
export function historyFileSpans(
  value: SessionHistoryValue,
  preview: boolean,
): NonNullable<TimelineRow["fileSpans"]> {
  if (
    (value.kind !== "tool" && value.kind !== "turn-diff") ||
    value.files === undefined
  )
    return [];
  let start = fileLead(value, preview).length;
  return value.files.slice(0, FILE_LIST_LIMIT).map((file, index) => {
    const end = start + fileLabels([file]).length;
    const span = { index, start, end };
    start = end + 1;
    return span;
  });
}

const FILE_LIST_LIMIT = 10;

function fileRemainder(
  files: Extract<SessionHistoryValue, { kind: "tool" }>["files"],
  count = files?.length ?? 0,
): string {
  const remaining = count - FILE_LIST_LIMIT;
  return remaining > 0 ? ` · ${remaining} more files` : "";
}

function fileLabels(
  files: NonNullable<Extract<SessionHistoryValue, { kind: "tool" }>["files"]>,
): string {
  if (files.length === 0) return "Changed files not reported";
  return files
    .slice(0, FILE_LIST_LIMIT)
    .map(
      (file) =>
        `${file.kind === undefined ? "" : `${file.kind} `}${file.path}${file.additions === undefined ? "" : ` +${file.additions}`}${file.removals === undefined ? "" : ` -${file.removals}`}`,
    )
    .join("\n");
}

/** Collapse display whitespace so tool input and usage fit one line. Other controls reach the display screening rule. */
export function oneLine(text: string): string {
  return text.replace(/[ \r\n\t]+/g, " ").trim();
}

/** Fixed metadata slots live outside history: reports cannot add conversation
 * rows, change its activity count, or resize its viewport. Empty facts stay blank. */
export function reportedMetadata(
  overlay: RunLiveOverlay | undefined,
): readonly string[] {
  const context = overlay?.context;
  const parts: string[] = [];
  if (context?.usedTokens !== undefined)
    parts.push(`used ${context.usedTokens} tokens`);
  if (context?.limitTokens !== undefined)
    parts.push(`capacity ${context.limitTokens} tokens`);
  if (context?.percentage !== undefined)
    parts.push(`reported ${context.percentage}%`);
  for (const window of context?.modelWindows ?? [])
    parts.push(
      `${oneLine(window.model)} capacity ${window.limitTokens} tokens`,
    );
  return [
    parts.length === 0 ? "" : `Context · ${parts.join(", ")}`,
    overlay?.usage ? `Usage · ${oneLine(overlay.usage)}` : "",
  ];
}
