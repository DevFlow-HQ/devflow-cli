import type { TurnFact } from "../harness/harness.js";
import { createHash } from "node:crypto";
import { fitEncoded } from "./encoded-json.js";
import { attemptStepId } from "../run/execution/execution.js";
import type { TurnEventOutline, TurnRecord } from "../run/store/store.js";
import type {
  SessionHistoryRow,
  SessionHistoryValue,
} from "./projection-port.js";

export type StoredFileChange = Extract<
  TurnFact,
  { readonly kind: "turn-diff" }
>["data"]["files"][number];
/** A history value as Application holds it. Unlike the delivered value, its file
 * changes keep their Harness-supplied patches, which only content reads expose. */
export type StoredHistoryValue =
  | Exclude<SessionHistoryValue, { readonly kind: "tool" | "turn-diff" }>
  | (Omit<Extract<SessionHistoryValue, { readonly kind: "tool" }>, "files"> & {
      readonly files?: readonly StoredFileChange[];
    })
  | (Omit<
      Extract<SessionHistoryValue, { readonly kind: "turn-diff" }>,
      "files"
    > & { readonly files: readonly StoredFileChange[] });

/** Where a stored fact's immutable retained text is read again: its append-only
 * event, or an immutable indexed fact such as a Turn input or migrated message. */
export type StoredAt =
  | { readonly kind: "event"; readonly index: number }
  | { readonly kind: "fact"; readonly key: string };
/** The Turn fields history reads. The index never keeps a Turn's input body. */
export type HistoryTurn = Omit<TurnRecord, "input">;
export interface HistoryFact {
  readonly key: string;
  turn: HistoryTurn;
  readonly order: number;
  source: "stored" | "preview";
  value: StoredHistoryValue;
  stored?: StoredAt;
}
export function historyKey(
  turnId: string,
  kind: string,
  id?: string | number,
): string {
  return JSON.stringify([turnId, kind, ...(id === undefined ? [] : [id])]);
}
/** The parts `historyKey` joined. */
export function readHistoryKey(key: string): {
  readonly turnId: string;
  readonly kind: string;
  readonly id?: string | number;
} {
  const [turnId, kind, id] = JSON.parse(key) as [
    string,
    string,
    (string | number)?,
  ];
  return { turnId, kind, id };
}
export function storedFactKey(
  turnId: string,
  fact: Pick<TurnEventOutline, "id"> & { readonly kind: TurnFact["kind"] },
  index: number,
): string {
  switch (fact.kind) {
    case "tool-call":
    case "tool-partial":
      return historyKey(turnId, "tool", fact.id);
    case "assistant-content":
      return historyKey(turnId, "message", fact.id ?? index);
    case "thought":
      return historyKey(turnId, "thought", fact.id);
    case "turn-diff":
      return historyKey(turnId, "turn-diff");
    case "steer":
      return historyKey(turnId, "steer", fact.id);
    case "agent-call":
      return historyKey(turnId, "agent-call", fact.id);
    default:
      return historyKey(turnId, fact.kind, index);
  }
}
/** Whether `storedHistoryValue` gives the outlined fact a row, decided without its body. */
export function storedFactShown(
  fact: Omit<TurnEventOutline, "turnId">,
  modern: boolean,
): boolean {
  switch (fact.kind) {
    case "assistant-content":
      return modern && fact.id !== undefined && fact.nested === undefined;
    case "thought":
      return fact.blank === undefined;
    case "model":
    case "agent-call-expired":
    case undefined:
      return false;
    default:
      return true;
  }
}
export function storedHistoryValue(
  fact: TurnFact,
  turn: HistoryTurn,
  modern: boolean,
): StoredHistoryValue | undefined {
  switch (fact.kind) {
    case "assistant-content":
      return modern &&
        fact.data.messageId !== undefined &&
        fact.data.parentActivity === undefined
        ? {
            kind: "message",
            role: "assistant",
            content: fact.data.content,
            ...(fact.data.incomplete === undefined ? {} : { incomplete: true }),
          }
        : undefined;
    case "thought":
      return fact.data.content.trim()
        ? {
            kind: "thought",
            content: fact.data.content,
            ...(fact.data.incomplete === undefined ? {} : { incomplete: true }),
            ...(fact.data.durationMs === undefined
              ? {}
              : { durationMs: fact.data.durationMs }),
          }
        : undefined;
    case "steer": {
      const settlement = fact.data.settlement;
      return {
        kind: "steer",
        content: fact.data.text,
        delivery:
          settlement.kind === "delivered"
            ? settlement.delivery
            : settlement.kind === "dropped"
              ? settlement.reason === "interrupt"
                ? "not-delivered"
                : "unconfirmed"
              : turn.resultKind === undefined
                ? "waiting"
                : turn.resultKind === "interrupted"
                  ? "not-delivered"
                  : "unconfirmed",
      };
    }
    case "agent-call":
      return {
        kind: "agent-call",
        call: fact.data.id,
        reason: fact.data.reason,
        reply: fact.data.answer.outcome,
        ...(fact.data.answer.outcome === "refused"
          ? { refusal: fact.data.answer.reason }
          : {}),
        disposition:
          turn.resultKind === undefined
            ? "pending"
            : turn.resultKind === "completed"
              ? "completed"
              : "dropped",
      };
    case "turn-diff":
      return {
        kind: "turn-diff",
        content: fact.data.content,
        files: fact.data.files,
      };
    case "tool-call":
    case "tool-partial": {
      const {
        callId: _,
        parentCallId: _parent,
        historyOrder: _order,
        ...tool
      } = fact.data;
      return {
        kind: "tool",
        ...tool,
        outcome:
          tool.outcome.kind === "running" && turn.resultKind !== undefined
            ? { kind: "unconfirmed" }
            : tool.outcome,
      };
    }
    case "tool-activity":
      return {
        kind: "activity",
        description: `${fact.data.tool} ${fact.data.phase ?? ""}${fact.data.summary === undefined ? "" : ` · ${fact.data.summary}`}`,
      };
    case "request-raised":
      return {
        kind: "request",
        description: `Harness Request raised · ${fact.data.tool}${fact.data.input === undefined ? "" : ` · ${fact.data.input}`}`,
      };
    case "request-answered":
      return {
        kind: "request",
        description: `Harness Request answered${fact.data.by === undefined ? "" : ` · answered by ${fact.data.by === "client-policy" ? "client policy" : fact.data.by}`}${fact.data.decision === undefined ? "" : ` (${fact.data.decision})`}`,
      };
    case "request-expired":
      return { kind: "request", description: "Harness Request expired" };
    case "elicitation-declined":
      return {
        kind: "activity",
        description: `Elicitation declined · ${fact.data.message}${fact.data.url === undefined ? "" : ` · ${fact.data.url}`}`,
      };
    case "model":
    case "agent-call-expired":
      return undefined;
    default: {
      const exhaustive: never = fact;
      return exhaustive;
    }
  }
}
export function resultValue(
  turn: HistoryTurn,
  harness?: string,
  model = turn.modelChoice?.model,
): StoredHistoryValue {
  const duration =
    turn.settledAt === undefined ||
    turn.resultKind === "lost" ||
    turn.resultKind === "not-started"
      ? undefined
      : Date.parse(turn.settledAt) - Date.parse(turn.admittedAt);
  return {
    kind: "turn-result",
    origin:
      turn.origin === "human" || turn.origin === "managed"
        ? turn.origin
        : "unknown",
    result: turn.resultKind ?? "unknown",
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(duration === undefined || !Number.isFinite(duration) || duration < 0
      ? {}
      : { durationMs: duration }),
  };
}
/** Bundle-authored Step ids are row headers inside the encoded allowance too. A cut
 * id keeps a digest, so distinct Steps stay distinct dividers; the full id remains
 * on the `run` Projection. */
function stepHeader(step: string): string {
  if (fitEncoded(step, 512, 1024) === step) return step;
  const digest = createHash("sha256").update(step).digest("hex").slice(0, 8);
  return `${fitEncoded(step, 500, 1000)} #${digest}`;
}
export function historyRow(
  fact: HistoryFact,
  identity: { readonly id: string; readonly position: string },
): SessionHistoryRow {
  const step = attemptStepId(fact.turn.attemptId);
  return {
    ...identity,
    source: fact.source,
    turnStartedAt: fact.turn.admittedAt,
    turn: fact.turn.turnId,
    ...(step === undefined ? {} : { step: stepHeader(step) }),
    value: fact.value,
  };
}
