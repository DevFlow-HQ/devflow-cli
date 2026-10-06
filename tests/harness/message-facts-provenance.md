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
