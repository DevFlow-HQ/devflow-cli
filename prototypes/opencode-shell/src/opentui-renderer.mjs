// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// The real RendererPort implementation, over OpenTUI 0.4.5.
//
// Finding worth carrying forward: this file is byte-identical for both runtime
// arms. @opentui/core ships "bun" and "node" export conditions, so the adapter
// never branches on runtime -- only the launch command and the Windows console
// handling differ. That is a much thinner runtime seam than expected.

import { createCliRenderer, BoxRenderable, TextRenderable } from "@opentui/core";

export async function createOpenTuiRenderer({ failOnStart = false } = {}) {
  if (failOnStart) {
    // Simulates the "startup failure" path without needing a broken terminal.
    throw new Error("forced startup failure");
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 10 });

  const box = new BoxRenderable(renderer, {
    id: "shell-root",
    width: "100%",
    height: "100%",
    border: true,
    title: "crucible",
  });
  const text = new TextRenderable(renderer, { id: "shell-text", content: "" });
  box.add(text);
  renderer.root.add(box);

  let destroyed = false;
  let keyHandler;

  return {
    get destroyed() {
      return destroyed;
    },
    size() {
      return { width: renderer.width, height: renderer.height };
    },
    render(view) {
      // Intentionally unguarded: a bad view must throw so the shell's
      // render-failure path is exercised for real rather than simulated.
      text.content = [view.title, "", ...view.lines].join("\n");
      renderer.requestRender();
    },
    onKey(cb) {
      keyHandler = (key) => {
        if (typeof key === "string") return cb(key);
        // Ctrl-C arrives here as input, NOT as SIGINT: OpenTUI puts the terminal
        // in raw mode, which disables ISIG. Normalising it to "ctrl-c" keeps that
        // platform truth inside the adapter instead of leaking into the shell.
        if (key?.ctrl && key?.name === "c") return cb("ctrl-c");
        cb(key?.name ?? key?.sequence ?? "");
      };
      renderer.keyInput.on("keypress", keyHandler);
    },
    onResize(cb) {
      renderer.on("resize", (width, height) => {
        cb(
          typeof width === "object"
            ? { width: width.width, height: width.height }
            : { width, height },
        );
      });
    },
    async destroy() {
      // ROOT CAUSE FIX. OpenTUI 0.4.5's destroy() can leave its promise unsettled
      // if a keypress is delivered while it is tearing down. Observed directly:
      // teardown reached "before destroy" and never resumed, the event loop then
      // drained, and the process exited 0 with every post-destroy step skipped.
      // The terminal still LOOKED fine because destroy emits the restore sequences
      // early -- so the damage is silent, and it hit ~50% of rapid-Ctrl-C runs.
      //
      // Two defences, in order:
      //   1. Detach input BEFORE destroying, so the race cannot be started.
      //   2. Bound the wait, so teardown completes even if destroy still stalls.
      try {
        if (keyHandler) renderer.keyInput.off("keypress", keyHandler);
        keyHandler = undefined;
      } catch {
        /* detaching input must never block destruction */
      }

      try {
        renderer.setTerminalTitle("");
      } catch {
        /* title reset must never block destruction */
      }

      if (destroyed || renderer.isDestroyed) {
        destroyed = true;
        return;
      }
      destroyed = true;

      await Promise.race([
        (async () => renderer.destroy())(),
        new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
      ]);
    },
  };
}
