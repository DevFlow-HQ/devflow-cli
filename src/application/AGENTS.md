# application — Module-local notes

## Invariants

- Transcript cursors bind Run, Session, cutoff and order boundary; entry ids still hash the eligibility position (#497).

- `UpdateStream` appends replacing history previews after pruning them, so the last delivered window cutoff and earlier marker stay current (#488).
- Before changing Run reads, history, observer delivery, progress, context/usage, or Workspace path search, read
  [Application history](../../docs/agents/application-history.md).
- Workspace path matching removes a leading `./` before hidden-path opt-in and ranking; only explicit dot-name components reveal hidden paths (#447).
- Home-scoped `preferences` needs no Harness or approval. Its keys are raw strings; `change-preferences` returns the transaction's saved pair.
  The ledger replays receipts without saving again; failed saves are not-applied with no effects.
- Windows fallback notices are live launch evidence retained per Run for this Application lifetime (#363), across tracking replacement and Projection reopen.
  A fresh Application learns a notice only from a new fallback launch; the notice is not persisted Run truth.
  `RunNotices` snapshots all Run notices together and clears them together on deletion (#450).
- Every canonical Run write goes through `observedOwner`, whose getter reads the refreshed `record`. It intercepts `selectHarness`, `selectModelChoice`,
  `changeModelChoice`, `writeState`, `publishAttempt`, `recordMaterializationConflict`, `recordGateAnswer`, `recordPendingGate`, `admitTurn`,
  every `appendTurnEvent`, and `settleTurn`, pushing after commit; Turn appends coalesce and no-op receipts push nothing.
  A new owner method compiles without pushing unless intercepted (A3).
  A `run` Projection joins the Run-scoped observer Set even while rested; later tracking entries reuse it so resume and human drivers cannot orphan the stream.
- `answer-human-gate` serves two gate mechanisms off one Port operation (#108). The Projection derivation decides which: `derived.pendingGate` present is an
  **authored** gate, answered by settling its producing Attempt through `observedOwner.publishAttempt` (into `attempt_log`, so the resumed walk skips the gate) —
  `free-text` publishes the `text` answer as the gate's declared output and re-drives execution in this process, approve advances `running` and re-drives, reject
  settles `failed` and rests. Otherwise `derived.checkpoint` is a **derived Review checkpoint**, answered by `recordGateAnswer` exactly as M2 did (no `attempt_log`;
  the checkpoint stays derived). The live Gate is `derived.pendingGate?.gate ?? derived.checkpoint?.gate` (a blocked Run has exactly one), and the answer form must match
  `gate.shape` (`free-text` ⇒ `text`, `approve-reject` ⇒ `continue`/`stop`) or it is a `gate-shape-mismatch` Problem that changes nothing. Idempotency is keyed on the
  operation id (`gate_answer` row for a checkpoint; the in-process ledger for both) — never on whether the gate settled, so a _different_ operation answering an
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
  `saveLastModelChoice` runs after Run creation or a fenced choice change; failure keeps the Run choice and its notice across Projection reopen.
- `run` Offers follow `prepareModelChoice` or qualification. Ordinary reads never prepare a Harness. Changes share `model-choice.ts` and re-read authority after
  qualification.
  `RunOwner.currentTurn` avoids history (#395). Halves use the Run, never Preferences. Push with the writer's owner. See [live control](../../docs/agents/run-control.md).
- Preflight alone exempts exactly `0.0.0-dev` from the engine range and reports `preflight-engine-skip` at info level; catalog notes and
  strict-parse failures still use ordinary compatibility. Both launch assessment and resume use the stored archive's declared range (#367).
- Preflight takes the injected `ProcessAdapter` for command resolution and the Git worktree probe; it never constructs one, so tests drive it spawn-free.
- A pre-M4 Run with no selection upgrades only once its still-installed pinned Snapshot proves the routing needs a Harness. Reopen and direct resume write `claude-code`
  once
  through `observedOwner.selectHarness`; Command-only Runs and missing/corrupt Snapshot Problems stay unselected (#139). A Run with no Model choice takes the preselection
  once
  at the resume drive or a reopened human Turn (`upgradeLegacyModelChoice`), never at reopen; no preselection halts with a model correction naming `secant run model`.
- Human Turn admission reads the Run's selected Harness and its registration's static input rules before ledger admission (#358). The read acquires no owner;
  a pre-M4 unselected Run uses Claude Code's rules, matching its reopen/resume upgrade. A refusal consumes no Operation id and records no Turn.
- Execution stores `blocked` before returning a checkpoint pause, and the Application keeps that Run's owner open. The Projection still derives the checkpoint
  facts from the Attempt log, Verdict binding, and Gate answers; the stored state lets dead-owner reconciliation preserve the pending checkpoint.
- `liveElsewhere` (a Run live in another process, owner pid alive) is refused before resume/answer claim anything (`run-live-elsewhere`, owner named), and `readResource`
  refuses it too; `listRuns` throwing on a malformed row is caught in cancel/delete so nothing throws out of `submit` (A4).
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
  neither observer claims the other's outcome. `preparation-cancelled` with the Run's signal aborted joins `driveWithAbortProtocol` (#437);
  an established startup failure keeps its primary category and Harness Problem.
- `harness-catalog` caches one qualification promise/result per semantic Harness id for the Application lifetime (#188). List calls discovery only; focus initially
  reports `not-checked`, then publishes one durable normalized result. Qualification diagnostics are process-held Resources addressed by semantic id and checked time.
- `launch-preparation` and `submitLaunch` share `LaunchPreparation.evaluate` in `launch-preparation.ts` (#189), admitting under identical rules.
  `submitLaunch` takes the first finding; the Projection collects all in launch order with correction targets. Corrupt composition is a hard-stop `bundle` finding.
  A `harness-input-reserved` finding instead targets `harness` (#410), leaving installed bytes usable by another compatible Harness.
  Model-choice checking is assessment-only: `harnessCatalog.qualify` prepares the selected Harness when the draft is otherwise ready and needs one.
  Direct `submitLaunch` skips qualification, so an unsupported model surfaces at the first Turn as `not-started`/`model-unavailable`, rather than before creation.
- The observer (`observer.ts`, #319) has a no-op default and never sees the logger. Application guards it once at resolution (#330): an observer
  never throws into its caller or changes a Projection, qualification, or Operation outcome. The private `OperationLedger.submit` owns receipt identity,
  scheduling and records, reporting admission before even inline settlement. Replays compare both kind and fingerprint before fresh authorization;
  refused ids remain unconsumed. Events carry ids, kinds, Problem codes, and typed failure fields only — never input, Turn text, or Problem prose.
  Tracked Operation admission, outcome, and replay carry their `runId`; pre-Run Operations omit it (#331). Application reports its own committed rests
  (cancel, Gate stop, prepare refusal, and each human Turn's `interactiveTurnRest`) through `run-rest`; a fenced write reports none.
  `preflight` and `assessPreflight` share one evaluator that reports their start/settle and each check they run (`preflight-check-start`/`-settle`, #325).
- One settle path (`submitEndInteractiveStep` → `startEndInteractiveStep`) backs `end-interactive-step`, `continue-repeat` (#217), and `end-stage` (#218), so no
  iteration settles twice. Run execution's `interactiveEndLegality` owns the position and mid-Turn rules; Application only translates its refusals
  through `interactiveControlMismatch` and `interactiveStepMidTurn`. Claim and promise ordering remain [run-control's](../../docs/agents/run-control.md).
- App-release trust is a recorded Trust grant (operation id `app-release`) that the startup ensure (`shipped-bundles.ts`) writes only on an Entry whose
  origin is `built-in`, re-checked every startup, so launch, resume, and the timeline read it like any grant; `trustState` shows a grant on a built-in as
  `app-release`. Equal bytes a user imported first keep their own origin and trust (#227).
- `OperationLedger.submit/open/settledOperation` owns receipts, subscriptions, and settlement waiters; settlers return metadata, never mutate ledger entries (#393, #448).
  Run authorization, Trust ordering, owners and abort stay in `createApplication`. Shutdown ends pending ledger waits and subscriptions before Run cleanup.
  An observation-ended receipt has unknown effects and never replaces ledger truth; a later settlement remains readable (#448).

- ripgrep 15.1.0's `--no-require-git` disables linked-worktree `commondir` lookup. Use it only outside Git; native Git rules keep their precedence (#484).

## Tests

- Read a held Run through its Projection. `runGroup.acquireRun` bumps the fencing epoch and refuses that Run's next Turn as fenced (#353).

## Read next

- Read [run-control](../../docs/agents/run-control.md) before changing deferred settlement, cancel or shutdown, Turn interrupt or steer, takeover, the
  interactive-Step drive, or the live overlay; the abort-reason mapping is [execution's](../run/execution/AGENTS.md).
- `createApplication` keeps Run ownership, observers, admission, execution drives and shutdown together. Catalog, Harness Catalog,
  launch preparation and home-scoped Preferences delegate their Projections and use cases to private files.
