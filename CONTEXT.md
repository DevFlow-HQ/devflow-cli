# DevFlow — Context

DevFlow is a provider-agnostic meta-orchestrator that delegates to AI coding CLIs. Crucible is its target Harness-oriented model.

## Glossary

This index and its linked glossary clusters are the canonical domain vocabulary. Each term has one definition. Read this index, then only the
cluster that matches the task, followed by its related ADRs when the task needs policy or rationale.

### Target language

- **Workflow Bundle** — one self-contained distributable workflow file, potentially an archive containing its manifest, definitions, prompts,
  skills, schemas, and **Bundle Assets**. Built-in and **External Workflow Bundles** use the same package and execution contract.
- **External Workflow Bundle** — a **Workflow Bundle** supplied outside Crucible's built-in set. It follows the same package and execution
  contract as a built-in Workflow Bundle.
- **Bundle Asset** — a resource carried inside a **Workflow Bundle** and distributed with it.
- **Harness** — an external coding-agent runtime Crucible can select for workflow execution. Codex, Claude Code, and Gemini are the initial
  Harnesses; their capabilities need not be identical.
- **Harness Adapter** — an Adapter at the Harness Seam that contains Harness-native control, event, and failure semantics behind a
  Crucible-owned Interface.

### Legacy Provider language

These terms describe the current DevFlow model, not Crucible's target Harness model.

- **Provider** — DevFlow's legacy selection and fallback-wiring concept around an AI coding CLI, not a synonym for the target **Harness**.
- **Supported provider** — a selectable legacy **Provider** with a structured data plane that can satisfy the normalized provider-event contract.
- **Deferred provider** — a wired legacy **Provider** intentionally excluded from selection. The current selection policy and initial sets belong
  to [ADR 0012](./docs/adr/0012-defer-gemini-and-opencode-as-wired-but-unselectable-providers.md).

### Legacy DevFlow clusters

- [Provider session control](./docs/glossary/provider-session-control.md) — launch, terminal control, cleanup, scoped state, and recovery.
- [Provider events and capture](./docs/glossary/provider-events-and-capture.md) — event sources, normalization, hooks, logs, and PTY fallback.
- [Grill and stage flow](./docs/glossary/grill-and-stage-flow.md) — transcript terms, markers, phases, and session scope.
- [Run and execution](./docs/glossary/run-and-execution.md) — runs, provider-authored issues, execution, and summaries.
- [Diagnostics](./docs/glossary/diagnostics.md) — internal logs, correlation, and terminal failure messages.

## Architecture decisions

Durable architecture decisions live in [docs/adr](./docs/adr/).
