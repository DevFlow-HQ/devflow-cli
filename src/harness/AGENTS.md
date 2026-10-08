# harness — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The public entry (`harness.ts`) is the whole Interface surface: the Adapter Interface, the evidence-bearing profile, and the factory a
  composition root calls. No native frame, protocol type, or conversation-id value crosses it; the declared exceptions are the Workspace path
  (`PrepareOptions.workspace`, the directory every Session runs against) and the one additional writable directory (`writableDirectory`), the named
  native-Adapter test seams on their override types (including Codex's recorder-only observer and between-Turn app-server lifecycle control), and the
  executable env constants (`CLAUDE_CODE_EXECUTABLE_ENV` / `SECANT_CLAUDE_CODE` and
  `CODEX_EXECUTABLE_ENV` / `SECANT_CODEX`), synchronous discovery and static served-capability tables read by Preflight before discovery
  and used for Agent-call profile availability (#377, ADR 0033; spawn targets stay private), and the frozen Harness input-rule declarations (ADR 0040),
  typed locally and checked structurally against Workflow by composition; and the permission-bridge factory (`startPermissionBridge`), exported so the fixture
  recorder composes the production bridge instead of a copy (#127 D3) and so redaction tests register a bearer the way production does (#334);
  its surface is named Session attachments (launch flags, bearer, URL, and opaque call declarations) and teardown, never an MCP type;
  and the safe cause translator (`translateCause`, #316), the one bounded, redacting record of a failure cause that M8's operational log and
  M11's Detailed diagnostics write; and the optional phase observer each prepare takes (`HarnessPhaseObserver`, #322), which carries only the
  semantic phase, an optional closed semantic `step` (#325), the Session key, elapsed time, and a typed `HarnessFailure`; no typed field carries a
  frame, argv, RPC name, or coordinate (mapping in harness-adapters), though a translated Codex cause may name its RPC method in bounded message or stack text.
  Recovery coordinates cross the Seam only as opaque `RecoveryCoordinate` values, never Run truth; callers never decide from their contents. Native
  protocol models and qualification stay private to each Adapter and re-export nothing native.
- No Routing, Step kind, retry budget, or Run policy knowledge lives here; those are above the Seam. A Turn is one mechanical exchange, not a
  judgement that a Step succeeded — the closed Turn results (`not-started`, `completed`, `failed`, `interrupted`, `lost`) are mechanical truth, and the
  Step kind decides the Attempt outcome above the Seam.
- Terminal ordering is exact: an Adapter publishes remaining events, drops pending Steers, expires requests and unanswered Agent calls, then closes
  the producer and settles the authoritative result. No event is observable afterward; both Adapters and the fake enforce this order.
  Turn diffs drain once; requested edits never prove changes. `tool-partial` drains incomplete command tails with a running outcome; unqualified fields stay absent.
- Child reuse across Turns (a result may settle before the native `close`) is in [harness-adapters](../../docs/agents/harness-adapters.md).
- Operational failures are typed values (`HarnessFailure`, `ControlReceipt` rejections, `RecordingReceipt`, `CleanupReport`). Only caller-contract
  violations throw: a second concurrent Turn on one Prepared Harness, a Turn after `close`, or a Turn beyond what an Adapter can serve. Control races
  (`expired`, `already-settled`, `shape-mismatch`, `unsupported`) are rejected receipts, never throws.
- Durable admission precedes content. `startTurn` returns a handle before native acceptance, but an Adapter awaits `recorder.admit` before sending
  content; a `recorded: false` receipt (or a thrown recorder) proves the Turn `not-started`. A recovery coordinate revealed only after acceptance is
  recorded through `recorder.checkpoint`; a late checkpoint failure is reported separately and never rewrites a settled result.
- `close` is idempotent and returns the same report. Claude retirement retains incomplete cleanup until final exit; failure survives recovery and preserves Turn truth.
- Codex MCP Turn metadata is nested under `x-codex-turn-metadata` (#370), as an object or JSON string. Helpers keep their own ids and only
  their immediate parent; their inherited token remains authoritative. MCP approval input includes the opaque tool arguments, not only the caption.
- Secrets Secant itself introduces are redacted from failures and diagnostics. Excluding raw protocol, private reasoning, and duplicate transcript
  content is Interface design, not generic secret redaction — a `HarnessFailure` still preserves all useful Harness-originated diagnostics and its cause.
  One private registry (`secrets.ts`) owns it: a minter registers a secret when it hands it out, and nothing registers through the Interface. A secret
  stays registered for the whole Secant invocation, so a cause translated after its bridge closes still redacts it; the cost is one short token per
  Session. The Seam's `redactSecrets` keeps a cause an Error with its name and bounded cause chain; it returns secret-free values unchanged. Redactor
  and translator share one cause-depth bound; a redacted tail beyond it becomes null so translation still marks the cut. The translator redacts each
  string before cutting it; its byte bounds are Interface facts pinned by its tests, in serialized UTF-8 bytes.
- Steer ids are caller-supplied and opaque. Each accepted Steer emits one `steer` settlement with its text and send time, even before its receipt resolves.
  Native correlation and pending state stay inside the Adapter; delivery means model exposure, never compliance (#356).
- Steer is a profile capability like the others (`HarnessProfile.steer`, evidence-bearing). An Adapter derives its `steer` receipt from it rather than
  hard-coding a second rejection; Codex and Claude Code (#359) declare it available, and the fake's script decides it through the profile it supplies.
- `SessionFacts.commands` (#359) are the typed leading words a Harness runs as its own commands in the Session (Claude Code's init `slash_commands` as
  `/name`; Codex lists none). They are data for ADR 0040's Steer check above the Seam, never a native list.
- Model selection is a profile fact. `modelSelection` declares where a model can be chosen (`launch`, `per-turn`, both, or `unavailable`) and carries a
  `ModelDeclaration` (ADR 0034): an exhaustive `list`, `suggested` picks that are neither exhaustive nor validated, or `free-text`. `list` and
  `suggested` entries share `{model, label, efforts, defaultEffort?}`; empty `efforts` is a model without an effort setting, and `suggested` and
  `free-text` carry a declaration-level `efforts` for any other name. Both declare `launch-and-per-turn`: Codex its `model/list` entries, Claude Code
  its aliases as `suggested` with the five `--help` efforts and no default (which levels a model honours is observed, never catalogued). Both observe
  the effective model: a `model` event carries effort beside a known model (absent: unknown), each replaces the last, the result's is the last (#345).
  `modelChange.reach` (#348) is `live-turn` (Claude Code, fixture-qualified) or `next-turn` (Codex: `changeModel` is `unsupported`); a change's
  `applied`, `refused` (with `kept`), or `next-turn` answer rides on its `model` event.
- `PreparedHarness.readDefaults()` (#341) is the Harness's own default Model choice, read lazily and once per Prepared Harness so a Run's prepare never
  pays for it: `reported`, or the Adapter's declared `fallback` with its reason (Codex: the `model/list` default at its own default effort; Claude
  Code: Opus (latest) at medium). Claude probes settings outside the profile cache (#347); a failed read falls back, never throws. An
  `effortLock` carries an opaque `source`. Composition's qualify path is its one caller.
- Each prepare and cache hit keeps its own Process, phases and signal (#333, #407). Signal cancellation stops only initial preparation.
  Adapter close retains acquisitions until Process `closed()` confirms exit; its immutable report separates startup failure from cleanup history.
- `PrepareOptions.writableDirectory` (#214) is validated by the one shared `writableDirectoryFailure` (`writable-directory.ts`) before anything
  native runs (not an existing absolute directory ⇒ typed `writable-directory-unavailable`). Claude Code forwards it as `--add-dir` on every launch; Codex
  sends a per-thread `sandbox_workspace_write.writable_roots` config override and refuses the Turn `writable-directory-refused` only when an acknowledged
  `workspaceWrite` sandbox omits it (read-only defers to approvals).
- Each `TurnRequest` carries its `modelChoice` (ADR 0034); `modelChoiceRefusal` refuses one outside a declared `list`, even an empty one
  (`suggested` and `free-text` admit any), as a `not-started` `model-unavailable` Turn before admission, never a substitution. Codex sends model
  and effort on `turn/start` (#345), Claude Code `--model --effort` at launch and typed controls to a reused child (#348). The observed effective
  model never copies the request.

- Context reports replace facts without calculation (#418): Claude keeps model capacity; Codex keeps total/last usage distinct. Tool ids are Turn-local opaque values
  (#414).

- Claude child frames never replace main usage. Parent tool ids share the Turn's minted-id map even when the child arrives first (#439).
  Unidentified settled replies receive a fresh message id; native stream identity is still required for previews.

- Before changing Interrupt, recovery, or Turn cleanup, read [Harness Turn control](../../docs/agents/harness-turn-control.md).

## Tests

- Doubles compose `createTurnEventProducerForTest` and `createPreparationOwnerForTest` through the public entry (#431);
  normalized event retention and initial-resource ownership remain production policy. Preparation close takes `monotonicDeadlineMs`.

- Before changing doubles, conformance, replayers, or recorders, read [Harness testing](../../docs/agents/harness-testing.md).

## Read next

- Read [harness-adapters](../../docs/agents/harness-adapters.md) before changing Claude Code or Codex Adapter internals.
- Read [ADR 0022](../../docs/adr/0022-own-a-truthful-deep-harness-seam.md) before changing the Interface; [Spec #107](https://github.com/secantdev/secant/issues/107) fixes the M3 event vocabulary, result names, and control race values.
