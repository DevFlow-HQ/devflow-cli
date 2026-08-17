// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
// Distribution budget input: artifact size and cold start.

import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const binary = join(here, "..", "dist", isWindows ? "crucible-shell.exe" : "crucible-shell");

const bytes = statSync(binary).size;
console.log(`artifact: ${(bytes / 1024 / 1024).toFixed(1)} MiB (${bytes} bytes)`);

// Cold start with no TTY: the renderer will fail, but process boot is what we time.
const started = Date.now();
spawnSync(binary, [], { timeout: 10000, env: { ...process.env, CRUCIBLE_SHELL_FAIL: "startup" } });
console.log(`cold start to exit (no tty): ${Date.now() - started} ms`);
