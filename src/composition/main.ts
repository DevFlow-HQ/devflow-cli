import { constants } from "node:os";
import type { HeadlessClients } from "../headless/headless.js";
import { runSecantInvocation } from "./operational-log.js";
import type { TuiOverrides } from "./tui-runtime.js";
import { wireApplication, type WiringOverrides } from "./wiring.js";

// wireApplication is the one wiring path both roots take; the composition suite
// reaches it through this entry to prove both roots agree (#74 A18).
export { wireApplication, type Wiring } from "./wiring.js";
// The CLI host's fatal catch names the active operational log through this.
export { describeFatal } from "./operational-log.js";
// The standalone runner programs' operational log (#326): runtime conformance
// and terminal lifecycle record their scenario and stage breadcrumbs through it.
export { runRunnerInvocation } from "./runner-log.js";

// The composition entry: both surfaces reach the runtime through here.
// `withClients` wires the Application (see wiring.ts) and hands its Ports to the
// callback the CLI host runs, owning the Catalog's lifetime. `launchTui` is the
// TUI root, kept as a thin seam so the CLI reaches the renderer only through a
// dynamic import: the headless paths never load Solid or OpenTUI's native library.
// Each is one Secant invocation: its operational log starts before anything is
// wired (operational-log.ts). Production passes no overrides; the composition
// suite passes Process and Harness doubles and the log-sink Seam.

/** Wires the composition root for one headless command, runs `fn` with the
 *  Application Interfaces, and closes the Catalog on every exit path. `fn` is
 *  awaited before the close: a Run command settles asynchronously (execution
 *  spawns), so closing the Run Store the instant `fn` returned its Promise would
 *  pull the store out from under the still-running Run.
 *
 *  It also owns the headless OS-signal exit path (#98): a headless process spawns
 *  each Run in its own detached process group, so a bare SIGINT/SIGHUP/SIGTERM
 *  would kill this process and leave the child running. The handler aborts every
 *  live Run and awaits its rest — killing the child's group and leaving the Run
 *  owner record live so the next open reconciles it `halted` (ADR 0019) — then
 *  closes the stores and re-raises the signal for the conventional exit. */
export async function withClients(
  fn: (clients: HeadlessClients) => number | Promise<number>,
  overrides: WiringOverrides = {},
): Promise<number> {
  return runSecantInvocation("headless", overrides, async (log) => {
    const {
      catalog,
      runGroup,
      projectionPort,
      bundleManagement,
      shutdown,
      startupNotices,
    } = wireApplication(overrides, log);
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGHUP", "SIGTERM"];
    let reraise: Promise<void> | undefined;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (reraise !== undefined) return;
      reraise = shutdown().finally(() => {
        runGroup.close();
        catalog.close();
        // The conventional exit status, recorded before the re-raise ends the
        // process: no record after it could be written.
        log.end(128 + constants.signals[signal], signal);
        // Restore the default disposition and re-raise, so the process exits with
        // the conventional 128 + signal code rather than a fabricated one.
        for (const s of signals) process.off(s, onSignal);
        process.kill(process.pid, signal);
      });
    };
    for (const signal of signals) process.on(signal, onSignal);
    try {
      const status = await fn({
        projectionPort,
        bundleManagement,
        startupNotices,
      });
      // A command can settle before the handler's drain does; wait for it, so the
      // end record carries the signal status, not this one.
      if (reraise !== undefined) await reraise;
      return status;
    } finally {
      for (const signal of signals) process.off(signal, onSignal);
      // A signal handler already closed the stores (and is re-raising); closing
      // again here would double-close, so leave it to the handler on that path.
      if (reraise === undefined) {
        runGroup.close();
        catalog.close();
      }
    }
  });
}

/** Launches the interactive shell. The TUI runtime is imported lazily so the
 *  headless paths never reach Solid or OpenTUI's native library. */
export async function launchTui(overrides: TuiOverrides = {}): Promise<number> {
  const { runTuiApp } = await import("./tui-runtime.js");
  return runTuiApp(overrides);
}
