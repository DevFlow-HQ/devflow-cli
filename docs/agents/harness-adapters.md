# Harness Adapter Internals

Read before changing native Adapter internals. [Harness notes](../../src/harness/AGENTS.md) own shared Interface, terminal, recovery and test invariants.
Message identities and terminal partials follow [native qualification provenance](../../tests/harness/message-facts-provenance.md) (#411).
Tools follow [tool provenance](../../tests/harness/tool-facts-provenance.md) (#414); preparation follows `preparation-owner.ts` and ADR 0022 (#407).

## Claude Code Adapter

- Claude's per-Adapter profile cache keys on discovery source, path and file identity. Equal bytes reuse the version; drift requalifies and a source change refreshes evidence.
- `readDefaults` probes `get_settings` once per Prepared Harness in a bounded, settings-only process outside that cache, retaining only `applied` (#347).
  A valid inherited `CLAUDE_CODE_EFFORT_LEVEL` locks effort; invalid values are ignored. Each Turn reads effort without holding settlement.
- A Model choice change (#348) sends `set_model`, `apply_flag_settings`, then a `get_settings` read-back, each after the last succeeded; applied needs the read-back.
  A refused effort restores the model. A reused child gets a differing request the same way. Anything unanswered or unrestorable relaunches with the flags.
- The shared listener mints a 256-bit bearer per Harness Session, reused on relaunch. Both MCP endpoints bind every transport to its Session
  and server, including short extra connections; idle-Session approvals are denied. Each token stays registered for the invocation, and every cause
  below launch crosses `redactSecrets` (close observations, stdin-write and stdout-read errors, captured stderr), so redaction happens at the Seam.
- The stream-json protocol model is the private `claude-code/frames.ts`: one `zod` schema per known frame type (`init`, `status`, `assistant`, `user`,
  `stream_event`, `result`, `control_response`, `command_lifecycle`, `telemetry`), parsed per frame by `parseFrame`, with the stdin encoders, the pure readers, and the only
  raw-field accessors. Elicitation requests are declined; `control_cancel_request` withdraws only the exact pending elicitation (#371). Unrecognized frames add no activity.
  Only the fields dispatch iterates over are structurally required (a message's content array, a stream event's object; a `result` always settles, a missing `subtype` as
  `unknown-result`); every other field degrades to absent (`.catch(undefined)`), unknown fields pass through, and a known type whose
  parse fails or an unknown type is ignored, never protocol corruption. `claude-code.ts` dispatches on `ParsedFrame` and reads no raw field.
- `OwnedProcess.writeStdin` resolves after its error-free write callback and, when `write` returned `false`, the `drain` event. Errors reject.
  Bytes are accepted before the promise settles; durable admission relies on this ordering.
- `jsonl.ts` is the one private hand-rolled NDJSON splitter both native Adapters use (M3 D15, M4 D1): it splits on `\n`, strips a trailing `\r`, preserves
  the terminated raw line for recording, and distinguishes a final unterminated remainder. Claude JSON-parses only a line that trims to something starting
  with `{`; its recorded protocol-corruption fixture pins such a remainder as `truncated JSON frame`, while Codex rejects any nonblank remainder.
- `acceptInit` compares the native `session_id` to the minted coordinate. A mismatch on a **resume** is a `recovery`-phase `recovery-unacknowledged` failure
  that marks the Session unusable (never a silent fresh conversation); a mismatch on a **fresh launch** is `not-started`/`init-session` — the minted id was
  simply never echoed, so the Turn never started.
- Authentication is recognized from the stdout `result` frame, since print mode has no typed auth field. #115's recording pinned the not-logged-in signal
  as `subtype:"success"` with `is_error:true` and `result:"Not logged in · Please run /login"`, so the check runs before the success branch, but the guard
  fires only when `isAuthenticationResult(frame)` and (`subtype !== "success"` or `is_error === true`): a real answer whose text merely quotes a login phrase
  settles `is_error:false` and stays a completed Turn. The raw result never crosses the Seam (it may quote a key) — only `AUTHENTICATION_REQUIRED` does.
- Session child reuse: a Turn result may settle before the child emits `close`. The Session tracks which Turn owns the child, lets an already-settled close
  win before the next send, and never attributes an old child's close to the next Turn; a still-live child may accept the next Turn in place.
- A caller's Interrupt on a live, initialized process running its Turn is native (#346): `claude-code/control.ts`, one channel per process, mints the `request_id`, writes the
  stdin `control_request` `interrupt` with `cancel_queued: true`, and correlates the echoed `control_response`. `controlTimeoutMs` (default 5 s, a named test seam) bounds the
  write through the aborted `result`. The confirming result's subtype is `error_during_execution`, a task failure's
  too, so only an aborted `terminal_reason` (`aborted_streaming`, `aborted_tools`) while that Interrupt is in flight settles `interrupted` `active-turn`; a natural result that
  wins the race keeps its own truth. POSIX keeps its process; Windows launch evidence closes the producer and reaps before settlement, using close kind,
  never exit status. Incomplete cleanup retains the child and fails recovery until final exit. Otherwise the next Turn uses `--resume` with the same id.
- Print mode's exit 1 is a clean close only after the process-owning Turn settled natively interrupted; retain that confirmation before closing (#371).
- A Steer (#359) is a stdin `user` frame with a minted uuid, written only after the prompt (stamped too) and accepted once written. A result listing only uuids the Turn never
  sent is another exchange's and is ignored. `command_lifecycle` `started` or the result's `user_message_uuids` settle it delivered, `cancelled` dropped. A result with a Steer
  pending is held as a boundary, and the Turn ends at the next exchange's; the delivering exchange decides `within-turn` or `after-boundary`. Each exchange re-sends init, and
  a same-id repeat only refreshes the Session fact. `compact_result: "failed"` turns that exchange's success result with `num_turns: 0` into `interrupted` under an Interrupt,
  else `failed`. A relaunched process sends init only after a `/compact`, so a pre-init `compacting` status lifts the init bound (`handshakeTimeoutMs` is the test seam).
- A refused response, failed write, unconfirmed stop, process close, or closing Session falls back to the process stop, which the internal stops
  (failed Turn write, init timeout or mismatch, corruption) always take. It uses the process Module's `interrupt(gracefulMs)`: graceful settles
  `interrupted` `process-only`, a force-kill `lost`, and a live child on Windows is force-killed at once, so its fallback settles `lost`. A process stop
  uses the same retirement owner as admission refusal, Model choice relaunch, native reap, natural close and final close. Incomplete cleanup retains
  the child until independent final exit; recovery refuses meanwhile. Retired readers cannot dispatch into another Turn. Cleanup failure survives recovery.
- Resume spawns with `--resume` (never `--session-id`) for a relaunch of a Session that already ran or a Turn carrying `resume`; init state is per process.
- An unacknowledged resume sets the Session's private `unusableReason` (`markUnusable`); `submit` fails every later Turn with it, never a fresh conversation.

## Codex qualification and Turns

- `codex.ts` owns orchestration, cache, and profile; `codex/qualification.ts` owns bounded pre-thread validation and diagnostics; `codex/runtime-protocol.ts`
  owns retained JSONL state and normalization; `codex/required-schema.ts` owns generated-schema compatibility. Native protocol types stay private.
- Every `prepare` observes `codex --version`; cached schema evidence is keyed by discovery source, path, SHA-256 identity, version, platform, and revision.
  The host platform driving discovery/profile is immutable; only the cache-key test seam varies platform evidence. A hit skips schema generation only.
- Live qualification sends one `initialize` then `initialized`, runs bounded `account/read` and `model/list`, and transfers its child and connection.
  `model/list` entries keep each model's `supportedReasoningEfforts` and `defaultReasoningEffort` as reported (a model with no efforts gets no
  default), and its `isDefault` model is the defaults fallback. One page is read (`cursor: null`); `nextCursor` is not followed.
- `readDefaults` sends `config/read` for the Workspace on the transferred connection, bounded by `controlTimeoutMs`, only when called (the qualify
  path), so Run prepares and their strict recordings never carry it. It is not in `required-schema.ts`: a failed, timed-out, or malformed read falls
  back with its reason instead of failing qualification, and a configured model outside `model/list` or an unoffered effort falls back or takes the
  model's default effort. A fallback reason is read by a person, so it names no RPC and carries no native message. It reports no phase.
- A fresh Session gets `thread.id` before admission; a detached Session requires its exact `thread/resume` id. Any bad acknowledgement makes it
  `unusable`; no fallback. A caller's resume matching the thread still live on this connection skips `thread/resume` and sends the next `turn/start`.
- The Prepared Harness owns one replaceable app-server generation. An Adapter-ended generation detaches every Session before EOF;
  the next Turn rediscovers and checks the qualified path, SHA-256 digest and version, then repeats full live qualification through its prepare's Process.
  Replacement failures (`recovery-identity` or `recovery-app-server`, no possible effects) leave Sessions detached for retry; a refused resume fences only
  that Session. An incompletely reaped generation is retained for cleanup and refuses replacement until it is reaped, preventing duplicate app-servers.
  Sessions resend their thread config on resume. Turns bind after replacement; retired generations cannot dispatch into newer Turns.
- Fresh and resumed Turns preserve admission-before-content and matching terminal authority; completed items supersede delta previews.
- Effective values (#345): `turn/start` carries the Model choice; first acceptance sends one bounded `thread/read` (a refusal re-sent at the next item)
  as the observation, and a matching `model/rerouted` replaces the model. A failed or late read leaves values unknown, never holding the Turn.
- Codex client RPC and reverse-request ids have separate private maps. Approvals expose exact actions. A native resolution or terminal confirms an answer
  whose send has started, emitting `request-answered` before settlement; earlier resolution or terminal expires it. Close and local failures expire
  unconfirmed answers, including in-flight writes. A write failure after native confirmation cannot retract the answer.
- Native Steer and Interrupt await bounded RPC acknowledgement for exact active ids. Only matching interrupted completion proves interruption. Windows launch
  evidence bounds terminal confirmation, closes the producer and reaps the generation before settlement. Every Session detaches and recovers on one replacement.
  EOF cannot erase confirmation. Missing confirmation reaps then settles `lost`; an RPC refusal leaves the Turn live. POSIX keeps its server.
- A Steer's `userMessage` (`clientId`) puts it in history, which delivers it (ADR 0035) at the next model output (agent, reasoning, plan, or tool
  item, delta, approval; never hook prompt or compaction) or any other end. In history with none by a `completed`/`failed` terminal, it is a
  leftover (#357): absent an Interrupt or close it is re-sent once, empty input then text on RPC refusal, on a new native turn id whose target slot
  waiting controls follow, settling `re-delivered`. Refused twice, the terminal stands; an unanswered re-send start loses the Turn.
- `CodexTurn` keeps approval correlation and native control together because both share terminal-ordering state. A third Harness needing the same shapes
  triggers their split; before then, splitting only relocates coupling.
- Codex close rejects new work, expires requests, attempts bounded native interruption, closes stdin, and reaps the tree; cleanup cannot rewrite Turn truth.
- Timeout split: `handshakeTimeoutMs` bounds prepare and replacement qualification (spawn → `initialize`/`account`/`model`); `controlTimeoutMs`
  (defaults to it) bounds post-qualification live exchanges (session start/resume, Turn start/interrupt/steer acks). A stall-then-timeout test squeezes
  `controlTimeoutMs`, never `handshakeTimeoutMs` — throttling the spawn+handshake there flakes `prepare` on a loaded Windows runner (the #148 CI flake).
- Opted-in Codex Sessions attach `secant` through start and every exact resume, reusing their token and fixed tools across replacement (#370).
  `approvalsReviewer: "user"` keeps requests human-routed; MCP tool elicitations expose Allow/Deny. Other elicitations and user input are declined.
  Declined elicitation evidence crosses the Harness Interface as data; Application owns its words. Native MCP metadata only cross-checks attribution.
- Codex inherits user environment/home; unauthenticated becomes the fixed separate-login remediation, and no account or credential crosses the Seam.
- The per-thread `sandbox_workspace_write.writable_roots` override (#214) **replaces** any user-configured extra `writable_roots` for that thread rather than
  merging them (a `ponytail:` in `codex.ts`; merge via `config/read` if a user relies on both). `sandboxAdmitsDirectory` compares roots through
  `realpathSync.native`, since Codex may report a resolved path, and refuses only a `workspaceWrite` sandbox that omits the root; every other posture stays the user's.

## Native phases

Each Adapter reports the five phases through `phases.ts`, settling each start once with monotonic elapsed time (#322). Handshake exchanges nest
`HarnessPhaseStep` spans (#325) inside it; composition logs them only in detail mode.

- **Claude Code.** Per-Session `launch` spans bridge start and spawn; close winning abandons it. Fresh init is `handshake`; resumed init is `recovery`,
  including relaunches of Sessions that ran before. Settlement before init fails that phase with the Turn's failure, or abandons it on interruption.
  `control` covers stops, including internal stops after settlement. Native confirmation succeeds; a natural result abandons it, and fallback includes termination.
  Keyless `cleanup` covers close; Session-keyed cleanup covers process stops, admission, relaunch and Windows interrupt reaping. Version has no phase.
- **Codex.** Keyless `launch` spans app-server spawn and `handshake` spans initialize, account and model reads at prepare and replacement. Replacement also
  reports the triggering Session's `recovery` around identity checks, launch and handshake. Handshake steps are `protocol-initialize`, `account-check` and
  `model-list`; the open step shares the handshake outcome, so login refusal fails `account-check`. Turn models are checked before recovery, never at prepare.
  Defaults `config/read` and runtime `thread/read` have no phase. Per Session, `thread/start` is `handshake` and `thread/resume` is `recovery`.
  `control` spans Interrupt and Steer: acknowledgement is ok, except Windows Interrupt waits for terminal confirmation. An expected race abandons it;
  other failures report `control-refused` with the RPC code, `control-timeout`, `control-transport` or `protocol-corruption`. Keyless cleanup covers close,
  including bounded interruption; Session-keyed cleanup covers Windows interrupt reaping.
