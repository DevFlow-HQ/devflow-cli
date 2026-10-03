import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProcessAdapter } from "../../src/process/process.js";
import { withRunnerObserver } from "../helpers/standalone.js";
import { initialMembership } from "./windows-contained-native.js";

const mode = process.argv[2];
const worker = fileURLToPath(import.meta.url);
const adapter = createProcessAdapter(withRunnerObserver());

async function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    stream.write(text, (error) => (error ? reject(error) : resolve())),
  );
}

if (mode === "arguments") {
  const membership = initialMembership();
  await write(
    process.stdout,
    JSON.stringify({
      membership,
      args: process.argv.slice(3),
      pathKeys: Object.keys(process.env).filter(
        (key) => key.toUpperCase() === "PATH",
      ),
      path: process.env.PATH,
      value: process.env.SECANT_CONTAINMENT_VALUE,
      omitted: process.env.SECANT_CONTAINMENT_OMITTED ?? null,
      cwd: process.cwd(),
    }),
  );
} else if (mode === "echo") {
  appendFileSync(process.argv[3]!, `${process.pid}\n`);
  await write(process.stdout, "ready\n");
  for await (const bytes of process.stdin)
    await write(process.stdout, bytes.toString());
} else if (mode === "holder") {
  process.send?.("ready");
  setInterval(() => {}, 1000);
} else if (mode === "handle-exit") {
  const holder = spawn(process.execPath, [worker, "holder"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    holder.once("message", () => resolve());
    holder.once("error", reject);
  });
  await Promise.all([
    write(
      process.stdout,
      JSON.stringify({ pid: holder.pid, final: "x".repeat(128 * 1024) }),
    ),
    write(process.stderr, "stderr-final:" + "y".repeat(128 * 1024)),
  ]);
  process.exit(23);
} else if (mode === "bash-tree") {
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
  // Git for Windows exposes the Windows PID in /proc/<MSYS pid>/winpid, also
  // used by Git's t6500-gc.sh. Bash exits, leaving dead Windows parent links.
  const script =
    'sleep 300 >/dev/null 2>&1 </dev/null & first=$!; sleep 301 >/dev/null 2>&1 </dev/null & second=$!; printf "%s\\n%s\\n" "$(cat /proc/$first/winpid)" "$(cat /proc/$second/winpid)"';
  const child = spawn(bash, ["-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    errors += bytes.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`bash exited ${code}: ${errors}`)),
    );
  });
  const pids = output.trim().split(/\s+/).map(Number);
  if (
    pids.length !== 2 ||
    pids.some((pid) => !Number.isInteger(pid) || pid <= 0)
  )
    throw new Error(`invalid Bash descendants: ${output}`);
  await write(
    process.stdout,
    JSON.stringify({ harnessPid: process.pid, bashPid: child.pid, pids }) +
      "\n",
  );
  setInterval(() => {}, 1000);
} else if (mode === "crash-owner") {
  const launched = await adapter.spawnOwnedProcess({
    role: "harness-runtime",
    executable: process.execPath,
    args: [worker, "bash-tree"],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  });
  if (!launched.ok)
    throw new Error(`tree launch failed: ${launched.failure.kind}`);
  for await (const chunk of launched.process.stdout)
    await write(process.stdout, Buffer.from(chunk).toString());
} else if (mode === "wait-reference") {
  const launched = await adapter.spawnOwnedProcess({
    role: "harness-runtime",
    executable: process.execPath,
    args: ["-e", "process.exit(19)"],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  });
  if (!launched.ok) throw new Error("wait-reference child did not launch");
  // No application timer owns this wait. The native exit registration must keep
  // the process alive until the handle's result can be published.
  const close = await launched.process.closed();
  await write(process.stdout, JSON.stringify(close));
} else throw new Error(`unknown containment worker mode: ${mode}`);
