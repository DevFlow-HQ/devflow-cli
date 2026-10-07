import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignal } from "solid-js";
import type { AnswerOutcome, RunActionOutcome } from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import type {
  RunTimelineEvent,
  RunView,
  WorkspacePathSearch,
  WorkspacePathQuery,
} from "../../src/application/projection-port.js";
import {
  resizeWorkbench,
  makeRunView,
  snapshotOf,
  runOf,
  events,
  wrappingEvents,
  onWorkbench,
  workbenchShown,
  ANSWER_OFFER,
  blockedRunOf,
  mountApp,
  mountWorkbench,
  press,
  type,
  noOverflow,
  RESUME_OFFER,
  CANCEL_OFFER,
  okActions,
  SEND_OFFER,
  END_OFFER,
  interactiveRunOf,
  requestOverlay,
  INTERRUPT_OFFER,
  STEER_OFFER,
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
  openModelChoice,
  rowOf,
} from "./run-workbench-fixture.js";

test("m10-audit-workbench-test-domains: the interactive input takes the human's text and Enter sends one Turn (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  // Focus is on the native field during the Step; the human's text rides the mock
  // input, while Enter to send comes over the Port dispatcher (D9).
  await type(wb.t, "hi");
  assert.match(wb.t.captureCharFrame(), /> hi/);

  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "hi" },
  ]);
});

test("a blank interactive Turn is not sent (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  // Enter with an empty draft sends nothing; a whitespace-only draft is the same.
  await press(wb.t, wb.renderer, "return");
  await press(wb.t, wb.renderer, "space");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 0);
});

test("m10-workbench-interaction: a pending send clears immediately, keeps native editing and never sends its capture twice (#420)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "hi");
  await press(wb.t, wb.renderer, "return");
  assert.doesNotMatch(wb.t.captureCharFrame(), /> hi|sending/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 1);
  await type(wb.t, "next");
  assert.match(wb.t.captureCharFrame(), /> next/);
  wb.control.setInteractiveOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /> next/);
});

test("an applied send leaves the immediately cleared draft and newer text intact while the agent works (#290, #420)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 100, 40, okActions());
  await type(wb.t, "hi there");
  await press(wb.t, wb.renderer, "return");
  assert.doesNotMatch(wb.t.captureCharFrame(), /sending|> hi there/);
  await type(wb.t, "new draft");

  // Admission: the Run push carries the live Turn first, then the send settles applied.
  wb.control.setRun(liveInteractiveRunOf());
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /> new draft/);
  wb.control.setInteractiveOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  let frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /hi there/); // the draft went with the admitted Turn
  assert.doesNotMatch(frame, /sending/); // nothing lingers for the Turn's length
  assert.match(frame, /> new draft/);
  assert.match(frame, /esc esc interrupt/);

  await press(wb.t, wb.renderer, "c", { ctrl: true });
  await type(wb.t, "next");
  assert.match(wb.t.captureCharFrame(), /> next/);
  // ...and when the Turn ends the move returns to the human with that draft intact.
  wb.control.setRun(interactiveRunOf());
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /working/);
  assert.match(frame, /enter send Turn/);
  assert.match(frame, /> next/);
  assert.equal(wb.control.sends.length, 1);
});

test("at a Turn boundary the interactive Esc still leaves the Workbench (#219)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Secant/);
});

test("a draft longer than a narrow input stays in bounds and clears at Enter (#290, #420)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 48, 24, okActions());
  const long = "draft ".repeat(40).trim(); // far wider than the 48-column input
  await type(wb.t, long);
  noOverflow(wb.t.captureCharFrame(), 48);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: long },
  ]);

  wb.control.setRun(liveInteractiveRunOf());
  wb.control.setInteractiveOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /draft/);
  assert.doesNotMatch(frame, /sending/);
  assert.match(frame, /◆ The agent is working/);
  noOverflow(frame, 48);
});

test("a refused send surfaces the refusal and keeps the typed draft (#122, A9, #290)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 48, 24);
  await type(wb.t, "hi");
  await press(wb.t, wb.renderer, "return");
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "interactive-turn-not-admitted",
      explanation:
        "Run run-1 did not admit the interactive Turn; the text was not sent to the agent.",
      remediation: "send it again",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  // The reason is said in words, clipped to the width rather than overflowing it.
  assert.match(frame, /✗ Run run-1 did not admit the/);
  noOverflow(frame, 48);
  // The refusal restores text and the field keeps focus (A9). No Turn was admitted.
  assert.match(frame, /> hi/);
  assert.doesNotMatch(frame, /sending|working/);
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> hi!/);
});

test("a reserved-word refusal keeps the draft and focus through small terminals and resize (#358, #23)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 100, 24);
  assert.match(wb.t.captureCharFrame(), /enter send Turn/);
  await type(wb.t, "/clear");
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "/clear" },
  ]);
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "harness-input-reserved",
      explanation:
        "/clear is reserved by Claude Code; Secant owns the conversation, Model choice, or permission change it requests.",
      remediation:
        "Use Secant's controls for these changes, or send text with a different first word.",
      possibleEffects: "none",
    },
  });
  for (const width of [100, 48, 60, 140]) {
    resizeWorkbench(wb.t, wb.renderer, width, 24);
    await wb.t.renderOnce();
    const frame = wb.t.captureCharFrame();
    assert.match(frame, /✗ \/clear is reserved by Claude Code/);
    assert.match(frame, /> \/clear/);
    assert.doesNotMatch(frame, /sending|working/);
    noOverflow(frame, width);
  }
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> \/clear!/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends[1], {
    runId: "run-1",
    stepId: "discuss",
    text: "/clear!",
  });
});

test("the interactive input reads without colour and fits a narrow terminal (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 48, 24);
  const frame = wb.t.captureCharFrame();
  // The Step and its controls read from glyphs and words, not colour.
  assert.match(frame, /◇ Your move/);
  assert.match(frame, /enter send Turn · \^E end step/);
  noOverflow(frame, 48);
});

// AC3: free-text gate ----------------------------------------------

test("a free-text gate shows a text input in place of the footer", async () => {
  const { t } = await mountWorkbench(freeTextRunOf());
  const frame = t.captureCharFrame();
  assert.match(frame, /Workflow decision · What is the ticket number\?/);
  assert.match(frame, /Answer published as: ticket/);
  assert.match(frame, /enter submit · esc back/);
  assert.doesNotMatch(frame, /d details · end latest/); // footer replaced
});

test("typing then Enter dispatches answer-human-gate with the typed text against the gate", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  await type(t, "fix 42"); // text rides the native field via the mock input (D9)
  assert.match(t.captureCharFrame(), /> fix 42/); // field echoes the value
  await press(t, renderer, "return"); // Enter to submit comes over the Port dispatcher
  assert.equal(control.texts.length, 1);
  assert.equal(control.texts[0]?.text, "fix 42");
  assert.deepEqual(control.texts[0]?.gate, FREE_TEXT_GATE);
});

test("the free-text field takes capitals and punctuation verbatim (D9) — fails at HEAD", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  // At HEAD the hand-rolled buffer lowercased capitals and dropped shifted symbols, so
  // `ABC-1!.` arrived `abc-1!.`; the native field carries the exact text.
  await type(t, "ABC-1!.");
  assert.match(t.captureCharFrame(), /> ABC-1!\./);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "ABC-1!.");
});

test("a bracketed paste and a word delete edit the free-text field natively (D9)", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  await t.mockInput.pasteBracketedText("fix issue");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /> fix issue/); // the paste landed whole
  // Ctrl+Backspace deletes the last word — reachable only through the native field.
  t.mockInput.pressBackspace({ ctrl: true });
  await t.renderOnce();
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "fix ");
});

test("the interactive field takes capitals and punctuation verbatim (D9) — fails at HEAD", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "ABC-1!.");
  assert.match(wb.t.captureCharFrame(), /> ABC-1!\./);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "ABC-1!." },
  ]);
});

test("a capital typed as a shifted key reaches the interactive field as uppercase (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  wb.t.mockInput.pressKey("a", { shift: true });
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "A" },
  ]);
});

test("an empty free-text submission is refused locally without dispatching", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  await press(t, renderer, "return"); // nothing typed
  assert.equal(control.texts.length, 0);
  assert.match(t.captureCharFrame(), /cannot be empty/);
  // Backspace on an empty buffer stays empty and still refuses.
  await press(t, renderer, "backspace");
  await press(t, renderer, "return");
  assert.equal(control.texts.length, 0);
});

test("the free-text gate control fits small widths without overflow and reads without colour", async () => {
  const { t, renderer } = await mountWorkbench(freeTextRunOf(), 100, 30);
  noOverflow(t.captureCharFrame(), 100);
  resizeWorkbench(t, renderer, 40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Workflow decision/);
  assert.match(frame, /enter submit/);
});

test("a suggested gate lists its suggestions beside Other, with Other chosen until the human picks (#213)", async () => {
  const { t } = await mountWorkbench(suggestedRunOf());
  const frame = t.captureCharFrame();
  assert.match(frame, /Workflow decision · Where should the spec live\?/);
  assert.match(frame, /Choose: Local · GitHub · \[Other \(type\)\]/);
  assert.match(frame, /↑↓ choose or type · enter submit/);
});

test("down picks a suggestion into the field and Enter submits it as the gate's text answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await press(t, renderer, "down");
  assert.match(t.captureCharFrame(), /Choose: \[Local\] · GitHub/);
  assert.match(t.captureCharFrame(), /> Local/);
  await press(t, renderer, "down");
  assert.match(t.captureCharFrame(), /Choose: Local · \[GitHub\]/);
  await press(t, renderer, "return");
  assert.equal(control.texts.length, 1);
  assert.equal(control.texts[0]?.text, "GitHub");
  assert.deepEqual(control.texts[0]?.gate, FREE_TEXT_GATE);
});

test("up wraps to the last suggestion, and cycling back to Other restores the typed answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await type(t, "Linear");
  await press(t, renderer, "up");
  assert.match(t.captureCharFrame(), /\[GitHub\]/);
  assert.match(t.captureCharFrame(), /> GitHub/);
  await press(t, renderer, "down"); // past the last suggestion: back to Other
  assert.match(t.captureCharFrame(), /\[Other \(type\)\]/);
  assert.match(t.captureCharFrame(), /> Linear/);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "Linear");
});

test("editing a picked suggestion turns it into a typed Other answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await press(t, renderer, "down");
  await type(t, " Enterprise");
  assert.match(t.captureCharFrame(), /\[Other \(type\)\]/);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "Local Enterprise");
});

test("the suggested gate control fits small widths without overflow (#213)", async () => {
  const { t, renderer } = await mountWorkbench(suggestedRunOf(), 100, 30);
  noOverflow(t.captureCharFrame(), 100);
  resizeWorkbench(t, renderer, 40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Choose:/);
  assert.match(frame, /enter submit/);
});

// AC4: interrupt, steer, resume ------------------------------------

test("an unavailable Steer says why at Enter in the Agent-step prompt and has no dispatch (ADR 0036)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    okActions(),
  );
  assert.match(t.captureCharFrame(), /◆ The agent is working — wait/);
  assert.doesNotMatch(t.captureCharFrame(), /enter steer/);
  // A bare `s` is text now; Enter names the Offer's exact reason and keeps it.
  await press(t, renderer, "s");
  await type(t, "s");
  await press(t, renderer, "return");
  assert.equal(control.steers.length, 0);
  assert.match(
    t.captureCharFrame(),
    /✗ steer unavailable · Claude Code has no same-Turn steer/,
  );
  assert.match(t.captureCharFrame(), /> s/);
});

function steerableRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "running",
    progress: [{ id: "repair", kind: "agent", status: "running" }],
    actionOffers: [INTERRUPT_OFFER, AVAILABLE_STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("an available Steer rides the Agent-step prompt: Enter sends the guidance to the live Turn (#148, ADR 0036)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  // The prompt says the agent works and that Enter steers, readable without colour.
  assert.match(
    wb.t.captureCharFrame(),
    /◆ The agent is working — a message steers/,
  );
  assert.match(wb.t.captureCharFrame(), /enter steer · esc esc interrupt/);

  // The guidance rides the native field; Enter sends exactly one steer at the live turnId.
  await type(wb.t, "wrap it up");
  assert.match(wb.t.captureCharFrame(), /> wrap it up/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "wrap it up" },
  ]);
});

test("blank Steer guidance is not sent, and Esc arms the Interrupt rather than sending (#148)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  // Enter with an empty draft authors nothing.
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 0);
  await type(wb.t, "   ");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 0);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Press esc again to interrupt/);
  assert.equal(wb.control.steers.length, 0);
});

test("a refused Steer keeps the typed guidance and surfaces the refusal (#148)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());

  await type(wb.t, "keep going");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: {
      code: "steer-rejected",
      explanation: "The live Turn rejected the guidance.",
      remediation: "Steer the next live Turn.",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  // The draft survives a refusal (A9-style), and the refusal replaces the hint line.
  assert.match(frame, /> keep going/);
  assert.match(frame, /The live Turn rejected the guidance/);
});

test("a still-pending Agent-step Steer never freezes the prompt, ignores a second Enter, and keeps newer text (#148, #294)", async () => {
  // The default steer outcome stays `pending` until the test settles it.
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  await type(wb.t, "first guidance");
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "first guidance" },
  ]);
  // The field keeps its keys while the Steer settles; Enter in flight is ignored.
  await type(wb.t, " more");
  assert.match(wb.t.captureCharFrame(), /> {2}more/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 1);
  // Admission leaves the separately typed draft intact.
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /> {2}more/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers[1], {
    runId: "run-1",
    turnId: "turn-7",
    text: " more",
  });
});

test("the Agent-step prompt stays within a narrow terminal and relays out on resize (#148)", async () => {
  const { t, renderer } = await mountWorkbench(
    steerableRunOf(),
    40,
    24,
    okActions(),
  );
  // A long guidance draft cannot push any line past the width.
  await type(
    t,
    "please wrap up the current change and stop before touching anything else",
  );
  noOverflow(t.captureCharFrame(), 40);
  resizeWorkbench(t, renderer, 80, 24);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 80);
});

/** A long unavailable-steer evidence, wider than any terminal under test. */
const LONG_STEER_REASON =
  "This Harness has no same-Turn guidance frame: a further user message would queue as the next Turn, so steer is rejected unsupported and never emulated.";

test("Enter in the interactive input steers a live Turn with the draft, with no pending state (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  let frame = wb.t.captureCharFrame();
  // The hint names Enter beside the Interrupt, led by the scanner; the rail stays
  // without a Steer row, since the input carries the controls.
  assert.match(
    frame,
    /^ {3}[■⬝]{8} enter steer · esc esc interrupt — stop the live Turn/m,
  );
  assert.doesNotMatch(frame, /s steer —|Steer — guide/);

  await type(wb.t, "focus on the tests");
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "focus on the tests" },
  ]);
  assert.equal(wb.control.sends.length, 0);
  // In flight, nothing lingers: no steering hint, and a second Enter is ignored
  // rather than sending the draft again.
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /steering|sending/);
  assert.match(frame, /enter steer · esc esc interrupt/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 1);

  // Admission keeps the already-cleared draft and the Turn working.
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /focus on the tests/);
  assert.match(frame, /◆ The agent is working/);
  assert.match(frame, /enter steer · esc esc interrupt/);
});

/** The Problems Steer admission refuses a Claude Code Steer with (#359), as the
 *  Application words them. */
const CLAUDE_STEER_REFUSALS = [
  {
    text: "/clear the slate",
    shown: /✗ \/clear is reserved by Claude Code/,
    problem: {
      code: "harness-input-reserved",
      explanation:
        "/clear is reserved by Claude Code; Secant owns the conversation, Model choice, or permission change it requests.",
      remediation:
        "Use Secant's controls for these changes, or send text with a different first word.",
      possibleEffects: "none",
    },
  },
  {
    text: "/compact",
    shown: /✗ Send \/compact when the Turn ends/,
    problem: {
      code: "steer-session-command",
      explanation:
        "Send /compact when the Turn ends: Claude Code runs its commands after the Turn, not inside it.",
      remediation:
        "Wait for the Turn to end and send it as the next Turn, or Interrupt the Turn first.",
      possibleEffects: "none",
    },
  },
] as const;

test("a Claude Code Steer shows each refusal reason and keeps its draft and focus through small terminals and resize (#359, #23)", async () => {
  for (const refusal of CLAUDE_STEER_REFUSALS) {
    const wb = await mountWorkbench(
      steerableInteractiveRunOf({ selectedHarness: "claude-code" }),
      100,
      24,
      okActions(),
    );
    await type(wb.t, refusal.text);
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.steers, [
      { runId: "run-1", turnId: "turn-7", text: refusal.text },
    ]);
    wb.control.setSteerOutcome({ kind: "refused", problem: refusal.problem });
    for (const width of [100, 48, 60, 140]) {
      resizeWorkbench(wb.t, wb.renderer, width, 24);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      // The reason leads with what to do, in words and the ✗ glyph, so it
      // survives a narrow clip and reads without colour.
      assert.match(frame, refusal.shown, `${refusal.problem.code} @${width}`);
      assert.ok(frame.includes(`> ${refusal.text}`), `draft @${width}`);
      // The refusal sits above the working hint, which still offers its keys.
      assert.match(frame, /enter steer · esc esc interrupt/);
      noOverflow(frame, width);
    }
    // Focus stays in the input: typing extends the kept draft, and Enter steers
    // the edited text.
    await type(wb.t, "!");
    assert.ok(wb.t.captureCharFrame().includes(`> ${refusal.text}!`));
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.steers[1], {
      runId: "run-1",
      turnId: "turn-7",
      text: `${refusal.text}!`,
    });
  }
});

test("the Agent-step prompt shows a Session-command Steer refusal and keeps the guidance (#359)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 48, 24, okActions());
  await type(wb.t, "/compact");
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "/compact" },
  ]);
  const [, sessionCommand] = CLAUDE_STEER_REFUSALS;
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: sessionCommand.problem,
  });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /enter steer · esc esc interrupt|esc esc int/);
  assert.match(frame, /> \/compact/);
  assert.match(frame, /Send \/compact when the Turn ends/);
  noOverflow(frame, 48);
});

test("text typed while an interactive Steer settles survives its applied outcome (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  await type(wb.t, "check the logs");
  await press(wb.t, wb.renderer, "return");
  // The field keeps its keys in flight, so the human can draft more guidance...
  await type(wb.t, " and then");
  assert.match(wb.t.captureCharFrame(), /> {2}and then/);
  // ...which is theirs, not the sent Steer's, so the applied outcome leaves it.
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /> {2}and then/);
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "check the logs" },
  ]);
});

test("a Steer still settling when its Turn ends holds back the send until it settles (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  await type(wb.t, "late guidance");
  await press(wb.t, wb.renderer, "return");
  wb.control.setRun(interactiveRunOf());
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /enter send Turn/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 0);

  // The late Steer is refused against the ended Turn: the draft stays, and Enter now
  // sends it as the next Turn.
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: {
      code: "turn-control-rejected",
      explanation: "The Turn had already ended.",
      remediation: "Send it as the next Turn.",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /✗ The Turn had already ended/);
  assert.match(frame, /Late Steer · text restored to draft/);
  assert.match(frame, /> late guidance/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "late guidance" },
  ]);
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /already ended/);
});

test("a blank draft is not steered and a bare `s` types into the interactive input (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
  );
  await press(wb.t, wb.renderer, "return");
  await type(wb.t, "   ");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 0);
  assert.doesNotMatch(wb.t.captureCharFrame(), /✗/);

  // `s` is text here: it never opens the Agent step's Steer box.
  wb.renderer.key("s");
  await type(wb.t, "s");
  const frame = wb.t.captureCharFrame();
  assert.match(frame, />\s+s/);
  assert.doesNotMatch(frame, /Steer — guide the running Turn/);
});

test("a refused interactive Steer keeps the draft, and arming the Interrupt clears the refusal (#294)", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    actions,
  );

  await type(wb.t, "keep going");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: {
      code: "steer-rejected",
      explanation: "The live Turn rejected the guidance.",
      remediation: "Steer the next live Turn.",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /✗ The live Turn rejected the guidance/);
  assert.match(frame, /> keep going/);

  // The Interrupt stays reachable: the first Esc arms, clearing the refusal so the
  // confirm shows, and the second dispatches.
  await press(wb.t, wb.renderer, "escape");
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /✗/);
  assert.match(frame, /⚠ Press esc again to interrupt/);
  await press(wb.t, wb.renderer, "escape");
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
});

test("an unavailable Steer shows its reason at Enter, sends nothing, and keeps the draft (#294)", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  // Unavailable, the hint never names Enter; the reason waits for the attempt.
  let frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /^ {3}[■⬝]{8} working · esc esc interrupt — stop the live Turn/m,
  );
  assert.doesNotMatch(frame, /enter steer|unavailable/);

  await type(wb.t, "wrap up");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 0);
  assert.equal(wb.control.sends.length, 0);
  frame = wb.t.captureCharFrame();
  // The refusal row carries the Offer's reason word for word, in words and a
  // glyph, above the working hint, which still says the agent works.
  assert.match(
    frame,
    /^ {3}✗ steer unavailable · Claude Code has no same-Turn steer/m,
  );
  assert.match(frame, /> wrap up/);
  assert.match(frame, /working · esc esc interrupt/);

  // Esc arms the Interrupt over the reason, and the second Esc dispatches it.
  await press(wb.t, wb.renderer, "escape");
  frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /steer unavailable/);
  assert.match(frame, /⚠ Press esc again to interrupt/);
  await press(wb.t, wb.renderer, "escape");
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
});

test("the unavailable reason leaves when the Turn ends, and Enter then sends the kept draft (#294)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, okActions());
  await type(wb.t, "wrap up");
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /steer unavailable/);

  wb.control.setRun(interactiveRunOf());
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /steer unavailable/);
  assert.match(frame, /enter send Turn/);
  assert.match(frame, /> wrap up/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "wrap up" },
  ]);
});

test("a long unavailable reason wraps in full on a small terminal and relays out on resize (#294)", async () => {
  const unsteerable = { ...STEER_OFFER, reason: LONG_STEER_REASON };
  const wb = await mountWorkbench(
    liveInteractiveRunOf({
      actionOffers: [INTERRUPT_OFFER, unsteerable, CANCEL_OFFER],
      timeline: wrappingEvents(200),
    }),
    100,
    24,
    okActions(),
  );
  await type(wb.t, "please wrap up the current change before anything else");
  await press(wb.t, wb.renderer, "return");
  // The reason wraps rather than clipping, and the bottom region counts every
  // wrapped row, so the working hint below it stays on screen.
  const reason = (frame: string) =>
    frame
      .split("\n")
      .map((line) => line.trim())
      .join(" ");
  let frame = wb.t.captureCharFrame();
  assert.ok(
    reason(frame).includes(`✗ steer unavailable · ${LONG_STEER_REASON}`),
  );
  assert.doesNotMatch(frame, /This Harness[^\n]*…/);
  assert.match(frame, /working · esc esc interrupt/);
  noOverflow(frame, 100);

  resizeWorkbench(wb.t, wb.renderer, 40, 16);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(frame, /^ {3}✗ steer unavailable · This Harness/m);
  assert.ok(reason(frame).includes(LONG_STEER_REASON.split(" ").at(-1)!));
  assert.match(frame, /working · esc esc interrupt/);
  noOverflow(frame, 40);
  resizeWorkbench(wb.t, wb.renderer, 100, 24);
  await wb.t.renderOnce();
  noOverflow(wb.t.captureCharFrame(), 100);
});

test("with reduced motion the Steer cue follows a static [⋯] (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    40,
    okActions(),
    true,
  );
  const frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /^ {3}\[⋯\] enter steer · esc esc interrupt — stop the live Turn/m,
  );
  assert.doesNotMatch(frame, /[■⬝]/);
});

test("the Steer cue keeps its words in a small terminal, the scanner yielding first (#294)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    24,
    okActions(),
  );
  resizeWorkbench(wb.t, wb.renderer, 40, 16);
  await wb.t.renderOnce();
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /^ {3}enter steer · esc esc interrupt/m);
  assert.doesNotMatch(frame, /[■⬝]/);
  noOverflow(frame, 40);
  resizeWorkbench(wb.t, wb.renderer, 100, 24);
  await wb.t.renderOnce();
  frame = wb.t.captureCharFrame();
  assert.match(
    frame,
    /^ {3}[■⬝]{8} enter steer · esc esc interrupt — stop the live Turn/m,
  );
  noOverflow(frame, 100);
});

// After an Interrupt an Agent Step's Attempt stays open and the Run waits for the
// person's follow-up (#354): the bottom input becomes "Reply to the agent", mounted
// from the follow-up Offer, and hands back to the rail once that Turn is live.
const FOLLOW_UP_OFFER = {
  action: "send-follow-up-turn" as const,
  runId: "run-1",
  stepId: "repair",
  attemptId: "0.0:repair",
  turnId: "turn-7",
  basis: "interrupted Agent Turn" as const,
  consequence:
    "send the typed text to the agent as your next message in the same Session; the Step continues from that Turn.",
};

function waitingRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "blocked",
    progress: [{ id: "repair", kind: "agent", status: "blocked" }],
    timeline: [
      {
        at: "T1",
        event: "turn-settled",
        detail: "interrupted",
        turnKind: "agent",
      },
    ],
    actionOffers: [FOLLOW_UP_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("an Agent-step Interrupt hands the bottom input to the person, and Enter sends the follow-up from the compose (#354)", async () => {
  const control = makeRunView(snapshotOf(liveTurnRunOf()));
  const renderer = makeFakeRenderer(100, 40);
  const actions = okActions({
    interrupt: () => {
      // The live snapshot carries the waiting rest in, exactly as production does.
      control.setRun(waitingRunOf());
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame(workbenchShown);
  await press(t, renderer, "escape"); // arm
  await press(t, renderer, "escape"); // interrupt

  const frame = t.captureCharFrame();
  // Timeline mechanics: the interrupted Turn stays in history and the Step waits.
  assert.match(frame, /Agent Turn settled · interrupted/);
  assert.match(frame, /Step repair/);
  assert.match(frame, /◇ You stopped the agent — it is waiting on your reply/);
  assert.match(frame, /◇ Reply to the agent — it is waiting on you/);
  assert.match(frame, /enter send reply · esc back/);
  // A follow-up ends no Step and resumes nothing; the Interrupt's receipt gives
  // way to the prompt's note.
  assert.doesNotMatch(frame, /\^E|end step|r resume|halted/);
  assert.doesNotMatch(frame, /Turn interrupted/);
  assert.doesNotMatch(frame, /esc esc interrupt/);

  // `q`, `t`, and `d` type into the focused prompt rather than fire commands.
  await type(t, "quit the docs, then test");
  await press(t, renderer, "return");
  assert.deepEqual(control.followUps, [
    { runId: "run-1", turnId: "turn-7", text: "quit the docs, then test" },
  ]);
  assert.deepEqual(control.sends, []);
  assert.doesNotMatch(t.captureCharFrame(), /sending|> quit the docs/);

  // Admission applies the send and clears the draft; the follow-up Turn goes live and
  // the prompt's working controls take over again.
  control.setInteractiveOutcome({ kind: "applied" });
  control.setRun(
    liveTurnRunOf({
      timeline: [
        {
          at: "T1",
          event: "turn-settled",
          detail: "interrupted",
          turnKind: "agent",
        },
        { at: "T2", event: "turn-started", detail: "s", turnKind: "agent" },
      ],
    }),
  );
  await t.renderOnce();
  const working = t.captureCharFrame();
  // The follow-up Turn appends below the interrupted one in the same Step.
  assert.match(working, /settled · interrupted[\s\S]*Agent Turn started/);
  assert.doesNotMatch(working, /Reply to the agent/);
  assert.match(working, /working · esc esc interrupt/);
});

test("a refused follow-up keeps its draft, and Enter on a blank compose sends nothing (#354)", async () => {
  const wb = await mountWorkbench(waitingRunOf());
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.followUps, []);

  await type(wb.t, "try again");
  await press(wb.t, wb.renderer, "return");
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "follow-up-turn-not-waiting",
      explanation: "Run run-1 is running and is not waiting for a follow-up.",
      remediation: "Open the Run.",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /✗ Run run-1 is running and is not waiting/);
  assert.match(frame, /> try again/);
});

test("the follow-up compose keeps its draft and focus while its Attempt waits, and a new Attempt starts it empty (#354)", async () => {
  const wb = await mountWorkbench(waitingRunOf());
  await type(wb.t, "half a thought");
  // A catch-up briefly withdraws every control; the same Attempt's compose returns
  // focused with its draft.
  wb.control.setFreshness({
    kind: "catching-up",
    catchUp: "rebased",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /Reply to the agent/);
  wb.control.setFreshness({
    kind: "current",
    catchUp: "fresh",
    lastConfirmedAt: "2026-09-22T10:30:01.000Z",
  });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /> half a thought/);
  await type(wb.t, " more");
  assert.match(wb.t.captureCharFrame(), /> half a thought more/);

  // A later Attempt of the Step waits on its own Interrupt: a fresh, empty compose.
  wb.control.setRun(
    waitingRunOf({
      actionOffers: [
        { ...FOLLOW_UP_OFFER, attemptId: "0.1:repair", turnId: "turn-9" },
        CANCEL_OFFER,
      ],
    }),
  );
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /half a thought/);
});

test("the follow-up compose owns its keys as the interactive input does, and Esc leaves the Workbench (#354)", async () => {
  const wb = await mountWorkbench(waitingRunOf());
  // Ctrl+E ends no Step here and Ctrl+N continues nothing: no confirm arms.
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  await press(wb.t, wb.renderer, "n", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press y|y continue/);
  await type(wb.t, "back");
  assert.match(wb.t.captureCharFrame(), /> back/);
  await press(wb.t, wb.renderer, "escape");
  await wb.t.waitForFrame((f) => f.includes("Secant"));
});

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`the follow-up compose reads in words and fits ${width}x${height} across a resize (#354)`, async () => {
    const wb = await mountWorkbench(waitingRunOf(), width, height);
    const frame = wb.t.captureCharFrame();
    noOverflow(frame, width);
    // Meaning without colour: the note and who holds the Turn, in words.
    assert.match(frame, /You stopped the agent/);
    assert.match(frame, /Reply to the agent/);
    assert.match(frame, /enter send reply/);
    const other = width === 60 ? 140 : 60;
    resizeWorkbench(wb.t, wb.renderer, other, 24);
    await wb.t.renderOnce();
    const resized = wb.t.captureCharFrame();
    noOverflow(resized, other);
    assert.match(resized, /Reply to the agent/);
  });
}

function steerSettlement(
  id: string,
  text: string,
  settlement: NonNullable<RunTimelineEvent["steer"]>["settlement"],
  step = "discuss",
): RunTimelineEvent {
  return {
    at: "2026-01-01T00:00:01.000Z",
    event: "steer",
    step,
    detail: `${settlement.kind === "dropped" ? "dropped by interrupt" : "delivered within Turn"} · ${text.slice(0, 30).replace(/\s+/g, " ")}`,
    steer: {
      steerId: id,
      text,
      sentAt: "2026-01-01T00:00:00.000Z",
      settlement,
    },
  };
}

for (const [width, height] of [
  [60, 24],
  [140, 44],
] as const) {
  test(`Interrupt restores every undelivered interactive Steer with focus at ${width}x${height} (#356)`, async () => {
    let interrupts = 0;
    const wb = await mountWorkbench(
      steerableInteractiveRunOf(),
      width,
      height,
      okActions({
        interrupt: () => {
          interrupts += 1;
          return () => ({ kind: "ok" });
        },
      }),
    );
    await type(wb.t, "restore this guidance");
    await press(wb.t, wb.renderer, "return");
    wb.control.setSteerOutcome({ kind: "applied" });
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /> restore this guidance/);
    await type(wb.t, "my unsent draft");
    await press(wb.t, wb.renderer, "escape");
    assert.equal(interrupts, 0);
    assert.match(wb.t.captureCharFrame(), /esc again/);
    await press(wb.t, wb.renderer, "escape");
    assert.equal(interrupts, 1);
    const timeline = [
      steerSettlement("delivered", "already exposed", {
        kind: "delivered",
        delivery: "within-turn",
      }),
      steerSettlement("first", "restore this guidance", {
        kind: "dropped",
        reason: "interrupt",
      }),
      steerSettlement("second", "second guidance", {
        kind: "dropped",
        reason: "interrupt",
      }),
    ];
    wb.control.setRun(interactiveRunOf({ timeline }));
    await wb.t.renderOnce();
    const frame = wb.t.captureCharFrame();
    assert.match(frame, /draft restored/);
    assert.match(frame, /Steer.*dropped by interrupt/);
    noOverflow(frame, width);
    // Restore once, preserve the unsent draft, and send the exact full text at a boundary.
    wb.control.setRun(interactiveRunOf({ timeline }));
    resizeWorkbench(wb.t, wb.renderer, width === 60 ? 140 : 60, 24);
    await wb.t.renderOnce();
    noOverflow(wb.t.captureCharFrame(), width === 60 ? 140 : 60);
    await press(wb.t, wb.renderer, "return");
    assert.equal(
      wb.control.sends[0]?.text,
      "restore this guidance\nsecond guidance\nmy unsent draft",
    );
    assert.doesNotMatch(wb.control.sends[0]?.text ?? "", /already exposed/);
  });
}

test("an Agent Interrupt restores a long Steer into the follow-up prompt and Enter sends it as the follow-up (#356, #354)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 60, 24, okActions());
  await type(wb.t, "sent guidance");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  const text = `verbatim line\n${"long guidance ".repeat(30)}last word`;
  const timeline = [
    steerSettlement(
      "long",
      text,
      { kind: "dropped", reason: "interrupt" },
      "repair",
    ),
  ];
  wb.control.setRun(waitingRunOf({ timeline }));
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /draft restored/);
  assert.match(frame, /enter send reply/);
  assert.doesNotMatch(frame, /r resume from timeline/);
  noOverflow(frame, 60);
  // The original text survives the 160-character timeline cap, sent as the reply.
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.followUps, [
    { runId: "run-1", turnId: "turn-7", text },
  ]);
  assert.equal(wb.control.steers.length, 1);
});

test("a drop seen before the Agent Step rests restores once the follow-up is offered (#354)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 30, okActions());
  await type(wb.t, "guidance in flight");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  const timeline = [
    steerSettlement(
      "in-flight",
      "guidance in flight",
      { kind: "dropped", reason: "interrupt" },
      "repair",
    ),
  ];
  // The Turn settled, but the walk has not yet written its waiting rest.
  wb.control.setRun(steerableRunOf({ actionOffers: [CANCEL_OFFER], timeline }));
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /draft restored/);
  wb.control.setRun(waitingRunOf({ timeline }));
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /draft restored/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.followUps, [
    { runId: "run-1", turnId: "turn-7", text: "guidance in flight" },
  ]);
});

test("a signal-halted Agent Step parks no compose for Steers its Turn dropped (#354)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 30, okActions());
  await type(wb.t, "guidance that cannot be sent");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  wb.control.setRun(
    steerableRunOf({
      state: "halted",
      progress: [{ id: "repair", kind: "agent", status: "blocked" }],
      actionOffers: [RESUME_OFFER],
      timeline: [
        steerSettlement(
          "dropped",
          "guidance that cannot be sent",
          { kind: "dropped", reason: "interrupt" },
          "repair",
        ),
      ],
    }),
  );
  await wb.t.renderOnce();
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /draft restored/);
  assert.doesNotMatch(frame, /guidance that cannot be sent/);
  assert.match(frame, /Run run-1 halted/);
});

test("settlement observed before its receipt restores once after admission, with Enter already clearing the draft (#356, #420)", async () => {
  const wb = await mountWorkbench(
    steerableInteractiveRunOf(),
    100,
    30,
    okActions(),
  );
  await type(wb.t, "a racing draft");
  await press(wb.t, wb.renderer, "return");
  const timeline = [
    steerSettlement("racing", "a racing draft", {
      kind: "dropped",
      reason: "interrupt",
    }),
  ];
  wb.control.setRun(interactiveRunOf({ timeline }));
  await wb.t.renderOnce();
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /draft restored/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, "a racing draft");
});

test("historic drops and loss drops do not replace the compose on open or repeated snapshots (#356)", async () => {
  const old = steerSettlement("old", "old interrupt", {
    kind: "dropped",
    reason: "interrupt",
  });
  const wb = await mountWorkbench(
    steerableInteractiveRunOf({ timeline: [old] }),
    100,
    30,
    okActions(),
  );
  await type(wb.t, "my current draft");
  const loss = steerSettlement("loss", "lost turn", {
    kind: "dropped",
    reason: "loss",
  });
  wb.control.setRun(interactiveRunOf({ timeline: [old, loss] }));
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /draft restored/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, "my current draft");
});

// "armed" presses Esc while the Steer is in flight: the arm, not a compose
// closing, is the intervening interaction since the prompt is always there.
for (const close of ["offer-ended", "armed"] as const) {
  test(`an Agent Steer accepted after its Turn's offer ended (${close}) restores its text once into the follow-up prompt (#356, #354)`, async () => {
    const wb = await mountWorkbench(steerableRunOf(), 100, 30, okActions());
    await type(wb.t, "guidance awaiting receipt");
    await press(wb.t, wb.renderer, "return");
    if (close === "armed") await press(wb.t, wb.renderer, "escape");
    const timeline = [
      steerSettlement(
        "late-accepted",
        "guidance awaiting receipt",
        { kind: "dropped", reason: "interrupt" },
        "repair",
      ),
    ];
    wb.control.setRun(waitingRunOf({ timeline }));
    await wb.t.renderOnce();
    wb.control.setSteerOutcome({ kind: "applied" });
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /draft restored/);
    // A repeated snapshot restores nothing twice.
    wb.control.setRun(waitingRunOf({ timeline }));
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.followUps, [
      { runId: "run-1", turnId: "turn-7", text: "guidance awaiting receipt" },
    ]);
  });
}

test("workbench-model-choice: the palette's Model command opens the shared picker and submits the model and effort through Run Actions (#351, ADR 0040)", async () => {
  const changes: unknown[] = [];
  const { t, renderer } = await mountWorkbench(
    runOf({
      modelChoice: MODEL_OFFER.currentChoice,
      actionOffers: [MODEL_OFFER],
    }),
    100,
    40,
    okActions({
      changeModelChoice: (offer, choice) => {
        changes.push({ offer, choice });
        return () => ({
          kind: "ok",
          modelChoiceChange: { choice, reach: "next-turn" },
        });
      },
    }),
  );

  await press(t, renderer, "g", { ctrl: true });
  assert.match(t.captureCharFrame(), /ctrl\+p Model choice/);
  // A bare `m` in focused details no longer opens it (ADR 0040).
  await press(t, renderer, "m");
  assert.doesNotMatch(t.captureCharFrame(), /Choose a model/);
  await openModelChoice(t, renderer);
  assert.match(t.captureCharFrame(), /1\. Choose a model/);
  assert.match(t.captureCharFrame(), /Fast.*\[current\]/);
  await press(t, renderer, "down");
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /2\. Choose effort/);
  assert.match(t.captureCharFrame(), /deep does not offer high effort/);
  await press(t, renderer, "return");
  assert.deepEqual(changes, [
    { offer: MODEL_OFFER, choice: { model: "deep", effort: "medium" } },
  ]);
  assert.doesNotMatch(t.captureCharFrame(), /Choose effort/);
  assert.match(t.captureCharFrame(), /applies from the next Turn/);
});

test("workbench-model-choice: absent, unavailable, and stale Offers never open the picker", async () => {
  const wb = await mountWorkbench(runOf());
  // The palette lists Model only while its Offer is available and current.
  const paletteOffersModel = async () => {
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    const listed = /Change the Run model/.test(wb.t.captureCharFrame());
    await press(wb.t, wb.renderer, "escape");
    return listed;
  };

  await press(wb.t, wb.renderer, "m");
  assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
  assert.equal(await paletteOffersModel(), false);
  wb.control.setRun(
    runOf({
      actionOffers: [
        {
          ...MODEL_OFFER,
          available: false,
          problem: {
            code: "model-choice-checking",
            explanation: "Model choices are being checked.",
            remediation: "Wait for qualification.",
            possibleEffects: "none",
          },
        },
      ],
    }),
  );
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  assert.match(
    wb.t.captureCharFrame(),
    /Model choice unavailable · Model choices are being checked/,
  );
  await press(wb.t, wb.renderer, "m");
  assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
  await press(wb.t, wb.renderer, "escape"); // back to the prompt
  assert.equal(await paletteOffersModel(), false);
  wb.control.setRun(runOf({ actionOffers: [MODEL_OFFER] }));
  await wb.t.renderOnce();
  assert.equal(await paletteOffersModel(), true);
  wb.control.setFreshness({
    kind: "catching-up",
    catchUp: "fresh",
    lastConfirmedAt: "2026-10-05T00:00:00Z",
  });
  await wb.t.renderOnce();
  assert.equal(await paletteOffersModel(), false);
  assert.doesNotMatch(
    wb.t.captureCharFrame(),
    /Choose a model|ctrl\+p Model choice/,
  );
});

for (const route of ["palette", "/model", "/effort"] as const) {
  for (const [width, height] of [
    [48, 24],
    [60, 12],
    [140, 44],
  ]) {
    test(`workbench-model-choice: ${route} keeps Model choice reachable at ${width}x${height} and resize preserves effort and focus`, async () => {
      const wb = await mountWorkbench(
        runOf({ actionOffers: [MODEL_OFFER] }),
        width,
        height,
      );

      assert.match(wb.t.captureCharFrame(), /\^P commands/);
      await openModelChoice(wb.t, wb.renderer, "Model", route);
      if (route !== "/effort") {
        await press(wb.t, wb.renderer, "down");
        await press(wb.t, wb.renderer, "return");
      }
      noOverflow(wb.t.captureCharFrame(), width);
      resizeWorkbench(wb.t, wb.renderer, 140, 44);
      await wb.t.renderOnce();
      const effort = wb.t.captureCharFrame();
      assert.match(effort, /2\. Choose effort/);
      assert.match(effort, route === "/effort" ? /Model: Fast/ : /Model: Deep/);
      assert.match(
        effort,
        route === "/effort" ? /› high \[current\]/ : /› medium \[current\]/,
      );
      assert.doesNotMatch(effort, /tab Harness/);
      await press(wb.t, wb.renderer, "escape");
      assert.match(wb.t.captureCharFrame(), /1\. Choose a model/);
      assert.match(
        wb.t.captureCharFrame(),
        route === "/effort" ? /› Fast.*\[current\]/ : /› Deep.*\[current\]/,
      );
      await press(wb.t, wb.renderer, "escape");
      assert.doesNotMatch(
        wb.t.captureCharFrame(),
        /Choose a model|Choose effort/,
      );
      assert.ok(onWorkbench(wb.t.captureCharFrame()));
      noOverflow(wb.t.captureCharFrame(), 140);
    });
  }

  test(`workbench-model-choice: ${route} Port Escape steps back even when the real keymap also receives Escape`, async () => {
    const wb = await mountWorkbench(runOf({ actionOffers: [MODEL_OFFER] }));

    await openModelChoice(wb.t, wb.renderer, "Model", route);
    if (route !== "/effort") await press(wb.t, wb.renderer, "return");
    assert.match(wb.t.captureCharFrame(), /Choose effort/);
    wb.renderer.key("escape");
    // Explicit Escape sequence avoids the terminal's lone-Esc disambiguation wait.
    wb.t.mockInput.pressKey("\x1b[27u");
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /1\. Choose a model/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /2\. Choose effort/);
    await press(wb.t, wb.renderer, "c", { ctrl: true });
    assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
    assert.deepEqual(wb.exits, []);
  });

  for (const modal of ["request", "gate", "checkpoint"] as const) {
    test(`workbench-model-choice: ${route} a ${modal} closes the picker and owns its keys`, async () => {
      const wb = await mountWorkbench(runOf({ actionOffers: [MODEL_OFFER] }));

      await openModelChoice(wb.t, wb.renderer, "Model", route);
      assert.match(wb.t.captureCharFrame(), /Choose a model|Choose effort/);
      if (modal === "request") wb.control.setLive(requestOverlay());
      else if (modal === "gate")
        wb.control.setRun(
          freeTextRunOf({ actionOffers: [MODEL_OFFER, FREE_TEXT_OFFER] }),
        );
      else
        wb.control.setRun(
          blockedRunOf({ actionOffers: [MODEL_OFFER, ANSWER_OFFER] }),
        );
      await wb.t.renderOnce();
      assert.doesNotMatch(
        wb.t.captureCharFrame(),
        /Choose a model|Choose effort/,
      );
      if (modal === "checkpoint") {
        // Model stays reachable through Ctrl+P over the checkpoint (ADR 0040),
        // so details name that route rather than a key under the checkpoint.
        await press(wb.t, wb.renderer, "g", { ctrl: true });
        assert.match(wb.t.captureCharFrame(), /ctrl\+p Model choice/);
        await press(wb.t, wb.renderer, "tab");
      }
      // A bare `m` reaches the control that owns the bottom, never the picker.
      await press(wb.t, wb.renderer, "m");
      assert.doesNotMatch(
        wb.t.captureCharFrame(),
        /Choose a model|Choose effort/,
      );
      if (modal === "request") {
        await press(wb.t, wb.renderer, "escape");
        assert.equal(wb.control.requests[0]?.decision, "deny");
      } else if (modal === "gate") {
        await type(wb.t, "351");
        await press(wb.t, wb.renderer, "return");
        assert.equal(wb.control.texts[0]?.text, "351");
      } else {
        await press(wb.t, wb.renderer, "return");
        assert.equal(wb.control.answers[0]?.answer, "continue");
      }
    });
  }
}

for (const settlement of ["live-turn", "next-turn", "refused"] as const) {
  test(`workbench-model-choice: a live request remains pending until its ${settlement} receipt`, async () => {
    const offer = { ...MODEL_OFFER, reach: "live-turn" as const };
    const [outcome, setOutcome] = createSignal<RunActionOutcome>({
      kind: "pending",
    });
    let submissions = 0;
    const wb = await mountWorkbench(
      runOf({
        selectedHarness: "codex",
        modelChoice: offer.currentChoice,
        actionOffers: [offer],
      }),
      60,
      24,
      okActions({
        changeModelChoice: () => {
          submissions += 1;
          return outcome;
        },
      }),
    );

    await openModelChoice(wb.t, wb.renderer);
    assert.match(wb.t.captureCharFrame(), /requested until the Harness/);
    await press(wb.t, wb.renderer, "return");
    await press(wb.t, wb.renderer, "return");
    assert.equal(submissions, 1);
    assert.match(wb.t.captureCharFrame(), /Model choice requested/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /applied to the live Turn/);
    await press(wb.t, wb.renderer, "g", { ctrl: true });
    assert.match(wb.t.captureCharFrame(), /› Details/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /ctrl\+p Model choice/);
    // While the change is pending the palette offers no second Model command.
    await press(wb.t, wb.renderer, "escape");
    await openModelChoice(wb.t, wb.renderer);
    assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
    await press(wb.t, wb.renderer, "escape");
    assert.equal(submissions, 1);
    if (settlement === "refused")
      setOutcome({
        kind: "refused",
        problem: {
          code: "model-choice-refused",
          explanation: "That model is blocked by your organisation.",
          remediation: "Choose an allowed model.",
          possibleEffects: "none",
        },
      });
    else
      setOutcome({
        kind: "ok",
        modelChoiceChange: { choice: offer.currentChoice, reach: settlement },
      });
    await wb.t.renderOnce();
    const frame = wb.t.captureCharFrame();
    assert.doesNotMatch(frame, /Model choice requested/);
    if (settlement === "live-turn")
      assert.match(frame, /applied to the live Turn/);
    else if (settlement === "next-turn")
      assert.match(frame, /applies from the next Turn/);
    else {
      assert.match(frame, /Model choice not changed/);
      assert.match(frame, /Choose an allowed model/);
    }
    assert.equal(frame.includes("\x1b"), false);
    noOverflow(frame, 60);
  });
}

test("workbench-model-choice: the dialog holds timeline keys while durable activity still appends", async () => {
  const base = { actionOffers: [MODEL_OFFER], timeline: events(80) };
  const wb = await mountWorkbench(runOf(base));

  await press(wb.t, wb.renderer, "pageup");
  const before = wb.t.captureCharFrame().match(/.* e\d+ .*/)?.[0];
  assert.ok(before);
  await openModelChoice(wb.t, wb.renderer);
  await press(wb.t, wb.renderer, "end", { alt: true });
  await press(wb.t, wb.renderer, "q");
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  assert.deepEqual(wb.exits, []);
  assert.match(wb.t.captureCharFrame(), /Choose a model/);
  wb.control.setRun(runOf({ ...base, timeline: events(83) }));
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "escape");
  const after = wb.t.captureCharFrame();
  assert.ok(after.includes(before));
  assert.match(after, /new activities · Jump to latest/);
  await press(wb.t, wb.renderer, "end", { alt: true });
  assert.match(wb.t.captureCharFrame(), /e82/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /new activities/);
});

for (const effort of ["locked", "unavailable"] as const) {
  test(`workbench-model-choice: Other uses native text and ${effort} effort remains truthful`, async () => {
    const changes: unknown[] = [];
    const offer = {
      ...MODEL_OFFER,
      modelDeclaration: { kind: "free-text" as const, efforts: [] },
      ...(effort === "locked"
        ? {
            effortLock: {
              effort: "high",
              source: "CLAUDE_CODE_EFFORT_LEVEL=high",
            },
          }
        : {}),
    };
    const wb = await mountWorkbench(
      runOf({
        state: "halted",
        selectedHarness: "claude-code",
        actionOffers: [offer],
      }),
      60,
      24,
      okActions({
        changeModelChoice: (_, choice) => {
          changes.push(choice);
          return () => ({
            kind: "ok",
            modelChoiceChange: { choice, reach: "next-turn" },
          });
        },
      }),
    );

    await openModelChoice(wb.t, wb.renderer);
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
    await type(wb.t, "custom-mq");
    assert.match(wb.t.captureCharFrame(), /custom-mq/);
    assert.deepEqual(wb.exits, []);
    await press(wb.t, wb.renderer, "return");
    const frame = wb.t.captureCharFrame();
    assert.match(frame, /2\. Choose effort/);
    if (effort === "locked") {
      assert.match(frame, /Locked by CLAUDE_CODE_EFFORT_LEVEL=high/);
      assert.match(frame, /high \[current\] \(locked\)/);
    } else assert.match(frame, /This model has no effort setting/);
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(changes, [
      {
        model: "custom-mq",
        ...(effort === "locked" ? { effort: "high" } : {}),
      },
    ]);
    noOverflow(wb.t.captureCharFrame(), 60);
  });
}

test("workbench-model-choice: losing the Offer closes the dialog and late Harness refusals render in the timeline", async () => {
  const wb = await mountWorkbench(runOf({ actionOffers: [MODEL_OFFER] }));

  await openModelChoice(wb.t, wb.renderer);
  assert.match(wb.t.captureCharFrame(), /Choose a model/);
  wb.control.setRun({
    ...runOf(),
    modelChoiceNotice: "The Harness kept alpha because beta was refused.",
  });
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /Choose a model/);
  assert.match(
    wb.t.captureCharFrame(),
    /The Harness kept alpha because beta was refused/,
  );
});

test("m10-workbench-interaction: Shift+Enter and Ctrl+J add native newlines, the field grows by its lines, and Enter sends the whole draft", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 60, 24);
  await type(wb.t, "first");
  // The dispatcher leaves Shift+Enter to the field: no send.
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 1);
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "stale",
      explanation: "not now",
      remediation: "retry",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  wb.renderer.key("return", { shift: true });
  // The kitty keyboard sequence a terminal sends for Shift+Enter.
  wb.t.mockInput.pressKey("\x1b[13;2u");
  await type(wb.t, "second");
  wb.t.mockInput.pressKey("j", { ctrl: true });
  await type(wb.t, "third");
  assert.equal(wb.control.sends.length, 1);
  const frame = wb.t.captureCharFrame();
  const top = rowOf(frame, /^ > first/);
  assert.match(frame.split("\n")[top + 1]!, /^ {3}second/);
  assert.match(frame.split("\n")[top + 2]!, /^ {3}third/);
  // Three field rows, the meta row, the refusal and the hint fill the bottom.
  assert.equal(top, 24 - 2 - 5);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends[1], {
    runId: "run-1",
    stepId: "discuss",
    text: "first\nsecond\nthird",
  });
});

const DRAFT_REFUSAL: AnswerOutcome = {
  kind: "refused",
  problem: {
    code: "draft-not-admitted",
    explanation: "The captured text was not admitted.",
    remediation: "Send it again.",
    possibleEffects: "none",
  },
};

for (const route of ["turn", "follow-up", "steer"] as const) {
  for (const result of ["applied", "refused"] as const) {
    test(`m10-workbench-interaction: ${route} ${result} preserves a newer multiline draft through updates and resize (#420)`, async () => {
      const initial =
        route === "turn"
          ? interactiveRunOf()
          : route === "follow-up"
            ? waitingRunOf()
            : steerableInteractiveRunOf();
      const wb = await mountWorkbench(initial, 48, 18);
      await type(wb.t, "captured first");
      wb.t.mockInput.pressKey("j", { ctrl: true });
      await type(wb.t, "captured second");
      await press(wb.t, wb.renderer, "return");
      assert.doesNotMatch(wb.t.captureCharFrame(), /captured|sending/);
      await type(wb.t, "new first");
      wb.t.mockInput.pressKey("j", { ctrl: true });
      await type(wb.t, "new second");
      for (const width of [120, 121, 48, 140]) {
        wb.control.setRun({
          ...initial,
          windowsCleanupNotice: "An unrelated update.",
        });
        resizeWorkbench(wb.t, wb.renderer, width, 24);
        await wb.t.renderOnce();
        const frame = wb.t.captureCharFrame();
        assert.match(frame, /new first/);
        assert.match(frame, /new second/);
        assert.doesNotMatch(frame, /captured|sending/);
        noOverflow(frame, width);
      }
      const outcome =
        result === "applied" ? ({ kind: "applied" } as const) : DRAFT_REFUSAL;
      if (route === "steer") wb.control.setSteerOutcome(outcome);
      else wb.control.setInteractiveOutcome(outcome);
      await wb.t.renderOnce();
      const expected =
        result === "refused"
          ? "captured first\ncaptured second\nnew first\nnew second"
          : "new first\nnew second";
      // Snapshot repetition must neither duplicate a restore nor clear newer work.
      wb.control.setRun({ ...initial });
      await wb.t.renderOnce();
      await press(wb.t, wb.renderer, "return");
      const submissions =
        route === "turn"
          ? wb.control.sends
          : route === "follow-up"
            ? wb.control.followUps
            : wb.control.steers;
      assert.equal(submissions[1]?.text, expected);
    });
  }
}

for (const route of ["turn", "follow-up"] as const) {
  test(`m10-workbench-interaction: two ${route} refusals settle out of order but restore in capture order (#420)`, async () => {
    const initial = route === "turn" ? interactiveRunOf() : waitingRunOf();
    const wb = await mountWorkbench(initial, 60, 24);
    await type(wb.t, "first capture");
    await press(wb.t, wb.renderer, "return");
    // Re-entering a still-pending capture is suppressed independently of focus.
    await type(wb.t, "first capture");
    await press(wb.t, wb.renderer, "return");
    assert.equal(
      (route === "turn" ? wb.control.sends : wb.control.followUps).length,
      1,
    );
    await press(wb.t, wb.renderer, "c", { ctrl: true });
    await type(wb.t, "second capture");
    await press(wb.t, wb.renderer, "return");
    await type(wb.t, "unsent");
    wb.control.setInteractiveOutcome(DRAFT_REFUSAL, 1);
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /> unsent/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /second capture/);
    wb.control.setInteractiveOutcome(DRAFT_REFUSAL, 0);
    await wb.t.renderOnce();
    wb.control.setRun({ ...initial });
    await wb.t.renderOnce();
    await press(wb.t, wb.renderer, "return");
    const submissions =
      route === "turn" ? wb.control.sends : wb.control.followUps;
    assert.equal(submissions[2]?.text, "first capture\nsecond capture\nunsent");
  });
}

for (const target of ["Step", "Attempt"] as const) {
  test(`m10-workbench-interaction: a late receipt after a new ${target} stays recoverable until explicitly recovered (#420)`, async () => {
    const initial = target === "Step" ? interactiveRunOf() : waitingRunOf();
    const replacement =
      target === "Step"
        ? interactiveRunOf({
            progress: [
              {
                id: "replacement",
                kind: "interactive-agent",
                status: "blocked",
              },
            ],
            actionOffers: [{ ...SEND_OFFER, stepId: "replacement" }],
          })
        : waitingRunOf({
            actionOffers: [
              {
                ...FOLLOW_UP_OFFER,
                attemptId: "replacement-attempt",
                turnId: "turn-8",
              },
            ],
          });
    const wb = await mountWorkbench(initial, 48, 18);
    await type(wb.t, "old target text");
    await press(wb.t, wb.renderer, "return");
    await type(wb.t, "departed draft");
    wb.control.setRun(replacement);
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /departed draft/);
    await type(wb.t, "new target draft");
    wb.control.setInteractiveOutcome(DRAFT_REFUSAL);
    await wb.t.renderOnce();
    for (const width of [48, 121, 60]) {
      wb.control.setRun({ ...replacement });
      resizeWorkbench(wb.t, wb.renderer, width, 24);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      assert.match(frame, /Unsent text from an earlier input saved/);
      assert.match(frame, /Recover unsent\s+text/);
      assert.match(frame, /> new target draft/);
      assert.doesNotMatch(frame, /old target text|departed draft/);
      noOverflow(frame, width);
    }
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    await type(wb.t, "Recover unsent text");
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
    assert.match(wb.t.captureCharFrame(), /Earlier-input text recovered/);
    assert.doesNotMatch(wb.t.captureCharFrame(), /earlier input saved/);
    await press(wb.t, wb.renderer, "return");
    const submissions =
      target === "Step" ? wb.control.sends : wb.control.followUps;
    assert.equal(submissions[1]?.text, "old target text\nnew target draft");
  });
}

test("m10-workbench-interaction: Ctrl+C clears newer text while a send is pending and its refusal can still restore the capture (#420)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "capture");
  await press(wb.t, wb.renderer, "return");
  await type(wb.t, "newer");
  await press(wb.t, wb.renderer, "c", { ctrl: true });
  assert.deepEqual(wb.exits, []);
  assert.doesNotMatch(wb.t.captureCharFrame(), /newer|capture/);
  wb.control.setInteractiveOutcome(DRAFT_REFUSAL);
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /> capture/);
  await press(wb.t, wb.renderer, "c", { ctrl: true });
  await press(wb.t, wb.renderer, "c", { ctrl: true });
  assert.equal(wb.exits.length, 1);
});

test("m10-workbench-interaction: an old-Step Steer drop and refused receipt retain one recoverable copy (#420)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 60, 24);
  await type(wb.t, "old guidance");
  await press(wb.t, wb.renderer, "return");
  const timeline = [
    steerSettlement(
      "old-drop",
      "old guidance",
      { kind: "dropped", reason: "interrupt" },
      "repair",
    ),
  ];
  wb.control.setRun(interactiveRunOf({ timeline }));
  await wb.t.renderOnce();
  await type(wb.t, "current text");
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: { ...DRAFT_REFUSAL.problem, possibleEffects: "unknown" },
    steerId: "old-drop",
  });
  await wb.t.renderOnce();
  wb.control.setRun(interactiveRunOf({ timeline }));
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /Recover unsent text \(1\)/);
  assert.match(wb.t.captureCharFrame(), /> current text/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /> old guidance|draft restored/);
});

test("m10-workbench-interaction: refused receipts and Interrupt drops share capture order even across repeated snapshots (#420)", async () => {
  const wb = await mountWorkbench(steerableInteractiveRunOf(), 60, 24);
  await type(wb.t, "first steer");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  await type(wb.t, "second steer");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: { ...DRAFT_REFUSAL.problem, possibleEffects: "unknown" },
    steerId: "second-drop",
  });
  await wb.t.renderOnce();
  await type(wb.t, " unsent");
  const timeline = [
    steerSettlement("second-drop", "second steer", {
      kind: "dropped",
      reason: "interrupt",
    }),
    steerSettlement("first-drop", "first steer", {
      kind: "dropped",
      reason: "interrupt",
    }),
  ];
  wb.control.setRun(interactiveRunOf({ timeline }));
  await wb.t.renderOnce();
  wb.control.setRun(interactiveRunOf({ timeline }));
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, "first steer\nsecond steer unsent");
});

test("m10-workbench-interaction: an identical-text Steer retry restores the accepted retry's Interrupt drop (#420)", async () => {
  const wb = await mountWorkbench(steerableInteractiveRunOf(), 60, 24);
  await type(wb.t, "again");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome(DRAFT_REFUSAL);
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied" });
  await wb.t.renderOnce();
  wb.control.setRun(
    interactiveRunOf({
      timeline: [
        steerSettlement("retry-drop", "again", {
          kind: "dropped",
          reason: "interrupt",
        }),
      ],
    }),
  );
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, "again");
});

test("m10-workbench-interaction: a capture before its first named Attempt cannot restore into a replacement Attempt (#420)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 60, 24);
  await type(wb.t, "original Attempt guidance");
  await press(wb.t, wb.renderer, "return");
  wb.control.setRun(waitingRunOf());
  await wb.t.renderOnce();
  wb.control.setRun(
    waitingRunOf({
      actionOffers: [
        { ...FOLLOW_UP_OFFER, attemptId: "replacement", turnId: "turn-8" },
      ],
    }),
  );
  await wb.t.renderOnce();
  await type(wb.t, "replacement draft");
  wb.control.setSteerOutcome(DRAFT_REFUSAL);
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /original Attempt guidance/);
  assert.match(wb.t.captureCharFrame(), /Recover unsent text \(1\)/);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.followUps[0]?.text, "replacement draft");
});

test("m10-workbench-interaction: a refused receipt restores text without taking focus from details (#420)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 100, 30);
  await type(wb.t, "capture");
  await press(wb.t, wb.renderer, "return");
  await press(wb.t, wb.renderer, "g", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /› Details/);
  wb.control.setInteractiveOutcome(DRAFT_REFUSAL);
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /› Details/);
  await type(wb.t, "X");
  assert.doesNotMatch(wb.t.captureCharFrame(), /captureX/);
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[1]?.text, "capture");
});

test("m10-workbench-interaction: a receipt refused after Run completion offers explicit text recovery (#420)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 60, 24);
  await type(wb.t, "late text");
  await press(wb.t, wb.renderer, "return");
  wb.control.setRun(interactiveRunOf({ state: "succeeded", actionOffers: [] }));
  await wb.t.renderOnce();
  wb.control.setInteractiveOutcome(DRAFT_REFUSAL);
  await wb.t.renderOnce();
  assert.match(
    wb.t.captureCharFrame(),
    /Unsent text from an earlier input saved/,
  );
  const copied: string[] = [];
  const original = wb.t.renderer.copyToClipboardOSC52;
  wb.t.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  try {
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    await type(wb.t, "Copy unsent text");
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(copied, ["late text"]);
    assert.match(
      wb.t.captureCharFrame(),
      /unsent text copied to\s+terminal clipboard/,
    );
    wb.t.renderer.copyToClipboardOSC52 = () => false;
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    await type(wb.t, "Copy unsent text");
    await press(wb.t, wb.renderer, "down");
    await press(wb.t, wb.renderer, "return");
    assert.match(wb.t.captureCharFrame(), /Clipboard unavailable/);
    assert.match(wb.t.captureCharFrame(), /unsent\s+text\s+remains\s+saved/);
  } finally {
    wb.t.renderer.copyToClipboardOSC52 = original;
  }
});

test("m10-workbench-interaction: Steer ids distinguish identical text in two Attempts and keep each recovery on its target (#420)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 30);
  await type(wb.t, "identical guidance");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied", steerId: "first-id" });
  await wb.t.renderOnce();
  wb.control.setRun(waitingRunOf());
  await wb.t.renderOnce();
  const newOffer = {
    ...FOLLOW_UP_OFFER,
    attemptId: "replacement",
    turnId: "turn-8",
  };
  wb.control.setRun(waitingRunOf({ actionOffers: [newOffer] }));
  await wb.t.renderOnce();
  wb.control.setRun(steerableRunOf());
  await wb.t.renderOnce();
  await type(wb.t, "identical guidance");
  await press(wb.t, wb.renderer, "return");
  wb.control.setSteerOutcome({ kind: "applied", steerId: "second-id" });
  await wb.t.renderOnce();
  wb.control.setRun(
    waitingRunOf({
      actionOffers: [newOffer],
      timeline: [
        steerSettlement(
          "second-id",
          "identical guidance",
          { kind: "dropped", reason: "interrupt" },
          "repair",
        ),
        steerSettlement(
          "first-id",
          "identical guidance",
          { kind: "dropped", reason: "interrupt" },
          "repair",
        ),
      ],
    }),
  );
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /Recover unsent text \(1\)/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.followUps, [
    { runId: "run-1", turnId: "turn-8", text: "identical guidance" },
  ]);
});

test("m10-commands-and-input-rules: first-character discovery highlights only prefixes and Escape keeps text", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, MODEL_OFFER, END_OFFER] }),
  );

  await type(wb.t, "/mo");
  assert.match(wb.t.captureCharFrame(), /› \/model/);
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /› \/model/);
  assert.match(wb.t.captureCharFrame(), /> \/mo/);
  assert.deepEqual(wb.exits, []);
  assert.deepEqual(wb.control.sends, []);
});

for (const text of [
  " /model",
  "/MODEL",
  "/model haiku",
  "/continue working on it",
  "/end-step",
  "/end-stage",
  "/effort extra",
  "/quit now",
  "/exit now",
  "/themes light",
]) {
  test(`m10-commands-and-input-rules: known first word ${JSON.stringify(text)} owns the draft even when unavailable`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER] }),
    );

    await type(wb.t, text);
    await press(wb.t, wb.renderer, "return");
    assert.match(
      wb.t.captureCharFrame(),
      /isn't available right now|doesn't accept inline arguments/,
    );
    assert.ok(wb.t.captureCharFrame().includes(text));
    assert.deepEqual(wb.control.sends, []);
    assert.deepEqual(wb.exits, []);
  });
}

for (const text of [
  "/tmp/x",
  "/compact",
  "/some-skill @file",
  " /unknown",
  "/tmp/model.ts",
  "/unknown\nunchanged",
]) {
  test(`m10-commands-and-input-rules: unknown skills, Session words, and paths pass unchanged ${JSON.stringify(text)}`, async () => {
    const wb = await mountWorkbench(interactiveRunOf());

    await type(wb.t, text);
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /› \/(?:model|effort|end-step|themes|quit)/,
    );
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.sends, [
      { runId: "run-1", stepId: "discuss", text },
    ]);
  });
}

test("m10-commands-and-input-rules: discovery ends at whitespace and never opens after a leading space", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, MODEL_OFFER] }),
  );

  await type(wb.t, " /mo");
  assert.doesNotMatch(wb.t.captureCharFrame(), /enter\/tab run/);
  await press(wb.t, wb.renderer, "c", { ctrl: true });
  await type(wb.t, "/model ");
  assert.doesNotMatch(wb.t.captureCharFrame(), /enter\/tab run/);
});

for (const command of ["model", "effort"]) {
  for (const key of ["return", "tab"]) {
    test(`m10-commands-and-input-rules: /${command} ${key} opens the joint picker at its correct focus and clears the command`, async () => {
      const wb = await mountWorkbench(
        interactiveRunOf({ actionOffers: [SEND_OFFER, MODEL_OFFER] }),
      );

      await type(wb.t, `/${command}`);
      await press(wb.t, wb.renderer, key);
      assert.match(
        wb.t.captureCharFrame(),
        command === "model" ? /1\. Choose a model/ : /2\. Choose effort/,
      );
      assert.deepEqual(wb.control.sends, []);
      await press(wb.t, wb.renderer, "c", { ctrl: true });
      assert.doesNotMatch(wb.t.captureCharFrame(), /> \/(?:model|effort)/);
    });
  }
}

for (const command of ["themes", "quit", "exit"]) {
  test(`m10-commands-and-input-rules: /${command} invokes the shell owner`, async () => {
    const wb = await mountWorkbench(interactiveRunOf());

    await type(wb.t, `/${command}`);
    await press(wb.t, wb.renderer, "return");
    if (command === "themes")
      assert.match(wb.t.captureCharFrame(), /Themes · Dark/);
    else assert.equal(wb.exits.length, 1);
    assert.deepEqual(wb.control.sends, []);
  });
}

test("m10-commands-and-input-rules: drawn prefix loses its Offer before Enter and cannot adopt another command", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, MODEL_OFFER, END_OFFER] }),
  );

  await type(wb.t, "/e");
  assert.match(wb.t.captureCharFrame(), /› \/effort/);
  wb.control.setRun(
    interactiveRunOf({ actionOffers: [SEND_OFFER, END_OFFER] }),
  );
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /› \/end-step/);
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /isn't available right now/);
  assert.deepEqual(wb.control.sends, []);
  assert.deepEqual(wb.control.ends, []);
});

test("m10-commands-and-input-rules: arrows have single ownership through Port and native field, Tab precedes details", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, MODEL_OFFER, END_OFFER] }),
  );

  await press(wb.t, wb.renderer, "g", { ctrl: true });
  await press(wb.t, wb.renderer, "tab");
  await type(wb.t, "/");
  wb.renderer.key("down");
  wb.t.mockInput.pressArrow("down");
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /› \/effort/);
  wb.renderer.key("up");
  wb.t.mockInput.pressArrow("up");
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /› \/model/);
  await type(wb.t, "mo");
  assert.match(wb.t.captureCharFrame(), /> \/mo/);
  wb.renderer.key("tab");
  wb.t.mockInput.pressKey("\t");
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /1\. Choose a model/);
  assert.deepEqual(wb.control.sends, []);
});

for (const modal of ["request", "gate", "checkpoint"]) {
  test(`m10-commands-and-input-rules: a ${modal} preempts discovery and palette retains permitted scope`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({
        actionOffers: [
          SEND_OFFER,
          MODEL_OFFER,
          END_OFFER,
          CONTINUE_OFFER,
          END_STAGE_OFFER,
        ],
      }),
    );

    await type(wb.t, "/");
    assert.match(wb.t.captureCharFrame(), /› \/model/);
    if (modal === "request") wb.control.setLive(requestOverlay());
    else if (modal === "gate")
      wb.control.setRun(
        freeTextRunOf({
          actionOffers: [MODEL_OFFER, FREE_TEXT_OFFER, END_OFFER],
        }),
      );
    else
      wb.control.setRun(
        blockedRunOf({
          actionOffers: [MODEL_OFFER, ANSWER_OFFER, END_OFFER],
        }),
      );
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /enter\/tab run/);
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    const frame = wb.t.captureCharFrame();
    for (const name of ["Model", "Effort", "Themes", "Quit"])
      assert.ok(frame.includes(name));
    assert.doesNotMatch(frame, /Confirm ending|Confirm another/);
    await press(wb.t, wb.renderer, "escape");
    await press(wb.t, wb.renderer, "return");
    if (modal === "request") assert.equal(wb.control.requests.length, 1);
    else if (modal === "checkpoint") assert.equal(wb.control.answers.length, 1);
    assert.deepEqual(wb.control.sends, []);
  });
}

for (const [width, height] of [
  [48, 12],
  [60, 12],
  [120, 24],
  [121, 24],
  [160, 40],
]) {
  test(`m10-commands-and-input-rules: list rows at ${width}x${height} preserve prompt and selection through resize`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({
        actionOffers: [
          SEND_OFFER,
          MODEL_OFFER,
          END_OFFER,
          CONTINUE_OFFER,
          END_STAGE_OFFER,
        ],
      }),
      width,
      height,
    );

    await type(wb.t, "/");
    await press(wb.t, wb.renderer, "down");
    for (const [w, h] of [
      [width, height],
      [160, 40],
      [48, 12],
    ]) {
      resizeWorkbench(wb.t, wb.renderer, w, h);
      await wb.t.renderOnce();
      const frame = wb.t.captureCharFrame();
      noOverflow(frame, w);
      assert.match(frame, /> \//);
      assert.match(frame, /› \/effort/);
      assert.match(frame, /enter send Turn/);
      assert.equal(frame.split("\n")[h - 1]?.trim(), "");
    }
    await press(wb.t, wb.renderer, "tab");
    assert.match(wb.t.captureCharFrame(), /2\. Choose effort/);
  });
}

for (const state of ["working", "agent", "finished"] as const) {
  test(`m10-commands-and-input-rules: ${state} exposes only its permitted commands`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({
        actionOffers: [
          SEND_OFFER,
          MODEL_OFFER,
          END_OFFER,
          CONTINUE_OFFER,
          END_STAGE_OFFER,
        ],
      }),
    );

    await type(wb.t, "/");
    assert.match(wb.t.captureCharFrame(), /\/end-step/);
    if (state === "working")
      wb.control.setRun(
        liveInteractiveRunOf({
          actionOffers: [
            INTERRUPT_OFFER,
            AVAILABLE_STEER_OFFER,
            MODEL_OFFER,
            END_OFFER,
          ],
        }),
      );
    else if (state === "agent")
      wb.control.setRun(runOf({ actionOffers: [MODEL_OFFER] }));
    else
      wb.control.setRun(
        runOf({ state: "succeeded", actionOffers: [MODEL_OFFER] }),
      );
    await wb.t.renderOnce();
    if (state === "agent") await type(wb.t, "/");
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /\/end-step|\/continue|\/end-stage/,
    );
    if (state !== "finished") {
      for (const name of ["model", "effort", "themes", "quit"])
        assert.ok(wb.t.captureCharFrame().includes(`/${name}`));
    }
    await press(wb.t, wb.renderer, "p", { ctrl: true });
    const frame = wb.t.captureCharFrame();
    assert.ok(frame.includes("Themes") && frame.includes("Quit"));
    assert.doesNotMatch(frame, /Confirm ending|Confirm another/);
    if (state === "finished")
      assert.doesNotMatch(frame, /Change the Run model|Change effort/);
  });
}

for (const text of ["/tmp/x", "/compact", "/unknown skill"]) {
  test(`m10-commands-and-input-rules: working Turn passes ${text} unchanged to existing Steer admission`, async () => {
    const wb = await mountWorkbench(
      liveInteractiveRunOf({
        actionOffers: [INTERRUPT_OFFER, AVAILABLE_STEER_OFFER],
      }),
    );

    await type(wb.t, text);
    await press(wb.t, wb.renderer, "return");
    assert.deepEqual(wb.control.steers, [
      { runId: "run-1", turnId: "turn-7", text },
    ]);
    assert.deepEqual(wb.control.sends, []);
  });
}

for (const command of ["model", "effort"]) {
  test(`workbench-model-choice: /${command} absent, unavailable and stale Offers keep text and never open the picker`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER] }),
    );

    for (const actionOffers of [
      [SEND_OFFER],
      [
        SEND_OFFER,
        {
          ...MODEL_OFFER,
          available: false as const,
          problem: {
            code: "checking",
            explanation: "Checking choices",
            remediation: "Wait",
            possibleEffects: "none" as const,
          },
        },
      ],
      [SEND_OFFER, MODEL_OFFER],
    ]) {
      wb.control.setRun(interactiveRunOf({ actionOffers }));
      if (
        actionOffers.some(
          (offer) => offer.action === "change-model-choice" && offer.available,
        )
      )
        wb.control.setFreshness({
          kind: "catching-up",
          catchUp: "fresh",
          lastConfirmedAt: "2026-10-05T00:00:00Z",
        });
      await wb.t.renderOnce();
      await press(wb.t, wb.renderer, "c", { ctrl: true });
      await type(wb.t, `/${command}`);
      await press(wb.t, wb.renderer, "return");
      assert.doesNotMatch(
        wb.t.captureCharFrame(),
        /Choose a model|Choose effort/,
      );
      assert.match(wb.t.captureCharFrame(), /isn't available right now/);
      assert.match(wb.t.captureCharFrame(), new RegExp(`> /${command}`));
      assert.deepEqual(wb.control.sends, []);
    }
  });
}

test("m10-commands-and-input-rules: pending Turn admission keeps Slash discovery and the joint picker available without losing a refused capture (#420)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, MODEL_OFFER] }),
  );

  await type(wb.t, "captured text");
  await press(wb.t, wb.renderer, "return");
  await type(wb.t, "/model");
  assert.match(wb.t.captureCharFrame(), /› \/model/);
  await press(wb.t, wb.renderer, "return");
  assert.match(wb.t.captureCharFrame(), /1\. Choose a model/);
  wb.control.setInteractiveOutcome(DRAFT_REFUSAL);
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /1\. Choose a model/);
  await press(wb.t, wb.renderer, "c", { ctrl: true });
  await type(wb.t, " newer text");
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "captured text" },
    { runId: "run-1", stepId: "discuss", text: "captured text newer text" },
  ]);
  assert.deepEqual(wb.exits, []);
});

test("m10-workspace-mentions: native caret completion replaces only the token, quotes file ranges and retains surrounding text", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER] }),
  );
  wb.control.view.searchWorkspacePaths = async () => ({
    status: "available",
    candidates: [{ path: "my file.ts", kind: "file" }],
  });

  await type(wb.t, "before @my#L10-20 after");
  for (let i = 0; i < 6; i++) wb.t.mockInput.pressArrow("left");
  await until(() => {
    void wb.t.renderOnce();
    return wb.t.captureCharFrame().includes("my file.ts");
  });
  await press(wb.t, wb.renderer, "tab");
  await type(wb.t, "!");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, 'before @"my file.ts"#L10-20! after');
});

async function mentionFrame(
  wb: Awaited<ReturnType<typeof mountWorkbench>>,
  pattern: RegExp,
) {
  await until(() => {
    void wb.t.renderOnce();
    return pattern.test(wb.t.captureCharFrame());
  });
}

for (const prefix of ["", "漢字 👩‍💻 ", "first\nsecond "]) {
  test(`m10-workspace-mentions: folder selection drops ranges and preserves native Unicode/multiline editing ${JSON.stringify(prefix)}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER] }),
    );
    wb.control.view.searchWorkspacePaths = async () => ({
      status: "available",
      candidates: [
        { path: "file.ts", kind: "file" },
        { path: "my folder", kind: "folder" },
      ],
    });

    if (prefix.includes("\n")) {
      await type(wb.t, "first");
      wb.t.mockInput.pressKey("j", { ctrl: true });
      await type(wb.t, "second ");
    } else if (prefix !== "") {
      await wb.t.mockInput.pasteBracketedText(prefix);
      await wb.t.renderOnce();
    }
    await type(wb.t, "@my#L10-20 tail");
    for (let i = 0; i < 5; i++) wb.t.mockInput.pressArrow("left");
    await mentionFrame(wb, /› @file.ts/);
    wb.renderer.key("down");
    wb.t.mockInput.pressArrow("down");
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /› @my folder/);
    await press(wb.t, wb.renderer, "return");
    assert.equal(wb.control.sends.length, 0);
    assert.doesNotMatch(wb.t.captureCharFrame(), /enter\/tab insert/);
    await type(wb.t, "!");
    await press(wb.t, wb.renderer, "return");
    assert.equal(wb.control.sends[0]?.text, `${prefix}@"my folder/"! tail`);
  });
}

for (const text of [
  "email@example.com",
  "word@src",
  "@.hidden/file",
  "@ignored/file",
  "@missing",
  "@/outside/absolute",
  "/unknown @missing",
]) {
  test(`m10-workspace-mentions: no-result Enter preserves manual text ${JSON.stringify(text)}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER] }),
    );

    await type(wb.t, text);
    if (!text.startsWith("email") && !text.startsWith("word"))
      await mentionFrame(wb, /No path suggestions/);
    else assert.doesNotMatch(wb.t.captureCharFrame(), /Searching Workspace/);
    await press(wb.t, wb.renderer, "return");
    assert.equal(wb.control.sends[0]?.text, text);
  });
}

for (const working of [false, true]) {
  test(`m10-workspace-mentions: search unavailable leaves ordinary ${working ? "Steer" : "Send"} available`, async () => {
    const wb = await mountWorkbench(
      working
        ? liveInteractiveRunOf({
            actionOffers: [INTERRUPT_OFFER, AVAILABLE_STEER_OFFER],
          })
        : interactiveRunOf({ actionOffers: [SEND_OFFER] }),
    );
    wb.control.view.searchWorkspacePaths = async () => ({
      status: "unavailable",
      cause: new Error("search failed"),
    });

    await type(wb.t, "please @missing");
    await mentionFrame(wb, /Path search unavailable/);
    await press(wb.t, wb.renderer, "return");
    assert.equal(
      (working ? wb.control.steers : wb.control.sends)[0]?.text,
      "please @missing",
    );
  });
}

for (const text of [" /MoDeL @src", "/continue @src", "/themes @src"]) {
  test(`m10-workspace-mentions: known unavailable/invalid command suppresses mentions ${text}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER] }),
    );
    wb.control.view.searchWorkspacePaths = async () => {
      assert.fail("known command must suppress search");
    };

    await type(wb.t, text);
    await press(wb.t, wb.renderer, "return");
    assert.match(wb.t.captureCharFrame(), /doesn't accept inline arguments/);
    assert.doesNotMatch(
      wb.t.captureCharFrame(),
      /Workspace paths|path suggestions/,
    );
    assert.equal(wb.control.sends.length, 0);
  });
}

test("m10-workspace-mentions: Escape preserves draft and unknown Slash permits a later token", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER] }),
  );
  wb.control.view.searchWorkspacePaths = async () => ({
    status: "available",
    candidates: [{ path: "src/a.ts", kind: "file" }],
  });

  await type(wb.t, "/unknown @src");
  await mentionFrame(wb, /› @src\/a.ts/);
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /enter\/tab insert/);
  assert.deepEqual(wb.exits, []);
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, "/unknown @src");
});

for (const change of [
  "query",
  "token",
  "Workspace",
  "caret-leaves",
  "request",
  "gate",
]) {
  test(`m10-workspace-mentions: delayed reply cannot survive a changed ${change}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER] }),
    );
    const pending: {
      input: WorkspacePathQuery;
      resolve: (result: WorkspacePathSearch) => void;
    }[] = [];
    wb.control.view.searchWorkspacePaths = (input) =>
      new Promise((resolve) => pending.push({ input, resolve }));

    await type(wb.t, "@old");
    await until(() => pending.length === 1);
    if (change === "query") await type(wb.t, "new");
    if (change === "token") await type(wb.t, " @old");
    if (change === "Workspace")
      wb.control.setSnapshot(
        snapshotOf(
          interactiveRunOf({
            workspacePath: "/new/workspace",
            actionOffers: [SEND_OFFER],
          }),
        ),
      );
    if (change === "caret-leaves") wb.t.mockInput.pressKey("HOME");
    if (change === "request") wb.control.setLive(requestOverlay());
    if (change === "gate") wb.control.setSnapshot(snapshotOf(freeTextRunOf()));
    await wb.t.renderOnce();
    if (["query", "token", "Workspace"].includes(change))
      await until(() => pending.length === 2);
    pending[0]?.resolve({
      status: "available",
      candidates: [{ path: "obsolete.ts", kind: "file" }],
    });
    await wb.t.renderOnce();
    await wb.t.renderOnce();
    assert.doesNotMatch(wb.t.captureCharFrame(), /obsolete.ts/);
    if (pending[1]) {
      pending[1].resolve({
        status: "available",
        candidates: [{ path: "current.ts", kind: "file" }],
      });
      await mentionFrame(wb, /› @current.ts/);
      assert.equal(
        pending[1].input.workspacePath,
        change === "Workspace" ? "/new/workspace" : "/tmp/ws",
      );
    } else
      assert.doesNotMatch(
        wb.t.captureCharFrame(),
        /Searching Workspace|enter\/tab insert/,
      );
  });
}

for (const [width, height] of [
  [24, 10],
  [80, 16],
]) {
  test(`m10-workspace-mentions: bounded list and selected path stay visible through dual resize at ${width}x${height}`, async () => {
    const wb = await mountWorkbench(
      interactiveRunOf({ actionOffers: [SEND_OFFER] }),
      width,
      height,
    );
    wb.control.view.searchWorkspacePaths = async () => ({
      status: "available",
      candidates: Array.from({ length: 10 }, (_, i) => ({
        path: `path-${i}.ts`,
        kind: "file",
      })),
    });

    await type(wb.t, "@path");
    await mentionFrame(wb, /› @path-0.ts/);
    for (let i = 0; i < 9; i++) await press(wb.t, wb.renderer, "down");
    assert.match(wb.t.captureCharFrame(), /› @path-9.ts/);
    noOverflow(wb.t.captureCharFrame(), width);
    resizeWorkbench(wb.t, wb.renderer, width + 10, height + 3);
    await wb.t.renderOnce();
    assert.match(wb.t.captureCharFrame(), /› @path-9.ts/);
    noOverflow(wb.t.captureCharFrame(), width + 10);
    await press(wb.t, wb.renderer, "tab");
    await type(wb.t, " done");
    await press(wb.t, wb.renderer, "return");
    assert.equal(wb.control.sends[0]?.text, "@path-9.ts done");
  });
}

test("m10-workspace-mentions: a hash inside a quoted file path is not its textual range delimiter", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER] }),
  );
  const queries: string[] = [];
  wb.control.view.searchWorkspacePaths = async (input) => {
    queries.push(input.query);
    return {
      status: "available",
      candidates: [{ path: "a#b c.ts", kind: "file" }],
    };
  };

  await type(wb.t, '@"a#b c.ts"#L10-20');
  await mentionFrame(wb, /› @a#b c.ts/);
  assert.deepEqual(queries, ["a#b c.ts"]);
  await press(wb.t, wb.renderer, "tab");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends[0]?.text, '@"a#b c.ts"#L10-20');
});
