import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { withTimeout } from "./standalone.js";

/** Fixture readiness and release through live sockets, without host fs.watch quotas. */
export async function createLifetimeControl() {
  const roles = {
    root: Promise.withResolvers<{ pid: number; release(): void }>(),
    descendant: Promise.withResolvers<{ pid: number; release(): void }>(),
  };
  for (const role of Object.values(roles)) void role.promise.catch(() => {});
  const peers = new Set<Socket>();
  const server = createServer((peer) => {
    peers.add(peer);
    peer.on("error", (cause) => {
      for (const role of Object.values(roles)) role.reject(cause);
    });
    let input = "";
    peer.setEncoding("utf8");
    peer.on("data", (bytes: string) => {
      input += bytes;
      if (!input.includes("\n")) return;
      const match = /^(root|descendant) ([0-9]+)\n$/.exec(input);
      assert.ok(match, `invalid fixture readiness: ${input}`);
      const role = match[1];
      assert.ok(role === "root" || role === "descendant");
      const pid = Number(match[2]);
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      roles[role].resolve({ pid, release: () => peer.end("release") });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    ready(role: keyof typeof roles) {
      return withTimeout(
        roles[role].promise,
        5000,
        `${role} fixture did not become ready`,
      );
    },
    source(role: keyof typeof roles, exit: string): string {
      return `
        const control = require('node:net').connect({ host: '127.0.0.1', port: ${address.port} });
        control.once('connect', () => control.write('${role} ' + process.pid + '\\n'));
        control.once('data', () => { ${exit} });
        control.once('end', () => { ${exit} });
      `;
    },
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
