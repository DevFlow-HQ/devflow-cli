# Grow a Turn's history in place through a per-Session history Projection

The Run Workbench appends a conversation whose rows change in place (ADR 0036), and the Harness Seam now carries identified tool, command, diff, and
summary facts (ADR 0038). The Run Projection still carries one replaceable preview string and one activity string per Run, has no message or call
identity, stores assistant text twice, and publishes a Turn's durable rows only after the Turn. [Decide how a Turn's history grows mid-Turn in the Run
Projection and headless --json](https://github.com/secantdev/secant/issues/263) resolves how history is stored, identified, bounded, and read.

**Stored at start and at settle, never per chunk.** A tool call, an Agent call, and a Steer are stored when they start and again when they settle;
assistant text and Thought rows are stored once when they settle. No delta or output chunk is written. A Turn that is later `lost` therefore still
shows what was in flight, with its outcome unconfirmed. Every row goes through the existing admitted `appendTurnEvent`, so the Harness-facing half
keeps exactly three admitted Turn writes. Each stored row reaches open clients during the Turn; the Turn's durable history no longer waits for the
Attempt's publication.

**Identity and order.** Each item carries an opaque identity that is stable within its Turn: the Adapter supplies it for assistant text, Thoughts,
and tool calls, and Secant supplies it for Steers and Agent calls. The Projection issues its own opaque row identity at the Projection Port, so the
Seam's identity never reaches a client and clients never learn where an identity came from. A row keeps the position where its item first
appeared, not where it settled.

**Steer, Agent call, and Turn facts.** A Steer is stored when sent, then becomes delivered, not delivered after an Interrupt, or delivery not
confirmed after a lost Turn. An Agent call is one row carrying the call and its reason, then Secant's reply (accepted, held for review, refused),
then whether it was applied when the Turn ended (ADR 0032). The Turn's closing line reads the Turn's origin (so the Entry Turn says Secant started
the Step), its result kind (interrupted or lost), its effective model or else its requested model (ADR 0034), and a duration from Secant's own
admitted and settled times. A `lost` or `not-started` Turn shows no duration.

**Interrupt and loss.** When a Turn settles, text and a Thought still streaming are stored as they stand and marked incomplete, and a running
command keeps its last retained preview labelled as live output that may be incomplete. The command's outcome stays unconfirmed; nothing is
invented. After a crash, live text and output held only in memory are gone and nothing is repaired or periodically saved: stored start rows remain
unconfirmed and settled rows stand.

**Command output and diffs.** Each call retains the last 30,000 characters of its output, live and stored alike, matching OpenCode's shell
preview. When earlier output is dropped a Secant marker says so, distinct from any omission the Harness itself reported. Live previews reach
clients at most every 50 ms per Run; terminal facts are never coalesced. Supplied final output replaces the preview without appending to it; a
call that completes without output keeps its preview with that label; a failed or declined call shows its error with any retained preview below. A
cumulative Turn diff is one row that collapses to the changed files with lines added and removed and expands to the full diff; per-call patches
are not cut. Context and usage stay in the live overlay, replaced on each report and never stored.

**One per-Session history family.** A new `openProjection` family reads one Session's history: the newest 200 rows, with no cursor. Each stored
change arrives as that whole page through the existing `durable` update, so clients never merge stored rows; the one new update variant carries a
single row's live preview. The Application owns preview-to-row reconciliation, coalescing, stale-preview removal, and liveness behind it (ADR
0038). A row that falls off the top of the page is no longer shown or updated, as in OpenCode; the page marks that earlier conversation is not
shown. The whole conversation stays readable on demand through the Session's transcript page and export References, which the Run Workbench opens
from its details panel. The `run` family's live overlay loses its Run-wide `preview` and `activity` strings and the `preview` update kind. The
overlay keeps the Turn phase, outstanding requests, Action Offers, context, and usage. `RunView.timeline` keeps its frozen shape, derived from the
new rows.

**One record of the conversation.** `transcript_entry` retires. The Turn's input becomes its first row, `settleTurn` stops appending a final
assistant copy, and transcript pages and exports are built from Turn rows: human input, delivered Steers, and settled assistant messages.
Previous-release databases migrate at open through the embedded journals.

**Headless.** Headless stays stored-only and gains no live stream. `run read --transcript --json` entries keep `session`, `role`, and `content`,
gain optional `kind` (message, Steer, Entry prompt), `turn`, `steer`, and `incomplete` fields, and now list each settled assistant message rather
than one per Turn. Tool, Thought, diff, and Agent-call rows, live previews, waiting Steers, and context and usage are headless parity gaps
recorded in [headless parity](../headless-parity.md). `run show --json` is unchanged.

Rejected: storing only at settle, which erases in-flight work from a lost Turn; storing every chunk, which ADR 0038 excludes; a Secant counter as
item identity, which breaks when a native item is split or re-sent; inlining history in `RunView`, which re-sends the whole history on every
stored write and inlines transcript entries into `run show --json`; keeping two client-joined channels, which moves reconciliation into every
client; row-level durable deltas, which make each client a reducer (ADR 0024); paging older rows into the Workbench or keeping a bounded window of
loaded pages, which keeps rows mounted and rebuilt for rare scrollback while the on-demand transcript already serves it; a 1 MiB stored output,
roughly 35 times OpenCode's; a separate full-output file, which in OpenCode serves only the model, and here the Harness owns what its model sees;
and a headless `--follow` stream or history read, each a new frozen contract to qualify on three operating systems.

This amends [ADR 0024](./0024-use-one-deep-projection-port-for-tui-and-headless-clients.md) with the history family and the retired `preview`
update, and [ADR 0036](./0036-the-run-workbench-mirrors-the-agent.md) with the Turn-diff collapse, the 200-row window, and the details-panel
transcript. Implementation still follows the milestone loop.
