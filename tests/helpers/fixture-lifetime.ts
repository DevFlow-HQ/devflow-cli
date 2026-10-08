import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createProcessAdapter } from "../../src/process/process.js";
import { observeLifetime } from "../process/windows-contained-native.js";
import { withRunnerObserver } from "./standalone.js";

/** Independent OS death evidence, acquired while the fixture is still live. */
export function fixtureLifetime(pid: number) {
  const windows =
    process.platform === "win32" ? observeLifetime(pid) : undefined;
  const adapter = createProcessAdapter(withRunnerObserver());
  const alive = () => {
    if (windows !== undefined) return windows.alive();
    const result = adapter.spawnCommandSync({
      role: "command",
      executable: "/bin/ps",
      args: ["-p", String(pid), "-o", "stat="],
      cwd: process.cwd(),
      env: process.env,
      maxBufferBytes: 1024,
    });
    assert.ok(result.kind === "exited");
    assert.ok(result.status === 0 || result.status === 1);
    return (
      result.status === 0 &&
      !new TextDecoder().decode(result.stdout).trim().startsWith("Z")
    );
  };
  return {
    alive,
    async ended() {
      const deadline = performance.now() + 5000;
      while (alive()) {
        assert.ok(
          performance.now() < deadline,
          `fixture PID ${pid} survived cleanup`,
        );
        await setImmediate();
      }
    },
    close: () => windows?.close(),
  };
}
