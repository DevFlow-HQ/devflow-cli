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

test("execution ledger JSONL codec never serializes the derived incomplete stop reason", () => {
  assert.throws(
    () =>
      serialize({
        type: "final",
        stopReason: "incomplete",
        completedIssueFilenames: [],
        remainingIssueFilenames: [],
      } as unknown as ExecutionLedgerRecord),
    /Invalid execution ledger record/,
  );
});

test("execution ledger JSONL codec synthesizes incomplete state when the final record is absent", () => {
  assert.deepEqual(
    assemble(
      [
        serialize({
          type: "start",
          stage: "execute",
          initialIssueFilenames: ["001-build.md", "002-left.md"],
          maxIterations: 9,
        }),
        serialize({
          type: "iteration",
          iteration: 1,
          marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
          gitHeadBefore: null,
          gitHeadAfter: null,
        }),
      ],
      { activeIssueFilenames: ["002-left.md"] },
    ),
    {
      stage: "execute",
      iterations: [
        {
          iteration: 1,
          marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
          gitHeadBefore: null,
          gitHeadAfter: null,
        },
      ],
      final: {
        stopReason: "incomplete",
        completedIssueFilenames: ["001-build.md"],
        remainingIssueFilenames: ["002-left.md"],
      },
    },
  );
});

test("execution ledger JSONL codec accepts a start-only partial ledger", () => {
  assert.deepEqual(
    assemble(
      [
        serialize({
          type: "start",
          stage: "execute",
          initialIssueFilenames: ["001-build.md"],
          maxIterations: 7,
        }),
      ],
      { activeIssueFilenames: ["001-build.md"] },
    ),
    {
      stage: "execute",
      iterations: [],
      final: {
        stopReason: "incomplete",
        completedIssueFilenames: [],
        remainingIssueFilenames: ["001-build.md"],
      },
    },
  );
});

test("execution ledger JSONL codec drops one malformed trailing line", () => {
  assert.deepEqual(
    assemble([
      serialize({
        type: "start",
        stage: "execute",
        initialIssueFilenames: ["001-build.md"],
        maxIterations: 7,
      }),
      serialize({
        type: "iteration",
        iteration: 1,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        gitHeadBefore: null,
        gitHeadAfter: null,
      }),
      serialize({
        type: "final",
        stopReason: "terminal",
        completedIssueFilenames: ["001-build.md"],
        remainingIssueFilenames: [],
      }),
      '{"type":"iteration",',
    ]),
    {
      stage: "execute",
      iterations: [
        {
          iteration: 1,
          marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
          gitHeadBefore: null,
          gitHeadAfter: null,
        },
      ],
      final: {
        stopReason: "terminal",
        completedIssueFilenames: ["001-build.md"],
        remainingIssueFilenames: [],
      },
    },
  );
});

test("execution ledger JSONL codec still rejects malformed non-trailing lines", () => {
  assert.throws(
    () =>
      assemble([
        serialize({
          type: "start",
          stage: "execute",
          initialIssueFilenames: ["001-build.md"],
          maxIterations: 7,
        }),
        '{"type":"iteration",',
        serialize({
          type: "final",
          stopReason: "terminal",
          completedIssueFilenames: ["001-build.md"],
          remainingIssueFilenames: [],
        }),
      ]),
    /Invalid execution ledger JSONL line/,
  );
});

test("execution ledger JSONL codec requires a start header", () => {
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
});
