import fs from "fs-extra";
import { join } from "node:path";

export interface ClaudeHookArtifactsOptions {
  hookDirectory: string;
}

export interface ClaudeHookArtifacts {
  hookDirectory: string;
  hookScriptPath: string;
  socketPath: string;
}

export async function createClaudeHookArtifacts({
  hookDirectory,
}: ClaudeHookArtifactsOptions): Promise<ClaudeHookArtifacts> {
  const hookScriptPath = join(hookDirectory, "hook.js");
  const socketPath = join(hookDirectory, "hook.sock");

  await fs.ensureDir(hookDirectory);
  await fs.writeFile(hookScriptPath, claudeHookScript(), {
    encoding: "utf8",
    mode: 0o755,
  });

  return {
    hookDirectory,
    hookScriptPath,
    socketPath,
  };
}

export function claudeHookScript(): string {
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
