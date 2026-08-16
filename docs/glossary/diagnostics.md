# Legacy Diagnostics

This cluster defines legacy DevFlow terms for internal diagnostics and unexpected terminal failures.

## Terms

- **Diagnostic log** — DevFlow's durable internal activity record, distinct from the **Run summary**.
- **Log level** — the severity classification assigned to a **Diagnostic log** record.
- **Correlation ref** — a short opaque identifier that connects an unexpected terminal failure to its diagnostic record.
- **Redacted terminal error** — the user-facing message for an unexpected failure, containing only its **Correlation ref** and log location.

## Related decisions

- [ADR 0011](../adr/0011-adapter-diagnostic-tracing-is-metadata-only.md) owns Adapter diagnostic-tracing policy.
