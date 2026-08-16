# Codex App-Server Capability Envelope for Crucible

Research date: 2026-08-15

Upstream source snapshot: OpenAI Codex commit
[`85fc4def358b7df21883e72ae8dda43a0f572f32`](https://github.com/openai/codex/commit/85fc4def358b7df21883e72ae8dda43a0f572f32)

Ticket: [DevFlow-HQ/devflow-cli#15](https://github.com/DevFlow-HQ/devflow-cli/issues/15)

## Answer

Codex app-server is capable enough to be Crucible's first-class Codex Harness
Adapter boundary, including interactive sessions: it exposes structured thread and
turn identity, durable resume, complete turn and item lifecycles, streamed agent
content, tool activity, approvals, user questions, interruption, typed failures,
and Codex-owned authentication. OpenAI describes this as the interface for rich
clients rather than CI automation. However, the command itself remains
**experimental**, and OpenAI explicitly says it may change without notice. Crucible
must therefore treat it as a **version-pinned provider protocol**, not as a stable,
version-negotiated industry interface.[^app-docs][^cli-reference]

The recommended envelope is:

- Spawn `codex app-server` as a child and use its default **stdio JSONL** transport.
- Complete `initialize` and `initialized`, discover models through `model/list`,
  start or resume a persistent thread, then drive turns through `turn/start`.
- Keep `experimentalApi` off unless Crucible has a separately tested requirement;
  the core thread, turn, streaming, tool, approval, interruption, and error
  lifecycle is on the default schema, while native `requestUserInput` and some
  collaboration features remain experimental.
- Pin a tested Codex version range, generate the stable schema from that exact
  binary during adapter maintenance, and fail clearly on an incompatible runtime.
- Let Codex own credentials and persisted thread data. Crucible owns the child
  process, request correlation, UI policy, normalized events, and its mapping from
  a Crucible session to `thread.id`.

This conclusion is **inferred** from the documented protocol and first-party source,
not from completed Crucible implementation or a three-OS runtime certification.

## Evidence Vocabulary

- **Documented**: stated in current official OpenAI documentation.
- **Source-observed**: present in first-party source or schema at the pinned commit.
- **Locally observed**: directly observed on this Linux research host.
- **Inferred**: a Crucible design conclusion drawn from documented/source facts.
- **Unknown**: not established by the permitted primary sources or direct tests.

## Capability Matrix

| Area                      | Status                              | Capability and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                    | Documented, locally observed        | `codex app-server` launches the server; stdio is the default. This host has `codex-cli 0.147.0`, and `codex app-server --help` exposes stdio, WebSocket, Unix-socket, `off`, and schema-generation commands. Only the Linux observation is local.[^app-docs]                                                                                                                                                                                                                     |
| Initialization            | Documented, source-observed         | Exactly one `initialize` request is accepted per connection. It carries `clientInfo` and capabilities and returns `userAgent`, `codexHome`, `platformFamily`, and `platformOs`; requests before it fail with `Not initialized`, and a repeat fails with `Already initialized`. The client then sends `initialized`.[^app-init][^initialize-schema]                                                                                                                               |
| Transport framing         | Documented, source-observed         | The stdio wire is one JSON object per line. It follows bidirectional JSON-RPC 2.0 shapes but omits the `jsonrpc: "2.0"` member. Requests have `id`, `method`, and optional `params`; responses have the same string-or-integer `id` plus `result` or `error`; notifications omit `id`.[^app-protocol][^rpc-schema]                                                                                                                                                               |
| Requests and server calls | Documented, source-observed         | Communication is genuinely bidirectional. Codex sends ordinary notifications and also sends requests that Crucible must answer, including approval, user-input, MCP elicitation, permission, dynamic-tool, and optional attestation requests.[^server-requests]                                                                                                                                                                                                                  |
| Thread identity           | Source-observed                     | `thread.id` is the resumable conversation identifier and Codex-generated IDs are UUIDv7. `thread.sessionId` is a separate root shared by a fork tree; root threads normally have matching values, but forks do not. `forkedFromId` and `parentThreadId` carry other relationships.[^thread-data]                                                                                                                                                                                 |
| Persistence and resume    | Documented, source-observed         | `thread/start` creates and subscribes; `thread/resume` reopens a stored thread by `threadId`; `thread/fork` creates a new thread from history. `ephemeral: true` deliberately avoids disk materialization and returns no path, so it is outside Crucible's durable recovery claim.[^thread-lifecycle][^thread-data]                                                                                                                                                              |
| Models                    | Documented, source-observed         | `model/list` returns selectable IDs, hidden/default flags, input modalities, supported/default reasoning effort, personality support, service tiers, and upgrade metadata. `thread/start` and `turn/start` accept model overrides; turn overrides become sticky defaults for later turns.[^models-doc][^model-schema][^turn-schema]                                                                                                                                              |
| Agent selection           | Documented absence, source-observed | There is no stable generic `agentId` selector in `thread/start` or `turn/start`. The surface has a specific `review/start`, internal/subagent item activity, and experimental collaboration-mode APIs. A truthful adapter can select model/effort/personality and invoke review, but cannot advertise arbitrary named-agent selection from the stable protocol.[^thread-schema][^turn-schema][^app-overview]                                                                     |
| Streaming content         | Documented, source-observed         | A turn has `turn/started`, item lifecycles, deltas, and one terminal `turn/completed`. `item/agentMessage/delta` is ordered text to concatenate by `itemId`; the final `agentMessage` in `item/completed` is authoritative. `turn/completed` includes only a final-message summary fallback, not the canonical complete item list.[^events]                                                                                                                                      |
| Tool activity             | Documented, source-observed         | Typed items cover command execution, file changes, MCP and dynamic tools, collaboration tools, web search, image view/generation, sleep, reasoning, plans, review, and compaction. Command output and patch progress have dedicated deltas; final `item/completed` carries result status.[^items-doc][^item-schema]                                                                                                                                                              |
| Approvals                 | Documented, source-observed         | Command and file approvals are server-initiated requests correlated by JSON-RPC request ID plus `threadId`, `turnId`, and `itemId`. Decisions include accept, session acceptance, decline, cancel, and some policy amendments. A pending item starts before the request and completes after the answer; `serverRequest/resolved` closes client UI state.[^approvals]                                                                                                             |
| Questions and user input  | Documented, source-observed         | Experimental `item/tool/requestUserInput` carries one or more identified questions, options, `isOther`, `isSecret`, and required `isBlocking`; the client returns answers keyed by question ID. MCP can independently elicit form, extended-form, or URL input. These are requests, not passive events.[^questions-doc][^questions-schema]                                                                                                                                       |
| Same-turn input           | Documented, source-observed         | `turn/steer` appends user input to the active regular turn and requires the expected active turn ID. It does not start a new turn and rejects review/compaction or a mismatched/no active turn.[^interrupt-steer]                                                                                                                                                                                                                                                                |
| Interruption              | Documented, source-observed         | `turn/interrupt(threadId, turnId)` acknowledges the request, then the authoritative completion arrives as `turn/completed` with `status: "interrupted"`. It does not necessarily terminate background terminals. Interrupting also resolves pending server requests.[^interrupt-steer][^interrupt-test]                                                                                                                                                                          |
| Generic cancellation      | Documented absence                  | There is no documented JSON-RPC `$/cancelRequest` equivalent for arbitrary in-flight app-server requests. The protocol instead has operation-specific controls such as `turn/interrupt`, login cancel, command terminate, process kill, and background-terminal cleanup.[^app-overview]                                                                                                                                                                                          |
| Errors                    | Documented, source-observed         | Request failures use JSON-RPC errors (`-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal, and `-32001` overloaded). Mid-turn `error` notifications include `willRetry`; a terminal failed turn carries a `TurnError` with message, optional typed `codexErrorInfo`, and details.[^errors-doc][^error-codes][^error-schema]                                                                                                          |
| Shutdown                  | Source-observed                     | There is no app-server shutdown RPC. In stdio mode, stdin EOF closes the single connection, stops accepting work, performs a bounded drain of in-flight RPC handling/cleanup, shuts down loaded threads, and exits. The upstream test harness performs graceful shutdown by dropping child stdin and waiting. Signal-driven graceful restart logic is enabled for multi-client transports, not stdio.[^stdio-lifecycle][^process-lifecycle][^test-server]                        |
| Authentication            | Documented, source-observed         | Codex can own API-key persistence and ChatGPT browser/device OAuth, including token refresh; `account/read`, login, cancel, logout, and account notifications expose state. Authentication to a remote WebSocket listener is a separate transport concern. `CODEX_HOME` and OS credential-store settings determine where Codex state/credentials live.[^auth-doc][^auth-app-server]                                                                                              |
| Protocol evolution        | Documented, source-observed         | Generated TypeScript/JSON Schema is guaranteed to match the generating Codex binary. Generation defaults to a filtered stable surface; `--experimental` expands it, and runtime experimental use requires initialize opt-in. The command as a whole is still experimental.[^schema-evolution]                                                                                                                                                                                    |
| Version negotiation       | Source-observed, unknown guarantee  | `initialize` has no protocol-version field or server capability/version response. `clientInfo.version` identifies the client; it does not negotiate the wire. Source has `v1` and `v2` type namespaces on one method-addressed wire, but no handshake selects one. No backward-compatibility duration or semver policy for app-server was found.[^initialize-schema][^request-map]                                                                                               |
| Platform availability     | Documented, source-observed         | OpenAI publishes current `codex-app-server` binaries/packages for x86-64 and ARM64 on macOS, Linux, and Windows. The first-party release build matrices build app-server on those targets; the CLI itself has official installers for all three OS families.[^release][^release-unix][^release-windows][^cli-install]                                                                                                                                                            |
| Platform parity           | Unknown                             | Primary sources do not promise behaviorally identical approvals, sandboxing, process control, path handling, credentials, or signals on all OSes. `initialize` reports the actual platform, tool paths use the executor's native convention, Windows has its own sandbox setup API, and at least the first-party `turn_interrupt` integration suite is Unix-gated. Release availability is not parity certification.[^initialize-schema][^events][^windows-doc][^interrupt-test] |
| Test support              | Source-observed                     | Upstream tests spawn the real app-server under a temporary `CODEX_HOME`, use a local Wiremock Responses endpoint with deterministic SSE sequences, build fake rollout JSONL, and compare checked-in schemas with regenerated output. These helpers live in Rust test source; no supported standalone fake app-server package was found.[^test-server][^mock-server][^fake-rollout][^schema-tests]                                                                                |

## Launch and Initialization Contract

Crucible should spawn the resolved `codex` executable with `app-server`, pipe
stdin/stdout, keep stderr separate for diagnostics, and frame stdout strictly by
newline. Logs are documented on stderr and can be JSON with `LOG_FORMAT=json`; they
must never be parsed as protocol messages.[^app-protocol]

The first write must be an `initialize` request with a stable Crucible client name,
title, and Crucible version. `clientInfo.name` also identifies the integration in
OpenAI compliance logs. After the matching response, Crucible should send the
documented `initialized` notification even though current source only logs incoming
client notifications; relying on that implementation no-op would violate the
documented handshake and could break on a later version.[^app-init][^initialize-source][^client-notification]

`initialize.codexHome`, `platformFamily`, and `platformOs` should be retained as
diagnostic metadata. They are observations about the server process, not proof that
a remote executor or every returned path has the same OS convention.[^initialize-schema][^events]

## Threads, Turns, and Resumption

The recovery key is `thread.id`, not `sessionId`, rollout path, process ID, or turn
ID. Crucible should persist it as soon as `thread/start` succeeds and use
`thread/resume` after process loss. `sessionId` is useful tree metadata but cannot
replace the thread ID after a fork. Durable recovery must reject or downgrade
ephemeral threads.[^thread-data][^thread-lifecycle]

The request response from `turn/start` only says that a turn was accepted and gives
its initial state. It is not completion. Crucible must keep reading until the same
turn reaches `turn/completed`; process exit, EOF, an agent-message delta, an
`item/completed`, or the `turn/start` response cannot truthfully stand in for that
terminal event.[^events][^turn-schema]

For origin classification, Crucible can assign a unique `clientUserMessageId` to
every managed or human message it submits. The corresponding `userMessage` item
echoes it as `clientId`. Inputs restored from old history may lack this value, so the
adapter must preserve `unknown` rather than infer authorship from text.[^turn-schema][^items-doc]

## Streaming and Tool Semantics

Crucible may expose live text by concatenating `item/agentMessage/delta` in arrival
order for one `itemId`, but should normalize final assistant content from the final
`agentMessage` item. It must preserve the lifecycle ordering
`item/started -> deltas -> item/completed` and treat the completed item as
authoritative when streamed and final values differ.[^events]

Tool activity is not generic terminal text. Crucible can represent commands, file
changes, MCP calls, web searches, dynamic tools, and their typed statuses directly.
It must not execute the display `command` from an event: current docs say ordinary
command items can contain redacted display values, and executor-native paths may not
be local to the app-server OS.[^items-doc]

Reasoning deltas are a separate content class from agent messages. A truthful adapter
must not merge reasoning summaries/raw reasoning into the user's final assistant
message.[^events]

## Approvals and Human Input

Server-initiated requests reverse the usual direction: Codex supplies an `id`, and
Crucible must answer that exact ID with `result` or `error`. The adapter needs a
pending-request table independent of ordinary client requests. It should clear UI
state on `serverRequest/resolved`, including when interruption resolves a request
before the human answers.[^rpc-schema][^approvals][^questions-doc]

Approval policy and reviewer are explicit thread/turn settings. Crucible must not
silently translate a manual policy into auto-accept, `never`, or `auto_review`.
Likewise, approval decision `cancel` interrupts the turn while `decline` allows it to
continue; those outcomes cannot be normalized as the same denial.[^thread-schema][^turn-schema][^item-schema]

`item/tool/requestUserInput` is currently experimental. If Crucible needs Codex's
native question tool, it must opt into the experimental surface and accept the
additional compatibility burden. Stable Crucible can still submit subsequent turns
or steer an active regular turn, but that is not equivalent to answering a blocking
tool request.[^questions-schema][^schema-evolution]

## Errors, Interruption, and Process Lifecycle

Crucible needs three error planes:

1. A JSON-RPC error rejects one request and retains its request ID.
2. A mid-turn `error` notification reports a model/runtime problem and whether Codex
   will retry.
3. `turn/completed` with `failed` is the authoritative terminal turn failure.

It must not fail a turn on a retrying error notification or report success merely
because a request received a successful response.[^errors-doc][^error-schema]

For user interruption, send `turn/interrupt`, wait for its response, and continue
reading until terminal `turn/completed: interrupted`. Background terminals are a
separate lifecycle. A timeout may justify process termination, but that must be
reported as adapter/process loss, not as a provider-confirmed interrupted turn.[^interrupt-steer]

For normal shutdown, first resolve/interrupt active work as product policy requires,
then close stdin and wait for the child. Current source uses stdin EOF as stdio
shutdown and the first-party test harness follows that path. Crucible should retain a
bounded kill fallback, but forced termination cannot be labelled graceful or
provider-confirmed.[^stdio-lifecycle][^test-server]

## Authentication Ownership

Codex, not Crucible, should parse, store, refresh, and remove OpenAI credentials.
Crucible may drive the `account/*` RPC UX and choose the `CODEX_HOME` supplied to the
child, but it should treat auth files and keyring entries as opaque secrets. OpenAI
documents file, keyring, and automatic credential stores and warns that
`auth.json` contains access tokens.[^auth-doc][^auth-app-server]

A new empty scoped `CODEX_HOME` is therefore not transparent: it may isolate the
server from the user's existing login and persisted threads. **Inferred:** Crucible
must choose and document either user-owned Codex state, a Crucible-owned persistent
Codex home with Codex-driven login, or a deliberate credential-seeding mechanism.
It cannot promise resume while deleting the state that backs the thread.[^auth-doc][^thread-lifecycle]

WebSocket bearer authentication protects access to the app-server transport; it
does not authenticate model requests to OpenAI. The stdio recommendation avoids a
network listener and this extra trust boundary.[^app-protocol]

## Version and Platform Policy

There is no protocol version negotiation to rescue a client/server mismatch.
Crucible should record `codex --version`, maintain a tested range, reject known-bad
versions before starting work, and regenerate the **stable** schema from each
supported binary. Unknown notifications may be ignored with diagnostics, but an
unknown required response shape, item variant, or terminal status must become a
typed protocol incompatibility rather than guessed behavior.[^schema-evolution][^initialize-schema]

The label "stable surface" only distinguishes default schema members from members
gated by `experimentalApi`; it does not make the experimental app-server command a
production compatibility promise. Crucible should avoid experimental methods unless
a product requirement outweighs this cost, and test them behind their own adapter
capability/version gate.[^schema-evolution][^cli-reference]

Current release evidence is strong for binary availability on:

- macOS x86-64 and ARM64;
- Linux x86-64 and ARM64 (published app-server artifacts are MUSL-linked);
- Windows x86-64 and ARM64 MSVC.[^release][^release-unix][^release-windows]

It is not enough to claim cross-platform behavioral parity. Crucible needs its own
smoke matrix on all target OSes for launch/initialize, one no-tool turn, one command,
one file edit, approval round trip, interruption, resume after process restart,
credential discovery, and graceful stdin shutdown. Windows should additionally
exercise native sandbox setup and native path handling; macOS should exercise its
credential-store and sandbox behavior. Until those run, platform behavior beyond
published availability remains **unknown**.[^windows-doc][^events]

## Deterministic Test Strategy

**Source-observed:** OpenAI's own integration pattern is reproducible: spawn the real
server with a temporary `CODEX_HOME`, point a custom model provider at a local mock
Responses endpoint, feed deterministic SSE sequences for messages/tools/errors, and
assert JSON-RPC output. The repository also contains fake rollout builders for list,
read, resume, and fork tests and checks generated schemas against committed
fixtures.[^test-server][^mock-server][^fake-rollout][^schema-tests]

**Inferred for Crucible:** use two layers:

- A small scripted fake at Crucible's process/transport seam for exhaustive parser,
  ordering, malformed-frame, timeout, request-correlation, and forward-compatibility
  tests. It must identify itself as a fake and model the pinned schema, not claim to
  validate Codex behavior.
- Version-pinned contract tests against the real app-server and a local fake model
  backend, followed by the three-OS smoke matrix. Keep credentials and the public
  network out of deterministic tests.

No supported, standalone first-party fake app-server distribution was found.
Upstream Rust test helpers are useful evidence and examples, not an API Crucible can
depend on.

## Truth Constraints for the Crucible Harness Adapter

The adapter must preserve all of these constraints:

1. **One protocol stream, one parser.** Treat stdout as JSONL only and stderr as
   diagnostics only; never scrape terminal decoration.
2. **Correlate both directions.** Maintain client request IDs and server request IDs
   separately and answer approvals/questions on the exact server ID.
3. **Preserve native identity.** Store `thread.id` for resume; retain but do not
   conflate `sessionId`, `turn.id`, fork, parent, and item IDs.
4. **Use terminal truth.** Emit normalized turn completion only from
   `turn/completed`; preserve `completed`, `interrupted`, and `failed` distinctly.
5. **Use final-item truth.** Deltas are previews; `item/completed` is authoritative.
   Do not turn tool/reasoning text into assistant final content.
6. **Preserve unknown origin.** Use echoed `clientId` and adapter records; never
   classify old/unmatched user content by inspecting its text.
7. **Do not invent agent selection.** Advertise model, effort, personality, review,
   and only explicitly supported collaboration capabilities. No stable arbitrary
   agent picker exists.
8. **Do not bypass consent silently.** Expose or explicitly configure approval and
   question behavior; preserve decline versus cancel and clear resolved requests.
9. **Keep auth opaque.** Let Codex own login and token refresh, redact credentials,
   and make the selected persistent `CODEX_HOME` policy explicit.
10. **Interrupt before killing.** Wait for provider-confirmed interruption when
    possible; report a killed or vanished child as process loss.
11. **Pin compatibility.** Check the installed version, bind parsing to its generated
    stable schema, gate experimental fields separately, and fail closed on required
    unknown shapes.
12. **Qualify platform claims.** Report the runtime platform returned by initialize
    and only claim features exercised by Crucible's OS/version test matrix.

## Decision Fog

The research resolves upstream capability, but leaves these downstream choices:

1. What exact Codex version range will Crucible support, and who advances the pinned
   generated schema when Codex releases?
2. Will Crucible use the user's `CODEX_HOME`, maintain a persistent Crucible-owned
   home, or require login in each isolated home?
3. Does Crucible require native blocking `requestUserInput` now? If yes, that one
   requirement opts the adapter into the experimental schema.
4. Which approval modes must Crucible expose: manual, Codex auto-review, unattended
   `never`, or a product-defined subset?
5. Is arbitrary named-agent selection a Crucible requirement? The stable app-server
   surface does not establish it.
6. What CI/host pool will provide actual Windows and macOS contract coverage? Current
   first-party release evidence does not replace Crucible-run parity tests.

## Primary Sources

[^app-docs]: OpenAI, [Codex App Server](https://developers.openai.com/codex/app-server.md), including intended use and experimental status.

[^cli-reference]: OpenAI, [Developer commands: `codex app-server`](https://developers.openai.com/codex/developer-commands.md#codex-app-server), marks the command experimental and subject to change.

[^app-protocol]: OpenAI Codex source, [`app-server/README.md` lines 20-64](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L20-L64).

[^app-init]: OpenAI Codex source, [`app-server/README.md` lines 76-159](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L76-L159).

[^initialize-schema]: OpenAI Codex protocol source, [`v1.rs` lines 27-80](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v1.rs#L27-L80).

[^initialize-source]: OpenAI Codex source, [`initialize_processor.rs` lines 44-158](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/src/request_processors/initialize_processor.rs#L44-L158).

[^client-notification]: OpenAI Codex source, [`message_processor.rs` lines 658-668](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/src/message_processor.rs#L658-L668) and [`common.rs` lines 1875-1877](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/common.rs#L1875-L1877).

[^rpc-schema]: OpenAI Codex protocol source, [`rpc.rs`](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/rpc.rs).

[^request-map]: OpenAI Codex protocol source, [`common.rs` lines 487-522](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/common.rs#L487-L522).

[^server-requests]: OpenAI Codex protocol source, [`common.rs` lines 1592-1648](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/common.rs#L1592-L1648).

[^thread-lifecycle]: OpenAI Codex source, [`app-server/README.md` thread lifecycle](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L76-L83) and [`thread.rs` resume contract lines 308-380](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L308-L380).

[^thread-data]: OpenAI Codex protocol source, [`thread_data.rs` lines 193-312](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L193-L312).

[^thread-schema]: OpenAI Codex protocol source, [`thread.rs` lines 52-204](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L52-L204).

[^turn-schema]: OpenAI Codex protocol source, [`turn.rs` lines 27-217](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L27-L217).

[^models-doc]: OpenAI, [App-server models](https://developers.openai.com/codex/app-server.md#models).

[^model-schema]: OpenAI Codex protocol source, [`model.rs` lines 36-152](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L36-L152).

[^app-overview]: OpenAI Codex source, [`app-server/README.md` API overview lines 161-282](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L161-L282).

[^events]: OpenAI Codex source, [`app-server/README.md` lines 1530-1654](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L1530-L1654).

[^items-doc]: OpenAI Codex source, [`app-server/README.md` lines 1597-1654](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L1597-L1654).

[^item-schema]: OpenAI Codex protocol source, [`item.rs` command decisions lines 57-118](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L57-L118) and [`ThreadItem` lines 226-401](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L226-L401).

[^approvals]: OpenAI Codex source, [`app-server/README.md` lines 1680-1707](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L1680-L1707).

[^questions-doc]: OpenAI Codex source, [`app-server/README.md` lines 1709-1745](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L1709-L1745).

[^questions-schema]: OpenAI Codex protocol source, [`item.rs` lines 1615-1697](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1615-L1697).

[^interrupt-steer]: OpenAI Codex source, [`app-server/README.md` lines 1153-1221](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L1153-L1221).

[^interrupt-test]: OpenAI Codex source, Unix-gated [`turn_interrupt.rs` lines 1-123](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs#L1-L123).

[^errors-doc]: OpenAI Codex source, [`app-server/README.md` lines 1656-1678](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L1656-L1678).

[^error-codes]: OpenAI Codex source, [`error_code.rs`](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/src/error_code.rs).

[^error-schema]: OpenAI Codex protocol source, [`notification.rs` lines 38-56](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/notification.rs#L38-L56) and [`thread_data.rs` lines 265-312](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L265-L312).

[^stdio-lifecycle]: OpenAI Codex source, [`stdio.rs` lines 24-100](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-transport/src/transport/stdio.rs#L24-L100).

[^process-lifecycle]: OpenAI Codex source, [`app-server/lib.rs` lines 725-760](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/src/lib.rs#L725-L760) and [`970-1208`](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/src/lib.rs#L970-L1208).

[^auth-doc]: OpenAI, [Codex authentication](https://developers.openai.com/codex/auth.md), including login ownership and credential storage.

[^auth-app-server]: OpenAI Codex source, [`app-server/README.md` lines 2226-2373](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L2226-L2373).

[^schema-evolution]: OpenAI Codex source, [`app-server/README.md` lines 2455-2515](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/README.md#L2455-L2515) and [`precomputed_exports.rs` lines 14-122](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/precomputed_exports.rs#L14-L122).

[^release]: OpenAI Codex [release `rust-v0.147.0`](https://github.com/openai/codex/releases/tag/rust-v0.147.0), published 2026-08-07 with app-server artifacts for all named targets.

[^release-unix]: OpenAI Codex source, [macOS/Linux app-server release matrix](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/.github/workflows/rust-release.yml#L80-L131).

[^release-windows]: OpenAI Codex source, [Windows app-server release matrix](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/.github/workflows/rust-release-windows.yml#L1-L66).

[^cli-install]: OpenAI, [Codex CLI installation](https://developers.openai.com/codex/cli.md#getting-started), with official macOS/Linux and Windows installers.

[^windows-doc]: OpenAI, [Windows sandbox and support matrix](https://developers.openai.com/codex/windows.md).

[^test-server]: OpenAI Codex source, [`TestAppServer` lines 145-195 and 227-309](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/tests/common/test_app_server.rs#L145-L195).

[^mock-server]: OpenAI Codex source, [deterministic mock model server](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/tests/common/mock_model_server.rs).

[^fake-rollout]: OpenAI Codex source, [fake rollout builders](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server/tests/common/rollout.rs#L22-L93).

[^schema-tests]: OpenAI Codex source, [schema fixture regeneration checks](https://github.com/openai/codex/blob/85fc4def358b7df21883e72ae8dda43a0f572f32/codex-rs/app-server-protocol/src/schema_fixtures_tests.rs#L19-L94).
