import { compareConversationOrder } from "./conversation-order.js";
import type { HistoryTextEdgeAnalyser } from "./application.js";
import { createHistoryContent } from "./history-content.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readTurnFact } from "../run/store/store.js";
import type { TurnFact } from "../harness/harness.js";
import type {
  AdmitTurnRequest,
  AppendTurnEventRequest,
  SettleTurnRequest,
  TurnRecord,
  TurnEventRecord,
  TranscriptEntryRecord,
} from "../run/store/store.js";
import type { LiveObservation } from "../run/execution/execution.js";
import { runSessionNotFound } from "./problems.js";
import type {
  OpenedProjection,
  Problem,
  SessionHistorySnapshot,
  SessionHistoryValue,
  SessionHistoryRow,
} from "./projection-port.js";
import type { SubscriptionLifecycle } from "./subscription-lifecycle.js";
import type { UpdateStream } from "./update-stream.js";
import {
  historyKey,
  storedFactKey,
  storedHistoryValue,
  resultValue,
  historyRow,
  type HistoryFact,
} from "./history-facts.js";

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
interface IndexedTurn {
  record: TurnRecord;
  readonly modern: boolean;
  readonly stored: Map<string, TurnFact>;
  readonly orders: Map<string, number>;
  nextOrder: number;
  model?: string;
}
interface RunHistory {
  readonly owner: object | undefined;
  readonly turns: Map<string, IndexedTurn>;
  readonly sessions: Set<string>;
  readonly facts: Map<string, HistoryFact>;
  readonly pages: Map<string, HistoryFact[]>;
  readonly pending: Set<string>;
  eventCount: number;
  harness?: string;
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
  cutoff?: HistoryFact;
  hasEarlier: boolean;
  last?: SessionHistorySnapshot;
}
function compare(a: HistoryFact, b: HistoryFact): number {
  return compareConversationOrder(
    { turnSequence: a.turn.sequence, position: a.order },
    { turnSequence: b.turn.sequence, position: b.order },
  );
}
function lowerBound(facts: readonly HistoryFact[], fact: HistoryFact): number {
  let lo = 0,
    hi = facts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(facts[mid]!, fact) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** Stored facts are indexed once. Event updates touch one item; projections visit only the newest window. */
export function createSessionHistory(deps: {
  readonly read: (runId: string) => HistoryRead;
  readonly readEvent: (
    runId: string,
    index: number,
  ) => TurnEventRecord | Problem;
  readonly available: (runId: string) => true | Problem;
  readonly textEdges?: HistoryTextEdgeAnalyser;
  readonly observedOwner: (runId: string) => object | undefined;
  readonly subscriptions: SubscriptionLifecycle;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}) {
  const runs = new Map<string, RunHistory>();
  const observers = new Set<Observer>();
  let stopped = false;
  const content = createHistoryContent({
    available: deps.available,
    textEdges: deps.textEdges,
    readStored(runId, at) {
      let value: SessionHistoryValue | undefined;
      if (at.kind === "event") {
        const event = deps.readEvent(runId, at.index);
        if ("code" in event) return event;
        const fact = readTurnFact(event);
        const turn = runs.get(runId)?.turns.get(event.turnId)?.record;
        value = fact && turn ? storedHistoryValue(fact, turn, true) : undefined;
      } else {
        // Turn inputs and migrated messages are immutable canonical index facts.
        const fact = runs.get(runId)?.facts.get(at.key);
        value = fact?.source === "stored" ? fact.value : undefined;
      }
      return (
        value ?? {
          code: "history-content-missing",
          explanation: "The retained history fact is unavailable.",
          remediation: "Retry the current row.",
          possibleEffects: "none",
        }
      );
    },
  });
  function pruneContent(): void {
    content.prune(
      [...runs.values()].flatMap((run) =>
        [...run.pages.values()].flatMap((page) =>
          page.slice(-200).map((fact) => fact.value),
        ),
      ),
    );
  }
  function put(run: RunHistory, fact: HistoryFact): void {
    const previous = run.facts.get(fact.key);
    if (
      previous?.source === fact.source &&
      isDeepStrictEqual(previous.value, fact.value)
    )
      return;
    const page = run.pages.get(fact.turn.session) ?? [];
    run.pages.set(fact.turn.session, page);
    if (previous !== undefined) {
      previous.turn = fact.turn;
      previous.source = fact.source;
      previous.value = fact.value;
      previous.stored = fact.stored ?? previous.stored;
      return;
    }
    const tail = page.at(-1);
    if (tail === undefined || compare(tail, fact) < 0) page.push(fact);
    else page.splice(lowerBound(page, fact), 0, fact);
    run.facts.set(fact.key, fact);
    for (const older of page.slice(0, Math.max(0, page.length - 200)))
      if (older.source === "preview") remove(run, older.key);
  }
  function remove(run: RunHistory, key: string): void {
    const fact = run.facts.get(key);
    if (fact === undefined) return;
    const page = run.pages.get(fact.turn.session)!;
    page.splice(lowerBound(page, fact), 1);
    run.facts.delete(key);
    run.pending.delete(key);
  }
  function appearance(
    turn: IndexedTurn,
    key: string,
    persisted?: number,
  ): number {
    const existing = turn.orders.get(key);
    if (existing !== undefined) return existing;
    const order = persisted ?? turn.nextOrder;
    turn.orders.set(key, order);
    turn.nextOrder = Math.max(turn.nextOrder, order + 1);
    return order;
  }
  function applyEvent(
    run: RunHistory,
    event: TurnEventRecord,
    index: number,
  ): void {
    const turn = run.turns.get(event.turnId);
    const fact = readTurnFact(event);
    if (turn === undefined || fact === undefined) return;
    const key = storedFactKey(event.turnId, fact, index);
    const previous = turn.stored.get(key);
    if (
      fact.kind === "steer" &&
      fact.data.settlement.kind === "waiting" &&
      previous?.kind === "steer"
    )
      return;
    if (fact.kind === "model") {
      turn.model = fact.data.model;
      if (turn.record.resultKind !== undefined) putResult(run, turn);
      return;
    }
    const order = appearance(turn, key, fact.data.historyOrder ?? index);
    turn.stored.set(key, fact);
    const value = storedHistoryValue(fact, turn.record, turn.modern);
    if (value === undefined) {
      if (fact.kind === "thought") remove(run, key);
      return;
    }
    // A running start does not erase its later live output. Partials and terminal facts do.
    if (
      run.facts.get(key)?.source === "preview" &&
      fact.kind === "tool-call" &&
      fact.data.outcome.kind === "running"
    )
      return;
    put(run, {
      key,
      turn: turn.record,
      order,
      source: "stored",
      value,
      stored: { kind: "event", index },
    });
    run.pending.delete(key);
  }
  function putResult(run: RunHistory, turn: IndexedTurn): void {
    put(run, {
      key: historyKey(turn.record.turnId, "result"),
      turn: turn.record,
      order: Infinity,
      source: "stored",
      value: resultValue(turn.record, run.harness, turn.model),
    });
  }
  function initialize(
    runId: string,
  ): RunHistory | (HistoryRead & { readonly found: false }) {
    const existing = runs.get(runId);
    if (existing !== undefined) return existing;
    const read = deps.read(runId);
    if (!read.found) return read;
    const records = read.records;
    const run: RunHistory = {
      owner: deps.observedOwner(runId),
      turns: new Map(),
      sessions: new Set(records.sessions),
      facts: new Map(),
      pages: new Map(),
      pending: new Set(),
      eventCount: records.events.length,
      harness: records.harness,
    };
    const conversation = new Map<string, TranscriptEntryRecord[]>();
    for (const entry of records.transcript) {
      const entries = conversation.get(entry.turnId) ?? [];
      entries.push(entry);
      conversation.set(entry.turnId, entries);
    }
    for (const record of records.turns) {
      const entries = conversation.get(record.turnId) ?? [];
      const modern = entries.some((entry) => entry.kind !== undefined);
      const turn: IndexedTurn = {
        record,
        modern,
        stored: new Map(),
        orders: new Map(),
        nextOrder: 0,
        model: record.modelChoice?.model,
      };
      run.turns.set(record.turnId, turn);
      if (modern) putInput(run, record);
      else
        for (const [i, entry] of entries.entries()) {
          const key = historyKey(record.turnId, "legacy", entry.seq);
          put(run, {
            key,
            turn: record,
            // The first migrated input precedes activity. All following
            // messages keep authoritative transcript order, including user rows.
            order:
              i === 0 && entry.role === "user"
                ? -1
                : records.events.length + entry.order.position,
            source: "stored",
            value: {
              kind: "message",
              role: entry.role === "user" ? "user" : "assistant",
              content: entry.content,
            },
            stored: { kind: "fact", key },
          });
        }
    }
    for (const [index, event] of records.events.entries())
      applyEvent(run, event, index);
    for (const turn of run.turns.values())
      if (turn.record.resultKind !== undefined) putResult(run, turn);
    runs.set(runId, run);
    return run;
  }
  function refreshOwnership(runId: string): void {
    const run = runs.get(runId);
    const owner = deps.observedOwner(runId);
    // An index is current only while its owner routes every committed write here.
    // Rested or newly acquired Runs must read canonical facts again before reuse.
    if (run !== undefined && (owner === undefined || owner !== run.owner)) {
      run.cancel?.();
      runs.delete(runId);
    }
  }
  function indexed(runId: string): RunHistory | undefined {
    const run = initialize(runId);
    return "found" in run ? undefined : run;
  }
  function putInput(run: RunHistory, turn: TurnRecord): void {
    const key = historyKey(turn.turnId, "input");
    put(run, {
      key,
      turn,
      order: -1,
      source: "stored",
      stored: { kind: "fact", key },
      value:
        turn.origin === "managed"
          ? { kind: "entry-prompt", content: turn.input }
          : { kind: "message", role: "user", content: turn.input },
    });
  }
  function snapshot(observer: Observer): SessionHistorySnapshot {
    const run = initialize(observer.runId);
    const base = {
      family: "session-history" as const,
      runId: observer.runId,
      session: observer.session,
    };
    if ("found" in run) return { ...base, result: run };
    if (!run.sessions.has(observer.session))
      return {
        ...base,
        result: {
          found: false,
          problem: runSessionNotFound(observer.runId, observer.session),
        },
      };
    const page = run.pages.get(observer.session) ?? [];
    if (page.length > 200) {
      const cutoff = page.at(-201)!;
      if (observer.cutoff === undefined || compare(cutoff, observer.cutoff) > 0)
        observer.cutoff = cutoff;
      observer.hasEarlier = true;
    }
    const facts = page
      .slice(-200)
      .filter(
        (fact) =>
          observer.cutoff === undefined || compare(fact, observer.cutoff) > 0,
      );
    const retained = new Set(facts.map((fact) => fact.key));
    for (const key of observer.identities.keys())
      if (!retained.has(key)) observer.identities.delete(key);
    const rows = facts.map((fact) => {
      let identity = observer.identities.get(fact.key);
      if (identity === undefined) {
        identity = {
          id: randomUUID(),
          position: `${observer.prefix}.${String(observer.serial++).padStart(12, "0")}`,
        };
        observer.identities.set(fact.key, identity);
      }
      return {
        ...historyRow(fact, identity),
        value: content.project(observer.runId, fact, observer.prefix),
      };
    });
    return {
      ...base,
      result: {
        found: true,
        history: {
          rows,
          hasEarlier: observer.hasEarlier,
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
  function samePage(
    a: SessionHistorySnapshot | undefined,
    b: SessionHistorySnapshot,
  ): boolean {
    if (a === undefined) return false;
    if (!a.result.found || !b.result.found)
      return isDeepStrictEqual(a.result, b.result);
    const left = a.result.history,
      right = b.result.history;
    return (
      left.hasEarlier === right.hasEarlier &&
      left.rows.length === right.rows.length &&
      left.rows.every((row, i) => {
        const next = right.rows[i]!;
        return (
          row.id === next.id &&
          row.source === next.source &&
          (row.value === next.value || isDeepStrictEqual(row.value, next.value))
        );
      })
    );
  }
  function cancelIdle(run: RunHistory): void {
    if (run.pending.size === 0) {
      run.cancel?.();
      run.cancel = undefined;
    }
  }
  function publish(runId: string): void {
    for (const observer of observers)
      if (observer.runId === runId) {
        const page = snapshot(observer);
        const changed = !samePage(observer.last, page);
        observer.last = page;
        if (changed) observer.updates.push({ kind: "durable", snapshot: page });
      }
    pruneContent();
    const run = runs.get(runId);
    if (run !== undefined) cancelIdle(run);
  }
  function observePreview(
    runId: string,
    turnId: string,
    session: string,
    key: string,
    value: SessionHistoryValue,
  ): void {
    const run = runs.get(runId);
    const turn = run?.turns.get(turnId);
    if (
      run === undefined ||
      turn === undefined ||
      turn.record.session !== session ||
      turn.record.resultKind !== undefined
    )
      return;
    const stored = turn.stored.get(key);
    if (
      stored !== undefined &&
      (stored.kind !== "tool-call" || stored.data.outcome.kind !== "running")
    )
      return;
    const order = appearance(turn, key);
    const firstAppearance = !run.facts.has(key);
    put(run, { key, turn: turn.record, order, source: "preview", value });
    const active = [...observers].filter(
      (observer) => observer.runId === runId && observer.session === session,
    );
    if (active.length === 0) return;
    run.pending.add(key);
    // Allocate in appearance order before the timer, preserving positions across interleaved rows.
    if (firstAppearance) for (const observer of active) snapshot(observer);
    if (!stopped && run.cancel === undefined)
      run.cancel = deps.schedule(() => {
        run.cancel = undefined;
        const pending = new Set(run.pending);
        run.pending.clear();
        for (const observer of observers)
          if (observer.runId === runId) {
            const page = snapshot(observer);
            if (!page.result.found) continue;
            const windowStart = page.result.history.rows[0]?.position;
            if (windowStart === undefined) continue;
            const rowsById = new Map<string, SessionHistoryRow>(
              observer.last?.result.found
                ? observer.last.result.history.rows.map((row) => [row.id, row])
                : [],
            );
            for (const [key, identity] of observer.identities) {
              if (!pending.has(key)) continue;
              const row = page.result.history.rows.find(
                (row) => row.id === identity.id,
              );
              const previous = rowsById.get(identity.id);
              if (
                row?.source === "preview" &&
                (previous?.value !== row.value ||
                  previous.source !== row.source)
              )
                observer.updates.push({
                  kind: "history-preview",
                  row,
                  windowStart,
                  hasEarlier: page.result.history.hasEarlier,
                });
            }
            observer.last = page;
          }
        pruneContent();
      }, 50);
  }
  return {
    open(
      runId: string,
      session: string,
    ): OpenedProjection<SessionHistorySnapshot> {
      refreshOwnership(runId);
      const updates = deps.subscriptions.open<SessionHistorySnapshot>(
        () => () => {
          observers.delete(observer);
          content.closeScope(observer.prefix);
          pruneContent();
          if (![...observers].some((current) => current.runId === runId)) {
            const run = runs.get(runId);
            run?.cancel?.();
            if (run !== undefined) {
              run.cancel = undefined;
              run.pending.clear();
            }
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
        hasEarlier: false,
      };
      observers.add(observer);
      const current = snapshot(observer);
      observer.last = current;
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
        message.turnId,
        message.session,
        historyKey(message.turnId, "message", message.messageId),
        { kind: "message", role: "assistant", content: message.content },
      );
    },
    observeThought(
      runId: string,
      thought: NonNullable<LiveObservation["thought"]>,
    ): void {
      if (thought.content.trim())
        observePreview(
          runId,
          thought.turnId,
          thought.session,
          historyKey(thought.turnId, "thought", thought.summaryId),
          { kind: "thought", content: thought.content },
        );
    },
    observeDiff(
      runId: string,
      diff: NonNullable<LiveObservation["diff"]>,
    ): void {
      observePreview(
        runId,
        diff.turnId,
        diff.session,
        historyKey(diff.turnId, "turn-diff"),
        { kind: "turn-diff", content: diff.content, files: diff.files },
      );
    },
    observeTool(
      runId: string,
      tool: NonNullable<LiveObservation["tool"]>,
    ): void {
      const { callId, parentCallId: _parent, ...call } = tool.call;
      observePreview(
        runId,
        tool.turnId,
        tool.session,
        historyKey(tool.turnId, "tool", callId),
        { kind: "tool", ...call },
      );
    },
    selectedHarness(runId: string, harness: string): void {
      const run = runs.get(runId);
      if (run === undefined || run.harness === harness) return;
      run.harness = harness;
      for (const turn of run.turns.values())
        if (turn.record.resultKind !== undefined) putResult(run, turn);
    },
    prepare(runId: string): void {
      refreshOwnership(runId);
      indexed(runId);
    },
    append(
      runId: string,
      request: AppendTurnEventRequest,
    ): AppendTurnEventRequest {
      const run = runs.get(runId);
      const turn = run?.turns.get(request.turnId);
      const fact = request.fact;
      if (
        run === undefined ||
        turn === undefined ||
        fact.kind === "model" ||
        fact.kind === "agent-call-expired"
      )
        return request;
      const key = storedFactKey(request.turnId, fact, run.eventCount);
      return { ...request, historyOrder: appearance(turn, key) };
    },
    appended(runId: string, event: TurnEventRecord | undefined): void {
      const run = runs.get(runId);
      if (run !== undefined && event !== undefined)
        applyEvent(run, event, run.eventCount++);
    },
    admitted(runId: string, request: AdmitTurnRequest): void {
      const run = runs.get(runId);
      if (run === undefined || run.turns.has(request.turnId)) return;
      const record: TurnRecord = {
        turnId: request.turnId,
        attemptId: request.attemptId,
        session: request.session,
        origin: request.origin,
        kind: request.kind,
        modelChoice: request.modelChoice,
        sequence: run.turns.size,
        input: request.input,
        admittedAt: request.at.toISOString(),
      };
      run.turns.set(record.turnId, {
        record,
        modern: true,
        stored: new Map(),
        orders: new Map(),
        nextOrder: 0,
        model: record.modelChoice?.model,
      });
      run.sessions.add(record.session);
      putInput(run, record);
    },
    settled(runId: string, request: SettleTurnRequest): void {
      const run = runs.get(runId);
      const turn = run?.turns.get(request.turnId);
      if (
        run === undefined ||
        turn === undefined ||
        turn.record.resultKind !== undefined
      )
        return;
      turn.record = {
        ...turn.record,
        resultKind: request.resultKind,
        resultDetail: request.resultDetail,
        settledAt: request.at.toISOString(),
      };
      for (const key of turn.orders.keys()) {
        const row = run.facts.get(key);
        const stored = turn.stored.get(key);
        const value =
          stored === undefined
            ? undefined
            : storedHistoryValue(stored, turn.record, turn.modern);
        if (row?.source === "preview" && value === undefined) remove(run, key);
        else if (value !== undefined)
          put(run, {
            key,
            turn: turn.record,
            order: turn.orders.get(key)!,
            source: "stored",
            stored: row?.stored,
            value,
          });
        run.pending.delete(key);
      }
      putResult(run, turn);
      cancelIdle(run);
    },
    readContent: content.read,
    releaseContent(readId: string): void {
      content.release(readId);
      pruneContent();
    },
    publish,
    closed(runId: string): void {
      for (const observer of observers)
        if (observer.runId === runId) observer.updates.end("subject-gone");
      runs.get(runId)?.cancel?.();
      runs.delete(runId);
      content.closeRun(runId, true);
    },
    shutdown(): void {
      stopped = true;
      content.shutdown();
      for (const run of runs.values()) {
        run.cancel?.();
        run.cancel = undefined;
      }
    },
  };
}
