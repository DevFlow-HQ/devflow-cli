# Crucible shell prototype (THROWAWAY)

Prototype for [#6](https://github.com/DevFlow-HQ/devflow-cli/issues/6). **Not production code.**
Nothing in `src/` imports this, and nothing here may be promoted without a deliberate migration under
`docs/agents/engineering-baseline.md`.

## Falsifiable question

Can a minimal OpenCode-derived Crucible shell start, render, accept input, resize, exit, restore the
terminal after normal and abnormal termination, run through a testable renderer seam, and package
successfully on Windows, macOS and Linux — without importing OpenCode domain state or prematurely
committing Crucible to an unsuitable runtime?

## Accept / reject

**Accept** when, on all three platforms:

1. every exit path (normal, Ctrl-C, `SIGTERM`, `SIGHUP`, startup failure, render failure, uncaught
   exception, unhandled rejection, and ten repeated cycles) restores the terminal — verified as
   emitted escape sequences in a real PTY, not asserted in the abstract — and teardown runs
   **exactly once**;
2. the whole lifecycle is drivable through the Crucible-owned `RendererPort` with no terminal, no
   OpenTUI and no OpenCode server;
3. a packaged artifact runs outside its build workspace with no `node_modules` present;
4. no file imports `@opencode-ai/*` or any OpenCode domain type.

**Reject** if any exercised exit path leaves the terminal corrupted on any supported platform, if the
seam cannot be tested without a real terminal, or if packaging cannot locate its native library
outside the workspace.

## What is deliberately NOT here

Port depth and semantic fit — sessions, messages, tool calls, agents, permissions, questions — belong
to [#17](https://github.com/DevFlow-HQ/devflow-cli/issues/17), not to this ticket. The view is a
static frame with a key log on purpose. Solid/TSX composition is likewise out: it is a separate
transform variable that would confound the runtime answer.

## Layout

| Path                      | Role                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `src/renderer-port.mjs`   | The Crucible-owned seam. The only thing the shell talks to.        |
| `src/shell.mjs`           | Runtime-agnostic lifecycle. Owns teardown-exactly-once.            |
| `src/opentui-renderer.mjs`| Real port implementation over OpenTUI 0.4.5. Identical on both arms.|
| `src/fake-renderer.mjs`   | Deterministic port implementation. No terminal, no native library. |
| `src/win32.mjs`           | Windows console mode. The one genuinely runtime-divergent file.    |
| `src/main.mjs`            | Single entry for both arms.                                        |
| `src/spike.mjs`           | Does OpenTUI load/create/destroy under this runtime at all?         |
| `test/seam.test.mjs`      | Lifecycle through the fake port. Stock Node, any platform.         |
| `test/lifecycle.pty.test.mjs` | Real PTY (ConPTY on Windows). The cross-platform evidence.      |
| `scripts/conpty-probe.mjs`| Which actor emits each terminal mode sequence on Windows.          |
| `scripts/real-terminal-check.mjs` | The Windows evidence ConPTY cannot give. Human-run.        |

## Windows is measured differently, on purpose

ConPTY is not a byte pipe. It interprets escape sequences into console state and
re-emits its own rendering of the screen buffer, so on Windows the pty stream is a
*screenshot*, not a transcript. Three consequences shaped the evidence here:

- **Readiness and teardown accounting go to a side-channel file**, never stdout.
- **Mouse-disable sequences are not wire-observable.** ConPTY forwards the enables
  and swallows the disables; `scripts/conpty-probe.mjs` proved the enables are ours
  rather than ConPTY negotiation. Asserting them would test ConPTY's passthrough.
- **Console mode is unreadable at teardown on the Node arm.** Keypress-driven exits
  reach teardown after ConPTY has dropped the console input pipe, so `GetConsoleMode`
  fails with 233 `ERROR_PIPE_NOT_CONNECTED`. The handle is valid; there is no console
  behind it. The Bun arm does not hit this.

What ConPTY cannot answer, a human answers with `scripts/real-terminal-check.mjs`,
which measures the console from the shell's **parent** in a real terminal — the state
the user is actually left holding. Verified on Windows 11 / PowerShell, all paths
`503 -> 503` with no mouse residue: normal quit, Ctrl-C, and render failure. That is
what licenses scoping those two assertions out of the harness rather than deleting them.

**General rule for this codebase: on Windows, measure over a real API or a side
channel, never over the terminal.**

### Windows Terminal is proven; legacy conhost is not

Everything above holds in Windows Terminal. In the **legacy console host**
(`conhost.exe powershell.exe`), OpenTUI's `renderer.destroy()` destroys the
console: the window closes itself a few seconds after the shell exits, and both
the shell's own `SetConsoleMode` and a *parent* process's `GetConsoleMode` fail
with 233. Four runs isolate the cause:

| run                        | renderer     | at `SHELL_READY` | after teardown | window   |
| -------------------------- | ------------ | ---------------- | -------------- | -------- |
| `CRUCIBLE_SHELL_FAIL=startup` | never created | —             | `503 -> 503`   | survives |
| guard applied              | created      | 520, readable    | 233, gone      | dies     |
| `CRUCIBLE_SKIP_CONSOLE_GUARD=1` | created | 520, readable    | 233, gone      | dies     |
| via `real-terminal-check`  | created      | 520, readable    | 233, gone      | dies     |

The console is alive *after* `createCliRenderer` and gone *after*
`renderer.destroy()`. Our teardown, the console guard and the parent/child console
sharing in `real-terminal-check.mjs` were each ruled out by control runs — the
guard makes no difference, and skipping the renderer entirely is clean.

This is an **adoption and maintenance cost of the OpenCode-derived renderer**, not
a defect in Crucible's teardown, so it belongs to
[#17](https://github.com/DevFlow-HQ/devflow-cli/issues/17) rather than to this
prototype. Recorded here so it is not rediscovered later.

## Running it

```bash
# The lockfile is committed because this prototype IS the evidence behind #6 and
# #33, so its dependency set is part of the measurement. package.json pins only
# four direct dependencies; the lockfile pins 111 and carries integrity hashes,
# which catch a republished tarball at an unchanged version number.
#
# `ci`, not `install`: with a lockfile present both install from it, but `install`
# silently rewrites it when it disagrees with package.json, where `ci` fails. For a
# re-run that is the whole point -- drift should stop the measurement rather than
# be quietly absorbed into it.
npm ci

# lifecycle through the seam - no terminal needed, runs anywhere
node --test test/seam.test.mjs

# interactive, pick an arm
bun src/main.mjs
node --experimental-ffi src/main.mjs        # Node >= 26 ONLY

# real-PTY evidence (CRUCIBLE_RUNTIME must be absolute or on PATH: node-pty does no PATH lookup)
CRUCIBLE_ARM=bun  CRUCIBLE_RUNTIME=bun  node --test test/lifecycle.pty.test.mjs
CRUCIBLE_ARM=node CRUCIBLE_RUNTIME=node node --test test/lifecycle.pty.test.mjs

# packaging
# Re-run this after ANY npm ci: only the host's optional native is in the install
# tree, so ci prunes the other seven and the cross-compile stops resolving them.
node scripts/install-natives.mjs                            # required before compiling
bun build --compile src/main.mjs --outfile dist/crucible-shell
node scripts/smoke-packaged.mjs
```

Windows only, and **not** through a pty — run these in a real console window:

```powershell
# who emits which mode sequence
node scripts/conpty-probe.mjs

# the evidence CI structurally cannot produce; needs a real TTY and a human
node --experimental-ffi --no-warnings scripts/real-terminal-check.mjs node
node --experimental-ffi --no-warnings scripts/real-terminal-check.mjs bun
```

Cross-platform runs happen in `.github/workflows/prototype-shell.yml`, which exists only on this
branch.

## Cleanup / adoption

Throwaway. On adoption, only the *decisions* move into production; this tree is deleted with its
branch and its workflow. See the resolution comment on #6.
