import type { ExecutionLedger } from "./orchestrator.js";

export interface RunSummaryPaths {
  prdArtifact: string;
  issuesDirectory: string;
  executionArtifact: string;
}

function formatStopReason(stopReason: ExecutionLedger["final"]["stopReason"]): string {
  switch (stopReason) {
    case "terminal":
      return "Execution stopped because the provider reported that no more AFK tasks remain.";
    case "no-file":
      return "Execution stopped because there were no AFK issue files left to run.";
    case "cap":
      return "Execution stopped after reaching the iteration cap.";
    case "error":
      return "Execution stopped after an execution error.";
  }
}

function formatList(entries: string[]): string[] {
  if (entries.length === 0) {
    return ["- None"];
  }

  return entries.map((entry) => `- ${entry}`);
}

function formatIterations(iterations: ExecutionLedger["iterations"]): string[] {
  if (iterations.length === 0) {
    return ["- None"];
  }

  return iterations.map((iteration) => `- Iteration ${iteration.iteration}`);
}

export function renderRunSummary(
  ledger: ExecutionLedger,
  paths: RunSummaryPaths,
): string {
  return [
    "",
    "Run summary",
    formatStopReason(ledger.final.stopReason),
    "",
    "Iterations:",
    ...formatIterations(ledger.iterations),
    "",
    "Completed issues:",
    ...formatList(ledger.final.completedIssueFilenames),
    "",
    "Remaining issues likely need human attention (HITL):",
    ...formatList(ledger.final.remainingIssueFilenames),
    "",
    "Artifacts:",
    `- PRD: ${paths.prdArtifact}`,
    `- Issues: ${paths.issuesDirectory}`,
    `- Execution ledger: ${paths.executionArtifact}`,
    "",
    "Next steps: review remaining issues, verify the working tree, and commit or open a PR as needed.",
    "",
  ].join("\n");
}
