import { appendFileSync } from "node:fs";
import {
  conhostConsoleProbe,
  createProcessStdinRelease,
  createProductionRenderer,
  createStdinKeypress,
  createTeardown,
  runBehindConhostNotice,
} from "../tui/renderer/renderer.js";
import { mountTui } from "../tui/tui.js";
import { runSecantInvocation, type OperationalLog } from "./operational-log.js";
import { wireApplication, type WiringOverrides } from "./wiring.js";

// The TUI composition root: it wires the Application through the one shared path
// (see wiring.ts), creates the production renderer, mounts the shell, owns the
// Catalog's lifetime, and owns the single
// teardown site through every exit path — quit binding, Ctrl+C, SIGHUP,
// SIGTERM, render failure, and unhandled error. `process.exit` is never called
// on the normal path; the returned code becomes `process.exitCode`. Runs
// in-process under the compiled binary, which carries OpenTUI's native library;
// the no-terminal case rejects before the renderer is created, which is what the
// no-TTY smoke proves.
//
// The whole launch is one guarded Secant invocation: its operational log starts
// before the no-TTY rejection, and a wiring, renderer-creation, or render failure
// is recorded there and rethrown after teardown, so the CLI host names the log
// file like any other fatal error.

// The precise startup Problem when there is no interactive terminal. Kept stable
// so CI's no-TTY package smoke can assert the literal against the binary's output
// (ADR 0027); module-private, since nothing imports it.
const NO_TTY_PROBLEM = {
  code: "no-interactive-terminal",
  explanation:
    "Secant's interactive shell needs an interactive terminal, but stdin or stdout is not a TTY.",
  remediation:
    "Run `secant` in a terminal, or use a headless command such as `secant workspace`.",
} as const;

// A test-only diagnostic side channel for the real-terminal lifecycle suite
// (#56). When SECANT_TERMINAL_LOG names a file, the shell appends `ready` once
// mounted and `teardown` when the single teardown runs, so the suite reads
// readiness and the exactly-once teardown from a file instead of scraping the
// PTY stream — unreadable under ConPTY on Windows, where the shell's own output
// is absorbed into the alternate-screen buffer. Unset in production: a no-op.
// node:fs only, never a Bun API, so it stays outside the runtime-neutrality
// allowlist.
function recordTerminalEvent(line: string): void {
  const path = process.env.SECANT_TERMINAL_LOG;
  if (path) appendFileSync(path, `${line}\n`);
}

/** What the launch reads from the process's terminal. */
interface TuiTerminal {
  /** Whether stdin and stdout are both TTYs. */
  readonly interactive: boolean;
  /** Whether the console is a visible legacy conhost window. */
  readonly legacyConsole: () => boolean;
}

/** The TUI launch's overrides: the wiring overrides plus a terminal test Seam, so
 *  the composition suite reaches past the no-TTY rejection without a terminal. */
export interface TuiOverrides extends WiringOverrides {
  readonly terminal?: TuiTerminal;
}

export async function runTuiApp(overrides: TuiOverrides = {}): Promise<number> {
  return runSecantInvocation("tui", overrides, (log) =>
    guardedLaunch(overrides, log),
  );
}

async function guardedLaunch(
  overrides: TuiOverrides,
  log: OperationalLog,
): Promise<number> {
  const terminal = overrides.terminal ?? {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    legacyConsole: conhostConsoleProbe,
  };
  if (!terminal.interactive) {
    process.stderr.write(
      `Error [${NO_TTY_PROBLEM.code}]: ${NO_TTY_PROBLEM.explanation}\n`,
    );
    process.stderr.write(`Remediation: ${NO_TTY_PROBLEM.remediation}\n`);
    return 1;
  }

  // The one named seam for the legacy-conhost notice: after the no-TTY
  // rejection, before anything is wired or the renderer is created. Suppressed
  // everywhere but a visible conhost window (see conhost-notice.ts), where it
  // waits for one key; Ctrl+C there exits before any TUI takeover. To stdout,
  // not stderr: the gate above guarantees stdout is the (visible) console TTY,
  // whereas stderr may be redirected — so this is where the warning is certain
  // to be seen.
  return runBehindConhostNotice(
    {
      probe: terminal.legacyConsole,
      isWindowsTerminalSession: process.env.WT_SESSION !== undefined,
      write: (text) => process.stdout.write(text),
      waitForKeypress: createStdinKeypress(process.stdin),
    },
    () => launchTui(overrides, log),
  );
}

async function launchTui(
  overrides: WiringOverrides,
  log: OperationalLog,
): Promise<number> {
  const {
    catalog,
    runGroup,
    projectionPort,
    shutdown: drainLiveRuns,
    // The TUI relays human turn-taking, so an interactive-agent Bundle is admitted
    // here (headless refuses it at Preflight, #116, #122).
  } = wireApplication({ ...overrides, supportsInteractiveTurns: true }, log);
  try {
    const { port, renderer } = await createProductionRenderer();
    // The diagnostic records the single teardown from createTeardown's own
    // once-guard, so it sees one `teardown` no matter how many exit paths fire.
    const teardown = createTeardown(createProcessStdinRelease(), port, () =>
      recordTerminalEvent("teardown"),
    );

    let failure: unknown;
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    // Resolving a settled Promise is a no-op, so no extra guard is needed; the
    // teardown itself is the once-only gate.
    // Abort every Run live in this process and await its rest before teardown (#98),
    // so a killed or quit shell never leaves a child running; each Run's Workspace
    // claim stays live for the next open to reconcile `halted` (ADR 0019). Draining
    // is idempotent, so every exit path can call `finish` freely.
    const finish = (reason?: unknown) => {
      if (reason instanceof Error && failure === undefined) {
        failure = reason;
        // Recorded and flushed now, before the drain: a drain that never settles
        // still leaves the failure in the log.
        log.fatal(reason);
      }
      void drainLiveRuns().finally(() => {
        teardown();
        resolveShutdown();
      });
    };

    // The composition root owns every OS-signal exit path (the renderer's own
    // handlers are disabled). Each drains live Runs, then runs the teardown.
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGHUP", "SIGTERM"];
    const onSignal = () => finish();
    for (const signal of signals) process.on(signal, onSignal);

    try {
      await mountTui(renderer, {
        projectionPort,
        rendererPort: port,
        // Read once here, never by the presentation: `1` draws the working scanner
        // as the static `[⋯]` (#292), until a stored setting exists (ADR 0037).
        reducedMotion: process.env.SECANT_REDUCED_MOTION === "1",
        exit: (reason) => finish(reason),
      });
      // Mounted: the renderer holds the terminal in raw mode and Home's quit
      // bindings are live, so the suite may now drive an exit path.
      recordTerminalEvent("ready");
      await shutdown;
    } catch (error) {
      // A render crash while a Run is live: drain the live Runs (finish resolves
      // `shutdown` only after the drain), and await it so the outer finally never
      // closes the Run Store out from under a still-aborting Run (#98).
      finish(error instanceof Error ? error : new Error(String(error)));
      await shutdown;
    } finally {
      for (const signal of signals) process.off(signal, onSignal);
      teardown();
    }

    // Rethrow any failure once the terminal is restored: the guard records it and
    // the CLI host names the log file on stderr.
    if (failure !== undefined) throw failure;
    return 0;
  } finally {
    runGroup.close();
    catalog.close();
  }
}
