import assert from "node:assert/strict";
import test from "node:test";

import { renderRunSummary } from "../src/runSummary.js";
import type { ExecutionLedger } from "../src/orchestrator.js";

const runPaths = {
  prdArtifact: "/repo/.devflow/runs/run-123/prd.md",
  issuesDirectory: "/repo/.devflow/runs/run-123/issues",
  executionArtifact: "/repo/.devflow/runs/run-123/execution.json",
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
      "- Iteration 1",
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
