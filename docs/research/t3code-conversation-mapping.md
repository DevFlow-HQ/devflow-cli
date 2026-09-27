# T3 Code's Harness Event to Conversation Mapping

Research date: 2026-09-27

Upstream source snapshot: T3 Code commit
[`de251fc2971a884cb5b1305ba4daf309dc8cccb0`](https://github.com/pingdotgg/t3code/commit/de251fc2971a884cb5b1305ba4daf309dc8cccb0)
(MIT), read from a local clone of `origin/main`. Secant is compared at
[`9388dec6dd33119005cdb0e1881007ef720cd14d`](https://github.com/secantdev/secant/commit/9388dec6dd33119005cdb0e1881007ef720cd14d).

Ticket: [#238](https://github.com/secantdev/secant/issues/238)

## Answer

T3 Code shapes most of the conversation on the server, before any UI code runs. Each provider adapter translates native
Claude Code or Codex traffic into one shared `ProviderRuntimeEvent` union. The union covers turn lifecycle, content
deltas tagged by stream kind, item lifecycles for tools, requests, subagent tasks, token usage, rate limits, and
warnings.[^contract][^claude-router][^codex-map] A server ingestion layer then decides what enters the thread.
Assistant and reasoning deltas become buffered, segmented messages. Tool, request, task, plan, warning, error,
compaction, and context-window events become persisted _activities_. Turn lifecycle becomes session status. The rest is
dropped from the thread: account and auth updates, hooks, MCP OAuth completion, config and deprecation notices, tool
summaries, and live command or file-change output deltas.[^ingest-activities][^ingest-delta-filter]

Rate limits never become conversation items in the ordinary case. They go into a per-provider-instance snapshot read
by **Usage → Limits** and the `/usage-limits` banner. Only a limit that actually stops a turn becomes one warning or
error row.[^usage-ingest][^claude-rate][^codex-pump] Token usage drives a composer meter and is filtered out of the
timeline.[^worklog-filter][^context-meter]

The web client derives rows from the projected messages and activities. It collapses each tool call's lifecycle into
one row, groups adjacent tool rows under a summary, moves subagent work into an Agents surface behind one spawn row,
and folds a settled turn behind "Worked for …". While a turn runs it shows a "Working for" header and a live line that
reads "Thinking" or "Running <program>".[^worklog][^rows][^render-working] By default, assistant text reaches clients
one finished paragraph or closed code block at a time, not token by token.[^streaming-setting][^split] The pending
send is purely client-side: an optimistic user message plus a local "Sending" state that clears when the server
projection moves.[^local-dispatch][^optimistic]

T3 Code shows reasoning as collapsed "Thought" rows and asks Claude for summarized thinking.[^reasoning-row][^claude-thinking]
Secant's ADR 0022 keeps private reasoning out of the Harness Seam, and Secant's union carries no reasoning
today.[^adr0022][^sec-union]

Against Secant's `TurnEvent` union, the data already crosses for assistant text (a replaceable preview and final
content), tool activity with a started/completed phase and a free-text summary, Harness Requests, the effective
model, usage, and generic activity. It does not carry tool-call identity, a failed or declined tool status, command
output or exit code as fields, changed-file lists, subagent lifecycle, plans, compaction, warning severity, a
turn-accepted signal, or rate-limit facts. `context` is declared but neither native Adapter emits it. Secant's Codex
Adapter turns every method it does not recognize into `activity` naming the method, so `account/rateLimits/updated`
and `thread/tokenUsage/updated` reach the caller as activity text. That branch is the source of the "Codex activity:
account/rateLimits/updated" row in [Report 5](https://github.com/secantdev/secant/issues/235#issuecomment-5854322539).[^sec-codex-default]
The [comparison table](#comparison-with-secants-harness-event-union) lists each item.

## Evidence Boundary

- **Source-observed**: read in the pinned T3 Code or Secant source. Every claim below is source-observed unless it is
  marked otherwise.
- **Inferred**: a conclusion drawn from source-observed facts.
- Read: T3 Code's `AGENTS.md` and `docs/internals`, the Claude and Codex adapters, provider fan-out, orchestration
  ingestion, decider and projector, the server read projection, `packages/client-runtime/src/work-log`, and the web
  timeline and composer. Not read: mobile, desktop, the other four provider adapters, or any running T3 Code instance.
- This note describes T3 Code. It does not design Secant's screen.

## The Mapping Layers

T3 Code's guidance states the intended split: adapters translate native protocols into orchestration events, a pure
decider records events, a projector derives the read model, and "complexity belongs at the adapter boundary.
Orchestration stays pure, UI stays dumb."[^t3-agents][^t3-overview][^t3-providers] In practice the mapping runs
through seven layers:

| Layer                     | Where                                                                                                                | What it decides                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Native → runtime event | `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `CodexAdapter.ts`                                                | Which native messages become events; tool item type, title, and detail; subagent attribution; which limit, retry, or notice warrants a warning. Native frames ride along as `raw` for logging.[^contract] |
| 2. Provider fan-out       | `ProviderService.ts`, `ProviderUsageLimitsIngestion.ts`                                                              | Analytics for model reroutes and turn usage; rate limits into the provider-instance snapshot.[^provider-service][^usage-ingest]                                                                           |
| 3. Ingestion              | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`                                                   | Session status, message segmentation and buffering, the event-to-activity table, and everything that is dropped.[^ingest-activities][^ingest-session]                                                     |
| 4. Event log, read model  | `orchestration/decider.ts`, `orchestration/projector.ts`                                                             | A delta appends text; a completion flips `streaming` off.[^decider-msg][^projector-msg]                                                                                                                   |
| 5. Read projection        | `orchestration/ActivityPayloadProjection.ts`, `ThreadLiveEventCoalescer.ts`                                          | Slims activity payloads before any client sees them, prunes snapshots, and coalesces live tool updates.[^project-payload][^project-snapshot][^coalescer]                                                  |
| 6. Client derivation      | `apps/web/src/session-logic.ts`, `components/chat/MessagesTimeline.logic.ts`, `packages/client-runtime/src/work-log` | Work-log entries, lifecycle collapse, grouping, turn folds, and the working and thinking rows.[^worklog][^rows]                                                                                           |
| 7. Render                 | `components/chat/MessagesTimeline.tsx`, `components/ChatView.tsx`, composer components                               | Labels, icons, shimmer, the elapsed timer, and expansion bodies.[^render-working][^plain-row]                                                                                                             |

## Visible Items

### Assistant text

- **Claude.** A `text_delta` becomes `content.delta` with stream kind `assistant_text`, keyed to the text block's item
  id. `content_block_stop` emits `item.completed` of type `assistant_message` carrying the block's full text as
  `detail`. When no delta streamed, the adapter first emits the snapshot text as one delta. The result message
  force-completes any open block.[^claude-stream][^claude-text-complete][^claude-complete-turn]
- **Codex.** `item/agentMessage/delta` becomes `content.delta`. `item/completed` for an `agentMessage` becomes
  `item.completed` whose `detail` is the item text.[^codex-agent-delta][^codex-item-completed][^codex-detail]
- **Render.** The assistant row renders markdown with an `isStreaming` flag. A finished empty message reads
  "(empty response)". The copy button and timestamp row wait until the turn settles.[^render-assistant][^rows-meta]
- Streaming mechanics are under [Streaming Text to Final Message](#streaming-text-to-final-message).

### Reasoning

- **Claude.** A `thinking_delta` is mapped to `reasoning_summary_text`, with the source comment "Claude never returns
  the raw chain of thought." T3 Code launches Claude with `showThinkingSummaries` and thinking display `summarized`
  unless thinking is off or the `thinking-display` launch argument is `omitted`.[^claude-streamkind][^claude-thinking]
- **Codex.** `item/reasoning/textDelta` becomes `reasoning_text`, and `item/reasoning/summaryTextDelta` becomes
  `reasoning_summary_text`. Ingestion keeps a summary and a raw trace of the same item in separate
  segments.[^codex-reasoning][^reasoning-ids]
- **Ingestion.** Reasoning is stored as messages with role `reasoning` and a `reasoning:` id prefix. It is never
  delivered token by token: a `token` project setting is downgraded to `paragraph` for reasoning. A block closes when
  visible assistant text starts, a tool starts, a request pauses the turn, or the reasoning item completes. The item's
  snapshot text is used only when nothing streamed.[^ingest-reasoning][^ingest-tool-closes][^ingest-reasoning-complete]
- **Render.** A reasoning block is a collapsed "Thought" row that expands to markdown, capped at `max-h-96`. While it
  streams it reads "Thinking" with a shimmer. Adjacent thoughts and tool rows in one turn share an activity group
  labelled "Thought (×N)" or by the tool summary. Thoughts fold with the rest of a settled
  turn.[^reasoning-row][^reasoning-trace][^activity-group][^turn-folds]
- Clients that do not opt in to reasoning receive those messages with role `system`.[^project-event]

### Tool calls

- **Claude.** A `tool_use` `content_block_start` becomes `item.started`. The item type comes from a tool-name
  heuristic (`bash` → `command_execution`, `edit`/`write` → `file_change`, `agent`/`task` → `collab_agent_tool_call`,
  and so on), with a generic title and a `detail` summary of the input. `input_json_delta` emits `item.updated` when the
  parsed input changes. A `tool_result` emits `item.updated` and then `item.completed` with status `completed` or
  `failed` and the result block in `data`.[^claude-tool-start][^claude-classify][^claude-summary][^claude-user]
- **Codex.** `item/started` and `item/completed` map to the same lifecycle. The item type comes from the native
  `item.type`, and `data` is the whole native notification. A `failed` or `declined` native status passes
  through.[^codex-lifecycle][^codex-itemtype][^codex-title]
- **Ingestion.** Tool item types become `tool.started`, `tool.updated`, and `tool.completed` activities. `detail` is
  truncated to 180 characters. `tool.updated` rows persist in projected form, because each streaming update repeats the
  accumulated output; `tool.started` and `tool.completed` persist the full payload.[^ingest-tool-activities]
- **Read projection.** Before a payload reaches a client, the server reduces a non-MCP tool's `data` to the command, a
  one-line output summary, up to 12 changed paths, and a few identifiers. Snapshots drop `tool.updated` rows that a
  later completion supersedes. Live updates for one tool call are coalesced within a 50 ms
  window.[^project-payload][^project-superseded][^coalescer]
- **Client.** `tool.started` rows are skipped. Updates and the completion merge into one row by tool-call id. Tool rows
  with neither a success nor a failure signal are hidden inside groups unless they are running in the live turn.
  Adjacent tool rows render as one summary such as "Ran 3 commands and read 2 files". A single row is labelled by its
  command or tool presentation.[^worklog-filter][^worklog-collapse][^group-summary][^display-label]

### Commands with output

- **Label.** Known shell wrappers are unwrapped, so `/bin/zsh -lc "printf 'hello'"` displays as the inner command
  while the raw command is kept for the expanded body.[^command-unwrap][^command-output-test]
- **Output.** Live `command_output` deltas from both providers are dropped at ingestion.[^ingest-delta-filter] The
  row's output comes from the completed item: Codex `item.aggregatedOutput` or the Claude `tool_result` content. The
  server reduces it to the first meaningful line, at most 84 characters, or "N lines". The client strips a trailing
  `<exited with exit code N>`.[^project-command][^project-summary][^strip-exit]
- **Status.** A live command reads "Running <program>" and then "Ran", "Failed", "Declined", or "Stopped".[^live-label]
- **Expanded body.** Expanding a row shows the raw command, the output summary, and changed files in monospace, capped
  at `max-h-64`.[^expanded-body][^plain-row]
- **Inferred.** Full command output is persisted in the event store but never sent to a client, so the conversation
  never shows more of a command's output than the one-line summary.[^ingest-tool-activities][^project-snapshot]

### File edits and diffs

- **Per tool.** The server collects up to 12 changed paths from the payload. A single edit row and an edit group both
  read "Changed N files", counted by distinct paths, and the paths appear in the expanded
  body.[^project-payload][^single-edit-row][^group-summary][^expanded-body]
- **Provider diffs are not rendered.** `file_change_output` deltas are dropped.[^ingest-delta-filter] Codex
  `turn/diff/updated` only records a placeholder checkpoint with status `missing` while the turn
  runs.[^codex-diff][^ingest-diff]
- **Turn diff.** On turn completion, the checkpoint reactor captures a hidden git ref, diffs it against the pre-turn
  ref with `numstat`, and attaches per-file additions and deletions to the turn's final assistant message. The
  changed-files card under that message opens the diff panel.[^checkpoint][^changed-files]
- **Inferred.** The visible diff is T3 Code's own git evidence, not a Harness event.

### Subagents

- **Claude.** `task_started`, `task_progress`, `task_updated`, and `task_notification` become `task.*` events that
  repeat the agent's identity (role, model, effort, tool-use id, workflow) on every row. Subagent narration (text and
  thinking with a `parent_tool_use_id`) is dropped. Subagent tool blocks are tagged with the owning agent. Subagent
  assistant snapshots emit nothing.[^claude-tasks][^claude-subagent-stream][^claude-subagent-assistant]
- **Codex.** Synthetic `collabAgent/*` events become `task.*` with `timelineBypass: true`, and child-thread chatter is
  suppressed.[^codex-collab][^codex-child-chatter]
- **Ingestion.** Task progress uses one stable activity id per task, so each tick replaces the last.[^ingest-task-progress]
- **Client.** The "quiet-timeline guarantee": rows owned by an agent leave the main timeline, and each batch of spawns
  becomes one row such as "Kicked off 3 subagents", linked to the Agents
  panel.[^quiet][^spawn-summary][^spawn-row]

### Plans, approvals, questions, warnings, and compaction

- **Plans.** `turn.plan.updated` is kept out of the work log. It feeds an in-memory "current step" for the working
  indicators. A proposed plan (Claude `ExitPlanMode`, a Codex plan item) becomes a proposed-plan
  card.[^worklog-filter][^plan-progress][^proposed-plan]
- **Approvals.** `request.opened` becomes an `approval.requested` activity, which renders as a row such as "Command
  approval requested". The composer's approval panel is derived from the same activities. In `full-access` mode Claude
  approvals are auto-allowed and no request is raised.[^ingest-approval][^pending][^claude-canuse]
- **Questions.** `user-input.requested` carries questions with options. Codex async questions arrive on a completed
  agent message and are answered with a new user message.[^codex-async][^t3-providers-async]
- **Warnings and errors.** A `runtime.warning` row is labelled by its message. `runtime.error` shows a "Runtime error"
  row and sets the session's `lastError`. The adapters choose which notices become warnings. A Codex error with
  `willRetry` is a warning, and Codex stderr is an error only when fatal.[^ingest-errors][^claude-system][^codex-error]
- **Compaction.** A compacted thread state becomes a row such as "Compacted context 120k → 40k
  tokens".[^ingest-compaction]

### Timestamps

Work rows and the assistant metadata line carry timestamps, but each stays invisible until the row is hovered or
focused.[^row-timestamp][^assistant-meta]

## Dropped or Aggregated as Noise

| Native signal                                                                                                                                    | T3 Code fate                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude `rate_limit_event`; Codex `account/rateLimits/updated`                                                                                    | Normalized to `account.rate-limits.updated` and folded into the provider-instance snapshot for **Usage → Limits** and `/usage-limits`. No thread row.[^claude-rate][^codex-rate][^usage-ingest][^usage-doc]                                                                   |
| A Claude window rejected with no overage during a turn                                                                                           | One `runtime.warning` per limit window and reset time per turn, because the SDK parks the turn silently.[^claude-rate]                                                                                                                                                        |
| Codex `usageLimitExceeded`                                                                                                                       | One `runtime.error` built from the latest limits, with the duplicate `error` notification suppressed.[^codex-pump]                                                                                                                                                            |
| Codex `account/updated`; Claude `auth_status`                                                                                                    | Emitted as `account.updated` and `auth.status`; ingestion has no case for them.[^codex-account][^claude-telemetry][^ingest-activities]                                                                                                                                        |
| Token usage (Claude `message_delta`, result, `task_progress`; Codex `thread/tokenUsage/updated`)                                                 | `thread.token-usage.updated` becomes a `context-window.updated` activity. It is filtered from the work log, drives the composer meter, and snapshots keep one per turn.[^claude-stream][^codex-token][^ingest-activities][^worklog-filter][^context-meter][^project-snapshot] |
| Turn usage and cost on `turn.completed`                                                                                                          | Read for analytics; not rendered in the thread.[^claude-complete-turn][^provider-service]                                                                                                                                                                                     |
| Claude `api_retry`                                                                                                                               | A `session.state.changed` "running" heartbeat. The source says per-attempt warning rows spammed the work log.[^claude-system]                                                                                                                                                 |
| Claude `thinking_tokens`, `local_command_output`, `plugin_install`, `commands_changed`, `memory_recall`, `background_tasks_changed`, and similar | Consumed without an event, as are `vcs_state_changed`, `code_change_published`, `prompt_suggestion`, `conversation_reset`, and `command_lifecycle`.[^claude-system][^claude-vcs][^claude-router]                                                                              |
| Claude `notification` and `informational`                                                                                                        | Dropped unless high priority or a warning, then a warning row.[^claude-system]                                                                                                                                                                                                |
| Claude hooks, `tool_use_summary`, `files_persisted`, `system/init`                                                                               | Emitted as `hook.*`, `tool.summary`, `files.persisted`, and `session.configured`; ingestion has no case for them.[^claude-system][^claude-telemetry][^ingest-activities]                                                                                                      |
| Codex `model/rerouted`                                                                                                                           | Analytics only (`mixedModels`). A Claude `model_refusal_fallback` becomes a warning row instead.[^codex-reroute][^provider-service][^claude-system]                                                                                                                           |
| Codex `deprecationNotice`, `configWarning`, MCP OAuth completion                                                                                 | Emitted, with no ingestion case.[^codex-notices][^ingest-activities]                                                                                                                                                                                                          |
| Live command and file-change output deltas (both providers)                                                                                      | Dropped at the top of ingestion.[^ingest-delta-filter]                                                                                                                                                                                                                        |
| Parent-conversation `tool.progress`                                                                                                              | Dropped; only subagent-owned heartbeats persist, one row per task.[^ingest-tool-progress]                                                                                                                                                                                     |
| Unknown Codex method; unknown Claude SDK message                                                                                                 | Codex returns no event. Claude emits a `runtime.warning`, and the client hides such rows when their summary ends with "(no displayable text content)".[^codex-fallthrough][^claude-router][^no-content-warning]                                                               |

## Streaming Text to Final Message

1. **Adapter.** Each text block (Claude) or agent message item (Codex) streams deltas under its item id and completes
   with its full text as a fallback.[^claude-stream][^claude-text-complete][^codex-item-completed]
2. **Segment ids.** Ingestion names a message `assistant:<itemId>`. Later segments in the same turn get `:segment:N`.
   Reasoning uses the `reasoning:` prefix.[^reasoning-ids][^ingest-segment-start]
3. **Delivery mode.** A per-project setting chooses `turn` (hold until the turn ends or pauses), `paragraph` (the
   default, deliver each finished paragraph or closed code block), or `token` (legacy, forward every delta). The key
   was renamed so earlier token-streaming opt-ins reset to `paragraph`.[^streaming-setting]
4. **Paragraph split.** Buffered text is released up to the last blank line, closing fence, list-item start, or
   top-level heading outside an open fence. A section title waits until content follows it. Deliveries are at least
   400 ms apart, and a buffer over 24,000 characters spills whole.[^split][^buffer][^buffer-constants]
5. **Completion.** Ingestion flushes the remaining buffer as a final delta, then dispatches a completion with
   `streaming: false`. It uses the completion's fallback text only when nothing streamed, and skips a redundant empty
   completion.[^finalize][^ingest-assistant-complete]
6. **Pause.** An approval or a blocking question flushes and completes the current segment, so text written before the
   request is final. Text after it opens a new segment.[^ingest-pause]
7. **Turn end.** Every open message is finalized, pending native-callback questions are dismissed, and segment state is
   cleared.[^ingest-terminal]
8. **Read model.** A streaming delta appends text. A completion with empty text keeps the text and clears
   `streaming`.[^decider-msg][^projector-msg]
9. **Client.** A text-only change to a streaming message replaces its row in place without re-sorting the
   timeline.[^timeline-streaming]

## Pending Send and Working Agent

### Pending send

- **Order of operations.** On send, the client starts a local dispatch, appends an optimistic user message, and clears
  the composer before awaiting any server call.[^send-begin][^optimistic]
- **Acknowledgement.** `isSendBusy` holds until the server projection shows the dispatch took effect. While a turn
  runs, a changed latest user message counts (a steer). Otherwise a change in the latest turn's timestamps or the
  session status counts. A pending approval or question, a thread error, or a turn-start failure also clears
  it.[^local-dispatch][^ack]
- **Composer.** While busy, the send button shows a spinner and reads "Sending". While a turn runs, a new draft
  "queues" next to Stop. Queued messages render as rows below the live turn and send at the next completed tool
  boundary or turn end. The queue holds while an approval or question is pending.[^send-button][^queue][^queued-rows]

### Working agent

- **Session status.** Ingestion sets the session status from `turn.started` (running), `turn.completed` (ready, or
  error when failed), `turn.aborted` (interrupted), and `session.exited` (stopped). `runtime.error` sets error. A
  stale or conflicting turn id cannot move the lifecycle.[^ingest-session][^ingest-runtime-error]
- **Working state.** `isWorking` is true when the phase is `running`, a send is busy, or the thread is connecting,
  reverting, compacting, or waiting for a worktree bootstrap.[^derive-phase][^is-working]
- **Rows.** A "working" row sits right after the latest user message and reads "Working for <elapsed>". Its timer
  rewrites its own text node every second, so it causes no React commits. The live line reads "Thinking" with a brain
  icon when no tool is active, or the active tool's label ("Running pytest"). A settled turn folds behind "Worked for
  <duration>", or "You stopped after <duration>" when interrupted.[^working-row-logic][^render-working][^timer][^live-row][^turn-folds]
- **Animation.** The shimmer is a CSS mask moving left to right over 2.2 s. An IntersectionObserver pauses it off
  screen, in a hidden tab, and under reduced motion.[^css-shimmer][^visible-anim] T3 Code's guidance names "a lying
  spinner" and continuously repainting animations as things to avoid.[^t3-agents]
- **Plan step.** A current plan step from `turn.plan.updated` annotates the working indicators and is cleared when the
  turn settles.[^plan-progress]

## Reasoning and ADR 0022

ADR 0022 lists "private reasoning" beside raw frames and telemetry as facts that remain private at the Harness
Seam.[^adr0022] At the pinned Secant commit:

- The `TurnEvent` union has no reasoning variant.[^sec-union]
- The Claude Code Adapter reads only `text_delta` stream events and only `text` and `tool_use` content blocks, so
  thinking never becomes an event.[^sec-claude-stream][^sec-claude-assistant]
- The Codex Adapter returns reasoning items with no event. Reasoning delta methods fall into the generic branch, which
  emits `activity` naming the method, such as "Codex activity: item/reasoning/summaryTextDelta", with no reasoning
  text.[^sec-codex-reasoning][^sec-codex-default]

T3 Code, by contrast, requests Claude's summarized thinking, displays Codex raw and summary reasoning, and persists
both as `reasoning` messages.[^claude-thinking][^ingest-reasoning] ADR 0022's text does not say whether a
provider-supplied reasoning _summary_ counts as private reasoning. This note records that as an open question for the
ADR owner.

## Comparison With Secant's Harness Event Union

"Secant today" names the `TurnEvent` variant that carries the data and what the Claude Code and Codex Adapters
actually populate.[^sec-union][^sec-tool-activity]

| T3 Code visible item                           | T3 Code data (normalized)                                                                    | Secant today                                                                                                                                                                                                                                                                          | Gap                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Streaming assistant message                    | `content.delta` (`assistant_text`) keyed by item id                                          | `preview`: one cumulative, replaceable text for the Turn; removed when final content lands.[^sec-claude-preview][^sec-codex-preview]                                                                                                                                                  | No message or segment identity; one preview slot per Turn.                                                  |
| Final assistant message                        | `item.completed` `assistant_message` with full text                                          | `assistant-content` per Claude text block or Codex agent message, plus `finalContent` on the result.[^sec-claude-assistant][^sec-codex-item][^sec-completed]                                                                                                                          | Carried. No id tying it to its preview.                                                                     |
| Reasoning ("Thought")                          | `reasoning_text` / `reasoning_summary_text` deltas; reasoning item completion                | None by design. Codex reasoning methods surface as method-name `activity`.[^sec-codex-reasoning][^sec-codex-default]                                                                                                                                                                  | Intentional under ADR 0022; see the open question above.                                                    |
| Tool call row and lifecycle                    | `item.started/updated/completed`: item id, item type, title, detail, status, `data`          | `tool-activity`: `tool`, `phase` started or completed, free-text `summary`.[^sec-tool-activity]                                                                                                                                                                                       | No call id to pair phases; no item-type classification; no failed or declined status; no in-flight updates. |
| Command with output                            | Command string; completed output (first line or "N lines"); exit code in text                | Codex summary is the command only. Claude's completed summary is the stringified `tool_result` content.[^sec-codex-item][^sec-claude-tools]                                                                                                                                           | No separate command, output, or exit-code fields; Codex output absent.                                      |
| File edit row                                  | Up to 12 changed paths from the payload                                                      | Codex summary "N file changes". Claude summary is the JSON-stringified tool input.[^sec-codex-item][^sec-claude-assistant]                                                                                                                                                            | No structured path list.                                                                                    |
| Turn diff and changed-files card               | T3 Code's own git checkpoint diff at turn end                                                | Not a Harness event in either product.[^checkpoint]                                                                                                                                                                                                                                   | Not a Seam gap: T3 Code derives it outside its adapters.                                                    |
| Subagent spawn row and Agents panel            | `task.*` with task id, role, model, status, usage; `agentId` on tool items; `timelineBypass` | `parentActivity` on `assistant-content` and `tool-activity`, set only by the Claude Adapter. Codex collab calls are `tool-activity` `subagent`. Claude `system` task frames become generic activity.[^sec-tool-activity][^sec-claude-assistant][^sec-codex-item][^sec-claude-generic] | No subagent identity, lifecycle, status, or usage.                                                          |
| Plan progress and proposed plan                | `turn.plan.updated`; `turn.proposed.*`                                                       | None. Codex plan methods become method-name `activity`; Claude TodoWrite is an ordinary `tool-activity`.[^sec-codex-default][^sec-claude-assistant]                                                                                                                                   | No plan data.                                                                                               |
| Approval                                       | `request.opened/resolved` with native options                                                | `request-raised` / `request-answered` / `request-expired`, with an `approval` shape of `tool`, `input`, and `allow`/`deny`.[^sec-requests]                                                                                                                                            | Carried. Decisions limited to allow and deny.                                                               |
| Structured question                            | `user-input.requested`: questions, options, multi-select                                     | `clarification` with one free-text `prompt`.[^sec-requests]                                                                                                                                                                                                                           | No options or multi-question structure.                                                                     |
| Warning and error rows; error banner           | `runtime.warning`, `runtime.error`, session `lastError`                                      | Codex errors become `activity` text ("Codex is retrying after an error: …"). Typed failure arrives only on the result.[^sec-codex-accept][^sec-completed]                                                                                                                             | No severity; a warning is indistinguishable from other activity.                                            |
| Compaction row                                 | `thread.state.changed` `compacted` with before and after tokens                              | None. Codex compaction surfaces as generic activity; Claude `compact_boundary` as "Claude Code activity: system".[^sec-codex-item][^sec-claude-generic]                                                                                                                               | No compaction fact.                                                                                         |
| Context-window meter                           | `thread.token-usage.updated` → `context-window.updated`                                      | `context` (`usedTokens`, `limitTokens`) is declared but emitted by neither Adapter. Codex `thread/tokenUsage/updated` becomes method-name `activity`.[^sec-union][^sec-codex-default]                                                                                                 | Declared, not populated.                                                                                    |
| Turn usage and cost                            | `turn.completed` usage, cost, token usage (analytics only)                                   | `usage` (labelled estimate, free-text summary) from the Claude result; the Codex Adapter emits none.[^sec-claude-result][^sec-union]                                                                                                                                                  | Summary text only; Codex missing.                                                                           |
| Rate limits and account                        | Provider snapshot; one row only when a limit stops the turn                                  | No variant. Codex `account/rateLimits/updated` becomes `activity`; Claude `rate_limit_event` becomes "Claude Code activity: rate_limit_event".[^sec-codex-default][^sec-claude-generic]                                                                                               | Inverse gap: Secant emits as activity what T3 Code keeps out of the thread.                                 |
| Effective model and reroute                    | `turn.started` model; `model.rerouted` (analytics); Claude fallback warning                  | `model` with known or unknown model.[^sec-union]                                                                                                                                                                                                                                      | Carried; no reroute reason.                                                                                 |
| Session init facts                             | `session.configured` (dropped)                                                               | `session` with facts, plus a Claude `activity` summarizing version, tools, and MCP.[^sec-claude-init][^sec-codex-admitted]                                                                                                                                                            | Carried; Secant emits more than T3 Code shows.                                                              |
| Working indicator (turn running, tool running) | Session status from `turn.started` and terminal events; in-progress tool status              | No turn-accepted or turn-started event. The caller knows `startTurn` returned and when the result settles. Tool phase `started` has no id to pair with its completion.[^sec-interface][^sec-codex-accept]                                                                             | No native-acceptance signal; no running-tool identity.                                                      |
| Pending send                                   | Client-local optimistic message and dispatch state                                           | Caller-owned. The durable recorder's `admit` precedes submission.[^sec-recorder]                                                                                                                                                                                                      | Not Harness data in T3 Code either.                                                                         |

## Sources

[^adr0022]: Secant, [ADR 0022 lines 27-32](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/adr/0022-own-a-truthful-deep-harness-seam.md?plain=1#L27-L32).

[^t3-agents]: T3 Code, [`AGENTS.md` lines 143-165](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/AGENTS.md?plain=1#L143-L165).

[^t3-overview]: T3 Code, [`docs/internals/overview.md` lines 40-77](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/internals/overview.md?plain=1#L40-L77).

[^t3-providers]: T3 Code, [`docs/internals/providers.md` lines 1-6](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/internals/providers.md?plain=1#L1-L6).

[^t3-providers-async]: T3 Code, [`docs/internals/providers.md` lines 81-91](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/internals/providers.md?plain=1#L81-L91).

[^contract]: T3 Code, [`packages/contracts/src/providerRuntime.ts` lines 23-216](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/providerRuntime.ts#L23-L216) (raw envelope, stream kinds, item and request types, event types, base) and [lines 1177-1230](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/providerRuntime.ts#L1177-L1230) (the union).

[^claude-router]: T3 Code, [`ClaudeAdapter.ts` lines 4133-4187](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4133-L4187).

[^claude-stream]: T3 Code, [`ClaudeAdapter.ts` `handleStreamEvent` lines 2849-2959](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2849-L2959).

[^claude-subagent-stream]: T3 Code, [`ClaudeAdapter.ts` lines 2858-2882](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2858-L2882).

[^claude-tool-start]: T3 Code, [`ClaudeAdapter.ts` lines 2961-3144](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2961-L3144).

[^claude-classify]: T3 Code, [`ClaudeAdapter.ts` `classifyToolItemType` lines 1027-1075](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1027-L1075).

[^claude-summary]: T3 Code, [`ClaudeAdapter.ts` `summarizeToolRequest` and `titleForTool` lines 1485-1537](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1485-L1537).

[^claude-streamkind]: T3 Code, [`ClaudeAdapter.ts` `streamKindFromDeltaType` lines 1725-1731](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1725-L1731).

[^claude-thinking]: T3 Code, [`ClaudeAdapter.ts` lines 1733-1738](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1733-L1738) and [lines 4853-4926](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4853-L4926).

[^claude-user]: T3 Code, [`ClaudeAdapter.ts` `handleUserMessage` lines 3164-3321](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3164-L3321) and [`toolResultStreamKind` lines 1862-1871](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1862-L1871).

[^claude-subagent-assistant]: T3 Code, [`ClaudeAdapter.ts` lines 3330-3406](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3330-L3406).

[^claude-text-complete]: T3 Code, [`ClaudeAdapter.ts` `completeAssistantTextBlock` lines 2257-2333](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2257-L2333).

[^claude-complete-turn]: T3 Code, [`ClaudeAdapter.ts` `completeTurn` lines 2657-2847](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2657-L2847) and [`handleResultMessage` lines 3471-3490](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3471-L3490).

[^claude-vcs]: T3 Code, [`ClaudeAdapter.ts` lines 3593-3606](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3593-L3606).

[^claude-system]: T3 Code, [`ClaudeAdapter.ts` `handleSystemMessage` lines 3608-3999](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3608-L3999).

[^claude-tasks]: T3 Code, [`ClaudeAdapter.ts` lines 3695-3861](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3695-L3861).

[^claude-telemetry]: T3 Code, [`ClaudeAdapter.ts` `handleSdkTelemetryMessage` lines 4003-4067](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4003-L4067).

[^claude-rate]: T3 Code, [`ClaudeAdapter.ts` lines 4069-4130](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4069-L4130).

[^claude-canuse]: T3 Code, [`ClaudeAdapter.ts` lines 4693-4740](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4693-L4740).

[^codex-map]: T3 Code, [`CodexAdapter.ts` `mapToRuntimeEvents` lines 1307-2226](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1307-L2226).

[^codex-fallthrough]: T3 Code, [`CodexAdapter.ts` line 2225](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2225).

[^codex-itemtype]: T3 Code, [`CodexAdapter.ts` `toCanonicalItemType` lines 647-666](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L647-L666).

[^codex-title]: T3 Code, [`CodexAdapter.ts` `itemTitle` lines 732-771](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L732-L771).

[^codex-detail]: T3 Code, [`CodexAdapter.ts` `itemDetail` lines 774-796](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L774-L796).

[^codex-lifecycle]: T3 Code, [`CodexAdapter.ts` `mapItemLifecycle` lines 1000-1041](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1000-L1041).

[^codex-collab]: T3 Code, [`CodexAdapter.ts` `mapCollabAgentEvent` lines 1051-1090](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1051-L1090).

[^codex-child-chatter]: T3 Code, [`CodexSessionRuntime.ts` lines 1109-1132](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L1109-L1132).

[^codex-token]: T3 Code, [`CodexAdapter.ts` lines 1581-1599](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1581-L1599).

[^codex-diff]: T3 Code, [`CodexAdapter.ts` lines 1667-1681](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1667-L1681).

[^codex-item-completed]: T3 Code, [`CodexAdapter.ts` lines 1683-1744](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1683-L1744).

[^codex-async]: T3 Code, [`CodexAdapter.ts` lines 1694-1714](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1694-L1714).

[^codex-agent-delta]: T3 Code, [`CodexAdapter.ts` lines 1780-1838](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1780-L1838).

[^codex-reasoning]: T3 Code, [`CodexAdapter.ts` lines 1840-1879](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1840-L1879).

[^codex-reroute]: T3 Code, [`CodexAdapter.ts` lines 1934-1950](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1934-L1950).

[^codex-notices]: T3 Code, [`CodexAdapter.ts` lines 1952-1988](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1952-L1988) and [lines 2023-2042](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2023-L2042).

[^codex-account]: T3 Code, [`CodexAdapter.ts` lines 1990-2003](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1990-L2003).

[^codex-rate]: T3 Code, [`CodexAdapter.ts` lines 2005-2021](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2005-L2021).

[^codex-error]: T3 Code, [`CodexAdapter.ts` lines 2131-2171](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2131-L2171).

[^codex-pump]: T3 Code, [`CodexAdapter.ts` lines 2346-2420](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L2346-L2420).

[^provider-service]: T3 Code, [`ProviderService.ts` lines 1087-1110](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ProviderService.ts#L1087-L1110) and [`observeModelReroutedForAnalytics` lines 764-790](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ProviderService.ts#L764-L790).

[^usage-ingest]: T3 Code, [`ProviderUsageLimitsIngestion.ts` lines 1-44](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ProviderUsageLimitsIngestion.ts#L1-L44).

[^usage-doc]: T3 Code, [`docs/user/usage.md` lines 64-91](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/docs/user/usage.md?plain=1#L64-L91).

[^buffer-constants]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 117-122](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L117-L122).

[^split]: T3 Code, [`ProviderRuntimeIngestion.ts` `splitBufferedAssistantText` lines 222-288](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L222-L288).

[^reasoning-ids]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 305-342](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L305-L342).

[^ingest-activities]: T3 Code, [`ProviderRuntimeIngestion.ts` `runtimeEventToActivities` lines 492-1040](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L492-L1040); the default branch returns no activity at [lines 1035-1039](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1035-L1039).

[^ingest-approval]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 503-562](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L503-L562).

[^ingest-errors]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 564-619](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L564-L619).

[^ingest-task-progress]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 705-781](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L705-L781).

[^ingest-tool-progress]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 813-845](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L813-L845).

[^ingest-compaction]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 881-910](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L881-L910).

[^ingest-tool-activities]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 932-1033](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L932-L1033).

[^ingest-segment-start]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 1226-1286](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1226-L1286).

[^buffer]: T3 Code, [`ProviderRuntimeIngestion.ts` `appendBufferedAssistantText` lines 1340-1392](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1340-L1392).

[^finalize]: T3 Code, [`ProviderRuntimeIngestion.ts` `finalizeAssistantMessage` lines 1496-1546](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1496-L1546).

[^ingest-delta-filter]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 1781-1790](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1781-L1790).

[^ingest-session]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 1832-1958](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1832-L1958).

[^ingest-reasoning]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 1960-2038](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1960-L2038).

[^ingest-pause]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 2099-2151](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2099-L2151).

[^ingest-tool-closes]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 2040-2056](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2040-L2056) and [lines 2158-2176](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2158-L2176).

[^ingest-reasoning-complete]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 2178-2249](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2178-L2249).

[^ingest-assistant-complete]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 2251-2336](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2251-L2336).

[^ingest-terminal]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 2349-2425](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2349-L2425).

[^ingest-runtime-error]: T3 Code, [`ProviderRuntimeIngestion.ts` lines 2431-2458](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2431-L2458).

[^ingest-diff]: T3 Code, [`ProviderRuntimeIngestion.ts` `recordProviderDiff` lines 2622-2657](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2622-L2657).

[^plan-progress]: T3 Code, [`ThreadPlanProgress.ts` lines 1-12](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ThreadPlanProgress.ts#L1-L12) and [`ProviderRuntimeIngestion.ts` lines 2480-2493](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L2480-L2493).

[^streaming-setting]: T3 Code, [`packages/contracts/src/settings.ts` lines 977-984](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/settings.ts#L977-L984) and [lines 1092-1098](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/contracts/src/settings.ts#L1092-L1098).

[^decider-msg]: T3 Code, [`decider.ts` lines 1935-2002](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/decider.ts#L1935-L2002).

[^projector-msg]: T3 Code, [`projector.ts` lines 776-830](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/projector.ts#L776-L830).

[^project-command]: T3 Code, [`ActivityPayloadProjection.ts` `projectCommandData` lines 86-129](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L86-L129) and [`summarizeMcpResult` lines 213-244](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L213-L244).

[^project-summary]: T3 Code, [`ActivityPayloadProjection.ts` `summarizeToolTextOutput` lines 164-189](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L164-L189).

[^project-payload]: T3 Code, [`ActivityPayloadProjection.ts` `projectActivityPayload` lines 425-501](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L425-L501) and [`collectChangedFiles` lines 33-84](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L33-L84).

[^project-superseded]: T3 Code, [`ActivityPayloadProjection.ts` `dropSupersededToolUpdatedActivities` lines 581-644](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L581-L644).

[^project-snapshot]: T3 Code, [`ActivityPayloadProjection.ts` lines 504-664](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L504-L664).

[^project-event]: T3 Code, [`ActivityPayloadProjection.ts` `projectActivityEvent` lines 666-689](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ActivityPayloadProjection.ts#L666-L689).

[^coalescer]: T3 Code, [`ThreadLiveEventCoalescer.ts` lines 18-80](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/ThreadLiveEventCoalescer.ts#L18-L80).

[^checkpoint]: T3 Code, [`CheckpointReactor.ts` lines 285-356](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/orchestration/Layers/CheckpointReactor.ts#L285-L356).

[^worklog]: T3 Code, [`apps/web/src/session-logic.ts` lines 389-519](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L389-L519) and [`toDerivedWorkLogEntry` lines 542-680](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L542-L680).

[^quiet]: T3 Code, [`session-logic.ts` lines 389-449](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L389-L449).

[^worklog-filter]: T3 Code, [`session-logic.ts` lines 470-491](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L470-L491).

[^no-content-warning]: T3 Code, [`session-logic.ts` lines 517-526](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L517-L526).

[^worklog-collapse]: T3 Code, [`session-logic.ts` `collapseDerivedWorkLogEntries` lines 718-885](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L718-L885).

[^command-unwrap]: T3 Code, [`session-logic.ts` lines 1053-1143](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L1053-L1143).

[^strip-exit]: T3 Code, [`session-logic.ts` `extractToolDetail` and `stripTrailingExitCode` lines 1217-1302](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L1217-L1302).

[^timeline-streaming]: T3 Code, [`session-logic.ts` lines 1620-1715](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L1620-L1715).

[^derive-phase]: T3 Code, [`session-logic.ts` `derivePhase` lines 1738-1750](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.ts#L1738-L1750).

[^command-output-test]: T3 Code, [`session-logic.command-output.test.ts` lines 20-44](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/session-logic.command-output.test.ts#L20-L44).

[^group-summary]: T3 Code, [`packages/client-runtime/src/work-log/presentation.ts` lines 464-635](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/client-runtime/src/work-log/presentation.ts#L464-L635) (`toolGroupAction`, the per-action counts and labels, and `summarizeToolGroup`).

[^pending]: T3 Code, [`packages/client-runtime/src/pendingRequests.ts` lines 124-165](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/packages/client-runtime/src/pendingRequests.ts#L124-L165).

[^display-label]: T3 Code, [`MessagesTimeline.logic.ts` lines 47-70](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L47-L70).

[^single-edit-row]: T3 Code, [`MessagesTimeline.logic.ts` lines 1289-1304](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L1289-L1304).

[^live-label]: T3 Code, [`MessagesTimeline.logic.ts` `liveWorkEntryLabel` lines 72-98](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L72-L98).

[^rows]: T3 Code, [`MessagesTimeline.logic.ts` row union lines 340-463](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L340-L463) and [`deriveMessagesTimelineRows` lines 962-1487](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L962-L1487).

[^turn-folds]: T3 Code, [`MessagesTimeline.logic.ts` `deriveTurnFolds` lines 643-825](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L643-L825).

[^working-row-logic]: T3 Code, [`MessagesTimeline.logic.ts` lines 1022-1136 and 1462-1475](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L1022-L1475).

[^rows-meta]: T3 Code, [`MessagesTimeline.logic.ts` lines 1377-1412](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L1377-L1412).

[^queued-rows]: T3 Code, [`MessagesTimeline.logic.ts` lines 1477-1485](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L1477-L1485).

[^spawn-summary]: T3 Code, [`agentSpawnSummary.ts` lines 7-36](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/agentSpawnSummary.ts#L7-L36).

[^render-assistant]: T3 Code, [`MessagesTimeline.tsx` `AssistantTimelineRow` lines 2380-2425](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2380-L2425).

[^render-working]: T3 Code, [`MessagesTimeline.tsx` `WorkingTimelineRow` lines 2531-2564](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2531-L2564) and [`ThinkingTimelineRow` lines 2705-2715](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2705-L2715).

[^row-timestamp]: T3 Code, [`MessagesTimeline.tsx` `TimelineRowTimestamp` lines 2327-2353](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2327-L2353).

[^assistant-meta]: T3 Code, [`MessagesTimeline.tsx` `AssistantMessageMeta` lines 2445-2487](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2445-L2487).

[^activity-group]: T3 Code, [`MessagesTimeline.tsx` `ActivityGroupTimelineRow` lines 2608-2703](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2608-L2703).

[^reasoning-trace]: T3 Code, [`MessagesTimeline.tsx` `ReasoningTraceBlock` lines 2739-2829](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2739-L2829).

[^reasoning-row]: T3 Code, [`MessagesTimeline.tsx` `ReasoningTimelineRow` lines 2831-2895](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2831-L2895).

[^timer]: T3 Code, [`MessagesTimeline.tsx` `WorkingTimer` lines 2906-2932](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L2906-L2932).

[^live-row]: T3 Code, [`MessagesTimeline.tsx` `LiveActivityRow` lines 3138-3252](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L3138-L3252).

[^changed-files]: T3 Code, [`MessagesTimeline.tsx` `AssistantChangedFilesSection` lines 3374-3459](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L3374-L3459).

[^expanded-body]: T3 Code, [`MessagesTimeline.tsx` `buildToolCallExpandedBody` lines 4413-4462](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L4413-L4462).

[^spawn-row]: T3 Code, [`MessagesTimeline.tsx` `AgentSpawnRow` lines 4510-4540](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L4510-L4540).

[^plain-row]: T3 Code, [`MessagesTimeline.tsx` `PlainWorkEntryRow` lines 4727-4941](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.tsx#L4727-L4941).

[^proposed-plan]: T3 Code, [`ClaudeAdapter.ts` lines 3412-3439](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3412-L3439), [`CodexAdapter.ts` lines 1716-1729](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1716-L1729), and [`MessagesTimeline.logic.ts` lines 1367-1375](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/MessagesTimeline.logic.ts#L1367-L1375).

[^css-shimmer]: T3 Code, [`apps/web/src/index.css` lines 502-586](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/index.css#L502-L586).

[^visible-anim]: T3 Code, [`apps/web/src/lib/visibleAnimation.ts` lines 10-48](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/lib/visibleAnimation.ts#L10-L48).

[^context-meter]: T3 Code, [`apps/web/src/lib/contextWindow.ts` lines 28-73](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/lib/contextWindow.ts#L28-L73).

[^local-dispatch]: T3 Code, [`ChatView.tsx` `useLocalDispatchState` lines 774-849](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.tsx#L774-L849).

[^is-working]: T3 Code, [`ChatView.tsx` lines 3237-3243](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.tsx#L3237-L3243).

[^send-begin]: T3 Code, [`ChatView.tsx` lines 7897-7900](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.tsx#L7897-L7900).

[^optimistic]: T3 Code, [`ChatView.tsx` lines 8228-8258](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.tsx#L8228-L8258).

[^ack]: T3 Code, [`ChatView.logic.ts` `hasServerAcknowledgedLocalDispatch` lines 1256-1323](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/ChatView.logic.ts#L1256-L1323).

[^send-button]: T3 Code, [`ComposerPrimaryActions.tsx` lines 215-280](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/chat/ComposerPrimaryActions.tsx#L215-L280).

[^queue]: T3 Code, [`QueuedMessageSender.tsx` lines 30-99](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/components/QueuedMessageSender.tsx#L30-L99).

[^sec-union]: Secant, [`src/harness/harness.ts` lines 300-392](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L300-L392).

[^sec-tool-activity]: Secant, [`src/harness/harness.ts` `ToolActivity` lines 308-315](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L308-L315).

[^sec-requests]: Secant, [`src/harness/harness.ts` lines 249-298](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L249-L298).

[^sec-completed]: Secant, [`src/harness/harness.ts` `CompletedDetail` and `FailedDetail` lines 476-492](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L476-L492).

[^sec-recorder]: Secant, [`src/harness/harness.ts` lines 185-247](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L185-L247).

[^sec-interface]: Secant, [`src/harness/harness.ts` `HarnessTurn` and `PreparedHarness` lines 554-592](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L554-L592).

[^sec-codex-default]: Secant, [`src/harness/codex/runtime-protocol.ts` lines 437-535](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/runtime-protocol.ts#L437-L535); unrecognized methods emit `Codex activity: <method>` at lines 530-535.

[^sec-codex-reasoning]: Secant, [`src/harness/codex/runtime-protocol.ts` line 552](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/runtime-protocol.ts#L552).

[^sec-codex-item]: Secant, [`src/harness/codex/runtime-protocol.ts` `normalizeItem` lines 538-703](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/runtime-protocol.ts#L538-L703).

[^sec-codex-preview]: Secant, [`src/harness/codex/runtime-protocol.ts` lines 489-497](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/runtime-protocol.ts#L489-L497) and [`src/harness/codex.ts` lines 1613-1630](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L1613-L1630).

[^sec-codex-admitted]: Secant, [`src/harness/codex.ts` lines 1227-1238](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L1227-L1238).

[^sec-codex-accept]: Secant, [`src/harness/codex.ts` lines 1244-1336](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L1244-L1336).

[^sec-claude-init]: Secant, [`src/harness/claude-code.ts` lines 1243-1253](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1243-L1253).

[^sec-claude-assistant]: Secant, [`src/harness/claude-code.ts` `acceptAssistant` lines 1256-1287](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1256-L1287) and [`summarize` lines 1431-1439](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1431-L1439).

[^sec-claude-tools]: Secant, [`src/harness/claude-code.ts` `acceptToolResults` lines 1289-1305](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1289-L1305).

[^sec-claude-stream]: Secant, [`src/harness/claude-code.ts` `acceptStreamEvent` lines 1307-1312](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1307-L1312).

[^sec-claude-result]: Secant, [`src/harness/claude-code.ts` `acceptResult` lines 1314-1316](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1314-L1316).

[^sec-claude-preview]: Secant, [`src/harness/claude-code.ts` lines 1382-1400](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1382-L1400).

[^sec-claude-generic]: Secant, [`src/harness/claude-code.ts` lines 1093-1122](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1093-L1122) and [`src/harness/claude-code/frames.ts` lines 120-162 and 231-236](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code/frames.ts#L120-L236).
