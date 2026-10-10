import assert from "node:assert/strict";
import test from "node:test";
import type { Application } from "../../src/application/application.js";
import { runHeadless } from "../../src/headless/headless.js";
import {
  FAILED_RUN,
  HALTED_RUN,
  NEWER_DIAGNOSTIC,
  copyPreviousReleaseHome,
  injectNewerEvidence,
  withPreviousReleaseApplication,
} from "../application/previous-release-failure-fixture.js";

// `run show` over an upgraded pre-M11 home (#536, spec #527 decisions 7 and 11):
// predecessor failures with no evidence read as unknown in text and JSON, and
// facts from a newer Secant narrow field by field instead of breaking the read.

const UNKNOWN = "This Step failed for unknown reasons.";
const MAY_HAVE_CHANGED = "It may have changed files before it stopped.";
const NEXT = "Resume the Run to try again, or delete it.";
const UNKNOWN_FAILURE = {
  source: "unknown",
  code: "unknown",
  possibleEffects: "unknown",
  explanation: `${UNKNOWN} ${MAY_HAVE_CHANGED}`,
  nextStep: NEXT,
};

async function show(app: Application, args: readonly string[]) {
  let out = "";
  let err = "";
  const code = await runHeadless(app, ["run", "show", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
    cwd: () => process.cwd(),
  });
  assert.equal(err, "");
  return { code, out };
}

type Event = {
  event: string;
  detail?: string;
  step?: string;
  failure?: unknown;
};
const settled = (run: { timeline: Event[] }) =>
  run.timeline.filter((event) => event.event === "attempt-settled");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("m11-old-and-unknown-evidence: run show reads upgraded predecessor failures as unknown across two reopens", async () => {
  const home = copyPreviousReleaseHome();
  for (let pass = 0; pass < 2; pass++) {
    await withPreviousReleaseApplication(home, async (app) => {
      for (const [runId, state, last] of [
        [HALTED_RUN, "halted", "indeterminate"],
        [FAILED_RUN, "failed", "failed"],
      ] as const) {
        const plain = await show(app, [runId]);
        // Exit codes are unchanged: `show` never exits by rest state.
        assert.equal(plain.code, 0);
        assert.match(
          plain.out,
          new RegExp(
            `\\nState: ${state}\\nStopped because: ${escape(UNKNOWN)}\\nNext: ${escape(NEXT)}\\n`,
          ),
        );
        assert.match(plain.out, /attempt-settled succeeded · step prepare\n/);
        for (const outcome of ["failed", last])
          assert.match(
            plain.out,
            new RegExp(
              `attempt-settled ${outcome} · step build · ${escape(`${UNKNOWN} ${MAY_HAVE_CHANGED}`)}\\n`,
            ),
          );
        // No diagnostic exists for a cause that was never recorded.
        assert.doesNotMatch(plain.out, /Diagnostic/);

        const json = await show(app, [runId, "--json"]);
        assert.equal(json.code, 0);
        const run = JSON.parse(json.out).result.run;
        assert.equal(run.state, state);
        assert.deepEqual(run.restingCause, {
          code: "unknown",
          explanation: UNKNOWN,
          nextStep: NEXT,
        });
        assert.deepEqual(
          settled(run).map(({ detail, step, failure }) => ({
            detail,
            step,
            failure,
          })),
          [
            { detail: "succeeded", step: "prepare", failure: undefined },
            { detail: "failed", step: "build", failure: UNKNOWN_FAILURE },
            { detail: last, step: "build", failure: UNKNOWN_FAILURE },
          ],
        );
      }
    });
  }
});

test("m11-old-and-unknown-evidence: run show narrows newer sources, codes, effects and malformed details field by field", async () => {
  const home = copyPreviousReleaseHome();
  await withPreviousReleaseApplication(home, async () => {});
  injectNewerEvidence(home);
  await withPreviousReleaseApplication(home, async (app) => {
    const halted = JSON.parse((await show(app, [HALTED_RUN, "--json"])).out)
      .result.run;
    // An unknown Resting-cause code keeps the unknown wording and its diagnostic.
    assert.deepEqual(halted.restingCause, {
      code: "unknown",
      explanation: UNKNOWN,
      nextStep: NEXT,
      diagnostic: {
        runId: HALTED_RUN,
        diagnosticId: "newer-diagnostic",
        type: "diagnostic",
      },
    });
    assert.deepEqual(
      settled(halted).map((event) => event.failure),
      [
        undefined,
        // An unknown source is unknown; its valid effects value still stands.
        { ...UNKNOWN_FAILURE, possibleEffects: "none", explanation: UNKNOWN },
        // An unknown code under a known source.
        UNKNOWN_FAILURE,
      ],
    );
    const failed = JSON.parse((await show(app, [FAILED_RUN, "--json"])).out)
      .result.run;
    assert.deepEqual(
      settled(failed).map((event) => event.failure),
      [
        undefined,
        // Details missing the required size limit make the cause unknown.
        UNKNOWN_FAILURE,
        // An unknown effects value narrows alone: the valid cause is kept and
        // the possible-effects warning is added.
        {
          source: "receipt",
          code: "receipt-too-large",
          possibleEffects: "unknown",
          details: { outputName: "build-log", sizeLimit: 1024 },
          explanation: `The required output "build-log" exceeds the 1024-byte limit. ${MAY_HAVE_CHANGED}`,
          nextStep: "Resume the Run to try the Step again.",
        },
      ],
    );

    const plain = await show(app, [HALTED_RUN]);
    assert.equal(plain.code, 0);
    assert.match(
      plain.out,
      new RegExp(`\\nState: halted\\nStopped because: ${escape(UNKNOWN)}\\n`),
    );
    assert.match(
      plain.out,
      new RegExp(`attempt-settled failed · step build · ${escape(UNKNOWN)}\\n`),
    );
    assert.ok(plain.out.endsWith(`\nDiagnostic:\n${NEWER_DIAGNOSTIC}`));
    assert.doesNotMatch(plain.out, /newer-source|receipt-newer/);
    const failedPlain = await show(app, [FAILED_RUN]);
    assert.match(
      failedPlain.out,
      /attempt-settled failed · step build · The required output "build-log" exceeds the 1024-byte limit\. It may have changed files before it stopped\.\n/,
    );
  });
});
