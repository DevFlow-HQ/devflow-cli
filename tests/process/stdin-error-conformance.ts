import assert from "node:assert/strict";
import { createProcessAdapter } from "../../src/process/process.js";
import { withRunnerObserver } from "../helpers/standalone.js";
import type { RunnerCase } from "../helpers/scenario-runner.js";

/** Closing fd 0 makes the peer refusal deterministic on the POSIX pipe path.
 * Windows' contained named pipes remain covered by their native conformance. */
export function registerStdinErrorCases(
  register: (test: RunnerCase) => void,
): void {
  if (process.platform === "win32") return;
  for (const bytes of [1_024, 1_024 * 1_024]) {
    register({
      name: `process-stdin-error-${bytes === 1_024 ? "shutdown" : "write"}`,
      body: async () => {
        const launched = await createProcessAdapter(
          withRunnerObserver(),
        ).spawnOwnedProcess({
          role: "harness-probe",
          executable: process.execPath,
          args: [
            "-e",
            "import { closeSync } from 'node:fs'; closeSync(0); console.log('stdin-closed'); setInterval(() => {}, 1000);",
          ],
          cwd: process.cwd(),
          env: process.env,
          launchTimeoutMs: 5_000,
        });
        assert.ok(launched.ok);
        const child = launched.process;
        try {
          const output = child.stdout[Symbol.asyncIterator]();
          const decoder = new TextDecoder();
          let ready = "";
          while (!ready.includes("\n")) {
            const chunk = await output.next();
            assert.ok(!chunk.done);
            ready += decoder.decode(chunk.value, { stream: true });
          }
          assert.equal(ready, "stdin-closed\n");
          // Bun can defer a small write's failure until end flushes it. A large
          // write must reject immediately; neither path may emit unhandled error.
          if (bytes === 1_024 * 1_024) {
            await assert.rejects(child.writeStdin(new Uint8Array(bytes)));
          } else {
            await child.writeStdin(new Uint8Array(bytes)).catch(() => {});
          }
          const closing = child.closeStdin(1_000);
          assert.equal(child.closeStdin(1_000), closing);
          const close = await closing;
          assert.equal(close.kind, "cleanup-error");
          if (close.kind !== "cleanup-error")
            throw new Error("expected stdin failure");
          assert.ok(close.cause instanceof Error);
          await assert.rejects(
            child.writeStdin(new Uint8Array(1)),
            (error) => error === close.cause,
          );
          const terminal = await child.closed();
          assert.ok(terminal.kind === "signal" || terminal.kind === "exited");
        } finally {
          await child.interrupt(1_000);
        }
      },
    });
  }
}
