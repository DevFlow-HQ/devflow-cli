# Own a Truthful Deep Harness Seam Instead of Emulating Harness Parity

Crucible owns one deep **Harness Adapter** Module that translates Harness-native launch, conversation, event, control, recovery, failure, and cleanup
semantics into a Crucible Interface. Its conceptual shape is `prepare -> PreparedHarness`, `startTurn -> HarnessTurn`, and `close -> CleanupReport`;
a Turn exposes one ordered event stream, one sole authoritative result, and a closed control operation. Exact type names remain an implementation
choice, but the ordering, ownership, and failure rules are part of the Interface. The caller is Crucible's Run/Step execution Module, never the TUI:
raw Harness evidence flows through the Adapter to that caller and then through the **Projection Port**. The Adapter therefore knows no Workflow
Bundle, Step kind, retry budget, Routing, or Run state, and offers no raw-provider client or protocol escape hatch. This decision resolves
[Define the truthful Harness capability and Adapter contract](https://github.com/DevFlow-HQ/devflow-cli/issues/8).

`prepare` performs non-conversational Preflight qualification and returns an immutable semantic profile tied to the observed executable, version,
platform, configuration posture, and Adapter revision. The profile uses evidence-bearing variants rather than flat booleans: recovery distinguishes
native reattach, load-with-replay, and unavailable; interruption distinguishes confirmed active-Turn interruption, process-only stop, and
unavailable; approvals and structured clarifications are independent; model selection reports where it can occur; and recovery-coordinate timing
states whether durable recording can precede submission. Step kinds declare required capabilities and Preflight checks their union. Optional UI
features use the same profile. If reality drifts, the Adapter may requalify only when it can prove equivalent semantics; Crucible never fills a gap
with PTY inference, a weaker operation, or a silent Harness switch.

A **Turn** is one mechanical exchange inside a named **Harness Session**, not a Session and not a judgement that a Step succeeded. Crucible supplies
an opaque correlation key, and `startTurn` returns a handle before native acceptance; that key is not an exactly-once promise, so uncertain
submission is never automatically retried. A Prepared Harness allows one active Turn while privately retaining multiple idle named conversations.
Sessions open or recover lazily and report `open`, `detached`, or `unusable` independently of every Turn outcome. The closed Turn results are
`not-started`, `completed`, `failed`, `interrupted`, and `lost`: `completed` means only an authoritative Harness boundary, while `lost` means effects
may have started but no terminal truth survived qualified, safe, read-only recovery probes. Lost detail records whether acceptance, completion, or
interruption is unknown and the last authoritative observation. The Step kind, above this Seam, decides the Attempt outcome and retry policy.

The event stream preserves every user-meaningful assistant, tool, command, file-edit, subagent, request, retry, failure, model, session, and recovery
fact. Known unfamiliar tool work is `other`; unknown methods and accounting notices add no activity. Context and usage carry only reported facts,
with their meanings distinct and cost estimates labelled. Raw protocol frames, private reasoning, telemetry, and ordinary stderr remain private.
(Edited 2026-10-06 to apply [ADR 0038](./0038-carry-observed-tool-and-summary-facts-through-the-harness-seam.md) in #418.)
(Edited 2026-09-29: [ADR 0036](./0036-the-run-workbench-mirrors-the-agent.md) settles that a provider-written reasoning summary is not private
reasoning and may cross the Seam; the raw chain of thought stays private.)
(Edited 2026-09-29: [ADR 0038](./0038-carry-observed-tool-and-summary-facts-through-the-harness-seam.md) defines identified typed tool observations,
native command previews, patches, and summary rows, inherits Harness summary settings, and limits context to reported facts rather than calculations.
Unknown protocol methods and accounting notices do not become generic activity; meaningful tool work remains displayable.)
The Adapter drains the native transport independently of a slow TUI, coalesces only replaceable previews, closes the producer after all final facts
are queued, and only then settles the result; no event can follow it. The result carries terminal status, the effective-model observation,
post-Turn Session availability, and structured failure. Authoritative assistant content crosses as `assistant-content` events.
(Edited 2026-10-09 for [M10 audit A13](https://github.com/secantdev/secant/issues/440): retire generic activity events and the unread final-content result field.)

Controls are closed and stateful. `steer` means native same-Turn input only; `answer-request` addresses one exact ephemeral approval or structured
clarification; `interrupt` means Harness-confirmed termination of the active Turn and its native work. Ordinary turn-taking calls `startTurn` again,
and ending an Interactive agent step remains a Crucible control above the Seam. Expected races return an accepted or rejected receipt rather than
throwing. Acceptance does not prove final effect: after an accepted interrupt the Adapter rejects new inputs, drains to native terminal evidence,
and the Turn result confirms whether interruption occurred. Harness Requests are Turn-scoped, independently keyed, may coexist, and expire when the
Turn ends, is interrupted, or is lost; an ordinary assistant question at a Turn boundary is not a Harness Request. (Edited 2026-09-29:
[ADR 0035](./0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md) widens `steer` to native mid-Turn delivery of the human's text at the Harness's
next boundary, keeps a Turn open until every accepted Steer is delivered, adds a delivered-or-dropped Steer lifecycle to the event stream, drops
undelivered Steers on interrupt, and qualifies Claude Code's `interrupt` control request as a confirmed active-Turn interruption with a process-stop
fallback.)

Native conversation identifiers are opaque recovery coordinates, never Run truth. When one is observable before submission, the Adapter awaits a
Crucible-owned durable recorder before sending content; recording failure proves `not-started`. When a Harness reveals it only after acceptance, the
profile exposes that unavoidable crash window and the Adapter records it immediately. A late recording failure cannot falsify the Turn result: the
Adapter continues draining, reports the checkpoint failure separately, and does not claim durable recovery. Recovery never silently creates a fresh
conversation. Load-with-replay keeps old transcript content visibly historical, reconciles duplicates, and establishes a history/live barrier before
new progress. A settled result is immutable; later evidence is appended as reconciliation rather than rewriting history.

Operational failures are typed values, preserving phase, category, possible effects, partial output, native code, retry evidence, useful diagnostics,
and the original cause; only trusted caller-contract violations throw. Authentication failures direct the user to log in separately through the
named Harness. Unlike the legacy metadata-only diagnostic default in [ADR 0011](https://github.com/secantdev/secant/blob/legacy-devflow/docs/adr/0011-adapter-diagnostic-tracing-is-metadata-only.md), this target
Interface exposes all useful Harness-originated diagnostic information to the Harness owner and preserves its cause. It redacts only secrets Crucible
itself introduces; excluding raw protocol, private reasoning, and duplicate transcript content is Interface design, not generic secret redaction.
Requested and effective models remain distinct, native read-only evidence is used proactively, provider fallback is shown, and an unconfirmed
effective model stays unknown rather than copying the request.

Crucible does not transport credentials through this Interface: authentication and configuration remain owned by the user's Harness installation.
Timeouts apply only to a closed set of mechanical operations—launch/protocol initialization, open/recovery handshakes and status probes, immediate
control acknowledgement, and cleanup—never to agent thought, tools, subagents, approvals, clarifications, or a whole Turn. `close` is idempotent,
rejects new work, expires requests, attempts supported graceful interruption, closes transports, and then bounds termination and process-tree reaping.
Force-killing a Turn already proven complete is cleanup; killing unconfirmed active work produces `lost`. Cleanup failure is separate and cannot
rewrite a settled Turn. Edited 2026-10-05: before successful preparation, the invocation-lived Harness Adapter owns initial acquisitions,
including failed or cancelled preparations with unconfirmed cleanup. Successful preparation transfers ownership exclusively to the Prepared
Harness's caller; Preflight retains that responsibility until successful Run handoff. Exactly one owner remains responsible at each stage.
The preparation lifecycle selected below is implemented by #407 (2026-10-06).

This Interface is also the test surface: every shipped Harness Adapter implements it beside a deterministic fake; a shared conformance suite exercises
ordering, requests, controls, recovery, failure, and cleanup, while private versioned protocol fixtures and opt-in pinned real-runtime qualification
cover native drift. The shipped Harness portfolio is a product-scope decision rather than part of this architecture. OpenCode supplied useful examples
of exact IDs, durable admission, and session tracking, but its types, event vocabulary, state providers, and domain model do not cross the Seam,
consistent with [ADR 0018](./0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md). We
rejected a minimal `qualify/turn/close` facade because it hides stateful interaction and recovery, a broad capability object graph because it leaks
mechanism and invites caller coupling, and a whole-Step `execute` API because it drags orchestration below the Seam. The chosen prepared-Harness
hybrid is narrower in vocabulary but deeper in guarantees; its cost is a stricter Adapter and conformance burden in exchange for truthful differences
and one stable caller contract.

## Amendment (2026-10-05): initial preparation ownership through invocation shutdown

[Decide cleanup ownership for failed initial Harness preparation through invocation shutdown](https://github.com/secantdev/secant/issues/402)
selects the existing Harness Adapter as the invocation-lived owner of initial, pre-handoff preparation resources. Composition constructs and
finally closes it. This extends the Harness Interface with a per-preparation cancellation signal and an Adapter-level final `close` returning
a separate typed preparation-cleanup report. Exact type names remain implementation choices. The existing Prepared Harness Interface and its
post-handoff cleanup ownership remain unchanged. This amendment recorded the approved planning contract. Implemented in M10 by #407 (2026-10-06).

The Adapter registers each preparation before its first asynchronous operation, then owns acquired resources until confirmed disposal or
exclusive successful handoff. Independent concurrent preparations retain separate Process, observer, and cancellation scopes. The qualification
cache can remain shared, but a cache hit never reuses another preparation's Process or observer. Retaining unfinished preparations and
unconfirmed initial resources is the deliberate exception to the earlier cache-only Adapter rule.

Cancellation and successful handoff have one atomic ordering point immediately before publishing success. Cancellation or shutdown before
handoff returns a typed preparation failure and leaves cleanup with the Adapter. Successful handoff first transfers ownership exclusively to
the caller, which must receive the successful result and close the Prepared Harness if it no longer needs it. An expected cancellation or
preparation refused after shutdown is a typed operational failure, not a thrown caller-contract violation. An already established startup failure
retains its primary category and cause; cancellation and cleanup evidence cannot replace it.

Cancellation belongs to the owner of the actual preparation. Closing a Projection ends its subscription. Shared Harness Catalog qualification
continues until it settles or the invocation shuts down, so leaving one screen cannot cancel qualification another consumer awaits. A dedicated
preparation can be cancelled through its own signal without affecting independent preparations.

Composition begins final close across all Adapters before draining Application's existing Run owners. Each close synchronously closes
preparation admission and cancels its pending preparations. Initial preparation cleanup proceeds concurrently under one shared five-second
deadline across Adapters, resources, and cleanup stages. The budget begins when preparation shutdown starts; it is not five seconds per resource
or a bound on the separately owned Run drain. Repeated close calls share one cleanup attempt and its immutable report without restarting or
extending the deadline. Composition records the reports before closing stores and the operational log on normal completion, signals, errors,
and startup or renderer failures after acquisition.

A preparation still settling at the deadline counts as unresolved even when its launch has not returned a resource. A late acquisition remains
owned and enters cleanup while the invocation lives; it cannot publish success after shutdown won or access already closed reporting sinks.
Returning the bounded final report does not release an unconfirmed resource or prove that an external process stopped. The report preserves
the observations at its deadline. Later confirmed closure releases private retention without rewriting that report.

An incomplete cached cleanup receipt is distinct from independently confirmed final exit. The Adapter observes the latter through the Process
Interface and releases ownership only when the owned resource lifetime is confirmed ended. Earlier cleanup failure remains historical evidence
after a later confirmed exit. The preparation-cleanup report distinguishes all resources confirmed closed from unresolved work, with typed
entries for preparation still settling and acquired resource closure unconfirmed. It preserves startup and cleanup failures separately, including
their causes and useful diagnostics. Process handles, protocol connections, and native generation objects remain private.

The Interface adds one final lifecycle operation rather than making each caller learn resource tracking and cleanup races. Those decisions stay
local to the Harness Module; composition owns construction, shutdown ordering, and reporting. Existing Claude Code, Codex, and deterministic
fake Adapters demonstrate the Seam. Verification exercises `prepare` and final `close` through that same Interface with an injected Process,
including delayed acquisition, cancellation and handoff races, independent prepares, late exit, and truthful unresolved reports. Composition
coverage includes qualification without a Run, failed Run preparation, normal headless completion, signals, TUI quit, and construction failure.

We rejected a failed-prepare cleanup handle because it distributes retention and late-result obligations across failure callers. A Process scope
would broaden ownership to other children and require coordination with successfully handed-off Prepared Harnesses. The selected contract costs
per-preparation tracking and lifecycle conformance work. Retention scales with unresolved preparations and resources; the shutdown deadline
bounds waiting, not memory or external-process lifetime. Broader post-handoff cleanup changes require a separate decision. This nonblocking M9
hand-over does not change the approved milestone sequence or commission production implementation.

## Amendment (2026-09-07): skills, protocol drift, and model lists

Recorded while [approving the migration handoff](https://github.com/DevFlow-HQ/devflow-cli/issues/22). A `skill` Bundle Asset reaches every
Harness by **plain-path delivery** in v1: the Adapter places the skill directory in the Run's read-only asset space and the rendered prompt tells the
agent to read its `SKILL.md`. Native skill delivery is a later version and, when it arrives, becomes a profile fact (`native` or `plain-path`)
rather than a Preflight requirement, because plain-path is a real delivery and not an emulated control. Qualification of an installed Harness whose
protocol is unversioned (Codex app-server) runs the pinned conformance probe against whatever is installed: pass means usable, fail means the
Harness is `unavailable` with a typed reason, never best-effort parsing. A Workflow Bundle never selects or constrains a model in v1; the Adapter
profile supplies the model list when the Harness exposes one and declares free-text entry otherwise. A non-binding recommended model authored in
the Bundle is deferred to a later version. (Edited 2026-09-23: M5 shipped this as two profile fields. `modelSelection` declares where a model can be
selected and carries a `list` or `free-text` model declaration, or declares selection `unavailable`; `modelObservation` declares whether the Adapter
reads the effective model from native evidence, independent of selection. A caller's requested model outside a declared list is a typed
`model-unavailable` prepare failure, never a substitution. Edited 2026-10-03, [#340](https://github.com/secantdev/secant/issues/340): the request
moved to each Turn request, so such a model now settles that Turn `not-started` with `model-unavailable` before admission, and nothing about the model
is a prepare option.) (Edited 2026-09-29: [ADR 0034](./0034-choose-and-change-model-and-effort-as-one-run-wide-model-choice.md)
replaces the Run-level requested model with a Run-wide **Model choice** of model and effort requested per Turn, adds a `suggested` model declaration
kind, and qualifies Claude Code's typed model and effort control requests with a relaunch fallback.)

## Amendment (2026-09-18): delivery mode is the Adapter's, substitution is the caller's

Recorded while tidying the M3 audit
([#129](https://github.com/secantdev/secant/issues/129), audit [#127](https://github.com/secantdev/secant/issues/127)).
The 2026-09-07 amendment above read as if the Adapter renders the prompt. It does not. What the Adapter owns, and the profile declares, is the delivery
**mode** — `native` or `plain-path` for a skill, and the equivalent `FileDelivery` mode for file artifacts. Substituting Bundle artifacts into the prompt
text is the **caller's**, because rendering needs the Bundle input and asset knowledge this ADR keeps out of the Adapter (the Adapter knows no Workflow
Bundle). The caller renders the prompt text and hands it in as the Turn's semantic input; the Adapter chooses only how each declared asset is delivered.

## Amendment (2026-09-21): Harness portfolio is product scope

Recorded while [choosing whether OpenCode earns the third v1 Harness slot](https://github.com/secantdev/secant/issues/175). The original decision's
named three-Adapter portfolio was a migration-plan fact, not an architectural constraint. The Harness Seam applies unchanged to every shipped Adapter;
the current portfolio and any qualification condition live in the product-scope and sequencing decisions.

## Amendment (2026-09-23): one additional writable directory crosses the Seam

Recorded while tidying the M6 audit ([#231](https://github.com/secantdev/secant/issues/231), audit
[#230](https://github.com/secantdev/secant/issues/230)). [#214](https://github.com/secantdev/secant/issues/214) added a second declared caller-supplied
path to `prepare` beside the Workspace: `PrepareOptions.writableDirectory`, one additional absolute directory every Session may write. The Adapter
grants it natively only where the Harness's sandbox rules would otherwise refuse it, without changing the user's broader permission posture. A path
that is not an existing absolute directory is a typed `writable-directory-unavailable` prepare failure, and a native policy that does not admit it
fails the Turn. Composition supplies the Run working area that [ADR 0023](./0023-own-durable-run-truth-in-isolated-run-stores.md)'s 2026-09-23
amendment gives each Run Store; the Adapter sees only a path, never a Run fact, so it still knows no Run state and is never granted the Run database
or Artifact repository.

## Amendment (2026-09-28): Agent calls cross the Seam as opaque declarations

[ADR 0033](./0033-carry-agent-calls-to-secant-over-a-per-session-loopback-mcp-server.md) lets an agent call Secant through a Secant-hosted MCP
server the Adapter attaches to its Session. The caller passes a Session's call declarations as opaque data, bound when the Session opens; the Turn's
event stream gains a data-only agent-call event, the Turn handle gains one closed control that answers it, a call unanswered at Turn end expires
before the producer closes, and the profile gains an evidence-bearing `agentCalls` capability. The Adapter still learns no Step, Stage, or Run fact:
it delivers the declarations and reports the call, and the caller judges it. The same decision makes Codex MCP tool approvals ordinary tool-approval
Harness Requests and declines other MCP elicitations without failing the Turn, instead of treating them as unsupported server requests.

## Amendment (2026-10-08): required and optional native facts

Recorded while deciding [which consumed Codex notifications qualification requires](https://github.com/secantdev/secant/issues/458), hand-over A14
of the [M10 audit](https://github.com/secantdev/secant/issues/429). Each slice had chosen alone: M10 made the Codex reasoning-summary delta a
required schema fact, so its rename would make Codex `unavailable` for every model, while the Turn diff and token-usage notifications consumed in the
same milestone degraded silently, and four notifications nothing reads stayed required.

One rule now governs every Adapter. A consumed native fact is **required** only when a Turn cannot run correctly without it: Turn admission and its
terminal, the final agent message, tool calls, Harness Requests, Steer, Interrupt, resume, and the effective model, with the native shapes that place
them in Session history (for Codex, the model-output item kinds that mark Steer delivery). Every other consumed fact is **optional**: Thought
summaries, the cumulative Turn diff, context and usage, and live previews of agent messages, command output, and summaries, whose finals still replace
them ([ADR 0024](./0024-use-one-deep-projection-port-for-tui-and-headless-clients.md)). A failed required fact keeps the 2026-09-07 rule: the Harness is
`unavailable` with a typed reason. A failed optional fact disables only that fact.

Optional facts are never best-effort parsed. Where the Harness publishes its formats (the Codex generated schema), qualification checks optional facts
against them beside the required ones; a mismatch disables that fact for the qualified install before any Run, and the Adapter never reads it. The
profile carries each disabled fact as a person-readable limit, and the Qualification state reads `qualified-with-limits`, listing the limit apart from
the six capabilities. Where the Harness publishes no formats (Claude Code), a fact is read strictly when it arrives and stays absent when unreadable;
whether that runtime absence is named is [#460](https://github.com/secantdev/secant/issues/460)'s question. An honest absence, such as a model that
writes no summary or summaries turned off in the user's Harness settings, is not a limit.

A fact nothing consumes is neither required nor optional: it leaves the lists, and the change that first consumes it classifies it. Each Adapter keeps
its classification private beside its check, and a test holds the Codex lists equal to the facts the Adapter reads. We rejected requiring every
consumed fact, where any display rename removes the Harness, and T3 Code's posture of checking nothing in the stream, where a renamed terminal would
leave Turns hanging.
