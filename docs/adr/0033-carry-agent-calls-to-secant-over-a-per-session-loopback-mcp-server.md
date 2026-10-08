# Carry Agent Calls to Secant over a Per-Session Loopback MCP Server

An agent reaches Secant through an **Agent call**: a tool on a Secant-hosted MCP server that the Harness Adapter attaches to the agent's **Harness
Session**. The server listens on loopback HTTP inside the Secant process, is reached by Claude Code (an `mcp_set_servers` stdin control request,
amended 2026-10-08) and Codex (per-thread `thread/start` and `thread/resume` configuration) on all three platforms, and runs outside both
Harnesses' command sandboxes. Its first
calls are the two that [ADR 0032](./0032-let-opted-in-interactive-agent-steps-accept-agent-declared-completion.md) defines, `step_done` and
`stage_done`, each taking one required `reason`. This decision was made on
[Choose the channel and caller identification for agent calls to Secant](https://github.com/secantdev/secant/issues/244), from the findings in
[agent-to-Secant call channels](../research/agent-to-secant-call-channels.md).

**The agent never supplies its identity.** The Adapter mints a random token per Session and writes it into that Session's MCP attachment, so the
Harness sends it with every call. The token names the Session; the Session's live **Turn** names the Turn, and at most one Turn is live per
Prepared Harness; the Turn's owner, known only above the Harness Interface, names the **Step Attempt** and the Run. A call from a Session with no
live Turn is refused as having no Turn in progress, so a background task or helper left over from an earlier Turn can never be attributed to
another Session's Turn. The threat model is the honest caller: the token is readable by other processes of the same OS user, and
such a process can already rewrite the Run's files. **Amended 2026-10-08 ([#459](https://github.com/secantdev/secant/issues/459)):** the token used to reach Claude Code in `--mcp-config`
on its command line, which every local user reads through `/proc/<pid>/cmdline` under Linux's default `hidepid=0` (Windows shows a command line
only to the same user and administrators). It now reaches both Harnesses only over their private stdio channel, as Codex's per-thread configuration
already did: Claude Code receives an `mcp_set_servers` control request carrying both servers, answered before the first message and re-sent at every
launch, including resume. The token is never on a command line or in the Harness's environment, so the agent's own commands cannot print it. A
refused or failed request fails the launch with a plain cause; Secant never falls back to the command line. Secant never sends `mcp_status`, whose
reply echoes each server's headers. A by-hand Windows check that the token arrives and is absent from `Win32_Process.CommandLine` is required human
evidence for the change. Kernel peer credentials were not taken, because they are dependable
only on Linux and need `bun:ffi`, which [ADR 0030](./0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md) does not allow. A call made
by the agent's own helpers inside the Session, such as a Claude Code sub-agent or a Codex child thread cloned from the parent's configuration,
arrives with the Session's token and counts as the agent's call.

**The channel lives with the Session, not the Step.** A Session is attached when at least one Step naming it is opted in, and offers only the calls
those Steps enable; Sessions no opted-in Step names see no Secant tool. The tool list is fixed when the Session opens, because Claude Code's MCP
configuration is set once per launch and Codex ignores `tools/list_changed`, so each call is judged against the live Turn's Step: during a Step that is
not opted in, the call is refused. The one loopback listener per Prepared Harness also serves the existing `secant-permissions` bridge, which moves
from one token per Run to the same per-Session token, so a tool approval is attributed to its own Session's Turn exactly as a call is.

**A call is answered at once, by Secant.** The reply is one of accepted ("takes effect when this Turn finishes"), held for review (a step done that
reaches the human-controlled group's **Review checkpoint**, so the human decides the next Iteration), or refused with the reason, marked as a tool
error. The reason is stored exactly as sent; the only checks are that it is non-empty once trimmed and at most 400 characters, and each screen fits
it to its own space and strips terminal control characters where it is shown. Secant's own tools never raise an approval prompt: Codex receives
`default_tools_approval_mode = "approve"` for the `secant` server in the per-thread configuration, and Claude Code receives `--allowedTools` naming
only Secant's calls. That is a narrow exception to launching Claude Code without `--allowedTools`; it is additive to the user's rules, and a user or
managed deny rule still wins, leaving the Step waiting for the human as before.

**Across the Harness Interface** the Adapter still learns no Workflow fact. The caller passes a Session's call declarations as opaque data — an id,
the Secant-owned description, and the reason's maximum length — on each Turn, bound when the Session opens; a different set on a later Turn is a
caller-contract violation. The Turn's event stream gains a data-only agent-call event, the Turn handle gains one closed control that answers it and
reports an expired or already-settled race, and a call still unanswered at Turn end expires before the producer closes. An evidence-bearing
`agentCalls` capability joins the profile, and Codex qualification probes the MCP configuration it relies on. **Clarified 2026-10-05 (#377):**
Preflight uses the Harness-owned static served-capability table to refuse an opted-in Step before discovery, Run creation, or Trust.
That table declares whether the Adapter implements the channel. Each successfully qualified profile derives `agentCalls.available` from its
Adapter's table and retains the native evidence. An installed executable must still qualify before it can prepare a Turn; Codex's required MCP
schema facts remain part of that qualification. Assessment qualifies, while direct submit and resume keep their synchronous, spawn-free Preflight.
The Adapter's Turn guard remains the final caller-contract check. Above the Interface, one predicate owned by Run execution decides whether a call is legal
where the Step sits, shared with the human's controls; the pending call is recorded as a Turn event and applied through the Application's existing
End Step settlement. The MCP listener is a private Module inside the Harness, shared by both Adapters, with no Port, and the token is redacted from
Codex diagnostics as it already is from Claude Code's. Amended 2026-10-08 ([#459](https://github.com/secantdev/secant/issues/459)): every Turn
event either Adapter publishes is redacted too, once, where the shared Turn-event producer receives it and before command output is cut to its
retained tail, so the live view, the Run Store, and transcripts never hold it.

**Approvals and input requests from the user's own MCP servers stop failing Turns.** Codex raises an MCP tool approval as
`mcpServer/elicitation/request` marked `_meta.codex_approval_kind = "mcp_tool_call"`; it becomes an ordinary tool-approval **Harness Request**
offering Allow and Deny, never the "always" choice that would write the user's global Codex configuration. Every other elicitation — a server's
own form or link — from Codex, its older `item/tool/requestUserInput`, or Claude Code's stream-json elicitation control request, is declined and the
Turn continues. A durable row tells the human which server asked, its own message and link, that Secant cannot show it, and to finish that setup in
the Harness directly before continuing. Any other unrecognised Codex request still fails the Turn.

Rejected: a `secant` command run from the agent's shell, which Codex's default sandbox blocks on every platform, so each call would fail once and
then need an out-of-sandbox approval from the human, a reviewer model, or a rule written into the user's global Codex files, and which could not
prove its caller; a stdio shim relaying to Secant, which adds a process and a hop and identifies the caller no better; Codex dynamic tools, which
are experimental and Codex-only; one token per Run, which pins a stray call on whichever Turn is live; attaching the calls to every Session, which
shows every Bundle tools it can never use; attaching them per Step, which relaunches the Session at every Step boundary; letting the permission
bridge approve Secant's own tools, which fails under Claude Code's `dontAsk` mode; rewriting the reason to one line, which is a screen's concern;
and (2026-10-08, #459) SDK-type MCP servers carried over Claude Code's own stdio control channel, which need no token but give each Harness a
different channel, a future-version option.
