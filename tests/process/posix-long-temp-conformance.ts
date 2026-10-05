import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProcessAdapter,
  type ChildFact,
} from "../../src/process/process.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  stage,
  withRunnerObserver,
  withTimeout,
} from "../helpers/standalone.js";
import type { RunnerCase } from "../helpers/scenario-runner.js";

export function registerPosixLongTempCases(
  register: (test: RunnerCase) => void,
): void {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  register({
    name: "POSIX long TMPDIR preserves launch inputs",
    body: longTempLaunch,
  });
}

async function longTempLaunch(): Promise<void> {
  const base = makeTempDir("secant-long-temp-");
  const nested = join(base, "a".repeat(64), "b".repeat(64));
  mkdirSync(nested, { recursive: true });
  const directory = realpathSync(nested);
  assert.ok(Buffer.byteLength(directory) > 110);
  const cleanup: (() => void)[] = [];
  const restore = setEnvironmentForTest(
    { after: (fn) => cleanup.push(fn) },
    { TMPDIR: directory },
  );
  const facts: ChildFact[] = [];
  const adapter = createProcessAdapter(
    withRunnerObserver({ observeChild: (fact) => facts.push(fact) }),
  );
  const env = { ...process.env, SECANT_LONG_TMP_PROBE: "long-temp-env" };
  const metadata = {
    cwd: directory,
    args: ["one", "two with spaces"],
    tmpdir: directory,
    extra: "long-temp-env",
  };
  const source = `
    const metadata = {
      cwd: process.cwd(), args: process.argv.slice(1),
      tmpdir: process.env.TMPDIR, extra: process.env.SECANT_LONG_TMP_PROBE,
    };
  `;
  try {
    assert.equal(tmpdir(), directory);
    await stage("Command launches under long caller TMPDIR", async () => {
      const result = await adapter.spawnCommand({
        role: "command",
        executable: process.execPath,
        args: [
          "-e",
          source +
            "process.stdout.write(JSON.stringify(metadata)); process.stderr.write('command-stderr'); process.exitCode = 17;",
          ...metadata.args,
        ],
        cwd: directory,
        env,
        timeoutMs: 5000,
        maxCaptureBytes: 4096,
        truncationMarker: "[truncated]",
      });
      assert.deepEqual(result, {
        kind: "exited",
        status: 17,
        text: Buffer.from(JSON.stringify(metadata) + "command-stderr"),
      });
    });
    await stage(
      "OwnedProcess retains stdio and backpressure under long TMPDIR",
      async () => {
        const launched = await adapter.spawnOwnedProcess({
          role: "harness-runtime",
          executable: process.execPath,
          args: [
            "-e",
            source +
              `
          const chunks = [];
          process.stdin.on('data', (chunk) => chunks.push(chunk));
          process.stdin.on('end', () => {
            process.stdout.write(JSON.stringify(metadata) + '\\n');
            process.stdout.write(Buffer.concat(chunks));
            process.stderr.write('owned-stderr');
            process.exitCode = 17;
          });
        `,
            ...metadata.args,
          ],
          cwd: directory,
          env,
          launchTimeoutMs: 5000,
        });
        assert.ok(launched.ok);
        const child = launched.process;
        const stdout = collect(child.stdout);
        const stderr = collect(child.stderr);
        const payload = "a".repeat(1024 * 1024);
        try {
          await withTimeout(
            child.writeStdin(Buffer.from(payload)),
            5000,
            "long-TMPDIR stdin did not drain",
          );
          assert.deepEqual(await child.closeStdin(5000), {
            kind: "exited",
            status: 17,
          });
          assert.deepEqual(await child.closed(), {
            kind: "exited",
            status: 17,
          });
          assert.equal(await stdout, JSON.stringify(metadata) + "\n" + payload);
          assert.equal(await stderr, "owned-stderr");
        } finally {
          await child.interrupt(100);
        }
      },
    );
    assert.deepEqual(
      facts.map((fact) => fact.kind),
      ["spawn", "exit", "spawn", "exit"],
    );
    for (const fact of facts) {
      if (fact.kind !== "exit") continue;
      assert.equal(fact.status, 17);
      assert.equal(fact.signal, undefined);
    }
    assert.equal(process.env.TMPDIR, directory);
  } finally {
    restore();
    for (const close of cleanup) close();
  }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const bytes of stream)
    text += decoder.decode(bytes, { stream: true });
  return text + decoder.decode();
}
