# Test runners

Read before changing how the semantic suite or standalone runtime conformance runs: the canonical test script, its workers and per-test timeout,
environment changes inside tests, or the runtime-conformance supervisor. [Testing](./testing.md) owns the evidence layers and fixture policy.

## Semantic suite

`bunfig.toml` records why the per-test timeout is a CLI `--timeout` flag rather than a `[test] timeout` key (that key applies only to `bun:test`, so
it never reaches these `node:test` tests).

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

## Standalone runtime conformance

- A supervisor parent (`tests/helpers/supervisor.ts`) runs the scenarios in one child process and enforces the 20-second bound from outside its event
  loop. The same bound applies from process spawn to the first scenario, between scenarios, and from the last scenario to program completion.
  A new scenario or gap starts a fresh bound; stage and child breadcrumbs never extend it. The scenario side
  (`scenario-runner.ts`) writes scenario, stage, and child-fact breadcrumbs synchronously to a breadcrumb file and the operational log.
  Every real Process takes `withRunnerObserver()`.
- A failure, timeout, or crash prints a last-active-stage summary: scenario (or program phase outside one), open stage, open child roles and PIDs
  (a blocking sync spawn has none yet), elapsed time, and the log folder (`SECANT_LOG_DIR`, else `secant-runner-logs` under the OS temp folder). The supervisor then kills
  the tree (each reported PID's group or tree, then the scenario's), removes the run's temp root, and resumes at the next scenario. Child facts
  outside scenarios are retained, including settlements of earlier children. A clean finish also kills and reports leftover children, with status 0
  if cleanup succeeds; the scenario process waits for that kill so Windows still has a live parent for tree traversal. Its fixtures
  are runtime cases (`supervisor-conformance.ts`). Terminal lifecycle runs the same scenario side unsupervised.
- M10 failure regressions select `--audit-runtime-failure-causes`: readiness under watcher exhaustion, synthetic worker EOF lifetime, and late zero-budget cleanup.
  The M10 exited-root fixtures use live sockets (`tests/helpers/lifetime-control.ts`) for readiness/release, preserving inherited pipes without acquiring
  filesystem watchers; the other exited-root fixtures, such as `escapedPipeHolder`, still wait on `fs.watch`.
- The temp root is the scenario's `TMPDIR` itself, one short name deep: on Windows the deepest Run Store paths sit within 13 characters of git's
  260-character limit, so a deeper root fails `matt-front-replayer-workbench` there.
