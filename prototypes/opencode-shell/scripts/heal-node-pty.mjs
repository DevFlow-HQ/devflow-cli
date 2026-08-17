// THROWAWAY prototype for DevFlow-HQ/devflow-cli#6.
//
// ROOT CAUSE (macOS only), already documented in
// docs/adr/0016-self-heal-node-pty-macos-spawn-helper-executable-bit.md:
//
// node-pty@1.1.0's registry tarball ships prebuilds/darwin-{arm64,x64}/spawn-helper
// with mode 0644 -- no executable bit. On macOS node-pty does NOT forkpty+execvp in
// process the way it does on Linux; it posix_spawns that helper, which then sets up
// the controlling tty. Without +x, posix_spawn fails EACCES and node-pty throws
// `posix_spawnp failed.` -- which is exactly what killed all 13 macOS tests in ~1ms.
//
// Production already self-heals this at its single node-pty boundary. This prototype
// has its own node_modules, so it needs the same heal.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { statSync, chmodSync } from "node:fs";

const require = createRequire(import.meta.url);

export function ensureSpawnHelperExecutable() {
  if (process.platform !== "darwin") return { healed: false, reason: "not darwin" };

  let helper;
  try {
    helper = join(
      dirname(require.resolve("node-pty")),
      "..",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
  } catch {
    return { healed: false, reason: "node-pty not resolvable" };
  }

  let mode;
  try {
    mode = statSync(helper).mode;
  } catch {
    // Missing file: stay silent and let node-pty surface its own error.
    return { healed: false, reason: "helper not found" };
  }

  const EXEC_BITS = 0o111;
  if ((mode & EXEC_BITS) === EXEC_BITS) return { healed: false, reason: "already executable" };

  try {
    chmodSync(helper, mode | EXEC_BITS);
  } catch (error) {
    throw new Error(
      `could not make node-pty's spawn-helper executable. Run: sudo chmod +x ${helper}\n${error.message}`,
    );
  }
  return { healed: true, helper };
}

// Runnable directly so CI can heal (and report) as an explicit step.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(ensureSpawnHelperExecutable()));
}
