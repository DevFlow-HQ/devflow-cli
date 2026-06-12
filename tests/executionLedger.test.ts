import test from "node:test";
import assert from "node:assert/strict";

import {
  assemble,
  serialize,
  type ExecutionLedgerRecord,
} from "../src/executionLedger.js";

test("execution ledger JSONL codec assembles a clean stream into the legacy ledger shape", () => {
  const records: ExecutionLedgerRecord[] = [
    {
      type: "start",
      stage: "execute",
      initialIssueFilenames: ["001-build.md", "002-hitl.md"],
      maxIterations: 9,
    },
    {
      type: "iteration",
      iteration: 1,
      marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
      providerSessionId: "session-1",
      gitHeadBefore: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      gitHeadAfter: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      finalAssistantMessage: "Finished the first issue.",
    },
    {
      type: "final",
      stopReason: "terminal",
      completedIssueFilenames: ["001-build.md"],
      remainingIssueFilenames: ["002-hitl.md"],
    },
  ];

  assert.deepEqual(
    assemble(records.map((record) => serialize(record))),
    {
      stage: "execute",
      iterations: [
        {
          iteration: 1,
          marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
          providerSessionId: "session-1",
          gitHeadBefore: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          gitHeadAfter: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          finalAssistantMessage: "Finished the first issue.",
        },
      ],
      final: {
        stopReason: "terminal",
        completedIssueFilenames: ["001-build.md"],
        remainingIssueFilenames: ["002-hitl.md"],
      },
    },
  );
});

test("execution ledger JSONL codec rejects invalid records before serialization", () => {
  assert.throws(
    () =>
      serialize({
        type: "iteration",
        iteration: 1,
        marker: "",
        gitHeadBefore: null,
        gitHeadAfter: null,
      }),
    /Invalid execution ledger record/,
  );
});

test("execution ledger JSONL codec requires a start header and final record for clean assembly", () => {
  assert.throws(
    () =>
      assemble([
        serialize({
          type: "iteration",
          iteration: 1,
          marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
          gitHeadBefore: null,
          gitHeadAfter: null,
        }),
      ]),
    /start header/,
  );

  assert.throws(
    () =>
      assemble([
        serialize({
          type: "start",
          stage: "execute",
          initialIssueFilenames: ["001-build.md"],
          maxIterations: 7,
        }),
      ]),
    /final record/,
  );
});
