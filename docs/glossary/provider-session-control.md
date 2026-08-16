# Legacy Provider Session Control

This cluster defines legacy DevFlow terms for launching, controlling, cleaning up, and recovering a Provider session.

## Terms

- **Managed session** — one legacy Provider invocation with a lifecycle and completion contract.
- **Control transport** — how DevFlow launches and steers a legacy Provider process.
- **PTY control harness** — shared terminal-control behavior for a Provider session driven through a PTY.
- **Provider turn interruption** — a user action that interrupts the Provider's current turn while keeping the **Managed session** active.
- **Managed session abort** — a user action or Provider exit that ends the **Managed session** before its completion marker is accepted.
- **Provider key policy** — an Adapter's interpretation of terminal keys as forwarded input, a turn interruption, or a session abort.
- **Graceful exit command** — a Provider-native command that requests the CLI exit itself.
- **Completed-session cleanup** — teardown of a successfully completed **Managed session**.
- **Scoped provider home** — a DevFlow-controlled Provider data directory scoped to a run or **Managed session**.
- **Provider session state** — run-scoped recovery metadata for the current Provider-backed **Managed session**.
- **Provider session id** — a Provider-native identifier DevFlow persists only when its Adapter can treat it as reliable.
- **Provider session recovery** — resuming an interrupted **Managed session** from its **Provider session id**.
- **Artifact fallback recovery** — starting a new Provider session from durable DevFlow artifacts when native resume is unavailable.

## Related decisions

- [ADR 0002](../adr/0002-keep-pty-control-with-structured-event-source-fallbacks.md) owns the PTY control and data-plane split.
- [ADR 0005](../adr/0005-treat-provider-session-state-as-recovery-metadata.md) owns recovery metadata and native resume policy.
- [ADR 0014](../adr/0014-graceful-completed-session-cleanup-for-structured-runners.md) owns graceful completed-session cleanup.
- [ADR 0006](../adr/0006-use-project-local-claude-hook-settings.md) and
  [ADR 0017](../adr/0017-materialize-claude-macos-keychain-credential-into-scoped-home.md) own Claude-specific scoped-home policy.
