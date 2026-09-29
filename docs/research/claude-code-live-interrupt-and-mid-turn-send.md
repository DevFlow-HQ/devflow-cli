# Claude Code Live Interrupt and Mid-Turn Send

Research date: 2026-09-29

Harness version examined: Claude Code **2.1.284** (installed native executable, Linux
x64; `claude --version` returned `2.1.284 (Claude Code)`).

Ticket: [#255](https://github.com/secantdev/secant/issues/255). This note settles
the Claude Code items left **Untested** or **Unknown** in
[Harness Interrupt and Queued Messages](harness-interrupt-and-queued-messages.md)
by running small live model sessions against the installed CLI. A second round,
[Round 2](#round-2-permission-waits-and-multi-tool-rounds), repeats the key stops and
sends through a stand-in for Secant's MCP permission bridge. A third round,
[Round 3](#round-3-sigterm-re-approval-and-denied-tool-calls), repeats the SIGTERM
during a permission wait and sends a user frame while the bridge denies a call.

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

**Round 2: the same holds while a tool call waits on the permission bridge.** See
[Round 2](#round-2-permission-waits-and-multi-tool-rounds).

- **Raw `interrupt` during a permission wait.** It was honoured in three of three
  runs, with a `control_response` in 2 to 4 ms. Claude Code sent the bridge an MCP
  `notifications/cancelled` for the pending `approve` call within 4 ms. The Turn
  ended with the same `error_during_execution` / `aborted_tools` `result` as a
  mid-tool interrupt, and `permission_denials` named the waiting call. The process
  stayed alive and the next user frame ran in the same Session. The model saw the
  call as "rejected before it could execute". The bridge's late `allow`, 30 s
  later, had no effect: the command never ran.
- **SIGTERM during a permission wait.** The process exited 143 with no `result`
  and no `tool_result`. No `notifications/cancelled` was sent. During shutdown,
  Claude Code opened a new MCP session to the bridge and sent a second `approve`
  call for the same `tool_use_id`. On `--resume`, the transcript gained a synthetic
  `tool_result`: "[Tool call interrupted: the session ended before this call's
  result was recorded, so its outcome is unknown…]". Round 3 repeated this; see
  below.
- **A user frame is still taken at a tool boundary, but only after the whole tool
  round.** This held when two MCP calls ran at once, when a Bash call and an MCP
  call ran one after the other in one round, and for a single MCP call. It also
  held for a frame written while a Bash call waited on the bridge: the frame was
  held through the approval and the command. Each time, the frame reached the model
  in the same Turn, and its `uuid` was in that `result`'s `user_message_uuids`.

**Round 3: SIGTERM always re-asks, and a denial is a tool boundary.** See
[Round 3](#round-3-sigterm-re-approval-and-denied-tool-calls).

- **The second `approve` after SIGTERM came every time.** It came in six of six
  runs, with the SIGTERM 0.5 s, 3 s, or 10 s into the wait, 29 to 47 ms after the
  signal, on a new MCP session, with the same `tool_use_id`. With R2-A2 that is
  seven of seven.
- **Answering it did not run the command.** A quick `allow` (two runs) or `deny`
  (one run) was delivered in full, but the command's side-effect file never
  appeared, no frame was written, and the process still exited 143 about 0.9 s
  after the signal. On `--resume` the call got the same synthetic "outcome is
  unknown" result whatever the answer.
- **A user frame written during a wait that ends in a denial is taken with the
  denial, in the same Turn, and listed.** Two of two runs: the frame reached the
  model next to the denial's `tool_result`, and its `uuid` was in the Turn's one
  `result`, which also named the call in `permission_denials`.
- **A frame written as the denial lands can miss the Turn.** Written 8 ms before
  or 33 ms after the denial's `tool_result` frame, it ran as the next Turn, in
  three of three runs.
- **A denial does not end a round early.** With one call denied and one allowed in
  the same round, the frame was taken only after the allowed call's result, in the
  same Turn (one run).

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
  `--permission-prompt-tool`). The round 1 driver did not. Round 2 added a stand-in
  bridge; see [Round 2](#round-2-permission-waits-and-multi-tool-rounds).
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

## Round 2: permission waits and multi-tool rounds

Run on 2026-09-29 against the same Claude Code **2.1.284**. Every fact in this
section is Recorded (2.1.284) unless it carries another label.

### Round 2 method

The round 2 driver used the same launch flags as `src/harness/claude-code.ts`:
`-p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --model haiku --session-id <uuid>` (or `--resume <uuid>`),
then the bridge fragment. It passed no `--allowedTools` and no permission-mode flag,
so `system/init` reported `permissionMode: "default"`.

The stand-in bridge copied `src/harness/permission-bridge.ts`:

- a Streamable HTTP MCP server on `127.0.0.1` with a random port and a bearer
  token, one transport per MCP session, built on the repository's
  `@modelcontextprotocol/sdk` 1.29.0;
- server `secant-permissions` with one `approve` tool (`tool_name`, `input`,
  `tool_use_id`), returning `{"behavior":"allow","updatedInput":…}` or
  `{"behavior":"deny",…}` as JSON text;
- launch fragment `--mcp-config <inline JSON> --permission-prompt-tool
mcp__secant-permissions__approve`.

Unlike Secant, the stand-in let the experiment set a delay for each `approve`
answer, and it did not stop when the call was cancelled. It logged every HTTP
request body, every closed response stream, and the handler's abort signal. For
round 2 it also served a second MCP server, `slowtools`, from the same process. Its
one tool, `slow_echo(text, delay_s)`, waits `delay_s` seconds and returns `echo:
<text>`. It is marked `readOnlyHint: true`.

Other differences from round 1:

- `ORCA_*` variables were removed from the child environment, as well as
  `CLAUDE*`. The host's user hooks, including a `PermissionRequest` hook, then
  printed `{}` and did not decide anything. Every `Bash ./slowjob.sh` and
  `./slow15.sh` call reached the stand-in `approve`. A Bash `echo` the model ran
  on its own did not: Claude Code allowed it without a prompt.
- The user's other MCP servers (context7 and the claude.ai connectors) also loaded,
  as they would under Secant. MCP tools were deferred, so the model sometimes
  called `ToolSearch` before `slow_echo`.
- `slow15.sh` is `echo started-15; sleep 15; echo done-15`.

`HTTP` and `MCP` lines below are the stand-in's log, on the same clock as the
stream frames.

### R2-A1: raw `interrupt` while Bash waits on the bridge (two runs, plus one with `cancel_queued`)

The stand-in held the Bash `approve` for 30 s, then answered `allow`. The
interrupt came 3 s into the wait. Run 1:

```text
t=5832 assistant tool_use toolu_01Y7… Bash {"command":"./slowjob.sh",…}
t=5854 HTTP POST /mcp tools/call#2 name=approve
t=5857 MCP approve#1 CALLED tool=Bash tool_use_id=toolu_01Y7… -> will allow after 30000ms
t=8937 ps: no slowjob or sleep 27
t=8938 in  {"type":"control_request","request_id":"int1","request":{"subtype":"interrupt"}}
t=8940 control_response {"subtype":"success","request_id":"int1","response":{"still_queued":[]}}
t=8942 HTTP POST /mcp notifications/cancelled params={"requestId":2,"reason":"AbortError: remote-cancel"}
t=8944 MCP approve#1 extra.signal ABORTED
t=8946 user tool_result "The user doesn't want to proceed with this tool use. The tool use was
       rejected …" is_error
t=8948 user text "[Request interrupted by user for tool use]"
t=8958 result subtype=error_during_execution is_error=true terminal_reason=aborted_tools
       stop_reason=tool_use num_turns=3 result_index=0 queued_turn_count=0
       user_message_uuids=[<prompt uuid>]
       permission_denials=[{"tool_name":"Bash","tool_use_id":"toolu_01Y7…",…}]
t=8960 command_lifecycle <prompt uuid> state=cancelled
t=10495 in  user <the question>
t=17396 assistant text "I attempted to call the Bash tool to run `./slowjob.sh`, but the tool use
        was rejected before it could execute. No command finished and no output was
        produced—the tool call was denied by the user."
t=17424 result subtype=success num_turns=1 result_index=1
t=35858 MCP approve#1 RETURNING {"behavior":"allow",…} (signal.aborted=true)
t=39891 ps: no slowjob or sleep 27; no further stream frames
t=42932 HTTP approve response stream closed (only when the driver closed stdin)
t=43767 EXIT code=0
```

Run 2 (test C, the repeat) gave the same frames: `control_response` in 2 ms,
`notifications/cancelled` 4 ms after the interrupt, the same `result`, and the same
`permission_denials`. Asked afterwards, the model said "My only action was an
attempted Bash tool call to run `./slowjob.sh`, which was rejected before
execution."

- **Honoured, and the process stays alive.** The next user frame ran as
  `result_index: 1` in the same process and Session.
- **Claude Code cancels the bridge call.** The bridge receives a standard MCP
  `notifications/cancelled` with the `approve` call's JSON-RPC id and `reason:
"AbortError: remote-cancel"`. It is sent on a new POST. The HTTP response stream
  for the cancelled call is not closed. It stayed open until the process exited.
- **A late answer does nothing.** The stand-in's `allow` came 27 s after the
  interrupt. The SDK server does not send a response for a cancelled request, so
  nothing reached Claude Code. **Inferred** from the SDK, and consistent with what
  was seen: `slowjob.sh` never started, and no frame followed.
- **The transcript matches a mid-tool interrupt.** The `tool_result` is stored with
  `toolUseResult: "User rejected tool use"` and `toolDenialKind: "user-rejected"`,
  followed by `[Request interrupted by user for tool use]`. Nothing marks that the
  call was waiting on approval and never ran. Only `permission_denials` in the
  `result` names it.

With `cancel_queued: true` and a user frame written 1.5 s before the interrupt:

```text
t=5571 MCP approve#1 CALLED tool=Bash … -> will allow after 30000ms
t=7110 in  user uuid=a1a1a1a1-…-01 "Queued message: reply with the single word MANGO."
t=7111 command_lifecycle a1a1a1a1-… state=queued
t=8610 in  control_request interrupt int1 cancel_queued=true
t=8613 command_lifecycle a1a1a1a1-… state=cancelled
t=8614 control_response {"still_queued":[],"cancelled":["a1a1a1a1-0000-4000-8000-000000000001"]}
t=8615 HTTP POST /mcp notifications/cancelled params={"requestId":2,…}
t=8631 result subtype=error_during_execution terminal_reason=aborted_tools result_index=0
t=13667 in  user <the question>        (no Turn started before this)
t=18831 result subtype=success result_index=1
```

The queued message was dropped as in test 5b, and the bridge call was cancelled the
same way.

### R2-A2: SIGTERM while Bash waits on the bridge

```text
t=4926 assistant tool_use toolu_01Ub… Bash {"command":"./slowjob.sh",…}
t=4975 MCP approve#1 CALLED tool=Bash tool_use_id=toolu_01Ub… reqId=2 (held 30 s)
t=8033 SIGNAL SIGTERM group
t=8037 HTTP response streams closed: both GET streams and the approve#1 stream
t=8055 HTTP POST /mcp server/discover, then initialize → new MCP session cea0a024
t=8072 HTTP POST /mcp sid=cea0a024 tools/call#1 name=approve
t=8073 MCP approve#2 CALLED tool=Bash tool_use_id=toolu_01Ub… (same call, again)
t=8896 approve#2 response stream closed
t=8897 EXIT code=143 signal=null
```

- **The process exits 143 with no `result`**, 864 ms after the signal. No
  `notifications/cancelled` was sent. The bridge saw its streams drop.
- **A second `approve` call arrives during shutdown.** Claude Code opened a new MCP
  session and asked again for the same `tool_use_id`, 39 ms after the SIGTERM. It
  exited without waiting for the answer. The bash command never ran. Seen in the
  one run.
- **The original process writes nothing for the waiting call.** The transcript ends
  at the `tool_use`, with no `tool_result`.
- **`--resume` fills the gap with a synthetic result.** The resume process
  (launched with the bridge flags) appended, before its first Turn:

```text
user       tool_result "[Tool call interrupted: the session ended before this call's result
           was recorded, so its outcome is unknown. Check whether it took effect before
           relying on it or running it again.]" is_error  toolDenialKind="interrupted"
assistant  "No response requested."  model=<synthetic>
user       <the question>
```

The resumed model answered: "The last line I wrote was "No response requested." The
command did not finish — the session ended before the tool result was recorded, so
I received no output from `./slowjob.sh`." The resume process made no `approve`
call.

This differs from test 1a. There, a SIGTERM during a running Bash call wrote a real
`Exit code 137` result before the exit.

### R2-B1: a user frame during a round with two slow tool calls

**Two `slow_echo` calls in one message (8 s and 20 s).** Both ran at once. Both
`approve` calls came first, and both `slow_echo` calls started within 350 ms.

```text
t=5514 assistant tool_use toolu_013T… slow_echo {"text":"alpha","delay_s":8}
t=5543 MCP slow_echo#1 START alpha
t=5855 assistant tool_use toolu_012b… slow_echo {"text":"beta","delay_s":20}
t=5890 MCP slow_echo#2 START beta
t=8585 in  user uuid=b1a00000-…-01 "Additional instruction: when you reply, also say the word MANGO."
t=8587 command_lifecycle b1a00000-… state=queued
t=13562 user tool_result toolu_013T… "echo: alpha"
t=25904 user tool_result toolu_012b… "echo: beta"
t=25921 command_lifecycle b1a00000-… state=started
t=30394 assistant text "echo: alpha\necho: beta"
t=30430 command_lifecycle b1a00000-… state=completed
t=30434 result subtype=success num_turns=3 result_index=0
        user_message_uuids=[<prompt uuid>, "b1a00000-0000-4000-8000-000000000001"]
```

**Bash `./slow15.sh` and `slow_echo` (5 s) in one message.** These ran one after
the other. The `approve` call for `slow_echo` came only after Bash finished.

```text
t=10142 assistant tool_use toolu_01E8… Bash {"command":"./slow15.sh",…}
t=10166 MCP approve#1 CALLED tool=Bash (allowed at once)
t=10347 assistant tool_use toolu_01UN… slow_echo {"text":"gamma","delay_s":5}
t=14186 in  user uuid=b1b00000-…-01 "Additional instruction: … MANGO."
t=14188 command_lifecycle b1b00000-… state=queued
t=25233 user tool_result toolu_01E8… "started-15\ndone-15"
t=25246 MCP approve#2 CALLED tool=mcp__slowtools__slow_echo
t=25253 MCP slow_echo#1 START gamma
t=30266 user tool_result toolu_01UN… "echo: gamma"
t=30299 command_lifecycle b1b00000-… state=started
t=33981 assistant text "PINEAPPLE"
t=34012 result subtype=success num_turns=4
        user_message_uuids=[<prompt uuid>, "b1b00000-0000-4000-8000-000000000001"]
```

An earlier run wrote the frame during the second call, the MCP one. It was taken
after that call's result, in the same way.

- **A frame is taken only after the whole round.** It is not taken after the first
  call's result, whether the calls run together (first result at 13.6 s, pickup at
  25.9 s) or one after the other (the Bash result, then the whole MCP call, then
  pickup). In the transcript, the `queued_command` attachment follows the last
  `tool_result` of the round, and the `queue-operation` `remove` has `reason:
"absorbed_mid_turn"`.
- **Same Turn, listed.** Each time there was one `result`, and the picked-up `uuid`
  was in its `user_message_uuids`.
- Haiku did not say MANGO in either run. Delivery does not mean compliance, as in
  test 4c.

### R2-B2: a user frame during one MCP call, and during a permission wait

**During one `slow_echo` (15 s).**

```text
t=9359 assistant tool_use toolu_01Qq… slow_echo {"text":"delta","delay_s":15}
t=9387 MCP slow_echo#1 START delta
t=12410 in  user uuid=b2a00000-…-01 "Additional instruction: … MANGO."
t=12412 command_lifecycle b2a00000-… state=queued
t=24400 user tool_result toolu_01Qq… "echo: delta"
t=24415 command_lifecycle b2a00000-… state=started
t=28050 assistant text "delta"
t=28085 result subtype=success num_turns=4
        user_message_uuids=[<prompt uuid>, "b2a00000-0000-4000-8000-000000000001"]
```

The MCP call was not cut short, and no `notifications/cancelled` was sent. The
frame was taken after the MCP result, as for Bash in test 4a. In a first run, the
frame arrived while the model was streaming the call that became `slow_echo`. It
was held through the whole MCP call and taken after its result, in the same Turn.

**While Bash waits on the bridge (held 10 s, then `allow`).**

```text
t=29043 assistant tool_use toolu_01Nn… Bash {"command":"./slow15.sh",…}
t=29068 MCP approve#1 CALLED tool=Bash -> will allow after 10000ms
t=32092 in  user uuid=b2b00000-…-01 "Additional instruction: … MANGO."
t=32095 command_lifecycle b2b00000-… state=queued
t=39070 MCP approve#1 RETURNING {"behavior":"allow",…}
t=42120 system/task_started local_bash
t=54146 user tool_result toolu_01Nn… "started-15\ndone-15"
t=54168 command_lifecycle b2b00000-… state=started
t=56342 assistant text "PINEAPPLE MANGO"
t=56369 result subtype=success num_turns=2
        user_message_uuids=[<prompt uuid>, "b2b00000-0000-4000-8000-000000000001"]
```

- **The frame does not end or answer the permission wait.** It was held through
  the rest of the wait, the approval, and the 15 s command. It was taken after the
  tool result, in the same Turn, and listed. Haiku acted on it this time.

### `command_lifecycle` in round 2

In every run:

- A written frame got `queued` within 1 to 3 ms.
- A picked-up frame got `started` 15 to 33 ms after the round's last `tool_result`
  frame, and `completed` just before the Turn's `result`. The prompt's `completed`
  came just after the `result`.
- After an interrupt, the prompt got `cancelled` just after the `result`.
- With `cancel_queued`, the queued frame got `cancelled` just before the
  `control_response`.

## Round 3: SIGTERM re-approval and denied tool calls

Run on 2026-09-29 against the same Claude Code **2.1.284**. Every fact in this
section is Recorded (2.1.284) unless it carries another label.

### Round 3 method

The round 3 driver and stand-in bridge were the round 2 ones, with the same launch
flags, the same `default` permission mode, no `--allowedTools`, and `CLAUDE*` and
`ORCA_*` removed from the child environment. Two changes:

- The stand-in's answer policy could depend on the call's position, so the first
  `approve` for a Bash call could be held and a second one for the same call
  answered differently. It also called back when an answer was returned, so the
  driver could write a frame at that moment.
- The command was `./mark.sh`, which appends a timestamp to `mark.out` and prints
  `marked`. The driver deleted `mark.out` before each run and checked for it
  before the signal, 2 s after the exit, and after the resume. `mark.out` was
  absent at every check in every round 3 run.

The B prompts said "run exactly this command: ./mark.sh ." and Haiku sometimes sent
the command as `./mark.sh .`. It was denied every time, so this made no difference.

### R3-A: SIGTERM while Bash waits on the bridge (six runs)

Each run held the first Bash `approve` for 120 s, then sent a process-group SIGTERM
after a delay. A second `approve` for the same call was held, answered `allow` after
50 ms, or answered `deny` after 50 ms. The `allow` run with a 3 s delay:

```text
t=5168 MCP approve#1 CALLED tool=Bash tool_use_id=toolu_01Ct… reqId=2 (held 120 s)
t=8211 mark.out before SIGTERM: ABSENT
t=8212 SIGNAL SIGTERM group
t=8216 HTTP approve#1 response stream closed
t=8242 HTTP POST /mcp server/discover, then initialize → new MCP session bb09799d
t=8257 MCP approve#2 CALLED tool=Bash tool_use_id=toolu_01Ct… reqId=1 (same call, again)
t=8307 MCP approve#2 RETURNING {"behavior":"allow","updatedInput":{"command":"./mark.sh",…}}
t=8309 HTTP approve#2 response written in full (writableFinished=true)
t=9119 EXIT code=143 signal=null
t=11123 mark.out 2s after exit: ABSENT
```

| Run        | SIGTERM after the first `approve` | Second `approve` after SIGTERM | Answer to it   | Exit after SIGTERM | `mark.out` |
| ---------- | --------------------------------- | ------------------------------ | -------------- | ------------------ | ---------- |
| a_hold_05  | 0.5 s                             | 47 ms                          | held           | 1,306 ms, 143      | absent     |
| a_hold_3   | 3 s                               | 37 ms                          | held           | 933 ms, 143        | absent     |
| a_hold_10  | 10 s                              | 33 ms                          | held           | 920 ms, 143        | absent     |
| a_allow_05 | 0.5 s                             | 29 ms                          | `allow`, 50 ms | 978 ms, 143        | absent     |
| a_allow_3  | 3 s                               | 45 ms                          | `allow`, 50 ms | 907 ms, 143        | absent     |
| a_deny_3   | 3 s                               | 38 ms                          | `deny`, 50 ms  | 951 ms, 143        | absent     |

- **The second `approve` came in all six runs.** Each time Claude Code opened a new
  MCP session (`server/discover`, then `initialize`) and called `approve` again with
  the same `tool_use_id` and input, 29 to 47 ms after the signal. It happened at
  every delay tried, 0.5 s to 10 s. With R2-A2 that makes seven of seven runs.
- **Answering it did not run the command.** An `allow` delivered 50 ms after the
  call, 80 to 95 ms after the signal, did not start `./mark.sh`: `mark.out` never
  appeared, and no `task_started`, `tool_result`, or other stream frame followed
  the signal. The process exited 812 to 899 ms after the answer, about as long as
  when the call was held. A `deny` changed nothing either.
- **No frame after the signal.** No stream frame of any kind was written after the
  SIGTERM, and no `result`.
- **The answer is not recorded.** In all six transcripts nothing follows the
  `tool_use` until the resume. The `--resume` process wrote the same synthetic
  `tool_result` as in R2-A2, with `toolDenialKind: "interrupted"`, whether the second
  `approve` was held, allowed, or denied. It made no `approve` call. Each resumed
  model said the command did not finish and its outcome was unknown.
- Claude Code opens the second `approve` but does not act on its answer before it
  exits. **Inferred** from the six runs. Whether a slower shutdown could act on it
  is Unknown.

### R3-B1: a user frame while a Bash call waits on a denial (two runs)

The stand-in denied the Bash `approve` after 8 s. The driver wrote a user frame 3 s
into the wait. Run 1:

```text
t=4952 assistant tool_use toolu_01XY… Bash {"command":"./mark.sh",…}
t=4977 MCP approve#1 CALLED tool=Bash -> will deny after 8000ms
t=7985 in  user uuid=b3100000-…-01 "Additional instruction: when you reply, also say the word MANGO."
t=7987 command_lifecycle b3100000-… state=queued
t=12978 MCP approve#1 RETURNING {"behavior":"deny","message":"Denied by the stand-in bridge."}
t=12987 user tool_result toolu_01XY… "Denied by the stand-in bridge." is_error
t=13003 command_lifecycle b3100000-… state=started
t=14954 assistant text "PINEAPPLE MANGO"
t=14970 command_lifecycle b3100000-… state=completed
t=14974 result subtype=success terminal_reason=completed num_turns=2 result_index=0
        queued_turn_count=0
        permission_denials=[{"tool_name":"Bash","tool_use_id":"toolu_01XY…",…}]
        user_message_uuids=[<prompt uuid>, "b3100000-0000-4000-8000-000000000001"]
t=14975 command_lifecycle <prompt uuid> state=completed
```

Run 2 gave the same sequence: `queued` 2 ms after the write, `started` 15 ms after
the denied `tool_result`, the reply "PINEAPPLE MANGO", and one `result` listing the
frame.

- **Taken at the denial's boundary, in the same Turn, and listed.** The frame was
  held through the rest of the wait. It reached the model next to the denial's
  `tool_result`, and its `uuid` was in the Turn's one `result`. Haiku acted on it in
  both runs.
- In the transcript, the `tool_result` is stored with `toolUseResult: "Error: Denied
by the stand-in bridge."` and `toolDenialKind: "permission-rule"`. The
  `queued_command` attachment follows it, and the `queue-operation` `remove` has
  `reason: "absorbed_mid_turn"`, as in rounds 1 and 2.
- The denial's `message` reaches the model as the `tool_result` text.

### R3-B2: a user frame written as the denial is returned (three runs)

The stand-in denied after 5 s. The driver wrote the frame from the stand-in's
return callback: at once (two runs) or 40 ms later (one run).

```text
t=9663 MCP approve#1 RETURNING {"behavior":"deny",…}
t=9663 in  user uuid=b3200000-…-01 "Additional instruction: … MANGO."
t=9671 user tool_result toolu_013H… "Denied by the stand-in bridge." is_error
t=9698 command_lifecycle b3200000-… state=queued
t=11285 assistant text "PINEAPPLE"
t=11307 result subtype=success num_turns=2 result_index=0 user_message_uuids=[<prompt uuid>]
t=11309 command_lifecycle <prompt uuid> state=completed
t=11310 command_lifecycle b3200000-… state=started
t=15623 assistant text "PINEAPPLE"
t=15673 result subtype=success num_turns=1 result_index=1
        user_message_uuids=["b3200000-0000-4000-8000-000000000001"]
```

| Run   | Frame written, relative to the denied `tool_result` frame | `queued` after the write | Taken in the Turn? |
| ----- | --------------------------------------------------------- | ------------------------ | ------------------ |
| b2    | 8 ms before                                               | 35 ms                    | No, next Turn      |
| b2-r2 | 8 ms before                                               | 31 ms                    | No, next Turn      |
| b2d   | 33 ms after                                               | 2 ms                     | No, next Turn      |

- **Not taken in the running Turn.** In all three runs the frame was not in the
  first `result`'s `user_message_uuids`. It ran by itself as the next Turn
  (`result_index: 1`) with no new stdin write, as in test 4b. In each transcript
  the `enqueue` comes after the denial's `tool_result`, with a `dequeue` for the
  next Turn and no `queued_command` attachment.
- **The window closes very close to the `tool_result`.** A frame written 8 ms
  before the `tool_result` frame was acknowledged `queued` 31 to 35 ms after the
  write, which was after the pickup point. In R3-B1 the pickup came 15 to 16 ms
  after the `tool_result`. So a frame that is not yet `queued` when the denial
  lands can miss the Turn. **Inferred** from three runs; the exact cut-off was not
  measured.
- In b2d the second Turn's model refused the instruction, saying it had already
  answered. Delivery does not mean compliance.

### R3-B3: one call denied, one allowed, in one round (one run)

The prompt asked for Bash `./mark.sh` and `slow_echo("gamma", 5)` in one message.
The model first called `ToolSearch` for `slow_echo` in a round of its own. The
stand-in denied the Bash `approve` after 6 s and allowed `slow_echo` at once. The
driver wrote the frame 3 s into the Bash wait.

```text
t=7098 assistant tool_use toolu_01V2… Bash {"command":"./mark.sh",…}
t=7118 MCP approve#1 CALLED tool=Bash -> will deny after 6000ms
t=7296 assistant tool_use toolu_01Qx… mcp__slowtools__slow_echo {"text":"gamma","delay_s":5}
t=10135 in  user uuid=b3300000-…-01 "Additional instruction: … MANGO."
t=10137 command_lifecycle b3300000-… state=queued
t=13119 MCP approve#1 RETURNING {"behavior":"deny",…}
t=13129 user tool_result toolu_01V2… "Denied by the stand-in bridge." is_error
t=13142 MCP approve#2 CALLED tool=mcp__slowtools__slow_echo (allowed at once)
t=13152 MCP slow_echo#1 START gamma
t=18166 user tool_result toolu_01Qx… "echo: gamma"
t=18182 command_lifecycle b3300000-… state=started
t=22955 assistant text "PINEAPPLE"
t=22976 result subtype=success num_turns=4 result_index=0
        permission_denials=[{"tool_name":"Bash",…}]
        user_message_uuids=[<prompt uuid>, "b3300000-0000-4000-8000-000000000001"]
```

- **A denied call does not end the round early.** The frame was not taken after the
  denial. The `slow_echo` call's `approve` came 13 ms after the denial, and the
  frame was taken 16 ms after the `slow_echo` result, the round's last. This is
  the same whole-round rule as R2-B1.
- **Same Turn, listed.** One `result`, with the frame's `uuid` in
  `user_message_uuids` and the denial in `permission_denials`. Haiku did not say
  MANGO.

### `command_lifecycle` in round 3

- A frame written during a wait got `queued` within 2 ms. A frame written within a
  few milliseconds of the denial landing got it 31 to 35 ms later.
- A frame taken at a boundary got `started` 15 to 16 ms after the round's last
  `tool_result`, `completed` 3 to 4 ms before the `result`, and the prompt's
  `completed` 1 to 2 ms after it.
- A frame that missed the Turn got `started` 1 ms after the prompt's
  `completed`, then ran as the next Turn.

## The Four Original Unknowns

| Unknown in [Harness Interrupt and Queued Messages](harness-interrupt-and-queued-messages.md)       | Result on 2.1.284                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                    |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Does SIGTERM in `-p` mode keep the partial assistant text in the transcript that `--resume` loads? | **No for streamed text:** nothing of the unfinished model call is saved, not even thinking. **Yes for a finished tool round:** the `tool_use` and a real `Exit code 137` result with partial stdout are saved. There is no interrupted marker. Resume adds a synthetic `No response requested.`. **Round 2:** for a call waiting on the permission bridge nothing is saved after the `tool_use`; resume adds a synthetic "Tool call interrupted… outcome is unknown" `tool_result`. **Round 3:** the same in six more runs, whether the bridge held, allowed, or denied the second `approve` that shutdown sends. | Recorded (2.1.284)                          |
| Does SIGINT to a `-p --input-format stream-json` process end only the Turn and keep reading stdin? | **No.** It writes one `error_during_execution` `result`, then exits with code 0 about 1 s later, with stdin still open. The partial Turn is kept for `--resume`. A still-queued message is lost.                                                                                                                                                                                                                                                                                                                                                                                                                  | Recorded (2.1.284)                          |
| Is a raw `control_request` `interrupt` honoured without the SDK's `initialize`?                    | **Yes.** `control_response` success with the receipt in 2 to 4 ms, then an `error_during_execution` `result`. The process stays alive, and the next user frame runs in the same Session with the partial Turn in context. `cancel_queued` works raw. **Round 2:** the same during a permission-bridge wait, and the bridge call gets MCP `notifications/cancelled`.                                                                                                                                                                                                                                               | Recorded (2.1.284)                          |
| Minimum version for headless mid-Turn pickup and for `priority`                                    | **Not named** in the changelog. Pickup between tool rounds is Recorded on 2.1.284. `priority` was not sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Documented (none found); Recorded (2.1.284) |

## Capability Table

| Stop or send on the raw `-p` stream                            | Turn ends with                                                                            | Process            | Partial text in context    | Tool call in context                                                                  | Foreground Bash tree                                               | Queued message                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------ | -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| SIGTERM (group)                                                | No `result`                                                                               | Exits 143          | No, not even on resume     | Yes: `tool_use` plus `Exit code 137` and partial stdout                               | Killed by the CLI                                                  | Not tested                                                                               |
| SIGINT (group or pid)                                          | `result` `error_during_execution`, `aborted_streaming` / `aborted_tools`                  | Exits 0 after ~1 s | Yes, on resume             | Yes, as a "rejected" result; partial stdout discarded                                 | Killed                                                             | Lost; not replayed on resume                                                             |
| `control_request` `interrupt`                                  | `control_response` receipt, then the same `result`                                        | Stays alive        | Yes, in the next Turn      | Yes, as a "rejected" result; partial stdout discarded                                 | Killed                                                             | Runs next by itself; listed in `still_queued`                                            |
| `control_request` `interrupt` with `cancel_queued: true`       | Same, with `cancelled: [uuid]`                                                            | Stays alive        | Not tested (mid-tool only) | Same as above                                                                         | Killed                                                             | Dropped; `command_lifecycle` `cancelled`                                                 |
| User frame during a tool call                                  | Same Turn continues                                                                       | Stays alive        | n/a                        | n/a                                                                                   | Runs to completion                                                 | Delivered with the tool result; in `user_message_uuids`                                  |
| `interrupt` while a tool call waits on the permission bridge   | Same `result`; `permission_denials` names the call; bridge gets `notifications/cancelled` | Stays alive        | n/a                        | Yes, as a "rejected" result; the tool never ran                                       | Never started; a late `allow` has no effect                        | With `cancel_queued`: dropped, as above                                                  |
| SIGTERM while a tool call waits on the permission bridge       | No `result`; a second `approve` for the same call during shutdown, in seven of seven runs | Exits 143          | n/a                        | Only on resume: a synthetic "Tool call interrupted… outcome is unknown" result        | Never started, even when the second `approve` was answered `allow` | Not tested                                                                               |
| User frame during an MCP call, or a round of two or more calls | Same Turn continues                                                                       | Stays alive        | n/a                        | n/a                                                                                   | Runs to completion                                                 | Delivered after the round's last tool result, not between calls; in `user_message_uuids` |
| User frame while a tool call waits on the permission bridge    | Same Turn continues                                                                       | Stays alive        | n/a                        | n/a                                                                                   | Runs after approval                                                | Held through approval and the tool; delivered with its result; in `user_message_uuids`   |
| User frame while a tool call waits on a bridge denial          | Same Turn continues                                                                       | Stays alive        | n/a                        | Yes, as an error `tool_result` with the denial message; `permission_denials` names it | Never started                                                      | Held through the wait; delivered with the denial's result; in `user_message_uuids`       |
| User frame written as the bridge denial lands                  | First Turn ends normally                                                                  | Stays alive        | n/a                        | Same as above                                                                         | Never started                                                      | Missed the boundary in three of three runs; runs next as its own Turn                    |
| User frame while text streams, no tool round left              | First Turn ends normally                                                                  | Stays alive        | n/a                        | n/a                                                                                   | n/a                                                                | Runs next as its own Turn with its own `result`                                          |

## Still Unknown

- Whether a stdin user frame with `priority: "now"` preempts the running Turn on
  the raw stream, and whether `"later"` holds a frame past a tool boundary.
  `priority` was never sent.
- Why `queued_turn_count` stayed `0` while a message was waiting, and what makes it
  non-zero.
- Whether an interrupted mid-text Turn's tokens are counted anywhere. Its `result`
  reported `total_cost_usd: 0` and zero usage.
- What SIGINT does while a tool call waits on the permission bridge. Round 2
  tested only the raw `interrupt` and SIGTERM there.
- Why SIGTERM sends a second `approve` for the waiting call, and whether any
  answer to it can take effect. It came in seven of seven runs. Round 3 answered it
  within 50 ms in three runs and the command never ran, but a slower shutdown, or
  an answer that lands at another moment, was not tested.
- Whether a user frame is taken between calls when a round has a call that fails
  on its own, rather than being denied. Round 3 found that a denied call does not
  end the round early (one run).
- The exact cut-off for a frame to be taken at a denial's boundary. Frames written
  5 s before the denial were taken; frames written 8 ms before or 33 ms after its
  `tool_result` frame were not. Nothing in between was tried.
- Whether MCP tools without `readOnlyHint` run at the same time in one round. The
  stand-in's `slow_echo` set it, and a Bash call plus an MCP call ran one after the
  other.
- How a SIGTERM that arrives while a user frame is queued treats that frame. It was
  not tested, but the SIGINT result suggests it is lost. **Inferred.**
- Whether `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` changes what a resume after
  SIGTERM or SIGINT sees. It was not set.
- Whether a stronger model follows a mid-Turn message that conflicts with the
  original prompt. Haiku ignored two in test 4c.
- Windows: every behaviour in this note.
