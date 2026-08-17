// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Real-PTY lifecycle evidence. Launches the shell inside an actual pseudo-terminal
// (ConPTY on Windows) and asserts that after every exit path the terminal-restoring
// escape sequences were actually emitted, and that teardown ran exactly once.
//
// Select the arm with CRUCIBLE_ARM=bun|node and CRUCIBLE_RUNTIME=<executable path>.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "main.mjs");

const ARM = process.env.CRUCIBLE_ARM ?? "node";

// node-pty does NOT do PATH lookup: passing a bare "bun" throws
// `Error: File not found:` on macOS and Windows. Resolve to an absolute path.
function resolveRuntime(nameOrPath) {
  if (!nameOrPath) return process.execPath;
  if (nameOrPath.includes("/") || nameOrPath.includes("\\")) return nameOrPath;
  const finder = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(finder, [nameOrPath], { encoding: "utf8" });
  const first = (found.stdout ?? "").split(/\r?\n/).find((line) => line.trim());
  if (!first) throw new Error(`could not resolve runtime "${nameOrPath}" on PATH`);
  return first.trim();
}

const RUNTIME = resolveRuntime(process.env.CRUCIBLE_RUNTIME);
const ARGS = ARM === "bun" ? [entry] : ["--experimental-ffi", "--no-warnings", entry];

// What "the terminal was restored" means, as bytes on the wire.
const RESTORE = {
  "exits alternate screen": "\x1b[?1049l",
  "shows the cursor": "\x1b[?25h",
  "disables mouse tracking": "\x1b[?1003l",
  "disables sgr mouse mode": "\x1b[?1006l",
  "disables bracketed paste": "\x1b[?2004l",
  "resets the terminal title": "\x1b]0;",
};

function runShell({ env = {}, drive }) {
  // Teardown accounting is read from a file, not from the pty: see src/main.mjs.
  const logFile = join(mkdtempSync(join(tmpdir(), "crucible-teardown-")), "log");
  return new Promise((resolve) => {
    const child = pty.spawn(RUNTIME, ARGS, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: join(here, ".."),
      env: { ...process.env, CRUCIBLE_TEARDOWN_LOG: logFile, ...env },
    });

    let out = "";
    let ready = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve({ out, log: readLog(logFile), exitCode: null, timedOut: true });
      }
    }, 20000);

    child.onData((data) => {
      out += data;
      if (!ready && out.includes("SHELL_READY")) {
        ready = true;
        setTimeout(() => drive?.(child), 120);
      }
    });

    child.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Give the PTY a beat to flush trailing bytes.
      setTimeout(() => resolve({ out, log: readLog(logFile), exitCode, timedOut: false }), 80);
    });
  });
}

function readLog(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "");
}

function assertRestored(out, label) {
  for (const [what, sequence] of Object.entries(RESTORE)) {
    assert.ok(out.includes(sequence), `${label}: terminal never ${what}`);
  }
}

function teardownCount(out) {
  return [...out.matchAll(/SHELL_TEARDOWN reason=(\S+) count=(\d+)/g)];
}

// Reports the ACTUAL count. An earlier version hard-coded "ran more than once",
// which misdescribed the real failure mode (zero markers, not two).
function assertToreDownOnce(log, expectedReason) {
  const marks = teardownCount(log);
  assert.equal(marks.length, 1, `expected exactly 1 teardown marker, saw ${marks.length}`);
  if (expectedReason) assert.equal(marks[0][1], expectedReason);
  assert.equal(marks[0][2], "1", "teardown counter was not 1");
  return marks;
}

describe(`lifecycle on ${ARM} (${RUNTIME})`, () => {
  test("starts, renders, and reports ready", async () => {
    const { out, log } = await runShell({ drive: (c) => c.write("q") });
    assert.ok(out.includes("SHELL_READY"), "shell never reported ready");
    assert.ok(out.includes("crucible"), "shell never rendered its frame");
  });

  test("accepts input", async () => {
    const { out, log } = await runShell({
      drive: (c) => {
        c.write("x");
        setTimeout(() => c.write("z"), 150);
        // OpenTUI redraws only changed cells, so pressed keys otherwise arrive as
        // scattered incremental updates. Resizing forces a full repaint, which
        // puts the complete "keys" line back on the wire deterministically.
        setTimeout(() => c.resize(100, 30), 300);
        setTimeout(() => c.write("q"), 600);
      },
    });
    assert.match(stripAnsi(out), /keys\s+x z/, "keypresses never reached the view");
  });

  test("handles resize", async () => {
    const { out, log } = await runShell({
      drive: (c) => {
        c.resize(100, 30);
        setTimeout(() => c.write("q"), 200);
      },
    });
    const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    assert.ok(/resizes\s+[1-9]/.test(plain), "resize never reached the view");
  });

  test("normal quit restores the terminal exactly once", async () => {
    const { out, log, exitCode } = await runShell({ drive: (c) => c.write("q") });
    assertRestored(out, "normal quit");
    assertToreDownOnce(log, "normal");
    assert.equal(exitCode, 0);
  });

  // Ctrl-C is an ordinary keypress here, NOT SIGINT: OpenTUI's raw mode disables
  // ISIG, so \x03 reaches stdin as data. A shell that only installs a SIGINT
  // handler would hang forever on Ctrl-C -- which is exactly what this prototype
  // observed before the key path was added.
  test("ctrl-c restores the terminal exactly once", async () => {
    const { out, log } = await runShell({ drive: (c) => c.write("\x03") });
    assertRestored(out, "ctrl-c");
    assertToreDownOnce(log, "ctrl-c");
  });

  test("repeated ctrl-c still restores exactly once", async () => {
    const { out, log } = await runShell({
      drive: (c) => {
        c.write("\x03");
        c.write("\x03");
        c.write("\x03");
      },
    });
    assertRestored(out, "repeated ctrl-c");
    assertToreDownOnce(log, "ctrl-c");
  });

  test("startup failure restores the terminal", async () => {
    const { out, log, exitCode } = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "startup" } });
    assertToreDownOnce(log, "startup-failure");
    assert.equal(exitCode, 1);
  });

  test("render failure restores the terminal exactly once", async () => {
    const { out, log } = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "render" } });
    assertRestored(out, "render failure");
    assertToreDownOnce(log, "render-failure");
  });

  test("uncaught exception restores the terminal exactly once", async () => {
    const { out, log } = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "throw" } });
    assertRestored(out, "uncaught exception");
    assertToreDownOnce(log, "uncaught-exception");
  });

  test("unhandled rejection restores the terminal exactly once", async () => {
    const { out, log } = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "reject" } });
    assertRestored(out, "unhandled rejection");
    assertToreDownOnce(log, "unhandled-rejection");
  });

  test("ten start/stop cycles each restore exactly once", async () => {
    for (let i = 0; i < 10; i += 1) {
      const { out, log } = await runShell({ drive: (c) => c.write("q") });
      assertRestored(out, `cycle ${i}`);
      assertToreDownOnce(log, "normal");
    }
  });

  if (process.platform !== "win32") {
    test("SIGTERM restores the terminal exactly once", async () => {
      const { out, log } = await runShell({ drive: (c) => process.kill(c.pid, "SIGTERM") });
      assertRestored(out, "sigterm");
      assertToreDownOnce(log, "sigterm");
    });

    test("SIGHUP restores the terminal exactly once", async () => {
      const { out, log } = await runShell({ drive: (c) => process.kill(c.pid, "SIGHUP") });
      assertRestored(out, "sighup");
      assertToreDownOnce(log, "sighup");
    });
  }
});
