# Gemini ACP Capability Envelope

**Status:** Research conclusion for [DevFlow CLI issue 7](https://github.com/DevFlow-HQ/devflow-cli/issues/7)

**As of:** 2026-08-15

**Current stable examined:** Gemini CLI [`v0.55.1`](https://github.com/google-gemini/gemini-cli/releases/tag/v0.55.1), source commit [`41327e407da58aa01c409ef6685b7b5d379f295e`](https://github.com/google-gemini/gemini-cli/tree/41327e407da58aa01c409ef6685b7b5d379f295e)

**Protocol examined:** stable ACP v1 at [`1d0be14884d00de07350e85346a3cfa60ef8eb03`](https://github.com/agentclientprotocol/agent-client-protocol/tree/1d0be14884d00de07350e85346a3cfa60ef8eb03); Gemini pins the official TypeScript SDK [`0.16.1`](https://github.com/agentclientprotocol/typescript-sdk/tree/9609d922dc855dc4446dfaef082416d34e0f123a)

## Evidence Labels

- **Documented:** stated by official Gemini CLI or ACP documentation.
- **Source-observed:** directly visible in current official source at the pinned commits above.
- **Locally observed:** reproduced with the installed tool on the research host; this is environment-specific, not a cross-platform claim.
- **Inferred:** the narrow conclusion supported by documented or source-observed facts, but not directly promised or tested upstream.
- **Unknown:** no current primary evidence establishes the behavior.

## Answer

Gemini CLI now exposes a viable structured ACP v1 data plane through `gemini --acp`: newline-delimited JSON-RPC 2.0 over stdio, stable native session IDs, turn-final `session/prompt` responses, streamed assistant and thought chunks, structured tool activity and permission requests, cancellation, and persisted-session loading. It is materially stronger than terminal scraping and can satisfy a first-class Crucible Harness Adapter if the adapter accumulates each prompt's message chunks until the prompt response and owns classification of its outgoing user prompts. [Gemini documents the launch and stdio transport](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/docs/cli/acp-mode.md#L1-L12), while ACP defines the prompt response as the turn boundary after any streamed updates and tool calls ([prompt lifecycle](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/prompt-turn.mdx#L10-L55), [completion](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/prompt-turn.mdx#L215-L229)). **Documented and source-observed.**

This is not full parity with every present ACP v1 feature. Gemini implements history-replaying `session/load`, not no-replay `session/resume`; has no `session/close`, list, delete, logout, elicitation, or client-terminal surface; deliberately excludes its conversational `ask_user` tool in ACP mode; and still uses the never-stabilized `session/set_model` API from its pinned SDK. Current stable ACP has since removed that model method in favor of session config options ([official removal notice](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/rfds/updates.mdx#L194-L198)). **Source-observed.** These are feature boundaries, not defects to conceal with Codex- or Claude-shaped emulation.

The official CLI targets Windows, macOS, and Linux, and the ACP code is included in the CLI unit-test shard run on all three. However, upstream does not document an ACP-specific platform matrix and does not run a clearly identified ACP subprocess conformance suite on all three platforms. Therefore launch parity on all target platforms is **inferred**, not proven. The adapter must retain a platform acceptance gate rather than advertise all-platform ACP support solely from generic CLI support.

## Capability Matrix

| Area | Gemini ACP envelope | Evidence status |
| --- | --- | --- |
| Launch | `gemini --acp`; long-lived agent subprocess over stdin/stdout | Documented |
| Framing | UTF-8, one JSON-RPC object per newline; protocol traffic only on stdout, logs allowed on stderr | Documented and source-observed |
| Protocol | ACP major version `1`; Gemini returns SDK constant `1` | Source-observed |
| Initialization | Advertises implementation info, four auth methods, `loadSession`, image/audio/embedded-context prompts, and HTTP/SSE MCP | Source-observed |
| New sessions | `session/new` returns a UUID and mode/model state | Source-observed |
| Recovery | `session/load` restores stored conversation and replays history; no `session/resume` | Source-observed |
| Model selection | Launch `--model`, session model metadata, and legacy `session/set_model`; no current stable config-option implementation | Source-observed |
| Streaming | Agent text chunks, thought chunks, tool updates, available-command updates; prompt response is turn end | Source-observed |
| Approvals | Client-facing `session/request_permission`; modes `default`, `auto_edit`, `yolo`, optionally `plan` | Source-observed |
| Questions | No structured conversational question/elicitation path; ordinary question text can end a turn and receive a later prompt | Source-observed and inferred |
| Cancellation | `session/cancel` aborts the active prompt and should return `stopReason: cancelled`; session remains reusable | Documented and source-observed |
| Errors | JSON-RPC errors plus Gemini/API codes; some model-stream anomalies become successful `end_turn` | Source-observed |
| Session shutdown | No session-close method; close stdin or signal/terminate process | Source-observed |
| Authentication | Gemini agent owns auth; client selects an advertised method; Gemini-specific `_meta` can carry API-key/gateway details | Source-observed |
| Platforms | CLI supported on Windows 11 24H2+, macOS 15+, Ubuntu 20.04+; ACP-specific parity not independently certified | Documented, inferred, and unknown |
| Deterministic tests | Hidden ordered fake-response/recording flags plus unit mocks and one ACP subprocess telemetry test | Source-observed |

## Launch, Initialization, And Negotiation

### Launch and process shape

- `gemini --acp` is the current documented launch. `--experimental-acp` remains a deprecated alias in source ([CLI option definitions](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/config/config.ts#L363-L371)). **Documented and source-observed.**
- ACP mode branches into `runAcpClient` after normal settings, workspace, storage, and application initialization ([entry branch](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/gemini.tsx#L724-L760)). `gemini` normally uses a lightweight parent that spawns a child with inherited stdio before the heavy CLI starts ([launcher](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/index.ts#L84-L138)). **Source-observed.** A harness must manage the spawned process lifecycle, not assume the JSON-RPC agent is necessarily the original Node process.
- Gemini constructs an ACP `AgentSideConnection` over stdin and a protected working stdout, using the SDK's NDJSON stream ([ACP stdio transport](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpStdioTransport.ts#L15-L34)). **Source-observed.** No PTY is required or desirable for ACP.

### Framing

- ACP stdio messages are UTF-8 JSON-RPC requests, responses, or notifications, each delimited by `\n`; embedded framing newlines are forbidden, stdout must contain only protocol messages, and logs may go to stderr ([ACP transport requirements](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/transports.mdx#L6-L27)). **Documented.**
- Gemini's pinned SDK serializes `JSON.stringify(message) + "\n"` and parses complete newline-delimited records ([SDK `0.16.1` stream](https://github.com/agentclientprotocol/typescript-sdk/blob/9609d922dc855dc4446dfaef082416d34e0f123a/src/stream.ts#L21-L70)). **Source-observed.** In this pinned SDK, malformed JSON is logged and dropped rather than answered with a parse-error response. A harness must treat framing corruption or unexpected stdout as a transport failure and must not wait forever for a JSON-RPC error that may never arrive.

### Initialization and protocol version

- ACP requires `initialize` before session creation. The client sends its latest supported major and capabilities; the agent returns the requested version if supported or its latest supported version otherwise; the client should close if it cannot support the returned version ([ACP negotiation](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/initialization.mdx#L24-L29), [version rules](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/initialization.mdx#L84-L98)). **Documented.**
- Gemini pins `@agentclientprotocol/sdk` `0.16.1` ([package manifest](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/package.json#L27-L36)); that SDK's protocol constant is `1` ([SDK schema](https://github.com/agentclientprotocol/typescript-sdk/blob/9609d922dc855dc4446dfaef082416d34e0f123a/src/schema/index.ts#L140-L180)). Gemini returns that constant without comparing it to the requested value ([dispatcher](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L40-L103)). **Source-observed.** The harness must perform the compatibility check itself and currently accept only major `1`; a returned `1` is not evidence that every later v1 extension is implemented.
- Gemini advertises `loadSession`, image/audio/embedded-context prompt support, and HTTP/SSE MCP transport, plus `gemini-cli` name/title/version and four authentication methods ([initialize response](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L47-L103)). Omitted capabilities are unsupported under ACP's negotiation rules ([ACP capability omission rule](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/initialization.mdx#L100-L112)). **Source-observed and documented.**

## Sessions And Recovery

### New sessions

- `session/new` creates a random UUID, loads settings from the request's absolute `cwd`, builds a session-specific config, authenticates, initializes Gemini, starts a chat, and returns the UUID plus available/current modes and models ([session manager](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSessionManager.ts#L58-L161)). **Source-observed.** The request `cwd`, rather than subprocess cwd, is the ACP workspace authority, as ACP requires ([working-directory rules](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/session-setup.mdx#L358-L367)).
- The process can hold multiple in-memory sessions in a map, but each session has at most one active prompt controller ([manager map](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSessionManager.ts#L33-L55), [session prompt state](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L65-L73)). **Source-observed.** The harness should serialize prompts per session.

### Load versus resume

- Gemini advertises and implements ACP v1 `session/load`: it resolves the supplied native ID in the project-scoped chat store, recreates the chat from persisted history, and keeps the same session ID ([load implementation](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSessionManager.ts#L164-L229), [project-scoped resolver](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/utils/sessionUtils.ts#L450-L550)). **Source-observed.** This supports provider-session recovery across process restarts when the same provider state and project identity remain available.
- `session/load` means full history replay. Current ACP separately defines `session/resume` as reconnecting without replay and requires a distinct `sessionCapabilities.resume` advertisement ([ACP load](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/session-setup.mdx#L83-L188), [ACP resume](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/session-setup.mdx#L190-L253)). Gemini advertises no resume capability and has no resume dispatcher method. **Documented and source-observed.** A Crucible capability named `supportsResume` may be true only if its semantics explicitly include replaying ACP `session/load`; it must not claim no-replay `session/resume`.
- Gemini emits replayed `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, and completed/failed `tool_call` updates ([history streamer](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L241-L309)). **Source-observed.** Replay must be tagged or discarded as historical data, never normalized into fresh submitted-message or turn-completed events.
- ACP requires all history notifications to finish before the `session/load` response ([ordering rule](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/session-setup.mdx#L134-L188)), but Gemini starts `streamHistory(...)` without awaiting it before constructing the response ([Gemini load ordering](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSessionManager.ts#L197-L228)). **Source-observed spec gap.** The harness cannot use the load response alone as proof that replay notifications have drained; it must tolerate replay/update races before sending or attributing the next prompt, and this behavior needs a pinned integration test.
- Missing, expired, corrupted, moved, or cross-project session behavior is not given a stability guarantee. Resolution errors are explicit, but retention duration and compatibility across future Gemini versions are **unknown**. A harness must preserve artifact fallback recovery and clear a rejected provider ID rather than retry it indefinitely.

## Model Selection

- Gemini CLI accepts `--model` ([CLI option](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/config/config.ts#L281-L293)), and session creation reports `models.availableModels` and `models.currentModelId`. The list is dynamic based on auth, preview access, and model configuration ([model builder](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpUtils.ts#L254-L365)). **Source-observed.** Do not hard-code a universal Gemini model list.
- Gemini implements the SDK interface method `unstable_setSessionModel`, which sets the session config model ([dispatcher](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L224-L235)). On the wire in SDK `0.16.1`, this is `session/set_model` ([SDK method table](https://github.com/agentclientprotocol/typescript-sdk/blob/9609d922dc855dc4446dfaef082416d34e0f123a/src/schema/index.ts#L140-L180)). **Source-observed.**
- ACP never stabilized that model API and removed it in June 2026 in favor of session config options ([official ACP update](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/rfds/updates.mdx#L194-L198)). Gemini does not implement `session/set_config_option` in its dispatcher. **Source-observed protocol gap.** The adapter may use `--model` as the stable Gemini CLI launch control. If it uses `session/set_model`, it must pin/test the Gemini version, detect support from returned session model metadata rather than ACP major alone, and surface method-not-found instead of silently claiming the requested model.

## Prompting, Streaming, And Turn Boundaries

- Gemini accepts ACP text, image, audio, resource-link, and embedded-resource prompt blocks; image, audio, and embedded context are advertised capabilities ([prompt conversion](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L945-L987), [initialize capabilities](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L81-L103)). **Source-observed.** Crucible only needs text initially and should not advertise richer input until it preserves each content type.
- Model content streams as `session/update` `agent_message_chunk`; reasoning summaries stream as `agent_thought_chunk`. Gemini does not attach message IDs in these paths ([event mapping](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L405-L485)). **Source-observed.** The harness must accumulate ordered text chunks by the outstanding `session/prompt` request and session ID. It must not expect a final consolidated message in the prompt response.
- The `session/prompt` response is the authoritative turn boundary. Gemini returns `end_turn`, `cancelled`, `max_tokens`, or `max_turn_requests` in reachable source paths and includes Gemini-specific quota metadata on many successful responses ([prompt loop and stop mapping](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L311-L626)). **Source-observed.** A normalized `turn-completed.assistantMessage` is the accumulated current-turn `agent_message_chunk` text at response time; thought and tool content are not assistant final text.
- Current prompt submission is not echoed as a `user_message_chunk`; that update is used for history replay. **Source-observed** from the prompt and history paths above. The harness already knows every prompt it sends and must emit/classify its own submitted-user-message boundary as managed or human. It must never infer origin by logging or comparing prompt bodies.
- Completion markers may be split across chunks. **Inferred.** Scan only the assembled assistant message at the prompt response, not individual deltas, thoughts, tool output, replay, stderr, or the prompt result's `_meta`.

## Tool Activity And Approvals

- Gemini executes tools itself and reports structured activity. Without a confirmation requirement it sends `tool_call` with `in_progress`, then `tool_call_update` with `completed` or `failed`; updates include stable call IDs, titles, mapped kinds, locations, text results, and file diffs where available ([tool execution](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L659-L943), [content conversion](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpUtils.ts#L47-L82)). **Source-observed.** Tool failure is usually fed back to the model and does not necessarily fail the prompt.
- When confirmation is required, Gemini calls the client method `session/request_permission` with a pending tool call and semantic options. It converts the selected provider-specific option to Gemini's confirmation outcome and updates policy for session/permanent approvals where enabled ([permission flow](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L711-L809), [option construction](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpUtils.ts#L85-L200)). **Source-observed.** The harness owns presenting or applying user policy and must return one offered option or `cancelled`; it must not invent approval.
- Session modes are `default` (prompt), `auto_edit`, `yolo`, and, when enabled, `plan`; `session/set_mode` changes the mode ([mode definitions](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpUtils.ts#L224-L252), [setter](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L207-L218)). **Source-observed.** Workspace trust can force approval back to `default` ([trust override](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/config/config.ts#L750-L764)); requested auto-approval is not proof of effective auto-approval.
- ACP cancellation requires the client to resolve pending permission requests with `cancelled` and permits final updates before the prompt's cancelled response ([ACP cancellation contract](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/prompt-turn.mdx#L312-L345)). **Documented.** Permission handling and prompt cancellation must share one cancellation state machine.

## Questions And User Input

- Gemini explicitly excludes its `ask_user` tool in ACP mode because IDE interception of tool calls breaks that conversational flow ([ACP-mode exclusion](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/config/config.ts#L782-L806)). **Source-observed.** The current dispatcher neither advertises elicitation nor calls `elicitation/create`.
- Structured permission requests are not general questions. The model can still ask a question in ordinary `agent_message_chunk` text, return `end_turn`, and receive the user's answer in a later `session/prompt`. **Inferred from the prompt lifecycle.** A harness must model this as two turns, not pretend Gemini can pause a turn for arbitrary structured input.
- There is no source-backed mid-turn free-form steering/input method. **Unknown/unsupported.** Do not map arbitrary terminal keystrokes or a Codex/Claude input primitive onto ACP. Only respond to a permission request, cancel the turn, or wait for turn completion and send another prompt.

## Interruption And Cancellation

- `session/cancel` is a notification, not a request. Gemini finds the session and aborts its current `AbortController`; the prompt loop converts abortion into `stopReason: cancelled` ([dispatcher](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L189-L208), [abort handling](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L311-L415)). **Source-observed.** Cancellation ends the prompt, not the session; a later prompt can continue.
- Starting another prompt aborts any prior pending prompt before installing a new controller ([prompt start](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L311-L315)). **Source-observed.** This is not a supported steering primitive; serialize prompts and wait for the cancelled response to avoid cross-turn attribution races.
- Calling cancel with no active generation throws internally, and cancelling an unknown session yields invalid-params `-32602` in the dispatcher. Because notifications have no response, the caller cannot rely on receiving those errors. **Source-observed.** Cancellation should be idempotent in the harness state and confirmed by the outstanding prompt's completion, not a cancel response.
- Process signals are session aborts, not turn interruption. Signal handlers perform global cleanup and exit successfully ([cleanup handlers](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/utils/cleanup.ts#L128-L149)). **Source-observed.** Preserve the distinction between `session/cancel` and terminating the process.

## Errors

- ACP methods use JSON-RPC success or error responses; notifications receive no response ([ACP overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/overview.mdx#L134-L145)). Gemini's SDK supplies standard parse/method/params/internal codes plus `-32000` authentication required ([SDK errors](https://github.com/agentclientprotocol/typescript-sdk/blob/9609d922dc855dc4446dfaef082416d34e0f123a/src/acp.ts#L1164-L1265)). **Documented and source-observed.** Preserve numeric code, message, method, request ID, and session ID in typed diagnostics without logging payload bodies or credentials.
- Gemini uses `-32602` for missing sessions, `-32000` for auth failures, direct `429` for rate limiting, the upstream status or `500` for stream errors, and humanizes nested Google API messages ([dispatcher errors](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L106-L160), [prompt errors](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L470-L547), [message extraction](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpErrors.ts#L9-L44)). **Source-observed.** Do not assume every non-standard error code lies in JSON-RPC's server-error range.
- Several invalid/empty/blocked model stream conditions are deliberately converted to a successful `end_turn` response rather than an error ([graceful stream handling](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L486-L547)). **Source-observed.** A Crucible stage must remain marker- and validation-driven; `end_turn` alone cannot mean stage success.
- Unexpected process exit, EOF before outstanding request completion, invalid stdout, duplicate/mismatched response IDs, and framing failure are transport/process failures even if no JSON-RPC error exists. **Inferred from ACP framing and process lifecycle.** They must not become synthetic successful turns.

## Shutdown And Process Lifecycle

- Current Gemini does not advertise or dispatch `session/close`; its session map is disposed only when the agent connection is disposed. **Source-observed** from the complete dispatcher surface and [manager disposal](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSessionManager.ts#L47-L56). Do not send unadvertised close/list/delete/logout methods.
- ACP stdio's normal lifecycle is client launch, message exchange, then client close of stdin and process termination ([transport lifecycle](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/transports.mdx#L17-L42)). Gemini awaits connection closure and always runs exit cleanup, specifically covering stdin EOF ([Gemini transport cleanup](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpStdioTransport.ts#L25-L34)). **Documented and source-observed.**
- Cleanup disposes provider config and flushes telemetry; `SIGINT`, `SIGTERM`, and `SIGHUP` are handled once ([cleanup implementation](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/utils/cleanup.ts#L75-L114), [signals](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/utils/cleanup.ts#L128-L149)). **Source-observed.** The harness should close stdin, wait a bounded grace period, then terminate the spawned process tree if necessary. A forced kill after validated stage completion is teardown, not retroactive stage failure; inability to reap the process is a cleanup failure.

## Authentication Ownership

- Gemini advertises four agent-owned methods: Google login, Gemini API key, Vertex AI, and AI API Gateway. `authenticate` validates the selected method, refreshes Gemini auth, and persists the selected type in user settings ([auth advertisement and handler](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L47-L79), [authentication](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L106-L167)). **Source-observed.** Authentication belongs to Gemini CLI; the harness selects/hosts the interaction but must not scrape Gemini credential stores.
- Existing settings/environment credentials can satisfy `session/new`; otherwise session creation returns authentication required or a specific missing-key error ([new-session auth](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSessionManager.ts#L71-L110)). **Source-observed.** `initialize` succeeding does not prove the next session can authenticate.
- `GEMINI_CLI_HOME` is the official isolation control for user-level configuration and storage on macOS/Linux and Windows ([configuration reference](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/docs/reference/configuration.md#L2626-L2633), [enterprise examples](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/docs/cli/enterprise.md#L217-L241)). **Documented.** A scoped home improves deterministic session discovery and avoids unrelated sessions, but an empty scope also lacks the user's existing auth. Credential reuse/copying requires an explicit security decision; it is not an adapter default.
- Gemini-specific `_meta['api-key']` and `_meta.gateway` fields allow API-key or gateway details to cross ACP, and Gemini advertises matching metadata hints ([extension source](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L47-L77), [parsing](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L115-L158)). **Source-observed Gemini extension.** ACP permits custom data only under `_meta` ([extensibility](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/protocol/v1/extensibility.mdx#L8-L40)). Secrets must never enter logs, traces, fixtures, issue comments, or run artifacts.
- Gemini advertises no logout capability. **Source-observed.** End the scoped process/home lifecycle instead of inventing logout semantics.

## Target Platforms

- Official recommended targets are macOS 15+, Windows 11 24H2+, and Ubuntu 20.04+, with Node.js 20+ and Bash, Zsh, or PowerShell ([installation requirements](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/docs/get-started/installation.mdx#L3-L21)). npm is cross-platform; Homebrew is documented for macOS/Linux and MacPorts for macOS ([installation methods](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/docs/get-started/installation.mdx#L23-L69)). **Documented.**
- Gemini's CI runs the CLI unit-test workspace on Linux, macOS, and Windows ([Linux](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/.github/workflows/ci.yml#L141-L201), [macOS](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/.github/workflows/ci.yml#L237-L292), [Windows](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/.github/workflows/ci.yml#L386-L467)); release verification installs/runs the package on all three ([release matrix](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/.github/workflows/verify-release.yml#L29-L57)). **Source-observed.** macOS unit tests are `continue-on-error`, and release smoke only checks version; neither proves ACP subprocess behavior.
- The ACP implementation uses Node streams, paths, UUIDs, and the shared CLI config. No ACP-specific OS branch was found in the relevant source. **Source-observed.** Equivalent ACP behavior on supported OS versions is a reasonable **inference**, but Windows signal/process-tree semantics, path replay, permission dialogs, auth/browser flow, stdin EOF, and clean stdout remain **unknown until direct acceptance tests**.

### Required platform gate

Before Crucible claims a platform supported, a pinned stable Gemini version must pass on that OS:

1. `gemini --acp` launch with stdout purity and stderr separation.
2. Initialize/version/capability capture.
3. Scoped-home authentication or an explicit pre-authenticated fixture.
4. New session, deterministic streamed prompt, and native session ID capture.
5. Permission allow, deny, and cancel paths.
6. Active prompt cancellation followed by a successful prompt in the same session.
7. Process restart plus `session/load`, replay isolation, and a new successful prompt.
8. Stdin-close graceful exit and bounded forced process-tree cleanup.

Until all three pass, report support per OS rather than promoting a generic Gemini ACP flag to an all-platform guarantee.

## Deterministic Testing Surface

- Gemini has hidden `--fake-responses`, `--fake-responses-non-strict`, and `--record-responses` options ([CLI definitions](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/config/config.ts#L474-L488)). The strict fake consumes newline-delimited canned responses in exact call order and throws on exhaustion or method mismatch; non-strict finds the next matching method ([fake generator](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/core/src/core/fakeContentGenerator.ts#L39-L113)). **Source-observed.** Strict mode is suitable for deterministic adapter acceptance fixtures, but hidden flags are internal test support, not a public compatibility promise.
- Upstream ACP unit tests use mocked `AgentSideConnection`, config, streams, tools, permission responses, errors, cancellation, and session loading. The resume test verifies replay of user, thought, assistant, and tool history ([resume test](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpResume.test.ts#L74-L312)); dispatcher tests cover initialize/auth/cancel/mode/model ([dispatcher tests](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.test.ts#L121-L338)). **Source-observed.**
- An upstream subprocess integration test launches the bundled CLI with `--acp --fake-responses`, a fake key, scoped `GEMINI_CLI_HOME`, and a real SDK client, then closes stdin and verifies telemetry flush ([ACP telemetry integration test](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/integration-tests/acp-telemetry.test.ts#L20-L115)). A separate environment/auth suite is currently `describe.skip` ([skipped auth suite](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/integration-tests/acp-env-auth.test.ts#L19-L43)). **Source-observed.** Upstream's subprocess coverage is useful but incomplete.
- Crucible should own a protocol fake for exhaustive adapter-state tests and use pinned real-Gemini fake-response subprocess tests for contract acceptance. **Inferred recommendation.** Do not make production support depend on test-only flags; do make release qualification detect their removal or behavior change.

## Gemini-Specific Extensions And ACP Gaps

### Gemini-specific extensions

1. `_meta['api-key']` on `authenticate`, plus the advertised `{'api-key': {provider: 'google'}}` hint. [Source](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L47-L62)
2. `_meta.gateway` auth request with `baseUrl` and headers, plus advertised protocol/restart hints. [Source](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L68-L77)
3. Prompt-response `_meta.quota.token_count` and `_meta.quota.model_usage`. [Source](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L605-L626)
4. File-diff `_meta.kind` values `add`, `delete`, or `modify`. [Source](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpUtils.ts#L61-L76)
5. Approval-mode changes encoded as ordinary assistant text `[MODE_UPDATE] <mode>` rather than a capability-defined control update. [Source](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpSession.ts#L178-L188)
6. Legacy `session/set_model` and session `models` metadata from SDK `0.16.1`, after that API's removal from current stable ACP artifacts. [Gemini source](https://github.com/google-gemini/gemini-cli/blob/41327e407da58aa01c409ef6685b7b5d379f295e/packages/cli/src/acp/acpRpcDispatcher.ts#L224-L235), [ACP removal](https://github.com/agentclientprotocol/agent-client-protocol/blob/1d0be14884d00de07350e85346a3cfa60ef8eb03/docs/rfds/updates.mdx#L194-L198)

Preserve unknown `_meta`; parse only fields with an explicit consumer and a pinned fixture. Never let extension metadata become orchestration truth.

### Spec gaps or divergences

- `session/load` replay completion is not awaited before the load response.
- The model selector is no longer part of current stable ACP and is not replaced by session config options.
- `ask_user` is disabled and no ACP elicitation capability is exposed.
- No session close/resume/list/delete or logout capability is exposed despite those methods existing in newer v1 artifacts.
- The pinned SDK drops malformed JSON lines after logging instead of returning a JSON-RPC parse error.
- Mode changes are injected into assistant content and can contaminate final-message accumulation unless recognized as Gemini control text.
- Gemini emits no message IDs on live assistant/thought chunks and no consolidated final assistant message.

These gaps must remain explicit adapter branches. They do not justify emulating missing Gemini behavior from another provider.

## Truthful Crucible Harness Adapter Constraints

The adapter must preserve all of the following:

1. **Use stdio, not PTY parsing.** Spawn `gemini --acp`, reserve stdout for NDJSON, capture stderr only as redacted diagnostics, and reject non-protocol stdout.
2. **Negotiate narrowly.** Send ACP v1 initialization, require returned major `1`, record capabilities, and call only advertised or explicitly version-pinned Gemini extension methods.
3. **Scope state deliberately.** Set `GEMINI_CLI_HOME` to a Crucible-owned root when isolation is required; do not mutate global settings. Treat auth migration into that scope as a separate user-approved security decision.
4. **Own outgoing user boundaries.** Emit submitted-message events from the adapter's own prompt calls with known managed/human origin. Do not wait for Gemini to echo live user messages and do not inspect bodies to infer origin.
5. **Accumulate current-turn text.** Correlate ordered `agent_message_chunk` updates with one outstanding prompt; exclude thoughts, tool output, replay, quota, stderr, and recognized mode-control text; emit one final assistant message only when the prompt response arrives.
6. **Keep marker authority.** Scan the assembled turn-final assistant text for Crucible markers. Never treat `end_turn`, process exit, a completed tool, or empty/blocked model output as stage success.
7. **Serialize prompts.** Do not overlap prompt requests or use a second prompt as steering. Cancel, await the first prompt's `cancelled` completion, then send the next prompt.
8. **Model permission as a client request.** Present or apply explicit policy to exactly the offered options, return `cancelled` during cancellation, and never silently auto-approve because another provider supports it.
9. **Keep tools observational unless required.** Tool activity may drive UI and diagnostics, but it is not a turn boundary or stage-completion signal.
10. **Call recovery what it is.** Persist the UUID from `session/new`; recover with history-replaying `session/load`; suppress/tag replay; tolerate the load-response race; fall back to durable Crucible artifacts when loading fails.
11. **Treat model control as conditional.** Prefer launch `--model`. If dynamic switching is required, pin and test legacy `session/set_model`, verify effective returned/current model where possible, and fail visibly if unsupported.
12. **Separate cancellation from shutdown.** Use `session/cancel` for an active turn. For session teardown, close stdin, wait, then terminate/reap the process tree. Do not claim `session/close` support.
13. **Preserve typed failures.** Distinguish launch, initialize/version, auth, JSON-RPC request, cancellation, unexpected EOF/exit, validation/marker, and cleanup failures. Log metadata only.
14. **Qualify each platform.** Keep Windows, macOS, and Linux support flags behind the real subprocess acceptance gate above; generic package availability is insufficient.
15. **Pin tests to evidence.** Own a fake ACP peer for adapter tests and run the stable Gemini bundle with strict `--fake-responses` for provider contract tests. A Gemini/SDK upgrade requires replay, framing, extension, and platform requalification.

## Local Observation

On 2026-08-15, the research host was Ubuntu Linux x86-64 with Node `v24.11.1` and an installed Gemini CLI `0.18.4`. `gemini --help` exposed only `--experimental-acp`; `gemini --acp` exited with `Unknown argument: acp`. **Locally observed.** This old installation does not contradict current stable `v0.55.1`; it demonstrates why the harness must version-check at discovery and must not infer ACP launch support from the mere presence of a `gemini` executable. No direct Windows or macOS observation was available.

## Decision Questions And Fog

1. **Recovery vocabulary:** Will Crucible's public `supportsResume` include ACP's history-replaying `session/load`, or should capabilities distinguish `loadWithReplay` from no-replay `resume`? The distinction is observable and affects event normalization.
2. **Authentication scope:** Should Crucible use the user's existing Gemini home, require authentication inside an isolated `GEMINI_CLI_HOME`, or provide an explicit credential-materialization flow? Security and recoverability differ; research does not choose for the user.
3. **Model requirement:** Is launch-time model selection sufficient, or does a real workflow require mid-session switching? The latter currently depends on a removed ACP API.
4. **Mode updates:** Should exact `[MODE_UPDATE]` chunks be retained as provider metadata or merely excluded from final assistant content? They must not be recorded as model prose.
5. **Platform proof:** Windows and macOS ACP subprocess behavior remains unobserved. Promotion should wait for the acceptance matrix, especially EOF, process-tree cleanup, auth, replay paths, and permission flows.
6. **Load replay race:** A real pinned-process fixture must establish a safe drain/correlation strategy before recovery is production-enabled. Source proves the missing await but not every scheduling order a client will observe.
7. **Retention/upgrade behavior:** Gemini provides no durable guarantee for session retention duration or cross-version history compatibility. Artifact fallback remains mandatory.

## Resolution

Gemini ACP is suitable for a structured Crucible adapter and likely for recoverable support through `session/load`, subject to the replay-race fixture and per-platform acceptance gate. It should not remain classified as PTY-only. Promotion must nevertheless preserve Gemini's actual envelope: ACP v1 over stdio, chunk accumulation to prompt-response turn boundaries, adapter-owned submitted-message origin, explicit client permissions, cancellation without steering, process-level shutdown, Gemini-owned authentication, conditional legacy model switching, replay-aware recovery, and no fabricated elicitation/session-close/current-ACP-model-config parity.
