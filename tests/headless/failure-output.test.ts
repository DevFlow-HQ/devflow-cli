import { Database } from "bun:sqlite";
import {
  launch,
  receiptAgent,
  refusedPromptBundle,
  writeBundle,
} from "../application/agent-receipt-fixture.js";
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
import { fakeHarnessProfile } from "../harness/fake-adapter.js";
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

test("m11-headless-failure-output: receipt failure explains each failed Attempt and adds failure to the existing JSON event", async (t) => {
  const { wired, runId } = await launch(
    t,
    receiptAgent([undefined, undefined]).adapter,
    writeBundle("none", 1),
  );
  const shown = await show(wired, [runId]);
  assert.equal(shown.code, 0);
  const failedLines = shown.out
    .split("\n")
    .filter((line) => line.includes("attempt-settled failed"));
  assert.equal(failedLines.length, 2);
  for (const line of failedLines)
    assert.match(
      line,
      /attempt-settled failed · step publish · The required output "spec-ref" was not written\. It may have changed files before it stopped\.$/,
    );
  assert.match(shown.out, /turn-settled agent completed · step publish/);
  const json = await show(wired, [runId, "--json"]);
  assert.equal(json.code, 0);
  const run = JSON.parse(json.out).result.run;
  const events = run.timeline.filter(
    (event: { event: string }) => event.event === "attempt-settled",
  );
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "at",
      "detail",
      "event",
      "failure",
      "step",
    ]);
    assert.equal(event.detail, "failed");
    assert.deepEqual(event.failure, {
      source: "receipt",
      code: "receipt-missing",
      possibleEffects: "unknown",
      details: { outputName: "spec-ref" },
      explanation:
        'The required output "spec-ref" was not written. It may have changed files before it stopped.',
      nextStep: "Resume the Run to try the Step again.",
    });
  }
});

for (const sql of [
  "DELETE FROM failure_evidence",
  "UPDATE failure_evidence SET source = 'new-source'",
  "UPDATE failure_evidence SET code = 'new-code'",
  "UPDATE failure_evidence SET details = '{'",
  "UPDATE failure_evidence SET possible_effects = 'new-effects'",
]) {
  test(`m11-headless-failure-output: unknown persisted evidence stays readable (${sql})`, async (t) => {
    const { wired, runId, home } = await launch(
      t,
      receiptAgent([undefined]).adapter,
      writeBundle("none"),
    );
    const roots = join(home, "runs");
    const db = new Database(
      join(roots, readdirSync(roots)[0]!, runId, "run.db"),
    );
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    const plain = await show(wired, [runId]);
    assert.equal(plain.code, 0);
    assert.match(plain.out, /attempt-settled failed · step publish · /);
    assert.match(plain.out, /It may have changed files before it stopped\./);
    const json = await show(wired, [runId, "--json"]);
    assert.equal(json.code, 0);
    const failed = JSON.parse(json.out).result.run.timeline.find(
      (e: { event: string }) => e.event === "attempt-settled",
    );
    assert.equal(failed.failure.possibleEffects, "unknown");
    assert.equal(
      failed.failure.code,
      sql.includes("possible_effects") ? "receipt-missing" : "unknown",
    );
  });
}

for (const kind of ["agent", "interactive-agent"] as const) {
  test(`m11-pre-turn-agent-evidence: run show text and JSON carry ${kind} refusal without renaming fields`, async (t) => {
    const { wired, runId } = await launch(
      t,
      receiptAgent(["/model unsafe"]).adapter,
      refusedPromptBundle(kind),
      true,
    );
    const shown = await show(wired, [runId]);
    assert.equal(shown.code, 0);
    const event = kind === "agent" ? "attempt-settled" : "attempt-failure";
    assert.ok(shown.out.includes(`${event}`));
    assert.match(
      shown.out,
      /step tickets · Secant did not send the prompt because it starts with a word the Harness reserves\./,
    );
    const json = await show(wired, [runId, "--json"]);
    assert.equal(json.code, 0);
    const run = JSON.parse(json.out).result.run;
    assert.equal(run.state, kind === "agent" ? "failed" : "blocked");
    const failed = run.timeline.find(
      (e: { step?: string }) => e.step === "tickets",
    );
    assert.equal(failed.event, event);
    assert.equal(failed.failure.code, "prompt-refused");
    assert.equal(failed.failure.source, "agent");
    assert.equal(failed.failure.possibleEffects, "none");
    assert.deepEqual(
      Object.keys(failed).sort(),
      kind === "agent"
        ? ["at", "detail", "event", "failure", "step"]
        : ["at", "event", "failure", "step"],
    );
    assert.equal(failed.failure.diagnostic.type, "diagnostic");
    await wired.shutdown();
  });
}

for (const delivery of ["skill", "file"] as const) {
  test(`m11-pre-turn-agent-evidence: run show carries ${delivery} render failure and diagnostic`, async (t) => {
    const profile = fakeHarnessProfile({
      [delivery === "skill" ? "skillDelivery" : "fileDelivery"]: {
        mode: "native",
        evidence: "native only",
      },
    });
    const { wired, runId } = await launch(
      t,
      receiptAgent([], { profile }).adapter,
      writeBundle("none"),
    );
    const shown = await show(wired, [runId]);
    assert.equal(shown.code, 0);
    assert.match(
      shown.out,
      /attempt-settled failed · step publish · Secant could not prepare the prompt and did not send it\./,
    );
    const run = JSON.parse((await show(wired, [runId, "--json"])).out).result
      .run;
    assert.equal(run.timeline.at(-1).failure.code, "prompt-render-failed");
    assert.equal(
      run.timeline.at(-1).failure.category,
      "unsupported-delivery-mode",
    );
    await wired.shutdown();
  });
}

test("m11-pre-turn-agent-evidence: run show carries output preparation evidence through retries", async (t) => {
  const { wired, runId } = await launch(
    t,
    receiptAgent([], { squatReceiptRoot: true }).adapter,
    writeBundle("none", 1),
  );
  const shown = await show(wired, [runId]);
  assert.equal(shown.code, 0);
  assert.equal(
    (
      shown.out.match(
        /Secant could not prepare the prompt and did not send it\./g,
      ) ?? []
    ).length,
    2,
  );
  const run = JSON.parse((await show(wired, [runId, "--json"])).out).result.run;
  assert.deepEqual(
    run.timeline
      .filter((e: { event: string }) => e.event === "attempt-settled")
      .map((e: { failure: { code: string } }) => e.failure.code),
    ["not-started", "not-started"],
  );
  await wired.shutdown();
});

test("m11-pre-turn-agent-evidence: run show names an unusable conversation without another Turn", async (t) => {
  const agent = receiptAgent([undefined], {
    results: [
      {
        kind: "failed",
        detail: {
          failure: {
            phase: "recovery",
            category: "cannot-recover",
            possibleEffects: "none",
          },
          effectiveModel: { known: false },
          session: { state: "unusable", reason: "cannot recover" },
        },
      },
    ],
  });
  const { wired, runId } = await launch(
    t,
    agent.adapter,
    writeBundle("none", 1),
  );
  const shown = await show(wired, [runId]);
  assert.equal(shown.code, 0);
  assert.match(
    shown.out,
    /This Step's agent conversation can no longer continue\./,
  );
  const run = JSON.parse((await show(wired, [runId, "--json"])).out).result.run;
  assert.equal(run.timeline.at(-1).failure.code, "session-unusable");
  assert.equal(run.timeline.at(-1).failure.possibleEffects, "none");
  assert.equal(agent.inputs.length, 1);
  await wired.shutdown();
});

import {
  harnessFailureCases,
  launchHarnessFailure,
} from "../application/harness-failure-fixture.js";
for (const scenario of harnessFailureCases) {
  test(`m11-harness-failure-evidence: run show carries ${scenario.name} once in text and turn-settled JSON`, async (t) => {
    const { wired, runId } = await launchHarnessFailure(t, scenario.result);
    const plain = await show(wired, [runId]);
    assert.equal(plain.code, 0);
    const line = plain.out
      .split("\n")
      .find((line) => line.includes("turn-settled"))!;
    assert.ok(line.endsWith(scenario.explanation), plain.out);
    assert.equal(plain.out.split(scenario.explanation).length - 1, 1);
    const json = await show(wired, [runId, "--json"]);
    assert.equal(json.code, 0);
    const run = JSON.parse(json.out).result.run;
    const turn = run.timeline.find(
      (event: { event: string }) => event.event === "turn-settled",
    );
    assert.equal(turn.failure.code, `turn-${scenario.result.kind}`);
    assert.equal(turn.failure.explanation, scenario.explanation);
    assert.equal(turn.failure.possibleEffects, scenario.effects);
    const attempt = run.timeline.find(
      (event: { event: string }) => event.event === "attempt-settled",
    );
    if (attempt !== undefined) {
      assert.deepEqual(attempt.failure, { turnId: turn.turnId });
    }
  });
}
