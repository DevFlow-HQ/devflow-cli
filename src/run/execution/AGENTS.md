# execution — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The cancel Seam's Run-wide sentinel strings are owned here: `RUN_CANCEL_ABORT` ends the Run `cancelled`, while `SIGNAL_ABORT` stops live work and
  leaves it resumable (ADR 0019). Turn interrupt uses `RequestChannel.bindInterrupt`, unbound at Turn end; receipt/result mapping lives in that binding
  ([run-control](../../../docs/agents/run-control.md#turn-interrupt-and-steer)), never on the Run's controller or routing promise.
- The Harness-facing half publishes nothing durable except through the three admitted Turn writes (`admitTurn`, `appendTurnEvent`, `settleTurn`); every
  other durable Run fact surfaces on the Attempt's later `publishAttempt`, never from executing a Turn.
  Steer settlement events carry their own id, full text, and send time, so execution records them before or after the acceptance receipt without a second write (#356).
- `driveHarnessTurn` reads the Run's Model choice once per Turn (`currentModelChoice`, ADR 0034). It sends that value on the Turn request and writes
  it on the `turn` row in the same `admitTurn`, for Agent, Entry, and human Turns alike, so a Turn's record is what it asked for. It reads the
  acquire-time `owner.record`, which holds only while no Run can change its request (#344).
- Every autonomous Agent Attempt publishes one co-sourced evidence value: qualified Harness identity plus its optional observed model. `attemptEvidence`
  fails fast if an Agent result lacks identity; Command/Gate and synthetic interactive Attempts publish neither (#147).
- An Agent Step's declared `text` outputs come only from Output receipts (#215): after a `completed` Turn each receipt must be a regular UTF-8 file of at most
  64 KiB, non-empty once trimmed, or the Attempt fails (retryable) and moves no binding. Assistant prose is never read as an output or as Routing control.
- Receipt paths reach the Agent only as appended prompt text — one `receiptInstruction` line per declared output after the rendered prompt — never as an env var
  or Harness option. A prompt-renderer or `produces` change that drops those lines fails every Agent Step that declares an output.
- Execution never hands the working area to the Harness; composition's prepare does (#214). Here it only fills the `{{run:working-area}}` prompt slot
  (`WORKING_AREA_SLOT`), typing an unusable area `working-area-unavailable`/`not-started`; Command steps never see it — their `cwd` resolves against the
  Workspace. A producing Step consumes `outputReceiptDirectory`'s typed result once, with no separate area check: its Problem kind becomes the
  `not-started` category (dropped with the rest of the detail until ADR 0041's evidence lands), so the failed Attempt admits and sends no Turn and
  follows the ordinary retry policy (#305).
- Every Command-step spawn passes its resolved authored environment through the Run Store entry's `isolatedGitEnvironment`; the helper appends
  non-interactive signing, hook, credential, and editor overrides after authored Git config entries, without changing user files or hiding ordinary
  system/global config (#166). `GIT_CONFIG_PARAMETERS` is removed because Git applies it after the counted entries and could undo the hardening.
- An Agent Step Attempt's Turn is `<attemptId>#turn-<n>`, `n` one past that Attempt's admitted Turns (#352): a walk resumed after a crash mid-Turn re-mints the
  same Attempt id behind the Store's UUID marker, so its Turn joins that Attempt rather than colliding with the `lost` row. `openAgentAttemptTurn` derives the
  open Agent Attempt's latest Turn from `turns()` and `attemptLog()` with no new record, counting only `kind: "agent"`; open is not waiting, so callers add the basis.
- A Port Interrupt of an Agent Step's Turn pauses with no Attempt published (#354): `waitingAgentTurn` (an open Attempt ending `interrupted`) is the
  Attempt-level waiting basis, and the walk rests `blocked`. A re-walk re-minting that Attempt sends `ExecutionDeps.followUp` verbatim as an `agent`,
  `human`-origin `#turn-<n>` only while its `turnId` is still that latest Turn; otherwise it pauses again and never re-sends the prompt. The follow-up
  keeps the Attempt's receipt directory, adds no receipt lines, and its Turn gives the Attempt its outcome. A signal still cancels the Attempt and halts.
- An interactive-agent Step's Entry Turn (`entryTurn`) is due only while no Turn of its Attempt was admitted, so no later walk re-sends it; none publishes
  an Attempt, only `end-interactive-step` does (#212). `interactiveTurnRest` decides the rest after every Interactive Turn, Entry or human (#353): an
  Interrupt waits `blocked`, a `lost` Turn halts. A signal also settles a live Turn `interrupted` without throwing, so the aborted signal, not the result
  kind, keeps it halting (ADR 0019).
- `runRepeatGroup` has two branches (#217): the Verdict-driven one re-reads `until` after each iteration and blocks at the Review cadence; the human-controlled
  one (`control: "human"`) reads no Verdict and raises no checkpoint, resting `blocked` at each iteration's interactive Step. Neither reads agent text to choose the exit.
- `interactiveEndLegality` owns the ending controls' rules, shared by Application settlement and Offers: End Step outside a human-controlled Repeat,
  Continue or End Stage inside one, all only at a Turn boundary. A live Turn takes precedence over a position mismatch. Callers confirm the active Step
  and supply Turn liveness; Application includes its in-flight promise, while the Projection uses durable Turn records.
  Confirmed End Stage publishes the iteration's Attempt marked `endsStage`, so the walk exits the group once (#218).
- Each Repeat iteration of an Interactive Step is its own Attempt (`encodeAttemptId` carries the iteration) with its own Session (`interactiveSession` scopes the
  name to that Attempt id), so Continue always opens a fresh conversation; `interactiveStepTarget` finds the resting iteration from the log (#216).
- `observe` is guarded once at each entry (`executeRouting` and `driveInteractiveTurn`) by the shared `observer.ts` rule (#330): an observer never
  throws into its caller or changes a Run, Attempt, or Turn outcome. It reports the Run, Attempt, and Turn lifecycle by id only (#320):
  each start ends in `-end`, an `attempt-pause` awaiting a human, or an `-unwind` when the walk throws, which claims no outcome.
  Human Turns take it on `InteractiveTurnRequest`; the Application reports the Attempts it settles.
- Execution's own Run Store writes report `store-write-start`/`-end` through `observedWrite` (`store-write.ts`, #325): the state write, Attempt publish,
  pending gate, Materialization conflict, Turn admission, and Turn settlement, by kind and ids only. `appendTurnEvent` runs per transcript item and
  reports nothing; the Run Store Interface takes no observer.
