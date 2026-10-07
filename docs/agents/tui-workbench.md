# Run Workbench Interaction

Read this before changing the Run Workbench's key routing, modal stack, steer compose, interactive input, destructive confirms, or details panel. It was
carved out of [the presentation Module's notes](../../src/tui/AGENTS.md), which keep the general OpenTUI layout invariants and the rule that the Workbench
alone takes its keys, size, and resize from the Renderer Port; the Application side of the controls it dispatches is in [run-control](./run-control.md).

## Key routing and native inputs

- The free-text gate control and the interactive input each mount a native OpenTUI `<input>` (`run-gate-control.tsx`, `run-workbench.tsx`; D9), not a hand-rolled
  buffer. The verified routing order is why this works on the Port-driven Workbench: OpenTUI delivers a keypress to the global listeners registered on `keyInput`
  **before** the focused renderable's own handler, and the production Renderer Port adapter (`renderer/renderer.ts`, `renderer.keyInput.on("keypress", …)`) is exactly
  such a global listener, so the Workbench dispatcher runs first and always fires its command — a focused field can never preempt a command key. The dispatcher claims
  the command keys (Enter to submit, Esc to leave/deny, Ctrl+E to arm End Step, `y` to confirm) and lets every other key reach the field, which owns text, cursor motion,
  word delete, paste, and shifted symbols (so capitals and punctuation are no longer out of reach — the #23 shifted-symbol deferral is retired for these two controls).
- We do **not** call `stopPropagation` (the narrow Port key value carries no such method, A16), so the focused field also receives a command key by its own bindings. That
  is harmless because the freeze blurs the field for the keys that would double: the field is blurred (`focused` false) while an answer is in flight and while a confirming
  keypress is armed, so the confirming `y` confirms rather than types. The `pending()` check still sits **above** the typing branch in the Workbench key loop
  (`run-workbench.tsx`), so an armed End-Step confirm takes `y`/Escape. The one non-frozen double is Ctrl+E: it arms End Step and, on the same event, the field also runs its
  built-in Ctrl+E→line-end before the arm blurs it — a moot cursor move, so the bindings override the research left optional is deferred.
- A free-text gate's authored suggestions (#213) ride the same control: `gateControl.handleKey` takes `up`/`down` to cycle the suggestions and Other, and the
  Workbench dispatcher consults it before the timeline's own `up`/`down` cases, so paging never fires while the gate is up. The gate footer is `gateHeight()` rows —
  5 with suggestions, else 4 — so the bottom-region accounting reads it rather than a constant.
- The interactive-agent input (`run-workbench.tsx`, #122) is a native OpenTUI `<input>` (D9): while `focus` is `interactive` the field owns text, so `q`/`r`/`c`/`x`/`t`
  type into it rather than fire their bare-letter commands (only Ctrl+C still exits, and the dispatcher gates those commands on not typing). The field carries capitals,
  punctuation, paste and word delete verbatim. Enter dispatches `send-interactive-turn` at a Turn boundary and `steer-turn` against the Offer's `turnId` during a live
  Turn (#294; blank/whitespace refused before dispatch either way, and a refused send or Steer keeps the draft, A9);
  Ctrl+E arms `end-interactive-step`, offered — and so armable — only at a Turn boundary (no live Turn), reusing the same `pending` arm-and-confirm;
  in a human-controlled Repeat Ctrl+N arms `continue-repeat` the same way instead (#217), its confirm leading with `y`/`esc` before the Offer's consequence,
  and Ctrl+E arms `end-stage` (#218), whose consequence opens with "Secant has not checked the tracker" so a narrow clip keeps the warning; `esc` declines
  it and the field refocuses with its draft.
  The Step is "active" whenever the Run is blocked at an `interactive-agent` Step (independent of a live Turn), so focus stays on the input across the whole
  Step and returns to the timeline when it ends.
- The same input is an Agent Step's follow-up compose after an Interrupt (#354): it mounts from the `send-follow-up-turn` Offer alone, never the Step kind,
  reads "Reply to the agent", and its Enter dispatches the follow-up against the Offer's `turnId`; it shows no `^E` and arms no ending control. It leaves
  once the follow-up Turn is live, so the rail's Agent-step Steer (`s`) and two-press Esc apply again, and each newly interrupted Turn refocuses it;
  a catch-up never moves focus. The
  Interrupt's `d dismiss` receipt clears when the Offer arrives, since `d` would type into the field. `inputActive` is the one "input owns the
  interaction" predicate; `interactiveStepActive` stays the Step-kind fact for the interactive controls.
- Typed-but-unsent interactive text (the `draft` signal) clears only on a **fresh** input — a new interactive Step, or a follow-up to a new Attempt (the focus
  effect keys on the Step id, or Step and Attempt for a follow-up; never a parsed Turn id) — so it survives a Turn settle, a second Interrupt of the same
  Attempt, and a tab away within the same Step; a refused send keeps it (the refusal surfaces beside it, A9), and only an applied send
  clears it. A send applies at Turn admission (#290), so the draft clears while the agent works; the `… sending…` hint and the blurred field last only until then.
  An input Steer (#294) follows the same rule with no pending state at all: the field keeps its keys, a second Enter in flight is ignored, and a send waits
  until it settles. Its settlement rides the compose's Steer path (`steerFlight`, tagged with its source and the sent text), and an applied Steer clears the
  draft only while it still holds that text, so guidance typed in flight survives. An unavailable Steer shows its reason only at Enter, as
  `✗ steer unavailable · <reason>` on the refusal line (`InteractiveRefusal`, which also carries an Application refusal), since a standing copy beside the
  scanner would clip at any usual width. Arming the Interrupt clears that line, so the armed confirm is never hidden, and the reason leaves when the Turn ends.
  The label reads the live Turn from the `interrupt-turn` Offer, never a missing send Offer: the agent is working while one is offered, else it is the human's move.
- The working scanner (`working-scanner.tsx`, #292) mounts only while that same Offer is present, so its one timer stops when the Turn ends. It leads
  existing rows and adds none: the interactive hint line (`<scanner> esc esc interrupt — …`, or `<scanner> enter steer · esc esc interrupt — …` while
  Steer is offered available, #294) and the rail's interrupt row
  (`<scanner> working · esc esc interrupt — …`), whose words carry the meaning without motion or colour, so in a row too narrow for both the mark
  yields and the words stay whole. The armed interactive confirm replaces its line,
  and a request or gate (`modalControl`) hides both. `reducedMotion` arrives as a mount option, never an environment read, and draws a static `[⋯]`.

## Modal stack and composes

- A dialog with `onKey` takes every key from the Workbench's Renderer Port before screen dispatch (#351). The dialog primitive disables its
  Escape/Ctrl+C keymap layer for that entry, so the shared picker's Escape can step from effort to model. Other dialogs keep their own keymap.
- Ctrl+P takes the Workbench Port path before inspection, requests and gates; normal screens keep the keymap path. Action owners supply the catalog.
  A new request or gate target closes discovery and restores an unconfirmed appearance. Deliberate reopening over that target remains available.
  Native fields stay blurred while a dialog is on the stack. Dialog refocus never steals focus from a replacement dialog.
- After shell shortcuts, output inspection and the details-opened Session reader own every key but Ctrl+C. Esc returns to the selected
  details resource; `q` enters guarded Exit (#392). Keep Running preserves the content, scroll and focus. Ctrl+G opens focused resources even
  below the inline panel breakpoints; the bare `t` shortcut is retired (#421).
- The interim `m` Model-choice picker uses the dialog stack and the `change-model-choice` Offer, including below the details hide size. A Request or
  Human Gate closes it. Reach comes from the Offer while requested and from the Operation receipt once applied; a live change remains pending until observed.
- The Workbench bottom region is a modal stack (#121): an outstanding approval Harness Request or a free-text Human Gate owns Esc and every printable key, so
  while either is up the Run Actions rail (r/c/x) and the two-press Esc interrupt are suppressed (`modalControl()` gates `anyActionOffer`/`actionLines` and the
  interrupt disarm). `interrupt-turn`/`steer-turn` offers stay present through an `awaiting-approval` Turn (run-projection derives them from liveness, not
  `TurnPhase`), so without this guard the request control and the "esc esc interrupt" hint collide over Esc. The rail's interrupt/steer rows are also hidden while an
  interactive Step owns the input (#122); during a live human Turn the input's hint line carries the Interrupt (#219) and an available Steer's Enter (#294) instead,
  and `handleInteractiveKey` runs the shared two-press `armOrDispatchInterrupt` (disarming on any other key first), so Esc leaves only at a Turn boundary.
  `anyActionOffer` and `actionLines` must agree on this, or an empty `Actions:` heading steals the hint row.
- Native Steer (#148) is an on-demand compose, not a blocked-state modal like the gate/interactive inputs: while an agent Turn is live under a Harness that declares native
  steer (Codex and Claude Code offer `steer-turn` `available`), the Actions rail names the `s` key; `s` opens a native `<input>` (`SteerInput`) in the bottom
  region with `focus === "steer"`, Enter dispatches `steer-turn` (blank refused, a refused steer keeps the draft), Escape backs out — the Turn keeps working either way. It
  belongs to Agent steps only: in an interactive Step `s` types into the input, whose own Enter steers the live Turn (#294). It yields to a request/gate modal
  (`modalControl` wins `bottomHeight`; an effect closes the compose when the offer leaves or a modal appears). The `s`-open and steer-typing key routing sit beside the
  interactive `typing` branch (gated so `q`/`t`/Run-Actions type as text while composing). An unavailable steer shows `steer — unavailable · <reason>` on the rail and `s`
  opens nothing. Admission refusals (a reserved word, a Session command, #359) take the refusal line and keep the draft; their explanations lead with what to
  do, so a narrow clip keeps it.
- Interrupt-drop settlements restore full Steer text once, after the live Turn leaves and pending send receipts settle (#356). Delivered and loss-drop rows remain history.
  New drops join in recorded order before the unsent draft; opening old history restores nothing, and repeated snapshots never duplicate a restore.
  Full text comes from `RunTimelineEvent.steer`,
  never its capped `detail`. Restored drafts use a one-row native textarea because `<input>` strips newlines; ordinary M7/M8 inputs keep their existing routing.
  They restore only into an input that can send them: the interactive Step's, or an Agent Step's follow-up compose, whose Enter sends them as the follow-up
  (#354), with the Steer compose's unsent text after them. An Agent Step a signal halted has no such input, so its drops stay history; the Steer compose
  never parks a restored draft. An interactive Step's recovered input stays editable at `halted` until resume. Escape returns to the timeline's Run actions.
- A stale approval answer keeps its inline refusal while the offer re-renders: a genuinely new request (a fresh `requestId`) resets the decision to `allow`
  and clears the refusal, but a stale answer keeps the same id, so its refusal survives while the bumped-generation offer re-renders (`onIdentityChange` on
  the request id).

## Run Actions, details panel, and live updates

- Every confirmation dispatches its captured Offer, after checking its semantic target against the current Offer (#389). A replacement or withdrawal
  clears the arm; reappearance requires a fresh arm. Unchanged targets retain the original consequence across unrelated updates and fresh objects.
- A destructive Run Action (cancel or delete) arms a confirming keypress before it dispatches (`run-workbench.tsx` `pending`): `y` confirms, Escape backs out.
  An ordinary resume dispatches at once; a resume Offer carrying a takeover form first confirms once and names the foreign owner process.
- `ResumeRunOffer` is a `SteerTurnOffer`-style union (#194): `available:false` renders `resume — unavailable · <reason>` and `r` no-ops (story 40); an
  `available:true` offer with `acknowledgement` arms an extra confirm (`pending() === "acknowledge"`) before dispatch, since an indeterminate Command Attempt may
  repeat effects (story 39) — the full risk shows in the panel's recovery evidence, the rail prompt leads with the action so it never clips.
- The Harness/model facts (#125/#147), recovery evidence, the story-38 resting reason, cancel/delete (#194), and the Run id and owner process (#293) moved off the header/rail
  into the details panel; the header names the Run id again only once the Run leaves a live state (`running`/`blocked`). `buildDetailsRows` (`run-workbench-views.tsx`) builds
  the panel once; the container reserves exactly `detailsRows().length` rows, so render and row accounting never drift. Recovery lines appear only when their Run-view fact is
  present. `c`/`x` act only while the panel is shown, confirm in the panel; the rail keeps only resume and the live-Turn interrupt/steer. A terminal/`halted` rest also shows
  one `restingProse` line beside the header state word (colour is never the only signal); `blocked` keeps that prose only in the panel, and `headerRows()` counts it.
- Immediate durable Turn settlement clears the Run control overlay (`reduceRunUpdate`, `run-view.tsx`); a trailing `settling` observation cannot restore it (#412).
  History ids survive wrapping/settlement. Ctrl+O opens first visible detail; click opens its row. Output/Thoughts toggle; supplied diffs open uncapped inspection.
  History-only observer loss is visible and reconnectable; reopening issues fresh ids and resets the viewport. Workflow facts follow their Turn, including equal-time ties.

## Read next

- `run-inspection.tsx` owns bounded artifact/output inspection; `run-transcript.tsx` owns the details-opened retained Session reader (#421).
  Its Resource entry id anchors an offset relative to the role header; leading dividers have negative offsets, so newly attached dividers preserve content.
  Resize clamps only within the entry; read notices stay outside content. Only this reader pages older: `p` preserves position, including failed retries.
  Up at the top also loads older. Export (`e`) reads the complete Reference only on demand and queues text to the terminal clipboard, naming refusal.
  `run-workbench-views.tsx` holds the Workbench's four pure presentational leaves; state, focus, modal precedence, and the key dispatcher stay in
  `run-workbench.tsx` (A12).
