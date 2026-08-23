# DevFlow — Context

DevFlow is a provider-agnostic meta-orchestrator that delegates to AI coding CLIs. Crucible is its target Harness-oriented model.

## Glossary

This index and its linked glossary clusters are the canonical domain vocabulary. Each term has one definition. Read this index, then only the
cluster that matches the task, followed by its related ADRs when the task needs policy or rationale.

### Target language

- **Workspace** — the resolved absolute directory a **Run** executes against, supplied as a launch input. It is a value on the Run, not an entity
  with its own identity. _Avoid_: Project.
- **Run** — one execution of one **Workflow Bundle** against one **Workspace** through one **Harness**. See the
  [Crucible Run lifecycle](./docs/glossary/crucible-run-lifecycle.md) cluster for everything inside a Run.
- **Catalog Entry** — a record that a **Workflow Bundle** of a given id and version is available on this machine, carrying its origin: built-in, a
  local path, or later a portal. Installing creates one; uninstalling removes it.
- **Workflow Bundle** — one self-contained distributable workflow file, potentially an archive containing its manifest, definitions, prompts,
  skills, schemas, and **Bundle Assets**. Built-in and **External Workflow Bundles** use the same package and execution contract.
- **External Workflow Bundle** — a **Workflow Bundle** supplied outside Crucible's built-in set. It follows the same package and execution
  contract as a built-in Workflow Bundle.
- **Bundle Asset** — a resource carried inside a **Workflow Bundle** and distributed with it, carrying a declared **kind** that determines how
  it reaches the **Harness**. Delivery is the **Harness Adapter**'s job, so a workflow author never needs to know where a Harness keeps its
  skills. A Bundle Asset is not a **Run Artifact**: it has no producer and no place in a Run's bindings.
- **Proof Bundle** — the role held by a maintained **External Workflow Bundle** whose purpose is to keep Crucible's step vocabulary honest. It
  lives outside the source tree, loads the way a user's own Bundle would, and is exercised in CI. It is not shipped in the catalog. The role
  survives any particular occupant.
- **Test Repair Workflow** — the first **Proof Bundle**. Given a path to a failing test, it drives that test to green through bounded **Step
  Attempts**, then commits only after a **Human Gate** approves.
- **Harness** — an external coding-agent runtime Crucible can select for workflow execution. Codex, Claude Code, and Gemini are the initial
  Harnesses; their capabilities need not be identical.
- **Harness Adapter** — an Adapter at the Harness Seam that contains Harness-native control, event, and failure semantics behind a
  Crucible-owned Interface.
- **Projection Port** — the Crucible-owned Interface above the TUI's state layer. Crucible pushes a normalized snapshot and incremental events
  down to the view components; commands travel back up. It is an in-memory Interface, not a wire protocol, so process topology stays a separate
  decision. Harness selection sits above it, and changing the Harness remounts the session subtree.
- **Renderer Port** — the Crucible-owned Interface around the terminal renderer, covering lifecycle only: size, key input, resize, and teardown.
  It exists so the whole shell lifecycle is exercisable against a fake with no terminal, and it carries the teardown ordering the legacy Windows
  console host requires. See [ADR 0018](./docs/adr/0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md).

### Target Crucible clusters

- [Crucible Run lifecycle](./docs/glossary/crucible-run-lifecycle.md) — Runs, Steps, Step Attempts, Run Artifacts, Harness Sessions, Human Gates,
  Harness Requests, and the Run states.

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
