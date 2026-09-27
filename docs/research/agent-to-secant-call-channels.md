# Agent-to-Secant Call Channels and Caller Identification

Research date: 2026-09-27

Versions examined:

- Secant at [`9388dec`](https://github.com/secantdev/secant/tree/9388dec6dd33119005cdb0e1881007ef720cd14d), Bun 1.4.2.
- Claude Code 2.1.283 (installed on the Linux research host); `code.claude.com` documentation fetched 2026-09-27; Claude Agent SDK 0.3.283
  type declarations; Anthropic `sandbox-runtime` at
  [`ddbeb74`](https://github.com/anthropic-experimental/sandbox-runtime/tree/ddbeb74711c4097014ef3056791efa83f553116c).
- Codex CLI 0.157.1 (installed), source tag `rust-v0.157.1` at
  [`3665039`](https://github.com/openai/codex/tree/36650394c5b38c2990ccf2a3457165ca3e9d9726); OpenAI Codex documentation fetched 2026-09-27
  (the `developers.openai.com/codex/*.md` URLs now redirect to `learn.chatgpt.com/docs/*.md`).
- Linux man-pages 6.19 (man7.org), Apple XNU at
  [`f6217f8`](https://github.com/apple-oss-distributions/xnu/tree/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea), Microsoft Learn Win32 pages fetched
  2026-09-27, Node.js `net` and `child_process` documentation (current).
- Peer products: T3 Code local checkout at `de251fc` (`pingdotgg/t3code`), OpenCode local checkout at `228e909` (`anomalyco/opencode`).

Ticket: [#241](https://github.com/secantdev/secant/issues/241)

## Answer

An agent inside a Harness Session can make a deliberate call to Secant by two routes. Every other mechanism examined either observes one of these
calls (hooks, event-stream correlation) or avoids IPC altogether (a file drop):

1. **A Harness-native tool whose server Secant attaches per Session.** Both Harnesses accept an MCP server supplied at launch: Claude Code through
   `--mcp-config` (stdio, HTTP, SSE, or WebSocket), Codex through `mcp_servers.*` config, which the stable `thread/start` `config` map accepts per
   thread. Codex also has client-executed **dynamic tools** whose call arrives on Secant's own app-server connection carrying `threadId` and `turnId`,
   but that surface is experimental and Secant keeps `experimentalApi` off. Claude Code's equivalent, in-process SDK MCP servers, exists only on the
   Agent SDK's undocumented stdio control protocol. In both Harnesses the MCP server runs outside the command sandbox.[^cc-cli][^cx-thread-start][^cx-dynamic][^sdk-mcp][^cc-sandbox-scope]
2. **A command the agent runs through the Harness's shell tool**, for example the `secant` executable with a subcommand. The command is only a
   client: it still has to reach the running Secant over a Unix domain socket, a Windows named pipe, or loopback TCP, and it does so from _inside_
   whatever sandbox the Harness applies to shell commands. Codex's default `workspace-write` sandbox turns network off. Its Linux and macOS
   implementations block that connection by default, and so does the preferred Windows `elevated` sandbox; the `unelevated` fallback relies on
   environment-level offline controls. Claude Code's sandbox is off by default and absent on native Windows, but when it is on it blocks Unix
   sockets and filters loopback traffic.[^cx-approvals][^cx-landlock][^cx-seatbelt][^cx-win-firewall][^cc-sandbox]

Approval rules differ sharply. Claude Code treats an MCP tool call like any tool needing permission; under Secant's current launch, which passes no
allow rules, that prompt is routed to Secant's own MCP permission bridge. Codex, by default, requires approval for any MCP tool that is not annotated
read-only, and raises it as an `mcpServer/elicitation/request`. Secant's Codex Adapter currently treats every server request it does not model as a
protocol failure of the Turn.[^cc-perm-eval][^sec-bridge][^cx-mcp-approval][^sec-codex-unsupported]

Secant can identify the calling Session without the agent supplying identity, but only at different strengths:

- **Per-Session attachment.** Secant writes the identity into each Session's launch or thread configuration: argv, env, URL, or header. The model
  never has to supply it. It is not secret from other processes of the same user, because another Session's argv and environment are readable
  through the operating system.
- **Harness-attested identity.** The Harness tags the call itself on a channel Secant already owns: Codex dynamic-tool `threadId` or the Session's
  own stream of tool events, which Secant already reads.
- **Harness-injected environment variables.** Claude Code sets `CLAUDE_CODE_SESSION_ID` and Codex sets `CODEX_THREAD_ID` in shell-tool children,
  and both equal the ids Secant already records. They need no agent input but are trivially overridable by the agent's own command line.
- **Operating-system peer identity plus process ancestry.** This is kernel-attested for the PID and user id. Mapping a PID to a Session through
  ancestry is dependable on Linux, weaker on macOS, and weakest on Windows. Anthropic's own cross-session messaging draws the same line and falls
  back to a per-session token on native Windows.

Constraints: ADR 0030 makes any CLI the same compiled binary re-invoked with a subcommand, and Bun and Node expose no peer-credential API outside
`bun:ffi`, which ADR 0030 limits to a named allowlist. ADR 0022 and `src/harness/AGENTS.md` keep any per-Session attachment, native id, and recovery
coordinate private to the Adapter, as the permission bridge already is. This report does not choose a mechanism. The matrix at the end compares them.

## Evidence Vocabulary

- **Documented**: stated in current official Anthropic, OpenAI, OS-vendor, or runtime documentation.
- **Source-observed**: present in first-party source at the pinned commit.
- **Locally observed**: directly observed on this Linux research host (Claude Code 2.1.283, Codex CLI 0.157.1).
- **Inferred**: a conclusion drawn from documented or source facts, not tested.
- **Unknown**: not established by the permitted primary sources or direct tests.

## Secant's Current Attachment Points

These facts bound what a per-Session attachment would reuse:

- **Claude Code: one process per Session.** Each Harness Session is its own `claude -p --input-format stream-json ...` process. Its argv is built
  per launch and its environment is `process.env`. A first launch mints `--session-id` and a relaunch uses `--resume` with the same id. Anything
  Secant puts on that argv or env is therefore already per Session. (Source-observed.)[^sec-claude-launch]
- **Claude Code: the existing MCP bridge.** Secant already runs a loopback Streamable-HTTP MCP server, bound to `127.0.0.1` on a random port with
  a 256-bit bearer token, and attaches it with `--mcp-config` plus `--permission-prompt-tool`. There is one bridge per prepared Harness, shared by
  all of its Sessions. It keeps a transport per MCP session but routes every call to "whatever Turn is active", because "approvals need no session
  affinity". The bearer appears only in the `--mcp-config` argv. (Source-observed.)[^sec-bridge]
- **Codex: one app-server per prepared Harness.** Every Session of a prepared Harness is a thread on the same child process. Anything set in that
  child's environment is shared by all of those Sessions. Per-thread configuration already crosses on `thread/start`: Secant sends
  `config: {"sandbox_workspace_write.writable_roots": [...]}` for #214. (Source-observed.)[^sec-codex-thread]
- **Codex: server requests outside the model fail the Turn.** The Adapter models only command and file-change approvals. Any other server request
  from Codex becomes `unsupported-server-request` and fails the Turn as a protocol failure. (Source-observed.)[^sec-codex-unsupported]
- **Profile posture.** The Claude Code profile declares "no `--bare`, `--strict-mcp-config`, `--allowedTools`, `--tools`, or permission-mode
  flag", so the user's settings, hooks, and MCP servers apply. The Codex profile leaves approval and sandbox policy "unset by Secant". Any mechanism
  therefore runs under whatever sandbox and approval posture the user has configured. (Source-observed.)[^sec-claude-profile][^sec-codex-profile]

## Mechanism A: A Secant-Provided MCP Server Attached Per Session

### Claude Code

- **Launch attachment (Documented).** `--mcp-config` loads servers "from JSON files or strings". With `-p`, Claude Code waits for pending
  servers to connect before the first Turn, for up to `MCP_TIMEOUT` (30 s default). `--strict-mcp-config` restricts the Session to `--mcp-config`
  servers only. A configured stdio entry receives an `env` map. HTTP, SSE, and WebSocket entries receive `url` and `headers`.[^cc-cli][^cc-mcp-add]
- **Stdio server identity (Documented).** Claude Code sets `CLAUDE_CODE_SESSION_ID` in stdio MCP server subprocesses, and "an MCP server subprocess
  retains the ID it was spawned with". On `--resume <session-id>`, the server receives the resumed id. It also sets `CLAUDECODE=1` and
  `CLAUDE_PROJECT_DIR`.[^cc-env-session][^cc-mcp-stdio]
- **Stdio server identity (Locally observed).** On Claude Code 2.1.283, a stdio server passed through `--mcp-config` ran as a direct child of the
  `claude` process. It received its configured argv and `env`, the full parent environment (a variable set only on the `claude` spawn arrived), and
  `CLAUDE_CODE_SESSION_ID` equal to the `--session-id` Secant minted. The probe script exits without speaking MCP, and the same `claude` process
  started it twice, which is consistent with Claude Code's documented reconnection. No model request was made: the probe sent no user
  message.[^cc-mcp-reconnect]
- **Permissions (Documented).** "MCP tools require explicit permission before Claude can use them." Allow rules use `mcp__<server>__*`.
  `acceptEdits` does not auto-approve MCP tools, `bypassPermissions` does, and `dontAsk` denies anything not pre-allowed.[^sdk-mcp-perm][^cc-perm-eval]
  A tool whose `tools/list` entry sets `_meta["anthropic/requiresUserInteraction"]: true` always prompts. The `--permission-prompt-tool` cannot
  approve such a tool: Claude Code converts its `allow` to a deny.[^cc-requires-interaction][^cc-cli]
- **Permissions under Secant (Source-observed and Inferred).** Secant passes no allow rules, so a call to a Secant MCP tool that no user rule
  allows produces a permission prompt. That prompt reaches Secant's own `approve` bridge tool, which today raises it to the human as an approval
  Harness Request.[^sec-bridge]
- **Discovery (Documented).** MCP tool search is on by default: "only tool names and server instructions load at session start". The agent
  discovers the full tool definition on demand, and server instructions help it know when to search.[^cc-tool-search]
- **Sandbox (Documented).** The Claude Code sandbox "applies only to Bash, PowerShell, and Monitor commands and their child processes". The docs
  describe MCP servers and hooks as things "Claude Code runs outside the sandbox". An MCP call is therefore not subject to sandbox network rules on
  any OS.[^cc-sandbox-scope]
- **Enterprise block (Documented).** A deployed `managed-mcp.json` makes Claude Code refuse servers "passed with the `--mcp-config` CLI flag". This
  affects the existing permission bridge equally.[^cc-managed-mcp]
- **In-process SDK MCP (Source-observed).** The Agent SDK's `type: 'sdk'` servers exchange `mcp_message` control requests over the SDK's stdio
  control channel. That would give per-process attribution for free. The earlier Secant research found no public raw-CLI contract for those control
  frames, so this route means adopting the SDK or an undocumented protocol.[^sdk-mcp][^prior-claude]

### Codex

- **Configuration (Documented).** `mcp_servers.<name>` supports stdio servers (`command`, `args`, `env`, `env_vars`) and Streamable-HTTP servers
  (`url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`). Defaults are `startup_timeout_sec = 10` and `tool_timeout_sec = 60`. `required`
  makes startup fail. Per-server `default_tools_approval_mode` and `tools.<tool>.approval_mode` take `auto`, `prompt`, `writes`, or
  `approve`.[^cx-mcp]
- **Per-thread attachment (Documented and Source-observed).** `thread/start.config` is a stable field. The app-server loads it through the same
  `load_with_overrides` path as other config, and each Session computes its MCP runtime from its own effective config. `thread/resume` accepts "the
  same configuration overrides supported by `thread/start`".[^cx-thread-start][^cx-config-load][^cx-session-mcp][^cx-resume]
- **Per-thread attachment (Locally observed).** On Codex CLI 0.157.1, two `thread/start` calls on one app-server, each with a different
  `config["mcp_servers.secant_probe"]` (distinct `args` and `env`), spawned two stdio server processes. Each was a direct child of the app-server and
  carried only its own thread's argv and env. The run used a temporary `CODEX_HOME`, `ephemeral: true`, and no login.
- **Server environment (Source-observed and Locally observed).** Stdio servers get a restricted environment: a fixed default list (`HOME`, `PATH`,
  `USER`, and similar, or Windows core variables), the `env_vars` allowlist, and explicit `env`. A variable set only on the app-server spawn did not
  reach the probe, and no `CODEX_THREAD_ID` is injected.[^cx-mcp-env]
- **Approvals (Source-observed).** In the default `auto` mode, a tool needs approval unless annotated `readOnlyHint: true`, or both
  `destructiveHint: false` and `openWorldHint: false`. Missing annotations count as destructive and open-world. `approve` mode skips approval. Under
  approval policy `never`, a call that needs approval is denied.[^cx-mcp-approval]
- **Approval channel (Source-observed).** Approval is raised as `mcpServer/elicitation/request` when the stable, default-on
  `tool_call_mcp_elicitation` feature is enabled. Otherwise it is raised as `item/tool/requestUserInput`. Neither is modelled by Secant's Codex
  Adapter today. The published app-server guide describes connector-tool approval through `tool/requestUserInput`; the source is more
  specific.[^cx-mcp-approval][^cx-feature][^cx-elicitation-doc][^sec-codex-unsupported]
- **Sandbox (Documented, Source-observed, and Locally observed).** Permission-profile network domain rules "do not restrict web search, apps, or
  MCP servers". The stdio launcher starts a server with `sandbox: None`, and the probe servers were direct children of the app-server process with
  no sandbox wrapper in between, so they do not run under the command sandbox.[^cx-network-domains][^cx-mcp-launch]

### Codex dynamic tools

- **Protocol (Documented and Source-observed).** `dynamicTools` on `thread/start`, and the `item/tool/call` server request it triggers, are
  "experimental APIs" that require `capabilities.experimentalApi = true`. The request carries `threadId`, `turnId`, `callId`, `tool`, and `arguments`.
  Codex persists the tools in the rollout and restores them on `thread/resume`. The call surfaces as `item/started` and `item/completed` with type
  `dynamicToolCall`.[^cx-dynamic][^cx-dynamic-schema]
- **Attribution (Inferred).** The call arrives on the one stdio connection Secant owns, already tagged with the thread, so no separate listener,
  credential, or OS lookup is involved. The cost is the experimental opt-in that the Codex capability research advised gating behind its own
  requirement.[^prior-codex]

### Transport inside the MCP route

- **Harness-to-server transports.** Claude Code offers stdio, HTTP, SSE, and WebSocket. Codex offers stdio and Streamable HTTP. Neither documents
  MCP over a Unix socket or named pipe. (Documented absence.)[^cc-mcp-add][^cx-mcp]
- **HTTP.** A loopback listener, as the existing bridge already runs. The TCP client is the Harness process itself: the `claude` process for one
  Session, or the shared app-server for all Sessions of a Codex prepared Harness. The Session therefore has to be distinguishable by URL, header, or
  token, not by connection alone. (Source-observed and Inferred.)[^sec-bridge][^sec-codex-thread]
- **Stdio.** The Harness spawns a server process, for example the `secant` binary re-invoked with a subcommand under ADR 0030. That process must
  then reach the main Secant process over native IPC (Mechanism C). It does so from outside the command sandbox, so the sandbox rules in Mechanism B
  do not apply to it. Secant can also check that the server's parent PID is the Harness child it spawned. Both probes above showed that parentage.
  (Inferred and Locally observed.)

## Mechanism B: A CLI Command the Agent Runs

- **Fit with ADR 0030 (Inferred).** Secant ships one Bun-compiled executable, so the CLI is that executable with a subcommand. ADR 0030's "direct
  spawning, no shell" rule governs how Secant spawns, not how the Harness's shell tool runs the agent's command. The command is always a client that
  must still connect to the running Secant over Mechanism C.[^adr-0030]
- **Identity already in the command's environment (Documented and Source-observed).**
  - Claude Code sets `CLAUDE_CODE_SESSION_ID` in Bash and PowerShell tool subprocesses, "matches the `session_id` field in the hook JSON input",
    and updates it on `/clear`. It also sets `CLAUDE_PID`, `CLAUDECODE`, and `CLAUDE_CODE_CHILD_SESSION=1`.[^cc-env-session][^cc-env-pid]
  - Codex's model shell commands receive `CODEX_THREAD_ID` (the thread id) and `CODEX_SESSION_ID` (the fork-tree root), set after the shell
    environment policy. `CODEX_THREAD_ID` "is injected ... even when `include_only` is set".[^cx-exec-env][^cx-shell-env]
  - Both values equal what Secant already records as the Session's recovery coordinate: Claude's minted `--session-id` and Codex's
    `thread.id`.[^sec-claude-launch][^sec-codex-thread]
- **Identity Secant injects (Source-observed and Inferred).**
  - For Claude Code, per-Session environment variables fit naturally, because each Session is its own process spawned with `env: process.env` and
    Claude Code hands its environment to hooks and tool children.[^sec-claude-launch][^cc-hook-env]
  - For Codex, app-server environment is shared across a prepared Harness. By default the shell policy inherits it all: `inherit = all`, with
    `ignore_default_excludes = true` keeping `*KEY*`, `*SECRET*`, and `*TOKEN*` names. A per-thread value would need a per-thread
    `shell_environment_policy.set` override. Its values are documented as "injected after exclusions", though "include filters can still remove
    them"; the per-thread route is inferred, not tested.[^cx-shell-env][^cx-shell-policy-default][^cx-shell-set]
  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials Claude Code recognises and, on Linux, puts Bash in a separate PID
    namespace.[^cc-env-scrub]
- **Spoofability (Inferred).** An environment variable is whatever the calling process says. The agent can prefix its own command
  (`CLAUDE_CODE_SESSION_ID=<other> secant ...`). A per-Session secret handed to the command is readable by the agent it is meant to identify. This
  mechanism identifies an honest caller, not an adversarial one.
- **Approvals (Documented).**
  - In Claude Code's Manual mode, Bash needs permission except for a built-in set of read-only commands. `Bash(secant *)` allow rules or the
    Harness's permission modes decide, and under Secant a prompt reaches the permission bridge.[^cc-tools-ref][^cc-perm-eval]
  - In Codex's `on-request` policy, sandboxed commands run without asking. Going beyond the sandbox, including network access, needs approval
    through `item/commandExecution/requestApproval`, which Secant already models.[^cx-approvals][^sec-codex-unsupported]
  - Codex `prefix_rule` rules can allow, prompt for, or forbid a command prefix "outside the sandbox".[^cx-rules]
- **Sandbox reach: Claude Code (Documented and Source-observed).**
  - The sandbox is `sandbox.enabled: false` by default and "native Windows is not supported".[^cc-sandbox-default][^cc-sandbox]
  - When it is on, Linux and WSL2 block `socket(AF_UNIX, ...)` through a seccomp filter unless `allowAllUnixSockets`. macOS blocks every Unix
    socket not listed in `allowUnixSockets`.[^cc-unix-sockets]
  - Network egress goes through a host proxy with a domain allowlist. On Linux, sandbox-runtime's `bwrap --unshare-net` isolates the network
    namespace, so the sandbox's `127.0.0.1` is not the host's. On macOS, loopback `connect` needs `allowLocalBinding`.[^srt-linux][^srt-macos]
  - A blocked command may be retried outside the sandbox through the ordinary permission flow unless `allowUnsandboxedCommands: false`.[^cc-sandbox-retry]
- **Sandbox reach: Codex (Documented and Source-observed).**
  - `workspace-write` "keeps network access turned off unless you enable it".[^cx-approvals]
  - On Linux, the network-off mode installs a seccomp filter that denies `connect`, `bind`, `listen`, `accept`, `sendto`, and related calls for
    every socket family, only allowing `socket(AF_UNIX)` creation. The `bwrap` launcher also unshares the network namespace. A sandboxed CLI therefore
    cannot reach a Unix socket or loopback port.[^cx-landlock][^cx-bwrap]
  - On macOS, Seatbelt starts from `(deny default)` and adds network rules only when network is on or a Unix-socket allowlist or proxy is configured.
    `permissions.<name>.network.unix_sockets` can admit a named socket path even with network off.[^cx-seatbelt][^cx-unix-allow]
  - On Windows, the `elevated` sandbox runs commands as dedicated lower-privilege sandbox users. Its firewall rules block non-loopback traffic and
    loopback TCP except proxy ports. The `unelevated` fallback uses a restricted token and "environment-level offline controls" (proxy variables
    pointed at `127.0.0.1:9`), which is weaker.[^cx-windows][^cx-win-firewall][^cx-win-env]
  - Loopback destinations are blocked unless allowed by an exact `localhost` rule or `allow_local_binding`.[^cx-local-dest]

## Mechanism C: Local Transports (Unix Socket, Named Pipe, Loopback TCP)

This is what a CLI (B) or a stdio MCP server process (A) uses to reach the running Secant.

### Availability and access control

- **Runtime (Documented and Source-observed).** Node's `net` IPC paths are Unix domain sockets on Unix and named pipes on Windows, where "the path
  _must_ refer to an entry in `\\?\pipe\` or `\\.\pipe\`". Windows removes the pipe when the owning process exits. Bun's socket layer maps pipes to
  named pipes on Windows.[^node-ipc][^bun-pipe]
- **Unix sockets (Documented).** On Linux, connecting to a pathname stream socket requires write permission on the socket file. The man page warns
  that "portable programs should not rely on this feature for security". Abstract sockets ignore permissions entirely.[^unix7-perms]
- **Network namespaces (Documented).** Network namespaces isolate the abstract socket namespace, so an abstract socket is unreachable from inside
  either Harness's Linux sandbox. Pathname sockets are filesystem-scoped.[^netns7]
- **Named pipes (Documented).** A pipe's default security descriptor grants full control to LocalSystem, administrators, and the creator owner, and
  only read access to Everyone and anonymous. `PIPE_REJECT_REMOTE_CLIENTS` refuses remote clients. `FILE_FLAG_FIRST_PIPE_INSTANCE` makes a second
  creation fail, which guards against a squatter creating the name first.[^win-pipe-sec][^win-createpipe]
- **Named pipes under Codex's elevated sandbox (Inferred).** Its commands run as a different user, so under the default descriptor they could open
  a Secant pipe for read but not write. The `unelevated` restricted-token case is Unknown.
- **Loopback TCP (Inferred).** Any local process of any user can connect, so the listener has to authenticate. The existing bridge uses a
  constant-time-checked 256-bit bearer for this.[^sec-bridge]

### Peer identity from the operating system

- **Linux (Documented).** `SO_PEERCRED` returns the peer's PID, UID, and GID "in effect at the time of the call to `connect(2)`". It works for
  connected `AF_UNIX` stream sockets. A PID passed over a Unix socket into another PID namespace is translated into the receiver's namespace.[^unix7-peercred][^pidns7]
- **macOS (Documented and Source-observed).** `getpeereid()` returns the peer's effective UID and GID for a Unix stream socket. XNU also defines
  `LOCAL_PEERPID`, `LOCAL_PEEREPID`, and `LOCAL_PEERTOKEN` (an audit token).[^mac-getpeereid][^xnu-un]
- **Windows (Documented).** `GetNamedPipeClientProcessId` "retrieves the client process identifier" for a named pipe.[^win-pipe-pid]
- **Loopback TCP (Documented).**
  - On Linux, `/proc/pid/fd` shows `socket:[inode]`, which `/proc/net/tcp` maps to local and remote addresses. Reading another process's fd table is
    subject to a ptrace access check.[^proc-fd][^proc-net]
  - On Windows, `GetExtendedTcpTable` with `TCP_TABLE_OWNER_PID_*` returns the owning PID of each connection.[^win-tcp-table]
  - macOS was not examined.
- **Reaching these from Secant (Inferred).** The Node `net` API documents no peer-credential accessor. Secant would need `bun:ffi` and the socket's
  file descriptor or pipe handle to call these APIs, and ADR 0030 limits `bun:` and `Bun.` to a named allowlist: the SQLite adapter, the Windows
  console guard, and the CLI entry check.[^node-ipc][^adr-0030]

### Process ancestry: from peer PID to Harness Session

- **APIs (Documented and Source-observed).**
  - Linux: `/proc/pid/stat` exposes `ppid`, `pgrp`, and `session`.[^proc-stat]
  - macOS: `proc_bsdinfo` has `pbi_ppid` and `pbi_pgid`, read via `PROC_PIDTBSDINFO`.[^xnu-procinfo]
  - Windows: `PROCESSENTRY32.th32ParentProcessID` is "the identifier of the process that created this process".[^win-processentry]
  - Windows can also test job-object membership with `IsProcessInJob`. Secant does not use job objects today: it kills trees with
    `taskkill /T /F`.[^win-isprocessinjob][^sec-process]
- **What Secant can anchor on (Source-observed).** Secant spawns each Harness child `detached` off Windows, which makes it "the leader of a new process
  group and session". Codex puts its own tool commands in new groups or sessions (`setpgid(0, 0)`, `setsid()`), so session-id matching does not
  survive into Codex tool commands. Only a parent-PID walk up to the Harness child does.[^sec-process][^node-detached][^cx-pgroup]
- **Ancestry breaks (Inferred).** A PID walk breaks when an intermediate process exits and its child is reparented, and it is exposed to PID reuse.
  Sandboxes add PID namespaces: Codex's `bwrap`, and Claude Code with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. That is harmless to kernel translation
  but can hide intermediate processes.[^pidns7][^cc-env-scrub]
- **Anthropic's precedent (Documented).** Claude Code's cross-session messaging inbox is a Unix socket on macOS and Linux and a named pipe on native
  Windows. It verifies "own-child" messages as follows:
  - On Linux, "by process evidence even for a child that has already exited".
  - On macOS, "only while the posting process is still running".
  - In a PID-1 container, not at all.
  - On native Windows, "it also has none", so there the per-session `CLAUDE_CODE_MESSAGING_TOKEN` "is the only way Claude Code verifies an own-child
    message".[^cc-messaging]
- **Spoofability (Inferred).** The kernel attests the PID and UID, so an unrelated process cannot claim to be a descendant of the Harness child.
  Every process the agent itself starts is a legitimate descendant, which is the intended caller. Peer identity proves "came from this Session's
  process tree", never "the model meant it".

## Mechanism D: Other Harness Surfaces

### Claude Code hooks

- **What they are (Documented).** Command, HTTP, and MCP-tool hooks can be injected with `--settings`. Hook input carries `session_id`,
  `tool_name`, `tool_input`, and `tool_use_id`. An HTTP hook POSTs that JSON to a URL with configured headers.
- **Use as a channel.** A `PreToolUse` or `PostToolUse` hook matching `mcp__secant__.*` or `Bash(secant *)` hands Secant a Harness-attested
  `session_id` for a deliberate call. It is not itself a call the agent makes.[^cc-hook-types][^cc-hook-input][^cc-http-hook]
- **What can block it (Documented).** `allowedHttpHookUrls`, `allowManagedHooksOnly`, and `disableAllHooks` can block injected hooks. Hooks run
  outside the sandbox.[^cc-hook-url][^cc-sandbox-scope]

### Codex hooks and `notify`

- **Hooks (Documented).** Hooks load from config layers (`hooks.json` or `[hooks]`), and each non-managed hook must be reviewed and trusted by hash.
  New or changed hooks are "skipped until trusted", unless `--dangerously-bypass-hook-trust` is passed. Input carries `session_id` and `turn_id`.[^cx-hooks]
- **`notify` (Documented).** `notify` runs only on `agent-turn-complete`, with a payload including `thread-id`. That duplicates `turn/completed`,
  which Secant already receives.[^cx-notify]

### Correlation with the Session's own event stream

- **Inferred.** Secant already parses each Session's structured stream: Claude `tool_use` blocks, and Codex `mcpToolCall`, `dynamicToolCall`, and
  `commandExecution` items tagged with `threadId`. A deliberate call through any channel also appears there as a tool event of the calling Session.
  That gives Harness-attested corroboration without the agent supplying identity. For a CLI call, the evidence is a command-text match, a form of
  reading agent-authored content that the source proposal wanted to avoid.[^sec-codex-thread][^idea]
- **Inferred.** ADR 0022 allows one active Turn per prepared Harness. A call arriving during a Turn is therefore circumstantially that Turn's, but
  background processes, other prepared Harnesses, and foreign processes make this exclusion, not proof.[^adr-0022]

### File drop in the writable directory

- **Inferred.** Secant already grants each launch one extra writable directory (#214), and both sandboxes admit writes there. A per-Session path
  inside it survives network-off sandboxes on all three OSes. It is not IPC: Secant would read the file at the Turn boundary. Any same-user writer
  can forge it.[^sec-writable]

## Constraints From Secant's Decisions

- **ADR 0030.** A CLI or stdio-server entry is the one compiled binary with a subcommand. Any native peer-credential call is `bun:ffi` outside the
  current allowlist. Windows IPC in Bun is a named pipe. No shell is needed on Secant's side.[^adr-0030]
- **ADR 0022 and `src/harness/AGENTS.md`.** The public Harness Interface admits "no native frame, protocol type, or conversation-id value".
  Recovery coordinates cross only as opaque values that "callers never decide from". The permission bridge is the precedent: it is private to the
  Harness Module, exposes only "launch flags, the bearer, a redactor and a teardown", and stays "never an MCP type".
- **What that means for attribution (Inferred).** Matching `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` to a Session is Adapter-private work,
  and a received call would cross the Seam as a normalized Harness fact. Secant-introduced secrets must stay redacted from diagnostics.[^sec-harness-agents][^adr-0022]
- **ADR 0020.** "A Repeat group ends ... never because an agent said so", and ADR 0020 retired an agent-emitted terminal marker. The ticket's input
  table names this as the rule the capability would supersede. This research informs that change but does not make it.[^adr-0020]

## Peer Products

- **T3 Code (Source-observed).** T3 Code serves a `t3-code` MCP toolkit from its own HTTP server at `http://127.0.0.1:<port>/mcp`.
  - It issues a credential per provider session (thread), resolves each request's bearer token to that thread's invocation scope, and rejects
    unknown or expired tokens.
  - Claude gets the server as an Agent SDK `mcpServers` HTTP entry with an `Authorization` header.
  - Codex gets it as app-server launch overrides `-c mcp_servers.t3-code.url=...` and `bearer_token_env_var="T3_MCP_BEARER_TOKEN"`, with the token
    in that app-server's environment.
  - It also prepends an `agent-device` CLI shim to the provider's `PATH` and pre-points it at its daemon, so "the agent never handles a token".[^t3-codex][^t3-claude][^t3-registry][^t3-shim]
- **OpenCode (Source-observed).** OpenCode is itself the agent, so host tools are in-process plugin tools. They load from `tool/*.ts`, and each
  receives `sessionID` in its context. A `shell.env` plugin hook receives `sessionID` and `callID` and can add per-session environment to shell
  commands. No cross-process attribution is needed.[^oc-registry][^oc-plugin-tool][^oc-shell-env]

## Mechanism Matrix

"Attribution" means identifying the calling Harness Session without the agent supplying identity.

### Attribution and spoofability

| Mechanism                                                                       | Claude Code support                                                                           | Codex support                                                                                          | Attribution                                                                                                                                                                       | Spoofability                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1. Per-Session stdio MCP server (Secant binary as server, IPC to main process) | Documented `--mcp-config` stdio; spawned by that Session's `claude` process; locally observed | Documented `mcp_servers`; per-thread via `thread/start.config`, locally observed one server per thread | Per-Session argv/env written by Secant; `CLAUDE_CODE_SESSION_ID` also present (Claude); server PPID = Harness child (Codex: shared app-server, so the thread comes from argv/env) | Model never supplies it. Same-user processes can read argv (`/proc/pid/cmdline`, world-readable under default `hidepid=0`) and env (ptrace check), so a deliberate forger can copy another Session's value |
| A2. Per-Session HTTP MCP server on loopback (existing bridge pattern)           | Documented `http` entries with headers; existing bridge                                       | Documented `url` + `http_headers` / `bearer_token_env_var`                                             | Per-Session URL, header, or bearer; TCP owner PID = `claude` process (per Session) or app-server (per prepared Harness)                                                           | As A1: the token sits in argv (Claude) or config/env (Codex); any local user can connect, so a bearer is required                                                                                          |
| A3. Harness-native in-band tool (Codex dynamic tools; Claude SDK MCP)           | Only via the Agent SDK control protocol (`mcp_message`); not a documented raw-CLI contract    | Experimental `dynamicTools` + `item/tool/call`; restored on resume                                     | Harness-attested: `threadId`/`turnId` on Secant's own stdio connection (Codex); per-process stdio (Claude SDK)                                                                    | Not forgeable by other processes; only the Harness can write to Secant's stdio                                                                                                                             |
| B. `secant` CLI run by the agent                                                | Bash/PowerShell tool; `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` in env                           | Shell tool; `CODEX_THREAD_ID`, `CODEX_SESSION_ID` in env                                               | Harness-injected env (no agent input needed); Secant-injected env (per Session for Claude; per-thread `shell_environment_policy.set` inferred for Codex); plus peer PID via C     | Env is fully agent-controlled; honest-caller identification only                                                                                                                                           |
| C. Unix socket / named pipe / loopback TCP listener (endpoint for A1 or B)      | Reachable from MCP servers and hooks; from Bash only as the sandbox allows                    | Reachable from MCP servers; from shell commands only when network or socket allowlisting permits       | Linux `SO_PEERCRED`; macOS `getpeereid` / `LOCAL_PEERPID`; Windows `GetNamedPipeClientProcessId`; TCP owner lookups; then ancestry to the Harness child                           | PID/UID kernel-attested; ancestry weaker on macOS (live processes only) and Windows (no process evidence, per Anthropic's own implementation)                                                              |
| D1. Claude Code hooks (observer of A or B)                                      | Documented; command, HTTP, and MCP-tool hooks via `--settings`; `session_id` in input         | n/a                                                                                                    | Harness-attested `session_id` and `tool_use_id`                                                                                                                                   | An HTTP hook endpoint needs a header token; hook settings are user- or enterprise-overridable                                                                                                              |
| D2. Codex hooks / `notify`                                                      | n/a                                                                                           | Hooks need hash trust or `--dangerously-bypass-hook-trust`; `notify` is turn-complete only             | `session_id` / `thread-id` in payload                                                                                                                                             | Hook handlers are commands; `notify` adds nothing over `turn/completed`                                                                                                                                    |
| D3. Event-stream correlation (corroborates A–C)                                 | `tool_use` blocks on the Session's stdout                                                     | `mcpToolCall` / `dynamicToolCall` / `commandExecution` items with `threadId`                           | Harness-attested per Session                                                                                                                                                      | Content match for CLI calls; structural for MCP and dynamic calls                                                                                                                                          |
| D4. File drop in the writable directory                                         | Writable via `--add-dir`                                                                      | Writable via per-thread `writable_roots`                                                               | Per-Session path                                                                                                                                                                  | Any same-user writer                                                                                                                                                                                       |

### Sandbox, approval, and platform notes

| Mechanism                                                                       | Sandbox / approval impact                                                                                                                                                                                                                                                                            | Windows / macOS / Linux notes                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1. Per-Session stdio MCP server (Secant binary as server, IPC to main process) | Runs outside both command sandboxes. Claude: needs an allow rule or a permission prompt (routed to Secant's bridge today). Codex: unannotated tools need approval via `mcpServer/elicitation/request`, which Secant's Adapter rejects today; `readOnlyHint` or `approval_mode = "approve"` avoids it | Same on all three for the Harness side; the server-to-Secant hop uses C (named pipe on Windows); `managed-mcp.json` blocks Claude `--mcp-config` everywhere                                                                                                     |
| A2. Per-Session HTTP MCP server on loopback (existing bridge pattern)           | As A1                                                                                                                                                                                                                                                                                                | Loopback TCP on all three; no Unix-socket or pipe MCP transport documented                                                                                                                                                                                      |
| A3. Harness-native in-band tool (Codex dynamic tools; Claude SDK MCP)           | Codex: no MCP approval path; requires `experimentalApi`. Claude: the SDK path bypasses the raw CLI                                                                                                                                                                                                   | Platform-neutral: rides the existing stdio transport                                                                                                                                                                                                            |
| B. `secant` CLI run by the agent                                                | Claude: Bash permission prompt unless allowed; sandbox (off by default) blocks Unix sockets and proxies loopback. Codex: default network-off sandbox blocks the connection; needs escalation approval, a `prefix_rule`, network on, a socket allowlist (macOS), or `danger-full-access`              | Linux Codex: seccomp denies `connect` for every family. macOS Codex: Seatbelt deny-default, named-socket allowlist possible. Windows Codex elevated: separate user plus loopback firewall; unelevated: env-only offline. Claude sandbox: none on native Windows |
| C. Unix socket / named pipe / loopback TCP listener (endpoint for A1 or B)      | Subject to the caller's sandbox (B) or none (A1, hooks)                                                                                                                                                                                                                                              | Windows: named pipe (default DACL gives Everyone read only). Linux: abstract sockets are netns-scoped. Peer-credential calls need `bun:ffi` outside the ADR 0030 allowlist                                                                                      |
| D1. Claude Code hooks (observer of A or B)                                      | Hooks run outside the sandbox; `allowedHttpHookUrls`, `allowManagedHooksOnly`, and `disableAllHooks` can block them                                                                                                                                                                                  | Same on all three                                                                                                                                                                                                                                               |
| D2. Codex hooks / `notify`                                                      | Untrusted hooks are skipped                                                                                                                                                                                                                                                                          | Same on all three                                                                                                                                                                                                                                               |
| D3. Event-stream correlation (corroborates A–C)                                 | None                                                                                                                                                                                                                                                                                                 | Same on all three                                                                                                                                                                                                                                               |
| D4. File drop in the writable directory                                         | Admitted by both sandboxes                                                                                                                                                                                                                                                                           | Same on all three; not IPC, read at the Turn boundary                                                                                                                                                                                                           |

## Open Questions Left for the Decision

- **Codex approvals.** Should a Secant MCP tool on Codex be annotated or configured to skip approval, or should the Codex Adapter learn
  `mcpServer/elicitation/request`? Today either an approval requirement or the elicitation fails the Turn.
- **Claude permission posture.** Should Claude Code launches gain an allow rule for Secant's own tool, which changes the declared "no
  `--allowedTools`" posture? The alternative is to let the bridge answer prompts for that tool. Note that `requiresUserInteraction` cannot be
  bridge-approved.
- **Dynamic tools.** Is Codex's experimental dynamic-tool surface worth its own capability and version gate, given it is the only route with
  Harness-attested per-thread identity on the existing connection?
- **Threat model.** Is an honest-caller threat model (env or argv identity) enough, or must attribution withstand a same-user process that reads
  another Session's credential? The latter points toward kernel peer identity plus ancestry, which Windows cannot fully provide.
- **Subagents.** How should calls from subagents map to a Session? Claude subagents share the parent process and session id, and hooks add
  `agent_id`. Codex subagents are separate threads, so `CODEX_THREAD_ID` would carry the child thread id (Inferred).[^cc-hook-input][^cx-exec-env]
- **Untested behaviour.** Nothing here was tested on macOS or Windows. The per-thread `shell_environment_policy.set` override, the named-pipe
  behaviour under Codex's restricted-token sandbox, and Bun's access to socket handles are Unknown.

## Primary Sources

[^idea]: Secant issue #235, [Idea: let the agent tell Secant it is done](https://github.com/secantdev/secant/issues/235#issuecomment-5854800510), and the [Charting record](https://github.com/secantdev/secant/issues/235#issuecomment-5855568126), "Raised during charting".

[^prior-claude]: Secant research, [Claude Code structured transports](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/research/claude-code-structured-transports.md), "Permissions and approvals".

[^prior-codex]: Secant research, [Codex app-server capability envelope](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/research/codex-app-server-capability-envelope.md), "Answer" and "Version and Platform Policy".

[^adr-0020]: Secant, [ADR 0020](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/adr/0020-deterministic-verdicts-and-human-checkpoints-terminate-repetition.md), opening paragraphs.

[^adr-0022]: Secant, [ADR 0022](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/adr/0022-own-a-truthful-deep-harness-seam.md), Interface, Turn, and control paragraphs.

[^adr-0030]: Secant, [ADR 0030](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/adr/0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md#runtime-neutrality), "Distribution, v1" and "Runtime neutrality".

[^sec-harness-agents]: Secant, [`src/harness/AGENTS.md` invariants](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/AGENTS.md#L7-L16).

[^sec-bridge]: Secant, [`src/harness/permission-bridge.ts` lines 1-21 and 107-208](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/permission-bridge.ts#L1-L208), and [`claude-code.ts` `ensureBridge`/`routeApproval` lines 336-363](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L336-L363).

[^sec-claude-launch]: Secant, [`src/harness/claude-code.ts` launch lines 740-783](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L740-L783).

[^sec-claude-profile]: Secant, [`src/harness/claude-code.ts` profile lines 1525-1545](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1525-L1545).

[^sec-codex-thread]: Secant, [`src/harness/codex.ts` prepared Harness line 436, thread config lines 610-623, and `thread/start` lines 711-720](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L436-L720).

[^sec-codex-profile]: Secant, [`src/harness/codex.ts` configuration posture line 1795](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L1795-L1796).

[^sec-codex-unsupported]: Secant, [`src/harness/codex/runtime-protocol.ts` lines 437-466](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/runtime-protocol.ts#L437-L466) and [`codex.ts` lines 1263-1273](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L1263-L1273).

[^sec-process]: Secant, [`src/process/process.ts` detached spawn lines 413 and 660-666](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/process/process.ts#L660-L666) and [`src/process/AGENTS.md`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/process/AGENTS.md).

[^sec-writable]: Secant, [`src/harness/AGENTS.md` writable directory invariant](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/AGENTS.md#L40-L43).

[^cc-cli]: Anthropic, [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference), rows `--mcp-config`, `--strict-mcp-config`, `--permission-prompt-tool`, `--allowedTools`, `--settings`.

[^cc-mcp-add]: Anthropic, [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp), "Installing MCP servers" (HTTP, SSE, stdio, WebSocket) and "Add MCP servers from JSON configuration".

[^cc-mcp-reconnect]: Anthropic, [MCP: automatic reconnection](https://code.claude.com/docs/en/mcp#automatic-reconnection).

[^cc-mcp-stdio]: Anthropic, [MCP: Option 3, local stdio server](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server).

[^cc-env-session]: Anthropic, [Environment variables](https://code.claude.com/docs/en/env-vars), rows `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`.

[^cc-env-pid]: Anthropic, [Environment variables](https://code.claude.com/docs/en/env-vars), row `CLAUDE_PID`.

[^cc-env-scrub]: Anthropic, [Environment variables](https://code.claude.com/docs/en/env-vars), row `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.

[^cc-hook-env]: Anthropic, [Hooks reference: common input fields](https://code.claude.com/docs/en/hooks#common-input-fields), "A hook process inherits the parent environment".

[^cc-perm-eval]: Anthropic, [Agent SDK permissions: how permissions are evaluated](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated), and [Configure permissions: MCP](https://code.claude.com/docs/en/permissions#mcp).

[^sdk-mcp-perm]: Anthropic, [Agent SDK MCP: allow MCP tools](https://code.claude.com/docs/en/agent-sdk/mcp#allow-mcp-tools).

[^cc-requires-interaction]: Anthropic, [MCP: require approval for a specific tool](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool).

[^cc-tool-search]: Anthropic, [MCP: scale with MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search).

[^cc-managed-mcp]: Anthropic, [Managed MCP: exclusive control with managed-mcp.json](https://code.claude.com/docs/en/managed-mcp#exclusive-control-with-managed-mcp-json).

[^cc-sandbox]: Anthropic, [Sandboxing](https://code.claude.com/docs/en/sandboxing), platform support ("Native Windows is not supported") and "Network isolation".

[^cc-sandbox-scope]: Anthropic, [Sandboxing: permission rules](https://code.claude.com/docs/en/sandboxing#permission-rules) ("applies only to Bash, PowerShell, and Monitor commands") and protected paths ("a hook or MCP server that Claude Code runs outside the sandbox").

[^cc-sandbox-default]: Anthropic, [Settings reference: `sandbox.enabled`](https://code.claude.com/docs/en/settings-reference#sandbox-enabled).

[^cc-sandbox-retry]: Anthropic, [Sandboxing: the unsandboxed retry escape hatch](https://code.claude.com/docs/en/sandboxing).

[^cc-unix-sockets]: Anthropic, [Settings reference: `sandbox.network.allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`](https://code.claude.com/docs/en/settings-reference#sandbox-network-allowunixsockets).

[^cc-tools-ref]: Anthropic, [Tools reference](https://code.claude.com/docs/en/tools-reference), "Permission required" column and Bash tool behavior.

[^cc-hook-types]: Anthropic, [Hooks reference: hook handler fields](https://code.claude.com/docs/en/hooks#hook-handler-fields).

[^cc-hook-input]: Anthropic, [Hooks reference: common input fields](https://code.claude.com/docs/en/hooks#common-input-fields).

[^cc-http-hook]: Anthropic, [Hooks reference: HTTP hook fields](https://code.claude.com/docs/en/hooks#http-hook-fields).

[^cc-hook-url]: Anthropic, [Settings reference: `allowedHttpHookUrls`, `allowManagedHooksOnly`, `disableAllHooks`](https://code.claude.com/docs/en/settings-reference#allowedhttphookurls).

[^cc-messaging]: Anthropic, [Message your other Claude Code sessions: the session's inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket), including own-child verification per platform.

[^sdk-mcp]: Anthropic, [`@anthropic-ai/claude-agent-sdk@0.3.283` `sdk.d.ts`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.283/sdk.d.ts), `McpSdkServerConfig` (`type: 'sdk'`, line 1192) and `SDKControlMcpMessageRequest` (`subtype: 'mcp_message'`, line 4647); [custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools) ("runs in-process inside your application").

[^srt-linux]: Anthropic sandbox-runtime, [`linux-sandbox-utils.ts` network architecture note lines 1155-1181](https://github.com/anthropic-experimental/sandbox-runtime/blob/ddbeb74711c4097014ef3056791efa83f553116c/src/sandbox/linux-sandbox-utils.ts#L1155-L1181). Claude Code's docs say the same primitives are available as this package; identity with the bundled implementation is inferred.

[^srt-macos]: Anthropic sandbox-runtime, [`macos-sandbox-utils.ts` network rules lines 1141-1200](https://github.com/anthropic-experimental/sandbox-runtime/blob/ddbeb74711c4097014ef3056791efa83f553116c/src/sandbox/macos-sandbox-utils.ts#L1141-L1200).

[^cx-thread-start]: OpenAI Codex, [`ThreadStartParams` in `v2/thread.rs` lines 62-166](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L62-L166) (`config` stable; `dynamicTools` experimental).

[^cx-config-load]: OpenAI Codex, [`thread_processor.rs` `load_with_overrides` lines 1336-1342](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/src/request_processors/thread_processor.rs#L1336-L1342).

[^cx-session-mcp]: OpenAI Codex, [`core/src/session/session.rs` MCP runtime from the session config lines 1112-1153](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/session.rs#L1112-L1153).

[^cx-resume]: OpenAI, [Codex App Server: start or resume a thread](https://learn.chatgpt.com/docs/app-server.md) (resume overrides; dynamic tools restored on resume).

[^cx-dynamic]: OpenAI, [Codex App Server: dynamic tool calls (experimental)](https://learn.chatgpt.com/docs/app-server.md), and the `dynamicToolCall` item description.

[^cx-dynamic-schema]: OpenAI Codex, [`DynamicToolCall` server request in `common.rs` lines 1795-1799](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/common.rs#L1795-L1799) and [`DynamicToolCallParams` in `v2/item.rs` lines 1652-1667](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1652-L1667).

[^cx-elicitation-doc]: OpenAI, [Codex App Server: MCP server elicitation requests and MCP tool-call approvals (apps)](https://learn.chatgpt.com/docs/app-server.md).

[^cx-mcp]: OpenAI, [Codex Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli), STDIO servers, Streamable HTTP servers, and other configuration options.

[^cx-mcp-env]: OpenAI Codex, [`rmcp-client/src/utils.rs` `create_env_for_mcp_server` and `DEFAULT_ENV_VARS` lines 16-59 and 162-179](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/rmcp-client/src/utils.rs#L16-L179).

[^cx-mcp-launch]: OpenAI Codex, [`rmcp-client/src/stdio_server_launcher.rs` executor launch lines 625-644](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L625-L644).

[^cx-mcp-approval]: OpenAI Codex, [`core/src/mcp_tool_call.rs` approval rules lines 2436-2467 and approval delivery lines 1583-1712](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/mcp_tool_call.rs#L1583-L1712), and [`codex-mcp/src/mcp/mod.rs` auto-approval lines 91-110](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/codex-mcp/src/mcp/mod.rs#L91-L110).

[^cx-feature]: OpenAI Codex, [`features/src/lib.rs` `tool_call_mcp_elicitation` lines 1719-1724](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/features/src/lib.rs#L1719-L1724).

[^cx-network-domains]: OpenAI, [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference.md), `permissions.<name>.network.domains` ("Does not restrict web search, apps, or MCP servers").

[^cx-exec-env]: OpenAI Codex, [`unified_exec/process_manager.rs` lines 1441-1449](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/unified_exec/process_manager.rs#L1441-L1449) and [`exec_env.rs` lines 30-50](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/exec_env.rs#L30-L50).

[^cx-shell-env]: OpenAI Codex, [`protocol/src/shell_environment.rs` lines 6-7 and 90-160](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/protocol/src/shell_environment.rs#L90-L160).

[^cx-shell-policy-default]: OpenAI Codex, [`protocol/src/config_types.rs` `ShellEnvironmentPolicy::default` lines 261-271](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/protocol/src/config_types.rs#L261-L271).

[^cx-shell-set]: OpenAI, [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference.md), `shell_environment_policy.set`, `.inherit`, `.ignore_default_excludes`.

[^cx-approvals]: OpenAI, [Codex agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security.md), overview and "Network access", and [Sandbox](https://learn.chatgpt.com/docs/sandboxing.md), "Configure defaults".

[^cx-local-dest]: OpenAI, [Codex agent approvals and security: local and private destinations; dangerous settings](https://learn.chatgpt.com/docs/agent-approvals-security.md).

[^cx-rules]: OpenAI, [Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules.md).

[^cx-landlock]: OpenAI Codex, [`linux-sandbox/src/landlock.rs` seccomp mode selection lines 115-126 and restricted rules lines 201-231](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/linux-sandbox/src/landlock.rs#L115-L231).

[^cx-bwrap]: OpenAI Codex, [`linux-sandbox/src/bwrap.rs` network modes lines 101-118 and `--unshare-net` lines 301-302](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/linux-sandbox/src/bwrap.rs#L101-L302).

[^cx-seatbelt]: OpenAI Codex, [`seatbelt_base_policy.sbpl` line 8](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl#L8) and [`seatbelt.rs` network policy lines 316-376](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/sandboxing/src/seatbelt.rs#L316-L376).

[^cx-unix-allow]: OpenAI, [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference.md), `permissions.<name>.network.unix_sockets` and `dangerously_allow_all_unix_sockets`.

[^cx-windows]: OpenAI, [Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox.md), "Configure the Windows sandbox".

[^cx-win-firewall]: OpenAI Codex, [`windows-sandbox-rs/src/setup_provisioning/firewall.rs` rule definitions lines 35-49](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/windows-sandbox-rs/src/setup_provisioning/firewall.rs#L35-L49).

[^cx-win-env]: OpenAI Codex, [`windows-sandbox-rs/src/env.rs` `apply_no_network_to_env` lines 126-160](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/windows-sandbox-rs/src/env.rs#L126-L160).

[^cx-pgroup]: OpenAI Codex, [`utils/pty/src/process_group.rs` `setsid` line 52 and `setpgid` line 74](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/utils/pty/src/process_group.rs#L52-L74).

[^cx-hooks]: OpenAI, [Codex hooks](https://learn.chatgpt.com/docs/hooks.md), "Where Codex looks for hooks", "Review and trust hooks", "Common input fields".

[^cx-notify]: OpenAI, [Codex advanced configuration: notifications](https://learn.chatgpt.com/docs/config-advanced.md).

[^node-ipc]: Node.js, [`net`: identifying paths for IPC connections](https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections).

[^node-detached]: Node.js, [`child_process` `options.detached`](https://nodejs.org/api/child_process.html#optionsdetached).

[^bun-pipe]: Bun source, [`WindowsNamedPipe.rs`](https://github.com/oven-sh/bun/blob/main/src/runtime/socket/WindowsNamedPipe.rs) (named pipes behind the socket API on Windows); not pinned to 1.4.2.

[^unix7-perms]: Linux man-pages, [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html), "Pathname socket ownership and permissions" and "Abstract sockets".

[^unix7-peercred]: Linux man-pages, [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html), `SO_PEERCRED`.

[^netns7]: Linux man-pages, [network_namespaces(7)](https://man7.org/linux/man-pages/man7/network_namespaces.7.html).

[^pidns7]: Linux man-pages, [pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html), "Miscellaneous".

[^proc-stat]: Linux man-pages, [proc_pid_stat(5)](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html), fields 4-6; [proc_pid_cmdline(5)](https://man7.org/linux/man-pages/man5/proc_pid_cmdline.5.html); [proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html); [proc(5) `hidepid`](https://man7.org/linux/man-pages/man5/proc.5.html).

[^proc-fd]: Linux man-pages, [proc_pid_fd(5)](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html).

[^proc-net]: Linux man-pages, [proc_net(5)](https://man7.org/linux/man-pages/man5/proc_net.5.html), `/proc/net/tcp`.

[^mac-getpeereid]: Apple, [getpeereid(3)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html).

[^xnu-un]: Apple XNU, [`bsd/sys/un.h` lines 88-93](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/un.h#L88-L93).

[^xnu-procinfo]: Apple XNU, [`bsd/sys/proc_info.h` `proc_bsdinfo` lines 59-75 and `PROC_PIDTBSDINFO` line 729](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_info.h#L59-L75).

[^win-pipe-pid]: Microsoft, [GetNamedPipeClientProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid).

[^win-pipe-sec]: Microsoft, [Named pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).

[^win-createpipe]: Microsoft, [CreateNamedPipeA](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea), `PIPE_REJECT_REMOTE_CLIENTS` and `FILE_FLAG_FIRST_PIPE_INSTANCE`.

[^win-tcp-table]: Microsoft, [GetExtendedTcpTable](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable).

[^win-processentry]: Microsoft, [PROCESSENTRY32](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32).

[^win-isprocessinjob]: Microsoft, [IsProcessInJob](https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob).

[^t3-codex]: T3 Code (local checkout `de251fc`), [`apps/server/src/provider/Layers/CodexAdapter.ts` lines 2277-2310](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2277-L2310).

[^t3-claude]: T3 Code (local checkout `de251fc`), [`apps/server/src/provider/Layers/ClaudeAdapter.ts` lines 4938-4952](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4938-L4952).

[^t3-registry]: T3 Code (local checkout `de251fc`), [`apps/server/src/mcp/McpSessionRegistry.ts` lines 15-101](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/mcp/McpSessionRegistry.ts#L15-L101), [`McpHttpServer.ts` lines 84-102](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/mcp/McpHttpServer.ts#L84-L102), and [`McpProviderSession.ts` lines 3-50](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/mcp/McpProviderSession.ts#L3-L50).

[^t3-shim]: T3 Code (local checkout `de251fc`), [`apps/server/src/provider/Layers/ProviderService.ts` lines 924-962](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ProviderService.ts#L924-L962) and [`apps/server/src/device/AgentDeviceShim.ts`](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/device/AgentDeviceShim.ts).

[^oc-registry]: OpenCode (local checkout `228e909`), [`packages/opencode/src/tool/registry.ts` lines 183-197](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/tool/registry.ts#L183-L197).

[^oc-plugin-tool]: OpenCode (local checkout `228e909`), [`packages/plugin/src/tool.ts` line 4](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/plugin/src/tool.ts#L4).

[^oc-shell-env]: OpenCode (local checkout `228e909`), [`packages/opencode/src/tool/shell.ts` lines 416-425](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/tool/shell.ts#L416-L425).
