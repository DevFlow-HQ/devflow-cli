# harness — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The public entry (`harness.ts`) is the whole Interface surface: the Adapter Interface, the evidence-bearing profile, and the factory a
  composition root calls. No native frame, protocol type, or conversation-id value crosses it; the declared exceptions are the Workspace path
  (`PrepareOptions.workspace`, the directory every Session runs against) and the one additional writable directory (`writableDirectory`), the named
  native-Adapter test seams on their override types (including Codex's recorder-only observer and between-Turn app-server lifecycle control), and the
  executable env constants (`CLAUDE_CODE_EXECUTABLE_ENV` / `SECANT_CLAUDE_CODE` and
  `CODEX_EXECUTABLE_ENV` / `SECANT_CODEX`) — the synchronous discovery outcome and static served-capability table that Preflight shares
  with the Adapter (the resolved spawn target stays private), and the frozen static Harness input-rule declarations (ADR 0040),
  typed locally and checked structurally against Workflow by composition; and the permission-bridge factory (`startPermissionBridge`), exported so the fixture
  recorder composes the production bridge instead of a copy (#127 D3) and so redaction tests register a bearer the way production does (#334);
  its surface is launch flags, the bearer, and a teardown, never an MCP type;
  and the safe cause translator (`translateCause`, #316), the one bounded, redacting record of a failure cause that M8's operational log and
  M11's Detailed diagnostics write; and the optional phase observer each prepare takes (`HarnessPhaseObserver`, #322), which carries only the
  semantic phase, an optional closed semantic `step` (#325), the Session key, elapsed time, and a typed `HarnessFailure`; no typed field carries a
  frame, argv, RPC name, or coordinate (mapping in harness-adapters), though a translated Codex cause may name its RPC method in bounded message or stack text.
  Recovery coordinates cross the Seam only as opaque `RecoveryCoordinate` values, never Run truth; callers never decide from their contents. Native
  protocol models and qualification stay private to each Adapter and re-export nothing native.
- No Routing, Step kind, retry budget, or Run policy knowledge lives here; those are above the Seam. A Turn is one mechanical exchange, not a
  judgement that a Step succeeded — the closed Turn results (`not-started`, `completed`, `failed`, `interrupted`, `lost`) are mechanical truth, and the
  Step kind decides the Attempt outcome above the Seam.
- Terminal ordering is exact and load-bearing: on terminal an Adapter publishes remaining events, drops every pending Steer, expires outstanding requests, closes the
  event producer, then settles the one authoritative result. No event is observable after the result settles. The fake enforces this with an
  `emit after result` guard; a real Adapter must hold the same order.
- Child reuse across Turns (a result may settle before the native `close`) is in [harness-adapters](../../docs/agents/harness-adapters.md).
- Operational failures are typed values (`HarnessFailure`, `ControlReceipt` rejections, `RecordingReceipt`, `CleanupReport`). Only caller-contract
  violations throw: a second concurrent Turn on one Prepared Harness, a Turn after `close`, or a Turn beyond what an Adapter can serve. Control races
  (`expired`, `already-settled`, `shape-mismatch`, `unsupported`) are rejected receipts, never throws.
- Durable admission precedes content. `startTurn` returns a handle before native acceptance, but an Adapter awaits `recorder.admit` before sending
  content; a `recorded: false` receipt (or a thrown recorder) proves the Turn `not-started`. A recovery coordinate revealed only after acceptance is
  recorded through `recorder.checkpoint`; a late checkpoint failure is reported separately and never rewrites a settled result.
- `close` is idempotent and returns the same report each call; cleanup failure is separate and cannot rewrite a settled Turn.
- Secrets Secant itself introduces are redacted from failures and diagnostics. Excluding raw protocol, private reasoning, and duplicate transcript
  content is Interface design, not generic secret redaction — a `HarnessFailure` still preserves all useful Harness-originated diagnostics and its cause.
  One private registry (`secrets.ts`) owns it: a minter registers a secret when it hands it out, and nothing registers through the Interface. A secret
  stays registered for the whole Secant invocation, so a cause translated after its bridge closes still redacts it; the cost is one short token per
  bridge. The Seam's `redactSecrets` keeps a cause an Error with its name and bounded cause chain; it returns secret-free values unchanged. Redactor
  and translator share one cause-depth bound; a redacted tail beyond it becomes null so translation still marks the cut. The translator redacts each
  string before cutting it; its byte bounds are Interface facts pinned by its tests, in serialized UTF-8 bytes.
- Steer ids are caller-supplied and opaque. Each accepted Steer emits one `steer` settlement with its text and send time, even before its receipt resolves.
  Native correlation and pending state stay inside the Adapter; delivery means model exposure, never compliance (#356).
- Steer is a profile capability like the others (`HarnessProfile.steer`, evidence-bearing). An Adapter derives its `steer` receipt from it rather than
  hard-coding a second rejection; the Claude Code profile declares it unavailable (print mode has no same-Turn guidance frame) and the fake's script
  decides it through the profile it supplies.
- Model selection is a profile fact. `modelSelection` declares where a model can be chosen (`launch`, `per-turn`, both, or `unavailable`) and carries a
  `ModelDeclaration` (ADR 0034): an exhaustive `list`, `suggested` picks that are neither exhaustive nor validated, or `free-text`. `list` and
  `suggested` entries share `{model, label, efforts, defaultEffort?}`; empty `efforts` is a model without an effort setting, and `suggested` and
  `free-text` carry a declaration-level `efforts` for any other name. Codex declares `launch-and-per-turn` with the `model/list` entries observed at
  qualification; Claude Code declares `launch` with its documented aliases as `suggested`, each offering the five `--help` efforts and no default
  effort, since which levels a Claude model honours is observed, never catalogued. `modelObservation` separately declares whether the effective
  model is read from native evidence; both observe it.
- `PreparedHarness.readDefaults()` (#341) is the Harness's own default Model choice, read lazily and once per Prepared Harness so a Run's prepare never
  pays for it: `reported`, or the Adapter's declared `fallback` with its reason (Codex: the `model/list` default at its own default effort; Claude
  Code: Opus (latest) at medium until #347 reads `get_settings`), or `unavailable`. A read the Harness cannot answer falls back, never throws; an
  `effortLock` carries an opaque `source`. Composition's qualify path is its one caller.
- `PrepareOptions.process` and `phases` (#333) serve that prepare and its Prepared Harness alone; an Adapter keeps only its qualification cache across
  prepares, so a cache hit never reuses an earlier caller's Process or observer.
- `PrepareOptions.writableDirectory` (#214) is validated by the one shared `writableDirectoryFailure` (`writable-directory.ts`) before anything
  native runs (not an existing absolute directory ⇒ typed `writable-directory-unavailable`). Claude Code forwards it as `--add-dir` on every launch; Codex
  sends a per-thread `sandbox_workspace_write.writable_roots` config override and refuses the Turn `writable-directory-refused` only when an acknowledged
  `workspaceWrite` sandbox omits it (read-only defers to approvals).
- Each `TurnRequest` carries its `modelChoice` (ADR 0034); `modelChoiceRefusal` refuses one outside a declared `list`, even an empty one
  (`suggested` and `free-text` admit any), as a `not-started` `model-unavailable` Turn before admission, never a substitution. Codex sends it
  on `turn/start`, Claude Code as `--model` on the launch serving the Turn (a reused live child keeps its model, #348); neither sends effort
  yet (#345, #348). The observed effective model never copies the request.

### Interrupt, recovery, and cleanup

- Codex control timeouts and native RPC errors refuse the call while native terminal truth owns the Turn; unexpected refusals emit a live activity diagnostic.
  A timed-out Interrupt stays sent: retries and Steer are refused, and later connection loss leaves interruption unknown. A native RPC error resets it to idle.
  Refusal alone preserves attachment; malformed responses and transport failures still lose and detach the Turn.
- A Turn settles `interrupted` only on confirmed interruption: a matching native terminal is `active-turn` (Codex; Claude Code since #346), a graceful
  process stop `process-only`. A force-kill, lost connection, or unconfirmed termination settles it `lost` with `interruption-unknown`. Windows has no
  graceful stage ([process notes](../process/AGENTS.md)), so a process stop of a live child there truthfully settles `lost`. The profile's interruption
  evidence states each Harness's stop and its per-OS fallback; the conformance `interruptOutcome` and `recoveryInterruptOutcome` options pin them.
- Recovery is caller- and history-driven: a relaunch of a Session that already ran, or any Turn carrying `resume`, resumes that exact native conversation.
  A resume the native side does not acknowledge is a `recovery`-phase failure that marks the Session `unusable`; recovery never silently starts a fresh
  conversation. Codex app-server replacement failures leave Sessions detached; only an unacknowledged thread resume makes its Session unusable.
  Each Adapter's resume mechanics are in [harness-adapters](../../docs/agents/harness-adapters.md).

## Tests

- The `tests/harness` domain owns the deterministic fake Adapter, shared conformance, and native replayers. Recorded and residual synthetic cases live in
  `tests/harness/fixtures/<harness>/<case>/` with a `recording.json` sidecar and opt-in recorder.
- Prepare/lifecycle cases run all Adapters; Codex replay covers exact-thread recovery, approvals, and native Steer. Other control groups stay capability-specific.
  Structured clarifications, after-acceptance checkpoint, load-with-replay, and caller-contract violations remain fake-only. The fake performs load-with-replay:
  resumed Turn re-emits the Session's transcript history (`assistant-content`, `tool-activity`), drops a scripted entry that repeats a replayed one, then
  emits `REPLAY_BARRIER` (an `activity`) before any live event — history is historical by position, inside the closed vocabulary.
- Native Adapter and replayer conformance that launches real children runs only in standalone runtime conformance (#198); scripted Process failure
  cases through the Claude Code Seam run in the semantic suite (#332). The layer rules are in [testing](../../docs/agents/testing.md).
- **Replayer startup-signal race:** a Bun child's `process.on("SIGTERM")` handler is only honoured once installed — a SIGTERM delivered before the
  child's top-level code runs hits the default disposition and kills it (this is a startup race, not a `bun test` limitation; plain `bun` shows the same
  window). So the replayer installs its SIGTERM handler at startup, and interrupt/close cases wait for the `session` event (init observed) before
  interrupting. Never signal a freshly spawned child before it has announced readiness.
- The replayer's `case.json` vocabulary (`tests/harness/fixtures/README.md` is the reference): a `control` step (#346: take the next stdin
  `control_request` and emit recorded bytes echoing its `request_id`, or swallow it to model an unconfirmed stop; stdin is read while steps run),
  `ignoreSigterm` (swallow SIGTERM → force-kill path; moot on Windows, where every live child is force-killed regardless), per-turn `exitAfter`
  (exit without a result → lost/corruption) and `workingAreaPatch` (applied in the launch's `--add-dir` directory), a `resume` section replayed when
  the launch has `--resume`, and `sessions[]` (#224: the Nth fresh `--session-id` launch after the first plays `sessions[N-1]`, one conversation per
  human-controlled Repeat iteration).

## Read next

- Read [harness-adapters](../../docs/agents/harness-adapters.md) before changing Claude Code or Codex Adapter internals.
- Read [ADR 0022](../../docs/adr/0022-own-a-truthful-deep-harness-seam.md) before changing the Interface; [Spec #107](https://github.com/secantdev/secant/issues/107) fixes the M3 event vocabulary, result names, and control race values.
