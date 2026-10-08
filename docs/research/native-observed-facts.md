# Native evidence for observed Harness facts

Research date: 2026-10-08. Resolves [Record native evidence for unqualified observed facts](https://github.com/secantdev/secant/issues/460), the native-evidence hand-over from [Audit: M10](https://github.com/secantdev/secant/issues/429#issuecomment-6034331033).
Secant source was inspected at `392046e7595858a3feb0320d1ab7cae82fc4eddf`.

## Findings

Installed recordings now establish Claude Bash calls and Codex declined command terminals. They do not establish Claude user-facing reasoning summaries, explicit line addition/removal totals, native context percentages, or a duration attributable to a qualified Thought summary.
Codex reports command duration `0`. Claude reports `thinking_duration_ms: 805` as message metadata, but its measurement and summary attribution remain unqualified. Neither supplies Thought duration.

These are research captures. Promoting their unchanged native bodies into fixture replay through the Harness Interface remains implementation work. No production code, existing fixture, provenance ledger, Harness preference, or ADR policy changed.
[ADR 0038](https://github.com/secantdev/secant/blob/392046e7595858a3feb0320d1ab7cae82fc4eddf/docs/adr/0038-carry-observed-tool-and-summary-facts-through-the-harness-seam.md) continues to require reported facts and authentic qualification.

## Capture method and scope

Three research sub-agents inspected the two installed Harnesses and independently reviewed the accepted native frames. Each probe ran in a temporary Workspace under an outer process-group timeout.
Claude Code was `2.1.294`, effective model `claude-opus-5-5`. Codex was `codex-cli 0.161.0`, qualified against `codex-probe-5` through Secant's production Adapter and recorder-only observer.

Claude inherited model, effort, and thinking-summary preferences. It used `--safe-mode`, `--strict-mcp-config`, a restricted tool list, and `--no-session-persistence` to isolate this recording.
Safe mode disables customizations, so absence in these captures does not establish absence in every customized user launch. No thinking-display flag or summary opt-in was supplied.
Codex inherited its user configuration and login. Its saved requests contain no model, effort, summary, sandbox-policy, or writable-root override. The ordinary Adapter supplies `approvalsReviewer: "user"`.

The observers excluded private reasoning and signatures before writing artifacts. Retained full native JSON lines preserve their wire text except documented redactions. Selected tool frames are verbatim retained lines, not rebuilt envelopes.
Claude's private-frame inventory is a projection of field names and allowed metadata, not a replayable private frame. Codex `stdout-projection` entries are explicitly labelled terminal projections. Neither qualifies omitted payloads.
Sidecars record versions, timestamps, redactions, and refresh commands. Codex's temporary paths are deliberately public probe paths and remain unchanged. Its schemas, account/config responses, stderr, and reasoning bodies are not published.

The Claude tool run exited `0`. The reasoning run's exit and omissions are recorded in its metadata. Both Codex runs reported clean Adapter close and native process exit `0`.
A first sandboxed Codex prepare stopped at the version probe because its executable warned about a read-only home. It made no Turn; the bounded native retry succeeded.

## Claude Bash is evidenced

The [selected tool frames](native-observed-facts-captures/claude/selected-tool-frames.jsonl) contain two distinct assistant `tool_use` blocks named `Bash`, their `input.command`, and correlated user `tool_result.tool_use_id` values.
The first result succeeds and reports structured `stdout`, empty `stderr`, and `interrupted: false`. The second reports `is_error: true` and string error content.
This establishes the existing command classifier and generic completed/failed outcome inputs. [Capture metadata](native-observed-facts-captures/claude/capture.json) and [recording provenance](native-observed-facts-captures/claude/recording.json) fix its scope.

Neither Bash result supplies structured numeric exit code, cwd, or duration. The failed result's text includes `Exit code 7`; parsing that prose into a numeric exit fact remains excluded.
The successful result's separate stdout/stderr fields are available for a scoped shell-output implementation, with no numeric-exit or cwd promise.
The [current classifier](https://github.com/secantdev/secant/blob/392046e7595858a3feb0320d1ab7cae82fc4eddf/src/harness/claude-code/frames.ts#L550-L649) only classifies Bash and preserves opaque input. It does not yet extract these shell-output fields.

## Codex command decline is evidenced

The [decline recording](native-observed-facts-captures/codex/decline.json), `capture[2]` through `capture[6]`, preserves start, approval request, native `decline` response, request resolution, and terminal command item.
The terminal `item/completed` independently reports `status: "declined"` with the same thread, Turn, and item identity. The Turn then completes successfully.
Its output, exit code, process id, and command duration are null. It supplies no refusal text. The approval request's explanation is not a terminal refusal reason.
[Recording provenance](native-observed-facts-captures/codex/recording-decline.json) records the exact capture version and time.

Native `availableDecisions` omits the literal `decline`, although this install accepts that response and reports the declined terminal. This qualifies the observed terminal, without changing Secant's user-facing approval contract.
The [current reader](https://github.com/secantdev/secant/blob/392046e7595858a3feb0320d1ab7cae82fc4eddf/src/harness/codex/runtime-protocol.ts#L900-L925) suppresses declined terminals. A follow-up can now consume this native outcome through fixture replay.
[Official App Server documentation](https://learn.chatgpt.com/docs/app-server) also describes completed items as authoritative and documents declined command terminals. Documentation supports interpretation; the recording establishes the native observation.

## Claude summaries remain unqualified

The tool probe supplied no thinking frames. The [reasoning probe](native-observed-facts-captures/claude/reasoning/native-filtered.stdout) supplied `thinking_display: "updates"` metadata and thinking/signature frames, which were excluded.
Its [private-frame inventory](native-observed-facts-captures/claude/reasoning/private-frame-metadata.json) preserves metadata without retaining private bodies. No qualified user-facing summary was captured under this launch.
[Provenance](native-observed-facts-captures/claude/reasoning/recording.json) records the inherited-preference scope.

Earlier [Claude summary research](claude-code-reasoning-summaries.md) investigated explicit summarized-display settings on 2.1.283. Those opt-in observations do not authorize changing this user's settings or establish an inherited-settings summary fixture for 2.1.294.
Arbitrary `thinking` and `thinking_delta` fields remain private. A future positive case needs version, model/provider and display semantics, identified summary deltas, and authoritative final replacement.

## Explicit line totals and context percentages remain absent

Claude's Edit result in the selected tool frames supplies `structuredPatch` hunks and lines. Codex's [normal recording](native-observed-facts-captures/codex/normal.json), `capture[6]`, supplies a completed file change and unified patch, followed by cumulative Turn diffs.
Neither supplies explicit additions/removals totals. Hunk `oldLines` and `newLines` are coordinates, not totals. Counted patch lines cannot qualify reported totals.

Claude's result reports model window capacity and usage. Codex's normal and decline recordings report separate `total` and `last` counters plus `modelContextWindow: 828400`.
Neither supplies native percentage or an explicit occupancy measurement. Capacity and counters remain separate facts. Division, tokenization, or a guessed model limit cannot fill this gap.
These negative observations cover the recorded versions and cases, not every possible provider/model or future native protocol.

## Durations retain their own meanings

Codex's normal `capture[9]` reports completed command `durationMs: 0`, output, and exit code `0`. This establishes a reported zero command duration, not a nonzero example or reasoning duration.
The [ToolCall contract](https://github.com/secantdev/secant/blob/392046e7595858a3feb0320d1ab7cae82fc4eddf/src/harness/harness.ts#L427-L451) currently has no command-duration consumer. Adding one requires a separate contract decision and stays outside this evidence ticket.

Claude's private-frame inventory reports `thinking_duration_ms: 805` on an assistant message, without a qualified summary or established measurement semantics.
Its whole-Turn `duration_ms: 2544` and API `duration_api_ms: 2173` measure different scopes. Codex's labelled terminal projection similarly retains whole-Turn duration separately.
The [Thought contract](https://github.com/secantdev/secant/blob/392046e7595858a3feb0320d1ab7cae82fc4eddf/src/harness/harness.ts#L578-L585) needs trustworthy reasoning-duration attribution. None of these observations closes that qualification gap.

## Sibling implementations are advisory

OpenCode was inspected at `228e9095ba3988a02664c3816cb51f98584e86c2`. It uses [local reasoning timestamps](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/session/processor.ts#L207-L214), [calculated context percentages](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/subagent-footer.tsx#L33-L44), and [diff-derived totals](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/core/src/tool/edit.ts#L178-L189). Those are not Harness-reported Secant facts.

T3 Code was inspected at `de251fc2971a884cb5b1305ba4daf309dc8cccb0`. Its Claude launch [requests summarized thinking](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4879-L4890), and its [context helper calculates percentages](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/web/src/lib/contextWindow.ts#L43-L48).
Its [Codex terminal mapper](https://github.com/pingdotgg/t3code/blob/de251fc2971a884cb5b1305ba4daf309dc8cccb0/apps/server/src/provider/Layers/CodexAdapter.ts#L1000-L1030) preserves declined status. These examples guided investigation and do not replace installed native evidence or ADR 0038.

## Implementation hand-over

M10's follow-up planning can promote the unchanged Claude Bash and Codex declined bodies into recorded fixture cases, replay them through production Adapters, and update [tool provenance](https://github.com/secantdev/secant/blob/392046e7595858a3feb0320d1ab7cae82fc4eddf/tests/harness/tool-facts-provenance.md).
Keep Claude numeric exit codes, summaries, totals, native percentages, and qualified Thought durations absent. A fixture test must establish call correlation and terminal independence, including the successful Turn containing a declined command.
Shell stdout/stderr extraction can use the newly observed Claude fields if scoped by that planning. Command duration is documented evidence with no existing consumer. No ADR amendment is needed to record these facts.

Refresh from a checkout of Secant with its dependencies installed. The sidecars invoke the committed probes under `timeout -k 10s`; both default to temporary output.
`SECANT_EVIDENCE_REPO` can select the source checkout and `SECANT_EVIDENCE_DIR` can select a new temporary capture root. Refresh requires installed, authenticated Harnesses and stays outside CI.
