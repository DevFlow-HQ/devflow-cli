import { z } from "zod";
import type {
  RunOwner,
  TranscriptOrder,
  TranscriptEntryRecord,
} from "../run/store/store.js";
import { runSessionNotFound, runTranscriptCursorInvalid } from "./problems.js";
import { transcriptView, turnSteps } from "./run-projection.js";
import { compareConversationOrder } from "./conversation-order.js";
import type {
  TranscriptExportReference,
  TranscriptPageReference,
  TranscriptRead,
} from "./projection-port.js";

/** Bounded transcript pages contain twenty retained conversation entries. */
export const TRANSCRIPT_PAGE_SIZE = 20;
// Exports remain bounded without repeating a full order scan every twenty rows.
const TRANSCRIPT_EXPORT_BATCH_SIZE = 1_000;

const cursorSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    session: z.string(),
    cutoff: z.number().int().nonnegative(),
    before: z
      .object({
        turnSequence: z.number().int().nonnegative(),
        position: z.number().int().min(-1),
        seq: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

// Application owns snapshot lifetime and cursor scope; Store reads bounded
// canonical facts without copying conversation or retaining a read transaction.
export function readTranscriptResource(
  owner: RunOwner,
  reference: TranscriptPageReference | TranscriptExportReference,
): TranscriptRead {
  const known = owner
    .harnessSessions()
    .some((s) => s.session === reference.session);
  if (!known) {
    return {
      found: false,
      problem: runSessionNotFound(reference.runId, reference.session),
    };
  }
  let cursor: Cursor | undefined;
  if (reference.type === "transcript-page" && reference.older !== undefined) {
    cursor = decodeCursor(reference.older);
    if (
      cursor === undefined ||
      cursor.runId !== reference.runId ||
      cursor.session !== reference.session
    ) {
      return {
        found: false,
        problem: runTranscriptCursorInvalid(reference.runId, reference.session),
      };
    }
  }
  const cutoff = cursor?.cutoff ?? owner.transcriptCutoff();
  const steps = turnSteps(owner.turns());
  if (reference.type === "transcript-export") {
    const entries: TranscriptEntryRecord[] = [];
    let before: TranscriptOrder | undefined;
    for (;;) {
      const page = owner.transcriptPage({
        session: reference.session,
        cutoff,
        before,
        limit: TRANSCRIPT_EXPORT_BATCH_SIZE,
      });
      entries.push(...page.entries);
      if (!page.hasOlder || page.entries[0] === undefined) break;
      before = page.entries[0].order;
    }
    entries.sort((a, b) => compareConversationOrder(a.order, b.order));
    return {
      found: true,
      type: "transcript-export",
      entries: entries.map((entry) =>
        transcriptView(entry, steps, reference.runId),
      ),
    };
  }
  const page = owner.transcriptPage({
    session: reference.session,
    cutoff,
    before: cursor?.before,
    limit: TRANSCRIPT_PAGE_SIZE,
  });
  const entries = [...page.entries].sort((a, b) =>
    compareConversationOrder(a.order, b.order),
  );
  return {
    found: true,
    type: "transcript-page",
    entries: entries.map((entry) =>
      transcriptView(entry, steps, reference.runId),
    ),
    ...(page.hasOlder && entries[0] !== undefined
      ? {
          older: encodeCursor({
            version: 1,
            runId: reference.runId,
            session: reference.session,
            cutoff,
            before: entries[0].order,
          }),
        }
      : {}),
  };
}
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function decodeCursor(cursor: string): Cursor | undefined {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return undefined;
    const parsed = cursorSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success && parsed.data.before.seq <= parsed.data.cutoff
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}
