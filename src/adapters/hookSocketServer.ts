import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";

import {
  buildHookSocketBoundTrace,
  buildHookSocketMalformedPayloadTrace,
  buildHookSocketPayloadReceivedTrace,
  emitAdapterTrace,
} from "./adapterTrace.js";
import { NoopLogger, type Logger } from "../logger.js";

export type HookSocketPayloadHandler = (
  payload: unknown,
) => void | Promise<void>;

export type HookSocketErrorHandler = (error: Error) => void | Promise<void>;

export interface HookSocketServerOptions {
  onError?: HookSocketErrorHandler;
  logger?: Logger;
  maxSocketPathBytes?: number;
}

export interface HookSocketServer {
  start(
    socketPath: string,
    onPayload: HookSocketPayloadHandler,
  ): Promise<void>;
  stop(options: { drainMs: number }): Promise<void>;
}

export class HookSocketPathTooLongError extends Error {
  readonly socketPath: string;
  readonly byteLength: number;
  readonly maxSocketPathBytes: number;

  constructor(options: {
    socketPath: string;
    byteLength: number;
    maxSocketPathBytes: number;
  }) {
    super(
      `Hook socket path is ${options.byteLength} bytes, which exceeds the ${options.maxSocketPathBytes}-byte sun_path budget for this platform.`,
    );
    this.name = "HookSocketPathTooLongError";
    this.socketPath = options.socketPath;
    this.byteLength = options.byteLength;
    this.maxSocketPathBytes = options.maxSocketPathBytes;
  }
}

export class HookSocketMalformedPayloadError extends Error {
  readonly socketPath: string;
  readonly payload: string;
  readonly reason: "truncated" | "malformed";
  readonly cause: unknown;

  constructor(options: {
    socketPath: string;
    payload: string;
    reason: "truncated" | "malformed";
    cause: unknown;
  }) {
    super(`Hook socket received ${options.reason} JSON payload.`);
    this.name = "HookSocketMalformedPayloadError";
    this.socketPath = options.socketPath;
    this.payload = options.payload;
    this.reason = options.reason;
    this.cause = options.cause;
  }
}

export class HookSocketPayloadHandlerError extends Error {
  readonly socketPath: string;
  readonly cause: unknown;

  constructor(socketPath: string, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : "Unknown payload handler failure";

    super(`Hook socket payload handler failed: ${causeMessage}.`);
    this.name = "HookSocketPayloadHandlerError";
    this.socketPath = socketPath;
    this.cause = cause;
  }
}

export class HookSocketConnectionError extends Error {
  readonly socketPath: string;
  readonly cause: unknown;

  constructor(socketPath: string, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : "Unknown socket connection failure";

    super(`Hook socket connection failed: ${causeMessage}.`);
    this.name = "HookSocketConnectionError";
    this.socketPath = socketPath;
    this.cause = cause;
  }
}

export function hookSocketServer(
  options: HookSocketServerOptions = {},
): HookSocketServer {
  const logger = options.logger ?? NoopLogger;
  const maxSocketPathBytes =
    options.maxSocketPathBytes ?? (process.platform === "darwin" ? 104 : 108);
  let server: net.Server | undefined;
  let currentSocketPath: string | undefined;
  let payloadHandler: HookSocketPayloadHandler | undefined;
  let stopping = false;
  let unregisterProcessCleanup: (() => void) | undefined;
  const sockets = new Set<net.Socket>();
  const inFlight = new Set<Promise<void>>();

  async function reportError(error: Error): Promise<void> {
    await options.onError?.(error);
  }

  function cleanupSocketFileSync(socketPath: string): void {
    if (process.platform === "win32") {
      return;
    }

    try {
      unlinkSync(socketPath);
    } catch {
      // Exit and signal handlers must never mask the real shutdown reason.
    }
  }

  async function cleanupSocketFile(socketPath: string): Promise<void> {
    if (process.platform === "win32") {
      return;
    }

    try {
      await fs.unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  function registerProcessCleanup(socketPath: string): () => void {
    if (process.platform === "win32") {
      return () => {};
    }

    let cleaned = false;
    const cleanupOnce = () => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      cleanupSocketFileSync(socketPath);
    };
    const handleSigint = () => {
      cleanupOnce();
      unregister();
      try {
        process.kill(process.pid, "SIGINT");
      } catch {
        process.exit(130);
      }
    };
    function unregister() {
      process.off("exit", cleanupOnce);
      process.off("SIGINT", handleSigint);
    }

    process.once("exit", cleanupOnce);
    process.once("SIGINT", handleSigint);

    return unregister;
  }

  function trackInFlight(promise: Promise<void>): void {
    inFlight.add(promise);
    promise.finally(() => {
      inFlight.delete(promise);
    });
  }

  async function handleSocket(socket: net.Socket): Promise<void> {
    const socketPath = currentSocketPath;
    const onPayload = payloadHandler;

    if (!socketPath || !onPayload) {
      socket.destroy();
      return;
    }

    let rawPayload = "";

    try {
      try {
        for await (const chunk of socket) {
          rawPayload += chunk.toString("utf8");
        }
      } catch (error) {
        if (!stopping) {
          await reportError(new HookSocketConnectionError(socketPath, error));
        }
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(rawPayload);
      } catch (error) {
        const reason = isTruncatedJsonParseError(error) ? "truncated" : "malformed";
        emitAdapterTrace(
          logger,
          buildHookSocketMalformedPayloadTrace({
            socketPath,
            reason,
            payloadLength: rawPayload.length,
          }),
        );
        await reportError(
          new HookSocketMalformedPayloadError({
            socketPath,
            payload: rawPayload,
            reason,
            cause: error,
          }),
        );
        return;
      }

      emitAdapterTrace(
        logger,
        buildHookSocketPayloadReceivedTrace({
          socketPath,
          type: hookPayloadType(parsed),
          rawPayload,
        }),
      );

      try {
        await onPayload(parsed);
      } catch (error) {
        await reportError(new HookSocketPayloadHandlerError(socketPath, error));
      }
    } finally {
      sockets.delete(socket);
    }
  }

  return {
    async start(socketPath, onPayload) {
      if (server) {
        throw new Error("Hook socket server is already started.");
      }

      const byteLength = Buffer.byteLength(socketPath);
      if (byteLength >= maxSocketPathBytes) {
        throw new HookSocketPathTooLongError({
          socketPath,
          byteLength,
          maxSocketPathBytes,
        });
      }

      await cleanupSocketFile(socketPath);

      currentSocketPath = socketPath;
      payloadHandler = onPayload;
      stopping = false;

      server = net.createServer((socket) => {
        if (stopping) {
          socket.destroy();
          return;
        }

        sockets.add(socket);
        socket.once("close", () => {
          sockets.delete(socket);
        });
        trackInFlight(handleSocket(socket));
      });

      try {
        await new Promise<void>((resolve, reject) => {
          const activeServer = server;

          if (!activeServer) {
            reject(new Error("Hook socket server was not initialized."));
            return;
          }

          activeServer.once("error", reject);
          activeServer.listen(socketPath, () => {
            activeServer.off("error", reject);
            unregisterProcessCleanup = registerProcessCleanup(socketPath);
            emitAdapterTrace(
              logger,
              buildHookSocketBoundTrace({
                socketPath,
              }),
            );
            resolve();
          });
        });
      } catch (error) {
        // listen() never succeeded; reset state so a later stop() short-circuits
        // on its `if (!server)` guard instead of calling close() on a server
        // that was never listening (which rejects with ERR_SERVER_NOT_RUNNING).
        server = undefined;
        currentSocketPath = undefined;
        payloadHandler = undefined;
        unregisterProcessCleanup?.();
        unregisterProcessCleanup = undefined;
        throw error;
      }
    },

    async stop({ drainMs }) {
      if (!server) {
        return;
      }

      const activeServer = server;
      const socketPath = currentSocketPath;
      stopping = true;
      server = undefined;
      currentSocketPath = undefined;
      payloadHandler = undefined;
      unregisterProcessCleanup?.();
      unregisterProcessCleanup = undefined;

      const closePromise = new Promise<void>((resolve, reject) => {
        activeServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      const drainPromise = Promise.allSettled([...inFlight]);
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), Math.max(0, drainMs));
      });
      const drainResult = await Promise.race([drainPromise, timeoutPromise]);

      if (drainResult === "timeout") {
        for (const socket of sockets) {
          socket.destroy();
        }
      }

      await closePromise;

      if (socketPath) {
        await cleanupSocketFile(socketPath);
      }
    },
  };
}

function isTruncatedJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    /unexpected end/i.test(error.message)
  );
}

function hookPayloadType(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { hook_event_name?: unknown }).hook_event_name === "string"
  ) {
    return (payload as { hook_event_name: string }).hook_event_name;
  }

  if (Array.isArray(payload)) {
    return "array";
  }

  return payload === null ? "null" : typeof payload;
}
