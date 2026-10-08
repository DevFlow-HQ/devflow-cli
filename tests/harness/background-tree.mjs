// Runtime-only descendant readiness. The worker leaves escaped Git Bash children
// in the Harness's inherited Windows job, and reports their PIDs before content.
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
export async function backgroundTree(options) {
  if (options === undefined) return;
  const child = spawn(process.execPath, [options.worker, "bash-tree"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", (bytes) => {
    errors += bytes.toString();
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`background worker exited ${code}: ${errors}`)),
    );
    child.stdout.on("data", (bytes) => {
      output += bytes.toString();
      if (!output.includes("\n")) return;
      const tree = JSON.parse(output.split("\n")[0]);
      const pending = `${options.report}.pending`;
      writeFileSync(
        pending,
        JSON.stringify({ ...tree, runtimePid: process.pid }),
      );
      renameSync(pending, options.report);
      resolve();
    });
  });
}
