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

Before changing Turn interrupt, Steer, live Model choice changes, or Agent follow-up, read [live Turn control](./run-turn-control.md).

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
  superseded generation is refused as stale. Message, tool, Thought, and diff previews go to per-Session history without bumping this generation,
  so an in-flight answer stays valid across them (#412).
- At Turn end `bindAnswer(undefined)` clears any still-outstanding request, bumps the generation, and sets the live phase to `settling` before announcing the overlay, so
  a resumed Run starts clean. The durable `request-expired` timeline row is execution's write, not the live lane's.
- A **durable** push (`pushRunUpdate`) fans out to this Run's observers **and** every Run-list observer and the Workspace Run summary (`pushRunCollectionUpdates`);
  a **live overlay** channel push reaches this Run's observers only. `observedOwner` also fans out successful Turn-event and settlement writes (#412).
  Launch and resume admission, cancel, and delete call that fan-out directly. The summary
  (`summarizeRuns`, #396) is one `countRuns` read and pushes only when a count changes; the quit guard trusts it, so a new ownership change or claim must reach the
  fan-out.
  Each fan-out with a Workspace observer open (always, in the TUI) opens every registered `run.db` once: O(Runs) per durable write.
- A late-joining observer catches up on the current overlay at open, so a follower connecting after a request was raised still sees it. By design a client can
  therefore receive live control updates for a Turn whose durable start it never saw: a headless follower opening mid-Turn observes the live request even though its
  durable Turn-start snapshot predates the connection.
- An approval Request's answer names its own source — `human` or `client-policy` (`HarnessAnswerSource`); the client declaring provenance is what lets the durable
  timeline render "answered by client policy" (`run-projection`) without the Adapter knowing a client policy exists.
