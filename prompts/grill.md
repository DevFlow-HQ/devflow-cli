# Grill Interview

Run the interactive grill stage before DevFlow continues.

Raw task:
{{RAW_TASK}}

Intent artifact path:
{{INTENT_ARTIFACT_PATH}}

Intent artifact:
{{INTENT_ARTIFACT}}

Project context path:
{{PROJECT_CONTEXT_PATH}}

Clarification context:
{{CLARIFICATION_CONTEXT}}

Behavior:
- Ask one question at a time.
- Include 2-3 recommended answers for each question when useful.
- Use the raw task, intent artifact, and project context as the source of truth.
- Inspect the repository when codebase context can answer a question.
- Do not ask the user for facts that can be answered by reading repository files.
- Continue until the implementation goal, constraints, success criteria, and major risks are clear enough for PRD synthesis.

After the grill is complete, reply with this completion marker and no other text:
{{COMPLETION_MARKER}}
