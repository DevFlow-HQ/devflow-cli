// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// Deterministic RendererPort with no terminal, no native library and no runtime
// requirement. Its existence is the evidence for the ticket's "testable renderer
// seam" clause: the shell's whole lifecycle can be driven and asserted under a
// plain `node --test`, on any platform, with no OpenTUI and no OpenCode server.

export function createFakeRenderer({ size = { width: 80, height: 24 } } = {}) {
  let destroyed = false;
  const frames = [];
  const destroyCalls = [];
  let keyCb = () => {};
  let resizeCb = () => {};
  let current = { ...size };

  return {
    frames,
    destroyCalls,
    get destroyed() {
      return destroyed;
    },
    size() {
      return { ...current };
    },
    render(view) {
      if (!view || !Array.isArray(view.lines)) {
        throw new TypeError("view must have lines[]");
      }
      frames.push(view);
    },
    onKey(cb) {
      keyCb = cb;
    },
    onResize(cb) {
      resizeCb = cb;
    },
    async destroy() {
      destroyCalls.push(Date.now());
      destroyed = true;
    },

    // test drivers
    pressKey: (key) => keyCb(key),
    resizeTo: (width, height) => {
      current = { width, height };
      resizeCb({ width, height });
    },
  };
}
