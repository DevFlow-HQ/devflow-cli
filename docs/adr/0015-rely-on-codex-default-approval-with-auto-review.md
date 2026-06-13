# Rely On Codex's Default Approval Policy With Auto-Review Instead Of `-a never`

DevFlow launches Codex with **no `--ask-for-approval` flag** and instead passes `-c approvals_reviewer=auto_review` (via `buildCodexLaunchArgs`, so it applies to both the hook and JSONL runners). It does **not** pass `-s/--sandbox` because `workspace-write` is already Codex's default. With no approval flag, Codex falls back to its default `approval_policy = "on-request"`; `auto_review` then routes every action that asks to cross a sandbox boundary to an automated reviewer agent rather than pausing for a human. The result is **non-blocking but sandboxed**: routine actions run inside `workspace-write` (writes confined to the repo, network off), and boundary escalations are auto-reviewed instead of either deadlocking on a human prompt or being waved through unconditionally. This replaces the previous `["-a", "never"]`.

Non-blocking is a hard requirement, not a preference: the hook and JSONL runners **submit prompts programmatically** to the PTY, and the execute stage runs an **unattended bounded fresh-session loop** — any human-approval prompt would hang those paths.

## Considered Options

- **`-a never` (the prior behavior, rejected).** It never gates the model and, on its own, pins no sandbox, so it relies on whatever Codex defaults to and lets every command through unreviewed — the danger that motivated this change. It is also self-defeating with auto-review: per Codex docs, *"with `approval_policy = "never"`, there is nothing to review,"* so `-a never` would silently disable the reviewer.
- **`-a on-request` without auto-review (rejected).** Safe, but it surfaces a human approval prompt on every boundary crossing — which deadlocks the programmatic runners and the unattended execute loop.
- **`--dangerously-bypass-approvals-and-sandbox` (rejected).** Removes both gates; strictly more dangerous than `-a never`.
- **Writing `approvals_reviewer` into the generated `config.toml` instead of a `-c` flag (rejected).** Only the hook runner writes `config.toml`; a launch-arg flag covers both data planes uniformly.

## Consequences

- **The absence of an approval flag in the launch args is deliberate.** A future maintainer who "fixes" it by re-adding `-a never` reintroduces the exact danger this ADR removes **and** silently disables `auto_review`. Do not re-add it.
- `auto_review` engages a **separate reviewer agent** per escalation — it adds latency/token cost on boundary-crossing actions, and it is a *reviewer swap, not a permission grant* (it still respects the active sandbox).
- This holds only while Codex's defaults remain `sandbox = workspace-write` + `approval_policy = on-request`. If Codex changes either default, this decision must be revisited (an explicit `-s workspace-write -a on-request` would then be needed to preserve the behavior).
- The deferred V2 "user-chosen approval mode" supersedes part of this for the *manual* case: DevFlow will store its own approval preference and the Codex adapter will translate `manual` to dropping `auto_review` (interactive `on-request`) and `auto` to this ADR's behavior. The translation stays inside the adapter.
