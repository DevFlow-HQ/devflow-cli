import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DELETE_OFFER,
  EXECUTION_FAULT_CAUSE,
  RESUME_OFFER,
  mountWorkbench,
  interactiveRunOf,
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

type Failure = NonNullable<
  ReturnType<typeof runOf>["timeline"][number]["failure"]
>;

const RECEIPT_FAILURE: Failure = {
  source: "receipt",
  code: "receipt-missing",
  possibleEffects: "unknown",
  explanation:
    'The required output "spec-ref" was not written. It may have changed files before it stopped.',
  nextStep: "Resume the Run to try the Step again.",
  details: { outputName: "spec-ref" },
};
function receiptFailed(failure = RECEIPT_FAILURE) {
  return runOf({
    state: "failed",
    timeline: [
      { at: "T001", event: "run-created" },
      {
        at: "T002",
        event: "attempt-settled",
        detail: "failed",
        step: "publish",
        failure,
      },
    ],
  });
}

for (const appearance of ["dark", "light"] as const) {
  test(`m11-workbench-failure-presentation: ${appearance} receipt row uses an error border and muted complete wording`, async () => {
    const preferences = previewPreferences();
    const { t, renderer } = await mountWorkbench(
      receiptFailed(),
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
    await t.renderOnce();
    const frame = t.captureCharFrame();
    const flat = frame.replace(/\s+/g, " ");
    assert.match(flat, /✗ Step Attempt failed/);
    assert.match(flat, /The required output "spec-ref" was not written\./);
    assert.match(flat, /It may have changed files before it stopped\./);
    assert.match(flat, /Next: Resume the Run to try the Step again\./);
    assert.doesNotMatch(frame, /▸ Step Attempt failed|receipt-missing/);
    assert.equal(
      colourOf(t, /┃/),
      appearance === "dark" ? "230,126,128" : "248,85,82",
    );
    assert.equal(
      colourOf(t, /The required output/),
      appearance === "dark" ? "122,132,120" : "166,176,160",
    );
    noOverflow(frame, 100);
    await press(t, renderer, "g", { ctrl: true });
    assert.match(t.captureCharFrame(), /Source · receipt/);
    assert.match(t.captureCharFrame(), /Code · receipt-missing/);
    assert.match(
      t.captureCharFrame(),
      /Possible effects · May have changed files/,
    );
  });
}

test("m11-workbench-failure-presentation: receipt rows wrap completely and retain their merged order at narrow widths and small heights", async () => {
  const long = {
    ...RECEIPT_FAILURE,
    explanation:
      'The required output "' +
      "a long name ".repeat(12) +
      '" was not written. END_OF_FAILURE',
    nextStep: "Resume the Run " + "to try again ".repeat(12) + "END_OF_NEXT",
  };
  const { t, renderer } = await mountWorkbench(receiptFailed(long), 140, 50);
  for (const [width, height] of [
    [140, 50],
    [100, 40],
    [40, 40],
    [40, 12],
  ] as const) {
    resizeWorkbench(t, renderer, width, height);
    await t.renderOnce();
    noOverflow(t.captureCharFrame(), width);
    const collected: string[] = [t.captureCharFrame()];
    // Scroll through a failure longer than the viewport, retaining every line.
    for (let i = 0; i < 25; i++) {
      await press(t, renderer, "pageup");
      collected.push(t.captureCharFrame());
    }
    const all = collected.join("\n");
    assert.ok(
      all.includes("END_OF_FAILURE"),
      `${width}x${height} shows the complete explanation`,
    );
    assert.ok(
      all.includes("END_OF_NEXT"),
      `${width}x${height} shows the complete next step`,
    );
    assert.doesNotMatch(all, /…/);
    await press(t, renderer, "end", { alt: true });
  }
});

test("m11-workbench-failure-presentation: the latest failed Attempt supplies all technical evidence fields", async () => {
  const failure = {
    ...RECEIPT_FAILURE,
    phase: "output-check",
    category: "required-output",
    nativeCode: "EOUTPUT",
    possibleEffects: "partial" as const,
  };
  const { t, renderer } = await mountWorkbench(receiptFailed(failure), 100, 40);
  await press(t, renderer, "g", { ctrl: true });
  const panel = t.captureCharFrame();
  assert.match(panel, /Phase · output-check/);
  assert.match(panel, /Category · required-output/);
  assert.match(panel, /Native code · EOUTPUT/);
  assert.match(panel, /Changed files before it stopped/);
});

test("m11-workbench-failure-presentation: unknown evidence has a readable failure row between its neighboring Workflow facts", async () => {
  const failure: Failure = {
    source: "unknown",
    code: "unknown",
    possibleEffects: "unknown",
    explanation:
      "This Step failed for unknown reasons. It may have changed files before it stopped.",
    nextStep: "Resume the Run to try again, or delete it.",
  };
  const run = runOf({
    timeline: [
      {
        at: "T001",
        event: "attempt-settled",
        detail: "succeeded",
        step: "before",
      },
      {
        at: "T002",
        event: "attempt-settled",
        detail: "failed",
        step: "middle",
        failure,
      },
      {
        at: "T003",
        event: "attempt-settled",
        detail: "succeeded",
        step: "after",
      },
    ],
  });
  const { t } = await mountWorkbench(run, 100, 30);
  const frame = t.captureCharFrame();
  assert.match(frame, /This Step failed for unknown reasons\./);
  assert.ok(
    frame.indexOf("Step · before") < frame.indexOf("✗ Step Attempt failed"),
  );
  assert.ok(
    frame.indexOf("✗ Step Attempt failed") < frame.indexOf("Step · after"),
  );
  assert.doesNotMatch(frame, /▸ Step Attempt failed/);
});

test("m11-workbench-failure-presentation: an Attempt diagnostic is read through its reference and reports expiry", async () => {
  const failure = {
    ...RECEIPT_FAILURE,
    diagnostic: {
      runId: "run-1",
      diagnosticId: "receipt-diag",
      type: "diagnostic" as const,
    },
  };
  const { t, renderer, control } = await mountWorkbench(runOf(), 100, 40);
  control.setRead("d:receipt-diag", {
    found: true,
    type: "diagnostic",
    content: "Kind: receipt\nCause: recorded test evidence",
  });
  control.setRun(receiptFailed(failure));
  await t.waitForFrame((frame) => frame.includes("✗ Step Attempt failed"));
  await press(t, renderer, "g", { ctrl: true });
  assert.match(t.captureCharFrame(), /failure diagnostic: receipt-missing/);
  while (!/› failure diagnostic/.test(t.captureCharFrame()))
    await press(t, renderer, "down");
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /Cause: recorded test evidence/);

  const expired = await mountWorkbench(receiptFailed(failure), 100, 40);
  await press(expired.t, expired.renderer, "g", { ctrl: true });
  assert.match(
    expired.t.captureCharFrame(),
    /Diagnostic · Expired after 90 days/,
  );
});

const ENTRY_FAILURE: Failure = {
  source: "agent",
  code: "prompt-refused",
  category: "harness-input-reserved",
  phase: "turn",
  possibleEffects: "none",
  explanation:
    "Secant did not send the prompt because it starts with a word the Harness reserves.",
  nextStep: "Fix the Bundle prompt or choose another Harness.",
  diagnostic: {
    runId: "run-1",
    diagnosticId: "entry-diag",
    type: "diagnostic",
  },
};

function entryBlocked() {
  return interactiveRunOf({
    timeline: [
      {
        at: "T001",
        event: "attempt-settled",
        detail: "succeeded",
        step: "before",
      },
      {
        at: "T002",
        event: "attempt-failure",
        step: "discuss",
        failure: ENTRY_FAILURE,
      },
    ],
  });
}

for (const appearance of ["dark", "light"] as const) {
  test(`m11-pre-turn-agent-evidence: ${appearance} Entry failure keeps Workflow order, error styling, and prompt focus`, async () => {
    const preferences = previewPreferences();
    const { t, renderer } = await mountWorkbench(
      entryBlocked(),
      100,
      35,
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
    const frame = t.captureCharFrame();
    const flat = frame.replace(/\s+/g, " ");
    assert.match(flat, /✗ Step Attempt failed/);
    assert.match(
      flat,
      /Secant did not send the prompt because it starts with a word the Harness reserves\./,
    );
    assert.match(
      flat,
      /Next: Fix the Bundle prompt or choose another Harness\./,
    );
    assert.ok(frame.indexOf("Step · before") < frame.indexOf("Step · discuss"));
    assert.equal(
      colourOf(t, /┃/),
      appearance === "dark" ? "230,126,128" : "248,85,82",
    );
    assert.equal(
      colourOf(t, /Secant did not send/),
      appearance === "dark" ? "122,132,120" : "166,176,160",
    );
    await type(t, "continue here");
    assert.match(t.captureCharFrame(), /continue here/);
    await press(t, renderer, "g", { ctrl: true });
    assert.match(t.captureCharFrame(), /Code · prompt-refused/);
    assert.match(t.captureCharFrame(), /Possible effects · No changes made/);
    assert.match(t.captureCharFrame(), /Diagnostic · Expired after 90 days/);
    noOverflow(t.captureCharFrame(), 100);
  });
}

test("m11-pre-turn-agent-evidence: blocked Entry reason wraps at narrow widths and opens its diagnostic", async () => {
  const { t, renderer, control } = await mountWorkbench(runOf(), 100, 40);
  control.setRead("d:entry-diag", {
    found: true,
    type: "diagnostic",
    content:
      'Kind: prompt-refused\n\nHarness diagnostics:\nThe prompt starts with "/model".',
  });
  control.setRun(entryBlocked());
  await t.waitForFrame((frame) => frame.includes("✗ Step Attempt failed"));
  for (const [width, height] of [
    [100, 40],
    [40, 35],
    [40, 12],
  ] as const) {
    resizeWorkbench(t, renderer, width, height);
    await t.renderOnce();
    noOverflow(t.captureCharFrame(), width);
  }
  resizeWorkbench(t, renderer, 100, 40);
  await press(t, renderer, "g", { ctrl: true });
  while (!/› failure diagnostic/.test(t.captureCharFrame()))
    await press(t, renderer, "down");
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /The prompt starts with "\/model"/);
});
