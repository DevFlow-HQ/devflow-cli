import { readRun } from "../application/run-test-helpers.js";
import assert from "node:assert/strict";
import {
  launchAgentCompletionRun,
  completed,
  call,
  reviewedLoop,
  across,
} from "../helpers/agentCompletion.js";
import { awaitSettled, followRun } from "../helpers/settleOperation.js";
import { realpathSync } from "node:fs";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { createApplication } from "../helpers/application.js";
import {
  hostPlatform,
  repeatCommandGateRouting,
  writeRoutingBundle,
} from "../helpers/commandBundle.js";
import { countingBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";
import { test } from "node:test";
import { createSignal } from "solid-js";
import { createLiveRunWorkbenchView } from "../../src/tui/tui.js";
import type { RunActionOutcome } from "../../src/tui/tui.js";
import { makeFakeRenderer } from "./renderer-fixture.js";
import type {
  RunLiveOverlay,
  ResumeRunOffer,
} from "../../src/application/projection-port.js";
import {
  resizeWorkbench,
  makeRunView,
  snapshotOf,
  runOf,
  events,
  timelineLines,
  conversationText,
  onWorkbench,
  workbenchShown,
  GATE,
  ANSWER_OFFER,
  checkpointOf,
  blockedRunOf,
  mountApp,
  mountWorkbench,
  press,
  type,
  noOverflow,
  PROGRESS,
  RESUME_OFFER,
  CANCEL_OFFER,
  DELETE_OFFER,
  RESUME_ACK_OFFER,
  okActions,
  SEND_OFFER,
  END_OFFER,
  interactiveRunOf,
  requestOverlay,
  INTERRUPT_OFFER,
  liveTurnRunOf,
  CONTINUE_OFFER,
  END_STAGE_OFFER,
  liveInteractiveRunOf,
  FREE_TEXT_GATE,
  FREE_TEXT_OFFER,
  freeTextRunOf,
  suggestedRunOf,
  AVAILABLE_STEER_OFFER,
  steerableInteractiveRunOf,
  MODEL_OFFER,
  mountModelChoice,
  openModelChoice,
  mountInspectable,
  INSPECTIONS,
  previewPreferences,
  openAppThemes,
  rowOf,
} from "./run-workbench-fixture.js";

// --- rendering (AC1) -------------------------------------------------------

test("m10-workbench-interaction: the headerless conversation, sidebar, and meta row render the facts headless run show prints", async () => {
  const facts = runOf({
    runId: "run-77",
    state: "running",
    progress: PROGRESS,
    position: 1,
    timeline: [
      { at: "2026-01-01T00:00:00.000Z", event: "run-created" },
      {
        at: "2026-01-01T00:01:00.000Z",
        event: "attempt-settled",
        detail: "passed",
      },
    ],
  });
  // Above 120 columns the sidebar names the Bundle, the state in words, and every
  // Step by glyph; there is no header (ADR 0036).
  const wide = await mountWorkbench(facts, 140, 30);
  const frame = wide.t.captureCharFrame();
  assert.match(frame, /Alpha Flow/); // Bundle name
  assert.doesNotMatch(frame, /run-77/); // an active Run's id lives in the panel
  assert.match(frame, /Running/); // state in words
  assert.match(frame, /✓ plan/); // every Step, always visible beside the conversation
  assert.match(frame, /▸ … build/);
  assert.match(frame, /· ship/);
  assert.match(frame, /○ Run created/); // timeline events in plain words
  assert.match(frame, /▸ Step Attempt passed/);
  assert.equal(timelineLines(frame)[0]!.trim().startsWith("Beginning"), true);

  // At 120 columns or less the current Step moves into the prompt's meta row.
  const narrow = await mountWorkbench(facts, 100, 30);
  const compact = narrow.t.captureCharFrame();
  assert.match(compact, /Step build/);
  assert.doesNotMatch(compact, /Alpha Flow|ship/);
  assert.match(compact, /○ Run created/);
  assert.match(compact, /The Workflow is running/);
});

test("reopened history renders End Step distinctly from a settled Command Attempt (#134 A19)", async () => {
  const { t } = await mountWorkbench(
    runOf({
      timeline: [
        {
          at: "2026-09-18T00:00:00.000Z",
          event: "interactive-step-ended",
          detail: "succeeded",
        },
        {
          at: "2026-09-18T00:01:00.000Z",
          event: "repeat-continued",
          detail: "succeeded",
        },
        {
          at: "2026-09-18T00:02:00.000Z",
          event: "stage-ended",
          detail: "succeeded",
        },
      ],
    }),
  );
  // A confirmed End Stage reads as its own row, apart from Continue (#218), each in
  // plain words rather than its raw kind (#289).
  const frame = t.captureCharFrame();
  assert.match(frame, /▸ Stage ended/);
  assert.match(frame, /▸ Step ended/);
  // A human-controlled Repeat's Continue reads as its own history row (#217).
  assert.match(frame, /↻ Continued to the next Iteration/);
  assert.doesNotMatch(
    frame,
    /stage-ended|interactive-step-ended|repeat-continued|succeeded/,
  );
});

test("a blocked Run shows a waiting-for-review note and the checkpoint facts", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: PROGRESS,
      position: 1,
      checkpoint: {
        message: "Review the batch",
        interval: 3,
        completedIterations: 6,
        latestVerdict: {
          name: "done",
          value: "fail",
          reference: {
            runId: "run-1",
            artifactName: "done",
            versionId: "v3",
            type: "verdict",
          },
        },
        gate: {
          runId: "run-1",
          stepId: "work",
          attemptId: "a9",
          shape: "approve-reject",
        },
      },
    }),
  );
  // Without a current answer Offer the checkpoint control waits, but the prompt
  // still says what the Run waits on, in words (ADR 0036).
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Continue 3 More Iterations/);
  assert.match(frame, /waiting for review/);
  assert.match(frame, /Review the batch/);
  await press(t, renderer, "g", { ctrl: true });
  assert.match(t.captureCharFrame(), /checkpoint verdict: done = fail/);
});

// --- live updates + timeline mechanics (AC2, AC3) --------------------------

test("launching transitions to the Workbench before the Run rests, and progress rows appear while a Step runs", async () => {
  // Launch resolves at admission (S1): the App walks Start a Run → launch and lands
  // on the Workbench with the Run still running and no activity yet — before it
  // rests. The read seam is a deferred fake: a durable update then appends timeline
  // rows while a Step runs, and they appear live without leaving the Workbench.
  const control = makeRunView(
    snapshotOf(
      runOf({
        state: "running",
        progress: PROGRESS,
        position: 1,
        timeline: [],
      }),
    ),
  );
  const renderer = makeFakeRenderer(100, 20);
  const { t } = await mountApp(control, renderer, "run-1", 100, 20);
  await t.waitForFrame(workbenchShown);
  assert.match(t.captureCharFrame(), /The Workflow is running/); // reached the Workbench, still live
  assert.match(t.captureCharFrame(), /no activity yet/); // the Run has not rested
  // A Step runs: durable progress lands and follows the live edge into view.
  control.setRun(
    runOf({
      state: "running",
      progress: PROGRESS,
      position: 1,
      timeline: events(3),
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, / e2/); // the newest row appeared while running
  assert.doesNotMatch(frame, /not Run state/);
});

// --- focus + Escape (AC5) --------------------------------------------------

test("focus moves prompt → details → prompt, and Escape leaves the Workbench for Home", async () => {
  const { t, renderer } = await mountWorkbench(runOf({ timeline: events(4) }));
  assert.doesNotMatch(t.captureCharFrame(), /Details/);
  await press(t, renderer, "g", { ctrl: true }); // open + focus details
  assert.match(t.captureCharFrame(), /› Details/);
  await press(t, renderer, "tab"); // back to the prompt; the panel stays shown
  assert.doesNotMatch(t.captureCharFrame(), /› Details/);
  assert.match(t.captureCharFrame(), /Details · ctrl\+g focus/);
  await press(t, renderer, "escape"); // leaves the Workbench
  assert.match(t.captureCharFrame(), /Start a Run/); // back on Home
  assert.doesNotMatch(t.captureCharFrame(), /Details/);
});

test("m10-workbench-interaction: q types into the prompt; Ctrl+C clears a draft, then requests guarded Quit", async () => {
  const first = await mountWorkbench(runOf());
  // No bare letter is a Workbench command beside the always-editable prompt.
  await press(first.t, first.renderer, "q");
  await type(first.t, "q");
  assert.equal(first.exits.length, 0);
  assert.match(first.t.captureCharFrame(), /^ > q/m);
  // The first Ctrl+C clears the draft and keeps the Workbench; the next quits.
  await press(first.t, first.renderer, "c", { ctrl: true });
  assert.equal(first.exits.length, 0);
  assert.doesNotMatch(first.t.captureCharFrame(), /^ > q/m);
  await press(first.t, first.renderer, "c", { ctrl: true });
  assert.equal(first.exits.length, 1);

  const second = await mountWorkbench(runOf());
  await press(second.t, second.renderer, "c", { ctrl: true });
  assert.equal(second.exits.length, 1);
});

// --- Review checkpoint interaction (#92) -----------------------------------

test("a blocked Run shows the checkpoint interaction in place of the footer, with the facts and evidence", async () => {
  const { t } = await mountWorkbench(
    blockedRunOf({
      checkpoint: checkpointOf({
        message: "Ship it?",
        interval: 3,
        completedIterations: 6,
      }),
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-1",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
    }),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /every 3 iteration\(s\)/); // cadence
  assert.match(frame, /6 completed/); // completed-iteration count
  assert.match(frame, /Ship it\?/); // the authored message
  assert.match(frame, /latest: done = fail/); // the latest fail Verdict
  assert.match(frame, /Continue 3 More Iterations/); // control names the count
  assert.match(frame, /Stop Run/);
  assert.match(frame, /report/); // evidence: the output link
  assert.match(frame, /enter confirm/); // the interaction's own hints
  assert.doesNotMatch(frame, /d details · end latest/); // footer was replaced
});

test("a non-blocked Run shows no checkpoint control and keeps its prompt", async () => {
  const { t } = await mountWorkbench(runOf({ timeline: events(3) }));
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.doesNotMatch(frame, /More Iterations/);
  assert.match(frame, /\^G details · \^P commands/); // the prompt holds the bottom region
});

test("a checkpoint without a live answer offer shows no controls", async () => {
  const { t } = await mountWorkbench(
    runOf({ state: "blocked", checkpoint: checkpointOf(), actionOffers: [] }),
  );
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /More Iterations/); // no control lacks an offer
  assert.match(frame, /waiting for review/); // the blocked note still shows
});

test("Continue dispatches answer-human-gate continue against the snapshot's gate, with the granted count in the label", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  // Focus lands on the interaction with Continue selected by default.
  assert.match(t.captureCharFrame(), /› \[ Continue 3 More Iterations \]/);
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  assert.equal(control.answers[0]?.answer, "continue");
  assert.deepEqual(control.answers[0]?.gate, GATE);
});

test("Stop dispatches answer-human-gate stop against the snapshot's gate", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  await press(t, renderer, "right"); // select Stop
  assert.match(t.captureCharFrame(), /› \[ Stop Run \]/);
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  assert.equal(control.answers[0]?.answer, "stop");
  assert.deepEqual(control.answers[0]?.gate, GATE);
});

test("the controls are unavailable while the answer is pending and gone once it applies", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  control.setAnswerOutcome({ kind: "pending" });
  await press(t, renderer, "return"); // dispatch continue
  await t.renderOnce();
  assert.equal(control.answers.length, 1);
  assert.match(t.captureCharFrame(), /submitting your answer/);
  assert.match(t.captureCharFrame(), /unavailable/);
  // A second confirm while pending dispatches nothing.
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  // Applied: the live snapshot leaves blocked and the interaction disappears.
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "running", timeline: events(2), actionOffers: [] }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.match(frame, /\^G details · \^P commands/); // the prompt returned
});

test("a refused answer surfaces its Problem and re-enables the controls", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  control.setAnswerOutcome({
    kind: "refused",
    problem: {
      code: "gate-stale",
      explanation: "The Gate moved on.",
      remediation: "Re-open the Run.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /refused: The Gate moved on/);
  assert.doesNotMatch(frame, /unavailable/); // controls available again
});

test("a Run that blocks again after a granted interval shows the interaction with the advanced count", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ checkpoint: checkpointOf({ completedIterations: 3 }) }),
  );
  assert.match(t.captureCharFrame(), /3 completed/);
  await press(t, renderer, "return"); // continue
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "running", timeline: events(4), actionOffers: [] }),
  );
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Review checkpoint/);
  // It blocks again after the granted interval, with an advanced count.
  control.setRun(
    blockedRunOf({ checkpoint: checkpointOf({ completedIterations: 6 }) }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /6 completed/);
});

test("a re-block at a fresh Gate resets the control to Continue and clears a prior refusal", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  // Select Stop and dispatch; the answer is refused (the Gate moved on).
  control.setAnswerOutcome({
    kind: "refused",
    problem: {
      code: "gate-stale",
      explanation: "The Gate moved on.",
      remediation: "Re-open the Run.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "right"); // select Stop
  await press(t, renderer, "return");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /refused: The Gate moved on/);
  assert.match(t.captureCharFrame(), /› \[ Stop Run \]/); // Stop still selected

  // The Run runs on, then re-blocks at a *fresh* Gate (a different Attempt).
  control.setRun(
    runOf({ state: "running", timeline: events(2), actionOffers: [] }),
  );
  await t.renderOnce();
  control.setRun(
    blockedRunOf({
      checkpoint: checkpointOf({
        gate: { ...GATE, attemptId: "a10" },
        completedIterations: 6,
      }),
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /6 completed/); // the advanced count
  assert.doesNotMatch(frame, /refused/); // the stale refusal is gone
  assert.match(frame, /› \[ Continue 3 More Iterations \]/); // reset to Continue
});

test("Stop leaves the Run failed with its timeline and Artifacts still browsable", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ timeline: events(3) }),
  );
  await press(t, renderer, "right"); // Stop
  await press(t, renderer, "return");
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({
      state: "failed",
      timeline: events(3),
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-1",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
      actionOffers: [],
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /✗ Run failed/);
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.match(frame, / e0/); // the timeline is intact
  await press(t, renderer, "g", { ctrl: true }); // Artifacts still browsable
  assert.match(t.captureCharFrame(), /report \(text\)/);
});

test("focus lands on the checkpoint when it appears, moves to details and back, and the outcome replaces it when it leaves", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ timeline: events(4) }),
  );
  assert.match(t.captureCharFrame(), /› Review checkpoint/); // focus on the interaction
  await press(t, renderer, "g", { ctrl: true }); // to details
  assert.match(t.captureCharFrame(), /› Details/);
  assert.doesNotMatch(t.captureCharFrame(), /› Review checkpoint/);
  await press(t, renderer, "tab"); // back to the checkpoint
  assert.match(t.captureCharFrame(), /› Review checkpoint/);
  // When it leaves, the finished outcome holds the bottom region.
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "failed", timeline: events(4), actionOffers: [] }),
  );
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Review checkpoint/);
  assert.match(t.captureCharFrame(), /✗ Run failed/);
});

test("the checkpoint interaction fits small widths without overflow and states both consequences without colour", async () => {
  const { t, renderer } = await mountWorkbench(blockedRunOf(), 100, 30);
  let frame = t.captureCharFrame();
  noOverflow(frame, 100);
  assert.match(frame, /grant one more review interval/); // continue consequence, plain text
  assert.match(frame, /end the Run failed/); // stop consequence, plain text
  resizeWorkbench(t, renderer, 40, 24);
  await t.renderOnce();
  frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Continue 3 More Iterations/); // controls still readable
  assert.match(frame, /Stop Run/);
});

// --- deleted between launch and initial open -------------------------------

test("a launched Run missing on initial open returns to Previous Runs with its Bundle notice", async () => {
  const control = makeRunView({
    family: "run",
    runId: "ghost",
    result: {
      found: false,
      problem: {
        code: "run-not-found",
        explanation: "No such Run.",
        remediation: "Run `secant run list`.",
        possibleEffects: "none",
      },
    },
  });
  const renderer = makeFakeRenderer(80, 24);
  const { t } = await mountApp(control, renderer, "ghost", 80, 24);
  await t.waitForFrame((frame) => frame.includes("was deleted"));
  assert.match(t.captureCharFrame(), /Alpha Flow was deleted/);
  assert.doesNotMatch(t.captureCharFrame(), /No such Run/);
});

const RESUME_UNAVAILABLE_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: false as const,
  reason:
    'resume needs the "main" Session, which is no longer usable — start a new Run instead.',
};

test("m10-audit-workbench-test-domains: resume and delete live in focused details, off the everyday screen (ADR 0036)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER, DELETE_OFFER] }),
    100,
    40,
    okActions(),
  );
  const everyday = t.captureCharFrame();
  assert.doesNotMatch(everyday, /r resume/);
  assert.doesNotMatch(everyday, /x delete/);
  assert.doesNotMatch(everyday, /c cancel/);
  // A bare `r` beside the prompt types; it never resumes.
  await press(t, renderer, "r");
  assert.doesNotMatch(t.captureCharFrame(), /Checking resume/);
  // Both live in the panel with their consequences.
  await press(t, renderer, "g", { ctrl: true });
  const panel = t.captureCharFrame();
  assert.match(panel, /r resume — resume: continue from the Step/);
  assert.match(panel, /x delete — remove the Run/);
  assert.doesNotMatch(panel, /c cancel/); // not offered while resting
});

test("no Actions section is shown when the Run offers none", async () => {
  const { t } = await mountWorkbench(runOf({ actionOffers: [] }));
  assert.doesNotMatch(t.captureCharFrame(), /Actions:/);
});

test("resume dispatches and the Workbench follows into the running Run", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "halted", actionOffers: [RESUME_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  const actions = okActions({
    resume: () => {
      // Production drives the Run and the read seam observes it; model that here:
      // the dispatch settles at once and the snapshot advances to running.
      control.setRun(runOf({ state: "running", actionOffers: [CANCEL_OFFER] }));
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame(workbenchShown);
  await press(t, renderer, "g", { ctrl: true });
  assert.match(t.captureCharFrame(), /r resume/);

  await press(t, renderer, "r");
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /halted/); // transitioned into the running Workbench
  assert.doesNotMatch(frame, /r resume/); // no longer resumable
  // Cancel is offered while live, in the same focused panel.
  assert.match(frame, /c cancel/);
});

test("workbench-timeline-inspection: a resume receipt moves from checking to applied and is dismissible", async () => {
  const [outcome, setOutcome] = createSignal<RunActionOutcome>({
    kind: "pending",
  });
  const actions = okActions({ resume: () => outcome });
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
    100,
    40,
    actions,
  );

  await press(t, renderer, "g", { ctrl: true });
  await press(t, renderer, "r");
  assert.match(t.captureCharFrame(), /Checking resume/);
  assert.doesNotMatch(t.captureCharFrame(), /dismisses/);

  setOutcome({ kind: "ok" });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Resume applied · any key dismisses/);

  // The dismissing key keeps its own recipient: Esc still leaves details.
  await press(t, renderer, "escape");
  const dismissed = t.captureCharFrame();
  assert.doesNotMatch(dismissed, /Resume applied/);
  assert.doesNotMatch(dismissed, /› Details/);
});

test("resume takeover asks once with the owner pid before dispatching the offered form", async () => {
  const takeover = {
    ...RESUME_OFFER,
    takeover: { ownerPid: 7331 },
  };
  let received: ResumeRunOffer | undefined;
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "running",
      liveness: { state: "live-elsewhere", ownerPid: 7331 },
      actionOffers: [takeover],
    }),
    100,
    40,
    okActions({
      resume: (offer) => {
        received = offer;
        return () => ({ kind: "ok" });
      },
    }),
  );

  await press(t, renderer, "g", { ctrl: true }); // resume lives in focused details
  await press(t, renderer, "r");
  assert.equal(received, undefined);
  assert.match(t.captureCharFrame(), /Take over from process 7331/);
  await press(t, renderer, "y");
  assert.deepEqual(received, takeover);
});

test("workbench-interaction-regression: delete stays armed until y confirms and then leaves", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "failed", actionOffers: [DELETE_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let removed = 0;
  const actions = okActions({
    remove: () => {
      removed += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame(workbenchShown);
  await press(t, renderer, "g", { ctrl: true }); // open the panel where delete now lives (#194)
  await t.waitForFrame((f) => f.includes("x delete"));
  await press(t, renderer, "x"); // arm the confirmation
  assert.equal(removed, 0); // not dispatched yet
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "y"); // confirm
  assert.equal(removed, 1);
  assert.match(t.captureCharFrame(), /Previous Runs/);
  assert.match(t.captureCharFrame(), /Alpha Flow was deleted/);
  assert.doesNotMatch(t.captureCharFrame(), /Details/);
});

test("Escape backs out of an armed delete without dispatching or leaving", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "failed", actionOffers: [DELETE_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let removed = 0;
  const actions = okActions({
    remove: () => {
      removed += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame(workbenchShown);
  await press(t, renderer, "g", { ctrl: true }); // open the panel where delete now lives (#194)
  await t.waitForFrame((f) => f.includes("x delete"));
  await press(t, renderer, "x"); // arm
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "escape"); // back out
  assert.equal(removed, 0);
  assert.doesNotMatch(t.captureCharFrame(), /Delete is permanent/);
  assert.ok(onWorkbench(t.captureCharFrame())); // still on the Workbench
});

test("workbench-interaction-regression: cancel stays armed until y confirms", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "running", actionOffers: [CANCEL_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let cancelled = 0;
  const actions = okActions({
    cancel: () => {
      cancelled += 1;
      control.setRun(
        runOf({ state: "cancelled", actionOffers: [DELETE_OFFER] }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame(workbenchShown);
  await press(t, renderer, "g", { ctrl: true }); // open the panel where cancel now lives (#194)
  await t.waitForFrame((f) => f.includes("c cancel"));
  await press(t, renderer, "c"); // arm
  assert.equal(cancelled, 0);
  assert.match(t.captureCharFrame(), /Cancel ends the Run/);
  await press(t, renderer, "y"); // confirm
  assert.equal(cancelled, 1);
  const frame = t.captureCharFrame();
  assert.match(frame, /■ Run cancelled/); // transitioned to the cancelled state
  assert.match(frame, /x delete/); // now offers delete, not cancel
  assert.doesNotMatch(frame, /c cancel/);
});

test("a refused action surfaces the reason without leaving", async () => {
  const actions = okActions({
    resume: () => () => ({
      kind: "refused",
      problem: {
        code: "run-live-elsewhere",
        explanation: "The Run is live in another process.",
        remediation: "Wait for it to rest, then retry.",
        possibleEffects: "none",
      },
    }),
  });
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
    100,
    40,
    actions,
  );
  await press(t, renderer, "g", { ctrl: true }); // resume lives in focused details
  await press(t, renderer, "r");
  const frame = t.captureCharFrame();
  assert.match(frame, /live in another process/); // the reason is shown
  assert.ok(onWorkbench(frame)); // still on the Workbench
});

test("a refused delete surfaces its reason though delete lives only in the panel (#194 story 37)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "failed", actionOffers: [DELETE_OFFER] }),
    100,
    40,
    okActions({
      remove: () => () => ({
        kind: "refused",
        problem: {
          code: "run-store-damaged",
          explanation: "The Run store is damaged.",
          remediation: "Re-open the Run.",
          possibleEffects: "none",
        },
      }),
    }),
  );
  // Delete lives only in the panel; its refusal must not be gated behind it (the
  // regression this guards), so it stays visible after the panel closes too.
  assert.doesNotMatch(t.captureCharFrame(), /Actions:/);
  await press(t, renderer, "g", { ctrl: true }); // open the panel where delete lives
  await press(t, renderer, "x"); // arm
  await press(t, renderer, "y"); // confirm → refused
  const after = t.captureCharFrame();
  assert.match(after, /The Run store is damaged\./); // the reason stays visible
  assert.ok(onWorkbench(after)); // still on the Workbench
  await press(t, renderer, "g", { ctrl: true }); // close the panel
  assert.match(t.captureCharFrame(), /The Run store is damaged\./);
});

// --- recovery evidence, resting prose, and the two resume acknowledgements
//     (#194 stories 36-40) ------------------------------------------------

test("[workbench-details-recovery] the panel renders recovery evidence and hosts the relocated destructive actions", async () => {
  // Coverage dimensions for this slice (AC7): keymap and focus (`d` opens the panel,
  // `x` arms delete from it), terminal layout and the details breakpoint (the panel
  // fits at 100×40 without overflow), colour-independent status (every recovery line
  // and the resting prose read as words), interaction tuning (delete arms then
  // confirms on `y`), and renderer/platform evidence (the sessions/latest-activity
  // facts come only from the Run view). Timeline mechanics and large content are
  // inapplicable to this slice; the Windows Terminal human check is not applicable —
  // the named workbench-details-recovery scenario runs in the canonical suite on
  // Windows, macOS, and Linux.
  const run = runOf({
    state: "halted",
    sessions: [
      {
        session: "main-0.1:work",
        name: "main, iteration 1",
        availability: "unusable",
      },
    ],
    timeline: [
      {
        at: "T0",
        event: "turn-settled",
        detail: "interrupted",
        step: "work",
        session: "main-0.1:work",
        sessionName: "main, iteration 1",
      },
    ],
    actionOffers: [RESUME_UNAVAILABLE_OFFER, DELETE_OFFER],
  });
  const { t, renderer } = await mountWorkbench(run, 100, 40, okActions());
  // The prompt's note: the halted Run's id and resting prose (story 38, AC4).
  const header = t.captureCharFrame();
  // Everyday rows carry neither the recorded Session name nor its availability
  // (#289 story 84); the Session divider names the conversation in plain words.
  const everyday = timelineLines(header).join("\n");
  assert.match(everyday, /Conversation · main, iteration 1/);
  assert.doesNotMatch(everyday, /\b(?:open|detached|unusable)\b/);
  assert.doesNotMatch(everyday, /main-0\.1|session/);
  assert.match(header, /Execution stopped outside the Workflow\./);
  // Run lifecycle actions are off the everyday screen (ADR 0036).
  assert.doesNotMatch(header, /resume —|x delete/);

  await press(t, renderer, "g", { ctrl: true });
  const panel = t.captureCharFrame();
  assert.match(panel, /Recovery:/);
  assert.match(
    panel,
    /Resting reason · Execution stopped outside the Workflow\./,
  );
  assert.match(panel, /Latest activity · turn-settled interrupted · T0/);
  // Session availability stays in the panel, under the plain name (#289 story 85).
  assert.match(panel, /Session main, iteration 1 · unusable/);
  // Nothing invented when absent (story 36, AC2): no conflict line here.
  assert.doesNotMatch(panel, /Materialization conflict/);
  assert.match(panel, /x delete — remove the Run/);
  // Resume is truthfully unavailable, not hidden (story 40).
  assert.match(panel, /resume — unavailable · .*no longer usable/);
  noOverflow(panel, 100);

  // The relocated delete keeps its confirm-armed behaviour (story 37, AC3).
  await press(t, renderer, "x");
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "escape"); // Esc backs out without dispatching
  assert.doesNotMatch(t.captureCharFrame(), /Delete is permanent/);
});

test("an unavailable resume is not dispatchable — r does nothing (#194 story 40)", async () => {
  let dispatched = false;
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_UNAVAILABLE_OFFER] }),
    100,
    40,
    okActions({
      resume: () => {
        dispatched = true;
        return () => ({ kind: "ok" });
      },
    }),
  );
  await press(t, renderer, "g", { ctrl: true }); // resume lives in focused details
  await press(t, renderer, "r");
  assert.equal(dispatched, false);
  assert.match(t.captureCharFrame(), /resume — unavailable/);
});

test("an indeterminate-Command resume arms an acknowledgement before it dispatches (#194 story 39)", async () => {
  let received = false;
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_ACK_OFFER] }),
    100,
    40,
    okActions({
      resume: () => {
        received = true;
        return () => ({ kind: "ok" });
      },
    }),
  );
  // `r` arms the acknowledgement of repeatable effects and does not dispatch yet.
  await press(t, renderer, "g", { ctrl: true }); // resume lives in focused details
  await press(t, renderer, "r");
  assert.equal(received, false);
  const armed = t.captureCharFrame();
  assert.match(armed, /Resuming may repeat this Step's effects/);
  assert.match(armed, /y to acknowledge and resume/);
  // Esc backs out without resuming.
  await press(t, renderer, "escape");
  assert.equal(received, false);
  assert.doesNotMatch(t.captureCharFrame(), /y to acknowledge/);
  // Arm again and confirm: `y` acknowledges and dispatches the resume.
  await press(t, renderer, "r");
  await press(t, renderer, "y");
  assert.equal(received, true);
});

test("End Step arms a confirmation and dispatches on y (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.ends, [{ runId: "run-1", stepId: "discuss" }]);
});

test("Escape backs out of an armed End Step without dispatching (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(wb.control.ends.length, 0);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
});

test("End Step armed blurs the field so the confirming y never types, and dropping the arm refocuses it (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "hi");
  await press(wb.t, wb.renderer, "e", { ctrl: true }); // arm End Step → field blurs
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  // While armed the field is blurred: a keystroke (the confirming `y` included) does not
  // type — the draft is unchanged. `y` over the Port confirms; it is never text.
  await type(wb.t, "y");
  assert.match(wb.t.captureCharFrame(), /> hi/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /> hiy/);
  // Esc drops the arm; the field refocuses and accepts text again.
  await press(wb.t, wb.renderer, "escape");
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> hi!/);
});

test("the armed End Step confirms on y over the Port and no y lands in the field (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  await press(wb.t, wb.renderer, "y"); // confirm through the Port dispatcher
  assert.deepEqual(wb.control.ends, [{ runId: "run-1", stepId: "discuss" }]);
});

test("End Step is not offered mid-Turn (#122)", async () => {
  // A live Turn offers its interrupt, not send/end: End Step cannot arm and Enter
  // sends nothing, so the human waits (or interrupts) rather than ending mid-Turn.
  const wb = await mountWorkbench(liveInteractiveRunOf());
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /◆ The agent is working/);
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.equal(wb.control.ends.length, 0);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "a");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 0);
});

test("Continue replaces End Step in a human-controlled Repeat: ^N arms a confirmation that says no ticket is closed, and y dispatches (#217)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, CONTINUE_OFFER] }),
  );
  assert.match(wb.t.captureCharFrame(), /enter send Turn · \^N continue/);
  // End Step is not offered here, so ^E arms nothing.
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "n", { ctrl: true });
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /y continue · esc keep/);
  assert.match(armed, /this does not close the ticket/);
  // The arm blurs the field, so the confirming y is never text.
  await type(wb.t, "y");
  assert.doesNotMatch(wb.t.captureCharFrame(), /> drafty/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.continues, [
    { runId: "run-1", stepId: "discuss" },
  ]);
  assert.equal(wb.control.ends.length, 0);
});

test("Escape backs out of an armed Continue, and Continue cannot arm mid-Turn (#217)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, CONTINUE_OFFER] }),
  );
  await press(wb.t, wb.renderer, "n", { ctrl: true });
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /y continue/);
  assert.equal(wb.control.continues.length, 0);

  const live = await mountWorkbench(liveInteractiveRunOf());
  await press(live.t, live.renderer, "n", { ctrl: true });
  assert.doesNotMatch(live.t.captureCharFrame(), /y continue/);
  await press(live.t, live.renderer, "y");
  assert.equal(live.control.continues.length, 0);
});

test("End Stage has no key: ^E arms nothing beside Continue, and the palette arms a confirm saying the tracker is unchecked; esc declines keeping focus and the draft; y dispatches End Stage only (#218, ADR 0040)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({
      actionOffers: [SEND_OFFER, CONTINUE_OFFER, END_STAGE_OFFER],
    }),
  );
  assert.match(
    wb.t.captureCharFrame(),
    /enter send Turn · \^N continue · \^P commands/,
  );
  await type(wb.t, "draft");
  // Ctrl+E means End Step only; with no End Step Offer it arms nothing.
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /y end stage|End this/);
  const armEndStage = async () => {
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    await type(wb.t, "End Stage");
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
  };
  await armEndStage();
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /y end stage · esc keep — Secant has not checked the/);
  assert.doesNotMatch(armed, /End this interactive Step\?/);
  // Declined: nothing dispatches, and the field keeps its draft and focus.
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /y end stage/);
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> draft!/);
  assert.equal(wb.control.endStages.length, 0);
  // Confirmed: the arm blurs the field, so y never types, and only End Stage goes.
  await armEndStage();
  await type(wb.t, "y");
  assert.doesNotMatch(wb.t.captureCharFrame(), /> draft!y/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.endStages, [
    { runId: "run-1", stepId: "discuss" },
  ]);
  assert.equal(wb.control.continues.length, 0);
  assert.equal(wb.control.ends.length, 0);
});

test("End Stage cannot arm mid-Turn (#218)", async () => {
  const live = await mountWorkbench(liveInteractiveRunOf());
  await press(live.t, live.renderer, "e", { ctrl: true });
  assert.doesNotMatch(live.t.captureCharFrame(), /y end stage/);
  await press(live.t, live.renderer, "y");
  assert.equal(live.control.endStages.length, 0);
});

test("a human-declared completion says the tracker was not checked, apart from a verified one (#218)", async () => {
  const declared = await mountWorkbench(
    runOf({ state: "succeeded", completion: "human-declared" }),
  );
  assert.match(
    declared.t.captureCharFrame(),
    /You declared the stage complete; Secant did not check the tracker\./,
  );
  const verified = await mountWorkbench(runOf({ state: "succeeded" }));
  assert.match(verified.t.captureCharFrame(), /Workflow completed\./);
  assert.doesNotMatch(verified.t.captureCharFrame(), /did not check/);
});

test("a live interactive Turn shows its Interrupt and two Esc presses dispatch it (#219)", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  const frame = wb.t.captureCharFrame();
  // The agent holds the Turn, so the prompt says it is working, never the human's move.
  assert.match(frame, /◆ The agent is working/);
  assert.doesNotMatch(frame, /Your move|Your Turn/);
  assert.match(frame, /working · esc esc interrupt/);
  await type(wb.t, "next");
  // With a draft the hint still says the agent is working.
  assert.match(wb.t.captureCharFrame(), /working · esc esc interrupt/);

  await press(wb.t, wb.renderer, "escape"); // arm, never leave
  assert.equal(interrupted, undefined);
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /Press esc again to interrupt/);
  assert.ok(onWorkbench(armed));
  assert.match(armed, /> next/); // the draft survives the arm

  await press(wb.t, wb.renderer, "escape"); // dispatch
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
  assert.ok(onWorkbench(wb.t.captureCharFrame()));
  assert.equal(wb.control.sends.length, 0);
});

test("any other key cancels an armed interactive Interrupt and still types (#219)", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Press esc again/);
  // One real keypress reaches both the Port dispatcher (which disarms) and the
  // focused field (which types it); the test drives each path.
  wb.renderer.key("a");
  await type(wb.t, "a");
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /Press esc again/);
  assert.match(frame, /> a/);
  assert.equal(interrupted, 0);
  // Disarmed, the next Esc arms again rather than dispatching.
  await press(wb.t, wb.renderer, "escape");
  assert.equal(interrupted, 0);
});

test("Ctrl+E disarms an armed interactive Interrupt, so one more Esc only re-arms (#219)", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(interrupted, 0);
  assert.match(wb.t.captureCharFrame(), /Press esc again/);
});

test("a request during a live interactive Turn owns Esc before the Interrupt (#219)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, okActions());
  wb.control.setLive(requestOverlay());
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /esc esc interrupt/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(wb.control.requests[0]?.decision, "deny");
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again to interrupt/);
});

test("an interrupted interactive Turn returns to the same Step's input, not a halted Run (#219, #353)", async () => {
  const control = makeRunView(snapshotOf(liveInteractiveRunOf()));
  const renderer = makeFakeRenderer(100, 40);
  const actions = okActions({
    interrupt: () => {
      control.setRun(
        interactiveRunOf({
          timeline: [
            { at: "T1", event: "turn-settled", detail: "interrupted" },
          ],
        }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame(workbenchShown);
  await press(t, renderer, "escape");
  await press(t, renderer, "escape");
  const back = t.captureCharFrame();
  assert.match(back, /◇ Your move/);
  assert.match(back, /enter send Turn/);
  assert.doesNotMatch(back, /halted|r resume|The agent is working/);
});

test("the live interactive Interrupt reads without colour and fits a small terminal (#219)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 40, 16, okActions());
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /esc esc interrupt/);
  noOverflow(frame, 40);
  await press(wb.t, wb.renderer, "escape");
  frame = wb.t.captureCharFrame();
  assert.match(frame, /⚠ Press esc again/);
  noOverflow(frame, 40);
});

// Mount a running Run and put an outstanding request on the live overlay.
async function mountWithRequest(overlay: RunLiveOverlay = requestOverlay()) {
  const mounted = await mountWorkbench(runOf({ state: "running" }));
  mounted.control.setLive(overlay);
  await mounted.t.renderOnce();
  return mounted;
}

// AC1 --------------------------------------------------------------

test("an outstanding request renders the tool, input, and both decisions in place of the footer", async () => {
  const { t } = await mountWithRequest();
  const frame = t.captureCharFrame();
  assert.match(frame, /Permission required · awaiting your approval/);
  assert.match(frame, /Tool: Edit/);
  assert.match(frame, /Input: \{"path":"src\/fix\.ts"\}/);
  assert.match(frame, /\[ Allow \]/);
  assert.match(frame, /\[ Deny \]/);
  assert.match(frame, /enter confirm · esc deny/);
  assert.doesNotMatch(frame, /d details · end latest/); // footer replaced
});

test("Enter confirms allow and dispatches answer-harness-request with the offer's id and generation", async () => {
  const { t, control, renderer } = await mountWithRequest(requestOverlay(5));
  assert.match(t.captureCharFrame(), /› \[ Allow \]/); // allow selected by default
  await press(t, renderer, "return");
  assert.equal(control.requests.length, 1);
  assert.deepEqual(control.requests[0], {
    requestId: "req-1",
    generation: 5,
    decision: "allow",
  });
});

test("→ selects deny and Enter dispatches the deny decision", async () => {
  const { t, control, renderer } = await mountWithRequest();
  await press(t, renderer, "right");
  assert.match(t.captureCharFrame(), /› \[ Deny \]/);
  await press(t, renderer, "return");
  assert.equal(control.requests[0]?.decision, "deny");
});

test("Esc denies the outstanding request", async () => {
  const { t, control, renderer } = await mountWithRequest();
  await press(t, renderer, "escape");
  assert.equal(control.requests.length, 1);
  assert.equal(control.requests[0]?.decision, "deny");
});

test("the request control vanishes when the Turn settles without an answer, and keys reach the timeline again (A8)", async () => {
  const { t, control, renderer } = await mountWithRequest();
  assert.match(t.captureCharFrame(), /Permission required · awaiting/);
  // The Turn ends (or is interrupted/lost) and the overlay clears — the reducer drops it
  // on a `closed` update or when durable liveness leaves live-here (A8, run-view.test.ts).
  // Here the mounted view is handed the cleared overlay directly.
  control.setLive(undefined);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /awaiting your approval/); // the request control is gone
  assert.match(frame, /esc esc interrupt|\^G details/); // the prompt returned
  // Ordinary keys reach the timeline again — the modal no longer swallows them.
  await press(t, renderer, "g", { ctrl: true });
  assert.match(t.captureCharFrame(), /› Details/);
});

test("the request is never re-asked: a later overlay with no outstanding clears the control", async () => {
  const { t, control } = await mountWithRequest();
  control.setLive({
    runId: "run-1",
    generation: 4,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /awaiting your approval/);
});

// AC2 --------------------------------------------------------------

test("a stale answer is refused with the Problem inline and the current offer re-rendered", async () => {
  const { t, control, renderer } = await mountWithRequest(requestOverlay(3));
  control.setRequestOutcome({
    kind: "refused",
    problem: {
      code: "harness-request-stale",
      explanation: "The request moved on.",
      remediation: "Answer the current request.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "return");
  await t.renderOnce();
  // The generation bumped under the user; the same requestId re-renders, and the
  // precise Problem shows inline while the control stays up.
  control.setLive(requestOverlay(4));
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /refused: The request moved on/);
  assert.match(frame, /\[ Allow \]/); // the current offer is still rendered
});

test("the controls are unavailable while a request answer is pending and dispatch nothing twice", async () => {
  const { t, control, renderer } = await mountWithRequest();
  control.setRequestOutcome({ kind: "pending" });
  await press(t, renderer, "return");
  await t.renderOnce();
  assert.equal(control.requests.length, 1);
  assert.match(t.captureCharFrame(), /relaying your decision/);
  assert.match(t.captureCharFrame(), /\(unavailable\)/);
  await press(t, renderer, "return"); // a second confirm while pending dispatches nothing
  assert.equal(control.requests.length, 1);
});

test("Esc from Details returns focus to the prompt during a live Turn, never arming interrupt (A7)", async () => {
  // With a live agent Turn the interrupt Offer stands, so at HEAD the two-press Esc arm
  // sat above the focused-region branches and shadowed Details' own Esc: opening Details
  // and pressing Esc armed (and a second Esc cancelled) the Turn instead of going back.
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t, renderer } = await mountWorkbench(
    liveTurnRunOf({ timeline: events(4) }),
    100,
    40,
    actions,
  );
  await press(t, renderer, "g", { ctrl: true }); // open Details; focus moves there
  const detailsFrame = t.captureCharFrame();
  assert.match(detailsFrame, /› Details/);
  assert.match(detailsFrame, /esc back/); // the footer stays honest about what Esc does
  await press(t, renderer, "escape"); // A7: back to the prompt, not an interrupt arm
  const afterEsc = t.captureCharFrame();
  assert.doesNotMatch(afterEsc, /› Details/);
  assert.doesNotMatch(afterEsc, /Press esc again to interrupt/);
  // A second Esc — now at the prompt — only arms; it dispatches no interrupt-turn.
  await press(t, renderer, "escape");
  assert.equal(interrupted, 0);
});

test("workbench-interaction-regression: interrupt requires two Esc presses and keeps the Workbench", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const { t, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    actions,
  );
  assert.match(t.captureCharFrame(), /esc esc interrupt/); // the control is listed
  await press(t, renderer, "escape"); // arm
  assert.equal(interrupted, undefined);
  assert.match(t.captureCharFrame(), /Press esc again to interrupt/);
  await press(t, renderer, "escape"); // dispatch
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
  assert.ok(onWorkbench(t.captureCharFrame())); // did not leave the Workbench
});

test("workbench-interaction-regression: request modal owns Esc before interrupt and steer controls", async () => {
  // The interrupt/steer offers stand while a Turn is live even at awaiting-approval,
  // so without the modal guard the request control and the interrupt hint collide
  // over Esc. The request modal must own the bottom interaction.
  const { t, control, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    okActions(),
  );
  control.setLive(requestOverlay());
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /awaiting your approval/);
  assert.doesNotMatch(frame, /esc esc interrupt/); // interrupt control suppressed
  assert.doesNotMatch(frame, /steer — unavailable/);
  await press(t, renderer, "escape"); // a single Esc denies, and never arms interrupt
  assert.equal(control.requests[0]?.decision, "deny");
  assert.doesNotMatch(t.captureCharFrame(), /Press esc again to interrupt/);
});

test("a request appearing disarms an already-armed interrupt so no stale hint lingers", async () => {
  const mounted = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  await press(mounted.t, mounted.renderer, "escape"); // arm interrupt, no request yet
  assert.match(mounted.t.captureCharFrame(), /Press esc again to interrupt/);
  mounted.control.setLive(requestOverlay()); // a request takes over the interaction
  await mounted.t.renderOnce();
  const frame = mounted.t.captureCharFrame();
  assert.doesNotMatch(frame, /Press esc again to interrupt/); // disarmed and hidden
  assert.match(frame, /awaiting your approval/);
});

test("any other key cancels an armed Interrupt without dispatching or leaving", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t, renderer } = await mountWorkbench(
    liveTurnRunOf({ timeline: events(4) }),
    100,
    40,
    actions,
  );
  await press(t, renderer, "escape"); // arm
  assert.match(t.captureCharFrame(), /Press esc again/);
  await press(t, renderer, "up"); // any other key cancels the arm
  assert.doesNotMatch(t.captureCharFrame(), /Press esc again/);
  assert.equal(interrupted, 0);
});

test("resume on a halted Run dispatches resume-run and live rows resume", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "halted", actionOffers: [RESUME_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let resumed = 0;
  const actions = okActions({
    resume: () => {
      resumed += 1;
      control.setRun(
        liveTurnRunOf({
          timeline: [{ at: "T0", event: "turn-started", turnKind: "agent" }],
        }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame(workbenchShown);
  await press(t, renderer, "g", { ctrl: true });
  await t.waitForFrame((f) => f.includes("r resume"));
  await press(t, renderer, "r");
  assert.equal(resumed, 1);
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /halted/);
  assert.match(frame, /Agent Turn started/); // the resumed Turn's rows appear
});

// AC5: Esc modes + focus -------------------------------------------

test("Esc means deny in a request, interrupt-arm during a live Turn, and leave when at rest", async () => {
  // At rest with no live Turn: Esc leaves the Workbench.
  const rest = await mountWorkbench(runOf({ state: "succeeded" }));
  await press(rest.t, rest.renderer, "escape");
  assert.match(rest.t.captureCharFrame(), /Start a Run/); // back on Home

  // During a live Turn: Esc arms interrupt rather than leaving.
  const live = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  await press(live.t, live.renderer, "escape");
  assert.match(live.t.captureCharFrame(), /Press esc again to interrupt/);
  assert.ok(onWorkbench(live.t.captureCharFrame())); // stayed

  // With an outstanding request: Esc denies (does not arm interrupt or leave).
  const req = await mountWithRequest();
  await press(req.t, req.renderer, "escape");
  assert.equal(req.control.requests[0]?.decision, "deny");
});

test("the request control fits small widths without overflow and reads without colour", async () => {
  const mounted = await mountWithRequest();
  noOverflow(mounted.t.captureCharFrame(), 100);
  resizeWorkbench(mounted.t, mounted.renderer, 40, 24);
  await mounted.t.renderOnce();
  const frame = mounted.t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Allow/);
  assert.match(frame, /Deny/);
});

for (const [width, height] of [
  [60, 24],
  [140, 44],
]) {
  test(`agent completion renders pending, settled, and hostile reasons at ${width}x${height}`, async (context) => {
    let finish!: () => void;
    const boundary = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const reason = "ready\n\x1b[31mred\x1b[0m\t\x07\u202e" + "終😺 ".repeat(70);
    const { wired, runId } = await launchAgentCompletionRun(context, [
      {
        agentCalls: [call(reason)],
        block: true,
        finish: boundary,
        result: completed,
      },
    ]);
    const pending = await followRun(wired.projectionPort, runId, (run) =>
      run.pendingAgentCompletion !== undefined ? run : undefined,
    );
    const wb = await mountWorkbench(pending, width, height);
    const frame = wb.t.captureCharFrame();
    assert.match(frame, /The agent has asked to end this Step/);
    assert.match(frame, /ready red/);
    for (const control of ["\x1b", "\x07", "\u202e"])
      assert.equal(frame.includes(control), false);
    noOverflow(frame, width);
    const pendingLine = frame
      .split("\n")
      .find((line) => line.includes("The agent has asked"));
    assert.ok(pendingLine?.includes("…"));
    await press(wb.t, wb.renderer, "home", { alt: true });
    finish();
    const settled = await followRun(wired.projectionPort, runId, (run) =>
      run.state === "succeeded" ? run : undefined,
    );
    wb.control.setRun(settled);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "home", { alt: true });
    assert.match(wb.t.captureCharFrame(), /Beginning of Run history/);
    await press(wb.t, wb.renderer, "end", { alt: true });
    const ended = wb.t.captureCharFrame();
    assert.match(ended, /Step ended by the agent/);
    assert.match(ended, /ready red/);
    for (const control of ["\x1b", "\x07", "\u202e"])
      assert.equal(ended.includes(control), false);
    noOverflow(ended, width);
    assert.equal(
      readRun(wired.projectionPort, runId).timeline.find(
        (event) => event.endedBy === "agent",
      )?.reason,
      reason,
    );
    const newWidth = width === 60 ? 140 : 60;
    const newHeight = height === 24 ? 44 : 24;
    resizeWorkbench(wb.t, wb.renderer, newWidth, newHeight);
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "end", { alt: true });
    assert.match(wb.t.captureCharFrame(), /Step ended by the agent/);
    noOverflow(wb.t.captureCharFrame(), newWidth);
  });
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
]) {
  test(`a held agent Continue shows the checkpoint message and keeps the person's controls at ${width}x${height}`, async (context) => {
    const message = "Look over\nthe \x1b[31mtracker\x1b[0m, then Continue.";
    const { wired, runId } = await launchAgentCompletionRun(
      context,
      across(
        ["1", "2"].map((key) => ({
          agentCalls: [call(`ticket ${key} done`, key)],
          result: completed,
        })),
      ),
      reviewedLoop({ interval: 1, message }),
    );
    const held = await followRun(wired.projectionPort, runId, (run) =>
      run.heldForReview !== undefined ? run : undefined,
    );
    assert.equal(held.heldForReview?.message, message);
    const wb = await mountWorkbench(held, width, height);
    const readable = (frame: string) => frame.replace(/\s+/g, " ");
    const heldRow =
      /◆ Held for review · the agent's Continue waits for you · Look over the tracker, then Continue\./g;
    const newWidth = width === 60 ? 140 : 60;
    const newHeight = height === 24 ? 44 : 24;
    for (const [w, h] of [
      [width, height],
      [newWidth, newHeight],
      [width, height],
    ] as const) {
      resizeWorkbench(wb.t, wb.renderer, w, h);
      // A re-pushed snapshot replaces the stable-key tail row, never repeats it.
      wb.control.setRun({ ...held });
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      // Meaning without colour: a glyph and words say the Continue is held, and the
      // authored message wraps at the live edge with its control bytes removed.
      assert.equal(readable(frame).match(heldRow)?.length, 1);
      // The timestamped call row clips on a narrow screen; the held row still reads.
      if (w >= 140) {
        assert.match(readable(frame), /held for review · ticket 2 done/);
        assert.match(
          readable(frame),
          /↻ Continued by the agent · ticket 1 done/,
        );
      }
      assert.equal(frame.includes("\x1b"), false);
      noOverflow(frame, w);
    }
    // The person's controls stay: Continue arms its confirmation.
    await press(wb.t, wb.renderer, "n", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /y continue/);
  });
}

test("agent stage done reads as a Stage request while pending and a Stage end once applied", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      state: "running",
      timeline: [{ at: "T000", event: "turn-started", step: "implement" }],
      pendingAgentCompletion: { call: "stage_done", reason: "no ticket left" },
    }),
    60,
    24,
  );
  assert.match(
    t.captureCharFrame(),
    /The agent has asked to end this Stage · no ticket left/,
  );
  control.setRun(
    runOf({
      state: "succeeded",
      completion: "agent-declared",
      timeline: [
        { at: "T000", event: "turn-started", step: "implement" },
        {
          at: "T001",
          event: "stage-ended",
          detail: "succeeded",
          endedBy: "agent",
          reason: "no ticket left",
          step: "implement",
        },
      ],
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /▸ Stage ended by the agent · no ticket left/);
  noOverflow(frame, 60);
});

test("m10-confirmation-target-identity: End Step cannot adopt a replacement Step", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  wb.control.setRun(
    interactiveRunOf({
      progress: [
        { id: "next-step", kind: "interactive-agent", status: "running" },
      ],
      actionOffers: [
        { ...SEND_OFFER, stepId: "next-step" },
        { ...END_OFFER, stepId: "next-step" },
      ],
    }),
  );
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.ends, []);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
});

/** Arm a Step ending through its decided route: its key, or the palette's App
 *  command, which reaches the same arm-then-confirm path (ADR 0040). */
async function armEnding(
  wb: Awaited<ReturnType<typeof mountWorkbench>>,
  route:
    | { readonly key: "e" | "n" }
    | { readonly command: string }
    | { readonly slash: string },
) {
  if ("slash" in route) {
    wb.t.mockInput.pressKey("\x15"); // native Ctrl+U clears the line without requesting Quit
    await wb.t.renderOnce();
    await type(wb.t, route.slash);
    await press(wb.t, wb.renderer, "return");
    return;
  }
  if ("key" in route) {
    await press(wb.t, wb.renderer, route.key, { ctrl: true });
    return;
  }
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, route.command);
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
}

// #389 exercises supported client snapshots. It does not measure how often a
// live Harness produces a replacement, and Step Offers expose no Attempt id.
// End Step and Continue run through both their key and the palette; End Stage has
// no key, so its palette and Slash commands arm it (ADR 0040).
for (const ending of [
  {
    offer: END_OFFER,
    route: { key: "e" },
    prompt: /End this interactive Step\?/,
    writes: "ends",
  },
  {
    offer: END_OFFER,
    route: { command: "End Step" },
    prompt: /End this interactive Step\?/,
    writes: "ends",
  },
  {
    offer: CONTINUE_OFFER,
    route: { key: "n" },
    prompt: /y continue/,
    writes: "continues",
  },
  {
    offer: CONTINUE_OFFER,
    route: { command: "Continue" },
    prompt: /y continue/,
    writes: "continues",
  },
  {
    offer: END_STAGE_OFFER,
    route: { command: "End Stage" },
    prompt: /y end stage/,
    writes: "endStages",
  },
  {
    offer: END_OFFER,
    route: { slash: "/end-step" },
    prompt: /End this interactive Step\?/,
    writes: "ends",
  },
  {
    offer: CONTINUE_OFFER,
    route: { slash: "/continue" },
    prompt: /y continue/,
    writes: "continues",
  },
  {
    offer: END_STAGE_OFFER,
    route: { slash: "/end-stage" },
    prompt: /y end stage/,
    writes: "endStages",
  },
] as const) {
  const via =
    "key" in ending.route
      ? `ctrl+${ending.route.key}`
      : "slash" in ending.route
        ? ending.route.slash
        : "palette";
  const keptDraft = "slash" in ending.route ? "" : "kept draft";
  test(`m10-confirmation-target-identity: ${ending.offer.action} via ${via} rejects a replaced Run or Step`, async () => {
    for (const replacement of [
      { ...ending.offer, stepId: "next-step" },
      { ...ending.offer, runId: "run-replacement" },
    ]) {
      const wb = await mountWorkbench(
        interactiveRunOf({ actionOffers: [SEND_OFFER, ending.offer] }),
      );
      await armEnding(wb, ending.route);
      assert.match(wb.t.captureCharFrame(), ending.prompt);
      wb.control.setRun(
        interactiveRunOf({ actionOffers: [SEND_OFFER, replacement] }),
      );
      await press(wb.t, wb.renderer, "y");
      assert.deepEqual(wb.control[ending.writes], []);
      assert.doesNotMatch(wb.t.captureCharFrame(), ending.prompt);
    }
  });

  test(`m10-confirmation-target-identity: ${ending.offer.action} via ${via} withdrawal and reappearance require a fresh arm`, async () => {
    const initial = interactiveRunOf({
      actionOffers: [SEND_OFFER, ending.offer],
    });
    const wb = await mountWorkbench(initial);
    await type(wb.t, "kept draft");
    await armEnding(wb, ending.route);
    wb.control.setRun(interactiveRunOf({ actionOffers: [SEND_OFFER] }));
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), ending.prompt);
    wb.control.setRun(initial);
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(wb.control[ending.writes], []);
    assert.ok(wb.t.captureCharFrame().includes(`> ${keptDraft}`));
    await type(wb.t, " editable");
    assert.ok(wb.t.captureCharFrame().includes(`> ${keptDraft} editable`));
    await armEnding(wb, ending.route);
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(wb.control[ending.writes], [
      { runId: "run-1", stepId: "discuss" },
    ]);
  });

  test(`m10-confirmation-target-identity: ${ending.offer.action} via ${via} retains intent through updates and resize`, async () => {
    const original = {
      ...ending.offer,
      consequence: "ORIGINAL consequence " + "long warning ".repeat(30),
    };
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER, original] }),
      160,
      32,
    );
    await type(wb.t, "kept draft");
    await armEnding(wb, ending.route);
    const armed = wb.t.captureCharFrame();
    assert.match(armed, ending.prompt);
    assert.match(armed, /ORIGINAL consequence/);
    wb.control.setRun(
      interactiveRunOf({
        timeline: [{ at: "T1", event: "turn-started" }],
        actionOffers: [
          { ...SEND_OFFER },
          { ...original, consequence: "REPLACEMENT wording" },
        ],
      }),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /ORIGINAL consequence/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /REPLACEMENT wording/);
    // The captured target survives every width, its whole consequence wraps,
    // and the bottom region counts every wrapped row: the warning ends on the
    // last interior row, with the draft's field above it.
    for (const width of [48, 100, 160]) {
      resizeWorkbench(wb.t, wb.renderer, width, 32);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      noOverflow(frame, width);
      const lines = frame.split("\n");
      assert.match(lines[30]!, /warning\s*$/);
      assert.equal(lines[31]!.trim(), "");
      assert.ok(lines.some((line) => line.includes(`> ${keptDraft}`)));
      assert.ok(
        conversationText(frame, width).includes(original.consequence.trim()),
      );
      assert.doesNotMatch(frame, /REPLACEMENT wording/);
    }
    await type(wb.t, "y");
    assert.ok(!wb.t.captureCharFrame().includes(`> ${keptDraft}y`));
    await press(wb.t, wb.renderer, "escape");
    assert.doesNotMatch(wb.t.captureCharFrame(), ending.prompt);
    await type(wb.t, " editable");
    assert.ok(wb.t.captureCharFrame().includes(`> ${keptDraft} editable`));
    await armEnding(wb, ending.route);
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(wb.control[ending.writes], [
      { runId: "run-1", stepId: "discuss" },
    ]);
  });
}

for (const recovery of [
  {
    offer: { ...RESUME_OFFER, takeover: { ownerPid: 7331 } },
    prompt: /Take over from process 7331/,
  },
  { offer: RESUME_ACK_OFFER, prompt: /y to acknowledge and resume/ },
  {
    offer: { ...RESUME_ACK_OFFER, takeover: { ownerPid: 7331 } },
    prompt: /Take over from process 7331/,
  },
] as const) {
  test(`m10-confirmation-target-identity: resume captures ${recovery.prompt.source} and its consequence`, async () => {
    const received: ResumeRunOffer[] = [];
    const original: Extract<ResumeRunOffer, { available: true }> =
      recovery.offer;
    const initial = runOf({ state: "halted", actionOffers: [original] });
    const wb = await mountWorkbench(
      initial,
      160,
      40,
      okActions({
        resume: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "g", { ctrl: true }); // resume lives in focused details
    await press(wb.t, wb.renderer, "r");
    assert.match(wb.t.captureCharFrame(), recovery.prompt);
    // A new object for the same normalized target must not reset the arm.
    wb.control.setRun(
      runOf({
        state: "halted",
        actionOffers: [
          {
            ...original,
            ...(original.takeover === undefined
              ? {}
              : { takeover: { ...original.takeover } }),
            consequence: "REPLACEMENT resume consequence",
          },
        ],
        timeline: [{ at: "T1", event: "turn-started" }],
      }),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), recovery.prompt);
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /REPLACEMENT resume consequence/,
    );
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(received, [original]);
  });
}

for (const replacement of [
  {
    ...RESUME_ACK_OFFER,
    acknowledgement: "Different command effects may repeat.",
  },
  { ...RESUME_ACK_OFFER, acknowledgement: undefined },
  { ...RESUME_ACK_OFFER, takeover: { ownerPid: 8442 } },
  { ...RESUME_ACK_OFFER, runId: "run-replacement" },
  RESUME_UNAVAILABLE_OFFER,
] as const) {
  test(`m10-confirmation-target-identity: changed resume evidence clears acknowledgement (${JSON.stringify(replacement)})`, async () => {
    const received: ResumeRunOffer[] = [];
    const wb = await mountWorkbench(
      runOf({ state: "halted", actionOffers: [RESUME_ACK_OFFER] }),
      100,
      40,
      okActions({
        resume: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "g", { ctrl: true }); // resume lives in focused details
    await press(wb.t, wb.renderer, "r");
    assert.match(wb.t.captureCharFrame(), /y to acknowledge and resume/);
    wb.control.setRun(runOf({ state: "halted", actionOffers: [replacement] }));
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(received, []);
    assert.doesNotMatch(wb.t.captureCharFrame(), /y to acknowledge and resume/);
  });
}

test("m10-confirmation-target-identity: takeover owner changes and withdrawal cannot silently resume", async () => {
  const original = { ...RESUME_ACK_OFFER, takeover: { ownerPid: 7331 } };
  for (const replacement of [
    { ...original, takeover: { ownerPid: 8442 } },
    { ...original, takeover: undefined },
    { ...original, acknowledgement: "Different acknowledgement" },
    undefined,
  ]) {
    const received: ResumeRunOffer[] = [];
    const initial = runOf({ state: "halted", actionOffers: [original] });
    const wb = await mountWorkbench(
      initial,
      100,
      40,
      okActions({
        resume: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "g", { ctrl: true }); // resume lives in focused details
    await press(wb.t, wb.renderer, "r");
    assert.match(wb.t.captureCharFrame(), /Take over from process 7331/);
    wb.control.setRun(
      runOf({
        state: "halted",
        actionOffers: replacement === undefined ? [] : [replacement],
      }),
    );
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /Take over from process 7331/);
    wb.control.setRun(initial);
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(received, []);
    await press(wb.t, wb.renderer, "r");
    await press(wb.t, wb.renderer, "y");
    assert.deepEqual(received, [original]);
  }
});

for (const interactive of [false, true]) {
  test(`m10-confirmation-target-identity: ${interactive ? "input" : "rail"} Interrupt cannot migrate to a replacement Turn`, async () => {
    const received: (typeof INTERRUPT_OFFER)[] = [];
    const liveRun = interactive ? liveInteractiveRunOf : liveTurnRunOf;
    const wb = await mountWorkbench(
      liveRun(),
      160,
      40,
      okActions({
        interrupt: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "escape");
    assert.match(wb.t.captureCharFrame(), /Press esc again to interrupt/);
    wb.control.setRun(
      liveRun({ actionOffers: [{ ...INTERRUPT_OFFER, turnId: "turn-next" }] }),
    );
    await wb.t.renderOnce();
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /Press esc again to interrupt/,
    );
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, []);
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, [{ ...INTERRUPT_OFFER, turnId: "turn-next" }]);
  });

  test(`m10-confirmation-target-identity: ${interactive ? "input" : "rail"} Interrupt preserves captured wording and clears on withdrawal`, async () => {
    const received: (typeof INTERRUPT_OFFER)[] = [];
    const liveRun = interactive ? liveInteractiveRunOf : liveTurnRunOf;
    const original = {
      ...INTERRUPT_OFFER,
      consequence: "ORIGINAL Turn consequence " + "long warning ".repeat(20),
    };
    const initial = liveRun({ actionOffers: [original] });
    const wb = await mountWorkbench(
      initial,
      160,
      32,
      okActions({
        interrupt: (offer) => {
          received.push(offer);
          return () => ({ kind: "ok" });
        },
      }),
    );
    await press(wb.t, wb.renderer, "escape");
    wb.control.setRun(
      liveRun({
        actionOffers: [
          { ...original, consequence: "REPLACEMENT Turn wording" },
        ],
        timeline: [{ at: "T1", event: "turn-started" }],
      }),
    );
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /ORIGINAL Turn consequence/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /REPLACEMENT Turn wording/);
    for (const width of [48, 100, 160]) {
      resizeWorkbench(wb.t, wb.renderer, width, 32);
      await wb.t.renderOnce();
      noOverflow(wb.t.captureCharFrame(), width);
      assert.match(wb.t.captureCharFrame(), /Press esc again to interrupt/);
    }
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, [original]);
    wb.control.setRun(initial);
    await press(wb.t, wb.renderer, "escape");
    wb.control.setRun(liveRun({ actionOffers: [] }));
    await wb.t.renderOnce();
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /Press esc again to interrupt/,
    );
    wb.control.setRun(initial);
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, [original]);
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(received, [original, original]);
  });
}

// The Workbench answers an authored free-text Gate; approve-reject keeps the
// headless path (run-gate-control.tsx), covered by tests/headless/run.test.ts.
test("[repeat-command-gate-progress] the Workbench answers the Gate after a passing Repeat and an outside Command, re-running no Command (#384)", async (context) => {
  const { process, runs } = countingBundleProcess();
  const catalog = openCatalog(makeTempDir("secant-wb-progress-home-"));
  context.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-wb-progress-ws-"));
  const runGroup = openFakeRunGroup(
    makeTempDir("secant-wb-progress-store-"),
    workspace,
  );
  context.after(() => runGroup.close());
  const app = createApplication({
    process,
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process,
      }),
  });
  context.after(() => app.shutdown());
  const bundle = writeRoutingBundle({
    id: "dev.secant.repeat-command-gate",
    routing: repeatCommandGateRouting("free-text"),
  });
  assert.ok(app.bundleManagement.build(bundle.folder, { noInstall: false }).ok);
  const digest = catalog.listEntries().find((e) => e.id === bundle.id)!.digest;
  catalog.approveWorkspace(workspace, new Date());
  const launched = app.projectionPort.submit({
    operationId: "launch",
    operation: "launch-run",
    input: { bundle: { id: bundle.id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(launched.admitted);
  await awaitSettled(app.projectionPort, "launch");
  const runId = launched.runId!;

  const renderer = makeFakeRenderer(140, 40);
  const { t } = await mountApp(
    { view: createLiveRunWorkbenchView(app.projectionPort) },
    renderer,
    runId,
    140,
    40,
  );
  await t.waitForFrame((frame) => frame.includes("Workflow decision ·"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Workflow decision · approve the outside change/);
  // The sidebar lists every Step by glyph, the gate current (ADR 0036).
  for (const step of [
    /✓ baseline/,
    /✓ check/,
    /✓ outside/,
    /▸ ⏸ gate/,
    /· after/,
  ])
    assert.match(frame, step);
  assert.deepEqual(runs, { baseline: 1, check: 1, outside: 1 });

  await type(t, "ship it");
  await press(t, renderer, "return");
  const done = await followRun(app.projectionPort, runId, (run) =>
    run.state === "succeeded" ? run : undefined,
  );
  assert.deepEqual(
    done.progress.map((step) => `${step.id}:${step.status}`),
    [
      "baseline:succeeded",
      "check:succeeded",
      "outside:succeeded",
      "gate:succeeded",
      "after:succeeded",
    ],
  );
  assert.deepEqual(runs, { baseline: 1, check: 1, outside: 1, after: 1 });
  await t.waitForFrame((next) => next.includes("Run succeeded"));
});

for (const discovery of ["palette", "themes"] as const) {
  for (const interaction of ["request", "gate"] as const) {
    test(`m10-home-and-preferences: new ${interaction} preempts ${discovery}, deliberate palette reopens and owns keys`, async () => {
      const wb = await mountWorkbench(
        runOf({ state: "running", actionOffers: [INTERRUPT_OFFER] }),
        100,
        40,
        okActions(),
        true,
        0,
        previewPreferences(),
      );
      if (discovery === "themes") {
        await openAppThemes(wb);
        await type(wb.t, "nord");
      } else await press(wb.t, wb.renderer, "p", { ctrl: true });
      if (interaction === "request") wb.control.setLive(requestOverlay());
      else wb.control.setRun(freeTextRunOf());
      await wb.t.renderOnce();
      assert.doesNotMatch(
        wb.t.captureCharFrame(),
        /Themes · .+ · nord|App commands/,
      );
      assert.match(
        wb.t.captureCharFrame(),
        interaction === "request"
          ? /Permission required/
          : /What is the ticket number/,
      );
      await press(wb.t, wb.renderer, "p", { ctrl: true });
      assert.match(wb.t.captureCharFrame(), /App commands/);
      await type(wb.t, "Quit");
      await press(wb.t, wb.renderer, "return"); // nothing selected; no answer or Quit
      assert.deepEqual(wb.control.requests, []);
      assert.deepEqual(wb.control.texts, []);
      assert.deepEqual(wb.exits, []);
      await press(wb.t, wb.renderer, "escape");
      assert.doesNotMatch(wb.t.captureCharFrame(), /App commands/);
      if (interaction === "request") {
        await press(wb.t, wb.renderer, "return");
        assert.deepEqual(wb.control.requests, [
          { requestId: "req-1", generation: 3, decision: "allow" },
        ]);
      } else {
        await type(wb.t, "409");
        await press(wb.t, wb.renderer, "return");
        assert.deepEqual(wb.control.texts, [
          { gate: FREE_TEXT_GATE, text: "409" },
        ]);
      }
    });
  }
}

test("m10-home-and-preferences: palette End Step follows the key's confirmation and current Offer", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "keep draft");
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  const palette = wb.t.captureCharFrame();
  assert.match(palette, /End Step \(ctrl\+e\)/);
  assert.doesNotMatch(
    palette,
    /Start a Run|Workflow Bundles|Previous Runs|Harnesses/,
  );
  await type(wb.t, "End Step");
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /End this interactive Step/);
  assert.deepEqual(wb.control.ends, []);
  assert.deepEqual(wb.control.sends, []);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /> keep draft/);
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> keep draft!/);
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, "End Step");
  await press(wb.t, wb.renderer, "down");
  wb.control.setRun(interactiveRunOf({ actionOffers: [SEND_OFFER] }));
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.ends, []);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step/);
});

test("m10-home-and-preferences: palette guarded Quit keeps inspection and its focus on dismissal", async () => {
  const wb = await mountInspectable(1);
  await INSPECTIONS[0].open(wb);
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, "Quit");
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /Halt 1 live Run and quit/);
  wb.t.mockInput.pressEnter();
  await wb.t.renderOnce();
  assert.deepEqual(wb.exits, []);
  assert.match(wb.t.captureCharFrame(), /esc close · q quit/);
});

for (const command of ["Model", "Effort"] as const) {
  test(`m10-home-and-preferences: ${command} in the palette opens the working choice picker over a Gate`, async () => {
    const wb = await mountWorkbench(
      freeTextRunOf({ actionOffers: [FREE_TEXT_OFFER, MODEL_OFFER] }),
    );
    await type(wb.t, "keep answer");
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    const frame = wb.t.captureCharFrame();
    for (const name of ["Model", "Effort", "Themes", "Quit"])
      assert.match(frame, new RegExp(name));
    assert.doesNotMatch(frame, /End Step|Continue \(ctrl/);
    await type(wb.t, command);
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      command === "Model" ? /Choose a model/ : /Choose effort/,
    );
    assert.deepEqual(wb.control.texts, []);
    // Escape from effort first returns to model; the next closes the picker.
    if (command === "Effort") await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "escape");
    await type(wb.t, "!");
    assert.match(wb.t.captureCharFrame(), /keep answer!/);
  });
}

test("m10-home-and-preferences: palette and keys share refusal cleanup when arming End Step", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "return");
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "stale-send",
      explanation: "stale send",
      remediation: "Try again",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /stale send/);
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await type(wb.t, "End Step");
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /End this interactive Step/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /stale send/);
  assert.deepEqual(wb.control.ends, []);
});

// --- m10-workbench-interaction: one bottom interaction (#419, H1) -----------

// Exactly one control holds the bottom region (ADR 0036): the prompt, a Harness
// Request, a Human Gate, a Review checkpoint, or a finished Run's outcome. Each
// state below asserts what that one resolved interaction drives — the visible
// control, the field that takes text, the App commands on offer, the key
// recipient, and the rows it occupies — at two sizes and through a resize of both
// the renderer and the Renderer Port. Row accounting is exact: the control's first
// row sits where the counted rows put it, directly over the bottom padding.

/** The palette's command names, read by opening and closing it over the Port. */
async function paletteCommands(
  wb: Awaited<ReturnType<typeof mountWorkbench>>,
): Promise<string[]> {
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  const frame = wb.t.captureCharFrame();
  await press(wb.t, wb.renderer, "escape");
  return [
    "Model",
    "Effort",
    "End Step",
    "Continue",
    "End Stage",
    "Themes",
    "Quit",
  ].filter((name) => new RegExp(`\\b${name}\\b`).test(frame));
}

for (const [width, height] of [
  [100, 30],
  [48, 18],
] as const) {
  test(`m10-workbench-interaction: one resolved interaction drives control, field, commands, key recipient and rows at ${width}x${height}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER, END_OFFER, MODEL_OFFER] }),
      width,
      height,
    );
    const last = height - 2; // the last interior row, over the bottom padding
    // The interactive Step's Agent-bearing Run reserves two metadata slots
    // (#418) under the status row, above every bottom control.

    // Prompt: the field, meta row and hint hold three rows; text reaches it.
    let frame = wb.t.captureCharFrame();
    assert.equal(rowOf(frame, /^ > /), last - 2);
    assert.match(frame, /enter send Turn · \^E end step/);
    // An armed End Step wraps its whole consequence; the counted rows grow with it.
    await press(wb.t, wb.renderer, "e", { ctrl: true });
    frame = wb.t.captureCharFrame();
    // Field, meta row, then the warning's wrapped rows down to the last interior
    // row: nothing clipped below, no blank row left over.
    assert.equal(
      rowOf(frame, /⚠ End this interactive Step/),
      rowOf(frame, /^ > /) + 2,
    );
    assert.match(frame.split("\n")[last]!, /Run\.\s*$/);
    assert.equal(frame.split("\n")[last + 1]!.trim(), "");
    await press(wb.t, wb.renderer, "escape");
    assert.deepEqual(await paletteCommands(wb), [
      "Model",
      "Effort",
      "End Step",
      "Themes",
      "Quit",
    ]);
    await type(wb.t, "kept");
    assert.match(wb.t.captureCharFrame(), /^ > kept/m);

    // Harness Request: five rows; it owns printable keys and Enter.
    wb.control.setLive(requestOverlay());
    await wb.t.renderOnce();
    frame = wb.t.captureCharFrame();
    assert.equal(rowOf(frame, /△ Permission required/), last - 4);
    assert.doesNotMatch(frame, /^ > /m); // no prompt beneath it
    assert.deepEqual(await paletteCommands(wb), [
      "Model",
      "Effort",
      "Themes",
      "Quit",
    ]);
    await type(wb.t, "zz");
    await press(wb.t, wb.renderer, "e", { ctrl: true });
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.requests, [
      { requestId: "req-1", generation: 3, decision: "allow" },
    ]);
    assert.deepEqual(wb.control.sends, []);
    assert.deepEqual(wb.control.ends, []);
    // The request held the same Step's bottom, so the draft survives it.
    wb.control.setLive(undefined);
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /^ > kept/m);

    // Human Gate: four rows; typed text reaches the gate's own field.
    wb.control.setRun(
      freeTextRunOf({ actionOffers: [FREE_TEXT_OFFER, MODEL_OFFER] }),
    );
    await wb.t.renderOnce();
    frame = wb.t.captureCharFrame();
    assert.equal(rowOf(frame, /◆ Workflow decision/), last - 3);
    await type(wb.t, "351");
    assert.match(wb.t.captureCharFrame(), /^ {3}> 351/m);
    assert.deepEqual(await paletteCommands(wb), [
      "Model",
      "Effort",
      "Themes",
      "Quit",
    ]);
    await press(wb.t, wb.renderer, "return");
    assert.equal(wb.control.texts[0]?.text, "351");
    assert.deepEqual(wb.control.sends, []);
    // Authored suggestions add the choice row: five rows.
    wb.control.setRun(suggestedRunOf());
    await wb.t.renderOnce();
    assert.equal(
      rowOf(wb.t.captureCharFrame(), /◆ Workflow decision/),
      last - 4,
    );

    // Review checkpoint: seven rows; Enter answers it, never the prompt.
    wb.control.setRun(
      blockedRunOf({ actionOffers: [ANSWER_OFFER, MODEL_OFFER] }),
    );
    await wb.t.renderOnce();
    frame = wb.t.captureCharFrame();
    assert.equal(rowOf(frame, /Review checkpoint ·/), last - 6);
    await type(wb.t, "x");
    await press(wb.t, wb.renderer, "return");
    assert.equal(wb.control.answers[0]?.answer, "continue");
    assert.deepEqual(wb.control.sends, []);

    // Finished: the outcome's three rows; only Themes and Quit remain.
    wb.control.setRun(runOf({ state: "succeeded", actionOffers: [] }));
    await wb.t.renderOnce();
    frame = wb.t.captureCharFrame();
    assert.equal(rowOf(frame, /✓ Run succeeded/), last - 2);
    assert.deepEqual(await paletteCommands(wb), ["Themes", "Quit"]);

    // The gate and checkpoint were other Steps: a fresh input target, so the
    // departed Step's draft never moves into them or back (decision 29). A new
    // draft keeps exact rows through a resize of both the renderer and the Port.
    wb.control.setRun(interactiveRunOf());
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /kept/);
    await type(wb.t, "fresh");
    const other = width === 100 ? 48 : 100;
    resizeWorkbench(wb.t, wb.renderer, other, height);
    await wb.t.renderOnce();
    frame = wb.t.captureCharFrame();
    noOverflow(frame, other);
    assert.equal(rowOf(frame, /^ > fresh/), last - 2);
  });
}

test("m10-workbench-interaction: a request preempts the prompt and picker, owns Escape and printable keys, and a deliberately reopened palette dismisses back to it", async () => {
  let interrupted = 0;
  const wb = await mountWorkbench(
    steerableInteractiveRunOf({
      actionOffers: [
        INTERRUPT_OFFER,
        AVAILABLE_STEER_OFFER,
        CANCEL_OFFER,
        MODEL_OFFER,
      ],
    }),
    100,
    30,
    okActions({
      interrupt: () => {
        interrupted += 1;
        return () => ({ kind: "ok" });
      },
    }),
  );
  await type(wb.t, "draft");
  await openModelChoice(wb.t, wb.renderer);
  assert.match(wb.t.captureCharFrame(), /Choose a model/);

  // The request arrives: the picker closes, and the request owns every key.
  wb.control.setLive(requestOverlay());
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
  for (const key of ["q", "s", "y", "x"]) await press(wb.t, wb.renderer, key);
  await type(wb.t, "typed");
  assert.doesNotMatch(wb.t.captureCharFrame(), /draftt|typed/);

  // Deliberate Ctrl+P reopens the permitted commands over it; Escape dismisses
  // the palette alone and returns the keys to the request.
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /Change the Run model/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End Step|End Stage/);
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /App commands/);
  assert.deepEqual(wb.control.requests, []);
  assert.match(wb.t.captureCharFrame(), /Permission required/);

  // The request's Escape denies once; it never arms or dispatches the Interrupt,
  // and nothing was sent or steered underneath.
  await press(wb.t, wb.renderer, "escape");
  assert.deepEqual(wb.control.requests, [
    { requestId: "req-1", generation: 3, decision: "deny" },
  ]);
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again/);
  assert.equal(interrupted, 0);
  assert.deepEqual(wb.control.steers, []);
  assert.deepEqual(wb.control.sends, []);

  // Once it clears, the prompt has its draft and the two-press Interrupt back,
  // and an Escape that closes a dialog over the prompt arms nothing.
  wb.control.setLive(undefined);
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /^ > draft/m);
  await press(wb.t, wb.renderer, "p", { ctrl: true });
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again/);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Press esc again/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(interrupted, 1);
});

test("m10-workbench-interaction: Ctrl+C clears a nonempty draft even while details hold focus, then requests guarded Quit", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 100, 30);
  await type(wb.t, "keep me?");
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /› Details/);
  await press(wb.t, wb.renderer, "c", { ctrl: true });
  assert.deepEqual(wb.exits, []);
  assert.doesNotMatch(wb.t.captureCharFrame(), /keep me\?/);
  await press(wb.t, wb.renderer, "c", { ctrl: true });
  assert.equal(wb.exits.length, 1);
});

test("m10-workbench-interaction: an interrupted interactive Turn leaves an explicit waiting note until a later Turn settles (story 75)", async () => {
  const interrupted = interactiveRunOf({
    timeline: [
      { at: "T1", event: "turn-started", turnKind: "interactive-agent" },
      {
        at: "T2",
        event: "turn-settled",
        detail: "interrupted",
        turnKind: "interactive-agent",
      },
    ],
  });
  const wb = await mountWorkbench(interrupted, 60, 24);
  assert.match(
    wb.t.captureCharFrame(),
    /◇ You stopped the agent — it is waiting on/,
  );
  wb.control.setRun(
    interactiveRunOf({
      timeline: [
        ...interrupted.timeline,
        {
          at: "T3",
          event: "turn-settled",
          detail: "completed",
          turnKind: "interactive-agent",
        },
      ],
    }),
  );
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /You stopped the agent/);
});

test("m10-workbench-interaction: an Esc pair that straddles its Turn's end never leaves the Workbench", async () => {
  let interrupted = 0;
  const wb = await mountWorkbench(
    liveInteractiveRunOf(),
    100,
    30,
    okActions({
      interrupt: () => {
        interrupted += 1;
        return () => ({ kind: "ok" });
      },
    }),
  );
  await press(wb.t, wb.renderer, "escape"); // arm
  wb.control.setRun(interactiveRunOf()); // the Turn ends under the arm
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again/);
  await press(wb.t, wb.renderer, "escape"); // the second half: consumed
  assert.ok(onWorkbench(wb.t.captureCharFrame()));
  assert.equal(interrupted, 0);
  await press(wb.t, wb.renderer, "escape"); // a deliberate Esc at the boundary
  assert.match(wb.t.captureCharFrame(), /Start a Run/);
});

test("m10-confirmation-target-identity: a request preempting an armed cancel clears it, so a later y dispatches nothing", async () => {
  let cancelled = 0;
  const wb = await mountWorkbench(
    runOf({ state: "running", actionOffers: [CANCEL_OFFER] }),
    100,
    40,
    okActions({
      cancel: () => {
        cancelled += 1;
        return () => ({ kind: "ok" });
      },
    }),
  );
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  await press(wb.t, wb.renderer, "c");
  assert.match(wb.t.captureCharFrame(), /Cancel ends the Run/);
  wb.control.setLive(requestOverlay());
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /Cancel ends the Run/);
  wb.control.setLive(undefined);
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "y");
  assert.equal(cancelled, 0);
});

test("m12-local-test-helpers: the sidebar names a requested Model choice until its receipt settles", async () => {
  const [outcome, setOutcome] = createSignal<RunActionOutcome>({
    kind: "pending",
  });
  const wb = await mountModelChoice({
    offer: MODEL_OFFER,
    run: { selectedHarness: "codex", modelChoice: MODEL_OFFER.currentChoice },
    width: 140,
    actions: okActions({ changeModelChoice: () => outcome }),
  });
  await openModelChoice(wb.t, wb.renderer);
  await press(wb.t, wb.renderer, "down");
  await press(wb.t, wb.renderer, "return");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /→ requested deep · medium effort/);
  setOutcome({
    kind: "ok",
    modelChoiceChange: {
      choice: { model: "deep", effort: "medium" },
      reach: "next-turn",
    },
  });
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /→ requested/);
});
