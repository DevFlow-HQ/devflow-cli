import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Wiring } from "../../src/composition/main.js";
import type {
  RunFailureView,
  RunView,
} from "../../src/application/projection-port.js";
import {
  DECLARED_COMMAND,
  LONG_STDOUT,
  STDERR_TAIL,
  launchCommandFailure,
  type CommandFailure,
} from "../helpers/commandFailure.js";
import { readRun } from "./run-test-helpers.js";

// m11-command-failure-evidence (#530, ADR 0041): a Command that could not start,
// whose program vanished after Preflight, that timed out, or that a signal killed
// keeps its outcome, retries, and halt, and now says why through the Projection.

const NOT_FOUND = "The Command's program was not found.";
const INSTALL = "Install the program or fix its path, then resume the Run.";
const MAY_HAVE_CHANGED = "It may have changed files before it stopped.";

const CASES: readonly {
  readonly failure: CommandFailure;
  readonly evidence: Omit<RunFailureView, "diagnostic">;
  /** The Detailed diagnostic's exact text, or a pattern for a translated cause. */
  readonly diagnostic?: string | RegExp;
}[] = [
  {
    failure: "spawn-failed",
    evidence: {
      source: "command",
      code: "spawn-failed",
      possibleEffects: "none",
      nativeCode: "EACCES",
      explanation: "The Command's program could not be started.",
      nextStep: "Install or fix the program, then resume the Run.",
    },
    diagnostic: new RegExp(
      "^Kind: spawn-failed\\n\\nCause: Error\\nMessage: spawn scripted-command EACCES\\nCode: EACCES\\n" +
        `[\\s\\S]*\\n\\nCommand: ${escape(DECLARED_COMMAND)}\\n$`,
    ),
  },
  {
    // A spawn-time ENOENT keeps its own code but reads like a missing program.
    failure: "spawn-enoent",
    evidence: {
      source: "command",
      code: "spawn-failed",
      possibleEffects: "none",
      nativeCode: "ENOENT",
      explanation: NOT_FOUND,
      nextStep: INSTALL,
    },
    diagnostic: /^Kind: spawn-failed\n\nCause: Error\n.*ENOENT/,
  },
  {
    failure: "executable-missing",
    evidence: {
      source: "command",
      code: "executable-missing",
      possibleEffects: "none",
      explanation: NOT_FOUND,
      nextStep: INSTALL,
    },
  },
  {
    failure: "timed-out",
    evidence: {
      source: "command",
      code: "timed-out",
      possibleEffects: "unknown",
      details: { timeLimitMs: 600_000 },
      explanation: `The Command ran past its 10-minute time limit and was stopped. ${MAY_HAVE_CHANGED}`,
      nextStep:
        "Resume the Run to try again. Open the details section for its last output.",
    },
    diagnostic:
      "Kind: timed-out\n\n" +
      `Command stdout tail:\n[secant: earlier output omitted]\n${LONG_STDOUT.slice(-30_000)}\n\n` +
      `Command stderr tail:\n${STDERR_TAIL}\n\nCommand: ${DECLARED_COMMAND}\n`,
  },
  {
    failure: "killed",
    evidence: {
      source: "command",
      code: "killed",
      possibleEffects: "unknown",
      nativeCode: "SIGTERM",
      explanation: `A signal stopped the Command before it finished. ${MAY_HAVE_CHANGED}`,
      nextStep: "Resume the Run to run the Command again.",
    },
  },
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `check` Step's settled Attempts, in order. */
function checkAttempts(run: RunView) {
  return run.timeline.filter(
    (event) => event.event === "attempt-settled" && event.step === "check",
  );
}

function assertCommandFailure(
  wired: Wiring,
  run: RunView,
  expected: (typeof CASES)[number],
): void {
  const killed = expected.failure === "killed";
  // Outcomes, retries, and the rest are unchanged: a signal halts after one
  // indeterminate Attempt; every other cause fails, retries once, then rests failed.
  assert.equal(run.state, killed ? "halted" : "failed");
  const attempts = checkAttempts(run);
  assert.deepEqual(
    attempts.map((event) => event.detail),
    killed ? ["indeterminate"] : ["failed", "failed"],
  );
  // A failed Attempt moves no binding, and no Step follows.
  assert.deepEqual(run.outputs, []);
  assert.equal(
    run.timeline.some((event) => event.step === "after"),
    false,
  );
  for (const attempt of attempts) {
    // A Command Attempt carries its own evidence, never a pointer to a Turn.
    const own = attempt.failure;
    assert.ok(own !== undefined && !("turnId" in own), JSON.stringify(own));
    const { diagnostic, ...failure } = own;
    assert.deepEqual(failure, expected.evidence);
    if (expected.diagnostic === undefined) {
      assert.equal(diagnostic, undefined);
      continue;
    }
    assert.ok(diagnostic, "the failure references its Detailed diagnostic");
    const read = wired.projectionPort.readResource(diagnostic);
    assert.ok(read.found, JSON.stringify(read));
    if (typeof expected.diagnostic === "string")
      assert.equal(read.content, expected.diagnostic);
    else assert.match(read.content, expected.diagnostic);
  }
}

for (const expected of CASES) {
  test(`m11-command-failure-evidence: ${expected.failure} keeps its outcome and says why after reopen`, async (t) => {
    const launched = await launchCommandFailure(t, expected.failure);
    assertCommandFailure(
      launched.wired,
      readRun(launched.wired.projectionPort, launched.runId),
      expected,
    );
    assert.deepEqual(launched.spawns, {
      check:
        expected.failure === "executable-missing"
          ? 0
          : expected.failure === "killed"
            ? 1
            : 2,
      after: 0,
    });

    // The evidence is durable: a fresh wiring reads the same rows and words.
    const reopened = await launched.reopen();
    assertCommandFailure(
      reopened,
      readRun(reopened.projectionPort, launched.runId),
      expected,
    );
    const owner = reopened.runGroup.acquireRun(launched.runId);
    assert.ok(owner);
    try {
      const stored = owner.failureEvidence();
      assert.equal(stored.length, expected.failure === "killed" ? 1 : 2);
      for (const row of stored) {
        assert.equal(row.source, "command");
        assert.equal(row.code, expected.evidence.code);
        assert.equal(row.possibleEffects, expected.evidence.possibleEffects);
        assert.equal(row.nativeCode, expected.evidence.nativeCode);
        assert.equal(row.turnId, undefined);
        assert.equal(row.diagnosticId !== undefined, "diagnostic" in expected);
      }
    } finally {
      owner.close();
    }
  });
}

test("m11-command-failure-evidence: a timeout whose stored details are unreadable still reads as a timeout", async (t) => {
  const launched = await launchCommandFailure(t, "timed-out");
  const runs = join(launched.home, "runs");
  const db = new Database(
    join(runs, readdirSync(runs)[0]!, launched.runId, "run.db"),
  );
  try {
    db.exec("UPDATE failure_evidence SET details = '{'");
  } finally {
    db.close();
  }
  const failure = checkAttempts(
    readRun(launched.wired.projectionPort, launched.runId),
  )[0]?.failure;
  assert.ok(failure !== undefined && !("turnId" in failure));
  assert.equal(failure?.code, "timed-out");
  assert.equal(failure?.details, undefined);
  assert.equal(
    failure?.explanation,
    `The Command ran past its time limit and was stopped. ${MAY_HAVE_CHANGED}`,
  );
});
