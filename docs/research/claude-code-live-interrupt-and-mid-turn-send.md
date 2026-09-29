# Claude Code Live Interrupt and Mid-Turn Send

Research date: 2026-09-29

Harness version examined: Claude Code **2.1.284** (installed native executable, Linux
x64; `claude --version` returned `2.1.284 (Claude Code)`).

Ticket: [#255](https://github.com/secantdev/secant/issues/255). This note settles
the Claude Code items left **Untested** or **Unknown** in
[Harness Interrupt and Queued Messages](harness-interrupt-and-queued-messages.md)
by running small live model sessions against the installed CLI.

## Answer

**SIGTERM loses streamed text but keeps a killed tool call.** A process-group SIGTERM
exits with code 143 and writes no `result`. Mid-text, the transcript keeps only the
user prompt: no partial text, no thinking, no interrupted marker. Mid-tool, the
transcript keeps the `tool_use` and a real `tool_result` of `Exit code 137` plus
the tool's partial stdout. On `--resume`, Claude Code first appends a synthetic
assistant message, `No response requested.` (`model: "<synthetic>"`). The resumed
model saw the killed tool call and its output. After a mid-text SIGTERM it saw
only its own prompt and the synthetic reply. Twice it said it had "declined" the
task.

**SIGINT ends the Turn, then the process exits.** SIGINT gave one `result`
(`subtype: "error_during_execution"`, `is_error: true`, `terminal_reason`
`aborted_streaming` or `aborted_tools`). The process then exited with code 0 about
1 s later, with stdin still open. This held for the process group and for the pid
alone. The partial Turn is kept in the transcript: partial text is saved with
`isAbortedMidStream: true`, and `[Request interrupted by user]` is appended. A
`--resume` process sees both, after the synthetic `No response requested.`. A user
message still queued at the SIGINT was dropped and did not come back on resume.

**A raw `control_request` `interrupt` works without `initialize` and keeps the
process alive.** The `control_response` came back in 2 to 4 ms and carried the
receipt `{"still_queued":[…]}`. It came before the Turn's `result`, which had the
same shape as the SIGINT one. The next stdin user frame then ran as a new Turn in
the same process and Session.

- Mid-text, the partial text stays in context. The `assistant` frame carries
  `aborted: true`, and the model later quoted the last line it had written.
- Mid-tool, the `tool_use` stays. Its `tool_result` is replaced by the standard
  "The user doesn't want to proceed with this tool use… rejected" text, followed by
  `[Request interrupted by user for tool use]`. Output the tool had already printed
  is thrown away. The model then said the tool was "rejected before execution".
- The foreground Bash process tree was killed.
- A Bash command the model had moved to the background kept running after the
  interrupt. It was killed only when the process exited.

**A user frame written during a tool call is picked up in the same Turn. One written
while text streams becomes the next Turn.**

- **During a tool call.** The frame was held until the tool finished. It then
  reached the model as a `queued_command` system-reminder next to the tool result.
  The Turn's one `result` listed its `uuid` in `user_message_uuids`, and
  `num_turns` stayed 2. The model acted on it in that Turn.
- **Two frames** written 0.5 s apart were taken together at the same boundary, in
  write order.
- **While text streamed.** The frame was not taken into the running Turn. It ran
  as a second Turn with its own `result` and `result_index: 1`.
- `queued_turn_count` was `0` on every `result`, including the first `result` in
  that last case, while the message was still waiting.

**On an interrupt, a queued message runs, is cancelled, or is lost, depending on the
stop.**

- **Plain `interrupt`.** The message is listed in `still_queued` and runs by itself
  as the next Turn right after the interrupted `result`.
- **`interrupt` with `cancel_queued: true`.** The message is listed in `cancelled`,
  and a `command_lifecycle` `cancelled` frame is written for it. No next Turn
  starts, and the process stays alive.
- **SIGINT.** The message is dropped with no lifecycle frame, and the process
  exits.

**Version floor.** The changelog names none of `user_message_uuids`,
`queued_turn_count`, the `interrupt` control request, receipts, or `cancel_queued`.
The nearest entries are listed under [Version floor](#test-6-version-floor).

**Which stop keeps the process alive and the partial Turn in context:** only the
`control_request` `interrupt`. SIGINT keeps the partial Turn but ends the process.
SIGTERM ends the process and loses streamed text.

Windows was not tested.

## Evidence Vocabulary

- **Recorded (2.1.284)**: seen in the live frame sequences or session transcripts
  captured for this note on 2026-09-29 against Claude Code 2.1.284. Every fact
  below without another label is Recorded (2.1.284).
- **Documented**: stated in the Claude Code changelog or official docs, cited
  directly or through
  [Harness Interrupt and Queued Messages](harness-interrupt-and-queued-messages.md).
- **Inferred**: a consequence drawn from Recorded facts; it needs a check before it
  becomes a compatibility promise.
- **Unknown**: not settled by these runs.

## Method

A small Bun driver spawned `claude` with the stream flags that
`src/harness/claude-code.ts` uses. It spawned `claude` `detached`, so the CLI led its
own process group, as `src/process/process.ts` does:

```text
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --model haiku \
  [--session-id <uuid> | --resume <uuid>] \
  --allowedTools "Bash(sleep:*)" "Bash(echo:*)" "Bash(./slowjob.sh)"
```

The driver worked like this:

- It wrote user frames in the Adapter's `encodeTurn` shape plus a `uuid`:
  `{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null,"uuid":"<uuid>"}`.
- It logged every stdout line with a millisecond offset, and recorded exit code
  and signal.
- It signalled with `process.kill(-pid, sig)` for the process group, as Secant's
  `killGroup` does, or with `process.kill(pid, sig)` for the pid alone.
- It checked the Bash child with `ps -eo pid,ppid,pgid,sid,args` before and
  after each stop.
- It read the session transcript at
  `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` after each run.
- Each process ran with a scratch directory as cwd, not the repository. It had
  no `CLAUDE*` environment variables, used subscription auth
  (`apiKeySource: "none"`), and ran in permission mode `default`.

The two Turn shapes:

- **Mid-tool.** The prompt asked for `./slowjob.sh` in the foreground, then the
  code word `PINEAPPLE`. `slowjob.sh` is `echo started-27; sleep 27; echo done-27`.
  The stop or send came 3 s after the `tool_use` frame. The brief's `sleep 20` could
  not be used: 2.1.284's Bash tool refuses long sleeps on its own. It answered
  `sleep 27` with `Blocked: standalone sleep 27…` and `sleep 27 && echo done-27`
  with `Blocked: sleep 27 followed by: echo done-27…`. The first `sleep 27` run
  (test 3, run 1) was moved to the background by the model.
- **Mid-text.** The prompt was "count from one to three hundred in English words,
  one number per line". The stop or send came 2.5 s after the first text delta,
  about 1,400 characters in.

After each stop the driver asked the same process, or a `--resume` process,
"Without running any tools: what was the last thing you wrote or did in this
conversation before this message? Quote the last line you wrote…".

Differences from Secant's launch:

- Secant adds the loopback MCP permission bridge (`--mcp-config`,
  `--permission-prompt-tool`). The driver did not. A tool call parked on a
  permission prompt at the moment of a stop was not tested.
- The host's user settings load no-op `SessionStart`, `PreToolUse`, `PostToolUse`,
  and `Stop` hooks, plus a user `CLAUDE.md`.

Frame excerpts below are trimmed. `t` is milliseconds since spawn. Hook, status,
`thinking_tokens`, and `stream_event` frames are omitted, and so are most
`command_lifecycle` frames. Raw logs were kept outside the repository.

## Test 1: SIGTERM mid-Turn, then `--resume`

### 1a: during a tool call (three runs)

```text
t=2916 assistant tool_use {"command":"./slowjob.sh","run_in_background":false}
       ps: 68103 claude (pgid 68103)
           68275 /bin/bash -c … eval ./slowjob.sh   (pgid 68275, sid 68275)
           68277 /bin/bash ./slowjob.sh             (pgid 68277)
           68278 sleep 27                           (pgid 68277)
t=5986 SIGNAL SIGTERM group pid=68103
t=6000 system/task_notification status=stopped
t=6021 user tool_result "Exit code 137\nstarted-27" is_error
t=6865 EXIT code=143 signal=null
t=8427 ps: no slowjob or sleep 27 left
```

No `result` frame was written. The transcript kept the whole tool round, and resume
added one synthetic entry:

```text
user       "Use the Bash tool … ./slowjob.sh …"
assistant  thinking, tool_use toolu_01…            stop_reason=tool_use
user       tool_result "Exit code 137\nstarted-27" is_error
           toolUseResult="Error: Exit code 137\nstarted-27"
--- written by the --resume process ---
assistant  "No response requested."  model=<synthetic> stop_reason=stop_sequence
user       <the question>
```

The resumed model answered: "I ran the Bash command `./slowjob.sh` in the
foreground, but it was killed before completion—the exit code was 137 (SIGKILL) and
it only printed "started-27" before terminating."

- **The Bash tree was killed, although it was outside the signalled group.** The
  Bash tool runs its shell as a new session and process group (`pgid 68275`), so
  `kill(-pid)` does not reach it. Claude Code killed it itself (exit 137). This
  matches the documented 2.1.212 fix for orphaned trees on SIGTERM.
- The killed tool call is kept as an ordinary error result. There is no
  `[Request interrupted…]` marker and no synthetic denial. This matches 2.1.236.

### 1b: while text streams (two runs)

```text
t=5139 partial text so far (1372 chars) tail="…One Hundred Eighteen\nOne"
t=5140 SIGNAL SIGTERM group
t=6401 EXIT code=143 signal=null
```

No `result` frame and no `assistant` frame were written. The transcript held only
the user prompt, then the resume's synthetic `No response requested.`. The resumed
model answered, in both runs: "The last line I wrote was: "No response requested."
No commands ran—you asked me to count without using tools, which I declined to do."

- **The partial text and its thinking are gone.** The resumed model has no trace
  that it started to answer.
- The synthetic `No response requested.` reads, to the model, as a refusal of the
  prompt. **Inferred.**

## Test 2: SIGINT to a `-p` stream-json process

### 2a: during a tool call (process group, then pid only)

```text
t=3282 assistant tool_use {"command":"./slowjob.sh",…}
t=6325 SIGNAL SIGINT group
t=6382 user tool_result "The user doesn't want to proceed with this tool use. The tool
       use was rejected (eg. if it was a file edit, the new_string was NOT written to
       the file). STOP what you are doing and wait for the user t…" is_error
t=6385 user text "[Request interrupted by user for tool use]"
t=6401 result subtype=error_during_execution is_error=true terminal_reason=aborted_tools
       stop_reason=tool_use num_turns=3 user_message_uuids=[<prompt uuid>]
       errors=["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]
t=7255 EXIT code=0 signal=null
```

SIGINT to the pid alone (2c) gave the same frames and `EXIT code=0` after 1 s.

### 2b: while text streams (two runs)

```text
t=5239 SIGNAL SIGINT group
t=5277 assistant text "one\ntwo\n…" (1822 chars) aborted=true
t=5278 user text "[Request interrupted by user]"
t=5283 result subtype=error_during_execution terminal_reason=aborted_streaming
       stop_reason=null num_turns=2 total_cost_usd=0 duration_api_ms=0
t=6564 EXIT code=0 signal=null
```

Transcript, then the `--resume` process:

```text
assistant  thinking                                  stop_reason=null
assistant  text "one\ntwo\n…" (1822 chars)            isAbortedMidStream=true
user       "[Request interrupted by user]"
--- written by the --resume process ---
assistant  "No response requested."  model=<synthetic>
user       <the question>
```

The resumed model answered: "The last line I wrote was "one hundred" as part of
counting from one to three hundred in words. You interrupted the counting task
mid-way through the one-hundreds range."

- **SIGINT ends the Turn and then the process.** The process did not wait for more
  stdin. It exited 0 about 1 s after the `result` in all four runs, so no next
  user frame can run in the same process.
- **The partial Turn is kept.** On resume, the model sees the partial text, the
  interrupt marker, and the synthetic reply. For a tool call, it sees the rejected
  result. The second mid-text run's resumed model quoted the synthetic line as its
  last line but still said "you interrupted the counting task".
- The Bash tree was gone after the SIGINT.
- The interrupted mid-text `result` reported `total_cost_usd: 0` and zero usage,
  even though about 1,400 characters had been generated. The next `result` in the
  process (test 3b) carried the running total again. Whether an aborted stream's
  tokens are ever counted is Unknown.

## Test 3: raw `control_request` `interrupt` without `initialize`

The first frame of each process was the user prompt. No `initialize` was ever sent.

### 3a: during a tool call

```text
t=2732 assistant tool_use {"command":"./slowjob.sh",…}
t=5774 in  {"type":"control_request","request_id":"int1","request":{"subtype":"interrupt"}}
t=5778 control_response {"subtype":"success","request_id":"int1","response":{"still_queued":[]}}
t=5792 user tool_result "The user doesn't want to proceed with this tool use. The tool use was
       rejected …" is_error
t=5793 user text "[Request interrupted by user for tool use]"
t=5800 result subtype=error_during_execution is_error=true terminal_reason=aborted_tools
       num_turns=3 user_message_uuids=[<prompt uuid>] queued_turn_count=0 result_index=0
t=5800 command_lifecycle <prompt uuid> state=cancelled
t=7343 ps: no slowjob or sleep 27 left; process alive
t=7343 in  user <the question>
t=7403 system/init (same session_id)
t=11845 assistant text "I attempted to call the Bash tool to run `./slowjob.sh`, but the
        tool use was rejected before execution. No command finished and I received no
        output—the user interrupted the tool call."
t=11891 result subtype=success num_turns=1 result_index=1
```

In the transcript, the `tool_result` is stored with `toolUseResult: "User rejected
tool use"` and `toolDenialKind: "user-rejected"`. In tests 5a and 5b, `slowjob.sh`
had already printed `started-27` when the interrupt came, and the stored
`tool_result` was the same rejection text. The partial stdout was discarded. No
synthetic `No response requested.` is written when the next Turn runs in the same
process.

Run 1 used a bare `sleep 27` and hit the Bash tool's sleep guard. The model then
started `sleep 27` with `run_in_background: true`. The interrupt at t=5612 ended the
Turn, but `sleep 27` was still running at t=7154. The background task was reported
`killed` only at t=15993, after the driver closed stdin and the process began to
exit. The second Turn's model said the background command "is still running".

### 3b: while text streams

```text
t=5444 in  control_request interrupt int1
t=5446 control_response {"subtype":"success","request_id":"int1","response":{"still_queued":[]}}
t=5481 assistant text "One\nTwo\n…" (1412 chars) aborted=true
t=5484 user text "[Request interrupted by user]"
t=5488 result subtype=error_during_execution terminal_reason=aborted_streaming stop_reason=null
       total_cost_usd=0 num_turns=2 result_index=0
t=7027 in  user <the question>
t=10714 assistant text "The last line I wrote was "One" (after "One Hundred Twenty"),
        completing the number list you requested. … I was interrupted partway through
        the three-hundred count."
t=10775 result subtype=success num_turns=1 result_index=1
t=11673 EXIT code=0 (after the driver closed stdin)
```

- **Honoured without `initialize`.** The `control_response` is a `success` with the
  documented receipt, written before the interrupted `result`, as the SDK typings
  describe.
- **The process stays alive and the Session continues.** The next user frame ran
  in the same process with the same `session_id`.
- **Partial text is in context. A partial tool result is not.** The model quoted
  the exact last partial line. For the tool call, it saw only the rejection text,
  and it believed the command never ran.
- **The foreground Bash tree is killed. A background Bash task is not.**
- The `init` frame advertised `capabilities: ["interrupt_receipt_v1",
"interrupt_cancel_queued_v1", "msg_lifecycle_v1", "mcp_read_resource_v1",
"mcp_tool_ui_meta_v1"]`. `command_lifecycle` frames (`queued`, `started`,
  `completed`, `cancelled`) were written by default on this raw stream, with no
  opt-in.

## Test 4: user frames written mid-Turn

### 4a: one frame during a tool call

```text
t=2978 assistant tool_use {"command":"./slowjob.sh",…}
t=6018 in  user uuid=aaaaaaaa-…-000000000001 "Additional instruction: after the command
       finishes, also say the word MANGO."
t=6022 command_lifecycle aaaaaaaa-… state=queued
t=30101 user tool_result "started-27\ndone-27"
t=30139 command_lifecycle aaaaaaaa-… state=started
t=34711 assistant text "PINEAPPLE\nMANGO"
t=34741 command_lifecycle aaaaaaaa-… state=completed
t=34746 result subtype=success num_turns=2 queued_turn_count=0 result_index=0
        user_message_uuid=<prompt uuid>
        user_message_uuids=[<prompt uuid>, "aaaaaaaa-0000-4000-8000-000000000001"]
t=34748 command_lifecycle <prompt uuid> state=completed
```

The transcript shows how the frame reached the model:

```text
queue-operation enqueue  "Additional instruction: …"
user            tool_result "started-27\ndone-27"
attachment      queued_command source_uuid=aaaaaaaa-… commandMode=prompt
                rendered: "<system-reminder>\nThe user sent a new message while you were
                working:\nAdditional instruction: after the command finishes, also say
                the word MANGO.\n\nThis is how Claude Code surfaces messages the user
                sends mid-turn — within the running turn, often alongside the next tool
                result, rather than as a separate conversation turn. Address the message
                above as you continue this turn.\n</system-reminder>"
queue-operation remove   reason=absorbed_mid_turn
assistant       "PINEAPPLE\nMANGO"
```

- **Picked up in the same Turn.** The frame is held until the running tool
  finishes, not injected into it, and it did not cut the 27 s command short. It
  reached the model with the tool result.
- The Turn's one `result` lists the picked-up `uuid` in `user_message_uuids`.
  `user_message_uuid` stays the prompt's. `num_turns` is 2, the same as a Turn with
  no pickup.
- The picked-up frame is never echoed on stdout as a `user` frame; the driver did
  not pass `--replay-user-messages`. `command_lifecycle` `completed` for it comes
  before the Turn's `result`.

### 4b: one frame while text streams, with no tool round left

```text
t=5584 in  user uuid=bbbbbbbb-…-000000000001 "Now reply with the single word MANGO."
t=5585 command_lifecycle bbbbbbbb-… state=queued
t=10247 assistant text "One\nTwo\n…" (5488 chars)
t=10290 result subtype=success num_turns=1 queued_turn_count=0 result_index=0
        user_message_uuids=[<prompt uuid>]
t=10293 command_lifecycle <prompt uuid> state=completed
t=10294 command_lifecycle bbbbbbbb-… state=started
t=10333 system/init
t=11500 assistant text "MANGO"
t=11542 result subtype=success num_turns=1 queued_turn_count=0 result_index=1
        user_message_uuid="bbbbbbbb-…" user_message_uuids=["bbbbbbbb-…"]
```

- **Not picked up. It runs as the next Turn.** The first Turn finished its text
  with no sign of the message. A second `system/init` and a second `result` followed
  at once, with no new stdin write.
- **`queued_turn_count` was `0`** on the first `result`, while `bbbbbbbb-…` was
  still queued and about to run. It was `0` on every `result` captured for this
  note. It cannot be used to tell that another Turn will follow. The
  `command_lifecycle` `queued` frame, without a matching `started` before the
  `result`, did show this.

### 4c: two frames during a tool call

```text
t=5767 in  user uuid=cccccccc-…-01 "Additional instruction one: … say the word MANGO."
t=6269 in  user uuid=cccccccc-…-02 "Additional instruction two: after that, say the word KIWI."
t=29830 user tool_result "started-27\ndone-27"
t=29890 command_lifecycle cccccccc-…-01 state=started
t=29890 command_lifecycle cccccccc-…-02 state=started
t=33241 assistant text "PINEAPPLE"
t=33277 result subtype=success num_turns=2 queued_turn_count=0
        user_message_uuids=[<prompt uuid>, "cccccccc-…-01", "cccccccc-…-02"]
```

- **Both frames are taken at the same boundary, in write order.** The transcript
  has two `queued_command` attachments (one, then two) after the tool result. The
  Turn made one more model call, not one per message.
- **Listed does not mean acted on.** Both `uuid`s are in `user_message_uuids`, but
  the model answered only `PINEAPPLE`. The original prompt said "and nothing else",
  and Haiku kept to it. `user_message_uuids` shows delivery to the model, not
  compliance.

## Test 5: a queued message, then a stop

Each run wrote a user frame during the tool call and stopped the Turn 1.5 s later,
before the tool finished.

### 5a: plain `interrupt`

```text
t=5955 in  user uuid=dddddddd-…-01 "Queued message: reply with the single word MANGO."
t=7456 in  control_request interrupt int1
t=7460 control_response {"subtype":"success","request_id":"int1",
       "response":{"still_queued":["dddddddd-0000-4000-8000-000000000001"]}}
t=7472 user tool_result "The user doesn't want to proceed with this tool use. …" is_error
t=7480 result subtype=error_during_execution terminal_reason=aborted_tools result_index=0
       user_message_uuids=[<prompt uuid>]
t=7484 command_lifecycle dddddddd-… state=started
t=9103 assistant text "MANGO"
t=9136 result subtype=success num_turns=1 result_index=1 user_message_uuids=["dddddddd-…"]
```

- **The queued message runs by itself as the next Turn**, 4 ms after the
  interrupted `result`, with no new stdin write. The receipt names it in
  `still_queued`.

### 5b: `interrupt` with `cancel_queued: true`

```text
t=5728 in  user uuid=eeeeeeee-…-01 "Queued message: reply with the single word MANGO."
t=7229 in  {"type":"control_request","request_id":"int1",
       "request":{"subtype":"interrupt","cancel_queued":true}}
t=7234 command_lifecycle eeeeeeee-… state=cancelled
t=7235 control_response {"subtype":"success","request_id":"int1",
       "response":{"still_queued":[],"cancelled":["eeeeeeee-0000-4000-8000-000000000001"]}}
t=7262 result subtype=error_during_execution terminal_reason=aborted_tools result_index=0
t=18827 process alive, no further frames; in  user <the question>
t=23444 result subtype=success result_index=1
```

- **`cancel_queued` works on the raw stream.** The message is dropped, and the
  receipt names it in `cancelled`. It never reaches the model: the transcript has
  `queue-operation` `enqueue` then `remove`, and no `queued_command` attachment. No
  Turn starts until the next stdin frame.

### 5c: SIGINT

```text
t=6501 in  user uuid=ffffffff-…-01 "Queued message: reply with the single word MANGO."
t=6502 command_lifecycle ffffffff-… state=queued
t=8001 SIGNAL SIGINT group
t=8050 result subtype=error_during_execution terminal_reason=aborted_tools
t=8052 command_lifecycle <prompt uuid> state=cancelled
t=8961 EXIT code=0 signal=null
```

- **The queued message is lost.** No lifecycle frame is written for
  `ffffffff-…`, and the process exits. The transcript holds a `queue-operation`
  `enqueue` for it with no `dequeue` or `remove`. A `--resume` of the Session did
  not replay it. Asked to list every user message, the resumed model listed the
  prompt, `[Request interrupted by user for tool use]`, the synthetic `No response
requested.`, and the question. MANGO was not among them.

## Test 6: version floor

Read from the [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
at its 2.1.284 head (**Documented**). No entry names `user_message_uuids`,
`user_message_uuid`, `queued_turn_count`, the `interrupt` control request,
`interrupt_receipt`, `still_queued`, `cancel_queued`, `command_lifecycle`, or a
`priority` field on user messages. The nearest entries:

| Version | Entry (quoted or trimmed)                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.19  | "[SDK] Added replay of `queued_command` attachment messages as `SDKUserMessageReplay` events when `replayUserMessages` is enabled"                                                          |
| 2.1.94  | "Fixed SDK/print mode not preserving the partial assistant response in conversation history when interrupted mid-stream"                                                                    |
| 2.1.162 | "Fixed an interrupt (Esc) sent at the very start of a turn being silently dropped in stream-json/SDK sessions"                                                                              |
| 2.1.212 | "Fixed SIGTERM during a running Bash tool orphaning the command's process tree in print/SDK mode; the CLI now aborts the turn, kills the tree, and exits 143"                               |
| 2.1.236 | "SIGTERM in print/SDK mode no longer records an interrupted turn or synthetic tool denials before exiting; running commands are still terminated and the process still exits with code 143" |
| 2.1.246 | "Fixed MCP tool calls interrupted by an incoming message in headless/remote sessions being reported to the model as "completed with no output" instead of an explicit interrupted error"    |
| 2.1.261 | "Fixed SDK and cloud sessions ignoring a Stop or interrupt sent just after the first prompt, before the turn had started"                                                                   |
| 2.1.274 | "Fixed a local `claude -p --resume` started with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` not reporting background tasks the previous process left unfinished"                                 |

The SDK reference's own version notes still apply: `interrupt_receipt_v1` from
v2.1.205 and `interrupt_cancel_queued_v1` from v2.1.219 (**Documented**, cited in
[Harness Interrupt and Queued Messages](harness-interrupt-and-queued-messages.md)).
The installed 2.1.284 advertises both, and also `msg_lifecycle_v1`, in
`system/init.capabilities`.

## Test 7: Windows

Not tested. No Windows host was available. Signal delivery, `taskkill` tree
behaviour, and the SIGINT and SIGTERM results above are all Linux-only.

## The Four Original Unknowns

| Unknown in [Harness Interrupt and Queued Messages](harness-interrupt-and-queued-messages.md)       | Result on 2.1.284                                                                                                                                                                                                                                                                                | Evidence                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Does SIGTERM in `-p` mode keep the partial assistant text in the transcript that `--resume` loads? | **No for streamed text:** nothing of the unfinished model call is saved, not even thinking. **Yes for a finished tool round:** the `tool_use` and a real `Exit code 137` result with partial stdout are saved. There is no interrupted marker. Resume adds a synthetic `No response requested.`. | Recorded (2.1.284)                          |
| Does SIGINT to a `-p --input-format stream-json` process end only the Turn and keep reading stdin? | **No.** It writes one `error_during_execution` `result`, then exits with code 0 about 1 s later, with stdin still open. The partial Turn is kept for `--resume`. A still-queued message is lost.                                                                                                 | Recorded (2.1.284)                          |
| Is a raw `control_request` `interrupt` honoured without the SDK's `initialize`?                    | **Yes.** `control_response` success with the receipt in 2 to 4 ms, then an `error_during_execution` `result`. The process stays alive, and the next user frame runs in the same Session with the partial Turn in context. `cancel_queued` works raw.                                             | Recorded (2.1.284)                          |
| Minimum version for headless mid-Turn pickup and for `priority`                                    | **Not named** in the changelog. Pickup between tool rounds is Recorded on 2.1.284. `priority` was not sent.                                                                                                                                                                                      | Documented (none found); Recorded (2.1.284) |

## Capability Table

| Stop or send on the raw `-p` stream                      | Turn ends with                                                           | Process            | Partial text in context    | Tool call in context                                    | Foreground Bash tree | Queued message                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------ | -------------------------- | ------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| SIGTERM (group)                                          | No `result`                                                              | Exits 143          | No, not even on resume     | Yes: `tool_use` plus `Exit code 137` and partial stdout | Killed by the CLI    | Not tested                                              |
| SIGINT (group or pid)                                    | `result` `error_during_execution`, `aborted_streaming` / `aborted_tools` | Exits 0 after ~1 s | Yes, on resume             | Yes, as a "rejected" result; partial stdout discarded   | Killed               | Lost; not replayed on resume                            |
| `control_request` `interrupt`                            | `control_response` receipt, then the same `result`                       | Stays alive        | Yes, in the next Turn      | Yes, as a "rejected" result; partial stdout discarded   | Killed               | Runs next by itself; listed in `still_queued`           |
| `control_request` `interrupt` with `cancel_queued: true` | Same, with `cancelled: [uuid]`                                           | Stays alive        | Not tested (mid-tool only) | Same as above                                           | Killed               | Dropped; `command_lifecycle` `cancelled`                |
| User frame during a tool call                            | Same Turn continues                                                      | Stays alive        | n/a                        | n/a                                                     | Runs to completion   | Delivered with the tool result; in `user_message_uuids` |
| User frame while text streams, no tool round left        | First Turn ends normally                                                 | Stays alive        | n/a                        | n/a                                                     | n/a                  | Runs next as its own Turn with its own `result`         |

## Still Unknown

- Whether a stdin user frame with `priority: "now"` preempts the running Turn on
  the raw stream, and whether `"later"` holds a frame past a tool boundary.
  `priority` was never sent.
- Why `queued_turn_count` stayed `0` while a message was waiting, and what makes it
  non-zero.
- Whether an interrupted mid-text Turn's tokens are counted anywhere. Its `result`
  reported `total_cost_usd: 0` and zero usage.
- Whether a user frame is picked up at a boundary between two tool calls when the
  tool round has several calls, or with MCP or permission-bridge tools. Only one
  foreground Bash call per round was used.
- What any stop does while a tool call waits on a permission prompt through
  Secant's `--permission-prompt-tool` bridge. The driver used `--allowedTools`.
- How a SIGTERM that arrives while a user frame is queued treats that frame. It was
  not tested, but the SIGINT result suggests it is lost. **Inferred.**
- Whether `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` changes what a resume after
  SIGTERM or SIGINT sees. It was not set.
- Whether a stronger model follows a mid-Turn message that conflicts with the
  original prompt. Haiku ignored two in test 4c.
- Windows: every behaviour in this note.
