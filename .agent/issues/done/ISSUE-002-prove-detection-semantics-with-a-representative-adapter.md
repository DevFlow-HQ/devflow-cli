# ISSUE-002: Prove detection semantics with a representative adapter

Type: AFK

## What to build

Implement one representative adapter path that exercises the shared detection contract against local machine state without starting an interactive provider session. This slice should prove that provider availability checks stay non-interactive, keep executable resolution inside the adapter, and return structured success or failure outcomes that higher-level setup logic can consume consistently.

## Acceptance criteria

- [x] Detection is asynchronous, parameterless, and non-interactive.
- [x] Successful detection returns a structured result that can include the executable command name or resolved path.
- [x] Failed detection returns a structured result with a reason string and does not duplicate provider identity already carried by the adapter.

## Blocked by

- ISSUE-001
