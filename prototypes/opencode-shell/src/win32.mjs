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
//
// The two FFI backends are NOT drop-in compatible. Measured on Bun 1.3.14 and
// Node 26.7.0 (`node:ffi` is behind --experimental-ffi and absent before 26):
//
//                 bun:ffi                  node:ffi
//   dlopen() ->   { symbols }              { lib, functions }
//   descriptor    { args, returns }        { arguments, return }
//   pointer type  "ptr"                    "pointer"
//   out-param     ffi.ptr(typedArray)      pass the typed array directly
//
// Both take the same lowercase string type names otherwise. The descriptor keys
// are the dangerous difference: node:ffi IGNORES unknown keys, so bun's
// { args, returns } silently compiles to a zero-argument void function that
// returns undefined for every call rather than failing. bindConsoleApi therefore
// proves the binding against a known answer before anyone relies on it.

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;

const INACTIVE = {
  active: false,
  initialMode: null,
  readMode: () => null,
  restore: () => {},
};

// Returns a normalised { getStdHandle, getConsoleMode, setConsoleMode } over
// whichever FFI backend this runtime provides, or undefined if there is none.
// Exported so scripts/real-terminal-check.mjs can read the console mode from the
// PARENT of the shell -- the only vantage point that observes what the user's
// terminal is actually left in.
export async function bindConsoleApi() {
  const isBun = typeof process.versions?.bun === "string";

  let ffi;
  try {
    ffi = isBun ? await import("bun:ffi") : await import("node:ffi");
  } catch {
    return undefined;
  }
  if (!ffi?.dlopen) return undefined;

  let api;
  try {
    if (isBun) {
      const { symbols } = ffi.dlopen("kernel32.dll", {
        GetCurrentProcessId: { args: [], returns: "u32" },
        GetLastError: { args: [], returns: "u32" },
        GetStdHandle: { args: ["i32"], returns: "ptr" },
        GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
        SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
      });
      api = {
        pid: () => symbols.GetCurrentProcessId(),
        lastError: () => symbols.GetLastError(),
        getStdHandle: (id) => symbols.GetStdHandle(id),
        getConsoleMode: (handle, out) => symbols.GetConsoleMode(handle, ffi.ptr(out)),
        setConsoleMode: (handle, mode) => symbols.SetConsoleMode(handle, mode),
      };
    } else {
      const { functions } = ffi.dlopen("kernel32.dll", {
        GetCurrentProcessId: { arguments: [], return: "u32" },
        GetLastError: { arguments: [], return: "u32" },
        GetStdHandle: { arguments: ["i32"], return: "pointer" },
        GetConsoleMode: { arguments: ["pointer", "pointer"], return: "i32" },
        SetConsoleMode: { arguments: ["pointer", "u32"], return: "i32" },
      });
      api = {
        pid: () => functions.GetCurrentProcessId(),
        lastError: () => functions.GetLastError(),
        getStdHandle: (id) => functions.GetStdHandle(id),
        getConsoleMode: (handle, out) => functions.GetConsoleMode(handle, out),
        setConsoleMode: (handle, mode) => functions.SetConsoleMode(handle, mode),
      };
    }
  } catch {
    return undefined;
  }

  // A mis-bound backend fails silently, so refuse to hand back an API that
  // cannot reproduce a value we already know.
  try {
    if (api.pid() !== process.pid) return undefined;
  } catch {
    return undefined;
  }

  return api;
}

export async function installWindowsConsoleGuard() {
  if (process.platform !== "win32") return INACTIVE;
  if (!process.stdin.isTTY) return INACTIVE;

  const k32 = await bindConsoleApi();
  if (!k32) return INACTIVE;

  const handle = k32.getStdHandle(STD_INPUT_HANDLE);
  const buf = new Uint32Array(1);

  // Failures carry their Win32 error, because a bare null costs a debugging round
  // trip. This is how the Node arm's teardown failure was identified as 233,
  // ERROR_PIPE_NOT_CONNECTED -- the ConPTY is gone by teardown, the handle is
  // fine -- rather than the stale-handle theory it superficially resembled.
  const diag = [];

  const readMode = () => {
    try {
      if (k32.getConsoleMode(handle, buf) === 0) {
        diag.push(`read:err=${k32.lastError()}:h=${handle}:now=${k32.getStdHandle(STD_INPUT_HANDLE)}`);
        return null;
      }
      return buf[0];
    } catch (error) {
      diag.push(`read:threw=${error.message}`);
      return null;
    }
  };

  const initialMode = readMode();
  if (initialMode === null) return INACTIVE;

  // EXPERIMENT SWITCH (#6): is this guard needed at all?
  //
  // OpenTUI puts the terminal in raw mode, and libuv's Windows raw mode clears
  // ENABLE_PROCESSED_INPUT itself -- which is precisely what this guard exists to
  // do. If that is so, the whole FFI dependency is redundant on the Node arm, and
  // with it the Node >= 26 and --experimental-ffi requirement. That is a material
  // input to the runtime choice in #21, so it is worth measuring rather than
  // assuming. Set CRUCIBLE_SKIP_CONSOLE_GUARD=1 and compare the mode read while
  // the TUI is live (recorded on the SHELL_READY line by src/main.mjs).
  const guardApplied = process.env.CRUCIBLE_SKIP_CONSOLE_GUARD !== "1";
  if (guardApplied) {
    k32.setConsoleMode(handle, initialMode & ~ENABLE_PROCESSED_INPUT);
  }

  let restored = false;
  return {
    active: true,
    initialMode,
    guardApplied,
    readMode,
    diagnostics: () => diag.join(" | "),
    restore() {
      if (restored) return;
      restored = true;
      try {
        if (k32.setConsoleMode(handle, initialMode) === 0) {
          diag.push(`restore:err=${k32.lastError()}`);
        }
      } catch (error) {
        diag.push(`restore:threw=${error.message}`);
      }
    },
  };
}
