# Crucible Run Lifecycle

This cluster defines the target Crucible terms for a **Run** and everything that happens inside one. The **Workflow Bundle** side of the
vocabulary lives in the [index](../../CONTEXT.md); this cluster owns execution.

## Terms

- **Bundle Snapshot** — the exact **Workflow Bundle** content one **Run** launched with, pinned so a later reinstall cannot rewrite that Run's
  history.
- **Step** — one authored node in a **Workflow Bundle**'s routing, identified by an author-chosen name unique within its Bundle and opaque to
  Crucible.
- **Iteration** — one logical occurrence of a repeated group of **Steps**. A numbered scope, not an entity.
- **Step Attempt** — one execution of one **Step**, identified by its Step, **Iteration**, and attempt number. Retries and **Iterations** are
  bounded separately.
- **Attempt outcome** — how a **Step Attempt** ended: `succeeded`, `failed`, `indeterminate`, or `cancelled`.
- **Indeterminate attempt** — a **Step Attempt** Crucible started and never saw a result for. Distinct from a failure, because a step that died
  after acting on the world must not be blindly retried.
- **Launch input** — a value supplied when a **Run** is created, seeded into the Run's bindings like any other **Run Artifact**.
- **Run Artifact** — a named, typed value in the routing's dataflow, produced by a **Step Attempt** and consumable by later **Steps**. Logically
  versioned: the name binds to the latest good version and superseded versions stay reachable.
- **Artifact home** — where a **Run Artifact**'s bytes live. Crucible's own store by default; a declared path inside the **Workspace** when the
  artifact genuinely belongs to the repository.
- **Workspace change** — any change inside the **Workspace** that is not a declared **Run Artifact**. Owned by the world and by Git, never by
  Crucible's artifact graph.
- **Harness Session** — a named conversation with the selected **Harness**, owned by exactly one **Run** and never shared across Runs. The routing
  names the session each agent **Step** runs in; Crucible opens it on first use and reuses it after.
- **Session availability** — whether a **Harness Session** is `open` (a next turn can be sent now), `detached` (not live, but holding a
  Harness-native id worth reattaching), or `unusable` (reattach failed).
- **Human Gate** — a Crucible-owned pause carrying a Bundle-authored question. Its answer is a durable **Run Artifact**, so a **Run** can wait on
  one indefinitely.
- **Harness Request** — a **Harness**-originated tool approval or clarification raised mid-turn. Ephemeral: it lives and dies with the live turn.
- **Interactive agent step** — a **Step** whose **Harness Session** is handed to the human for turn-taking. Crucible relays turns and authors
  nothing. The legacy grill is this shape.
- **Steer** — injecting a turn into a live **Harness Session**. The **Step Attempt** keeps running and its state is untouched.
- **Interrupt** — stopping the current **Step Attempt**, which ends `cancelled` and leaves the **Run** `halted` and re-attemptable.
- **Cancel** — explicitly ending a **Run**. The only route to the terminal `cancelled` state.
- **Preflight** — the precondition check performed before a **Run** exists: required **Launch inputs**, step preconditions such as "requires a Git
  repository", and Harness capability requirements. A failed preflight creates no **Run**.

## Run states

A **Run** pins its **Workspace**, **Bundle Snapshot**, **Harness**, default model, and **Launch inputs** at launch.

| State       | Meaning                                                         | Terminal |
| ----------- | --------------------------------------------------------------- | -------- |
| `running`   | a **Step Attempt** is executing                                 | no       |
| `blocked`   | a **Human Gate** or **Harness Request** is waiting on the human | no       |
| `halted`    | stopped for a reason outside the workflow's logic               | no       |
| `failed`    | the workflow concluded negatively                               | no       |
| `succeeded` | the routing completed                                           | yes      |
| `cancelled` | the user explicitly ended the Run                               | yes      |

`blocked` is derived from the current **Step Attempt** rather than stored, as is the interrupted condition of a Run marked live with no process
running it.

## Rules

- Crucible orchestrates around the **Harness**, never inside it. The Harness owns its own questions, tool approvals, and turn mechanics.
- One live **Run** — `running` or `blocked` — per **Workspace**. A `halted` Run holds no claim, so Crucible does not promise its Workspace is
  unchanged when it resumes.
- No **Step** is skippable. The routing advances only by a Step completing.
- **Bundle Assets** are not **Run Artifacts**: they have no producer, no per-attempt version, and no place in the bindings.

## Related decisions

- [ADR 0019](../adr/0019-failed-and-halted-runs-are-resumable-resting-states.md) owns Run resumability and the reset-on-resume rule.
- [Define Crucible's product domain and lifecycle](https://github.com/DevFlow-HQ/devflow-cli/issues/4) records the full model and its rationale.
