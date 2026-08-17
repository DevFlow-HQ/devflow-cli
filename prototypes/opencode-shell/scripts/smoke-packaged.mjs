// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Copies the compiled binary to a scratch directory that contains NO node_modules,
// launches it in a real PTY with a minimal environment, and asserts it renders,
// accepts input, exits cleanly and restores the terminal.
//
// This is the packaging question: can the artifact find its native library,
// parser worker and assets without the build workspace?

import { mkdtempSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";

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
  }).filter(([, value]) => value !== undefined),
);

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
  if (out.includes("SHELL_READY")) setTimeout(() => child.write("q"), 200);
});

const timeout = setTimeout(() => {
  child.kill();
  console.error("TIMED OUT. tail:", JSON.stringify(out.slice(-600)));
  process.exit(1);
}, 30000);

child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  const checks = {
    "reported ready": out.includes("SHELL_READY"),
    "rendered a frame": out.includes("crucible"),
    "tore down exactly once": (out.match(/SHELL_TEARDOWN/g) ?? []).length === 1,
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
    console.error("tail:", JSON.stringify(out.slice(-600)));
    process.exit(1);
  }
  console.log("packaged binary works outside its workspace");
  process.exit(0);
});
