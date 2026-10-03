# Interrupt Ends Only the Turn, and a Mid-Turn Message Is a Native Steer

An **Interrupt** stops the live **Turn** and nothing more: the **Step Attempt** stays open, the **Run** waits on the human, and the human's next
message continues the same **Harness Session**. A message the human sends while a Turn is working is a **Steer** in both agent Step kinds, delivered
natively at the **Harness**'s next boundary, and the Turn does not end until every Steer has been delivered. The need came from the pre-public-release
reports ([#235](https://github.com/secantdev/secant/issues/235)): in the native clients Escape stops the Turn and the human types on in the same
Session, and a message typed mid-Turn is picked up without interrupting, while Secant halted the Run on Interrupt, offered Claude Code no Steer, and
refused a mid-Turn send. This supersedes the Run lifecycle glossary's Interrupt rule (the Attempt ends `cancelled` and the Run rests `halted`) and its
Steer definition ("not a new Turn, and unsupported Harnesses do not emulate it"), [Spec: M3](https://github.com/secantdev/secant/issues/107) stories
18 and 19 and its deferral of a Session-preserving Claude Code interrupt, and [Spec: M4](https://github.com/secantdev/secant/issues/137) story 19's
Codex-only Steer. It amends [ADR 0022](./0022-own-a-truthful-deep-harness-seam.md)'s `steer` and `interrupt` controls and Claude Code's interruption
mode. Unchanged: closing Secant or Ctrl+C halts the Run ([ADR 0019](./0019-failed-and-halted-runs-are-resumable-resting-states.md)), Cancel is the
only route to `cancelled`, an Agent call made in an interrupted Turn is dropped ([ADR
0032](./0032-let-opted-in-interactive-agent-steps-accept-agent-declared-completion.md)), and headless gains no Interrupt or Steer.

**Interrupt, per Step kind.** In an **Interactive agent step** the interrupted Turn ends `interrupted` and the Run returns to `blocked` on the human,
whose next message goes into the same Session; no Attempt is published and the Iteration stays open. An interrupted **Entry Turn** is treated the same
way and is never re-sent. In an **Agent step** the interrupted Turn ends `interrupted`, the Attempt stays open, and the Run is `blocked` on the
human's message. That message starts a human-origin follow-up Turn in the same Session and the same Attempt, and the Attempt takes its outcome from
its last Turn: a clean end completes the Step and the Routing advances without the human, exactly as an uninterrupted Agent step does, and a failure
takes the Step's ordinary retry policy. A second Interrupt is the only way to hold the Step again. A `lost` Turn keeps its current meaning. When
Secant closes while a Run waits after an Interrupt, the Run halts as any live Run does, and resuming returns it to waiting on the human's message.

**Steer.** Steer now means native mid-Turn delivery of the human's own text, landing at the Harness's next boundary; it is offered in Agent steps and
Interactive agent steps alike, wherever the profile's Steer evidence says the Harness supports it. Codex delivers it through `turn/steer` with
`expectedTurnId` and a Secant-minted `clientUserMessageId`, which comes back as the `clientId` of the `userMessage` item written when the text is
taken into history before the next model request. Claude Code delivers it as a stdin `user` frame on the existing `claude -p --input-format
stream-json` process, stamped with a Secant-minted `uuid`: a frame written while a tool round runs, including one waiting on a tool approval, is taken
with the round's last tool result in the same exchange and listed in `result.user_message_uuids`, and one written while text streams runs as the next
native exchange with its own `result`; `command_lifecycle` frames, advertised as `msg_lifecycle_v1`, say which frames are still queued. Delivery means
the Harness put the text in front of the model, never that the model followed it.

**The Turn stretches until every Steer is delivered.** A Turn ends at the first Harness boundary after which no accepted Steer is pending, so one
Secant Turn may span several native exchanges. The human's message therefore always reaches the agent before an Agent-declared completion from that
Turn is applied. Codex can accept a Steer in the few milliseconds between its last check for pending input and the end of the Turn, or on a failing
Turn, write it into history, and complete without answering it; a Steer sent during its Stop hooks is answered, because pending input re-runs the
Turn. The Codex Adapter detects that leftover, a `userMessage` item with the Steer's `clientId` followed by `turn/completed` with no model output, and
re-delivers it inside the same Secant Turn with a native `turn/start` whose input is empty. Recorded on codex-cli 0.157.1, that start is accepted on
the idle thread and the model answers the leftover from history, which holds the text once. It is sent only on a detected leftover, since on a thread
with nothing pending it makes the model repeat itself or invent work. A Codex that refuses an empty input falls back to re-sending the same text,
which answers too but leaves the message in history twice. Either way the input is the human's own message, so a Steer is answered before its Turn
ends on both Harnesses and this is ordinary turn-taking, not emulation. A Steer that arrives after the Turn has ended is rejected and its draft kept:
in an Interactive agent step the human sends it as the next Turn, and in an Agent step that has advanced the human is told it was not delivered.

**Interrupt drops what has not been delivered.** Every accepted Steer still pending when an Interrupt lands is dropped and its text returned to the
human's compose, so nothing runs after the human said stop. Codex discards pending steered input on `turn/interrupt`; Claude Code is interrupted with
`cancel_queued: true`, which hands the queued frames back instead of running them as the next Turn.

**How Claude Code stops.** Claude Code is interrupted with a raw `control_request` `interrupt` written to the same stdin, which, recorded on Claude
Code 2.1.284, answers without the SDK's `initialize` in milliseconds, ends the Turn with a `result`, keeps the process and Session live for the next
frame, keeps the partial text in context, and stops the foreground tool. It holds while a tool waits on Secant's permission bridge too: Claude Code
cancels the pending approval call with an MCP `notifications/cancelled`, which expires the Harness Request, and the tool never runs. That makes Claude
Code's interruption a confirmed active-Turn interruption rather than a process-only stop. Qualification bounds the dependency: a Claude Code that does
not answer the request falls back to today's process stop, SIGTERM of the process group on POSIX and job termination on contained Windows
children, or `taskkill /T /F` on a Windows fallback, and `--resume`, which loses partial streamed text. This is the same wire and the same degrade
rule [ADR 0034](./0034-choose-and-change-model-and-effort-as-one-run-wide-model-choice.md) adopted for `set_model`; adopting the Agent SDK itself
stays rejected for the reasons in [Establish Claude Code's viable structured transports](https://github.com/secantdev/secant/issues/3).
On POSIX, an Interrupt stops the Turn's foreground tool work; a shell the model moved to the background may outlive it until the Session closes.
**Windows amendment, 2026-10-04 ([#259 decision](https://github.com/secantdev/secant/issues/259#issuecomment-5890689876)):**
Windows Interrupt stops all work owned by the contained native process, including background tools and Harness-launched MCP servers. Request
native interruption first, then terminate and reap the whole job before reporting the stop finished. Native terminal confirmation and cleanup are
separate evidence: a force-kill without confirmation is `lost`, and incomplete cleanup remains visible. Cancel, Session teardown, and shutdown also
reap the owned tree. This supersedes the earlier Windows background-work allowance; the POSIX allowance is unchanged. Without containment, usual
Windows cleanup can still miss escaped Git Bash descendants, as [recorded](../research/windows-live-interrupt-and-steer.md) on Claude Code 2.1.283
and codex-cli 0.155.0. Exact Harness Session recovery after a reaped Interrupt belongs to the Harness Adapters.

**Recording.** Each Steer is durable against its Turn: the human's text, when it was sent, and how it settled, as delivered within the Turn, delivered
after a native boundary, re-delivered, or dropped by an Interrupt or a lost Turn. An interrupted Turn records the stop used, the control request or
the process stop. A follow-up Turn after an Interrupt is a human-origin Turn inside the Agent step's Attempt. Steered text is shown as the human's
message inside its Turn, durable content kept distinct from live previews under [ADR
0024](./0024-use-one-deep-projection-port-for-tui-and-headless-clients.md).

**Harness Interface.** `steer` keeps its `ControlReceipt`, whose acceptance now means the text was handed to the Harness. The Turn's closed event
stream gains one Steer lifecycle, delivered or dropped, beside the Harness Request lifecycle, and on terminal the Adapter publishes a dropped event
for any Steer never delivered before it closes the producer and settles the one result. Which Steers are pending, the native correlation ids, and
where the real Turn boundary falls stay private to each Adapter; execution still sees one result per Turn and learns nothing native. The profile's
Steer evidence states each Harness's delivery point, and Claude Code declares `active-turn` interruption when qualification confirms the control
request.

Rejected: keeping Interrupt as a halt, which turns stopping one's own conversation into a Run-level stop outside the workflow's logic; resending an
interrupted Agent step's prompt on resume; an interrupted Agent step that waits for the human to end it, which silently turns it into an Interactive
agent step; a client-side queue sent as the next Turn, which is emulation and would race the one live Turn per Prepared Harness and the Agent-declared
completion's clean-end settlement; a separate queue key beside Steer; counting Claude Code's second native exchange as a new Turn the Harness started,
which would let an Agent-declared completion settle the Step while the human's message is still being answered; reporting a Codex leftover upward as
missed, which pushes a native race into two Step kinds; SIGINT, which exits the process and silently loses queued messages; and `queued_turn_count`,
which stayed 0 while a message waited. How the Run Workbench presents Interrupt, Steer, a dropped Steer's restored draft, and delivered and dropped
Steers is left to the Run Workbench prototype. The decision was made on [Decide how the human interrupts a Turn and sends a message while a Turn is
working](https://github.com/secantdev/secant/issues/255).
