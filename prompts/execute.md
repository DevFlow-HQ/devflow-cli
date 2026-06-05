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
- Before the marker, state a brief summary of the changes made and functionality added in this session in the reply only. Do not write that summary as a new artifact.

Completion:
- Iteration-complete marker: if you completed one AFK issue, moved it to `issues/done/`, and committed when permitted, reply with the brief summary followed by this marker. Emit it when the selected AFK issue is complete. Do not emit it early.
{{ITERATION_MARKER}}
- Terminal no-more-tasks marker: emit this marker only after confirming from the supplied open issue files that no AFK issue remains unworked.
{{TERMINAL_MARKER}}
- Being blocked on one issue, tired, or unsure is not grounds for the terminal no-more-tasks marker.
- Premature terminal emission silently abandons real work and ends the execution stage.
- Emit exactly one of those markers.
