import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  OwnedProcessClose,
  OwnedProcess,
  ProcessAdapter,
  SpawnOwnedProcessResult,
} from "../../src/process/process.js";
import type { createCodexAdapter } from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";

const fixture = join(import.meta.dirname, "fixtures/codex/codex-qualification");
const trafficSchema = z.object({
  traffic: z.array(z.object({ direction: z.string(), line: z.string() })),
});
const frameSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Byte-faithful recorded pre-thread replies. Authentication uses its own
 * versioned recording; malformed initialization below is a synthetic race/failure
 * overlay and makes no claim about native wire shape. No new native field is read. */
export function scriptedPreparation(
  options: {
    readonly failure?: "authentication" | "protocol";
    readonly cleanup?: OwnedProcessClose;
    readonly acquisition?: Promise<void>;
    readonly onModelList?: () => void;
  } = {},
) {
  const recording = trafficSchema.parse(
    JSON.parse(
      readFileSync(
        join(
          options.failure === "authentication"
            ? join(import.meta.dirname, "fixtures/codex/authentication")
            : fixture,
          "case.json",
        ),
        "utf8",
      ),
    ),
  );
  const replies = new Map<number, string>();
  for (const frame of recording.traffic) {
    const parsed = frameSchema.parse(JSON.parse(frame.line));
    if (frame.direction === "stdout" && parsed.id !== undefined)
      replies.set(parsed.id, frame.line);
  }
  const acquired = Promise.withResolvers<void>();
  const cleanupStarted = Promise.withResolvers<void>();
  const underlying =
    Promise.withResolvers<Extract<SpawnOwnedProcessResult, { ok: true }>>();
  const closes: number[] = [];
  let closedReads = 0;
  let launches = 0;
  let current: OwnedProcess | undefined;
  const runtime = createFakeProcess({
    resolutionHandler: () => ({
      kind: "found",
      executable: process.execPath,
      prefixArgs: [],
    }),
    commandHandler: (command) => {
      if (command.args.includes("generate-json-schema")) {
        const out = command.args[command.args.indexOf("--out") + 1];
        assert.ok(out);
        copyFileSync(
          join(fixture, "stable-schema.generated.json"),
          join(out, "codex_app_server_protocol.schemas.json"),
        );
      }
      return {
        kind: "exited",
        status: 0,
        text: encoder.encode(
          options.failure === "authentication"
            ? "codex-cli 0.155.0"
            : "codex-cli 0.160.0",
        ),
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
          const request = frameSchema.parse(JSON.parse(decoder.decode(bytes)));
          if (request.id === undefined) return [];
          if (request.method === "model/list") options.onModelList?.();
          const reply =
            options.failure === "protocol" && request.method === "initialize"
              ? JSON.stringify({ id: request.id, result: {} }) + "\n"
              : replies.get(request.id);
          assert.ok(reply, `recorded reply for ${request.method}`);
          return [{ kind: "stdout", bytes: encoder.encode(reply) }];
        },
      },
    ],
  });
  const processAdapter: ProcessAdapter = {
    ...runtime,
    resolveExecutable: (name, options) =>
      runtime.resolveExecutable(name, options),
    spawnCommand: (options) => runtime.spawnCommand(options),
    spawnCommandSync: (options) => runtime.spawnCommandSync(options),
    spawnOwnedProcess: async (spawn) => {
      launches++;
      const result = await runtime.spawnOwnedProcess(spawn);
      assert.ok(result.ok);
      underlying.resolve(result);
      acquired.resolve();
      await options.acquisition;
      const owned = result.process;
      current = owned;
      return {
        ...result,
        process: {
          stdout: owned.stdout,
          stderr: owned.stderr,
          writeStdin: (bytes) => owned.writeStdin(bytes),
          interrupt: (ms) => owned.interrupt(ms),
          closed: () => {
            closedReads++;
            return owned.closed();
          },
          closeStdin: (ms) => {
            closes.push(ms);
            cleanupStarted.resolve();
            return options.cleanup === undefined
              ? owned.closeStdin(ms)
              : Promise.resolve(options.cleanup);
          },
        },
      };
    },
  };
  return {
    process: processAdapter,
    acquired: acquired.promise,
    cleanupStarted: cleanupStarted.promise,
    closes,
    closedReads: () => closedReads,
    launches: () => launches,
    exitNow() {
      assert.ok(current);
      return current.closeStdin(0);
    },
    async exit() {
      const child = await underlying.promise;
      await child.process.closeStdin(0);
      return child.process.closed();
    },
  };
}

/** Advance only the deadline clock. Readiness always comes from promises. */
export function preparationClock(start = 0) {
  let time = start;
  const timers = new Set<{
    readonly at: number;
    readonly callback: () => void;
  }>();
  const clock: NonNullable<
    Parameters<typeof createCodexAdapter>[0]["preparationClock"]
  > = {
    now: () => time,
    schedule: (callback, delayMs) => {
      const timer = { at: time + delayMs, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  };
  return {
    clock,
    scheduled: () => Array.from(timers, (timer) => timer.at),
    elapse(to: number) {
      time = to;
    },
    advance(to: number) {
      time = to;
      for (const timer of timers)
        if (timer.at <= time) {
          timers.delete(timer);
          timer.callback();
        }
    },
  };
}
