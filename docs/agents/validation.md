# Validation And Failure Translation

Read this when handling external or persisted input or translating external failures.

At an ingress Seam, validate external or persisted input only to the contract the owning Module consumes; keep intentionally opaque payloads opaque.
After validation, operate on trusted domain values where a domain representation exists. A Module enforces its construction invariants before
persistence.

Translate external failures at their owning Seam into typed domain failures while preserving the original cause. Presentation formats those failures;
it does not classify them.
