# Derive Claude JSONL Turn Completion From The `end_turn` Stop Reason

Claude's native transcript JSONL has no atomic turn-completion record like Codex's
`task_complete`/`last_agent_message`; it writes one record per content block, and all
records of a single API message share a `message.id` and `stop_reason`. The Claude JSONL
adapter therefore synthesizes `turn-completed` **only** when it observes a main-session
assistant message whose `stop_reason` is `end_turn`, assembling
`turn-completed.assistantMessage` from the `text` blocks across all records sharing that
`message.id`; `tool_use` is mid-turn and emits nothing.

## Considered Options

- **Strict (chosen): only `end_turn` completes a turn.** `stop_sequence`/`max_tokens`
  throw a descriptive `ProviderSessionEventCaptureError`; `null` is left to fall through to
  the existing incomplete-session / first-event-timeout path (it is not reliably terminal —
  it also appears on interrupted mid-message blocks, so erroring on sight would misfire).
- **Lenient: any non-`tool_use` stop reason completes a turn.** Rejected — it would let
  truncated (`max_tokens`) or abnormally-stopped turns masquerade as clean completions and
  be scanned for the completion marker.

## Consequences

- Reassembly relies on Claude flushing a message's per-block records together (observed:
  all records of a turn-ending message carry a uniform `stop_reason`, and the final block
  is always `text`). The normalizer groups by `message.id` rather than emitting per record,
  so a late sibling block cannot yield an empty/partial `assistantMessage`.
- Records with `isSidechain: true` (sub-agent / `Task` tool) are dropped entirely, so a
  sub-agent's own `end_turn` cannot prematurely complete the main turn.
