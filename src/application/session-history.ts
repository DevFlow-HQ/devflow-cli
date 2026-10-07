import { readToolCallEvent, readTurnDiffEvent } from "../run/store/store.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AppendTurnEventRequest,
  TurnRecord,
  TurnEventRecord,
  TranscriptEntryRecord,
} from "../run/store/store.js";
import {
  attemptStepId,
  readAgentCallEvent,
  type LiveObservation,
} from "../run/execution/execution.js";
import { runSessionNotFound } from "./problems.js";
import type {
  OpenedProjection,
  Problem,
  SessionHistoryRow,
  SessionHistorySnapshot,
  SessionHistoryValue,
} from "./projection-port.js";
import type { SubscriptionLifecycle } from "./subscription-lifecycle.js";
import type { UpdateStream } from "./update-stream.js";

interface HistoryRecords {
  readonly turns: readonly TurnRecord[];
  readonly events: readonly TurnEventRecord[];
  readonly transcript: readonly TranscriptEntryRecord[];
  readonly sessions: readonly string[];
  readonly harness?: string;
}
type HistoryRead =
  | { readonly found: true; readonly records: HistoryRecords }
  | { readonly found: false; readonly problem: Problem };
interface Fact {
  readonly key: string;
  readonly turn: TurnRecord;
  readonly order: number;
  readonly source: "stored" | "preview";
  readonly value: SessionHistoryValue;
}
interface LivePreview {
  readonly turnId: string;
  readonly session: string;
  readonly value: SessionHistoryValue;
  readonly order: number;
}
interface RunHistory {
  readonly previews: Map<string, LivePreview>;
  readonly orders: Map<string, Map<string, number>>;
  readonly pending: Set<string>;
  readonly evicted: Set<string>;
  readonly earlier: Set<string>;
  cancel?: () => void;
}
interface Observer {
  readonly runId: string;
  readonly session: string;
  readonly updates: UpdateStream<SessionHistorySnapshot>;
  readonly identities: Map<
    string,
    { readonly id: string; readonly position: string }
  >;
  readonly prefix: string;
  serial: number;
}
const payloadSchema = z.object({
  callId: z.string().optional(),
  messageId: z.string().optional(),
  summaryId: z.string().min(1).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  content: z.string().optional(),
  parentActivity: z.string().optional(),
  incomplete: z.literal(true).optional(),
  historyOrder: z.number().int().nonnegative().optional(),
  steerId: z.string().optional(),
  text: z.string().optional(),
  settlement: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("waiting") }),
      z.object({
        kind: z.literal("delivered"),
        delivery: z.enum(["within-turn", "after-boundary", "re-delivered"]),
      }),
      z.object({
        kind: z.literal("dropped"),
        reason: z.enum(["interrupt", "loss"]),
      }),
    ])
    .optional(),
  requestId: z.string().optional(),
  input: z.string().optional(),
  decision: z.string().optional(),
  by: z.string().optional(),
  harness: z.string().optional(),
  server: z.string().optional(),
  message: z.string().optional(),
  url: z.string().optional(),
  summary: z.string().optional(),
  tool: z.string().optional(),
  phase: z.string().optional(),
  model: z.string().optional(),
});
function payload(
  event: Pick<TurnEventRecord, "payload">,
): z.infer<typeof payloadSchema> | undefined {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(event.payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
function toolKey(turnId: string, callId: string): string {
  return JSON.stringify([turnId, "tool", callId]);
}
function messageKey(turnId: string, messageId: string): string {
  return JSON.stringify([turnId, "message", messageId]);
}
function thoughtKey(turnId: string, summaryId: string): string {
  return JSON.stringify([turnId, "thought", summaryId]);
}
function eventKey(
  event: Pick<TurnEventRecord, "turnId" | "kind" | "payload">,
  index: number,
): string {
  const data = payload(event);
  if (event.kind === "turn-diff")
    return JSON.stringify([event.turnId, "turn-diff"]);
  if (event.kind === "tool-call" && data?.callId !== undefined)
    return toolKey(event.turnId, data.callId);
  if (event.kind === "assistant-content" && data?.messageId !== undefined)
    return messageKey(event.turnId, data.messageId);
  if (event.kind === "thought" && data?.summaryId !== undefined)
    return thoughtKey(event.turnId, data.summaryId);
  if (event.kind === "steer" && data?.steerId !== undefined)
    return JSON.stringify([event.turnId, "steer", data.steerId]);
  const call = readAgentCallEvent({ ...event, at: "" });
  if (call !== undefined)
    return JSON.stringify([event.turnId, "agent-call", call.callId]);
  return JSON.stringify([event.turnId, event.kind, index]);
}

/** Owns the single bounded collection, first appearance, reconciliation and per-Run preview budget. */
export function createSessionHistory(deps: {
  readonly read: (runId: string) => HistoryRead;
  readonly subscriptions: SubscriptionLifecycle;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}) {
  const runs = new Map<string, RunHistory>();
  const observers = new Set<Observer>();
  let stopped = false;
  function state(runId: string): RunHistory {
    let run = runs.get(runId);
    if (run === undefined) {
      run = {
        previews: new Map(),
        orders: new Map(),
        pending: new Set(),
        evicted: new Set(),
        earlier: new Set(),
      };
      runs.set(runId, run);
    }
    return run;
  }
  function ordersFor(run: RunHistory, turnId: string): Map<string, number> {
    let orders = run.orders.get(turnId);
    if (orders === undefined) {
      orders = new Map();
      run.orders.set(turnId, orders);
    }
    return orders;
  }
  function appearance(runId: string, turnId: string, key: string): number {
    const orders = ordersFor(state(runId), turnId);
    const existing = orders.get(key);
    if (existing !== undefined) return existing;
    const read = deps.read(runId);
    let latest = -1;
    if (read.found)
      for (const [index, event] of read.records.events.entries())
        if (event.turnId === turnId) {
          const persisted = payload(event)?.historyOrder;
          if (eventKey(event, index) === key && persisted !== undefined) {
            orders.set(key, persisted);
            return persisted;
          }
          latest = Math.max(latest, persisted ?? -1);
        }
    for (const value of orders.values()) latest = Math.max(latest, value);
    const next = latest + 1;
    orders.set(key, next);
    return next;
  }
  function ordered(
    runId: string,
    records: HistoryRecords,
    session: string,
  ): Fact[] {
    const run = state(runId);
    const facts = new Map<string, Fact>();
    for (const turn of records.turns.filter(
      (turn) => turn.session === session,
    )) {
      const conversation = records.transcript.filter(
        (entry) => entry.turnId === turn.turnId,
      );
      const modern = conversation.some((entry) => entry.kind !== undefined);
      if (modern)
        facts.set(JSON.stringify([turn.turnId, "input"]), {
          key: JSON.stringify([turn.turnId, "input"]),
          turn,
          order: -1,
          source: "stored",
          value:
            turn.origin === "managed" && turn.kind === "interactive-agent"
              ? { kind: "entry-prompt", content: turn.input }
              : { kind: "message", role: "user", content: turn.input },
        });
      else
        for (const [index, entry] of conversation.entries()) {
          const key = JSON.stringify([turn.turnId, "legacy", entry.seq]);
          facts.set(key, {
            key,
            turn,
            order: index,
            source: "stored",
            value: {
              kind: "message",
              role: entry.role === "user" ? "user" : "assistant",
              content: entry.content,
            },
          });
        }
      let model = turn.modelChoice?.model;
      for (const [index, event] of records.events.entries()) {
        if (event.turnId !== turn.turnId) continue;
        const data = payload(event);
        if (event.kind === "model" && data?.model !== undefined)
          model = data.model;
        if (data === undefined) continue;
        let value: SessionHistoryValue | undefined;
        if (
          event.kind === "assistant-content" &&
          data.messageId !== undefined &&
          data.parentActivity === undefined &&
          modern
        )
          value = {
            kind: "message",
            role: "assistant",
            content: data.content ?? "",
            ...(data.incomplete === undefined ? {} : { incomplete: true }),
          };
        if (event.kind === "thought" && data.summaryId !== undefined) {
          const key = thoughtKey(event.turnId, data.summaryId);
          run.previews.delete(key);
          run.pending.delete(key);
          if (data.content?.trim())
            value = {
              kind: "thought",
              content: data.content,
              ...(data.incomplete === undefined ? {} : { incomplete: true }),
              ...(data.durationMs === undefined
                ? {}
                : { durationMs: data.durationMs }),
            };
        }
        if (
          event.kind === "steer" &&
          data.steerId !== undefined &&
          data.text !== undefined &&
          data.settlement !== undefined
        ) {
          const settlement = data.settlement;
          value = {
            kind: "steer",
            content: data.text,
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
        const call = readAgentCallEvent({ ...event, at: "" });
        if (call !== undefined)
          value = {
            kind: "agent-call",
            call: call.id,
            reason: call.reason,
            reply: call.answer.outcome,
            ...(call.answer.outcome === "refused"
              ? { refusal: call.answer.reason }
              : {}),
            disposition:
              turn.resultKind === undefined
                ? "pending"
                : turn.resultKind === "completed"
                  ? "completed"
                  : "dropped",
          };
        if (event.kind === "turn-diff") {
          const diff = readTurnDiffEvent(event);
          if (diff !== undefined)
            value = {
              kind: "turn-diff",
              content: diff.content,
              files: diff.files,
            };
        }
        if (event.kind === "tool-call") {
          const tool = readToolCallEvent(event);
          if (tool !== undefined) {
            const observation = {
              tool: tool.tool,
              input: tool.input,
              outcome: tool.outcome,
              ...(tool.count === undefined ? {} : { count: tool.count }),
              ...(tool.files === undefined ? {} : { files: tool.files }),
            };
            value = {
              kind: "tool",
              ...observation,
              outcome:
                observation.outcome.kind === "running" &&
                turn.resultKind !== undefined
                  ? { kind: "unconfirmed" }
                  : observation.outcome,
            };
          }
        }
        if (event.kind === "tool-activity" && data.tool !== undefined)
          value = {
            kind: "activity",
            description: `${data.tool} ${data.phase ?? ""}${data.summary === undefined ? "" : ` · ${data.summary}`}`,
          };
        if (event.kind === "request-raised" && data.tool !== undefined)
          value = {
            kind: "request",
            description: `Harness Request raised · ${data.tool}${data.input === undefined ? "" : ` · ${data.input}`}`,
          };
        if (event.kind === "request-answered")
          value = {
            kind: "request",
            description: `Harness Request answered${data.by === undefined ? "" : ` · answered by ${data.by === "client-policy" ? "client policy" : data.by}`}${data.decision === undefined ? "" : ` (${data.decision})`}`,
          };
        if (event.kind === "request-expired")
          value = { kind: "request", description: "Harness Request expired" };
        if (event.kind === "elicitation-declined" && data.message !== undefined)
          value = {
            kind: "activity",
            description: `Elicitation declined · ${data.message}${data.url === undefined ? "" : ` · ${data.url}`}`,
          };
        if (value === undefined) continue;
        const key = eventKey(event, index);
        const existing = facts.get(key);
        const order = existing?.order ?? data.historyOrder ?? index;
        facts.set(key, { key, turn, order, source: "stored", value });
        if (value.kind !== "tool" || value.outcome.kind !== "running") {
          run.previews.delete(key);
          run.pending.delete(key);
        }
      }
      for (const [key, message] of run.previews) {
        if (message.turnId !== turn.turnId) continue;
        if (turn.resultKind !== undefined) {
          run.previews.delete(key);
          run.pending.delete(key);
          continue;
        }
        facts.set(key, {
          key,
          turn,
          order: message.order,
          source: "preview",
          value: message.value,
        });
      }
      if (turn.resultKind !== undefined) {
        const duration =
          turn.settledAt === undefined ||
          turn.resultKind === "lost" ||
          turn.resultKind === "not-started"
            ? undefined
            : Date.parse(turn.settledAt) - Date.parse(turn.admittedAt);
        const key = JSON.stringify([turn.turnId, "result"]);
        facts.set(key, {
          key,
          turn,
          order: Infinity,
          source: "stored",
          value: {
            kind: "turn-result",
            origin:
              turn.origin === "human" || turn.origin === "managed"
                ? turn.origin
                : "unknown",
            result: turn.resultKind,
            ...(records.harness === undefined
              ? {}
              : { harness: records.harness }),
            ...(model === undefined ? {} : { model }),
            ...(duration === undefined ||
            !Number.isFinite(duration) ||
            duration < 0
              ? {}
              : { durationMs: duration }),
          },
        });
      }
    }
    return [...facts.values()]
      .filter((fact) => !run.evicted.has(fact.key))
      .sort((a, b) => a.turn.sequence - b.turn.sequence || a.order - b.order);
  }
  function evict(runId: string, session: string, facts: readonly Fact[]): void {
    const run = state(runId);
    for (const fact of facts.slice(0, -200)) {
      run.earlier.add(session);
      run.evicted.add(fact.key);
      run.previews.delete(fact.key);
      run.pending.delete(fact.key);
    }
  }
  function snapshot(observer: Observer): SessionHistorySnapshot {
    const read = deps.read(observer.runId);
    const base = {
      family: "session-history" as const,
      runId: observer.runId,
      session: observer.session,
    };
    if (!read.found) return { ...base, result: read };
    if (!read.records.sessions.includes(observer.session))
      return {
        ...base,
        result: {
          found: false,
          problem: runSessionNotFound(observer.runId, observer.session),
        },
      };
    const facts = ordered(observer.runId, read.records, observer.session);
    for (const fact of facts.slice(-200))
      if (!observer.identities.has(fact.key)) {
        observer.identities.set(fact.key, {
          id: randomUUID(),
          position: `${observer.prefix}.${String(observer.serial++).padStart(12, "0")}`,
        });
      }
    const retained = facts.slice(-200);
    const rows: SessionHistoryRow[] = retained.map((fact) => {
      const identity = observer.identities.get(fact.key)!;
      const step = attemptStepId(fact.turn.attemptId);
      return {
        ...identity,
        source: fact.source,
        turnStartedAt: fact.turn.admittedAt,
        turn: fact.turn.turnId,
        ...(step === undefined ? {} : { step }),
        value: fact.value,
      };
    });
    // Retained identities are subscription-local. Discard old rows' values and prevent late previews from restoring them.
    evict(observer.runId, observer.session, facts);
    return {
      ...base,
      result: {
        found: true,
        history: {
          rows,
          hasEarlier:
            facts.length > 200 ||
            state(observer.runId).earlier.has(observer.session),
          transcriptPage: {
            type: "transcript-page",
            runId: observer.runId,
            session: observer.session,
          },
          transcriptExport: {
            type: "transcript-export",
            runId: observer.runId,
            session: observer.session,
          },
        },
      },
    };
  }
  function publish(runId: string): void {
    if (
      !runs.has(runId) &&
      ![...observers].some((observer) => observer.runId === runId)
    )
      return;
    const read = deps.read(runId);
    if (read.found)
      for (const session of read.records.sessions)
        ordered(runId, read.records, session);
    for (const observer of observers)
      if (observer.runId === runId)
        observer.updates.push({
          kind: "durable",
          snapshot: snapshot(observer),
        });
    const run = runs.get(runId);
    if (run?.pending.size === 0) {
      run.cancel?.();
      run.cancel = undefined;
    }
  }
  function observePreview(
    runId: string,
    preview: Omit<LivePreview, "order">,
    key: string,
  ): void {
    const read = deps.read(runId);
    if (!read.found) return;
    const turn = read.records.turns.find(
      (turn) =>
        turn.turnId === preview.turnId && turn.session === preview.session,
    );
    if (turn === undefined || turn.resultKind !== undefined) return;
    if (
      read.records.events.some((event, index) => {
        if (eventKey(event, index) !== key) return false;
        if (event.kind !== "tool-call") return true;
        const tool = readToolCallEvent(event);
        return tool !== undefined && tool.outcome.kind !== "running";
      })
    )
      return;
    const run = state(runId);
    if (run.evicted.has(key)) return;
    const order = appearance(runId, preview.turnId, key);
    // Ignore a preview for an item already discarded from the shared window.
    if (!run.previews.has(key) && ordersFor(run, preview.turnId).has(key)) {
      const facts = ordered(runId, read.records, preview.session);
      const older = facts.length >= 200 && facts.at(-200);
      if (
        older &&
        (turn.sequence < older.turn.sequence ||
          (turn.sequence === older.turn.sequence && order < older.order))
      )
        return;
    }
    run.previews.set(key, { ...preview, order });
    run.pending.add(key);
    const current = ordered(runId, read.records, preview.session);
    evict(runId, preview.session, current);

    // Allocate identities in first-appearance order even before the coalesced publication.
    for (const observer of observers)
      if (observer.runId === runId && observer.session === preview.session)
        snapshot(observer);
    if (
      !stopped &&
      [...observers].some((observer) => observer.runId === runId) &&
      run.cancel === undefined
    )
      run.cancel = deps.schedule(() => {
        run.cancel = undefined;
        const pending = new Set(run.pending);
        run.pending.clear();
        for (const observer of observers)
          if (observer.runId === runId) {
            const page = snapshot(observer);
            if (!page.result.found) continue;
            const history = page.result.history;
            const windowStart = history.rows[0]?.position;
            if (windowStart === undefined) continue;
            for (const row of history.rows) {
              const factKey = [...observer.identities].find(
                ([, value]) => value.id === row.id,
              )?.[0];
              if (
                row.source === "preview" &&
                factKey !== undefined &&
                pending.has(factKey)
              )
                observer.updates.push({
                  kind: "history-preview",
                  row,
                  windowStart,
                  hasEarlier: history.hasEarlier,
                });
            }
          }
      }, 50);
  }
  return {
    open(
      runId: string,
      session: string,
    ): OpenedProjection<SessionHistorySnapshot> {
      const updates = deps.subscriptions.open<SessionHistorySnapshot>(
        () => () => {
          observers.delete(observer);
          if (![...observers].some((current) => current.runId === runId)) {
            const run = runs.get(runId);
            run?.cancel?.();
            if (run !== undefined) run.cancel = undefined;
          }
        },
      );
      const observer: Observer = {
        runId,
        session,
        updates,
        identities: new Map(),
        prefix: randomUUID(),
        serial: 0,
      };
      observers.add(observer);
      const current = snapshot(observer);
      return {
        snapshot: current,
        updates,
        catchUp: "fresh",
        close: () => updates.close(),
      };
    },
    observe(
      runId: string,
      message: NonNullable<LiveObservation["message"]>,
    ): void {
      observePreview(
        runId,
        {
          turnId: message.turnId,
          session: message.session,
          value: {
            kind: "message",
            role: "assistant",
            content: message.content,
          },
        },
        messageKey(message.turnId, message.messageId),
      );
    },
    observeThought(
      runId: string,
      thought: NonNullable<LiveObservation["thought"]>,
    ): void {
      if (!thought.content.trim()) return;
      observePreview(
        runId,
        {
          turnId: thought.turnId,
          session: thought.session,
          value: { kind: "thought", content: thought.content },
        },
        thoughtKey(thought.turnId, thought.summaryId),
      );
    },
    observeDiff(
      runId: string,
      diff: NonNullable<LiveObservation["diff"]>,
    ): void {
      observePreview(
        runId,
        {
          turnId: diff.turnId,
          session: diff.session,
          value: {
            kind: "turn-diff",
            content: diff.content,
            files: diff.files,
          },
        },
        JSON.stringify([diff.turnId, "turn-diff"]),
      );
    },
    observeTool(
      runId: string,
      tool: NonNullable<LiveObservation["tool"]>,
    ): void {
      const call = tool.call;
      observePreview(
        runId,
        {
          turnId: tool.turnId,
          session: tool.session,
          value: {
            kind: "tool",
            tool: call.tool,
            input: call.input,
            outcome: call.outcome,
            ...(call.count === undefined ? {} : { count: call.count }),
            ...(call.files === undefined ? {} : { files: call.files }),
          },
        },
        toolKey(tool.turnId, call.callId),
      );
    },
    publish,
    append(
      runId: string,
      request: AppendTurnEventRequest,
    ): AppendTurnEventRequest {
      if (
        ![
          "assistant-content",
          "thought",
          "turn-diff",
          "steer",
          "agent-call",
          "tool-activity",
          "tool-call",
          "request-raised",
          "request-answered",
          "request-expired",
          "elicitation-declined",
        ].includes(request.kind)
      )
        return request;
      const parsed = payload(request);
      if (parsed === undefined) return request;
      const read = deps.read(runId);
      const index = read.found ? read.records.events.length : 0;
      const key = eventKey(request, index);
      const historyOrder = appearance(runId, request.turnId, key);
      return {
        ...request,
        payload: JSON.stringify({
          ...JSON.parse(request.payload),
          historyOrder,
        }),
      };
    },
    closed(runId: string): void {
      for (const observer of observers)
        if (observer.runId === runId) observer.updates.end("subject-gone");
      runs.get(runId)?.cancel?.();
      runs.delete(runId);
    },
    shutdown(): void {
      stopped = true;
      for (const run of runs.values()) {
        run.cancel?.();
        run.cancel = undefined;
      }
    },
  };
}
