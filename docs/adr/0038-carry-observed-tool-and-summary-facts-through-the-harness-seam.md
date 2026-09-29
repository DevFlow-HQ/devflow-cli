# Carry observed tool and summary facts through the Harness Seam

The Run Workbench needs one tool row that changes in place, command output, file diffs, and collapsed reasoning summaries. The existing Harness
Interface discards native call identity and flattens useful fields into summary strings. [Decide the Harness Seam's tool, command, diff, and
reasoning-summary events](https://github.com/secantdev/secant/issues/262) resolves the semantic contract: the Harness Adapter carries observed,
normalized facts, and the Projection Module owns their reconciliation for clients. Secant shows what the Harness supplies; it does not manufacture
missing evidence or change the user's Harness settings to make an optional display feature available.

**Tool identity and lifecycle.** Every observed tool call has one stable opaque identity within its Turn. Both Adapters privately translate native
identities; repeated or concurrent calls never pair by name, summary, or adjacency. An observed parent-call relationship uses the same identity
vocabulary. Start, updates, and result refer to the same call. The Interface carries running, completed, failed, and declined outcomes with useful
error or refusal text where reported. Failure belongs to the tool and does not itself decide the Turn or Run outcome. A Harness Request remains a
separate interaction, and an Agent call retains ADR 0033's separate declaration and disposition.

An authoritative Turn settlement stops live indicators. A tool with no terminal result remains unconfirmed: Turn success cannot prove tool success,
and Turn interruption or loss cannot prove the tool failed or stopped. Clients can show the missing result in the context of the settled Turn
without a synthetic tool completion or a second cancellation controller. This matters because Secant observes an external Harness; OpenCode owns
its tools and can settle its own aborted executions, while T3 Code's Claude Adapter synthesizes outcomes for unmatched calls.

**Typed facts.** The normalized kinds are read, search, command, file change, web, MCP tool, subagent, and other. They carry their meaningful main
input, with an optional reported result count and its unit, such as lines, matches, or files. Unknown counts remain absent, not zero. A command
remains a command unless native evidence supports a more specific classification. Other preserves meaningful unfamiliar work without exposing raw
protocol frames. Native names, arguments, results, and errors are translated behind the Harness Interface; clients do not parse tool-summary prose
or infer a kind from arbitrary command text. Exact type and event names remain implementation choices.

**Command output.** Command text, working directory when observed, output, and an observed exit code are separate facts. When the native transport
supplies output during execution, it updates a replaceable preview for the same call. If only completed output is supplied, it appears on completion.
Final native output reconciles with the preview without duplication. A Harness-supplied omission or truncation is preserved as evidence; it is not
confused with the Workbench's collapsed display. Missing output and exit codes remain unknown. No polling, process inspection, or Harness-setting
override is introduced to obtain live output.

Live and completed shell panels remain bounded by default: ADR 0036's ten-line collapse applies while running as well as after completion, text fits
the available width, and expansion is an explicit human action. Streaming never automatically expands a panel or consumes the screen. Preserve the
available output for expansion or inspection; a short summary alone does not replace the supplied output. Preview updates are coalescible, while
terminal facts are not. The Projection decision fixes retained preview budgets, interrupted partial-output retention, final reconciliation, durable
publication, and headless exposure before implementation; routing each output chunk through today's durable tool-event append is excluded.

**File changes.** Preserve observed paths, change kinds, and supplied patches as data. A per-call patch belongs to that call. A cumulative Turn diff
remains Turn-scoped when the Harness supplies no call association. If only changed paths are reported, those are displayed without a manufactured
patch. Requested edit input is not evidence that the edit happened. Secant does not run Git, scan the Workspace, or reconstruct changes to fill a
missing Harness diff. ADR 0036's rule that supplied diffs are not cut still applies.

**Reasoning summaries.** Inherit the Harness's existing summary behavior, including its defaults when no preference is configured. Secant does not
enable summaries, change effort or thinking mode, or rewrite global settings for Thought rows. A supplied provider-written Reasoning summary gains
opaque identity and streaming/completion facts so its text settles in one row without appending the final snapshot to its own deltas. Its first
nonempty line supplies a shortened collapsed label; expansion reveals the complete body. While a summary streams the row shows Thinking and a
spinner. Duration appears only when the Harness reports a trustworthy reasoning duration; summary-delivery timing is not substituted. Missing,
empty, or unsupported summaries produce no Thought body. Raw reasoning, signatures, and encrypted or redacted payloads stay private under ADR 0022.
Recognizing a summary must be grounded in the qualified transport/model/provider semantics, not an arbitrary historical thinking field.

**Context and noise.** Carry only reported context and usage facts, keeping their meanings distinct. Input/output usage, cached-token counters,
cumulative usage, a model's reported window capacity, and an explicitly reported context measurement are not interchangeable. Secant never tokenizes,
adds counters into context occupancy, calculates a percentage, guesses a model limit, or repairs inconsistent Harness figures. A percentage is shown
only if reported by the Harness. Unavailable fields stay absent. Both Adapters consume the relevant native observations without implying that both
can populate every context field. Usage and account/rate observations remain separate from conversation activity; a genuine failure or pause uses
its appropriate semantic failure or request rather than a protocol-name row. Unknown methods, telemetry, and raw reasoning do not become generic
activity; meaningful known work, including an unfamiliar tool represented as other, is preserved.

**Ownership and qualification.** Native schemas, classification, call correlation, and source-specific output assembly stay behind the Harness
Interface. The application Projection Module owns bounded per-call reconciliation, preview replacement, and Turn-derived liveness through the
existing Projection Port; presentation owns wrapping, collapse, expansion, and colour. No new public Module, raw-provider escape hatch, or execution
control is introduced. The Interface is the test surface: both Adapters and the fake exercise interleaved identities, reported failure/refusal,
preview/final reconciliation, unknown tool outcomes, and terminal ordering; native fixtures qualify the fields actually consumed. Recorded Codex
evidence establishes command output and exit codes. Current recorded Claude shell cases do not establish its structured exit-code shape; that field
must be qualified before extraction, with absence represented honestly.

This narrows ADR 0022's permission to calculate context into a reported-facts-only policy, and clarifies ADR 0036's Thought duration, bounded shell
panels, and context requirement. It leaves [Decide how a Turn's history grows mid-Turn in the Run Projection and headless
--json](https://github.com/secantdev/secant/issues/263) to settle persistence, live history, resource retention, and the frozen client contracts.
Implementation still follows the milestone loop.

The [OpenCode investigation](../research/opencode-tool-output-lifecycle.md) establishes live bounded shell previews and owned tool cleanup in its
existing TUI; its newer Core Bash progress remains unfinished. The [T3 Code investigation](../research/t3code-tool-output-lifecycle.md) establishes
completed output summaries, stable call collapse, and the cost of fabricated unmatched outcomes. These are source and existing-test inspections,
not live qualification runs. Completed-only output was considered; optional native live output earns its incremental complexity by sharing the
already-required identified row and replaceable-preview mechanism. Automatic summary opt-in, calculated context, provider-specific client reducers,
and synthetic tool completion were rejected because they change configuration or redistribute interpretation and invented truth into callers.
