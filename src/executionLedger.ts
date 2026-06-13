import { z } from "zod";

const gitExecutionHeadSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .nullable();

const executionStopReasonSchema = z.enum([
  "terminal",
  "no-file",
  "cap",
  "error",
]);

export type ExecutionStopReason = z.infer<typeof executionStopReasonSchema>;
export type ExecutionAssembledStopReason = ExecutionStopReason | "incomplete";

const nonEmptyStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Must be a non-empty string.",
});

const executionStartRecordSchema = z
  .object({
    type: z.literal("start"),
    stage: z.literal("execute"),
    initialIssueFilenames: z.array(z.string()),
    maxIterations: z.number().int().nonnegative(),
  })
  .strict();

const executionIterationRecordSchema = z
  .object({
    type: z.literal("iteration"),
    iteration: z.number().int().positive(),
    marker: nonEmptyStringSchema,
    providerSessionId: nonEmptyStringSchema.optional(),
    gitHeadBefore: gitExecutionHeadSchema,
    gitHeadAfter: gitExecutionHeadSchema,
    finalAssistantMessage: nonEmptyStringSchema.optional(),
  })
  .strict();

const executionFinalRecordSchema = z
  .object({
    type: z.literal("final"),
    stopReason: executionStopReasonSchema,
    completedIssueFilenames: z.array(z.string()),
    remainingIssueFilenames: z.array(z.string()),
  })
  .strict();

const executionLedgerRecordSchema = z.discriminatedUnion("type", [
  executionStartRecordSchema,
  executionIterationRecordSchema,
  executionFinalRecordSchema,
]);

export type ExecutionStartRecord = z.infer<typeof executionStartRecordSchema>;
export type ExecutionIterationRecord = z.infer<
  typeof executionIterationRecordSchema
>;
export type ExecutionFinalRecord = z.infer<typeof executionFinalRecordSchema>;
export type ExecutionLedgerRecord = z.infer<typeof executionLedgerRecordSchema>;

export interface ExecutionLedger {
  stage: "execute";
  iterations: Array<Omit<ExecutionIterationRecord, "type">>;
  final: {
    stopReason: ExecutionAssembledStopReason;
    completedIssueFilenames: string[];
    remainingIssueFilenames: string[];
  };
}

export interface AssembleExecutionLedgerOptions {
  activeIssueFilenames?: string[];
}

export function serialize(record: ExecutionLedgerRecord): string {
  const result = executionLedgerRecordSchema.safeParse(record);

  if (!result.success) {
    throw new Error(`Invalid execution ledger record. ${result.error.message}`);
  }

  return `${JSON.stringify(result.data)}\n`;
}

export function assemble(
  lines: string[],
  options: AssembleExecutionLedgerOptions = {},
): ExecutionLedger {
  const records = parseRecords(lines);
  const startRecords = records.filter((record) => record.type === "start");
  const finalRecords = records.filter((record) => record.type === "final");

  if (startRecords.length !== 1) {
    throw new Error("Execution ledger must contain exactly one start header.");
  }

  if (finalRecords.length > 1) {
    throw new Error("Execution ledger must contain at most one final record.");
  }

  const iterations = records
    .filter((record) => record.type === "iteration")
    .map(({ type: _type, ...iteration }) => iteration);

  const finalRecord = finalRecords[0];

  if (
    finalRecord !== undefined &&
    iterations.length === 0 &&
    finalRecord.stopReason !== "no-file"
  ) {
    throw new Error("Execution ledger must contain at least one iteration.");
  }

  if (finalRecord === undefined) {
    const remainingIssueFilenames = [...(options.activeIssueFilenames ?? [])].sort();
    const remainingIssueFilenameSet = new Set(remainingIssueFilenames);

    return {
      stage: startRecords[0].stage,
      iterations,
      final: {
        stopReason: "incomplete",
        completedIssueFilenames: startRecords[0].initialIssueFilenames.filter(
          (issueFilename) => !remainingIssueFilenameSet.has(issueFilename),
        ),
        remainingIssueFilenames,
      },
    };
  }

  const { type: _type, ...final } = finalRecord;

  return {
    stage: startRecords[0].stage,
    iterations,
    final,
  };
}

function parseRecords(lines: string[]): ExecutionLedgerRecord[] {
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const records: ExecutionLedgerRecord[] = [];

  for (const [index, line] of nonEmptyLines.entries()) {
    const isTrailingLine = index === nonEmptyLines.length - 1;
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (isTrailingLine) {
        continue;
      }

      const details = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid execution ledger JSONL line. ${details}`);
    }

    const result = executionLedgerRecordSchema.safeParse(parsed);

    if (!result.success) {
      if (isTrailingLine) {
        continue;
      }

      throw new Error(`Invalid execution ledger record. ${result.error.message}`);
    }

    records.push(result.data);
  }

  return records;
}
