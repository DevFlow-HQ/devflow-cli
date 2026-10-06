# Live Run Control

Read this before changing live Run control in the Application: deferred settlement, cancel and shutdown, Turn interrupt, steer, and live Model choice
change, takeover, the interactive-Step drive, or the live overlay. It was carved out of [the Application Module's notes](../../src/application/AGENTS.md), which keep the
write, launch, and read invariants; the abort-reason vocabulary and the resting state each reason maps to are owned by
[the Run execution Module's notes](../../src/run/execution/AGENTS.md).

## Settlement, cancel, and shutdown

- Run settlement is deferred (#98 S1): `runAndSettle`/the answer-continue branch start the execution promise and `submit` returns `admitted` synchronously; the
  `finally` releases the owner only after a resting outcome and settlement publishes after it. A `blocked` Run keeps its owner with no execution promise until answered.
  `send-interactive-turn` is the exception: it settles at the Turn's admission, not at rest (Interactive-Step drive below).
- One `AbortController` per live Run lives in the `runs` map. The Application never imports the execution `RunCancelledError`: it aborts its own controller, so
  `tracking.abort.signal.aborted` in the catch is exactly "our cancel/signal fired", and the reason decides the rest
  ([execution's mapping](../../src/run/execution/AGENTS.md)): only `RUN_CANCEL_ABORT` throws (`RunCancelledError`, so cancel-run writes the rest through the
  held owner); a signal throws nothing, so `runAndSettle` returns through its normal path, and a signal leaves the claim live for the next open to reconcile.
- `cancel-run` is cancel-as-abort for active work in this process; a held blocked Run is rested directly, a non-live blocked Run is acquired and rested, and a Run live
  elsewhere takes the fresh-owner epoch-bump path. `shutdown()` drains every Run it owns with no work in flight, selected by retained ownership, never the durable
  state (#385): a drive that faulted mid-Turn retains its owner and Step with the Run still `running`. It closes the held Harness, releases a blocked
  rest's claim without changing it, and leaves follow-up waiting claims and any non-blocked claim for Store reconciliation, since an unowned `running`
  record is never reconciled. It then aborts and awaits running work with `SIGNAL_ABORT`, also leaving their claims live. Last, it drains what those
  drives retained and awaits any drain a cancel or a drive's release already began. A failed drain skips no other drain or abort; shutdown rejects
  with it once all have run. Those three paths drain a retained Step and owner through `drainRetained`, which marks the Run done before its first
  await.
- Cancel and shutdown race on the Run controller: whichever aborts first supplies its reason. Turn interrupt is bound separately; its Operation reports the
  Harness receipt and its own Turn's result, while the Run's eventual rest still reflects cancel or shutdown when either stops the Run.

- Agent calls (#372) settle in Application's `settleAgentCompletion`, after a tracked routing block and after a human Turn, under the existing promise.
  It reads the latest accepted call of the Attempt's latest clean Turn, publishes through `publishInteractiveEnd`, and loops over subsequent Entry Turns.
  An unowned blocked Run with such a call offers resume to close the settle-before-apply crash window. No execution callback applies a call.

## Turn interrupt and steer

- `interrupt-turn` (#298) reaches only its named live Turn through `RequestChannel.bindInterrupt`, bound and unbound alongside answer and steer in execution's
  Turn driver. A rejected Harness receipt settles `not-applied` immediately; an accepted receipt waits only for that Turn's result: `interrupted` or `lost` settles
  `applied`, anything else `not-applied` with `interrupt-rejected` and a reason. An applied interrupt ends only the Turn: the Run returns to `blocked` with
  the Step's Harness held (ADR 0035). In an Interactive agent Step that is a Turn boundary like a completed Turn (#353); in an Agent Step the Attempt stays
  open and the follow-up continues it (#354, below). A `lost` or signal-stopped Turn halts, by [execution's rules](../../src/run/execution/AGENTS.md).
  Interrupt never fires the Run's controller, so a refused or ineffective interrupt cannot stop a following human Turn, Agent Turn, or Command step.
- Both `interrupt-turn` and `steer-turn` are offered only while a live (unsettled) Turn exists in this process; a control naming a settled Turn is rejected as a value.
- The steer Offer is discriminated on the prepared profile's steer evidence (live first, then persisted with the Attempt), never Adapter prose above the Seam: a Harness
  with native steer (Codex, Claude Code since #359) offers it `available` with the live turnId, one without `available:false` with the evidence as `reason` (#148).
- Steer admission (`steerRefusal`, #359) refuses before any Operation, in ADR 0040's order: `steer-unavailable`, `steer-blank`, the selected Harness's
  `harness-input-reserved`, then `steer-session-command` for a word in `tracking.live.sessionCommands` (execution sets it from the live Turn's Session fact
  through `RequestChannel.sessionCommands`, clearing it at Turn end). Workflow's one matcher serves both word checks.
- Steer keeps the Turn working. An admitted Steer reaches the live Turn's `tracking.live.steer` (bound by `driveHarnessTurn` over `turn.steer` via the
  `RequestChannel.bindSteer` hook, unbound at Turn end alongside `bindAnswer`); a native control race settles `steer-rejected`, a stale/settled turnId `turn-control-rejected`,
  an accepted steer `applied`, Run still running. Its Operation id is the opaque Steer id through execution to the Harness; replay never sends it twice (#356). Settlement
  carries full text and send time through `appendTurnEvent`, independently of when the acceptance receipt resolves.
- A `change-model-choice` whose Offer reach is `live-turn` (#348) sends `RequestChannel.bindModelChange`'s control and stays `pending`; the Run and preference
  are written only when the Harness reports it applied (`live-turn`), or when the receipt is rejected or the Turn ends unanswered (`next-turn`). A refusal writes
  nothing and settles `model-choice-refused`; another change meanwhile is `model-choice-change-pending`. Every write happens in the synchronous settle, before
  the next Turn reads the choice. A later Turn's own refused request restores the Run to the Harness's `kept` choice, saves it, and sets `modelChoiceNotice`.
- `resume-run` continues a `detached` Session in the same native Session because the executor reads the stored Session availability and passes its coordinate as
  `resume`; a Session recorded `unusable` fails the Attempt without ever opening a fresh Session (ADR 0022).

## Follow-up after an Agent-step Interrupt

- `send-follow-up-turn` (#354) is its own Operation and Offer, admitted only on the derived waiting basis: `deriveRun(...).hold` (`run-progress.ts`) reads the
  Run `blocked`, no gate or checkpoint, and the Store's `waitingAgentTurn` on the current Agent Step. The same derivation serves the Offer, settle-time
  admission (`claimHeldRun`, shared with the interactive controls), Harness adoption, and shutdown, so those readers agree. It is not the interactive send.
- It re-walks the Routing through `executeTrackedRouting` with the human's text as `followUp`; execution decides whether it still applies. The walk
  takes over the held Harness (`heldStep`, cleared from tracking first), so composition reuses it or, after a reopen, prepares one that resumes the
  detached Session. Like `send`, it settles at the follow-up Turn's admission (`settleAtAdmission`); a drive resting without admitting it settles
  `follow-up-turn-not-admitted`, and a fault after admission lands on the Run.
- A follow-up while the previous drive is still in flight is refused as not waiting: the walk's `blocked` write pushes the Offer just before that drive's
  `finally` clears `tracking.promise`, so a client acting on the very first waiting snapshot can be refused once, exactly as an interactive send is.
- Closing on this Agent-step waiting basis leaves the claim for Store reconciliation, which halts it without an `indeterminate` marker (#355, ADR 0035).
  Resume re-mints the same open Attempt and pauses `blocked` with the same follow-up Turn target; it sends no prompt and counts no retry. A follow-up resumes
  the detached Session. Crash recovery uses the same rule, and the halted Repeat-boundary Projection still names the interrupted Agent Step.
- An interrupted Interactive or Entry Turn stays `blocked` across close, like any ordinary interactive wait: its next Turn already resumes the Session.
  Gates and checkpoints also retain their blocked rests. A follow-up live at close follows the existing signal-stop rule, cancelling its Attempt and halting.

## Takeover

- A takeover that only re-owns a Run resting `blocked` settles synchronously in `runAndSettle` (it re-fences the owner, leaves the Run blocked, runs no execution).
  `startRun` must NOT set `tracking.promise` for it — the `promise === undefined` predicate is exactly what makes cancel/shutdown write the rest and release the owner
  rather than abort a dead signal and leave the Run stuck blocked with a leaked owner. The gate is `tracking.takeover === true && tracking.state === "blocked"`,
  captured before `runAndSettle`.

## Interactive-Step drive

- `send-interactive-turn`/`end-interactive-step` (#122) drive an interactive-agent Step the Run rests `blocked` at. The executor records **no** durable gate — the stored
  state is `blocked`, its basis derived from the current Step being `interactive-agent` (the same signal the TUI blocked-basis reads), and no Attempt settles until End.
- `beginInteractive` reuses the held owner (a blocked Run keeps it) or resumes+acquires a reopened one, then re-derives to confirm the Run is blocked at the named Step.
- `send` drives one human Turn (origin `human`, verbatim text as the transcript input) through the opaque Step driver against that owner and stays `blocked` between
  Turns (owner held, no execution promise, ADR 0031); its `blocked` write pushes the new transcript.
- `send` settles `applied` at the Turn's durable admission (#290), the Run already `running`, while `tracking.promise` still spans the whole Turn for cancel
  and shutdown. A Turn ending unadmitted (unusable Session, fenced admission, stopped first) settles `not-applied` (`interactive-turn-not-admitted`, or its
  own earlier Problem); a fault after admission lands on the Run's `problem`, since the Operation already settled.
- `interactiveStepTarget` derives the resting iteration's Attempt id and Session from the attempt log (a Step inside a Repeat group, or `fresh`, gets a
  per-Attempt Session). `end` publishes that Attempt (empty, succeeded, stages no commit) with `advanceState: "running"` and re-drives execution, which
  re-walks from the top, replays settled iterations, and skips the settled Step (#216).
- Both set `tracking.promise` (via a `start*` helper) so cancel-run and shutdown find and abort live work; interrupt reaches only the Turn's bound function.
  The abort reason decides the rest as the answer path does, and reaches clients through the Run Projection. `send` is refused blank at admission (before any stdin);
  the three ending controls use Run execution's `interactiveEndLegality` after `beginInteractive` confirms the Step and acquires or reuses its owner.
  The Application passes `interactiveTurnLive`, preserving its in-flight promise check, and translates refusals into the existing Problems.
- `continue-repeat` (#217) is `end` for a Step inside a human-controlled Repeat, which the scheduler re-walks into the next iteration.
  The Projection asks the same predicate which ending controls to offer, passing its durable Turn-live fact; its send, interrupt, and steer gates stay local.
- `end-stage` (#218) is `continue-repeat` whose published Attempt carries `endsStage`, one durable `attempt_log` mark: the re-walk finishes that iteration and exits
  the group, the Projection walks past it and reports `completion: "human-declared"` once the Run succeeds. Offered beside Continue; no tracker is read.

## Live overlay

- The private `live-overlay.ts` channel carries a `generation` that a raised or settled request bumps, each pushing a fresh overlay, so an answer formed against a
  superseded generation is refused as stale. Identified message previews go to per-Session history without bumping this generation,
  so an in-flight answer stays valid across them (#412).
- At Turn end `bindAnswer(undefined)` clears any still-outstanding request, bumps the generation, and sets the live phase to `settling` before announcing the overlay, so
  a resumed Run starts clean. The durable `request-expired` timeline row is execution's write, not the live lane's.
- A **durable** push (`pushRunUpdate`) fans out to this Run's observers **and** every Run-list observer and the Workspace Run summary (`pushRunCollectionUpdates`);
  a **live overlay** channel push reaches this Run's observers only. Launch and resume admission, cancel, and delete call that fan-out directly. The summary
  (`summarizeRuns`, #396) is one `countRuns` read and pushes only when a count changes; the quit guard trusts it, so a new ownership change or claim must reach the fan-out.
  Each fan-out with a Workspace observer open (always, in the TUI) opens every registered `run.db` once: O(Runs) per durable write.
- A late-joining observer catches up on the current overlay at open, so a follower connecting after a request was raised still sees it. By design a client can
  therefore receive live control updates for a Turn whose durable start it never saw: a headless follower opening mid-Turn observes the live request even though its
  durable Turn-start snapshot predates the connection.
- An approval Request's answer names its own source — `human` or `client-policy` (`HarnessAnswerSource`); the client declaring provenance is what lets the durable
  timeline render "answered by client policy" (`run-projection`) without the Adapter knowing a client policy exists.
