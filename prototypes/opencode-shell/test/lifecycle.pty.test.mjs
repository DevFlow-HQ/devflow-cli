// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Real-PTY lifecycle evidence. Launches the shell inside an actual pseudo-terminal
// (ConPTY on Windows) and asserts that after every exit path the terminal-restoring
// escape sequences were actually emitted, and that teardown ran exactly once.
//
// Select the arm with CRUCIBLE_ARM=bun|node and CRUCIBLE_RUNTIME=<executable path>.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";
import { ensureSpawnHelperExecutable } from "../scripts/heal-node-pty.mjs";

// macOS: node-pty 1.1.0 ships spawn-helper without +x. See ADR-0016.
ensureSpawnHelperExecutable();

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
//
// Stated as PAIRS rather than as a fixed list of expected bytes, because the
// correct invariant is "whatever the shell turned on, it turned back off" -- not
// "these exact sequences appear". Hardcoding the sequences asserted Windows must
// emit xterm mouse-tracking codes that ConPTY never enables in the first place,
// which failed honestly-restored Windows runs.
//
// `wireVisible` marks pairs whose restoration is actually observable in the pty
// byte stream on THIS platform. On Windows it is not a transcript at all: ConPTY
// interprets escape sequences into console state and re-emits its own rendering.
// It forwards ?1049l, ?25h and ?2004l, but demonstrably swallows the mouse-mode
// disables -- verified by emitting all eight resets explicitly and watching only
// the non-mouse ones arrive. Asserting the mouse disables on Windows therefore
// tests ConPTY's passthrough, not Crucible's teardown.
//
// Windows mouse/console restoration is instead proven directly, by comparing the
// console mode read at startup with the one read after restore (503 == 503) --
// see assertConsoleModeRestored. Same principle as readiness and teardown
// accounting: on Windows, measure over a real API or a side channel, never over
// the terminal.
const IS_WINDOWS = process.platform === "win32";
const RESTORE_PAIRS = [
  ["alternate screen", "\x1b[?1049h", "\x1b[?1049l", true],
  ["cursor visibility", "\x1b[?25l", "\x1b[?25h", true],
  ["bracketed paste", "\x1b[?2004h", "\x1b[?2004l", true],
  ["mouse tracking", "\x1b[?1000h", "\x1b[?1000l", !IS_WINDOWS],
  ["button-event mouse tracking", "\x1b[?1002h", "\x1b[?1002l", !IS_WINDOWS],
  ["any-event mouse tracking", "\x1b[?1003h", "\x1b[?1003l", !IS_WINDOWS],
  ["sgr mouse mode", "\x1b[?1006h", "\x1b[?1006l", !IS_WINDOWS],
].map(([what, enable, disable, wireVisible]) => ({ what, enable, disable, wireVisible }));

// ROOT CAUSE of the Windows hang: node-pty's ConPTY backend keeps its agent and
// named-pipe handles alive until the terminal is explicitly disposed. Letting the
// child exit is enough on POSIX but NOT on Windows, so `node --test` sat with a
// live event loop for ~163s after the last assertion and was cancelled. Every pty
// is tracked and killed deterministically instead of force-exiting the runner.
const liveTerminals = new Set();

function disposeTerminal(child) {
  liveTerminals.delete(child);
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

after(() => {
  for (const child of [...liveTerminals]) disposeTerminal(child);
});

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
    liveTerminals.add(child);

    let out = "";
    let ready = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(readyPoll);
        disposeTerminal(child);
        resolve({ out, log: readLog(logFile), exitCode: null, timedOut: true });
      }
    }, 20000);

    child.onData((data) => {
      out += data;
    });

    // Observable readiness from the side-channel file, NOT scraped from the pty:
    // see the ConPTY note in src/main.mjs. Polling the log makes this identical
    // on all three platforms instead of relying on byte passthrough.
    const readyPoll = setInterval(() => {
      if (ready || settled) return;
      if (!readLog(logFile).includes("SHELL_READY")) return;
      ready = true;
      clearInterval(readyPoll);
      drive?.(child);
    }, 25);
    readyPoll.unref?.();

    child.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(readyPoll);
      // Give the PTY a beat to flush trailing bytes.
      setTimeout(() => {
        disposeTerminal(child);
        resolve({ out, log: readLog(logFile), exitCode, timedOut: false });
      }, 80);
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

// Diagnostics travel with the failure. Windows can only be debugged through CI
// from here, so a bare "never restored it" costs a whole round trip; the raw tail
// and the mode census make the next round trip productive.
function diagnostics(result) {
  const { out, log, exitCode, timedOut } = result;
  const census = RESTORE_PAIRS.map(({ what, enable, disable, wireVisible }) => {
    const on = out.includes(enable);
    const off = out.includes(disable);
    return `${what}=${on ? "on" : "-"}/${off ? "off" : "-"}${wireVisible ? "" : "(not wire-visible)"}`;
  }).join(" ");
  return [
    `\n  exitCode=${exitCode} timedOut=${!!timedOut}`,
    `  modes(entered/restored): ${census}`,
    `  teardownLog: ${JSON.stringify(log)}`,
    `  tail: ${JSON.stringify(out.slice(-400))}`,
  ].join("\n");
}

function assertRestored(result, label) {
  const out = typeof result === "string" ? result : result.out;
  const detail = typeof result === "string" ? "" : diagnostics(result);
  let modesEntered = 0;
  for (const { what, enable, disable, wireVisible } of RESTORE_PAIRS) {
    if (!out.includes(enable)) continue; // never turned on here; nothing owed
    modesEntered += 1;
    if (!wireVisible) continue; // restoration proven via console mode instead
    assert.ok(out.includes(disable), `${label}: entered ${what} but never restored it${detail}`);
  }
  // Guards against a vacuous pass: if the TUI never entered ANY mode, it never
  // really started, and "restored everything it entered" would be trivially true.
  assert.ok(modesEntered > 0, `${label}: shell never entered any terminal mode${detail}`);
}

function teardownCount(out) {
  return [...out.matchAll(/SHELL_TEARDOWN reason=(\S+) count=(\d+)/g)];
}

// On Windows the meaningful restoration claim is about console MODE, which no
// escape-sequence assertion can observe. The shell reports the mode it read at
// startup and after restoring; they must match.
function assertConsoleModeRestored(log, label) {
  const match = log.match(/initialConsoleMode=(\S+) finalConsoleMode=(\S+)/);
  if (!match) return; // not Windows, or no console: nothing claimed
  assert.equal(match[2], match[1], `${label}: Windows console mode was not restored\n  log: ${JSON.stringify(log)}`);
}

// Reports the ACTUAL count. An earlier version hard-coded "ran more than once",
// which misdescribed the real failure mode (zero markers, not two).
function assertToreDownOnce(log, expectedReason) {
  const marks = teardownCount(log);
  assert.equal(marks.length, 1, `expected exactly 1 teardown marker, saw ${marks.length}`);
  if (expectedReason) assert.equal(marks[0][1], expectedReason);
  assert.equal(marks[0][2], "1", "teardown counter was not 1");
  assertConsoleModeRestored(log, expectedReason ?? "teardown");
  return marks;
}

describe(`lifecycle on ${ARM} (${RUNTIME})`, () => {
  test("starts, renders, and reports ready", async () => {
    const result = await runShell({ drive: (c) => c.write("q") });
    const { out, log, exitCode } = result;
    assert.ok(log.includes("SHELL_READY"), `shell never reported ready${diagnostics(result)}`);
    assert.ok(out.includes("crucible"), "shell never rendered its frame");
  });

  test("accepts input", async () => {
    const result = await runShell({
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
    const { out, log, exitCode } = result;
    assert.match(stripAnsi(out), /keys\s+x z/, "keypresses never reached the view");
  });

  test("handles resize", async () => {
    const result = await runShell({
      drive: (c) => {
        c.resize(100, 30);
        setTimeout(() => c.write("q"), 200);
      },
    });
    const { out, log, exitCode } = result;
    const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    assert.ok(/resizes\s+[1-9]/.test(plain), "resize never reached the view");
  });

  test("normal quit restores the terminal exactly once", async () => {
    const result = await runShell({ drive: (c) => c.write("q") });
    const { out, log, exitCode } = result;
    assertRestored(result, "normal quit");
    assertToreDownOnce(log, "normal");
    assert.equal(exitCode, 0);
  });

  // Ctrl-C is an ordinary keypress here, NOT SIGINT: OpenTUI's raw mode disables
  // ISIG, so \x03 reaches stdin as data. A shell that only installs a SIGINT
  // handler would hang forever on Ctrl-C -- which is exactly what this prototype
  // observed before the key path was added.
  test("ctrl-c restores the terminal exactly once", async () => {
    const result = await runShell({ drive: (c) => c.write("\x03") });
    const { out, log, exitCode } = result;
    assertRestored(result, "ctrl-c");
    assertToreDownOnce(log, "ctrl-c");
  });

  test("repeated ctrl-c still restores exactly once", async () => {
    const result = await runShell({
      drive: (c) => {
        c.write("\x03");
        c.write("\x03");
        c.write("\x03");
      },
    });
    const { out, log, exitCode } = result;
    assertRestored(result, "repeated ctrl-c");
    assertToreDownOnce(log, "ctrl-c");
  });

  test("startup failure restores the terminal", async () => {
    const result = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "startup" } });
    const { out, log, exitCode } = result;
    assertToreDownOnce(log, "startup-failure");
    assert.equal(exitCode, 1);
  });

  test("render failure restores the terminal exactly once", async () => {
    const result = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "render" } });
    const { out, log, exitCode } = result;
    assertRestored(result, "render failure");
    assertToreDownOnce(log, "render-failure");
  });

  test("uncaught exception restores the terminal exactly once", async () => {
    const result = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "throw" } });
    const { out, log, exitCode } = result;
    assertRestored(result, "uncaught exception");
    assertToreDownOnce(log, "uncaught-exception");
  });

  test("unhandled rejection restores the terminal exactly once", async () => {
    const result = await runShell({ env: { CRUCIBLE_SHELL_FAIL: "reject" } });
    const { out, log, exitCode } = result;
    assertRestored(result, "unhandled rejection");
    assertToreDownOnce(log, "unhandled-rejection");
  });

  test("ten start/stop cycles each restore exactly once", async () => {
    for (let i = 0; i < 10; i += 1) {
      const result = await runShell({ drive: (c) => c.write("q") });
      const { out, log, exitCode } = result;
      assertRestored(result, `cycle ${i}`);
      assertToreDownOnce(log, "normal");
    }
  });

  if (process.platform !== "win32") {
    test("SIGTERM restores the terminal exactly once", async () => {
      const result = await runShell({ drive: (c) => process.kill(c.pid, "SIGTERM") });
      const { out, log, exitCode } = result;
      assertRestored(result, "sigterm");
      assertToreDownOnce(log, "sigterm");
    });

    test("SIGHUP restores the terminal exactly once", async () => {
      const result = await runShell({ drive: (c) => process.kill(c.pid, "SIGHUP") });
      const { out, log, exitCode } = result;
      assertRestored(result, "sighup");
      assertToreDownOnce(log, "sighup");
    });
  }
});
