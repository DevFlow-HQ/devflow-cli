# Issue Decomposition

Decompose the accepted PRD into provider-authored issue files.

Canonical PRD artifact path:
{{PRD_ARTIFACT_PATH}}

Project context path:
{{PROJECT_CONTEXT_PATH}}

Issues directory:
{{ISSUES_DIRECTORY}}

Behavior:
- Read the PRD and project context from the paths above.
- Write at least one non-empty Markdown issue file directly into the issues directory.
- Do not write execution, validation, or alternate PRD artifacts.

After writing the issue file or files, reply with this completion marker and no other text:
{{COMPLETION_MARKER}}
