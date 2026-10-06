# Tool fact qualification

#414 consumes identified calls through the Harness Interface. Existing `recording.json` sidecars own the versions,
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
Requested edit/write inputs establish the target, not an observed patch. Diff extraction belongs to #416.

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
It also qualifies `fileChange.id`, `changes[].path`, `changes[].kind.type`, nullable `move_path`, and `status`.
Main inputs preserve command text and affected paths/change kinds. Array length is not a reported result count.
Command actions, output, cwd, and exit code are not consumed by this slice. #415 owns output evidence and retention.

`agent-calls/case.json`, codex-cli 0.160.0 and codex-probe-4, qualifies MCP item `id`, `server`, `tool`, opaque
`arguments`, and `status`. A focused test reuses unchanged item bodies with only envelope correlation remapped.
It checks external approval/form/URL tools separately and excludes Secant `step_done` from ordinary MCP history.
Neither an elicitation answer nor result text determines a tool outcome. MCP failed status and non-null error detail are unqualified. Command refusal and file-change failed/refused statuses also stay absent.

The Adapter's private id map includes native Turn and item ids inside the owning Secant Turn. The shared producer
keeps the first start and observed terminal fact, replaces previews, and drains before result. Turn terminal truth
never manufactures a tool result. `interrupt/case.json` contains a command start without a terminal item; standalone
Interrupt conformance retains that observation without a synthetic settlement.

## Explicit gaps and semantic coverage

The authentic corpus does not qualify a non-null parent-call relation, native web/subagent item shapes,
every optional count/error/refusal form in both Adapters, or Claude structured numeric shell exit codes.
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
