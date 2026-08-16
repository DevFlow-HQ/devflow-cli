# Claude Code Structured Transport Evidence

Research date: 2026-08-15
Issue: [#3, Establish Claude Code's viable structured transports on all target platforms](https://github.com/DevFlow-HQ/devflow-cli/issues/3)

## Executive answer

Both candidates remain technically viable, but they expose different evidence envelopes.

- **Agent SDK:** a typed TypeScript or Python wrapper that spawns one Claude Code subprocess per session and communicates with it over stdio. It normally installs a version-matched native Claude Code binary, but TypeScript's `pathToClaudeCodeExecutable` and Python's `cli_path` can point it at the user's separately installed executable. It offers the richer documented host contract: initialization, bidirectional streaming input, typed messages, in-process approval and question callbacks, turn interruption, cancellation, model changes, session helpers, and cleanup. Its decisive nontechnical constraint is Anthropic's statement that third-party products may not offer claude.ai login or plan rate limits without prior approval; the documented default is application/API-key-owned authentication and billing. [Documented: [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [hosting](https://code.claude.com/docs/en/agent-sdk/hosting), [quickstart authentication](https://code.claude.com/docs/en/agent-sdk/quickstart#setup)]
- **`claude -p` stream transport:** the user's installed `claude` process with documented NDJSON output (`--output-format stream-json`) and NDJSON input (`--input-format stream-json`). It preserves the installed CLI's authentication, configuration, billing route, and update ownership unless Crucible deliberately overrides them. It exposes session IDs, resume, model/agent/tool configuration, complete and partial messages, tool activity, result records, and process exit status. Its documented host-control surface is narrower: an MCP tool can handle permission prompts, but the public CLI contract does not document the SDK's stdio control handshake, an in-process question callback, a keep-session-alive interrupt request, or runtime model/permission changes. [Documented: [headless mode](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [authentication](https://code.claude.com/docs/en/authentication)]
- **Relationship, not duplication:** the SDK itself launches Claude Code with stream-json stdin/stdout and layers an initialize/control protocol, callbacks, types, and lifecycle management over that process. Therefore the architecture choice is not "Claude Code versus the SDK"; it is whether Crucible owns the raw documented print-mode boundary or adopts Anthropic's wrapper and its product/authentication terms. [Source-observed: versioned TypeScript package implementation, [`sdk.mjs`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.mjs), and official Python subprocess transport at commit [`d416278`](https://github.com/anthropics/claude-agent-sdk-python/blob/d416278da98d61261fab0305036eacf19aa83ebc/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)]

The facts do not eliminate either transport in all deployment models. They do eliminate an unqualified promise that an SDK-backed third-party product can consume every user's Claude subscription: that requires Anthropic approval or a different auth/billing contract. They also eliminate claiming feature parity for a raw `claude -p` adapter where only SDK control methods are documented.

## Evidence labels and scope

Every conclusion below uses one of these labels:

- **Documented:** stated in current official Anthropic or platform documentation.
- **Source-observed:** present in an official repository, published package, type definition, or protocol implementation, but not necessarily promised as a stable public contract.
- **Locally observed:** observed on this research host only.
- **Inferred:** a design consequence drawn from cited facts; it needs validation before becoming a compatibility promise.
- **Unknown:** current primary sources do not establish the fact.

"Agent SDK" primarily means the TypeScript SDK because Crucible is currently a Node/TypeScript CLI. Python differences are called out where material. "Direct CLI" means the documented `claude -p --input-format stream-json --output-format stream-json --verbose` subprocess transport, not Claude Code's interactive terminal UI or its internal transcript-file schema.

## Candidate summary

| Dimension                          | Agent SDK                                                                                                                                                                                                                                                                                                                        | Direct `claude -p` stream-json                                                                                                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drives user's installed executable | **Yes, explicitly.** Set `pathToClaudeCodeExecutable`; Python uses `cli_path`. Otherwise the SDK uses its bundled binary. [Documented: [TypeScript `Options`](https://code.claude.com/docs/en/agent-sdk/typescript#options), [Python `ClaudeAgentOptions`](https://code.claude.com/docs/en/agent-sdk/python#claudeagentoptions)] | **Yes, inherently.** Crucible resolves and spawns the installed `claude` executable. [Documented: [CLI reference](https://code.claude.com/docs/en/cli-reference)]                                                                                                    |
| Default binary ownership           | SDK package pins and supplies a native binary. [Documented: [TypeScript install](https://code.claude.com/docs/en/agent-sdk/typescript#installation)]                                                                                                                                                                             | User or administrator installs and updates Claude Code. [Documented: [setup](https://code.claude.com/docs/en/setup)]                                                                                                                                                 |
| Host API                           | Typed async iterator plus control methods and callbacks. [Documented: [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)]                                                                                                                                                                              | Child-process stdin/stdout/stderr, JSON lines, flags, signals, and exit status. [Documented: [headless mode](https://code.claude.com/docs/en/headless)]                                                                                                              |
| Rich interactive host control      | Documented for streaming input: approvals/questions, interrupt, runtime model and permission mode, queued messages. [Documented: [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [user input](https://code.claude.com/docs/en/agent-sdk/user-input)]                                      | Permission routing through an MCP tool is documented. Equivalent raw stdio controls are not public CLI promises. [Documented: [CLI reference, `--permission-prompt-tool`](https://code.claude.com/docs/en/cli-reference#cli-flags)]                                  |
| Auth/billing default               | Application API key or supported cloud-provider credentials; third-party claude.ai login/rate-limit offering requires prior approval. [Documented: [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart#setup)]                                                                                                     | Installed CLI uses the user's selected credential according to documented precedence; noninteractive mode uses `ANTHROPIC_API_KEY` when present. [Documented: [authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)] |
| Version control                    | SDK and bundled CLI versions move together; choosing an installed executable decouples them and reintroduces compatibility testing. [Documented: [TypeScript install](https://code.claude.com/docs/en/agent-sdk/typescript#installation)]                                                                                        | User-installed versions may auto-update or be manually pinned depending on installation method. [Documented: [updates](https://code.claude.com/docs/en/setup#update-claude-code)]                                                                                    |

## Platform, runtime, and packaging envelope

### Supported systems

- **Documented:** Claude Code supports macOS 13+, Windows 10 1809+/Windows Server 2019+, Ubuntu 20.04+, Debian 10+, and Alpine 3.19+, on x64 or ARM64 with 4 GB RAM. Native Windows, WSL 1, and WSL 2 are supported; native Windows uses PowerShell when Git for Windows is absent and may use Bash when it is present. [Source: [Claude Code system requirements and Windows setup](https://code.claude.com/docs/en/setup#system-requirements)]
- **Documented:** the TypeScript SDK requires Node.js 18+; Python requires Python 3.10+. [Source: [Agent SDK quickstart prerequisites](https://code.claude.com/docs/en/agent-sdk/quickstart#prerequisites)]
- **Source-observed:** Agent SDK 0.3.233 declares native optional packages for Darwin x64/ARM64, Windows x64/ARM64, Linux glibc x64/ARM64, and Linux musl x64/ARM64, and identifies the bundled Claude Code version as 2.1.233. The published manifest records platform binaries of roughly 307-325 MB each. [Sources: versioned [`package.json`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/package.json), [`manifest.json`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/manifest.json)]
- **Documented:** most TypeScript installs receive only the applicable optional platform binary. Package managers that omit optional dependencies leave no bundled binary; Yarn 1 may install both glibc and musl Linux packages because it does not understand npm's `libc` field. [Source: [TypeScript installation](https://code.claude.com/docs/en/agent-sdk/typescript#installation)]
- **Documented:** Python source distributions may omit a binary, notably the documented ARM64 Windows example; the Python SDK then searches for an installed CLI. Its Windows transport refuses `.bat`/`.cmd` shims and requires a native executable to avoid `cmd.exe` argument-injection risk. [Sources: [quickstart install note](https://code.claude.com/docs/en/agent-sdk/quickstart#setup), [SDK troubleshooting](https://code.claude.com/docs/en/agent-sdk/troubleshooting#cliconnectionerror-refusing-to-execute-batch-script)]
- **Inferred:** a TypeScript Crucible package can retain its current Node 18 floor with the SDK, but accepting the default SDK binary makes Claude Code a large transitive platform artifact. Driving the installed executable avoids that artifact only if packaging explicitly excludes/skips optional native packages or does not depend on the SDK.
- **Documented:** a single-file Bun executable cannot resolve the SDK binary inside Bun's virtual filesystem. The supported workaround is to embed/extract one platform binary and pass the real path, producing a separate build per target platform. [Source: [compile to a single executable](https://code.claude.com/docs/en/agent-sdk/typescript#compile-to-a-single-executable)]
- **Inferred:** direct CLI mode has the smallest Crucible package but adds an installation/version prerequisite. SDK bundled mode has the strongest version pin but materially increases installation/download size. SDK-plus-installed-executable retains the wrapper API but has both the SDK dependency and external-version compatibility risk.

### Local observation

- **Locally observed (2026-08-15):** this research host is Linux x86_64 with Node v24.11.1, but `command -v claude` returned no path. No authenticated execution, live framing, cancellation, or resume experiment was therefore possible. These are not negative product findings; they only mean this report relies on current official documentation and published sources for runtime behavior.

## Launch and initialization

### Agent SDK

- **Documented:** `query()` returns an async generator of SDK messages. The SDK spawns and supervises a separate Claude Code process over stdio; one active session maps to one subprocess and its process tree and local transcript. [Sources: [TypeScript `query()`](https://code.claude.com/docs/en/agent-sdk/typescript#query), [hosting subprocess model](https://code.claude.com/docs/en/agent-sdk/hosting#the-subprocess-model)]
- **Documented:** `startup()` can pre-spawn the subprocess and complete the initialize handshake before a prompt arrives, with a default 60-second initialization timeout. [Source: [TypeScript `startup()`](https://code.claude.com/docs/en/agent-sdk/typescript#startup)]
- **Documented:** options set cwd, environment, model, main agent, tools, permissions, settings sources, MCP servers, hooks, limits, and the executable path. TypeScript's `env` replaces rather than merges `process.env`, so Crucible must deliberately preserve required inherited variables. [Source: [TypeScript `Options`](https://code.claude.com/docs/en/agent-sdk/typescript#options)]
- **Source-observed:** SDK 0.3.233 launches the executable with stream-json input/output and `--verbose`, then sends a newline-delimited `control_request` with subtype `initialize`. The response reports commands, agents, models, account information, and output styles. This is exposed as typed SDK API, but raw control-frame compatibility should not be treated as an independent public CLI protocol. [Sources: versioned [`sdk.mjs`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.mjs), [`SDKControlInitializeResponse`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts)]

### Direct CLI

- **Documented:** launch `claude -p` with a prompt argument or stdin. Add `--output-format stream-json --verbose` for NDJSON events and `--input-format stream-json` for structured stdin. Invalid flags fail before the run and are written to stderr. [Sources: [headless basic usage and streaming](https://code.claude.com/docs/en/headless), [CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)]
- **Documented:** the stream begins with `system/init` unless plugin-install or startup-hook lifecycle events precede it. Init identifies the session, model, tools, MCP status, plugins, Claude Code version, permission mode, and optional protocol capabilities. Consumers must feature-detect capabilities and ignore unknown values. [Sources: [headless session metadata](https://code.claude.com/docs/en/headless#read-session-metadata), [`SDKSystemMessage`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts)]
- **Documented:** `--bare` skips automatic hooks, skills, plugins, MCP, auto memory, CLAUDE.md, OAuth credentials, and the system keychain. Without `--bare`, print mode loads ordinary project/user context and can run project hooks and connect project MCP servers without an interactive workspace-trust prompt. [Source: [headless bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)]
- **Constraint:** a truthful adapter must make "user-compatible environment" versus "isolated deterministic environment" explicit. It must not silently claim both installed-login reuse and `--bare`, because bare mode deliberately excludes subscription OAuth and keychain credentials. [Documented basis: [headless bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)]

## Input and output framing

### Common event model

- **Documented:** stream-json is newline-delimited JSON, one event object per line. Complete mode emits system, assistant, user/tool-result, and final result messages. `--include-partial-messages`/`includePartialMessages` adds raw API streaming events for text and tool-input deltas without removing complete messages. [Sources: [headless streaming](https://code.claude.com/docs/en/headless#stream-responses), [SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)]
- **Documented:** complete assistant messages carry text and `tool_use` blocks; user-role messages carry streamed human input and tool results; the final `result` carries success/error subtype, final text when successful, session ID, usage, cost estimate, permission denials, and termination metadata. [Sources: [agent loop message lifecycle](https://code.claude.com/docs/en/agent-sdk/agent-loop#message-types), versioned [`SDKMessage` and result types](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts)]
- **Documented:** partial events are raw API events and must be accumulated by the consumer. Main-session token deltas are available; complete subagent messages use `parent_tool_use_id`, while token-level subagent deltas are not forwarded by the ordinary SDK partial stream. Direct CLI can opt into subagent text with `--forward-subagent-text`. [Sources: [streaming output limitations](https://code.claude.com/docs/en/agent-sdk/streaming-output#streamevent-reference), [headless subagent messages](https://code.claude.com/docs/en/headless#follow-subagent-messages)]
- **Source-observed:** the official Python SDK transport frames arbitrary stdout chunks on newline boundaries, accepts CRLF, bounds each JSON message, drops blank/non-JSON diagnostic lines, raises on malformed JSON-looking lines, and drops a truncated final JSON line. [Source: official Python [`SubprocessCLITransport`](https://github.com/anthropics/claude-agent-sdk-python/blob/d416278da98d61261fab0305036eacf19aa83ebc/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)]
- **Constraint:** Crucible must parse by bytes/UTF-8 and newline, not assume child-process chunks equal records; preserve unknown event fields and unknown event types; keep stderr separate; and treat malformed or truncated protocol records as transport evidence, not assistant prose.

### Input differences

- **Documented:** Agent SDK accepts either a string for one-shot mode or an async iterable of `SDKUserMessage` for persistent streaming input. Streaming input supports images, queued messages, multiple turns, interruption, and context persistence. [Source: [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)]
- **Documented:** direct CLI accepts `text` or `stream-json` input in print mode. `--replay-user-messages` acknowledges structured input messages on stdout and requires stream-json in both directions. [Source: [CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)]
- **Source-observed:** the SDK serializes a user input as an NDJSON object shaped like `{"type":"user","message":{"role":"user",...},"parent_tool_use_id":null}`. The published `SDKUserMessage` type allows UUID/session fields, priority, origin, and `shouldQuery`. [Sources: versioned [`sdk.mjs`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.mjs), [`SDKUserMessage`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts)]
- **Unknown:** official CLI documentation does not promise every advanced `SDKUserMessage` field for an independently implemented `claude -p` producer. A direct adapter should begin with the documented basic stream-json user-message shape and validate advanced fields against its minimum supported CLI versions before advertising them.

## Sessions, persistence, and resumption

- **Documented:** both transports emit a native session ID and support `continue`, resume by ID, and fork. Sessions preserve conversation/tool history, not filesystem state. [Sources: [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [headless continue conversations](https://code.claude.com/docs/en/headless#continue-conversations)]
- **Documented:** direct CLI captures the ID from structured output and resumes with `claude -p --resume <id>`. `--no-session-persistence` disables disk persistence and therefore resume. [Sources: [headless continue conversations](https://code.claude.com/docs/en/headless#continue-conversations), [CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)]
- **Documented:** the SDK exposes `resume`, `continue`, `forkSession`, explicit `sessionId`, session listing/message APIs, and TypeScript `persistSession: false`. It also offers a `SessionStore` mirror for cross-host resume; the subprocess still writes locally first, mirror writes are best-effort, and `mirror_error` reports dropped batches. [Sources: [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)]
- **Documented:** local transcripts live under `~/.claude/projects/` or `$CLAUDE_CONFIG_DIR/projects/`. Their on-disk entry schema is explicitly internal and may change between Claude Code releases; direct transcript parsing is not a supported Harness transport. [Source: [session storage location and warning](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)]
- **Documented:** current Claude Code searches across projects for a unique session ID; versions before 2.1.223 searched only the current project and its worktrees. Resume restores conversation, model/agent/permission state with documented exceptions, but launch-only MCP/settings/plugin/add-dir flags may need to be supplied again. [Source: [resume behavior](https://code.claude.com/docs/en/sessions#resume-a-session)]
- **Constraint:** Crucible must persist the provider session ID only after observing it, keep its own durable Run artifacts independent of Claude's transcript, reapply launch configuration on resume, and expose "conversation resumed" separately from "filesystem reverted/restored." It must never infer resume support by locating and parsing internal JSONL files.

## Model and agent selection

- **Documented:** both transports can select the startup model and main agent (`model`/`agent` options; `--model`/`--agent` flags), define custom agents, and configure subagents. The SDK additionally documents `supportedModels()`, `supportedAgents()`, and streaming-only `setModel()`. [Sources: [TypeScript options/query methods](https://code.claude.com/docs/en/agent-sdk/typescript#query-object), [CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)]
- **Documented:** aliases such as `sonnet` and `opus` move over time and differ by provider. Full model IDs pin more tightly, but availability and organization allowlists still govern selection. The init message reports the effective model and result `modelUsage` reports models actually used, including fallback. [Source: [model configuration](https://code.claude.com/docs/en/model-config)]
- **Documented:** direct print mode can change model with `/model <value>` in an input, but this is a conversation command rather than a typed control acknowledgement. The SDK `setModel()` validates and acknowledges the request on supported Claude Code versions. [Sources: [headless command availability](https://code.claude.com/docs/en/headless#auto-approve-tools), [model setting](https://code.claude.com/docs/en/model-config#setting-your-model)]
- **Constraint:** report requested and effective model/agent separately; do not claim the alias is a fixed model; retain fallback/model-usage events; and reject or degrade honestly when a configured agent is absent on resume.

## Tools, permissions, approvals, and questions

### Tools

- **Documented:** both candidates use Claude Code's built-in tools and can configure exact available tools (`tools`/`--tools`), pre-approved rules (`allowedTools`/`--allowedTools`), deny rules, MCP servers, hooks, skills, and custom agents. "Allowed tools" approves; it does not restrict availability. [Sources: [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions#allow-and-deny-rules), [CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)]
- **Documented:** tool calls and tool results are present in complete messages; partial mode additionally streams tool input JSON. Subagent attribution uses `parent_tool_use_id`. [Source: [stream tool calls](https://code.claude.com/docs/en/agent-sdk/streaming-output#stream-tool-calls)]
- **Constraint:** a Harness Adapter must distinguish tool availability from approval, main-agent activity from subagent activity, request from execution, and denial from tool failure. It must not translate `allowedTools` into a capability allowlist.

### Permissions and approvals

- **Documented:** the SDK's `canUseTool` callback receives unresolved tool requests and can allow, modify, deny, explain, and apply suggested permission updates. Earlier allow/mode decisions bypass it; hooks are required for policy that must inspect every call. [Sources: [SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input#handle-tool-approval-requests), [permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated)]
- **Documented:** direct CLI offers permission modes and rules. In noninteractive mode, `--permission-prompt-tool <mcp-tool>` routes permission prompts to an MCP tool and waits for its server at startup. [Source: [CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)]
- **Source-observed:** the SDK uses the special value `--permission-prompt-tool stdio` when `canUseTool` is supplied and exchanges `control_request`/`control_response` frames. `stdio` and those raw control frames are implementation details in the published SDK, not documented as a direct-CLI API. [Sources: versioned [`sdk.mjs`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.mjs), [`SDKControlRequest`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts)]
- **Unknown:** no current public CLI document establishes that an independent raw `claude -p` consumer may select the SDK's `stdio` permission tool or implement the complete control protocol. A direct adapter must use documented modes/rules or a real MCP permission tool unless Anthropic publishes that contract.

### Questions and user input

- **Documented:** in the SDK, `AskUserQuestion` and unresolved permission requests invoke `canUseTool`, pause the agent, and resume after the callback returns. The callback may remain pending indefinitely and is cancelled when the query is cancelled. Questions contain 1-4 prompts, each with 2-4 options, optional multiselect, and support host-collected free text. [Source: [handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)]
- **Documented:** streaming input can send follow-up or redirecting user messages while the session remains alive. This is distinct from answering an in-loop `AskUserQuestion` request. [Source: [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)]
- **Documented:** in `dontAsk` mode, `AskUserQuestion` and tools requiring interaction are denied rather than prompting. [Source: [SDK permission modes](https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes)]
- **Unknown:** public direct-CLI documentation does not define a native stdin/stdout question-answer callback equivalent to `canUseTool`. It documents an MCP permission-prompt tool, but does not state that this tool receives and can answer every `AskUserQuestion` shape. Therefore a raw adapter cannot truthfully advertise structured in-loop questions without a focused executable test and a published contract or an explicitly owned MCP bridge.

## Interruption, cancellation, and queued work

The Harness contract must keep three meanings separate: add/queue user input, interrupt the active turn while retaining the session, and terminate the Harness Session/process.

### Agent SDK

- **Documented:** streaming mode supports queued messages and `Query.interrupt()`/Python client `interrupt()`; single-message mode does not support real-time interruption. Produced messages and the interrupted result remain buffered and must be drained. [Sources: [streaming input limitations](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Python interrupt example](https://code.claude.com/docs/en/agent-sdk/python#claudesdkclient)]
- **Documented:** `AbortController` cancels the query and cleans resources. `Query.close()` forcefully ends the query, pending requests, MCP transports, and CLI subprocess. [Source: [TypeScript options and Query](https://code.claude.com/docs/en/agent-sdk/typescript#query-object)]
- **Source-observed:** recent init messages advertise `interrupt_receipt_v1` and `interrupt_cancel_queued_v1`; receipts identify queued messages that survive or were cancelled. Consumers must feature-detect these optional capabilities. [Sources: versioned [`SDKSystemMessage` and interrupt types](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts), [SDK changelog 0.3.205/0.3.219](https://github.com/anthropics/claude-agent-sdk-typescript/blob/73a28abad0d5015568404ecfe0d9cad3ed479fe3/CHANGELOG.md)]

### Direct CLI

- **Documented:** sending stream-json messages queues turns; `--max-turns` applies separately to queued messages. This is not documented as an interrupt. [Source: [CLI `--max-turns`](https://code.claude.com/docs/en/cli-reference#cli-flags)]
- **Documented:** SIGTERM aborts the in-progress turn, terminates running Bash process trees, runs `SessionEnd` hooks, and exits with code 143. [Source: [headless background tasks and exit](https://code.claude.com/docs/en/headless#background-tasks-at-exit)]
- **Unknown:** the direct CLI contract does not document a keep-process-alive turn-interrupt input frame. Crucible may cancel the child process, but must not call that equivalent to the SDK's session-preserving `interrupt()`.
- **Constraint:** every queued user message needs a client correlation ID where the supported input version permits one; interrupt receipts must be capability-gated; termination must report whether the conversation remains resumable; and adapters must not report a stopped process as a clean completed turn unless a result/terminal event establishes completion.

## Errors, exit, and cleanup

### Structured and process errors

- **Documented:** a successful direct `claude -p` exits 0 and failures exit nonzero. Argument errors go to stderr before startup; failures inside a run, including missing authentication, are emitted as the stdout result. [Source: [headless basic usage](https://code.claude.com/docs/en/headless#basic-usage)]
- **Documented:** result subtypes distinguish success, max-turn, max-budget, execution, and structured-output failures; result messages carry session IDs and estimates even for most loop errors. Single-shot SDK `query()` yields an error result and then throws, whereas a streaming input session normally stays alive after limit errors but exits after a session crash. [Source: [agent loop result handling](https://code.claude.com/docs/en/agent-sdk/agent-loop#handle-the-result)]
- **Documented:** retry events expose attempt, delay, status, and a categorical error; Claude Code performs its own bounded retries, with different behavior before and after partial output/tool completion to avoid duplicate side effects. [Sources: [headless API retries](https://code.claude.com/docs/en/headless#handle-api-retries), [error reference](https://code.claude.com/docs/en/errors#automatic-retries)]
- **Documented:** cost fields are client-side estimates, not authoritative billing data, and may be zeroed after crashes. [Source: [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)]
- **Constraint:** Crucible must retain the structured result/error subtype, terminal reason when present, process exit/signal, stderr diagnostics, and whether any assistant/tool output was partial. It must avoid textual inference when a typed field exists and must not treat estimated cost as a bill.

### Cleanup

- **Documented:** the SDK owns subprocess supervision. TypeScript cancellation attempts graceful stdin EOF before force kill; `close()` cleans pending requests, MCP transports, and the subprocess. [Sources: [Query `close()`](https://code.claude.com/docs/en/agent-sdk/typescript#query-object), published [`SpawnOptions`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts)]
- **Source-observed:** the official Python transport closes stdin, waits up to five seconds, terminates, waits again, then kills, and registers an exit reaper for leaked children. [Source: official Python [`SubprocessCLITransport.close`](https://github.com/anthropics/claude-agent-sdk-python/blob/d416278da98d61261fab0305036eacf19aa83ebc/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)]
- **Documented:** direct print mode terminates foreground/background Bash process trees after completion/closed stdin using documented grace periods; SIGTERM performs hook and child cleanup. [Source: [headless background tasks at exit](https://code.claude.com/docs/en/headless#background-tasks-at-exit)]
- **Constraint:** direct mode makes Crucible the process supervisor. It needs bounded stdin-close, wait, terminate, and kill escalation; child-tree behavior on Windows/macOS/Linux must be release-tested; cleanup failure must remain distinct from a successful model result.

## Authentication and billing ownership

### Direct CLI

- **Documented:** Claude Code supports Claude Pro/Max/Team/Enterprise subscription login, Console/API-key billing, Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, Claude Platform on AWS, gateways, and helper/token mechanisms. Credential precedence is explicit; `ANTHROPIC_API_KEY` always wins in `-p` when present. [Source: [authentication](https://code.claude.com/docs/en/authentication)]
- **Documented:** normal `-p` can use the user's installed login and configuration. `--bare` cannot read OAuth login, keychain, long-lived `CLAUDE_CODE_OAUTH_TOKEN`, or Anthropic profiles; it needs an API key/helper for direct Anthropic usage. [Source: [headless bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)]
- **Inferred:** if Crucible merely invokes the user's installed, authenticated CLI without injecting credentials, the user/admin continues to own account selection, billing route, and credential lifecycle. Crucible must still display effective auth/provider metadata where available and avoid copying credentials into its own durable artifacts.

### Agent SDK

- **Documented:** SDK quickstarts require the application's Anthropic API key or supported cloud-provider credentials. The SDK reads the key from the spawned process environment and does not load `.env` itself. [Source: [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart#setup)]
- **Documented:** Anthropic states that, unless previously approved, third-party developers may not offer claude.ai login or rate limits in products powered by the Agent SDK and should use API-key authentication. [Source: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#get-started)]
- **Documented:** technically, CLI credential mechanisms such as `apiKeyHelper`, environment keys, managed restrictions, and certain login flows also apply to the Agent SDK because it wraps the CLI. Technical reach does not override the third-party product restriction above. [Source: [Claude Code credential management](https://code.claude.com/docs/en/authentication#credential-management)]
- **Decision constraint:** an SDK-backed Crucible must choose one of: user supplies an API key/cloud-provider identity; Crucible supplies and bills credentials under a product agreement; or Anthropic explicitly approves user subscription login/rate-limit use. "Use whatever the installed CLI is logged into" is technically possible with `pathToClaudeCodeExecutable` but is not a safe product promise under the cited SDK terms without confirmation.

## Version evolution and compatibility

- **Documented:** the TypeScript SDK version tracks its bundled Claude Code patch version; SDK 0.3.191 bundles CLI 2.1.191, and current package 0.3.233 identifies CLI 2.1.233. Anthropic recommends taking patch SDK releases continuously and reviewing changelogs before minor updates. [Sources: [TypeScript install note](https://code.claude.com/docs/en/agent-sdk/typescript#installation), versioned [`package.json`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/package.json)]
- **Source-observed:** the SDK's public surface and wire schema evolve quickly: the V2 session API was removed in 0.3.142; interrupt receipts, cancellation semantics, terminal reasons, denial events, and task/tool shapes have changed across recent patches. [Source: immutable [TypeScript SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/73a28abad0d5015568404ecfe0d9cad3ed479fe3/CHANGELOG.md)]
- **Documented:** installed Claude Code may auto-update in the background for native installations; Homebrew, WinGet, and Linux package-manager installations update differently. Specific versions and stable/latest channels can be installed, and enterprise settings can enforce minimum/maximum versions. [Source: [Claude Code updates and pinning](https://code.claude.com/docs/en/setup#update-claude-code)]
- **Documented:** init `capabilities` is an open set intended for feature detection; unknown values must be ignored. [Source: [headless session metadata](https://code.claude.com/docs/en/headless#read-session-metadata)]
- **Constraint:** the adapter must record observed Claude Code and SDK versions, define a tested minimum/maximum matrix, capability-gate optional behavior, tolerate additive unknown events/fields, and fail closed only for missing fields that its advertised capability actually requires. SDK-plus-installed-executable needs explicit wrapper/CLI compatibility tests; direct mode needs installed-version gates because Crucible cannot assume the user's update channel.

## Fixtures, fakes, and deterministic testing

### Agent SDK seams

- **Source-observed:** TypeScript exposes `spawnClaudeCodeProcess`, whose `SpawnedProcess` interface is stdin/stdout plus exit/error lifecycle and kill. It can back deterministic fake-process tests without invoking the real binary. [Source: versioned [`Options.spawnClaudeCodeProcess` and `SpawnedProcess`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts)]
- **Documented/source-observed:** Python accepts a custom `Transport`, but marks that low-level interface as internal and changeable. TypeScript also publishes a transport interface, but the documented customization seam is the process spawner. [Sources: [Python `Transport`](https://code.claude.com/docs/en/agent-sdk/python#transport), versioned [TypeScript `Transport`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts)]
- **Documented:** `InMemorySessionStore` supports tests/development, and Anthropic publishes a conformance suite for custom SessionStore implementations. This validates session-store behavior, not the entire Claude subprocess protocol. [Source: [session-store validation](https://code.claude.com/docs/en/agent-sdk/session-storage#validate-your-adapter)]

### Direct CLI seams

- **Inferred:** Crucible can inject its own process-spawn boundary and run a fake executable that consumes/emits NDJSON fixtures. The same captured fixture corpus can drive a pure parser/reducer test independently of process behavior.
- **Unknown:** Anthropic does not publish a headless stream-json protocol conformance suite, canonical fake executable, or declared schema-version negotiation for independent CLI consumers. The SDK's types and changelog are strong source evidence but are not a frozen direct-CLI protocol specification.
- **Constraint:** keep fixtures version-tagged and provenance-tagged; include init-before-result, startup events before init, text/tool partials plus complete messages, permission denial, API retry, malformed/truncated line, stderr plus nonzero exit, cancellation with partial assistant output, multiple queued turns, resume, subagent attribution, unknown events/fields, and clean result followed by trailing system events. Real executable smoke tests must run on Windows, macOS, and Linux for every supported version band and auth mode; unit fakes cannot prove process-tree cleanup, credential discovery, or platform path behavior.

## Truthful Harness Adapter constraints

Regardless of transport, the Claude adapter must preserve these facts rather than flatten them into fictional parity:

1. **Capability provenance:** distinguish launch-time configuration, init-advertised capability, SDK-only method, documented direct-CLI behavior, and locally tested behavior.
2. **Process versus Harness Session:** one SDK query/stream maps to a subprocess; direct mode is explicitly subprocess-owned. Session ID persistence and process liveness are different states.
3. **Turn boundaries:** assistant messages with tools are intermediate; the `result` marks loop/turn completion. Keep iterating after a result when enabled trailing events matter. [Documented: [agent loop message types](https://code.claude.com/docs/en/agent-sdk/agent-loop#message-types)]
4. **Complete versus partial content:** partial deltas are display progress; complete assistant messages/result are canonical transcript candidates. Interrupted assistant messages may be partial and must remain marked as such.
5. **Main versus subagent:** retain `parent_tool_use_id`, subagent/task identity, and forwarding configuration; never merge subagent prose into the main assistant turn without attribution.
6. **User-message origin:** preserve provided origin/correlation metadata. Absence is unknown, not human. The adapter must separately tag Crucible-injected prompts because provider echoes alone do not prove authorship.
7. **Tool semantics:** available, requested, approved, executed, denied, failed, backgrounded, and completed are separate states. Approval rules are not a tool allowlist.
8. **Interaction semantics:** tool approval, `AskUserQuestion`, ordinary follow-up input, queued input, turn interruption, query cancellation, and process termination are separate capabilities.
9. **Error layers:** preserve protocol error, Claude result subtype/terminal reason, API retry/failure category, process exit/signal, stderr, and cleanup failure independently.
10. **Resume honesty:** a session ID plus persisted transcript enables conversation resume; it does not restore files. Launch-only config may need reapplication, and direct parsing of transcript JSONL is unsupported.
11. **Auth ownership:** record whether the user CLI, user API key/cloud identity, or Crucible account owns inference and billing. Never silently cross that boundary or persist credentials in Run artifacts.
12. **Version honesty:** report observed CLI/SDK versions, gate optional controls on capabilities, tolerate additive schemas, and reject unsupported minimums with an actionable error.
13. **Isolation honesty:** default SDK and non-bare CLI behavior can load host/project customization. "Isolated" requires explicit settings sources/config dir/auto-memory/MCP policy; "uses the user's Claude setup" intentionally does not provide the same determinism. [Documented basis: [SDK Claude Code features](https://code.claude.com/docs/en/agent-sdk/claude-code-features), [headless bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)]
14. **Backpressure and shutdown:** consume stdout/stderr concurrently, frame arbitrary chunks, propagate output backpressure, close stdin deliberately, wait within a bound, then terminate/kill and reap descendants as the platform permits.

## Downstream decision constraints and remaining fog

This ticket establishes constraints for issue #8 and the later process/packaging decision; it does not select the final architecture.

1. **Auth/product agreement:** must initial Crucible use the user's existing Claude subscription and plan limits? If yes, obtain Anthropic confirmation that this local third-party use is approved for the Agent SDK, or favor the direct installed-CLI boundary. If API-key/cloud-provider ownership is acceptable, the SDK remains open.
2. **Binary ownership:** should Crucible pin and ship a ~300 MB platform Claude binary through SDK optional dependencies, require the user's installed binary, or support both as explicit modes? Supporting both multiplies version/auth test combinations.
3. **Required interaction level:** does the minimum Workflow contract require structured in-loop `AskUserQuestion`, approval callbacks, and session-preserving interruption? If yes, the SDK has a documented path. Direct CLI needs an owned MCP permission/question bridge or must advertise those capabilities as unavailable until a public contract and executable proof exist.
4. **Configuration posture:** should a Run inherit the user's hooks, skills, MCP, memory, and CLAUDE.md, or use a controlled settings/config environment? Bare mode improves determinism but changes authentication and feature loading; neither posture can be implicit.
5. **Version policy:** what installed Claude Code version range will Crucible support, and will unsupported auto-updated versions be blocked, warned, or run in a reduced capability mode?
6. **Cancellation guarantee:** is process cancellation sufficient, or must Crucible preserve a live Harness Session after interrupt? Raw direct CLI only documents the former; SDK streaming documents both.
7. **Windows launch contract:** will Crucible require a native `claude.exe` and reject `.cmd` wrappers, matching Anthropic's Python SDK hardening? This should be settled before defining executable discovery.
8. **Evidence still needed before implementation:** authenticated three-platform smoke tests for NDJSON input/output, SDK-to-installed-binary compatibility, permission and AskUserQuestion behavior, queued-message ordering, interrupt receipts, process-tree cleanup, resume after forced termination, credential discovery under isolated config, and unknown/additive event handling.

## Primary source index

- [Claude Code headless/programmatic mode](https://code.claude.com/docs/en/headless)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code setup and platform requirements](https://code.claude.com/docs/en/setup)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code errors](https://code.claude.com/docs/en/errors)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK Python reference](https://code.claude.com/docs/en/agent-sdk/python)
- [Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Agent SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent SDK approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Agent SDK sessions and external storage](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Agent SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Agent SDK 0.3.233 package metadata](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/package.json), [types](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.d.ts), [implementation](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/sdk.mjs), and [binary manifest](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.233/manifest.json)
- [Immutable TypeScript SDK changelog snapshot](https://github.com/anthropics/claude-agent-sdk-typescript/blob/73a28abad0d5015568404ecfe0d9cad3ed479fe3/CHANGELOG.md)
- [Immutable Python subprocess transport snapshot](https://github.com/anthropics/claude-agent-sdk-python/blob/d416278da98d61261fab0305036eacf19aa83ebc/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)
