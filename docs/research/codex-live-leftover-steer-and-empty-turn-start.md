# Codex Live Leftover Steer and Empty Turn Start

Research date: 2026-09-29

Harness version examined: Codex **codex-cli 0.157.1** (installed standalone build, Linux x64, `codex --version` returned `codex-cli 0.157.1`),
source read at upstream tag `rust-v0.157.1`, commit
[`36650394c5b38c2990ccf2a3457165ca3e9d9726`](https://github.com/openai/codex/commit/36650394c5b38c2990ccf2a3457165ca3e9d9726).

Ticket: [#255](https://github.com/secantdev/secant/issues/255). This note runs live `codex app-server` sessions to settle three questions that
[Harness Interrupt and Queued Messages](harness-interrupt-and-queued-messages.md) left open and that ADR 0035 (on `docs/interrupt-steer`) depends
on. ADR 0035 says that when Codex takes a steered text into history after its last model request and completes the Turn without answering it,
the Codex Adapter re-delivers that leftover with a native `turn/start`. It would use an empty input if Codex accepts one, and the same text
otherwise.

## Answer

**1. Codex accepts an empty-input `turn/start` on an idle thread, and the model answers the leftover.** `turn/start` with `input: []` returns a
normal `{ turn }`. Codex then emits `turn/started`, no `userMessage` item, one model response, and `turn/completed` `status: "completed"`. The
model responds to whatever the history already holds. With a leftover steer at the end of the history, it answered the steered question in all
4 of 4 runs, and `thread/read` then shows the steered text exactly once. An input of one empty text item is accepted too, but it records an
empty `userMessage` and the model returned an empty reply. While a Turn is active, an empty `turn/start` is refused with
`-32603 "failed to submit turn input: EmptyInput"`, and an empty `turn/steer` with `-32600 "input must not be empty"`.[^empty-src]

**2. The leftover window was reproduced, but not during Stop hooks.** A `turn/steer` sent while a 12-second Stop hook runs is accepted, and Codex
answers it **in the same Turn** (2 of 2 runs). After the hooks, it drains the steer as a `userMessage` with the `clientId`, makes another model
request, runs the Stop hooks again, and only then completes. The source shows why: the regular task re-runs the turn loop whenever pending input
remains after it returns.[^regular-loop] The real window is the gap between that last pending-input check and task finish. A `turn/steer`
written the moment the Stop hook's `hook/completed` arrives hit it in **6 of 22** trials (the pilot's 1 of 2 plus 5 of 20 in the main run). In
those trials Codex accepted the steer, emitted its `userMessage` item with the matching `clientId`, and then sent `turn/completed`
`status: "completed"` with no model output after the item. The other 16 were refused with `-32600 "no active turn to steer"`. With a 1 to 3 ms
delay, all 4 trials were refused.

**3. Re-delivering the same text writes it into history twice.** Given a leftover, `turn/start` with the same text (and the same
`clientUserMessageId`) is answered normally. `thread/read` then lists two `userMessage` items with the same text and the same `clientId`: one in
the leftover Turn and one in the re-delivery Turn. Asked how many times it had been asked the question, the model answered `2` (2 of 2). After an
empty re-delivery it answered `1` (3 of 3; the pilot run asked a different question).

**4. Nothing experimental was used.** Every method, field, and notification in these runs is in the stable schema that the installed binary
generates (`codex app-server generate-json-schema`, without `--experimental`), and every session initialized with
`capabilities.experimentalApi: false`. `TurnStartParams.input` is a plain array with no `minItems`, both there and in Secant's recorded fixture
`tests/harness/fixtures/codex/codex-qualification/stable-schema.generated.json`. Only the test setup was out of the ordinary: the Stop hook was
added through the per-thread `config` override `bypass_hook_trust: true`, which Codex flags as dangerous (see Method).

## Evidence Vocabulary

- **Observed**: seen in these live runs, quoted from the raw frames.
- **Not observed**: looked for in these runs and absent.
- **Source-observed**: read in the Codex source at the commit above.
- **Untested**: implied by the source but not run.

## Method

A Python driver spawned `codex app-server` (stdio JSONL) in a throwaway working directory under the session scratchpad, not in the repository.
It sent Secant's handshake from `src/harness/codex/qualification.ts`:

```json
{"method":"initialize","params":{"clientInfo":{"name":"secant","title":"Secant","version":"0.0.0-dev"},"capabilities":{"experimentalApi":false}}}
{"method":"initialized"}
```

It then sent `thread/start {cwd}` and `turn/start {threadId, input:[{type:"text",text}], model}` in the shape `src/harness/codex.ts` uses, and
`turn/steer {threadId, expectedTurnId, input, clientUserMessageId}`, the ADR 0035 shape. It logged every frame with a millisecond offset
(`t`, seconds since spawn below). Any server request would have been declined automatically.

Differences from Secant's launch:

- Every `turn/start` also set `effort: "low"` to keep cost down. Secant sets no effort. The model was `gpt-6-luna` ("Fast and affordable model
  for easier tasks" in `model/list`), not the user's configured `gpt-6-sol`.
- The user's real `~/.codex` was the Codex home, unmodified, as in Secant's user-compatible launch. Its `hooks.json` registers
  Orca command hooks, including `SessionStart`, `UserPromptSubmit`, and `Stop`. They ran on every Turn and appear in the frames. Its MCP servers
  (`context7`, `codex_apps`, and two that failed to start) loaded too.
- To keep a Turn open during a Stop hook, experiment 2 started its threads with a per-thread config override:

  ```json
  {
    "bypass_hook_trust": true,
    "hooks.Stop": [
      { "hooks": [{ "type": "command", "command": "sleep 12", "timeout": 60 }] }
    ]
  }
  ```

  The race variant used the same override with `"command": "true"`. Hooks from a config layer run only when they are trusted, and a
  `bypass_hook_trust` request override lifts that gate for the session.[^hook-trust] Codex answered with
  `configWarning` "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation." The hook ran
  from the `sessionFlags` source (`"sourcePath": "/<session-flags>/config.toml"`). No file in `~/.codex` was written by hand, and
  `config.toml` and `hooks.json` kept their earlier modification times. Codex still wrote its own session rollouts, as any run does.

- No temporary `CODEX_HOME` was needed, so none was created and `auth.json` was never touched.
- Every `codex app-server` the driver started exited when the driver closed stdin. The only `codex` processes left afterwards predate the runs:
  the user's 0.158.0 app-server daemon, the VS Code extension, and an interactive `codex resume`.

## Experiment 1: empty-input `turn/start`

Each run used one thread and three Turns, one after another, each started after the previous `turn/completed`.

**Observed.** T1 `"Remember the code word ZEBRA-42. Reply with just: OK"` completed with `OK`. T2 then sent `input: []`:

```text
[4.748] out turn/start {"threadId":"…d1ad6","input":[],"model":"gpt-6-luna","effort":"low"}
[4.778] in  response {"turn":{"id":"…d1d46","items":[],"status":"inProgress",…}}
[4.781] in  turn/started {"turn":{"id":"…d1d46",…}}
[6.187] in  item/completed agentMessage text="OK"
[6.224] in  hook/started stop (user hooks.json)
[6.247] in  turn/completed {"turn":{"id":"…d1d46","status":"completed","error":null,…}}
```

- **Not observed** in T2: a `userMessage` item, or a `UserPromptSubmit` hook run. Both appear in T1 and in T3.
- The model's reply repeated T1's answer: with no new input, it answered the last user message in history again.
- `thread/read` (`includeTurns: true`) lists T2 as `completed` with only `agentMessage "OK"`.

T3 sent `input: [{"type":"text","text":""}]`. Codex recorded
`userMessage content=[{"type":"text","text":"","text_elements":[]}]`, ran the `UserPromptSubmit` hook, and the model returned
`agentMessage text=""`. `turn/completed` had `status: "completed"` and `items: []`.

**Addendum, fresh thread (1 run).** An empty `turn/start` as the first Turn of a new thread was also accepted. With no user message in history,
the model made up a task from the injected context. It wrote a commentary message ("I'll check the current Codex docs and your local config
guidance first…"), called two `context7` MCP tools, tried a shell command (which failed), and gave a final answer about running Codex subagents in
parallel.

**Observed, empty input during an active Turn** (experiment 2 mode `c`, sent while the Stop hook ran):

```text
[7.440] turn/steer {"expectedTurnId":"…dd47","input":[]}  -> {"error":{"code":-32600,"message":"input must not be empty"}}
[7.442] turn/start {"input":[]}                           -> {"error":{"code":-32603,"message":"failed to submit turn input: EmptyInput"}}
```

The Turn then completed normally with `ALPHA`.

**Source-observed.** `start_or_steer` treats an empty `UserInput` as `has_explicit_input = false`. With no active Turn, it spawns the regular
task without pushing any input, so the model request is built from the existing history alone. With an active Turn, `steer_input` returns
`EmptyInput`, which `turn/start` reports as `failed to submit turn input: EmptyInput`.[^empty-src]

## Experiment 2: reproducing a leftover steer

### 2a. Steer during a Stop hook (answered in the same Turn)

Prompt `"Reply with just: ALPHA"`. The driver waited for the session-flags Stop hook's `hook/started`, then 1 s, then sent
`turn/steer` with `clientUserMessageId: "secant-steer-n2"`. Run `n2` (run `n1` matched it):

```text
[ 6.108] item/completed agentMessage text="ALPHA"
[ 6.144] hook/started   stop  sourcePath=/<session-flags>/config.toml  (sleep 12)
[ 7.146] turn/steer -> {"result":{"turnId":"…b256"}}
[18.146] hook/completed stop
[18.202] item/completed userMessage clientId="secant-steer-n2" "New question: what is 17+25? Reply with just the number."
[19.944] item/completed agentMessage text="42"
[19.977] hook/started   stop  (second run of the Stop hooks)
[31.985] hook/completed stop
[31.993] turn/completed {"turn":{"id":"…b256","status":"completed",…}}
```

**Observed.** A steer sent during a Stop hook is accepted, drained after the hooks, and answered within the same Turn, and the Stop hooks run
again. `thread/read` shows one Turn holding `userMessage ALPHA`, `agentMessage ALPHA`, `userMessage (clientId secant-steer-n2) 17+25`,
`agentMessage 42`. So a Stop hook does not open a leftover window at this version. The pending-input check that runs before the Stop hooks sees
nothing, but the regular task checks again after `run_turn` returns and re-enters it with the pending input.[^regular-loop]

### 2b. Steer at the Stop hook's `hook/completed` (the leftover)

The window left is the gap between that final check (`regular.rs` line 120) and `on_task_finished`. There Codex takes the active task and then
records any pending input to history, running `UserPromptSubmit` hooks on it and emitting its `userMessage` item.[^task-finish] To aim at it, the
driver used a fresh thread per trial with a no-op session-flags Stop hook (`true`). The reader thread wrote `turn/steer` as soon as it parsed
the first Stop `hook/completed` of the Turn (0 ms delay), or after a fixed delay.

| Delay after Stop `hook/completed` | Trials | Leftover (accepted, item, no answer) | Refused `no active turn to steer` | Answered in the Turn |
| --------------------------------- | -----: | -----------------------------------: | --------------------------------: | -------------------: |
| 0 ms (pilot and main run)         |     22 |                                    6 |                                16 |                    0 |
| 1 ms                              |      2 |                                    0 |                                 2 |                    0 |
| 3 ms                              |      2 |                                    0 |                                 2 |                    0 |

Hit rate at 0 ms: 6 of 22 (27%). The steer response always came back within 1 to 2 ms. By the server's own `emittedAtMs` stamps,
`turn/completed` followed the Stop `hook/completed` by 3 to 6 ms in refused trials and by 43 to 58 ms in leftover trials. The extra time is
spent recording the leftover, including the user's `UserPromptSubmit` hook.

**Observed, decisive frames** (trial `r0-0`, emitted in this order within about 4 ms):

```json
{"method":"item/started","params":{"item":{"type":"userMessage","id":"01a0ebee-5b21-…","clientId":"secant-steer-r0-0","content":[{"type":"text","text":"New question: what is 17+25? Reply with just the number.","text_elements":[]}]},"turnId":"01a0ebee-3d03-…"}}
{"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a0ebee-5b21-…","clientId":"secant-steer-r0-0",…},"turnId":"01a0ebee-3d03-…"}}
{"method":"turn/completed","params":{"turn":{"id":"01a0ebee-3d03-…","items":[{"type":"agentMessage","text":"OK","phase":"final_answer",…}],"itemsView":"summary","status":"completed","error":null,…}}}
```

- The `turn/steer` response was `{"result":{"turnId":"01a0ebee-3d03-…"}}`, the same success shape as a delivered steer.
- **Not observed** after the item: any `agentMessage`, any further model request, or any `error` notification.
- The `turn/completed` summary lists only the final `agentMessage`. It never lists `userMessage` items in any Turn.
- `thread/read` places the leftover `userMessage` inside the completed Turn, after `agentMessage "OK"`.
- In the pilot trial, the user's `UserPromptSubmit` hook ran between the steer and the leftover item.

**Source-observed, not reproduced.** The regular task also returns early, without re-checking pending input, when the Turn has a terminal
error. Pending input then reaches `on_task_finished` the same way, which is the "failing Turn" case.[^regular-loop] Post-turn compaction runs
inside `run_turn` before it returns, so the same re-check covers it. That case is Untested.

## Experiment 3: re-delivery of a leftover

Each leftover in 2b was followed on the same thread by a re-delivery `turn/start`, then an account Turn. The account Turn asked: "Ignore any
AGENTS.md or environment context. Counting only messages I typed in this chat before this one: how many times did I ask you what 17+25 is? Reply
with just the number." After that came a `thread/read`. The pilot asked for the messages listed verbatim instead, and the model listed its
injected AGENTS.md context, so only its `thread/read` counts.

### 3a. Empty input (4 leftovers: pilot, `r0-0`, `r0-14`, `r0-19`)

```text
out turn/start {"threadId":"…20fa68","input":[],"model":"gpt-6-luna","effort":"low"}
in  response  {"turn":{"id":"01a0ebee-5b2d-…","status":"inProgress",…}}
in  item/completed agentMessage text="42"   phase=final_answer
in  turn/completed {"turn":{"id":"01a0ebee-5b2d-…","status":"completed",…}}
account Turn -> "1"
thread/read:
  TURN …3d03 completed: userMessage "Reply with just: OK" | agentMessage "OK" | userMessage clientId=secant-steer-r0-0 "New question: what is 17+25? …"
  TURN …5b2d completed: agentMessage "42"
```

**Observed.** In 4 of 4 runs, the empty `turn/start` produced an answer to the leftover (`42`) with no new `userMessage` item. The steered text
appears once in history, and the model counted it once in 3 of 3 account Turns.

### 3b. Same text and same `clientUserMessageId` (2 leftovers: `r0-2`, `r0-17`)

```text
out turn/start {"input":[{"type":"text","text":"New question: what is 17+25? Reply with just the number."}],"clientUserMessageId":"secant-steer-r0-2",…}
in  item/completed userMessage clientId="secant-steer-r0-2" "New question: what is 17+25? …"
in  item/completed agentMessage text="42"
in  turn/completed status=completed
account Turn -> "2"
thread/read:
  TURN …8b66 completed: userMessage "Reply with just: OK" | agentMessage "OK" | userMessage clientId=secant-steer-r0-2 "New question: what is 17+25? …"
  TURN …9b50 completed: userMessage clientId=secant-steer-r0-2 "New question: what is 17+25? …" | agentMessage "42"
```

**Observed.** In 2 of 2 runs, the same-text re-delivery is answered. History then holds the text twice, as two `userMessage` items with the same
`clientId` in two Turns, and Codex did not de-duplicate on `clientUserMessageId`. The model counted the question twice in both account Turns.

## Unknowns and caveats

- The race hit rate depends on this host and on the user's hooks. The Orca `UserPromptSubmit` hook lengthens the finishing path, and a client
  that is not reacting to `hook/completed` will land in the window only by chance. The rate is not a property of Codex.
- The failing-Turn path (terminal error, then pending input recorded at task finish) was read in source and not reproduced.
- Only one model (`gpt-6-luna`, effort `low`) was used, with trivial prompts. Whether larger models answer the leftover as reliably after an
  empty `turn/start` is Untested. In a longer history, an empty start makes the model respond to "whatever history holds", which was a
  made-up task on a thread with no user message.
- Timestamps are the client's read times, rounded to 1 ms, except where `emittedAtMs` is named.
- The Stop hook in experiment 2 depended on `bypass_hook_trust` and the session-flags hook layer. Secant uses neither. They were only a way to
  open the window on purpose.

## Primary Sources

[^empty-src]: OpenAI Codex source at `36650394`: [`core/src/session/turn_input.rs` lines 289-300](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn_input.rs#L289-L300) (`has_explicit_input`), [lines 356-362](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn_input.rs#L356-L362) (an empty input spawns the task with no pushed input), [lines 632-638 and 665-667](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn_input.rs#L632-L667) (`NoActiveTurn`, `EmptyInput` in `steer_input`); [`app-server/src/request_processors/turn_processor.rs` lines 596-620 and 672-682](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/request_processors/turn_processor.rs#L596-L682) (`turn/start` input mapping and `failed to submit turn input: {reason:?}`), [lines 1084-1085 and 1133-1134](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/request_processors/turn_processor.rs#L1084-L1134) (`turn/steer` errors `no active turn to steer`, `input must not be empty`).

[^regular-loop]: OpenAI Codex source, [`core/src/tasks/regular.rs` lines 104-122](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tasks/regular.rs#L104-L122) (loop over `run_turn`, early return on `terminal_error`, re-run while `has_pending_input`); [`core/src/session/turn.rs` lines 551-563 and 640-733](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn.rs#L551-L733) (post-sampling pending-input check, then Stop hooks and post-turn compaction before `break`).

[^task-finish]: OpenAI Codex source, [`core/src/tasks/mod.rs` lines 621-684](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tasks/mod.rs#L621-L684) (`on_task_finished` takes the task, takes pending input, and records it via `run_hooks_and_record_inputs`); [`core/src/session/turn.rs` lines 839-887](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/turn.rs#L839-L887) (`UserPromptSubmit` inspection, then `record_pending_input`).

[^hook-trust]: OpenAI Codex source, [`app-server/src/config_manager.rs` lines 438-445](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/config_manager.rs#L438-L445) (`bypass_hook_trust` request override), [`hooks/src/engine/discovery.rs` lines 714-719 and 831](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/hooks/src/engine/discovery.rs#L714-L831) (only trusted, managed, or bypassed handlers run; `SessionFlags` hook source), [`config/src/hook_config.rs` lines 19-25 and 57-58](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/config/src/hook_config.rs#L19-L58) (`hooks.<Event>` and `hooks.state` in config), [`features/src/lib.rs` lines 1211-1216](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/features/src/lib.rs#L1211-L1216) (`hooks` feature stable, on by default).
