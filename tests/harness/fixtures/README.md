# Recorded Harness fixtures

Byte-faithful recordings of a real installed Harness, replayed in CI so the
Adapter is exercised against exactly what it saw once — never a fake in place of
a spawn (ADR 0027). The `claude` replayer (`../replayer.mjs`) reads these; the
structural step (`bun run structure:check`) fails any case directory missing
its `recording.json`.

## Layout

```
fixtures/<harness>/<case>/
  recording.json    provenance sidecar (six required keys, below)
  case.json         replay script the replayer executes
  *.stdout          byte-faithful stdout chunks case.json references
  *.stderr          optional byte-faithful stderr chunks
  workspace.patch   optional git diff the replayer applies at the Turn's result
  *.patch           optional working-area diffs (`workingAreaPatch`, below)
```

## `recording.json` (sidecar)

Six keys, all required (the structural step enforces their presence):

- `harness` — e.g. `"claude-code"`.
- `executableVersion` — full `claude --version` string at record time.
- `protocolVersion` — `claude_code_version` reported in the init frame.
- `recordedAt` — ISO-8601 instant, or `"synthetic"` for a hand-authored case.
- `redactions` — array of `{ "placeholder", "reason" }`, one per substitution class
  the recorder applied (home directory, user name, bridge token, credential).
- `refreshCommand` — the opt-in command that re-records this case, or a
  `"synthetic — ..."` note for hand-authored cases.

## `case.json` (replay script)

- A `bridge` step may instead name `{ server, tool, arguments, expect? }` (#371), selecting the named MCP config entry and checking the exact tool reply.
  Permission steps retain `{ tool_name, input }`. An `elicitationReply: { requestId }` step waits for the matching native decline response.
  A `control` step's optional `requestId` identifies which recorded id to remap, preserving unrelated elicitation withdrawal ids.
- `settings` (#347) — a sticky `{ "stdout": "settings.stdout" }` reply to `get_settings`, echoing the request id; `{ "unanswered": true }` models a timeout.
  Settings-only probes use `--no-session-persistence`, carry no Session id or user frame, and never advance `sessions[]`. Ordinary cases use the
  separately recorded `settings` or `settings-locked` reply, selected by the inherited `xhigh` lock. Other controls still require explicit steps.
- `exitCode` — the process exit code the replayer settles with.
- `turns[]` — one entry per stdin Turn frame the Adapter sends:
  - `stdout` / `stderr` — a byte file emitted for the whole Turn, **or**
  - `steps[]` — an ordered mix of `{ "emit": "file" }` (stdout bytes),
    `{ "bridge": { tool_name, input } }` / `{ "bridgeAll": [ ... ] }` (a real MCP
    permission round-trip that blocks until Secant answers), so recorded stdout
    after a bridge step emits only once the verdict is in, and
    `{ "control": { "subtype", "cancelQueued"?, "emit"? } }` (#346), which blocks
    until the Adapter writes a stdin `control_request` of that subtype (with
    `cancel_queued: true` when `cancelQueued` is set), then emits `emit`
    with every recorded `request_id` replaced by the Adapter-minted one (as
    `session_id` is echoed), and `{ "steer": { "uuid" } }` (#359), which blocks
    until the Adapter writes a mid-Turn `user` frame and then replaces the
    recorded Steer `uuid` with the Adapter-minted one in every later byte. A control step without `emit` swallows the request:
    it models a Claude Code that never confirms, so the Adapter falls back to
    the process stop. On the recorded `resume` case it overlays that fallback on
    bytes recorded with a SIGTERM stop. stdin is read while steps run, so a
    control request may arrive before its step; one that arrives once the Turn
    has no control step left fails the replay. A bridge call answered "request
    expired" skips to the Turn's next control step, or exits 0 without one.
  - `uuid` — the uuid the recorder stamped on this Turn's prompt (#359); the
    replayer swaps in the Adapter's from the Turn frame, as for a Steer.
  - `before` — `control` specs (as above) taken between the previous Turn and
    this Turn's prompt (#348), such as a Model choice change to a reused child.
    A `get_settings` control step, in `steps` or `before`, takes the next
    `get_settings` while that window is open and emits its recorded read-back;
    every other `get_settings` still takes the sticky `settings` reply.
  - `workspacePatch` — a git diff file the replayer `git apply`s in the launch
    cwd as the Turn concludes (the "applied at the Turn's result" step).
  - `workingAreaPatch` — the same, applied in the launch's `--add-dir` directory
    (the Run working area); the replay fails if the launch carries none.
  - `exitAfter` — exit right after this Turn's bytes (models lost/corruption).
  - `ignoreSigterm` — swallow SIGTERM so only a force-kill stops the process.
- `backgroundTree` — a synthetic Turn option naming the Windows descendant worker and its PID-report file. The Codex Turn is acknowledged before descendant startup; its PID report is published atomically and precedes native content. Runtime tree tests wait for that report, not optional Model observation.
- `resume` — a separate `{ exitCode, turns }` played when the launch carries
  `--resume` (a reattached, detached Session).
- `sessions[]` — optional later fresh Sessions: the Nth `--session-id` launch
  after the first plays `sessions[N-1]`, a `{ exitCode, turns }` of its own (one
  conversation per human-controlled Repeat iteration). Without it, every fresh
  launch replays the initial recording.

Session ids are **not** redacted: Secant mints the session UUID and passes it at
spawn, so each recording is made with the canonical per-case UUID its tests use,
and the recorded frames echo it verbatim. The bridge bearer token never appears
in stdout (it rides only in `--mcp-config` argv); the recorder still scans for it.

## Recording (opt-in, local, needs the installed Harness)

`bun tests/harness/record.ts <case>` drives the named scenario against the
installed `claude`, reproducing the Adapter's exact launch argv and an equivalent
loopback MCP approve-bridge, then writes the case directory. It records with
`--restricted` (the real login and model apply, but this host's hooks, plugins,
`CLAUDE.md`, and settings-file MCP do not) so fixtures are clean and reproducible;
scoping `CLAUDE_CONFIG_DIR` instead would drop the login. The account's
claude.ai connectors still load under `--restricted` (a held-open process lists
them in a later Turn's init), so the recorder also sets
`ENABLE_CLAUDEAI_MCP_SERVERS=false`. It never runs in CI.

The recorder refuses to write a recording whose bytes still match a credential
pattern after redaction, naming the pattern — a recording must not carry a live
secret.

The `interrupt` case holds one process's stdin open: it writes the first Turn,
sends a `control_request` `interrupt` once text streams, sends the next Turn
once the aborted `result` arrives, then closes stdin. stdout is split at the
line boundary where each stdin frame was written.

The `steer-within`, `steer-boundary`, `steer-cancel`, and `compaction` cases
(#359), and `interrupt` since #359, hold stdin open through one shared helper.
Their prompts and Steers carry recorder uuids (`9a0e0000-…-00000000000N` and
`5eee0000-…-00000000000N`) the replayer swaps for the Adapter's; the older
single-Turn cases send unstamped prompts, so their results list no uuid. A Steer
lands in a tool round because the recorder holds that round's Write approval
while it writes the Steer; replay emits the bytes around the Steer and raises
no approval, so the approval wait is a recording device, not replayed
behaviour. `compaction` sends `/compact` twice as its own Turn: the first is
interrupted mid-compaction, the second compacts. Automatic compaction is not
recorded (it needs a near-full context window); the scripted Claude in
`claude-code-steer.test.ts` covers its frames.

## Codex replay

Codex records the Adapter's pinned schema/probe revision in `protocolVersion`;
app-server has no negotiated protocol version. The Codex replayer separately
models `--version`, stable `app-server generate-json-schema`, and one stdio JSONL
app-server child. A real case replays its ordered `stdin`, `stdout`, and `stderr`
entries strictly: every client line must match before the next native bytes are
emitted. `workspace-patch` entries apply their Git patch before the recorded
terminal Turn event. The replayer substitutes only the recorded `«WORKSPACE»`
path; it does not fabricate ids, requests, controls, or terminal facts.

Qualification contains only pre-thread traffic: `initialize`, `initialized`,
`account/read`, and `model/list`, then the `config/read` defaults read the qualify
path adds (#341). It must not contain `thread/*`, `turn/*`, prompt, or input
content. Real completion, approval, Steer, Interrupt, resume, authentication, and
Test Repair cases extend the handshake without `config/read`, since a Run's
prepare never reads the defaults; a synthetic replay therefore plays the
qualification traffic only up to `config/read` and answers it from `responses`
when a test asks.

`agent-calls` and `agent-calls-legacy` record on codex-cli 0.160.0 with `codex-probe-4`. The opt-in recorder uses the production Secant listener
and a fixture MCP server for approvals and form/link elicitations. Its pass-through shim adds only the fixture server and, for the legacy case,
disables `tool_call_mcp_elicitation`; requests and replies are real Codex traffic. Session URL and bearer are redacted. Strict replay substitutes
only that dynamic attachment and reissues the recorded Secant tool call over authenticated HTTP. Older start/resume recordings omit the reviewer;
replay requires the new explicit `user` reviewer before comparing their remaining fields. Refresh with `bun tests/harness/record-codex.ts agent-calls`
or `bun tests/harness/record-codex.ts agent-calls-legacy` on macOS or Linux with an authenticated Codex install.

Every real Turn case carries the Turn's `thread/read` right after the
`turn/start` response (#345); `two-turns` also requests `gpt-5.5` at `low`, then
`medium`, so its `turn/start` frames carry effort and each read reports it back.
`test-repair` requests `gpt-5.5` at `high` (#342), the default `codex-qualification`
reports, so a flagless smoke launch qualified against that case replays it.
In `test-repair` Codex refused that first read while the fresh thread's rollout
was still empty, and the read sent again at the Turn's next item answered.
A synthetic replay holds the rest of a Turn until its `thread/read` arrives, as
Codex answers it within milliseconds, then answers with the thread's latest
`turn/start` model and effort (else `recorded-model` with no effort), or with a
case's `threadRead` (a `{model, effort}` answer, `rpc-error`, `malformed`, or
`stall`; `rpc-error-once` refuses the first read, emits the user message, and
holds the Turn until the next). A case's `turn.reroute` (`{toModel, at, foreignTurn?}`) emits
`model/rerouted` before or after that read is answered.

The two qualification cases record against a temporary Codex home under the
user's home directory (Codex warns about one under the temp folder on its
`--version` output) that holds only a link to the user's `auth.json` and a known
`config.toml`: `codex-qualification` names `gpt-5.5` at `high` (reported
defaults), and `codex-qualification-unconfigured` names no model (the `model/list`
default stands in). The user's own configuration never reaches a recording. The
approval recorder uses a temporary pass-through executable with the per-process
`approvals_reviewer=user` Codex override; it does not change user configuration
or broaden Secant's one-time `allow` decision.

The `codex-qualification` case carries the installed binary's complete generated
stable schema as `stable-schema.generated.json`, plus its byte-faithful, redacted
pre-thread response lines. The generated file is intentionally not formatted or
reviewed as handwritten source. Claude Code has no analogue because its CLI does
not expose a schema-generation qualification command; its native evidence is the
recorded stdout stream instead. Refresh one case with
`bun tests/harness/record-codex.ts <case>` while logged in through Codex; omitting
the case refreshes `codex-qualification`. Authentication uses an empty temporary
`CODEX_HOME`. The qualification and Turn cases are recorded on codex-cli 0.160.0
and authentication on 0.155.0; every case shares the `codex-qualification`
schema. Replay is deterministic Adapter evidence on all three CI operating
systems, not a claim that the currently installed real Codex remains compatible.

The leftover Steer cases (#357) catch a race: Codex takes a Steer after its last
pending-input check, writes its `userMessage`, and completes with no model output.
The recorder sends the Steer the moment the first native turn's Stop hook reports
`hook/completed` and re-records the whole session until Codex leaves the Steer
over instead of refusing or answering it. Like `steer`, they run against the
user's own Codex home, which must define a Stop hook, so these recordings carry
that home's hook runs and MCP server names (paths redacted), unlike the
qualification cases. On Linux x64 the #345 refresh took 10 attempts for `steer-leftover` and
14 for `steer-leftover-resend`. A real Codex accepts empty input on an idle thread, so
`steer-leftover-resend` records through a pass-through app-server that refuses the
first empty-input `turn/start` with the bytes Codex sends for empty input on a busy
thread (`-32603 failed to submit turn input: EmptyInput`, seen on 0.157.1). That
one response line is injected; every other byte, including the re-sent text's
answer, is the real app-server's.

## Synthetic cases

Some Adapter behaviours a real `claude` cannot be made to emit on demand:
`error_max_budget_usd` failure, an init-less process, a process that answers no
interrupt and swallows SIGTERM, a mid-frame exit, queued multi-Turn budget failure, and the specific
concurrent/outstanding permission-bridge shapes. These stay hand-authored, moved
into this tree with a `recording.json` whose `recordedAt` is `"synthetic"` and
whose `refreshCommand` explains why. They preserve the coverage the deleted
`protocol-cases/` tree carried.

**Re-evaluate later:** if a future `claude` gains a deterministic way to induce
any of these (a fault-injection flag, a `--max-budget`, a documented corruption
mode), promote that case from synthetic to a real recording and delete its
synthetic note. The synthetic inventory below is the pick-up list.

| Case                      | Behaviour                                                                                              | Why synthetic                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `failed`                  | terminal `error_during_execution` result                                                               | no on-demand way to force a task error result                 |
| `two-turns`               | two Turns, second `error_max_budget_usd`                                                               | no on-demand budget-exhaustion trigger                        |
| `no-init`                 | process never emits init                                                                               | no way to make a real init hang deterministically             |
| `unresponsive`            | leaves the interrupt unanswered, then swallows SIGTERM → force-kill, reported escalated (every OS)     | a real `claude` answers the interrupt and honours SIGTERM     |
| `lost-completion`         | exits mid-stream with no result                                                                        | timing-dependent; kept deterministic as synthetic             |
| `approval`                | one Bash approval, allow/deny/expired                                                                  | real tool inputs vary run to run                              |
| `approval-concurrent`     | two coexisting approvals                                                                               | real runs raise one prompt at a time                          |
| `approval-outstanding`    | an approval left outstanding at close, or interrupted and answered `aborted_tools`                     | timing-dependent                                              |
| `codex-approval-contract` | colliding client/server ids plus concurrent command and file approvals                                 | exact id collision and concurrency are not reliably inducible |
| `model-rerouted`          | `thread/read` reports a model and effort, then `model/rerouted` replaces the model for that Turn       | Codex reroutes only for `highRiskCyberActivity`               |
| `resume-unacknowledged`   | an unanswered interrupt falls back; the resume init echoes a different id                              | a real `--resume` acknowledges the id                         |
| `completed`               | success Turn: tool activity, thinking/telemetry exclusion, preview coalescing, unknown-frame tolerance | a real plain Turn does not emit every frame variety on demand |
| `completed-quotes-login`  | success result whose text quotes "run /login"                                                          | guards that a real answer is not misread as auth              |
| `incompatibility`         | initialize omits one required response field                                                           | a compatible real Codex cannot emit this fault on demand      |
| `model-change-unanswered` | `model-change` bytes with every change control swallowed, so the next Turn relaunches with `--resume`  | a real Claude Code answers every typed control                |

The synthetic `interrupt-recovery` and `compaction-recovery` cases reuse the
original recorded bytes and add a replacement-process `resume` section for
Windows confirm-then-reap recovery. They are not recordings of Windows recovery.
The synthetic Codex replayer's `completeAfterResume` permits a replacement's
follow-up to complete, and `completedTurnsBeforeBlock` establishes multiple
Sessions before the interrupted Turn. Its `backgroundTree` option reports
escaped Git Bash descendants before native acceptance for handle-based cleanup
checks. Strict recorded Codex `resume` remains a POSIX same-server scenario.

`model-change` (#348) is a Claude Code 2.1.289 recording on one held process launched with `--model haiku --effort low`. While Turn 1 waits on its
Write approval, the recorder sends `set_model`, `apply_flag_settings`, and a `get_settings` read-back, each after the last answered; the Turn's next reply
runs on Sonnet. Before Turn 2 an unknown `set_model` is refused with `catalog_unknown`, and Turn 2 still runs. A separate `--resume --model --effort`
launch supplies the `resume` section. Control replies are cut from the Turn bytes into their own files, and `get_settings` replies keep only `applied`.
The recorder also writes the synthetic `model-change-unanswered` from the same bytes. Refresh both with `bun tests/harness/record.ts model-change`.

The #371 channel cases are native Claude Code 2.1.289 recordings. Refresh each with `bun tests/harness/record.ts` followed by `agent-call`,
`elicitation-declined`, or `elicitation-withdrawn`. The recorder uses an empty temporary Workspace, the production channel attachment, and a loopback
setup tool; withdrawal is generated by a real native Interrupt while its elicitation is pending.

The #417 Codex Thought cases record codex-cli 0.160.1 on Linux x64 using the
production Adapter. `thought-summary-configured` uses an isolated Codex home
with `gpt-6.1-sol` and `model_reasoning_summary = "concise"`.
`thought-summary-unconfigured` uses that model with no summary preference.
`thought-summary` inherits the host configuration. None overrides reasoning effort.
The recorder sets only its temporary home's configuration, never user files or a
production summary setting. Refresh with `bun tests/harness/record-codex.ts`
followed by the case name. Their fact qualification and remaining gaps are in
[message-facts-provenance.md](../message-facts-provenance.md).
