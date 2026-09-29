# Harness Interrupt and Queued Messages

Research date: 2026-09-28

Sources examined:

- Claude Code **2.1.283** (installed native executable, Linux x64) and the `@anthropic-ai/claude-agent-sdk` **0.3.283** package that
  bundles it (`claudeCodeVersion: 2.1.283`), plus Secant's recorded stream-json fixtures from Claude Code 2.1.273 and 2.1.281.
- Codex **codex-cli 0.157.1** (installed, Linux x64), upstream tag `rust-v0.157.1` at commit
  [`36650394c5b38c2990ccf2a3457165ca3e9d9726`](https://github.com/openai/codex/commit/36650394c5b38c2990ccf2a3457165ca3e9d9726), plus
  Secant's recorded app-server fixtures from codex-cli 0.155.0.
- T3 Code commit
  [`de251fc2971a884cb5b1305ba4daf309dc8cccb0`](https://github.com/pingdotgg/t3code/commit/de251fc2971a884cb5b1305ba4daf309dc8cccb0), which
  resolves `@anthropic-ai/claude-agent-sdk@0.3.276`.
- Secant at [`68a9018`](https://github.com/secantdev/secant/commit/68a90184a50bcf78c3877362e7da49c6b9dba171).

Ticket: [#254](https://github.com/secantdev/secant/issues/254)

## Answer

**Native clients.** In the Claude Code TUI, `Esc` stops the current response or tool call, "Claude keeps the work done so far", and any
queued messages go out next. `Enter` while Claude works queues the message. If Claude is running tool calls, the message is passed to
Claude "as soon as those tool calls finish, within the same turn". Messages still queued when the Turn ends are sent as the next Turn.
There is no separate steer key.[^cc-controls][^cc-steer][^cc-queue] The Codex TUI has two keys. `Enter` while Codex works injects the
message into the current Turn over `turn/steer`. `Tab` holds it in a TUI-local queue that is sent as a new Turn when the Turn
completes. `Esc` sends a native interrupt, and the same thread carries on with the interrupted Turn's items and a `<turn_aborted>`
marker in history.[^cx-shortcuts][^cx-composer][^cx-tui-steer][^cx-tui-queue][^cx-abort-marker]

**Wire mechanisms.** On Claude Code's `-p --input-format stream-json` stream, every user message written to stdin enters the CLI's own
command queue, whether or not a Turn is running. By default the running Turn picks it up between tool rounds. When no tool round is
left, it runs as the next Turn. The SDK reference documents this pickup (`user_message_uuids`, `queued_turn_count`). The CLI reference
does not, and the `priority` field that tunes it (`now` / `next` / `later`) is SDK-internal.[^cc-sdk-uuids][^cc-sdk-dts-user][^cc-bin-queue]
Claude Code has three ways to stop a Turn:

- A `control_request` `interrupt`, which keeps the process alive and returns a receipt of queued messages. It is SDK-internal: the docs
  acknowledge raw control-protocol clients only for its `cancel_queued` flag.[^cc-sdk-interrupt][^cc-sdk-dts-interrupt]
- SIGINT, which the headless docs name as the way "to end the turn".
- SIGTERM, which "leaves the turn that was in progress unfinished and records no result for it". On resume, "your next prompt drives the
  conversation".[^cc-sigterm]

Codex app-server has stable, documented `turn/interrupt` and `turn/steer`. A `turn/start` sent while a Turn is active is folded into
that Turn as a steer, not queued; this is source-observed and undocumented. The server-side `thread/queue/*` is
experimental.[^cx-steer-doc][^cx-interrupt-doc][^cx-start-or-steer][^cx-queue-exp]

**T3 Code.**

- **Claude Code: stop.** T3 Code never calls the SDK's `interrupt()`. Stop closes the whole query ("interrupt() can acknowledge while
  resumed background tasks keep the CLI alive"). The next message restarts the SDK with `resume` set to the same Claude session
  id.[^t3-claude-stop][^t3-claude-resume]
- **Claude Code: mid-Turn send.** A send during a Turn is pushed into the live streaming-input prompt, and T3 Code calls that a
  steer.[^t3-claude-steer]
- **Codex: stop.** Stop is a native `turn/interrupt`, and the same thread takes the next `turn/start`.[^t3-codex-interrupt]
- **Codex: mid-Turn send.** A send during a Turn is a plain `turn/start`, which app-server folds into the active Turn. T3 Code never calls
  `turn/steer`.[^t3-codex-followup]
- **Web client queue.** The composer queues by default (`followUpBehavior: "queue"`), and Mod+Enter does the opposite for one message.
  That queue is client emulation. It sends each message after the next completed tool call, or when the Turn ends, through the same
  send path. It holds while an approval or question is open, and Stop moves the queue back into the composer.[^t3-setting][^t3-queue-due][^t3-sender][^t3-stop-drain]

**Secant today.**

- **Claude Code interrupt** is process-only. `turn.interrupt()` sends SIGTERM to the process tree. The Turn settles `interrupted` and the
  Session `detached`, and the next Turn relaunches with `--resume`.[^sec-claude-interrupt][^sec-claude-resume]
- **Claude Code steer** is `available: false`. The profile's evidence says a further user message "queues as the next Turn", but the SDK
  reference documents pickup between tool calls.[^sec-claude-profile][^cc-sdk-uuids]
- **Codex** interrupt uses `turn/interrupt` and steer uses `turn/steer`, both on the stable surface, and the next Turn goes to the same
  thread through `thread/resume`.[^sec-codex-steer][^sec-codex-interrupt][^sec-codex-resume]
- **After an Interrupt, an Agent step's** Step Attempt ends `cancelled` and the Run rests `halted`.[^sec-exec-cancelled]
- **After an Interrupt, an Interactive agent step's** human Turn leaves the Run `halted` and publishes no Attempt. The human continues the
  same Session only after a resume.[^sec-app-interactive][^sec-glossary]
- **Secant has no client queue.** A send during a live human Turn is refused as `interactiveTurnBusy`.[^sec-app-busy]

**Capabilities on the current transports.** Neither Harness needs a transport change for any of the three capabilities. The table
lists which surface each one would rely on.

| Harness (current transport)                                  | (a) Interrupt, then continue the same Session                                                                                                                                                                                                                                                                                                                          | (b) Native mid-Turn injection                                                                                                                                                                                                                                                                                                                                                                        | (c) Client-side queue sent as the next Turn                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code, direct `claude -p` stream-json                  | **Yes, documented, as today:** SIGTERM, then relaunch with `--resume`. The unfinished Turn records no result, and whether its partial content is in context is Unknown. **Keep-alive** stop: `control_request` `interrupt` is SDK-internal, and SIGINT is documented to end the Turn, but whether the process survives it is Untested. No transport change either way. | **Present on this transport:** a stdin user message written mid-Turn is picked up at the next tool boundary. This is documented only in the SDK reference and TUI docs, and Source-observed in the CLI. It is best-effort: with no tool round left it becomes the next Turn. `priority` is SDK-internal. It needs Adapter work (write during a live Turn, correlate by `uuid`), not a new transport. | **Yes, documented:** send it as the next `user` frame after the Turn's `result`. This is the multi-Turn path Secant already uses. A frame written early is queued natively by the CLI but may be picked up mid-Turn, so a strict "next Turn" queue must wait for `result` or send `priority: "later"` (SDK-internal). |
| Codex, `codex app-server` (stable, `experimentalApi: false`) | **Yes, documented and schema-published:** `turn/interrupt`, then `turn/completed` `interrupted`, and the thread stays loaded. History keeps the partial items plus `<turn_aborted>` (Source-observed). Secant already reattaches with `thread/resume`. Recorded for the interrupt only; no recorded continuation Turn.                                                 | **Yes, documented and schema-published:** `turn/steer` with `expectedTurnId`, taken at the next sampling boundary. Recorded and used by Secant. A steer not yet consumed is dropped on interrupt (Source-observed).                                                                                                                                                                                  | **Yes:** `turn/start` after `turn/completed`. A `turn/start` sent while the Turn is active steers instead of queuing (Source-observed, undocumented). The native server queue `thread/queue/*` is experimental.                                                                                                       |

The whole app-server command is itself documented as experimental.[^cx-app-doc]

## Evidence Vocabulary

- **Documented**: stated in current official Anthropic or OpenAI documentation.
- **Schema-published**: present in the JSON Schema the installed Codex binary generates for the stable surface
  (`codex app-server generate-json-schema`).
- **SDK-internal**: a raw wire control or field the Agent SDK uses and types, which no public CLI reference documents as a host contract.
- **Source-observed**: present in first-party source, a type bundle, or strings compiled into an executable.
- **Recorded**: present in Secant's committed Harness fixtures.
- **Untested**: a runtime behaviour the sources imply but this research did not run. No model session was started.
- **Unknown**: not settled by the allowed sources.

## Method

The research ran only harmless commands:

- `claude --version`, which returned `2.1.283 (Claude Code)`, and `claude --help`.
- `codex --version`, which returned `codex-cli 0.157.1`.
- `codex app-server generate-json-schema --out <dir>`, run with and without `--experimental`.

The Claude Code executable was searched as bytes for compiled strings and never run with a prompt. The Codex source was read at the
installed version's tag. T3 Code was read from a local clone at the commit above. Secant was read at `origin/main`.

## Claude Code

### Native TUI

- **Documented.** `Esc`: "Stop the current response or tool call mid-turn so you can redirect. Claude keeps the work done so far. If
  you have messages queued, Claude Code sends them next." `Ctrl+C` "Interrupts a running operation". Double `Esc` with an empty input
  opens the rewind menu; it does not interrupt.[^cc-controls]
- **Documented.** "Type a correction and press `Enter` without stopping Claude. The message shows as queued in the conversation. If
  Claude is running tool calls, it reads the message as soon as those calls finish, within the same turn, and adjusts before its next
  step."[^cc-steer]
- **Documented.** Queued messages that are still waiting when the Turn ends "go out without another key press, in the order you typed
  them". Queued commands and shell commands are held until the Turn ends. `Ctrl+Enter` (v2.1.275+) sends the queue now. Since
  v2.1.281, work that can move to the background does, "and Claude reads your messages in the same turn". Otherwise the key interrupts
  the Turn and sends the messages next. `Up` takes queued entries back into the input.[^cc-queue]
- **Documented.** Keybinding `chat:queueSubmit` (v2.1.247+) marks a message "to wait its turn: while Claude is working, Claude Code
  queues it and never interrupts the turn".[^cc-keybindings]
- **Source-observed.** The executable carries the history markers `[Request interrupted by user]` and
  `[Request interrupted by user for tool use]`. It also carries a send-now marker: "the turn was ended to deliver the message that
  follows".[^cc-bin-queue]

### Agent SDK and the stream-json wire

- **Documented as an SDK method.** `Query.interrupt()` is "only available in streaming input mode". On CLIs with `interrupt_receipt_v1`
  (v2.1.205+), it resolves to `SDKControlInterruptResponse { still_queued, cancelled? }`. Queued messages survive a plain interrupt and
  run afterwards "unless you cancel them first", and several "can merge into one turn". "A client that drives the CLI's control
  protocol directly, rather than through `interrupt()`, can set `cancel_queued: true` on the `interrupt` control request" (v2.1.219+,
  `interrupt_cancel_queued_v1`). This is the only raw-client statement found for interrupt.[^cc-sdk-interrupt]
- **SDK-internal.** The wire shape is `{ type: "control_request", request_id, request: { subtype: "interrupt", cancel_queued? } }` on
  stdin. The receipt comes back as a `control_response` and "is written before the interrupted turn result". Other SDK-internal pieces:
  `cancel_async_message` drops one queued message by `uuid`, and `perTaskStopAffordance` keeps background tasks alive across an
  interrupt.[^cc-sdk-dts-interrupt] The executable also accepts an `@internal` `reason` field on the request.[^cc-bin-queue] Secant's
  recorded `system/init` frames advertise both `interrupt_receipt_v1` and `interrupt_cancel_queued_v1`.[^fx-claude-caps]
- **Documented as the session continuing.** The SDK's Python example interrupts, drains the interrupted result, and sends the next query
  on the same client. "`interrupt()` sends a stop signal but does not clear the message buffer." An interrupted Turn's `terminal_reason`
  is `aborted_streaming` or `aborted_tools`.[^cc-sdk-python] The result `subtype` depends on state: it is usually
  `error_during_execution`, and sometimes `success`. Truncated assistant messages carry `aborted: true`.[^cc-bin-queue][^cc-sdk-dts-user]
- **Documented through the SDK reference only.** A user message sent while a Turn runs can be picked up by that Turn:
  - "When Claude Code picks up a regular message you sent while a turn was running, it adds that message's `uuid` to the result's list"
    (`user_message_uuids`).
  - "If Claude Code picks up a regular message of yours between tool calls, the turn answers the picked-up message from then on"
    (`user_message_uuid`).
  - `queued_turn_count` counts user sends still queued when a result is produced.

  The CLI reference and headless page describe `--input-format stream-json` only as "realtime streaming input". Its `--max-turns` entry
  says a message still queued when the limit ends a Turn "stays queued and starts a new turn".[^cc-sdk-uuids][^cc-cli-ref]

- **Source-observed.** The SDK writes each yielded message straight to stdin, so all queuing is the CLI's:
  - The CLI enqueues each stdin user message with `priority ?? "next"`, where `now < next < later`.
  - Between tool rounds, the query loop drains entries up to `next` into the running Turn as `queued_command` attachments
    (`absorbed_mid_turn`).
  - A queued `now` entry aborts the running Turn (`abortController.abort(… "interrupt")`).
  - `later` waits for the Turn to end.
  - The `@internal` stdout frame `command_lifecycle` reports each message as `queued`, `started`, `completed`, `cancelled`, `discarded`, or
    `refused`.

  `SDKUserMessage.priority` is in the SDK typings but not in the documented field list. `shouldQuery: false` appends to the transcript
  without starting a Turn.[^cc-bin-queue][^cc-sdk-dts-user][^cc-sdk-user-doc]

- **Documented.** "If you stop a `claude -p` run with SIGTERM … Claude Code exits with code 143. Claude Code leaves the turn that was in
  progress unfinished and records no result for it. To end the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`, before
  you stop the process." On resume, "Claude Code leaves the interrupted turn as it is, and your next prompt drives the conversation",
  unless `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`. SIGTERM also kills running Bash process trees and leaves a pending permission prompt
  unanswered.[^cc-sigterm][^cc-env]
- **Documented (changelog).**[^cc-changelog]
  - 2.1.94 fixed "SDK/print mode not preserving the partial assistant response in conversation history when interrupted mid-stream".
  - 2.1.236: "SIGTERM in print/SDK mode no longer records an interrupted turn or synthetic tool denials before exiting".
  - 2.1.246 fixed MCP tool calls "interrupted by an incoming message in headless/remote sessions". That fix implies preemption by an
    incoming message in headless mode.

- **Recorded.** Secant's `claude-code/interrupt` fixture (2.1.273) stops mid-text with no `result` frame and exit code 143.[^fx-claude-interrupt]

## Codex

### Native TUI

- **Documented.** "Press Tab while Codex is working to queue a follow-up prompt, slash command, or shell command for the next turn.
  Press Enter while Codex is working to inject new instructions into the current turn." The same page documents `Ctrl+C` only as closing
  the session, and does not describe `Esc` as an interrupt.[^cx-shortcuts]
- **Source-observed.** `Esc` is the default `interrupt_turn` binding, and it fires only while a task runs and no popup is open.
  `Ctrl+C` also sends `Op::Interrupt` when work is active, and a second press quits.[^cx-keymap] After `TurnStatus::Interrupted`, the TUI
  prints "Conversation interrupted - tell the model what to do differently" and keeps the thread.[^cx-tui-interrupted]
- **Source-observed.** Composer: "`Enter` submits immediately. `Tab` requests queuing while a task is running."[^cx-composer]
  - `Enter` during a Turn becomes a pending steer. The app sends it as `turn/steer` with the active `expectedTurnId`. On "no active turn to
    steer" it falls back to `turn/start`, and on a Turn-id mismatch it retries once.[^cx-tui-steer]
  - `Tab` messages wait in a TUI-local queue that `maybe_send_next_queued_input` sends when the Turn completes.[^cx-tui-queue]
  - The old `steer` feature flag is `Stage::Removed`: "behavior is always steer-enabled".[^cx-feature]
- **Source-observed.** On interrupt, the TUI restores its queued messages and any unacknowledged steers into the composer rather than
  auto-submitting them: "The server has already discarded pending input by the time the interrupted turn reaches the UI". If `Esc` is
  pressed while steers are still pending, the TUI interrupts and resubmits them as one fresh Turn.[^cx-tui-restore]

### Core and app-server

- **Source-observed.** `steer_input` rejects a steer with no active Turn, a mismatched id, or a Review or Compact Turn. Otherwise it
  appends the input to the Turn's `pending_input`. Pending input "is drained into history before building the next model request", so a
  steer lands at the next sampling boundary and forces one more model request. It does not preempt an in-flight stream. If the Turn
  finishes first, the leftover input is recorded into history for later. On interrupt, `clear_pending` drops it.[^cx-steer-core][^cx-turn-loop][^cx-clear-pending]
- **Source-observed.** On an interrupt, core records a `<turn_aborted>` user fragment into history before emitting `TurnAborted`. The
  fragment reads "The user interrupted the previous turn on purpose … If any tools/commands were aborted, they may have partially
  executed". A running tool's output becomes "aborted by user". Core tests assert that the next request carries both. The fragment is
  controlled by config `[agents] interrupt_message`, default `true`.[^cx-abort-marker]
- **Documented and schema-published.** "Use turn/steer to append more user input to the active in-flight turn. Include expectedTurnId;
  it must match the active turn id. The request fails if there is no active turn on the thread. turn/steer doesn't emit a new
  turn/started notification." It accepts no Turn-level overrides. `turn/steer` and `turn/interrupt` carry no `#[experimental]` marker,
  and both appear in the stable schema. `turn/steer` is present from `rust-v0.99.0` and absent at `rust-v0.98.0`.[^cx-steer-doc][^cx-common]
- **Documented.** `turn/interrupt`: "On success, the turn finishes with status: "interrupted"". **Source-observed:** the `{}` response is
  sent first, then `turn/completed` `interrupted`, and outstanding server requests are resolved.[^cx-interrupt-doc][^cx-interrupt-order]
- **Source-observed, undocumented.** `turn/start` calls `start_or_steer_turn`. When a regular Turn is active, core steers the input into
  that Turn and the response returns the active Turn's id: "Core steered an active turn … No new turn was created". Only with no active
  Turn does it start a new one.[^cx-start-or-steer]
- **Source-observed.** The server-side queue (`thread/queue/add|list|update|delete|reorder|start`, `thread/queue/changed`) is
  `#[experimental]` and absent from the stable schema. It auto-dispatches when the thread goes idle, but not after an interrupt.[^cx-queue-exp]
- **Recorded.** The `codex/steer` fixture (0.155.0, `experimentalApi: false`) sends `turn/steer` with `expectedTurnId` and gets
  `{ turnId }` back. The Turn then completes with the steered answer. The `codex/interrupt` fixture shows `turn/interrupt`, then
  `turn/completed` with `status: "interrupted"`. No recorded fixture sends a Turn after an interrupt.[^fx-codex]

## T3 Code

### Interrupt

- **Claude Code: T3 Code choice.** `interruptTurn` calls `stopSessionInternal`. That closes the SDK query ("The SDK closes stdin, then
  escalates from SIGTERM to SIGKILL"). It then:
  - marks subagent tasks `stopped`;
  - cancels pending approvals and questions;
  - flushes any partly streamed assistant text as a completed message;
  - emits `turn.completed` with state `interrupted`, then `session.exited`.

  A unit test asserts one `close()` and no session left: "Closing the session is the hard stop because SDK interrupt can leave resumed
  background work alive."[^t3-claude-stop]

- **Claude Code: native resume, triggered by T3 Code.** The next message finds the session stopped and starts a new one. The provider
  service reuses the persisted resume cursor, so the SDK is started with `resume` set to the same Claude session id. The cursor also
  stores `resumeSessionAt`, but that is not passed to the SDK. No test covers stop, then send, then resume end to end.[^t3-claude-resume]
- **Codex: native.** `interruptTurn` first settles parked approvals and inputs ("cancelling after the RPC would deadlock Stop"). It then
  sends best-effort `turn/interrupt` to live collab children and `turn/interrupt { threadId, turnId }` to the main thread. It does not
  wait for `turn/completed`. The process stays up, and the next send is `turn/start` on the same thread.[^t3-codex-interrupt]

### Mid-Turn sends

- **Claude Code: native streaming input.** The adapter feeds one unbounded queue into the SDK's prompt `AsyncIterable`, and `sendTurn`
  offers every message to it. "A sendTurn while a real turn is running is a steer: the message is queued into the live SDK agent loop and
  the work continues as the same turn". Outgoing messages carry no `priority` or `shouldQuery`. T3 Code does not use `cancel_queued` or
  receipts.[^t3-claude-steer]
- **Codex: native `turn/start`, not `turn/steer`.** T3 Code initializes with `experimentalApi: true` but never sends `turn/steer`. Its
  comment reads: "Codex accepts follow-ups while the current turn is still running. The response contains the queued turn id, but
  turn/interrupt only accepts the id that is active now". The Codex source shows that such a `turn/start` is steered into the active
  Turn.[^t3-codex-followup][^cx-start-or-steer]
- **No per-Harness capability flag.** T3 Code's `ProviderAdapterCapabilities` has no interrupt or steer field.[^t3-caps]

### Web client

- **Setting.** `followUpBehavior: "queue" | "steer"`, default `"queue"`: "Queue follow-ups while the agent runs or steer the current
  run. … Press ⌘/Ctrl[+ Shift] + Enter to do the opposite for one message." Tab plays no part. The send button reads "Queue message"
  while a Turn runs.[^t3-setting][^t3-keys]
- **Steer is an immediate send.** It goes down the ordinary `thread.turn.start` path, and the server adapter decides what a mid-Turn send
  means.[^t3-keys]
- **The queue is client emulation.** It is an in-memory store. "A queued message is due mid-turn once a tool call finished after it was
  queued, and as soon as the turn is over otherwise". One message leaves per tool boundary. `QueuedMessageSender` holds the queue while
  an approval or question is pending. When a message is due, it sends through the same turn-start command, so a queued message usually
  arrives mid-Turn through the Harness's native path. "Send now" (`mod+shift+enter`) skips the wait.[^t3-queue-due][^t3-sender]
- **Stop returns the queue.** "Stop also cancels the queue: the messages return to the composer instead of starting a new turn the moment
  the interrupted one settles."[^t3-stop-drain]

## Secant Today

### Interrupt

- **Control path.** `interrupt-turn` aborts the live Run's one `AbortController` with `INTERRUPT_TURN_ABORT`. The Agent executor turns
  that abort into `turn.interrupt()` at the Harness Seam.[^sec-run-control][^sec-agent-abort]
- **Claude Code.** The Adapter claims the process and SIGTERMs its tree through the process Module. It then drains to exit and settles
  the Turn `interrupted` with mode `process-only`, and the Session `detached` at its coordinate. If the process has to be force-killed,
  or its stop is unconfirmed, the Turn ends `lost` with `interruption-unknown`. On Windows an interrupt of live work is always reported
  lost. The next launch after a detach uses `--resume <id>`. No control request is ever written.[^sec-claude-interrupt][^sec-claude-resume]
- **Codex.** The Adapter sends `turn/interrupt { threadId, turnId }` and waits for the matching `turn/completed` `interrupted`
  (`active-turn`). It then marks the Session detached, so the next Turn first issues `thread/resume` on the same thread.[^sec-codex-interrupt][^sec-codex-resume]
- **Agent step.** An `interrupted` Turn maps to a `cancelled` Attempt, which is published with `advanceState: "halted"` and never
  retried. A `lost` Turn maps to `indeterminate`, and the Run also rests `halted`. `resume-run` re-attempts the Step. Because the Session
  record is `detached`, the retry sends the Step's prompt again into the same native Session.[^sec-exec-cancelled][^sec-agent-recovery]
- **Interactive agent step.**
  - Each human Turn runs with `detachAfterTurn`, which records the Session `detached` after each Turn.[^sec-agent-interactive] (Corrected
    2026-09-29: the Harness is not closed after each Turn. The wiring keeps one prepared Harness, and one Claude Code process, across the
    Step's Turns; only Codex reissues `thread/resume` before each human Turn because of the `detached` record.)
  - An interrupted or lost human Turn rests the Run `halted`, not `blocked`, and publishes no Attempt. An interrupted Entry Turn does the
    same.[^sec-app-interactive][^sec-exec-entry]
  - The glossary says that "after a halt the human continues the same Harness Session". That takes a resume back to `blocked` before the
    next `send-interactive-turn`.[^sec-glossary]

- **Keys.** The TUI's Interrupt takes two presses of `Esc`, and the input's hint line carries it during a live human Turn.[^sec-tui]

### Steer and queuing

- **Offer.** `steer-turn` is offered from the prepared profile's steer evidence. Codex declares it `available`: "Codex accepts native
  same-Turn guidance addressed to the exact active thread and Turn". The Adapter sends
  `turn/steer { threadId, expectedTurnId, input }` and checks that the returned `turnId` matches.[^sec-codex-steer][^sec-run-control]
- **Claude Code declines steer.** Claude Code declares `available: false` with this evidence: "Claude Code's stream-json print mode has no
  same-Turn guidance frame: a further user message queues as the next Turn, so steer is rejected unsupported and never emulated." Its
  `steer()` returns `unsupported`, and a profile that claimed steer would make it throw.[^sec-claude-profile] Measured against this
  research, the "no same-Turn guidance frame" half is accurate for the documented CLI contract. The "queues as the next Turn" half is
  not: the SDK reference documents that a regular message sent mid-Turn is picked up between tool calls.[^cc-sdk-uuids]
- **No queue.** Secant has no queue at either layer. `send-interactive-turn` during a live Turn is refused with `interactiveTurnBusy`:
  "One Turn at a time". An Agent Step Attempt runs exactly one Turn.[^sec-app-busy][^sec-agent-turn]

## What Each Capability Would Need

- **Claude Code (a), without a halt.** The Session already survives an interrupt. What stops the human typing on is the Application's
  mapping of an interrupted Turn to `halted`, not the transport. A keep-alive stop would need one of these:
  - a `control_request` `interrupt` (SDK-internal; with a receipt and `cancel_queued`);
  - SIGINT, if the process survives it in `-p` mode (Untested).

  The documented SIGTERM path loses the unfinished Turn's result. Whether the partial assistant output stays in the resumed context is
  Unknown.

- **Claude Code (b).** The Adapter would have to write a `user` frame with a `uuid` while its Turn is live, then settle the outcome:
  - picked up: the `uuid` appears in `result.user_message_uuids`;
  - not picked up: a second `result` follows, signalled by `queued_turn_count`.

  Delivery within the same Turn is not guaranteed, so it is weaker than the glossary's Steer ("It is not a new Turn"). `command_lifecycle`
  would report the outcome exactly, but it is `@internal`.

- **Claude Code (c).** This needs no Harness change. It is an Application decision to hold the text and call `startTurn` after the Turn
  settles, which is emulation by the reading rule.
- **Codex (a)–(c).** All three are on the stable surface today. A client queue must wait for `turn/completed` before `turn/start`, or the
  start is folded into the running Turn. The native `thread/queue/*` would need `experimentalApi: true`.

## Unknowns

- Claude Code: whether SIGTERM in `-p` mode keeps the partial assistant text of the unfinished Turn in the transcript that `--resume`
  loads. The docs say only that the Turn is "unfinished" with no result, and the 2.1.236 changelog says no interrupted-turn marker is
  recorded. Untested.
- Claude Code: whether SIGINT to a `-p --input-format stream-json` process ends only the Turn and keeps reading stdin, or also exits.
  Untested.
- Claude Code: whether a raw `control_request` `interrupt` is honoured without the SDK's `initialize` request first. Untested.
- Claude Code: the minimum version for headless mid-Turn pickup and for `priority`. Neither changelog names one.
- Codex: whether the model-visible context after `turn/interrupt` and a later `turn/start` over app-server matches the core tests. It is
  covered at the core layer only, and not recorded in Secant.
- Codex: whether a `turn/start` that is steered into an active Turn emits any notification of its own.
- T3 Code: no test covers the Claude Code stop, send, and resume path end to end.

## Primary Sources

[^cc-controls]: Anthropic, [Interactive mode: general controls](https://code.claude.com/docs/en/interactive-mode#general-controls), rows `Esc`, `Ctrl+C`, and double `Esc`.

[^cc-steer]: Anthropic, [How Claude Code works: interrupt and steer](https://code.claude.com/docs/en/how-claude-code-works#interrupt-and-steer).

[^cc-queue]: Anthropic, [Interactive mode: queue messages while Claude works](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works), [when Claude Code sends what you queued](https://code.claude.com/docs/en/interactive-mode#when-claude-code-sends-what-you-queued) (including `Ctrl+Enter`, v2.1.275 and v2.1.281), and [take back what you queued](https://code.claude.com/docs/en/interactive-mode#take-back-what-you-queued).

[^cc-keybindings]: Anthropic, [Keybindings: chat actions](https://code.claude.com/docs/en/keybindings#chat-actions) (`chat:queueSubmit`, `chat:sendNow`, `chat:cancel`) and [app actions](https://code.claude.com/docs/en/keybindings#app-actions) (`app:interrupt`).

[^cc-sigterm]: Anthropic, [Run Claude Code programmatically: stop a run with SIGTERM](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm).

[^cc-env]: Anthropic, [Environment variables](https://code.claude.com/docs/en/env-vars), rows `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS`, and `CLAUDE_CODE_RESUME_PROMPT`.

[^cc-cli-ref]: Anthropic, [CLI reference: CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags), rows `--input-format`, `--max-turns`, and `--replay-user-messages`. The page has no `control_request` entry and does not describe mid-Turn stdin input.

[^cc-sdk-interrupt]: Anthropic, [Agent SDK TypeScript reference: `Query` object](https://code.claude.com/docs/en/agent-sdk/typescript#query-object) (`interrupt()`, "only available in streaming input mode") and [`SDKControlInterruptResponse`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolinterruptresponse) (v2.1.205 receipts, the `cancel_queued` raw-client paragraph, v2.1.219), plus the [`SDKSystemMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdksystemmessage) capability table.

[^cc-sdk-uuids]: Anthropic, [Agent SDK TypeScript reference: `user_message_uuid`](https://code.claude.com/docs/en/agent-sdk/typescript#user_message_uuid), [`user_message_uuids`](https://code.claude.com/docs/en/agent-sdk/typescript#user_message_uuids) ("When Claude Code picks up a regular message you sent while a turn was running…"), and [`queued_turn_count`](https://code.claude.com/docs/en/agent-sdk/typescript#queued_turn_count).

[^cc-sdk-user-doc]: Anthropic, [Agent SDK TypeScript reference: `SDKUserMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage), which lists `isSynthetic`, `shouldQuery`, and `uuid` but not `priority`.

[^cc-sdk-python]: Anthropic, [Agent SDK Python reference: example using interrupts](https://code.claude.com/docs/en/agent-sdk/python#example-using-interrupts) and [`ResultMessage`](https://code.claude.com/docs/en/agent-sdk/python#resultmessage) (`terminal_reason` `aborted_streaming` / `aborted_tools`); [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode#benefits) ("Queued messages … with ability to interrupt").

[^cc-sdk-dts-interrupt]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.283/sdk.d.ts`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.283/sdk.d.ts): `Query.interrupt()` lines 2849-2857, `SDKControlInterruptRequest` (`cancel_queued`) lines 4544-4554, `SDKControlInterruptResponse` (`still_queued`, `cancelled`, "written before the interrupted turn result") lines 4556-4567, `SDKControlRequest` lines 4920-4931, `cancel_async_message` lines 3865-3870, `perTaskStopAffordance` lines 1788-1804; and [`sdk.mjs`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.283/sdk.mjs) (`interrupt` sends `{subtype:"interrupt"}` in a `control_request` envelope; `streamInput` writes each message straight to the transport).

[^cc-sdk-dts-user]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.283/sdk.d.ts`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.283/sdk.d.ts): `SDKUserMessage` lines 6149-6235 (`priority?: 'now' | 'next' | 'later'` line 6161, `shouldQuery` lines 6189-6192), `SDKAssistantMessage.aborted` lines 3633-3637, `queued_turn_count` lines 5633-5635, `user_message_uuids` lines 5644-5648, and `SDKSystemMessage.capabilities` lines 5903-5905.

[^cc-bin-queue]: Source-observed: compiled strings in the installed Claude Code 2.1.283 native executable, searched as bytes and never run with a prompt. They include the queue entry default `priority:tr.priority??"next"` and order `{now:0,next:1,later:2}`, the between-tool-round drain consuming entries with `reason:"absorbed_mid_turn"`, the drain subscriber aborting the running Turn when a `now` command is queued, the `@internal` `command_lifecycle` frame, the interrupt request schema with `@internal` `reason` and `cancel_queued`, the markers `[Request interrupted by user]` and `[Request interrupted by user for tool use]`, the send-now marker, and the `terminal_reason` rule that selects the result subtype.

[^cc-changelog]: Anthropic, [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), entries under 2.1.94, 2.1.236, and 2.1.246.

[^cx-app-doc]: OpenAI, [Codex App Server](https://learn.chatgpt.com/docs/app-server): "The app-server command and WebSocket transport are experimental and aren't supported for production workloads."

[^cx-shortcuts]: OpenAI, [Codex developer commands: interactive shortcuts](https://learn.chatgpt.com/docs/developer-commands#interactive-shortcuts).

[^cx-steer-doc]: OpenAI, [Codex App Server: steer an active turn](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn).

[^cx-interrupt-doc]: OpenAI, [Codex App Server: interrupt a turn](https://learn.chatgpt.com/docs/app-server#interrupt-a-turn).

[^cx-keymap]: OpenAI Codex source, [`tui/src/keymap.rs` line 1664](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/keymap.rs#L1664) (`interrupt_turn` = `Esc`) and [line 1681](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/keymap.rs#L1681) (`queue` = `Tab`); [`tui/src/bottom_pane/mod.rs` lines 1677-1692](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/bottom_pane/mod.rs#L1677-L1692); [`tui/src/chatwidget/interaction.rs` lines 551-619](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/interaction.rs#L551-L619) (Ctrl+C).

[^cx-tui-interrupted]: OpenAI Codex source, [`tui/src/chatwidget/protocol.rs` line 481](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/protocol.rs#L481) and [`tui/src/chatwidget/turn_runtime.rs` line 565](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/turn_runtime.rs#L565).

[^cx-composer]: OpenAI Codex source, [`tui/src/bottom_pane/chat_composer.rs` lines 111-112](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/bottom_pane/chat_composer.rs#L111-L112) and [lines 3515-3522](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/bottom_pane/chat_composer.rs#L3515-L3522).

[^cx-tui-steer]: OpenAI Codex source, [`tui/src/chatwidget/input_flow.rs` lines 49-83](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/input_flow.rs#L49-L83), [`tui/src/chatwidget/input_submission.rs` line 227](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/input_submission.rs#L227), and [`tui/src/app/thread_routing.rs` lines 752-790](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/app/thread_routing.rs#L752-L790) (`turn/steer` with `expectedTurnId`, fallback to `turn/start`).

[^cx-tui-queue]: OpenAI Codex source, [`tui/src/chatwidget/input_flow.rs` lines 85-95 and 235](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/input_flow.rs#L85-L95) and [`tui/src/chatwidget/turn_runtime.rs` line 205](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/turn_runtime.rs#L205) (`maybe_send_next_queued_input` on Turn completion).

[^cx-feature]: OpenAI Codex source, [`features/src/lib.rs` lines 412-414](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/features/src/lib.rs#L412-L414) and [lines 1600-1603](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/features/src/lib.rs#L1600-L1603).

[^cx-tui-restore]: OpenAI Codex source, [`tui/src/chatwidget/input_restore.rs` lines 308-383](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/input_restore.rs#L308-L383) and [`tui/src/chatwidget/interaction.rs` lines 197-210](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tui/src/chatwidget/interaction.rs#L197-L210).

[^cx-steer-core]: OpenAI Codex source, [`core/src/session/turn_input.rs` lines 624-704](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn_input.rs#L624-L704) (`steer_input`) and [`core/src/tasks/mod.rs` lines 662-686](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tasks/mod.rs#L662-L686) (leftover input recorded on Turn finish).

[^cx-turn-loop]: OpenAI Codex source, [`core/src/session/turn.rs` lines 416-443 and 548-563](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn.rs#L416-L443) (drain before the next request; `needs_follow_up` includes pending input), and [`core/tests/suite/pending_input.rs` line 1116](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/tests/suite/pending_input.rs#L1116) (`user_input_does_not_preempt_after_reasoning_item`).

[^cx-clear-pending]: OpenAI Codex source, [`core/src/session/input_queue.rs` lines 206-210](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/input_queue.rs#L206-L210), called from the abort paths at [`core/src/tasks/mod.rs` line 559](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tasks/mod.rs#L559).

[^cx-abort-marker]: OpenAI Codex source, [`core/src/tasks/mod.rs` lines 911-1003](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tasks/mod.rs#L911-L1003) (`handle_task_abort`), [`core/src/context/turn_aborted.rs` lines 10-39](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/context/turn_aborted.rs#L10-L39), [`core/src/tools/parallel.rs` lines 329-331](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tools/parallel.rs#L329-L331), [`core/src/config/mod.rs` lines 3867-3871](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/config/mod.rs#L3867-L3871), and tests [`core/tests/suite/abort_tasks.rs` lines 212 and 302-368](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/tests/suite/abort_tasks.rs#L302-L368).

[^cx-common]: OpenAI Codex source, [`app-server-protocol/src/protocol/common.rs` lines 1044-1055](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/common.rs#L1044-L1055) (`turn/steer` and `turn/interrupt` unmarked, beside `#[experimental("thread/realtime/start")]`); [`v2/turn.rs` lines 293-315](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L293-L315) (`TurnSteerParams`); first present at [`rust-v0.99.0` `common.rs` lines 263-266](https://github.com/openai/codex/blob/ec9f76ce4f854c7d4f3c78c9b1bacbe128df286e/codex-rs/app-server-protocol/src/protocol/common.rs#L263-L266), absent at `rust-v0.98.0` (`82464689ce0ba8a3b2065e73a8aa0cfdf2ad0625`). Locally observed: both methods and `v2/TurnSteerParams.json` are in the stable generated schema for codex-cli 0.157.1.

[^cx-interrupt-order]: OpenAI Codex source, [`app-server/src/request_processors/turn_processor.rs` lines 1595-1640](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/request_processors/turn_processor.rs#L1595-L1640) ("Turn interrupts respond upon TurnAborted") and [`app-server/src/bespoke_event_handling.rs` lines 1203-1218 and 1531-1554](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/bespoke_event_handling.rs#L1203-L1218).

[^cx-start-or-steer]: OpenAI Codex source, [`app-server/src/request_processors/turn_processor.rs` lines 650-676](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/request_processors/turn_processor.rs#L650-L676) (`start_or_steer_turn`, `Steered { turn_id } => (turn_id, false)`), [`core/src/session/turn_input.rs` lines 276-315](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn_input.rs#L276-L315), and [`protocol/src/turn_input.rs` lines 187-196](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/protocol/src/turn_input.rs#L187-L196).

[^cx-queue-exp]: OpenAI Codex source, [`app-server-protocol/src/protocol/common.rs` lines 623-657](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/common.rs#L623-L657) (`#[experimental]` `thread/queue/*`) and [`ext/queue/src/service.rs` lines 549-553](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/ext/queue/src/service.rs#L549-L553) (no auto-dispatch after `ThreadIdleCause::Interrupted`). Locally observed: absent from the stable generated schema and present in the `--experimental` one.

[^t3-claude-stop]: T3 Code, [`ClaudeAdapter.ts` `interruptTurn` lines 5276-5284](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5276-L5284), [`stopSessionInternal` lines 4250-4357](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4250-L4357), [`completeTurn` lines 2766-2835](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2766-L2835), and [`ClaudeAdapter.test.ts` lines 3233-3240](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.test.ts#L3233-L3240).

[^t3-claude-resume]: T3 Code, [`ProviderCommandReactor.ts` lines 774-844](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L774-L844), [`ProviderService.ts` lines 1466-1518](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ProviderService.ts#L1466-L1518) and [lines 1761-1766](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ProviderService.ts#L1761-L1766), and [`ClaudeAdapter.ts` lines 4406-4410](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4406-L4410) (`resume: existingResumeSessionId`) and [lines 5005-5013](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5005-L5013).

[^t3-claude-steer]: T3 Code, [`ClaudeAdapter.ts` lines 4416-4423](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4416-L4423) (prompt queue as `AsyncIterable`), [lines 5141-5150](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5141-L5150) (steer comment), [lines 5257-5265](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5257-L5265) (`Queue.offer`), and [lines 1568-1580](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1568-L1580) (outgoing `SDKUserMessage` fields).

[^t3-codex-interrupt]: T3 Code, [`CodexSessionRuntime.ts` lines 2614-2656](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L2614-L2656) (`interruptTurn`), [lines 2069-2086](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L2069-L2086) (`turn/completed`), and [lines 2550-2586](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L2550-L2586) (next `turn/start` on the same thread).

[^t3-codex-followup]: T3 Code, [`CodexSessionRuntime.ts` lines 2596-2604](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L2596-L2604) and [`CodexProvider.ts` lines 343-354](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexProvider.ts#L343-L354) (`experimentalApi: true`). `turn/steer` appears only in the generated [`meta.gen.ts`](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/effect-codex-app-server/src/_generated/meta.gen.ts#L70).

[^t3-caps]: T3 Code, [`ProviderAdapter.ts` lines 45-55](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Services/ProviderAdapter.ts#L45-L55).

[^t3-setting]: T3 Code, [`packages/contracts/src/settings.ts` lines 453-455](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/settings.ts#L453-L455) and [`SettingsPanels.tsx` lines 2733-2772](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/settings/SettingsPanels.tsx#L2733-L2772).

[^t3-keys]: T3 Code, [`composer-logic.ts` lines 27-45](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/composer-logic.ts#L27-L45), [`ChatView.tsx` lines 7658-7701](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.tsx#L7658-L7701), [`ComposerPrimaryActions.tsx` lines 231-245](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/ComposerPrimaryActions.tsx#L231-L245), and [`decider.ts` lines 1684-1685](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/decider.ts#L1684-L1685) ("The normal turn path steers a running agent or resumes an idle session").

[^t3-queue-due]: T3 Code, [`queuedMessageStore.ts` lines 124-155](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/queuedMessageStore.ts#L124-L155) and [lines 220-262](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/queuedMessageStore.ts#L220-L262) (`isQueuedMessageDue`).

[^t3-sender]: T3 Code, [`QueuedMessageSender.tsx` lines 55-98](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/QueuedMessageSender.tsx#L55-L98), [`sendQueuedMessage.ts` lines 179-198](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/sendQueuedMessage.ts#L179-L198), and [`packages/contracts/src/keybindings.ts` lines 37-40](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/keybindings.ts#L37-L40) (`thread.steerQueuedMessage`).

[^t3-stop-drain]: T3 Code, [`ChatView.tsx` lines 3958-3978](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.tsx#L3958-L3978) and [lines 8613-8615](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.tsx#L8613-L8615).

[^sec-run-control]: Secant, [Live Run control: Turn interrupt and steer](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/docs/agents/run-control.md#turn-interrupt-and-steer).

[^sec-glossary]: Secant, [Run lifecycle glossary](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/docs/glossary/secant-run-lifecycle.md), entries Entry Turn, Steer, and Interrupt.

[^sec-tui]: Secant, [TUI Workbench: modal stack and composes](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/docs/agents/tui-workbench.md#modal-stack-and-composes).

[^sec-claude-interrupt]: Secant, [`src/harness/claude-code.ts` lines 539-583](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/claude-code.ts#L539-L583) (SIGTERM through the process Module; `interrupted` or `lost`), [lines 967-977](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/claude-code.ts#L967-L977) (`ClaudeCodeTurn.interrupt`), and [lines 1159-1173](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/claude-code.ts#L1159-L1173) (`process-only`, Session `detached`).

[^sec-claude-resume]: Secant, [`src/harness/claude-code.ts` lines 739-750](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/claude-code.ts#L739-L750) (relaunch with `--resume`) and [line 708](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/claude-code.ts#L708) (each Turn written to stdin).

[^sec-claude-profile]: Secant, [`src/harness/claude-code.ts` lines 960-965](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/claude-code.ts#L960-L965) (`steer`), [lines 1445-1457](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/claude-code.ts#L1445-L1457) (`steerReceipt`), and [lines 1542-1563](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/claude-code.ts#L1542-L1563) (profile `interruption` and `steer` evidence).

[^sec-codex-steer]: Secant, [`src/harness/codex.ts` lines 894-955](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/codex.ts#L894-L955) (`turn/steer`) and [lines 1817-1821](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/codex.ts#L1817-L1821) (profile `steer`); [`src/harness/codex/qualification.ts` line 69](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/codex/qualification.ts#L69) (`experimentalApi: false`).

[^sec-codex-interrupt]: Secant, [`src/harness/codex.ts` lines 957-1050](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/codex.ts#L957-L1050) (`turn/interrupt`) and [lines 1562-1576](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/codex.ts#L1562-L1576) (matching `interrupted` terminal, `markDetached`).

[^sec-codex-resume]: Secant, [`src/harness/codex.ts` lines 680-705](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/harness/codex.ts#L680-L705) (a detached Session issues `thread/resume` on the same thread before the next Turn).

[^sec-agent-abort]: Secant, [`src/run/execution/agent.ts` lines 441-463](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/run/execution/agent.ts#L441-L463) (`bindSteer`; the abort listener calls `turn.interrupt()`) and [`src/application/application.ts` lines 1943-1973](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/application/application.ts#L1943-L1973) (`interruptTurnAndSettle`).

[^sec-agent-recovery]: Secant, [`src/run/execution/agent.ts` lines 322-343](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/run/execution/agent.ts#L322-L343) (`sessionRecovery`: `detached` resumes the same Session).

[^sec-agent-turn]: Secant, [`src/run/execution/agent.ts` lines 206-207](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/run/execution/agent.ts#L206-L207) ("One Turn per Agent Step Attempt in M3").

[^sec-agent-interactive]: Secant, [`src/run/execution/agent.ts` lines 511-535](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/run/execution/agent.ts#L511-L535) (`driveInteractiveTurn`, `detachAfterTurn`).

[^sec-exec-cancelled]: Secant, [`src/run/execution/execution.ts` lines 640-673](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/run/execution/execution.ts#L640-L673) (`indeterminate` and `cancelled` Attempts published with `advanceState: "halted"`).

[^sec-exec-entry]: Secant, [`src/run/execution/execution.ts` lines 248-272 and 610-617](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/run/execution/execution.ts#L248-L272) (an interrupted or lost Entry Turn rests the Run `halted` without an Attempt).

[^sec-app-interactive]: Secant, [`src/application/application.ts` lines 2328-2334](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/application/application.ts#L2328-L2334) (an interrupted or lost human Turn rests the Run `halted`).

[^sec-app-busy]: Secant, [`src/application/application.ts` lines 2261-2268](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/src/application/application.ts#L2261-L2268) ("One Turn at a time: a live Turn refuses a new one as a value").

[^fx-claude-interrupt]: Secant fixture, [`claude-code/interrupt`](https://github.com/secantdev/secant/tree/68a90184a50bcf78c3877362e7da49c6b9dba171/tests/harness/fixtures/claude-code/interrupt) (2.1.273; `case.json` `exitCode: 143`; `turn-1.stdout` ends in text deltas with no `result`).

[^fx-claude-caps]: Secant fixtures, [`claude-code/plain/turn-1.stdout`](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/tests/harness/fixtures/claude-code/plain/turn-1.stdout) (2.1.273) and [`claude-code/matt-front/grill-1.stdout`](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/tests/harness/fixtures/claude-code/matt-front/grill-1.stdout) (2.1.281): `system/init.capabilities` includes `interrupt_receipt_v1` and `interrupt_cancel_queued_v1`.

[^fx-codex]: Secant fixtures, [`codex/steer/case.json`](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/tests/harness/fixtures/codex/steer/case.json) and [`codex/interrupt/case.json`](https://github.com/secantdev/secant/blob/68a90184a50bcf78c3877362e7da49c6b9dba171/tests/harness/fixtures/codex/interrupt/case.json) (codex-cli 0.155.0, recorded 2026-09-18, `experimentalApi: false`).
