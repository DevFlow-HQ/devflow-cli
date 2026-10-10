import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { failureEvidence } from "./run-schema.js";
import type { FailureEvidenceRequest, DiagnosticContent } from "./store.js";
import { renderDiagnostic, writeDiagnostic } from "./diagnostics.js";

const failureDetails = z.record(
  z.string(),
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
);

/** Both callers hold the guarded outcome transaction. Validate before writing a
 * diagnostic, then insert its immutable evidence row. */
export function recordFailureEvidence(params: {
  readonly db: SQLiteBunDatabase;
  readonly attemptId: string;
  readonly evidence: FailureEvidenceRequest;
  readonly at: string;
  readonly diagnosticsDir: string;
  readonly diagnostic?: DiagnosticContent;
}): void {
  const failure = params.evidence;
  const subject =
    failure.turnId === undefined
      ? and(
          eq(failureEvidence.attempt_id, params.attemptId),
          isNull(failureEvidence.turn_id),
        )
      : eq(failureEvidence.turn_id, failure.turnId);
  if (
    params.db
      .select({ id: failureEvidence.evidence_id })
      .from(failureEvidence)
      .where(subject)
      .get() !== undefined
  )
    return;
  const details =
    failure.details === undefined
      ? null
      : JSON.stringify(failureDetails.parse(failure.details));
  if (details !== null && new TextEncoder().encode(details).byteLength > 4096)
    throw new Error("Failure evidence details exceed the 4096-byte limit.");
  const diagnostic = params.diagnostic ?? failure.diagnostic;
  const diagnosticId =
    diagnostic === undefined
      ? null
      : writeDiagnostic(params.diagnosticsDir, renderDiagnostic(diagnostic));
  params.db
    .insert(failureEvidence)
    .values({
      evidence_id: randomUUID(),
      attempt_id: params.attemptId,
      turn_id: failure.turnId ?? null,
      source: failure.source,
      code: failure.code,
      phase: failure.phase ?? null,
      category: failure.category ?? null,
      possible_effects: failure.possibleEffects,
      native_code: failure.nativeCode ?? null,
      details,
      diagnostic_id: diagnosticId,
      at: params.at,
    })
    .run();
}
