# Module Design

Read this when changing ownership, a Module, its Interface, or a Seam.

## Language

**Module** — anything with an Interface and an Implementation, at any scale.

**Interface** — everything a caller must know to use a Module correctly, including invariants, ordering constraints, error modes, configuration, and
performance characteristics.

**Implementation** — the behavior hidden inside a Module.

**Seam** — a place where behavior can be altered without editing the caller; the location where a Module's Interface lives.

**Adapter** — a concrete implementation that satisfies an Interface at a Seam.

**Depth** — the leverage a Module provides through its Interface. A deep Module hides substantial decisions and behavior behind a small Interface.

**Leverage** — capability callers and tests gain per unit of Interface they must learn.

**Locality** — concentration of related knowledge, change, defects, and verification in one owning place.

## Standard

- Give each domain concept or invariant one owning Module. Ownership here belongs to the code's domain model, not to a person or team.
- Keep the Interface as small as callers need while hiding decisions, mechanisms, invariants, and failure translation in the Implementation.
- Keep correctness-critical ordering and lifecycle visible in cohesive orchestration.
- Extract when the result names an independent concept, centralizes an invariant, hides substantial knowledge, owns a side effect, or serves genuine consumers.
- Apply the deletion test: removing a worthwhile Module redistributes meaningful complexity into callers.
- Introduce a Seam where behavior genuinely varies, normally demonstrated by at least two justified Adapters.

## File Shape

Prefer small, cohesive, navigable files. File growth triggers a cohesion review, not an automatic violation or split.

Split when an independently nameable Module or private submodule improves Locality. Keep cohesive Implementation together when splitting would create
shallow helpers, expose internal orchestration, or make correctness depend on navigating several files.
