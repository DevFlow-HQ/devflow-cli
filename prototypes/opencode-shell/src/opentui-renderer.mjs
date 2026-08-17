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
      renderer.keyInput.on("keypress", (key) => {
        if (typeof key === "string") return cb(key);
        // Ctrl-C arrives here as input, NOT as SIGINT: OpenTUI puts the terminal
        // in raw mode, which disables ISIG. Normalising it to "ctrl-c" keeps that
        // platform truth inside the adapter instead of leaking into the shell.
        if (key?.ctrl && key?.name === "c") return cb("ctrl-c");
        cb(key?.name ?? key?.sequence ?? "");
      });
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
      // Mirrors opencode's util/renderer.ts: title cleared before the
      // idempotency check, so a second call is a genuine no-op.
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
      // NOTE: CliRenderer.destroy() is synchronous in 0.4.5 and returns undefined,
      // despite reading like an async teardown. Awaiting is harmless but a caller
      // must not assume a promise contract here.
      await renderer.destroy();
    },
  };
}
