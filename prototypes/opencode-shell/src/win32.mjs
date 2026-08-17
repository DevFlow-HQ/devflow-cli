// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Windows console mode is the one place the two runtime arms genuinely diverge.
//
// OpenCode's packages/tui/src/terminal-win32.ts does `import { dlopen, ptr } from
// "bun:ffi"` at module top level. That is a hard Bun dependency in a statically
// imported module: under Node it fails at import time, before any of our code
// runs. Crucible cannot copy that file as-is if it wants a Node arm.
//
// This version resolves the FFI backend lazily, so the same source loads on both
// runtimes and on non-Windows platforms.
//
// Semantics copied from OpenCode (MIT): clear ENABLE_PROCESSED_INPUT so Ctrl-C
// arrives as stdin input instead of a CTRL_C_EVENT, and restore the ORIGINAL
// console mode on teardown.

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;

const NOOP = () => {};

async function loadFfi() {
  const isBun = typeof process.versions?.bun === "string";
  try {
    return isBun ? await import("bun:ffi") : await import("node:ffi");
  } catch {
    return undefined;
  }
}

export function installWindowsConsoleGuard() {
  if (process.platform !== "win32") return NOOP;
  if (!process.stdin.isTTY) return NOOP;

  // Synchronous contract, async FFI load: resolve eagerly and let the returned
  // restore function await the pending work. Good enough for a prototype.
  let restore = NOOP;
  const pending = loadFfi()
    .then((ffi) => {
      if (!ffi?.dlopen) return;
      const k32 = ffi.dlopen("kernel32.dll", {
        GetStdHandle: { args: ["i32"], returns: "ptr" },
        GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
        SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
      });
      const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
      const buf = new Uint32Array(1);
      if (k32.symbols.GetConsoleMode(handle, ffi.ptr(buf)) === 0) return;
      const initial = buf[0];
      k32.symbols.SetConsoleMode(handle, initial & ~ENABLE_PROCESSED_INPUT);
      restore = () => {
        k32.symbols.SetConsoleMode(handle, initial);
        restore = NOOP;
      };
    })
    .catch(() => {});

  return () => {
    void pending.then(() => restore());
    restore();
  };
}
