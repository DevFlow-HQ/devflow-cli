// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Single entry for BOTH runtime arms. Run it as:
//   bun  src/main.mjs
//   node --experimental-ffi src/main.mjs      (Node >= 26 only)
//
// CRUCIBLE_SHELL_FAIL selects an abnormal path for the PTY harness:
//   startup | render | throw | reject

import { writeSync, appendFileSync } from "node:fs";
import { createShell } from "./shell.mjs";
import { createOpenTuiRenderer } from "./opentui-renderer.mjs";
import { assertRendererPort } from "./renderer-port.mjs";
import { installWindowsConsoleGuard } from "./win32.mjs";

const fail = process.env.CRUCIBLE_SHELL_FAIL ?? "";
const restoreWindowsConsole = installWindowsConsoleGuard();

// Teardown accounting goes to a FILE, never to the terminal.
//
// Terminal restoration must be proven by bytes on the wire -- that is the actual
// claim. But the teardown COUNTER must not be, because a process that exits
// immediately after writing races the pty: both process.stdout.write and
// writeSync(1) lost the marker on roughly a third of rapid-Ctrl-C runs while the
// terminal was restored perfectly every time. Measuring the counter over the same
// channel the shell is tearing down produces false failures.
const LOG = process.env.CRUCIBLE_TEARDOWN_LOG;
function recordTeardown(reason, count) {
  if (LOG) appendFileSync(LOG, `SHELL_TEARDOWN reason=${reason} count=${count}\n`);
  else writeSync(1, `SHELL_TEARDOWN reason=${reason} count=${count}\n`);
}

let renderer;
try {
  renderer = assertRendererPort(
    await createOpenTuiRenderer({ failOnStart: fail === "startup" }),
  );
} catch (error) {
  // Startup failure: nothing to restore in the renderer, but the Windows console
  // guard already changed global state and MUST be undone.
  restoreWindowsConsole();
  process.stderr.write(`startup failed: ${error.message}\n`);
  recordTeardown("startup-failure", 1);
  process.exit(1);
}

const shell = createShell({
  renderer,
  process,
  onExit: ({ reason, teardownCount }) => {
    restoreWindowsConsole();
    recordTeardown(reason, teardownCount);
  },
});

shell.start();
process.stdout.write("SHELL_READY\n");

if (fail === "render") {
  setTimeout(() => {
    try {
      renderer.render(null);
    } catch (error) {
      void shell.teardown("render-failure").then(() => {
        process.stderr.write(`render failed: ${error.message}\n`);
        process.exit(1);
      });
    }
  }, 150);
}

if (fail === "throw") {
  setTimeout(() => {
    throw new Error("forced uncaught exception");
  }, 150);
}

if (fail === "reject") {
  setTimeout(() => {
    void Promise.reject(new Error("forced unhandled rejection"));
  }, 150);
}
