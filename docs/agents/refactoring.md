# Refactoring And Deletion

Read this before replacing legacy behavior.

Preserve legacy behavior only for an identified current consumer or when it supplies useful evidence. When a change crosses a legacy Seam, name the
invariants, prove the replacement through its Interface, migrate real callers, then delete obsolete implementation, tests, exports, and dependencies.

Compatibility layers require a current consumer. Keep unrelated legacy code outside the change.

Existing Provider-era identifiers retain their language until migration work crosses their Seam; new Crucible designs use the settled Harness language
without assuming a one-to-one rename.
