// Spike (#338) driver. Every check prints `RESULT <id> PASS|FAIL|INFO <json>`.
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Contained,
  WAITERS,
  SpawnError,
  cmdShimCommandLine,
  collect,
  commandLine,
  describePids,
  entriesBlock,
  envBlock,
  exitCode,
  exitFileTime,
  fileTimeNow,
  isAlive,
  isInJob,
  k32,
  openProcess,
  quoteArg,
  spawnContained,
  tickMonitor,
  waitPoll,
  withTimeout,
} from "./contained";

const args = process.argv.slice(2);
const mode = args[0];
const compiled = !/bun(\.exe)?$/i.test(process.execPath);
const CMD = "C:\\Windows\\System32\\cmd.exe";
const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
let failures = 0;

function result(id: string, verdict: "PASS" | "FAIL" | "INFO", data: unknown): void {
  if (verdict === "FAIL") failures++;
  console.log(`RESULT ${id} ${verdict} ${JSON.stringify(data)}`);
}

/** argv to run this program again in another mode (compiled exe or `bun main.ts`). */
function self(...rest: (string | number)[]): string[] {
  const r = rest.map(String);
  return compiled ? [process.execPath, ...r] : [process.execPath, Bun.main, ...r];
}

function nodeExe(): string {
  const n = Bun.which("node");
  if (!n) throw new Error("node not on PATH");
  return n;
}

const SHIM_JS = (shim: string) => {
  // Same npm cmd-shim parse as src/process/process.ts parseNpmCmdShim.
  const text = readFileSync(shim, "utf8");
  const inv = text.split(/\r?\n/).find((l) => l.includes("%_prog%"))!;
  const quoted = [...inv.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const tok = quoted.find((t) => /%dp0%/i.test(t) && /\.[cm]?js$/i.test(t))!;
  const rel = tok.replace(/^%dp0%/i, "").split(/[\\/]+/).filter(Boolean);
  const interp = [...text.matchAll(/SET\s+"?_prog=([^"\r\n]+)"?/gi)]
    .map((m) => m[1]!.replace(/"$/, "").trim())
    .find((v) => v.length > 0 && !/%dp0%/i.test(v))!;
  return { interpreter: interp, script: join(dirname(shim), ...rel) };
};

async function runToEnd(c: Contained, input?: string, timeoutMs = 20000) {
  const o = collect(c.stdout);
  const e = collect(c.stderr);
  c.stderr.resume();
  if (input !== undefined) c.stdin.end(input);
  else c.stdin.end();
  const code = await withTimeout(waitPoll(c.hProcess, 10), timeoutMs, "child exit");
  await withTimeout(Promise.all([o.ended, e.ended]), 5000, "stdio end").catch(() => {});
  return { code, out: o.text(), err: e.text() };
}

// ---------------------------------------------------------------- child modes
async function childModes(): Promise<boolean> {
  switch (mode) {
    case "echo-child": {
      process.stderr.write("err-line\n");
      process.stdout.write(JSON.stringify({ pid: process.pid, argv: process.argv }) + "\n");
      for await (const c of process.stdin) process.stdout.write("echo:" + c);
      process.exit(Number(args[1] ?? 0));
    }
    case "argv-child":
      process.stdout.write(JSON.stringify({ pid: process.pid, argv: args.slice(1) }) + "\n");
      process.exit(0);
    case "sleep-child":
      await Bun.sleep(Number(args[1]));
      process.exit(Number(args[2] ?? 0));
    case "hold-child": {
      // Leave a grandchild holding our stdout for 4 s, then exit at once.
      nodeSpawn(self("sleep-child", 4000, 0)[0]!, self("sleep-child", 4000, 0).slice(1), {
        stdio: ["ignore", "inherit", "inherit"],
      });
      process.stdout.write("hold-child up\n");
      await Bun.sleep(200);
      process.exit(3);
    }
  }
  return false;
}

// ---------------------------------------------------------------- T1 compiled round trip
async function t1(): Promise<void> {
  const argv = self("echo-child", 7);
  const c = await spawnContained({ app: argv[0], commandLine: commandLine(argv) });
  const inJob = c.inJob();
  const o = collect(c.stdout);
  const e = collect(c.stderr);
  const mon = tickMonitor();
  c.stdin.write("one\n");
  await Bun.sleep(300);
  c.stdin.write("two é日本\n");
  c.stdin.end();
  const code = await withTimeout(waitPoll(c.hProcess, 10), 15000, "t1 exit");
  await withTimeout(Promise.all([o.ended, e.ended]), 3000, "t1 eof").catch(() => {});
  const ticks = mon();
  const out = o.text();
  const pass =
    inJob && out.includes("echo:one\n") && out.includes("echo:two é日本\n") && e.text().includes("err-line") && code === 7;
  result(`t1.${compiled ? "compiled" : "bun-script"}`, pass ? "PASS" : "FAIL", {
    compiled,
    execPath: process.execPath,
    bun: Bun.version,
    pid: c.pid,
    inJob,
    code,
    out,
    err: e.text(),
    ticks,
  });
}

// ---------------------------------------------------------------- T5 exit wait
async function t5(which: string): Promise<void> {
  const wait = WAITERS[which];
  if (!wait) throw new Error(`unknown waiter ${which}`);
  const scenarios: { name: string; argv: string[]; act?: (c: Contained) => void; expect?: number }[] = [
    { name: "normal", argv: self("sleep-child", 1500, 5), expect: 5 },
    {
      name: "crash",
      argv: self("sleep-child", 60000, 0),
      act: (c) => {
        const h = openProcess(c.pid, true);
        k32.TerminateProcess(h, 0xdead);
        k32.CloseHandle(h);
      },
      expect: 0xdead,
    },
    { name: "terminate-job", argv: self("sleep-child", 60000, 0), act: (c) => c.terminateJob(0x77), expect: 0x77 },
    { name: "close-job", argv: self("sleep-child", 60000, 0), act: (c) => c.closeJob() },
  ];
  for (const s of scenarios) {
    try {
      const c = await spawnContained({ app: s.argv[0], commandLine: commandLine(s.argv) });
      c.stdout.resume();
      c.stderr.resume();
      c.stdin.end();
      const mon = tickMonitor();
      const t0 = performance.now();
      const p = wait(c.hProcess);
      if (s.act) setTimeout(() => s.act!(c), 500);
      const code = await withTimeout(p, 15000, `${which}/${s.name}`);
      const detect = fileTimeNow();
      const exitAt = exitFileTime(c.hProcess);
      const latencyMs = Number(detect - exitAt) / 10000;
      const ticks = mon();
      const ok = (s.expect === undefined || code === s.expect) && ticks.maxGapMs < 100;
      result(`t5.${which}.${s.name}`, ok ? "PASS" : "FAIL", {
        compiled,
        code,
        expect: s.expect,
        latencyMs: +latencyMs.toFixed(2),
        elapsedMs: Math.round(performance.now() - t0),
        ticks,
      });
      k32.CloseHandle(c.hProcess);
      if (s.name !== "close-job") c.closeJob();
    } catch (err) {
      result(`t5.${which}.${s.name}`, "FAIL", { compiled, error: String(err) });
    }
  }
}

/** Pipe EOF is not process exit: a grandchild that inherited stdout delays EOF. */
async function t5eof(): Promise<void> {
  const argv = self("hold-child");
  const c = await spawnContained({ app: argv[0], commandLine: commandLine(argv) });
  const o = collect(c.stdout);
  c.stderr.resume();
  c.stdin.end();
  const t0 = performance.now();
  await waitPoll(c.hProcess, 5);
  const exitMs = performance.now() - t0;
  const code = exitCode(c.hProcess);
  const eofAt = await withTimeout(o.ended, 15000, "eof");
  const eofMs = eofAt - t0;
  result("t5.eof", "INFO", {
    compiled,
    code,
    exitDetectedMs: Math.round(exitMs),
    stdoutEofMs: Math.round(eofMs),
    eofLagMs: Math.round(eofMs - exitMs),
    note: "EOF lag ~4000ms means pipe EOF cannot stand in for exit",
  });
  c.closeJob();
}

// ---------------------------------------------------------------- T2 shim resolution
async function t2(shim: string): Promise<void> {
  const node = nodeExe();
  const { interpreter, script } = SHIM_JS(shim);
  result("t2.parse", "INFO", { shim, interpreter, script, nodeResolved: node, shimText: readFileSync(shim, "utf8") });
  const simple = ["a b", "c"];
  const routes: Record<string, { app: string; line: string }> = {
    "cmd-route": { app: CMD, line: cmdShimCommandLine(CMD, shim, ["echo", ...simple]) },
    "node-direct": { app: node, line: commandLine([node, script, "echo", ...simple]) },
  };
  for (const [name, r] of Object.entries(routes)) {
    try {
      const c = await spawnContained({ app: r.app, commandLine: r.line });
      const o = collect(c.stdout);
      const e = collect(c.stderr);
      // wait for the node child to report its pid, then inspect the job
      let first = "";
      for (let k = 0; k < 200 && !first.includes("\n"); k++) {
        await Bun.sleep(20);
        first = o.text();
      }
      const nodePid = JSON.parse(first.split("\n")[0]!).pid as number;
      const hn = openProcess(nodePid);
      const nodeInJob = isInJob(hn, c.job);
      const members = describePids(c.jobPids());
      c.stdin.write("one\n");
      await Bun.sleep(200);
      c.stdin.end("two\n");
      const code = await withTimeout(waitPoll(c.hProcess, 10), 15000, "t2 exit");
      await withTimeout(Promise.all([o.ended, e.ended]), 3000, "eof").catch(() => {});
      const out = o.text();
      const ok = nodeInJob && out.includes("echo:one\n") && out.includes("echo:two\n") && e.text().includes("err-line") && code === 42;
      result(`t2.${name}`, ok ? "PASS" : "FAIL", {
        commandLine: r.line,
        directPid: c.pid,
        nodePid,
        nodeInJob,
        jobMembers: members,
        code,
        out,
        err: e.text(),
      });
      k32.CloseHandle(hn);
      c.closeJob();
    } catch (err) {
      result(`t2.${name}`, "FAIL", { error: String(err) });
    }
  }
  // Interrupt/exit relevance of the extra cmd.exe: kill only the direct child.
  try {
    const c = await spawnContained({ app: CMD, commandLine: cmdShimCommandLine(CMD, shim, ["hang"]) });
    const o = collect(c.stdout);
    c.stderr.resume();
    let first = "";
    for (let k = 0; k < 200 && !first.includes("\n"); k++) {
      await Bun.sleep(20);
      first = o.text();
    }
    const nodePid = JSON.parse(first.split("\n")[0]!).pid as number;
    const hn = openProcess(nodePid);
    const hc = openProcess(c.pid, true);
    k32.TerminateProcess(hc, 9);
    await Bun.sleep(1000);
    const cmdDead = !isAlive(hc);
    const nodeAlive = isAlive(hn);
    let eof = false;
    o.ended.then(() => (eof = true));
    await Bun.sleep(200);
    const membersAfter = describePids(c.jobPids());
    c.closeJob();
    await Bun.sleep(500);
    result("t2.cmd-route.kill-direct-child", "INFO", {
      cmdDead,
      nodeAliveAfterCmdKilled: nodeAlive,
      stdoutEofAfterCmdKilled: eof,
      jobMembersAfterCmdKilled: membersAfter,
      nodeAliveAfterJobClose: isAlive(hn),
    });
  } catch (err) {
    result("t2.cmd-route.kill-direct-child", "FAIL", { error: String(err) });
  }
}

// ---------------------------------------------------------------- T3 quoting
const ARGS = [
  "plain",
  "with space",
  'embedded "quote"',
  "trailing\\",
  "trail space\\ ",
  "",
  "C:\\path with\\",
  "%PATH%",
  "%SPIKE_PARENT_ONLY%",
  "^&|<>",
  "a&b",
  "x|y",
  "<in>",
  "(paren)",
  "!bang!",
  "semi;colon,comma",
  "é",
  "日本",
  "🙂",
  '\\\\server\\"q',
  "tab\there",
  '"',
  '\\"',
  '""',
  "a\\\\b",
  "*?",
  "-flag=a b",
];

function compareArgv(got: unknown): { exact: boolean; mismatches: unknown[] } {
  const g = Array.isArray(got) ? (got as string[]) : [];
  const mismatches: unknown[] = [];
  for (let k = 0; k < Math.max(ARGS.length, g.length); k++) {
    if (ARGS[k] !== g[k]) mismatches.push({ k, want: ARGS[k], got: g[k] });
  }
  return { exact: mismatches.length === 0, mismatches };
}

function parseArgvOut(out: string): unknown {
  const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
  if (!line) return undefined;
  try {
    return JSON.parse(line).argv;
  } catch {
    return undefined;
  }
}

async function t3(shim: string): Promise<void> {
  const node = nodeExe();
  const { script } = SHIM_JS(shim);
  const contained: Record<string, { app: string; line: string; strict: boolean }> = {
    "ours.direct-node": { app: node, line: commandLine([node, script, "argv", ...ARGS]), strict: true },
    "ours.direct-bun-exe": { app: self()[0]!, line: commandLine([...self("argv-child"), ...ARGS]), strict: true },
    "ours.cmd-shim": { app: CMD, line: cmdShimCommandLine(CMD, shim, ["argv", ...ARGS]), strict: false },
  };
  for (const [name, r] of Object.entries(contained)) {
    try {
      const c = await spawnContained({ app: r.app, commandLine: r.line });
      const { code, out, err } = await runToEnd(c);
      const cmp = compareArgv(parseArgvOut(out));
      result(`t3.${name}`, cmp.exact ? "PASS" : r.strict ? "FAIL" : "INFO", {
        code,
        exact: cmp.exact,
        mismatches: cmp.mismatches,
        commandLine: r.line,
        err: err.slice(0, 500),
        rawOut: cmp.exact ? undefined : out.slice(0, 2000),
      });
      c.closeJob();
    } catch (err) {
      result(`t3.${name}`, "FAIL", { error: String(err) });
    }
  }
  const cmp = (name: string, run: () => { out: string; err?: string; error?: unknown; code?: number | null }) => {
    try {
      const r = run();
      const c = compareArgv(parseArgvOut(r.out));
      result(`t3.${name}`, "INFO", {
        exact: c.exact,
        mismatches: c.mismatches,
        code: r.code,
        error: r.error ? String(r.error) : undefined,
        err: r.err?.slice(0, 300),
      });
    } catch (error) {
      result(`t3.${name}`, "INFO", { threw: String(error) });
    }
  };
  cmp("node-spawnSync.node", () => {
    const r = nodeSpawnSync(node, [script, "argv", ...ARGS], { encoding: "utf8" });
    return { out: r.stdout ?? "", err: r.stderr, error: r.error, code: r.status };
  });
  cmp("bun-spawnSync.node", () => {
    const r = Bun.spawnSync([node, script, "argv", ...ARGS]);
    return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
  });
  cmp("bun-spawnSync.shim", () => {
    const r = Bun.spawnSync([shim, "argv", ...ARGS]);
    return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
  });
  cmp("node-spawnSync.shim-noshell", () => {
    const r = nodeSpawnSync(shim, ["argv", ...ARGS], { encoding: "utf8" });
    return { out: r.stdout ?? "", err: r.stderr, error: r.error, code: r.status };
  });
  cmp("node-spawnSync.shim-shell", () => {
    const r = nodeSpawnSync(quoteArg(shim), ["argv", ...ARGS], { encoding: "utf8", shell: true });
    return { out: r.stdout ?? "", err: r.stderr, error: r.error, code: r.status };
  });
}

// ---------------------------------------------------------------- T4 environment block
async function t4(shim: string, scratch: string): Promise<void> {
  const node = nodeExe();
  const { script } = SHIM_JS(shim);
  const shimDir = dirname(shim);
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.toUpperCase() === "PATH" || k === "SPIKE_PARENT_ONLY") continue;
    base[k] = v;
  }
  base.SPIKE_UNI = "é日本🙂 x=y";
  const pathWithNode = [dirname(node), shimDir, "C:\\Windows\\System32"].join(";");
  const pathNoNode = [shimDir, "C:\\Windows\\System32"].join(";");

  const envOf = async (line: string, app: string | null, block: Uint16Array) => {
    const c = await spawnContained({ app, commandLine: line, envBlock: block });
    const r = await runToEnd(c);
    c.closeJob();
    const l = r.out.split(/\r?\n/).find((x) => x.startsWith("{"));
    return { ...r, env: l ? (JSON.parse(l).env as Record<string, string>) : undefined };
  };
  const diff = (want: Record<string, string>, got: Record<string, string> | undefined) => {
    if (!got) return { missing: ["<no output>"], extra: [], changed: [] };
    const gotUpper = new Map(Object.entries(got).map(([k, v]) => [k.toUpperCase(), { k, v }]));
    const missing: string[] = [];
    const changed: unknown[] = [];
    for (const [k, v] of Object.entries(want)) {
      const g = gotUpper.get(k.toUpperCase());
      if (!g) missing.push(k);
      else if (g.v !== v) changed.push({ k, want: v, got: g.v });
    }
    const wantUpper = new Set(Object.keys(want).map((k) => k.toUpperCase()));
    const extra = Object.keys(got).filter((k) => !wantUpper.has(k.toUpperCase()));
    return { missing, extra, changed };
  };

  const want = { ...base, PATH: pathWithNode };
  for (const sorted of [true, false]) {
    try {
      const block = sorted ? envBlock(want) : entriesBlock(Object.entries(want).map(([k, v]) => `${k}=${v}`).reverse());
      const r = await envOf(commandLine([node, script, "env"]), node, block);
      const d = diff(want, r.env);
      const ok =
        r.code === 0 && d.missing.length === 0 && d.changed.length === 0 && r.env?.SPIKE_UNI === base.SPIKE_UNI && !("SPIKE_PARENT_ONLY" in (r.env ?? {}));
      result(`t4.direct-node.${sorted ? "sorted" : "unsorted-reversed"}`, ok ? "PASS" : sorted ? "FAIL" : "INFO", {
        code: r.code,
        spikeUni: r.env?.SPIKE_UNI,
        parentOnlyPresent: r.env ? "SPIKE_PARENT_ONLY" in r.env : null,
        childPath: r.env?.PATH ?? r.env?.Path,
        diff: d,
        err: r.err.slice(0, 300),
      });
    } catch (err) {
      result(`t4.direct-node.${sorted ? "sorted" : "unsorted"}`, "FAIL", { error: String(err) });
    }
  }
  // Shim route resolves `node` through the custom PATH (cmd.exe reads the block).
  for (const [label, p] of [["with-node", pathWithNode], ["without-node", pathNoNode]] as const) {
    try {
      const w = { ...base, PATH: p };
      const r = await envOf(cmdShimCommandLine(CMD, shim, ["env"]), CMD, envBlock(w));
      const ok = label === "with-node" ? r.code === 0 && r.env?.SPIKE_UNI === base.SPIKE_UNI : r.code !== 0 && !r.env;
      result(`t4.cmd-shim.${label}`, ok ? "PASS" : "FAIL", {
        code: r.code,
        spikeUni: r.env?.SPIKE_UNI,
        childPath: r.env?.PATH ?? r.env?.Path,
        parentOnlyPresent: r.env ? "SPIKE_PARENT_ONLY" in r.env : null,
        err: r.err.slice(0, 300),
      });
    } catch (err) {
      result(`t4.cmd-shim.${label}`, "FAIL", { error: String(err) });
    }
  }
  // CreateProcessW(lpApplicationName = NULL) searches the PARENT's PATH, not the block's.
  try {
    const only = join(scratch, "only-on-custom-path");
    mkdirSync(only, { recursive: true });
    copyFileSync(self()[0]!, join(only, "spikeonly.exe"));
    const w = { ...base, PATH: [only, "C:\\Windows\\System32"].join(";") };
    let outcome: unknown;
    try {
      const c = await spawnContained({ app: null, commandLine: compiled ? "spikeonly argv-child x" : `spikeonly ${quoteArg(Bun.main)} argv-child x`, envBlock: envBlock(w) });
      const r = await runToEnd(c);
      c.closeJob();
      outcome = { spawned: true, code: r.code, out: r.out.slice(0, 200) };
    } catch (err) {
      outcome = { spawned: false, win32: err instanceof SpawnError ? err.win32 : String(err) };
    }
    result("t4.search-uses-parent-path", "INFO", { customPathOnlyExe: outcome });
    rmSync(only, { recursive: true, force: true });
  } catch (err) {
    result("t4.search-uses-parent-path", "FAIL", { error: String(err) });
  }
  // Duplicate PATH spellings in one block.
  try {
    const entries = Object.entries(base).map(([k, v]) => `${k}=${v}`);
    entries.push(`Path=${pathNoNode}`, `PATH=${pathWithNode}`);
    const r = await envOf(commandLine([node, script, "env"]), node, entriesBlock(entries));
    result("t4.duplicate-path-case", "INFO", {
      code: r.code,
      keys: Object.keys(r.env ?? {}).filter((k) => k.toUpperCase() === "PATH"),
      nodeSeesPath: r.env?.PATH,
    });
  } catch (err) {
    result("t4.duplicate-path-case", "FAIL", { error: String(err) });
  }
}

// ---------------------------------------------------------------- T6 Git Bash escape + parent crash
async function bashTree(): Promise<{ c: Contained; members: string[]; handles: { pid: number; h: bigint }[] }> {
  const line = `${quoteArg(BASH)} -c "sleep 300 >/dev/null 2>&1 </dev/null & sleep 301 & echo started"`;
  const c = await spawnContained({ app: BASH, commandLine: line });
  const o = collect(c.stdout);
  c.stderr.resume();
  for (let k = 0; k < 250 && !o.text().includes("started"); k++) await Bun.sleep(20);
  // bash returns after backgrounding; wait for it to exit so the sleeps are orphans.
  await withTimeout(waitPoll(c.hProcess, 20), 10000, "bash exit").catch(() => {});
  await Bun.sleep(500);
  const pids = c.jobPids();
  const members = describePids(pids);
  const handles = pids.map((pid) => ({ pid, h: openProcess(pid) })).filter((x) => x.h !== 0n);
  return { c, members, handles };
}

async function t6escape(): Promise<void> {
  const { c, members, handles } = await bashTree();
  const bashExited = !isAlive(c.hProcess);
  const sleeps = members.filter((m) => /sleep\.exe/i.test(m));
  c.closeJob();
  const t0 = performance.now();
  while (handles.some((x) => isAlive(x.h)) && performance.now() - t0 < 5000) await Bun.sleep(20);
  const survivors = handles.filter((x) => isAlive(x.h)).map((x) => x.pid);
  const ok = bashExited && sleeps.length >= 2 && survivors.length === 0;
  result(`t6.escape.${compiled ? "compiled" : "bun-script"}`, ok ? "PASS" : "FAIL", {
    bashExitedBeforeClose: bashExited,
    jobMembersBeforeClose: members,
    killedWithinMs: Math.round(performance.now() - t0),
    exitCodes: handles.map((x) => `${x.pid}:${exitCode(x.h)}`),
    survivors,
  });
}

async function t6crashParent(readyFile: string): Promise<void> {
  const { members, handles } = await bashTree();
  writeFileSync(readyFile, JSON.stringify({ parentPid: process.pid, members, pids: handles.map((x) => x.pid) }));
  await Bun.sleep(600000);
}

async function t6crash(scratch: string): Promise<void> {
  const ready = join(scratch, "crash-ready.json");
  rmSync(ready, { force: true });
  const argv = self("t6-crash-parent", ready);
  const p = nodeSpawn(argv[0]!, argv.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
  for (let k = 0; k < 500 && !existsSync(ready); k++) await Bun.sleep(20);
  if (!existsSync(ready)) return result("t6.crash", "FAIL", { error: "crash parent never became ready" });
  await Bun.sleep(100);
  const info = JSON.parse(readFileSync(ready, "utf8")) as { parentPid: number; members: string[]; pids: number[] };
  const handles = info.pids.map((pid) => ({ pid, h: openProcess(pid) })).filter((x) => x.h !== 0n);
  const aliveBefore = handles.filter((x) => isAlive(x.h)).map((x) => x.pid);
  // Kill only the parent (no /T): the OS closes its job handle.
  const tk = nodeSpawnSync("taskkill", ["/F", "/PID", String(p.pid)], { encoding: "utf8" });
  const t0 = performance.now();
  while (handles.some((x) => isAlive(x.h)) && performance.now() - t0 < 5000) await Bun.sleep(20);
  const survivors = handles.filter((x) => isAlive(x.h)).map((x) => x.pid);
  const ok = info.members.some((m) => /sleep\.exe/i.test(m)) && aliveBefore.length > 0 && survivors.length === 0;
  result(`t6.crash.${compiled ? "compiled" : "bun-script"}`, ok ? "PASS" : "FAIL", {
    parentPid: info.parentPid,
    jobMembers: info.members,
    aliveBeforeKill: aliveBefore,
    taskkill: tk.stdout.trim(),
    treeGoneWithinMs: Math.round(performance.now() - t0),
    survivors,
  });
}

// ---------------------------------------------------------------- dispatch
if (!(await childModes())) {
  try {
    switch (mode) {
      case "t1":
        await t1();
        break;
      case "t5":
        await t5(args[1]!);
        break;
      case "t5-eof":
        await t5eof();
        break;
      case "t2":
        await t2(args[1]!);
        break;
      case "t3":
        await t3(args[1]!);
        break;
      case "t4":
        await t4(args[1]!, args[2]!);
        break;
      case "t6-escape":
        await t6escape();
        break;
      case "t6-crash-parent":
        await t6crashParent(args[1]!);
        break;
      case "t6-crash":
        await t6crash(args[1]!);
        break;
      default:
        throw new Error(`unknown mode ${mode}`);
    }
  } catch (err) {
    result(`${mode}.harness`, "FAIL", { error: String(err), stack: (err as Error).stack });
  }
  process.exit(failures ? 1 : 0);
}
