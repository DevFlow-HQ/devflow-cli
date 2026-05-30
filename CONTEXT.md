# DevFlow — Context

DevFlow is a provider-agnostic meta-orchestrator that delegates to AI coding CLIs (Claude, Gemini, Codex, OpenCode). See `.agent/HANDOFF_2.md` and `.agent/Progress.md` for full project history.

## Glossary

- **Provider** — an AI coding CLI that DevFlow drives (Claude, Gemini, Codex, OpenCode). Each has a built-in `ManagedSessionAdapter`.
- **Managed session** — a single provider invocation with a defined prompt/marker contract, lifecycle, and validation. Owned by `runSession(...)` on the adapter.
- **Control transport** — how DevFlow launches and steers the provider process. Today: `pty` (via `node-pty`). Reserved values: `api`, `inherit`, `stdio`.
- **Data plane / event source** — how normalized provider events reach DevFlow. Reserved values: `hooks`, `jsonl`, `logs`, `api`, `pty` (fallback). Control transport and event source are intentionally orthogonal.
- **Normalized provider event** — the narrow `ManagedProviderSessionEvent` union: `session-start`, `submitted-user-message`, `turn-completed`, `session-completed`. Provider-specific payloads and message-origin classification must be normalized inside the adapter before reaching orchestration.
- **Submitted user message** — a provider-role user message boundary from the selected data plane; origin metadata distinguishes human replies from DevFlow-managed prompts.
- **Human reply** — a submitted user message authored by the user during the grill discussion; only human replies belong in the **Grill transcript**.
- **Grill transcript** — the durable record of the grill-stage discussion from the first provider response after the initial prompt through accepted grill completion, excluding completion markers and later protocol text.
- **Accepted grill completion** — the grill stage boundary reached when the active completion marker is observed and DevFlow successfully validates, completes the **Grill transcript**, and writes the grill checkpoint.
- **Structured grill transcript contract** — structured transcript-capable providers emit normalized provider events with trustworthy origin metadata. Orchestration owns grill transcript artifact policy: provider content comes from `turn-completed.assistantMessage`; only human-origin `submitted-user-message` events are recorded as user replies; managed-origin and unknown-origin submitted user messages are excluded; and completion markers plus later protocol text stay out of the durable artifact.
- **Transcript capture** — recording provider and user messages into the **Grill transcript**; distinct from **Normalized provider event** capture even when events supply the transcript content.
- **Turn** — one full round of `user submits → model responds → model signals done`. A turn ends with exactly one `turn-completed`. Repairs and continuations each constitute their own turn.
- **`turn-completed.assistantMessage`** — optional content field on `turn-completed`. When emitted from a structured event source, it carries the model's final assistant message for the turn (e.g., Codex `Stop.last_assistant_message` or JSONL `task_complete.last_agent_message`). When emitted from PTY fallback, the field is absent because PTY cannot reliably extract clean per-turn content.
- **Intra-turn streaming is not modelled** — DevFlow does not surface token deltas, intermediate prose between tool calls, or tool-call events. Only turn-final content. If a stage later needs full intra-turn prose, expand the union then; do not over-engineer now.
- **No `session-failed` event** — authoritative session failure is the typed error thrown from `runSession()` (`ProviderSessionLaunchError`, `IncompleteProviderSessionError`, `ProviderSessionCleanupError`, etc.). A best-effort "session-failed" event would be redundant and never load-bearing for orchestration.
- **Hook content** — Claude, Codex, and Gemini-CLI hooks carry the full assistant message content at turn boundaries, so hooks alone can satisfy DevFlow's data needs for these providers. OpenCode hooks do not carry content.
- **Fallback tier** — DevFlow models three event-source tiers, selected before a managed session starts: **hooks (primary) → JSONL tailing (universal fallback) → PTY synthesis (bottom fallback)**. JSONL is the universal fallback for *every* provider with a stable session log, not OpenCode-specific. The fallback may not be exercised on providers whose hooks already deliver everything DevFlow needs, but the infrastructure must exist so any future hook gap (missing event, missing content, misconfigured user hook) degrades to JSONL rather than directly to PTY.
- **Provider hook** — an executable command the provider invokes on a lifecycle/tool event, receiving structured JSON on stdin. DevFlow's primary structured event mechanism.
- **JSONL session log** — an append-only file the provider writes during a session with one JSON record per line (e.g. Codex rollout files). DevFlow's secondary/fallback structured event mechanism for providers without hooks.
- **Session log locator** — a provider-owned strategy for identifying the JSONL session log for a managed session without depending on provider hook events.
- **Scoped provider home** — a DevFlow-controlled provider data directory scoped to a run or managed session, used to make provider-owned files discoverable without mixing them with unrelated user sessions.
- **PTY fallback events** — normalized events synthesized from PTY terminal output by `runPtyManagedSession`. Used only when no structured event source is available for the provider (Claude/Gemini/OpenCode today). For Codex, PTY is **non-observational**: it serves only as a control transport (spawn, stdin forwarding, terminal mirroring, Ctrl+C, resize) and emits no synthesized events. Codex's PTY `onExit` is still observed, but only as a lifecycle notification — not as a completion-detection input.
- **Marker observation channel** — for PTY-fallback providers, markers are scanned in raw terminal output. For structured providers, markers are scanned in `turn-completed.assistantMessage` content delivered by the selected structured event source, such as hooks or JSONL.
- **Phase manager** — the orchestration-side state machine that owns current-phase tracking, marker scanning on incoming `turn-completed` events, validation, repair injection, and continuation advancement for hook-driven providers. Lives outside the PTY runner. Stamps every forwarded event with the current phase id at receipt time.
- **Phase** — a logical step inside a managed session (initial prompt, continuation, repair). Identified by `ManagedProviderSessionPhase.id`. DevFlow phases are private; providers don't know about them.
- **Live PRD continuation** — PRD synthesis injected into the same still-running provider session immediately after accepted grill completion.
- **Dedicated stage session** — a provider session scoped to one stage or one issue-solving loop so later work does not inherit unnecessary context from earlier stages.
- **Provider session state** — run-scoped recovery metadata for the current provider-backed **Managed session**, including provider identity, provider session id when available, and the current DevFlow phase.
- **Provider session recovery** — continuing any interrupted **Managed session** from its provider session id when the adapter truthfully supports resume.
- **Artifact fallback recovery** — starting a new provider session from durable DevFlow artifacts when the original provider session cannot be resumed.
- **Run** — one user invocation of DevFlow, scoped to `.devflow/runs/<run-id>/`. A run may contain multiple managed sessions across stages.

## Architecture Decisions

Durable architecture decisions live in `docs/adr/`.
