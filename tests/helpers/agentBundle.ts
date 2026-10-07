import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "./tempDir.js";

/** Author a prompt-bearing Bundle without choosing the test's Routing or bytes. */
export function writeAgentBundle(options: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: { readonly path: string; readonly text: string };
  readonly routing: readonly unknown[];
}): { folder: string; id: string } {
  const folder = makeTempDir("secant-agent-bundle-");
  const promptPath = join(folder, options.prompt.path);
  mkdirSync(dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, options.prompt.text);
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id: options.id,
        version: "1.0.0",
        name: options.name,
        description: options.description,
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [{ path: options.prompt.path, kind: "prompt" }],
      routing: options.routing,
    }),
  );
  return { folder, id: options.id };
}
