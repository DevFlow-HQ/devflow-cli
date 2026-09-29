# Windows Process Containment

Research date: 2026-09-29

Versions examined, on Windows 11 Home 10.0.26200 (x64):

- Bun **1.4.2**, which vendors libuv from
  [`oven-sh/libuv@8023581`](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/process.c)
  ([`scripts/build/deps/libuv.ts` line 28](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/scripts/build/deps/libuv.ts#L28)
  at `bun-v1.4.2`).
- Git for Windows **2.55.0.windows.3**: GNU bash 5.3.15 on the MSYS runtime **3.6.9** (`uname -a`:
  `MSYS_NT-10.0-26200 … 3.6.9-b4195d69.x86_64`).
- Claude Code **2.1.283**, the WinGet native executable.
- Codex **codex-cli 0.155.0**, the standalone build. Source is cited at its release tag,
  `rust-v0.155.0` ([`f0a1b8f`](https://github.com/openai/codex/tree/f0a1b8f0849d90960bc406b848f32e5a129b0457)).
- T3 Code at [`d2c9281`](https://github.com/pingdotgg/t3code/tree/d2c9281b8112dc3b2991642c4bdb985e4b08b9bb) and
  OpenCode at [`b3f1a96`](https://github.com/anomalyco/opencode/tree/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b).

Ticket: [#258](https://github.com/secantdev/secant/issues/258). It follows
[Windows Live Interrupt and Steer](windows-live-interrupt-and-steer.md) (#255). That note found that a script run by
Claude Code's Bash tool through Git Bash has a dead Windows parent pid, and survives both Claude Code's own
`taskkill /PID <shell> /T /F` and Secant's `taskkill /T /F`. The decision on containment belongs to #259. This note
records facts only. A follow-up pass on 2026-09-29 (same machine and versions) closed the original "Still Unknown" list
by live experiment; those results are folded into the sections below and the drivers are described in the Method.

## Answer

**C1. Git Bash starts every MSYS program outside the Windows parent tree when it forks and then execs.** `taskkill /T`
walks only live parent links, so it cannot reach that program or anything under it. The process's Windows parent is the
fork child, which exits as soon as the exec succeeds. Driven the way Claude Code drives its tool shell
(`Git\bin\bash.exe -c "eval '<cmd>' < /dev/null && …"`), `taskkill /T /F` on the root left these alive:

- a script (`./x.sh`, `bash x.sh`, `sh x.sh`) and everything it started;
- `bash -c '…'`;
- a bare MSYS utility (`sleep`);
- an MSYS pipe stage (`… | cat`, `… | tee file`);
- an MSYS stage of `xargs` and `find -exec`;
- the MSYS `sleep` inside `npm run`, `npx -c`, and `bun run` of a script (the launcher `node`/`bun` has a live parent and
  dies; the MSYS leaf escapes);
- a backgrounded MSYS job (`… &`, `nohup … &`, `… & disown`), where the root bash exits at once and the detached leaf is
  left behind.

These were killed:

- a native command (`ping`, `bun`, `powershell`, `cmd`);
- a pipeline or subshell of native commands;
- `cmd & wait`;
- `exec ./x.sh` from the top-level shell.

The single-run C1 cases in the first pass were re-run three times each in the follow-up, plus the new MSYS paths above
(three runs each). Every escape was reproducible. `setsid` and `make` are not present in this Git for Windows
(`command not found`), so they could not be run. The MSYS source matches this: on `exec`, the old process stays behind to
wait only when the target is not an MSYS program, or when the process has no MSYS parent; otherwise it exits.

**C2. A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and no breakaway limit, reaches all of them.** It was
assigned to the root right after `spawn()` returned. Every escaped process above — including each new MSYS path and every
backgrounded leaf — was a member of the job (`IsProcessInJob`), dead parent and all, and `CloseHandle` or
`TerminateJobObject` killed every one, with no survivor in any case (three runs each for the new paths, 15/15 in the first
pass).

The job must not allow breakaway. The MSYS runtime adds `CREATE_BREAKAWAY_FROM_JOB` to every spawn when its immediate job
has `BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK`. With either flag, the Git Bash processes left the job and survived it. A
process that requests breakaway from a job that forbids it does not silently escape: `CreateProcess` fails with
`ERROR_ACCESS_DENIED` (5) — observed for every probe spawned under a Secant-style no-breakaway job and for Codex's own
MCP job (C7).

**C3. Bun has no built-in way to create a job or to spawn suspended, but the assign-after-spawn window did not expose a
descendant in practice.** `bun:ffi` against `kernel32.dll` works; four calls are enough (`CreateJobObjectW`,
`SetInformationJobObject`, `AssignProcessToJobObject`, and `TerminateJobObject` or `CloseHandle`), inside a
`bun build --compile` executable too. Assigning after `spawn()` returns leaves a window in which the child runs outside the
job. Measured over 20 launches each of the real `claude.exe` and `codex.exe`, spawned the way `src/process/process.ts`
spawns them, the assignment landed 56–224 µs after `spawn()` returned, and **no non-`conhost` descendant was created
before the assignment, and none escaped the job** (0/20 for each Harness). `claude.exe`'s first real child (`reg.exe`)
appeared 42–82 ms after the assignment, its Git/Bash tool children hundreds of ms later; `codex.exe` produced only its
`conhost` before the app-server handshake. The only early sibling is the system-created `conhost.exe`, which is never a job
member by design.

The window can be closed from `bun:ffi` while Secant keeps ordinary streams for the child's stdio. A self-rolled
`CreateProcessW` with `PROC_THREAD_ATTRIBUTE_JOB_LIST` puts the child in the job at creation, before its first
instruction. `CREATE_SUSPENDED`, then assign, then `ResumeThread` also works. For stdio, Bun's own `node:net` listens on
a named pipe for each stream, and the child inherits a client end opened with `CreateFileW`. Secant then reads and writes
`net.Socket` streams on libuv's async I/O, with no thread and no polling. That prototype carried the Claude Code
stream-json and Codex app-server protocols live, and a job kill ended each Harness and every tool descendant (3 of 3 for
each). It survived a parent crash and moved 64 MiB in 70–86 ms. The anonymous-pipe route fails: CRT fds from
`ucrtbase` `_open_osfhandle` are not Bun fds (`EBADF`).

**C4. Codex on Windows contains a command in a per-command Job Object, and this holds under the user's Windows sandbox.**
Driven the way Secant drives it — `thread/start` with `cwd` only, so the user's `~/.codex/config.toml` governs — the
acknowledged policy is `approvalPolicy: "on-request"` and, for a `cwd` the config trusts, `sandbox: workspaceWrite`
(a `cwd` the config does not trust acknowledges `readOnly`). The sandboxed command runs under a **restricted token** as the
same user at medium integrity, and Codex still puts it in a per-command job `KILL_ON_JOB_CLOSE | BREAKAWAY_OK` owned by
`codex.exe`. `turn/interrupt` ends the Turn `interrupted` and leaves the sandboxed command tree running (3/3);
`thread/backgroundTerminals/clean` and the app-server's exit both stop it (3/3). An outer Secant-style no-breakaway job
still contains the sandboxed tree — every process reported `IsProcessInJob(secantJob) = true` despite the restricted
token (assignment and nesting succeed because it is the same user), and `TerminateJobObject` on the outer job killed the
whole tree (3/3). **Git Bash cannot run at all under Codex's `workspace-write` sandbox**: the MSYS runtime aborts before
`main` with `fatal error - couldn't create signal pipe` / `CreateFileMapping … Win32 error 5`, because the restricted
token denies the shared section MSYS needs; the fork-and-exec escape therefore never arises under the sandbox, only native
commands (`cmd`, `pwsh`, `PING`) run there.

`turn/interrupt` not stopping the command, and the escape of a pipe-mode Git Bash script past Codex's `BREAKAWAY_OK` job,
are unchanged from the first pass. The two follow-up questions are now answered:

- **PTY-mode kill is the pseudoconsole closing, not the job.** Under a PTY, Codex's job holds only `pwsh`, the launcher
  `bash`, and `usr\bin\bash` (n=3); the dead-parent script and its `PING` broke away and are **not** job members. Killing
  the headless `conhost.exe` pseudoconsole host alone left the escaped script and `PING` running (3/3); terminating Codex's
  own job — which kills `pwsh`, the pseudoconsole's owner — killed the escaped script and `PING` too (3/3). So the escaped
  tree dies because `pwsh`'s exit closes the pseudoconsole, and the app-server's exit ends `pwsh` the same way.
- **The stdin-close stall is an inherited pipe waiting for EOF.** In pipe mode the escaped script inherits the command's
  stdout/stderr write handles; Codex's app-server keeps a reader that awaits the stdout/stderr read tasks, each looping
  until `read()` returns `Ok(0)` (**Source-observed**,
  [`utils/pty/src/pipe.rs` lines 109-122](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/pipe.rs#L109-L122)
  and [261-268](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/pipe.rs#L261-L268)).
  With the escaped script holding the pipe open, EOF never comes: the app-server exited 21.0–21.1 s after stdin close —
  exactly when the 30-ping script finished and released the pipe — and the script ran to completion (3/3). A script that
  first closes its own stdio (`exec </dev/null >/dev/null 2>&1`) releases the pipe, and the app-server then exited in
  58–89 ms while the script kept running detached (3/3). On a normal root exit Codex also calls `preserve_descendants()`
  (**Source-observed**, [`pipe.rs` line 285](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/pipe.rs#L285)),
  deliberately keeping the tree.

**C5. What the guides do.**

- Codex contains commands in Job Objects: attached at `CreateProcess` for a PTY, assigned after spawn for pipes. Each
  stdio MCP server and each sandboxed command sit in their own job (C4, C7).
- Claude Code (inferred from strings in its binary), OpenCode, and T3 Code stop trees with `taskkill /T /F`, and none of
  them uses a Job Object for tool or Harness processes.
- Claude Code puts no job of its own around tool commands. Seen from inside, a Bash-tool command sat in a job outside
  Claude Code's tree, and a PowerShell-tool command sat in the job its host already had.

**C6. Claude Code still runs `taskkill /T /F` on the tool shell on a raw interrupt; the fork-and-exec escape defeats it.**
The binary string that skips a kill when the abort reason is `"interrupt"` belongs to the live-shell wrapper's own
`kill()`, not to the tree kill: `#T(){let e=Ci(this.#i.reason);if(e==="interrupt"||wJt(e,this.#u))return;this.kill()}`
(**Binary-observed**). Traced live, the stream-json `control_request` `interrupt` (ADR 0035's wire) still fires
`C:\WINDOWS\System32\taskkill.exe /PID <tool-shell> /T /F` — a fast toolhelp watcher caught two such invocations per
interrupt, parented by `claude.exe`, in every run (3/3) — and the escaped script survived and ran to completion anyway.
A SIGTERM of `claude.exe`, a `taskkill /PID <claude> /F` (no `/T`), and a plain stdin close issue no `taskkill` at all
(`claude.exe` dies first) and likewise leave the escaped script running to completion (3/3 each). So the two kill paths
coexist: the interrupt keeps the tree kill, and the tree kill is what the escape defeats.

**C7. A Secant-style no-breakaway job ends the processes a Harness deliberately detaches, and denies a Harness's own
breakaway.**

- **Claude Code background Bash (`run_in_background`).** The background script escapes the tool tree (dead parent) and,
  with no Secant job, outlives `claude.exe` and runs to completion (2/2). Under a Secant `KILL_ON_JOB_CLOSE` job the whole
  background tree is a job member, and closing the job after `claude.exe` exits kills it mid-run — the start marker was
  written but never the done marker (2/2).
- **Claude Code stdio MCP server.** Launched by `claude.exe` through `bun`, it is a direct child inside the Secant job; its
  own libuv job nests within. A child it spawns with `CREATE_BREAKAWAY_FROM_JOB` succeeds but still lands inside the Secant
  job, because breakaway stops at the first job that forbids it (3/3).
- **Codex stdio MCP server.** Codex puts each MCP server in its own no-breakaway job (`KILL_ON_JOB_CLOSE`,
  `create_without_breakaway`, **Source-observed**), inside the Secant job when present. A child it spawns with
  `CREATE_BREAKAWAY_FROM_JOB` fails with `ERROR_ACCESS_DENIED` (5), 3/3. **This is the answer to whether a Secant
  no-breakaway job would break a Harness that must launch something detached: yes — the detaching spawn fails with error 5.** Codex already tolerates this: its own no-breakaway MCP path treats a rejected job assignment as a fallback and
  re-spawns uncontained
  ([`rmcp-client/src/stdio_server_launcher.rs` lines 324-343](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L324-L343)).
- **Codex background terminals.** Contained in the Secant job when present (`IsProcessInJob` true), and killed by
  `TerminateJobObject` on the outer job (C4).
- **Secant's own planned loopback MCP** is not built; noted only. As a direct child of the Secant process it would be a
  member of the same job and end on job close like any other member.

## Evidence Vocabulary

- **Observed**: seen in process tables, job queries, marker files, or Harness frames captured for this note on 2026-09-29
  against the versions above. Every fact without another label is Observed.
- **Source-observed**: read in the named source at the cited commit.
- **Doc**: stated by Microsoft Learn or Bun's documentation.
- **Binary-observed**: found in the strings of the installed executable, which is closed source.
- **Inferred**: a consequence drawn from the above that needs a check before it becomes a compatibility promise.

## Method

The drivers were small Bun 1.4.2 scripts. They and every raw log stayed in the session scratchpad, outside the
repository. The first pass used the drivers described here; the 2026-09-29 follow-up added drivers that launch the real
`claude.exe` and `codex.exe` the way Secant does, poll the process tree with a toolhelp snapshot, and enumerate every
Job Object via the system handle table.

- **Spawning.** Children were spawned as `src/process/process.ts` spawns an owned process on win32 (**Source-observed**,
  `spawnOwnedProcessWithNode`): `node:child_process` `spawn`, `windowsHide: true`, `detached: false`, overlapped pipes.
- **Process tables.** Taken with `Get-CimInstance Win32_Process`; the fast follow-up watcher used
  `CreateToolhelp32Snapshot` plus `NtQueryInformationProcess(ProcessCommandLineInformation)` for command lines, polling
  every ~4.6 ms.
- **Job queries.** A `bun:ffi` binding to `kernel32.dll`, `ntdll.dll`, `kernelbase.dll`, and `advapi32.dll` made these
  calls: `IsProcessInJob` for membership; `QueryInformationJobObject` for limit flags and member pids;
  `NtQuerySystemInformation(SystemHandleInformation)` + `DuplicateHandle` + `CompareObjectHandles` to enumerate every job
  the caller can duplicate a handle to and print a process's full job chain; `OpenProcessToken` + `IsTokenRestricted` and
  the token integrity SID for the sandbox check; `GetProcessTimes` and `GetSystemTimePreciseAsFileTime` for the
  assign-after-spawn timing.
- **Test job.** `CreateJobObjectW`, `SetInformationJobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (and, where a run
  says so, a breakaway flag), then `AssignProcessToJobObject`.
- **Real Harness launches.** `claude.exe` with the #255 stream-json flags (`--model haiku`, a per-Run `--session-id`, and
  the allow-list for the case); Codex `app-server` with the qualification handshake, `thread/start { cwd }` only unless a
  run notes `approvalPolicy`/`sandbox`, and `turn/start` on `gpt-6-luna` at `effort: "low"`. `CLAUDE*`, `ORCA_*`, and
  `CODEX_HOME` were stripped so the user's real config applied.
- **Test processes.** Each carried a marker (an address such as `127.0.0.58`/`127.0.0.59`/`127.0.0.61`, a duration such as
  `25.7`, or a script name) so escaped processes could be found by command line, and each driver killed every survivor by
  pid and verified none remained.
- **Contained spawn.** A third set of drivers launched the children through the `bun:ffi` `CreateProcessW` prototype
  described in C3, not through Bun's spawn.
- **Hygiene.** A final process-table sweep after all runs found no marker process and no stray `claude`/`codex`/`bash`
  from the runs.

The agent shell these drivers ran in was itself inside a job with breakaway, and a process that breaks away with
`CREATE_BREAKAWAY_FROM_JOB` lands in an anonymous job whose handle the handle-table walk cannot match to a named owner.
So `IsProcessInJob(NULL)` is `true` for every process below, and membership in a _named or owned_ job — the test job, a
Harness job, or the Secant job — is what tells the cases apart. On this machine the follow-up drivers themselves ran under
a WinGet/WMI-launched `claude.exe` host rather than the first pass's Orca host, which changes the outer job owners in the
chain maps but not any containment result.

## C1: Which Git Bash commands escape `taskkill /T`

Each case spawned `C:\Program Files\Git\bin\bash.exe -c "eval '<cmd>' < /dev/null && pwd -P > /dev/null"`. That is the
shape of Claude Code's Bash-tool invocation, which the #255 note captured as `Git\bin\bash.exe -c "source <snapshot> … &&
eval '<cmd>' …"`. The trailing `&& …` stops bash from exec'ing the last command in place. After 2.5–4 s the driver ran
`taskkill /pid <root> /T /F`, waited, and listed survivors.

| Case                                      | Tree before the kill                                                  | Survivors of `taskkill /T /F` |
| ----------------------------------------- | --------------------------------------------------------------------- | ----------------------------- |
| `ping -n 26 127.0.0.58`                   | launcher → `usr\bin\bash` → bash (fork) → `PING`                      | none                          |
| `sleep 25.8`                              | launcher → `usr\bin\bash`; `sleep.exe` (parent **dead**)              | `sleep.exe`                   |
| `./slow258.sh`                            | launcher → bash; script bash (parent **dead**) → bash (fork) → `PING` | script bash, fork, `PING`     |
| `bash slow258.sh`                         | same as `./slow258.sh`                                                | script bash, fork, `PING`     |
| `sh slow258.sh`                           | same, with `sh.exe`                                                   | both `sh.exe`, `PING`         |
| `bash -c 'ping …'`                        | launcher → bash; inner bash (parent **dead**) → `PING`                | inner bash, `PING`            |
| `ping … \| cat`                           | unbroken chain to `PING`                                              | none (`PING`); `cat` escapes  |
| `ping … \| tee file`                      | chain to `PING`; `tee` (parent **dead**)                              | `tee` (exits on `PING` EOF)   |
| `(ping …; true)`                          | unbroken chain (subshell fork) to `PING`                              | none                          |
| `ping … & wait`                           | unbroken chain to `PING`                                              | none                          |
| `sleep 25.7 &` / `nohup … &` / `& disown` | root bash exits; `sleep.exe` (parent **dead**)                        | `sleep.exe`                   |
| `echo 25.7 \| xargs sleep`                | launcher → bash; `sleep.exe` (parent **dead**)                        | `sleep.exe`                   |
| `find . -maxdepth 0 -exec sleep …`        | launcher → bash; `find`, `sleep` (parents **dead**)                   | `find.exe`, `sleep.exe`       |
| `npm run <sh script>` / `npx -c 'sh …'`   | bash → node → cmd → sh; `sleep.exe` (parent **dead**)                 | `sh.exe`… , `sleep.exe`       |
| `bun run <sh script>`                     | bash → bun → sh; `sleep.exe` (parent **dead**)                        | `sleep.exe`                   |
| `exec ./slow258.sh`                       | top bash → script bash (parent **alive**) → fork → `PING`             | none                          |
| `bun -e 'setTimeout(…)'`                  | unbroken chain to `bun.exe`                                           | none                          |
| `powershell.exe -File x.ps1`              | unbroken chain to `powershell.exe` → `PING`                           | none                          |
| `cmd //c 'ping …'`                        | unbroken chain to `cmd.exe` → `PING`                                  | none                          |

The first eleven rows of the first pass ran once each; the follow-up re-ran the escaping cases and the new MSYS paths three
times each, all identical. `setsid` and `make` are not installed (`command not found`). The `| cat` stage was still not
captured directly (an escaped `cat` carries no marker), but `| tee file` — which does — escaped the `taskkill` with a dead
parent and then exited on its own when `PING` closed the pipe.

- **The pattern.** A process escapes when an MSYS process forks and the fork child then execs another MSYS program: bash,
  sh, or a utility in `usr\bin`. That program's Windows parent is the fork child, which has already exited. A native
  target keeps a live parent, as does `exec` from the top-level shell. Everything under an escaped process escapes too.

### Why the parent pid is dead (Source-observed)

- **The exec path.** In the MSYS runtime
  ([`winsup/cygwin/spawn.cc` at `msys2-3.6.10` `3ea87a5`](https://github.com/msys2/msys2-runtime/blob/3ea87a506e64e841dc0b8ee50ed61999c8fed26c/winsup/cygwin/spawn.cc)),
  `exec` is `_P_OVERLAY`, and a new Windows process is created for the target. For an MSYS target the old process leaves
  through `myself.exit (EXITCODE_NOSET)` (lines 892-929); it waits (`wait_for_myself ()`) only when it has no MSYS parent
  (lines 905-908). For a non-MSYS target the process is synced and waited on (lines 884-887). A fork child always has an
  MSYS parent, so after exec'ing an MSYS program it exits and the new process's Windows parent is gone.
- **The runtime also breaks away from jobs.** The same function adds `CREATE_BREAKAWAY_FROM_JOB` whenever `IsProcessInJob`
  is true and the immediate job has `JOB_OBJECT_LIMIT_BREAKAWAY_OK` or `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`
  ([lines 435-473](https://github.com/msys2/msys2-runtime/blob/3ea87a506e64e841dc0b8ee50ed61999c8fed26c/winsup/cygwin/spawn.cc#L435-L473)),
  naming a Program Compatibility Assistant memory issue as the reason. `fork.cc` adds no such flag. So an MSYS **exec or
  spawn** leaves any breakaway-permitting job, and a **fork** stays in the job.

## C2: A kill-on-close Job Object

### Every case from C1, under a job without breakaway

The C1 cases — the original 15 and the new MSYS paths — were repeated with a job holding only `KILL_ON_JOB_CLOSE`,
assigned to the root 0.04 to 0.16 ms after `spawn()` returned. At the stop the driver called `CloseHandle(job)` (and, for
a few cases, `TerminateJobObject` first).

- **Nothing survived.** Every escaped process — every MSYS leaf, every `xargs`/`find`/`npm`/`npx`/`bun run` stage, every
  backgrounded `&`/`nohup`/`disown` leaf, the `tee` stage — was a member of the job, and closing its last handle killed
  every case (three runs each for the new paths, 15/15 in the first pass, 0 survivors throughout).
- **Job membership does not depend on parent links.** A child joins its creator's job at creation, whether or not its
  creator is still alive (**Doc**,
  [`AssignProcessToJobObject`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)).

### The same cases under a job that allows breakaway

| Job limit flags                            | `sleep`                                | `./slow258.sh`                                | `ping` (native)                    |
| ------------------------------------------ | -------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `KILL_ON_JOB_CLOSE`                        | in job; killed                         | in job; killed                                | in job; killed                     |
| `KILL_ON_JOB_CLOSE \| BREAKAWAY_OK`        | **not in job; survived**               | **not in job; script, fork, `PING` survived** | **`PING` not in job; survived**    |
| `KILL_ON_JOB_CLOSE \| SILENT_BREAKAWAY_OK` | only the launcher in job; **survived** | only the launcher in job; **survived**        | only the launcher in job; survived |

- **With `BREAKAWAY_OK`, MSYS children left the job** via the `CREATE_BREAKAWAY_FROM_JOB` path in `spawn.cc`. **With
  `SILENT_BREAKAWAY_OK`, only the assigned root is in the job.** A process that requests breakaway from a job that forbids
  it does not escape: `CreateProcess` returns `ERROR_ACCESS_DENIED` (5) — see C7.

### `CLAUDE_CODE_GIT_BASH_PATH` and a different bash

Pointing `CLAUDE_CODE_GIT_BASH_PATH` at Git's `usr\bin\bash.exe` instead of the default `bin\bash.exe` did not change the
escape: the Bash-tool script still forks-and-execs and survived both `taskkill /T /F` and the raw interrupt (script ran to
completion 3/3), and a Secant no-breakaway job still contained it (`TerminateJobObject` left no done marker). Running
`usr\bin\bash.exe` directly as the tool-shell root (with Git's `usr\bin` prepended to `PATH`, which the `bin\bash.exe`
launcher normally supplies) reproduced the same escape and the same job containment (three runs each, taskkill and job).
WSL bash is not installed on this machine (`wsl --status`: "not installed"), so a non-MSYS bash could not be compared, and
only Claude Code 2.1.283 is installed.

### The job chain above a tool command

With no Secant job, a Claude Code Bash-tool shell sits in Claude Code's libuv job
`KILL_ON_JOB_CLOSE | BREAKAWAY_OK | SILENT_BREAKAWAY_OK | DIE_ON_UNHANDLED_EXCEPTION` owned by `claude.exe`, which nests
under the outer host jobs; the escaped script itself, having broken away, is in no named job (only the anonymous
breakaway-target job the Method describes). With a Secant `KILL_ON_JOB_CLOSE` job assigned to `claude.exe`, the tool
shell and every descendant report membership in that job, and the tool command's own immediate job becomes the Secant job
(the probe read `jobFlags = KILL_ON_JOB_CLOSE`, ~5-6 members): breakaway climbs the chain until it reaches the
no-breakaway job and stops (**Doc**,
[Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)). Codex's command sits in its own
per-command job owned by `codex.exe` (`KILL_ON_JOB_CLOSE | BREAKAWAY_OK`), attached at creation for a PTY and after spawn
for pipes.

## C3: How Bun can create the job, and the assign-after-spawn window

### What Bun already does

- Every non-detached child of `node:child_process` / `Bun.spawn` is assigned to libuv's global job
  (`KILL_ON_JOB_CLOSE | BREAKAWAY_OK | SILENT_BREAKAWAY_OK | DIE_ON_UNHANDLED_EXCEPTION`) after `CreateProcessW`
  (**Source-observed**, `oven-sh/libuv@8023581` `src/win/process.c` lines 93-96, 1128-1130). Only a detached child gets
  `CREATE_SUSPENDED` (lines 1106-1107). So libuv's job does not contain the tree: its `BREAKAWAY_OK` lets MSYS children
  leave, and it kills only the direct child when Secant exits.

### The window, measured

Assigning after `spawn()` returns leaves a window Microsoft describes. Measured over 20 launches each of the real
Harnesses spawned as `src/process/process.ts` does:

- `claude.exe`: `spawn()` → `AssignProcessToJobObject` returned in 62–224 µs; the child was created 6.8–11.3 ms before the
  assignment (Bun spawns, then we assign). **0 of 20** runs created a non-`conhost` descendant before the assignment, and
  **0 of 20** left a non-`conhost` descendant outside the job. The first real child (`reg.exe`) appeared 42–82 ms after
  the assignment; Git/Bash tool children hundreds of ms later; nested `claude.exe` subagents ~1 s.
- `codex.exe`: assignment in 56–160 µs; only its system `conhost` appeared early, never before the assignment (0/20).

The only early sibling is the system-created `conhost.exe`, which is not a job member by design and disappears with its
clients. **Inferred**: on this machine the window is real but never populated, because both Harnesses' first descendant is
tens of milliseconds out; a Harness that forked a descendant within the first ~0.2 ms would be the exposing case, and
neither does.

### A contained spawn with streamed stdio

A scratch prototype, `spawnContained(commandLine, cwd)`, made these calls in this order:

1. **Job.** `CreateJobObjectW`, then `SetInformationJobObject` with only `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no
   breakaway flag.
2. **Stdio.** For each of stdin, stdout, and stderr, `node:net` `createServer().listen("\\.\pipe\secant-<pid>-<uuid>")`.
   Then `CreateFileW` on that name opens an inheritable client handle. Stdin gets `GENERIC_READ | FILE_WRITE_ATTRIBUTES`,
   and stdout and stderr get `GENERIC_WRITE | FILE_READ_ATTRIBUTES`, which are the access rights libuv gives a child's
   pipes. The server accepts that one connection and closes, so nothing else can connect. The accepted `net.Socket` is the
   stream Secant reads or writes.
3. **Attribute list.** `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` names exactly the three client handles, so the child inherits
   nothing else, although `bInheritHandles` must be `TRUE` (**Doc**). `PROC_THREAD_ATTRIBUTE_JOB_LIST` names the job,
   which the documentation supports from Windows 10 and Windows Server 2016 (**Doc**,
   [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)).
4. **Create.** `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW` and
   `STARTF_USESTDHANDLES`. Afterwards the parent closes its copies of the client handles and the thread handle.
5. **Stop.** `TerminateJobObject` kills the tree. If Secant dies, the OS closes the job handle and kill-on-close does the
   same.

Results:

| Case                                                                                                   | Result                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job membership at creation                                                                             | `IsProcessInJob(child, job)` was `true` right after `CreateProcessW` returned, in every run.                                                                                                                                                        |
| Round trip (`bun -e` echoing stdin, one stderr line, `exit 7`)                                         | Both stdin lines echoed, stderr arrived separately, `socket.end()` gave the child EOF, and the exit code read 7. A 10 ms interval kept ticking the whole time, so the event loop was not blocked.                                                   |
| Throughput (child writes 64 MiB with backpressure)                                                     | All 67,108,864 bytes, in 70–86 ms (3 of 3).                                                                                                                                                                                                         |
| Git Bash fork-and-exec (`bash.exe -c "./t2.sh; …"`, the script pings, then writes a marker)            | The script's bash had a dead parent pid, as in C1. `TerminateJobObject` left no bash or `ping`, and the marker was never written (3 of 3).                                                                                                          |
| Parent crash (`process.exit(3)` with the same tree running, no cleanup)                                | Nine seconds later both script pids were gone, no `ping` was left, and there was no marker (3 of 3).                                                                                                                                                |
| Live Claude Code (`claude -p` with the #255 stream-json flags, `--model haiku`, `--allowedTools Bash`) | `system/init` and the assistant frames arrived over the bridged stdout. The Bash tool ran a Git Bash script (four `bash.exe` and a `PING.EXE`). `TerminateJobObject` ended `claude.exe` and all of them, and the marker was never written (3 of 3). |
| Live Codex (`codex app-server`, `initialize`, `thread/start { cwd }` only, `turn/start`)               | The handshake, thread, and Turn ran over the bridged pipes. The sandboxed `pwsh` and `ping` started, so Codex's own sandbox job nested under Secant's. `TerminateJobObject` ended `codex.exe`, `pwsh`, and `ping` (3 of 3).                         |
| Anonymous pipes (`CreatePipe`) wrapped with `ucrtbase` `_open_osfhandle` and `fs` streams              | Failed. The CRT fds are not in Bun's fd table, and Bun's `close` returned `EBADF`.                                                                                                                                                                  |

What the prototype does not cover, and what Bun's spawn does today that it would have to replace (**Inferred** from the
prototype's shape, not measured):

- **Command line.** It takes one Windows command-line string. Bun builds it from an argv with the `CommandLineToArgvW`
  quoting rules and finds the executable on PATH. The prototype relied on `CreateProcessW`'s own search, and a `.cmd`
  shim needs `cmd.exe`.
- **Environment.** It passes `NULL`, so the child inherits Secant's environment block. A custom `env` needs a UTF-16,
  sorted, double-NUL-terminated block.
- **Exit wait.** It polls `WaitForSingleObject(h, 0)` every 20 ms. A production version would want
  `RegisterWaitForSingleObject` or a wait worker.
- **Process Interface.** `pid`, `exited`, stdio and a tree kill map onto today's owned process. `escalated`, the shared
  shutdown bound, and signal delivery to a process group on POSIX were not wired, and POSIX keeps Bun's spawn.

### Routes

| Route                                    | What it is                                                                                          | Facts                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun built-ins only                       | `node:child_process` / `Bun.spawn`                                                                  | Cannot create a job. The only job is libuv's, which has breakaway and silent breakaway.                                                                                     |
| `bun:ffi` to `kernel32.dll`, after spawn | `CreateJobObjectW`, `SetInformationJobObject`, `OpenProcess`, `AssignProcessToJobObject`, terminate | All C2 results used this route; it also works in a `bun build --compile` executable. `bun:ffi` is documented experimental. The measured window never exposed a descendant.  |
| `bun:ffi`, own `CreateProcessW`          | `CREATE_SUSPENDED` + assign + `ResumeThread`, or `PROC_THREAD_ATTRIBUTE_JOB_LIST`, as Codex does    | Closes the window: the child is in the job from creation. Stdio stays streamed through `node:net` named-pipe servers (see below); live Claude Code and Codex contained 3/3. |
| npm package                              | —                                                                                                   | No general-purpose Job Object package; `tree-kill` is `taskkill /T /F` (which C1 shows missing these); `koffi` is a native dependency.                                      |

Measured against [dependency discipline](../agents/dependencies.md) (facts only; #259 decides): `bun:ffi` is a built-in
Secant already uses once (`src/tui/renderer/conhost-notice.ts`, the sole allowlisted entry in
`tests/architecture/check-vendor-provenance.ts`); a Job Object route in `src/process/` would need its own allowlist entry.
The after-spawn Job Object surface is six kernel32 calls and one fixed struct. The contained spawn below adds
`CreateProcessW`, `CreateFileW`, the three attribute-list calls, `SetHandleInformation`, and the `STARTUPINFOEXW` and
`PROCESS_INFORMATION` layouts. It also takes over what Bun's spawn does today (see its gaps).

## C4: Codex `turn/interrupt`, the Windows sandbox, and the PTY

### Codex's own job

The probe through Codex's shell tool reported `jobFlags = KILL_ON_JOB_CLOSE | BREAKAWAY_OK` with `pwsh` and the probe as
members, matching **Source-observed**
[`codex-rs/utils/pty/src/win/job.rs` line 52](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/win/job.rs#L52).

### The interrupt and the two later stops

`turn/interrupt` answered `{}`, `turn/completed` `status: "interrupted"` followed within 1 ms, and the command tree was
untouched — 5/5 in the first pass, and again in every follow-up run. The source explains it: `exec_command` stores the
live process before the first wait ("Persist live sessions before the initial yield wait so interrupting the turn cannot
drop the last Arc",
[`core/src/unified_exec/process_manager.rs` line 570](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/core/src/unified_exec/process_manager.rs#L570));
the process is ended only by `terminate_all_processes`, reached through `thread/backgroundTerminals/clean` or shutdown. The
job's `terminate()` is a no-op once `preserve_descendants()` has cleared `KILL_ON_JOB_CLOSE`, which the pipe path calls
when the root exits ([`pipe.rs` line 285](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/pipe.rs#L285)).
The pipe path assigns after spawn with the comment "Accept the small race" ([line 195](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/pipe.rs#L195));
the PTY path attaches the job at creation with `PROC_THREAD_ATTRIBUTE_JOB_LIST`
([`win/psuedocon.rs` line 177](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/win/psuedocon.rs#L177)).

### The Windows sandbox (the real Secant settings)

Driven with `thread/start { cwd }` only, the acknowledged policy is `approvalPolicy: "on-request"` and, for a `cwd` the
user's config trusts, `sandbox: workspaceWrite` (an untrusted `cwd` acknowledges `readOnly`). A sandboxed native command
runs under a restricted token as the same user at medium integrity, in Codex's per-command job
`KILL_ON_JOB_CLOSE | BREAKAWAY_OK` owned by `codex.exe`:

```text
pwsh.exe   inSecantJob=true restricted   job KILL_ON_JOB_CLOSE|BREAKAWAY_OK n=3 owner=codex.exe
cmd.exe    inSecantJob=true restricted   /c "ping -n 30 127.0.0.58 && echo done > done258.marker"
PING.EXE   inSecantJob=true restricted
```

- `turn/interrupt` left the sandboxed tree running (3/3); `thread/backgroundTerminals/clean` and the app-server's exit
  stopped it (3/3).
- Under an outer Secant no-breakaway job, every sandboxed process reported `IsProcessInJob(secantJob) = true` and
  `TerminateJobObject` on the outer job killed the whole tree, no marker (3/3). `AssignProcessToJobObject` and nesting
  succeed despite the restricted token because it is the same user.
- **Git Bash cannot run under the `workspace-write` sandbox**: `bash.exe: *** fatal error - couldn't create signal pipe,
Win32 error 5` / `CreateFileMapping S-1-5-… Win32 error 5. Terminating.` The restricted token denies the shared section
  the MSYS runtime needs, so the fork-and-exec escape does not arise under the sandbox; only native commands run there. An
  escalation hint did not change this.

The sandbox is **Source-observed** to build its own job and spawn through `CreateProcessAsUserW` with the job in a
`PROC_THREAD_ATTRIBUTE_JOB_LIST` (`windows-sandbox-rs/src/process.rs`, `conpty/mod.rs`), so Codex's containment does not
depend on the token.

### PTY mode: job versus console close

Under a PTY, Codex's job held `pwsh`, the launcher `bash`, and `usr\bin\bash` (n=3); the dead-parent script and its `PING`
broke away and were **not** members.

- Killing only the headless `conhost.exe` pseudoconsole host: the escaped script and `PING` **survived** (3/3).
- `TerminateJobObject` on Codex's job (killing `pwsh`, the pseudoconsole owner): the escaped script and `PING` **died**
  (3/3).

So the PTY-mode kill of the escaped tree is the pseudoconsole closing when `pwsh` dies, not the job reaching a member and
not the `conhost` process dying. The app-server's exit ends `pwsh` the same way.

### Why the app-server stalled after stdin close

In pipe mode the escaped script inherits the command's stdout/stderr write handles; the app-server's reader awaits the
read tasks, which loop until `read()` returns `Ok(0)` (**Source-observed**, `pipe.rs` 109-122 and 261-268). With the
script holding the pipe open, EOF never comes: the app-server exited 21.0–21.1 s after stdin close — exactly when the
30-ping script finished — and the script ran to completion (3/3). A script that first redirects its own stdio to
`/dev/null` releases the pipe, and the app-server exited in 58–89 ms while the script kept running detached (3/3).

## C5: What the guides do on Windows

| Tool                | Windows tree stop                                                                                                                                                                                                                 | Job Object                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Codex 0.155.0       | `TerminateJobObject` on a per-command job (C4); `taskkill /T /F` is a fallback. Its binary imports the Job Object APIs and `NtResumeProcess` (**Binary-observed**). Each MCP server and each sandboxed command get their own job. | Yes: `KILL_ON_JOB_CLOSE \| BREAKAWAY_OK`. Attached at creation for a PTY, after spawn for pipes. |
| Claude Code 2.1.283 | `C:\WINDOWS\System32\taskkill.exe /PID <pid> /T /F`, with `process.kill(pid)` as fallback (**Binary-observed**; C6 traces it live on interrupt). No Claude-owned job around tool commands (C2).                                   | Not for tool processes                                                                           |
| OpenCode `b3f1a96`  | `detached: false` for PowerShell, `detached: process.platform !== "win32"` otherwise; abort/timeout runs `taskkill /pid … /T /F` (**Source-observed**).                                                                           | No                                                                                               |
| T3 Code `d2c9281`   | Harness processes run through Effect's Node spawner, which runs `taskkill` for the tree on win32 (**Source-observed**). For Codex an interrupt is only `turn/interrupt`; for Claude, `interruptTurn` closes the SDK query.        | No                                                                                               |

For T3 Code and OpenCode, **Inferred**: a `taskkill /T` tree stop meets the same dead-parent limit as C1 whenever the tree
holds a Git Bash fork-and-exec process.

## C6: Claude Code's interrupt still kills the tool shell with `taskkill /T /F`

The binary string that skips a kill when the abort reason is `"interrupt"` is the live-shell wrapper's own `kill()`, not
the process-tree kill: `#T(){let e=Ci(this.#i.reason);if(e==="interrupt"||wJt(e,this.#u))return;this.kill()}`
(**Binary-observed**). Traced live with a toolhelp watcher polling every ~5 ms:

| Stop (mid Bash-tool run)                  | Claude-issued `taskkill /PID <tool-shell> /T /F` | Escaped script          |
| ----------------------------------------- | ------------------------------------------------ | ----------------------- |
| stream-json `control_request` `interrupt` | **2 per interrupt** (3/3 runs)                   | ran to completion (3/3) |
| SIGTERM of `claude.exe`                   | none (3/3)                                       | ran to completion (3/3) |
| `taskkill /PID <claude> /F` (no `/T`)     | none (3/3)                                       | ran to completion (3/3) |
| stdin close                               | none (3/3)                                       | ran to completion (3/3) |

So the interrupt keeps the tree kill (two invocations, one per tool-shell layer, parented by `claude.exe`); the
`reason === "interrupt"` guard suppresses only the wrapper's direct `kill()`, and the tree kill it still issues is exactly
what the fork-and-exec escape defeats. The other three stops kill `claude.exe` before it can spawn `taskkill`, and the
escaped script outlives all of them. Under a Secant no-breakaway job, `TerminateJobObject` was the only stop that ended the
escaped script (done marker never written).

## C7: What a Secant no-breakaway job does to deliberately-detached processes

| Detached process             | No Secant job                                        | Under a Secant `KILL_ON_JOB_CLOSE` job                                                               |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude Code background Bash  | escapes tree; outlives `claude.exe`; completes (2/2) | member; job close kills it mid-run — start marker only, no done marker (2/2)                         |
| Claude Code stdio MCP server | direct child; its libuv job nests                    | member; a `CREATE_BREAKAWAY_FROM_JOB` child it spawns **succeeds but stays in the Secant job** (3/3) |
| Codex stdio MCP server       | own no-breakaway job (`create_without_breakaway`)    | member; a `CREATE_BREAKAWAY_FROM_JOB` child it spawns **fails, `ERROR_ACCESS_DENIED` (5)** (3/3)     |
| Codex background terminal    | escapes (C4)                                         | member; `TerminateJobObject` on the outer job kills it (C4)                                          |

The important consequence: a process inside a no-breakaway job that asks for `CREATE_BREAKAWAY_FROM_JOB` gets
`ERROR_ACCESS_DENIED` (5) — observed for every Secant-job probe and for Codex's own no-breakaway MCP job. **A Harness that
must launch something detached would have that spawn fail under a Secant no-breakaway job.** Codex already tolerates it:
its stdio MCP launcher treats a rejected assignment as a fallback and re-spawns uncontained
([`rmcp-client/src/stdio_server_launcher.rs` lines 324-343](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L324-L343)).
Claude Code's MCP servers and background Bash do not request breakaway, so the Secant job simply contains them, and its
close ends them. Secant's own planned loopback MCP is not built; as a direct child it would be a job member ended on
close like any other.

## Still Unknown

- **The contained spawn inside a compiled binary, and a Harness's `.cmd` shim.** The named-pipe prototype (C3) ran
  under `bun` 1.4.2. It was not run from a `bun build --compile` executable or through `cmd.exe` for a shim. After-spawn
  `bun:ffi` job calls did work in a compiled executable.
- **Other Claude Code releases and a non-MSYS bash.** Only Claude Code 2.1.283 is installed, and WSL is not installed
  (`wsl --status`: "not installed"), so whether a later Claude Code release or a genuinely non-MSYS bash changes the escape
  could not be tested here. `CLAUDE_CODE_GIT_BASH_PATH` pointed at Git's `usr\bin\bash.exe` did not change it (C2).
- **A job-free measurement baseline.** This machine has no job-free starting point — the host process is itself in a job,
  and a process that breaks away lands in an anonymous job whose handle the handle-table walk cannot resolve to an owner —
  so `IsProcessInJob(NULL)` is always `true` and membership in a named or owned job is what distinguishes cases. A clean
  baseline would need a login session started outside any compatibility or service job.
