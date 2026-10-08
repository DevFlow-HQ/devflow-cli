# Claude Code Adapter internals

Read before changing the private Claude Code Adapter.
[Harness adapters](./harness-adapters.md) owns shared entry guidance and phase mapping.

## Claude Code Adapter

- Claude's per-Adapter profile cache keys on discovery source, path and file identity. Equal bytes reuse the version; drift requalifies and a source change refreshes
  evidence.
- `readDefaults` probes `get_settings` once per Prepared Harness in a bounded, settings-only process outside that cache, retaining only `applied` (#347).
  A valid inherited `CLAUDE_CODE_EFFORT_LEVEL` locks effort; invalid values are ignored. Each Turn reads effort without holding settlement.
- A Model choice change (#348) sends `set_model`, `apply_flag_settings`, then a `get_settings` read-back, each after the last succeeded; applied needs the read-back.
  A refused effort restores the model. A reused child gets a differing request the same way. Anything unanswered or unrestorable relaunches with the flags.
- The shared listener mints a 256-bit bearer per Harness Session, reused on relaunch. Both MCP endpoints bind every transport to its Session
  and server, including short extra connections; idle-Session approvals are denied. Each token stays registered for the invocation, and every cause
  below launch crosses `redactSecrets` (close observations, stdin-write and stdout-read errors, captured stderr), so redaction happens at the Seam.
- Every Session launch attaches its MCP servers with `mcp_set_servers` over stdin before the prompt. Success requires every requested server in
  `added` and an empty `errors` map; refusal, malformed success, write failure, timeout and closure fail launch with a plain `mcp-attachment` cause.
  No bearer reaches argv or environment, no argv fallback exists, and `mcp_status` is never sent. Resume and Model-choice/Windows recovery reuse this path.
- The stream-json protocol model is the private `claude-code/frames.ts`: one `zod` schema per known frame type (`init`, `status`, `assistant`, `user`,
  `stream_event`, `result`, `control_response`, `command_lifecycle`, `telemetry`), parsed per frame by `parseFrame`, with the stdin encoders, the pure readers, and the
  only
  raw-field accessors. Elicitation requests are declined; `control_cancel_request` withdraws only the exact pending elicitation (#371). Unrecognized frames add no
  activity; an unrecognized or malformed `control_request` instead loses the Turn with `unsupported-control-request` and stops its process.
  Only the fields dispatch iterates over are structurally required (a message's content array, a stream event's object; a `result` always settles, a missing `subtype` as
  `unknown-result`); every other field degrades to absent (`.catch(undefined)`), unknown fields pass through, and a known type whose
  observation parse fails or an unknown type is ignored, never protocol corruption. Control requests use the failure rule above.
  This applies the [shared classification rule](./harness-adapters.md#required-and-optional-native-facts): unreadable optional observations stay absent,
  with no named display limits. `claude-code.ts` dispatches on `ParsedFrame` and reads no raw field.
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
- A caller's Interrupt on a live, initialized process running its Turn is native (#346): `claude-code/control.ts`, one channel per process, mints the `request_id`, writes
  the
  stdin `control_request` `interrupt` with `cancel_queued: true`, and correlates the echoed `control_response`. `controlTimeoutMs` (default 5 s, a named test seam) bounds
  the
  write through the aborted `result`. The confirming result's subtype is `error_during_execution`, a task failure's
  too, so only an aborted `terminal_reason` (`aborted_streaming`, `aborted_tools`) while that Interrupt is in flight settles `interrupted` `active-turn`; a natural result
  that
  wins the race keeps its own truth. POSIX keeps its process; Windows launch evidence closes the producer and reaps before settlement, using close kind,
  never exit status. Incomplete cleanup retains the child and fails recovery until final exit. Otherwise the next Turn uses `--resume` with the same id.
- Print mode's exit 1 is a clean close only after the process-owning Turn settled natively interrupted; retain that confirmation before closing (#371).
- A Steer (#359) is a stdin `user` frame with a minted uuid, written only after the prompt (stamped too) and accepted once written. A result listing only uuids the Turn
  never
  sent is another exchange's and is ignored. `command_lifecycle` `started` or the result's `user_message_uuids` settle it delivered, `cancelled` dropped. A result with a
  Steer
  pending is held as a boundary, and the Turn ends at the next exchange's; the delivering exchange decides `within-turn` or `after-boundary`. Each exchange re-sends init,
  and
  a same-id repeat only refreshes the Session fact. `compact_result: "failed"` turns that exchange's success result with `num_turns: 0` into `interrupted` under an
  Interrupt,
  else `failed`. A relaunched process sends init only after a `/compact`, so a pre-init `compacting` status lifts the init bound (`handshakeTimeoutMs` is the test seam).
- A refused response, failed write, unconfirmed stop, process close, or closing Session falls back to the process stop, which the internal stops
  (failed Turn write, init timeout or mismatch, corruption) always take. It uses the process Module's `interrupt(gracefulMs)`: graceful settles
  `interrupted` `process-only`, a force-kill `lost`, and a live child on Windows is force-killed at once, so its fallback settles `lost`. A process stop
  uses the same retirement owner as admission refusal, Model choice relaunch, native reap, natural close and final close. Incomplete cleanup retains
  the child until independent final exit; recovery refuses meanwhile. Retired readers cannot dispatch into another Turn. Cleanup failure survives recovery.
- Resume spawns with `--resume` (never `--session-id`) for a relaunch of a Session that already ran or a Turn carrying `resume`; init state is per process.
- An unacknowledged resume sets the Session's private `unusableReason` (`markUnusable`); `submit` fails every later Turn with it, never a fresh conversation.
