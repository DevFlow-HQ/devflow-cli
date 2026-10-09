import assert from "node:assert/strict";
import { withClients } from "../../src/composition/main.js";
import { fakeHarnessProfile, createFake } from "../harness/fake-adapter.js";

import { awaitSettled, followRun } from "../helpers/settleOperation.js";

// The real Secant signal path over a fake Harness. SIGTERM drains shutdown on
// POSIX; Windows kills the process, exercising the same Store rule after a crash.
const [home, workspace, folder, bundleId] = process.argv.slice(2);
assert.ok(home && workspace && folder && bundleId);
await withClients(
  async ({ projectionPort: port, bundleManagement }) => {
    const built = bundleManagement.build(folder, { noInstall: false });
    assert.ok(built.ok);
    assert.ok(
      port.submit({
        operationId: "approve",
        operation: "approve-workspace",
        input: { path: workspace },
      }).admitted,
    );
    const launch = port.submit({
      operationId: "launch",
      operation: "launch-run",
      input: {
        bundle: { id: bundleId },
        launchInputs: {},
        trustDigest: built.report.digest,
        harness: "claude-code",
        requestedModel: "fake-model",
      },
    });
    assert.ok(launch.admitted && launch.runId, JSON.stringify(launch));
    const runId = launch.runId;
    const turn = await followRun(port, runId, (run) =>
      run.actionOffers.find((offer) => offer.action === "interrupt-turn"),
    );
    assert.ok(turn.action === "interrupt-turn");
    assert.ok(
      port.submit({
        operationId: "interrupt",
        operation: "interrupt-turn",
        input: { runId, turnId: turn.turnId },
      }).admitted,
    );
    assert.equal((await awaitSettled(port, "interrupt")).status, "applied");
    assert.equal((await awaitSettled(port, "launch")).status, "applied");
    const waiting = await followRun(port, runId, (run) =>
      run.state === "blocked" ? run : undefined,
    );
    assert.ok(
      waiting.actionOffers.some(
        (offer) => offer.action === "send-follow-up-turn",
      ),
    );
    process.stdout.write("waiting\n");
    // stdin keeps the worker alive until the parent interrupts its owned process.
    await new Promise<void>(() => process.stdin.resume());
    return 0;
  },
  {
    secantHome: home,
    launchCwd: workspace,
    harnessAdapter: createFake({
      profile: fakeHarnessProfile(),
      turns: [
        {
          block: true,
          result: {
            kind: "completed",
            detail: {
              effectiveModel: { known: false },
              session: { state: "open" },
            },
          },
          interruptResult: {
            kind: "interrupted",
            detail: {
              interruption: fakeHarnessProfile().interruption,
              session: { state: "detached", coordinate: { opaque: "s" } },
            },
          },
        },
      ],
    })(),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "fake-claude",
        description: "fake Harness",
      },
    }),
  },
);
