export interface CodexHookConfigTomlInput {
  hookScriptPath: string;
}

export function codexHookConfigToml({
  hookScriptPath,
}: CodexHookConfigTomlInput): string {
  const command = `node ${shellQuote(hookScriptPath)}`;
  const handler = `{ hooks = [{ type = "command", command = ${tomlString(command)} }] }`;

  return [
    "[hooks]",
    `SessionStart = [${handler}]`,
    `UserPromptSubmit = [${handler}]`,
    `Stop = [${handler}]`,
    "",
  ].join("\n");
}

export function codexHookScript(): string {
  return `#!/usr/bin/env node
import net from "node:net";

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  void forwardHookPayload(input);
});
process.stdin.on("error", (error) => {
  fail(error);
});

async function forwardHookPayload(rawPayload) {
  let payload;

  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    fail(error);
    return;
  }

  const socketPath = process.env.DEVFLOW_HOOK_IPC_PATH;

  if (!socketPath) {
    fail(new Error("DEVFLOW_HOOK_IPC_PATH is not set."));
    return;
  }

  try {
    await writePayload(socketPath, JSON.stringify(payload));
  } catch (error) {
    fail(error);
  }
}

function writePayload(socketPath, payload) {
  return new Promise((resolve, reject) => {
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

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
