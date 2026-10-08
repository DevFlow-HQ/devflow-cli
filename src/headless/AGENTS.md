# headless — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The Run notice follower starts before launch/resume/answer settlement (#363), reopens on observer lag, and writes fallback information once to stderr.
  Run snapshot JSON serialization explicitly omits the transient notice; `show` and `model` also write it to stderr.
- `run model` waits for the qualified `change-model-choice` Offer, forwards partial values unchanged, and adds its result to Operation JSON.

- Exit-code contract: the headless Run commands exit 0 only when the Run rests exactly `succeeded`, **2** when it rests `blocked` at its Human Gate
  checkpoint (the M2 gate's expected outcome — distinguished from a failure so CI can assert it), and 1 for every other rest (A36, `exitForState` in
  `run-commands.ts`). Because `blocked` now has its own code, the package smoke asserts a rest-state exit through its `run()` helper (its `expect` option) rather
  than a raw `spawnSync`; but raw `spawnSync` sites deliberately remain for the spawns that expect a non-zero/failure exit and for the long-lived child processes
  (SIGINT, takeover), which `run()`'s default exit-0 contract does not fit (A35). This rest-state exit is only `launch`, `resume` and `answer` — the three
  commands that drive to settlement through `settleAndReportRun`;
  `show`, `list`, `read`, `model`, `cancel` and `delete` exit 0 on success (or 1 on a refusal), never by rest state. On Ctrl+C the signal handler (`withClients`,
  `composition/main.ts`, #98) aborts the live Runs, restores the default disposition, and re-raises the signal, so the process exits **128 plus the signal
  number** rather than 1 — the Unix "killed" contract a CI script reads, which a fabricated 1 destroys. The `halted` rest lands lazily: the claim is left
  live and the next open reconciles it `halted` (ADR 0019), not the signalled process.
- `run answer` gates on the Port's `answer-human-gate` Offer (A14): the Offer owns legality and carries the exact Gate reference, so its absence — not a
  client re-derivation from `run.state` — refuses an unanswerable Run, and submitting against `offer.gate` lets the Application catch a Gate that moved
  as stale. Never classify the answer or synthesize the reference here. `run answer` takes `--continue`/`--stop` (approve-reject and checkpoints) or
  `--text <value>` (a free-text authored gate, #108) — exactly one, tested by presence so `--text ""` is a valid empty answer. The client never re-classifies
  the gate shape: a `--text` answer to an approve-reject gate (or vice versa) is forwarded and the Application refuses it as `gate-shape-mismatch`.
- A Run that rests `blocked` at a gate names its follow-up answer command in the plain-text tail (`settleAndReportRun`'s `answerHint`, #108): a free-text
  gate names `--text`, an approve-reject gate names `--continue`/`--stop`. `run show` names the blocked basis in every case (A15): the durable Human Gate
  (the authored pending gate's shape/message/output and the derived Review checkpoint, both under the `answer-human-gate` Offer's `basis`), the interactive Turn
  (from the `send-interactive-turn` Offer's `basis`), an Agent Step waiting after an Interrupt (the `send-follow-up-turn` Offer's `basis`, #354; headless
  names no follow-up command), and the ephemeral Harness Request. The first two are durable `RunView` fields renderRun prints; the ephemeral
  request is never durable, so `showRun` peeks the live overlay (`peekLiveOverlay` — a bounded first-update read that returns the overlay buffered at open while a
  Turn is live here, else nothing) and names the outstanding request. All of it is additive to the frozen `--json`, whose shape is the durable snapshot alone.
- `run show` keeps raw event kinds and ids (it is the diagnostic surface) and ends each Step-scoped timeline line with ` · step <id>` (#289); the TUI shows
  plain labels instead. The Step and plain Session fields are additive to `--json` (`projection-port.ts` documents them).
- `run show` labels the immutable `run.selectedHarness` as `Selected Harness:` and the latest Agent-step Attempt's `run.harness`/`effectiveModel` facts as
  `Observed Harness:`/`Observed executable:`/`Observed version:`/`Observed effective model:` (#125, #147). The version prints unadorned since it may contain
  parentheses. `selectedHarness` is additive, the existing observed JSON fields stay unchanged, and Command-only Runs omit all of them so their frozen shape is unchanged.
- Command groups register onto the configured program with `io`/`execute`/`fail`/`settle`. Run and settings share the receipt waiter on the
  Projection Port; Run owns `settleAndReportRun` and `splitSelector`, also used by `bundle inspect`.
- Headless JSON omits operational Problem causes in every envelope; normalized fields and user data named `cause` remain intact (#449).
- Settings show JSON is only the theme/appearance pair. Set JSON is the Operation receipt, with `preferencesChange` only on an applied save.
  Fallback notices use stderr and exit zero; failed saves retain not-applied receipts and exit one. Bare settings prints help without composition.
- `launch`/`resume` answer approval Harness Requests while following the live Run (#117), all through one owner — `harness-requests.ts` holds the
  `--harness-requests` option (`addHarnessRequestsOption`, declared on both commands), its parser, and the follower (A34; the option was declared verbatim on
  each command and the follower wrapped in an identical try/finally before). `followHarnessRequests` opens the `run` Projection and, on each `live` overlay,
  submits `answer-harness-request` (as `client-policy`) for every offer not yet in its `attempted` set — the key is `generation:requestId`, so a request
  re-offered at a later generation (a prior answer went stale) is retried. `--harness-requests` defaults to **`deny`** (`parseHarnessRequestPolicy`): an
  unattended Run denies every approval unless the operator opts into `allow` (the only other value; Claude Code offers no "always"). `withHarnessRequests` starts
  the follower before settlement is awaited, so an Agent Turn that pauses on approval is unblocked and the Run can rest; it is harmless for a Command-only Run.
- Run and settings await `ProjectionPort.settledOperation`; Application owns receipt settlement and the shutdown Problem with unknown effects (#448).
  `run model` prints that returned receipt, so JSON and exit code agree even if the ledger still holds a pending Operation after shutdown.
- `followHarnessRequests` reopens only after `observer-lagged`; any other end stops the follower (#306).
- Launch preparation and Harness inspection share a private readiness waiter (#390): only `observer-lagged` reopens; every other end fails with no effects.
  Launch waits for ready/not-ready; inspection waits for a missing Harness or qualification beyond `not-checked`, including valid negative results.
- `run launch --harness claude-code|codex` forwards the semantic choice through `LaunchRunInput`; Application owns required/unknown/irrelevant refusal. Resume accepts
  no Harness flag and reuses the durable id. The option changes no frozen JSON field or exit code; selected-Harness Problems use the existing renderer (#146).
- `run launch --model`/`--effort` forward the draft's Model choice, and an omitted one is resolved by launch preparation. `launchRun` submits the ready
  `launch-run` Offer's draft (a ready assessment always carries one), so headless launches the preselection the TUI shows (ADR 0034). `run show --json` adds
  `modelChoice`; `requestedModel` is its model.
- `run launch` reads the `launch-preparation` assessment before submitting (`assessDraft`, #189). A `not-ready` draft prints every finding (text through the
  shared `fail` renderer) and exits 1 without submitting; its `--json` is the frozen `{ status: "not-ready", findings }` shape (`reportNotReady`).
- `run read --transcript` (#124) selects the Session from `<run-id>/<session>` then `--session`; with neither it takes the sole Session that has a recorded
  transcript. It refuses `run-session-not-found` when the named Session has no transcript, when the Run has none at all, or when more than one Session exists
  and none was named (`readTranscript`). `run show` never inlines transcript entries; the Session's page/export References are the only read path.
- Transcript JSON explicitly maps `session`, `role`, `content`, optional `step`, and only optional `kind`, `turn`, `steer`, `incomplete` (#411).
  Delivered Steers alone are conversation entries. Retained Resource entry identity never enters JSON; `{ page, export }` and read envelopes stay frozen.
- `render.ts` ignores an unknown action-offer kind on purpose: each offer kind is rendered by its own filtered loop, so an offer kind the client does not
  recognise falls through every loop and prints nothing rather than erroring — the client never enumerates a closed set of offers.
- `render.ts` is the wording the TUI mirrors: `src/tui/bundle-format.ts` copies its Bundle status words, so a wording change here lands in both or the two
  surfaces disagree about the same fact.
- The `--json` shapes are frozen: the three-OS CI gate parses specific fields (`.result.run.state`, `.checkpoint.completedIterations`, …), so renaming
  one breaks the gate. They are not uniform — `bundle inspect --json` prints the inner bundle while `bundle list --json` prints the snapshot — so match
  the existing shape a command already emits.
- The `harness` command group lives in `harness-commands.ts`. `harness inspect` waits for settled qualification when its initial snapshot is
  `not-checked` (#188, #390). Its frozen JSON is the inner focused Harness, where `supportedModels` keeps its names-only shape (a `suggested` declaration
  reads as `free-text`) and #341 adds `modelDeclaration` and `harnessDefaults` (text: `Reported settings:`) beside it, #342 `preselection`;
  `harness list --json` prints the whole list snapshot, and neither command derives or exposes Action Offers.
- A locked launch prints its lock sentence on stderr, keeping stdout JSON unchanged (#347).
- Every command prints the startup notices (`clients.startupNotices`, the ADR 0029 Shipped Bundle ensure) to stderr before executing (`buildProgram`'s
  `execute`). A failed ensure never blocks the command, and stdout, the `--json` shapes, and exit codes are untouched by the notices.
- Commander settings (`exitOverride`, `configureOutput`, `enablePositionalOptions`, `configureHelp`) must be configured on the program before the
  `.command(...)` calls: Commander copies them into each subcommand as it is added, so a subcommand added before a setting silently misses it.

## Tests

- The exit-code and `--json` contracts above are the CI acceptance seam; `tests/cli` does not exist (the tiny entry branches in `cli/main.ts` are
  covered by the package smoke and a child-process spawn), so assert headless behaviour here and in the package smoke, not through a separate CLI suite.
  Named gap under testing's behavioral-completeness bar: three `cli/main.ts` behaviours are covered **only** by the compiled-binary smoke, never the
  deterministic suite — the bare-argv branch that lazily imports the TUI so Solid and OpenTUI never load on a headless path (`:24-32`); `isMainEntry`'s
  `Bun.main` separator normalisation, the #62 Windows entry quirk (`:57-62`); and the top-level error handler that sets exit 1 and prints the
  `describeFatal` text naming the log file once a branch has loaded composition, else the stack (`:64-73`; the sink suite unit-tests that text). The
  file records at `:49-56` why it cannot be unit-tested as written; if a fourth branch appears, revisit a small `tests/cli` rather than widening the smoke.

## Read next

- [Headless parity](../../docs/headless-parity.md) lists the TUI capabilities headless deliberately lacks; update it when a decision adds or closes one.
