// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// The Crucible-owned renderer seam. This is the whole point of the prototype:
// the shell below talks ONLY to this shape, never to OpenTUI, never to OpenCode.
// Two implementations exist -- opentui-renderer.mjs (real) and fake-renderer.mjs
// (deterministic, no terminal) -- which is what makes the shell testable.
//
// Deliberately NOT here: sessions, messages, parts, providers, agents,
// permissions, questions, projects, workspaces. No OpenCode domain state.
//
// @typedef {{ width: number, height: number }} Size
// @typedef {{ title: string, lines: string[] }} ShellView
//
// interface RendererPort {
//   get destroyed(): boolean
//   size(): Size
//   render(view: ShellView): void
//   onKey(cb: (key: string) => void): void
//   onResize(cb: (size: Size) => void): void
//   destroy(): Promise<void>   // MUST be idempotent
// }

export const RENDERER_PORT_METHODS = ["size", "render", "onKey", "onResize", "destroy"];

/** Cheap structural check so a host adapter can't silently drift from the seam. */
export function assertRendererPort(candidate) {
  for (const method of RENDERER_PORT_METHODS) {
    if (typeof candidate?.[method] !== "function") {
      throw new Error(`RendererPort is missing ${method}()`);
    }
  }
  if (typeof candidate.destroyed !== "boolean") {
    throw new Error("RendererPort is missing a boolean `destroyed`");
  }
  return candidate;
}
