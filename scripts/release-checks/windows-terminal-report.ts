import {
  formatReleaseEvidenceReport,
  type ReleaseEvidenceReport,
} from "./release-evidence.js";

type WindowsTerminalEvidence =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "carry-forward";
      readonly report: string;
      readonly comparison: string;
    };

export interface WindowsTerminalReport {
  readonly report: ReleaseEvidenceReport;
  readonly evidence: WindowsTerminalEvidence;
  readonly quitBindingPassed: boolean;
  readonly ctrlCPassed: boolean;
  readonly altArrowScrollPassed: boolean;
  readonly mouseWheelScrollPassed: boolean;
  readonly shiftEnterNewlinePassed: boolean;
  readonly clipboardCopyPassed: boolean;
  readonly conhostNoticeAppeared: boolean;
  readonly conhostNoticeReadable: boolean;
  readonly conhostWindowSurvived: boolean;
}

function formatPassFail(value: boolean): "pass" | "fail" {
  return value ? "pass" : "fail";
}

function formatYesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

export function windowsTerminalOutcome(
  observations: Pick<
    WindowsTerminalReport,
    | "quitBindingPassed"
    | "ctrlCPassed"
    | "altArrowScrollPassed"
    | "mouseWheelScrollPassed"
    | "shiftEnterNewlinePassed"
    | "clipboardCopyPassed"
  >,
): ReleaseEvidenceReport["outcome"] {
  return observations.quitBindingPassed &&
    observations.ctrlCPassed &&
    observations.altArrowScrollPassed &&
    observations.mouseWheelScrollPassed &&
    observations.shiftEnterNewlinePassed &&
    observations.clipboardCopyPassed
    ? "pass"
    : "fail";
}

export function formatWindowsTerminalReport(
  report: WindowsTerminalReport,
): string {
  const observedOutcome = windowsTerminalOutcome(report);
  if (report.report.subject.kind !== "terminal") {
    throw new Error("Windows Terminal evidence requires a terminal subject.");
  }
  if (report.report.outcome !== observedOutcome) {
    throw new Error(
      "Windows Terminal observations must agree with the common report outcome.",
    );
  }
  if (
    report.evidence.kind === "carry-forward" &&
    (report.evidence.report.trim().length === 0 ||
      report.evidence.comparison.trim().length === 0)
  ) {
    throw new Error(
      "Carry-forward evidence requires a named prior report and comparison.",
    );
  }
  const evidence =
    report.evidence.kind === "fresh"
      ? "- Evidence basis: fresh real-terminal check"
      : `- Evidence basis: carry-forward from ${report.evidence.report}
- Named comparison: ${report.evidence.comparison}`;
  return `${formatReleaseEvidenceReport(report.report)}
${evidence}

| Host | Action | Observation | Result |
| --- | --- | --- | --- |
| Windows Terminal | Quit command (Ctrl+P, Quit, Enter) | Key delivered, shell exited, and terminal remained responsive | ${formatPassFail(report.quitBindingPassed)} |
| Windows Terminal | Ctrl+C | Key delivered, shell exited, and terminal remained responsive | ${formatPassFail(report.ctrlCPassed)} |
| Windows Terminal | Alt+Up / Alt+Down | History scrolled in both directions while compose retained its draft | ${formatPassFail(report.altArrowScrollPassed)} |
| Windows Terminal | Mouse wheel | History scrolled in both directions | ${formatPassFail(report.mouseWheelScrollPassed)} |
| Windows Terminal | Shift+Enter (kitty keyboard protocol) | Compose inserted a newline without sending a Turn | ${formatPassFail(report.shiftEnterNewlinePassed)} |
| Windows Terminal | OSC 52 clipboard copy | Exported transcript pasted into another application with matching text | ${formatPassFail(report.clipboardCopyPassed)} |
| legacy conhost (observed only; does not decide outcome) | Quit command (Ctrl+P, Quit, Enter) | Startup notice appeared | ${formatYesNo(report.conhostNoticeAppeared)} |
| legacy conhost (observed only; does not decide outcome) | startup | Notice read and a key pressed before TUI takeover | ${formatYesNo(report.conhostNoticeReadable)} |
| legacy conhost (observed only; does not decide outcome) | Quit command (Ctrl+P, Quit, Enter) | Window survived and remained responsive | ${formatYesNo(report.conhostWindowSurvived)} |`;
}
