import type { ExecutionLedger } from "./orchestrator.js";

export interface RunSummaryPaths {
  prdArtifact: string;
  issuesDirectory: string;
  executionArtifact: string;
}

const ITERATION_MESSAGE_WIDTH = 82;

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
    case "incomplete":
      return "Execution stopped before a final execution record was written.";
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

  const iterationColumnWidth = Math.max(
    2,
    ...iterations.map((iteration) => iteration.iteration.toString().length),
  );

  return iterations.flatMap((iteration) => {
    const message = iteration.finalAssistantMessage ?? "(no summary available)";
    const wrappedLines = wrapMessage(message, ITERATION_MESSAGE_WIDTH);
    const firstPrefix = `${iteration.iteration
      .toString()
      .padStart(iterationColumnWidth)} │ `;
    const continuationPrefix = `${" ".repeat(iterationColumnWidth)} │ `;

    return wrappedLines.map((line, index) => {
      const prefix = index === 0 ? firstPrefix : continuationPrefix;
      return `${prefix}${line}`;
    });
  });
}

function wrapMessage(message: string, width: number): string[] {
  return message
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line.trimEnd(), width));
}

function wrapLine(line: string, width: number): string[] {
  if (line.length === 0) {
    return [""];
  }

  const words = line.split(/\s+/);
  const wrappedLines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
      continue;
    }

    const candidate = `${currentLine} ${word}`;
    if (candidate.length > width) {
      wrappedLines.push(currentLine);
      currentLine = word;
      continue;
    }

    currentLine = candidate;
  }

  wrappedLines.push(currentLine);
  return wrappedLines;
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
