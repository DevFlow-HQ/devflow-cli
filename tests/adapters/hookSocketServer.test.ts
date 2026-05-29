import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import fs from "fs-extra";

import {
  HookSocketMalformedPayloadError,
  hookSocketServer,
} from "../../src/adapters/hookSocketServer.js";

function createSocketPath(testName: string): string {
  const safeName = testName.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);

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
  await server.start(socketPath, () => {});

  assert.equal(await fs.pathExists(socketPath), true);

  await server.stop({ drainMs: 0 });

  assert.equal(await fs.pathExists(socketPath), false);
});

function assertPayloadWithId(payload: unknown): number {
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  assert.equal(typeof (payload as { id?: unknown }).id, "number");

  return (payload as { id: number }).id;
}
