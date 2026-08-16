# Legacy Grill And Stage Flow

This cluster defines legacy DevFlow terms for grill transcripts, stage completion, and Provider session scope.

## Terms

- **Human reply** — a **Submitted user message** authored by the user during the grill discussion.
- **Grill transcript** — the durable record of the grill-stage discussion.
- **Accepted grill completion** — the grill-stage boundary reached when its completion marker is accepted.
- **Grill conclusion confirmation** — the Provider's prompt-level request for explicit approval before it emits the grill completion marker.
- **Structured grill transcript contract** — the division of transcript capture responsibilities between an Adapter and orchestration.
- **Transcript capture** — recording Provider and user messages into the **Grill transcript**.
- **Completion marker** — an opaque stage token that is the authoritative completion condition for that stage.
- **Marker observation channel** — the selected source in which DevFlow detects a **Completion marker**.
- **Phase manager** — the orchestration state machine that manages phases and marker handling for a structured Provider session.
- **Phase** — a logical step inside a **Managed session**, such as an initial prompt, continuation, or repair.
- **Live PRD continuation** — PRD synthesis injected into the still-running Provider session after accepted grill completion.
- **Dedicated stage session** — a Provider session scoped to one stage or one issue-solving loop.

## Related decisions

- [ADR 0001](../adr/0001-keep-grill-to-prd-live-continuation-with-resumable-recovery.md) owns live PRD continuation and dedicated-session policy.
- [ADR 0003](../adr/0003-keep-provider-events-narrow-and-turn-boundary-shaped.md) owns event and completion-marker policy.
- [ADR 0004](../adr/0004-keep-structured-grill-transcript-policy-in-orchestration.md) owns the structured transcript contract.
