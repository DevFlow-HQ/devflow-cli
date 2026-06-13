import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";

import fs from "fs-extra";

import {
  HookSocketMalformedPayloadError,
  HookSocketPathTooLongError,
  hookSocketServer,
} from "../../src/adapters/hookSocketServer.js";
import type { Logger } from "../../src/logger.js";

import { makeTempDir } from "../helpers/tempDir.js";
function createCapturingLogger() {
  const entries: Array<{
    level: keyof Logger;
    msg: string;
    context: Parameters<Logger["debug"]>[1];
  }> = [];
  const logger: Logger = {
    debug: (msg, context) => entries.push({ level: "debug", msg, context }),
    info: (msg, context) => entries.push({ level: "info", msg, context }),
    warn: (msg, context) => entries.push({ level: "warn", msg, context }),
    error: (msg, context) => entries.push({ level: "error", msg, context }),
    critical: (msg, context) => {
      entries.push({ level: "critical", msg, context });
      return "err_test";
    },
  };

  return { entries, logger };
}

function createSocketPath(testName: string): string {
  // Keep the path short so happy-path tests stay within the macOS 104-byte
  // sun_path budget regardless of the temp-dir prefix length.
  const safeName = testName.replace(/[^a-z0-9]+/gi, "-").slice(0, 16);

  if (process.platform === "win32") {
    return path.join("\\\\.\\pipe", `devflow-${process.pid}-${safeName}`);
  }

  return path.join(os.tmpdir(), `devflow-${process.pid}-${safeName}.sock`);
}

async function writePayload(socketPath: string, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.end(payload);
    });
    socket.once("close", (hadError) => {
      if (!hadError) {
        resolve();
      }
    });
  });
}

test("hook socket server delivers one JSON payload per connection", async (t) => {
  const socketPath = createSocketPath(t.name);
  const received: unknown[] = [];
  const server = hookSocketServer();
  t.after(async () => {
    await server.stop({ drainMs: 0 });
  });

  await server.start(socketPath, (payload) => {
    received.push(payload);
  });

  await writePayload(socketPath, JSON.stringify({ event: "ready", count: 1 }));

  assert.deepEqual(received, [{ event: "ready", count: 1 }]);
});

test("hook socket server delivers concurrent payloads independently", async (t) => {
  const socketPath = createSocketPath(t.name);
  const received: unknown[] = [];
  const server = hookSocketServer();
  t.after(async () => {
    await server.stop({ drainMs: 0 });
  });

  await server.start(socketPath, async (payload) => {
    await delay(5);
    received.push(payload);
  });

  await Promise.all([
    writePayload(socketPath, JSON.stringify({ id: 1 })),
    writePayload(socketPath, JSON.stringify({ id: 2 })),
    writePayload(socketPath, JSON.stringify({ id: 3 })),
  ]);
  await delay(20);

  assert.deepEqual(
    received
      .map((payload) => assertPayloadWithId(payload))
      .sort((left, right) => left - right),
    [1, 2, 3],
  );
});

test("hook socket server reports truncated JSON without crashing", async (t) => {
  const socketPath = createSocketPath(t.name);
  const errors: unknown[] = [];
  const received: unknown[] = [];
  const server = hookSocketServer({
    onError(error) {
      errors.push(error);
    },
  });
  t.after(async () => {
    await server.stop({ drainMs: 0 });
  });

  await server.start(socketPath, (payload) => {
    received.push(payload);
  });

  await writePayload(socketPath, '{"event":');
  await writePayload(socketPath, '{"event":"next"}');

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { event: "next" });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof HookSocketMalformedPayloadError);
  assert.equal(errors[0].reason, "truncated");
});

test("hook socket server reports malformed JSON without crashing", async (t) => {
  const socketPath = createSocketPath(t.name);
  const errors: unknown[] = [];
  const received: unknown[] = [];
  const server = hookSocketServer({
    onError(error) {
      errors.push(error);
    },
  });
  t.after(async () => {
    await server.stop({ drainMs: 0 });
  });

  await server.start(socketPath, (payload) => {
    received.push(payload);
  });

  await writePayload(socketPath, "{nope}");
  await writePayload(socketPath, '{"event":"next"}');

  assert.deepEqual(received, [{ event: "next" }]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof HookSocketMalformedPayloadError);
  assert.equal(errors[0].reason, "malformed");
});

test("hook socket server drains in-flight payload handling on stop", async (t) => {
  const socketPath = createSocketPath(t.name);
  const received: unknown[] = [];
  const server = hookSocketServer();
  let releaseHandler!: () => void;
  const handlerReleased = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });

  await server.start(socketPath, async (payload) => {
    await handlerReleased;
    received.push(payload);
  });

  await writePayload(socketPath, '{"event":"slow"}');
  const stopPromise = server.stop({ drainMs: 100 });
  await delay(20);
  assert.deepEqual(received, []);

  releaseHandler();
  await stopPromise;

  assert.deepEqual(received, [{ event: "slow" }]);
});

test("hook socket server forces open connections closed after drain timeout", async (t) => {
  const socketPath = createSocketPath(t.name);
  const server = hookSocketServer();
  t.after(async () => {
    await server.stop({ drainMs: 0 });
  });
  await server.start(socketPath, () => {});

  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const stopStartedAt = Date.now();
  await server.stop({ drainMs: 20 });

  assert.ok(Date.now() - stopStartedAt < 500);
  assert.equal(socket.destroyed, true);
});

test("hook socket server cleans up its Unix socket file on stop", async (t) => {
  if (process.platform === "win32") {
    return;
  }

  const socketPath = createSocketPath(t.name);
  const server = hookSocketServer();
  t.after(async () => {
    await server.stop({ drainMs: 0 });
  });
  await server.start(socketPath, () => {});

  assert.equal(await fs.pathExists(socketPath), true);

  await server.stop({ drainMs: 0 });

  assert.equal(await fs.pathExists(socketPath), false);
});

test("hook socket server cleans up its Unix socket file when the process exits without stop", async () => {
  if (process.platform === "win32") {
    return;
  }

  const tempDirectory = makeTempDir("devflow-hook-exit-");
  const socketPath = path.join(tempDirectory, "hook.sock");
  const childScriptPath = path.join(tempDirectory, "start-hook-server.mjs");
  const hookSocketServerUrl = pathToFileURL(
    path.join(process.cwd(), "src/adapters/hookSocketServer.ts"),
  ).href;
  const tsxCliPath = path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

  await fs.outputFile(
    childScriptPath,
    [
      'import fs from "node:fs";',
      `import { hookSocketServer } from ${JSON.stringify(hookSocketServerUrl)};`,
      "",
      "const socketPath = process.argv[2];",
      "const server = hookSocketServer();",
      "await server.start(socketPath, () => {});",
      "if (!fs.existsSync(socketPath)) {",
      '  console.error("socket missing after bind");',
      "  process.exit(2);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );

  const result = await runNode([tsxCliPath, childScriptPath, socketPath]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await fs.pathExists(socketPath), false);
});

test("hook socket server logs received hook payloads verbatim while keeping other lifecycle diagnostics metadata-only", async (t) => {
  const socketPath = createSocketPath(t.name);
  const { entries, logger } = createCapturingLogger();
  const server = hookSocketServer({ logger });
  t.after(async () => {
    await server.stop({ drainMs: 0 });
  });

  await server.start(socketPath, () => {});
  await writePayload(
    socketPath,
    JSON.stringify({
      hook_event_name: "SessionStart",
      secret: "SECRET-hook-payload-body",
    }),
  );
  await writePayload(socketPath, '{"hook_event_name":');

  const debugEntries = entries.filter((entry) => entry.level === "debug");
  const bound = debugEntries.find((entry) => /socket bound/i.test(entry.msg));
  const received = debugEntries.find((entry) => /payload received/i.test(entry.msg));
  const malformed = debugEntries.find((entry) =>
    /malformed payload/i.test(entry.msg),
  );
  const serializedContexts = JSON.stringify(
    debugEntries.map((entry) => entry.context),
  );

  assert.equal(bound?.context?.context?.socketPath, socketPath);
  assert.equal(received?.context?.context?.type, "SessionStart");
  assert.equal(
    received?.context?.context?.rawPayload,
    "{\"hook_event_name\":\"SessionStart\",\"secret\":\"SECRET-hook-payload-body\"}",
  );
  assert.equal("payloadLength" in (received?.context?.context ?? {}), false);
  assert.equal(malformed?.context?.context?.socketPath, socketPath);
  assert.equal(malformed?.context?.context?.reason, "truncated");
  assert.equal(malformed?.context?.context?.payloadLength, '{"hook_event_name":'.length);
  assert.equal("rawPayload" in (malformed?.context?.context ?? {}), false);
  assert.match(serializedContexts, /SECRET-hook-payload-body/);
  assert.equal(bound?.context?.runId, undefined);
  assert.equal(bound?.context?.stage, undefined);
});

test("hook socket server preserves behavior without an injected logger", async (t) => {
  const socketPath = createSocketPath(t.name);
  const received: unknown[] = [];
  const server = hookSocketServer();
  t.after(async () => {
    await server.stop({ drainMs: 0 });
  });

  await server.start(socketPath, (payload) => {
    received.push(payload);
  });

  await writePayload(socketPath, '{"event":"ready"}');

  assert.deepEqual(received, [{ event: "ready" }]);
});

test("hook socket server rejects an over-budget socket path before listening", async () => {
  const socketPath = path.join(os.tmpdir(), `${"a".repeat(110)}.sock`);
  const server = hookSocketServer({ maxSocketPathBytes: 104 });

  await assert.rejects(
    server.start(socketPath, () => {}),
    (error: unknown) => {
      assert.ok(error instanceof HookSocketPathTooLongError);
      assert.equal(error.maxSocketPathBytes, 104);
      assert.ok(error.byteLength >= 104);
      return true;
    },
  );

  // The server never listened, so stop() must be a clean no-op.
  await server.stop({ drainMs: 0 });
});

test("hook socket server surfaces the real listen failure and leaves stop a no-op", async () => {
  // Binding inside a non-existent directory makes listen() fail with ENOENT.
  const socketPath = path.join(
    os.tmpdir(),
    `devflow-missing-${process.pid}`,
    "hook.sock",
  );
  const server = hookSocketServer();

  await assert.rejects(server.start(socketPath, () => {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    // The original listen() cause is surfaced, not the masked close() error.
    assert.doesNotMatch(error.message, /Server is not running/i);
    assert.ok((error as NodeJS.ErrnoException).code);
    return true;
  });

  // listen() never succeeded, so a follow-up stop() must not call close() on a
  // never-listening server (which would reject with ERR_SERVER_NOT_RUNNING).
  await server.stop({ drainMs: 0 });
});

function assertPayloadWithId(payload: unknown): number {
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  assert.equal(typeof (payload as { id?: unknown }).id, "number");

  return (payload as { id: number }).id;
}

async function runNode(args: string[]): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
