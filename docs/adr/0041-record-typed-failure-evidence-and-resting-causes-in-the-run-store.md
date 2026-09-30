# Record Typed Failure Evidence and Resting Causes in the Run Store

A failed **Step Attempt** keeps only its **Attempt outcome**, and a failed **Turn** keeps only its category, phase, and native code. The Command
step drops its spawn error, timeout, and signal, and `SpawnResult` carries no cause. An Output receipt failure collapses to "missing". Agent failures
before a Turn exists write no row. A Run that rests `halted` or `failed` records no reason, and a Problem lives only in memory. The Run Workbench
says "Execution stopped outside the Workflow." and `run show` prints no reason. [ADR 0023](./0023-own-durable-run-truth-in-isolated-run-stores.md)
already says "minimal failure evidence remains with the Attempt, while detailed diagnostics expire after 90 days", but gives neither a shape. The
question came from [Decide what failure evidence a Run retains and shows](https://github.com/secantdev/secant/issues/291). The maintainer log is a
separate record, decided in [Decide Secant's local operational diagnostics](https://github.com/secantdev/secant/issues/273#issuecomment-5914178721).

**Three records.** **Failure evidence** sits on the Attempt or Turn it explains and lasts until Run deletion. A **Resting cause** sits on a Run that
rests `halted` or `failed`, points at the Failure evidence behind it when there is one, and lasts until Run deletion. A **Detailed diagnostic** is a
file under the Run's `diagnostics/`, referenced from Failure evidence, and pruned after 90 days by the existing best-effort prune. A Problem stays
the transient outcome of an Operation and is not persisted. A failed interactive Turn that returns the Run to `blocked` needs no Resting cause,
because its Turn's Failure evidence says why.

| Failure evidence (until Run deletion)                                                   | Detailed diagnostic (90 days)                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| source and code; phase and category                                                     | translated cause message and stack                                  |
| possible effects: `none`, `partial`, or `unknown`                                       | a failed Command's bounded stdout/stderr tail                       |
| native code: exit code, errno name, or signal name                                      | a Harness failure's partial output, retry evidence, and diagnostics |
| small safe details: receipt output name, timeout bound, the unknown half of a lost Turn | a lost Turn's last authoritative observation                        |
| reference to the Detailed diagnostic, if any                                            |                                                                     |

**Codes are stored; words are derived.** The Store holds typed facts only. The Projection derives each one's plain explanation and next step when
it reads it, as Problems already carry `explanation` and `remediation`, so wording can improve without migrating old Runs. The Store does not branch
on the codes, so it stores them as they are, and the Projection narrows them tolerantly at its read ingress. An unknown code, or a failed Attempt
recorded before this decision, reads "This Step failed for unknown reasons." A fixed set gets tailored wording: a Command that could not start,
timed out, or was killed; a missing, invalid, or oversized receipt; a Harness that is not authenticated (log in through the Harness itself, per
[ADR 0022](./0022-own-a-truthful-deep-harness-seam.md)); a Harness that exited or lost contact; a Turn lost after a Secant crash; an exhausted retry
budget; a gate answered stop; a Materialization conflict; a prepare failure; and an internal fault. Anything else gets generic wording by category,
such as "Claude Code reported an error. Open the details section for the cause." Secant does not parse Harness-native message text.

**What becomes durable.**

1. Command: the spawn errno, an executable gone between Preflight and spawn, a timeout with its bound and output tail, and the killing signal.
2. Output receipt: which output, and whether it was missing, not a regular file, a symlink, too large, invalid UTF-8, or blank.
3. Agent failures before a Turn exists (an unusable Session, a prompt render failure, a refused admission), recorded on the Attempt.
4. Every `HarnessFailure` field and a lost Turn's last observation, split between the two tiers above.
5. Resting causes for a prepare failure, an execution fault, and crash reconciliation ("Secant stopped while this Step was running"), beside the
   causes execution already knows: an exhausted retry budget, a gate answered stop, a Materialization conflict, and a lost or interrupted Turn.

The Harness `CleanupReport` and usage are not Failure evidence; they belong to the operational log.

**Who writes each fact.** Process gives `SpawnResult` a typed cause: the errno on `spawn-error`, the signal on `signal`, and a bounded output tail
on `timeout`. Run execution builds Failure evidence and passes it through the existing `publishAttempt` and Turn settlement, in the transaction that
records the outcome. A Resting cause rides the existing `writeState`, in the transaction that changes the state. Execution writes its own halts,
Application writes the prepare-failure and execution-fault causes, and the Run Store's reconciliation writes the crash cause in its reconcile
transaction. An execution fault now rests the Run `halted` with its cause instead of releasing ownership of a Run still marked `running`. A Detailed
diagnostic file is written before the row that references it, as the Materialization conflict path does, so a crash leaves at worst an orphan
file for the prune. No `RunOwner` write method is added, so `observedOwner`'s intercepted set still refreshes open clients. Harness Adapters are
unchanged.

**Privacy.** A Detailed diagnostic passes through the same safe cause translator as the operational log: it copies an allowlist of known fields
from an arbitrary error, redacts secrets Secant introduced (the Claude Code permission-bridge token today, the ADR 0033 agent-call token when it
lands), and bounds size. Raw Harness protocol frames, private reasoning, environment values, credentials, prompts, and user text never enter it.
The Command output tail is stored exactly as captured, like a declared Command output, and the Command appears as the Bundle declares it.

**Presentation.** Everyday screens carry no codes or ids.

- The Run Workbench's transcript shows a failure row where the failure happened, with the error colour's left border and the explanation and next
  step in muted text. A retried Attempt shows "Attempt 1 of 3 failed: … · retrying". A lost Turn says in plain words which half is unknown.
- When possible effects are `partial` or `unknown`, the row adds "It may have changed files before it stopped."
- When the Run rests `halted` or `failed`, a resting line in place of the compose gives the Resting cause and what to do next.
- The details panel gains a Failure section with the code, phase, category, possible effects, native code, and the Detailed diagnostic, which
  reads "Expired after 90 days" once pruned. A Problem drops its code line from everyday screens.
- `run show` prints "Stopped because:" and "Next:" under `State:`, and each failed Attempt or Turn in its timeline carries its one-line reason.
  `--json` adds optional `failure` objects on Attempts and Turns and a `restingCause` on the Run, each with the code, possible effects, native
  code, explanation, next step, and diagnostic reference. No field is renamed and exit codes are unchanged. A Detailed diagnostic is read through
  the existing diagnostic reference path.

## Considered options

- Show a reason only in the details panel and headless: a `halted` or `failed` Run asks the human to resume or abandon, and the everyday screen
  would give them nothing to decide with.
- Store the final sentence at failure time: freezes today's wording into every old Run and gives headless no stable code.
- Rely on the operational log alone: it is for maintainers, lasts 30 days, may be missing, and is never read by the Projection.
- Persist Problems as the failure record: a Problem is an Operation's transient answer to its caller, while a failure belongs to an Attempt, Turn,
  or Run and outlives any Operation.
- Parse Harness-native messages for tailored hints such as usage-limit reset times, as OpenCode and T3 Code do: the text changes with each Harness
  release, and nothing here admits reading it. Deferred.
- Backfill old Runs: their causes were never recorded.

## Consequences

- ADR 0040's "a failed Attempt and a `blocked` Entry Turn still show no reason on screen" gap closes with this decision.
- The transcript failure row lands in [ADR 0039](./0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md)'s per-Session
  history, so the milestone that builds this follows the agent-screen Run Workbench milestone.
- Whichever of this milestone and the operational log's builds the shared cause translator first owns it; the other reuses it.
- A copy-error action, a log-browsing screen, and showing retry evidence outside the Detailed diagnostic are deferred beyond the public release.
- `src/run/store/AGENTS.md` records the new tolerantly narrowed codes beside the D7 columns, and `src/process/AGENTS.md` records the typed
  `SpawnResult` cause, when the implementing slices land.
