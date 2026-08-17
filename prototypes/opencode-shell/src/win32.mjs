// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Windows console mode is the one place the two runtime arms genuinely diverge --
// and the one place terminal restoration CANNOT be proven by watching escape
// sequences on the wire. Windows console state lives behind SetConsoleMode, not
// behind bytes, so a pty-level byte assertion is blind to it.
//
// This module therefore does two jobs:
//   1. Own the ENABLE_PROCESSED_INPUT change (so Ctrl-C arrives as input, not as
//      a CTRL_C_EVENT) and restore the ORIGINAL mode on teardown.
//   2. Expose the raw mode value so the shell can record it at start and at exit,
//      letting the harness assert equality directly. That is real evidence for
//      Windows rather than an inference from Unix behaviour.
//
// Semantics derived from OpenCode's packages/tui/src/terminal-win32.ts (MIT).
// Divergence: OpenCode does a top-level `import { dlopen, ptr } from "bun:ffi"`,
// which is a hard Bun dependency in a statically imported module and fails at
// import time under Node. This resolves the FFI backend lazily so one source file
// loads on both arms and on non-Windows platforms.

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;

const INACTIVE = {
  active: false,
  initialMode: null,
  readMode: () => null,
  restore: () => {},
};

async function loadFfi() {
  const isBun = typeof process.versions?.bun === "string";
  try {
    return isBun ? await import("bun:ffi") : await import("node:ffi");
  } catch {
    return undefined;
  }
}

export async function installWindowsConsoleGuard() {
  if (process.platform !== "win32") return INACTIVE;
  if (!process.stdin.isTTY) return INACTIVE;

  const ffi = await loadFfi();
  if (!ffi?.dlopen) return INACTIVE;

  let k32;
  try {
    k32 = ffi.dlopen("kernel32.dll", {
      GetStdHandle: { args: ["i32"], returns: "ptr" },
      GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
      SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    });
  } catch {
    return INACTIVE;
  }

  const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
  const buf = new Uint32Array(1);

  const readMode = () => {
    try {
      if (k32.symbols.GetConsoleMode(handle, ffi.ptr(buf)) === 0) return null;
      return buf[0];
    } catch {
      return null;
    }
  };

  const initialMode = readMode();
  if (initialMode === null) return INACTIVE;

  k32.symbols.SetConsoleMode(handle, initialMode & ~ENABLE_PROCESSED_INPUT);

  let restored = false;
  return {
    active: true,
    initialMode,
    readMode,
    restore() {
      if (restored) return;
      restored = true;
      try {
        k32.symbols.SetConsoleMode(handle, initialMode);
      } catch {
        /* nothing further we can do */
      }
    },
  };
}
