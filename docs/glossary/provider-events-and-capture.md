# Legacy Provider Events And Capture

This cluster defines legacy DevFlow terms for observing Provider activity and normalizing it across Adapter seams.

## Terms

- **Data plane / event source** — how Provider activity reaches DevFlow independently of its control transport.
- **Normalized provider event** — a Provider-independent event carried from an Adapter into orchestration.
- **Submitted user message** — a user-message boundary reported by the selected data plane.
- **Turn** — one submitted user message, Provider response, and turn-completion signal.
- **`turn-completed.assistantMessage`** — optional final Provider text carried on a normalized turn-completion event.
- **Fallback tier** — the selected event-source priority for a **Managed session**.
- **Provider hook** — an executable command a Provider invokes on a lifecycle or tool event with structured input.
- **Hook IPC endpoint** — the ephemeral machine-scoped rendezvous through which a **Provider hook** returns its payload to DevFlow.
- **JSONL session log** — an append-only Provider session file containing one JSON record per line.
- **Session log locator** — a Provider-owned strategy for locating the JSONL session log of a **Managed session**.
- **PTY fallback events** — normalized events synthesized from terminal output when no structured event source is selected.

## Related decisions

- [ADR 0002](../adr/0002-keep-pty-control-with-structured-event-source-fallbacks.md) owns event-source fallback policy.
- [ADR 0003](../adr/0003-keep-provider-events-narrow-and-turn-boundary-shaped.md) owns the normalized event vocabulary.
- [ADR 0007](../adr/0007-derive-claude-jsonl-turn-completion-from-end-turn-stop-reason.md) and
  [ADR 0008](../adr/0008-claude-jsonl-launch-ordering-inverts-codex.md) own Claude JSONL details.
- [ADR 0013](../adr/0013-bind-hook-ipc-socket-at-short-machine-scoped-path.md) owns Hook IPC endpoint placement.
