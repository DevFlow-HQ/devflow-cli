// Runtime-only descendant readiness. The worker leaves escaped Git Bash children
// in the Harness's inherited Windows job, and reports their PIDs before content.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
export async function backgroundTree(options) {
  if (options === undefined) return;
  const child = spawn(process.execPath, [options.worker, "bash-tree"], {
    stdio: ["ignore", "pipe", "pipe"],
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
      writeFileSync(
        options.report,
        JSON.stringify({ ...tree, runtimePid: process.pid }),
      );
      resolve();
    });
  });
}
