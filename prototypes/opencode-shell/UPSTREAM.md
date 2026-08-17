# Upstream provenance

Required by the attribution constraints in `docs/research/opencode-tui-extraction-constraints.md`.

## Source

- Project: OpenCode, MIT licensed.
- Pinned commit: `38e10eb1408feb700021b8e8766fb0ab41bf84e2` (`origin/dev`, 2026-08-08) — the same commit
  the research is pinned to.
- Read from a detached worktree of the local checkout at
  `/home/rgarg/Documents/Software_Stuff/opencode`, whose `dev` branch had drifted to `2cba7e2` and was
  left untouched.

## What was actually copied

**No OpenCode source file was copied verbatim.** This prototype reimplements behaviour that was *read*
from the pinned tree. Recorded here anyway, because the semantics are derived:

| Upstream path                                | What was derived                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/tui/src/util/renderer.ts`          | Clear the terminal title *before* the idempotency check, then destroy.       |
| `packages/tui/src/app.tsx` (L186–363)        | Scope-based lifecycle: acquire renderer, register destroy as release action, scoped signal listener, destroy observed exactly once. |
| `packages/tui/src/terminal-win32.ts`         | `ENABLE_PROCESSED_INPUT` semantics on `STD_INPUT_HANDLE`, and restoring the original console mode on teardown. |

Divergence worth noting: upstream `terminal-win32.ts` does a top-level `import { dlopen, ptr } from
"bun:ffi"`, which is a hard Bun dependency in a statically imported module and fails at import time
under Node. `src/win32.mjs` resolves the FFI backend lazily so one source file loads on both arms.

## Third-party

- `@opentui/core` 0.4.5, `@opentui/solid` 0.4.5, `solid-js` 1.9.12 — MIT.
- `@opentui/core-{linux,darwin,win32}-{x64,arm64}[-musl]` 0.4.5 — native packages, MIT.
- `node-pty` 1.1.0 — MIT. Test harness only; not part of any shipped artifact.

A full locked transitive licence inventory is a release obligation, not a prototype one, and has not
been produced here.

## Not carried over

No OpenCode domain type, SDK client, event name, provider, session, message, part, permission,
question, project or workspace concept appears anywhere in this tree.
