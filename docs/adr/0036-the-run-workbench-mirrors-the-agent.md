# The Run Workbench Mirrors the Agent

The **Run Workbench** is an agent screen, not an event timeline. It shows a **Run** the way OpenCode's session screen shows a conversation: one
transcript that only appends, a single bottom region, and a working indicator, with Secant's Workflow progress beside it. The need came from report 5
of the pre-public-release reports ([#235](https://github.com/secantdev/secant/issues/235)): a UTC timestamp on every event, a truncated question, no
emphasis, one assistant preview line that was replaced instead of appended, "sending…" that lingered, and no cue that the agent was working. The layout
was chosen in a real terminal from three variants on
[Prototype the Run Workbench as an agent screen](https://github.com/secantdev/secant/issues/247), preserved on
`prototype/issue-247-run-workbench-agent-screen`. This supersedes the timeline-first Run view of
[Prototype Crucible's launch and Run information architecture](https://github.com/secantdev/secant/issues/23). It keeps that decision's rules that
Human Gates, Review checkpoints, Harness Requests, ordinary agent questions, and the human's Turns stay visibly distinct, that the current interaction
replaces the normal bottom input, and that colour is never the only signal. It amends [ADR 0024](./0024-use-one-deep-projection-port-for-tui-and-headless-clients.md)'s
visibly-distinct rule and settles [ADR 0022](./0022-own-a-truthful-deep-harness-seam.md)'s "private reasoning" for reasoning summaries.

**Layout.** There is no header. The transcript fills the screen and follows the live edge while the reader is there. Above 120 columns a 42-column
sidebar shows the Bundle name, the Steps (done, current with its Iteration, still to come), the Harness, model, and effort with any pending Model
choice, and the context used. Below 120 columns the current Step, Iteration, and Model choice move into the prompt's meta row. Earlier Steps stay in
full, separated by a thin rule naming the Step and its Harness Session; nothing folds. Ids, processes, and timestamps stay off the screen; the Run id
appears once the Run leaves an active state.

**What the transcript shows.** Each item appends in order and changes only in place.

- The human's messages sit in a panel with a bar in the agent colour. A **Steer** is the human's message inside its Turn, marked waiting, read by the
  agent, or not delivered.
- An **Entry Turn**'s Bundle prompt is one muted line saying Secant started the Step with it, since the human did not write it. Amendment
  (2026-10-08, [#462](https://github.com/secantdev/secant/issues/462)): this applies to every **Entry prompt**, any Turn input Secant sent from a
  Step's Bundle prompt, including an Agent step Attempt's prompt. Only input the human typed sits in the human's panel.
- Assistant text streams as markdown and is never truncated, so an agent's question is always read in full.
- A supplied reasoning summary is one collapsed Thought row, with its first nonempty line as a shortened label, a spinner and `Thinking` while it
  streams, and a duration only when the Harness reports a trustworthy reasoning duration. Existing Harness summary settings and unset defaults are
  inherited (ADR 0038).
- Each tool call is one row that changes in place: muted once settled, a spinner while running, the error colour when it fails. Shell output and
  file diffs are panels.
- An **Agent call** shows its call, the agent's reason, and what Secant did with it. An answered Human Gate shows the answer.
- A settled Turn ends with one line: the Harness, the model, the duration, and `interrupted` when it was.
- Rate limits, token usage, account notices, and unknown Harness methods never reach the transcript.

**Truncation.** Only shell output collapses, at 10 lines, ending with how many lines are hidden. Reasoning bodies and the Entry Turn prompt collapse
to their line. `ctrl+o` or a click expands everything collapsed. Assistant text, questions, the human's messages, and diffs are never cut; they wrap.
The shell bound applies to live output and completed output alike, fits the available width, and expands only on human action. Native output updates
replace the same call's preview; streaming never automatically opens a panel (ADR 0038). A Turn's cumulative diff collapses to its changed files
with lines added and removed and expands to the full diff; per-call patches are not cut (ADR 0039).
Amendment (2026-10-08): ADR 0039 bounds the content carried in history updates and reads large retained bodies on demand in bounded pieces.
Existing panels still expand in place and may briefly show loading or a retryable content-read failure. Fully shown messages and questions remain
readable without a new collapse rule; their visible text loads as needed. This changes delivery and loading, not the retained-content rules above.
Amendment (2026-10-08, [#461](https://github.com/secantdev/secant/issues/461)): a changed-file list also collapses. A Turn diff, and a single
call's file-change row, show the first 10 reported files in the Harness's order with paths wrapping, and the title line counts the rest as
`N more files`; 10 or fewer files add no count. `ctrl+o` or a click still opens the complete Turn diff or call patch, and updates never expand the
list. Only the list of names is capped; supplied diffs and patches stay uncut.
Amendment (2026-10-08, [#462](https://github.com/secantdev/secant/issues/462)): `ctrl+o` acts on one row, not everything collapsed. It toggles the
bottom-most row with at least one line on screen that hides or opens detail: a Thought with a body, shell output over 10 lines, the Entry prompt, or
a Turn diff or call patch, which opens the complete inspection. A row with nothing hidden is skipped, and a second press closes the row it opened.
The view then moves as for a click: a reader at the live edge stays there, and a paused reader's content stays fixed while the row grows. A click
still toggles any row. Expanding everything was rejected because one press would lay out and, once content loads on demand, read every retained body
in the window; the bottom-most row is the newest one, which a top-most rule leaves out of reach at the live edge.

**Colour.** Colour comes only from the vendored theme roles, and everforest is the default theme. The agent colour marks the human's messages, the
prompt bar, the Turn line, and the working indicator. Muted text marks settled work, `warning` marks reasoning rows and Harness Requests, `error`
marks failures, `success` marks Agent calls and a finished Run, and markdown carries bold.

**Bottom region.** Exactly one control holds it. A Harness Request is a panel headed "Permission required". A Human Gate is headed "Workflow
decision" and a Review checkpoint "Review checkpoint". A finished Run shows its outcome and Run id. Otherwise the prompt is there and always
editable. Its placeholder says whose move it is: while a Turn works, a message is a Steer the agent reads at its next step; otherwise it is the
human's next Turn. Sending clears the draft at once, with no sending state. Under the prompt, OpenCode's block scanner runs only while a Turn works,
beside `esc interrupt`. After an Interrupt, a note says the agent is waiting on the human, and any undelivered Steer is back in the draft. A Steer that
arrives after its Turn ended gets a notice, and its text stays in the draft.

**Keys and mouse.** Because the prompt always takes text, no bare letter is a Workbench command.

| Key                     | Does                                          |
| ----------------------- | --------------------------------------------- |
| `esc esc`               | Interrupt                                     |
| `enter`                 | Send, or Steer while a Turn works             |
| `shift+enter`, `ctrl+j` | Newline                                       |
| `ctrl+e`                | End Step                                      |
| `ctrl+n`                | Continue a human-controlled Repeat            |
| `ctrl+o`                | Expand                                        |
| `ctrl+g`                | Details panel                                 |
| `ctrl+c`                | Clear the draft; quit when the draft is empty |

The details panel takes focus from the prompt, so resume, cancel, and delete keep their letter keys and confirmations there. The mouse is on: the
wheel scrolls and a click expands. Every mouse action also has a key. The separate transcript overlay is retired: the conversation is on screen, and
captured command output and Run Artifacts are inspected from the details panel. The screen holds a Session's newest 200 rows; earlier rows are
marked as not shown, and the whole conversation opens on demand from the details panel's Session transcript (ADR 0039).

**ADR 0024 amended.** Durable, live, and preview updates stay distinct as data at the Projection Port, so a client always knows which kind of update
it holds. They are no longer required to look different on screen. Streaming text grows in place and settles without restyling. Only the working
indicator and the row spinners show that something is live.

**Reasoning summaries are not private reasoning.** A reasoning summary is text a provider writes for the user, such as Claude Code's summarized
thinking or Codex's reasoning summary. It may cross the Harness Seam, and the transcript shows it collapsed. The raw chain of thought, such as Codex's
raw reasoning text, stays private under ADR 0022.

**What this needs beneath the screen.** The Harness Seam and the Run Projection do not yet carry everything above. These gaps are decided separately,
in ADR 0038 for the Harness Seam and ADR 0039 for Turn history, its Projection facts, and headless `--json`:

- tool-call identity that pairs start and end, and running, failed, and declined states with error text;
- typed tool rows (a kind, the main input, and a result count), command output and exit code as fields, and file diffs as data;
- a reasoning-summary event;
- Turn history that grows during a Turn, with message identity so streaming text settles in place and durable rows arrive mid-Turn;
- noise kept out of `activity`, and context/usage facts supplied by both Adapters only where reported; Secant calculates no context occupancy,
  token counts, or percentages (ADR 0038);
- Steer state, Turn duration, Entry Turn authorship, and Agent-call rows in the Projection;
- which of these facts headless `--json` gains.

Rejected: keeping the timeline-first view with better styling, which still reads as an event log rather than the agent; a pure OpenCode layout with
Workflow progress only in the prompt's meta row, which hides the Steps on wide terminals; a Step-sectioned layout with a breadcrumb that folds earlier
Steps, which hides the conversation the human scrolls back to; styling previews differently from final text, which native agent screens do not do
and which made the old view read as unfinished; keeping reasoning summaries off the screen, since the provider publishes them for the user; and
keeping the Workbench keyboard-only, since the mouse wheel is the first thing a reader reaches for in a transcript.
