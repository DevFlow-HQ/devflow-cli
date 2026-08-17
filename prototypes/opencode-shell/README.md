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

## Running it

```bash
npm install

# lifecycle through the seam - no terminal needed, runs anywhere
node --test test/seam.test.mjs

# interactive, pick an arm
bun src/main.mjs
node --experimental-ffi src/main.mjs        # Node >= 26 ONLY

# real-PTY evidence
CRUCIBLE_ARM=bun  CRUCIBLE_RUNTIME=bun  node --test test/lifecycle.pty.test.mjs
CRUCIBLE_ARM=node CRUCIBLE_RUNTIME=node node --test test/lifecycle.pty.test.mjs

# packaging
bun build --compile src/main.mjs --outfile dist/crucible-shell
node scripts/smoke-packaged.mjs
```

Cross-platform runs happen in `.github/workflows/prototype-shell.yml`, which exists only on this
branch.

## Cleanup / adoption

Throwaway. On adoption, only the *decisions* move into production; this tree is deleted with its
branch and its workflow. See the resolution comment on #6.
