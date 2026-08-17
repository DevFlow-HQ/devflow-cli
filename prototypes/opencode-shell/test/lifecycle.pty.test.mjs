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
import * as pty from "node-pty";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "main.mjs");

const ARM = process.env.CRUCIBLE_ARM ?? "node";
const RUNTIME = process.env.CRUCIBLE_RUNTIME ?? process.execPath;
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
  return new Promise((resolve) => {
    const child = pty.spawn(RUNTIME, ARGS, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: join(here, ".."),
      env: { ...process.env, ...env },
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
        resolve({ out, exitCode: null, timedOut: true });
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
      setTimeout(() => resolve({ out, exitCode, timedOut: false }), 80);
    });
  });
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

describe(`lifecycle on ${ARM} (${RUNTIME})`, () => {
  test("starts, renders, and reports ready", async () => {
    const { out } = await runShell({ drive: (c) => c.write("q") });
    assert.ok(out.includes("SHELL_READY"), "shell never reported ready");
    assert.ok(out.includes("crucible"), "shell never rendered its frame");
  });

  test("accepts input", async () => {
    const { out } = await runShell({
      drive: (c) => {
        c.write("x");
        setTimeout(() => c.write("z"), 150);
        setTimeout(() => c.write("q"), 300);
      },
    });
    // OpenTUI redraws only changed cells, so the pressed characters arrive as an
    // incremental update AFTER the initial full frame rather than inside it.
    const plain = stripAnsi(out);
    const afterFirstFrame = plain.slice(plain.lastIndexOf("┘") + 1);
    assert.ok(afterFirstFrame.includes("x"), "first keypress never reached the view");
    assert.ok(afterFirstFrame.includes("z"), "second keypress never reached the view");
  });

  test("handles resize", async () => {
    const { out } = await runShell({
      drive: (c) => {
        c.resize(100, 30);
        setTimeout(() => c.write("q"), 200);
      },
    });
    const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    assert.ok(/resizes\s+[1-9]/.test(plain), "resize never reached the view");
  });

  test("normal quit restores the terminal exactly once", async () => {
    const { out, exitCode } = await runShell({ drive: (c) => c.write("q") });
    assertRestored(out, "normal quit");
    const marks = teardownCount(out);
    assert.equal(marks.length, 1, "teardown did not run exactly once");
    assert.equal(marks[0][2], "1");
    assert.equal(exitCode, 0);
  });

  // Ctrl-C is an ordinary keypress here, NOT SIGINT: OpenTUI's raw mode disables
  // ISIG, so \x03 reaches stdin as data. A shell that only installs a SIGINT
  // handler would hang forever on Ctrl-C -- which is exactly what this prototype
  // observed before the key path was added.
  test("ctrl-c restores the terminal exactly once", async () => {
    const { out } = await runShell({ drive: (c) => c.write("\x03") });
    assertRestored(out, "ctrl-c");
    const marks = teardownCount(out);
    assert.equal(marks.length, 1, "teardown did not run exactly once");
    assert.equal(marks[0][1], "ctrl-c");
  });

  test("repeated ctrl-c still restores exactly once", async () => {
    const { out } = await runShell({
      drive: (c) => {
        c.write("\x03");
        c.write("\x03");
        c.write("\x03");
      },
    });
    assertRestored(out, "repeated ctrl-c");
    assert.equal(teardownCount(out).length, 1, "teardown ran more than once");
  });

  test("startup failure restores the terminal", async () => {
    const { out, exitCode } = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "startup" } });
    const marks = teardownCount(out);
    assert.equal(marks.length, 1, "startup failure did not report teardown");
    assert.equal(marks[0][1], "startup-failure");
    assert.equal(exitCode, 1);
  });

  test("render failure restores the terminal exactly once", async () => {
    const { out } = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "render" } });
    assertRestored(out, "render failure");
    const marks = teardownCount(out);
    assert.equal(marks.length, 1);
    assert.equal(marks[0][1], "render-failure");
  });

  test("uncaught exception restores the terminal exactly once", async () => {
    const { out } = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "throw" } });
    assertRestored(out, "uncaught exception");
    const marks = teardownCount(out);
    assert.equal(marks.length, 1);
    assert.equal(marks[0][1], "uncaught-exception");
  });

  test("unhandled rejection restores the terminal exactly once", async () => {
    const { out } = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "reject" } });
    assertRestored(out, "unhandled rejection");
    const marks = teardownCount(out);
    assert.equal(marks.length, 1);
    assert.equal(marks[0][1], "unhandled-rejection");
  });

  test("ten start/stop cycles each restore exactly once", async () => {
    for (let i = 0; i < 10; i += 1) {
      const { out } = await runShell({ drive: (c) => c.write("q") });
      assertRestored(out, `cycle ${i}`);
      assert.equal(teardownCount(out).length, 1, `cycle ${i} teardown count`);
    }
  });

  if (process.platform !== "win32") {
    test("SIGTERM restores the terminal exactly once", async () => {
      const { out } = await runShell({ drive: (c) => process.kill(c.pid, "SIGTERM") });
      assertRestored(out, "sigterm");
      const marks = teardownCount(out);
      assert.equal(marks.length, 1);
      assert.equal(marks[0][1], "sigterm");
    });

    test("SIGHUP restores the terminal exactly once", async () => {
      const { out } = await runShell({ drive: (c) => process.kill(c.pid, "SIGHUP") });
      assertRestored(out, "sighup");
      const marks = teardownCount(out);
      assert.equal(marks.length, 1);
      assert.equal(marks[0][1], "sighup");
    });
  }
});
