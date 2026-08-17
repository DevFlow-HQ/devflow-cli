// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Settles one question with evidence instead of inference:
//
//   When the pty stream shows mouse-tracking ENABLE sequences on Windows, did our
//   application send them, or is that ConPTY's own terminal negotiation?
//
// It matters because the lifecycle assertion "you entered mouse tracking, so you
// must restore it" is only meaningful if the application is the one that entered
// it. If the sequences appear even when OpenTUI never creates a renderer, they
// are not ours and the assertion is measuring the wrong actor.
//
// Method: run the shell with CRUCIBLE_SHELL_FAIL=startup, which throws before
// createCliRenderer is ever called. Any mode sequence still present in the stream
// cannot have come from the renderer.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";
import { ensureSpawnHelperExecutable } from "./heal-node-pty.mjs";

ensureSpawnHelperExecutable();

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "main.mjs");
const ARM = process.env.CRUCIBLE_ARM ?? "bun";

function resolveRuntime(nameOrPath) {
  if (!nameOrPath) return process.execPath;
  if (nameOrPath.includes("/") || nameOrPath.includes("\\")) return nameOrPath;
  const finder = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(finder, [nameOrPath], { encoding: "utf8" });
  const first = (found.stdout ?? "").split(/\r?\n/).find((line) => line.trim());
  return first ? first.trim() : nameOrPath;
}

const RUNTIME = resolveRuntime(process.env.CRUCIBLE_RUNTIME ?? "bun");
const ARGS = ARM === "bun" ? [entry] : ["--experimental-ffi", "--no-warnings", entry];

const SEQUENCES = {
  "alt-screen on  ?1049h": "\x1b[?1049h",
  "alt-screen off ?1049l": "\x1b[?1049l",
  "mouse on       ?1000h": "\x1b[?1000h",
  "mouse off      ?1000l": "\x1b[?1000l",
  "btn-mouse on   ?1002h": "\x1b[?1002h",
  "btn-mouse off  ?1002l": "\x1b[?1002l",
  "any-mouse on   ?1003h": "\x1b[?1003h",
  "any-mouse off  ?1003l": "\x1b[?1003l",
  "sgr-mouse on   ?1006h": "\x1b[?1006h",
  "sgr-mouse off  ?1006l": "\x1b[?1006l",
  "paste on       ?2004h": "\x1b[?2004h",
  "paste off      ?2004l": "\x1b[?2004l",
};

function run(env, drive) {
  const logFile = join(mkdtempSync(join(tmpdir(), "crucible-probe-")), "log");
  return new Promise((resolve) => {
    const child = pty.spawn(RUNTIME, ARGS, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: join(here, ".."),
      env: { ...process.env, CRUCIBLE_TEARDOWN_LOG: logFile, ...env },
    });
    let out = "";
    child.onData((d) => {
      out += d;
      if (drive && out.length) drive(child, out);
    });
    child.onExit(() => setTimeout(() => resolve(out), 150));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      resolve(out);
    }, 15000);
  });
}

function census(out) {
  return Object.entries(SEQUENCES)
    .map(([label, seq]) => `    ${label}: ${out.includes(seq) ? "PRESENT" : "-"}`)
    .join("\n");
}

console.log(`platform=${process.platform} arm=${ARM} runtime=${RUNTIME}`);

// A. Renderer NEVER created. Anything present here is not ours.
const noRenderer = await run({ CRUCIBLE_SHELL_FAIL: "startup" });
console.log("\nA. renderer never created (CRUCIBLE_SHELL_FAIL=startup):");
console.log(census(noRenderer));

// B. Full run, quit normally.
let quit = false;
const full = await run({}, (child, out) => {
  if (!quit && out.includes("crucible")) {
    quit = true;
    setTimeout(() => child.write("q"), 400);
  }
});
console.log("\nB. full run, normal quit:");
console.log(census(full));

console.log(
  "\nVERDICT: any 'PRESENT' in A is ConPTY/terminal negotiation, not application output.",
);
