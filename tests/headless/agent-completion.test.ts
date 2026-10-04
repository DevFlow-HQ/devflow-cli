import assert from "node:assert/strict";
import test from "node:test";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import {
  launchAgentCompletionRun,
  completed,
  call,
} from "../helpers/agentCompletion.js";
import { awaitSettled } from "../helpers/settleOperation.js";

test("run show JSON retains the raw agent reason from a TUI-capable launch", async (t) => {
  const reason = "ready\n\x1b[31mred\x1b[0m\t\x07\u202e終";
  const { wired, runId } = await launchAgentCompletionRun(t, [
    { agentCalls: [call(reason)], result: completed },
  ]);
  await awaitSettled(wired.projectionPort, "launch");
  const output: string[] = [];
  const io: HeadlessIO = {
    out: (text) => output.push(text),
    err: () => {},
    cwd: () => process.cwd(),
  };
  assert.equal(
    await runHeadless(wired, ["run", "show", runId, "--json"], io),
    0,
  );
  const snapshot = JSON.parse(output.join(""));
  assert.equal(snapshot.result.run.state, "succeeded");
  assert.equal(snapshot.result.run.completion, "agent-declared");
  assert.equal(
    snapshot.result.run.timeline.find(
      (e: { endedBy?: string }) => e.endedBy === "agent",
    ).reason,
    reason,
  );
  assert.equal(
    snapshot.result.run.timeline.find(
      (e: { event: string }) => e.event === "agent-call",
    ).agentCall.reason,
    reason,
  );
  output.length = 0;
  assert.equal(await runHeadless(wired, ["run", "show", runId], io), 0);
  const text = output.join("");
  assert.match(text, /ended by the agent · ready red/);
  for (const marker of [" agent-call", "ended by the agent"]) {
    const line = text.split("\n").find((entry) => entry.includes(marker));
    assert.ok(line);
    assert.match(line, / · step discuss$/);
  }
  for (const control of ["\x1b", "\x07", "\u202e"])
    assert.equal(text.includes(control), false);
});
