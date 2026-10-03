# process — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The `ProcessAdapter` Interface and `createProcessAdapter` are the Module's only runtime exports (#202). The Interface is opaque: callers get normalized
  resolution, command, and owned-process outcomes and never a platform child. Only composition constructs an implementation (where and how many is
  its guidance's); no other Module constructs or imports one.
- Windows has no graceful stage (#127 A6, amended 2026-09-18): Windows' polite close (`taskkill` without `/F`) reaches only a window, and every child this
  Module spawns is `windowsHide: true` and so has none — verified on a desktop, where the same executable closed politely only when launched visible. So
  `killGroup` runs `taskkill /T /F` for both signals there, `interrupt` force-kills a live child at once and reports `escalated: true` (a child already
  gone reports `false`), and the graceful-stop proof in the spawn suite is POSIX-only by design. Off Windows: SIGTERM to the group, then SIGKILL.
- Interrupt is a two-stage shutdown that shares one `gracefulMs`: the process gets the whole bound to exit on the graceful signal, then the same bound
  again to die once force-killed. The bound is not split between the stages.
- The primary single-PATH-walk comment (D1, `walkPath`) covers only this Module's executable resolution; it must not be read as excluding the three git
  spawn sites (the Preflight worktree probe and the two Artifact-repo spawns) that pass the bare name `"git"` and let the OS resolve it through PATH.
- Child facts (#321): every spawn path reports through one `ChildWatch`, so its role, PID, and kill state agree across paths and it settles once.
  The role set and observer are type-only, so the two runtime exports above stay the only ones. A synchronous spawn reports `spawn` before it
  blocks and gets its PID only on settlement. `exit` means Secant sent no kill and `reap` means it did; `kill-escalation` follows the first kill on
  Windows, matching `interrupt`'s `escalated`. A `spawn-error` keeps only the native code, because the message, syscall, and stack name the
  executable. A sync child killed for overrunning `maxBuffer` returns an error and a PID, so it is a `reap`. A throwing observer is swallowed.
- Because the primary PATH walk cannot see a Windows App Execution Alias, a miss falls back to the first `where.exe` match (#165). The `.cmd`/`.bat` shim
  rule still applies to that path; Secant passes an alias path to the OS at spawn and never reads or resolves its AppExecLink target itself.

## Tests

- `tests/process/fake-adapter.ts` is the scripted Process for the semantic suite. It refuses to emit output after its terminal result, so a test cannot
  script a child the real Interface would never produce; keep that throw when extending it. Given the factory's options, it reports each
  scripted child's start and settlement with a fake PID. The shared parity cases assert facts only for the real Adapter, which supplies `facts`;
  the composition suite asserts the fake's facts where the log reads them.
