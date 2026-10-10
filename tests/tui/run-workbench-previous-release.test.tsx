import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAILED_RUN,
  HALTED_RUN,
  copyPreviousReleaseHome,
  injectNewerEvidence,
  withPreviousReleaseApplication,
} from "../application/previous-release-failure-fixture.js";
import { readRun } from "../application/run-test-helpers.js";
import {
  mountWorkbench,
  noOverflow,
  press,
  runOf,
} from "./run-workbench-fixture.js";

// The Workbench over an upgraded pre-M11 home (#536): the real Application's
// snapshot of each predecessor Run reaches the Renderer. Failures with no
// evidence read as unknown; facts from a newer Secant never break the screen.

const UNKNOWN_ROW =
  /┃This Step failed for unknown reasons\. It may have changed files before it stopped\.\s*\n\s*┃Next: Resume the Run to try again, or delete it\./g;

test("m11-old-and-unknown-evidence: the Workbench reads upgraded halted and failed predecessor Runs as unknown", async () => {
  const home = copyPreviousReleaseHome();
  for (const [runId, resting, last] of [
    [HALTED_RUN, "⏸ Run halted", "indeterminate"],
    [FAILED_RUN, "✗ Run failed", "failed"],
  ] as const) {
    const run = await withPreviousReleaseApplication(home, async (app) =>
      readRun(app.projectionPort, runId),
    );
    const { t, renderer } = await mountWorkbench(run, 100, 40);
    const frame = t.captureCharFrame();
    assert.match(
      frame,
      new RegExp(`${resting} — This Step failed for unknown reasons\\.`),
    );
    assert.match(frame, /Next: Resume the Run to try again, or delete it\./);
    assert.match(frame, /▸ Step Attempt succeeded/);
    assert.deepEqual(
      [...frame.matchAll(/✗ Step Attempt (\w+)/g)].map((match) => match[1]),
      ["failed", last],
    );
    // Both build Attempts carry their own unknown failure row.
    assert.equal(frame.match(UNKNOWN_ROW)?.length, 2);
    noOverflow(frame, 100);

    await press(t, renderer, "g", { ctrl: true });
    const panel = t.captureCharFrame();
    assert.match(panel, /Resting cause · unknown/);
    assert.match(panel, /Source · unknown/);
    assert.match(panel, /Code · unknown/);
    assert.match(panel, /Possible effects · May have changed files/);
    // Nothing was recorded, so nothing has expired.
    assert.match(panel, /Diagnostic · None recorded/);
    assert.doesNotMatch(panel, /Expired after 90 days/);
    assert.match(panel, /r resume — /);
    assert.match(panel, /x delete — /);
  }
});

test("m11-old-and-unknown-evidence: the Workbench narrows newer sources, codes, effects and malformed details field by field", async () => {
  const home = copyPreviousReleaseHome();
  await withPreviousReleaseApplication(home, async () => {});
  injectNewerEvidence(home);
  const { halted, diagnostic, failed } = await withPreviousReleaseApplication(
    home,
    async (app) => {
      const halted = readRun(app.projectionPort, HALTED_RUN);
      assert.ok(halted.restingCause?.diagnostic);
      return {
        halted,
        diagnostic: app.projectionPort.readResource(
          halted.restingCause.diagnostic,
        ),
        failed: readRun(app.projectionPort, FAILED_RUN),
      };
    },
  );

  // The unknown Resting cause still opens its diagnostic from details.
  const mounted = await mountWorkbench(runOf(), 100, 40);
  mounted.control.setRead("d:newer-diagnostic", diagnostic);
  mounted.control.setRun(halted);
  await mounted.t.waitForFrame((frame) => frame.includes("⏸ Run halted"));
  const frame = mounted.t.captureCharFrame();
  assert.match(frame, /⏸ Run halted — This Step failed for unknown reasons\./);
  // An unknown source keeps its valid "none" effects: no warning on that row.
  assert.match(
    frame,
    /✗ Step Attempt failed\s*\n\s*┃This Step failed for unknown reasons\.\s*\n/,
  );
  // An unknown code under a known source reads as unknown, with the warning.
  assert.match(
    frame,
    /✗ Step Attempt indeterminate\s*\n\s*┃This Step failed for unknown reasons\. It may have changed files before it stopped\./,
  );
  assert.doesNotMatch(frame, /newer-source|receipt-newer|newer-cause/);
  await press(mounted.t, mounted.renderer, "g", { ctrl: true });
  const panel = mounted.t.captureCharFrame();
  assert.match(panel, /Resting cause · unknown/);
  assert.match(panel, /Code · unknown/);
  assert.match(panel, /failure diagnostic: unknown/);
  while (!/› failure diagnostic/.test(mounted.t.captureCharFrame()))
    await press(mounted.t, mounted.renderer, "down");
  await press(mounted.t, mounted.renderer, "return");
  assert.match(mounted.t.captureCharFrame(), /Recorded by a newer Secant\./);

  const other = await mountWorkbench(failed, 100, 40);
  const failedFrame = other.t.captureCharFrame();
  // Details missing a required field make the first cause unknown.
  assert.match(
    failedFrame,
    /✗ Step Attempt failed\s*\n\s*┃This Step failed for unknown reasons\. It may have changed files before it stopped\./,
  );
  // An unknown effects value keeps the valid cause and adds the warning.
  assert.match(
    failedFrame,
    /┃The required output "build-log" exceeds the 1024-byte limit\. It may have changed files before it\s*\n\s*┃\s*stopped\./,
  );
  await press(other.t, other.renderer, "g", { ctrl: true });
  const failedPanel = other.t.captureCharFrame();
  assert.match(failedPanel, /Source · receipt/);
  assert.match(failedPanel, /Code · receipt-too-large/);
  assert.match(failedPanel, /Possible effects · May have changed files/);
  noOverflow(failedPanel, 100);
});
