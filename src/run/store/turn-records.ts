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
} from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { turnFactSchemas, type TurnFact } from "../../harness/harness.js";
import { harnessSessions, turnEvents, turns } from "./run-schema.js";
import type {
  AdmitTurnRequest,
  AppendTurnEventRequest,
  HarnessSessionRecord,
  SettleTurnRequest,
  TranscriptEntryRecord,
  TranscriptPage,
  TranscriptPageRequest,
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
  input: z.string(),
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

export function readTurns(db: SQLiteBunDatabase): readonly TurnRecord[] {
  return db
    .select({
      turn_id: turns.turn_id,
      attempt_id: turns.attempt_id,
      session_key: turns.session_key,
      origin: turns.origin,
      kind: turns.kind,
      requested_model: turns.requested_model,
      requested_effort: turns.requested_effort,
      sequence: turns.sequence,
      input: turns.input,
      admitted_at: turns.admitted_at,
      result_kind: turns.result_kind,
      result_detail: turns.result_detail,
      settled_at: turns.settled_at,
    })
    .from(turns)
    .orderBy(asc(turns.sequence))
    .all()
    .map((row): TurnRecord => {
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
        input: parsed.input,
        admittedAt: parsed.admitted_at,
        ...(parsed.result_kind !== null
          ? { resultKind: parsed.result_kind }
          : {}),
        ...(parsed.result_detail !== null
          ? { resultDetail: parsed.result_detail }
          : {}),
        ...(parsed.settled_at !== null ? { settledAt: parsed.settled_at } : {}),
      };
    });
}

export function readTurnEvents(
  db: SQLiteBunDatabase,
  index?: number,
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
    .limit(index === undefined ? -1 : 1)
    .offset(index ?? 0)
    .all()
    .map((row): TurnEventRecord => {
      const parsed = turnEventRow.parse(row);
      return {
        turnId: parsed.turn_id,
        kind: parsed.kind,
        payload: parsed.payload,
        at: parsed.at,
      };
    });
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
function conversationFacts(db: SQLiteBunDatabase) {
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
      .select({ ...conversationColumns, position })
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
  const { query, position } = conversationFacts(db);
  return query
    .where(isNotNull(turnEvents.transcript_seq))
    .orderBy(asc(turns.sequence), asc(position), asc(turnEvents.transcript_seq))
    .all()
    .map(transcriptRecord);
}

export function readTranscriptPage(
  db: SQLiteBunDatabase,
  request: TranscriptPageRequest,
): TranscriptPage {
  const limit = Math.max(1, request.limit);
  const { query, position } = conversationFacts(db);
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
