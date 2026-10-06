# Message fact qualification

#411 and #412 consume message identity, streaming text and settlement only from the authentic recordings below.
Their existing `recording.json` files own recording time, version, redactions and refresh commands.
No fixture bytes changed. Synthetic scripts establish terminal races and ordering only.

Claude Code `plain/turn-1.stdout`, version 2.1.273, qualifies assistant `message.id`,
text blocks and text on the full `assistant` frame. `message-facts.test.ts` feeds
those unchanged frames through the native Adapter and asserts one identified message.
The full assistant frame settles the message independently of the Turn's final result copy.

Claude Code `interrupt/turn-1.stdout`, version 2.1.288, qualifies streaming
`event.type: message_start`, `event.message.id`, `parent_tool_use_id`, and
`text_delta` text. It contains the partial text `#`. The native-Adapter test retains
that text with `incomplete: true` when interrupted, before authoritative result settlement.
An unidentified synthetic preview stays absent from live history and the stored conversation.
The same qualified id accompanies every complete `message-preview` replacement.
A copied authentic stream followed by a synthetic successful result tests unfinished
text at a successful terminal boundary; it establishes a semantic race, not a new wire field.
`steer-within/steered.stdout`, also 2.1.288, contains matching streaming and full-message ids.
The synthetic `two-turns` recording supplies no native qualification.

Codex `two-turns/case.json`, codex-cli 0.160.0 and codex-probe-3, qualifies
`item/completed` with `item.type: agentMessage`, `item.id` and `item.text`.
`codex-adapter-conformance.ts` checks both authentic Turns, independent identities,
exact content and event-before-result ordering. `completion/case.json` qualifies
`item/agentMessage/delta.params.itemId`; the maintained producer-trace case verifies
preview/final replacement with the same completed-item identity. An identified
preview still pending at terminal retains only its known text as incomplete.
A second conformance case removes only the completed item from a copied authentic
completion recording. This synthetic omission proves delta identity and partial
retention without inventing wire shape or treating a Turn result as message completion.

Steer identity and delivery remain the existing caller-supplied opaque id and
qualified settlement contract. This slice consumes no additional native Steer field.
Missing identity does not fall back to a Turn coordinate, frame uuid, prose or counter.
Only known partial text carries `incomplete: true`. A migrated lost Turn never
retroactively marks an old transcript message incomplete.

## Thought qualification, 2026-10-06

`codex/thought-summary-configured` records codex-cli 0.160.1, codex-probe-4,
OpenAI provider `openai` and model `gpt-6.1-sol`. An isolated Codex home links the
existing login and configures `model_reasoning_summary = "concise"`; it sets no
reasoning effort. Production never sets this preference. The unchanged recording
qualifies `thread/read.thread.modelProvider` and `.model`, reasoning `item.id`,
`item/reasoning/summaryTextDelta` with `itemId`, `summaryIndex` and `delta`, and
`item/completed.item.summary` as the authoritative array of provider-written text.
The first summary contains `**Determining minimal three-digit number**`.
Summary-part notifications are ignored; their presence is not required to assemble
indexed deltas. Final text replaces the preview rather than appending to it.
[Codex App Server](https://learn.chatgpt.com/docs/app-server) distinguishes reasoning
summaries from raw reasoning content. The authentic recording establishes this
transport, provider and model pairing before extraction. Schema compatibility
checks now use codex-probe-5; the original captures retain their recorded revision.

`codex/thought-summary-unconfigured`, captured on the same installed version
through codex-probe-5, uses an isolated home with the same model and no summary
preference. Its reasoning summary is empty. `codex/thought-summary` records the
host's inherited configuration through codex-probe-4 and also has empty summaries.
Strict conformance asserts no summary, effort or model override on thread/Turn
requests in all three cases. The isolated homes do not change global settings.
Every directory's `recording.json` owns exact capture time and redactions.

The Adapter emits summaries only after `thread/read` qualifies the OpenAI provider
and `gpt-6.1-sol` model. Other providers, models and an unread effective identity
remain an explicit evidence gap and produce no Thought events. A reroute to an
unqualified model withdraws qualification. Existing observed text can still settle
incomplete; later unqualified content does not cross the Harness Seam.

Claude Code's recorded thinking, thinking deltas, signatures and
`thinking_duration_ms` do not establish provider-written user-facing summaries or
reasoning-duration attribution. They remain private. No native reasoning duration
is qualified for either Adapter. Neither delivery time nor whole-Turn time supplies
one. Synthetic semantic events test reported duration presentation, including zero,
without claiming native field qualification.

The native conformance cases replay the authentic recording through the Harness
Interface. Local copied-case omissions and replacements exercise unfinished text,
empty final clearing, unqualified provider/model absence, private payload exclusion
and late-preview suppression. They establish semantic races, not new wire fields.
Process-free Run and Projection tests cover all observed settlements, first position,
settle-only writes, mixed 200/201-row eviction and transcript exclusion. Renderer
Port tests cover collapse, expansion by Ctrl+O and mouse, modal routing and resize.
Real-terminal appearance/accessibility and real-Harness release evidence remain
separate human checks under ADR 0027.
