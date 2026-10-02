// The MCP permission bridge — private to the Harness Module, composed only into
// the Claude Code Adapter. Claude Code has no raw-CLI approval callback; the one
// documented route is `--permission-prompt-tool`, an MCP tool it calls and waits
// on for every tool use that needs permission. Secant hosts one Streamable HTTP
// MCP server per prepared Harness on loopback with a random port and a per-Run
// bearer token, exposing a single `approve` tool. Each call is relayed to the
// active Turn as an approval Harness Request through the `ApprovalRouter`; the
// call blocks until the Turn answers, then returns Claude Code's expected
// `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }` shape.
//
// One prepared Harness owns several named Sessions, each its own Claude Code
// process and its own MCP connection to this one server, so the HTTP listener
// keeps a transport per MCP session (a new one per `initialize`) rather than a
// single latched session. Approvals need no session affinity — each request is
// correlated by its own id on the active Turn — so which connection a prompt
// arrives on does not matter.
//
// The MCP-native protocol types (`@modelcontextprotocol/sdk`) stay behind this
// Seam: the Adapter sees only opaque strings and the bridge's spawn flags. The
// bearer token is a Secant-introduced secret; it lives only in the `--mcp-config`
// argv and this server's auth check. It is registered with the Harness secret
// registry while the bridge is open, so every redaction at the Seam (a spawn error
// whose argv carries it back, say) and the safe cause translator scrub it.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerSecret } from "./secrets.js";

/** The MCP server name; Claude addresses the tool as `mcp__<server>__<tool>`. */
const SERVER_NAME = "secant-permissions";
const TOOL_NAME = "approve";

/** The exact `--permission-prompt-tool` value Claude Code is launched with. */
const PERMISSION_TOOL = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

/** The message returned to a bridge call whose Turn ended before it was
 *  answered. Claude sees this as an ordinary denial and stops the tool use. */
export const EXPIRED_MESSAGE = "request expired";

/** Constant-time bearer comparison (D2): the 256-bit per-Run token must not be
 *  recoverable by timing an early-exit `!==` byte compare. `timingSafeEqual`
 *  requires equal-length buffers, so a length mismatch is rejected before it. */
function bearerMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One permission prompt, flattened to opaque strings so no MCP-native type
 *  crosses the Seam. `input` is the tool input serialized for the request shape;
 *  the bridge keeps the original object to echo back unchanged on allow. */
export interface ApprovalRequest {
  readonly tool: string;
  readonly input: string;
}

/** The Turn's answer to one prompt. */
export type ApprovalOutcome =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly message: string };

/** Raises the prompt on the active Turn and resolves when it is answered or
 *  expired. Never throws: with no Turn to take it, it resolves a deny. */
export type ApprovalRouter = (
  request: ApprovalRequest,
) => Promise<ApprovalOutcome>;

/** A live bridge: the flags to launch Claude Code against it, the bearer it
 *  authenticates, and its teardown. */
export interface PermissionBridge {
  /** The exact argv fragment that points a Claude Code launch at this bridge
   *  (the inline server config and the permission-prompt tool). It is the only
   *  place the bearer appears on a launch. */
  readonly launchArgs: readonly string[];
  /** The per-bridge bearer token, a Secant-introduced secret: named here so a
   *  composer can list it as a known secret rather than parse it back out of
   *  `launchArgs`. */
  readonly bearer: string;
  /** Idempotent teardown: closes the MCP sessions and the loopback listener,
   *  then releases the bearer from the secret registry. */
  close(): Promise<void>;
}

/** Start one loopback MCP permission bridge. Resolves once it is listening. */
export function startPermissionBridge(
  router: ApprovalRouter,
): Promise<PermissionBridge> {
  const token = randomBytes(32).toString("hex");
  const authHeader = `Bearer ${token}`;

  // A transport (and its own McpServer) per live MCP session. A request with a
  // known session id reuses its transport; a session-less request opens a new one
  // for the `initialize` it must be.
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Set<McpServer>();
  const sockets = new Set<Socket>();

  const http: Server = createServer((req, res) => {
    if (!bearerMatches(req.headers.authorization, authHeader)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const sessionId = sessionIdOf(req);
    const existing =
      sessionId === undefined ? undefined : sessions.get(sessionId);
    if (existing !== undefined) {
      void existing.handleRequest(req, res).catch(() => endWith500(res));
      return;
    }
    if (sessionId !== undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown session" }));
      return;
    }
    // A session-less request: an `initialize` opening a new MCP session.
    const server = buildServer(router);
    servers.add(server);
    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (id: string) => {
          sessions.set(id, transport);
        },
      });
    transport.onclose = () => {
      if (transport.sessionId !== undefined)
        sessions.delete(transport.sessionId);
      servers.delete(server);
      void server.close().catch(() => {});
    };
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => endWith500(res));
  });
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise<PermissionBridge>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", reject);
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("permission bridge did not bind a loopback port"));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const mcpConfigArg = JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: {
            type: "http",
            url,
            headers: { Authorization: authHeader },
          },
        },
      });
      // Registered once handed out; nothing carries the token before this.
      const release = registerSecret(token, "bearer-token");
      let closed: Promise<void> | undefined;
      resolve({
        launchArgs: [
          "--mcp-config",
          mcpConfigArg,
          "--permission-prompt-tool",
          PERMISSION_TOOL,
        ],
        bearer: token,
        close() {
          if (closed !== undefined) return closed;
          closed = (async () => {
            for (const transport of sessions.values()) {
              await transport.close().catch(() => {});
            }
            for (const server of servers) await server.close().catch(() => {});
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((done) => http.close(() => done()));
          })().finally(release);
          return closed;
        },
      });
    });
  });
}

/** Build the one-tool MCP server for a single MCP session. */
function buildServer(router: ApprovalRouter): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" });
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Secant permission bridge: approve or deny one Claude Code tool use.",
      inputSchema: {
        tool_name: z.string(),
        input: z.unknown().optional(),
        tool_use_id: z.string().optional(),
      },
    },
    async (args) => {
      const outcome = await router({
        tool: args.tool_name,
        input: serializeInput(args.input),
      });
      const payload =
        outcome.decision === "allow"
          ? { behavior: "allow", updatedInput: args.input ?? {} }
          : { behavior: "deny", message: outcome.message };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );
  return server;
}

/** The MCP session id a request carries, if any (case-insensitive header). */
function sessionIdOf(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function endWith500(res: {
  headersSent: boolean;
  writableEnded: boolean;
  writeHead(code: number): unknown;
  end(): unknown;
}): void {
  if (!res.headersSent) res.writeHead(500);
  if (!res.writableEnded) res.end();
}

/** Serialize a tool input to the request-shape string. An object becomes JSON;
 *  a bare string passes through; nothing becomes an empty object. */
function serializeInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === undefined) return "{}";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
