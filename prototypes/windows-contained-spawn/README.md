# Windows contained-spawn research prototype

This branch preserves the original runnable source for the Windows containment
decision. It is a research artifact kept outside `main`, not production code.
Retain the branch until the contained-spawn implementation has been built and
qualified, and any remaining historical value has been considered explicitly.

## Question and evidence

Can a native Windows process be placed in a kill-on-close Job Object that allows
no breakaway **at creation**, while its stdin, stdout, and stderr remain usable
as asynchronous streams by both Harness transports?

The experiment uses `bun:ffi` `CreateProcessW` with the job-list and handle-list
attributes, plus `node:net` named-pipe streams. The research found containment of
the escaped Git Bash descendants, functioning live Claude Code and Codex streams,
and cleanup after a parent crash. The preservation check on 2026-09-29 re-ran the
echo driver on Windows with Bun 1.4.2: `inJob true`, both input lines echoed,
stderr received, and the expected child exit code of 7 observed.

- [Containment decision](https://github.com/secantdev/secant/issues/259#issuecomment-5890689876)
- [Research follow-up](https://github.com/secantdev/secant/issues/258#issuecomment-5890209519)
- [Exact research note](https://github.com/secantdev/secant/blob/12d6c4974d2955f7a3f2f9d2d9a18f0d60b920c6/docs/research/windows-process-containment.md)

The five TypeScript files are byte-for-byte copies of the recorded experiment's
`secant258exp/stdio` source. `SOURCE-SHA256SUMS.txt` records their original hashes.
Session logs, process snapshots, generated shell scripts, and marker files are
excluded; the experiment drivers generate their own shell scripts when needed.
The archived sources are excluded from formatting and linting to preserve those
bytes; the README remains subject to the repository's formatting check.

## Retrieve from Ubuntu or Windows

```sh
git fetch origin prototype/issue-259-windows-contained-spawn
git show FETCH_HEAD:prototypes/windows-contained-spawn/stdio/contained-spawn.ts
```

For a separate checkout, without changing the current branch:

```sh
git worktree add --detach ../secant-windows-prototype FETCH_HEAD
```

The source can be read on Ubuntu. Execution requires Windows x64 and Bun; the
FFI layouts and `kernel32.dll` calls are Windows-specific. The original research
used Windows 11, Bun 1.4.2, Git for Windows 2.55.0, Claude Code 2.1.283, and Codex
0.155.0. Installing Secant's package dependencies is not needed for these files.

## Run the preserved drivers on Windows

From the checkout root:

```powershell
bun prototypes/windows-contained-spawn/stdio/t1-echo.ts
bun prototypes/windows-contained-spawn/stdio/t2-cases.ts volume
```

The first driver prints Job Object membership, echoed input, stderr, child exit
code, and event-loop ticks. The second should report 67,108,864 bytes received.

| File                       | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `stdio/contained-spawn.ts` | The at-creation Job Object and named-pipe call sequence    |
| `stdio/t1-echo.ts`         | Stdin/stdout/stderr round trip and exit observation        |
| `stdio/t2-cases.ts`        | `escape`, `volume`, and `crash` experiments                |
| `stdio/t3-dbg.ts`          | Throughput debugging driver                                |
| `stdio/t4-live.ts`         | Live Claude Code or Codex transport and descendant cleanup |

The `escape`, `crash`, and live-Harness modes retain the original hard-coded
scratch directory `C:/Users/rg/AppData/Local/Temp/secant258exp/stdio`. To reproduce
them on another Windows account, copy the source into a scratch directory and
adjust the `dir` constants in that scratch copy. The escape modes also expect
Git Bash at `C:/Program Files/Git/bin/bash.exe`. The source on this branch remains
unchanged so it can be compared with the original experiment.

After setting the scratch paths:

```powershell
bun prototypes/windows-contained-spawn/stdio/t2-cases.ts escape
bun prototypes/windows-contained-spawn/stdio/t2-cases.ts crash
bun prototypes/windows-contained-spawn/stdio/t4-live.ts claude
bun prototypes/windows-contained-spawn/stdio/t4-live.ts codex
```

For `crash`, the driver intentionally exits with code 3. Check after the script's
eight-second window that no `t2-end.marker` was written; the driver itself exits
before making that observation. For `escape`, it prints the post-stop process
snapshot and whether the marker appeared. Live modes require the installed,
authenticated Harness executables. The original Codex driver automatically
accepts incoming server requests; use a scratch Workspace for reproduction.

## Adoption limits

Preservation is not production qualification. The original source has a polling
exit wait, incomplete resource cleanup and error handling, fixed Windows layouts,
and no general argv, executable/shim resolution, or custom environment contract.
The full contained-spawn route still needs compiled-executable qualification.

Use the source as evidence and implementation input. Deliberately migrate the
required behavior into the Process Module under the engineering baseline; do
not import this prototype into production or merge the archive branch into
`main`. The decision also requires an informational fallback when containment
cannot be established, plus Harness-owned interruption and exact recovery.
