# Tool fact qualification

#414 consumes identified calls and #416 consumes supplied file facts through the Harness Interface. Existing `recording.json` sidecars own the versions,
recording times, redactions, and refresh commands listed below. No recording bytes change. `observed-facts.test.ts`
feeds authentic message frames and item bodies through the production Adapters over an injected Process.
Synthetic envelopes, terminal omissions, id reuse, errors, and interleaving prove semantic behavior only.

## Claude Code

`test-repair/stdout-0.stdout` and `stdout-final.stdout`, Claude Code 2.1.273, qualify `assistant.message.content`
`tool_use` blocks with `id`, `name`, and opaque `input`, plus `user.message.content` `tool_result` blocks with
`tool_use_id` and `content`. Read and Edit inputs qualify `file_path`. A Read result reports `tool_use_result.file.numLines`.
The count means returned lines, not total file length. Deterministic assertions check both Read calls separately,
their main paths and counts of 2 and 5 lines, Edit settlement, and identity before the authoritative Turn result.

`matt-front/implement-0.stdout`, 2.1.286, qualifies Glob `input.pattern` and `tool_use_result.numFiles`.
The maintained case checks the pattern and the reported count of 2 files, independent of the filenames array.
`model-change/turn-1a.stdout` and `turn-1b.stdout`, 2.1.289, qualify Write `input.file_path` and a correlated result.
Requested edit/write inputs establish the target, never an observed change.

#416 qualifies Edit result `filePath` and `structuredPatch[]` with `oldStart`, `oldLines`, `newStart`, `newLines`,
and supplied `lines[]` from `test-repair/stdout-final.stdout`, recorded 2026-09-16T10:35:47.881Z. These are hunk
coordinates, not reported additions/removals. The Edit result reports no change-kind field, so kind stays absent.
Write result `type: "create"`, `filePath`, and an empty `structuredPatch` come from `model-change/turn-1b.stdout`,
recorded 2026-10-04T14:27:13.509Z. Empty hunks remain empty; `content`, `originalFile`, and old/new strings never
manufacture a patch. Assertions preserve both complete hunk data and emptiness on the correlated terminal call.
Each case's sidecar records Workspace/input-delta redactions and its `bun tests/harness/record.ts` refresh command.
Synthetic interleaving, malformed patches/kinds, requested-only edits, and large content test semantic behavior.

`steer-cancel/turn-1.stdout` and `cancelled.stdout`, 2.1.288, qualify rejected Write results with
`is_error: true`, string `content`, and the structured refusal discriminator `tool_use_result: "User rejected tool use"`.
Refusal never comes from a Harness Request answer or from parsing result prose. Other observed `is_error: true`
results normalize as failed, with string error content when supplied. Synthetic failure and malformed-count cases
check those semantic branches using the qualified fields. Missing or malformed numeric siblings leave counts absent.

`elicitation-declined/before.stdout` and `after.stdout`, 2.1.289, qualify the generic envelope for ToolSearch and
external MCP work. MCP input remains its tool name and opaque serialized input. Its recorded result text says
"decline" while its tool result has no error flag, so the call completes. The separate elicitation decline cannot
rewrite that outcome. `agent-call/before.stdout`, 2.1.289, qualifies `mcp__secant__step_done`; it stays an Agent call,
never an ordinary MCP row. ToolSearch itself remains meaningful `other` work, including its opaque query.

The Adapter mints call ids in each Secant Turn. Repeated starts/results are ignored by identity. Native ids never
cross the Interface, and native-id reuse in later Turns or Sessions mints different opaque values.

## Codex

`test-repair/case.json`, codex-cli 0.160.0 and codex-probe-3, qualifies correlated `item/started` and `item/completed`
`commandExecution` items with `id`, `command`, and `status`, including `inProgress`, `completed`, and `failed`.
It also qualifies `fileChange.id`, `changes[].path`, `changes[].kind.type: "update"`, null `move_path`, and `status`.
#416 qualifies `changes[].diff` as a supplied unified patch on the completed call. #502 exposes the started item's
`changes[].path` as ordered structured targets only, with no observed change kind or patch before completion.
Running targets do not prove an edit completed. `turn/diff/updated` supplies `threadId`, `turnId`, and `diff`:
four repeated cumulative snapshots without a call association. Only their supplied unquoted `+++ b/<path>` headers
outside hunks establish collapsed file paths; unfamiliar header forms stay absent while all diff bytes remain.
No addition/removal totals are supplied. The production Adapter assertions check complete per-call content,
Turn correlation, repeated replacements, and drain-before-result. The recording is dated 2026-10-03T21:26:02.175Z;
its sidecar owns the Workspace/account/home redactions and `bun tests/harness/record-codex.ts test-repair` refresh.
Synthetic cases verify foreign Turn/thread rejection, malformed optional data, same-path interleaving and large diffs.
Main inputs preserve command text and affected paths/change kinds. Array length is not a reported result count.
#415 also qualifies `cwd`, string/null `aggregatedOutput`, integer/null `exitCode` and correlated
`item/commandExecution/outputDelta` `threadId`/`turnId`/`itemId`/`delta`. The authentic failed and completed
node test commands replace their deltas with exact final output; exit codes 0, 1 and 2 stay numeric facts.
`approval/case.json`, the same executable/protocol versions, qualifies null final output with exit 0.
Its unchanged item body is asserted through the production Adapter. Null means unavailable, not explicit empty.
Copied-recording variants test empty/omitted/malformed finals, repeated deltas, late/foreign ids and orderly
unmatched tails. Those are semantic boundary cases, not fresh wire qualification. Command actions and native
omission fields stay unconsumed. Claude Bash command/output/cwd/structured-exit fields remain unqualified.

`agent-calls/case.json`, codex-cli 0.160.0 and codex-probe-4, qualifies MCP item `id`, `server`, `tool`, opaque
`arguments`, and `status`. A focused test reuses unchanged item bodies with only envelope correlation remapped.
It checks external approval/form/URL tools separately and excludes Secant `step_done` from ordinary MCP history.
Neither an elicitation answer nor result text determines a tool outcome. MCP failed status and non-null error detail are unqualified. Command refusal and file-change failed/refused statuses also stay absent.

The Adapter's private id map includes native Turn and item ids inside the owning Secant Turn. The shared producer
keeps the first start and observed terminal fact, replaces bounded previews, and drains incomplete command
partials before result. A partial keeps a running outcome; Application derives unconfirmed liveness. Turn terminal truth
never manufactures a tool result. `interrupt/case.json` contains a command start without a terminal item; standalone
Interrupt conformance retains that observation without a synthetic settlement.

## Explicit gaps and semantic coverage

The authentic corpus does not qualify a non-null parent-call relation, native web/subagent item shapes,
every optional count/error/refusal form in both Adapters, or Claude structured numeric shell exit codes.
File additions/removals, Codex add/delete kinds and non-null moves, and Claude non-create kinds remain unqualified.
Structured patch lengths are never converted to totals. Missing patches remain absent, including requested-only edits.
Those fields stay absent. Codex synthetic collab/web/image/dynamic item schemas previously produced activity,
but cannot qualify native observations. They now stay absent. The fake's maintained full-vocabulary case retains
all eight semantic kinds, same-name interleaving, private parent ids, zero/optional counts, and error/refusal outcomes.
An unfamiliar Claude tool in a qualified tool-use envelope remains `other`; an unknown protocol method produces nothing.

`session-history.test.ts` proves one logical row, stable subscription ids/positions, one mixed 200/201 window,
shared 50 ms preview timing, terminal replacement, no stale resurrection, id reuse, and unmatched outcomes.
Evicted stored keys stay excluded when Turn settlement removes memory-only previews in the same Application lifetime.
Store acceptance checks immutable first appearance, start/settlement crash durability, parent metadata, duplicate
facts, and transcript exclusion. Renderer acceptance checks words independent of color, wrapping, keyboard scrolling,
and dual resize. Standing headless, observer, control, and transcript cases remain in the three named M10 CI steps.
Human terminal and installed-Harness release evidence remains a separate recorded gate.

#439 replays the recorded Claude MCP names as `server/tool`. Synthetic child assistant,
message-start and message-delta overlays verify exclusion from main-thread usage and
Turn-local parent correlation, including a child arriving before its parent's start.
These overlays enforce translation policy; they do not qualify a native subagent usage shape.
Unknown and malformed control requests exercise a typed lost Turn and process retirement.
