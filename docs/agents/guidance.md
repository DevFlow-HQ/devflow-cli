# Guidance Design

Read this before adding, moving, splitting, or materially expanding agent guidance.

- Keep root `AGENTS.md` as a brief always-loaded index and the engineering baseline as its authoritative router and mandatory kernel.
- Create path-local `AGENTS.md` guidance only when a substantial domain repeatedly requires non-obvious ownership, invariants, dependency rules,
  Interface guidance, or test instructions.
- Local guidance inherits the baseline, adds only local facts, and cannot weaken it.
- Use skills for task workflows. Keep safety-critical engineering and domain policy in deterministically triggered guidance.
- Give every rule one authoritative home.

Focused documents are recursively extensible, not a fixed final hierarchy. When one approaches 80–100 lines, split independent branches or sequences
behind precise pointers.

Wrap new or materially edited agent-facing Markdown prose at no more than 175 characters per line. Unbreakable URLs, Markdown table rows, significant code
fences, and generated content governed elsewhere are exempt. The 80–100-line split review assumes prose follows this limit.

Review the full guidance tree once when establishing the baseline. Afterward, perform a one-shot review only when guidance is added, moved, split, or
materially expanded: follow the affected pointer chain recursively once with a representative task, confirm it reaches every required rule without
loading unrelated branches, and check that every affected document still earns its context cost.

## Activating Deferred Rules

Keep unresolved topology-, runtime-, and domain-specific decisions in their GitHub wayfinding issues rather than duplicating them here. When a decision
establishes a real domain, Seam, runtime, or topology, close it only after adding or updating the smallest applicable focused guidance and adding a
narrow mechanical check when violation is both costly and mechanically detectable. Complete both before implementation crosses the new Seam.
