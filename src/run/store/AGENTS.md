# store — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- `turnEventAt` indexes the same append-only, conversation-excluded sequence as `turnEvents`; new writes never shift an exact Resource (#489).

- Before changing Turn admission, settlement, event payloads, or transcript migration and reads, read
  [Store conversation](../../../docs/agents/run-store-conversation.md).
- Before changing Artifact reads/publication, Gate-answer publication, output receipts, or working-area access, read
  [Store artifacts](../../../docs/agents/run-store-artifacts.md).
- `run.db` is the only canonical truth and owns its Run's nullable process id plus monotonic fencing epoch. `coordination.db` holds only registration and
  create/delete admission and is rebuildable: a corrupt one is deleted and re-seeded from readable Run Stores without changing their owner records.
- `run_record.selected_harness` is the immutable semantic Run selection, written in the staged store before create publishes. It is nullable only for
  Command-only and pre-M4 Runs, validates as closed `claude-code | codex` at read ingress, and stays distinct from per-Attempt Harness/model evidence (#138, #146).
  `RunOwner.selectHarness` is the sole legacy upgrade write: fenced, null-only, and idempotent when the same immutable id is already present (#139).
- `run_record.requested_model`/`requested_effort` hold the Run-wide choice (ADR 0034), staged at create with the selected Harness and null for Command-only or
  pre-#342 Runs. `selectModelChoice` upgrades only null, idempotently for the same choice; `changeModelChoice` replaces it through a fenced transaction.
  Execution copies the choice onto each Turn; observed `effective_model` stays separate. Both choice writes refresh `RunOwner.record`, as `selectHarness` does.
- Ownership is per Run, not per Workspace (ADR 0031): each Run Store carries one owner record; an absent record reads unowned at epoch zero. There is no
  Workspace-wide claim column and no one-live-Run index, so any number of Runs may be live in one Workspace at once, each owned separately.
  `createRun` never refuses for the Workspace and two concurrent creates both succeed; ownership is set on the create/resume claim and released only on
  rest/delete/takeover — including _held through_ derived-`blocked`, so a Review checkpoint is answered in the instance that reached it.
- Create publishes by renaming the `.creating` quarantine into place as the last step before the transaction commits; delete drops the registration first,
  then reclaims the directory. Any failure before those points leaves only a quarantine (or an unadopted directory) the next open removes. The one window
  left is process death between a successful rename and the commit — the same accepted micro-window the Catalog carries.
- Coordination open retries migration once before corruption recovery: concurrent migrators may both read a stale journal, then the loser must reopen and
  observe the winner's committed generated ALTER rather than deleting the healthy database underneath it. Only `SQLITE_CORRUPT`/`SQLITE_NOTADB` enters
  destructive rebuild; permission, I/O, lock, and other failures propagate with their cause.
- Startup quarantine cleanup and the registration snapshot/orphan sweep hold one immediate `coordination.db` transaction, shared with create/delete admission.
  An intact coordinator is authoritative; unregistered directories are crash orphans. A live create's quarantine and renamed-before-commit directory
  are protected by its admission lock. Delete reclamation takes the same lock after its registration commits, so a racing startup sweep cannot interrupt its rename.
- Owner fencing is a monotonic epoch bumped on every `acquireRun`. Every canonical write opens one immediate `run.db` transaction, reads the epoch first,
  refuses a stale owner without writing, and otherwise performs the whole write in that transaction; private writers take that transaction and never open
  another. `publishAttempt` and `recordGateAnswer` keep a cheap check before staging Git but repeat the authoritative check inside the write transaction.
  `acquireRun` bumps the epoch without claiming, so a Projection read never marks a resting Run live. Only takeover claims this process while bumping;
  `endRun` releases only this process's ownership and leaves the store until explicit deletion.
- Takeover is what makes ownership safe, not the probe (ADR 0031): a plain `acquireRun`/`resumeRun` declines a Run owned by a live _other_ process (the
  courtesy probe, `process.kill(pid, 0)`), so the Application can confirm before fencing; the `takeover` flag bumps the epoch anyway, so the previous owner's
  next canonical write is refused. `resumeRun` refuses such a Run `run-live-elsewhere` with its `ownerPid`; a takeover is
  `acquireRun({ takeover: true })`.
- Every `run.db` handle a Run Store opens is closed before its directory is renamed or the group closes, so Windows temp cleanup is never blocked by a lock.
- Startup reconciliation (#86, #98 S2, ADR 0031): at open every registration opens its `run.db`, reads the owner, probes it, and performs any rest plus
  release inside that same immediate transaction (`process.kill(pid, 0)` is injectable as `isOwnerAlive`). An owner still alive in another process is a
  Run genuinely live there — left untouched, listed with its `ownerPid` so the Application can refuse `run-live-elsewhere`. A dead owner is reconciled
  by stored state: a `running`/`created` record rests `halted` with one `indeterminate` attempt-log marker. A `blocked` Run whose open Agent Attempt's
  latest Turn is `interrupted` also halts, without a marker (#355, ADR 0035); all other blocked rests stay blocked. Both close and crash use this rule.
  Ownership is released without Step work. Unowned legacy waits remain untouched. The `pid !== selfPid` guard makes an owner equal to our own pid always
  reconcile — this handles pid reuse and lets a same-process reopen (the reconciliation tests) reconcile; `selfPid` is injectable so two `openRunGroup`s on one
  home stand in for two processes. Previous-release databases migrate through the embedded Drizzle journals at open. The marker lands in `attempt_log`
  (not an `attempt` row); the resume skip cursor reads that log, so it is the marker's
  `indeterminate` outcome — not any absence from the log — that keeps the succeeded-attempt cursor unchanged and re-runs the interrupted Step.
- An acquired owner releases through its fencing epoch. A stale owner whose Run was taken over cannot clear the new owner during its own cleanup.
- Diagnostics retention (ADR 0023, #96): `diagnostics/` has had a writer since #88, so the 90-day expiry is a best-effort prune at group open (`pruneDiagnostics`,
  driven by an injectable clock) — files with an mtime at or before `now - 90 days` are deleted, newer ones kept. It walks Run directories on the filesystem, not
  the registrations, so it runs before any Run is acquired and never fails the open.
- Closed Store policy columns (`attempt_log.outcome`, `gate_answer.answer`, `pending_gate.shape`) validate at read ingress with `z.enum`.
  Turn `origin`, `kind`, `result_kind`, event `kind`, and Session `availability` remain raw legacy-compatible strings.
  `openAgentAttemptTurn`/`waitingAgentTurn` compares Turn kinds/results by equality; unknown values never establish an Agent wait.
  Conversation payload roles validate through `messagePayload` at transcript read ingress, separately from those legacy-compatible columns.
- An **authored** Human Gate (#108) is a different mechanism from the derived Review checkpoint above. `recordPendingGate` writes a durable `pending_gate` row (keyed on
  the producing Attempt id) **and rests the Run `blocked` in the same transaction**, so a crash cannot leave the record without the pause; it is idempotent on the Attempt
  id (`onConflictDoNothing`), so a resume that re-reaches the gate re-records nothing. The gate is "pending" only until that Attempt settles: `pendingGate()` returns the
  row whose Attempt id is not yet in `attempts` (the Projection derives the authored gate from it, distinct from a derived checkpoint).
  A `free-text` gate's authored `suggestions` (#213) ride the same row as a nullable JSON string array, parsed and validated at the read ingress; they only
  pre-fill the `text` answer, so answering never checks the text against them. How the gate is answered is the [Application's](../../application/AGENTS.md).
- `publishAttempt` for a **succeeded Attempt with no outputs and no required outputs** stages no commit (an empty tree is not valid `git mktree` input) and settles with
  no version — the approve-reject authored-gate answer (#108), the interactive End Step, and an Agent-step Attempt declaring no output. Every other succeeded Attempt
  produces at least one output and stages a commit as before. Its `endsStage` sets the nullable `attempt_log.stage_ended` in that transaction (#218): the one
  durable End Stage fact, read back as `AttemptLogEntry.endsStage` only when stored `true` — a stored `false` reads absent exactly like
  `null`. `endedBy: "agent"` writes nullable `attempt_log.ended_by` in the same publication transaction (#372).
- The `attempt` row also carries the normalized Harness identity and steer evidence of an Agent-step Attempt (#125, #134):
  `harness`/`executable`/`executable_version` plus `steer_available`/`steer_evidence`, written together by `publishAttempt` from the prepared profile (all null for a
  Command/Gate Attempt). `PublishAttemptRequest` carries an optional `agentEvidence` (identity required, model optional), so a write can never create a model-only
  row; the read-side `HarnessEvidenceRecord` union is what still admits a legacy model-only row written before identity existed. `harnessEvidence()` reads both
  facts from the one latest Agent-evidence row, so a model-less resumed Attempt clears the projected model rather than inheriting an older value. Which Attempts
  carry evidence is [execution's](../execution/AGENTS.md).
- There are no foreign keys and no `foreign_keys` pragma anywhere in either schema (only `busy_timeout` is set), so referential integrity rests entirely on the write
  transactions that keep related rows consistent; nothing the database enforces stands behind them.
- Run delete drops the registration and reclaims the directory as one lifecycle unit; with no foreign keys there is nothing to cascade — the directory holds the whole
  Run.
- Resume reads registration only to answer `unknown-run`, then claims ownership in `run.db`. Listing and startup reconciliation open each registered Run
  Store to read ownership and close every handle before returning; a damaged store lists unowned, matching its exact-read Problem.
  `countRuns` (#396) opens each store once and reads ownership apart from the record, counting unreadable ownership rather than unowned. A coordinator rebuild
  reads each readable Run's owner before restoring registration, so a live owner survives corruption and the following reconciliation decides its fate.

- Turn-event append faults keep the original driver cause plus a safe diagnostic. Drizzle query parameters and JSON syntax-error text can contain Turn content.
  Successful append receipts include only a newly stored event; dedup no-ops omit it. Application indexes that canonical payload after commit (#435).

## Tests

- Store Interface tests are split by concern into `ownership-and-recovery.test.ts`, `attempt-and-artifact-publication.test.ts`,
  `session-and-transcript-evidence.test.ts`, `conversation-migration.test.ts`, `materialization.test.ts`, `reconcile-turn.test.ts`, and
  `working-area.test.ts`, with the private Artifact
  Module's own `artifacts/artifacts.test.ts` beside them; keep every file independently runnable with explicit fixtures.
- Contention cases inject `busyTimeoutMs` on the contending group; the production 5 s lock wait exhausts plain `bun test`'s 5 s test bound.
