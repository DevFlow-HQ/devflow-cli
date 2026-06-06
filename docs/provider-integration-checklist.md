# Provider Integration Checklist

Use this as a non-trivial capability checklist for adding a provider as a real DevFlow adapter. Do not count ordinary coding-CLI behavior here: launching a process, accepting prompts, editing files, using a working directory, supporting Ctrl-C, or taking a model argument are baseline assumptions.

## Integration Tiers

- [ ] **PTY fallback:** provider can be driven in a terminal, but DevFlow only observes terminal text. Useful for experimental support, not a strong architecture fit.
- [ ] **First-class structured provider:** provider has scoped state plus a structured event source that exposes turn boundaries and final assistant messages.
- [ ] **Recoverable provider:** first-class structured provider plus reliable provider session ids and resume.

## Must-Have For First-Class Support

- [ ] **Scoped provider home/config:** DevFlow can force provider state into a run-scoped directory through an env var, CLI flag, or project-local config. Examples: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`.
- [ ] **No global config mutation:** hooks, logs, transcripts, settings, and generated scripts can be installed under DevFlow-owned paths without changing global user settings.
- [ ] **Structured data plane:** provider exposes hooks, JSONL/log records, or API events independent of styled terminal output.
- [ ] **Turn-final assistant content:** the structured source exposes the final assistant message for each completed turn.
- [ ] **Turn boundary:** the structured source clearly says when an assistant turn is complete.
- [ ] **Submitted-message boundary:** the structured source exposes user-message submission events or equivalent records.
- [ ] **Completion marker visibility:** DevFlow completion markers appear intact in the structured turn-final assistant message.
- [ ] **Origin classification:** the adapter can distinguish DevFlow-managed prompts from human replies, or can deterministically mark unknown origins without polluting the grill transcript.
- [ ] **Metadata-only diagnostics:** the integration can be debugged using event type, source, phase id, origin, message length, paths, offsets, ids, and process status without logging prompt bodies, assistant bodies, hook payload bodies, JSONL bodies, terminal transcript text, or credentials.

## Hooks Capability

Check these when the provider's primary structured source is hooks.

- [ ] Hooks can be configured per run, per project, or per scoped provider home.
- [ ] Hook config can point to DevFlow-owned scripts or sockets.
- [ ] Hook payloads are structured JSON or another stable structured format.
- [ ] Hook payloads include assistant turn completion and final assistant message content.
- [ ] Hook payloads include submitted-user-message information or enough metadata to classify origin.
- [ ] Hook setup and cleanup do not require editing committed project files or global user config.
- [ ] Malformed hook payloads can fail event capture without losing control of the provider process.

## JSONL Or Log Capability

Check these when the provider's structured source is JSONL/log tailing.

- [ ] Session logs are append-only or otherwise tail-safe.
- [ ] Records have a stable parseable schema.
- [ ] Logs live under scoped provider home or another deterministic provider-owned root.
- [ ] DevFlow can locate the active session log without relying on hook payloads.
- [ ] Fresh sessions support snapshot-before-launch discovery or an equivalent race-free locator.
- [ ] Resume sessions can be located by provider session id.
- [ ] The log source has offsets, monotonic record ids, timestamps, or another way to suppress stale pre-resume records.
- [ ] Assistant completion records can be distinguished from tool, sidechain, meta, compact, queue, or attachment records.
- [ ] Stop reasons or completion fields are explicit enough to avoid false `turn-completed` events.

## Resume And Recovery Capability

Check these before claiming provider-session recovery.

- [ ] Provider emits a stable native session id.
- [ ] Session id remains valid after process interruption or terminal exit.
- [ ] Provider has a native resume command/API that accepts that session id.
- [ ] Resume accepts a new DevFlow prompt after restoring context.
- [ ] The structured data plane reconnects to the resumed session by session id.
- [ ] Resume log/event capture starts after the old transcript/log offset, or can otherwise ignore stale turns.
- [ ] Rejected, expired, or missing resume ids fail clearly so DevFlow can fall back to durable artifacts.

## Strong Signals

- [ ] Provider supports both hooks and JSONL/log records, so DevFlow can keep one structured source as fallback for the other.
- [ ] Provider documents its hook/log schemas well enough for adapter tests to pin behavior.
- [ ] Provider lets credentials be reused or seeded into scoped config without exposing secrets.
- [ ] Provider emits session lifecycle records: start, turn complete, submitted message, and session complete.
- [ ] Provider can support final assistant messages cleanly enough for grill transcripts and execution iteration summaries.

## Red Flags

- [ ] Only exposes terminal output.
- [ ] Logs mix unrelated user sessions with no reliable active-session locator.
- [ ] Logs are rewritten in place with no stable offset, record id, or timestamp.
- [ ] Hooks require global user settings.
- [ ] Hooks fire but omit final assistant message content.
- [ ] Session ids exist but cannot be used for reliable resume.
- [ ] Origin cannot be classified without inspecting or logging prompt bodies.
- [ ] Completion markers are hidden, transformed, or absent from structured turn-final content.

## Related Architecture

- `../CONTEXT.md`: provider, managed session, control transport, data plane, normalized provider event, completion marker, scoped provider home.
- `adr/0002-keep-pty-control-with-structured-event-source-fallbacks.md`: PTY control with structured event sources.
- `adr/0003-keep-provider-events-narrow-and-turn-boundary-shaped.md`: normalized event vocabulary.
- `adr/0005-treat-provider-session-state-as-recovery-metadata.md`: provider session id and resume policy.
- `adr/0011-adapter-diagnostic-tracing-is-metadata-only.md`: adapter diagnostic trace policy.
