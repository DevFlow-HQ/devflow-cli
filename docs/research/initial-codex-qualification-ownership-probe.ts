/** Advisory, process-free investigation; run from the repository root:
 * bun docs/research/initial-codex-qualification-ownership-probe.ts
 *
 * Uses the public Harness and Process Interfaces and the qualification recording
 * used by tests/harness/containment.test.ts. It does not spawn native children.
 * The wrapper separates a cached incomplete closeStdin receipt from a later
 * independent closed() observation, which the ordinary fake combines.
 * Assertions document current behavior, including the ownership gap; this is
 * research evidence, not a passing regression test for a proposed fix.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCodexAdapter } from "../../src/harness/harness.js";
import type {
  OwnedProcessClose,
  ProcessAdapter,
} from "../../src/process/process.js";
import { createFakeProcess } from "../../tests/process/fake-adapter.js";

const CLEANUP_BOUND_MS = 15;
const INVESTIGATION_BOUND_MS = 2_000;
const fixture = join(
  import.meta.dirname,
  "../../tests/harness/fixtures/codex/codex-qualification",
);
const recording = z
  .object({
    traffic: z.array(z.object({ direction: z.string(), line: z.string() })),
  })
  .parse(JSON.parse(readFileSync(join(fixture, "case.json"), "utf8")));
const requestSchema = z.object({
  id: z.number().optional(),
  method: z.string(),
});
const responseSchema = z.object({ id: z.number().optional() });
const replies = new Map(
  recording.traffic
    .filter((frame) => frame.direction === "stdout")
    .flatMap((frame): [number, string][] => {
      const { id } = responseSchema.parse(JSON.parse(frame.line));
      return id === undefined ? [] : [[id, frame.line]];
    }),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Qualification =
  "authenticated" | "authentication-failure" | "protocol-failure";
type Cleanup =
  | { readonly kind: "complete" }
  | Extract<OwnedProcessClose, { kind: "cleanup-timeout" | "cleanup-error" }>;

function scriptedProcess(qualification: Qualification, cleanup: Cleanup) {
  const calls: { closeStdin: number[]; interrupt: number; closed: number } = {
    closeStdin: [],
    interrupt: 0,
    closed: 0,
  };
  let finalExitObserved = false;
  let releaseFinalExit: (() => Promise<OwnedProcessClose>) | undefined;
  const runtime = createFakeProcess({
    resolutionHandler: () => ({
      kind: "found",
      executable: process.execPath,
      prefixArgs: [],
    }),
    commandHandler: (options) => {
      if (options.args.includes("generate-json-schema")) {
        const directory = options.args[options.args.indexOf("--out") + 1];
        assert.ok(directory);
        copyFileSync(
          join(fixture, "stable-schema.generated.json"),
          join(directory, "codex_app_server_protocol.schemas.json"),
        );
      }
      return {
        kind: "exited",
        status: 0,
        text: encoder.encode("codex-cli 0.160.0"),
      };
    },
    ownedProcesses: [
      {
        kind: "launched",
        emissions: [
          {
            kind: "terminal",
            trigger: "close-stdin",
            close: { kind: "exited", status: 0 },
          },
        ],
        stdinReplies: (bytes) => {
          const request = requestSchema.parse(
            JSON.parse(decoder.decode(bytes)),
          );
          if (request.id === undefined) return [];
          let reply = replies.get(request.id);
          if (
            qualification === "authentication-failure" &&
            request.method === "account/read"
          ) {
            reply =
              JSON.stringify({
                id: request.id,
                result: { account: null, requiresOpenaiAuth: true },
              }) + "\n";
          }
          if (
            qualification === "protocol-failure" &&
            request.method === "initialize"
          ) {
            reply = JSON.stringify({ id: request.id, result: {} }) + "\n";
          }
          assert.ok(reply, `recorded response for ${request.method}`);
          return [{ kind: "stdout", bytes: encoder.encode(reply) }];
        },
      },
    ],
  });
  const processAdapter: ProcessAdapter = {
    resolveExecutable: (name, options) =>
      runtime.resolveExecutable(name, options),
    spawnCommand: (options) => runtime.spawnCommand(options),
    spawnCommandSync: (options) => runtime.spawnCommandSync(options),
    spawnOwnedProcess: async (options) => {
      const spawned = await runtime.spawnOwnedProcess(options);
      assert.ok(spawned.ok);
      const owned = spawned.process;
      // This is the fixture controller's independent final-exit observation.
      // Harness calls to closed() are counted separately below.
      const finalExit = owned.closed().then((close) => {
        finalExitObserved = true;
        return close;
      });
      releaseFinalExit = async () => {
        await owned.closeStdin(CLEANUP_BOUND_MS);
        return finalExit;
      };
      return {
        ...spawned,
        process: {
          stdout: owned.stdout,
          stderr: owned.stderr,
          writeStdin: (bytes) => owned.writeStdin(bytes),
          closeStdin: (timeoutMs) => {
            calls.closeStdin.push(timeoutMs);
            return cleanup.kind === "complete"
              ? owned.closeStdin(timeoutMs)
              : Promise.resolve(cleanup);
          },
          interrupt: (gracefulMs) => {
            calls.interrupt += 1;
            return owned.interrupt(gracefulMs);
          },
          closed: () => {
            calls.closed += 1;
            return finalExit;
          },
        },
      };
    },
  };
  return {
    processAdapter,
    calls,
    finalExitObserved: () => finalExitObserved,
    releaseFinalExit: () => {
      assert.ok(releaseFinalExit, "scripted child was acquired");
      return releaseFinalExit();
    },
  };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("investigation exceeded its completion bound")),
          INVESTIGATION_BOUND_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function causeMessages(cause: unknown): string[] {
  if (cause instanceof AggregateError)
    return cause.errors.flatMap(causeMessages);
  return cause instanceof Error ? [cause.message] : [];
}

const workspace = mkdtempSync(join(tmpdir(), "secant-qualification-probe-"));
try {
  for (const cleanup of [
    { kind: "cleanup-timeout" },
    { kind: "cleanup-error", cause: new Error("scripted stdin cleanup error") },
  ] satisfies Cleanup[]) {
    for (const qualification of [
      "authentication-failure",
      "protocol-failure",
    ] satisfies Qualification[]) {
      const adapter = createCodexAdapter({
        env: {},
        handshakeTimeoutMs: INVESTIGATION_BOUND_MS,
        cleanupTimeoutMs: CLEANUP_BOUND_MS,
      });
      const initial = scriptedProcess(qualification, cleanup);
      const started = performance.now();
      const failed = await bounded(
        adapter.prepare({ workspace, process: initial.processAdapter }),
      );
      const elapsedMs = Math.round(performance.now() - started);
      assert.equal(failed.ok, false);
      if (failed.ok) throw new Error("expected failed qualification");
      assert.equal("harness" in failed, false);
      assert.equal("unreaped" in failed, false);
      assert.equal(failed.failure.phase, "prepare");
      assert.equal(
        failed.failure.category,
        qualification === "authentication-failure"
          ? "authentication"
          : "protocol-incompatible",
      );
      const diagnostics = failed.failure.diagnostics;
      assert.ok(diagnostics);
      assert.ok(diagnostics.includes(`Cleanup ended '${cleanup.kind}'.`));
      const causes = causeMessages(failed.failure.cause);
      assert.ok(causes.includes("Codex stderr drain timed out"));
      assert.ok(
        causes.includes(
          cleanup.kind === "cleanup-error"
            ? "scripted stdin cleanup error"
            : "Codex cleanup ended 'cleanup-timeout'",
        ),
      );
      if (qualification === "authentication-failure") {
        assert.ok(diagnostics.startsWith("Authentication required for Codex."));
      } else {
        assert.ok(
          diagnostics.includes("initialize returned an incompatible result"),
        );
        assert.ok(
          causes.some((message) =>
            message.includes("initialize returned an incompatible result"),
          ),
        );
      }
      assert.equal(initial.finalExitObserved(), false);
      assert.deepEqual(initial.calls, {
        closeStdin: [CLEANUP_BOUND_MS],
        interrupt: 0,
        closed: 0,
      });

      // A valid independent prepare through the SAME Adapter still succeeds.
      // Closing that handle owns only its child, while initial exit is pending.
      const next = scriptedProcess("authenticated", { kind: "complete" });
      const success = await bounded(
        adapter.prepare({ workspace, process: next.processAdapter }),
      );
      assert.ok(success.ok);
      assert.equal(next.finalExitObserved(), false);
      const report = await bounded(success.harness.close());
      assert.equal(report.clean, true);
      assert.deepEqual(next.calls.closeStdin, [CLEANUP_BOUND_MS]);
      assert.equal(next.finalExitObserved(), true);
      assert.equal(initial.finalExitObserved(), false);
      assert.deepEqual(initial.calls, {
        closeStdin: [CLEANUP_BOUND_MS],
        interrupt: 0,
        closed: 0,
      });

      // Final exit can still be observed by Process independently; it does not
      // retroactively supply a caller-visible Harness cleanup capability.
      assert.deepEqual(await initial.releaseFinalExit(), {
        kind: "exited",
        status: 0,
      });
      assert.equal(initial.finalExitObserved(), true);
      assert.deepEqual(initial.calls, {
        closeStdin: [CLEANUP_BOUND_MS],
        interrupt: 0,
        closed: 0,
      });
      console.log(
        JSON.stringify({
          qualification,
          cleanup: cleanup.kind,
          elapsedMs,
          diagnostics,
          causes,
          initialHarnessCalls: initial.calls,
          nextCloseClean: report.clean,
          lateFinalExit: "exited",
        }),
      );
    }
  }

  // Before acquisition: discovery and launch failures expose no cleanup handle.
  for (const failurePoint of ["discovery", "launch"] satisfies (
    "discovery" | "launch"
  )[]) {
    const base = scriptedProcess("authenticated", { kind: "complete" });
    let ownedLaunchAttempts = 0;
    const processAdapter: ProcessAdapter = {
      ...base.processAdapter,
      resolveExecutable: (name, options) =>
        failurePoint === "discovery"
          ? { kind: "not-found" }
          : base.processAdapter.resolveExecutable(name, options),
      spawnOwnedProcess: () => {
        ownedLaunchAttempts += 1;
        return Promise.resolve({
          ok: false,
          failure: {
            kind: "spawn-error",
            cause: new Error("scripted launch error"),
          },
        });
      },
    };
    const failed = await bounded(
      createCodexAdapter({ env: {} }).prepare({
        workspace,
        process: processAdapter,
      }),
    );
    assert.equal(failed.ok, false);
    if (failed.ok) throw new Error("expected failure before acquisition");
    assert.equal("harness" in failed, false);
    assert.equal(
      failed.failure.category,
      failurePoint === "discovery" ? "not-found" : "app-server-launch",
    );
    assert.equal(ownedLaunchAttempts, failurePoint === "discovery" ? 0 : 1);
    assert.deepEqual(base.calls, { closeStdin: [], interrupt: 0, closed: 0 });
    console.log(
      JSON.stringify({
        failurePoint,
        category: failed.failure.category,
        ownedLaunchAttempts,
        acquiredChild: false,
      }),
    );
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
