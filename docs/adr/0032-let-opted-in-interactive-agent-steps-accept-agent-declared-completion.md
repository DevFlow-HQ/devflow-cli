# Let Opted-In Interactive Agent Steps Accept Agent-Declared Completion

An **Interactive agent step** whose Bundle opts it in may be ended by its agent, not only by the human. The agent makes a deliberate call to
Secant — **step done** or **stage done**, each with a required one-line reason — and Secant treats the call as a request for a control the human
already has: step done is **End Step**, or **Continue** inside a human-controlled **Repeat group**; stage done is **End Stage**, and exists only
inside a human-controlled group. The human's control and the agent's call enter by different ways in and reach **one settlement**, with the same
rules and the same durable record, so the agent can never do what the human could not. The need came from the Matt implement loop
([#235](https://github.com/secantdev/secant/issues/235#issuecomment-5854800510)): only the agent knows whether its ticket is finished or no ticket
is left, so the human was asked for a judgement they could only relay. This supersedes the sentence of
[ADR 0020](./0020-deterministic-verdicts-and-human-checkpoints-terminate-repetition.md) that ends an Interactive agent step only "on an explicit human
control", and the last line of its M6 Amendment ("the engine still reads nothing from the agent to choose the exit"). ADR 0020's Verdict half is
unchanged. It also supersedes [Spec: M6](https://github.com/secantdev/secant/issues/210)'s out-of-scope line on structured no-work reports. The
channel that carries the call and how Secant attributes it are decided by
[Choose the channel and caller identification for agent calls to Secant](https://github.com/secantdev/secant/issues/244), not here.

ADR 0020 gave three reasons, and each still holds. **Secant never reads meaning out of a Turn:** the call is a separate, structured request on a
Secant-owned channel, not text in the conversation; Secant parses no prose, and the reason is stored and shown but never interpreted. **A
workflow's logic does not re-enter the runtime through the agent's mouth:** a Bundle cannot define calls, the agent reaches only the endings a
human already has, and no call can end a Verdict-driven Repeat group — inside one, step done ends only its own Step and the Verdict alone decides
the loop. **Unattended repetition still stops for a human:** in a human-controlled group, once the agent has ended the group's interval of
Iterations in a row, Secant withholds the agent's Continue and the Iteration waits for the human, whose own Continue resets the count. That
interval is optional in the manifest and defaults to 100. Unlike the Verdict form's Review checkpoint it has no ceiling: an author who sets a very
large number has knowingly lengthened review, so the guarantee holds by default and is the author's to extend. Stage done is never withheld,
because stopping is never the runaway case.

A call is **recorded, not acted on**: Secant applies it only when the Turn it was made in ends cleanly, and drops it if that Turn fails, is
interrupted, or the Run is cancelled. The agent may keep working after calling, the latest call in a Turn wins, and an agent that never calls
leaves the Step waiting for the human exactly as before. The call's reply says whether it was accepted or refused and why. The human sees a
pending line while the Turn runs and then an "ended by the agent" record; history and the Run summary show verified, human-declared, and
agent-declared completion apart. Interrupting the Turn drops the call, nothing reopens a settled Iteration, and every human control stays offered
on an opted-in Step. The Bundle manifest switches the calls on per Step with `agentCompletion` — `true` for every call valid where the Step sits,
or a non-empty list of `step` and `stage` — plus an optional `reviewCheckpoint` on the human-controlled group and optional `stepDoneWhen` and
`stageDoneWhen` texts. Secant appends a sentence per enabled call to the **Entry Turn** prompt, using the author's text or a generic default that is
always true, and injects nothing when the Step has no Entry Turn. The build rejects a call the Step's position does not allow, `[]`, a
`reviewCheckpoint` whose Step cannot call step done, and author texts without an Entry Turn to carry them; using the fields raises the Bundle's
minimum Secant version.

Rejected: acting on the call the moment it arrives, which would cut off a live Turn that Continue itself may not race; one "done" call whose
meaning depends on position, which cannot tell Continue from End Stage; calls named after Secant's controls, which would make the agent learn
Secant's structure; letting an opted-in Step be ended only by the agent, which leaves the human no way out but Cancel when the agent never calls; a
human confirmation for stage done, since an author who wants a human sign-off leaves stage done off; and a required checkpoint interval. The
decision was made on [Define agent-declared completion for Interactive agent steps](https://github.com/secantdev/secant/issues/243).

## Amendment — the channel (#244)

[ADR 0033](./0033-carry-agent-calls-to-secant-over-a-per-session-loopback-mcp-server.md) settles the channel and attribution left open above: the
calls are `step_done` and `stage_done` tools on a Secant-hosted loopback MCP server attached per Session, attributed by a per-Session token to the
Session's live Turn without the agent supplying identity. A call from the agent's own helpers inside the Session counts as the agent's call. The
reason is stored as sent, up to 400 characters, and a step done that reaches the Review checkpoint is answered "held for review".
