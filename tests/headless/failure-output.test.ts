import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import type { Wiring } from "../../src/composition/main.js";
import {
  COMPLETED_DETACHED,
  launchInteractive,
  scriptedAdapter,
} from "../application/interactive-agent-fixture.js";
import { awaitSettled, followRun } from "../helpers/settleOperation.js";

// `run show` for a resting Run (#528, ADR 0041): "Stopped because:" and "Next:"
// under `State:`, an optional `restingCause` in `--json`, and the cause's
// Detailed diagnostic through the existing diagnostic read. Exit codes and
// existing fields are unchanged.

async function show(
  wired: Wiring,
  args: readonly string[],
): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: () => {},
    cwd: () => process.cwd(),
  };
  const code = await runHeadless(
    {
      projectionPort: wired.projectionPort,
      bundleManagement: wired.bundleManagement,
    },
    ["run", "show", ...args],
    io,
  );
  return { code, out: out.join("") };
}

/** An interactive Run whose human Turn faulted after admission, resting halted. */
async function faultedRun(t: TestContext) {
  const launched = await launchInteractive(
    t,
    scriptedAdapter([{ turns: [COMPLETED_DETACHED], fault: true }]),
  );
  const { wired, runId } = launched;
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-send-faults",
      operation: "send-interactive-turn",
      input: { runId, stepId: "discuss", text: "go" },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "op-send-faults");
  await followRun(wired.projectionPort, runId, (run) =>
    run.problem !== undefined ? run : undefined,
  );
  return launched;
}

test("m11-headless-failure-output: run show prints why a resting Run stopped and what to do next under State", async (t) => {
  const { wired, runId } = await faultedRun(t);
  const shown = await show(wired, [runId]);
  // `show` never exits by rest state.
  assert.equal(shown.code, 0);
  assert.match(
    shown.out,
    /\nState: halted\nStopped because: Secant hit an internal error\. It may have changed files before it stopped\.\nNext: Resume the Run to try again\. If it happens again, open the details section for the cause\.\n/,
  );
  // The diagnostic is read through the existing diagnostic reference.
  assert.match(
    shown.out,
    /\nDiagnostic:\nKind: execution-fault\n\nCause: Error\nMessage: scripted Secant fault/,
  );
});

test("m11-headless-failure-output: run show --json adds restingCause only while the Run rests", async (t) => {
  const { wired, runId } = await faultedRun(t);
  const shown = await show(wired, [runId, "--json"]);
  assert.equal(shown.code, 0);
  const run = JSON.parse(shown.out).result.run;
  assert.equal(run.state, "halted");
  const diagnosticId = run.restingCause?.diagnostic?.diagnosticId;
  assert.equal(typeof diagnosticId, "string");
  assert.deepEqual(run.restingCause, {
    code: "execution-fault",
    explanation:
      "Secant hit an internal error. It may have changed files before it stopped.",
    nextStep:
      "Resume the Run to try again. If it happens again, open the details section for the cause.",
    possibleEffects: "unknown",
    diagnostic: { runId, diagnosticId, type: "diagnostic" },
  });

  // A blocked Run carries no cause, so its frozen key list is unchanged.
  const blocked = await launchInteractive(
    t,
    scriptedAdapter([{ turns: [COMPLETED_DETACHED] }]),
  );
  const waiting = await show(blocked.wired, [blocked.runId, "--json"]);
  const waitingRun = JSON.parse(waiting.out).result.run;
  assert.equal(waitingRun.state, "blocked");
  assert.equal("restingCause" in waitingRun, false);
  // The resting Run differs from it only by the cause and the facts its Turn added.
  assert.deepEqual(
    Object.keys(run)
      .filter((key) => !Object.hasOwn(waitingRun, key))
      .sort(),
    ["problem", "restingCause", "sessions", "turnPosition"],
  );
});

test("m11-headless-failure-output: run show reads an expired diagnostic as expired", async (t) => {
  const { wired, runId, home } = await faultedRun(t);
  const runs = join(home, "runs");
  const diagnostics = join(runs, readdirSync(runs)[0]!, runId, "diagnostics");
  for (const file of readdirSync(diagnostics)) {
    rmSync(join(diagnostics, file));
  }
  const shown = await show(wired, [runId]);
  assert.equal(shown.code, 0);
  assert.match(shown.out, /\nStopped because: Secant hit an internal error/);
  assert.match(shown.out, /\nDiagnostic: expired\n/);
});
