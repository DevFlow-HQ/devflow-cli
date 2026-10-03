// Spike (#338): contained spawn adapted from the #259 research prototype
// (origin/prototype/issue-259-windows-contained-spawn, stdio/contained-spawn.ts).
// Adds: explicit application name, custom UTF-16 environment block, MSVCRT argv
// quoting, cmd.exe shim escaping, job inspection, and several exit-wait routes.
import { dlopen, FFIType as T, JSCallback, ptr } from "bun:ffi";
import net from "node:net";

export const k32 = dlopen("kernel32.dll", {
  SetHandleInformation: { args: [T.u64, T.u32, T.u32], returns: T.i32 },
  CreateJobObjectW: { args: [T.ptr, T.ptr], returns: T.u64 },
  SetInformationJobObject: { args: [T.u64, T.i32, T.ptr, T.u32], returns: T.i32 },
  QueryInformationJobObject: { args: [T.u64, T.i32, T.ptr, T.u32, T.ptr], returns: T.i32 },
  InitializeProcThreadAttributeList: { args: [T.ptr, T.u32, T.u32, T.ptr], returns: T.i32 },
  UpdateProcThreadAttribute: { args: [T.ptr, T.u32, T.u64, T.ptr, T.u64, T.ptr, T.ptr], returns: T.i32 },
  DeleteProcThreadAttributeList: { args: [T.ptr], returns: T.void },
  CreateProcessW: {
    args: [T.ptr, T.ptr, T.ptr, T.ptr, T.i32, T.u32, T.ptr, T.ptr, T.ptr, T.ptr],
    returns: T.i32,
  },
  TerminateJobObject: { args: [T.u64, T.u32], returns: T.i32 },
  TerminateProcess: { args: [T.u64, T.u32], returns: T.i32 },
  OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.u64 },
  CloseHandle: { args: [T.u64], returns: T.i32 },
  WaitForSingleObject: { args: [T.u64, T.u32], returns: T.u32 },
  GetExitCodeProcess: { args: [T.u64, T.ptr], returns: T.i32 },
  IsProcessInJob: { args: [T.u64, T.u64, T.ptr], returns: T.i32 },
  GetLastError: { args: [], returns: T.u32 },
  CreateFileW: { args: [T.ptr, T.u32, T.u32, T.ptr, T.u32, T.u32, T.ptr], returns: T.u64 },
  RegisterWaitForSingleObject: { args: [T.ptr, T.u64, T.ptr, T.ptr, T.u32, T.u32], returns: T.i32 },
  UnregisterWaitEx: { args: [T.u64, T.u64], returns: T.i32 },
  CreateToolhelp32Snapshot: { args: [T.u32, T.u32], returns: T.u64 },
  Process32FirstW: { args: [T.u64, T.ptr], returns: T.i32 },
  Process32NextW: { args: [T.u64, T.ptr], returns: T.i32 },
  GetProcessTimes: { args: [T.u64, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
  GetSystemTimePreciseAsFileTime: { args: [T.ptr], returns: T.void },
}).symbols;

const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002n;
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000dn;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_NO_WINDOW = 0x08000000;
const STARTF_USESTDHANDLES = 0x100;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_WRITE_ATTRIBUTES = 0x100;
const OPEN_EXISTING = 3;
const INVALID_HANDLE = 0xffffffffffffffffn;
export const STILL_ACTIVE = 259;
export const INFINITE = 0xffffffff;
const PROCESS_TERMINATE = 0x1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x100000;
const WT_EXECUTEONLYONCE = 0x8;

export function fail(what: string): never {
  throw new Error(`${what} failed: Win32 error ${k32.GetLastError()}`);
}

export function wide(s: string): Uint16Array {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

/** MSVCRT / CommandLineToArgvW quoting for one argument. */
export function quoteArg(a: string): string {
  if (a.length > 0 && !/[ \t\n\v"]/.test(a)) return a;
  let r = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === "\\") bs++;
    else if (ch === '"') {
      r += "\\".repeat(bs * 2 + 1) + '"';
      bs = 0;
    } else {
      r += "\\".repeat(bs) + ch;
      bs = 0;
    }
  }
  return r + "\\".repeat(bs * 2) + '"';
}

export function commandLine(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

// cross-spawn's cmd.exe escaping (lib/util/escape.js), reproduced for comparison.
const metaChars = /([()\][%!^"`<>&|;, *?])/g;
function cmdEscapeCommand(s: string): string {
  return s.replace(metaChars, "^$1");
}
function cmdEscapeArgument(arg: string, doubleEscape: boolean): string {
  let a = `${arg}`;
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(metaChars, "^$1");
  if (doubleEscape) a = a.replace(metaChars, "^$1");
  return a;
}
/** `cmd.exe /d /s /c "<shim> args"` with cross-spawn's npm-shim double escaping. */
export function cmdShimCommandLine(cmdExe: string, shim: string, args: readonly string[]): string {
  const inner = [cmdEscapeCommand(shim), ...args.map((a) => cmdEscapeArgument(a, true))].join(" ");
  return `${quoteArg(cmdExe)} /d /s /c "${inner}"`;
}

/** Sorted (case-insensitive, uppercase ordinal) UTF-16 environment block. */
export function envBlock(env: Record<string, string>, sort = true): Uint16Array {
  let keys = Object.keys(env);
  if (sort) {
    keys = keys.sort((a, b) => {
      const A = a.toUpperCase();
      const B = b.toUpperCase();
      return A < B ? -1 : A > B ? 1 : 0;
    });
  }
  return entriesBlock(keys.map((k) => `${k}=${env[k]}`));
}
export function entriesBlock(entries: readonly string[]): Uint16Array {
  const s = entries.map((e) => e + "\0").join("") + "\0";
  const a = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

async function pipe(childReads: boolean): Promise<{ socket: net.Socket; child: bigint }> {
  const name = `\\\\.\\pipe\\secant-spike-${process.pid}-${crypto.randomUUID()}`;
  const server = net.createServer();
  await new Promise<void>((res, rej) => server.once("error", rej).listen(name, res));
  const accepted = new Promise<net.Socket>((res) => server.once("connection", res));
  const sa = new Uint8Array(24);
  new DataView(sa.buffer).setUint32(0, 24, true);
  new DataView(sa.buffer).setInt32(16, 1, true);
  const access = childReads ? GENERIC_READ | FILE_WRITE_ATTRIBUTES : GENERIC_WRITE | FILE_READ_ATTRIBUTES;
  const child = k32.CreateFileW(ptr(wide(name)), access, 0, ptr(sa), OPEN_EXISTING, 0, null) as bigint;
  if (child === INVALID_HANDLE) fail("CreateFileW(pipe)");
  const socket = await accepted;
  server.close();
  return { socket, child };
}

export type Contained = {
  pid: number;
  hProcess: bigint;
  job: bigint;
  stdin: net.Socket;
  stdout: net.Socket;
  stderr: net.Socket;
  inJob: () => boolean;
  jobPids: () => number[];
  terminateJob: (code: number) => boolean;
  closeJob: () => boolean;
};

export type SpawnOpts = {
  app?: string | null;
  commandLine: string;
  cwd?: string;
  envBlock?: Uint16Array;
  killOnClose?: boolean;
};

export class SpawnError extends Error {
  constructor(readonly win32: number) {
    super(`CreateProcessW failed: Win32 error ${win32}`);
  }
}

export async function spawnContained(o: SpawnOpts): Promise<Contained> {
  const job = k32.CreateJobObjectW(null, null) as bigint;
  if (!job) fail("CreateJobObjectW");
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, o.killOnClose === false ? 0 : JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (!k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(limits), 144)) fail("SetInformationJobObject");

  const i = await pipe(true);
  const out = await pipe(false);
  const e = await pipe(false);

  const size = new BigUint64Array(1);
  k32.InitializeProcThreadAttributeList(null, 2, 0, ptr(size));
  const attrs = new Uint8Array(Number(size[0]));
  if (!k32.InitializeProcThreadAttributeList(ptr(attrs), 2, 0, ptr(size))) fail("InitializeProcThreadAttributeList");
  const handles = new BigUint64Array([i.child, out.child, e.child]);
  if (!k32.UpdateProcThreadAttribute(ptr(attrs), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, ptr(handles), 24n, null, null))
    fail("UpdateProcThreadAttribute(HANDLE_LIST)");
  const jobs = new BigUint64Array([job]);
  if (!k32.UpdateProcThreadAttribute(ptr(attrs), 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, ptr(jobs), 8n, null, null))
    fail("UpdateProcThreadAttribute(JOB_LIST)");

  const si = new Uint8Array(112);
  const sv = new DataView(si.buffer);
  sv.setUint32(0, 112, true);
  sv.setUint32(60, STARTF_USESTDHANDLES, true);
  sv.setBigUint64(80, i.child, true);
  sv.setBigUint64(88, out.child, true);
  sv.setBigUint64(96, e.child, true);
  sv.setBigUint64(104, BigInt(ptr(attrs)), true);
  const pi = new Uint8Array(24);
  const cmd = wide(o.commandLine);
  const app = o.app ? wide(o.app) : null;
  const dir = o.cwd ? wide(o.cwd) : null;
  const env = o.envBlock ?? null;
  const ok = k32.CreateProcessW(
    app ? ptr(app) : null,
    ptr(cmd),
    null,
    null,
    1,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
    env ? ptr(env) : null,
    dir ? ptr(dir) : null,
    ptr(si),
    ptr(pi),
  );
  const err = k32.GetLastError();
  k32.DeleteProcThreadAttributeList(ptr(attrs));
  for (const h of [i.child, out.child, e.child]) k32.CloseHandle(h);
  if (!ok) {
    for (const s of [i.socket, out.socket, e.socket]) s.destroy();
    k32.CloseHandle(job);
    throw new SpawnError(err);
  }
  const pv = new DataView(pi.buffer);
  const hProcess = pv.getBigUint64(0, true);
  const hThread = pv.getBigUint64(8, true);
  const pid = pv.getUint32(16, true);
  k32.CloseHandle(hThread);

  return {
    pid,
    hProcess,
    job,
    stdin: i.socket,
    stdout: out.socket,
    stderr: e.socket,
    inJob: () => isInJob(hProcess, job),
    jobPids: () => jobPids(job),
    terminateJob: (code) => k32.TerminateJobObject(job, code) !== 0,
    closeJob: () => k32.CloseHandle(job) !== 0,
  };
}

export function isInJob(h: bigint, job: bigint): boolean {
  const r = new Int32Array(1);
  k32.IsProcessInJob(h, job, ptr(r));
  return r[0] !== 0;
}

export function jobPids(job: bigint): number[] {
  const buf = new Uint8Array(8 + 8 * 256);
  if (!k32.QueryInformationJobObject(job, JobObjectBasicProcessIdList, ptr(buf), buf.length, null)) fail("QueryInformationJobObject");
  const dv = new DataView(buf.buffer);
  const n = dv.getUint32(4, true);
  const pids: number[] = [];
  for (let k = 0; k < n; k++) pids.push(Number(dv.getBigUint64(8 + 8 * k, true)));
  return pids;
}

/** pid -> { name, ppid } from a Toolhelp snapshot. */
export function processTable(): Map<number, { name: string; ppid: number }> {
  const snap = k32.CreateToolhelp32Snapshot(2, 0) as bigint;
  const m = new Map<number, { name: string; ppid: number }>();
  if (snap === INVALID_HANDLE) return m;
  const pe = new Uint8Array(568);
  const dv = new DataView(pe.buffer);
  dv.setUint32(0, 568, true);
  let ok = k32.Process32FirstW(snap, ptr(pe));
  while (ok) {
    const pid = dv.getUint32(8, true);
    const ppid = dv.getUint32(32, true);
    let name = "";
    for (let o = 44; o < 564; o += 2) {
      const c = dv.getUint16(o, true);
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
    m.set(pid, { name, ppid });
    ok = k32.Process32NextW(snap, ptr(pe));
  }
  k32.CloseHandle(snap);
  return m;
}

export function describePids(pids: number[]): string[] {
  const t = processTable();
  return pids.map((p) => `${p}:${t.get(p)?.name ?? "?"}(ppid ${t.get(p)?.ppid ?? "?"})`);
}

export function openProcess(pid: number, terminate = false): bigint {
  return k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | (terminate ? PROCESS_TERMINATE : 0), 0, pid) as bigint;
}

export function exitCode(h: bigint): number {
  const c = new Uint32Array(1);
  k32.GetExitCodeProcess(h, ptr(c));
  return c[0]!;
}

export function isAlive(h: bigint): boolean {
  return k32.WaitForSingleObject(h, 0) !== 0;
}

export function fileTimeNow(): bigint {
  const b = new BigUint64Array(1);
  k32.GetSystemTimePreciseAsFileTime(ptr(b));
  return b[0]!;
}

export function exitFileTime(h: bigint): bigint {
  const c = new BigUint64Array(1);
  const e = new BigUint64Array(1);
  const k = new BigUint64Array(1);
  const u = new BigUint64Array(1);
  k32.GetProcessTimes(h, ptr(c), ptr(e), ptr(k), ptr(u));
  return e[0]!;
}

// ---- Exit-wait routes -------------------------------------------------------

/** (a) Poll WaitForSingleObject(h, 0) on a timer. */
export async function waitPoll(h: bigint, intervalMs: number): Promise<number> {
  while (k32.WaitForSingleObject(h, 0) !== 0) await Bun.sleep(intervalMs);
  return exitCode(h);
}

/** (b) RegisterWaitForSingleObject with a threadsafe JSCallback. The pending wait
 *  does not itself hold the event loop open, so a ref timer is kept until it fires. */
export function waitRegister(h: bigint): Promise<number> {
  return new Promise((resolve, reject) => {
    const hWait = new BigUint64Array(1);
    const keepAlive = setInterval(() => {}, 1 << 30);
    const cb = new JSCallback(
      () => {
        k32.UnregisterWaitEx(hWait[0]!, 0n); // non-blocking: we may be inside the callback's dispatch
        clearInterval(keepAlive);
        setTimeout(() => cb.close(), 1000); // never free the trampoline while a pool thread may still be in it
        resolve(exitCode(h));
      },
      { args: [T.ptr, T.u8], returns: T.void, threadsafe: true },
    );
    if (!k32.RegisterWaitForSingleObject(ptr(hWait), h, cb.ptr, null, INFINITE, WT_EXECUTEONLYONCE)) {
      clearInterval(keepAlive);
      cb.close();
      reject(new Error(`RegisterWaitForSingleObject failed: ${k32.GetLastError()}`));
    }
  });
}

/** (c) A Worker blocks in WaitForSingleObject(h, INFINITE) and posts back. */
const workerSource = `
import { dlopen, FFIType } from "bun:ffi";
const k = dlopen("kernel32.dll", { WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 } }).symbols;
self.onmessage = (e) => { const r = k.WaitForSingleObject(BigInt(e.data), 0xffffffff); postMessage(r); };
`;
let workerUrl: string | undefined;
export function waitWorker(h: bigint): Promise<number> {
  workerUrl ??= URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }));
  return new Promise((resolve, reject) => {
    const w = new Worker(workerUrl!);
    w.onmessage = (ev) => {
      w.terminate();
      if (ev.data !== 0) reject(new Error(`worker wait returned ${ev.data}`));
      else resolve(exitCode(h));
    };
    w.onerror = (ev) => {
      w.terminate();
      reject(new Error(`worker error: ${(ev as ErrorEvent).message}`));
    };
    w.postMessage(h.toString());
  });
}

export type Waiter = (h: bigint) => Promise<number>;
export const WAITERS: Record<string, Waiter> = {
  poll20: (h) => waitPoll(h, 20),
  poll5: (h) => waitPoll(h, 5),
  register: waitRegister,
  worker: waitWorker,
};

// ---- Helpers ----------------------------------------------------------------

export function tickMonitor(periodMs = 10): () => { ticks: number; maxGapMs: number; p50: number; p99: number } {
  const gaps: number[] = [];
  let last = performance.now();
  const t = setInterval(() => {
    const n = performance.now();
    gaps.push(n - last);
    last = n;
  }, periodMs);
  return () => {
    clearInterval(t);
    const s = [...gaps].sort((a, b) => a - b);
    const q = (p: number) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
    return { ticks: gaps.length, maxGapMs: +(s[s.length - 1] ?? 0).toFixed(1), p50: q(0.5), p99: q(0.99) };
  };
}

export function collect(s: net.Socket): { text: () => string; ended: Promise<number> } {
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (d: string) => (buf += d));
  const ended = new Promise<number>((res) => {
    s.once("end", () => res(performance.now()));
    s.once("close", () => res(performance.now()));
    s.once("error", () => res(performance.now()));
  });
  return { text: () => buf, ended };
}

export function withTimeout<V>(p: Promise<V>, ms: number, what: string): Promise<V> {
  return Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timeout: ${what} after ${ms}ms`)))]);
}
