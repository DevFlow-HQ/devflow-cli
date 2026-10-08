# Grow a Turn's history in place through a per-Session history Projection

The Run Workbench appends a conversation whose rows change in place (ADR 0036), and the Harness Seam now carries identified tool, command, diff, and
summary facts (ADR 0038). The Run Projection still carries one replaceable preview string and one activity string per Run, has no message or call
identity, stores assistant text twice, and publishes a Turn's durable rows only after the Turn. [Decide how a Turn's history grows mid-Turn in the Run
Projection and headless --json](https://github.com/secantdev/secant/issues/263) resolves how history is stored, identified, bounded, and read.

**Stored at start and at settle, never per chunk.** A tool call, an Agent call, and a Steer are stored when they start and again when they settle;
assistant text and Thought rows are stored once when they settle. No delta or output chunk is written. A Turn that is later `lost` therefore still
shows what was in flight, with its outcome unconfirmed. Every row goes through the existing admitted `appendTurnEvent`, so the Harness-facing half
keeps exactly three admitted Turn writes. Amendment (2026-10-08): changed history is published during the Turn without waiting for the Attempt's
publication, but an observer may skip unread intermediate states under the latest-state delivery rule below.

**Identity and order.** Each item carries an opaque identity that is stable within its Turn: the Adapter supplies it for assistant text, Thoughts,
and tool calls, and Secant supplies it for Steers and Agent calls. The Projection issues its own opaque row identity at the Projection Port, so the
Seam's identity never reaches a client and clients never learn where an identity came from. A row keeps the position where its item first
appeared, not where it settled. Amendment (2026-10-08): this is the canonical conversation order for Session history, full transcript pages, and
exports, as decided in [Decide one conversation order for the full transcript and Session history](https://github.com/secantdev/secant/issues/457).
Turn input comes first, and retained items follow their first appearance within the Turn. Settlement, confirmed Steer delivery, and an Interrupt
do not move an item. Persist the observed first-appearance order with its durable fact; no chunk persistence is added. Transcript eligibility and
retained-entry identity are separate from order. Preserve existing retained-entry identities when changing the comparator. Previous-release
conversation keeps its authoritative migrated order; missing first appearances are never reconstructed from timestamps or legacy event copies.

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
clients at most every 50 ms per Run. Amendment (2026-10-08): starts and terminal facts remain recorded individually, but unread Session-history
pages and row previews may be superseded by their latest reconciled values under the delivery rule below. Supplied final output replaces the preview
without appending to it; a
call that completes without output keeps its preview with that label; a failed or declined call shows its error with any retained preview below. A
cumulative Turn diff is one row that collapses to the changed files with lines added and removed and expands to the full diff; per-call patches
are not cut. Context and usage stay in the live overlay, replaced on each report and never stored.

**One per-Session history family.** A new `openProjection` family reads one Session's history: the newest 200 rows, with no cursor. Amendment
(2026-10-08): a changed history publishes a complete, payload-bounded replacement page through the existing `durable` update. Large retained bodies
are reached through typed Resource References instead of being copied into every page. Clients never merge stored rows; the one live update variant
carries a complete replacement of one row's bounded preview and content references. The Application owns preview-to-row reconciliation, coalescing,
stale-preview removal, and liveness behind it (ADR
0038). A row that falls off the top of the page is no longer shown or updated, as in OpenCode; the page marks that earlier conversation is not
shown. The whole conversation stays readable on demand through the Session's transcript page and export References, which the Run Workbench opens
from its details panel. The `run` family's live overlay loses its Run-wide `preview` and `activity` strings and the `preview` update kind. The
overlay keeps the Turn phase, outstanding requests, Action Offers, context, and usage. `RunView.timeline` keeps its frozen shape, derived from the
new rows.

**Bounded latest-state delivery (2026-10-08).** [Decide how a Session history page fits the update stream's bound](https://github.com/secantdev/secant/issues/456)
amends the never-coalescing rule in [Bound Projection queues and end only a lagging subscription](https://github.com/secantdev/secant/issues/306)
for `session-history` only. Each observer retains at most one unread complete page and one later preview per retained row. A newer complete page
supersedes every earlier unread page and preview. Later previews replace earlier previews for the same row and respect Application's newest
window. Starts and settlements remain canonical stored facts even when the screen skips intermediate states. Preserve row identity, position,
source, and paused viewport anchors. A replaced preview cannot resurrect a settled or evicted row. Suppress unchanged pages before delivery.

The retained page and later previews together must fit a finite payload allowance; bound initial pages too. Use encoded UTF-8 payload accounting
for this family, with 8 MiB as the existing nominal delivery budget, rather than calling the current UTF-16 estimate a byte bound. Application
chooses private inline thresholds and reserves space for metadata, references, and pending previews under that aggregate allowance. Large values,
including messages, Thoughts, patches, tool input/output, errors, and file lists, cannot bypass it. Do not reduce the 200-row window or silently cut
retained content to meet delivery limits. There is no oversized-current-history-page exception. Terminal closure still releases retained state,
unregisters the observer, delivers its one prescribed terminal ahead of pending state, and rejects later pushes. Producers never wait, and observers
remain independent. Other Projection families keep their existing FIFO, accounting, overflow, and reopen behavior.

**Content read on demand (2026-10-08).** Application extends the Projection Port's typed Resource reading for retained history content. Keep complete
supplied patches and existing retained message/Thought bodies outside the bounded delivery page. Command output still retains only its 30,000-character
tail; this adds no full-output capture. A reference selects one exact content version. Read large bodies in bounded chunks with Application-owned
opaque continuation, preserving the supplied text exactly. Neither one read nor a concatenated hidden cache may eagerly load an arbitrarily large
body. Metadata and large file lists follow the same rule. Storage/native coordinates, provider deltas, and resource retention decisions stay behind
the Port. Existing transcript References cannot supply tool, Thought, or diff details and are not a substitute for this extension.

The Workbench loads content when an existing panel expands or inspection requests it; fully shown messages and questions load as needed for their
visible text without a new collapse rule. Expansion stays in place, may briefly show loading, and preserves its row and scroll anchor. Reading more
content does not change `View freshness`. Show a read failure with a retry on that content, without disconnecting the history view or affecting the
Run. A read completing for an older row/content version cannot overwrite a newer value or restore removed content. Stored content follows Run
retention until deletion. Live-only content remains ephemeral and follows the current row/observer lifetime; no chunk writes, crash reconstruction,
or timer-based persistence is added. Retain live content versions only while the latest delivery state or a bounded set of active reads needs them.
Reclaim superseded live versions; reading one after reclamation returns a stale, retryable content Problem and never substitutes a newer body's chunks.
Release demand-loaded content when it is no longer needed, keeping only a bounded viewport/inspection cache.
The exact typed read shapes and private thresholds are specified with the implementing slice; the above limits and version behavior are mandatory.

The references supply the mechanisms rather than a ready-made Secant contract. OpenCode keeps a
[30,000-character live shell tail](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/tool/shell.ts#L487)
and [separates oversized tool output from its inline result](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/tool/truncate.ts#L85).
T3 Code [projects compact activity on the server](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L164),
[coalesces identified tool updates](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ThreadLiveEventCoalescer.ts#L51),
and [fetches diff bodies separately](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/review.ts#L31).
Its [live-stream budget](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/LiveStreamBudget.ts#L17)
measures encoded bytes. Secant keeps reconciliation in Application and adapts these ideas to opaque Resource References. OpenCode's expiring local
output files and unbounded SSE queue, T3's client event reduction and 1 MiB diff-detail rejection, and a larger FIFO are not adopted. A strict page
budget alone still permits repeated pages to overflow a finite queue; latest-page replacement alone still permits an arbitrarily large patch.

**One record of the conversation.** `transcript_entry` retires. The Turn's input becomes its first row, `settleTurn` stops appending a final
assistant copy, and transcript pages and exports are built from Turn rows: human input, delivered Steers, and settled assistant messages.
Previous-release databases migrate at open through the embedded journals. Amendment (2026-10-08): an eligible message or delivered Steer keeps its
first-appearance position in this record. Assistant text still streaming and waiting or undelivered Steers remain absent from the stored transcript.
An orderly Turn settlement retains partial text with the existing incomplete marker; a crash does not reconstruct live-only content.

**Fixed transcript traversal (2026-10-08).** The first page read fixes the set of eligible stored conversation entries for that traversal. Every
older-page read carries the same eligibility cutoff and an exclusive first-appearance order boundary behind its opaque cursor. Later settlements,
Steer deliveries, and Turn inputs cannot enter that traversal, even if their first-appearance position lies inside a range already read. Re-reading
an older cursor returns the same entries while the Run is retained. Opening the transcript again starts a fresh traversal and includes newly
eligible entries in canonical order. The ordinary Session-history Projection continues updating independently.

Each export captures its own fresh eligibility cutoff when requested and orders that fixed set by the same canonical comparator. An export may
therefore include entries absent from an earlier-opened transcript reader. Identical retained entries have the same relative order. No new
shared-snapshot control or refresh action is required. Preserve the existing 20-entry pages, chronological order within each page, bounded export
behavior, opaque older cursor, Resource read envelopes, and stable retained-entry identity used for prepend and scroll anchoring. Application owns
the cutoff, cursor validation, and ordering behind the Projection Port. An eligibility cutoff and order key need no eagerly copied transcript or
transaction held open while a human reads. Exact cursor encoding and query mechanics belong to the implementing slice.

**Headless.** Headless stays stored-only and gains no live stream. `run read --transcript --json` entries keep `session`, `role`, and `content`,
gain optional `kind` (message, Steer, Entry prompt), `turn`, `steer`, and `incomplete` fields, and now list each settled assistant message rather
than one per Turn. Tool, Thought, diff, and Agent-call rows, live previews, waiting Steers, and context and usage are headless parity gaps
recorded in [headless parity](../headless-parity.md). `run show --json` is unchanged. Amendment (2026-10-08): canonical ordering and fixed transcript
reads change no headless JSON shape. Keep the existing optional `step`, decided optional metadata, `{ page, export }` envelope, and read-result
fields. Presentation identities, first-appearance keys, and eligibility cutoffs remain private and never become JSON entry fields. The cursor
remains an opaque string in its existing field.
Amendment (2026-10-08, [#462](https://github.com/secantdev/secant/issues/462)): the Entry prompt `kind` marks every Turn input Secant authored
(origin `managed`), including an Agent step Attempt's prompt, not only an Interactive agent step's Entry Turn. History derives it from the Turn,
so earlier Runs relabel on screen; stored transcript and export values are not backfilled, so earlier Agent-step prompts stay `message` there. The
JSON gains no kind or field. Headless text output names the authored kinds, `user · Entry prompt:` and `user · Steer:`, as the transcript reader
already does.

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
