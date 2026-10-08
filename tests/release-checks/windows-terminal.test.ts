import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWindowsTerminalReport,
  windowsTerminalOutcome,
  type WindowsTerminalReport,
} from "../../scripts/release-checks/windows-terminal-report.js";

const passingReport: WindowsTerminalReport = {
  report: {
    checkName: "Windows Terminal human real-terminal check",
    operatingSystem: { name: "Windows 11", version: "10.0.26100" },
    subject: {
      kind: "terminal",
      name: "Windows Terminal",
      version: "1.23.1234.0",
    },
    bunVersion: "1.4.2",
    secantVersion: "0.1.0",
    binarySha256: "a".repeat(64),
    outcome: "pass",
    timestamp: "2026-09-12T12:34:56.000Z",
  },
  evidence: { kind: "fresh" },
  quitBindingPassed: true,
  ctrlCPassed: true,
  altArrowScrollPassed: true,
  mouseWheelScrollPassed: true,
  shiftEnterNewlinePassed: true,
  clipboardCopyPassed: true,
  conhostNoticeAppeared: true,
  conhostNoticeReadable: true,
  conhostWindowSurvived: false,
};

test("m10-audit-windows-release-check: formats all terminal observations with a non-deciding conhost row", () => {
  const report = formatWindowsTerminalReport(passingReport);

  assert.equal(
    report,
    `## Windows Terminal human real-terminal check

- Check name: Windows Terminal human real-terminal check
- OS and version: Windows 11 10.0.26100
- Terminal: Windows Terminal 1.23.1234.0
- Bun version: 1.4.2
- Secant version: 0.1.0
- Binary SHA-256: ${"a".repeat(64)}
- Outcome: pass
- UTC timestamp: 2026-09-12T12:34:56.000Z
- Evidence basis: fresh real-terminal check

| Host | Action | Observation | Result |
| --- | --- | --- | --- |
| Windows Terminal | Quit command (Ctrl+P, Quit, Enter) | Key delivered, shell exited, and terminal remained responsive | pass |
| Windows Terminal | Ctrl+C | Key delivered, shell exited, and terminal remained responsive | pass |
| Windows Terminal | Alt+Up / Alt+Down | History scrolled in both directions while compose retained its draft | pass |
| Windows Terminal | Mouse wheel | History scrolled in both directions | pass |
| Windows Terminal | Shift+Enter (kitty keyboard protocol) | Compose inserted a newline without sending a Turn | pass |
| Windows Terminal | OSC 52 clipboard copy | Exported transcript pasted into another application with matching text | pass |
| legacy conhost (observed only; does not decide outcome) | Quit command (Ctrl+P, Quit, Enter) | Startup notice appeared | yes |
| legacy conhost (observed only; does not decide outcome) | startup | Notice read and a key pressed before TUI takeover | yes |
| legacy conhost (observed only; does not decide outcome) | Quit command (Ctrl+P, Quit, Enter) | Window survived and remained responsive | no |`,
  );
});

const checks = [
  ["quitBindingPassed", "Quit command (Ctrl+P, Quit, Enter)"],
  ["ctrlCPassed", "Ctrl+C"],
  ["altArrowScrollPassed", "Alt+Up / Alt+Down"],
  ["mouseWheelScrollPassed", "Mouse wheel"],
  ["shiftEnterNewlinePassed", "Shift+Enter (kitty keyboard protocol)"],
  ["clipboardCopyPassed", "OSC 52 clipboard copy"],
] as const;

for (const [key, action] of checks) {
  test(`m10-audit-windows-release-check: a failed ${action} observation fails the report`, () => {
    const observations = { ...passingReport, [key]: false };
    assert.equal(windowsTerminalOutcome(observations), "fail");
    const failed = formatWindowsTerminalReport({
      ...observations,
      report: { ...passingReport.report, outcome: "fail" },
    });
    assert.match(failed, /- Outcome: fail/);
    assert.ok(
      failed
        .split("\n")
        .some(
          (line) =>
            line.startsWith(`| Windows Terminal | ${action} |`) &&
            line.endsWith("| fail |"),
        ),
    );
    assert.throws(
      () => formatWindowsTerminalReport(observations),
      /observations must agree/,
    );
  });
}

test("m10-audit-windows-release-check: rejects a failed header over passing observations and a non-terminal subject", () => {
  assert.equal(windowsTerminalOutcome(passingReport), "pass");
  assert.throws(
    () =>
      formatWindowsTerminalReport({
        ...passingReport,
        report: { ...passingReport.report, outcome: "fail" },
      }),
    /observations must agree/,
  );
  assert.throws(
    () =>
      formatWindowsTerminalReport({
        ...passingReport,
        report: {
          ...passingReport.report,
          subject: { kind: "harness", name: "Codex", version: "0.42.0" },
        },
      }),
    /requires a terminal subject/,
  );
});
