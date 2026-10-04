# Claude Code Live Model and Effort Switch

Research date: 2026-09-28

Harness version examined: Claude Code **2.1.283** (installed native executable, Linux
x64; `claude --version` returned `2.1.283 (Claude Code)`).

Ticket: [#245](https://github.com/secantdev/secant/issues/245). This note settles
the Claude Code items left **Unknown** in
[Harness Model and Effort Controls](harness-model-effort-controls.md) by running a
small live model session against the installed CLI.

## Answer

**Between Turns, `/model <name>` and `/effort <level>` work in a live
`claude -p --input-format stream-json` process, and each returns one cheap
`result` frame.** Claude Code runs the command locally: it emits a `system/init`,
one `assistant` frame with `message.model: "<synthetic>"`, and a `result` with
`num_turns: 0`, `local_command: "model"` or `"effort"`, zero usage, and the command
output as `result`. The next Turn's `system/init.model`, `assistant.message.model`,
and a new `result.modelUsage` key all name the new model. An unknown model is
refused at once with `Model '<name>' not found`, still as `subtype: "success"` and
`is_error: false`, and the session keeps its old model.

**Mid-Turn, both commands are queued, not run and not shown to the model.** A
`/model sonnet` frame written while a Bash tool call ran did not change the
second model call of that Turn. It ran right after the Turn's `result`, and it was
never shown to the model as text. `/effort` behaved the same way.

**On `--resume`, the launch flags win.** `--resume <id> --model haiku` ran Haiku
even though the transcript's last Turn used Sonnet. `--resume <id> --effort low`
set the session effort to `low` (`/effort status`).

**The typed control requests work without the SDK `initialize`.** A raw `-p` process
answered `set_model`, `apply_flag_settings`, and `get_settings` with
`control_response` success, even before the first user frame. The next Turn used
the new model. An unknown model came back as a typed error with
`error_code: "catalog_unknown"`. `get_settings.applied` reports the model and effort
in effect; `applied.effort` is `null` on Haiku 4.5.

Effort itself never appears in the host stream. The level can only be read back
with `/effort status` (the configured level) or `get_settings.applied.effort` (the
level in effect for the current model).

## Evidence Vocabulary

- **Recorded (2.1.283)**: seen in the live frame sequence captured for this note on
  2026-09-28 against Claude Code 2.1.283. Every fact below without another label is
  Recorded (2.1.283).
- **Documented**: stated in current official Anthropic documentation, cited through
  [Harness Model and Effort Controls](harness-model-effort-controls.md).
- **Inferred**: a consequence drawn from Recorded facts; it needs a check before it
  becomes a compatibility promise.
- **Unknown**: not settled by these runs.

## Method

A small Bun driver spawned `claude` with the same stream flags that
`src/harness/claude-code.ts` uses:

```text
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --model <alias> [--session-id <uuid> | --resume <uuid>]
```

It wrote user frames in the Adapter's `encodeTurn` shape,
`{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null}`,
and logged every stdout line with a millisecond offset. `stream_event` partials were
counted and not kept. Each process ran in a fresh temporary directory as cwd, not in
the repository. Prompts were one line ("Reply with the single word OK").

Differences from Secant's launch:

- Secant adds the loopback MCP permission bridge (`--mcp-config`,
  `--permission-prompt-tool`). The driver did not. For the mid-Turn tests it passed
  `--allowedTools "Bash(sleep:*)" "Bash(echo:*)"` so one Bash call could run
  without a prompt. Permission mode stayed `default`.
- The host's user settings set `effortLevel: "high"` and a `SessionStart` hook.
  Because of that setting, `/effort high` was a no-op at first, so test 5 was
  repeated with `/effort low`.
- The first runs (tests 1 to 5 and 7) inherited `CLAUDE_CODE_*` variables from the
  parent Claude Code session that ran the driver. The later runs (5b, 6, 7b) removed
  them. No behavior differed between the two groups.
- `apiKeySource` was `none` (subscription login). `total_cost_usd` is Claude Code's
  own estimate.

Frame excerpts below are trimmed. `t` is milliseconds since spawn. Hook, rate-limit,
and `thinking_tokens` frames are omitted.

## Test 1: `/model` between Turns

Launch `--model haiku`, Turn 1, then `/model sonnet`, then Turn 2.

```text
t=509   system/init model=claude-haiku-4-5-20251001 session=f91818f9-…
t=2634  assistant model=claude-haiku-4-5-20251001 text "OK"
t=2668  result/success num_turns=1 result="OK" total_cost_usd=0.0178
t=2669  in  user "/model sonnet"
t=2691  system/init model=claude-haiku-4-5-20251001
t=2691  assistant model=<synthetic> text "Set model to `Sonnet 5` for this session only"
t=2693  result/success is_error=false num_turns=0 local_command="model"
        result="Set model to `Sonnet 5` for this session only"
        total_cost_usd=0.0178 usage.output_tokens=0 duration_api_ms=0
        stop_reason=null modelUsage={haiku}
t=2693  in  user "Reply with the single word OK"
t=2719  system/init model=claude-sonnet-5
t=4524  assistant model=claude-sonnet-5 text "OK"
t=4566  result/success num_turns=1 total_cost_usd=0.0711
        modelUsage={claude-haiku-4-5-20251001, claude-sonnet-5}
```

- The command gives one `result` with `num_turns: 0` and a `local_command` field
  that names the command. It costs nothing and returns in about 20 ms.
- The command's own `system/init` still names the old model. The switch shows up in
  the next Turn's `system/init`.
- `result.total_cost_usd` and `result.modelUsage` are totals for the whole process,
  not for one Turn. After the switch, `modelUsage` holds both models.
- The first Sonnet request wrote 12,359 new cache tokens, which matches the
  documented cache miss on a model change.
- The transcript records the command as a user message with
  `<command-name>/model</command-name>` and `<command-args>sonnet</command-args>`,
  followed by `local-command-stdout` and `commandRun: {command, args}` entries.

## Test 2: `/effort` between Turns

In the same process (now on Sonnet): `/effort high`, `/effort status`, then a Turn.

```text
t=4577  system/init model=claude-sonnet-5
t=4578  assistant model=<synthetic> text "Set effort level to high (this session only):
        Comprehensive implementation with extensive testing and documentation"
t=4579  result/success num_turns=0 local_command="effort" result="Set effort level to high …"
t=4588  system/init model=claude-sonnet-5
t=4588  assistant model=<synthetic> text "Current effort level: high (…)"
t=4589  result/success num_turns=0 local_command="effort" result="Current effort level: high (…)"
t=4622  system/init model=claude-sonnet-5 per_turn_effort_active=false
t=6897  assistant model=claude-sonnet-5 text "OK"
t=6949  result/success num_turns=1
```

- Both commands have the same frame shape as `/model`.
- No `system/init`, `assistant`, or `result` field names the effort level.
  `per_turn_effort_active` was `false` on every `system/init`. The only read-back is
  the `/effort status` text.
- The user settings already set `high`, so this change did nothing observable. Test
  5b and test 6 show `low` taking effect.

## Test 3: invalid model

Fresh process, `--model haiku`, then `/model not-a-real-model-xyz`, then a Turn.

```text
t=1024  system/init model=claude-haiku-4-5-20251001
t=1024  assistant model=<synthetic> text "Model 'not-a-real-model-xyz' not found"
t=1026  result/success is_error=false num_turns=0 local_command="model"
        result="Model 'not-a-real-model-xyz' not found"
t=1064  system/init model=claude-haiku-4-5-20251001
t=3051  assistant model=claude-haiku-4-5-20251001 text "OK"
t=3118  result/success num_turns=1
```

- `/model` checks the name as it runs. It rejects an unknown model and keeps the
  current one. The next Turn runs normally on Haiku.
- The rejection is only text: `subtype` is `success` and `is_error` is `false`. A
  host can tell refusal from success only by the `result` string. **Inferred.**

## Test 4: `/model` during a Turn

Fresh process, `--model haiku`. The Turn asks for `sleep 8 && echo done` through
Bash. The `/model sonnet` frame is written 2 s after the `tool_use` frame, while the
command runs.

```text
t=3635  assistant model=claude-haiku-4-5-20251001 tool_use {"command":"sleep 8 && echo done"}
t=5637  in  user "/model sonnet"
t=6695  system/task_started task_type=local_bash
t=11698 system/task_notification status=completed
t=11724 user tool_result "done"
t=11733 system/status requesting
t=14017 assistant model=claude-haiku-4-5-20251001 text "I'm Claude Haiku 4.5."
t=14051 result/success num_turns=2 queued_turn_count=0 result_index=0
t=14073 system/init model=claude-haiku-4-5-20251001
t=14074 assistant model=<synthetic> text "Set model to `Sonnet 5` for this session only"
t=14075 result/success num_turns=0 local_command="model" result_index=1
t=22080 system/init model=claude-sonnet-5
t=23772 assistant model=claude-sonnet-5 text "OK"
t=23802 result/success num_turns=1 result_index=2
```

- **Queued, then run after the Turn.** The model call after the tool result still
  used Haiku, and the model called itself Haiku 4.5. The command's own `result`
  came 24 ms after the Turn's `result`. The Turn after that ran on Sonnet.
- **Not shown to the model.** The text `/model sonnet` appears only on the input
  line. The model's reply does not mention it.
- The Turn's `result` reported `queued_turn_count: 0` even though the command was
  waiting. `result_index` numbers every `result` in the process, command results
  included.
- This does not match the documented claim that these commands "take effect without
  waiting for the current response to finish" (see
  [Harness Model and Effort Controls](harness-model-effort-controls.md)). On 2.1.283
  in `-p` stream-json mode, a mid-Turn `/model` waited for the Turn to end.

## Test 5: `/effort` during a Turn

First run (5): `/effort high`, the same level the user settings already set. Second
run (5b, `--model haiku`): `/effort status`, the same Bash Turn, `/effort low` 2 s
after `tool_use`, then `/effort status`.

```text
t=418   assistant model=<synthetic> text "Current effort level: high (…)"
t=4370  assistant model=claude-haiku-4-5-20251001 tool_use {"command":"sleep 8 && echo done"}
t=6370  in  user "/effort low"
t=12448 user tool_result "done"
t=14133 assistant model=claude-haiku-4-5-20251001 text "OK"
t=14154 result/success num_turns=2
t=14164 system/init model=claude-haiku-4-5-20251001
t=14164 assistant model=<synthetic> text "Set effort level to low (this session only): …"
t=14165 result/success num_turns=0 local_command="effort"
t=22165 assistant model=<synthetic> text "Current effort level: low (…)"
```

- Queued the same way as `/model`: the command's `result` follows the Turn's
  `result`, and the model never saw the text.
- Whether the rest of that Turn used the new effort cannot be seen. No frame names
  effort, and Haiku 4.5 does not apply effort at all (`get_settings.applied.effort`
  is `null` on Haiku; see test 7). The ordering of `result` frames is the only
  evidence that the command waited.

## Test 6: `--resume` with `--model` and `--effort`

Session `f91818f9-…` from test 1 ended on Sonnet. Two relaunches from the same cwd,
one after the other.

`--resume f91818f9-… --model haiku`:

```text
t=464   system/init model=claude-haiku-4-5-20251001 session=f91818f9-…
t=465   result/success num_turns=0 local_command="effort" result="Current effort level: high (…)"
        total_cost_usd=0.0913 modelUsage={claude-haiku-4-5-20251001, claude-sonnet-5}
t=25093 assistant model=claude-haiku-4-5-20251001 text "OK"
t=25135 result/success num_turns=1 total_cost_usd=0.1109
```

`--resume f91818f9-… --effort low` (no `--model`):

```text
t=516   system/init model=claude-haiku-4-5-20251001
t=516   assistant model=<synthetic> text "Current effort level: low (…)"
t=3398  assistant model=claude-haiku-4-5-20251001 text "OK"
t=3421  result/success num_turns=1 total_cost_usd=0.1142
```

- **`--model` on resume overrides the transcript's model.** Both `system/init.model`
  and `assistant.message.model` named Haiku after a transcript whose last Turn ran on
  Sonnet.
- **`--effort` on resume applies.** `/effort status` reported `low`, where the user
  settings say `high`.
- Without `--model`, the second relaunch ran Haiku, the model of the transcript's
  last Turn (from the first relaunch). This matches the documented "resume keeps
  the transcript model". It does not rule out other sources, because the user
  settings name no model.
- A resumed process starts `total_cost_usd` and `modelUsage` from the transcript's
  totals, not from zero. The first `result` after the resume already showed $0.0913
  and both models.

## Test 7: typed control requests without `initialize`

Fresh process `--model haiku`. The driver wrote control requests before any user
frame, with no SDK `initialize`.

```text
t=1    in  {"type":"control_request","request_id":"t3a","request":{"subtype":"get_settings"}}
t=458  control_response success t3a applied={"model":"claude-haiku-4-5-20251001","effort":null,…}
t=459  in  {"type":"control_request","request_id":"t1","request":{"subtype":"set_model","model":"sonnet"}}
t=467  control_response {"subtype":"success","request_id":"t1"}
t=467  in  {… "request":{"subtype":"apply_flag_settings","settings":{"effortLevel":"high"}}}
t=479  control_response {"subtype":"success","request_id":"t2"}
t=485  control_response success t3 applied={"model":"claude-sonnet-5","effort":"high",…}
t=524  system/init model=claude-sonnet-5
t=526  result/success local_command="effort" result="Current effort level: high (…)"
t=2868 assistant model=claude-sonnet-5 text "OK"
t=2900 result/success num_turns=1 modelUsage={claude-sonnet-5}
t=2900 in  {… "request":{"subtype":"set_model","model":"not-a-real-model-xyz"}}
t=3321 control_response {"subtype":"error","request_id":"t4",
        "error":"Model 'not-a-real-model-xyz' not found","error_code":"catalog_unknown"}
```

A second process (7b, `--model sonnet`, no Turn, no cost) read `get_settings` around
further changes:

```text
g1  applied={"model":"claude-sonnet-5","effort":"high","advisor":null,"ultracode":false}
m1  set_model haiku           -> success
g2  applied={"model":"claude-haiku-4-5-20251001","effort":null,…}
e1  apply_flag_settings low   -> success
g3  applied={"model":"claude-haiku-4-5-20251001","effort":null,…}
    /effort status            -> "Current effort level: low (…)"
```

- **No `initialize` is needed.** The process answers control requests at once, even
  before its first `system/init`.
- `set_model` changed the model for the next Turn; no Haiku Turn ran at all. It
  checks the name: an unknown model returns a typed `error` with
  `error_code: "catalog_unknown"`. A successful `set_model` or
  `apply_flag_settings` returns no body.
- `get_settings` returns `effective`, `sources`, `applied`, and
  `remote_control_policy_lock_reason`. After `apply_flag_settings`, `sources` gains a
  `flagSettings` entry holding `effortLevel`.
- `applied.effort` is the effort in effect for the current model, and it is `null`
  on Haiku 4.5. `/effort status` reports the configured level (`high` or `low`) for
  every model.
- A typed request sent during a Turn was not tested.

## Capability Table

| Capability                          | Control on the raw `-p` stream                          | Result on 2.1.283                                                                                              | Evidence                                        |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Change model between Turns          | User frame `/model <name>`                              | One `result` with `num_turns: 0`, `local_command: "model"`; the next Turn uses the new model                   | Recorded (2.1.283)                              |
| Change effort between Turns         | User frame `/effort <level>`                            | One `result` with `local_command: "effort"`; the level can only be read back as text                           | Recorded (2.1.283)                              |
| Read effort                         | `/effort status`; `get_settings.applied.effort`         | Configured level as text; level in effect, `null` on Haiku 4.5                                                 | Recorded (2.1.283)                              |
| Reject an unknown model             | `/model <bad>`                                          | Text `Model '<bad>' not found` in a `success` result; model unchanged                                          | Recorded (2.1.283)                              |
| Change model or effort mid-Turn     | `/model` or `/effort` frame written while a Turn runs   | Queued; runs right after the Turn's `result`; never shown to the model                                         | Recorded (2.1.283)                              |
| Override model on resume            | `--resume <id> --model <name>`                          | Launch flag wins over the transcript's model                                                                   | Recorded (2.1.283)                              |
| Override effort on resume           | `--resume <id> --effort <level>`                        | Applies (`/effort status` reports it)                                                                          | Recorded (2.1.283)                              |
| Typed model change                  | `control_request` `set_model`                           | `control_response` success without `initialize`; next Turn uses it; bad name is `error` with `catalog_unknown` | Recorded (2.1.283)                              |
| Typed effort change                 | `control_request` `apply_flag_settings` `{effortLevel}` | `control_response` success; shows in `get_settings.applied.effort` and `/effort status`                        | Recorded (2.1.283)                              |
| Report the effective model per Turn | `system/init.model`, `assistant.message.model`          | Both change on the first Turn after a switch; a command's own init shows the old model                         | Recorded (2.1.283)                              |
| Cost and usage per Turn             | `result.total_cost_usd`, `result.modelUsage`            | Process totals, restored from the transcript on resume; a Turn's cost is the difference from the last `result` | Recorded (2.1.283); Inferred for the difference |

## Unknowns

- Whether a typed `set_model` sent during a Turn changes the next model call of
  that Turn, as the SDK docs say it does from 2.1.212. Only `set_model` between
  Turns was tested. **Settled on 2.1.289 by #348**: a `set_model` and
  `apply_flag_settings` sent while a Turn waited on a tool approval answered
  success, `get_settings` read the new model and effort back, and the Turn's
  next reply ran on the new model (the `model-change` fixture). A `get_settings`
  pipelined right behind `set_model` still read the old model, so each request
  waits for the reply before it.
- What happens to a queued `/model` or `/effort` when the Turn is interrupted or
  the process ends before the Turn's `result`.
- Whether `-p` mode's queueing of slash commands during a Turn is fixed behavior or
  depends on the flag that the docs say governed it before 2.1.242.
- Whether a mid-Turn `/effort` changes effort for the rest of that Turn on a model
  that supports effort. Only Haiku 4.5, which ignores effort, was used mid-Turn.
- The effect of an effort change on output. The short prompts produced no thinking
  or length difference worth reading.
- Which model a `--resume` without `--model` picks when the user settings or an
  organization default name a model. These settings named none.
