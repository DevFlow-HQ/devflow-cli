# Engineering Baseline

This is the authoritative index and mandatory kernel for production engineering policy and prototype isolation policy. `CONTEXT.md` owns domain
vocabulary, ADRs preserve decision rationale, and applicable local guidance may refine this baseline after its domain and seams exist. Research,
historical reviews, and ignored `.agent/` files are advisory.

## Activation

This policy is authoritative while its mechanical gate is being established. Until the Minimum Verification contract is implemented and green, only
work whose purpose is to enable this baseline may change production code or start a prototype. That bootstrap work runs every already-available check
and is complete only when the full gate passes.

## Scope

- Establish a green minimum verification gate and align runtime declarations, types, build targets, dependencies, and verification environments before
  Crucible coding or prototype work begins.
- Apply structural standards as a quality ratchet to new production code and to legacy code whose seam a change crosses.
- Leave untouched legacy code alone unless current work depends on changing it.
- Apply the lightweight prototype contract; other focused rules apply only when a prototype crosses their explicit trigger.

## Architecture-Independent Rules

A rule belongs in this baseline only when it remains valid if the domain topology, package layout, runtime, libraries, test framework, or presentation technology changes.

State cross-cutting outcomes here, including ownership, dependency discipline, runtime alignment, and testing through a Module's Interface. Defer
concrete owners, dependency arrows, versions, tools, paths, and topology until the decisions that establish their seams exist.

## Required Guidance

- Before changing ownership, a Module, its Interface, or a Seam, read [module design](./module-design.md).
- Before changing dependencies, composition, or allowed import direction, read [dependency discipline](./dependencies.md).
- Before changing tests or fixtures, read [testing](./testing.md).
- Before handling external or persisted input or translating external failures, read [validation](./validation.md).
- Before starting or changing a prototype, read [prototypes](./prototypes.md).
- Before replacing legacy behavior, read [refactoring](./refactoring.md).
- Before adding, moving, splitting, or materially expanding agent guidance, read [guidance design](./guidance.md).
- Before declaring an implementation issue complete, read [change review](./change-review.md).

## Minimum Verification

The repository must expose one canonical check entrypoint covering:

- Type and static checking.
- Formatting verification.
- Linting.
- Recursively discovered deterministic tests.
- The production build.
- Installation and `--help`/`--version` smoke testing of the produced package.
- Narrow structural checks when a settled, high-cost rule becomes mechanically enforceable.

CI must perform a clean dependency installation before running the check entrypoint. Tests that require an installed Harness, network access,
credentials, or a real terminal remain opt-in. Documentation-link validation, coverage thresholds, and a general architecture linter are not part of
the baseline.
