// The canonical test launcher: Bun's test runner with three isolated file workers
// on every OS (`--parallel=3`).
//
// Raising the worker count is safe because the semantic suite is spawn-free: every
// suite that reached a real child under the runner moved to standalone runtime
// conformance (the last two, the Claude Code and Codex Harness suites, in #198),
// so the Bun 1.4.2 child-lifecycle defect (#149, #150) can no longer fire. #172's
// three-worker rejection on the Windows runner was one run, attributed to that
// defect but never traced; its 30s timeouts are also the signature of the
// system-disk stalls below.
//
// Three workers remain the calibrated count. #274 traced intermittent Windows
// stalls to temp-file and SQLite writes on the runner's system disk. The Windows
// check job now routes TEMP/TMP under RUNNER_TEMP and fails if that path is on
// the system drive.
//
// File isolation stays load-bearing: each file runs in its own worker, so
// module-level helpers and environment changes never leak across files. Tests
// within a file remain sequential; do NOT use `--concurrent`, which would race
// their shared fixtures. Child-lifecycle flakiness is fixed by keeping spawns out
// of the semantic suite, never a retry, a sleep, or a larger timeout
// (docs/agents/testing.md).
//
// Extra arguments pass through, so `bun run test -- tests/foo.test.ts` still works.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["test", "--parallel=3", "--timeout", "30000", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
