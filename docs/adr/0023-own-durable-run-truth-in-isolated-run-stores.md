# Own Durable Run Truth in Isolated Run Stores

Crucible persists a **Run** as a transactional record graph rather than a fully event-sourced log: immutable evidence records explain what happened,
while small mutable heads identify current state and Artifact bindings. Acknowledged operations are durably admitted before external effects, current
Run state and its immutable transition are recorded together, settled Turn results never change, and later recovery, reconciliation, checkpoint, or
cleanup evidence appends instead. Startup recovery reconstructs and reconciles but starts no external Step work; explicit human resume acquires fresh
ownership of that Run before authorizing more work. Native Harness conversation ids remain advisory recovery coordinates, genuine pending
Human Gates remain durable Workflow state, and expired Harness Requests or ordinary assistant questions are never recreated on the Harness's behalf.

Physical persistence follows the same ownership. Runs sharing one resolved absolute **Workspace** value are organized beneath a readable
`<path-slug>--<short-path-digest>` directory. Its `coordination.db` owns Run registration and create/delete operation admission. Each Run owns one
**Run Store** with `run.db` for structured truth and **Run owner** fencing, a
private bare Git repository for immutable Artifact content and history, temporary creation/publication/deletion staging, separately retained
diagnostics, and (2026-09-23, #214) one editable **Run working area**. A global Run index is a replaceable projection, not authority. Workspace is still a path value rather than an entity; the grouping and
coordinator are storage organization and coordination, not a new domain identity.

A producer writes **Candidate output** once. Crucible validates every required output of the Step Attempt, captures portable regular-file content,
and stages one Git commit for the complete publication set. The opaque commit id is the Artifact version id; Crucible owns no version counter. A
single `run.db` transaction then publishes every version, moves every affected binding, settles the Attempt, and advances the Run. Only that database
transaction creates the **Artifact publication**; a Git object or staging ref alone is invisible candidate storage. Promotion after the transaction
is recoverable housekeeping. The repository belongs only to that Run, never uses the Workspace's Git repository or shared Git alternates, and is
deleted with the Run. This internal storage use does not reintroduce the Git Step kind, Workspace observation, or public Git Module rejected for
Workflow execution.

Every published Artifact version is canonical inside its Run Store. An authored `home: workspace` declaration requests a **Workspace
materialization**, not a second source of truth. Before use, Crucible verifies that copy against the bound version. A missing or changed copy creates a
**Materialization conflict**: Crucible preserves both sides and halts without silently overwriting the Workspace or adopting its bytes. If a Workspace
write succeeds but validation or publication fails, the file remains external Workspace state and no binding moves. Bundle Assets stay static Bundle
content and never enter this history. Bundle archive validation and Run Artifact capture own separate policies even where their v1 regular-file rules
match, so either can evolve without coupling the other.

Run creation and deletion use admitted, idempotent operations plus temporary `.creating` and `.deleting` quarantine directories; their per-operation
contents disappear after success or startup cleanup. Run-owned canonical state, transcripts, gates, events, and Artifact versions remain until
explicit Run deletion. Minimal failure evidence remains with the Attempt, while detailed diagnostics expire after 90 days by default and reproducible
caches may be collected. If `coordination.db` is corrupt, Crucible ensures no process uses that Workspace grouping, removes the corrupt coordinator and
temporary creation/deletion contents, and performs only a bare-bones registration rebuild from readable normal Run Stores, preserving each readable
Run's owner record; other Workspace
groupings continue. A damaged `run.db` or Artifact repository isolates only that Run. Storage failure after an admitted external effect yields an
Indeterminate attempt when no immutable result can be recorded.

This design deliberately rejects one Git repository for all Crucible state, a Git repository per Workspace, a Crucible-maintained version sequence,
Workspace-only canonical Artifacts, Agent-maintained duplicate copies, automatic coordinator forensics, and full event sourcing. Per-Run repositories
sacrifice cross-Run byte deduplication and create more small stores, but make deletion, corruption isolation, maintenance, and ownership local. The
durability promise covers process, OS, and power failure while the local storage survives; disk loss, manual store deletion, and remote backup are not
part of it. Canonical Run content remains exact even when sensitive, protected by filesystem permissions or future transparent encryption rather than
truth-altering redaction. **Amended 2026-10-08 ([#459](https://github.com/secantdev/secant/issues/459)):** secrets Secant itself introduces, such as
an Agent-call token, are replaced in every Harness Turn event before it is recorded, as they already are in a Detailed diagnostic; the user's own
secrets are never pattern-matched, and all other content stays exact. Secant sets the permissions this relies on: each start makes the home
(`SECANT_HOME`) owner-only (`0700`), and Secant creates its directories `0700` and its files `0600`, never changing the mode of an existing file. A home
Secant cannot restrict, such as one on a filesystem without POSIX modes or owned by another account, draws a one-line warning and Secant continues.
Windows sets no mode and relies on the per-user profile's access control. This decision resolves [Define durable Run truth, outputs, Artifacts, transcripts, and recovery](https://github.com/DevFlow-HQ/devflow-cli/issues/16).

## Amendment (2026-09-07): home directory

The global store tree lives at `~/.secant` on every platform (`%USERPROFILE%\.secant` on Windows), overridable with the `SECANT_HOME` environment
variable. Platform-specific data directories (XDG, `Application Support`, `%LOCALAPPDATA%`) were rejected as three code paths for no user benefit;
the initial Harnesses use the same dotfile convention. Recorded while
[approving the migration handoff](https://github.com/DevFlow-HQ/devflow-cli/issues/22).

Amended 2026-10-02 ([#318](https://github.com/secantdev/secant/issues/318)): the home also holds a `logs` folder of operational logs, one JSONL file
per Secant invocation, which `SECANT_LOG_DIR` can move elsewhere. It is apart from every Run Store, and deleting a Run never touches it. Its lifecycle
is separate too: spec [#313](https://github.com/secantdev/secant/issues/313) keeps each file for 30 days after its last write, pruned best-effort at startup
([#323](https://github.com/secantdev/secant/issues/323), 2026-10-02).

## Amendment — Run ownership replaces the Workspace claim (2026-09-14, ADR 0031)

[ADR 0031](./0031-own-runs-per-run-not-per-workspace.md) removes the one-live-Run Workspace claim from `coordination.db`: the coordinator owns Run
registration and create/delete admission, each Run Store owns its **Run owner** record, and any number of Runs may be live in one Workspace. Explicit
human resume acquires fresh ownership of that Run only. Startup recovery probes each owned Run's process rather than
treating every owned Run as dead: an alive owner is left live, a dead owner's `running` Run rests `halted`, and a dead owner's derived-`blocked` Run
stays `blocked`. Fencing, isolation, publication, materialization, retention, and the bare-bones coordinator rebuild are
unchanged. Where this ADR and ADR 0031 differ, ADR 0031 governs.

## Amendment — ownership and guarded writes share `run.db` (2026-09-18, [#133](https://github.com/secantdev/secant/issues/133))

The earlier amendments left the owner record in `coordination.db` while every canonical write committed to `run.db`. Those two files cannot provide one
atomic fencing check and write. A takeover landing after the check but before a Turn settled could therefore make the stale owner's immutable result
permanent. The owning process id and monotonic epoch now live beside the Run's canonical records. A guarded write reads the epoch first and performs the
write in the same immediate transaction; takeover needs that same write lock. Resume consults coordination only to distinguish an unknown registration,
then claims ownership in the Run Store. Listing, startup reconciliation, and coordinator rebuild also read each Run Store's owner record, so rebuilding
registration no longer silently un-owns a live Run. The coordinator remains authoritative for registration and create/delete admission.

## Amendment — the requested model is immutable Run truth (2026-09-23, M5)

An Agent-bearing launch may request a model. The request is written into the Run record in the same creation transaction that pins the semantic
Harness selection ([ADR 0019](./0019-failed-and-halted-runs-are-resumable-resting-states.md)'s M4 amendment), before the first Attempt, and is never
changed. Launch and resume hand that one stored value to the Adapter's prepare, so a resumed Run asks for exactly what its launch asked for; an absent
value means the Harness default, never a substitute. The requested model is free text in the store, checked against the Adapter's declared model list
at launch-preparation and at prepare ([ADR 0022](./0022-own-a-truthful-deep-harness-seam.md)); a Command-only Run carries none. It is not evidence:
the effective model each Attempt observes stays a per-Attempt fact and never overwrites the request. (Edited 2026-09-29: [ADR 0034](./0034-choose-and-change-model-and-effort-as-one-run-wide-model-choice.md)
replaces this never-changed request with a Run-wide **Model choice** of model and effort that the store holds, updates on each change, and copies into
each Turn's requested model and effort beside the observed effective values; no value means "Harness default" any more.) (Edited 2026-10-03,
[#340](https://github.com/secantdev/secant/issues/340): the stored request is no longer handed to prepare. Run execution sends it on every Turn request
and records it on each Turn at admission; the Run-wide Model choice replaces the stored value in a later slice.)

## Amendment — a Run owns one editable working area (2026-09-23, [#214](https://github.com/secantdev/secant/issues/214))

Local planning needs editable spec and ticket files that belong to the Run but are not immutable Artifacts. Each Run Store therefore owns one
**Run working area**: a directory beside, never above, `run.db` and the Artifact repository, created on first use and removed by the same Run
deletion. It is working state, not truth: nothing is published, versioned, fenced, or reconciled from it, and resume never rewrites it. The Store
exposes only its canonical path, which execution names in prompts (`{{run:working-area}}`) and composition hands to Harness preparation as the one
additional writable directory, so no client or Harness reconstructs a private storage path or is granted the database and repository as a group. A
path that cannot be that directory is a typed failure that halts the Run before any Turn. Writing planning files into the Workspace or a shared
Store directory was rejected: the first leaks planning state into the user's project, the second would widen a sandbox grant over private Run truth.

Later the same day ([#220](https://github.com/secantdev/secant/issues/220)): per-Attempt Output receipts also live in a Store-named subdirectory of the working
area, because the one grant must cover every file an agent is told to write. A receipt is Candidate output: only its validated bytes are published, through the
ordinary Attempt publication, so the working area itself still holds no Run truth.

## Amendment (2026-09-30): the shape of failure evidence and detailed diagnostics

[ADR 0041](./0041-record-typed-failure-evidence-and-resting-causes-in-the-run-store.md) gives "minimal failure evidence" and "detailed diagnostics"
their shape. Typed **Failure evidence** rides the Attempt or Turn and a **Resting cause** rides a `halted` or `failed` Run, both until Run
deletion; the verbose cause, output tail, and Harness diagnostics are a **Detailed diagnostic** file under `diagnostics/`, pruned after 90 days.
Canonical content stays exact; only Secant-introduced secrets are redacted from a Detailed diagnostic. No other decision here changes.

## Amendment (2026-10-10): the Run Store owns the shape of recorded Turn facts

Recorded while deciding [where stored Turn-event shapes live](https://github.com/secantdev/secant/issues/518), hand-over A18 of the
[M10 follow-up audit](https://github.com/secantdev/secant/issues/510). The Run Store owns the schema of every recorded Turn-fact kind: those that
mirror Harness Turn events, the ones Run execution writes (Steer `waiting`, Agent call, Agent-call expiry), the retired kind kept to read old rows,
and the history-order field, whose value Application still stamps. The schemas stay private to the Store; its entry exports the `TurnFact` type beside
the validated readers and checked writes it already owned. A stored tool call or Turn diff reuses the Harness live type
([ADR 0022](./0022-own-a-truthful-deep-harness-seam.md)'s 2026-10-10 amendment), and a type check fails the build when the stored shape without its
history order stops equalling it; a separate stored shape and translation step waits until the two must differ. The Store keeps re-applying the
Harness output retention when it checks or reads a fact. This supersedes only [#435](https://github.com/secantdev/secant/issues/435)'s choice to own
the definitions with the Harness facts; its reader and receipt split stands.
