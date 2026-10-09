import { compareConversationOrder } from "./conversation-order.js";
import {
  createHistoryContent,
  type HistoryTextEdgeAnalyser,
} from "./history-content.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { outlineTurnFact, readTurnFact } from "../run/store/store.js";
import type { TurnFact } from "../harness/harness.js";
import type {
  AdmitTurnRequest,
  AppendTurnEventRequest,
  HistoryOutline,
  SettleTurnRequest,
  TurnEventOutline,
  TurnEventRecord,
  TranscriptEntryRecord,
  TranscriptOrder,
} from "../run/store/store.js";
import type { LiveObservation } from "../run/execution/execution.js";
import { runSessionNotFound } from "./problems.js";
import type {
  OpenedProjection,
  Problem,
  SessionHistorySnapshot,
  SessionHistoryRow,
} from "./projection-port.js";
import type { SubscriptionLifecycle } from "./subscription-lifecycle.js";
import type { UpdateStream } from "./update-stream.js";
import {
  historyKey,
  readHistoryKey,
  storedFactKey,
  storedFactShown,
  storedHistoryValue,
  resultValue,
  historyRow,
  type HistoryFact,
  type HistoryTurn,
  type StoredHistoryValue,
} from "./history-facts.js";

/** Indexed without bodies (#522); a value is read only for a windowed row. */
interface HistoryRecords extends HistoryOutline {
  readonly sessions: readonly string[];
  readonly harness?: string;
}
type HistoryRead =
  | { readonly found: true; readonly records: HistoryRecords }
  | { readonly found: false; readonly problem: Problem };
/** The newest stored event for a key: its coordinate and what ordering reads. */
interface StoredMark {
  readonly index: number;
  readonly kind: TurnFact["kind"];
  readonly running: boolean;
}
interface IndexedTurn {
  record: HistoryTurn;
  readonly modern: boolean;
  readonly stored: Map<string, StoredMark>;
  readonly orders: Map<string, number>;
  nextOrder: number;
  model?: string;
  /** The stored input's conversation `seq`; unknown for an input admitted live. */
  inputSeq?: number;
}
/** Store bodies read together for one window fill. */
interface WindowRead {
  readonly events: ReadonlyMap<number, TurnEventRecord>;
  readonly conversation: ReadonlyMap<number, TranscriptEntryRecord>;
}
/** Outside its Session's newest 200 rows a fact keeps only order, identity and
 * where its value is read again, so retention follows the window (#514). */
type IndexedFact = Omit<HistoryFact, "value"> & {
  value?: StoredHistoryValue;
};
const WINDOW = 200;
// Settlement changes only these stored values: delivery, disposition, or a running outcome.
const SETTLING = new Set<TurnFact["kind"]>([
  "steer",
  "agent-call",
  "tool-call",
  "tool-partial",
]);
interface RunHistory {
  readonly owner: object | undefined;
  readonly turns: Map<string, IndexedTurn>;
  readonly sessions: Set<string>;
  readonly facts: Map<string, IndexedFact>;
  readonly pages: Map<string, IndexedFact[]>;
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
  cutoff?: IndexedFact;
  hasEarlier: boolean;
  last?: SessionHistorySnapshot;
}
function compare(a: IndexedFact, b: IndexedFact): number {
  return compareConversationOrder(
    { turnSequence: a.turn.sequence, position: a.order },
    { turnSequence: b.turn.sequence, position: b.order },
  );
}
function lowerBound(facts: readonly IndexedFact[], fact: IndexedFact): number {
  let lo = 0,
    hi = facts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(facts[mid]!, fact) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const missingFact: Problem = {
  code: "history-content-missing",
  explanation: "The retained history fact is unavailable.",
  remediation: "Retry the current row.",
  possibleEffects: "none",
};
/** Stored facts are indexed once. Event updates touch one item; projections visit only
 * the newest window, and only its facts keep values. An index lives while an observer
 * or the live owner holds its Run. */
export function createSessionHistory(deps: {
  readonly read: (runId: string) => HistoryRead;
  /** Every requested event, or a Problem when any is unreadable. */
  readonly readEvents: (
    runId: string,
    indexes: readonly number[],
  ) => ReadonlyMap<number, TurnEventRecord> | Problem;
  /** Every requested conversation fact by `seq`, or a Problem when any is unreadable. */
  readonly readConversationAt: (
    runId: string,
    seqs: readonly number[],
  ) => ReadonlyMap<number, TranscriptEntryRecord> | Problem;
  /** The newest conversation fact in a Session ordered before `before`. */
  readonly readConversation: (
    runId: string,
    session: string,
    before: TranscriptOrder,
  ) => TranscriptEntryRecord | undefined | Problem;
  readonly available: (runId: string) => true | Problem;
  readonly textEdges?: HistoryTextEdgeAnalyser;
  readonly observedOwner: (runId: string) => object | undefined;
  readonly subscriptions: SubscriptionLifecycle;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly retained?: (runId: string, values: number) => void;
  readonly walked?: Parameters<typeof createHistoryContent>[0]["walked"];
}) {
  const runs = new Map<string, RunHistory>();
  // Event indexes whose stored body fails its schema. The index is built without
  // bodies, so such a row is learnt when first read; it is append-only, so the
  // fact stays true and every rebuild skips the row, as a full build would (#522).
  const unreadable = new Map<string, Set<number>>();
  const observers = new Set<Observer>();
  let stopped = false;
  const content = createHistoryContent({
    available: deps.available,
    textEdges: deps.textEdges,
    walked: deps.walked,
    readStored(runId, at) {
      let value: StoredHistoryValue | undefined;
      if (at.kind === "event") {
        const events = deps.readEvents(runId, [at.index]);
        if ("code" in events) return events;
        const event = events.get(at.index)!;
        const fact = readTurnFact(event);
        const turn = runs.get(runId)?.turns.get(event.turnId)?.record;
        value = fact && turn ? storedHistoryValue(fact, turn, true) : undefined;
      } else {
        // Turn inputs and migrated messages are immutable canonical facts.
        const run = runs.get(runId);
        const fact = run?.facts.get(at.key);
        if (run !== undefined && fact?.source === "stored")
          return fact.value ?? storedValue(runId, run, fact) ?? missingFact;
      }
      return value ?? missingFact;
    },
  });
  function pruneContent(): void {
    content.prune(
      [...runs.values()].flatMap((run) =>
        [...run.pages.values()].flatMap((page) =>
          page
            .slice(-WINDOW)
            .flatMap((fact) => (fact.value === undefined ? [] : [fact.value])),
        ),
      ),
    );
  }
  function inputValue(turn: HistoryTurn, input: string): StoredHistoryValue {
    return turn.origin === "managed"
      ? { kind: "entry-prompt", content: input }
      : { kind: "message", role: "user", content: input };
  }
  /** Undefined when the stored event's body shows no row: it fails its schema. */
  function eventValue(
    runId: string,
    turn: IndexedTurn,
    index: number,
    read?: ReadonlyMap<number, TurnEventRecord>,
  ): StoredHistoryValue | Problem | undefined {
    const events = read?.has(index) ? read : deps.readEvents(runId, [index]);
    if ("code" in events) return events;
    const fact = readTurnFact(events.get(index)!);
    return fact && storedHistoryValue(fact, turn.record, turn.modern);
  }
  /** Read a fact's value again from canonical Store facts, never from a cached body. */
  function storedValue(
    runId: string,
    run: RunHistory,
    fact: IndexedFact,
    read?: WindowRead,
  ): StoredHistoryValue | Problem | undefined {
    const { turnId, kind, id } = readHistoryKey(fact.key);
    const turn = run.turns.get(turnId);
    if (turn === undefined) return missingFact;
    if (kind === "result")
      return resultValue(turn.record, run.harness, turn.model);
    const at = bodyAt(run, fact);
    if (kind === "input" || kind === "legacy") {
      // A Turn input orders before the Turn's first activity; a migrated message at its own sequence.
      const seq = typeof id === "number" ? id : undefined;
      let entry: TranscriptEntryRecord | undefined;
      if (at?.kind === "conversation") {
        const entries = read?.conversation.has(at.seq)
          ? read.conversation
          : deps.readConversationAt(runId, [at.seq]);
        if ("code" in entries) return entries;
        entry = entries.get(at.seq);
      } else {
        const found = deps.readConversation(runId, turn.record.session, {
          turnSequence: turn.record.sequence,
          position: seq ?? 0,
          seq: seq === undefined ? 0 : seq + 1,
        });
        if (found !== undefined && "code" in found) return found;
        entry = found;
      }
      if (
        entry?.turnId !== turnId ||
        (seq === undefined ? entry.order.position !== -1 : entry.seq !== seq)
      )
        return missingFact;
      return seq === undefined
        ? inputValue(turn.record, entry.content)
        : {
            kind: "message",
            role: entry.role === "user" ? "user" : "assistant",
            content: entry.content,
          };
    }
    return at?.kind === "event"
      ? eventValue(runId, turn, at.index, read?.events)
      : missingFact;
  }
  /** Where a stored fact's body is read: its event, or its conversation row. A
   * live-admitted input has no known row and is found by order instead. */
  function bodyAt(
    run: RunHistory,
    fact: IndexedFact,
  ):
    | { readonly kind: "event"; readonly index: number }
    | { readonly kind: "conversation"; readonly seq: number }
    | undefined {
    const { turnId, kind, id } = readHistoryKey(fact.key);
    const turn = run.turns.get(turnId);
    if (kind === "result") return undefined;
    if (kind === "legacy" && typeof id === "number")
      return { kind: "conversation", seq: id };
    if (kind === "input")
      return turn?.inputSeq === undefined
        ? undefined
        : { kind: "conversation", seq: turn.inputSeq };
    const index =
      turn?.stored.get(fact.key)?.index ??
      (fact.stored?.kind === "event" ? fact.stored.index : undefined);
    return index === undefined ? undefined : { kind: "event", index };
  }
  /** One Store pass per body kind for every unread fact. */
  function readWindow(
    runId: string,
    run: RunHistory,
    facts: readonly IndexedFact[],
  ): WindowRead | Problem {
    const indexes: number[] = [],
      seqs: number[] = [];
    for (const fact of facts) {
      const at = fact.value === undefined ? bodyAt(run, fact) : undefined;
      if (at?.kind === "event") indexes.push(at.index);
      else if (at?.kind === "conversation") seqs.push(at.seq);
    }
    const events =
      indexes.length === 0 ? new Map() : deps.readEvents(runId, indexes);
    if ("code" in events) return events;
    const conversation =
      seqs.length === 0 ? new Map() : deps.readConversationAt(runId, seqs);
    if ("code" in conversation) return conversation;
    return { events, conversation };
  }
  /** A fact leaving the window keeps no value. A preview leaves as its stored fact, if any. */
  function evict(run: RunHistory, fact: IndexedFact): void {
    if (fact.source === "preview") {
      const mark = run.turns.get(fact.turn.turnId)?.stored.get(fact.key);
      if (mark === undefined) {
        remove(run, fact.key);
        return;
      }
      fact.source = "stored";
      fact.stored = { kind: "event", index: mark.index };
      run.pending.delete(fact.key);
    }
    fact.value = undefined;
  }
  function put(run: RunHistory, fact: IndexedFact): void {
    const previous = run.facts.get(fact.key);
    if (
      previous?.source === fact.source &&
      previous.value !== undefined &&
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
      if (lowerBound(page, previous) < page.length - WINDOW)
        evict(run, previous);
      return;
    }
    const tail = page.at(-1);
    const at =
      tail === undefined || compare(tail, fact) < 0
        ? page.length
        : lowerBound(page, fact);
    page.splice(at, 0, fact);
    run.facts.set(fact.key, fact);
    // One insertion moves exactly one fact out of the window: itself or the old first row.
    const boundary = page.length - WINDOW - 1;
    if (boundary >= 0) evict(run, at <= boundary ? fact : page[boundary]!);
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
  /** Index one stored event from its outline. Only a live append has its value. */
  function applyEvent(
    run: RunHistory,
    event: TurnEventOutline,
    index: number,
    value?: StoredHistoryValue,
  ): void {
    const turn = run.turns.get(event.turnId);
    const kind = event.kind;
    if (turn === undefined || kind === undefined) return;
    const key = storedFactKey(event.turnId, { ...event, kind }, index);
    const previous = turn.stored.get(key);
    if (
      kind === "steer" &&
      event.state === "waiting" &&
      previous?.kind === "steer"
    )
      return;
    if (kind === "model") {
      if (event.model !== undefined) turn.model = event.model;
      if (turn.record.resultKind !== undefined) putResult(run, turn);
      return;
    }
    const order = appearance(turn, key, event.historyOrder ?? index);
    const running = kind === "tool-call" && event.state === "running";
    turn.stored.set(key, { index, kind, running });
    if (!storedFactShown(event, turn.modern)) {
      if (kind === "thought") remove(run, key);
      return;
    }
    // A running start does not erase its later live output. Partials and terminal facts do.
    if (run.facts.get(key)?.source === "preview" && running) return;
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
    const conversation = new Map<
      string,
      HistoryRecords["conversation"][number][]
    >();
    for (const entry of records.conversation) {
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
        inputSeq: entries.find((entry) => entry.order.position === -1)?.seq,
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
            stored: { kind: "fact", key },
          });
        }
    }
    const skipped = unreadable.get(runId);
    for (const [index, event] of records.events.entries())
      if (!skipped?.has(index)) applyEvent(run, event, index);
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
  function putInput(run: RunHistory, turn: HistoryTurn, input?: string): void {
    const key = historyKey(turn.turnId, "input");
    put(run, {
      key,
      turn,
      order: -1,
      source: "stored",
      stored: { kind: "fact", key },
      value: input === undefined ? undefined : inputValue(turn, input),
    });
  }
  /** Fill the window's unread values in place. A stored body that fails its schema
   * returns `"reindex"`: the index is rebuilt without that row. */
  function windowFacts(
    runId: string,
    run: RunHistory,
    session: string,
  ): HistoryFact[] | Problem | "reindex" {
    const page = run.pages.get(session) ?? [];
    let read: WindowRead = { events: new Map(), conversation: new Map() };
    for (const fact of page.slice(-WINDOW)) {
      if (fact.value === undefined) {
        const at = bodyAt(run, fact);
        if (
          at?.kind === "event"
            ? !read.events.has(at.index)
            : at?.kind === "conversation" && !read.conversation.has(at.seq)
        ) {
          // Read every unread body left in the window together.
          const next = readWindow(runId, run, page.slice(-WINDOW));
          if ("code" in next) return next;
          read = next;
        }
        const value = storedValue(runId, run, fact, read);
        if (value === undefined) {
          if (at?.kind !== "event") return missingFact;
          const skipped = unreadable.get(runId) ?? new Set();
          unreadable.set(runId, skipped.add(at.index));
          return "reindex";
        }
        if ("code" in value) return value;
        fact.value = value;
      }
    }
    return page.slice(-WINDOW) as HistoryFact[];
  }
  function reportRetention(runId: string): void {
    if (deps.retained === undefined) return;
    let values = 0;
    for (const fact of runs.get(runId)?.facts.values() ?? [])
      if (fact.value !== undefined) values++;
    deps.retained(runId, values);
  }
  /** Drop an index no observer or live owner holds, with its content versions. */
  function releaseIdle(runId: string): void {
    const run = runs.get(runId);
    if (
      run === undefined ||
      deps.observedOwner(runId) !== undefined ||
      [...observers].some((observer) => observer.runId === runId)
    )
      return;
    run.cancel?.();
    runs.delete(runId);
    content.closeRun(runId);
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
    const window = windowFacts(observer.runId, run, observer.session);
    if (window === "reindex") {
      // Observer identities and cutoffs compare by key and order, so they survive.
      run.cancel?.();
      runs.delete(observer.runId);
      return snapshot(observer);
    }
    if ("code" in window)
      return { ...base, result: { found: false, problem: window } };
    const page = run.pages.get(observer.session) ?? [];
    if (page.length > WINDOW) {
      const cutoff = page.at(-WINDOW - 1)!;
      if (observer.cutoff === undefined || compare(cutoff, observer.cutoff) > 0)
        observer.cutoff = cutoff;
      observer.hasEarlier = true;
    }
    const facts = window.filter(
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
    releaseIdle(runId);
    reportRetention(runId);
  }
  function observePreview(
    runId: string,
    turnId: string,
    session: string,
    key: string,
    value: StoredHistoryValue,
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
    if (stored !== undefined && !stored.running) return;
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
            releaseIdle(runId);
            reportRetention(runId);
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
      reportRetention(runId);
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
      const key = storedFactKey(
        request.turnId,
        outlineTurnFact(fact),
        run.eventCount,
      );
      return { ...request, historyOrder: appearance(turn, key) };
    },
    appended(runId: string, event: TurnEventRecord | undefined): void {
      const run = runs.get(runId);
      if (run === undefined || event === undefined) return;
      const index = run.eventCount++;
      const fact = readTurnFact(event);
      const turn = run.turns.get(event.turnId);
      if (fact === undefined || turn === undefined) return;
      applyEvent(
        run,
        { turnId: event.turnId, ...outlineTurnFact(fact) },
        index,
        storedHistoryValue(fact, turn.record, turn.modern),
      );
    },
    admitted(runId: string, request: AdmitTurnRequest): void {
      const run = runs.get(runId);
      if (run === undefined || run.turns.has(request.turnId)) return;
      const record: HistoryTurn = {
        turnId: request.turnId,
        attemptId: request.attemptId,
        session: request.session,
        origin: request.origin,
        kind: request.kind,
        modelChoice: request.modelChoice,
        sequence: run.turns.size,
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
      putInput(run, record, request.input);
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
        run.pending.delete(key);
        const row = run.facts.get(key);
        const stored = turn.stored.get(key);
        // A preview always settles. A stored value changes only for a settling
        // kind, and an evicted one is read again with the settled Turn on re-entry.
        const refresh =
          row?.source === "preview" ||
          (row?.value !== undefined &&
            stored !== undefined &&
            SETTLING.has(stored.kind));
        if (row === undefined || !refresh) continue;
        const value =
          stored === undefined
            ? undefined
            : (eventValue(runId, turn, stored.index) ?? missingFact);
        if (value !== undefined && "code" in value) {
          // Never keep the unsettled value: the next page reads it again.
          evict(run, row);
          continue;
        }
        if (row.source === "preview" && value === undefined) remove(run, key);
        else if (value !== undefined)
          put(run, {
            key,
            turn: turn.record,
            order: turn.orders.get(key)!,
            source: "stored",
            stored: row.stored,
            value,
          });
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
      unreadable.delete(runId);
      content.closeRun(runId);
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
