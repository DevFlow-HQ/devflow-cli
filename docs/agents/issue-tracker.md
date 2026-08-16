# Issue Tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`, including its labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull Requests As A Triage Surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve an ambiguous number with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Skill Operations

When a skill says "publish to the issue tracker," create a GitHub issue. When it says "fetch the relevant ticket," use `gh issue view <number> --comments`.

## Wayfinding Operations

The map is one issue labelled `wayfinder:map`; its decision tickets are child issues.

- **Map**: create with `gh issue create --label wayfinder:map`.
- **Child ticket**: link the issue as a GitHub sub-issue using the sub-issues API. If sub-issues are unavailable, add it to a task list in the map body and put `Part of #<map>` at the top of the child body. Label it `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`, where the database id comes from `gh api repos/<owner>/<repo>/issues/<number> --jq .id`. If dependencies are unavailable, use `Blocked by: #<number>` in the child body.
- **Frontier**: list the map's open children and exclude tickets with open blockers or an assignee. The first remaining child in map order is next.
- **Claim**: assign the ticket before starting with `gh issue edit <number> --add-assignee @me`.
- **Resolve**: comment with the answer, close the ticket, then append a linked one-line gist to the map's Decisions-so-far.
