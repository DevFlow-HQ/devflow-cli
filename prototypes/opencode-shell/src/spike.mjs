// THROWAWAY spike for DevFlow-HQ/devflow-cli#6.
// Question it answers: does @opentui/core@0.4.5 load, create a renderer, and destroy
// it cleanly under this runtime on this platform? Plain JS on purpose: the TS/JSX
// transform is a separate variable and must not confound the runtime answer.

const result = {
  runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.versions.node}`,
  platform: `${process.platform}-${process.arch}`,
  steps: {},
};

function step(name, fn) {
  try {
    const value = fn();
    result.steps[name] = { ok: true, value: value ?? null };
    return value;
  } catch (error) {
    result.steps[name] = { ok: false, error: `${error?.name}: ${error?.message}` };
    return undefined;
  }
}

async function stepAsync(name, fn) {
  try {
    const value = await fn();
    result.steps[name] = { ok: true, value: value ?? null };
    return value;
  } catch (error) {
    result.steps[name] = { ok: false, error: `${error?.name}: ${error?.message}` };
    return undefined;
  }
}

const core = await stepAsync("import @opentui/core", async () => {
  const mod = await import("@opentui/core");
  return Object.keys(mod).filter((k) => /render|Render/.test(k)).sort().slice(0, 8);
});

if (core) {
  const { createCliRenderer } = await import("@opentui/core");

  const renderer = await stepAsync("createCliRenderer", async () => {
    const r = await createCliRenderer({ exitOnCtrlC: false, targetFps: 1 });
    globalThis.__r = r;
    return {
      hasDestroy: typeof r.destroy === "function",
      isDestroyed: r.isDestroyed,
      width: r.width,
      height: r.height,
    };
  });

  if (renderer) {
    const r = globalThis.__r;
    step("setTerminalTitle", () => {
      r.setTerminalTitle("crucible-spike");
      return "sent";
    });
    await stepAsync("destroy", async () => {
      await r.destroy();
      return { isDestroyed: r.isDestroyed };
    });
    await stepAsync("destroy is idempotent", async () => {
      if (r.isDestroyed) return "already destroyed, skipped second call";
      await r.destroy();
      return "second destroy survived";
    });
  }
}

console.log(JSON.stringify(result, null, 2));
process.exit(0);
