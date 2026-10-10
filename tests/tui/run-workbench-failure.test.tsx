import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DELETE_OFFER,
  EXECUTION_FAULT_CAUSE,
  RESUME_OFFER,
  mountWorkbench,
  noOverflow,
  okActions,
  press,
  previewPreferences,
  resizeWorkbench,
  runOf,
  type,
} from "./run-workbench-fixture.js";

// The resting view and the details Failure section (#528, ADR 0041): a `halted`
// or `failed` Run's bottom region says why it rests and what to do next in
// place of the compose, keeps the details, resume, and delete routes, and
// captures no typed text. A transient Problem shows in plain words; its code is
// kept for details.

const faulted = (over: Parameters<typeof runOf>[0] = {}) =>
  runOf({
    state: "halted",
    restingCause: EXECUTION_FAULT_CAUSE,
    actionOffers: [RESUME_OFFER, DELETE_OFFER],
    ...over,
  });

/** Mount the faulted Run with its diagnostic still on disk: the read is in
 *  place before the Run that references it arrives. */
async function mountWithDiagnostic(
  actions?: Parameters<typeof mountWorkbench>[3],
) {
  const mounted = await mountWorkbench(runOf(), 100, 40, actions);
  mounted.control.setRead("d:diag-1", {
    found: true,
    type: "diagnostic",
    content: "Kind: execution-fault\n\nCause: Error\nMessage: drive fault",
  });
  mounted.control.setRun(faulted());
  await mounted.t.waitForFrame((frame) => frame.includes("⏸ Run halted"));
  return mounted;
}

function recordingActions() {
  const dispatched: string[] = [];
  const record = (action: string) => () => {
    dispatched.push(action);
    return () => ({ kind: "ok" }) as const;
  };
  return {
    dispatched,
    actions: okActions({ resume: record("resume"), remove: record("delete") }),
  };
}

test("m11-workbench-failure-presentation: a halted Run's resting view replaces the compose with why it rests and what to do next", async () => {
  const { t } = await mountWorkbench(faulted(), 100, 30);
  const frame = t.captureCharFrame();
  assert.match(
    frame,
    /⏸ Run halted — Secant hit an internal error\. It may have changed files/,
  );
  assert.match(
    frame,
    /Next: Resume the Run to try again\. If it happens again, open the details/,
  );
  assert.match(frame, /^\s*Run run-1\s*$/m);
  assert.match(frame, /ctrl\+g details to resume or delete · esc back/);
  // No compose: no prompt, no placeholder note, and no code on the everyday screen.
  assert.doesNotMatch(frame, /^\s*>/m);
  assert.doesNotMatch(frame, /The Run is halted|execution-fault/);
  noOverflow(frame, 100);
});

test("m11-workbench-failure-presentation: a failed Run reads its cause and next step beside the state word", async () => {
  const { t } = await mountWorkbench(
    runOf({ state: "failed", actionOffers: [RESUME_OFFER, DELETE_OFFER] }),
    100,
    30,
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /✗ Run failed — This Step failed for unknown reasons\./);
  assert.match(frame, /Next: Resume the Run to try again, or delete it\./);
  assert.doesNotMatch(frame, /This Run has ended/);
});

test("m11-workbench-failure-presentation: the resting view captures no typed text, and its details keep resume and delete", async () => {
  const { dispatched, actions } = recordingActions();
  const { t, renderer, exits } = await mountWithDiagnostic(actions);
  const before = t.captureCharFrame();
  await type(t, "typed into nothing");
  await press(t, renderer, "return");
  assert.equal(t.captureCharFrame(), before);
  assert.deepEqual(dispatched, []);

  // Details hold the Failure section and the lifecycle actions.
  await press(t, renderer, "g", { ctrl: true });
  const panel = t.captureCharFrame();
  assert.match(panel, /Resting reason · Secant hit an internal error\./);
  assert.match(panel, /Failure: *\n *Resting cause · execution-fault/);
  assert.match(panel, /Possible effects · May have changed files/);
  assert.match(
    panel,
    /Diagnostic · open the failure diagnostic under Resources/,
  );
  assert.match(panel, /failure diagnostic: execution-fault/);
  assert.match(panel, /r resume — /);
  assert.match(panel, /x delete — /);
  noOverflow(panel, 100);

  await press(t, renderer, "x");
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "escape");
  await press(t, renderer, "r");
  assert.deepEqual(dispatched, ["resume"]);

  assert.deepEqual(exits, []);
});

test("m11-workbench-failure-presentation: the failure diagnostic opens from details through its reference", async () => {
  const { t, renderer } = await mountWithDiagnostic();
  await press(t, renderer, "g", { ctrl: true });
  // The fixture's Run lists its transcript first; select the diagnostic.
  while (!/› failure diagnostic/.test(t.captureCharFrame())) {
    await press(t, renderer, "down");
  }
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /Message: drive fault/);
});

test("m11-workbench-failure-presentation: a pruned diagnostic reads Expired after 90 days and is no longer offered", async () => {
  const { t, renderer } = await mountWorkbench(faulted(), 100, 40);
  await press(t, renderer, "g", { ctrl: true });
  const panel = t.captureCharFrame();
  assert.match(panel, /Diagnostic · Expired after 90 days/);
  assert.doesNotMatch(panel, /failure diagnostic/);
});

test("m11-workbench-failure-presentation: a Problem reads in plain words and keeps its code for details", async () => {
  const { t, renderer } = await mountWorkbench(
    faulted({
      problem: {
        code: "run-execution-fault",
        explanation: "Run run-1 could not be driven to rest: drive fault",
        remediation: "Check the Run store and retry.",
        possibleEffects: "unknown",
      },
    }),
    100,
    30,
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /✗ Run run-1 could not be driven to rest: drive fault/);
  assert.match(frame, /Check the Run store and retry\./);
  assert.doesNotMatch(frame, /run-execution-fault/);
  await press(t, renderer, "g", { ctrl: true });
  assert.match(t.captureCharFrame(), /Problem · run-execution-fault/);
});

test("m11-workbench-failure-presentation: long resting text wraps in full at narrow and wide widths", async () => {
  const long = "a long explanation word ".repeat(12).trim();
  const run = faulted({
    restingCause: {
      ...EXECUTION_FAULT_CAUSE,
      explanation: `${long}. END_OF_EXPLANATION`,
      nextStep: `${long}. END_OF_NEXT_STEP`,
    },
  });
  const { t, renderer } = await mountWorkbench(run, 140, 40);
  for (const [width, height] of [
    [140, 40],
    [100, 30],
    [40, 30],
  ] as const) {
    resizeWorkbench(t, renderer, width, height);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    noOverflow(frame, width);
    assert.match(frame, /END_OF_EXPLANATION/, `${width}x${height}`);
    assert.match(frame, /END_OF_NEXT_STEP/, `${width}x${height}`);
    assert.match(frame, /ctrl\+g details/, `${width}x${height}`);
    // Every word of both sentences is drawn: nothing is cut with an ellipsis.
    assert.doesNotMatch(frame, /…/, `${width}x${height}`);
  }
});

test("m11-workbench-failure-presentation: at small heights the resting view keeps every row and the history yields", async () => {
  const { t, renderer } = await mountWorkbench(faulted(), 100, 10);
  for (const [width, height] of [
    [100, 10],
    [40, 15],
  ] as const) {
    resizeWorkbench(t, renderer, width, height);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    noOverflow(frame, width);
    const flat = frame.replace(/\s+/g, " ");
    assert.match(flat, /⏸ Run halted — Secant hit an internal error\./);
    assert.match(flat, /before it stopped\. Next: Resume the Run/);
    assert.match(flat, /open the details section for the cause\./);
    assert.match(flat, /Run run-1/);
    assert.match(flat, /esc back · ctrl\+c quit/, `${width}x${height}`);
  }
});

for (const appearance of ["dark", "light"] as const) {
  test(`m11-workbench-failure-presentation: ${appearance} resting view keeps its theme roles`, async () => {
    const preferences = previewPreferences();
    const { t } = await mountWorkbench(
      faulted(),
      100,
      30,
      undefined,
      false,
      0,
      {
        ...preferences,
        snapshot: () => ({
          ...preferences.snapshot(),
          preferences: { theme: "everforest", appearance },
        }),
      },
    );
    // Warning for the halted state word, muted for its keys.
    assert.equal(
      colourOf(t, /⏸ Run halted/),
      appearance === "dark" ? "230,152,117" : "245,125,38",
    );
    assert.equal(
      colourOf(t, /ctrl\+g details to resume/),
      appearance === "dark" ? "122,132,120" : "166,176,160",
    );
  });
}

type TRendered = Awaited<ReturnType<typeof mountWorkbench>>["t"];

/** The colour of the first span in the frame whose own text matches `text`. */
function colourOf(t: TRendered, text: RegExp): string {
  const span = t
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((candidate) => text.test(candidate.text));
  assert.ok(span, `no span matching ${String(text)}`);
  return [span.fg.r, span.fg.g, span.fg.b]
    .map((value) => Math.round(value * 255))
    .join(",");
}
