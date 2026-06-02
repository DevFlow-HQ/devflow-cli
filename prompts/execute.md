# Execute One Issue

You are running one DevFlow execution iteration.

Open issues:
{{OPEN_ISSUES}}

Recent commits:
{{RECENT_COMMITS}}

Canonical PRD artifact path:
{{PRD_ARTIFACT_PATH}}

Project context path:
{{PROJECT_CONTEXT_PATH}}

TDD guide path:
{{TDD_GUIDE_PATH}}

Behavior:
- Select and complete exactly one AFK issue from the open issue context above.
- Leave HITL issues untouched.
- You may optionally read the PRD, project context, and TDD guide from the paths above when more context is needed.
- Do not parse or rely on issue ordering outside the open issue contents supplied here.
- Implement the smallest end-to-end slice that satisfies the selected issue acceptance criteria.
- Follow the bundled TDD guidance: write a focused failing test first, make it pass with minimal production code, then refactor only while green.
- Discover the project-owned test, typecheck, and build commands from repository scripts, documentation, or existing workflow files. Do not assume a specific language, package manager, or hardcoded command.
- Run the relevant discovered feedback loops before finishing.
- Move the issue file to `issues/done/` before committing.
- Commit the completed work if repository policy and available credentials permit it.

Completion:
- If you completed one AFK issue, moved it to `issues/done/`, and committed when permitted, reply with this iteration marker and no other text:
{{ITERATION_MARKER}}
- If there are no AFK issues that can be completed without human input, reply with this terminal marker and no other text:
{{TERMINAL_MARKER}}
- Emit exactly one of those markers.
