# Harness Model and Effort Controls

Research date: 2026-09-27

Harness versions examined:

- Claude Code **2.1.283** (installed native executable, Linux x64), the
  `@anthropic-ai/claude-agent-sdk` **0.3.283** package that bundles Claude Code
  2.1.283, and Secant's recorded stream-json fixtures from Claude Code 2.1.273 and
  2.1.281.
- Codex **codex-cli 0.157.1** (installed, Linux x64), upstream tag `rust-v0.157.1` at
  commit
  [`36650394c5b38c2990ccf2a3457165ca3e9d9726`](https://github.com/openai/codex/commit/36650394c5b38c2990ccf2a3457165ca3e9d9726),
  and Secant's recorded app-server fixtures from codex-cli 0.155.0.

Ticket: [#240](https://github.com/secantdev/secant/issues/240)

## Answer

**Codex app-server: yes, on the stable surface, with a thin read-back.** `model/list`
returns every picker-visible model with `supportedReasoningEfforts` and a
`defaultReasoningEffort`. `turn/start` accepts `model` and `effort` fields that
override the setting for that Turn and stay as the thread's defaults for later Turns.
Both are documented and appear in the stable generated schema; neither needs
`experimentalApi`.[^cx-models-doc][^cx-turn-doc][^cx-turn-src] Dedicated setters
exist (`thread/settings/update` between Turns, `turn/settings/update` inside a Turn),
but both are experimental.[^cx-common-src] On the stable surface, only the
`thread/start` and `thread/resume` responses name the configured model and effort
(`model`, `reasoningEffort`). After a `turn/start` override, no stable notification
names the new values: `turn/started` and `turn/completed` carry no model or effort,
and `thread/settings/updated` is experimental, so the server drops it for connections
that did not opt in. A stable client can call `thread/read`. Its `thread.model` and
`thread.reasoningEffort` are the current _configured_ values, and the schema says they
are "not per-turn execution telemetry". `model/rerouted` reports a reroute on the
service side for each Turn.[^cx-thread-src][^cx-thread-data-src][^cx-transport-src][^cx-events-doc]
Per-Turn `model` and `effort` on `turn/start` are present from `rust-v0.56.0` (absent
at `rust-v0.55.0`). The app-server command as a whole is still documented as
experimental.[^cx-app-doc]

**Claude Code direct stream: listing is SDK-internal. Switching has one documented
path, and effort is not reported back.** The raw `claude -p` stream has no documented
way to list models or effort levels. The model catalog with `supportedEffortLevels`
is documented only as the Agent SDK's `supportedModels()`. That method returns the
`models` field of the SDK's `initialize` control response, and the raw CLI contract
does not publish that exchange.[^cc-sdk-ts][^cc-sdk-mjs] The only documented way to
change model or effort between Turns of one live `-p` process is to send
`/model <name>` or `/effort <level>` as prompt text (Claude Code v2.1.205 or later).
The change applies to that session only and returns a command result, not a typed
acknowledgement.[^cc-headless][^cc-commands][^cc-sdk-slash] The typed setters
(`setModel()`, `applyFlagSettings({ effortLevel })`) are documented only as SDK
methods in streaming input mode. Their wire form is `control_request` subtypes
`set_model` and `apply_flag_settings`, found in the SDK's code and type bundle and in
the CLI's own schema but not in the CLI reference. That makes them
SDK-internal.[^cc-sdk-ts][^cc-sdk-dts][^cc-bin] Claude Code reports the effective
model in `system/init` (sent again on each Turn in the 2.1.281 recordings), on each
assistant message, and in `result.modelUsage`. It reports no effective effort level
in the stream a host reads. The documented `effort` field on `system/init` is set
only for Remote Control clients. The `per_turn_effort_active` flag seen in recordings
is an `@internal` cache-behavior boolean, not a level. Effort readback is documented
only in hook input, the `$CLAUDE_EFFORT` variable, the status line, and
`/effort status`.[^cc-sdk-ts][^cc-headless-init][^cc-hooks][^cc-bin][^fx-claude]

## Evidence Vocabulary

- **Documented**: stated in current official Anthropic or OpenAI documentation.
- **Schema-published**: present in the JSON Schema that the installed Codex binary
  generates for the stable surface (`codex app-server generate-json-schema`).
- **SDK-internal**: a raw wire control that the Agent SDK uses and types, and that
  no public CLI or protocol reference documents as a host contract.
- **Source-observed**: present in first-party source, a type bundle, or schema
  strings compiled into the executable.
- **Locally observed**: seen directly on this host from `--help`, `--version`, or
  schema output. No model session was started.
- **Recorded**: present in Secant's committed Harness fixtures.
- **Unknown**: not settled by the allowed sources.

## Method and Local Observations

Only harmless commands ran: `claude --version` returned `2.1.283 (Claude Code)`,
`claude --help`, `codex --version` returned `codex-cli 0.157.1`,
`codex app-server --help`, and
`codex app-server generate-json-schema --out <dir>` ran both with and without
`--experimental`. The Claude Code native executable was searched as bytes for
compiled schema strings. It was not run for this search. For Codex minimum versions,
the protocol source files were fetched at release tags and checked for each control.
Tags are coarse, so each bound is "present at X, absent at Y".

Secant today uses neither Harness's effort control. The Claude Code Adapter passes
`--model` at launch only and declares free-text selection
(`modelSelection.at: "launch"`). It keeps one `-p` process alive across Turns and
sends no control requests.[^secant-claude] The Codex Adapter keeps only the non-hidden
`model` ids from `model/list`. It sends `model` on `turn/start`, never sends `effort`,
initializes with `experimentalApi: false`, and reads the effective model from
`thread/start` or `thread/resume`.[^secant-codex]

## Claude Code: Direct Structured CLI Stream

### Listing models and effort levels

- **Documented absence on the raw CLI.** `claude --help` (2.1.283) lists no
  subcommand or flag that prints available models. `--model` takes "an alias … or a
  model's full name". `--effort` lists `low, medium, high, xhigh, max` as fixed help
  text, not as a per-model query.[^local-claude-help]
- **Documented static tables.** Model-configuration docs publish the alias table
  (`default`, `best`, `fable`, `sonnet`, `opus`, `haiku`, `[1m]` variants,
  `opusplan`) and a per-model effort table. For example, Opus 5.5 supports
  `low`–`max` and defaults to `medium`; Opus 4.6 has no `xhigh`. A level the model
  does not support falls back to the highest supported level at or below it.
  `availableModels` and organization caps can narrow both lists.[^cc-model-config]
- **Documented only as SDK methods.** `Query.supportedModels()` returns `ModelInfo[]`
  with `value`, `resolvedModel` (v2.1.197+), `supportsEffort`,
  `supportedEffortLevels`, `supportsAdaptiveThinking`, and `supportsFastMode`.
  `initializationResult()` returns the same `models` inside
  `SDKControlInitializeResponse`.[^cc-sdk-ts]
- **SDK-internal wire.** In SDK 0.3.283, `supportedModels()` returns the cached
  `initialize` response's `.models`. The request is a
  `{ type: "control_request", request_id, request: { subtype: "initialize", … } }`
  line written to the CLI's stdin.[^cc-sdk-mjs] A separate `list_models` control
  subtype exists. Its own description says it serves "a remote thin-client
  session".[^cc-sdk-dts][^cc-bin] The earlier Secant research already classed the
  `initialize` exchange as SDK-internal.[^prior-claude]

### Changing model and effort between Turns

**At launch (documented).** `--model` sets the session model and overrides the
`model` setting and `ANTHROPIC_MODEL`. `--effort` sets the session effort, overrides
`modelSettings` and `effortLevel`, and does not persist. The `ultracode` value needs
v2.1.203 or later.[^cc-cli-ref] The environment variable `CLAUDE_CODE_EFFORT_LEVEL`
overrides both `--effort` and `/effort`.[^cc-env] The Agent SDK itself maps its
`model` and `effort` options onto these same flags when it spawns the CLI.[^cc-sdk-mjs]

**In the live stream: slash commands (documented).**

- In `-p` mode, "`/model`, `/effort`, `/fast`, `/color`, and `/rename` accept the
  value as an argument, for example `/model sonnet`", and need Claude Code v2.1.205
  or later.[^cc-headless] A command is sent "by including it in your prompt string".
  Built-in commands run inside the Claude Code process, not as a model
  Turn.[^cc-sdk-slash]
- `/model <name>` in `-p` "applies to the current session only and isn't saved as
  your default". Project settings, managed settings, and an organization default
  still apply again on the next launch.[^cc-model-config-set]
- `/effort <level>` in `-p` applies to that session only and is not saved.
  `/effort status` prints the level, and the command "Works in `-p`". `max` and
  `ultracode` are session-only.[^cc-model-config-effort][^cc-commands]
- Both commands take effect without waiting for the current response to finish,
  after any cache confirmation. Before v2.1.242, a feature flag fetched from
  Anthropic decided whether they ran mid-Turn or queued.[^cc-commands]
- The docs do not specify what frame the stream returns for these commands: the
  result text, whether it counts as a Turn, or whether a new `system/init` follows.
  This is **Unknown**.

**In the live stream: typed control requests (SDK-internal).**

- The docs describe `setModel(model?)`, `applyFlagSettings(settings)`, and the
  deprecated `setMaxThinkingTokens()` as `Query` methods that work "only … in
  streaming input mode". `applyFlagSettings` is TypeScript-only.[^cc-sdk-ts]
  Timing: `model` applies during the current Turn, from the next model call (before
  v2.1.212 it waited for the next Turn). `effortLevel`, `ultracode`, and `fastMode`
  apply on the next Turn. `effortLevel: null` goes back to the model's default
  effort, not to the launch option.[^cc-sdk-ts-flags]
- The SDK checks a model string passed to `setModel()` before saving it. That check
  needs Claude Code v2.1.200 or later.[^cc-model-config]
- On the wire, SDK 0.3.283 sends `{ subtype: "set_model", model }`,
  `{ subtype: "apply_flag_settings", settings }`, and
  `{ subtype: "set_max_thinking_tokens", max_thinking_tokens, thinking_display }`.
  All three use the same `control_request` envelope.[^cc-sdk-mjs] The SDK types
  describe `set_model` as "Sets the model to use for subsequent conversation turns".
  The installed 2.1.283 executable holds matching compiled schemas for `set_model`,
  `apply_flag_settings`, `get_settings`, and `list_models`.[^cc-sdk-dts][^cc-bin]
- The public SDK docs mention "a client that drives the CLI's control protocol
  directly" and parsing "the wire protocol yourself" in two places (interrupt
  `cancel_queued` and `pending_permission_requests`). They document no raw shape or
  compatibility promise for `set_model` or `apply_flag_settings`, and the CLI
  reference never mentions `control_request`.[^cc-sdk-ts][^cc-cli-ref]
- The allowed sources do not say whether a raw `-p` process accepts these requests
  before the SDK's `initialize`. This is **Unknown**, and it was not tested.

**Side effects the host sees (documented).** Changing model, or changing effort on
most models, makes the next request re-read the whole conversation without cache
hits. On Opus 5.5 and Fable 5.1 with an API key or a Claude subscription, an effort
change keeps the cache.[^cc-caching] On resume, Claude Code keeps the transcript's model regardless of
the `model` setting.[^cc-model-config-set] When a safety classifier flags a request,
Fable, Opus 5.5, and Opus 5 sessions can move to a fallback model for the rest of
the session without the host asking.[^cc-fallback]

### What Claude Code reports back

| Report                          | What it carries                                                                                                                                                                                                                                                  | Status                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `system/init.model`             | The session model, for example `claude-opus-5-5[1m]`. The 2.1.281 recordings show a fresh `system/init` at the start of each Turn in one live process, and the CLI schema describes "the per-turn init of headless stream-json runs … the newest frame wins".    | Documented field; per-Turn repeat Recorded, Source-observed[^cc-headless-init][^fx-claude][^cc-bin] |
| `assistant.message.model`       | The model that produced each assistant message. The SDK docs example reads it per Turn to confirm a `setModel()` switch.                                                                                                                                         | Documented, Recorded[^cc-sdk-config][^fx-claude]                                                    |
| `result.modelUsage`             | Totals keyed by model, including subagent and compaction calls. `canonicalModel` and `provider` need v2.1.218 or later. The docs say to read the actual model from it.                                                                                           | Documented, Recorded[^cc-sdk-ts-result][^cc-model-config-warn][^fx-claude]                          |
| `system/model_refusal_fallback` | `original_model`, `fallback_model`, and `scope` (`session` or `local`) when a refusal is retried on a fallback model.                                                                                                                                            | Source-observed in SDK types only[^cc-sdk-dts]                                                      |
| `system/init.effort`            | "The effort level Claude Code sends on the session's next request", but "Claude Code sets the field only on the init message it sends to Remote Control clients, and omits it from the init message your application reads".                                     | Documented as absent for this transport[^cc-sdk-ts-init]                                            |
| `per_turn_effort_active`        | An `@internal` boolean. It says whether an effort change keeps the prompt cache for this frame's model, not which level is in effect. It is paired with an internal `system/per_turn_effort_changed` frame. Recorded as `true` in 2.1.281 and absent in 2.1.273. | SDK-internal, Recorded[^cc-bin][^fx-claude]                                                         |
| `get_settings` → `applied`      | `applied.model` and `applied.effort`: "Runtime-resolved values … what will actually be sent to the API". Not a public `Query` method.                                                                                                                            | SDK-internal[^cc-bin][^cc-sdk-dts]                                                                  |
| Hook input `effort.level`       | The level "in effect when the hook runs", after fallback to a supported level, for tool-use-context events. Also exposed as `$CLAUDE_EFFORT` to hook commands and the Bash tool. It matches the status line `effort` field.                                      | Documented; not a stream frame[^cc-hooks]                                                           |
| `/effort status`                | Prints the current level. Works in `-p`; the output format is not specified.                                                                                                                                                                                     | Documented[^cc-commands]                                                                            |

## Codex: App-Server

### Listing models and effort levels

- **Documented.** `model/list` lists "available models … with effort options". Each
  entry can carry `supportedReasoningEfforts` ("supported effort options for the
  model"), `defaultReasoningEffort` ("suggested default effort for clients"),
  `hidden`, and `isDefault`. The docs say models, efforts, and defaults "depend on the
  client and account".[^cx-models-doc]
- **Schema-published.** In the 0.157.1 stable schema, `Model` requires
  `supportedReasoningEfforts` (an array of `{ reasoningEffort, description }`) and
  `defaultReasoningEffort`. `ReasoningEffort` is "A non-empty reasoning effort value
  advertised by the model": a free string, not an enum. It is the same in the
  recorded 0.155.0 schema.[^local-codex-schema][^fx-codex-schema][^cx-model-src]
- **Recorded.** The 0.155.0 qualification recording lists five models. For example,
  default `gpt-6-astra` offers `low, medium, high, xhigh, max, ultra` with default
  `medium`; `gpt-5.6-sol` defaults to `low`; `gpt-5.5` offers `low` to `xhigh`.
  Secant parses the response and ignores both effort fields.[^fx-codex-qual][^secant-codex]
- The config key `model_reasoning_effort` accepts efforts "such as `low`, `medium`,
  `high`, `xhigh`, `max`, or `ultra`. Available levels depend on the model and
  client".[^cx-config-doc]

### Changing model and effort between Turns

- **`turn/start` fields (documented, stable).** "You can override configuration
  settings per turn (model, effort, personality, `cwd`, sandbox policy, summary). When
  specified, these settings become the defaults for later turns on the same
  thread."[^cx-turn-doc] The schema describes `model` and `effort` as "Override the …
  for this turn and subsequent turns". They are not gated by
  `experimentalApi`.[^cx-turn-src][^local-codex-schema] An experimental
  `collaborationMode` field on the same request "takes precedence over model,
  reasoning_effort, and developer instructions if set".[^cx-turn-src]
- **`thread/start` and `thread/resume` (stable).** Both accept `model`. Neither has a
  typed `effort` parameter on the stable schema. Both accept an untyped `config` map,
  and the documented config key for effort is
  `model_reasoning_effort`.[^cx-thread-src][^cx-config-doc] Launch-wide overrides are
  also possible with `codex app-server -c key=value`.[^local-codex-help]
- **Dedicated setters (experimental).** `thread/settings/update` overrides `model`,
  `effort`, `summary`, `serviceTier`, and others "for subsequent turns".
  `turn/settings/update` changes `model` and `effort` for the running Turn only.
  `collaborationMode/list` lists presets. All three are marked experimental in source
  and appear only in the `--experimental` schema.[^cx-common-src][^cx-thread-src][^cx-turn-src][^local-codex-schema]
  A client that has not opted in gets `<descriptor> requires experimentalApi
capability`.[^cx-experimental-doc]
- The sources do not say whether `turn/start` rejects or clamps an `effort` that the
  target model's `supportedReasoningEfforts` does not list. This is **Unknown**.

### What Codex reports back

| Report                                                  | What it carries                                                                                                                                                                                                                                                         | Status                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `thread/start` and `thread/resume` responses            | `model` (required) and `reasoningEffort` (nullable), with the same fields on `thread`. Recorded values in 0.155.0: `gpt-5.6-sol` and `medium`.                                                                                                                          | Schema-published, Recorded[^cx-thread-src][^fx-codex-turns]                                              |
| `thread/read` (stable) → `thread`                       | `model`: "Current configured model when loaded … This is not per-turn execution telemetry". `reasoningEffort` carries the same caveat.                                                                                                                                  | Schema-published[^cx-thread-data-src][^local-codex-schema]                                               |
| `turn/start` response, `turn/started`, `turn/completed` | The `Turn` object (`id`, `items`, `status`, timings, `error`) has no model or effort.                                                                                                                                                                                   | Schema-published, Recorded[^local-codex-schema][^fx-codex-turns]                                         |
| `thread/settings/updated`                               | The full `threadSettings`, including `model` and `effort`, sent when applied settings change. Marked experimental, and the transport drops experimental notifications for connections without `experimentalApi`, even though the stable schema bundle lists the method. | Source-observed; not delivered to Secant's connection[^cx-common-src][^cx-events-src][^cx-transport-src] |
| `model/rerouted`                                        | `{ threadId, turnId, fromModel, toModel, reason }` "when the service routes a request to another model". The only reason value is `highRiskCyberActivity`.                                                                                                              | Documented, Schema-published[^cx-events-doc][^local-codex-schema]                                        |
| `model/safetyBuffering/updated`                         | `model` and `fasterModel` for a Turn that enters safety buffering.                                                                                                                                                                                                      | Documented[^cx-events-doc]                                                                               |

## Minimum Versions

**Claude Code** (from the docs' own version notes):

| Control or report                                             | Minimum                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `--model`, `--effort` with named levels                       | Not stated; both present in 2.1.283 `--help`                        |
| `--effort ultracode`, or SDK `effortLevel: "ultracode"`       | 2.1.203[^cc-model-config-effort]                                    |
| `/model <name>` and `/effort <level>` in `-p`                 | 2.1.205[^cc-headless]                                               |
| `/model` and `/effort` mid-Turn regardless of feature flags   | 2.1.242[^cc-commands]                                               |
| SDK `setModel()` model check                                  | 2.1.200[^cc-model-config]                                           |
| SDK model switch taking effect within the current Turn        | 2.1.212[^cc-sdk-ts-flags]                                           |
| `ModelInfo.resolvedModel`                                     | 2.1.197[^cc-sdk-ts]                                                 |
| `system/init.capabilities`                                    | 2.1.205[^cc-headless-init]                                          |
| `modelUsage.canonicalModel`                                   | 2.1.218[^cc-sdk-ts-result]                                          |
| `per_turn_effort_active`, and `system/init` repeated per Turn | First seen in the 2.1.281 recordings; absent in 2.1.273[^fx-claude] |

**Codex** (from protocol source at release tags; the app-server command is
experimental at every version):

| Control or report                                | Present at      | Absent at       |
| ------------------------------------------------ | --------------- | --------------- |
| `model/list` with supported reasoning efforts    | `rust-v0.48.0`  | `rust-v0.47.0`  |
| `turn/start` `model` and `effort`                | `rust-v0.56.0`  | `rust-v0.55.0`  |
| `reasoningEffort` on the `thread/start` response | `rust-v0.59.0`  | `rust-v0.58.0`  |
| `model/rerouted`                                 | `rust-v0.110.0` | `rust-v0.100.0` |
| `thread/settings/update` (experimental)          | `rust-v0.140.0` | `rust-v0.130.0` |
| `turn/settings/update` (experimental)            | `rust-v0.152.0` | `rust-v0.150.0` |

The early `model/list` presence was checked by method name and field name only. This
research did not confirm that the response shape at `rust-v0.48.0` matches the
current v2 `Model`.

## Recorded Fixture Evidence

- `tests/harness/fixtures/claude-code/matt-front` (2.1.281, recorded
  2026-09-24): `grill-1` and `grill-2` are two stdin Turns to one process. Each
  begins with its own `system/init` (`model: "claude-opus-5-5[1m]"`,
  `per_turn_effort_active: true`, `view_mode: "default"`). Messages carry
  `model: "claude-opus-5-5"`, and `result.modelUsage` is keyed
  `claude-opus-5-5[1m]`. No frame carries an effort level.[^fx-claude]
- `tests/harness/fixtures/claude-code/plain`, `interrupt`, and `resume` (2.1.273):
  `system/init` has no `per_turn_effort_active` or `effort`. `modelUsage` lists both
  `claude-opus-5[1m]` and an auxiliary `claude-haiku-4-5-20251001` call.[^fx-claude]
- Fixtures from 2.1.234 (`two-turns`, `completed`, and others) are hand-authored or
  older and carry neither field.
- `tests/harness/fixtures/codex/codex-qualification` and the other Codex cases
  (0.155.0): `model/list` entries carry `supportedReasoningEfforts` and
  `defaultReasoningEffort`. `thread/start` and `thread/resume` responses carry
  `model` and `reasoningEffort`. `turn/start` requests carry neither `model` nor
  `effort`. `thread/settings/updated` never appears, which matches
  `experimentalApi: false`.[^fx-codex-qual][^fx-codex-turns]

## Unknowns

- Claude Code: whether a raw `claude -p --input-format stream-json` process accepts
  `set_model` or `apply_flag_settings` without the SDK's `initialize` request first.
  No source states it, and testing it would need a model session.
- Claude Code: which frames a `/model` or `/effort` prompt produces in stream-json
  (result text, `num_turns`, a new `system/init`), and whether `/model` in `-p` checks
  the model string. The docs describe that check only for SDK `setModel()`, Remote
  Control, and embedding apps.
- Claude Code: whether `--model` or `--effort` on a `--resume` relaunch overrides
  the model stored in the transcript. The docs say only that resume keeps the
  transcript model "regardless of the current `model` setting".
- Codex: whether `turn/start` rejects, clamps, or passes through an `effort` that the
  target model does not list.
- Codex: any stable push of the configured model or effort after a `turn/start`
  override. Only `thread/read` was found; `thread/settings/updated` is experimental.

## Capability Tables

### Claude Code: direct structured CLI stream

| Capability                   | Control                                                                                                                                                 | Documented or internal                                                  | Min version                          | Evidence                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------- |
| List models                  | None on the raw CLI. SDK `supportedModels()` / `initializationResult().models` over `initialize`                                                        | SDK method documented; wire SDK-internal                                | Not stated                           | [^local-claude-help][^cc-sdk-ts][^cc-sdk-mjs]       |
| List effort levels per model | `ModelInfo.supportedEffortLevels` over `initialize`; static docs table                                                                                  | SDK-internal wire; the table is documented as prose                     | Not stated                           | [^cc-sdk-ts][^cc-model-config]                      |
| Set model at launch          | `--model <alias\|name>`                                                                                                                                 | Documented                                                              | Not stated                           | [^cc-cli-ref][^local-claude-help]                   |
| Set effort at launch         | `--effort <level>`; `CLAUDE_CODE_EFFORT_LEVEL` overrides it                                                                                             | Documented                                                              | Not stated (2.1.203 for `ultracode`) | [^cc-cli-ref][^cc-env]                              |
| Change model between Turns   | Prompt text `/model <name>`                                                                                                                             | Documented (result shape unspecified)                                   | 2.1.205                              | [^cc-headless][^cc-model-config-set]                |
| Change effort between Turns  | Prompt text `/effort <level>`                                                                                                                           | Documented (result shape unspecified)                                   | 2.1.205                              | [^cc-headless][^cc-model-config-effort]             |
| Change model, typed          | `control_request` `set_model`                                                                                                                           | SDK-internal (documented only as SDK `setModel()`)                      | 2.1.200 check; 2.1.212 same-Turn     | [^cc-sdk-ts][^cc-sdk-mjs][^cc-bin]                  |
| Change effort, typed         | `control_request` `apply_flag_settings` `{ effortLevel }`                                                                                               | SDK-internal (documented only as SDK `applyFlagSettings()`)             | Not stated                           | [^cc-sdk-ts-flags][^cc-sdk-mjs][^cc-bin]            |
| Report effective model       | `system/init.model` (per Turn in 2.1.281), `assistant.message.model`, `result.modelUsage`                                                               | Documented; per-Turn init Recorded and Source-observed                  | 2.1.281 observed per Turn            | [^cc-headless-init][^cc-sdk-ts-result][^fx-claude]  |
| Report model fallback        | `system/model_refusal_fallback`                                                                                                                         | Source-observed in SDK types                                            | Not stated                           | [^cc-sdk-dts][^cc-fallback]                         |
| Report effective effort      | Not in the host stream. Internal: `get_settings.applied.effort`. Documented outside the stream: hook `effort.level`, `$CLAUDE_EFFORT`, `/effort status` | Absent (init `effort` is Remote Control only); SDK-internal; Documented | Not stated                           | [^cc-sdk-ts-init][^cc-bin][^cc-hooks][^cc-commands] |

### Codex: app-server

| Capability                   | Control                                                                                                                                             | Documented or internal                                          | Min version                           | Evidence                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| List models                  | `model/list` (`includeHidden`, cursor pagination)                                                                                                   | Documented, Schema-published                                    | `rust-v0.48.0`                        | [^cx-models-doc][^local-codex-schema]                    |
| List effort levels per model | `model/list` → `supportedReasoningEfforts[]`, `defaultReasoningEffort`                                                                              | Documented, Schema-published                                    | `rust-v0.48.0`                        | [^cx-models-doc][^cx-model-src][^fx-codex-qual]          |
| Set model at thread start    | `thread/start` or `thread/resume` `model`                                                                                                           | Documented, Schema-published                                    | Not isolated                          | [^cx-thread-src][^cx-app-doc]                            |
| Set effort at thread start   | `thread/start` `config` map with `model_reasoning_effort`; or `app-server -c`                                                                       | Documented config key; untyped map on the schema                | Not isolated                          | [^cx-thread-src][^cx-config-doc][^local-codex-help]      |
| Change model between Turns   | `turn/start` `model` (sticky for later Turns)                                                                                                       | Documented, Schema-published                                    | `rust-v0.56.0`                        | [^cx-turn-doc][^cx-turn-src]                             |
| Change effort between Turns  | `turn/start` `effort` (sticky for later Turns)                                                                                                      | Documented, Schema-published                                    | `rust-v0.56.0`                        | [^cx-turn-doc][^cx-turn-src]                             |
| Change without a new Turn    | `thread/settings/update`; `turn/settings/update` (active Turn)                                                                                      | Experimental (`experimentalApi` required)                       | `rust-v0.140.0`; `rust-v0.152.0`      | [^cx-common-src][^local-codex-schema]                    |
| Report effective model       | `thread/start` and `thread/resume` `model`; `thread/read` `thread.model` (configured, not telemetry); `model/rerouted` per Turn                     | Schema-published; `model/rerouted` Documented                   | `rust-v0.110.0` for `model/rerouted`  | [^cx-thread-src][^cx-thread-data-src][^cx-events-doc]    |
| Report effective effort      | `thread/start` and `thread/resume` `reasoningEffort`; `thread/read` `thread.reasoningEffort` (configured, not telemetry); `thread/settings/updated` | Schema-published; the notification is experimental and filtered | `rust-v0.59.0` for the response field | [^cx-thread-src][^cx-thread-data-src][^cx-transport-src] |

## Primary Sources

[^cc-headless]: Anthropic, [Run Claude Code programmatically: command support in `-p` mode](https://code.claude.com/docs/en/headless#create-a-commit), note beginning "Command support differs in `-p` mode".

[^cc-headless-init]: Anthropic, [Run Claude Code programmatically: read session metadata](https://code.claude.com/docs/en/headless#read-session-metadata), on `system/init` model and `capabilities` (v2.1.205+).

[^cc-commands]: Anthropic, [Commands](https://code.claude.com/docs/en/commands), rows `/model [model]` and `/effort [level|auto|status]`.

[^cc-model-config]: Anthropic, [Model configuration](https://code.claude.com/docs/en/model-config), sections Model aliases, Restrict model selection, and [Adjust effort level](https://code.claude.com/docs/en/model-config#adjust-effort-level), including the paragraph on `setModel()` string checks (v2.1.200+).

[^cc-model-config-set]: Anthropic, [Model configuration: setting your model](https://code.claude.com/docs/en/model-config#setting-your-model), including `/model` in `-p` and resume behavior.

[^cc-model-config-effort]: Anthropic, [Model configuration: set the effort level](https://code.claude.com/docs/en/model-config#set-the-effort-level) and the [non-interactive `/effort`](https://code.claude.com/docs/en/model-config#non-interactive-effort) note.

[^cc-model-config-warn]: Anthropic, [Model configuration](https://code.claude.com/docs/en/model-config): with `stream-json`, "read the actual model from the `modelUsage` field of the result message instead".

[^cc-fallback]: Anthropic, [Model configuration: automatic model fallback](https://code.claude.com/docs/en/model-config#automatic-model-fallback).

[^cc-cli-ref]: Anthropic, [CLI reference: CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags), rows `--model`, `--effort`, `--fallback-model`, and `--settings`. The page has no `control_request` entry.

[^cc-env]: Anthropic, [Environment variables](https://code.claude.com/docs/en/env-vars): "`CLAUDE_CODE_EFFORT_LEVEL` overrides `--effort` and `/effort`".

[^cc-caching]: Anthropic, [Prompt caching: switching models](https://code.claude.com/docs/en/prompt-caching#switching-models) and [changing effort level](https://code.claude.com/docs/en/prompt-caching#changing-effort-level).

[^cc-hooks]: Anthropic, [Hooks: common input fields](https://code.claude.com/docs/en/hooks#common-input-fields), row `effort`.

[^cc-sdk-ts]: Anthropic, [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript): [`Query` object](https://code.claude.com/docs/en/agent-sdk/typescript#query-object) (`setModel`, `applyFlagSettings`, `supportedModels`, `initializationResult`, "only available in streaming input mode"), [`ModelInfo`](https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo), [`SDKControlInitializeResponse`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolinitializeresponse), and [`SDKControlInterruptResponse`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolinterruptresponse) (raw control-protocol clients).

[^cc-sdk-ts-flags]: Anthropic, [Agent SDK TypeScript reference: `applyFlagSettings()`](https://code.claude.com/docs/en/agent-sdk/typescript#applyflagsettings), on the next-Turn versus current-Turn keys, `effortLevel: null`, and "Before v2.1.212".

[^cc-sdk-ts-init]: Anthropic, [Agent SDK TypeScript reference: `SDKSystemMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdksystemmessage), the `effort` bullet (Remote Control only) and the capability table.

[^cc-sdk-ts-result]: Anthropic, [Agent SDK TypeScript reference: `SDKResultMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage) (`modelUsage`) and [`ModelUsage`](https://code.claude.com/docs/en/agent-sdk/typescript#modelusage) (`canonicalModel`, v2.1.218+).

[^cc-sdk-config]: Anthropic, [Agent SDK configuration: change configuration mid-session](https://code.claude.com/docs/en/agent-sdk/configuration), a two-Turn example that reads `message.message.model` around `setModel()`.

[^cc-sdk-slash]: Anthropic, [Agent SDK slash commands: commands in Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/slash-commands#commands-in-agent-sdk-sessions): "Send a command by including it in your prompt string".

[^cc-sdk-mjs]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.283/sdk.mjs`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.283/sdk.mjs) (npm `claudeCodeVersion: 2.1.283`). `setModel` sends `{subtype:"set_model",model}`, `applyFlagSettings` sends `{subtype:"apply_flag_settings",settings}`, `supportedModels` returns `(await this.initialization).models`, the envelope is `{request_id,type:"control_request",request}`, and the launch arguments include `--output-format stream-json --verbose --input-format stream-json` plus `--effort` and `--model`.

[^cc-sdk-dts]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.283/sdk.d.ts`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.283/sdk.d.ts): `SDKControlSetModelRequest`, `SDKControlApplyFlagSettingsRequest`, `SDKControlSetMaxThinkingTokensRequest`, `SDKControlListModelsRequest`, `SDKControlGetSettingsRequest`, `SDKModelRefusalFallbackMessage`, and the `SDKSystemMessage.effort` doc comment. `getSettings` is absent from the public `Query` interface.

[^cc-bin]: Locally observed: compiled schema strings in the installed Claude Code 2.1.283 native executable (Linux x64 build), searched as bytes and not run. They cover `set_model`, `apply_flag_settings`, `get_settings` with `applied: { model, effort, … }` ("what will actually be sent to the API"), `list_models`, `per_turn_effort_active` ("@internal Whether per-turn effort is active for this frame's `model` …"), `system/per_turn_effort_changed`, and `view_mode` ("the per-turn init of headless stream-json runs").

[^local-claude-help]: Locally observed: `claude --help` on 2.1.283 (`--model`, `--effort <level>` "(low, medium, high, xhigh, max)", `--fallback-model`, `--input-format`; no model-listing command).

[^prior-claude]: Secant research, [Claude Code structured transports](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/research/claude-code-structured-transports.md), sections "Model and agent selection" and the SDK `initialize` observation.

[^cx-app-doc]: OpenAI, [Codex App Server](https://learn.chatgpt.com/docs/app-server) (redirected from `developers.openai.com/codex/app-server`): "The app-server command and WebSocket transport are experimental and aren't supported for production workloads", and the `thread/start` examples.

[^cx-experimental-doc]: OpenAI, [Codex App Server: experimental API opt-in](https://learn.chatgpt.com/docs/app-server#experimental-api-opt-in).

[^cx-models-doc]: OpenAI, [Codex App Server: list models (`model/list`)](https://learn.chatgpt.com/docs/app-server#list-models-modellist).

[^cx-turn-doc]: OpenAI, [Codex App Server: start a turn](https://learn.chatgpt.com/docs/app-server#start-a-turn), including "these settings become the defaults for later turns on the same thread".

[^cx-events-doc]: OpenAI, [Codex App Server: turn events](https://learn.chatgpt.com/docs/app-server#turn-events) (`model/rerouted`, `model/safetyBuffering/updated`, `turn/started`, `turn/completed`).

[^cx-config-doc]: OpenAI, [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), key `model_reasoning_effort`.

[^cx-turn-src]: OpenAI Codex protocol source, [`v2/turn.rs` lines 41-73](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L41-L73) (`TurnSettingsUpdateParams`) and [lines 228-267](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L228-L267) (`TurnStartParams.model`, `.effort`, experimental `.collaborationMode`).

[^cx-thread-src]: OpenAI Codex protocol source, [`v2/thread.rs` lines 57-222](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L57-L222) (`ThreadStartParams`, `ThreadStartResponse.reasoning_effort`) and [lines 230-333](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L230-L333) (`ThreadSettingsUpdateParams`, `ThreadSettings`, `ThreadSettingsUpdatedNotification`).

[^cx-thread-data-src]: OpenAI Codex protocol source, [`v2/thread_data.rs` lines 243-249](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L243-L249) (`Thread.model` and `Thread.reasoning_effort`, "not per-turn execution telemetry").

[^cx-model-src]: OpenAI Codex protocol source, [`v2/model.rs` lines 119-195](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L119-L195) (`Model`, `ReasoningEffortOption`, `ModelListResponse`, `ModelReroutedNotification`).

[^cx-common-src]: OpenAI Codex protocol source, [`common.rs` lines 685-690](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/common.rs#L685-L690) (experimental `thread/settings/update`), [lines 1038-1042](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/common.rs#L1038-L1042) (experimental `turn/settings/update`), [lines 1103-1106](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/common.rs#L1103-L1106) (`model/list`), and [lines 1941-1995](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/common.rs#L1941-L1995) (experimental `thread/settings/updated`, stable `model/rerouted`).

[^cx-events-src]: OpenAI Codex source, [`bespoke_event_handling.rs` lines 399-409 and 1234-1250](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/bespoke_event_handling.rs#L1234-L1250) (a `ModelReroute` event becomes `model/rerouted`; `ThreadSettingsApplied` becomes `thread/settings/updated` when settings changed).

[^cx-transport-src]: OpenAI Codex source, [`transport.rs` lines 114-122](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/transport.rs#L114-L122): notifications with an experimental reason are skipped for connections without `experimental_api_enabled`.

[^local-codex-help]: Locally observed: `codex app-server --help` on codex-cli 0.157.1 (`-c, --config <key=value>`, "[experimental] Run the app server").

[^local-codex-schema]: Locally observed: `codex app-server generate-json-schema --out <dir>`, with and without `--experimental`, on codex-cli 0.157.1. The stable bundle has `TurnStartParams.model`, `.effort`, `.summary`, `.serviceTier`; `Model.supportedReasoningEfforts`; `ReasoningEffort` as a non-empty string; `Turn` with no model field; and `model/rerouted` and `thread/settings/updated` in `ServerNotification`. `thread/settings/update`, `turn/settings/update`, and `collaborationMode/list` appear only in the experimental bundle.

[^fx-codex-schema]: Secant fixture, [`codex-qualification/stable-schema.generated.json`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/codex/codex-qualification/stable-schema.generated.json) (codex-cli 0.155.0).

[^fx-codex-qual]: Secant fixture, [`codex-qualification/case.json`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/codex/codex-qualification/case.json) and its [`recording.json`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/codex/codex-qualification/recording.json) (codex-cli 0.155.0, recorded 2026-09-18).

[^fx-codex-turns]: Secant fixtures, [`codex/two-turns/case.json`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/codex/two-turns/case.json) and [`codex/resume/case.json`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/codex/resume/case.json) (`thread/start` and `thread/resume` results with `model` and `reasoningEffort`; `turn/started` and `turn/completed` without them).

[^fx-claude]: Secant fixtures, [`claude-code/matt-front`](https://github.com/secantdev/secant/tree/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/claude-code/matt-front) (2.1.281; `grill-1.stdout` and `grill-2.stdout` are two Turns of one process per [`case.json`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/claude-code/matt-front/case.json) and the [fixture README](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/README.md)) and [`claude-code/plain/turn-1.stdout`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/tests/harness/fixtures/claude-code/plain/turn-1.stdout) (2.1.273).

[^secant-claude]: Secant, [`src/harness/claude-code.ts` lines 751-781](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L751-L781) (launch arguments), [lines 667-716](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L667-L716) (next Turn written to the live process), and [lines 1564-1574](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1564-L1574) (`modelSelection`, `modelObservation`).

[^secant-codex]: Secant, [`src/harness/codex/qualification.ts` lines 63-93](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/qualification.ts#L63-L93) (`experimentalApi: false`, `listModels`) and [`src/harness/codex.ts` lines 750-761 and 1796-1832](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L750-L761) (`turn/start` with `model` only; the profile's "reasoning effort … remain unset by Secant").
