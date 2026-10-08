import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createLifetimeControl } from "../../tests/helpers/lifetime-control.js";

/** Exercise the copied production binary, with fixture release owned by live sockets,
 * never by signalling a remembered numeric PID after its lifetime ends. */
export async function posixExitedRootAcceptance(options: {
  binary: string;
  smokeRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const folder = join(options.smokeRoot, "posix-exited-root");
  const workspace = join(folder, "workspace");
  const bundle = join(folder, "bundle");
  const logs = join(folder, "logs");
  await mkdir(workspace, { recursive: true });
  await mkdir(bundle);
  const env = {
    ...options.env,
    SECANT_LOG_DIR: logs,
    PATH: `${dirname(process.execPath)}${delimiter}${options.env.PATH ?? ""}`,
  };
  const control = await createLifetimeControl();
  try {
    const descendant = `
    process.on('SIGTERM', () => {});
    process.stdout.write('inherited-out');
    process.stderr.write('inherited-err');
    ${control.source("descendant", "process.exit(0);")}
  `;
    const source = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
      { stdio: ['ignore', 'inherit', 'inherit'] });
    ${control.source("root", "process.exit(17);")}
  `;
    const id = "dev.secant.posix-exited-root-smoke";
    await writeFile(
      join(bundle, "manifest.json"),
      JSON.stringify({
        formatVersion: 1,
        bundle: {
          id,
          version: "1.0.0",
          name: "Exited Root Smoke",
          description:
            "A Command retains root status through inherited-pipe cleanup.",
        },
        platforms: ["macos", "linux"],
        inputs: {},
        assets: [],
        routing: [
          {
            id: "root",
            kind: "command",
            produces: [
              { name: "log", type: "text" },
              { name: "passing", type: "verdict" },
            ],
            command: {
              executable: basename(process.execPath),
              arguments: ["-e", source],
            },
          },
        ],
      }),
    );
    const run = (args: readonly string[]): string => {
      const result = spawnSync(options.binary, [...args], {
        cwd: workspace,
        env,
        encoding: "utf8",
        timeout: 20000,
      });
      if (result.error !== undefined) throw result.error;
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    };
    run(["workspace", "approve"]);
    run(["bundle", "build", bundle]);
    const installed = JSON.parse(
      run(["bundle", "list", "--json"]),
    ).result.bundles.find((row: { id: string }) => row.id === id);
    assert.ok(installed !== undefined);
    const child = spawn(
      options.binary,
      ["run", "launch", id, "--trust", installed.digest, "--json"],
      { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes.toString();
    });
    child.stderr.on("data", (bytes) => {
      output += bytes.toString();
    });
    let ended = false;
    const closed = new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (_status, signal) => {
        ended = true;
        resolve(signal);
      });
    });
    void closed.catch(() => {});
    // The smoke process owns this bound independently of the binary's event loop.
    const bound = setTimeout(() => child.kill("SIGKILL"), 20000);
    try {
      const rootPid = (await control.ready("root")).pid;
      const descendantPid = (await control.ready("descendant")).pid;
      assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0);
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      (await control.ready("root")).release();
      await waitForDeath(rootPid);
      assert.equal(dead(descendantPid), false);
      assert.equal(
        ended,
        false,
        "binary settled before inherited pipes drained",
      );
      assert.equal(child.kill("SIGINT"), true);
      assert.equal(await closed, "SIGINT", output);
      await waitForDeath(descendantPid);
      const records: Record<string, unknown>[] = readdirSync(logs).flatMap(
        (file) =>
          readFileSync(join(logs, file), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
      );
      const lifecycle = records.filter((record) => record.childPid === rootPid);
      assert.deepEqual(
        lifecycle.map((record) => record.event),
        [
          "child-spawn",
          "child-cancellation",
          "child-kill-escalation",
          "child-reap",
        ],
      );
      assert.equal(lifecycle.at(-1)?.exitStatus, 17);
      assert.equal(lifecycle.at(-1)?.signal, undefined);
      const rows = JSON.parse(run(["run", "list", "--json"])).rows;
      assert.equal(rows.length, 1);
      const shown = JSON.parse(run(["run", "show", rows[0].runId, "--json"]));
      // A native exit publishes a succeeded Attempt even with a fail Verdict;
      // this last Step therefore completes its Run despite the later group cleanup.
      assert.equal(shown.result.run.state, "succeeded");
      assert.equal(
        JSON.parse(run(["run", "read", `${rows[0].runId}/log`, "--json"]))
          .content,
        "inherited-outinherited-err",
      );
      assert.equal(
        JSON.parse(run(["run", "read", `${rows[0].runId}/passing`, "--json"]))
          .content,
        "fail",
      );
    } finally {
      if (!ended) child.kill("SIGINT");
      await closed;
      clearTimeout(bound);
    }
  } finally {
    await control.close();
  }
}

function dead(pid: number): boolean {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error !== undefined) throw result.error;
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.status === 1 || result.stdout.trim().startsWith("Z");
}

async function waitForDeath(pid: number): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!dead(pid)) {
    assert.ok(
      performance.now() < deadline,
      "exited-root fixture survived cleanup",
    );
    await setImmediate();
  }
}
