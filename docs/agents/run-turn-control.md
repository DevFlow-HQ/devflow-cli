# Live Turn interrupt, steer, and follow-up

Read before changing Application Turn interrupt, Steer, live Model choice changes, or Agent follow-up.
[Live Run control](./run-control.md) owns cancellation, shutdown, ownership, and interactive drive.

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
  `RequestChannel.bindSteer` hook, unbound at Turn end alongside `bindAnswer`); a native control race settles `steer-rejected`, a stale/settled turnId
  `turn-control-rejected`,
  an accepted steer `applied`, Run still running. Its Operation id is the opaque Steer id through execution to the Harness; replay never sends it twice (#356). Its waiting
  and settlement writes follow [execution's Turn writes](../../src/run/execution/AGENTS.md); history keeps one row per Steer and transcript reads include
  delivered Steers only.
  A refused write after Harness acceptance reports `steer-not-recorded` with unknown effects, never a native rejection with no effects.
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
  `follow-up-turn-not-admitted`, and a fault after admission rests the Run `halted` with its cause, as every faulted drive does
  ([run-control](./run-control.md)), and puts the Problem on the Run.
- A follow-up while the previous drive is still in flight is refused as not waiting: the walk's `blocked` write pushes the Offer just before that drive's
  `finally` clears `tracking.promise`, so a client acting on the very first waiting snapshot can be refused once, exactly as an interactive send is.
- Closing on this Agent-step waiting basis leaves the claim for Store reconciliation, which halts it without an `indeterminate` marker (#355, ADR 0035).
  Resume re-mints the same open Attempt and pauses `blocked` with the same follow-up Turn target; it sends no prompt and counts no retry. A follow-up resumes
  the detached Session. Crash recovery uses the same rule, and the halted Repeat-boundary Projection still names the interrupted Agent Step.
- An interrupted Interactive or Entry Turn stays `blocked` across close, like any ordinary interactive wait: its next Turn already resumes the Session.
  Gates and checkpoints also retain their blocked rests. A follow-up live at close follows the existing signal-stop rule, cancelling its Attempt and halting.
