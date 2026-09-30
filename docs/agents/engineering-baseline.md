# Engineering Baseline

This is the mandatory kernel for production engineering policy and prototype isolation policy. Root `AGENTS.md` routes each task to the focused
document that owns its rules; this file holds what every change obeys. `CONTEXT.md` owns domain vocabulary, ADRs preserve decision rationale, and
applicable local guidance may refine this baseline after its domain and seams exist. Research, historical reviews, and ignored `.agent/` files are
advisory.

## Activation

The Minimum Verification gate is established and green — every bullet below is enforced by the canonical check — so this baseline is fully in force and
every change to production code or a prototype obeys it.

## Scope

- Keep the minimum verification gate green and runtime declarations, types, build targets, dependencies, and verification environments aligned.
- Apply structural standards as a quality ratchet to new production code and to legacy code whose seam a change crosses.
- Leave untouched legacy code alone unless current work depends on changing it.
- Unused code fails the gate: an unused file, dependency, export, or type, front doors included, and use by tests counts as use. Export a value or
  type only when another file imports it. Clear a finding by dropping the `export` and keeping the code, and delete a declaration only when nothing
  in its file uses it either. What runs is declared as an entry point; nothing is allowlisted.
- Apply the lightweight prototype contract; other focused rules apply only when a prototype crosses their explicit trigger.

## Architecture-Independent Rules

A rule belongs in this baseline only when it remains valid if the domain topology, package layout, runtime, libraries, test framework, or presentation
technology changes.

State cross-cutting outcomes here, including ownership, dependency discipline, runtime alignment, and testing through a Module's Interface. Defer
concrete owners, dependency arrows, versions, tools, paths, and topology until the decisions that establish their seams exist.

## Minimum Verification

The repository must expose one canonical check entrypoint covering:

- Type and static checking.
- Formatting verification.
- Linting.
- Recursively discovered deterministic tests.
- The production build.
- Compiled-binary smoke testing of the produced single-file executable (ADR 0030), covering `--help`/`--version` and the headless commands a slice lands.
- Narrow structural checks when a settled, high-cost rule becomes mechanically enforceable. The structural step (`bun run structure:check`, after
  linting and before the tests) is the only place Module-boundary, test-mirror, guidance-structure, release-workflow, and vendor-provenance
  violations print, each with a `fix:` and a `see:` line; see [topology](./topology.md#enforcement-and-tests) and
  [release workflow](./release-workflow.md). The other suites under `tests/architecture/` still report through the tests.
- Unused-code checking (`bun run unused:check`, right after the structural step), which prints each unused file, dependency, export, or type in the
  structural step's report form.

CI must perform a clean dependency installation before running the check entrypoint. Tests that require an installed Harness, network access,
credentials, or a real terminal remain opt-in. External URL validation, coverage thresholds, and a general architecture linter are not part of the
baseline.
