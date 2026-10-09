import assert from "node:assert/strict";
import test from "node:test";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import {
  launchAgentCompletionRun,
  completed,
  call,
  reviewedLoop,
  across,
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
  assert.match(text, /ended by the agent · ready\nred\t終/);
  assert.match(text, /agent-call[^\n]*ready\nred\t終 · step discuss/);
  assert.match(text, /ended by the agent · ready\nred\t終 · step discuss/);
  for (const control of ["\x1b", "\x07", "\u202e"])
    assert.equal(text.includes(control), false);
});

test("run show JSON reports a held agent Continue and its raw checkpoint message", async (t) => {
  const message = "Review\nthe \x1b[31mtracker\x1b[0m.";
  const { wired, runId } = await launchAgentCompletionRun(
    t,
    across([
      { agentCalls: [call("ticket 1 done", "1")], result: completed },
      { agentCalls: [call("ticket 2 done", "2")], result: completed },
    ]),
    reviewedLoop({ interval: 1, message }),
  );
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
  const run = JSON.parse(output.join("")).result.run;
  assert.equal(run.state, "blocked");
  assert.deepEqual(run.heldForReview, {
    interval: 1,
    message,
    reason: "ticket 2 done",
  });
  assert.deepEqual(
    run.timeline
      .filter((e: { event: string }) => e.event === "agent-call")
      .map(
        (e: { agentCall: { answer: { outcome: string } } }) =>
          e.agentCall.answer.outcome,
      ),
    ["accepted", "held-for-review"],
  );
  assert.equal(
    run.timeline.find((e: { event: string }) => e.event === "repeat-continued")
      .endedBy,
    "agent",
  );
  output.length = 0;
  assert.equal(await runHeadless(wired, ["run", "show", runId], io), 0);
  const text = output.join("");
  assert.match(
    text,
    /Held for review:\n {2}message: Review\nthe tracker\.\n {2}held after: 1 agent Continue\(s\) in a row\n {2}agent reason: ticket 2 done/,
  );
  assert.equal(text.includes("\x1b"), false);
});
