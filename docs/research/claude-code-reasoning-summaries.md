# Claude Code reasoning summaries over direct stream-json

Research date: 2026-09-29. Resolves [Establish whether Claude Code's direct stream-json transport emits reasoning summaries, and under which setting](https://github.com/secantdev/secant/issues/261).
This is transport evidence, not a design for the Harness Seam.

## Finding

**Yes.** Direct `claude -p --input-format stream-json --output-format stream-json` can return provider-written reasoning summaries. On the installed
Claude Code **2.1.283**, an isolated run with **`claude-sonnet-4-6`** and **`--settings` containing `showThinkingSummaries: true`** returned readable
`thinking_delta` chunks and an `assistant` frame containing the completed `thinking` block. A second run with the setting `false` returned empty
thinking plus an opaque signature. A third run established that the hidden **`--thinking-display summarized`** flag overrides the false setting.
These are direct CLI observations, not conclusions transferred from the Agent SDK. [Evidence: recorded runs](#recorded-runs).

The distinction matters for today's Secant launch: it already passes `--verbose --include-partial-messages`, but does not select thinking display.
The probe with no display override produced no readable summary. User settings, model, provider, and CLI version therefore matter; transport support
does not mean every existing launch supplies a summary. Secant currently discards thinking content. [Sources: [launch](https://github.com/secantdev/secant/blob/ea926ced2065395bc89640480fb9f37d8df1da41/src/harness/claude-code.ts#L755-L785),
[frame parsing](https://github.com/secantdev/secant/blob/ea926ced2065395bc89640480fb9f37d8df1da41/src/harness/claude-code/frames.ts), [recorded runs](#recorded-runs)].

The normal summarized mode supplies a body, **no separate title or thinking duration**. Neither Claude's observed blocks nor Codex's reasoning item
schema supplies a title field. A title-looking Markdown heading inside text remains text. Claude's internal `highlights` mode is a separate case,
described below; it is not the normal summary body plus a title. [Sources: [recorded frames](#claude-frame-shapes), [Codex comparison](#codex-app-server-comparison)].

## Controls and their limits

| Control                                                        | Established behavior                                                                                                                                                                                   | Authority                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `--settings <file-or-json>` with `showThinkingSummaries: true` | Documented setting for receiving summaries; directly observed to produce readable thinking on Sonnet 4.6. Controls API-side behavior, not just terminal expansion.                                     | [Model configuration](https://code.claude.com/docs/en/model-config#extended-thinking), installed settings schema and runs |
| `showThinkingSummaries: false`                                 | Directly observed to suppress the reasoning summary body while leaving thinking active. In this build the request metadata said `updates`, not `omitted`; short tool-progress updates remain possible. | Installed request-construction code and runs                                                                              |
| Hidden `--thinking-display summarized`                         | Accepted by 2.1.283; readable summary observed even over `showThinkingSummaries: false`. The frame metadata explicitly reported `summarized`.                                                          | Installed option registration and run                                                                                     |
| Hidden `--thinking-display omitted`                            | Accepted display choice in the installed parser. Explicit display takes priority over the setting; its request path bypasses the default progress-update selection. Not live-probed separately.        | Installed option registration and request-construction code                                                               |
| `--include-partial-messages`                                   | Adds partial `stream_event` messages. Removing it still returned complete `assistant` thinking blocks, without any `stream_event` frames.                                                              | [Headless streaming](https://code.claude.com/docs/en/headless#stream-responses), runs                                     |
| `--verbose`                                                    | Required with this CLI stream-json output. It is not itself a summary opt-in.                                                                                                                          | Installed help and successful launch arguments                                                                            |
| `alwaysThinkingEnabled: false`, `MAX_THINKING_TOKENS=0`        | Turn model thinking off where supported, rather than merely hiding the summary. The environment variable was directly observed to remove thinking blocks on Sonnet 4.6 even with summaries requested.  | [Model configuration](https://code.claude.com/docs/en/model-config#extended-thinking), installed code, run                |
| Hidden `--thinking disabled`                                   | Installed parser also accepts `enabled` and `adaptive`. This controls thinking, separately from display. Not separately live-probed.                                                                   | Installed option registration                                                                                             |
| `--effort`                                                     | Controls effort, not whether summaries are returned. Adaptive models can skip thinking on a simple request.                                                                                            | [Model configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level)                                   |

`--settings` applies above user, project, and local settings but below managed settings. Thus a per-launch setting is supported, although organization
policy can override it. This research changes no settings files belonging to the user. [Source: [session settings and precedence](https://code.claude.com/docs/en/settings#change-a-setting-for-one-session)].

**Provider/model qualification.** Current CLI documentation says thinking cannot be disabled on Opus 5.5, Sonnet 5.5, or Fable models; the off controls
above are not universal. On third-party providers `MAX_THINKING_TOKENS=0` omits the thinking parameter and adaptive models may still think.
The SDK documentation also says its `display` override is not sent to Bedrock or Google Cloud's Agent Platform. Those routes were not probed.
[Sources: [model configuration](https://code.claude.com/docs/en/model-config#extended-thinking), [SDK ThinkingConfig](https://code.claude.com/docs/en/agent-sdk/typescript#thinkingconfig)].

**Hidden versus documented.** `--thinking` and `--thinking-display` exist in 2.1.283's option registration with `hideHelp()`. Their absence from
`claude --help` is not evidence that they do not work. The setting is documented; the flags are version-specific installed-source evidence and carry
no claim of a documented stable CLI contract. The package transport converts SDK `thinking.display` into this same `--thinking-display` argument.
`showThoughts` was not present in the installed binary and is not the documented settings key. [Evidence: [installed distribution inspection](#installed-distribution-inspection)].

**Default and environment nuance.** Installed code reads `showThinkingSummaries` with a false default. In the observed first-party route, unset or
false selected API display `updates`, which suppresses reasoning bodies while permitting short progress text between tools. The internal
`CLAUDE_CODE_THINKING_DISPLAY_UPDATES` switch selects that progress-update path; it is not a summary on/off variable. No documented dedicated
summary environment variable was established. Prefer the documented setting or explicitly qualify the hidden flag. The public API documents
`updates` with beta header `thinking-display-updates-2026-08-18`: reasoning stays empty while readable progress updates may appear between tools.
[Sources: [thinking display](https://platform.claude.com/docs/en/build-with-claude/thinking#controlling-thinking-display); installed
`mun`, `QEt`, `zbo`, and request construction; [default/false runs](#recorded-runs)].

## Claude frame shapes

These are **sanitized projections of observed JSONL**, not invented API-to-CLI wrappers. Session ids, UUIDs, message ids, signatures, and summary
text are replaced; unrelated message metadata is omitted. The visible summary is deliberately not reproduced.

With explicit `--thinking-display summarized`:

```json
{"type":"stream_event","event":{"type":"message_start","message":{"id":"<message>","model":"claude-sonnet-4-6","type":"message","role":"assistant","content":[]}},"session_id":"<session>","parent_tool_use_id":null,"uuid":"<uuid>","ttft_ms":1151,"thinking_display":"summarized"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}},"session_id":"<session>","parent_tool_use_id":null,"uuid":"<uuid>","thinking_display":"summarized"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"<summary chunk>","estimated_tokens":null}},"session_id":"<session>","parent_tool_use_id":null,"uuid":"<uuid>","thinking_display":"summarized"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"<opaque>"}},"session_id":"<session>","parent_tool_use_id":null,"uuid":"<uuid>"}
{"type":"assistant","message":{"id":"<message>","model":"claude-sonnet-4-6","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"<complete summary>","signature":"<opaque>"}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"<session>","uuid":"<uuid>","timestamp":"2026-09-29T12:25:58.921Z","request_id":"<request>"}
{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"<session>","parent_tool_use_id":null,"uuid":"<uuid>"}
```

The observed complete thinking `assistant` frame arrived **before** its forwarded `content_block_stop`; its `stop_reason` was still null. A second
`assistant` frame with the **same native message id**, containing only a text block, arrived later. Thus an `assistant` frame does not necessarily
contain the entire native response or end the Turn. The final `result` carried `subtype: "success"`, `is_error: false`, and the final answer in
`result`, not a separate summary field. Do not append the completed thinking body to its deltas and duplicate it. [Evidence: runs].

With `showThinkingSummaries: false`, the analogous start/delta metadata reported `thinking_display: "updates"`; the observed thinking delta was:

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "thinking_delta",
      "thinking": "",
      "estimated_tokens": 50
    }
  },
  "session_id": "<session>",
  "parent_tool_use_id": null,
  "uuid": "<uuid>",
  "thinking_display": "updates"
}
```

The completed block was `{ "type": "thinking", "thinking": "", "signature": "<opaque>" }`. Empty thinking deltas and
`system` / `thinking_tokens` estimates still appeared. They are progress, not a readable summary. A missing `thinking_display` field is not proof
of any display mode: it was absent in the successful setting-true run. Installed schema explicitly makes it optional and says it records the
request body Claude Code sent, not what a gateway ultimately received. [Evidence: runs and installed `SDKPartialAssistantMessage` schema].

## Summary, raw thinking, redaction, and encryption

For current Claude models, `display: "summarized"` returns provider summaries; `omitted` leaves `thinking` empty and retains its signature.
Recent models default to omitted at the API, while Sonnet 4.6 and Opus 4.6 default to summarized. Adaptive thinking can produce no block.
Summaries stream, but signatures are opaque encrypted full thinking and cannot supply display text. Safety-redacted `redacted_thinking` blocks
carry opaque `data`, distinct from an empty ordinary thinking block. Neither encrypted field is a summary. [Source:
[Claude thinking overview](https://platform.claude.com/docs/en/build-with-claude/thinking#reading-thinking-output)].

Do not classify an arbitrary historical `thinking_delta` as a safe summary solely by its type. Anthropic introduced summarized thinking for
Claude 4 on May 22, 2025; Sonnet 3.7 previously exposed extended thinking step by step and is now retired. The live evidence here is explicitly
Sonnet 4.6, not Sonnet 3.7, a custom model alias, or a provider gateway with unknown behavior. This qualifies T3 Code's broad comment that Claude
never returns raw chain of thought. [Source: [Anthropic release notes](https://platform.claude.com/docs/en/release-notes/overview#may-22-2025)].

### Internal title mode

Installed 2.1.283 also accepts hidden `--thinking-display highlights`. Its embedded control schema describes one short title per stretch of
thinking rather than a prose summary. It restricts this to Anthropic-hosted Claude Code sessions; an API rejection makes the session fall back to
omitted, and third-party providers, disabled experimental betas, and some older models prevent it. This is installed internal protocol evidence,
not a portable promise that Claude provides both a title and body. The normal `summarized` runs had only `type`, `thinking`, and `signature` in
their thinking blocks. [Evidence: installed `set_max_thinking_tokens` schema and option registration].

The direct highlights probe completed successfully but emitted no title text: it reported `thinking_display: "omitted"`, empty thinking, and a
signature. That is consistent with the installed fallback path, but the run did not expose the upstream rejection cause. Availability of title
mode was therefore **not demonstrated** for this account/model; it cannot be used as evidence of a dependable provider-supplied title.
[Evidence: highlights-flag run].

## Codex app-server comparison

Official OpenAI documentation separates `item/reasoning/summaryTextDelta` from raw `item/reasoning/textDelta`. `summaryPartAdded` marks summary
boundaries; `summaryIndex` identifies the section. A final reasoning item has `id`, `summary`, and `content`, with summaries and raw blocks kept
separate. `item/completed` is the authoritative final item. [Source: [Codex App Server items](https://learn.chatgpt.com/docs/app-server#items)].

The installed **codex-cli 0.155.0** generated these shapes with `codex app-server generate-ts --out <temporary-directory>`; no model Turn was
run. These are schema examples, not captured live Codex notifications:

```json
{"method":"item/reasoning/summaryPartAdded","params":{"threadId":"<thread>","turnId":"<turn>","itemId":"<item>","summaryIndex":0}}
{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"<thread>","turnId":"<turn>","itemId":"<item>","summaryIndex":0,"delta":"<summary chunk>"}}
{"method":"item/reasoning/textDelta","params":{"threadId":"<thread>","turnId":"<turn>","itemId":"<item>","contentIndex":0,"delta":"<private raw chunk>"}}
{"method":"item/completed","params":{"threadId":"<thread>","turnId":"<turn>","item":{"type":"reasoning","id":"<item>","summary":["<complete summary>"],"content":[]}}}
```

`summary` and `content` are arrays of strings; there is no structured title or duration. `TurnStartParams.summary` accepts
`auto | concise | detailed | none`, overriding summary configuration for this and subsequent Turns. The documented
`model_reasoning_summary` configuration uses the same values; `model_supports_reasoning_summaries` controls sending reasoning metadata.
These controls do not establish that every model produces a summary. [Sources: installed generated `ReasoningSummary*Notification.ts`,
`ReasoningTextDeltaNotification.ts`, `ThreadItem.ts`, `TurnStartParams.ts`, `ReasoningSummary.ts`;
[OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#model_reasoning_summary)].

| Fact                   | Claude direct CLI, observed                                                             | Codex app-server, documented/generated                    |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Readable summary       | `thinking_delta.thinking`, completed `thinking.thinking`                                | `summaryTextDelta.delta`, final `reasoning.summary[]`     |
| Correlation            | Native message id at `message_start`; block `index`; wrapper session and parent tool id | `threadId`, `turnId`, `itemId`, `summaryIndex`            |
| Completed content      | Per-block `assistant` messages can precede native message completion                    | `item/completed` contains final item                      |
| Raw/encrypted material | Opaque `signature`; possible `redacted_thinking.data`                                   | Raw `textDelta` and final `content[]` explicitly separate |
| Title/duration         | Absent in normal summary blocks                                                         | Absent in reasoning schema                                |

Under [ADR 0036](../adr/0036-the-run-workbench-mirrors-the-agent.md) and [ADR 0022](../adr/0022-own-a-truthful-deep-harness-seam.md), provider
summaries may cross the Harness Seam, while raw reasoning remains private. The table establishes the upstream distinction; deciding the Secant
event, title fallback, timing, persistence, and launch policy belongs to the next decision ticket.

## Recorded runs

All runs used a new temporary working directory, no tools, no MCP servers, a fixed system prompt, `--safe-mode`, empty setting sources, and
`--no-session-persistence`. They used the existing CLI authentication; `--bare` was not used because it changes subscription authentication.
The prompt was a small ordering puzzle with no repository content. It requested final orders only, not disclosure of internal reasoning.
Each row was a fresh process. All completed with exit code 0, `result/success`, and empty stderr.

Common arguments:

```text
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --no-session-persistence --safe-mode --tools ""
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources ""
  --settings <temporary-settings-file> --model claude-sonnet-4-6 --effort high
  --system-prompt "You are a helpful assistant. Solve the supplied puzzle. Do not use tools."
```

Exact synthetic input frame, followed by a newline and stdin EOF:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "Without tools, solve this constraint puzzle carefully: A, B, C, D, E are ordered left to right. A is before C; B is immediately after D; E is neither first nor last; C is last; D is before E. Find all orders. Give only the orders as the final answer."
  }
}
```

| Run             | Variation                                           | Thinking deltas       | Complete readable thinking length | Display metadata | Wall time |
| --------------- | --------------------------------------------------- | --------------------- | --------------------------------- | ---------------- | --------- |
| summary-setting | `showThinkingSummaries: true`                       | 124                   | 1,494 characters                  | absent           | 22,354 ms |
| omitted-setting | `showThinkingSummaries: false`                      | 12, all empty         | 0                                 | `updates`        | 21,866 ms |
| summary-flag    | False setting plus `--thinking-display summarized`  | 115                   | 1,298 characters                  | `summarized`     | 19,040 ms |
| default-display | Empty settings                                      | 9, all empty          | 0                                 | `updates`        | 18,915 ms |
| completed-only  | True setting, remove `--include-partial-messages`   | 0; no stream events   | 1,444 characters                  | absent           | 21,871 ms |
| disabled-env    | True setting plus `MAX_THINKING_TOKENS=0`           | 0; no thinking blocks | 0                                 | absent           | 13,325 ms |
| highlights-flag | Empty settings plus `--thinking-display highlights` | 13, all empty         | 0; no title                       | `omitted`        | 22,830 ms |

Probe JSONL and stderr stayed under `%TEMP%/secant-261-LqhHHz`; generated Codex bindings stayed under `%TEMP%/secant-261-codex-schema`.
They are local, ephemeral evidence, not linked repository fixtures or prerequisites for the next ticket. The sanitized observations above are
the durable record. No raw thinking, summary body, encrypted signature, credential, or private user content is published here.

### Installed distribution inspection

The executable resolved from the WinGet link to `Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe`.
`claude --version` returned `2.1.283 (Claude Code)`. Embedded build metadata gave `BUILD_TIME: 2026-09-25T00:44:42Z` and
`GIT_SHA: 4631ccd7cfe41e69bc72d3b5b9dc7282536e4985`. SHA-256 of the inspected binary:
`9dbe16dafed59da5cdabbfe11ad0335738c753fad794989b47f9446accd6de3a`.

Read-only inspection decoded the bundled JavaScript from the executable; it did not modify or decompile user data. Reproducible search needles:

- `showThinkingSummaries`: settings schema; `mun` reads the setting with false fallback; `O0o` gives flag priority over settings.
- `--thinking-display <display>` and `u$e`: hidden option registration and choices `summarized`, `omitted`, `highlights`.
- `FNr` / `$Nr`: output-mode default handling; plain text and non-verbose JSON select omitted.
- `QEt`, `zbo`, and `display:"updates"`: summary/progress selection and the first-party API request rewrite.
- `thinking_display`: optional partial-frame metadata and `set_max_thinking_tokens` control schema, including the internal highlights restriction.
- `MAX_THINKING_TOKENS` / `BNr`: thinking-off environment and settings selection.

This installed first-party distribution and the recorded runs are primary evidence for hidden behavior. Current public documentation is mutable
and was fetched on the research date, first through Context7 and then directly from Anthropic and official OpenAI documentation.

## Evidence limits

Only Sonnet 4.6 on the observed first-party route was exercised; the result metadata reported `provider: "firstParty"`. No claim is made that
all Claude models, custom gateways, Bedrock, Agent Platform, Foundry, or future CLI builds behave identically. Hidden controls and metadata should
remain version-qualified. Safety-redacted thinking was documented, not triggered. Codex comparison is protocol/documentation evidence and locally
generated 0.155.0 schema, not a live reasoning-summary run. Research does not add dependencies, alter adapters, change policy, or adopt the SDK.
