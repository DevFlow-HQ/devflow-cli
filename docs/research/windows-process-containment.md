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
records facts only.

## Answer

**C1. Git Bash starts every MSYS program outside the Windows parent tree when it forks and then execs.** `taskkill /T`
walks only live parent links, so it cannot reach that program or anything under it. The process's Windows parent is the
fork child, which exits as soon as the exec succeeds. Driven the way Claude Code drives its tool shell
(`Git\bin\bash.exe -c "eval '<cmd>' < /dev/null && …"`), `taskkill /T /F` on the root left these alive:

- a script (`./x.sh`, `bash x.sh`, `sh x.sh`) and everything it started;
- `bash -c '…'`;
- a bare MSYS utility (`sleep`).

These were killed:

- a native command (`ping`, `bun`, `powershell`, `cmd`);
- a pipeline or subshell of native commands;
- `cmd & wait`;
- `exec ./x.sh` from the top-level shell.

Each case was run once. The MSYS source matches this. On `exec`, the old process stays behind to wait only when the
target is not an MSYS program, or when the process has no MSYS parent. Otherwise it exits.

**C2. A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and no breakaway limit, reaches all of them.** It was
assigned to the root right after `spawn()` returned. The escaped processes were members of the job (`IsProcessInJob`),
dead parent and all. `TerminateJobObject`, or just `CloseHandle` on the job, killed every one, with no survivor in any of
the 15 cases.

Two live runs repeated this with Claude Code. The job was assigned to `claude.exe` itself, and the Bash tool ran a Git Bash
script. `TerminateJobObject` killed `claude.exe`, both tool shells, the dead-parent script, and its `ping` (2 of 2). The
script's end marker was never written.

The job must not allow breakaway. The MSYS runtime adds `CREATE_BREAKAWAY_FROM_JOB` to every spawn when its immediate job
has `BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK`. With either flag, the Git Bash processes left the job and survived it.

**C3. Bun has no built-in way to create a job or to spawn suspended.** `bun:ffi` against `kernel32.dll` works. Four calls
are enough: `CreateJobObjectW`, `SetInformationJobObject`, `AssignProcessToJobObject`, and `TerminateJobObject` or
`CloseHandle`. It also works inside a `bun build --compile` executable. Bun documents `bun:ffi` as experimental.

Assigning after `spawn()` returns leaves a window in which the child runs outside the job. Bun's libuv suspends only
detached children, and it already puts every non-detached child in its own job, which has `KILL_ON_JOB_CLOSE`,
`BREAKAWAY_OK`, and `SILENT_BREAKAWAY_OK`. A second job nests under that one (Windows 8 and later), and nesting worked here.

**C4. Codex's `turn/interrupt` does not stop a running shell command on Windows.** The Turn ended `interrupted`. The
command's whole tree kept running while the app-server lived (5 of 5), as the source says: the process is stored as a
background terminal before the interrupt can drop it.

Two later steps did stop it: the experimental `thread/backgroundTerminals/clean` request, and the app-server's exit. Both
end the job Codex creates for each command, which has `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`. That job has `BREAKAWAY_OK`, so
a Git Bash fork-and-exec script run without a PTY left it. The script outlived both the clean request and the app-server's
exit, and ran to completion (2 of 2). The same script under a PTY died when the app-server exited (1 run).

Under an outer Secant-style job without breakaway, the Git Bash script stayed contained. `TerminateJobObject` on the outer
job killed it (1 run).

**C5. What the guides do.**

- Codex contains commands in Job Objects: attached at `CreateProcess` for a PTY, assigned after spawn for pipes.
- Claude Code (inferred from strings in its binary), OpenCode, and T3 Code stop trees with `taskkill /T /F`, and none of
  them uses a Job Object for tool or Harness processes.
- Claude Code puts no job of its own around tool commands. Seen from inside, a Bash-tool command sat in a job outside
  Claude Code's tree, and a PowerShell-tool command sat in the job its host already had.

## Evidence Vocabulary

- **Observed**: seen in process tables, job queries, marker files, or Harness frames captured for this note on 2026-09-29
  against the versions above. Every fact without another label is Observed.
- **Source-observed**: read in the named source at the cited commit.
- **Doc**: stated by Microsoft Learn or Bun's documentation.
- **Binary-observed**: found in the strings of the installed executable, which is closed source. The call sites were not
  traced.
- **Inferred**: a consequence drawn from the above that needs a check before it becomes a compatibility promise.

## Method

The drivers were small Bun 1.4.2 scripts. They and every raw log stayed in the session scratchpad, outside the repository.

- **Spawning.** Children were spawned as `src/process/process.ts` spawns an owned process on win32 (**Source-observed**,
  `spawnOwnedProcessWithNode` lines 400-414): `node:child_process` `spawn`, `windowsHide: true`, and `detached: false`.
- **Process tables.** Taken with `Get-CimInstance Win32_Process` (pid, parent pid, name, and command line).
- **Job queries.** A `bun:ffi` binding to `kernel32.dll` made these calls:
  - `IsProcessInJob(h, NULL)` for membership in any job, and `IsProcessInJob(h, job)` for membership in the test's own job;
  - `QueryInformationJobObject` with `JobObjectExtendedLimitInformation` (the limit flags) and
    `JobObjectBasicProcessIdList` (the members).
  - With a `NULL` job handle, the query reports the caller's own job. A spawned probe (`bun probe-child.ts`) used this to
    report the job it was running in.
- **Test job.** `CreateJobObjectW(NULL, NULL)`, then `SetInformationJobObject` with only
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` unless a run says otherwise, then `AssignProcessToJobObject`. The process was opened
  with `PROCESS_SET_QUOTA | PROCESS_TERMINATE`.
- **Test processes.** Each one carried a marker, the address `127.0.0.58` or the duration `25.8`, so escaped processes
  could be found by command line. The drivers killed every survivor by pid after each case.
- **Hygiene.** A final process-table check found no marker process and no `claude -p` or `codex app-server` left from the
  runs.

The agent shell these drivers ran in was already in a job with `BREAKAWAY_OK`. A process started through WMI
(`Win32_Process.Create`) was in a job with `BREAKAWAY_OK | SILENT_BREAKAWAY_OK`. No job-free starting point was available,
so "in any job" is `true` for every process below, and membership in the test's own job is what tells the cases apart.

## C1: Which Git Bash commands escape `taskkill /T`

Each case spawned `C:\Program Files\Git\bin\bash.exe -c "eval '<cmd>' < /dev/null && pwd -P > /dev/null"`. That is the
shape of Claude Code's Bash-tool invocation, which the #255 note captured as `Git\bin\bash.exe -c "source <snapshot> … &&
eval '<cmd>' …"`. The trailing `&& …` stops bash from exec'ing the last command in place. After 2.5 s the driver ran
`taskkill /pid <root> /T /F`, waited 1.5 s, and listed survivors.

| Case                                        | Tree before the kill                                                  | Survivors of `taskkill /T /F` |
| ------------------------------------------- | --------------------------------------------------------------------- | ----------------------------- |
| `ping -n 26 127.0.0.58`                     | launcher → `usr\bin\bash` → bash (fork) → `PING`                      | none                          |
| `sleep 25.8`                                | launcher → `usr\bin\bash`; `sleep.exe` (parent **dead**)              | `sleep.exe`                   |
| `./slow258.sh`                              | launcher → bash; script bash (parent **dead**) → bash (fork) → `PING` | script bash, fork, `PING`     |
| `bash slow258.sh`                           | same as `./slow258.sh`                                                | script bash, fork, `PING`     |
| `sh slow258.sh`                             | same, with `sh.exe`                                                   | both `sh.exe`, `PING`         |
| `bash -c 'ping …'`                          | launcher → bash; inner bash (parent **dead**) → `PING`                | inner bash, `PING`            |
| `ping … \| cat`                             | unbroken chain to `PING`                                              | none                          |
| `(ping …; true)`                            | unbroken chain (subshell fork) to `PING`                              | none                          |
| `ping … & wait`                             | unbroken chain to `PING`                                              | none                          |
| `exec ./slow258.sh`                         | top bash → script bash (parent **alive**) → fork → `PING`             | none                          |
| `bun -e 'setTimeout(…,25800)'`              | unbroken chain to `bun.exe`                                           | none                          |
| `bun run slow258` (a `package.json` script) | unbroken chain to `bun.exe` → `PING`                                  | none                          |
| `powershell.exe -NoProfile -File x.ps1`     | unbroken chain to `powershell.exe` → `PING`                           | none                          |
| `cmd //c 'ping …'`                          | unbroken chain to `cmd.exe` → `PING`                                  | none                          |

`setsid sleep 25.8` produced no process that the driver could see, and is not counted. The `| cat` process was not
captured in the pipeline row, so whether `cat.exe` (an MSYS program) escaped there is not known. Its `PING` did not escape.

- **The pattern.** A process escapes when an MSYS process forks and the fork child then execs another MSYS program: bash,
  sh, or a utility in `usr\bin`. That program's Windows parent is the fork child, which has already exited. A native
  target keeps a live parent. So do `exec` from the top-level shell, whose parent is the native `Git\bin\bash.exe`
  launcher, and any command that bash runs in its own fork without exec'ing an MSYS program.
- **Everything under an escaped process escapes too.** In the script cases, the script's own forks and its `ping` have
  live parents, but their chain ends at the dead-parent script, so `taskkill /T` never reaches them.

### Why the parent pid is dead (Source-observed)

- **The exec path.** In the MSYS runtime
  ([`winsup/cygwin/spawn.cc` at `msys2-3.6.10` `3ea87a5`](https://github.com/msys2/msys2-runtime/blob/3ea87a506e64e841dc0b8ee50ed61999c8fed26c/winsup/cygwin/spawn.cc)),
  `exec` is `_P_OVERLAY`, and a new Windows process is created for the target.
  - For an MSYS target the old process then leaves through `myself.exit (EXITCODE_NOSET)` (lines 892-929).
  - It first calls `wait_for_myself ()` only when `!my_wr_proc_pipe`, that is, when it has no MSYS parent (lines
    905-908).
  - For a non-MSYS target the process is "synced" at once, and "we will still eventually wait for it to exit in
    maybe_set_exit_code_from_windows()" (lines 884-887).
- **How that fits what was seen.** A fork child always has an MSYS parent, so after exec'ing an MSYS program it exits and
  the new process's Windows parent is gone. After exec'ing `ping`, it stays to wait. The top-level bash has a native
  parent, so it waits as well. **Inferred**: this is the whole mechanism. The table matches it in every case.
- **The runtime also breaks away from jobs.** The same function adds `CREATE_BREAKAWAY_FROM_JOB` whenever
  `IsProcessInJob` is true and the job returned by `QueryInformationJobObject (NULL, …)` has `JOB_OBJECT_LIMIT_BREAKAWAY_OK`
  or `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` (lines 444-473). The comment names a Program Compatibility Assistant memory
  issue as the reason. `fork.cc` adds no such flag
  ([lines 218-273](https://github.com/msys2/msys2-runtime/blob/3ea87a506e64e841dc0b8ee50ed61999c8fed26c/winsup/cygwin/fork.cc#L218-L273)).
  So an MSYS **exec or spawn** leaves any breakaway-permitting job, and a **fork** stays in the job.

## C2: A kill-on-close Job Object

### Every case from C1, under a job without breakaway

The same 15 cases were repeated, with a job holding only `KILL_ON_JOB_CLOSE`. The job was assigned to the root 0.04 to
0.16 ms after `spawn()` returned. At the stop time the driver called `CloseHandle(job)` and did not call
`TerminateJobObject`.

```text
=== msys-sleep: sleep 25.8  [mode=job]
  8884 <- 2944 (parent DEAD) sleep.exe inAnyJob=true inOurJob=true :: "…\Git\usr\bin\sleep.exe" 25.8
  job pid list: [19148,19660,9412,8884]
  CloseHandle(job) -> 1
  survivors: none
=== script-dot-slash: ./slow258.sh  [mode=job]
  20068 <- 3440 (parent DEAD) bash.exe inAnyJob=true inOurJob=true :: "…\Git\usr\bin\bash.exe" ./slow258.sh
  job pid list: [4368,9800,12188,20068,16076,3656]
  survivors: none
```

- **Nothing survived.** Every escaped process was in the job, and closing its last handle killed every case (15 of 15).
  `TerminateJobObject` followed by `CloseHandle` did the same for the direct-`ping`, `sleep`, and `./slow258.sh` cases.
- **Job membership does not depend on parent links.** A child joins its creator's job at creation, whether or not its
  creator is still alive (**Doc**,
  [`AssignProcessToJobObject`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject):
  "all child processes … are associated with that job by default").

### The same cases under a job that allows breakaway

| Job limit flags                            | `sleep 25.8`                           | `./slow258.sh`                                | `ping` (native)                    |
| ------------------------------------------ | -------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `KILL_ON_JOB_CLOSE`                        | in job; killed                         | in job; killed                                | in job; killed                     |
| `KILL_ON_JOB_CLOSE \| BREAKAWAY_OK`        | **not in job; survived**               | **not in job; script, fork, `PING` survived** | **`PING` not in job; survived**    |
| `KILL_ON_JOB_CLOSE \| SILENT_BREAKAWAY_OK` | only the launcher in job; **survived** | only the launcher in job; **survived**        | only the launcher in job; survived |

One run each.

- **With `BREAKAWAY_OK`, MSYS children left the job.** The job held the launcher, its console host, and `usr\bin\bash`.
  Every process that an MSYS process spawned or exec'd left it, including a native `PING`. That is the
  `CREATE_BREAKAWAY_FROM_JOB` path in `spawn.cc`.
- **With `SILENT_BREAKAWAY_OK`, only the assigned root is in the job.** Every child is outside it by definition.
  **Doc**:
  [`JOBOBJECT_BASIC_LIMIT_INFORMATION`](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information),
  "Allows any process associated with the job to create child processes that are not associated with the job".

### Claude Code under the job (2 runs)

`claude.exe` was spawned with the #255 flags (`-p --input-format stream-json --output-format stream-json --verbose --model
haiku`), with `--allowedTools "Bash(./slow258.sh)"`, and the job was assigned right after `spawn()`. The prompt asked for
`./slow258.sh` in the foreground. That script writes a start marker, runs `ping -n 28`, then writes an end marker.

```text
[  6171] tool_use Bash {"command":"./slow258.sh",…}
[ 10971] ps mid-tool:
  6644 claude.exe                                   inOurJob=true
  12420 <- 6644 conhost.exe                         inOurJob=false
  2576 <- 6644 Git\bin\bash.exe -c "source …"       inOurJob=true
  20376 <- 2576 Git\usr\bin\bash.exe -c "source …"  inOurJob=true
  8556 <- 15524 (parent DEAD) bash.exe ./slow258.sh inOurJob=true
  6008 <- 8556 bash.exe ./slow258.sh                inOurJob=true
  17776 <- 6008 PING.EXE                            inOurJob=true
[ 10971] job pids [2576,20376,20340,8556,6008,17776,6644]
[ 10972] TerminateJobObject -> 1
[ 11028] claude EXIT 1
[ 13158] ps 1.5 s after the stop: (none left)
[ 42159] markers started/done: true false
```

- **The whole tree was killed.** Run 2 matched: the same dead-parent script, all of the tree in the job, nothing left,
  and no end marker.
- **Some processes were not in the job but still went.** `claude.exe`'s own `conhost.exe`, started by the system for a
  console process, was not a member. It was gone once its clients were.
- **Nesting worked.** `claude.exe` was already in the driver's libuv job (see C3) when the assignment succeeded. **Doc**
  (same page): a process can be in more than one job "starting in Windows 8 and Windows Server 2012", and the new job
  "must be empty or it must be in the hierarchy of nested jobs to which the process already belongs".

### What a tool command sees from inside

`bun probe-child.ts` reports the caller's own job flags and member pids. It was run through Claude Code's Bash tool and
PowerShell tool (1 run each):

| Launch                                    | Bash-tool command's own job                                           | PowerShell-tool command's own job                 |
| ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `claude.exe`, no Secant job               | `BREAKAWAY_OK \| SILENT_BREAKAWAY_OK`, ~70 unrelated members          | `BREAKAWAY_OK`, the agent shell's host job        |
| `claude.exe` in a `KILL_ON_JOB_CLOSE` job | `KILL_ON_JOB_CLOSE`; members include `claude.exe` and the tool shells | `KILL_ON_JOB_CLOSE`; members include `claude.exe` |

- **No job of Claude Code's own around tool commands.** Without a Secant job, neither command was in a job of Claude
  Code's. The Bash-tool command had also left its host's job and landed in one with about 70 unrelated members, the same
  job that a process started through WMI lands in.
- **Why the Bash-tool command could leave. Doc**:
  [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs): "If the immediate job object
  allows breakaway, the child process breaks away from the immediate job object and from each job in the parent job
  chain, moving up the hierarchy until it reaches a job that does not permit breakaway." Under a job without breakaway,
  both commands stayed in it.

## C3: How Bun can create the job

### What Bun already does

- **Bun puts its own children in a job.** Every non-detached child of `node:child_process` `spawn`/`spawnSync` and
  `Bun.spawn`/`Bun.spawnSync` reported the job flags `0x3c00` (`KILL_ON_JOB_CLOSE | BREAKAWAY_OK | SILENT_BREAKAWAY_OK |
DIE_ON_UNHANDLED_EXCEPTION`), with the Bun parent and itself as members. A `detached: true` child reported only the
  parent's outer job.
- **That is libuv's global job** (**Source-observed**, `oven-sh/libuv@8023581` `src/win/process.c`):
  - `uv__init_global_job_handle` sets exactly those four flags (lines 93-96). It then adds the calling process to the job
    (line 109).
  - The comment says `SILENT_BREAKAWAY_OK` is set "so only the processes that we explicitly add are affected, and _their_
    subprocesses are not" (line 77).
  - Every non-detached child is assigned after `CreateProcessW` (lines 1128-1130). Only a detached child gets
    `CREATE_SUSPENDED` (lines 1106-1107).
- **So libuv's job does not contain the tree.** It kills only the direct child (`claude.exe`, `codex.exe`) when Secant
  exits. Its `BREAKAWAY_OK` would also let MSYS children leave it.

### What Bun does not offer

- **No job or suspended-spawn option.** Bun's `SpawnOptions` at `bun-v1.4.2` list `windowsHide`,
  `windowsVerbatimArguments`, `detached` (through `node:child_process`), `cgroup` ("Linux only"), and `terminal` (ConPTY
  on Windows) (**Doc**,
  [`docs/runtime/child-process.mdx`](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/docs/runtime/child-process.mdx)).
  There is no `CREATE_SUSPENDED` flag and no Windows job option.
- **The assign-after-spawn window.** A Bun spawn therefore cannot put a child in a job before it runs. Assigning after
  `spawn()` returns leaves the gap Microsoft describes: a process created before the assignment is not in the job.
  - Microsoft's remedy is `CREATE_SUSPENDED` (**Doc**, `AssignProcessToJobObject`), or `PROC_THREAD_ATTRIBUTE_JOB_LIST`
    at `CreateProcess`. That attribute takes "a list of job handles to be assigned to the child process" and needs
    Windows 10 or later (**Doc**,
    [`UpdateProcThreadAttribute`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)).
    Neither is reachable through Bun's spawn.
  - Here the assignment came 0.04 to 0.16 ms after `spawn()` returned. The first grandchild of `claude.exe` (its tool
    shell) appeared seconds later.
  - **Inferred**: a Harness that spawns a descendant within its first fraction of a millisecond is the case the window
    exposes. Neither Harness's start-up was timed at that resolution.

### Routes

| Route                                    | What it is                                                                                                                                                                                                             | Observed or documented facts                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun built-ins only                       | `node:child_process` / `Bun.spawn`                                                                                                                                                                                     | Cannot create a job. The only job is libuv's, which has breakaway and silent breakaway.                                                                                                                                                                                                                                                                                                                                                             |
| `bun:ffi` to `kernel32.dll`, after spawn | `CreateJobObjectW`, `SetInformationJobObject` (`JobObjectExtendedLimitInformation`, 144-byte struct on x64, `LimitFlags` at offset 16), `OpenProcess`, `AssignProcessToJobObject`, `TerminateJobObject`, `CloseHandle` | All C2 results used this route. It also worked in a `bun build --compile` executable: a Git Bash `sleep 25.8; true` tree of 4 processes was assigned, and `TerminateJobObject` left none. Bun's doc says "`bun:ffi` is **experimental**, with known bugs and limitations. Do not rely on it in production" ([`docs/runtime/ffi.mdx` line 7](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/docs/runtime/ffi.mdx#L7)). |
| `bun:ffi`, own `CreateProcessW`          | Spawn with `PROC_THREAD_ATTRIBUTE_JOB_LIST` or `CREATE_SUSPENDED`, as Codex does in Rust                                                                                                                               | Closes the window. It gives up Bun's spawn: stdio pipes and exit observation would be rebuilt over FFI. Not tried.                                                                                                                                                                                                                                                                                                                                  |
| npm package                              | —                                                                                                                                                                                                                      | The npm registry search for "windows job object kill" returned no general-purpose Job Object package. `tree-kill` 1.2.2 is `taskkill /T /F` on Windows, which C1 shows missing these processes. `koffi` 3.3.2 is a general FFI with a native install step (`install: node ./cnoke.cjs … --prebuild`).                                                                                                                                               |

Measured against [dependency discipline](../agents/dependencies.md) (facts only; #259 decides):

- **Built-in first.** `bun:ffi` is a built-in. Secant already uses it once: `src/tui/renderer/conhost-notice.ts` calls
  `kernel32` `GetConsoleWindow`. That file is the only entry allowlisted for `bun:ffi` in
  `tests/architecture/check-vendor-provenance.ts` (lines 42-62), and the runtime-neutrality allowlist grants each API per
  file. A Job Object route in `src/process/` would need its own entry.
- **Native dependencies.** `koffi` is a native dependency, which the policy says "needs a prior issue decision".
- **OpenCode's choice.** OpenCode also calls `kernel32` through `bun:ffi`, in
  [`packages/tui/src/terminal-win32.ts`](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/tui/src/terminal-win32.ts)
  for console modes. For process trees it uses `taskkill` and no FFI (C5).
- **Growth rule.** The Job Object surface used here is six kernel32 calls and one fixed struct layout. Nothing measured
  here says whether it would grow.

## C4: Codex `turn/interrupt` against a running shell command

### Setup

- **Launch.** The driver spawned `codex.exe app-server` with the #255 handshake. It stripped `CLAUDE*`, `ORCA_*`, and
  `CODEX_HOME`, so the user's home `C:\Users\rg\.codex` was used.
- **Deviation from Secant.** `thread/start` set `approvalPolicy: "never"` and `sandbox: "danger-full-access"`, so that no
  approval could stall the command. Secant leaves both unset. The user's config sets `[windows] sandbox = "unelevated"`,
  and the sandboxed path was not run (see Still Unknown).
- **Turns.** Each `turn/start` used `gpt-6-luna` with `effort: "low"`, and asked for one command, run in the foreground.
  Codex ran each through `pwsh.exe -Command …`.
- **Stop.** The driver sent `turn/interrupt` 5 s into the command. It then snapshotted the tree, optionally sent
  `thread/backgroundTerminals/clean` (which needs `experimentalApi: true` at `initialize`), and closed stdin.

### Codex's own job

The probe run through Codex's shell tool reported
`jobFlags=0x2800 [KILL_ON_JOB_CLOSE,BREAKAWAY_OK] jobPids=[<pwsh>,<probe>]`. That matches **Source-observed**
[`codex-rs/utils/pty/src/win/job.rs` line 52](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/win/job.rs#L52),
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK`.

### Runs

| Command (under `pwsh`)                                           | Mode | After `turn/interrupt` (app-server alive)        | After `backgroundTerminals/clean`                                  | After app-server exit                                                                                                                           |
| ---------------------------------------------------------------- | ---- | ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd /c "ping -n 30 … && echo done > marker"`                    | pipe | `pwsh`, `cmd`, `PING` running                    | not sent                                                           | exit 0 at once; tree gone; no marker                                                                                                            |
| `& Git\bin\bash.exe -c './slow258.sh'` (lone command, exec)      | PTY  | whole tree running; parents all live             | whole tree gone                                                    | exit 0; nothing left                                                                                                                            |
| `& Git\bin\bash.exe -c './slow258.sh; true'` (fork and exec)     | pipe | whole tree running; script has a **dead parent** | `pwsh`, launcher, and bash gone; **script, fork, `PING` survived** | app-server still running 8 s after stdin closed, so the driver ran `taskkill /T /F`; script survived and **ran to completion** (marker written) |
| same                                                             | pipe | whole tree running; script has a dead parent     | not sent                                                           | same as above: app-server still running 8 s after stdin closed; script survived and ran to completion                                           |
| same                                                             | PTY  | whole tree running; script has a dead parent     | not sent                                                           | exit 0; nothing left, including the script                                                                                                      |
| same, with `codex.exe` in a Secant-style `KILL_ON_JOB_CLOSE` job | pipe | whole tree running; script has a dead parent     | not sent                                                           | the driver called `TerminateJobObject` on its own job: everything gone, no marker; app-server exit 1                                            |

"Mode" is PTY when a headless `conhost.exe --headless` child of `codex.exe` was present, and pipe otherwise. The
model picked the mode; a hint in the prompt was used for the last three rows.

```text
[ 16088] turn/interrupt -> {}
[ 16089] <- turn/completed {"turn":{…,"status":"interrupted",…}}
[ 19303] ps 2.5 s after interrupt (app-server alive):
  11268 <- 18776 pwsh.exe …
  9032 <- 11268 cmd.exe /c "ping -n 30 127.0.0.58 && echo done > done258.marker"
  16628 <- 9032 PING.EXE
```

- **The interrupt leaves the command running.** `turn/interrupt` answered `{}`, and `turn/completed`
  `status: "interrupted"` followed within 1 ms. The command tree was untouched in every run (5 of 5; the probe run was
  not interrupted).
- **The source says why** (**Source-observed**, at `rust-v0.155.0`):
  - `exec_command` is the unified-exec tool. Its manager stores the live process before the first wait: "Persist live
    sessions before the initial yield wait so interrupting the turn cannot drop the last Arc and terminate the background
    process"
    ([`core/src/unified_exec/process_manager.rs` line 570](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/core/src/unified_exec/process_manager.rs#L570)).
  - The interrupt aborts the Turn's task
    ([`core/src/tasks/mod.rs` lines 901-939](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/core/src/tasks/mod.rs#L901-L939)).
  - The process is ended by `terminate_all_processes`
    ([line 1680](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/core/src/unified_exec/process_manager.rs#L1680)).
    That is reached through `thread/backgroundTerminals/clean`, which is marked `#[experimental(…)]`
    ([`app-server-protocol/src/protocol/common.rs` line 738](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/app-server-protocol/src/protocol/common.rs#L738)),
    or by shutdown.
- **How Codex kills a command on Windows** (**Source-observed**):
  - The job's `terminate()` calls `TerminateJobObject`
    ([`job.rs` lines 208-218](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/win/job.rs#L208-L218)).
  - It is a no-op once `preserve_descendants()`
    ([line 193](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/win/job.rs#L193))
    has cleared `KILL_ON_JOB_CLOSE`. The pipe path calls that when the root exits
    ([`pipe.rs` line 285](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/pipe.rs#L285)).
  - **Inferred**: descendants of a command whose root exited on its own are left running by design.
- **The pipe path assigns after spawn.** It creates the job
  ([`pipe.rs` line 191](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/pipe.rs#L191)),
  spawns normally, then assigns, with the comment "Accept the small race: a descendant created between spawn and assignment
  is not guaranteed to join the job and can escape termination"
  ([line 195](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/pipe.rs#L195)).
- **The PTY path attaches the job at creation.** It creates the job
  ([`win/psuedocon.rs` line 167](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/win/psuedocon.rs#L167))
  and passes it as `PROC_THREAD_ATTRIBUTE_JOB_LIST`
  ([line 177](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/win/psuedocon.rs#L177);
  [`win/procthreadattr.rs` lines 32 and 87](https://github.com/openai/codex/blob/f0a1b8f0849d90960bc406b848f32e5a129b0457/codex-rs/utils/pty/src/win/procthreadattr.rs#L87)).
  If the attribute fails, it "fail[s] the spawn rather than briefly run" uncontained.
- **Why the pipe-mode script survived.** Codex's job allows breakaway, so the MSYS runtime spawned the script with
  `CREATE_BREAKAWAY_FROM_JOB` (C1). The job's termination then missed it, as the `BREAKAWAY_OK` row in C2 did.
  - **Inferred**: under a PTY, the script died when the pseudoconsole closed, not through the job. It was not checked
    whether it was a job member there.
  - **Inferred**: under an outer job without breakaway, breakaway stops at that job, as the Nested Jobs doc quoted in C2
    says. So `TerminateJobObject` on the outer job reached the script.
- The app-server's failure to exit on stdin close while the escaped script ran (2 of 2 pipe runs) was not investigated.

## C5: What the guides do on Windows

| Tool                | Windows tree stop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Job Object                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Codex 0.155.0       | `TerminateJobObject` on a per-command job (C4). `taskkill /T /F` is a fallback, used for hooks when no job exists and for the exec-server's stdio tree (**Source-observed**, subagent read of `hooks/src/engine/command_runner.rs` and `exec-server/src/connection.rs` at `c248f6d`, not re-checked at the release tag). Its binary imports `CreateJobObjectW`, `AssignProcessToJobObject`, `SetInformationJobObject`, `TerminateJobObject`, and `NtResumeProcess` (**Binary-observed**).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Yes: `KILL_ON_JOB_CLOSE \| BREAKAWAY_OK`. Attached at creation for a PTY, after spawn for pipes. |
| Claude Code 2.1.283 | `taskkill.exe /PID <pid> /T /F`, with `process.kill(pid)` as the fallback (**Binary-observed**: the embedded JS spawns `%SYSTEMROOT%\System32\taskkill.exe` with `["/PID",pid,"/T","/F"]` and logs `killProcessTree … failed`). #255 saw it run against the tool shell on interrupt. The strings put `CreateJobObjectW` / `KILL_ON_JOB_CLOSE` only in a Rust Windows-sandbox helper and in the embedded Bun runtime's imports. C2's probe found no Claude-owned job around tool commands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Not for tool processes                                                                           |
| OpenCode `b3f1a96`  | The shell tool never detaches on Windows: `detached: false` for PowerShell, `detached: process.platform !== "win32"` otherwise ([`packages/opencode/src/tool/shell.ts` lines 299 and 308](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/tool/shell.ts#L293-L309)). On abort or timeout it calls `handle.kill({ forceKillAfter: "3 seconds" })` ([lines 548-554](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/opencode/src/tool/shell.ts#L548-L554)). On win32 `killGroup` runs `taskkill /pid ${proc.pid} /T /F`, falling back to `proc.kill` ([`packages/core/src/cross-spawn-spawner.ts` lines 292-304, 314-322](https://github.com/anomalyco/opencode/blob/b3f1a96c6dd7adeb28b36dd11add1998fc84d67b/packages/core/src/cross-spawn-spawner.ts#L292-L322)). Its dependencies for this are `cross-spawn`, `@lydell/node-pty`, and `bun-pty` 0.4.8; there is no tree-kill or Job Object package. | No                                                                                               |
| T3 Code `d2c9281`   | Harness processes run through Effect's `ChildProcessSpawner`. Its Node spawner runs `taskkill` for the tree on win32 ([vendored `.repos/effect-smol/packages/platform/node-shared/src/NodeChildProcessSpawner.ts` lines 95-104, 395, 418](https://github.com/pingdotgg/t3code/blob/d2c9281b8112dc3b2991642c4bdb985e4b08b9bb/.repos/effect-smol/packages/platform/node-shared/src/NodeChildProcessSpawner.ts#L95-L104)). For Codex, an interrupt is only the `turn/interrupt` RPC (`CodexSessionRuntime.ts` around line 2601), so the command tree is left to Codex. For Claude, `interruptTurn` settles the Turn and then always calls `stopSessionInternal`, which closes the SDK query ([`ClaudeAdapter.ts` lines 5286-5295](https://github.com/pingdotgg/t3code/blob/d2c9281b8112dc3b2991642c4bdb985e4b08b9bb/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5286-L5295)); how the SDK kills on Windows was not read.                                                                                 | No                                                                                               |

For T3 Code and OpenCode, **Inferred**: a `taskkill /T` tree stop meets the same dead-parent limit as C1 whenever the tree
holds a Git Bash fork-and-exec process.

## Still Unknown

- **Codex's sandboxed path.** The Windows sandbox (`[windows] sandbox = "unelevated"`, `workspace-write`) was not run. Its
  source uses a job and `PROC_THREAD_ATTRIBUTE_JOB_LIST` (`windows-sandbox-rs/src/process.rs`, from the subagent read at
  `c248f6d`, not re-checked at the release tag). Neither the job's breakaway flags nor whether `turn/interrupt` stops a
  sandboxed command was checked.
- **The PTY-mode mechanism.** Whether Codex's PTY-mode kill of the Git Bash script comes from the job or from the
  pseudoconsole closing, and whether the script was a job member there.
- **Nested breakaway at the root of the chain.** The Bash-tool probe in C2 left the host job for one with
  `BREAKAWAY_OK | SILENT_BREAKAWAY_OK`, instead of leaving every job. The job chain above the agent shell was not mapped,
  so which job stops the breakaway is not known.
- **The assign-after-spawn window.** How long it is in practice for `claude.exe` and `codex.exe`: whether either can
  create a descendant before an assignment 0.1 ms after `spawn()` returns. Not measured at that resolution.
- **`PROC_THREAD_ATTRIBUTE_JOB_LIST` or `CREATE_SUSPENDED` from Bun.** Whether either can be reached through a
  `bun:ffi` `CreateProcessW` while keeping Bun-managed stdio. Not tried.
- **Suspended-spawn route.** Whether libuv's detached spawn (`CREATE_SUSPENDED`, then an immediate resume) could be used.
  Bun exposes no hook between the create and the resume.
- **Other MSYS paths.** A pipeline's MSYS stage (`| cat`), `xargs`, `find -exec`, `make`, and `npm`/`npx` scripts run
  through `sh` were not captured. Each case in C1 ran once.
- **Other Claude Code versions and shells.** Whether a later Claude Code release, `CLAUDE_CODE_GIT_BASH_PATH`, or a
  non-Git-for-Windows bash changes the escape.
- **The binary's abort listener.** The Claude Code strings include one that skips the kill when the abort reason is
  `"interrupt"`. How that fits #255's observed `taskkill` on interrupt was not traced.
- **What Secant's own job would kill.** Whether a Job Object on a Harness process also kills processes that the Harness
  deliberately detaches, such as background Bash tasks, MCP servers, or Codex background terminals, beyond what C2 and C4
  show.
- **Codex's stdin-close stall.** Why Codex's app-server stayed up for more than 8 s after stdin closed while an escaped
  script held its pipes.
