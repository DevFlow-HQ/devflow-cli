// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Runtime-agnostic shell lifecycle. Knows nothing about Bun, Node, OpenTUI or
// OpenCode -- it is handed a RendererPort and is responsible for exactly one
// hard guarantee:
//
//   the terminal is restored exactly once, on every exit path.
//
// The research (docs/research/opencode-tui-extraction-constraints.md) calls a
// broken terminal after exit a release blocker, and lists the paths that must be
// proven. Each is wired below and exercised by test/lifecycle.pty.test.mjs.

export const EXIT_PATHS = [
  "normal",
  "ctrl-c",
  "sigint",
  "sigterm",
  "sighup",
  "startup-failure",
  "render-failure",
  "uncaught-exception",
  "unhandled-rejection",
];

export function createShell({ renderer, process: proc, onExit }) {
  const state = { keys: [], resizes: 0, size: renderer.size(), status: "running" };
  let teardownCount = 0;
  let tornDown = false;
  const installed = [];

  const view = () => ({
    title: "crucible-shell-prototype",
    lines: [
      `status   ${state.status}`,
      `size     ${state.size.width}x${state.size.height}`,
      `resizes  ${state.resizes}`,
      `keys     ${state.keys.join(" ") || "(none)"}`,
      "",
      "press q to quit, r to force a render failure",
    ],
  });

  // Idempotent teardown. Every exit path funnels through here; the counter is the
  // evidence that "exactly once" actually holds rather than being asserted.
  async function teardown(reason) {
    if (tornDown) return teardownCount;
    tornDown = true;
    teardownCount += 1;
    state.status = `exiting:${reason}`;

    for (const remove of installed.splice(0)) {
      try {
        remove();
      } catch {
        /* a failing listener removal must not block terminal restoration */
      }
    }

    try {
      await renderer.destroy();
    } finally {
      onExit?.({ reason, teardownCount });
    }
    return teardownCount;
  }

  function on(emitter, event, handler) {
    emitter.on(event, handler);
    installed.push(() => emitter.off(event, handler));
  }

  function start() {
    renderer.onKey((key) => {
      if (key === "q") {
        void teardown("normal").then(() => proc.exit(0));
        return;
      }
      // Raw mode means Ctrl-C never becomes SIGINT; it is an ordinary keypress.
      // The signal handler below therefore does NOT cover interactive Ctrl-C.
      if (key === "ctrl-c") {
        void teardown("ctrl-c").then(() => proc.exit(0));
        return;
      }
      if (key === "r") {
        // Force a render failure to prove teardown still runs.
        state.keys.push(key);
        try {
          renderer.render(null);
        } catch (error) {
          void teardown("render-failure").then(() => {
            proc.stderr.write(`render failed: ${error.message}\n`);
            proc.exit(1);
          });
        }
        return;
      }
      state.keys.push(key);
      renderer.render(view());
    });

    renderer.onResize((size) => {
      state.size = size;
      state.resizes += 1;
      renderer.render(view());
    });

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      on(proc, signal, () => {
        void teardown(signal.toLowerCase()).then(() => proc.exit(0));
      });
    }

    on(proc, "uncaughtException", (error) => {
      void teardown("uncaught-exception").then(() => {
        proc.stderr.write(`uncaught: ${error.message}\n`);
        proc.exit(1);
      });
    });

    on(proc, "unhandledRejection", (reason) => {
      void teardown("unhandled-rejection").then(() => {
        proc.stderr.write(`unhandled: ${reason}\n`);
        proc.exit(1);
      });
    });

    renderer.render(view());
    return { teardown, state, teardownCountRef: () => teardownCount };
  }

  return { start, teardown, state, teardownCountRef: () => teardownCount };
}
