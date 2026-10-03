import { dlopen, FFIType as T, JSCallback, ptr } from "bun:ffi";
import { createServer, type Socket } from "node:net";
import { finished } from "node:stream/promises";
import type { OwnedProcessClose, OwnedProcessOptions } from "./process.js";

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

/** Test-only failures at pre-execution acquisition points. Composition never
 * supplies one; there is no environment or command-line containment switch. */
export type ContainmentFailureStage =
  | "job-create"
  | "job-configure"
  | "stdio"
  | "handle-list"
  | "job-list"
  | "create-process"
  | "exit-wait"
  | "exit-callback";

export interface ContainedChild {
  readonly pid: number;
  readonly stdin: Socket;
  readonly stdout: Socket;
  readonly stderr: Socket;
  readonly close: Promise<OwnedProcessClose>;
  alive(): boolean;
}

type LaunchResult =
  | { readonly kind: "contained"; readonly child: ContainedChild }
  | { readonly kind: "fallback" }
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

/** Creation is suspended only to acquire the exit wait before execution. Job
 * membership itself is attached atomically by CreateProcessW's JOB_LIST. Any
 * failed attempt is fully released before the Node fallback may run. */
export async function launchContained(
  options: OwnedProcessOptions,
  failAt: ContainmentFailureStage | undefined,
): Promise<LaunchResult> {
  if (process.platform !== "win32") return { kind: "fallback" };
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
    return { kind: "fallback" };
  const check = (stage: ContainmentFailureStage): void => {
    if (stage === failAt)
      throw new Error(`forced containment failure: ${stage}`);
  };
  let k: Kernel;
  try {
    kernel ??= loadKernel().symbols;
    k = kernel;
  } catch {
    return { kind: "fallback" };
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
    // Install the drain observers before releasing the child's pipe handles.
    const drained = Promise.all(
      [output.socket, errors.socket].map((socket) =>
        finished(socket, { readable: true, writable: false, cleanup: true }),
      ),
    );
    void drained.catch(() => {});
    const ownedJob = job;
    const ownedProcess = processHandle;
    const observation = exit.finally(() => {
      live = false;
      const released = k.CloseHandle(ownedJob);
      k.CloseHandle(ownedProcess);
      input.socket.destroy();
      if (!released) throw nativeError(k, "CloseHandle(job)");
    });
    const close = observation
      .then(async (status): Promise<OwnedProcessClose> => {
        // Root exit ends this owned lifetime, including background descendants.
        // Drain the final frames before publishing close to either Harness. The
        // bound is on output drain, not on detecting exit. A stalled consumer is
        // a cleanup error, never a claimed successful drain.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            drained,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("contained output drain timeout")),
                1000,
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
    return { kind: "fallback" };
  } finally {
    if (initialized && attributes !== undefined)
      k.DeleteProcThreadAttributeList(ptr(attributes));
    for (const pipe of pipes) k.CloseHandle(pipe.handle);
    if (thread !== 0n) k.CloseHandle(thread);
    if (processHandle !== 0n) k.CloseHandle(processHandle);
    if (job !== 0n) k.CloseHandle(job);
  }
}
