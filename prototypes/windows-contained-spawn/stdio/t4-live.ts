// Live Harnesses launched through spawnContained: the stream protocol works over the
// bridged stdio, and a job kill ends the Harness and every tool descendant.
import { spawnContained } from "./contained-spawn";
import { existsSync, rmSync, writeFileSync } from "node:fs";

const dir = "C:/Users/rg/AppData/Local/Temp/secant258exp/stdio";
const which = process.argv[2];

async function alive(pattern: string): Promise<string[]> {
  const p = Bun.spawn(["powershell", "-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*${pattern}*' -and $_.Name -notin 'powershell.exe','bash.exe' -or ($_.Name -eq 'bash.exe' -and $_.CommandLine -like '*t4.sh*' -and $_.CommandLine -notlike '*secant258exp*') } | % { \"$($_.ProcessId) $($_.Name)\" }`]);
  return (await new Response(p.stdout).text()).trim().split(/\r?\n/).filter(Boolean);
}

function lines(stream: NodeJS.ReadableStream, on: (msg: any) => void) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) try { on(JSON.parse(line)); } catch { /* not JSON */ }
    }
  });
}

const marker = `${dir}/t4-end.marker`;
rmSync(marker, { force: true });
writeFileSync(`${dir}/t4.sh`, `#!/bin/bash\nping -n 25 127.0.0.2 > /dev/null\necho done > '${marker}'\n`);

if (which === "claude") {
  const c = await spawnContained(
    `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --allowedTools Bash`,
    dir,
  );
  console.log("claude pid", c.pid, "inJob", c.inJob());
  c.stderr.on("data", (d) => process.stderr.write(`[claude stderr] ${d}`));
  const seen = new Set<string>();
  lines(c.stdout, (m) => {
    const k = `${m.type}${m.subtype ? "/" + m.subtype : ""}`;
    if (!seen.has(k)) { seen.add(k); console.log("event", k); }
  });
  c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content:
    "Run exactly this Bash command and nothing else: ./t4.sh" } }) + "\n");
  let tree: string[] = [];
  for (let i = 0; i < 90 && tree.length === 0; i++) { await Bun.sleep(1000); tree = await alive("-n 25 127.0.0.2"); }
  console.log("ping running:", tree);
  console.log("script shells:", await alive("t4.sh"));
  c.kill();
  console.log("claude exit", await c.exited);
  await Bun.sleep(3000);
  console.log("after kill:", await alive("-n 25 127.0.0.2"), await alive("t4.sh"));
  await Bun.sleep(25000);
  console.log("marker written:", existsSync(marker));
}

if (which === "codex") {
  const c = await spawnContained(`codex app-server`, dir);
  console.log("codex pid", c.pid, "inJob", c.inJob());
  c.stderr.on("data", () => {});
  let id = 0;
  const pending = new Map<number, (r: any) => void>();
  const send = (method: string, params?: unknown) =>
    new Promise<any>((res) => { const n = ++id; pending.set(n, res); c.stdin.write(JSON.stringify({ id: n, method, params }) + "\n"); });
  const seen = new Set<string>();
  lines(c.stdout, (m) => {
    if (m.id !== undefined && pending.has(m.id) && m.method === undefined) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.id !== undefined && m.method) {
      console.log("server request", m.method);
      c.stdin.write(JSON.stringify({ id: m.id, result: { decision: "accept" } }) + "\n");
      return;
    }
    if (m.method && !seen.has(m.method)) { seen.add(m.method); console.log("notification", m.method); }
  });
  const init = await send("initialize", { clientInfo: { name: "secant-proto", version: "0.0.0" } });
  console.log("initialize ok:", !!init.result, init.error?.message ?? "");
  c.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const thread = await send("thread/start", { cwd: dir });
  const threadId = thread.result?.thread?.id;
  console.log("thread", threadId, thread.error?.message ?? "");
  await send("turn/start", { threadId, input: [{ type: "text", text:
    "Run exactly this PowerShell command and nothing else: ping -n 25 127.0.0.2" }] });
  let tree: string[] = [];
  for (let i = 0; i < 120 && tree.length === 0; i++) { await Bun.sleep(1000); tree = await alive("-n 25 127.0.0.2"); }
  console.log("ping running:", tree);
  c.kill();
  console.log("codex exit", await c.exited);
  await Bun.sleep(3000);
  console.log("after kill:", await alive("-n 25 127.0.0.2"), await alive("codex.exe"));
}
process.exit(0);
