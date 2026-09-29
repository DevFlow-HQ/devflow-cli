# OpenCode Tool Output and Lifecycle

Research date: 2026-09-29. Decision context: Secant wayfinder #262, Q3 (live shell output) and Q4 (tool identity and lifecycle).

Source: the user-supplied sibling checkout `../opencode`, HEAD
[`b3f1a96c6dd7adeb28b36dd11add1998fc84d67b`](https://github.com/anomalyco/opencode/commit/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b).
`git status --short` was empty before and after inspection. No sibling files were changed. Root and relevant package/tool/test `AGENTS.md` files
were read. This is source inspection, not a running-terminal observation; referenced tests were read, not executed.

## Answer

**Source-observed:** OpenCode's existing TUI shows shell output during execution through replaceable, bounded **metadata snapshots** on an
identified tool part. The panel remains the same tool after completion; its spinner stops. Completion does not switch that terminal panel to
the full model-facing output. Failure retains the latest progress metadata. Tool identities and state changes are owned by its execution
runtime, then reconciled into the terminal store.[^shell-producer][^shell-view][^lifecycle][^sync]

**Inferred for Secant:** adopt the presentation pattern and the distinction between replaceable previews and final facts. Keep lifecycle
translation inside the Harness Adapter and the per-call view behind the Projection Port. OpenCode owns execution, permissions, process
termination, and settlement; Secant observes an external Harness. OpenCode's synthetic aborted-tool cleanup therefore does not establish that
Secant can declare an external tool interrupted when its transport disappears. Secant's ADR 0022 already requires independent transport drain,
coalescing only replaceable previews, and authoritative terminal results.[^secant]

## Q3: running and completed shell output

| Aspect               | Source-observed behavior                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before output        | The producer sets `metadata.output = ""` before spawning. The TUI tests whether that field exists, so an empty-output panel can appear before the first chunk. Before the field exists, it uses the inline `$ command` / `~ Writing command…` row.[^shell-producer][^shell-view]                                                                                                              |
| While running        | Every decoded chunk updates a cumulative preview snapshot. `preview()` retains the last 30,000 JavaScript string units, prefixed by an omission marker once trimmed. The TUI strips ANSI, trims whitespace, shows a command spinner only while status is `running`, and renders that preview.[^preview][^shell-producer][^shell-view]                                                         |
| Collapsed            | The panel shows the first 10 lines of the current preview with a width-dependent character budget `10 * max(20, width - 6)`. Clicking expands/collapses. This is a plain text panel, not a terminal emulator.[^shell-view][^collapse]                                                                                                                                                         |
| After completion     | The same metadata-backed panel remains, with `$ command` replacing the spinner. The shell result contains separate model-facing `output`, bounded by line/byte limits with a saved full-output path when truncated; metadata keeps its bounded preview, exit code, and truncation facts. The TUI shell renderer does not show exit code or read `props.output`.[^shell-producer][^shell-view] |
| Failed / interrupted | Generic tool failure preserves streamed metadata. A panel that already exists shows that preview and the error at its bottom. An inline failed row turns red and allows click-to-reveal error text.[^lifecycle][^tool-errors]                                                                                                                                                                 |

The exposed legacy shell tool id remains `bash`, even for other shell implementations, explicitly for compatibility.[^shell-id]
The web shell renderer differs: it allows opening while pending and reads `props.output || props.metadata.output`, so completion can reveal
the model-facing result instead of only the preview. That web rule is not the terminal rule.[^web]

### Capture, batching, and backpressure

**Source-observed:** the shell stream consumer awaits `ctx.metadata(...)` per decoded chunk. That context calls the processor's
`updateToolCall`, which reads and writes the identified part through the Session implementation. The producer retains a bounded chunk tail;
after the full-output byte threshold it starts an append file sink. Its `sink.write(chunk)` return value is ignored: the inspected loop has no
explicit wait for Node writable `drain`.[^shell-producer][^metadata][^lifecycle]

The TUI SDK queues events arriving within a 16 ms window and emits **all** queued events inside one Solid `batch`. This reduces rendering
work but does not deduplicate snapshots or impose a queue capacity. The terminal sync store replaces/reconciles a part by message id + part id;
text deltas use a separate append path.[^batch][^sync]

**Inferred:** the awaited metadata callback offers local producer pacing, but neither that nor rendering batches demonstrates end-to-end
backpressure from a slow terminal to the native subprocess. Snapshot length bounds retained display content, not total event volume or sink
buffering. For Secant, a cadence/latest-per-call preview path should be decided before routing stdout chunks into its durable event append path.
Terminal status and final output must survive preview replacement.

## Q4: identity, updates, and terminal meaning

**Source-observed:** a legacy tool part has a generated part id, message id, session id, native `callID`, tool name, and a four-variant state:
`pending`, `running`, `completed`, `error`. The processor maintains a map keyed by call id; input start creates one pending part, a call makes
it running, and success/failure updates that part. Permission presentation correlates pending requests using `callID`.[^identities][^lifecycle][^tool-errors]

| Observation                       | Runtime / display behavior                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Success                           | Only a currently running tool can settle completed; final output, metadata, and end time replace its running state.[^lifecycle]                                                                                                                                                                                                                                                                               |
| Failure                           | Error state stores the input, error string, end time, and latest metadata. Provider error results and `tool-error` use this same failure path.[^lifecycle]                                                                                                                                                                                                                                                    |
| Declined permission or question   | These are error settlements at the processor. The inline TUI detects denial from error-string substrings (`QuestionRejectedError`, `rejected permission`, `specified a rule`, `user dismissed`) and strikes the row through. This is presentation classification, not a typed declined lifecycle variant.[^lifecycle][^tool-errors]                                                                           |
| Interruption / unfinished cleanup | Cleanup waits up to 250 ms for each outstanding tool, then writes `error: "Tool execution aborted"` and `metadata.interrupted = true`, preserving previous metadata. There is no separate interrupted tool state. The shell itself can also return a result containing `User aborted the command`; that lower-level return is not independently proof of a failed tool settlement.[^cleanup][^shell-producer] |
| Lost                              | Neither inspected tool-state schema has a `lost` variant. Absence of a final result is not modeled as a successful tool. The legacy cleanup rule is owned by execution, not evidence about an externally disconnected Harness.[^identities][^current-schema][^cleanup]                                                                                                                                        |

**Inferred:** Secant can preserve native call correlation and observed states without granting the TUI a new execution-control Interface.
Scope correlation by Turn/session/message where necessary; a native string call id is not shown here to be globally unique. A lost Turn should
leave unresolved tool completion explicitly unknown unless the Adapter has native terminal evidence. Do not translate Turn loss into tool
success, failure, or confirmed interruption merely to produce a tidy row.[^secant]

## Current Core migration: evidence limit

This snapshot contains both the existing compatibility TUI/runtime and newer Core contracts. The newer tool Context contains session,
assistant-message, agent, and tool-call identities but no progress callback. Its Bash implementation uses `AppProcess.run`, a 1 MiB capture
limit, and explicitly keeps a TODO to wire live progress. The Core process collector consumes output while bounding retained bytes; it does
not provide live shell preview events to that Bash caller.[^current-bash][^current-context][^current-process]

The newer event contract does define durable `Tool.Progress` snapshots, with an explicit comment to checkpoint semantic changes or bounded
cadence **rather than persist every stdout/stderr chunk**. Its projector replaces running structured/content progress, replaces it on success,
and preserves it on failure. Its runner marks pending/running tools failed with `Tool execution interrupted` when interrupted. These are
useful owned-lifecycle examples, not evidence that the new Bash implementation already streams shell output.[^current-progress][^current-update][^current-interrupt]

## Test evidence and complexity placement

Read tests cover progressive metadata updates, preserving output on shell abort, truncation with full-output retention, processor cleanup
marking pending tools aborted, and durable Core progress retained on failure.[^tests][^cleanup-test][^current-progress-test]
No inspected test establishes slow-consumer boundedness, writable-sink backpressure, or a rendered live-shell frame across interruption.

**Inferred Module assessment:** the substantial complexity is lifecycle and evidence ownership, not drawing the shell box. OpenCode localizes
execution/capture in the shell implementation, settlement in the Session processor, and rendering/reconciliation in the TUI. For Secant the
deep Module is the Harness Adapter: native ids, status translation, output replacement, transport draining, and uncertainty belong behind its
small Interface. The application Projection Module should own bounded per-call view reconciliation; the TUI should receive those facts and
own collapse/expand only. Passing provider-specific metadata and denial-string matching into Secant's TUI would make that Interface shallow
and redistribute correctness into callers. This is a design assessment, not an implementation proposal or completed dependency audit.

[^shell-producer]: OpenCode [`tool/shell.ts` lines 435–594](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/tool/shell.ts#L435-L594).

[^preview]: OpenCode [`tool/shell.ts` lines 220–223](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/tool/shell.ts#L220-L223), with limit at line 27.

[^shell-view]: OpenCode [`routes/session/index.tsx` lines 2046–2103](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/tui/src/routes/session/index.tsx#L2046-L2103).

[^collapse]: OpenCode [`collapse-tool-output.ts` lines 1–19](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/tui/src/util/collapse-tool-output.ts#L1-L19).

[^shell-id]: OpenCode [`shell/id.ts` lines 14–17](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/tool/shell/id.ts#L14-L17).

[^web]: OpenCode [`message-part.tsx` lines 2085–2125](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/session-ui/src/components/message-part.tsx#L2085-L2125).

[^metadata]: OpenCode [`session/tools.ts` lines 59–86](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/session/tools.ts#L59-L86).

[^batch]: OpenCode [`context/sdk.tsx` lines 48–80](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/tui/src/context/sdk.tsx#L48-L80).

[^sync]: OpenCode [`context/sync.tsx` lines 376–414](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/tui/src/context/sync.tsx#L376-L414).

[^identities]: OpenCode [`v1/session.ts` lines 259–324](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/schema/src/v1/session.ts#L259-L324).

[^lifecycle]: OpenCode [`session/processor.ts` lines 123–250](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/session/processor.ts#L123-L250), [call/result/error lines 331–418](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/session/processor.ts#L331-L418).

[^tool-errors]: OpenCode [`routes/session/index.tsx` lines 1856–1906](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/tui/src/routes/session/index.tsx#L1856-L1906), [block error lines 1994–2041](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/tui/src/routes/session/index.tsx#L1994-L2041).

[^cleanup]: OpenCode [`session/processor.ts` lines 585–608](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/session/processor.ts#L585-L608).

[^current-schema]: OpenCode [`session-message.ts` lines 81–139](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/schema/src/session-message.ts#L81-L139).

[^current-bash]: OpenCode [`core/tool/bash.ts` lines 19–81](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/core/src/tool/bash.ts#L19-L81), [execution lines 160–210](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/core/src/tool/bash.ts#L160-L210).

[^current-context]: OpenCode [`core/tool/tool.ts` lines 10–15](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/core/src/tool/tool.ts#L10-L15).

[^current-process]: OpenCode [`core/process.ts` lines 121–160](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/core/src/process.ts#L121-L160).

[^current-progress]: OpenCode [`session-event.ts` lines 273–372](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/schema/src/session-event.ts#L273-L372).

[^current-update]: OpenCode [`message-updater.ts` lines 250–342](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/core/src/session/message-updater.ts#L250-L342).

[^current-interrupt]: OpenCode [`runner/llm.ts` lines 119–150](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/core/src/session/runner/llm.ts#L119-L150).

[^tests]: OpenCode [`shell.test.ts` lines 1009–1041](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/test/tool/shell.test.ts#L1009-L1041), [lines 1108–1162](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/test/tool/shell.test.ts#L1108-L1162).

[^cleanup-test]: OpenCode [`processor-effect.test.ts` lines 873–938](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/test/session/processor-effect.test.ts#L873-L938).

[^current-progress-test]: OpenCode [`session-tool-progress.test.ts` lines 29–160](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/core/test/session-tool-progress.test.ts#L29-L160).

[^secant]: Secant [ADR 0022](https://github.com/secantdev/secant/blob/199212652826a33b9f3b98969eaed6423647f0da/docs/adr/0022-own-a-truthful-deep-harness-seam.md), authoritative Turn results and event-drain paragraphs. Domain distinction also follows [`CONTEXT.md`](https://github.com/secantdev/secant/blob/199212652826a33b9f3b98969eaed6423647f0da/CONTEXT.md).
