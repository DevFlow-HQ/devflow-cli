// T2 Git Bash dead-parent escape contained; T4 throughput; T6 handle list.
import { spawnContained } from "./contained-spawn";
import { existsSync, rmSync, writeFileSync } from "node:fs";

const dir = "C:/Users/rg/AppData/Local/Temp/secant258exp/stdio";
const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
const marker = `${dir}/t2-end.marker`;
const which = process.argv[2];

async function ps(pattern: string): Promise<string> {
  const p = Bun.spawn(["powershell", "-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${pattern}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }`]);
  return (await new Response(p.stdout).text()).trim();
}

if (which === "escape") {
  rmSync(marker, { force: true });
  writeFileSync(`${dir}/t2.sh`, `#!/bin/bash\nping -n 8 127.0.0.1 > /dev/null\necho done > '${marker}'\n`);
  // Same shape as Claude Code's tool shell: bash -c running a script (fork-and-exec).
  const c = await spawnContained(`"${bash}" -c "./t2.sh; echo after"`, dir);
  c.stdout.on("data", () => {});
  c.stderr.on("data", () => {});
  await Bun.sleep(1500);
  console.log("before kill:\n" + (await ps("t2.sh")) + "\n" + (await ps("-n 8 127.0.0.1")));
  c.kill();
  console.log("exit", await c.exited);
  await Bun.sleep(9000);
  console.log("after kill:", JSON.stringify(await ps("t2.sh")), JSON.stringify(await ps("-n 8 127.0.0.1")), "marker", existsSync(marker));
}

if (which === "volume") {
  const c = await spawnContained(`bun -e "const b=Buffer.alloc(1<<20,97); for(let i=0;i<64;i++){ if(!process.stdout.write(b)) await new Promise(r=>process.stdout.once('drain',r)); }"`);
  let n = 0;
  const t0 = performance.now();
  c.stderr.on("data", () => {});
  c.stdout.on("data", (d: Buffer) => (n += d.length));
  const ended = new Promise((r) => c.stdout.once("end", r));
  const code = await c.exited;
  await ended;
  console.log(JSON.stringify({ code, bytes: n, expected: 64 << 20, ms: Math.round(performance.now() - t0) }));
}

if (which === "crash") {
  // Parent (this process) dies abruptly while the contained tree runs: kill-on-close must end the tree.
  rmSync(marker, { force: true });
  writeFileSync(`${dir}/t2.sh`, `#!/bin/bash\nping -n 8 127.0.0.1 > /dev/null\necho done > '${marker}'\n`);
  const c = await spawnContained(`"${bash}" -c "./t2.sh; echo after"`, dir);
  c.stdout.on("data", () => {});
  await Bun.sleep(1500);
  console.log("tree up:\n" + (await ps("t2.sh")));
  process.exit(3); // no cleanup; the OS closes the job handle
}
