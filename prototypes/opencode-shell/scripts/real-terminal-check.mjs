// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// The one piece of evidence CI structurally cannot produce.
//
// Every automated Windows check in this prototype runs the shell under ConPTY,
// and ConPTY is not a terminal -- it is a screen scraper on one side and a pipe
// on the other. Two claims therefore remain unproven by the harness:
//
//   1. Mouse tracking. ConPTY forwards the mouse ENABLE sequences but swallows
//      the DISABLEs (scripts/conpty-probe.mjs proved the enables are ours, not
//      ConPTY negotiation). So the harness cannot tell whether a real terminal is
//      left reporting mouse events after exit.
//   2. Console mode, on the Node arm only. Under ConPTY the console input pipe is
//      already disconnected by teardown time (GetConsoleMode fails with 233,
//      ERROR_PIPE_NOT_CONNECTED), so both the restore and the read-back fail. The
//      Bun arm does not hit this. Whether that is a ConPTY artifact or a real
//      Node defect can only be settled in a real console.
//
// This script runs in a REAL terminal and measures from the PARENT process, which
// is the vantage point that matters: it is the console the human is left holding.
//
// Run it in Windows Terminal, PowerShell or conhost -- NOT through a pty, and not
// through an IDE task pane:
//
//   node --experimental-ffi --no-warnings scripts/real-terminal-check.mjs node
//   node --experimental-ffi --no-warnings scripts/real-terminal-check.mjs bun
//
// The runtime argument may also be an absolute path to a node/bun binary.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { bindConsoleApi } from "../src/win32.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;

const MOUSE_MODES = ["1000", "1002", "1003", "1006"];

if (process.platform !== "win32") {
  console.error("This check is Windows-only; there is nothing to prove elsewhere.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error(
    "Not a real terminal (stdin is not a TTY).\n" +
      "Run this directly in Windows Terminal / PowerShell / conhost -- that is the entire point.",
  );
  process.exit(1);
}

const arm = process.argv[2] ?? "node";
const runtime = arm === "bun" ? "bun" : arm === "node" ? process.execPath : arm;
const isBunRuntime = /bun(\.exe)?$/i.test(runtime);
const args = isBunRuntime
  ? [resolve(ROOT, "src/main.mjs")]
  : ["--experimental-ffi", "--no-warnings", resolve(ROOT, "src/main.mjs")];

const k32 = await bindConsoleApi();
if (!k32) {
  console.error(
    "No usable FFI in THIS process.\n" +
      "Re-run under Node >= 26 with --experimental-ffi, or under bun.",
  );
  process.exit(1);
}

const handle = k32.getStdHandle(STD_INPUT_HANDLE);
const buf = new Uint32Array(1);
function parentConsoleMode() {
  if (k32.getConsoleMode(handle, buf) === 0) return { mode: null, err: k32.lastError() };
  return { mode: buf[0], err: 0 };
}

const before = parentConsoleMode();
if (before.mode === null) {
  console.error(`Could not read this console's mode (Win32 error ${before.err}).`);
  process.exit(1);
}

const log = resolve(tmpdir(), `crucible-real-terminal-${process.pid}.log`);
if (existsSync(log)) rmSync(log);

console.log("=".repeat(72));
console.log("Crucible shell -- REAL TERMINAL check (#6)");
console.log("=".repeat(72));
console.log(`arm            ${arm}`);
console.log(`runtime        ${runtime}`);
console.log(`console mode   ${before.mode} (0x${before.mode.toString(16)}) before launch`);
console.log(`  ENABLE_PROCESSED_INPUT is ${before.mode & ENABLE_PROCESSED_INPUT ? "SET" : "clear"}`);
console.log("");
console.log("The shell is about to take over this terminal.");
console.log("Press 'q' to quit it normally, or Ctrl-C to quit via the interrupt path.");
console.log("");
console.log("Press Enter to launch...");

await new Promise((done) => process.stdin.once("data", done));

const exit = await new Promise((done) => {
  const child = spawn(runtime, args, {
    stdio: "inherit",
    env: { ...process.env, CRUCIBLE_TEARDOWN_LOG: log },
  });
  child.on("error", (error) => {
    console.error(`\nfailed to launch ${runtime}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => done({ code, signal }));
});

// Measured from the parent, in the real console, after the child is gone. This is
// the state the human is actually left with.
const after = parentConsoleMode();
const teardownLog = existsSync(log) ? readFileSync(log, "utf8") : "(no teardown log written)";
if (existsSync(log)) rmSync(log);

console.log("");
console.log("=".repeat(72));
console.log("RESULTS");
console.log("=".repeat(72));
console.log(`child exit          code=${exit.code} signal=${exit.signal}`);
console.log("");
console.log("Console mode, measured in this real console:");
console.log(`  before            ${before.mode} (0x${before.mode.toString(16)})`);
console.log(
  `  after             ${after.mode === null ? `UNREADABLE (Win32 error ${after.err})` : `${after.mode} (0x${after.mode.toString(16)})`}`,
);
const consoleVerdict =
  after.mode === null
    ? "INCONCLUSIVE -- could not read the console mode back"
    : after.mode === before.mode
      ? "PASS -- console mode restored exactly"
      : `FAIL -- console mode changed by ${before.mode} -> ${after.mode}`;
console.log(`  verdict           ${consoleVerdict}`);
console.log("");
console.log("Shell's own teardown record (written to a side channel, not the terminal):");
for (const line of teardownLog.trimEnd().split("\n")) console.log(`  ${line}`);
console.log("");
console.log("-".repeat(72));
console.log("NOW THE PART ONLY A HUMAN CAN JUDGE:");
console.log("");
console.log("  1. Click somewhere in this terminal window, and drag a little.");
console.log("  2. Move the mouse over the window.");
console.log("");
console.log("  If you see junk appear -- things like  ^[[<0;40;12M  or  \\x1b[M ... --");
console.log(`  then mouse reporting (${MOUSE_MODES.join("/")}) was left ON. That is a`);
console.log("  RELEASE BLOCKER per the extraction research, and the fix belongs in");
console.log("  Crucible's teardown, not in the test.");
console.log("");
console.log("  If clicking and dragging behave completely normally, mouse reporting");
console.log("  was correctly disabled and ConPTY was simply swallowing the disables.");
console.log("");
console.log("  Also check: does typing still echo? Does Ctrl-C still work?");
console.log("-".repeat(72));
