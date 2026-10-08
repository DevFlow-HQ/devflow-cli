import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAdapter } from "../../src/harness/harness.js";
import {
  createProcessAdapter,
  type ProcessAdapter,
  type OwnedProcess,
} from "../../src/process/process.js";
import type { RegisterConformanceCase } from "./conformance.js";
import { installCodexReplayer } from "./codex-replayer.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  stage,
  withRunnerObserver,
  withTimeout,
} from "../helpers/standalone.js";
import { fixtureLifetime } from "../helpers/fixture-lifetime.js";
import { preparationClock } from "./scripted-preparation.js";

/** Real Process lifetimes are exercised outside the semantic test runner. */
export function registerPreparationLifetime(
  register: RegisterConformanceCase,
): void {
  register(
    "m10-audit-runtime-failure-causes: real late acquisition remains owned after its report",
    async () => {
      const replay = installCodexReplayer("codex-qualification");
      let pid: number | undefined;
      const real = createProcessAdapter(
        withRunnerObserver({
          observeChild: (fact) => {
            if (fact.kind === "spawn" && fact.role === "harness-runtime")
              pid = fact.pid;
          },
        }),
      );
      const acquired = Promise.withResolvers<OwnedProcess>();
      const release = Promise.withResolvers<void>();
      const clock = preparationClock();
      const adapter = createCodexAdapter({
        env: {},
        path: replay.path,
        preparationClock: clock.clock,
      });
      const process: ProcessAdapter = {
        resolveExecutable: (name, options) =>
          real.resolveExecutable(name, options),
        spawnCommand: (options) => real.spawnCommand(options),
        spawnCommandSync: (options) => real.spawnCommandSync(options),
        spawnOwnedProcess: async (options) => {
          const result = await real.spawnOwnedProcess(options);
          if (result.ok) {
            acquired.resolve(result.process);
            await release.promise;
          }
          return result;
        },
      };
      const pending = adapter.prepare({
        workspace: makeTempDir("secant-preparation-workspace-"),
        process,
      });
      const child = await stage(
        "acquire real app-server before public handoff",
        () => acquired.promise,
      );
      assert.ok(pid !== undefined);
      const lifetime = fixtureLifetime(pid);
      try {
        const closing = adapter.close();
        clock.advance(5000);
        const report = await closing;
        assert.equal(report.status, "unresolved");
        assert.deepEqual(report.preparations[0]?.unresolved, [
          { kind: "preparation-pending" },
        ]);
        release.resolve();
        assert.equal(
          (await stage("settle cancelled late preparation", () => pending)).ok,
          false,
        );
        const exit = await stage("confirm real child lifetime ended", () =>
          withTimeout(child.closed(), 10000, "late child did not exit"),
        );
        // The exhausted deadline permits a failed drain receipt. Native death is
        // independently proved; it cannot rewrite the immutable unresolved report.
        assert.ok(
          exit.kind === "exited" ||
            exit.kind === "signal" ||
            exit.kind === "cleanup-error",
        );
        if (exit.kind === "cleanup-error") {
          assert.ok(exit.cause instanceof Error);
          assert.match(exit.cause.message, /POSIX stdin cleanup timeout/);
        }
        await lifetime.ended();
        assert.strictEqual(await adapter.close(), report);
        assert.equal(
          report.status,
          "unresolved",
          "final exit cannot rewrite deadline observations",
        );
      } finally {
        release.resolve();
        await child.interrupt(100);
        lifetime.close();
      }
    },
  );

  register(
    "m10-initial-preparation-ownership: real final exit overrides an incomplete cached cleanup receipt",
    async () => {
      const replay = installCodexReplayer("authentication");
      const real = createProcessAdapter(withRunnerObserver());
      const acquired = Promise.withResolvers<OwnedProcess>();
      const adapter = createCodexAdapter({
        env: {},
        path: replay.path,
        cleanupTimeoutMs: 0,
      });
      const scripted: ProcessAdapter = {
        resolveExecutable: (name, options) =>
          real.resolveExecutable(name, options),
        spawnCommand: (options) => real.spawnCommand(options),
        spawnCommandSync: (options) => real.spawnCommandSync(options),
        spawnOwnedProcess: async (options) => {
          const result = await real.spawnOwnedProcess(options);
          if (!result.ok) return result;
          const child = result.process;
          acquired.resolve(child);
          return {
            ...result,
            process: {
              ...child,
              stdout: child.stdout,
              stderr: child.stderr,
              writeStdin: (bytes) => child.writeStdin(bytes),
              interrupt: (ms) => child.interrupt(ms),
              closed: () => child.closed(),
              closeStdin: () =>
                Promise.resolve({
                  kind: "cleanup-error",
                  cause: new Error("synthetic cached cleanup error"),
                }),
            },
          };
        },
      };
      const failed = await adapter.prepare({
        workspace: makeTempDir("secant-preparation-workspace-"),
        process: scripted,
      });
      assert.equal(failed.ok, false);
      if (failed.ok) throw new Error("authentication accepted");
      assert.equal(failed.failure.category, "authentication");
      const child = await acquired.promise;
      await stage("close real child independently of cached receipt", () =>
        child.closeStdin(5000),
      );
      await stage("observe final exit", () => child.closed());
      const report = await adapter.close();
      assert.equal(report.status, "closed");
      assert.ok(
        report.preparations[0]?.cleanupFailures.some(
          (failure) => failure.category === "cleanup-error",
        ),
      );
      assert.strictEqual(await adapter.close(), report);
    },
  );

  register(
    "m10-initial-preparation-ownership: headless signal closes a qualification-only acquisition",
    async () => {
      const replay = installCodexReplayer("codex-qualification");
      const folder = makeTempDir("secant-preparation-signal-");
      const main = fileURLToPath(
        new URL("../../src/composition/main.ts", import.meta.url),
      );
      const processEntry = fileURLToPath(
        new URL("../../src/process/process.ts", import.meta.url),
      );
      const harness = fileURLToPath(
        new URL("../../src/harness/harness.ts", import.meta.url),
      );
      const proof = join(folder, "native-exit");
      const observerEntry = fileURLToPath(
        new URL("../helpers/standalone.ts", import.meta.url),
      );
      // A self-emitted signal reaches the registered handler on Windows too. Its
      // re-raise is the real host signal; POSIX terminal signals also remain covered
      // by compiled-binary/terminal acceptance. No installed Harness is used.
      const code = `
      import { writeFileSync } from 'node:fs';
      import { withClients } from ${JSON.stringify(main)};
      import { createProcessAdapter } from ${JSON.stringify(processEntry)};
      import { createCodexAdapter } from ${JSON.stringify(harness)};
      import { withRunnerObserver } from ${JSON.stringify(observerEntry)};
      const real = createProcessAdapter(withRunnerObserver());
      const release = Promise.withResolvers();
      process.once('SIGTERM', () => release.resolve());
      const scoped = {
        resolveExecutable: (name, options) => real.resolveExecutable(name, options),
        spawnCommand: (options) => real.spawnCommand(options),
        spawnCommandSync: (options) => real.spawnCommandSync(options),
        spawnOwnedProcess: async (options) => {
          const result = await real.spawnOwnedProcess(options);
          if (result.ok) {
            void result.process.closed().then((closed) => writeFileSync(${JSON.stringify(proof)}, closed.kind));
            queueMicrotask(() => process.emit('SIGTERM', 'SIGTERM'));
            await release.promise;
          }
          return result;
        },
      };
      await withClients(async ({ projectionPort }) => {
        projectionPort.openProjection({ family: 'harness-catalog', focus: { id: 'codex' } });
        await new Promise(() => {});
        return 0;
      }, {
        secantHome: ${JSON.stringify(join(folder, "home"))},
        launchCwd: ${JSON.stringify(folder)}, process: scoped,
        codexHarnessAdapter: createCodexAdapter({ path: ${JSON.stringify(replay.path)}, env: {} }),
        discoverCodex: () => ({ kind: 'found', attempt: { source: 'path', name: 'codex', description: 'recorded' } }),
        logSink: { folder: ${JSON.stringify(join(folder, "logs"))} },
      });
    `;
      const real = createProcessAdapter(withRunnerObserver());
      const spawned = await real.spawnOwnedProcess({
        role: "command",
        executable: process.execPath,
        args: ["-e", code],
        cwd: folder,
        env: process.env,
        launchTimeoutMs: 10000,
      });
      assert.ok(spawned.ok);
      const stdout = drain(spawned.process.stdout);
      const stderr = drain(spawned.process.stderr);
      const exit = await stage(
        "await signal cleanup and conventional re-raise",
        () =>
          withTimeout(
            spawned.process.closed(),
            15000,
            "headless signal shutdown hung",
          ),
      );
      const detail = await stderr;
      await stdout;
      assert.ok(exit.kind === "exited" || exit.kind === "signal", detail);
      assert.ok(existsSync(proof), `native lifetime unconfirmed: ${detail}`);
      assert.match(readFileSync(proof, "utf8"), /^(exited|signal)$/);
      const logs = readdirSync(join(folder, "logs"));
      assert.equal(logs.length, 1);
      const records: { event: string; status?: string; signal?: string }[] =
        readFileSync(join(folder, "logs", logs[0]!), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      const reports = records.filter(
        (record) => record.event === "harness-preparation-cleanup",
      );
      assert.equal(reports.length, 2);
      assert.ok(reports.every((record) => record.status === "closed"));
      assert.equal(records.at(-1)?.event, "invocation-end");
      assert.equal(records.at(-1)?.signal, "SIGTERM");
    },
  );
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const bytes of stream)
    text += decoder.decode(bytes, { stream: true });
  return text + decoder.decode();
}
