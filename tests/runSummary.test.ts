import assert from "node:assert/strict";
import test from "node:test";

import { renderRunSummary } from "../src/runSummary.js";
import type { ExecutionLedger } from "../src/orchestrator.js";

const runPaths = {
  prdArtifact: "/repo/.devflow/runs/run-123/prd.md",
  issuesDirectory: "/repo/.devflow/runs/run-123/issues",
  executionArtifact: "/repo/.devflow/runs/run-123/execution.jsonl",
};

test("run summary renders successful terminal ledgers with issue filenames and artifacts", () => {
  const ledger: ExecutionLedger = {
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
      completedIssueFilenames: ["001-first.md"],
      remainingIssueFilenames: ["002-needs-human.md"],
    },
  };

  assert.equal(
    renderRunSummary(ledger, runPaths),
    [
      "",
      "Run summary",
      "Execution stopped because the provider reported that no more AFK tasks remain.",
      "",
      "Iterations:",
      " 1 │ (no summary available)",
      "",
      "Completed issues:",
      "- 001-first.md",
      "",
      "Remaining issues likely need human attention (HITL):",
      "- 002-needs-human.md",
      "",
      "Artifacts:",
      `- PRD: ${runPaths.prdArtifact}`,
      `- Issues: ${runPaths.issuesDirectory}`,
      `- Execution ledger: ${runPaths.executionArtifact}`,
      "",
      "Next steps: review remaining issues, verify the working tree, and commit or open a PR as needed.",
      "",
    ].join("\n"),
  );
});

test("run summary renders no-file ledgers and empty issue lists", () => {
  const ledger: ExecutionLedger = {
    stage: "execute",
    iterations: [],
    final: {
      stopReason: "no-file",
      completedIssueFilenames: [],
      remainingIssueFilenames: [],
    },
  };

  assert.equal(
    renderRunSummary(ledger, runPaths),
    [
      "",
      "Run summary",
      "Execution stopped because there were no AFK issue files left to run.",
      "",
      "Iterations:",
      "- None",
      "",
      "Completed issues:",
      "- None",
      "",
      "Remaining issues likely need human attention (HITL):",
      "- None",
      "",
      "Artifacts:",
      `- PRD: ${runPaths.prdArtifact}`,
      `- Issues: ${runPaths.issuesDirectory}`,
      `- Execution ledger: ${runPaths.executionArtifact}`,
      "",
      "Next steps: review remaining issues, verify the working tree, and commit or open a PR as needed.",
      "",
    ].join("\n"),
  );
});

test("run summary renders a distinct friendly line for every execute stop reason", () => {
  const stopReasons: Array<{
    stopReason: ExecutionLedger["final"]["stopReason"];
    expectedLine: string;
  }> = [
    {
      stopReason: "terminal",
      expectedLine:
        "Execution stopped because the provider reported that no more AFK tasks remain.",
    },
    {
      stopReason: "no-file",
      expectedLine:
        "Execution stopped because there were no AFK issue files left to run.",
    },
    {
      stopReason: "cap",
      expectedLine: "Execution stopped after reaching the iteration cap.",
    },
    {
      stopReason: "error",
      expectedLine: "Execution stopped after an execution error.",
    },
  ];

  for (const { stopReason, expectedLine } of stopReasons) {
    const ledger: ExecutionLedger = {
      stage: "execute",
      iterations: [],
      final: {
        stopReason,
        completedIssueFilenames: [],
        remainingIssueFilenames: [],
      },
    };

    assert.match(renderRunSummary(ledger, runPaths), new RegExp(expectedLine));
  }
});

test("run summary renders full iteration final messages under a gutter", () => {
  const fullMessage =
    "Implemented the execution summary renderer and added a regression test that keeps this long narrative visible without truncating any words from the provider's final message.";
  const ledger: ExecutionLedger = {
    stage: "execute",
    iterations: [
      {
        iteration: 1,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        gitHeadBefore: null,
        gitHeadAfter: null,
        finalAssistantMessage: fullMessage,
      },
    ],
    final: {
      stopReason: "terminal",
      completedIssueFilenames: [],
      remainingIssueFilenames: [],
    },
  };

  const summary = renderRunSummary(ledger, runPaths);

  assert.match(
    summary,
    / 1 │ Implemented the execution summary renderer and added a regression test that keeps\n   │ this long narrative visible without truncating any words from the provider's final\n   │ message\./,
  );
  assert.match(summary, /without truncating any words/);
});

test("run summary renders multi-iteration narratives and missing-message placeholders", () => {
  const ledger: ExecutionLedger = {
    stage: "execute",
    iterations: [
      {
        iteration: 1,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_first",
        gitHeadBefore: null,
        gitHeadAfter: null,
        finalAssistantMessage: "Added the first execution slice.",
      },
      {
        iteration: 2,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_second",
        gitHeadBefore: null,
        gitHeadAfter: null,
      },
      {
        iteration: 12,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_twelfth",
        gitHeadBefore: null,
        gitHeadAfter: null,
        finalAssistantMessage: "Finished the final execution slice.",
      },
    ],
    final: {
      stopReason: "terminal",
      completedIssueFilenames: [],
      remainingIssueFilenames: [],
    },
  };

  assert.match(
    renderRunSummary(ledger, runPaths),
    / 1 │ Added the first execution slice\.\n 2 │ \(no summary available\)\n12 │ Finished the final execution slice\./,
  );
});

test("run summary does not attribute iterations to completed issue filenames", () => {
  const ledger: ExecutionLedger = {
    stage: "execute",
    iterations: [
      {
        iteration: 1,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        gitHeadBefore: null,
        gitHeadAfter: null,
        finalAssistantMessage: "Completed renderer updates.",
      },
    ],
    final: {
      stopReason: "terminal",
      completedIssueFilenames: ["013-iteration-narratives-gutter-layout.md"],
      remainingIssueFilenames: [],
    },
  };

  const summary = renderRunSummary(ledger, runPaths);
  const iterationsSection = summary.slice(
    summary.indexOf("Iterations:"),
    summary.indexOf("Completed issues:"),
  );

  assert.doesNotMatch(
    iterationsSection,
    /013-iteration-narratives-gutter-layout\.md/,
  );
  assert.doesNotMatch(iterationsSection, /issue/i);
});
