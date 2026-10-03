# Harness Adapter Internals

Read this before changing the private internals of the Claude Code or Codex Adapter under `src/harness/`. The Harness Interface, terminal ordering,
interrupt, recovery, and test invariants every Adapter shares stay in [the Harness Module's notes](../../src/harness/AGENTS.md).

## Claude Code Adapter

- Qualification is cached per Adapter instance in a private `Map`, keyed by the discovered target's discovery source, its path, and its file identity: same
  path with identical bytes ⇒ the probed version cannot have changed, so the cached profile is reused without re-running `--version`; any drift in path or
  identity requalifies, and folding the source into the key stops a reused profile reporting a stale source.
- The permission bridge mints a 256-bit per-Run bearer token for its loopback MCP server; the token lives only in the `--mcp-config` argv and the server's
  constant-time auth check. The bridge registers it with the Harness secret registry for the rest of the invocation, and the Session routes every
  failure cause originating below launch through the registry's `redactSecrets` (`scrub` on each close observation; the stdin-write and stdout-read
  errors and the captured stderr text too), so the rule is "redact at the Seam", not one spawn-error path (#127 A22).
- The stream-json protocol model is the private `claude-code/frames.ts`: one `zod` schema per known frame type (`init`, `assistant`, `user`,
  `stream_event`, `result`, `control_response`, `telemetry`), parsed per frame by `parseFrame`, with the stdin encoders, the pure readers, and the only
  raw-field accessors. Inbound `control_request` and `control_cancel_request` stay generic activity until #371. Only the fields dispatch
  iterates over are structurally required (a message's content array, a stream event's object; a `result` always settles, a missing `subtype` as
  `unknown-result`); every other field degrades to absent (`.catch(undefined)`), unknown fields pass through, and a known type whose
  parse fails or an unknown type is generic activity — never protocol corruption. `claude-code.ts` dispatches on `ParsedFrame` and reads no raw field.
- `OwnedProcess.writeStdin` resolves only after both the write callback has fired without error and the stream has drained (it waits for the `drain` event
  when `write` returned `false`); an error rejects. The Turn's bytes are accepted before the write promise settles, which is what the durable-admission
  ordering rests on.
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
- A caller's Interrupt on a live, initialized process running its Turn is native (#346): `claude-code/control.ts`, one channel per process, mints the
  `request_id`, writes the stdin `control_request` `interrupt`, and correlates the echoed `control_response`. `controlTimeoutMs` (default 5 s, a named
  test seam) bounds the write through the aborted `result`. The process, active Turn, and process ownership stay put. The confirming result's subtype
  is `error_during_execution`, a task failure's too, so only an aborted `terminal_reason` (`aborted_streaming`, `aborted_tools`) while that Interrupt is
  in flight settles `interrupted` `active-turn`; a natural result that wins the race keeps its own truth. The Session then reports `detached` with its
  coordinate, as Codex does, and a resuming Turn finds the process live and sends at once.
- A refused response, failed write, unconfirmed stop, process close, or closing Session falls back to the process stop, which the internal stops
  (failed Turn write, init timeout or mismatch, corruption) always take. It uses the process Module's `interrupt(gracefulMs)`: graceful settles
  `interrupted` `process-only`, a force-kill `lost`, and a live child on Windows is force-killed at once, so its fallback settles `lost`. A process stop
  claims the process before awaiting, and `onClosed` returns early when `this.process !== owned`; during a native stop it yields too, because the
  closed channel sends that stop to its fallback, which settles the one authoritative result.
- Resume spawns with `--resume` (never a fresh `--session-id`) for a relaunch of a Session that already ran or any Turn carrying `resume`. Init state is
  per process.
- Session unusability is stored as a private `unusableReason` on the Session, set by `markUnusable` when a resume is not acknowledged; the Turn-start path
  (`submit`) reads it first and fails every further Turn with the same recovery failure, never opening a fresh conversation.

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
- Codex client RPC and reverse-request ids have separate private maps. Approvals expose exact actions. A native resolution or terminal confirms an answer
  whose send has started, emitting `request-answered` before settlement; earlier resolution or terminal expires it. Close and local failures expire
  unconfirmed answers, including in-flight writes. A write failure after native confirmation cannot retract the answer.
- Native Steer and Interrupt await bounded RPC acknowledgement for exact active ids. Only matching interrupted completion proves interruption; connection loss stays `lost`.
- `CodexTurn` keeps approval correlation and native control together because both share terminal-ordering state. A third Harness needing the same shapes
  triggers their split; before then, splitting only relocates coupling.
- Codex close rejects new work, expires requests, attempts bounded native interruption, closes stdin, and reaps the tree; cleanup cannot rewrite Turn truth.
- Timeout split: `handshakeTimeoutMs` bounds prepare and replacement qualification (spawn → `initialize`/`account`/`model`); `controlTimeoutMs`
  (defaults to it) bounds post-qualification live exchanges (session start/resume, Turn start/interrupt/steer acks). A stall-then-timeout test squeezes
  `controlTimeoutMs`, never `handshakeTimeoutMs` — throttling the spawn+handshake there flakes `prepare` on a loaded Windows runner (the #148 CI flake).
- Codex inherits user environment/home; unauthenticated becomes the fixed separate-login remediation, and no account or credential crosses the Seam.
- The per-thread `sandbox_workspace_write.writable_roots` override (#214) **replaces** any user-configured extra `writable_roots` for that thread rather than
  merging them (a `ponytail:` in `codex.ts`; merge via `config/read` if a user relies on both). `sandboxAdmitsDirectory` compares roots through
  `realpathSync.native`, since Codex may report a resolved path, and refuses only a `workspaceWrite` sandbox that omits the root; every other posture stays the user's.

## Native phases

Each Adapter maps its native steps onto the five semantic phases (#322) through the private `phases.ts` span, which settles each start once and
measures elapsed time on the monotonic clock. A handshake made of several exchanges reports each as a span carrying a closed semantic `step`
(`HarnessPhaseStep`, #325), nested inside the handshake's own start and end; composition logs those only in detail mode.

- **Claude Code.** `launch` (per Session) spans the bridge start and the child spawn; a close that wins first abandons it. The first init of a fresh
  child is the Session's `handshake`; the init of a `--resume` child is `recovery`, which includes every relaunch of a Session that already ran
  (print mode exits per Turn, so a later Turn reattaches natively unless the child is still live). A Turn that settles before init ends that phase with its own
  failure, or abandoned when interrupted. `control` is one span per stop: a native stop's span is ok on confirmation, abandoned when a natural
  result wins, and otherwise spans the fallback process termination too. A process termination settles the span on its outcome even when the Turn
  already settled (an internal stop after corruption or a refused resume reports it too). `cleanup` spans the prepared Harness's `close`.
  The `--version` probe reports no phase.
- **Codex.** `launch` is the app-server spawn and `handshake` the `initialize`/`account/read`/`model/list` exchange, both at prepare and replacement with no
  Session key. Replacement also reports the triggering Session's `recovery` around identity checks, launch and handshake.
  The handshake's steps are `protocol-initialize`, `account-check`, and `model-list`; the step open when the handshake
  ends settles with its outcome, so a login refusal fails `account-check`. `model-list` only reads the list; each Turn's model is checked against it
  at Turn start before native recovery, never at prepare. The lazy `config/read` defaults read is outside the handshake and reports no
  phase. Per Session,
  `thread/start` is a `handshake` and `thread/resume` is `recovery`. `control` spans the `turn/interrupt` or `turn/steer`
  RPC: ok on a parsed acknowledgement, abandoned on an expected race, otherwise failed (`control-refused` with the RPC code, `control-timeout`,
  `control-transport`, or `protocol-corruption`). `cleanup` spans `close`, including its bounded interrupt.
