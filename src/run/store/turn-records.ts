import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  sql,
} from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import type { ToolCall, TurnDiff } from "../../harness/harness.js";
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
// Only qualified settled messages and delivered Steers are conversation rows.
// Unknown or unqualified metadata remains absent.
const filePatch = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unified"), content: z.string() }),
  z.object({
    kind: z.literal("structured"),
    hunks: z.array(
      z.object({
        oldStart: z.number().int().nonnegative(),
        oldLines: z.number().int().nonnegative(),
        newStart: z.number().int().nonnegative(),
        newLines: z.number().int().nonnegative(),
        lines: z.array(z.string()),
      }),
    ),
  }),
]);
const fileChange = z.object({
  path: z.string().min(1),
  kind: z.enum(["create", "update", "delete"]).optional(),
  patch: filePatch.optional(),
  additions: z.number().int().nonnegative().optional(),
  removals: z.number().int().nonnegative().optional(),
});
const turnDiff = z.object({
  content: z.string(),
  files: z.array(fileChange),
  historyOrder: z.number().int().nonnegative().optional(),
});
/** Only validated Secant-shaped supplied facts cross the persisted ingress. */
export function readTurnDiffEvent(
  event: Pick<TurnEventRecord, "kind" | "payload">,
): (TurnDiff & { readonly historyOrder?: number }) | undefined {
  if (event.kind !== "turn-diff") return undefined;
  try {
    const parsed = turnDiff.safeParse(JSON.parse(event.payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
const toolCall = z.object({
  callId: z.string().min(1),
  parentCallId: z.string().optional(),
  tool: z.enum([
    "read",
    "search",
    "command",
    "file-change",
    "web",
    "mcp",
    "subagent",
    "other",
  ]),
  input: z.string(),
  files: z.array(fileChange).optional(),
  count: z
    .object({ value: z.number().nonnegative(), unit: z.string() })
    .optional(),
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("running") }),
    z.object({ kind: z.literal("completed") }),
    z.object({ kind: z.literal("failed"), error: z.string().optional() }),
    z.object({ kind: z.literal("declined"), reason: z.string().optional() }),
  ]),
  historyOrder: z.number().int().nonnegative().optional(),
});
/** Tolerant persisted ingress. Legacy activity is never promoted to identified outcomes. */
export function readToolCallEvent(
  event: Pick<TurnEventRecord, "kind" | "payload">,
): (ToolCall & { readonly historyOrder?: number }) | undefined {
  if (event.kind !== "tool-call") return undefined;
  try {
    const parsed = toolCall.safeParse(JSON.parse(event.payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
const assistantMessage = z.object({
  messageId: z.string().min(1),
  historyOrder: z.number().int().nonnegative().optional(),
  content: z.string(),
  incomplete: z.literal(true).optional(),
  parentActivity: z.string().optional(),
});
const thoughtSummary = z.object({
  summaryId: z.string().min(1),
  content: z.string(),
  historyOrder: z.number().int().nonnegative().optional(),
  incomplete: z.literal(true).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
});
const deliveredSteer = z.object({
  steerId: z.string().min(1),
  historyOrder: z.number().int().nonnegative().optional(),
  text: z.string(),
  sentAt: z.string(),
  settlement: z.object({
    kind: z.literal("delivered"),
    delivery: z.enum(["within-turn", "after-boundary", "re-delivered"]),
  }),
});
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
        kind:
          request.origin === "managed" && request.kind === "interactive-agent"
            ? "entry-prompt"
            : "message",
        turn: request.turnId,
      }),
      transcript_seq: nextConversationPosition(db),
      at,
    })
    .run();
}

// Append one normalized durable Turn event (#116), append-only.
export function appendTurnEvent(
  db: SQLiteBunDatabase,
  request: AppendTurnEventRequest,
): void {
  let payload = request.payload;
  let transcriptSeq: number | undefined;
  if (request.kind === "turn-diff") {
    const diff = turnDiff.parse(JSON.parse(payload));
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
    if (duplicate !== undefined) return;
    payload = JSON.stringify(diff);
  } else if (request.kind === "thought") {
    const thought = thoughtSummary.parse(JSON.parse(payload));
    const duplicate = db
      .select({ seq: turnEvents.seq })
      .from(turnEvents)
      .where(
        and(
          eq(turnEvents.turn_id, request.turnId),
          eq(turnEvents.kind, "thought"),
          sql`json_extract(${turnEvents.payload}, '$.summaryId') = ${thought.summaryId}`,
        ),
      )
      .get();
    if (duplicate !== undefined) return;
    payload = JSON.stringify(thought);
  } else if (request.kind === "tool-call") {
    const call = toolCall.parse(JSON.parse(payload));
    const previous = db
      .select({ payload: turnEvents.payload })
      .from(turnEvents)
      .where(
        and(
          eq(turnEvents.turn_id, request.turnId),
          eq(turnEvents.kind, "tool-call"),
          sql`json_extract(${turnEvents.payload}, '$.callId') = ${call.callId}`,
        ),
      )
      .all()
      .flatMap((row) => {
        const parsed = readToolCallEvent({
          kind: "tool-call",
          payload: row.payload,
        });
        return parsed === undefined ? [] : [parsed];
      });
    if (
      previous.some((row) => row.outcome.kind !== "running") ||
      (call.outcome.kind === "running" && previous.length > 0)
    )
      return;
    payload = JSON.stringify({
      ...call,
      ...(previous[0]?.historyOrder === undefined
        ? {}
        : { historyOrder: previous[0].historyOrder }),
    });
  } else if (request.kind === "assistant-content") {
    const message = assistantMessage.safeParse(JSON.parse(payload));
    if (message.success && message.data.parentActivity === undefined) {
      // The same native message can be repeated. Its first settled fact wins.
      const duplicate = db
        .select({ seq: turnEvents.seq })
        .from(turnEvents)
        .where(
          and(
            eq(turnEvents.turn_id, request.turnId),
            eq(turnEvents.kind, "assistant-content"),
            sql`json_extract(${turnEvents.payload}, '$.messageId') = ${message.data.messageId}`,
          ),
        )
        .get();
      if (duplicate !== undefined) return;
      payload = JSON.stringify({
        ...message.data,
        role: "assistant",
        kind: "message",
        turn: request.turnId,
      });
      transcriptSeq = nextConversationPosition(db);
    }
  } else if (request.kind === "steer") {
    const steer = deliveredSteer.safeParse(JSON.parse(payload));
    if (steer.success) {
      const duplicate = db
        .select({ seq: turnEvents.seq })
        .from(turnEvents)
        .where(
          and(
            eq(turnEvents.turn_id, request.turnId),
            eq(turnEvents.kind, "steer"),
            isNotNull(turnEvents.transcript_seq),
            sql`json_extract(${turnEvents.payload}, '$.steerId') = ${steer.data.steerId}`,
          ),
        )
        .get();
      if (duplicate !== undefined) return;
      payload = JSON.stringify({
        ...steer.data,
        role: "user",
        content: steer.data.text,
        kind: "steer",
        turn: request.turnId,
        steer: {
          id: steer.data.steerId,
          delivery: steer.data.settlement.delivery,
        },
      });
      transcriptSeq = nextConversationPosition(db);
    }
  }
  db.insert(turnEvents)
    .values({
      turn_id: request.turnId,
      kind: request.kind,
      payload,
      transcript_seq: transcriptSeq ?? null,
      at: request.at.toISOString(),
    })
    .run();
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
  session: turns.session_key,
  turnId: turnEvents.turn_id,
  payload: turnEvents.payload,
  input: turns.input,
  at: turnEvents.at,
};
function transcriptRecord(row: unknown): TranscriptEntryRecord {
  const parsed = z
    .object({
      seq: z.number(),
      session: z.string(),
      turnId: z.string(),
      payload: z.string(),
      input: z.string(),
      at: z.string(),
    })
    .parse(row);
  const { content, ...metadata } = messagePayload.parse(
    JSON.parse(parsed.payload),
  );
  return {
    seq: parsed.seq,
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
  return db
    .select(conversationColumns)
    .from(turnEvents)
    .innerJoin(turns, eq(turns.turn_id, turnEvents.turn_id))
    .where(isNotNull(turnEvents.transcript_seq))
    .orderBy(asc(turnEvents.transcript_seq))
    .all()
    .map(transcriptRecord);
}

export function readTranscriptPage(
  db: SQLiteBunDatabase,
  request: TranscriptPageRequest,
): TranscriptPage {
  const limit = Math.max(1, request.limit);
  const rows = db
    .select(conversationColumns)
    .from(turnEvents)
    .innerJoin(turns, eq(turns.turn_id, turnEvents.turn_id))
    .where(
      and(
        eq(turns.session_key, request.session),
        isNotNull(turnEvents.transcript_seq),
        ...(request.before === undefined
          ? []
          : [lt(turnEvents.transcript_seq, request.before)]),
      ),
    )
    .orderBy(desc(turnEvents.transcript_seq))
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
