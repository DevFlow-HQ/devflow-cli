import type { RunView } from "../../src/application/projection-port.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFake, fakeHarnessProfile } from "../harness/fake-adapter.js";
import { launch, writeBundle } from "./agent-receipt-fixture.js";
import { readRun } from "./run-test-helpers.js";

test("m11-harness-failure-evidence: fake Harness authentication failure reaches history once and retains technical evidence", async (t) => {
  const { wired, runId } = await launch(
    t,
    createFake({
      profile: fakeHarnessProfile(),
      turns: [
        {
          result: {
            kind: "failed",
            detail: {
              effectiveModel: { known: false },
              session: { state: "open" },
              failure: {
                phase: "turn",
                category: "authentication",
                possibleEffects: "none",
                nativeCode: "EAUTH",
                cause: new Error("login required"),
                partialOutput: "partial",
                retryEvidence: "safe retry",
                diagnostics: "diagnostic",
              },
            },
          },
        },
      ],
    })(),
    writeBundle("none"),
  );
  const run: RunView = readRun(wired.projectionPort, runId);
  const settled = run.timeline.find((e) => e.event === "turn-settled")!;
  assert.ok(settled.failure && "explanation" in settled.failure);
  assert.equal(settled.failure?.source, "harness");
  assert.equal(settled.failure?.code, "turn-failed");
  assert.equal(settled.failure?.category, "authentication");
  assert.equal(settled.failure?.nativeCode, "EAUTH");
  assert.equal(settled.failure?.explanation, "Claude Code is not signed in.");
  assert.equal(
    settled.failure?.nextStep,
    "Log in through Claude Code itself, then resume the Run.",
  );
  const attempt = run.timeline.find((e) => e.event === "attempt-settled")!;
  assert.deepEqual(attempt.failure, { turnId: settled.turnId });
  const history = wired.projectionPort.openProjection({
    family: "session-history",
    runId,
    session: "planning",
  });
  t.after(() => history.close());
  assert.ok(history.snapshot.result.found);
  const rows = history.snapshot.result.history.rows;
  assert.deepEqual(
    rows.map((row) => row.value.kind),
    ["entry-prompt", "turn-result"],
  );
  const value = rows.at(-1)!.value;
  assert.ok(value.kind === "turn-result");
  assert.equal(value.failure?.explanation, settled.failure?.explanation);
});

import {
  harnessFailureCases,
  launchHarnessFailure,
} from "./harness-failure-fixture.js";
import { wireApplication } from "../../src/composition/main.js";
import { storedProcess } from "../helpers/wiringDoubles.js";
for (const scenario of harnessFailureCases) {
  test(`m11-harness-failure-evidence: ${scenario.name} stores every field and reaches the reopened Projection and history`, async (t) => {
    const launched = await launchHarnessFailure(t, scenario.result);
    const check = async (wired: typeof launched.wired) => {
      const run: RunView = readRun(wired.projectionPort, launched.runId);
      const turn = run.timeline.find((e) => e.event === "turn-settled")!;
      const failure = turn.failure!;
      assert.ok(failure && "explanation" in failure);
      assert.equal(failure.code, `turn-${scenario.result.kind}`);
      assert.equal(failure.possibleEffects, scenario.effects);
      assert.equal(failure.explanation, scenario.explanation);
      const result = scenario.result;
      assert.ok(
        result.kind === "failed" ||
          result.kind === "not-started" ||
          result.kind === "lost",
      );
      assert.equal(failure.phase, result.detail.failure?.phase);
      assert.equal(failure.category, result.detail.failure?.category);
      assert.equal(failure.nativeCode, result.detail.failure?.nativeCode);
      if (result.kind === "lost")
        assert.deepEqual(failure.details, { unknown: result.detail.unknown });
      assert.ok(failure.diagnostic);
      const diagnostic = await wired.projectionPort.readResource(
        failure.diagnostic,
      );
      assert.ok(diagnostic.found && diagnostic.type === "diagnostic");
      if (result.detail.failure !== undefined) {
        assert.match(
          diagnostic.content,
          /Message: sign in: native prose does not classify this failure/,
        );
        assert.match(
          diagnostic.content,
          /Partial output:\npartial\n\nRetry evidence:\nretry\n\nHarness diagnostics:\ndiagnostic/,
        );
      }
      if (result.kind === "lost")
        assert.ok(
          diagnostic.content.includes(
            `Last authoritative observation:\n${result.detail.lastObservation}`,
          ),
        );
      assert.doesNotMatch(diagnostic.content, /Publish the spec|usage|cleanup/);
      const attempt = run.timeline.find((e) => e.event === "attempt-settled");
      if (attempt !== undefined)
        assert.deepEqual(attempt.failure, { turnId: turn.turnId });
      const history = wired.projectionPort.openProjection({
        family: "session-history",
        runId: launched.runId,
        session: "planning",
      });
      try {
        assert.ok(history.snapshot.result.found);
        const rows = history.snapshot.result.history.rows;
        assert.deepEqual(
          rows.map((row) => row.value.kind),
          ["entry-prompt", "turn-result"],
        );
        const value = rows.at(-1)!.value;
        assert.ok(value.kind === "turn-result");
        assert.deepEqual(value.failure, failure);
      } finally {
        history.close();
      }
      return failure;
    };
    const before = await check(launched.wired);
    await launched.wired.close();
    const reopened = wireApplication({
      secantHome: launched.home,
      launchCwd: launched.workspace,
      process: storedProcess(),
    });
    t.after(() => reopened.close());
    assert.deepEqual(await check(reopened), before);
  });
}

for (const kind of ["completed", "interrupted"] as const) {
  test(`m11-harness-failure-evidence: ${kind} Turns keep their closing line without failure evidence despite cleanup failure`, async (t) => {
    const result =
      kind === "completed"
        ? ({
            kind,
            detail: {
              effectiveModel: { known: false },
              session: { state: "open" },
            },
          } as const)
        : ({
            kind,
            detail: {
              interruption: { mode: "active-turn", evidence: "confirmed" },
              session: { state: "open" },
            },
          } as const);
    const { wired, runId } = await launch(
      t,
      createFake({
        profile: fakeHarnessProfile(),
        turns: [{ result }],
        cleanup: {
          clean: false,
          detail: "cleanup-only",
          failure: {
            phase: "cleanup",
            category: "cleanup",
            possibleEffects: "possible",
            diagnostics: "cleanup-only",
          },
        },
      })(),
      writeBundle("none"),
    );
    const run: RunView = readRun(wired.projectionPort, runId);
    const turn = run.timeline.find((e) => e.event === "turn-settled")!;
    assert.equal(turn.detail, kind);
    assert.equal(turn.failure, undefined);
    const history = wired.projectionPort.openProjection({
      family: "session-history",
      runId,
      session: "planning",
    });
    t.after(() => history.close());
    assert.ok(history.snapshot.result.found);
    const value = history.snapshot.result.history.rows.at(-1)!.value;
    assert.ok(value.kind === "turn-result");
    assert.equal(value.failure, undefined);
    history.close();
    await wired.close();
  });
}
