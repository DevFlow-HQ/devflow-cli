import assert from "node:assert/strict";
import { createClaudeCodeAdapter } from "../../src/harness/harness.js";
import { createProcessAdapter } from "../../src/process/process.js";
import { openRunGroup } from "../../src/run/store/store.js";
import { withRunnerObserver } from "../helpers/standalone.js";
const [home, workspace, executable] = process.argv.slice(2);
assert.ok(home && workspace && executable);
const runtime = createProcessAdapter(withRunnerObserver());
const group = openRunGroup(home, workspace, { process: runtime });
const created = group.createRun({
  operationId: "harness-owner",
  bundleSnapshotDigest: "sha256:owner-recovery",
  launch: {},
  selectedHarness: "claude-code",
  at: new Date(),
});
const owner = group.acquireRun(created.runId);
assert.ok(owner);
const prepared = await createClaudeCodeAdapter({
  path: executable,
  env: {},
  sessionId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}).prepare({ workspace, process: runtime });
assert.ok(prepared.ok);
const turn = prepared.harness.startTurn({
  session: "planning",
  origin: "managed",
  correlationKey: { opaque: "owner-turn" },
  input: { text: "go" },
  recorder: {
    admit: (admission) => {
      const written = owner.admitTurn({
        turnId: "owner-turn",
        attemptId: "0.0:agent",
        session: "planning",
        origin: "managed",
        kind: "agent",
        input: admission.input.text,
        recoveryCoordinate: admission.recoveryCoordinate.opaque,
        harness: "claude-code",
        at: new Date(),
      });
      assert.ok(written.ok);
      return Promise.resolve({ recorded: true });
    },
    checkpoint: () => Promise.resolve({ recorded: true }),
  },
});
await new Promise<void>((resolve) =>
  turn.subscribe((event) => {
    if (event.kind === "session") resolve();
  }),
);
process.stdout.write("ready\n");
// The parent kills this owner instead of allowing orderly teardown.
await new Promise<void>(() => {});
