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
- Every opened Projection owns one `UpdateStream` (#306, #488). Session history retains one latest unread complete page and one later preview per
  retained row; a new page replaces all unread history state, and a preview replaces its same-row predecessor and drops evicted previews.
  History charges exact encoded UTF-8 JSON bytes (`encoded-json.ts`) against 8 MiB with no oversized-update exception (#490); other families remain
  FIFO, bounded at 1,000 unread updates and 8 Mi estimated units, and admit one update into an empty backlog. Overflow ends only that subscription
  through `end("observer-lagged")`, releasing backlog and delivering one `closed` ahead of it. Producers never wait; other observers and the Run
  continue, and reopen reads current state. Bounded rows keep one page plus one preview per row under the allowance, so history cannot lag on size.
- `SubscriptionLifecycle` privately creates every stream, including delegated and idle views (#310); termination unregisters its producer and drops retained delivery
  state. Shutdown ends observation before owner cleanup and awaiting work; [run-control](run-control.md) owns its claim rules.
  Keep empty Run observer Sets: live fan-out retains their identity. Later opens remain supported; shutdown memoizes in-flight cleanup only.
- History content (#489, #490) reads UTF-16 portions of at most 4,095 units (4,096 when one keeps a surrogate pair split at its start) or eight normalized
  items, with at most 32 active traversals per Application.
  Continuations stay on one exact version. Stored references keep append-only event coordinates, or the immutable index fact for Turn inputs and
  migrated messages, never cached bodies; release drops a traversal's body. A text continuation carries the total, its resuming part, and the edge
  analyser's state, so a sequential read is linear (#514). A seek walks from its traversal's nearest checkpoint (part position and analyser state,
  every eight pages, widened to at most 128 per traversal). Seeks and sequential reads keep the first point they reach in each spacing, so once a
  span has been read a seek into it walks at most one spacing plus a page; only the first walk into an unread span starts further back (#520).
  Checkpoints die with the traversal and never reach a cursor or the Store. Live previews and derived Turn results are held versions that survive
  only current windows and active traversals. A live preview over a stored start reads its own value. Closing one observer releases only its reads.
  Every variable-length field is a preview with a reference: messages, Thoughts, Entry prompts and Steers inline up to 4,095 units and 12 KiB
  encoded (`reference`); Agent calls, Requests, activity and Turn results cap strings at 512 units/1 KiB (`detail`); tool strings keep 512 units,
  paths 128 units/256 bytes, and file names the existing ten. Cut Step headers keep a digest. Each projected row stays under 18 KiB.
  Trusted TUI composition supplies text edge analysis privately; read callers cannot receive a source iterator. Raw content stays exact.
- `session-history` (#412–#417) bounds messages/tools/Thoughts/Turn diffs together at 200 with one 50 ms budget for every pending row.
  The index keeps values only for each Session's newest 200 rows; an evicted row keeps order, identity, and its Store coordinate and reads its value
  again on re-entry. The index is built from the body-free `historyOutline`; a page reads its window's unread event bodies in one `turnEventsAt`
  pass, and Turn inputs and migrated messages per row (#522). A Store failure on any window read fails the whole page. When a read body fails its
  schema, the index is rebuilt without that row, as a full build skipped it. The index and its content versions are released once no observer or
  live owner holds the Run (#514).
  Final output replaces previews; empty clears, absent retains incomplete tails. Partials invalidate previews without settling tools; last observer cancels the timer.
  Transcript Resources retain separate entry ids across reads/prepend, excluded from headless; pages still hold 20 entries.
- The `run` Projection exposes the immutable stored semantic id as `run.selectedHarness` before any Attempt and
  independently exposes the latest Agent-step Attempt's normalized name/executable/version as `run.harness` plus its sibling `effectiveModel` (#125, #147).
  Resume may replace only the observed fields; Command-only Runs omit both selection and observations.
- The Run Store appends the reconciliation `indeterminate` marker row to `attempt_log` (see [the Run Store's notes](../../src/run/store/AGENTS.md)). Its id names
  no Step, so progress attributes it to none: it is neither a success nor evidence a node was reached.
- `bindAnswer` clears context/usage for every new Turn; reports replace optional fields, including empty reports (#418). Accounting stays live-only.
- Workspace search resolves the Run through `readRun` without acquiring an owner; terminal or unavailable Runs never start listing (#482).
  One token signal owns a capped embedded-ripgrep listing; edits re-rank it, abort disposes it, and shutdown drains active helpers (#484).
  Never read candidate content or suggest symlinks/.git internals (#423).

## History order and identity

- `observedOwner.appendTurnEvent` passes first-appearance metadata through `history.append` before the fenced Store write, then indexes its committed receipt.
  The per-Run index initializes once per observed owner; previews read no Store facts, and repeated chunks derive no page. Unchanged pages publish nothing.
  A rested reopen or changed owner refreshes canonical facts before index reuse, preserving the live-elsewhere refusal.
  `history.append` stamps the first `historyOrder` for an identified message, Thought, tool, diff, Steer, Agent call, or Request event.
  Previews share that first-appearance order with their settled fact. Execution never stamps it independently.
- Each `session-history` subscription mints its own opaque row `id` and `position`; retained rows keep them across preview replacement and settlement.
  Reopening creates new identities and a fresh eviction cutoff. Cutoffs belong to subscriptions, so a settled preview cannot permanently hide stored rows
  from a later open. They are presentation identities, never native call ids, Store keys, or retained transcript entry ids.

- `conversation-order.ts` owns the comparator shared by Session history, transcript pages and exports: Turn Run sequence, input first, then first appearance.
  Retained transcript ids still use eligibility positions, independently of that order. `transcript-resource.ts` captures one cutoff per traversal or export;
  older cursors carry Run, Session, cutoff and an exclusive order boundary. An export reads bounded Session pages under its fresh cutoff.
- Migrated legacy input precedes event write order; later conversation rows retain authoritative migrated transcript order before the Turn result.
  Legacy message positions never compare directly with Run-wide event indexes.
