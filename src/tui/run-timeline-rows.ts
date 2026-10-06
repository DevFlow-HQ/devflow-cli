import stripAnsi from "strip-ansi";
import type {
  RunLiveOverlay,
  RunTimelineEvent,
  RunView,
  SessionHistoryView,
  SessionHistoryValue,
} from "../application/projection-port.js";
import type { Rule } from "./wrap.js";

/** One row in the Workbench's combined durable + live timeline: one logical line,
 *  which the Workbench wraps at its width (#288), under the dividers that lead it
 *  (#289). */
export interface TimelineRow {
  readonly key: string;
  readonly text: string;
  readonly at?: string;
  readonly placementRank?: number;
  readonly step?: string;
  readonly session?: string;
  readonly sessionName?: string;
  readonly iterationEnd?: true;
  readonly oneLine?: boolean;
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
  const conversation = [
    ...durableTimelineRows(
      run.timeline.filter((event) => event.session === undefined),
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
            text: `The agent has asked to end this ${run.pendingAgentCompletion.call === "stage_done" ? "Stage" : "Step"} · ${screenReason(run.pendingAgentCompletion.reason)}`,
            oneLine: true,
          },
        ]
      : []),
    // The checkpoint message is authored and may run long, so it wraps.
    ...(run.heldForReview !== undefined
      ? [
          {
            key: "agent-completion:held",
            text: `◆ Held for review · the agent's Continue waits for you · ${screenReason(run.heldForReview.message)}`,
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
    } · ${screenReason(event.reason ?? "")}`;
  switch (event.event) {
    case "agent-call": {
      const call = event.agentCall;
      if (call === undefined) return "Agent call";
      return `Agent call ${call.id} · ${call.answer.outcome === "refused" ? `refused · ${call.answer.reason}` : call.disposition === "dropped" ? "dropped" : call.answer.outcome === "held-for-review" ? "held for review" : "accepted, takes effect when this Turn finishes"} · ${screenReason(call.reason)}`;
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
      return stripAnsi(`? Elicitation declined${evidence}${detail}`).replace(
        /\p{Cc}/gu,
        " ",
      );
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
      text: historyLabel(row.value, row.source === "preview"),
      ...(row.value.kind === "agent-call" ? { oneLine: true } : {}),
      ...(row.value.kind === "thought"
        ? { thought: { ...row.value, live: row.source === "preview" } }
        : {}),
      dividers,
    };
  });
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

function historyLabel(value: SessionHistoryValue, preview: boolean): string {
  switch (value.kind) {
    case "thought": {
      const label = screenReason(
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
      return `Agent call ${value.call} · ${value.reply.replaceAll("-", " ")}${value.refusal === undefined ? "" : ` · ${value.refusal}`} · ${screenReason(value.reason)} · ${value.disposition}`;
    case "tool": {
      const label = value.outcome.kind;
      const detail =
        value.outcome.kind === "failed"
          ? value.outcome.error
          : value.outcome.kind === "declined"
            ? value.outcome.reason
            : undefined;
      return `Tool · ${value.tool.replaceAll("-", " ")} · ${label}${value.count === undefined ? "" : ` · ${value.count.value} ${value.count.unit}`}\n${value.input}${detail === undefined ? "" : `\n${detail}`}`;
    }
    case "request":
      return `? ${value.description}`;
    case "activity":
      return `↳ ${value.description}`;
    case "turn-result":
      return `Turn · ${value.origin === "managed" ? "Secant started the Step" : value.origin === "human" ? "started by you" : "origin unknown"} · ${value.result}${value.harness === undefined ? "" : ` · ${value.harness}`}${value.model === undefined ? "" : ` · ${value.model}`}${value.durationMs === undefined ? "" : ` · ${value.durationMs} ms`}`;
  }
}

/** Collapse whitespace so a serialized tool input or usage string stays one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function screenReason(reason: string): string {
  return stripAnsi(reason)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
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
