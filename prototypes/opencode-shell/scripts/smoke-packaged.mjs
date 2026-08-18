// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Copies the compiled binary to a scratch directory that contains NO node_modules,
// launches it in a real PTY with a minimal environment, and asserts it renders,
// accepts input, exits cleanly and restores the terminal.
//
// This is the packaging question: can the artifact find its native library,
// parser worker and assets without the build workspace?

import { mkdtempSync, copyFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { ensureSpawnHelperExecutable } from "./heal-node-pty.mjs";

ensureSpawnHelperExecutable();

const here = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const binaryName = isWindows ? "crucible-shell.exe" : "crucible-shell";
const built = join(here, "..", "dist", isWindows ? "crucible-shell.exe" : "crucible-shell");

const scratch = mkdtempSync(join(tmpdir(), "crucible-packaged-"));
const target = join(scratch, binaryName);
copyFileSync(built, target);
if (!isWindows) chmodSync(target, 0o755);

console.log(`launching ${target} from a directory with no node_modules`);

// FINDING: the Bun-compiled binary extracts its embedded OpenTUI native library
// into the system temp directory and dlopens it from there. A malformed temp
// variable is fatal -- node-pty stringifies an `undefined` value, so passing
// `TEMP: undefined` reaches the child as the literal "undefined" and the binary
// dies with `Failed to open library "/$bunfs/root/libopentui-*.so"`.
// Hence: only forward variables that are actually set.
//
// Readiness and teardown accounting travel over a side-channel FILE, never over
// the pty. ConPTY is a screen scraper: it re-emits a rendering of the console
// screen buffer, so plain stdout text written while the alternate screen is
// active is absorbed into the screen contents and never appears as a literal
// line. Scraping stdout for SHELL_READY works on Linux and macOS and can never
// work on Windows -- it simply timed out, having rendered perfectly. Same fix as
// test/lifecycle.pty.test.mjs; it was missed here only because Windows packaging
// was never reached before.
const logFile = join(scratch, "teardown.log");
const minimalEnv = Object.fromEntries(
  Object.entries({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    TERM: "xterm-256color",
    CRUCIBLE_TEARDOWN_LOG: logFile,
  }).filter(([, value]) => value !== undefined),
);

const readLog = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");

const child = pty.spawn(target, [], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: scratch,
  env: minimalEnv,
});

let out = "";
child.onData((d) => {
  out += d;
});

const readyPoll = setInterval(() => {
  if (!readLog().includes("SHELL_READY")) return;
  clearInterval(readyPoll);
  setTimeout(() => child.write("q"), 200);
}, 25);

const timeout = setTimeout(() => {
  clearInterval(readyPoll);
  child.kill();
  console.error("TIMED OUT.");
  console.error("  teardownLog:", JSON.stringify(readLog()));
  console.error("  tail:", JSON.stringify(out.slice(-600)));
  process.exit(1);
}, 30000);

child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  clearInterval(readyPoll);
  const log = readLog();
  const checks = {
    // From the side channel: text the terminal cannot be trusted to carry.
    "reported ready": log.includes("SHELL_READY"),
    "tore down exactly once": (log.match(/SHELL_TEARDOWN/g) ?? []).length === 1,
    // From the wire: ConPTY forwards both of these, so they hold on all three.
    "rendered a frame": out.includes("crucible"),
    "exited alternate screen": out.includes("\x1b[?1049l"),
    "restored the cursor": out.includes("\x1b[?25h"),
    "exited zero": exitCode === 0,
  };
  let failed = false;
  for (const [what, ok] of Object.entries(checks)) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failed = true;
  }
  if (failed) {
    console.error("teardownLog:", JSON.stringify(log));
    console.error("tail:", JSON.stringify(out.slice(-600)));
    process.exit(1);
  }
  console.log("packaged binary works outside its workspace");
  process.exit(0);
});
