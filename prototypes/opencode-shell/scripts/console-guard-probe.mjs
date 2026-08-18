// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Is installWindowsConsoleGuard needed at all?
//
// src/win32.mjs is the ONLY reason this prototype's Node arm requires Node >= 26
// and --experimental-ffi: node:ffi exists nowhere earlier. That requirement is
// reported upward as a cost of choosing Node as Crucible's runtime (#21). It is
// only a real cost if the guard does something OpenTUI would not have done anyway.
//
// The guard clears ENABLE_PROCESSED_INPUT so Ctrl-C arrives as a keypress rather
// than a CTRL_C_EVENT. But OpenTUI puts the terminal in raw mode, and libuv's
// Windows raw mode clears that same flag. If raw mode alone is sufficient, the FFI
// -- and the Node 26 floor with it -- is redundant.
//
// This measures it directly rather than inferring it from Ctrl-C behaviour: the
// shell records the console mode while the TUI is live (the SHELL_READY line), and
// this runs it twice, with the guard applied and skipped.
//
//   node scripts/console-guard-probe.mjs           # bun arm (default)
//   CRUCIBLE_RUNTIME=<path> node scripts/console-guard-probe.mjs
//
// Bun is the default arm because the Node arm cannot read its console mode back
// under ConPTY at all (233, ERROR_PIPE_NOT_CONNECTED) -- but the reading taken at
// SHELL_READY happens long before teardown, so both arms are measurable here.

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const ENABLE_PROCESSED_INPUT = 0x0001;
const RUNTIME = process.env.CRUCIBLE_RUNTIME ?? "bun";
const isBun = /bun(\.exe)?$/i.test(RUNTIME);
const ARGS = isBun
  ? [join(root, "src/main.mjs")]
  : ["--experimental-ffi", "--no-warnings", join(root, "src/main.mjs")];

if (process.platform !== "win32") {
  console.error("Windows-only: there is no console mode to measure elsewhere.");
  process.exit(1);
}

function run(skipGuard) {
  const logFile = join(mkdtempSync(join(tmpdir(), "crucible-guard-")), "log");
  return new Promise((resolve) => {
    const child = pty.spawn(RUNTIME, ARGS, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: root,
      env: {
        ...process.env,
        CRUCIBLE_TEARDOWN_LOG: logFile,
        ...(skipGuard ? { CRUCIBLE_SKIP_CONSOLE_GUARD: "1" } : {}),
      },
    });

    const readLog = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(readLog());
    };

    const poll = setInterval(() => {
      if (!readLog().includes("SHELL_READY")) return;
      clearInterval(poll); // fire ONCE: repeated writes into a closing pty give EAGAIN
      setTimeout(() => {
        try {
          child.write("q");
        } catch {
          /* already exiting */
        }
      }, 150);
    }, 25);
    const timer = setTimeout(finish, 20000);
    child.onExit(() => setTimeout(finish, 80));
  });
}

function report(label, log) {
  const match = log.match(/guardApplied=(\S+) initialConsoleMode=(\S+) liveConsoleMode=(\S+)/);
  console.log(`\n${label}`);
  if (!match) {
    console.log(`  no reading -- log was ${JSON.stringify(log)}`);
    return undefined;
  }
  const [, applied, initial, live] = match;
  const liveNum = Number(live);
  const processed = Number.isNaN(liveNum) ? null : (liveNum & ENABLE_PROCESSED_INPUT) !== 0;
  console.log(`  guard applied            ${applied}`);
  console.log(`  console mode at start    ${initial}`);
  console.log(`  console mode while live  ${live}`);
  console.log(
    `  ENABLE_PROCESSED_INPUT   ${processed === null ? "unreadable" : processed ? "SET" : "clear"}`,
  );
  return processed;
}

console.log(`runtime: ${RUNTIME}`);
const withGuard = report("A. guard APPLIED (current behaviour)", await run(false));
const without = report("B. guard SKIPPED (CRUCIBLE_SKIP_CONSOLE_GUARD=1)", await run(true));

console.log(`\n${"=".repeat(64)}`);
if (withGuard === null || without === null) {
  console.log("INCONCLUSIVE -- console mode could not be read in one or both runs.");
} else if (withGuard === false && without === false) {
  console.log("The guard is REDUNDANT on this runtime.");
  console.log("ENABLE_PROCESSED_INPUT is already clear without it, so OpenTUI's raw");
  console.log("mode is doing the job. The FFI dependency -- and on the Node arm the");
  console.log("Node >= 26 / --experimental-ffi floor it forces -- buys nothing here.");
} else if (withGuard === false && without === true) {
  console.log("The guard is LOAD-BEARING on this runtime.");
  console.log("ENABLE_PROCESSED_INPUT stays SET without it, so raw mode alone does not");
  console.log("clear it and Ctrl-C would arrive as CTRL_C_EVENT. The FFI dependency is");
  console.log("genuinely required, and the Node arm really does need Node >= 26.");
} else {
  console.log("UNEXPECTED: the guard did not clear ENABLE_PROCESSED_INPUT when applied.");
}
console.log("=".repeat(64));
