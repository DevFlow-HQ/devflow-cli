import { fakeHarnessProfile } from "../harness/fake-adapter.js";
import assert from "node:assert/strict";
import test from "node:test";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import type { Wiring } from "../../src/composition/main.js";
import {
  COMPLETED_DETACHED,
  INTERRUPTIBLE_TURN,
  launchInteractive,
  send,
  sendLiveTurn,
  interruptTurn,
  humanRepeatRouting,
  writeInteractiveBundle,
} from "../application/interactive-agent-fixture.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";

async function runShow(wired: Wiring, runId: string): Promise<string> {
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
    ["run", "show", runId],
    io,
  );
  assert.equal(code, 0);
  return out.join("");
}

test("m12-test-interface-ownership: run show preserves historical interactive and Agent Turn order (#126)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: fakeHarnessProfile(),
    turns: [COMPLETED_DETACHED, COMPLETED_DETACHED, COMPLETED_DETACHED],
  });
  await send(wired, runId, "op-t1", "discuss", "let us start here");
  await send(wired, runId, "op-t2", "discuss", "now the next idea");
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-end",
      operation: "end-interactive-step",
      input: { runId, stepId: "discuss" },
    }).admitted,
  );
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-end")).status,
    "applied",
  );
  const shown = await runShow(wired, runId);
  const firstInteractive = shown.indexOf("turn-started interactive-agent");
  const firstAgent = shown.indexOf("turn-started agent");
  assert.ok(firstInteractive >= 0, shown);
  assert.ok(firstAgent > firstInteractive, shown);
  assert.match(shown, /interactive-step-ended/);
});

test("m12-test-interface-ownership: run show names the interactive Turn basis for a blocked interactive Step (#122, A15)", async (t) => {
  const { wired, runId, run } = await launchInteractive(t, {
    profile: fakeHarnessProfile(),
    turns: [COMPLETED_DETACHED],
  });
  assert.equal(run.state, "blocked");
  const shown = await runShow(wired, runId);
  assert.match(shown, /Blocked: interactive Turn/);
});

test("m12-test-interface-ownership: run show reports the waiting Step after an interrupted interactive Turn (#353)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: fakeHarnessProfile(),
    turns: [INTERRUPTIBLE_TURN],
  });
  const { interrupt } = await sendLiveTurn(wired, runId, "op-send-interrupted");
  await interruptTurn(
    wired,
    runId,
    interrupt.turnId,
    "op-interrupt-interrupted",
  );
  assert.match(await runShow(wired, runId), /Blocked: interactive Turn/);
  await wired.shutdown();
});

test("m12-test-interface-ownership: run show identifies human-declared completion (#218)", async (t) => {
  const { wired, runId } = await launchInteractive(
    t,
    {
      profile: fakeHarnessProfile(),
      turns: [COMPLETED_DETACHED],
    },
    undefined,
    humanRepeatRouting(),
  );
  await send(wired, runId, "op-i0-t1", "implement", "are we done?");
  for (const [operationId, operation] of [
    ["op-continue-0", "continue-repeat"],
    ["op-end-stage", "end-stage"],
  ] as const) {
    assert.ok(
      wired.projectionPort.submit({
        operationId,
        operation,
        input: { runId, stepId: "implement" },
      }).admitted,
    );
    assert.equal(
      (await awaitSettled(wired.projectionPort, operationId)).status,
      "applied",
    );
  }
  assert.match(
    await runShow(wired, runId),
    /Completion: declared by a human \(Secant did not check the tracker\)/,
  );
});

test("m12-test-interface-ownership: headless refuses an interactive-agent Bundle without creating a Run (#116)", async (t) => {
  const h = openHeadlessHarness(t);
  const bundle = writeInteractiveBundle();
  assert.equal(await h.run(["bundle", "build", bundle.folder]), 0);
  const entry = h.catalog.listEntries().find((entry) => entry.id === bundle.id);
  assert.ok(entry);
  h.catalog.approveWorkspace(h.workspace, new Date());
  h.reset();
  assert.equal(
    await h.run([
      "run",
      "launch",
      bundle.id,
      "--trust",
      entry.digest,
      "--harness",
      "claude-code",
      "--model",
      "fake-model",
    ]),
    1,
  );
  assert.match(h.stderr(), /interactive-step-needs-tui/);
  assert.match(h.stderr(), /TUI/i);
  assert.equal(h.stdout(), "");
  assert.deepEqual(h.runGroup?.listRuns(), []);
});
