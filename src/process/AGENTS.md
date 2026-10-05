# process — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- `createProcessAdapter` is the Module's one runtime export (#202); the `ProcessAdapter` Interface it returns and every other export are types. The
  Interface is opaque: callers get normalized resolution, command, and owned-process outcomes and never a platform child. Only composition constructs
  an implementation (where and how many is its guidance's); no other Module constructs or imports one.
- Windows has no graceful stage (#127 A6, amended 2026-09-18): Windows' polite close (`taskkill` without `/F`) reaches only a window, and every child this
  Module spawns is `windowsHide: true` and so has none — verified on a desktop, where the same executable closed politely only when launched visible. So
  contained owned children terminate their job, and Node children use `taskkill /T /F` for both signals. `interrupt` force-kills a live child at once
  and reports `escalated: true` (a child already gone reports `false`). The graceful-stop proof is POSIX-only. Off Windows: SIGTERM, then SIGKILL.
- Windows owned launches attach a separate kill-on-close, no-breakaway job at creation. Only `windows-containment.ts` imports `bun:ffi`.
  The root starts suspended until its exit wait is registered. Any pre-execution failure releases the attempt before the Node fallback runs.
  Root-handle exit captures member handles, terminates the job, and confirms those plus later-listed handles before releasing the job and publishing
  `closed()`; controlled stops capture before termination too. The active list can drop a member before its handle signals, so pipe EOF or a later job
  list alone does not prove death. A child born after the first snapshot and gone from the list before the second remains an unconfirmed gap (#375).
  The existing close bound spans descendant-exit confirmation and output drain; a timeout is a cleanup error.
  The owned launch result, `spawn` fact, and interruption carry `contained` or `fallback`; Command spawns carry neither.
  Fallback launch results and facts retain the acquisition cause for translated operational logging (#363).
  Interrupt and stdin-close escalation terminate the whole job with a private stop code and record a reap only after a successful kill request;
  callers use child facts and cleanup outcomes, never exit codes, because kill-on-close can report zero. Failed termination records no kill.
- POSIX async roots are launched/reaped only by `posix-lifetime.ts` (ADR 0030, #387). WNOWAIT reserves root/group identity after exit;
  group signal authority retires before final reap and permanently on ownership loss. Root evidence and output drain are independent.
  `reap` records a group signal, retaining an already-exited root's status/signal. Escaped pipe holders cause bounded cleanup failure.
  SIGCHLD plus yielding 25 ms live-root probes cover Bun's fallback waiter; native state never blocks the JS thread.
  Unix stdio is one-way: end parent output sockets' unused write halves before launch to avoid Darwin's kqueue EOF reset.
  Oversized TMPDIR socket names use a short private acquisition folder; child cwd, argv, and environment remain authored.
- Interrupt is a two-stage shutdown that shares one `gracefulMs`: the process gets the whole bound to exit on the graceful signal, then the same bound
  again to die once force-killed. The bound is not split between the stages.
- Owned stdin keeps its own `error` listener through teardown; child-process errors do not cover pipe errors. `closeStdin` reaps before returning that cause
  as `cleanup-error`, while `closed()` keeps its independent native exit observation. Later writes reject the retained cause.
- The primary single-PATH-walk comment (D1, `walkPath`) covers only this Module's executable resolution; it must not be read as excluding the three git
  spawn sites (the Preflight worktree probe and the two Artifact-repo spawns) that pass the bare name `"git"` and let the OS resolve it through PATH.
- Child facts (#321): every spawn path reports through one `ChildWatch`, so its role, PID, and kill state agree across paths and it settles once.
  The role set and observer are type-only, so the one runtime export above stays the only one. A synchronous spawn reports `spawn` before it
  blocks and gets its PID only on settlement. `exit` means Secant sent no kill and `reap` means it did; `kill-escalation` follows the first kill on
  Windows, matching `interrupt`'s `escalated`. A `spawn-error` keeps only the native code, because the message, syscall, and stack name the
  executable. A sync child killed for overrunning `maxBuffer` returns an error and a PID, so it is a `reap`. A throwing observer is swallowed.
- Because the primary PATH walk cannot see a Windows App Execution Alias, a miss falls back to the first `where.exe` match (#165). The `.cmd`/`.bat` shim
  rule still applies to that path; Secant passes an alias path to the OS at spawn and never reads or resolves its AppExecLink target itself.
- An owned Windows launch with a bare name and no child PATH uses the Node fallback without a `where.exe` probe (#361). A missing executable keeps
  its typed `spawn-error` outcome.

## Tests

- `tests/process/fake-adapter.ts` is the scripted Process for the semantic suite. It refuses to emit output after its terminal result, so a test cannot
  script a child the real Interface would never produce; keep that throw when extending it. Given the factory's options, it reports each
  scripted child's start and settlement with a fake PID. The shared parity cases assert facts only for the real Adapter, which supplies `facts`;
  the composition suite asserts the fake's facts where the log reads them.
