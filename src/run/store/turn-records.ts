import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  max,
  ne,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { turnFactSchemas, type TurnFact } from "./turn-facts.js";
import { harnessSessions, turnEvents, turns } from "./run-schema.js";
import type {
  AdmitTurnRequest,
  AppendTurnEventRequest,
  HarnessSessionRecord,
  HistoryOutline,
  SettleTurnRequest,
  TranscriptEntryRecord,
  TranscriptPage,
  TranscriptPageRequest,
  TurnEventOutline,
  TurnEventRecord,
  TurnRecord,
} from "./store.js";

// The Turn and Session records plus their canonical conversation/history rows.
// Transcript pages and exports read those rows without another conversation copy. A private
// submodule of the Run Store (A32). Nothing here consults the fence: every function
// is a plain write or read against the handle it is given. The `RunOwner` members
// that call in here keep their names and keep the fencing re-check; the one other
// caller, the startup reconciler's `settleAbandonedTurns`, runs before any owner is
// acquired and is deliberately unfenced.

const turnRow = z.object({
  turn_id: z.string(),
  attempt_id: z.string(),
  session_key: z.string(),
  origin: z.string(),
  kind: z.string().nullable(),
  requested_model: z.string().nullable(),
  requested_effort: z.string().nullable(),
  sequence: z.number(),
  admitted_at: z.string(),
  result_kind: z.string().nullable(),
  result_detail: z.string().nullable(),
  settled_at: z.string().nullable(),
});
const turnEventRow = z.object({
  turn_id: z.string(),
  kind: z.string(),
  payload: z.string(),
  at: z.string(),
});
const harnessSessionRow = z.object({
  session_key: z.string(),
  availability: z.string(),
  availability_detail: z.string().nullable(),
});
type TurnFactKind = TurnFact["kind"];
type TurnFactOf<K extends TurnFactKind> = Extract<TurnFact, { kind: K }>;
function checkedAs<K extends TurnFactKind>(kind: K) {
  return (data: unknown): TurnFactOf<K> | z.ZodError => {
    const parsed = turnFactSchemas[kind].safeParse(data);
    // The schema indexed by `kind` parses exactly that kind's data.
    return parsed.success
      ? ({ kind, data: parsed.data } as TurnFactOf<K>)
      : parsed.error;
  };
}
// One keyed check per schema kind, shared by every write and read: a kind added to
// `turnFactSchemas` without an entry here fails type-checking.
const turnFactChecks: {
  readonly [K in TurnFactKind]: (data: unknown) => TurnFactOf<K> | z.ZodError;
} = {
  "assistant-content": checkedAs("assistant-content"),
  thought: checkedAs("thought"),
  "turn-diff": checkedAs("turn-diff"),
  "tool-call": checkedAs("tool-call"),
  "tool-partial": checkedAs("tool-partial"),
  steer: checkedAs("steer"),
  model: checkedAs("model"),
  "agent-call": checkedAs("agent-call"),
  "agent-call-expired": checkedAs("agent-call-expired"),
  "tool-activity": checkedAs("tool-activity"),
  "request-raised": checkedAs("request-raised"),
  "request-answered": checkedAs("request-answered"),
  "request-expired": checkedAs("request-expired"),
  "elicitation-declined": checkedAs("elicitation-declined"),
};
function checkTurnFact(kind: string, data: unknown): TurnFact | Error {
  return Object.hasOwn(turnFactChecks, kind)
    ? turnFactChecks[kind as TurnFactKind](data)
    : new TypeError("Turn event kind has no schema.");
}
// Only qualified settled messages and delivered Steers are conversation rows.
// Unknown or unqualified metadata remains absent.
/** Decode persisted normalized facts once at the Store ingress. Unknown legacy facts remain unqualified. */
export function readTurnFact(
  event: Pick<TurnEventRecord, "kind" | "payload">,
): TurnFact | undefined {
  let data: unknown;
  try {
    data = JSON.parse(event.payload);
  } catch {
    return undefined;
  }
  const fact = checkTurnFact(event.kind, data);
  return fact instanceof Error ? undefined : fact;
}
/** The outline `readHistoryOutline` reads in SQL, taken from a decoded fact. */
export function outlineTurnFact(
  fact: TurnFact,
): Omit<TurnEventOutline, "turnId"> & { readonly kind: TurnFact["kind"] } {
  const outline = {
    kind: fact.kind,
    ...(fact.data.historyOrder === undefined
      ? {}
      : { historyOrder: fact.data.historyOrder }),
  };
  switch (fact.kind) {
    case "tool-call":
    case "tool-partial":
      return {
        ...outline,
        id: fact.data.callId,
        state: fact.data.outcome.kind,
      };
    case "agent-call":
      return { ...outline, id: fact.data.callId };
    case "assistant-content":
      return {
        ...outline,
        ...(fact.data.messageId === undefined
          ? {}
          : { id: fact.data.messageId }),
        ...(fact.data.parentActivity === undefined ? {} : { nested: true }),
      };
    case "thought":
      return {
        ...outline,
        id: fact.data.summaryId,
        ...(fact.data.content.trim() ? {} : { blank: true }),
      };
    case "steer":
      return {
        ...outline,
        id: fact.data.steerId,
        state: fact.data.settlement.kind,
      };
    case "model":
      return { ...outline, model: fact.data.model };
    default:
      return outline;
  }
}
export function readToolCallEvent(
  event: Pick<TurnEventRecord, "kind" | "payload">,
) {
  const fact = readTurnFact(event);
  return fact?.kind === "tool-call" || fact?.kind === "tool-partial"
    ? fact.data
    : undefined;
}
export function readSteerEvent(
  event: Pick<TurnEventRecord, "kind" | "payload">,
) {
  const fact = readTurnFact(event);
  return fact?.kind === "steer" ? fact.data : undefined;
}
export function readAgentCallEvent(
  event: Pick<TurnEventRecord, "kind" | "payload">,
) {
  const fact = readTurnFact(event);
  return fact?.kind === "agent-call" ? fact.data : undefined;
}
const messagePayload = z.object({
  role: z.string(),
  content: z.string().optional(),
  kind: z.enum(["message", "steer", "entry-prompt"]).optional(),
  turn: z.string().optional(),
  steer: z
    .object({
      id: z.string(),
      delivery: z.enum(["within-turn", "after-boundary", "re-delivered"]),
    })
    .optional(),
  incomplete: z.literal(true).optional(),
});

function nextConversationPosition(db: SQLiteBunDatabase): number {
  return (
    (db
      .select({ value: max(turnEvents.transcript_seq) })
      .from(turnEvents)
      .get()?.value ?? 0) + 1
  );
}

// Admit a Turn (#116): the `turn` row is written before the stdin frame is sent
// (the durable admission the Adapter awaits), the named Session is upserted `open`,
// and the rendered input is appended as a `user` transcript entry — all or nothing,
// so a crash cannot leave a Turn admitted without its Session or transcript.
export function admitTurn(
  db: SQLiteBunDatabase,
  request: AdmitTurnRequest,
): void {
  const at = request.at.toISOString();
  // The Turn's position in the Run, computed under the caller's write lock so it
  // never races. Turns are append-only, so the count is the next zero-based sequence.
  const sequence = db.select({ value: count() }).from(turns).get()?.value ?? 0;
  db.insert(harnessSessions)
    .values({
      session_key: request.session,
      native_session_id: request.recoveryCoordinate,
      availability: "open",
      availability_detail: null,
      harness: request.harness,
      profile_digest: null,
      created_at: at,
      updated_at: at,
    })
    .onConflictDoUpdate({
      target: harnessSessions.session_key,
      set: {
        native_session_id: request.recoveryCoordinate,
        availability: "open",
        availability_detail: null,
        updated_at: at,
      },
    })
    .run();
  db.insert(turns)
    .values({
      turn_id: request.turnId,
      attempt_id: request.attemptId,
      session_key: request.session,
      origin: request.origin,
      kind: request.kind,
      requested_model: request.modelChoice?.model ?? null,
      requested_effort: request.modelChoice?.effort ?? null,
      sequence,
      input: request.input,
      admitted_at: at,
      result_kind: null,
      result_detail: null,
      settled_at: null,
    })
    .run();
  // Content remains on the admitted Turn. Its first row refers to that input,
  // rather than storing another transcript copy.
  db.insert(turnEvents)
    .values({
      turn_id: request.turnId,
      kind: "turn-input",
      payload: JSON.stringify({
        role: "user",
        kind: request.origin === "managed" ? "entry-prompt" : "message",
        turn: request.turnId,
      }),
      transcript_seq: nextConversationPosition(db),
      at,
    })
    .run();
}

/** A checked append: stored (absent when ignored as a duplicate), or refused as
 *  malformed before anything is written. */
export type AppendedTurnEvent =
  | { readonly kind: "appended"; readonly event?: TurnEventRecord }
  | { readonly kind: "malformed"; readonly cause: Error };

// Append one normalized durable Turn event (#116), append-only. Every fact, with
// its stamped order, is checked against its kind's schema before any write.
export function appendTurnEvent(
  db: SQLiteBunDatabase,
  request: AppendTurnEventRequest,
): AppendedTurnEvent {
  const fact = checkTurnFact(
    request.fact.kind,
    request.historyOrder === undefined
      ? request.fact.data
      : { ...request.fact.data, historyOrder: request.historyOrder },
  );
  if (fact instanceof Error) return { kind: "malformed", cause: fact };
  let payload: object = fact.data;
  let transcriptSeq: number | undefined;
  if (fact.kind === "turn-diff") {
    const duplicate = db
      .select({ seq: turnEvents.seq })
      .from(turnEvents)
      .where(
        and(
          eq(turnEvents.turn_id, request.turnId),
          eq(turnEvents.kind, "turn-diff"),
        ),
      )
      .get();
    if (duplicate !== undefined) return { kind: "appended" };
  } else if (fact.kind === "thought") {
    const duplicate = db
      .select({ seq: turnEvents.seq })
      .from(turnEvents)
      .where(
        and(
          eq(turnEvents.turn_id, request.turnId),
          eq(turnEvents.kind, "thought"),
          sql`json_extract(${turnEvents.payload}, '$.summaryId') = ${fact.data.summaryId}`,
        ),
      )
      .get();
    if (duplicate !== undefined) return { kind: "appended" };
  } else if (fact.kind === "tool-call" || fact.kind === "tool-partial") {
    const call = fact.data;
    const previous = db
      .select({ payload: turnEvents.payload, kind: turnEvents.kind })
      .from(turnEvents)
      .where(
        and(
          eq(turnEvents.turn_id, request.turnId),
          sql`${turnEvents.kind} in ('tool-call', 'tool-partial')`,
          sql`json_extract(${turnEvents.payload}, '$.callId') = ${call.callId}`,
        ),
      )
      .orderBy(asc(turnEvents.seq))
      .all()
      .flatMap((row) => {
        const parsed = readToolCallEvent({
          kind: row.kind,
          payload: row.payload,
        });
        return parsed === undefined ? [] : [{ kind: row.kind, call: parsed }];
      });
    if (
      previous.some((row) => row.call.outcome.kind !== "running") ||
      (fact.kind === "tool-call" &&
        call.outcome.kind === "running" &&
        previous.length > 0) ||
      (fact.kind === "tool-partial" &&
        previous.some((row) => row.kind === "tool-partial"))
    )
      return { kind: "appended" };
    payload = {
      ...call,
      ...(previous[0]?.call.historyOrder === undefined
        ? {}
        : { historyOrder: previous[0].call.historyOrder }),
    };
  } else if (fact.kind === "assistant-content") {
    const message = fact.data;
    if (
      message.messageId !== undefined &&
      message.parentActivity === undefined
    ) {
      // The same native message can be repeated. Its first settled fact wins.
      const duplicate = db
        .select({ seq: turnEvents.seq })
        .from(turnEvents)
        .where(
          and(
            eq(turnEvents.turn_id, request.turnId),
            eq(turnEvents.kind, "assistant-content"),
            sql`json_extract(${turnEvents.payload}, '$.messageId') = ${message.messageId}`,
          ),
        )
        .get();
      if (duplicate !== undefined) return { kind: "appended" };
      payload = {
        ...message,
        role: "assistant",
        kind: "message",
        turn: request.turnId,
      };
      transcriptSeq = nextConversationPosition(db);
    }
  } else if (fact.kind === "steer") {
    const steer = fact.data;
    if (steer.settlement.kind === "delivered") {
      const duplicate = db
        .select({ seq: turnEvents.seq })
        .from(turnEvents)
        .where(
          and(
            eq(turnEvents.turn_id, request.turnId),
            eq(turnEvents.kind, "steer"),
            isNotNull(turnEvents.transcript_seq),
            sql`json_extract(${turnEvents.payload}, '$.steerId') = ${steer.steerId}`,
          ),
        )
        .get();
      if (duplicate !== undefined) return { kind: "appended" };
      payload = {
        ...steer,
        role: "user",
        content: steer.text,
        kind: "steer",
        turn: request.turnId,
        steer: {
          id: steer.steerId,
          delivery: steer.settlement.delivery,
        },
      };
      transcriptSeq = nextConversationPosition(db);
    }
  }
  const row = db
    .insert(turnEvents)
    .values({
      turn_id: request.turnId,
      kind: fact.kind,
      payload: JSON.stringify(payload),
      transcript_seq: transcriptSeq ?? null,
      at: request.at.toISOString(),
    })
    .returning()
    .get();
  return {
    kind: "appended",
    event: {
      turnId: row.turn_id,
      kind: row.kind,
      payload: row.payload,
      at: row.at,
    },
  };
}

// Settle a Turn: immutable once settled, so the update fires only while the
// result is null. Messages already reside in canonical events; no final copy.
export function settleTurn(
  db: SQLiteBunDatabase,
  request: SettleTurnRequest,
): void {
  const at = request.at.toISOString();
  // Immutable: once a Turn's result is set, the whole settle is a no-op — the
  // Session availability and transcript it recorded are settled truth too.
  const current = db
    .select({ result_kind: turns.result_kind })
    .from(turns)
    .where(eq(turns.turn_id, request.turnId))
    .get();
  if (current === undefined || current.result_kind !== null) return;
  db.update(turns)
    .set({
      result_kind: request.resultKind,
      result_detail: request.resultDetail,
      settled_at: at,
    })
    .where(and(eq(turns.turn_id, request.turnId), isNull(turns.result_kind)))
    .run();
  db.update(harnessSessions)
    .set({
      availability: request.availability,
      availability_detail: request.availabilityDetail ?? null,
      updated_at: at,
    })
    .where(eq(harnessSessions.session_key, request.session))
    .run();
}

// An owner death mid-Turn leaves the Turn admitted without a settled result:
// no terminal truth survived, so settle it `lost` with completion-unknown so
// the durable Turn timeline shows its fate. No process is started — resume is
// explicit. Immutable like `settleTurn`: only rows still unsettled are set.
// Called by the startup reconciler inside its own transaction (`tx`), so the
// abandoned path and the ordinary settle above share one definition (A32).
export function settleAbandonedTurns(tx: SQLiteBunDatabase, at: string): void {
  const abandoned = tx
    .select({ session_key: turns.session_key })
    .from(turns)
    .where(isNull(turns.result_kind))
    .all();
  tx.update(turns)
    .set({
      result_kind: "lost",
      result_detail: JSON.stringify({
        kind: "lost",
        unknown: "completion",
      }),
      settled_at: at,
    })
    .where(isNull(turns.result_kind))
    .run();
  // Detach the abandoned Turn's Session to its stored recovery coordinate, exactly
  // as the in-process `lost` path (claude-code.ts `settleLost`) does — so a resume
  // continues in the same Claude Code Session via `--resume` rather than silently
  // opening a fresh conversation (ADR 0022). `admitTurn` recorded the coordinate as
  // `native_session_id` before the Turn started, so it survives the crash. Only a
  // still-`open` Session is moved; one already `detached`/`unusable` stays as-is.
  for (const { session_key } of abandoned) {
    tx.update(harnessSessions)
      .set({
        availability: "detached",
        availability_detail: sql`${harnessSessions.native_session_id}`,
        updated_at: at,
      })
      .where(
        and(
          eq(harnessSessions.session_key, session_key),
          eq(harnessSessions.availability, "open"),
        ),
      )
      .run();
  }
}

export function readCurrentTurn(
  db: SQLiteBunDatabase,
): Pick<TurnRecord, "turnId"> | undefined {
  const row = db
    .select({ turnId: turns.turn_id })
    .from(turns)
    .where(isNull(turns.result_kind))
    .orderBy(asc(turns.sequence))
    .get();
  return row === undefined
    ? undefined
    : z.object({ turnId: z.string() }).parse(row);
}

const turnColumns = {
  turn_id: turns.turn_id,
  attempt_id: turns.attempt_id,
  session_key: turns.session_key,
  origin: turns.origin,
  kind: turns.kind,
  requested_model: turns.requested_model,
  requested_effort: turns.requested_effort,
  sequence: turns.sequence,
  admitted_at: turns.admitted_at,
  result_kind: turns.result_kind,
  result_detail: turns.result_detail,
  settled_at: turns.settled_at,
};
function turnHead(row: unknown): Omit<TurnRecord, "input"> {
  const parsed = turnRow.parse(row);
  return {
    turnId: parsed.turn_id,
    attemptId: parsed.attempt_id,
    session: parsed.session_key,
    origin: parsed.origin,
    // A legacy row admitted before the kind column reads it back null: the
    // kind is genuinely unknown, so omit it rather than fabricate a guess.
    ...(parsed.kind !== null ? { kind: parsed.kind } : {}),
    // Effort is read only beside a model: a request never names effort alone.
    ...(parsed.requested_model !== null
      ? {
          modelChoice: {
            model: parsed.requested_model,
            ...(parsed.requested_effort !== null
              ? { effort: parsed.requested_effort }
              : {}),
          },
        }
      : {}),
    sequence: parsed.sequence,
    admittedAt: parsed.admitted_at,
    ...(parsed.result_kind !== null ? { resultKind: parsed.result_kind } : {}),
    ...(parsed.result_detail !== null
      ? { resultDetail: parsed.result_detail }
      : {}),
    ...(parsed.settled_at !== null ? { settledAt: parsed.settled_at } : {}),
  };
}
export function readTurns(db: SQLiteBunDatabase): readonly TurnRecord[] {
  return db
    .select({ ...turnColumns, input: turns.input })
    .from(turns)
    .orderBy(asc(turns.sequence))
    .all()
    .map((row): TurnRecord => ({
      ...turnHead(row),
      input: z.object({ input: z.string() }).parse(row).input,
    }));
}

/** Every history event in append order. `readTurnEventsAt` reads them by index,
 * and `readTurnEventsOfKinds` only the kinds a reader shows. */
export function readTurnEvents(
  db: SQLiteBunDatabase,
): readonly TurnEventRecord[] {
  return db
    .select({
      turn_id: turnEvents.turn_id,
      kind: turnEvents.kind,
      payload: turnEvents.payload,
      at: turnEvents.at,
    })
    .from(turnEvents)
    .where(
      and(
        ne(turnEvents.kind, "turn-input"),
        ne(turnEvents.kind, "legacy-message"),
      ),
    )
    .orderBy(asc(turnEvents.seq))
    .all()
    .map(turnEventRecord);
}
/** The history events of `kinds` in append order, the Run's or one Turn's. Rows are
 * chosen through the covering `(turn_id, kind)` index, so no other payload is read. */
export function readTurnEventsOfKinds(
  db: SQLiteBunDatabase,
  kinds: readonly TurnFactKind[],
  turnId?: string,
): readonly TurnEventRecord[] {
  return db
    .all(
      sql`
    select turn_id, kind, payload, at
    from turn_event
    where seq in (
      select seq
      from turn_event indexed by turn_event_turn_kind
      where kind in (select value from json_each(${JSON.stringify(kinds)}))${
        turnId === undefined ? sql`` : sql` and turn_id = ${turnId}`
      }
    )
    order by seq`,
    )
    .map(turnEventRecord);
}
function turnEventRecord(row: unknown): TurnEventRecord {
  const parsed = turnEventRow.parse(row);
  return {
    turnId: parsed.turn_id,
    kind: parsed.kind,
    payload: parsed.payload,
    at: parsed.at,
  };
}
const indexedEventRow = turnEventRow.extend({
  position: z.number().int().nonnegative(),
});
/** Number the history events through the `(turn_id, kind)` index, which covers
 * `seq` and `kind`: a payload fills most of its row's leaf page, so stepping the
 * table itself costs a page per event. Only the requested payloads are read. */
export function readTurnEventsAt(
  db: SQLiteBunDatabase,
  indexes: readonly number[],
): ReadonlyMap<number, TurnEventRecord> {
  const rows = db.all(sql`
    select ordinal.position as position, turn_id, kind, payload, at
    from (
      select seq, row_number() over (order by seq) - 1 as position
      from turn_event indexed by turn_event_turn_kind
      where kind <> 'turn-input' and kind <> 'legacy-message'
    ) as ordinal
    join turn_event on turn_event.seq = ordinal.seq
    where ordinal.position in (select value from json_each(${JSON.stringify(indexes)}))`);
  return new Map(
    rows.map((row) => [
      indexedEventRow.parse(row).position,
      turnEventRecord(row),
    ]),
  );
}

export function readHarnessSessions(
  db: SQLiteBunDatabase,
): readonly HarnessSessionRecord[] {
  return db
    .select({
      session_key: harnessSessions.session_key,
      availability: harnessSessions.availability,
      availability_detail: harnessSessions.availability_detail,
    })
    .from(harnessSessions)
    .orderBy(asc(harnessSessions.created_at))
    .all()
    .map((row): HarnessSessionRecord => {
      const parsed = harnessSessionRow.parse(row);
      return {
        session: parsed.session_key,
        availability: parsed.availability,
        ...(parsed.availability_detail !== null
          ? { availabilityDetail: parsed.availability_detail }
          : {}),
      };
    });
}

// Read the same canonical rows for export and bounded pages. Legacy rows carry
// their exact content; only a newly admitted input dereferences the Turn input.
const conversationColumns = {
  seq: turnEvents.transcript_seq,
  turnSequence: turns.sequence,
  session: turns.session_key,
  turnId: turnEvents.turn_id,
  payload: turnEvents.payload,
  input: turns.input,
  at: turnEvents.at,
};
// Order eligible rows without scanning the Run. Application stamps
// `historyOrder` on every Turn event it writes except `model` and
// `agent-call-expired`; only an unstamped row counts its historical ordinal, and
// `coalesce` evaluates that count for it alone. Each such row pays one count.
function conversationFacts<
  Columns extends Record<string, SQL | Column | SQL.Aliased>,
>(db: SQLiteBunDatabase, columns: Columns) {
  const position = sql<number>`case
    when ${turnEvents.kind} = 'turn-input' then -1
    when ${turnEvents.kind} = 'legacy-message' then ${turnEvents.transcript_seq}
    else coalesce(
      json_extract(${turnEvents.payload}, '$.historyOrder'),
      (select count(*) from turn_event as earlier
        where earlier.seq < ${turnEvents.seq}
        and earlier.kind not in ('turn-input', 'legacy-message'))
    )
  end`;
  return {
    position,
    query: db
      .select({ ...columns, position })
      .from(turnEvents)
      .innerJoin(turns, eq(turns.turn_id, turnEvents.turn_id)),
  };
}
const transcriptRow = z.object({
  seq: z.number().int().positive(),
  turnSequence: z.number().int().nonnegative(),
  position: z.number().int().min(-1),
  session: z.string(),
  turnId: z.string(),
  payload: z.string(),
  input: z.string(),
  at: z.string(),
});
function transcriptRecord(row: unknown): TranscriptEntryRecord {
  const parsed = transcriptRow.parse(row);
  const { content, ...metadata } = messagePayload.parse(
    JSON.parse(parsed.payload),
  );
  return {
    seq: parsed.seq,
    order: {
      turnSequence: parsed.turnSequence,
      position: parsed.position,
      seq: parsed.seq,
    },
    session: parsed.session,
    turnId: parsed.turnId,
    at: parsed.at,
    ...metadata,
    content: content ?? parsed.input,
  };
}
export function readTranscript(
  db: SQLiteBunDatabase,
): readonly TranscriptEntryRecord[] {
  const { query, position } = conversationFacts(db, conversationColumns);
  return query
    .where(isNotNull(turnEvents.transcript_seq))
    .orderBy(asc(turns.sequence), asc(position), asc(turnEvents.transcript_seq))
    .all()
    .map(transcriptRecord);
}

export function readTranscriptAt(
  db: SQLiteBunDatabase,
  seqs: readonly number[],
): ReadonlyMap<number, TranscriptEntryRecord> {
  const { query } = conversationFacts(db, conversationColumns);
  return new Map(
    query
      .where(
        sql`${turnEvents.transcript_seq} in (select value from json_each(${JSON.stringify(seqs)}))`,
      )
      .all()
      .map(transcriptRecord)
      .map((entry) => [entry.seq, entry]),
  );
}

export function readTranscriptPage(
  db: SQLiteBunDatabase,
  request: TranscriptPageRequest,
): TranscriptPage {
  const limit = Math.max(1, request.limit);
  const { query, position } = conversationFacts(db, conversationColumns);
  const rows = query
    .where(
      and(
        eq(turns.session_key, request.session),
        lte(turnEvents.transcript_seq, request.cutoff),
        ...(request.before === undefined
          ? []
          : [
              sql`(${turns.sequence}, ${position}, ${turnEvents.transcript_seq}) <
              (${request.before.turnSequence}, ${request.before.position}, ${request.before.seq})`,
            ]),
      ),
    )
    .orderBy(
      desc(turns.sequence),
      desc(position),
      desc(turnEvents.transcript_seq),
    )
    .limit(limit + 1)
    .all();
  const hasOlder = rows.length > limit;
  return {
    entries: (hasOlder ? rows.slice(0, limit) : rows)
      .reverse()
      .map(transcriptRecord),
    hasOlder,
  };
}

export function readTranscriptCutoff(db: SQLiteBunDatabase): number {
  return (
    db
      .select({ value: max(turnEvents.transcript_seq) })
      .from(turnEvents)
      .get()?.value ?? 0
  );
}

// JavaScript's `String.prototype.trim` whitespace, so `blank` matches a decoded Thought.
const WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006" +
  "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
// Each JSON function call site parses the payload again, so the outline reads every
// small field it needs through one multi-path `json_extract`, in this order.
const OUTLINE_PATHS = [
  "$.callId",
  "$.messageId",
  "$.summaryId",
  "$.steerId",
  "$.historyOrder",
  "$.outcome.kind",
  "$.settlement.kind",
  "$.model",
  "$.parentActivity",
] as const;
const outlineFields = z.array(z.unknown()).length(OUTLINE_PATHS.length);
const eventOutlineRow = z.object({
  turn_id: z.string(),
  kind: z.string(),
  // Null for a payload that is not JSON.
  fields: z.string().nullable(),
  blank: z.number().nullable(),
});
const conversationOutlineRow = z.object({
  seq: z.number().int().positive(),
  turnSequence: z.number().int().nonnegative(),
  position: z.number().int().min(-1),
  turnId: z.string(),
  fields: z.string(),
});
const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;

export function readHistoryOutline(db: SQLiteBunDatabase): HistoryOutline {
  const payload = turnEvents.payload;
  const paths = sql.join(
    OUTLINE_PATHS.map((path) => sql`${path}`),
    sql`, `,
  );
  const events = db
    .select({
      turn_id: turnEvents.turn_id,
      kind: turnEvents.kind,
      // `case` evaluates only its matching branch, so malformed JSON reaches no extract.
      fields: sql`case when json_valid(${payload})
        then json_extract(${payload}, ${paths}) end`,
      // Only a Thought's emptiness is read, never its content.
      blank: sql`case ${turnEvents.kind} when 'thought' then
        case when json_valid(${payload}) then
          trim(json_extract(${payload}, '$.content'), ${WHITESPACE}) = '' end end`,
    })
    .from(turnEvents)
    .where(
      and(
        ne(turnEvents.kind, "turn-input"),
        ne(turnEvents.kind, "legacy-message"),
      ),
    )
    .orderBy(asc(turnEvents.seq))
    .all()
    .map((row): TurnEventOutline => {
      const parsed = eventOutlineRow.parse(row);
      if (parsed.fields === null || !Object.hasOwn(turnFactChecks, parsed.kind))
        return { turnId: parsed.turn_id };
      const kind = parsed.kind as TurnFactKind;
      const [
        callId,
        messageId,
        summaryId,
        steerId,
        order,
        outcome,
        settlement,
        model,
        parent,
      ] = outlineFields.parse(JSON.parse(parsed.fields));
      const id =
        kind === "tool-call" || kind === "tool-partial" || kind === "agent-call"
          ? text(callId)
          : kind === "assistant-content"
            ? text(messageId)
            : kind === "thought"
              ? text(summaryId)
              : kind === "steer"
                ? text(steerId)
                : undefined;
      const state =
        kind === "tool-call" || kind === "tool-partial"
          ? text(outcome)
          : kind === "steer"
            ? text(settlement)
            : undefined;
      return {
        turnId: parsed.turn_id,
        kind,
        ...(Number.isSafeInteger(order) && (order as number) >= 0
          ? { historyOrder: order as number }
          : {}),
        ...(id === undefined ? {} : { id }),
        ...(state === undefined ? {} : { state }),
        ...(kind === "model" && text(model) !== undefined
          ? { model: text(model) }
          : {}),
        ...(kind === "assistant-content" && parent !== null
          ? { nested: true }
          : {}),
        ...(parsed.blank === 1 ? { blank: true } : {}),
      };
    });
  const { query, position } = conversationFacts(db, {
    seq: turnEvents.transcript_seq,
    turnSequence: turns.sequence,
    turnId: turnEvents.turn_id,
    // Conversation rows are read as JSON by `position` already, as by every transcript read.
    fields: sql`json_extract(${payload}, '$.role', '$.kind')`,
  });
  const conversation = query
    .where(isNotNull(turnEvents.transcript_seq))
    .orderBy(asc(turns.sequence), asc(position), asc(turnEvents.transcript_seq))
    .all()
    .map((row) => {
      const parsed = conversationOutlineRow.parse(row);
      const [role, kindField] = z
        .tuple([z.unknown(), z.unknown()])
        .parse(JSON.parse(parsed.fields));
      const kind = messagePayload.shape.kind.safeParse(kindField ?? undefined);
      return {
        seq: parsed.seq,
        order: {
          turnSequence: parsed.turnSequence,
          position: parsed.position,
          seq: parsed.seq,
        },
        turnId: parsed.turnId,
        // Roles validate at every transcript read ingress, as `messagePayload` does.
        role: messagePayload.shape.role.parse(role),
        ...(kind.data === undefined ? {} : { kind: kind.data }),
      };
    });
  return {
    turns: db
      .select(turnColumns)
      .from(turns)
      .orderBy(asc(turns.sequence))
      .all()
      .map(turnHead),
    events,
    conversation,
  };
}
