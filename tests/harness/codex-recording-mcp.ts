// Opt-in fixture server. Real Codex produces both its tool-approval request and
// the MCP server's form/link elicitations; no reverse request is fabricated.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";

export async function startCodexRecordingMcp() {
  const connections = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();
  const sockets = new Set<Socket>();
  const http = createServer((req, res) => {
    const id = req.headers["mcp-session-id"];
    const existing = typeof id === "string" ? connections.get(id) : undefined;
    if (existing !== undefined) {
      void existing.transport.handleRequest(req, res);
      return;
    }
    const server = new McpServer({ name: "recording-external", version: "1" });
    for (const name of ["needs_approval", "ask_form", "ask_url"]) {
      server.registerTool(
        name,
        {
          description: `Recording tool ${name}. Call only when instructed.`,
          inputSchema: {},
        },
        async () => {
          const reply =
            name === "needs_approval"
              ? "approved"
              : (
                  await server.server.elicitInput(
                    name === "ask_form"
                      ? {
                          mode: "form",
                          message: "Enter a recording code",
                          requestedSchema: {
                            type: "object",
                            properties: { code: { type: "string" } },
                            required: ["code"],
                          },
                        }
                      : {
                          mode: "url",
                          message: "Open the recording verification link",
                          url: "https://example.com/verify",
                          elicitationId: "recorded-elicitation",
                        },
                  )
                ).action;
          return { content: [{ type: "text", text: reply }] };
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId): void => {
        connections.set(sessionId, { server, transport });
      },
    });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("recording server failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      for (const connection of connections.values())
        await connection.server.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        http.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    },
  };
}
