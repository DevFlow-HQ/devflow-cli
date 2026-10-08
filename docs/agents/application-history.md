# Application history and read projections

Read before changing Run reads, history, observer delivery, progress, context/usage, or Workspace path search.
The [Application notes](../../src/application/AGENTS.md) keep write and admission rules.

- Never `acquireRun` a Run merely to read it when it is live in another process: acquiring bumps the owner-fencing epoch and would abort the process
  running it. `readResource`/`runResult` read through the live in-process owner when present, else acquire-and-close a rested Run, else refuse with
  `run-live-elsewhere`.
- The timeline is ordered by `at` (`buildTimeline`), then by Step instance (the Attempt's log index; an unsettled Attempt's Turns after every settled one), then
  category, for equal instants (A2, #98, #289), so one Step's events never interleave with the next Step's. Events are still built category by category, then sorted,
  so a later Attempt never moves an earlier event. ISO 8601 sorts lexicographically, so the string compare is the time compare.
- Each event's `step` and each Session's plain name come from stored Attempt ids (`attemptStepId`, `attemptIteration`, #289): a Session whose recorded name
  differs from its Step's authored one was scoped to an Attempt, so it reads "<authored>, iteration <n>". Nothing new is persisted.
- `run-progress.ts` owns Run progress (#384): each Attempt counts for its Step and Iteration (`attemptStepId`/`attemptIteration`), never as another group's
  Iteration, and a Review grant resets only its own group. A group ends once a later node is reached (an Attempt or pending Gate), End Stage closes its last
  Iteration, or `until` passes. The Projection and every control (hold basis, Gate answers, interactive admission) read its `deriveRun`.
- The client `RunStateName` has no `created` and gains `cancelled` (A7); the Run Store still records `created` internally, and `toRunState` maps it to `running` for the
  Projection — a launched Run reads `running` from admission.
- Every opened Projection owns one `UpdateStream` (#306): a FIFO that never coalesces or evicts, bounded at 1,000 unread updates and 8 Mi payload units (T3 Code's
  limits). Overflow ends only that subscription through `end("observer-lagged")`, which releases the backlog and delivers one `closed` ahead of it; `pushRunClosed`
  uses the same `end`. The producer never waits or fails, so the Run and its other observers continue, and a reopen reads a fresh snapshot and live catch-up.
- `SubscriptionLifecycle` privately creates every stream, including delegated and idle views (#310); termination unregisters its producer and drops retained delivery
  state. Shutdown ends observation before owner cleanup and awaiting work; [run-control](run-control.md) owns its claim rules.
  Keep empty Run observer Sets: live fan-out retains their identity. Later opens remain supported; shutdown memoizes in-flight cleanup only.
- `session-history` (#412–#417) bounds messages/tools/Thoughts/Turn diffs together at 200 with one 50 ms budget for every pending row.
  Final output replaces previews; empty clears, absent retains incomplete tails. Partials invalidate previews without settling tools; last observer cancels the timer.
  Transcript Resources retain separate entry ids across reads/prepend, excluded from headless; pages still hold 20 entries.
- The `run` Projection exposes the immutable stored semantic id as `run.selectedHarness` before any Attempt and
  independently exposes the latest Agent-step Attempt's normalized name/executable/version as `run.harness` plus its sibling `effectiveModel` (#125, #147).
  Resume may replace only the observed fields; Command-only Runs omit both selection and observations.
- The Run Store appends the reconciliation `indeterminate` marker row to `attempt_log` (see [the Run Store's notes](../../src/run/store/AGENTS.md)). Its id names
  no Step, so progress attributes it to none: it is neither a success nor evidence a node was reached.
- `bindAnswer` clears context/usage for every new Turn; reports replace optional fields, including empty reports (#418). Accounting stays live-only.
- Workspace search bounds traversal and reads only ignore metadata. Never read candidate content or suggest escaping symlinks/.git internals (#423).

## History order and identity

- `observedOwner.appendTurnEvent` passes each append through `history.append` before the fenced Store write, then pushes only after a successful receipt.
  `history.append` stamps the first `historyOrder` for an identified message, Thought, tool, diff, Steer, Agent call, or Request event.
  Previews share that first-appearance order with their settled fact. Execution never stamps it independently.
- Each `session-history` subscription mints its own opaque row `id` and `position`; retained rows keep them across preview replacement and settlement.
  Reopening creates new identities. They are presentation identities, never native call ids, Store keys, or retained transcript entry ids.
