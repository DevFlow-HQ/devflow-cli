// One loopback listener per Prepared Harness serves Session-attached agent calls
// and Claude Code permissions. Harness Session identity comes only from its
// registered bearer, never from an MCP connection count or caller-supplied id.
// Each MCP transport is bound to both that Session and its server endpoint.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  AgentCall,
  AgentCallDeclaration,
  AgentCallReply,
} from "./harness.js";
import { registerSecret } from "./secrets.js";

const SERVER_NAME = "secant-permissions";
const PERMISSION_TOOL = `mcp__${SERVER_NAME}__approve`;
export const EXPIRED_MESSAGE = "request expired";

function bearerMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ApprovalRequest {
  readonly tool: string;
  readonly input: string;
}
export type ApprovalOutcome =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly message: string };
export type ApprovalRouter = (
  session: string,
  request: ApprovalRequest,
) => Promise<ApprovalOutcome>;

/** Resolves the Session's live Turn at call time. An idle Session has no sink. */
type AgentCallRouter = (
  session: string,
) =>
  ((call: AgentCall, metadata: unknown) => Promise<AgentCallReply>) | undefined;

interface SessionAttachment {
  readonly launchArgs: readonly string[];
  readonly bearer: string;
  /** The agent-call endpoint; callers attach it only for a nonempty declaration set. */
  readonly url: string;
}
export interface PermissionBridge {
  /** Opens once by normalized Session name, and reuses its token on relaunch.
   * Changing the declarations of an already-open Session is a contract violation. */
  session(
    name: string,
    declarations?: readonly AgentCallDeclaration[],
  ): SessionAttachment;
  close(): Promise<void>;
}

/** Snapshot and compare the opaque declaration set, independently of its order. */
export function bindAgentCallDeclarations(
  bound: readonly AgentCallDeclaration[] | undefined,
  declarations: readonly AgentCallDeclaration[] = [],
): readonly AgentCallDeclaration[] {
  const snapshot = declarations
    .map((call) => ({ ...call }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const call of snapshot) {
    if (
      !call.id ||
      ids.has(call.id) ||
      !Number.isInteger(call.maxReasonLength) ||
      call.maxReasonLength < 1 ||
      call.maxReasonLength > 400
    ) {
      throw new Error("invalid agent-call declaration");
    }
    ids.add(call.id);
  }
  if (bound !== undefined && !isDeepStrictEqual(bound, snapshot)) {
    throw new Error("agent-call declarations changed after Session open");
  }
  return bound ?? snapshot;
}

interface HarnessSession {
  readonly name: string;
  readonly declarations: readonly AgentCallDeclaration[];
  readonly attachment: SessionAttachment;
}
interface McpSession {
  readonly owner: HarnessSession;
  readonly endpoint: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

/** The SDK stays private to Harness. The recorder uses this same listener,
 * with one named recording Session, rather than copying the permission bridge. */
export function startPermissionBridge(
  approve: ApprovalRouter,
  agentCalls: AgentCallRouter = () => undefined,
): Promise<PermissionBridge> {
  const harnessSessions = new Map<string, HarnessSession>();
  const sessions = new Map<string, McpSession>();
  const connections = new Set<McpSession>();
  const sockets = new Set<Socket>();
  let closed: Promise<void> | undefined;

  const http = createServer((req, res) => {
    if (closed !== undefined) {
      res.writeHead(503).end();
      return;
    }
    const owner = [...harnessSessions.values()].find((session) =>
      bearerMatches(
        req.headers.authorization,
        `Bearer ${session.attachment.bearer}`,
      ),
    );
    if (owner === undefined) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const endpoint = req.url;
    if (
      endpoint !== "/permissions" &&
      (endpoint !== "/mcp" || owner.declarations.length === 0)
    ) {
      res.writeHead(404).end();
      return;
    }
    const sessionId = sessionIdOf(req);
    const existing =
      sessionId === undefined ? undefined : sessions.get(sessionId);
    if (
      existing !== undefined &&
      existing.owner === owner &&
      existing.endpoint === endpoint
    ) {
      void existing.transport
        .handleRequest(req, res)
        .catch(() => endWith500(res));
      return;
    }
    if (sessionId !== undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown session" }));
      return;
    }
    const server =
      endpoint === "/permissions"
        ? permissionServer((request) => approve(owner.name, request))
        : agentCallServer(owner, agentCalls);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString("hex"),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, connection);
      },
    });
    const connection: McpSession = { owner, endpoint, transport, server };
    connections.add(connection);
    // The SDK wraps this hook when connected, so retain it before connect.
    transport.onclose = () => {
      if (transport.sessionId !== undefined)
        sessions.delete(transport.sessionId);
      connections.delete(connection);
      void server.close().catch(() => {});
    };
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .then(() => {
        // A failed initialization never earns a persistent transport.
        if (transport.sessionId === undefined) return server.close();
      })
      .catch(() => {
        endWith500(res);
        void server.close().catch(() => {});
      });
  });
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", reject);
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Harness listener did not bind a loopback port"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        session(name, declarations) {
          if (closed !== undefined)
            throw new Error("Session attachment after listener close");
          const existing = harnessSessions.get(name);
          const bound = bindAgentCallDeclarations(
            existing?.declarations,
            declarations,
          );
          if (existing !== undefined) return existing.attachment;
          const token = randomBytes(32).toString("hex");
          registerSecret(token, "bearer-token");
          const config = JSON.stringify({
            mcpServers: {
              ...(bound.length === 0
                ? {}
                : {
                    secant: {
                      type: "http",
                      url: `${baseUrl}/mcp`,
                      headers: { Authorization: `Bearer ${token}` },
                    },
                  }),
              [SERVER_NAME]: {
                type: "http",
                url: `${baseUrl}/permissions`,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          });
          const attachment: SessionAttachment = {
            launchArgs: [
              "--mcp-config",
              config,
              "--permission-prompt-tool",
              PERMISSION_TOOL,
              ...(bound.length === 0
                ? []
                : [
                    "--allowedTools",
                    bound.map((call) => `mcp__secant__${call.id}`).join(","),
                  ]),
            ],
            bearer: token,
            url: `${baseUrl}/mcp`,
          };
          harnessSessions.set(name, { name, declarations: bound, attachment });
          return attachment;
        },
        close() {
          closed ??= (async () => {
            // Stop socket input before awaiting SDK teardown, including transports
            // whose initialize is still in flight.
            for (const socket of sockets) socket.destroy();
            const results = await Promise.allSettled([
              ...[...connections].map((connection) =>
                connection.server.close(),
              ),
              new Promise<void>((done, fail) =>
                http.close((error) => (error ? fail(error) : done())),
              ),
            ]);
            const failures = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (failures.length > 0)
              throw new AggregateError(
                failures,
                "Harness listener cleanup failed",
              );
          })();
          return closed;
        },
      });
    });
  });
}

function permissionServer(
  router: (request: ApprovalRequest) => Promise<ApprovalOutcome>,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" });
  server.registerTool(
    "approve",
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
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  );
  return server;
}

function agentCallServer(
  owner: HarnessSession,
  router: AgentCallRouter,
): McpServer {
  const server = new McpServer({ name: "secant", version: "1.0.0" });
  for (const declaration of owner.declarations) {
    server.registerTool(
      declaration.id,
      {
        description: declaration.description,
        inputSchema: {
          reason: z
            .string()
            .max(declaration.maxReasonLength)
            .refine(
              (reason) => reason.trim().length > 0,
              "reason must not be empty",
            ),
        },
      },
      async (args, extra) => {
        const sink = router(owner.name);
        const reply: AgentCallReply =
          sink === undefined
            ? { outcome: "refused", reason: "no Turn in progress" }
            : await sink(
                {
                  callId: { opaque: randomBytes(16).toString("hex") },
                  id: declaration.id,
                  reason: args.reason,
                },
                extra._meta,
              );
        const message =
          reply.outcome === "accepted"
            ? "accepted: takes effect when this Turn finishes"
            : reply.outcome === "held-for-review"
              ? "held for review: the human decides the next Iteration"
              : reply.reason;
        return {
          isError: reply.outcome === "refused",
          content: [{ type: "text", text: message }],
        };
      },
    );
  }
  return server;
}

function sessionIdOf(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value[0]
      : undefined;
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
function serializeInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === undefined) return "{}";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
