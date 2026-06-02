# TDD Workflow Guide

Use this guide for DevFlow execution sessions even when no external skill is installed.

Principles:
- Test behavior through public interfaces, not private implementation details.
- Work in vertical slices. Do not write a batch of speculative tests before implementation.
- Keep each cycle narrow: one failing test, minimal code to pass, then cleanup while green.
- Prefer integration-style tests when they can exercise the real code path without brittle internals.
- Match the repository's existing vocabulary, helpers, fixtures, and test style.

Cycle:
1. Identify the smallest observable behavior needed for the selected issue.
2. Write one test that fails for that behavior.
3. Run the focused feedback loop and confirm the failure is meaningful.
4. Implement only enough production code to pass.
5. Run the focused feedback loop again.
6. Refactor only while tests are green.
7. Repeat for the next behavior only when it is necessary for the selected issue.

Finishing:
- Run the project-owned verification commands discovered from the repository.
- Do not invent unrelated refactors or broad architecture changes.
- Move only the completed issue into `issues/done/`.
- Commit only the selected issue's completed work when commits are permitted.
