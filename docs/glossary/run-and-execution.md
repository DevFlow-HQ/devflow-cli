# Legacy Run And Execution

This cluster defines legacy DevFlow terms for a Run and the Provider-driven execution loop.

## Terms

- **Legacy Run** — one DevFlow invocation and its run-scoped artifacts. Superseded by the target **Run** in the
  [Crucible Run lifecycle](./crucible-run-lifecycle.md) cluster, which is scoped to a **Workflow Bundle** and a **Workspace** rather than to a
  CLI invocation.
- **Issue** — a Provider-authored, independently-grabbable unit of work derived from the canonical PRD.
- **Issue decomposition** — the stage that derives **Issues** from the canonical PRD.
- **Blocked-by edge** — a dependency between sibling **Issues** that prevents one from starting until the other completes.
- **AFK issue / HITL issue** — an **Issue** designated for autonomous Provider execution or for human judgment, respectively.
- **Execution stage** — the Provider-driven loop that works open **Issues** after decomposition.
- **Execution iteration** — one fresh Provider turn over the open work in the **Execution stage**.
- **Active issues directory** — the run-scoped directory holding open **Issue** files.
- **Completed issue set** — the **Issues** moved from the active set after the Provider handles them.
- **No-more-tasks marker (terminal marker)** — the Provider's signal that no AFK **Issue** remains.
- **Iteration-complete marker** — the Provider's signal that the current **Execution iteration** has finished.
- **Execution record** — the durable per-iteration ledger for an **Execution stage**.
- **Incomplete execution record** — an **Execution record** lacking its clean-stop final record.
- **Iteration final message** — the final Provider message recorded for an **Execution iteration**.
- **Run summary** — the final CLI report rendered from the **Execution record**.

## Related decisions

- [ADR 0009](../adr/0009-provider-authored-issue-files-with-existence-only-validation.md) owns the Provider-authored **Issue** contract.
- [ADR 0010](../adr/0010-devflow-owned-dumb-execution-loop.md) owns execution-loop, marker, and execution-record policy.
