// Prototype: spawn a child inside a kill-on-close, no-breakaway Job Object from
// its first instruction, and hand Secant ordinary streams for its stdio.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import net from "node:net";
import { Readable, Writable } from "node:stream";

const k32 = dlopen("kernel32.dll", {
  CreatePipe: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  SetInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  InitializeProcThreadAttributeList: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  UpdateProcThreadAttribute: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
  CreateProcessW: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  CreateFileW: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.u64,
  },
}).symbols;


const HANDLE_FLAG_INHERIT = 1;
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002n;
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000dn;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_NO_WINDOW = 0x08000000;
const STARTF_USESTDHANDLES = 0x100;
const O_RDONLY = 0, O_WRONLY = 1, O_BINARY = 0x8000;

function fail(what: string): never {
  throw new Error(`${what} failed: Win32 error ${k32.GetLastError()}`);
}

const GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
const FILE_READ_ATTRIBUTES = 0x80, FILE_WRITE_ATTRIBUTES = 0x100;
const OPEN_EXISTING = 3;

/** A libuv-owned named-pipe server end (a net.Socket, fully async) and an inheritable client end for the child. */
async function pipe(childReads: boolean): Promise<{ socket: net.Socket; child: bigint }> {
  const name = `\\\\.\\pipe\\secant-${process.pid}-${crypto.randomUUID()}`;
  const server = net.createServer();
  await new Promise<void>((res, rej) => server.once("error", rej).listen(name, res));
  const accepted = new Promise<net.Socket>((res) => server.once("connection", res));
  const sa = new Uint8Array(24);
  new DataView(sa.buffer).setUint32(0, 24, true);
  new DataView(sa.buffer).setInt32(16, 1, true); // bInheritHandle
  const access = childReads ? GENERIC_READ | FILE_WRITE_ATTRIBUTES : GENERIC_WRITE | FILE_READ_ATTRIBUTES;
  const child = k32.CreateFileW(ptr(wide(name)), access, 0, ptr(sa), OPEN_EXISTING, 0, null);
  if (child === 0xffffffffffffffffn) fail("CreateFileW(pipe)");
  const socket = await accepted;
  server.close(); // one client per pipe; no one else can connect afterwards
  return { socket, child };
}

function wide(s: string): Uint16Array {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

export type ContainedChild = {
  pid: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number>;
  inJob: () => boolean;
  /** Kill the whole tree: every process ever created inside the job. */
  kill: () => void;
};

export async function spawnContained(commandLine: string, cwd?: string): Promise<ContainedChild> {
  const job = k32.CreateJobObjectW(null, null);
  if (!job) fail("CreateJobObjectW");
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true); // no breakaway flags
  if (!k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(limits), 144)) fail("SetInformationJobObject");

  const i = await pipe(true), o = await pipe(false), e = await pipe(false);

  // Attribute list: inherit exactly the three child pipe ends, and create in the job.
  const size = new BigUint64Array(1);
  k32.InitializeProcThreadAttributeList(null, 2, 0, ptr(size));
  const attrs = new Uint8Array(Number(size[0]));
  if (!k32.InitializeProcThreadAttributeList(ptr(attrs), 2, 0, ptr(size))) fail("InitializeProcThreadAttributeList");
  const handles = new BigUint64Array([i.child, o.child, e.child]);
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
  sv.setBigUint64(88, o.child, true);
  sv.setBigUint64(96, e.child, true);
  sv.setBigUint64(104, BigInt(ptr(attrs)), true);
  const pi = new Uint8Array(24);
  const cmd = wide(commandLine);
  const dir = cwd ? wide(cwd) : null;
  const ok = k32.CreateProcessW(
    null, ptr(cmd), null, null, 1,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
    null, dir ? ptr(dir) : null, ptr(si), ptr(pi),
  );
  const err = k32.GetLastError();
  k32.DeleteProcThreadAttributeList(ptr(attrs));
  for (const h of [i.child, o.child, e.child]) k32.CloseHandle(h);
  if (!ok) throw new Error(`CreateProcessW failed: Win32 error ${err}`);
  const pv = new DataView(pi.buffer);
  const hProcess = pv.getBigUint64(0, true), hThread = pv.getBigUint64(8, true);
  const pid = pv.getUint32(16, true);
  k32.CloseHandle(hThread);

  const exited = (async () => {
    // Poll without blocking the event loop; a production version would use a
    // wait thread or RegisterWaitForSingleObject.
    while (k32.WaitForSingleObject(hProcess, 0) !== 0) await Bun.sleep(20);
    const code = new Uint32Array(1);
    k32.GetExitCodeProcess(hProcess, ptr(code));
    return code[0];
  })();

  return {
    pid,
    stdin: i.socket,
    stdout: o.socket,
    stderr: e.socket,
    exited,
    inJob: () => {
      const r = new Int32Array(1);
      k32.IsProcessInJob(hProcess, job, ptr(r));
      return r[0] !== 0;
    },
    kill: () => {
      k32.TerminateJobObject(job, 1);
    },
  };
}
