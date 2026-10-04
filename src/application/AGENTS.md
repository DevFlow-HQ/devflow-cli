# application — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Windows fallback notices are live launch evidence retained per Run for this Application lifetime (#363), across tracking replacement and Projection reopen.
  A fresh Application learns a notice only from a new fallback launch; the notice is not persisted Run truth.
- Every canonical write to a Run must go through `observedOwner`, not the raw `RunOwner`, or an open client's live `run` Projection never updates. `observedOwner` spreads
  `...owner`, reads `record` through a getter (a spread copy goes stale after an upgrade write), and intercepts nine methods — `selectHarness`, `selectModelChoice` (#342),
  `writeState`, `publishAttempt`, `recordMaterializationConflict`, `recordGateAnswer`, `recordPendingGate` (the authored gate, #108, which rests the Run `blocked` in its own
  transaction), `admitTurn` (#290), and `appendTurnEvent` for Steer settlements (#356), pushing a fresh snapshot after each commits. A `run` Projection registers in the
  Run-scoped observer set even while rested; every later tracking entry reuses that set, so resume, gate-answer, and interactive drivers cannot orphan the stream. A new
  `RunOwner` write method compiles and silently pushes nothing (A3).
- `answer-human-gate` serves two gate mechanisms off one Port operation (#108). The Projection derivation decides which: `derived.pendingGate` present is an
  **authored** gate, answered by settling its producing Attempt through `observedOwner.publishAttempt` (into `attempt_log`, so the resumed walk skips the gate) —
  `free-text` publishes the `text` answer as the gate's declared output and re-drives execution in this process, approve advances `running` and re-drives, reject
  settles `failed` and rests. Otherwise `derived.checkpoint` is a **derived Review checkpoint**, answered by `recordGateAnswer` exactly as M2 did (no `attempt_log`;
  the checkpoint stays derived). The live Gate is `derived.pendingGate?.gate ?? derived.checkpoint?.gate` (a blocked Run has exactly one), and the answer form must match
  `gate.shape` (`free-text` ⇒ `text`, `approve-reject` ⇒ `continue`/`stop`) or it is a `gate-shape-mismatch` Problem that changes nothing. Idempotency is keyed on the
  operation id (`gate_answer` row for a checkpoint; the in-process operations map for both) — never on whether the gate settled, so a _different_ operation answering an
  already-answered gate falls through to the staleness check and is refused, not silently masked as `applied`.
- Cancelling an authored Human Gate retains its `pending_gate` record (#336); surface it as `derived.pendingGate` only while the stored Run state is
  `blocked`, so a terminal Run projects its stored state and offers deletion.
- The Trust grant is written only after `createRun` succeeds: any refusal reached before creation (a mismatching trust acknowledgement, a failed
  Preflight) returns without a grant, so it never leaves a dangling one. (`createRun` itself no longer refuses — ADR 0031 admits any number of live
  Runs.) Preflight runs before the Trust gate, so a Run whose preconditions fail is refused before trust is ever asked for.
- New Agent/Interactive-agent Runs require one known, available registry id and pin it in `createRun`; Command-only Runs reject a selection as irrelevant.
  The launch replay key includes the choice, and resume automatically reuses the immutable stored id without deriving it from Attempt evidence (#138, #146).
- Agent-bearing Runs hold a Model choice. `launch-preparation` resolves draft, valid last choice, reported default, then Adapter fallback.
  It applies the effort lock to any preselection and refuses contradicting effort with correction `effort`; `submit` requires a model and trusts the Offer's effort.
- Each focus open and assessment reads Preferences outside the qualification cache; stale model/effort skips the whole choice with a notice.
  `saveLastModelChoice` runs after Run creation; its failure notice survives Projection reopen for this Application lifetime.
- Preflight alone exempts exactly `0.0.0-dev` from the engine range and reports `preflight-engine-skip` at info level; catalog notes and
  strict-parse failures still use ordinary compatibility. Both launch assessment and resume use the stored archive's declared range (#367).
- Preflight takes the injected `ProcessAdapter` for command resolution and the Git worktree probe; it never constructs one, so tests drive it spawn-free.
- A pre-M4 Run with no selection upgrades only once its still-installed pinned Snapshot proves the routing needs a Harness. Reopen and direct resume write `claude-code` once
  through `observedOwner.selectHarness`; Command-only Runs and missing/corrupt Snapshot Problems stay unselected (#139). A Run with no Model choice takes the preselection once
  at the resume drive or a reopened human Turn (`upgradeLegacyModelChoice`), never at reopen; other drives skip it without an await.
- Human Turn admission reads the Run's selected Harness and its registration's static input rules before `admit` (#358). The read acquires no owner;
  a pre-M4 unselected Run uses Claude Code's rules, matching its reopen/resume upgrade. A refusal consumes no Operation id and records no Turn.
- Never `acquireRun` a Run merely to read it when it is live in another process: acquiring bumps the owner-fencing epoch and would abort the process
  running it. `readResource`/`runResult` read through the live in-process owner when present, else acquire-and-close a rested Run, else refuse with
  `run-live-elsewhere`.
- Execution stores `blocked` before returning a checkpoint pause, and the Application keeps that Run's owner open. The Projection still derives the checkpoint
  facts from the Attempt log, Verdict binding, and Gate answers; the stored state lets dead-owner reconciliation preserve the pending checkpoint.
- The timeline is ordered by `at` (`buildTimeline`), then by Step instance (the Attempt's log index; an unsettled Attempt's Turns after every settled one), then
  category, for equal instants (A2, #98, #289), so one Step's events never interleave with the next Step's. Events are still built category by category, then sorted,
  so a later Attempt never moves an earlier event. ISO 8601 sorts lexicographically, so the string compare is the time compare.
- Each event's `step` and each Session's plain name come from stored Attempt ids (`attemptStepId`, `attemptIteration`, #289): a Session whose recorded name
  differs from its Step's authored one was scoped to an Attempt, so it reads "<authored>, iteration <n>". Nothing new is persisted.
- When the Attempt log ends on a passing Repeat Verdict, projection advances beyond the group before inspecting the next node. An authored Human Gate already has a
  durable `pending_gate` then but deliberately has no Attempt-log entry until answered; parking on the deciding Command would hide the gate and its answer Offer.
- `liveElsewhere` (a Run live in another process, owner pid alive) is refused before resume/answer claim anything (`run-live-elsewhere`, owner named), and `readResource`
  refuses it too; `listRuns` throwing on a malformed row is caught in cancel/delete so nothing throws out of `submit` (A4).
- The client `RunStateName` has no `created` and gains `cancelled` (A7); the Run Store still records `created` internally, and `toRunState` maps it to `running` for the
  Projection — a launched Run reads `running` from admission.
- The closed registry and prepared Harnesses live in composition, not Application (#116, #146): the Port sees normalized choices/availability, while selected-only
  Preflight sees normalized discovery and capabilities. `makeRunExecution` resolves the durable id and prepares only that Adapter; on a `blocked` rest
  composition transfers an opaque Step driver (`heldStep`), kept only on the hold basis ([run-control](../../docs/agents/run-control.md)) and closed
  otherwise. Every human Turn reuses it, an Interrupt keeps it held (#353), a follow-up hands it back to the re-walk, and End, a `halted` Turn rest,
  cancel, or shutdown closes it exactly once. Preflight refuses discovery/capability failures before creation.
  `supportsInteractiveTurns` remains the client fact Application forwards to Preflight.
- A typed `prepare` failure is translated in one place, `haltForHarnessFailure` (#304): every drive reaches it — `executeTrackedRouting` for launch, resume, both
  Gate answers, End Step, Continue, End Stage, and the follow-up (#354), and the reopened human Turn directly. It rests the Run `halted` through
  `observedOwner`, settles the Operation `selected-harness-unavailable`, and releases the owner; an answer or Attempt committed before the drive stays
  committed. Composition reports the preparation refusal as `harness-unavailable`; Application reports its committed `halted` rest separately, so
  neither observer claims the other's outcome.
- Every opened Projection owns one `UpdateStream` (#306): a FIFO that never coalesces or evicts, bounded at 1,000 unread updates and 8 Mi payload units (T3 Code's
  limits). Overflow ends only that subscription through `end("observer-lagged")`, which releases the backlog and delivers one `closed` ahead of it; `pushRunClosed`
  uses the same `end`. The producer never waits or fails, so the Run and its other observers continue, and a reopen reads a fresh snapshot and live catch-up.
- `SubscriptionLifecycle` privately creates every stream, including delegated and idle views (#310); termination unregisters its producer and drops retained delivery
  state. Shutdown ends observation before owner cleanup and awaiting work; [run-control](../../docs/agents/run-control.md) owns its claim rules.
  Keep empty Run observer Sets: live fan-out retains their identity. Later opens remain supported; shutdown memoizes in-flight cleanup only.
- `harness-catalog` caches one qualification promise/result per semantic Harness id for the Application lifetime (#188). List calls discovery only; focus initially
  reports `not-checked`, then publishes one durable normalized result. Qualification diagnostics are process-held Resources addressed by semantic id and checked time.
- `launch-preparation` and `submitLaunch` share one create-time evaluator (`LaunchPreparation.evaluate`, `launch-preparation.ts`) so both admit under identical rules (#189):
  `submitLaunch` takes its first finding; the Projection collects all in launch order, each with a `correction` target. Composition-corruption is a single hard-stop `bundle`
  finding like missing/invalid bytes. The Model-choice check is assessment-only — the Projection qualifies the selected Harness (`harnessCatalog.qualify`, which spawns)
  whenever the draft is otherwise ready and needs one; a direct `submitLaunch` skips it, so a model outside the Harness's list surfaces at the first Turn as
  a `not-started` `model-unavailable` Turn, not as a pre-create refusal.
- The observer (`observer.ts`, #319) has a no-op default and never sees the logger. Application guards it once at resolution (#330): an observer
  never throws into its caller or changes a Projection, qualification, or Operation outcome. Every new Operation is admitted through `admit`, which reports the
  admission before scheduling settlement, so the record precedes an inline outcome; `submit` reports only replays and refusals. An Operation stored any
  other way is never logged as admitted. Events carry ids, kinds, Problem codes, and typed failure fields only — never input, Turn text, or Problem prose.
  Tracked Operation admission, outcome, and replay carry their `runId`; pre-Run Operations omit it (#331). Application reports its own committed rests
  (cancel, Gate stop, prepare refusal, and each human Turn's `interactiveTurnRest`) through `run-rest`; a fenced write reports none.
  `preflight` and `assessPreflight` share one evaluator that reports their start/settle and each check they run (`preflight-check-start`/`-settle`, #325).
- Steer `appendTurnEvent` writes push a durable snapshot immediately (#356). Other Turn events and `settleTurn` push no snapshot until the next intercepted write;
  activity reaches open clients through the separate live overlay. The Projection validates Steer payloads and exposes full text separately from capped timeline detail.
  Decided, not yet built: ADR 0039 publishes each stored Turn row to the per-Session history family during the Turn, keeping the three admitted writes.
- The `run` Projection exposes the immutable stored semantic id as `run.selectedHarness` before any Attempt and
  independently exposes the latest Agent-step Attempt's normalized name/executable/version as `run.harness` plus its sibling `effectiveModel` (#125, #147).
  Resume may replace only the observed fields; Command-only Runs omit both selection and observations.
- `deriveRun`'s walk assumes `attempt_log` holds only per-Step Attempts, but the Run Store already appends the reconciliation `indeterminate` marker row
  there (see [the Run Store's notes](../run/store/AGENTS.md)). The marker is harmless only because its outcome is not `succeeded`, not because the walk
  excludes it — keep that true if you add marker rows.
- One settle path (`submitEndInteractiveStep` → `startEndInteractiveStep`) backs `end-interactive-step`, `continue-repeat` (#217), and `end-stage` (#218), so no
  iteration settles twice. Run execution's `interactiveEndLegality` owns the position and mid-Turn rules; Application only translates its refusals
  through `interactiveControlMismatch` and `interactiveStepMidTurn`. Claim and promise ordering remain [run-control's](../../docs/agents/run-control.md).
- App-release trust is a recorded Trust grant (operation id `app-release`) that the startup ensure (`shipped-bundles.ts`) writes only on an Entry whose
  origin is `built-in`, re-checked every startup, so launch, resume, and the timeline read it like any grant; `trustState` shows a grant on a built-in as
  `app-release`. Equal bytes a user imported first keep their own origin and trust (#227).
- `createApplication` stays one closure: its `runs` and operations maps and observer Sets share settlement, owner-release, and shutdown ordering (#303 A3).
  Its private children are `launch-preparation`, `harness-catalog`, `live-overlay`, and `subscription-lifecycle`.

## Tests

- A test reads a Run the Application holds through the Projection, never `runGroup.acquireRun`: acquiring bumps the fencing epoch even in-process, so a
  `blocked` Run's held owner then refuses the next Turn's admission as fenced (#353).

## Read next

- Read [run-control](../../docs/agents/run-control.md) before changing deferred settlement, cancel or shutdown, Turn interrupt or steer, takeover, the
  interactive-Step drive, or the live overlay; the abort-reason mapping is [execution's](../run/execution/AGENTS.md).
- `createApplication`'s regions, in order: (1) state, observers, `observedOwner`, and the execution drivers (`runAndSettle`, `startRun`); (2) Projection dispatch
  (`openProjection`, `openRunProjection`), with the catalog and launch-preparation families in their own files; (3) approval, launch, and resume (`submitApprove`,
  `submitLaunch`, `resumePreconditions`, `submitResume`); (4) gate and Harness-request answering, then Turn interrupt and steer (`submitAnswer` through `steerTurnAndSettle`);
  (5) interactive turns (`claimHeldRun` through `runInteractiveEnd`, the follow-up included), then cancel, delete, read-acquire, and `shutdown`.
