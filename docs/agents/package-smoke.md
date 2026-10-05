# Package Smoke

Read this before changing `scripts/package-smoke.ts` or a scenario it runs. This is the one home for the smoke enumeration; the
[support matrix](../support-matrix.md), [testing](./testing.md), and the workflow point here rather than restating it.

The smoke copies the produced Bun compiled single-file executable out of `dist/` into an isolated temporary location and exercises it there. It is
the CI acceptance seam for headless work and invokes no real Harness: recorded replayers stand in on a temporary `PATH`. It runs twice per operating
system in [check.yml](../../.github/workflows/check.yml): the per-OS `check` job's `Compiled-binary smoke` step (`bun run test:package`, part of
`bun run check`, against the binary that job just built) and the `consumer` job's `Compiled-binary smoke` step against the cross-compiled candidate
binary downloaded from the Linux `build` job. Every scenario below runs on Windows x64, macOS arm64, and Linux x64 unless it names its platform.

## Scenarios, in run order

- **compiled-binary-interface**: the copied binary answers `--help` and `--version` exactly (on macOS after `codesign --verify --deep --strict`), and an
  unknown command or flag exits non-zero with usage before any composition wiring (#72).
- **relocated-pre-drizzle-home**: the checked-in pre-Drizzle fixture relocated beneath the isolated install, proving the binary migrates and opens it
  through its embedded migration registries. Each database's recorded migration count must exactly match its declared journal, including Catalog Preferences (#343).
- **workspace-catalog**: `workspace approve` then `workspace --json` reports the approved, realpath-canonical directory.
- **harness-catalog-headless**: with both replayers on `PATH`, `harness list --json` and `harness inspect codex --json` render the `harness-catalog`
  family with `not-checked` qualification.
- **install-and-catalog**: the Proof Bundle built with `--no-install --output` (a written file is the standing zero-error Composition assertion on each
  OS), installed, re-installed as already installed at the equal digest, and listed.
- **malformed-bundle-import** (#383): ordinary ZIP bytes with an aliased asset path or an undeclared file are refused by `bundle install`,
  naming the finding, leaving no Catalog entry, managed archive, or partial asset tree on any OS.
- **two-harness-proof-bundle** (#149): the installed Test Repair Proof Bundle run headlessly through the recorded Claude Code and Codex replayers in
  two fresh Workspaces differing only in `--harness`; each enters one repair iteration, passes its Verdict, and the authored approve-commit gate keeps
  Git unchanged until a separate `run answer --continue` succeeds and commits. Different effective models prove both Adapters were driven. Each launch
  names no model, so it qualifies first: the Codex replayer serves the `codex-qualification` recording to that session and the Test Repair recording,
  whose `turn/start` requests the reported default, to the Run's (#342).
- **headless-model-choice** (#342): `run launch --model --effort` through each replayer rests at the Proof Bundle's gate, and `run show --json` reports
  the Run's `modelChoice` and every `turn-started` entry's requested model and effort. Each launch names a value its preselection would not choose
  (Codex qualifies against `codex-qualification-unconfigured`), and the strict Codex replay proves both on `turn/start`. Claude refuses a contradicting
  effort under `CLAUDE_CODE_EFFORT_LEVEL=xhigh`, launches explicitly and flaglessly at that lock, and records observed effort in JSON (#347).
  `run model` changes each idle gate's Run; a later `run show --json` reports the new choice while earlier Turns retain their requested values (#344).
- **install-collision**: a byte-different same-identity archive is rejected as `bundle-identity-collision` (first-install-wins).
- **run-refusals** (#82): `run show` on an unknown id and `run launch` on an uninstalled Bundle exit non-zero with `run-not-found` and
  `bundle-not-installed` before any Run directory exists.
- **headless-refusal-fixtures** and **preflight-refusals** (#83, #116): a built-and-installed interactive-agent Bundle is refused with
  `interactive-step-needs-tui` and a Git-guarded Command Bundle with `git-worktree-root`, both ahead of the Trust gate. A hand-packed,
  strict-valid Bundle with a floor above `package.json`'s version installs untrusted; the versioned binary refuses its launch with
  "needs Secant ≥ x.y" before asking for Trust (#367).
- **shipped-bundles-embedded**: this OS's binary rebuilds each allow-listed folder to its `bundles/builtin.lock.json` digest and embeds those exact
  bytes, and not the External Proof Bundle's.
- **shipped-bundles-startup** (#227): a fresh home's first startup installs exactly the locked built-ins with origin `built-in` and app-release trust, a
  second startup changes no Catalog row, a byte-different import collides naming the built-in, the historical source-CLI-seeded Matt 2.7.0 remains beside 2.8.0
  after first and second startup, another version installs beside it, and a home whose
  built-in identity is already held (seeded through the source CLI) gets a stderr notice while the command succeeds.
- **matt-front-refusal**: the built-in the startup ensure installed, refused headlessly with `interactive-step-needs-tui` and its remediation.
- **launch-preparation-headless** (#189): a not-ready draft (missing input, untrusted digest) `run launch` prints every finding in text and JSON,
  exits one, and creates no Run.
- **workspace-materialization** (#88): a `home: workspace` text Artifact is materialized to its declared path; a middle Step modifies that copy; the
  next Step's byte-for-byte verify rests the Run `halted` with the conflict `run show` names; restoring the file and `run resume` continues it.
- **durable-human-gate** (#85): a Repeat group blocks at its Review checkpoint under one invocation; a second invocation answers `--continue` and the
  granted interval reaches the pass, so the answer survived process death as a durable Artifact.
- **run-list-and-delete**: listing Previous Runs over `bundle-catalog`/`run-list`, refusing to cancel a resting Run, and deleting a Run's store.
- **signal-halt-then-resume**: a Run interrupted by SIGINT mid-execution rests `halted` (POSIX aborts the live Run and leaves the claim live;
  Windows SIGINT terminates and leaves the same claim), and a later `resume` completes it.
- **posix-exited-root-cleanup** (#387, Linux and macOS): an ordinary Command's root exits 17 while a descendant holds inherited output pipes and ignores
  SIGTERM. SIGINT to the copied binary forces descendant cleanup under an independent parent bound; the operational log records one `reap` with status 17,
  the descendant is dead, and the reopened Run retains its captured output and `fail` Verdict. Fixture failure cleanup uses a release-file handshake.
- **owner-death-recovery** (#86): a Run whose owner is killed by SIGKILL, uncatchable, so the claim is left live at a now-dead pid, is reconciled
  `halted` by a later invocation running no Step work, and a plain `resume` (no `--takeover`) recovers it to `succeeded`, re-running no earlier Step.
  This is the one compiled-binary home for owner death; the process-free suite never spawns.
- **command-gate** (#89, the M2 gate): the maintained Command-only gate Bundle built, installed, and run to completion; its Repeat check fails twice and
  passes on the third iteration with a Review interval of two, so the Run blocks exactly once, and the `git-worktree-root` probe runs the real Git from
  the binary. Nothing in target source knows this Bundle exists.
- **repeat-command-gate-progress** (#384): an ordinary Command-only Bundle (failing baseline, Repeat passing first Iteration, outside Command, Gate,
  final Command) rests at its stored Gate and Offer on launch and a later `run show --json`; `run answer --continue` succeeds; each Command ran once.
- **windows-cmd-shim**: a Command naming an npm-style `.cmd` shim resolves through the shim, while a broken shim is refused at Preflight (POSIX has no
  shim, so it is skipped there).
- **windows-app-execution-alias**: when the runner exposes a `pwsh` or `winget` alias that `where.exe` finds after the primary PATH walk misses, a
  Command naming it passes Preflight and runs; a runner without such an alias records the reasoned gap.
- **no-interactive-terminal** (#55): with piped stdio the TUI launch rejects with the `no-interactive-terminal` Problem before any renderer exists.
- **operational-log** (#318, #323): sets an isolated `SECANT_LOG_DIR`, as does the POSIX root-lifetime proof. `--help`, `--version`, and a parse error
  write no log; a successful and a refused headless command each write one valid JSONL file with matching start and end records (Secant invocation id,
  client, version, platform, exit status, elapsed time), the approval's Operation admission and outcome sharing one id (#319), and no trace of a seeded environment value or
  argument; a Secant home that is a file fails fatally, flushes its failure record, and names the file on stderr; the no-TTY TUI launch is logged as a
  `tui` Secant invocation; and startup removes a file last written 31 days ago while retaining a 10-day-old file, unrelated files in the override
  folder, and a matching old file outside it. A two-Command Run launched with `SECANT_LOG_DETAIL` unset and then `1` (#325) adds only `debug`
  Preflight-check and store-write records, keeps every other record's order, and prints each mode's bytes per record kind. `homeEnv` strips a
  runner's `SECANT_LOG_DETAIL`, so only this scenario sets it.
