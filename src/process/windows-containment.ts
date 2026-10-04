import { dlopen, FFIType as T, JSCallback, ptr } from "bun:ffi";
import { createServer, type Socket } from "node:net";
import { finished } from "node:stream/promises";
import type {
  OwnedProcessClose,
  OwnedProcessOptions,
  ProcessAdapterOptions,
} from "./process.js";

// Win32's fixed x64 ABI, not a growing native binding. #259 and the compiled
// #338 probe established these layouts. Keep all native access private here.
function loadKernel() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [T.ptr, T.ptr], returns: T.u64 },
    SetInformationJobObject: {
      args: [T.u64, T.i32, T.ptr, T.u32],
      returns: T.i32,
    },
    InitializeProcThreadAttributeList: {
      args: [T.ptr, T.u32, T.u32, T.ptr],
      returns: T.i32,
    },
    UpdateProcThreadAttribute: {
      args: [T.ptr, T.u32, T.u64, T.ptr, T.u64, T.ptr, T.ptr],
      returns: T.i32,
    },
    DeleteProcThreadAttributeList: { args: [T.ptr], returns: T.void },
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
    ResumeThread: { args: [T.u64], returns: T.u32 },
    TerminateProcess: { args: [T.u64, T.u32], returns: T.i32 },
    TerminateJobObject: { args: [T.u64, T.u32], returns: T.i32 },
    QueryInformationJobObject: {
      args: [T.u64, T.i32, T.ptr, T.u32, T.ptr],
      returns: T.i32,
    },
    OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.u64 },
    IsProcessInJob: { args: [T.u64, T.u64, T.ptr], returns: T.i32 },
    CloseHandle: { args: [T.u64], returns: T.i32 },
    WaitForSingleObject: { args: [T.u64, T.u32], returns: T.u32 },
    GetExitCodeProcess: { args: [T.u64, T.ptr], returns: T.i32 },
    GetLastError: { args: [], returns: T.u32 },
    CreateFileW: {
      args: [T.ptr, T.u32, T.u32, T.ptr, T.u32, T.u32, T.ptr],
      returns: T.u64,
    },
    CreateEventW: { args: [T.ptr, T.i32, T.i32, T.ptr], returns: T.u64 },
    RegisterWaitForSingleObject: {
      args: [T.ptr, T.u64, T.ptr, T.ptr, T.u32, T.u32],
      returns: T.i32,
    },
    UnregisterWaitEx: { args: [T.u64, T.u64], returns: T.i32 },
  });
}

type Kernel = ReturnType<typeof loadKernel>["symbols"];
let kernel: Kernel | undefined;

/** Test-only acquisition and cleanup failures. Composition never supplies one;
 * there is no environment or command-line containment switch. */
export type ContainmentFailureStage =
  | "job-create"
  | "job-configure"
  | "stdio"
  | "handle-list"
  | "job-list"
  | "create-process"
  | "exit-wait"
  | "exit-callback"
  | "job-terminate"
  | "descendant-confirm"
  | "post-termination-member-missing";

export interface ContainedChild {
  readonly pid: number;
  readonly stdin: Socket;
  readonly stdout: Socket;
  readonly stderr: Socket;
  readonly close: Promise<OwnedProcessClose>;
  alive(): boolean;
  /** Request job-level termination once; true means a forced kill was sent. */
  terminate(): boolean;
}

type LaunchResult =
  | { readonly kind: "contained"; readonly child: ContainedChild }
  | { readonly kind: "fallback"; readonly cause: unknown }
  | { readonly kind: "failed"; readonly cause: unknown };

function wide(text: string): Uint16Array {
  const buffer = new Uint16Array(text.length + 1);
  for (let i = 0; i < text.length; i++) buffer[i] = text.charCodeAt(i);
  return buffer;
}

/** MSVCRT quoting controls the exact bytes delivered to the interpreter. It
 * handles quotes, empty args and trailing backslashes without cmd.exe. */
function quoteArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;
  let quoted = '"';
  let slashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      slashes++;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? slashes * 2 + 1 : slashes);
    quoted += character;
    slashes = 0;
  }
  return quoted + "\\".repeat(slashes * 2) + '"';
}

function environmentBlock(env: NodeJS.ProcessEnv): Uint16Array {
  // The caller already selected one spelling of each case-insensitive key.
  const keys = Object.keys(env).sort((a, b) => {
    const left = a.toUpperCase();
    const right = b.toUpperCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const entries = keys.flatMap((key) => {
    const value = env[key];
    return value === undefined ? [] : [`${key}=${value}\0`];
  });
  return wide(entries.join("") + (entries.length === 0 ? "\0" : ""));
}

function nativeError(k: Kernel, operation: string): Error {
  // Never include command lines or environment values (Harness secrets).
  return new Error(`${operation} failed (Win32 ${k.GetLastError()})`);
}

interface Pipe {
  readonly socket: Socket;
  readonly handle: bigint;
}

async function createPipe(
  k: Kernel,
  childReads: boolean,
  deadline: number,
): Promise<Pipe> {
  const name = `\\\\.\\pipe\\secant-${process.pid}-${crypto.randomUUID()}`;
  const server = createServer();
  let socket: Socket | undefined;
  let handle = 0n;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("named-pipe launch timeout")),
        Math.max(0, deadline - Date.now()),
      );
      server.once("error", reject);
      server.listen(name, resolve);
    });
    clearTimeout(timer);
    const accepted = new Promise<Socket>((resolve, reject) => {
      server.once("connection", resolve);
      server.once("error", reject);
      timer = setTimeout(
        () => reject(new Error("named-pipe connection timeout")),
        Math.max(0, deadline - Date.now()),
      );
    });
    // SECURITY_ATTRIBUTES x64: length, descriptor pointer, inherit flag. Only
    // these three child pipe ends appear in HANDLE_LIST; the job never does.
    const security = new Uint8Array(24);
    const view = new DataView(security.buffer);
    view.setUint32(0, 24, true);
    view.setInt32(16, 1, true);
    const access = childReads ? 0x80000000 | 0x100 : 0x40000000 | 0x80;
    handle = k.CreateFileW(
      ptr(wide(name)),
      access,
      0,
      ptr(security),
      3,
      0,
      null,
    );
    if (handle === 0xffffffffffffffffn) {
      handle = 0n;
      // Observe the rejected acceptance even when CreateFileW failed first.
      void accepted.catch(() => {});
      throw nativeError(k, "CreateFileW(pipe)");
    }
    socket = await accepted;
    // A write-side pipe can report EPIPE after root exit with no write pending.
    // Keep it observed; stream consumers still receive read-side errors.
    socket.on("error", () => {});
    if (!childReads) socket.on("readable", () => socket?.read(0));
    return { socket, handle };
  } catch (error) {
    socket?.destroy();
    if (handle !== 0n) k.CloseHandle(handle);
    throw error;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** The pool wait is a native handle observation, independent of pipe EOF. A
 * ref timer keeps Bun alive; an event proves the non-blocking unregister has
 * finished before a later JS turn frees the callback trampoline. */
function registerExit(
  k: Kernel,
  processHandle: bigint,
  failAt: ContainmentFailureStage | undefined,
): Promise<number> {
  const completion = k.CreateEventW(null, 1, 0, null);
  if (completion === 0n) throw nativeError(k, "CreateEventW(wait completion)");
  const waitHandle = new BigUint64Array(1);
  let callback: JSCallback | undefined;
  const keepAlive = setInterval(() => {
    void callback?.ptr;
  }, 1 << 30);
  let complete!: (status: number) => void;
  let fail!: (cause: unknown) => void;
  const exited = new Promise<number>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  try {
    if (failAt === "exit-callback")
      throw new Error("forced containment failure: exit-callback");
    callback = new JSCallback(
      () => {
        const code = new Uint32Array(1);
        const observed = k.GetExitCodeProcess(processHandle, ptr(code));
        const error = observed
          ? undefined
          : nativeError(k, "GetExitCodeProcess");
        k.UnregisterWaitEx(waitHandle[0]!, completion);
        const release = (): void => {
          if (k.WaitForSingleObject(completion, 0) !== 0) {
            setTimeout(release, 10);
            return;
          }
          setImmediate(() => {
            callback?.close();
            k.CloseHandle(completion);
            clearInterval(keepAlive);
          });
        };
        release();
        if (error !== undefined) fail(error);
        else complete(code[0]!);
      },
      { args: [T.ptr, T.u8], returns: T.void, threadsafe: true },
    );
    if (
      !k.RegisterWaitForSingleObject(
        ptr(waitHandle),
        processHandle,
        callback.ptr,
        null,
        0xffffffff,
        0x8,
      )
    )
      throw nativeError(k, "RegisterWaitForSingleObject");
    return exited;
  } catch (cause) {
    // Neither a failed callback allocation nor a failed wait registration has
    // submitted the callback to the pool. All locally acquired resources end
    // here; the suspended child is released by launchContained before fallback.
    callback?.close();
    k.CloseHandle(completion);
    clearInterval(keepAlive);
    throw cause;
  }
}

// A contained stop has its own status, never kill-on-close's misleading zero.
// Only Process attributes the successful kill to ChildWatch; callers use facts
// and escalation evidence rather than interpreting this private native code.
const REAP_EXIT_CODE = 0x53454341;

function terminateJob(k: Kernel, job: bigint): void {
  if (!k.TerminateJobObject(job, REAP_EXIT_CODE))
    throw nativeError(k, "TerminateJobObject");
}

interface MemberHandle {
  readonly pid: number;
  readonly handle: bigint;
}

/** A job's active list can lose a process before its handle signals. Acquire
 * handles while the job is still live, and again after termination for members
 * that entered between the first snapshot and the kill request. */
function snapshotJobMembers(
  k: Kernel,
  job: bigint,
  deadline: number,
  hiddenPid?: number,
): MemberHandle[] {
  let capacity = 16;
  let processes: Uint8Array;
  for (;;) {
    processes = new Uint8Array(8 + capacity * 8);
    const queried = k.QueryInformationJobObject(
      job,
      3,
      ptr(processes),
      processes.byteLength,
      null,
    );
    if (!queried && k.GetLastError() !== 234)
      throw nativeError(k, "QueryInformationJobObject(processes)");
    const view = new DataView(processes.buffer);
    const assigned = view.getUint32(0, true);
    const listed = view.getUint32(4, true);
    if (queried && assigned === listed) break;
    if (Date.now() >= deadline)
      throw new Error("contained process exit timeout");
    capacity = Math.max(capacity * 2, assigned);
  }
  const handles: MemberHandle[] = [];
  try {
    const view = new DataView(processes.buffer);
    for (let i = 0; i < view.getUint32(4, true); i++) {
      const pid = Number(view.getBigUint64(8 + i * 8, true));
      if (pid === hiddenPid) continue; // Test-only simulated post-kill list gap.
      const handle = k.OpenProcess(0x100000 | 0x1000, 0, pid);
      if (handle === 0n) {
        if (k.GetLastError() === 87) continue; // Already exited.
        throw nativeError(k, "OpenProcess(contained descendant)");
      }
      handles.push({ pid, handle });
      const member = new Int32Array(1);
      if (!k.IsProcessInJob(handle, job, ptr(member)))
        throw nativeError(k, "IsProcessInJob(contained descendant)");
      // An exited PID may have been reused since the job snapshot.
      if (member[0] === 0) {
        handles.pop();
        k.CloseHandle(handle);
      }
    }
    return handles;
  } catch (cause) {
    for (const member of handles) k.CloseHandle(member.handle);
    throw cause;
  }
}

function closeMembers(k: Kernel, members: readonly MemberHandle[]): void {
  for (const member of members) k.CloseHandle(member.handle);
}

/** Termination and pipe EOF are not process-handle exit. Confirm every retained
 * member under the same close deadline, including a second post-kill snapshot. */
async function confirmJobExit(
  k: Kernel,
  job: bigint,
  retained: readonly MemberHandle[],
  deadline: number,
  hiddenPid: number | undefined,
  memberGap: ProcessAdapterOptions["testWindowsContainmentMemberGap"],
): Promise<void> {
  const after = snapshotJobMembers(k, job, deadline, hiddenPid);
  const members = [...retained, ...after];
  let released = false;
  let reported = false;
  if (hiddenPid !== undefined && memberGap !== undefined)
    void memberGap.release.then(() => (released = true));
  try {
    for (;;) {
      let pending = false;
      for (const member of members) {
        // The test gate models a member that left the active list while its
        // process object still had not signaled. It never reaches composition.
        if (member.pid === hiddenPid && memberGap !== undefined && !released) {
          if (!reported) memberGap.onWait();
          reported = true;
          pending = true;
          continue;
        }
        const result = k.WaitForSingleObject(member.handle, 0);
        if (result === 0xffffffff)
          throw nativeError(k, "WaitForSingleObject(contained descendant)");
        if (result === 258) pending = true;
      }
      if (!pending) return;
      if (Date.now() >= deadline)
        throw new Error("contained process exit timeout");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    closeMembers(k, after);
  }
}

/** Creation is suspended only to acquire the exit wait before execution. Job
 * membership itself is attached atomically by CreateProcessW's JOB_LIST. Any
 * failed attempt is fully released before the Node fallback may run. */
export async function launchContained(
  options: OwnedProcessOptions,
  failAt: ContainmentFailureStage | undefined,
  memberGap?: ProcessAdapterOptions["testWindowsContainmentMemberGap"],
): Promise<LaunchResult> {
  if (process.platform !== "win32")
    return {
      kind: "fallback",
      cause: new Error("Windows containment is unavailable on this platform"),
    };
  if (
    [
      options.executable,
      options.cwd,
      ...options.args,
      ...Object.entries(options.env).flatMap(([key, value]) => [
        key,
        value ?? "",
      ]),
    ].some((value) => value.includes("\0"))
  )
    return {
      kind: "fallback",
      cause: new Error("Windows containment input contains a NUL"),
    };
  const check = (stage: ContainmentFailureStage): void => {
    if (stage === failAt)
      throw new Error(`forced containment failure: ${stage}`);
  };
  let k: Kernel;
  try {
    kernel ??= loadKernel().symbols;
    k = kernel;
  } catch (cause) {
    return { kind: "fallback", cause };
  }
  let job = 0n;
  let processHandle = 0n;
  let thread = 0n;
  let attributes: Uint8Array | undefined;
  let initialized = false;
  let exit: Promise<number> | undefined;
  const pipes: Pipe[] = [];
  const deadline = Date.now() + options.launchTimeoutMs;
  try {
    check("job-create");
    job = k.CreateJobObjectW(null, null);
    if (job === 0n) throw nativeError(k, "CreateJobObjectW");
    check("job-configure");
    const limits = new Uint8Array(144);
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: KILL_ON_JOB_CLOSE only, deliberately
    // neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK.
    new DataView(limits.buffer).setUint32(16, 0x2000, true);
    if (!k.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength))
      throw nativeError(k, "SetInformationJobObject");
    pipes.push(await createPipe(k, true, deadline));
    check("stdio");
    pipes.push(await createPipe(k, false, deadline));
    pipes.push(await createPipe(k, false, deadline));
    const size = new BigUint64Array(1);
    k.InitializeProcThreadAttributeList(null, 2, 0, ptr(size));
    attributes = new Uint8Array(Number(size[0]));
    if (!k.InitializeProcThreadAttributeList(ptr(attributes), 2, 0, ptr(size)))
      throw nativeError(k, "InitializeProcThreadAttributeList");
    initialized = true;
    const handles = new BigUint64Array(pipes.map((pipe) => pipe.handle));
    check("handle-list");
    if (
      !k.UpdateProcThreadAttribute(
        ptr(attributes),
        0,
        0x20002n,
        ptr(handles),
        BigInt(handles.byteLength),
        null,
        null,
      )
    )
      throw nativeError(k, "UpdateProcThreadAttribute(HANDLE_LIST)");
    const jobs = new BigUint64Array([job]);
    check("job-list");
    if (
      !k.UpdateProcThreadAttribute(
        ptr(attributes),
        0,
        0x2000dn,
        ptr(jobs),
        8n,
        null,
        null,
      )
    )
      throw nativeError(k, "UpdateProcThreadAttribute(JOB_LIST)");
    const startup = new Uint8Array(112);
    const view = new DataView(startup.buffer);
    view.setUint32(0, 112, true);
    view.setUint32(60, 0x100, true);
    handles.forEach((handle, index) =>
      view.setBigUint64(80 + index * 8, handle, true),
    );
    view.setBigUint64(104, BigInt(ptr(attributes)), true);
    const info = new Uint8Array(24);
    const command = wide(
      [options.executable, ...options.args].map(quoteArgument).join(" "),
    );
    const application = wide(options.executable);
    const environment = environmentBlock(options.env);
    const directory = wide(options.cwd);
    check("create-process");
    if (
      !k.CreateProcessW(
        ptr(application),
        ptr(command),
        null,
        null,
        1,
        0x80000 | 0x400 | 0x08000000 | 0x4,
        ptr(environment),
        ptr(directory),
        ptr(startup),
        ptr(info),
      )
    )
      throw nativeError(k, "CreateProcessW");
    const processInfo = new DataView(info.buffer);
    processHandle = processInfo.getBigUint64(0, true);
    thread = processInfo.getBigUint64(8, true);
    const pid = processInfo.getUint32(16, true);
    check("exit-wait");
    exit = registerExit(k, processHandle, failAt);
    const [input, output, errors] = pipes;
    if (input === undefined || output === undefined || errors === undefined)
      throw new Error("missing contained stdio");
    if (Date.now() >= deadline) throw new Error("contained launch timeout");
    if (k.ResumeThread(thread) === 0xffffffff)
      throw nativeError(k, "ResumeThread");
    k.CloseHandle(thread);
    thread = 0n;
    let live = true;
    let terminated = false;
    // Install the drain observers before releasing the child's pipe handles.
    const drained = Promise.all(
      [output.socket, errors.socket].map((socket) =>
        finished(socket, { readable: true, writable: false, cleanup: true }),
      ),
    );
    void drained.catch(() => {});
    const ownedJob = job;
    const ownedProcess = processHandle;
    let closeDeadline = 0;
    let retained: MemberHandle[] = [];
    let hiddenPid: number | undefined;
    const captureAndTerminate = (deadline: number): void => {
      const before = snapshotJobMembers(k, ownedJob, deadline);
      try {
        if (failAt === "post-termination-member-missing") {
          hiddenPid = before.find((member) => {
            if (member.pid === pid) return false;
            const result = k.WaitForSingleObject(member.handle, 0);
            if (result === 0xffffffff)
              throw nativeError(k, "WaitForSingleObject(contained descendant)");
            return result === 258;
          })?.pid;
        }
        terminateJob(k, ownedJob);
      } catch (cause) {
        closeMembers(k, before);
        throw cause;
      }
      retained = before;
      terminated = true;
    };
    const observation = exit.finally(async () => {
      live = false;
      closeDeadline = Date.now() + 1000;
      let releaseError: Error | undefined;
      try {
        if (!terminated) captureAndTerminate(closeDeadline);
        check("descendant-confirm");
        await confirmJobExit(
          k,
          ownedJob,
          retained,
          closeDeadline,
          hiddenPid,
          memberGap,
        );
      } finally {
        closeMembers(k, retained);
        if (!k.CloseHandle(ownedJob))
          releaseError = nativeError(k, "CloseHandle(job)");
        k.CloseHandle(ownedProcess);
        input.socket.destroy();
      }
      if (releaseError !== undefined) throw releaseError;
    });
    const close = observation
      .then(async (status): Promise<OwnedProcessClose> => {
        // Root exit ends this owned lifetime, including background descendants.
        // Drain the final frames before publishing close to either Harness. The
        // The same close bound covers descendant exit and output drain. A stalled
        // consumer is a cleanup error, never a claimed successful drain.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            drained,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("contained output drain timeout")),
                Math.max(0, closeDeadline - Date.now()),
              );
            }),
          ]);
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { kind: "exited", status };
        } finally {
          clearTimeout(timer);
        }
      })
      .catch((cause: unknown): OwnedProcessClose => {
        live = false;
        output.socket.destroy();
        errors.socket.destroy();
        return { kind: "cleanup-error", cause };
      });
    job = 0n;
    processHandle = 0n;
    return {
      kind: "contained",
      child: {
        pid,
        stdin: input.socket,
        stdout: output.socket,
        stderr: errors.socket,
        close,
        alive: () => live,
        terminate: () => {
          if (!live || terminated) return false;
          check("job-terminate");
          captureAndTerminate(Date.now() + 1000);
          return true;
        },
      },
    };
  } catch (cause) {
    // The only acquired process is still suspended. Close the job and confirm
    // death before fallback, so there is never a second live Harness process.
    for (const pipe of pipes) pipe.socket.destroy();
    if (job !== 0n && k.CloseHandle(job)) job = 0n;
    if (processHandle !== 0n) {
      k.TerminateProcess(processHandle, 1);
      const end = Date.now() + 3000;
      while (
        k.WaitForSingleObject(processHandle, 0) !== 0 &&
        Date.now() < end
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (k.WaitForSingleObject(processHandle, 0) !== 0)
        return { kind: "failed", cause };
      if (exit !== undefined) await exit.catch(() => {});
    }
    for (const pipe of pipes) pipe.socket.destroy();
    return { kind: "fallback", cause };
  } finally {
    if (initialized && attributes !== undefined)
      k.DeleteProcThreadAttributeList(ptr(attributes));
    for (const pipe of pipes) k.CloseHandle(pipe.handle);
    if (thread !== 0n) k.CloseHandle(thread);
    if (processHandle !== 0n) k.CloseHandle(processHandle);
    if (job !== 0n) k.CloseHandle(job);
  }
}
