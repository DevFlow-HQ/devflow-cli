# T3 Code's Harness Transports and In-Session Model and Effort Switching

Research date: 2026-09-27

Upstream source snapshot: T3 Code commit
[`de251fc2971a884cb5b1305ba4daf309dc8cccb0`](https://github.com/pingdotgg/t3code/commit/de251fc2971a884cb5b1305ba4daf309dc8cccb0)
(server package `t3` 0.0.42), the Claude Agent SDK version its lockfile resolves
([`@anthropic-ai/claude-agent-sdk@0.3.276`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.276/package.json)), and the OpenAI Codex
protocol ref its Codex client is generated from
([`fe74a774532af67b5a4a3dec03ce9469e17f89af`](https://github.com/openai/codex/commit/fe74a774532af67b5a4a3dec03ce9469e17f89af)). Secant is
compared at [`9388dec`](https://github.com/secantdev/secant/commit/9388dec6dd33119005cdb0e1881007ef720cd14d).

Ticket: [#239](https://github.com/secantdev/secant/issues/239)

## Answer

**Claude Code.** T3 Code drives Claude Code through the Claude Agent SDK, not through a parser of its own. It resolves SDK 0.3.276, runs
`query()` in streaming-input mode, and always passes the user's installed `claude` as `pathToClaudeCodeExecutable`. Its workspace overrides
remove all eight SDK platform binaries because "the SDK always receives the user's Claude executable".[^t3-sdk-pin][^t3-adapter-options] Under
the wrapper, SDK 0.3.276 spawns that executable with `--output-format stream-json --verbose --input-format stream-json`, plus `--model`,
`--effort`, and `--session-id` or `--resume`. It layers its own control protocol on top for approvals, questions, and runtime
setters.[^sdk-mjs]

T3 Code lists Claude models and effort levels from its own model manifest, not from the SDK's `supportedModels()`. The manifest is bundled,
refreshed hourly from T3 Code's `main` branch, and filtered by the installed CLI's version.[^t3-manifest-doc][^t3-claude-catalog] Effort is
passed only when `query()` starts. The adapter can switch the model on a live query with `setModel()`.[^t3-send-turn] The orchestration
layer, however, restarts a Claude session whenever the requested model selection changes, whether the model or any option such as effort. The
restart closes the SDK query and starts a new one with `resume` set to the same Claude session id.[^t3-reactor-restart][^t3-reactor-test]
T3 Code never calls `applyFlagSettings()`, which is the SDK's documented next-turn effort setter.[^sdk-apply-flag]

**Codex.** T3 Code drives `codex app-server` over stdio JSON-RPC through its own Effect client. The client is generated from Codex protocol
source at `fe74a774`, and T3 Code requires Codex 0.156.0 or newer.[^t3-codex-generate][^t3-compat] It opts into the experimental API at
`initialize`.[^t3-codex-init] It reads the models, and each model's supported and default reasoning efforts, live from a paginated
`model/list`.[^t3-codex-models] It sets model and effort on each `turn/start`. The protocol defines those fields as overrides for "this turn
and subsequent turns", so a change takes effect on the next Turn without restarting the process.[^t3-codex-turn][^codex-turn-rs] When an
interaction mode is set, T3 Code also sends the experimental `collaborationMode`. Its settings carry model and reasoning effort, and it takes
precedence over the plain fields.[^t3-codex-collab][^codex-turn-rs]

**Stated reasons.** T3 Code's source, docs, commit messages, and the pull request that added its Claude adapter give no reason for choosing
the Agent SDK over a direct stream-json CLI. They also give none for choosing app-server over `codex exec`.[^t3-pr-179][^t3-sdk-commit] The
nearby constraints they do state are product ones:

- T3 Code is a "bring-your-own-subscription" client, and it "uses Claude Code's login and configuration".[^t3-agents][^t3-claude-doc]
- The SDK's bundled binaries are unused because the user's executable is always passed.[^t3-sdk-pin]
- The model manifest lets startup work offline and lets model metadata change between releases.[^t3-manifest-doc]

**Against Secant.** Both products drive Codex through app-server. Secant differs in four ways: it uses the stable API only, its model list
carries no effort metadata, it reads only the first `model/list` page, and it sets no effort.[^secant-codex-qual][^secant-codex-turn] For
Claude Code the wrapper differs, but the process does not. Both products spawn the user's `claude` in stream-json print mode. T3 Code's
observable effort change is a restart and resume, and Secant already relaunches with `--resume`.[^secant-claude-launch] What the SDK adds is
typed runtime setters (`setModel`, `applyFlagSettings`) and a model list that includes effort levels. It reaches them over a control protocol
that Anthropic publishes only through the SDK.[^sdk-dts-query][^prior-claude]

That addition has two costs. The first is a second version axis: SDK 0.3.276 is matched to Claude Code 2.1.276, while T3 Code accepts CLIs
from 2.1.111 through 2.1.279 as "graceful".[^sdk-package][^t3-compat] The second is Anthropic's statement that third-party products built on
the SDK may not offer claude.ai login unless Anthropic has approved it.[^sdk-auth]

This research describes T3 Code as implemented at the pinned commit. It does not recommend a transport.

## Evidence vocabulary

- **Documented**: stated in current official Anthropic or OpenAI documentation.
- **Source-observed**: present in T3 Code, the published SDK package, Codex, or Secant source at the cited snapshot.
- **Inferred**: a conclusion drawn from cited facts.
- **Unknown**: not established by the permitted primary sources.

## Claude Code in T3 Code

### Transport: the Agent SDK over the user's executable

- **Source-observed.** `ClaudeAdapter.ts` "wraps `@anthropic-ai/claude-agent-sdk` query sessions" and imports `query`, `getSessionMessages`,
  and `forkSession` from the SDK. Its default `createQuery` calls the SDK's `query()`. The prompt is an `AsyncIterable` fed from a queue, which
  is the SDK's streaming-input mode.[^t3-adapter-header][^t3-adapter-start]
- **Source-observed.** Each session's `query()` options set the following:[^t3-adapter-options]
  - `pathToClaudeCodeExecutable`, `model`, and `effort`;
  - `settingSources` of `user`, `project`, and `local`, and `resume` or a fresh `sessionId`;
  - `includePartialMessages`, the `canUseTool` approval callback, and `onUserDialog`;
  - the instance environment, and an HTTP MCP server named `t3-code`.
- **Source-observed.** SDK 0.3.276 builds the child's argv with `--output-format stream-json --verbose --input-format stream-json`, `--model`,
  `--effort`, `--resume=<id>`, and `--session-id=<id>`. It uses `--permission-prompt-tool stdio` for callbacks. Its setters are control
  requests on stdin: `setModel()` sends subtype `set_model` and `applyFlagSettings()` sends `apply_flag_settings`. `supportedModels()`
  returns the `models` of the cached initialize response.[^sdk-mjs]
- **Source-observed.** T3 Code uses the direct CLI for one-shot helper jobs: thread titles, branch names, commit messages, and PR
  descriptions. That path runs `claude -p --output-format json --json-schema … --model … --effort … --tools "" --permission-mode dontAsk`, so
  T3 Code runs both Claude transports, one per job.[^t3-claude-textgen]

### Executable, packaging, and authentication

- **Source-observed.** Each Claude instance has a `binaryPath`, placeholder `claude`, and an optional `homePath` exported as
  `CLAUDE_CONFIG_DIR`.[^t3-settings]
  - Off Windows, the configured value goes to the SDK unchanged.
  - On Windows, T3 Code resolves it against `PATH`/`PATHEXT` and follows an npm `.cmd` shim to `bin/claude.exe` or `cli.js`. It must do this
    because the SDK spawns without a shell.[^t3-exe]
- **Source-observed.** `apps/server/package.json` declares `@anthropic-ai/claude-agent-sdk` `^0.3.276`, the lockfile resolves 0.3.276, and the
  workspace exempts that version from its minimum-release-age rule.[^t3-sdk-pin] `pnpm-workspace.yaml` overrides all eight
  `@anthropic-ai/claude-agent-sdk-<platform>` packages to `-`, with the comment "The SDK always receives the user's Claude executable, so its
  bundled binaries are unused."[^t3-sdk-pin]
- **Unknown.** Workspace overrides govern T3 Code's own pnpm installs. The published `t3` package still lists the SDK as a runtime
  dependency.[^t3-sdk-pin] These sources do not establish whether an npm consumer of `t3` receives the optional platform binaries.
- **Documented and source-observed.** Authentication belongs to the installed CLI:
  - Users install Claude Code and run `claude auth login`, and the CLI must be on the server's `PATH`.[^t3-install]
  - "T3 Code uses Claude Code's login and configuration".[^t3-claude-doc]
  - A separate account gets its own `CLAUDE_CONFIG_DIR`. T3 Code deliberately leaves `HOME` alone so the macOS keychain lookup still finds the
    stored OAuth login.[^t3-claude-home]
  - API keys and routers go into the instance's environment variables.[^t3-claude-doc]
  - On an authentication failure, T3 Code tells the user to run `claude auth login` on the environment's machine.[^t3-claude-home]
- **Source-observed.** The status probe runs `claude --version`.[^t3-claude-provider] It then starts an SDK `query()` whose prompt never
  yields, with hooks and MCP disabled, and reads `initializationResult()`. From that it takes only account fields (email, subscription type,
  token source, API provider) and slash commands.
- **Documented.** Anthropic's SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
  login or rate limits for their products, including agents built on the Claude Agent SDK."[^sdk-auth] **Unknown:** whether T3 Code holds
  that approval.

### Model and effort listing

- **Source-observed.** "Claude uses the manifest for its entire built-in catalog", while "Codex still gets its model list from its app
  server". The manifest is bundled for offline startup and fetched from `main` so model metadata can change between releases.[^t3-manifest-doc]
  The fetch URL is `raw.githubusercontent.com/pingdotgg/t3code/main/…/model-manifest.json`, with a one-hour TTL.[^t3-manifest-fetch]
- **Source-observed.** Each Claude profile declares an `effort` select. Opus 5.5, for example, offers `low`, `medium` (default), `high`,
  `xhigh`, `max`, `ultracode`, and `ultrathink`.[^t3-manifest-claude] The profile maps these values onto Claude Code:
  - `ultrathink` is listed in `promptInjectedValues`.
  - `effortMap` sends `ultracode` as `xhigh` and gives `ultrathink` no effort value.
  - The profile also declares `fastMode` and a `contextWindow` whose `1m` value appends `[1m]` to the model id.
- **Source-observed.** Each catalog model can set a `minVersion`, for example 2.1.280 for Opus 5.5. The provider check lists only the models
  the probed `claude --version` satisfies.[^t3-manifest-claude][^t3-claude-catalog]
- **Source-observed.** When a selection carries no effort, T3 Code's server resolves the descriptor's default option. For a built-in model
  it then passes that default as `effort`.[^t3-default-effort][^t3-adapter-options] T3 Code's user guide instead says that leaving the reasoning
  level unset "uses the provider's own configuration".[^t3-composer-doc] This research did not trace whether clients always send an explicit
  effort.
- **Documented, unused by T3 Code.** SDK 0.3.276's `supportedModels()` returns `ModelInfo` rows that carry `supportsEffort`,
  `supportedEffortLevels`, `supportsFastMode`, and `supportsAdaptiveThinking`.[^sdk-dts-models] A search of T3 Code's `apps/` and `packages/`
  finds no call to `supportedModels` or `applyFlagSettings`.

### Changing the model within a live session

The switch runs through two layers.

1. **Adapter, source-observed.** The Claude adapter declares `sessionModelSwitch: "in-session"`.[^t3-adapter-caps] Before it queues the
   user message, `sendTurn` resolves the selection to an API model id. If that id differs from the live query's current id, the adapter calls
   `query.setModel(apiModelId)`.[^t3-send-turn] The adapter tests assert these `setModel` calls.[^t3-adapter-tests]
2. **Orchestration, source-observed.** For `claudeAgent` only, `ensureSessionForThread` compares the requested `ModelSelection` (model plus
   options) with the last one it recorded for the thread. When they differ, it restarts the provider session and keeps the resume cursor. A
   model change on an existing session therefore reaches `startSession`, which stops the old query and starts a new one with
   `resume: <same session id>`. The SDK passes that as `--resume=<id>` alongside the new `--model`.[^t3-reactor-restart][^t3-adapter-start][^sdk-mjs]
   - In the path traced here, the new query already carries the new model, so the adapter's `setModel` comparison finds no difference on that
     Turn.
   - The restart conditions do not include the session's Turn state. This research did not trace whether clients hold a selection change until
     a Turn ends.
3. **History, source-observed.** The Claude adapter PR (#179) introduced the rule as a restart when Claude `modelOptions` change. #1371 widened
   it to the whole model selection. Neither states a reason.[^t3-pr-179]

### Changing effort within a live session

- **Source-observed.** Effort is set only in the `query()` options, which the SDK turns into `--effort`.[^t3-adapter-options][^sdk-mjs]
  - `ultracode` is sent as `xhigh`, together with `settings.ultracode: true`.
  - `ultrathink` sends no session effort. Instead the adapter prefixes the user text with `Ultrathink:`.[^t3-ultrathink]
  - In `sendTurn`, a changed effort only updates `context.currentEffort`, which subagent records inherit. No SDK call is made.[^t3-send-turn]
- **Source-observed.** A user-visible effort change is therefore the same restart-and-resume as a model change. The reactor test "restarts
  claude sessions when claude effort changes" asserts that the second `startSession` carries the first session's resume
  cursor.[^t3-reactor-test]
- **Documented, unused by T3 Code.** `applyFlagSettings()` changes settings "without restarting the query".[^sdk-apply-flag]
  - `effortLevel`, `ultracode`, `fastMode`, and `agent` apply on the next turn.
  - `model` applies within the current turn from Claude Code 2.1.212.
  - System-prompt options never change mid-session.
  - It works only in streaming-input mode.
- **Documented.** Claude Code itself accepts `--effort` at launch for one session.[^claude-effort] Interactively, `/effort` can run while
  Claude is working and applies to the next request. Earlier Secant research found that the public direct-CLI contract has no typed runtime
  model setter. It found that a `/model` input in print mode is a conversation command without a typed acknowledgement, and that the SDK's raw
  control frames are not a public CLI API.[^prior-claude]

### Related session controls

- **Source-observed.** A `sendTurn` while a real Turn is running is queued into the live SDK loop as the same Turn. T3 Code calls this
  steering.[^t3-send-turn]
- **Source-observed.** Stop closes the query instead of calling the SDK's `interrupt()`, because "interrupt() can acknowledge while resumed
  background tasks keep the CLI alive".[^t3-interrupt] SDK 0.3.276 still declares `interrupt()`.[^sdk-dts-query]
- **Source-observed.** Approvals and questions use the SDK's in-process `canUseTool` callback.[^t3-adapter-options][^sdk-mjs]

### Version and update boundary

- **Source-observed.** The manifest's compatibility table for `claudeAgent` rates CLI versions as follows.[^t3-compat] The resulting advisories
  are messages; they do not block sessions.
  - 2.1.280 and later: `supported`.
  - 2.1.111 up to 2.1.280: `graceful`.
  - Below 2.1.111: `unsupported`.
- **Source-observed.** The SDK package T3 Code resolves declares `claudeCodeVersion: 2.1.276`.[^sdk-package] **Inferred:** T3 Code's SDK
  wrapper and the user's CLI therefore move independently, and T3 Code manages that gap with its own compatibility table.
- **Source-observed.** One-click provider updates run only through the installer that the resolved executable's path proves owns it. Claude's
  native install updates with `claude update`.[^t3-providers-doc][^t3-claude-driver]

## Codex in T3 Code

### Transport and protocol client

- **Source-observed.** The Codex runtime spawns `<binaryPath> app-server` with any user launch arguments and optional `-c mcp_servers.t3-code…`
  overrides. It sets `CODEX_HOME` when one is configured.[^t3-codex-spawn][^t3-codex-args]
- **Source-observed.** `effect-codex-app-server` is a private workspace package. Its generator downloads the protocol schema from
  `openai/codex` at `UPSTREAM_REF = fe74a774…`.[^t3-codex-generate] The last commit to that generator is titled "require Codex 0.156 and
  regenerate its protocol (#13481)".
- **Source-observed.** `initialize` sends `clientInfo.name: t3code_desktop` with `capabilities.experimentalApi: true`, and then
  `initialized`.[^t3-codex-init] Threads open with `thread/start`, or with `thread/resume` for a stored cursor. A resume that fails with a
  recoverable "not found"-style error falls back to a fresh `thread/start`.[^t3-codex-open]
- **Source-observed.** Helper text generation runs `codex exec --ephemeral -s read-only --model … --config model_reasoning_effort=…`.[^t3-codex-textgen]

### Executable, home, and authentication

- **Source-observed.** A Codex instance has a `binaryPath` (placeholder `codex`) and a `homePath` (`CODEX_HOME`). It also has a
  `shadowHomePath`, which keeps `auth.json` separate while sharing state from `CODEX_HOME`.[^t3-settings] Users run `codex login`
  themselves.[^t3-install][^t3-codex-doc]
- **Source-observed.** The status probe reads `account/read`. If no account is present and OpenAI auth is required, the probe returns without
  listing models.[^t3-codex-probe]

### Model and effort listing

- **Source-observed.** `requestAllCodexModels` pages through `model/list` until `nextCursor` is empty.[^t3-codex-models]
  `mapCodexModelCapabilities` turns each model's `supportedReasoningEfforts` into a Reasoning select. It marks `defaultReasoningEffort` as the
  default, except that the `gpt-6-astra` family is forced to `medium`, and it adds service tiers.[^t3-codex-models]
- **Source-observed.** At `fe74a774`, `Model` carries `supported_reasoning_efforts` and `default_reasoning_effort`. `ModelListParams.limit`
  "defaults to a reasonable server-side value", and `ModelListResponse.next_cursor` signals more pages.[^codex-model-rs]

### Per-Turn model and effort

- **Source-observed.** `CodexAdapter.sendTurn` reads the selection's `reasoningEffort` and `serviceTier`. The runtime then builds `turn/start`
  with `model`, `effort`, and `serviceTier` on every Turn.[^t3-codex-turn]
- **Source-observed.** At `fe74a774`, `turn/start`'s `model` field is documented as "Override the model for this turn and subsequent turns",
  and `effort` as "Override the reasoning effort for this turn and subsequent turns".[^codex-turn-rs]
- **Source-observed.** When an interaction mode is set, T3 Code also sends `collaborationMode`. Its `settings` carry `model`,
  `reasoning_effort` (defaulting to `medium`), and `developer_instructions`.[^t3-codex-collab] Codex marks the field `EXPERIMENTAL` and says it
  "Takes precedence over model, reasoning_effort, and developer instructions if set".[^codex-turn-rs] T3 Code adds the field by hand, because
  its generated schema omits experimental fields.[^t3-codex-collab]
- **Source-observed.** The Codex adapter declares `sessionModelSwitch: "in-session"`.[^t3-codex-caps] The reactor's whole-selection restart
  rule applies to `claudeAgent` only. For Codex, a model or effort change travels on the next `turn/start` with no restart.[^t3-reactor-restart]
- **Source-observed.** At `fe74a774`, Codex also has `thread/settings/update`, which changes model and effort for subsequent turns without
  submitting a user turn. It is marked experimental. T3 Code's generated client includes only its `thread/settings/updated`
  notification.[^codex-thread-settings]

### Version boundary

- **Source-observed.** The manifest's compatibility table for `codex` rates app-server versions as follows.[^t3-compat]
  - 0.156.0 and later: `supported`.
  - 0.149.0 up to 0.156.0: `unsupported`.
  - Below 0.149.0: `broken`.

## Model and effort mechanisms by route

| Mechanism                                                      | Model             | Effort                        | Applies                                                    | Contract                                                                                                                                 |
| -------------------------------------------------------------- | ----------------- | ----------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code `--model` / `--effort` at launch                   | Yes               | Yes                           | For the launched session                                   | Documented CLI flags; the SDK uses the same flags[^claude-effort][^sdk-mjs]                                                              |
| Claude Code relaunch with `--resume <id>` and new launch flags | Yes               | Yes                           | Next process                                               | What T3 Code does through the SDK; that a new flag overrides resumed state is not verified here (Unknown)[^t3-reactor-restart][^sdk-mjs] |
| SDK `setModel()`                                               | Yes               | No                            | Subsequent responses; within the current turn from 2.1.212 | Documented SDK API; `set_model` control frame[^sdk-dts-query][^sdk-apply-flag]                                                           |
| SDK `applyFlagSettings({ effortLevel })`                       | Yes (`model` key) | Yes                           | Effort on the next turn                                    | Documented SDK API; `apply_flag_settings` control frame[^sdk-apply-flag][^sdk-mjs]                                                       |
| SDK `supportedModels()`                                        | Lists             | Lists `supportedEffortLevels` | From the initialize response                               | Documented SDK API[^sdk-dts-models]                                                                                                      |
| Raw `control_request` frames written by a non-SDK client       | Yes               | Yes                           | As for the SDK                                             | Not a published CLI contract[^prior-claude]                                                                                              |
| Codex `turn/start` `model` / `effort`                          | Yes               | Yes                           | This turn and subsequent turns                             | Stable app-server protocol[^codex-turn-rs]                                                                                               |
| Codex `turn/start` `collaborationMode.settings`                | Yes               | Yes                           | Takes precedence over the plain fields                     | Experimental[^codex-turn-rs]                                                                                                             |
| Codex `thread/settings/update`                                 | Yes               | Yes                           | Subsequent turns, without a user turn                      | Experimental at `fe74a774`[^codex-thread-settings]                                                                                       |
| Codex `model/list`                                             | Lists             | Lists supported and default   | Paginated                                                  | Stable app-server protocol[^codex-model-rs]                                                                                              |

## Comparison with Secant

### Claude Code

| Dimension                 | T3 Code                                                                                                                                                                                              | Secant                                                                                                                                                                     | Difference and its cost or risk                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport                 | Agent SDK 0.3.276 `query()` in streaming-input mode. Underneath, `claude` stream-json in both directions plus the SDK's private control protocol.[^t3-adapter-options][^sdk-mjs]                     | Direct `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`, one owned process per live Session.[^secant-claude-launch] | The same child protocol; T3 Code adds the SDK's typed control layer (setters, `canUseTool`, `supportedModels`). The cost is an SDK dependency whose control frames Secant would otherwise have to hand-implement, and which Anthropic documents only through the SDK.[^prior-claude] |
| Executable used           | The user's `claude` via `pathToClaudeCodeExecutable`; bundled platform binaries stripped from T3 Code's workspace install; Windows shims followed to `claude.exe` or `cli.js`.[^t3-exe][^t3-sdk-pin] | The user's `claude`, discovered and shim-resolved by the `process` Module and spawned directly.[^secant-claude-launch][^secant-21]                                         | Both run the installed executable. T3 Code also carries SDK 0.3.276, matched to Claude Code 2.1.276, against an independently updated CLI: the "second drift axis" Secant recorded in #21.[^sdk-package][^t3-compat][^secant-21]                                                     |
| Auth boundary             | The user's `claude auth login`, `CLAUDE_CONFIG_DIR`, or instance environment variables, consumed through the SDK.[^t3-claude-doc][^t3-claude-home]                                                   | The user's Claude Code with `process.env` inherited; Secant carries no credential.[^secant-claude-launch][^secant-107]                                                     | The credential route is identical: the CLI reads the same login. Anthropic's SDK terms add a product condition, no third-party claude.ai login for SDK-built agents without approval, which #21 recorded as not applying to the direct CLI.[^sdk-auth][^secant-21]                   |
| Model listing             | T3 Code's own manifest, bundled and fetched hourly from `main`, filtered by `claude --version`, plus custom models.[^t3-manifest-doc][^t3-claude-catalog]                                            | Free-text; Secant lists no models.[^secant-claude-profile]                                                                                                                 | T3 Code's list is curated metadata that T3 Code must maintain, not a Harness observation. The SDK's `supportedModels()` would observe it, but only through the initialize control response.[^sdk-dts-models][^sdk-mjs]                                                               |
| Effort listing            | Manifest effort select per model profile (e.g. `low`…`max`, `ultracode`, `ultrathink`).[^t3-manifest-claude]                                                                                         | None; effort is unset so the user's own configuration applies.[^secant-charting]                                                                                           | Same source split as models. T3 Code's server also sends the manifest default when the selection carries no effort, so the user's `effortLevel` setting does not decide it in that path.[^t3-default-effort][^claude-effort]                                                         |
| Mid-session model switch  | Adapter `setModel()` is available, but orchestration restarts the query with `resume` on any selection change.[^t3-send-turn][^t3-reactor-restart]                                                   | At launch only: `--model` on every launch of the prepared Harness; `modelSelection.at: "launch"`.[^secant-claude-launch][^secant-claude-profile]                           | Secant's relaunch-with-`--resume` path already exists for detached Sessions. T3 Code's user-facing switch uses that same shape. A true live switch needs the SDK's `set_model` frame, which the direct CLI does not publish.[^secant-claude-launch][^prior-claude]                   |
| Mid-session effort switch | Restart with `resume` and a new `--effort`; `applyFlagSettings` unused.[^t3-reactor-test][^t3-adapter-options]                                                                                       | None.                                                                                                                                                                      | As above. ADR 0022 admits a model change only by native change or a verified restart that preserves continuity. A restart ends the live process, which Secant reports as process-only interruption if a Turn is active.[^secant-adr-0022][^secant-claude-profile]                    |
| Harness update boundary   | The user updates the CLI (T3 Code can run the proven installer); T3 Code ships SDK bumps and remote manifest edits.[^t3-providers-doc][^t3-manifest-doc]                                             | The user updates the CLI; Secant records `--version` and requalifies on drift.[^secant-107]                                                                                | T3 Code has three moving parts (CLI, SDK, manifest), Secant one (CLI). T3 Code gets typed setters and a curated catalog for that cost.                                                                                                                                               |

### Codex

| Dimension                 | T3 Code                                                                                                                                                            | Secant                                                                                                                                                               | Difference and its cost or risk                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport                 | `codex app-server` stdio JSON-RPC; `experimentalApi: true`; client generated from Codex source at `fe74a774`.[^t3-codex-spawn][^t3-codex-init][^t3-codex-generate] | `codex app-server` stdio JSONL; `experimentalApi: false`; schema generated from the installed binary at qualification.[^secant-codex-qual][^secant-codex-schema]     | The same transport. T3 Code's experimental opt-in carries the compatibility burden the envelope research described; Secant's per-binary schema check replaces T3 Code's build-time generation plus version table.[^prior-codex][^t3-compat]                              |
| Executable used           | The user's `codex` (`binaryPath`), with optional `CODEX_HOME` and shadow home.[^t3-settings][^t3-codex-spawn]                                                      | The user's `codex`, discovered by the `process` Module.[^secant-codex-profile]                                                                                       | Same boundary.                                                                                                                                                                                                                                                           |
| Auth boundary             | The user's `codex login`; `account/read` probe; shadow homes for extra accounts.[^t3-codex-doc][^t3-codex-probe]                                                   | The user's Codex home and environment; `account/read` at qualification.[^secant-codex-qual][^secant-codex-profile]                                                   | Same boundary; T3 Code adds multi-account homes.                                                                                                                                                                                                                         |
| Model listing             | Every `model/list` page, following `nextCursor`.[^t3-codex-models]                                                                                                 | One `model/list` call with `limit: null`; non-hidden model ids only; `nextCursor` not followed.[^secant-codex-qual]                                                  | Inferred: if the server pages, Secant's declared list can omit models, and a request for an omitted model then fails `model-unavailable`.[^secant-codex-model-check][^codex-model-rs]                                                                                    |
| Effort listing            | `supportedReasoningEfforts` and `defaultReasoningEffort` per model.[^t3-codex-models]                                                                              | Not read: the parsed row keeps `id`, `model`, `displayName`, `hidden`, and `isDefault`.[^secant-codex-qual]                                                          | The data is already on the response Secant parses; only the declaration discards it.                                                                                                                                                                                     |
| Mid-session model switch  | `model` on every `turn/start`.[^t3-codex-turn]                                                                                                                     | `model` on every `turn/start`, fixed per prepared Harness; `modelSelection.at: "launch-and-per-turn"`.[^secant-codex-turn][^secant-codex-profile]                    | Same native point. Secant's requested model is constant for the Run, so no caller can change it between Turns today.                                                                                                                                                     |
| Mid-session effort switch | `effort` on every `turn/start`, plus experimental `collaborationMode.settings.reasoning_effort` when a mode is set.[^t3-codex-turn][^t3-codex-collab]              | None: "reasoning effort … remain unset by Secant".[^secant-codex-profile]                                                                                            | The stable `turn/start.effort` field is sticky for subsequent turns, so a per-Turn value persists until changed. Using `collaborationMode` or `thread/settings/update` would need the experimental opt-in that Secant keeps off.[^codex-turn-rs][^codex-thread-settings] |
| Harness update boundary   | The user updates; T3 Code regenerates its client and gates versions (0.156.0 and later `supported`).[^t3-codex-generate][^t3-compat]                               | The user updates; Secant qualifies whatever installed binary passes its required-schema probe (v0.1.0 evidence used 0.155.0).[^secant-codex-schema][^secant-support] | T3 Code's table rates 0.155.0 `unsupported` (an advisory, not a block), while Secant admitted 0.155.0 by probe. Neither approach removes the unversioned-protocol risk.                                                                                                  |

## Secant's recorded reasons, checked against this snapshot

Each finding is stated as a fact about the snapshot. None is a recommendation.

1. **Drift axis.** #21 chose the direct CLI partly because pointing a pinned SDK at an auto-updating CLI "adds a second drift axis".[^secant-21]
   T3 Code shows that axis. SDK 0.3.276 names Claude Code 2.1.276, and T3 Code runs it against CLIs from 2.1.111 upward under its own
   `graceful` and `supported` table.[^sdk-package][^t3-compat]
2. **Interrupt.** #21 recorded that the SDK's `interrupt()` was no longer in the public TypeScript reference.[^secant-21] SDK 0.3.276 declares
   `interrupt()` in `Query`, and the current TypeScript reference lists it.[^sdk-dts-query][^sdk-apply-flag] T3 Code does not use it to stop a
   Turn. It closes the query instead.[^t3-interrupt]
3. **Binary stripping.** #21 recorded that T3 Code strips the SDK binary "from desktop artifacts".[^secant-21] At this snapshot the removal is
   a workspace-wide pnpm override.[^t3-sdk-pin]
4. **Model list.** The charting record says Claude Code declares free-text because "its model list is reachable only through an SDK-internal
   control message".[^secant-charting] The published SDK confirms that `supportedModels()` reads the initialize control response.[^sdk-mjs]
   T3 Code does not use that response for models either; it maintains a manifest.
5. **Effort.** The charting record says M4 left effort unset "so the user's own Harness configuration stays in charge".[^secant-charting] T3
   Code's Claude server path does not leave it unset for built-in models.[^t3-default-effort] Its Codex path leaves it unset unless the
   selection carries one.[^t3-codex-turn]

## Decision fog for #245

This research leaves the following questions open for
[Decide how model and effort are chosen and changed within a Harness Session](https://github.com/secantdev/secant/issues/245):

1. Is a relaunch with `--resume` and new `--model` or `--effort` flags an acceptable "verified restart that preserves continuity" under ADR
   0022? That needs an executable test showing that launch flags override resumed state.
2. Should the Claude Code model and effort lists stay free-text, come from a Secant-maintained catalog as T3 Code does, or come from the
   initialize response through the SDK or a hand-implemented control handshake?
3. Should Codex effort be declared from `model/list` and applied through stable `turn/start.effort`? Should `model/list` follow `nextCursor`?
4. Must a switch be possible during an active Turn, or only at a Turn boundary? Claude restart would end the active Turn; Codex applies the
   change to the next Turn.

## Primary sources

[^t3-agents]: T3 Code, [`AGENTS.md` lines 3-5](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/AGENTS.md#L3-L5) (wraps provider CLIs; "bring-your-own-subscription").

[^t3-claude-doc]: T3 Code, [`docs/user/providers-claude.md` lines 3-38 and 75-96](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/user/providers-claude.md#L3-L38).

[^t3-install]: T3 Code, [`docs/user/install.md` lines 107-124](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/user/install.md#L107-L124).

[^t3-composer-doc]: T3 Code, [`docs/user/composer.md` lines 65-71](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/user/composer.md#L65-L71).

[^t3-codex-doc]: T3 Code, [`docs/user/providers-codex.md` lines 1-44](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/user/providers-codex.md#L1-L44).

[^t3-providers-doc]: T3 Code, [`docs/internals/providers.md` lines 60-79](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/internals/providers.md#L60-L79).

[^t3-manifest-doc]: T3 Code, [`docs/internals/model-manifest.md` lines 1-23](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/internals/model-manifest.md#L1-L23).

[^t3-manifest-fetch]: T3 Code, [`ModelManifest.ts` lines 40-44](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/ModelManifest.ts#L40-L44).

[^t3-manifest-claude]: T3 Code, [`model-manifest.json` Opus 5.5 profile lines 153-195](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/model-manifest.json#L153-L195) and [catalog entry lines 654-660](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/model-manifest.json#L654-L660).

[^t3-compat]: T3 Code, [`model-manifest.json` compatibility lines 5-24](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/model-manifest.json#L5-L24) and [`providerCompatibility.ts` lines 59-99](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/providerCompatibility.ts#L59-L99).

[^t3-sdk-pin]: T3 Code, [`apps/server/package.json` lines 25-26](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/package.json#L25-L26), [`pnpm-workspace.yaml` lines 56, 88, and 108-116](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/pnpm-workspace.yaml#L108-L116), and [`pnpm-lock.yaml` line 1134](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/pnpm-lock.yaml#L1134).

[^t3-settings]: T3 Code, [`packages/contracts/src/settings.ts` lines 577-657](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/settings.ts#L577-L657).

[^t3-exe]: T3 Code, [`ClaudeExecutable.ts` lines 10-89](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Drivers/ClaudeExecutable.ts#L10-L89).

[^t3-claude-home]: T3 Code, [`ClaudeHome.ts` lines 12-54 and 77-90](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Drivers/ClaudeHome.ts#L12-L90).

[^t3-claude-driver]: T3 Code, [`ClaudeDriver.ts` lines 75-91](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Drivers/ClaudeDriver.ts#L75-L91).

[^t3-claude-provider]: T3 Code, [`ClaudeProvider.ts` probe options lines 186-216, SDK probe lines 332-399, and version probe lines 461-533](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeProvider.ts#L186-L533).

[^t3-claude-catalog]: T3 Code, [`ClaudeModelCatalog.ts` lines 63-168](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/ClaudeModelCatalog.ts#L63-L168).

[^t3-default-effort]: T3 Code, [`ClaudeModelCatalog.ts` `resolveClaudeCatalogEffort` lines 188-201](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/ClaudeModelCatalog.ts#L188-L201) and [`packages/shared/src/model.ts` lines 141-169](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/shared/src/model.ts#L141-L169).

[^t3-ultrathink]: T3 Code, [`packages/shared/src/model.ts` lines 389-431](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/shared/src/model.ts#L389-L431) and [`ClaudeAdapter.ts` lines 1551-1566](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1551-L1566).

[^t3-adapter-header]: T3 Code, [`ClaudeAdapter.ts` lines 1-27 and 2097-2107](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1-L27).

[^t3-adapter-start]: T3 Code, [`ClaudeAdapter.ts` `startSession` lines 4382-4420](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4382-L4420).

[^t3-adapter-options]: T3 Code, [`ClaudeAdapter.ts` option derivation and `query()` options lines 4814-4954](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4814-L4954).

[^t3-send-turn]: T3 Code, [`ClaudeAdapter.ts` `sendTurn` lines 5127-5190](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5127-L5190).

[^t3-interrupt]: T3 Code, [`ClaudeAdapter.ts` `interruptTurn` lines 5276-5284](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5276-L5284).

[^t3-adapter-caps]: T3 Code, [`ClaudeAdapter.ts` capabilities lines 5557-5560](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5557-L5560) and the [`ProviderAdapterCapabilities` contract lines 28-55](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Services/ProviderAdapter.ts#L28-L55).

[^t3-adapter-tests]: T3 Code, [`ClaudeAdapter.test.ts` `setModel` cases lines 7327-7465](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.test.ts#L7327-L7465).

[^t3-reactor-restart]: T3 Code, [`ProviderCommandReactor.ts` restart rules lines 774-835 and per-Turn selection lines 847-913](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L774-L913).

[^t3-reactor-test]: T3 Code, [`ProviderCommandReactor.test.ts` "restarts claude sessions when claude effort changes" lines 3275-3341](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts#L3275-L3341).

[^t3-pr-179]: [pingdotgg/t3code#179](https://github.com/pingdotgg/t3code/pull/179), "feat: add Claude Code adapter" (commit `77716b4ccb`, introduces `shouldRestartForModelOptionsChange`), and commit [`a542a3b168`](https://github.com/pingdotgg/t3code/commit/a542a3b168423ce5d13e46edb08c0a98cc3b57df) (#1371), which renames it to the whole-selection rule. Neither body states a rationale.

[^t3-sdk-commit]: T3 Code commit [`9b3dbada17`](https://github.com/pingdotgg/t3code/commit/9b3dbada17dcbd0b96ca7eb6f79af7f7e0a416db), "Integrate Claude agent SDK into server provider adapter", whose body lists changes only.

[^t3-claude-textgen]: T3 Code, [`ClaudeTextGeneration.ts` lines 56-60 and 196-221](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/textGeneration/ClaudeTextGeneration.ts#L196-L221).

[^t3-codex-spawn]: T3 Code, [`CodexSessionRuntime.ts` lines 1326-1360](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L1326-L1360) and [`CodexAdapter.ts` `startSession` lines 2257-2310](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2257-L2310).

[^t3-codex-args]: T3 Code, [`codexLaunchArgs.ts` lines 1-47](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/codexLaunchArgs.ts#L1-L47).

[^t3-codex-generate]: T3 Code, [`packages/effect-codex-app-server/scripts/generate.ts` lines 20-23](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/effect-codex-app-server/scripts/generate.ts#L20-L23); last changed by commit `d5d48742c9`, "feat(codex): require Codex 0.156 and regenerate its protocol (#13481)".

[^t3-codex-init]: T3 Code, [`CodexProvider.ts` lines 343-354](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexProvider.ts#L343-L354) and [`CodexSessionRuntime.ts` lines 2481-2510](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L2481-L2510).

[^t3-codex-open]: T3 Code, [`CodexSessionRuntime.ts` `openCodexThread` lines 735-786](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L735-L786).

[^t3-codex-probe]: T3 Code, [`CodexProvider.ts` lines 412-470](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexProvider.ts#L412-L470).

[^t3-codex-models]: T3 Code, [`CodexProvider.ts` `mapCodexModelCapabilities` lines 145-213 and `requestAllCodexModels` lines 325-341](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexProvider.ts#L145-L341).

[^t3-codex-turn]: T3 Code, [`CodexAdapter.ts` `sendTurn` lines 2521-2559](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2521-L2559) and [`CodexSessionRuntime.ts` `buildTurnStartParams` lines 621-682 and `sendTurn` lines 2550-2611](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L621-L682).

[^t3-codex-collab]: T3 Code, [`CodexSessionRuntime.ts` lines 145-152 and 589-617](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L589-L617).

[^t3-codex-caps]: T3 Code, [`CodexAdapter.ts` capabilities lines 2726-2730](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2726-L2730).

[^t3-codex-textgen]: T3 Code, [`CodexTextGeneration.ts` lines 190-217](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/textGeneration/CodexTextGeneration.ts#L190-L217).

[^sdk-package]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.276` `package.json`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.276/package.json), lines 59-83 (optional platform packages; `claudeCodeVersion: "2.1.276"`).

[^sdk-mjs]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.276` `sdk.mjs`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.276/sdk.mjs) (minified): argv `["--output-format","stream-json","--verbose","--input-format","stream-json"]`, `--model`, `--effort`, `` `--resume=${…}` ``, `` `--session-id=${…}` ``, `"--permission-prompt-tool","stdio"`; `setModel` → `{subtype:"set_model"}`; `applyFlagSettings` → `{subtype:"apply_flag_settings"}`; `supportedModels()` → `(await this.initialization).models`.

[^sdk-dts-query]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.276` `sdk.d.ts`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts), `Query` lines 2684 (`interrupt()`), 2714-2719 (`setModel`), 2744-2767 (`applyFlagSettings`), 2819-2823 (`supportedModels`); `Options.effort` lines 1812-1823; `pathToClaudeCodeExecutable` lines 1886-1889.

[^sdk-dts-models]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.276` `sdk.d.ts` `ModelInfo` lines 1319-1358](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.276/sdk.d.ts).

[^sdk-apply-flag]: Anthropic, [Agent SDK TypeScript reference: `Query`, `setModel()`, `applyFlagSettings()`](https://code.claude.com/docs/en/agent-sdk/typescript) (retrieved through Context7, 2026-09-27).

[^sdk-auth]: Anthropic, [Agent SDK overview, Get started](https://code.claude.com/docs/en/agent-sdk/overview#get-started).

[^claude-effort]: Anthropic, [Claude Code model configuration: set the effort level](https://code.claude.com/docs/en/model-config#adjust-effort-level) and [CLI reference `--effort`](https://code.claude.com/docs/en/cli-reference) (retrieved through Context7, 2026-09-27).

[^codex-turn-rs]: OpenAI Codex, [`v2/turn.rs` lines 167-267 at `fe74a774`](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L167-L267); the same `model`/`effort` descriptions appear in T3 Code's [generated schema lines 56567-56681](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/effect-codex-app-server/src/_generated/schema.gen.ts#L56567-L56681).

[^codex-thread-settings]: OpenAI Codex, [`v2/thread.rs` `ThreadSettingsUpdateParams` lines 236-275](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L236-L275) and [`common.rs` lines 693-698](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/app-server-protocol/src/protocol/common.rs#L693-L698) (`#[experimental("thread/settings/update")]`); T3 Code's [`meta.gen.ts` line 149](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/effect-codex-app-server/src/_generated/meta.gen.ts#L149) has only the notification.

[^codex-model-rs]: OpenAI Codex, [`v2/model.rs` lines 52-65, 119-131, and 176-183 at `fe74a774`](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L52-L183).

[^secant-claude-launch]: Secant, [`src/harness/claude-code.ts` lines 324-335 and 739-786](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L739-L786).

[^secant-claude-profile]: Secant, [`src/harness/claude-code.ts` `buildProfile` lines 1520-1575](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1520-L1575) and the [`ModelSelectionCapability` type](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L103-L130).

[^secant-codex-qual]: Secant, [`src/harness/codex/qualification.ts` lines 30-40 and 64-93](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/qualification.ts#L30-L93).

[^secant-codex-schema]: Secant, [`src/harness/codex.ts` lines 280-300](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L280-L300) (`app-server generate-json-schema` from the installed binary).

[^secant-codex-model-check]: Secant, [`src/harness/codex.ts` lines 384-400](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L384-L400).

[^secant-codex-turn]: Secant, [`src/harness/codex.ts` lines 600-605 and 745-763](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L745-L763).

[^secant-codex-profile]: Secant, [`src/harness/codex.ts` profile lines 1790-1837](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L1790-L1837).

[^secant-support]: Secant, [`docs/support-matrix.md` lines 53-54](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/support-matrix.md#L53-L54).

[^secant-adr-0022]: Secant, [ADR 0022](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/adr/0022-own-a-truthful-deep-harness-seam.md) and the [#8 resolution, "Models, authentication, materials, and time bounds"](https://github.com/secantdev/secant/issues/8).

[^secant-21]: Secant, [#21 decision, section 4 "Claude Code transport: direct `claude -p` stream-json"](https://github.com/secantdev/secant/issues/21#issuecomment-5496912254).

[^secant-107]: Secant, [Spec: M3 — First Harness (Claude Code), #107](https://github.com/secantdev/secant/issues/107) (Harness discovery, configuration posture, authentication, process and Session model).

[^secant-charting]: Secant, [charting record on #235](https://github.com/secantdev/secant/issues/235#issuecomment-5855568126), "Answers to questions raised in the reports".

[^prior-claude]: Secant research, [`docs/research/claude-code-structured-transports.md` lines 63, 98-103, and 113-118](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/research/claude-code-structured-transports.md#L98-L118).

[^prior-codex]: Secant research, [`docs/research/codex-app-server-capability-envelope.md`, Version and Platform Policy](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/research/codex-app-server-capability-envelope.md#version-and-platform-policy).
