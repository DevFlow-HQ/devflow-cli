import { dlopen, FFIType as T, ptr } from "bun:ffi";

// Inspection only. Runtime cases cross Process's public Interface; these native
// probes independently observe OS membership and death, never production internals.
function load() {
  return dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: T.u64 },
    IsProcessInJob: { args: [T.u64, T.u64, T.ptr], returns: T.i32 },
    CreateProcessW: {
      args: [
        T.ptr,
        T.ptr,
        T.ptr,
        T.ptr,
        T.i32,
        T.u32,
        T.ptr,
        T.ptr,
        T.ptr,
        T.ptr,
      ],
      returns: T.i32,
    },
    GetLastError: { args: [], returns: T.u32 },
    OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.u64 },
    WaitForSingleObject: { args: [T.u64, T.u32], returns: T.u32 },
    TerminateProcess: { args: [T.u64, T.u32], returns: T.i32 },
    CloseHandle: { args: [T.u64], returns: T.i32 },
  }).symbols;
}
let kernel: ReturnType<typeof load> | undefined;
function native() {
  kernel ??= load();
  return kernel;
}
function wide(value: string): Uint16Array {
  const result = new Uint16Array(value.length + 1);
  for (let i = 0; i < value.length; i++) result[i] = value.charCodeAt(i);
  return result;
}

/** First child action: membership and a denied breakaway, before any handshake.
 * Libuv's fallback job permits breakaway; membership alone would not distinguish
 * it from the no-breakaway job Process must attach at creation. */
export function initialMembership(): {
  inJob: boolean;
  breakawayDenied: boolean;
} {
  const k = native();
  const member = new Int32Array(1);
  if (!k.IsProcessInJob(k.GetCurrentProcess(), 0n, ptr(member)))
    throw new Error("IsProcessInJob failed");
  const startup = new Uint8Array(104);
  new DataView(startup.buffer).setUint32(0, 104, true);
  const info = new Uint8Array(24);
  const application = wide(process.execPath);
  const command = wide(`"${process.execPath}" -e "process.exit(0)"`);
  const started = k.CreateProcessW(
    ptr(application),
    ptr(command),
    null,
    null,
    0,
    0x01000000 | 0x08000000,
    null,
    null,
    ptr(startup),
    ptr(info),
  );
  const error = k.GetLastError();
  if (started) {
    const view = new DataView(info.buffer);
    k.CloseHandle(view.getBigUint64(0, true));
    k.CloseHandle(view.getBigUint64(8, true));
  }
  return {
    inJob: member[0] !== 0,
    breakawayDenied: started === 0 && error === 5,
  };
}

/** Hold a process handle across the crash, so PID reuse cannot fake cleanup. */
export function observeLifetime(pid: number): {
  alive(): boolean;
  close(): void;
} {
  const k = native();
  const handle = k.OpenProcess(0x100000 | 0x1, 0, pid);
  if (handle === 0n) throw new Error(`cannot open live fixture PID ${pid}`);
  return {
    alive: () => k.WaitForSingleObject(handle, 0) !== 0,
    close: () => {
      k.TerminateProcess(handle, 1);
      k.CloseHandle(handle);
    },
  };
}

export function isLive(pid: number): boolean {
  const k = native();
  const handle = k.OpenProcess(0x100000, 0, pid);
  if (handle === 0n) return false;
  try {
    return k.WaitForSingleObject(handle, 0) === 258;
  } finally {
    k.CloseHandle(handle);
  }
}
