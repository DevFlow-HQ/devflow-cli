# Windows Live Interrupt and Steer

Research date: 2026-09-29

Harness versions examined, on Windows 11 Home 10.0.26200 (x64):

- Claude Code **2.1.283**, the WinGet native executable (`claude --version` returned
  `2.1.283 (Claude Code)`), resolved on PATH as
  `%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe`, a symbolic link into the WinGet package.
- Codex **codex-cli 0.155.0**, the standalone build at
  `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`.

Ticket: [#255](https://github.com/secantdev/secant/issues/255). The Linux rounds in
[Claude Code Live Interrupt and Mid-Turn Send](claude-code-live-interrupt-and-mid-turn-send.md)
(on `research/255-claude-live-interrupt`, Claude Code 2.1.284) and
[Codex Live Leftover Steer and Empty Turn Start](codex-live-leftover-steer-and-empty-turn-start.md)
(codex-cli 0.157.1) left Windows untested. This note repeats the stops and sends that
[ADR 0035](../adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md)
relies on, against the installed Windows CLIs. The Windows builds are one patch release (Claude
Code) and two minor releases (Codex) older than the Linux ones.

## Answer

**W1. The raw `control_request` `interrupt` works on Windows without `initialize`. The Turn
stops and the process and Session stay alive. But it does not kill a script that the Bash tool
runs.** The `control_response` came back 6 to 30 ms after the write, in 12 of 12 runs, with the
receipt `{"still_queued":[…]}`. The Turn then ended with the same `result` as on Linux:
`subtype: "error_during_execution"`, `terminal_reason` `aborted_tools` or `aborted_streaming`. The
next stdin user frame ran as `result_index: 1` in the same process and `session_id`. Mid-text,
the partial text stayed in context (`aborted: true`, `isAbortedMidStream: true`), and the model
quoted its last partial line. Mid-tool, the `tool_result` was the standard "The user doesn't want
to proceed with this tool use… rejected" text, and the model said the command "never executed".
To stop the tool, Claude Code runs `taskkill /PID <outer bash pid> /T /F` (seen in the process
table). That reached a native command run directly by the Bash tool (`ping`) and a PowerShell-tool
script, and both were killed. It did not reach `./slowjob.sh` run by the Bash tool, which runs
through Git Bash. The script's `bash.exe` had a Windows parent pid that no longer existed, so it
was outside the tree. It ran to completion in all 6 runs where the raw interrupt stopped it, and in
5 of them it was still running after Claude Code had exited. A backgrounded Bash task was not stopped by the interrupt. Claude Code
reported it `killed` when the process exited, but its script also ran on.

**W2. `cancel_queued: true` behaves as on Linux.** The queued frame was listed in `cancelled`,
with a `command_lifecycle` `cancelled` frame just before the `control_response`. No Turn ran in
the next 10 s, and the process stayed alive (2 of 2 runs). The transcript holds `enqueue`, then
`remove`, and no `queued_command` attachment. A plain `interrupt` listed the frame in
`still_queued` and ran it by itself as the next Turn, 10 ms after the interrupted `result`
(1 run).

**W3. Mid-Turn pickup behaves as on Linux.** A frame written during a Bash call was held until
the call finished. It then reached the model as a `queued_command` attachment, next to the tool
result, in the same Turn. Its `uuid` was in the one `result`'s `user_message_uuids`, `num_turns`
was 2, and the transcript's `remove` had `reason: "absorbed_mid_turn"` (1 run). A frame written
while text streamed ran as the next native exchange, with its own `system/init` and `result`
(`result_index: 1`) (1 run). `system/init.capabilities` advertised `msg_lifecycle_v1`, and
`command_lifecycle` frames (`queued`, `started`, `completed`, `cancelled`) came on the raw stream
in every run. `queued_turn_count` was `0` on every `result`.

**W4. An interrupt during a permission-bridge wait behaves as on Linux.** The stand-in bridge
held the `approve` answer for 30 s. After the interrupt, the stand-in got MCP
`notifications/cancelled` for the pending call (`"reason":"AbortError: remote-cancel"`) 3 ms after
the `control_response`, and its handler's abort signal fired. The `result` named the
call in `permission_denials`. The process stayed alive and the next frame ran in the same
Session. The late `allow` had no effect: the script never started (2 of 2 runs, one with
`cancel_queued`).

**W5. Secant's Windows stop today (`taskkill /pid <claude pid> /T /F`) kills Claude Code outright.
The Bash tool's script still survives.** Claude Code exited with code 1, 29 to 41 ms after
`taskkill` returned, and wrote no `result` and no frame after the kill. Mid-text, nothing of the
partial answer was saved. On `--resume`, Claude Code added a synthetic `No response requested.`,
and the resumed model said it had "declined" the task, as after a Linux SIGTERM. Mid-tool, the
transcript ended at the `tool_use`. `--resume` added a synthetic `tool_result`, "[Tool call
interrupted: the session ended before this call's result was recorded, so its outcome is
unknown…]" (`toolDenialKind: "interrupted"`), plus the synthetic reply. That is the Linux result
for a SIGTERM during a bridge wait, not for a SIGTERM during a running Bash call. `taskkill /T`
listed the Claude Code process, its two tool shells, and their consoles as killed. The script and
its `ping` were not in that list, and the script finished 24 s after the kill (1 run each).

**W6. Codex on Windows behaves as on Linux.** `turn/interrupt` answered `{}` in 92 ms, and
`turn/completed` `status: "interrupted"` followed 3 ms later. The same thread took the next
`turn/start` (2 of 2). A `turn/steer` with `clientUserMessageId` was accepted at once while text
streamed. It was taken into history only after the whole answer, as a `userMessage` item whose
`clientId` echoed the id, and it was answered in the same Turn (2 of 2). An empty-input
`turn/start` on an idle thread after a completed Turn was accepted. It wrote no `userMessage`
item, and the model answered from history by repeating its last reply (2 of 2). The leftover race
was not attempted.

## Evidence Vocabulary

- **Observed**: seen in the live frames, process tables, marker files, or session transcripts
  captured for this note on 2026-09-29 against the versions above. Every fact below without
  another label is Observed.
- **Source-observed**: read in the Secant source at this branch's base, `docs/interrupt-steer`
  (`1174b55`).
- **Inferred**: a consequence drawn from Observed facts that needs a check before it becomes a
  compatibility promise.
- **Not observed**: looked for in these runs and absent.

## Method

### Driver

A small Bun 1.4.2 driver spawned each CLI the way `src/process/process.ts` spawns an owned
process on win32: `node:child_process` `spawn` with `overlapped` stdio pipes,
`windowsHide: true`, and `detached: false`, since Windows has no process groups
(**Source-observed**, `spawnOwnedProcessWithNode`, lines 399-414). The driver:

- wrote stdin frames and logged every stdout line with a millisecond offset from spawn (`t`
  below), and logged the exit code and signal;
- read the whole Windows process table (`Get-CimInstance Win32_Process`: pid, parent pid, name,
  command line) before and after each stop, and walked Claude Code's descendants by parent pid;
- copied the session transcript from `%USERPROFILE%\.claude\projects\<cwd-slug>\<uuid>.jsonl`
  after each run.

Each run used its own throwaway directory under the session scratchpad as cwd. Scripts and raw
logs stayed there, outside the repository.

### Claude Code launch

The flags were those of `src/harness/claude-code.ts` (**Source-observed**, lines 764-780):

```text
claude.exe -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --model haiku --session-id <uuid>   (or --resume <uuid>)
```

- `system/init` reported `permissionMode: "default"` and
  `capabilities: ["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1","mcp_read_resource_v1","mcp_tool_ui_meta_v1"]`
  in every run. The tool list included both `Bash` and `PowerShell`.
- Every `CLAUDE*` and `ORCA_*` variable was removed from the child environment. The host's user
  settings still load Orca hook commands (`claude-hook.cmd || echo {}`), a user `CLAUDE.md`, and
  the user's MCP servers, as they would under Secant.
- W1 to W3 and W5 pre-allowed only the slow script, with `--allowedTools "Bash(./slowjob.sh)"
"Bash(./slowjob.sh:*)"`. The PowerShell and direct-`ping` variants pre-allowed only their own
  command. W4 passed no `--allowedTools`.
- User frames were in the Adapter's shape plus a `uuid`:
  `{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null,"uuid":"<uuid>"}`.
  The interrupt was `{"type":"control_request","request_id":"int1","request":{"subtype":"interrupt"}}`,
  with `"cancel_queued":true` added in W2. No `initialize` was ever sent.

### The slow tool

`slowjob.sh` waits about 27 s on a native Windows child and leaves marker files, so that its
survival shows as a side effect:

```bash
#!/bin/bash
echo started-27
date +%s%3N > started.marker
ping -n 28 127.0.0.1 > /dev/null
echo done-27
date +%s%3N > done.marker
```

The prompt asked for `./slowjob.sh` in the foreground with the Bash tool, then the word
`PINEAPPLE`. Claude Code's Bash tool ran it through Git for Windows: `Git\bin\bash.exe -c "source
…shell-snapshots\snapshot-bash-….sh …"`, then `Git\usr\bin\bash.exe`, then the script's own
`bash.exe`. Two variants checked other tool paths:

- `slowjob.ps1`, the same steps in PowerShell, run by the PowerShell tool
  (`cmd.exe /d /s /c "chcp 65001 & pwsh.exe -NoProfile -NonInteractive … -Command …"`);
- `ping -n 28 127.0.0.1` typed directly as the Bash tool's command.

In one early W1a run, Haiku sent the command as `./slowjob.sh .`, which the pre-allow rule did not
match. Claude Code denied it ("This command requires approval"), and the interrupt landed while
the model streamed its next step (`terminal_reason: aborted_streaming`). That run counts toward
the receipt timings only. The prompt was then reworded to name the command in backticks with "no
arguments".

The mid-text prompt was "count from one to three hundred in English words, one number per line".
The stop or send came 2.5 s after the first `text_delta`, or 3 to 5 s after the `tool_use` frame.
After each stop, the same process (or a `--resume` process) was asked, "Without running any
tools: what was the last thing you wrote or did…? Quote the last line you wrote…".

### Permission-bridge stand-in (W4)

The stand-in copied `src/harness/permission-bridge.ts` (**Source-observed**): a Streamable HTTP
MCP server on `127.0.0.1` with a random port and a 256-bit bearer token, one transport per MCP
session, built on the repository's `@modelcontextprotocol/sdk` 1.29.0. It served
`secant-permissions` with one `approve` tool (`tool_name`, `input`, `tool_use_id`) returning
`{"behavior":"allow","updatedInput":…}` as JSON text. The launch fragment was
`--mcp-config <inline JSON> --permission-prompt-tool mcp__secant-permissions__approve`. Unlike
Secant, it held each answer for 30 s, did not stop when cancelled, and logged every HTTP request
body and the handler's abort signal.

### Secant's Windows stop (W5)

Secant's process Module has no graceful stage on Windows. `interrupt` calls `killGroup`, which
spawns `taskkill /pid <pid> /T /F` at once and reports `escalated: true` for a live child
(**Source-observed**, `safeInterrupt` lines 561-595, `killGroup` lines 756-776, and
[`src/process/AGENTS.md`](../../src/process/AGENTS.md)). The Claude Code Adapter then settles the
Turn `lost` with `interruption-unknown` (`src/harness/claude-code.ts` lines 545-580), and the
profile's Windows interruption evidence says so (lines 1542-1548). The driver ran the same
`taskkill` command against the Claude Code pid.

### Codex launch (W6)

The driver spawned `codex.exe app-server` over JSONL with the handshake of
`src/harness/codex/qualification.ts`:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"secant","title":"Secant","version":"0.0.0-dev"},"capabilities":{"experimentalApi":false}}}
{"method":"initialized"}
```

- `ORCA_*`, `CLAUDE*`, and the inherited `CODEX_HOME` (which pointed at an Orca runtime home)
  were removed. The `initialize` response then reported
  `"codexHome":"C:\\Users\\rg\\.codex"`, the user's real home. Nothing in it was changed.
- `model/list` offered `gpt-6-luna` ("Fast and affordable model for easier tasks"), which every
  `turn/start` used, with `effort: "low"`. Secant sets no effort.
- `thread/start {cwd}` and `turn/start {threadId, input, model}` followed the shape in
  `src/harness/codex.ts`. `turn/steer` carried `threadId`, `expectedTurnId`, `input`, and
  `clientUserMessageId`, the ADR 0035 shape. The 0.155.0 stable schema
  (`codex app-server generate-json-schema`, without `--experimental`) lists
  `clientUserMessageId` on both `TurnSteerParams` and `TurnStartParams`.
- No hook ran in these sessions. No server request arrived.

### Process hygiene

Every process started for this note exited. A final process-table check against a snapshot taken
before the first run found no `claude`, `codex`, `bash`, or `ping` left from the runs. The
scripts that outlived Claude Code (W1, W5) ended on their own when their `ping` finished.

## W1: raw `interrupt` without `initialize`

### W1a: during a Bash-tool script (`w1-tool2`, run 2)

```text
t=5772  assistant tool_use Bash {"command":"./slowjob.sh"}
t=7355  started.marker written
t=10483 ps: 7880 claude.exe
             └ 18100 Git\bin\bash.exe -c "source …snapshot-bash-….sh …"
                └ 5132 Git\usr\bin\bash.exe -c "source …"
            8180 Git\usr\bin\bash.exe ./slowjob.sh    (parent 17956: no such process)
             └ 2920 Git\usr\bin\bash.exe ./slowjob.sh
                └ 9792 PING.EXE -n 28 127.0.0.1
t=10484 in  control_request interrupt int1
t=10502 control_response {"subtype":"success","request_id":"int1","response":{"still_queued":[]}}
t=10506 system/task_notification status=stopped
t=10526 user tool_result "The user doesn't want to proceed with this tool use. The tool use was
        rejected …" is_error
t=10569 result subtype=error_during_execution is_error=true terminal_reason=aborted_tools
        stop_reason=tool_use num_turns=3 result_index=0 queued_turn_count=0
t=12232 ps: 7880 claude.exe
             └ 11088 taskkill.exe /PID 18100 /T /F
            8180, 2920, 9792 PING.EXE still running
t=12233 in  user <the question>
t=16819 assistant text "…I immediately attempted to run the Bash tool with the command
        `./slowjob.sh`, but that tool use was rejected…, so the command never executed and I
        received no output from it."
t=17017 result subtype=success result_index=1 (same session_id)
t=18803 EXIT code=0   (after the driver closed stdin)
t=29681 ps: 8180, 2920, 9792 PING.EXE still running
t=34803 done.marker written: the script ran to completion
```

- **The interrupt is honoured, and the process and Session stay alive.** The receipt came
  18 ms after the write, before the `result`. The next frame ran in the same process and Session.
- **Claude Code stops the tool with `taskkill /T /F` on the outer shell.** The `taskkill.exe`
  child of `claude.exe` names pid 18100, the Bash tool's `Git\bin\bash.exe`.
- **That kill does not reach the script.** The script's first `bash.exe` had a parent pid that no
  process held, even before the interrupt. The same held for every Bash-tool script whose tree was
  captured (four scripts in three runs: the parent pids 17956, 2176, 20276, and 15548 were never
  live). `taskkill /T` walks
  live parent links only, so it could not find the script's subtree. **Inferred**: Git Bash's
  Cygwin-style fork and exec leave the child's Windows parent pointing at a process that has
  already exited.
- **The script ran to completion in all 6 runs where the raw interrupt stopped it:** W1a runs 1
  and 2, W1c, W2 runs 1 and 2, and the plain interrupt in W2. It also did in W5a, Secant's own
  kill. `done.marker` was written about 27.5 s after `started.marker`, the script's full length.
  In every raw-interrupt run except W1a run 1, Claude Code had exited before then. (In W1c the two
  scripts share one marker file, and both were seen running after the exit.)
- **What the model is told does not match what happened.** The stored `tool_result` is the
  rejection text (`toolUseResult: "User rejected tool use"`, `toolDenialKind: "user-rejected"`),
  followed by `[Request interrupted by user for tool use]`. The model said the command never ran.
  Its side effects all happened.
- The Linux run's "foreground Bash tree was killed" does not carry over to this Windows tool path.

### W1a': a PowerShell-tool script and a direct native command (one run each)

```text
PowerShell tool, ./slowjob.ps1:
t=9441 ps: claude.exe └ cmd.exe /d /s /c "chcp 65001 & pwsh.exe …" └ pwsh.exe -Command … └ PING.EXE
t=9442 in  control_request interrupt
t=9461 control_response {"still_queued":[]}
t=9526 result error_during_execution terminal_reason=aborted_tools
t=11185 ps: claude.exe └ taskkill.exe /PID 17180 /T /F      (cmd, pwsh, and PING gone)
       done.marker absent 32 s after exit

Bash tool, `ping -n 28 127.0.0.1` typed directly:
t=11969 ps: claude.exe └ Git\bin\bash.exe └ Git\usr\bin\bash.exe └ Git\usr\bin\bash.exe └ PING.EXE
t=11991 control_response {"still_queued":[]}
t=13750 ps: claude.exe └ taskkill.exe /PID 17844 /T /F      (bash chain and PING gone)
```

- **A tool tree with unbroken parent links is killed.** That covers the PowerShell tool's
  `cmd.exe`, `pwsh.exe`, and `ping`, and a native command that the Bash tool starts itself. What
  escapes is a process that Git Bash starts as a script interpreter.

### W1b: while text streams (one run)

````text
t=10817 stream first text_delta
t=13320 in  control_request interrupt int1
t=13329 control_response {"subtype":"success","request_id":"int1","response":{"still_queued":[]}}
t=13369 assistant text "one\ntwo\n…one hundred forty\none hundred forty-" (1896 chars) aborted=true
t=13373 user text "[Request interrupted by user]"
t=13382 result subtype=error_during_execution terminal_reason=aborted_streaming stop_reason=null
        total_cost_usd=0 num_turns=2
t=14883 alive=true; in user <the question>
t=19805 assistant text "The last line I wrote was:\n\n```\none hundred forty-\n```\n\nMy response
        was cut off mid-word…"
t=20022 result subtype=success result_index=1
````

The transcript stores the partial text with `isAbortedMidStream: true`, then
`[Request interrupted by user]`. This is the same as Linux test 3b, down to `total_cost_usd: 0`
on the interrupted `result`.

### W1c: a background task and a foreground call in one Turn (one run)

The model started `./slowjob.sh` with `run_in_background: true`, then again in the foreground.
The interrupt came 4 s into the foreground call.

```text
t=5837  system/task_started task_id=but651f8j is_backgrounded=true
t=9558  control_response {"still_queued":[]}
t=9618  result error_during_execution terminal_reason=aborted_tools
t=11864 ps: background shell (Git\bin\bash.exe 20356 └ 132) still a child of claude.exe;
            both scripts and both PING.EXE running outside the tree
t=20633 system/task_updated task_id=but651f8j status=killed   (after the driver closed stdin)
t=22958 EXIT code=1
t=25187 ps: both scripts and both PING.EXE still running
```

- **A background task survives the interrupt**, as on Linux. Claude Code killed its shell only as
  the process exited.
- **On Windows, its script outlived the exit too.** So did the killed foreground call's script.
  Both ran to completion.

### Exit code at stdin close

After the driver closed stdin, Claude Code exited with code 0 when the last `result` was a
success. It exited with code 1 in the two runs where the last `result` was the interrupted one
(W1a', direct `ping`; W1c). This was not compared on Linux.

## W2: `cancel_queued: true` with a queued frame

Two runs. Each wrote a user frame 3 s into the Bash call and interrupted 1.5 s later. Run 1:

```text
t=6726  in  user uuid=eeeeeeee-…-01 "Queued message: reply with the single word MANGO."
t=6730  command_lifecycle eeeeeeee-… state=queued
t=8229  in  {"type":"control_request","request_id":"int1","request":{"subtype":"interrupt","cancel_queued":true}}
t=8257  command_lifecycle eeeeeeee-… state=cancelled
t=8259  control_response {"subtype":"success","request_id":"int1",
        "response":{"still_queued":[],"cancelled":["eeeeeeee-0000-4000-8000-000000000001"]}}
t=8349  result subtype=error_during_execution terminal_reason=aborted_tools result_index=0
t=8353  command_lifecycle <prompt uuid> state=cancelled
t=18351 after 10 s: one result, process alive; in user <the question>
t=24246 result subtype=success result_index=1
```

- Run 2 gave the same sequence, with the receipt 28 ms after the write.
- The transcript has `queue-operation` `enqueue`, then `remove`, for the queued frame, and no
  `queued_command` attachment. The model never saw it.

**Plain `interrupt` with a queued frame (one run):**

```text
t=10119 in  control_request interrupt int1
t=10140 control_response {"still_queued":["dddddddd-0000-4000-8000-000000000001"]}
t=10208 result subtype=error_during_execution terminal_reason=aborted_tools result_index=0
t=10218 command_lifecycle dddddddd-… state=started
t=11968 assistant text "MANGO"
t=12193 result subtype=success result_index=1 user_message_uuids=["dddddddd-…"]
```

The queued frame ran by itself as the next Turn, with no new stdin write, as in Linux test 5a.

## W3: mid-Turn pickup

### W3a: one frame during a Bash call (one run)

```text
t=4061  assistant tool_use Bash {"command":"./slowjob.sh"}
t=7063  in  user uuid=aaaaaaaa-…-01 "Additional instruction: after the command finishes, also say the word MANGO."
t=7067  command_lifecycle aaaaaaaa-… state=queued
t=33192 user tool_result "started-27\ndone-27"
t=33386 command_lifecycle aaaaaaaa-… state=started
t=35944 assistant text "PINEAPPLE MANGO"
t=36161 command_lifecycle aaaaaaaa-… state=completed
t=36171 result subtype=success num_turns=2 result_index=0 queued_turn_count=0
        user_message_uuids=[<prompt uuid>, "aaaaaaaa-0000-4000-8000-000000000001"]
```

- The transcript has the `queued_command` attachment (`source_uuid: aaaaaaaa-…`,
  `commandMode: "prompt"`) after the tool result, then `queue-operation` `remove` with
  `reason: "absorbed_mid_turn"`.
- `started` came 194 ms after the `tool_result` frame. The Linux runs measured 15 to 33 ms. This
  is one run.

### W3b: one frame while text streams (one run)

```text
t=12969 stream first text_delta
t=15471 in  user uuid=bbbbbbbb-…-01 "Now reply with the single word MANGO."
t=15478 command_lifecycle bbbbbbbb-… state=queued
t=21606 assistant text "One\nTwo\n…Three Hundred" (5488 chars)
t=21804 result subtype=success num_turns=1 result_index=0 user_message_uuids=[<prompt uuid>]
t=21809 command_lifecycle bbbbbbbb-… state=started
t=22004 system/init
t=23314 assistant text "MANGO"
t=23524 result subtype=success result_index=1 user_message_uuids=["bbbbbbbb-…"]
```

The frame was not taken into the running Turn. It ran as the next native exchange, with no new
stdin write, as in Linux test 4b. `queued_turn_count` was `0` on the first `result` while the
frame waited.

## W4: raw `interrupt` while Bash waits on the permission bridge

Run 1. The stand-in held the Bash `approve` for 30 s. The interrupt came 3.7 s into the wait.

```text
t=8169  assistant tool_use toolu_01Wr… Bash {"command":"./slowjob.sh",…}
t=8411  HTTP POST /mcp tools/call#2 name=approve
t=8417  MCP approve#1 CALLED tool=Bash tool_use_id=toolu_01Wr… reqId=2 -> will allow after 30000ms
t=12130 in  control_request interrupt int1
t=12136 control_response {"subtype":"success","request_id":"int1","response":{"still_queued":[]}}
t=12139 HTTP POST /mcp notifications/cancelled params={"requestId":2,"reason":"AbortError: remote-cancel"}
t=12149 MCP approve#1 extra.signal ABORTED
t=12152 user tool_result "The user doesn't want to proceed with this tool use. …" is_error
t=12154 user text "[Request interrupted by user for tool use]"
t=12196 result subtype=error_during_execution terminal_reason=aborted_tools result_index=0
        permission_denials=[{"tool_name":"Bash","tool_use_id":"toolu_01Wr…",…}]
t=20092 result subtype=success result_index=1   (the question, same Session)
t=38420 MCP approve#1 RETURNING {"behavior":"allow",…} (signal.aborted=true)
t=53799 started.marker absent, done.marker absent; process alive
t=54877 EXIT code=0   (after the driver closed stdin)
```

Run 2 wrote a user frame 1.5 s into the wait and interrupted with `cancel_queued: true` 2.3 s
later. The queued frame got `cancelled`, the receipt listed it in `cancelled`, and
`notifications/cancelled` for the `approve` call followed 3 ms after the receipt. The same
`result` and `permission_denials` followed. No Turn ran until the next stdin frame, and the
script never started.

- **Same as Linux R2-A1.** The pending approval is cancelled over MCP, and the late `allow` does
  nothing. The tool never ran, so the Git Bash survival in W1 cannot arise here.

## W5: Secant's Windows stop (`taskkill /T /F`), then `--resume`

### W5a: during a Bash-tool script (one run)

```text
t=3735  assistant tool_use Bash {"command":"./slowjob.sh"}
t=5279  started.marker written
t=8472  ps: 13320 claude.exe └ 13336 Git\bin\bash.exe └ 7064 Git\usr\bin\bash.exe
            7880 bash.exe ./slowjob.sh (parent 2176: no such process) └ 18776 └ PING.EXE 3352
t=8473  SIGNAL taskkill /pid 13320 /T /F
t=8690  taskkill exit=0 "SUCCESS: … PID 6052 (child process of PID 7064) … PID 7064 (child
        process of PID 13336) … PID 18888 (child process of PID 13320) … PID 13336 (child
        process of PID 13320) … PID 13320 (child process of PID 15680) has been terminated."
t=8731  EXIT code=1 signal=null   (no result frame, no frame after the kill)
t=10947 ps: 7880, 18776, PING.EXE still running
t=32704 done.marker written: the script ran to completion
```

The transcript ended at the `tool_use`. The `--resume` process appended, before its first Turn:

```text
user       tool_result "[Tool call interrupted: the session ended before this call's result
           was recorded, so its outcome is unknown. Check whether it took effect before relying
           on it or running it again.]" is_error  toolDenialKind="interrupted"
assistant  "No response requested."  model=<synthetic> stop_reason=stop_sequence
user       <the question>
```

The resumed model answered: "The last line I wrote was: "No response requested." The command I
ran (`./slowjob.sh`) did not finish. It was interrupted…". The script had in fact finished.

- **A forced kill writes nothing.** On Linux, a SIGTERM during a running Bash call let Claude Code
  kill the tree and write a real `Exit code 137` result (Linux test 1a). `taskkill /F` gives it no
  chance, so the resume sees the same "outcome is unknown" result as after a Linux SIGTERM during
  a bridge wait (R2-A2).
- **Secant's `taskkill /T` misses the script for the same reason Claude Code's own kill does.**
  The script was not among the processes `taskkill` listed.

### W5b: while text streams (one run)

```text
t=4222 stream first text_delta
t=7373 SIGNAL taskkill /pid 2768 /T /F
t=7575 EXIT code=1 signal=null   (no result frame)
```

The transcript held only the prompt. The `--resume` process added the synthetic
`No response requested.`, and the resumed model answered: "The last line I wrote was "No response
requested." No commands were run — you explicitly asked me to do that task "without using any
tools," so I declined rather than execute it." This is the Linux SIGTERM result (test 1b): the
partial text and its thinking are lost.

## W6: Codex app-server

Two runs of the same three-part session, each on fresh threads.

### W6a: `turn/interrupt` mid-Turn

```text
[ 7.672] item/agentMessage/delta "one"      (86 deltas before the interrupt)
[ 9.174] out turn/interrupt {"threadId":"…0ff8","turnId":"…3532"}
[ 9.266] in  response {}
[ 9.270] in  turn/completed {"turn":{"id":"…3532","status":"interrupted","error":null,"items":[]}}
[ 9.271] out turn/start {"threadId":"…0ff8","input":[{"type":"text","text":"Without using tools: quote the last line you wrote…"}],…}
[12.593] in  turn/completed status=completed
         agentMessage "I didn't write a count before your message, so I can't quote a last line.
         I didn't finish the count."
```

- **Confirmed interrupt, and the thread is reused.** The response came in 92 ms in both runs,
  and `turn/completed` `status: "interrupted"` 3 to 4 ms later. The same thread took the next
  `turn/start`, which completed.
- **The partial answer was not in context.** No `item/completed` `agentMessage` was emitted for
  the interrupted Turn, and in both runs the next Turn's model said it had written no count.
  Whether Codex keeps any of an interrupted message in history was not checked with `thread/read`.

### W6b: `turn/steer` with `clientUserMessageId` while text streams

```text
[17.068] item/started agentMessage
[18.072] out turn/steer {"threadId":"…40c9","expectedTurnId":"…94be","input":[{"type":"text",
         "text":"New instruction: stop counting now and reply with just the word MANGO."}],
         "clientUserMessageId":"secant-steer-r1"}
[18.081] in  response {"turnId":"…94be"}
[40.667] item/completed agentMessage (5488 chars, "one … three hundred")
[40.754] item/started   userMessage clientId="secant-steer-r1" "New instruction: stop counting now…"
[40.779] item/completed userMessage clientId="secant-steer-r1"
[42.204] item/completed agentMessage "MANGO"
[42.299] turn/completed {"turn":{"id":"…94be","status":"completed",…}}
```

`thread/read` (`includeTurns: true`) shows one Turn holding the prompt, the full count, the
steered `userMessage` with `clientId: "secant-steer-r1"`, and `MANGO`. Run 2 matched.

- **The steer is accepted at once but taken only at the next model-request boundary.** Here that
  was after the whole streamed answer. It is answered in the same Turn, and the `clientId`
  echoes the Secant-minted id.
- 0.155.0 also printed a `deprecationNotice` for `thread/read` with `includeTurns: true` on a
  paginated thread, pointing at `thread/turns/list` and `thread/items/list`.

### W6c: empty-input `turn/start` on an idle thread

```text
T1 turn/start "Remember the code word ZEBRA-42. Reply with just: OK"  -> agentMessage "OK", completed
T2 turn/start {"threadId":"…","input":[],"model":"gpt-6-luna","effort":"low"}
   -> response {"turn":{"id":"…","status":"inProgress",…}}
   -> turn/started, agentMessage "OK", turn/completed status=completed
   (no userMessage item in T2)
T3 turn/start "What code word did I ask you to remember?"  -> agentMessage "ZEBRA-42"
```

The same held in both runs. As on Linux, with no new input the model answered the last user
message in history again. The leftover race (a steer landing after Codex's last pending-input
check) was not attempted.

## Windows Compared With Linux

| Case                                                | Linux (Claude Code 2.1.284, codex-cli 0.157.1)                                                                    | Windows (Claude Code 2.1.283, codex-cli 0.155.0)                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw `interrupt` without `initialize`: receipt       | `control_response` success in 2 to 4 ms, before the `result`                                                      | Same, in 6 to 30 ms (12 of 12)                                                                                                                                                            |
| Raw `interrupt`: Turn end                           | `error_during_execution`, `aborted_streaming` / `aborted_tools`                                                   | Same                                                                                                                                                                                      |
| Raw `interrupt`: process and Session                | Alive; next frame runs in the same Session                                                                        | Same                                                                                                                                                                                      |
| Raw `interrupt` mid-text: partial text              | Kept (`aborted: true`); model quotes the last partial line                                                        | Same                                                                                                                                                                                      |
| Raw `interrupt` mid-tool: what the model sees       | "rejected" `tool_result`; partial stdout dropped                                                                  | Same                                                                                                                                                                                      |
| Raw `interrupt` mid-tool: foreground tool processes | Bash tree killed                                                                                                  | Claude Code runs `taskkill /PID <shell> /T /F`. PowerShell tool and a direct native command: killed. A script run by the Bash tool (Git Bash): **not killed, ran to completion** (6 of 6) |
| Background Bash task                                | Survives the interrupt; killed at process exit                                                                    | Survives the interrupt; its shell is killed at exit, but **its script outlives the exit**                                                                                                 |
| Plain `interrupt` with a queued frame               | Listed in `still_queued`; runs next by itself                                                                     | Same                                                                                                                                                                                      |
| `interrupt` with `cancel_queued: true`              | Listed in `cancelled`; lifecycle `cancelled`; no next Turn; alive                                                 | Same (2 of 2)                                                                                                                                                                             |
| Frame during a tool call                            | Taken after the round's last result, same Turn, in `user_message_uuids`                                           | Same (1 run)                                                                                                                                                                              |
| Frame while text streams                            | Runs as the next native exchange, own `result`                                                                    | Same (1 run)                                                                                                                                                                              |
| `command_lifecycle` / `msg_lifecycle_v1`            | Present by default on the raw stream                                                                              | Same                                                                                                                                                                                      |
| `queued_turn_count`                                 | Always `0`                                                                                                        | Always `0`                                                                                                                                                                                |
| `interrupt` during a bridge wait                    | `notifications/cancelled` within 4 ms; `permission_denials` names the call; late `allow` ignored; tool never runs | Same (2 of 2)                                                                                                                                                                             |
| Today's stop, mid-text                              | SIGTERM: exit 143, no `result`, partial text lost; resume adds `No response requested.`; model says it "declined" | `taskkill /T /F`: exit 1, no `result`, partial text lost; same resume and same "declined" answer                                                                                          |
| Today's stop, mid-tool                              | SIGTERM: Claude Code kills the tree and records `Exit code 137` with partial stdout; resume shows it              | `taskkill /T /F`: nothing recorded after the `tool_use`; resume adds "Tool call interrupted… outcome is unknown"; the Git Bash script survives and completes                              |
| Codex `turn/interrupt`                              | Not re-run in the leftover note; ADR 0035 relies on `turn/completed` `status: "interrupted"`                      | Response `{}` in 92 ms, then `turn/completed` `status: "interrupted"`; thread reused (2 of 2)                                                                                             |
| Codex `turn/steer` with `clientUserMessageId`       | Accepted; `userMessage` item carries the `clientId`                                                               | Same; taken after the streamed answer, answered in the same Turn (2 of 2)                                                                                                                 |
| Codex empty-input `turn/start` on an idle thread    | Accepted; no `userMessage` item; model answers from history                                                       | Same (2 of 2)                                                                                                                                                                             |
| Codex leftover steer race                           | 6 of 22 at 0 ms after the Stop hook's `hook/completed`                                                            | Not attempted                                                                                                                                                                             |

## Against ADR 0035

These Observed results differ from what ADR 0035 states. The note makes no recommendation.

- **"kills the foreground tool tree."** On Windows, the raw `interrupt` did not kill a script that
  Claude Code's Bash tool ran through Git Bash. The script ran to completion in 6 of 6 runs, while
  the model was told the call was rejected and said it never ran. It did kill the PowerShell
  tool's tree and a native command that the Bash tool started directly.
- **"a shell the model moved to the background may outlive it until the Session closes."** On
  Windows, a background Bash task's script outlived the Session's process as well.
- **The SIGTERM fallback.** On Windows, today's fallback is Secant's `taskkill /T /F`, not SIGTERM.
  It also misses the Git Bash script. After it, the resumed model sees "outcome is unknown" rather
  than a killed tool's `Exit code 137`. The ADR's statement that the fallback loses partial
  streamed text holds on Windows.

Everything else the ADR relies on held on Windows. The raw `interrupt` answered without
`initialize`, ended the Turn with a `result`, kept the process, Session, and partial text, and
cancelled a pending bridge approval with `notifications/cancelled`. `cancel_queued` handed the
queued frame back. Pickup at the tool round's end and next-exchange delivery during text both
held, as did `command_lifecycle` frames. For Codex, `turn/interrupt`, `turn/steer` with
`clientUserMessageId`, and an empty `turn/start` all held.

## Still Unknown

- Whether Claude Code 2.1.284, the Linux version, behaves differently on Windows. Only 2.1.283 was
  installed here.
- Why the Git Bash script's Windows parent pid is dead. The Cygwin fork and exec explanation is
  **Inferred**. It was not traced, and neither was whether a `CLAUDE_CODE_GIT_BASH_PATH` or
  other shell setting changes it.
- Which other Bash-tool commands escape the tree: a pipeline, `bash -c`, `npm`, `bun`, or a
  command that runs a `.sh` through `sh`. Only a script run as `./slowjob.sh` escaped, and only
  one direct native command was tried.
- Whether a Windows Job Object or a later Claude Code release would make `taskkill /T` reach
  these processes.
- SIGINT, or `GenerateConsoleCtrlEvent`, to a hidden Windows Claude Code child. Neither was
  tried, since ADR 0035 uses neither.
- Whether a user frame is taken between calls in a multi-call round on Windows, and whether the
  denial-boundary timing of Linux round 3 holds. Neither was repeated.
- Why W3a's `started` came 194 ms after the `tool_result`, against 15 to 33 ms on Linux, and
  whether that widens the window in which a frame written near a boundary misses the Turn.
- The Codex leftover race on Windows, and whether its hit rate differs from Linux.
- Whether Codex keeps any of an interrupted Turn's partial agent message in history. The next
  Turn's model said it had written nothing, in 2 of 2 runs.
- Whether Codex's `turn/interrupt` stops a running shell command's process tree on Windows. W6
  interrupted only streamed text.
