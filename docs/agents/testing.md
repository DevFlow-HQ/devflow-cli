# Testing

Read this when changing tests or fixtures.

The default suite discovers tests recursively and is deterministic: it requires no network, credentials, installed Harness, real terminal, arbitrary
sleep, or other unstable external state. Tests requiring those resources are opt-in. Tests are written against the `node:test` API and run under Bun's
test runner (`bun test`), not `bun:test`; `bunfig.toml` records why the per-test timeout is a CLI `--timeout` flag rather than a `[test] timeout` key
(that key applies only to `bun:test`, so it never reaches these tests).

## Evidence Layers

The gate separates three independently attributable, blocking layers (ADR 0027's 2026-09-21 amendment):

- The **process-free semantic suite** runs under the test runner with injected Process and Harness doubles; the scripted Process is
  `tests/process/fake-adapter.ts`.
- **Standalone runtime conformance** runs real Process, Git, and recorded-Harness behavior in an ordinary Bun process outside the test runner: the
  `tests/process/runtime-conformance.ts` program, run by `bun run test:runtime-conformance` and CI's `Process runtime conformance` step. It and the
  terminal-lifecycle program share their runner helpers (timeouts, exit, temp-dir cleanup, `stage`) in `tests/helpers/standalone.ts`.
  - A supervisor parent (`tests/helpers/supervisor.ts`) runs the scenarios in one child process and enforces the 20-second bound from outside its event
    loop. The scenario side (`scenario-runner.ts`) writes scenario, stage, and child-fact breadcrumbs synchronously to a breadcrumb file and the
    operational log. Every real Process takes `withRunnerObserver()`.
  - A failed, timed-out, or crashed scenario prints a last-active-stage summary: scenario, open stage, open child roles and PIDs (a blocking sync spawn
    has none yet), elapsed time, and the log folder (`SECANT_LOG_DIR`, else `secant-runner-logs` under the OS temp folder). The supervisor then kills
    the tree (each reported PID's group or tree, then the scenario's), removes the run's temp root, and resumes at the next scenario. Its fixtures
    are runtime cases (`supervisor-conformance.ts`). Terminal lifecycle runs the same scenario side unsupervised.
  - The temp root is the scenario's `TMPDIR` itself, one short name deep: on Windows the deepest Run Store paths sit within 13 characters of git's
    260-character limit, so a deeper root fails `matt-front-replayer-workbench` there.
- **Compiled-binary acceptance** exercises Command, Harness, interruption, recovery, and Git through the copied binary in the consumer job.

A real child under `bun test` fails its test. `bunfig.toml` preloads the spawn trap (`tests/helpers/spawnTrap.ts`, which documents the routes it
covers) ahead of every file; it is the one `bun:test` import, because only Bun offers module mocks and preload hooks. Every child-process and Bun spawn
throws, and a global hook fails the test that reached one even when the caller turned the throw into a value. The failure names the route and the test.
There is no allowlist; the fix is a fake Process.

The checked-in [subprocess migration ledger](../subprocess-test-migration-ledger.md) is complete: every row is `done` and stays as a historical coverage
record. A new real-spawn assertion goes straight to standalone runtime conformance or compiled-binary acceptance, never into the semantic suite. Do not
mask a failure with a retry, sleep, timeout increase, or silent assertion removal in any layer.

The canonical test script (`scripts/test.ts`) runs three isolated file workers on every OS (`--parallel=3`). Three is safe only because no worker spawns a
child: under the Bun 1.4.2 child-lifecycle defect ([#149](https://github.com/secantdev/secant/issues/149)), workers each spawning a child at startup on a
CPU-constrained runner occasionally lost the child's `exit`/`close`/stdio events, and the spawn never settled. Three workers remain the calibrated
count. [#274](https://github.com/secantdev/secant/issues/274#issuecomment-5911415757) traced intermittent Windows stalls to temp-file and SQLite
writes on the runner's system disk. The Windows `check` job routes `TEMP` and `TMP` under `RUNNER_TEMP` and fails if it is on the system drive;
[Windows CI disk stalls](../research/windows-ci-disk-stalls.md) gives the symptoms, evidence, and how to re-measure if they return. Isolation stays
load-bearing: each file runs in its own worker, so module-level helpers and environment changes never leak across files. Tests within each file remain
sequential; do not replace file parallelism with `--concurrent`, which would race their shared fixtures. Should child-lifecycle flakiness return, keep
the spawn out of the semantic suite — never a retry, sleep, or timeout increase.

Within a file, a timed-out test's after hook can run once the next test has started. A test that changes an environment variable therefore makes the
change through `setEnvironmentForTest` (`tests/helpers/environment.ts`), never its own save-and-restore hook: only the newest test's claim on a variable
owns its value, so a late cleanup leaves the next test's value in place. Its returned restore ends a change early. A change for a whole file, such as
`ensureRuntimeOnPath` putting the runtime on PATH, is already isolated by its worker and needs no claim.

Package smoke tests exercise the compiled binary in an isolated location on each of the three operating systems; every scenario is enumerated
once in [package smoke](./package-smoke.md), the CI acceptance seam for headless work.

Verifying each shipped release channel as a consumer receives it — the archive, platform-package, npm-launcher, and installer scenarios and their CI steps
— is its own concern; see [release-consumers.md](./release-consumers.md).

Test observable behavior through the same Interface callers use. Internal refactoring should not require test rewrites. When shallow Modules are
replaced by a deeper Module, replace their implementation-coupled tests rather than retaining both suites.

Use real deterministic in-process local resources, such as temporary directories and local databases. Under the test runner, reach child-process
behavior only through the injected Process double and use an injected Adapter for remote or truly external dependencies. Real children, child-backed
Git repositories, and recorded Harness programs belong only in standalone runtime conformance or compiled-binary acceptance. Keep internal test Seams
private to the Module's Implementation.

## Behavioral Completeness

Tests are the Module's executable specification. Cover every promised behavior, branch, and failure path — not every input permutation — and each
boundary where bugs cluster (empty, zero, maximum, first and last, absent). The bar: a plausible wrong edit to the logic must turn some test red, so
assert the consequence (the value, state, or output), never that code merely ran. Depth scales with blast radius — money, security, data-loss, and
validation paths carry the most, trivial glue a line; never test the framework or the compiler. Completeness is defensible, not total: name the
behaviors you deliberately leave untested and why. A silent gap is the failure; a reasoned one is not. A flaky test is not a net — if a behavior
cannot be asserted deterministically, that is a named gap, not a sleep or a retry.

## Fixture Ladder

- Test in-process behavior with ordinary real values.
- Use deterministic real substitutes for local resources.
- Use the injected Process double for executable resolution, commands, owned processes, cancellation, escalation, and Process-backed Git probes.
- Use injected Adapters for remote or third-party Seams.
- Give recorded external-protocol fixtures source and version provenance, redaction, representative data, and update instructions.
- When replacing a recording, explain meaningful behavioral or protocol changes on the implementing issue.
- Await observable readiness events, promises, probes, or bounded conditions instead of fixed sleeps.

## Release Evidence

The canonical gate runs on Windows, macOS, and Linux, and a release publishes only from CI behind a human-approved environment. Real-terminal and
real-Harness evidence that CI cannot produce is recorded per release; see [ADR 0027](../adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md).

## Recorded Harness Fixtures

- Recordings live under `tests/harness/fixtures/<harness>/<case>/` and stay byte-faithful; their metadata lives beside them in `recording.json`.
- `recording.json` names exactly `harness`, `executableVersion`, `protocolVersion`, `recordedAt`, `redactions`, and `refreshCommand`. The structural
  step fails a case directory without it, and a sidecar with a missing, extra, or invalid key.
- `recordedAt` is an ISO-8601 instant, or `"synthetic"` for a hand-authored case whose `refreshCommand` reads `synthetic -- <why>`. `redactions` lists
  one `{ placeholder, reason }` per substitution class. A Codex `protocolVersion` names the `codex-probe-<n>` revision it was recorded against.
- No byte in a case directory may still match a credential pattern after redaction.
- Refresh is an opt-in script that needs the installed Harness. An agent or a human may re-record; the implementing issue states what changed
  semantically.
