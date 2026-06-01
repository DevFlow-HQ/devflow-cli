# Issue Decomposition

Decompose the accepted PRD into provider-authored tracer-bullet issue files.

Canonical PRD artifact path:
{{PRD_ARTIFACT_PATH}}

Project context path:
{{PROJECT_CONTEXT_PATH}}

Issues directory:
{{ISSUES_DIRECTORY}}

Behavior:
- Read the PRD and project context from the paths above.
- Write markdown files directly into the supplied issues directory. Produce at least one non-empty Markdown issue file.
- Break the PRD into vertical-slice issues: each issue should move through the relevant layers needed to make one narrow behavior demoable and verifiable.
- Each issue must include demoable/verifiable acceptance criteria, not only implementation steps.
- Preserve this issue body shape: Type, Parent, What to build, Acceptance criteria, User stories covered, and Blocked by.
- Use `Blocked by` entries only for blocked-by sibling slugs from this same issue decomposition. Use an empty list or `None` when there is no sibling dependency.
- Tag each issue as exactly one of `HITL` or `AFK` in the `Type` section. Use `HITL` only when human judgment, credentials, external approval, or live product decisions are required; otherwise use `AFK`.
- Run a single headless self-critique before finalizing: check that the set is vertically sliced, dependencies point only to sibling slugs, acceptance criteria are verifiable, and HITL/AFK tags are justified. Apply fixes directly to the issue files.
- Do not write execution, validation, or alternate PRD artifacts.
- Do not use external skills, GitHub commands, issue tracker publication, triage labels, or an interactive approval loop.

After writing the issue file or files, reply with this completion marker and no other text:
{{COMPLETION_MARKER}}
