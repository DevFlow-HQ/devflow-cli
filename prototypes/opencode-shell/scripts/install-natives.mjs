// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// FINDING this script encodes: `bun build --compile` must be able to RESOLVE every
// @opentui/core native package its platform-dispatch branch references -- not just
// the one matching the host. A plain `npm install` gives you only the host's
// optional dependency, so the compile fails with:
//
//   error: Could not resolve: "@opentui/core-linux-x64-musl"
//
// OpenCode hits the same constraint and solves it the same way: install the target
// native packages before cross-compiling (packages/opencode/script/build.ts).
//
// These must NOT be normal dependencies: npm hard-fails with EBADPLATFORM on the
// seven that do not match the host. --no-save --force installs them anyway without
// touching package.json.

import { spawnSync } from "node:child_process";

const VERSION = "0.4.5";
const TARGETS = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
];

const packages = TARGETS.map((t) => `@opentui/core-${t}@${VERSION}`);
console.log(`installing ${packages.length} OpenTUI native packages for cross-compilation`);

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["install", "--no-save", "--force", "--no-audit", "--no-fund", ...packages],
  { stdio: "inherit", shell: process.platform === "win32" },
);

process.exit(result.status ?? 1);
