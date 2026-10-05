import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { constants, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { getSystemErrorName } from "node:util";
import which from "which";
import type { OwnedProcessClose, OwnedProcessOptions } from "./process.js";

// Fixed host ABIs: glibc x64 and Darwin arm64. Native roots never enter Bun's
// child registry. WNOWAIT retains the session leader even after native exit;
// revoke every numeric signal authority before waitpid releases that identity.
function loadLibc() {
  return dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      socket: { args: ["i32", "i32", "i32"], returns: "i32" },
      connect: { args: ["i32", "ptr", "u32"], returns: "i32" },
      [process.platform === "darwin" ? "__ioctl" : "ioctl"]: {
        args: ["i32", "u64", "ptr"],
        returns: "i32",
      },
      close: { args: ["i32"], returns: "i32" },
      shutdown: { args: ["i32", "i32"], returns: "i32" },
      sigaction: { args: ["i32", "ptr", "ptr"], returns: "i32" },
      sigemptyset: { args: ["ptr"], returns: "i32" },
      sigfillset: { args: ["ptr"], returns: "i32" },
      posix_spawnattr_init: { args: ["ptr"], returns: "i32" },
      posix_spawnattr_setflags: { args: ["ptr", "i16"], returns: "i32" },
      posix_spawnattr_setsigdefault: { args: ["ptr", "ptr"], returns: "i32" },
      posix_spawnattr_setsigmask: { args: ["ptr", "ptr"], returns: "i32" },
      posix_spawnattr_destroy: { args: ["ptr"], returns: "i32" },
      posix_spawn_file_actions_init: { args: ["ptr"], returns: "i32" },
      posix_spawn_file_actions_adddup2: {
        args: ["ptr", "i32", "i32"],
        returns: "i32",
      },
      posix_spawn_file_actions_addclose: {
        args: ["ptr", "i32"],
        returns: "i32",
      },
      posix_spawn_file_actions_addchdir_np: {
        args: ["ptr", "ptr"],
        returns: "i32",
      },
      posix_spawn_file_actions_destroy: { args: ["ptr"], returns: "i32" },
      posix_spawn: {
        args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"],
        returns: "i32",
      },
      waitid: { args: ["i32", "u32", "ptr", "i32"], returns: "i32" },
      waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
      [process.platform === "darwin" ? "__error" : "__errno_location"]: {
        args: [],
        returns: "ptr",
      },
    },
  );
}
type Libc = ReturnType<typeof loadLibc>["symbols"];
let libc: Libc | undefined;

const probes = new Set<() => void>();
function onChildExit(): void {
  for (const probe of probes) probe();
}
function observeExit(probe: () => void) {
  if (probes.size === 0) process.on("SIGCHLD", onChildExit);
  probes.add(probe);
  // Bun's old-kernel waiter may replace the signal handler. Yielding targeted
  // WNOHANG observation also covers a root that closed all pipes before exit.
  // This costs at most 40 native probes/second for an unobserved live root.
  const timer = setInterval(probe, 25);
  return {
    stop: () => {
      clearInterval(timer);
      probes.delete(probe);
      if (probes.size === 0) process.removeListener("SIGCHLD", onChildExit);
    },
    unref: () => timer.unref(),
  };
}

const signalNames: readonly NodeJS.Signals[] = [
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGSYS",
];

function nativeError(code: number, operation: string): Error {
  // Native errors never contain executable, argv, cwd or environment secrets.
  return Object.assign(new Error(`${operation} failed (${code})`), {
    code: code === 10 ? "ECHILD" : getSystemErrorName(-code),
  });
}
function errno(k: Libc): number {
  const address =
    process.platform === "darwin" ? k.__error?.() : k.__errno_location?.();
  if (address === undefined || address === null)
    throw new Error("missing native errno");
  return new Int32Array(toArrayBuffer(address, 0, 4))[0]!;
}
function check(code: number, operation: string): void {
  if (code !== 0) throw nativeError(code, operation);
}
function cstring(text: string): Buffer {
  if (text.includes("\0")) throw nativeError(22, "POSIX input");
  return Buffer.from(text + "\0");
}
function vector(buffers: readonly Buffer[]): BigUint64Array {
  return new BigUint64Array([
    ...buffers.map((buffer) => BigInt(ptr(buffer))),
    0n,
  ]);
}

interface Pipe {
  readonly socket: Socket;
  readonly fd: number;
}

/** Import a native socket through the supported net.Server acceptance route.
 * Passing an arbitrary fd to new Socket is not supported by pinned Bun. */
async function createPipe(
  k: Libc,
  path: string,
  deadline: number,
  childReads: boolean,
): Promise<Pipe> {
  const server = createServer({ allowHalfOpen: true });
  let socket: Socket | undefined;
  let fd = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      timer = setTimeout(
        () => fail(new PosixLaunchTimeout("POSIX stdio launch timeout")),
        Math.max(0, deadline - Date.now()),
      );
      server.listen(path, done);
    });
    clearTimeout(timer);
    const accepted = new Promise<Socket>((done, fail) => {
      server.once("connection", (peer) => {
        socket = peer;
        done(peer);
      });
      server.once("error", fail);
      timer = setTimeout(
        () => fail(new PosixLaunchTimeout("POSIX stdio connection timeout")),
        Math.max(0, deadline - Date.now()),
      );
    });
    // Observe acquisition rejection even if native connect fails first.
    void accepted.catch(() => {});
    fd = k.socket(1, 1, 0);
    if (fd < 0) throw nativeError(errno(k), "socket");
    const cloexec =
      process.platform === "darwin"
        ? k.__ioctl?.(fd, 0x20006601n, null)
        : k.ioctl?.(fd, 0x5451n, null);
    if (cloexec !== 0) throw nativeError(errno(k), "ioctl(FIOCLEX)");
    const address = Buffer.alloc(process.platform === "darwin" ? 106 : 110);
    const bytes = cstring(path);
    if (bytes.length > address.length - 2)
      throw new Error("POSIX stdio path too long");
    if (process.platform === "darwin") {
      address[0] = address.length;
      address[1] = 1;
    } else address.writeUInt16LE(1, 0);
    bytes.copy(address, 2);
    if (k.connect(fd, ptr(address), address.length) < 0)
      throw nativeError(errno(k), "connect");
    socket = await accepted;
    socket.on("error", () => {});
    // stdio is one-way. Retire unused socket halves before child launch so
    // closing a stdio fd delivers EOF rather than a duplex peer reset on Darwin.
    if (childReads) {
      if (k.shutdown(fd, 1) < 0)
        throw nativeError(errno(k), "shutdown(stdin write half)");
      socket.resume();
    } else {
      // Bun schedules the native shutdown on nextTick. Await its finish before
      // launching a child that can close at once.
      const writeShut = finished(socket, {
        readable: false,
        writable: true,
        cleanup: true,
      });
      void writeShut.catch(() => {});
      socket.end();
      clearTimeout(timer);
      await Promise.race([
        writeShut,
        new Promise<never>((_, fail) => {
          timer = setTimeout(
            () => fail(new PosixLaunchTimeout("POSIX stdio shutdown timeout")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
      // The writer owns this half-close. Its peer read half is already EOF;
      // Darwin rejects a second SHUT_RD on that peer with ENOTCONN.
    }
    return { socket, fd };
  } catch (cause) {
    socket?.destroy();
    if (fd >= 0) k.close(fd);
    throw cause;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

export class PosixLaunchTimeout extends Error {}

export interface PosixChild {
  readonly pid: number;
  readonly stdin: Socket;
  readonly stdout: Socket;
  readonly stderr: Socket;
  readonly close: Promise<OwnedProcessClose>;
  /** Ownership outlives root exit, until root evidence and output drain settle. */
  active(): boolean;
  rootSignalled(): boolean;
  signal(signal: "SIGTERM" | "SIGKILL"): boolean;
  /** A failed bound retires authority and destroys pipes, never claims drain. */
  abandon(cause: unknown): void;
}

/** One private launch/wait owner shared by Command and OwnedProcess. */
export async function launchPosix(
  options: OwnedProcessOptions,
  observation: {
    spawned(pid: number): void;
    killing(signal: "SIGTERM" | "SIGKILL"): void;
    closed(status: number | null, signal: NodeJS.Signals | null): void;
  },
  testSignalGroup?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void,
): Promise<PosixChild> {
  if (!(
    (process.platform === "linux" && process.arch === "x64") ||
    (process.platform === "darwin" && process.arch === "arm64")
  ))
    throw new Error("unsupported POSIX ABI");
  const k = (libc ??= loadLibc().symbols);
  const darwin = process.platform === "darwin";
  const deadline = Date.now() + options.launchTimeoutMs;
  // Unix address limits apply to the complete encoded path, including NUL.
  // Keep caller TMPDIR/cwd/env intact; only this private acquisition path moves.
  const socketCapacity = darwin ? 104 : 108;
  const socketParent =
    Buffer.byteLength(join(tmpdir(), "sp-XXXXXX", "2")) + 1 <= socketCapacity
      ? tmpdir()
      : "/tmp";
  const folder = mkdtempSync(join(socketParent, "sp-"));
  const pipes: Pipe[] = [];
  const attr = Buffer.alloc(darwin ? 8 : 336);
  const actions = Buffer.alloc(darwin ? 8 : 80);
  let attrReady = false;
  let actionsReady = false;
  let stopObservation: ReturnType<typeof observeExit> | undefined;
  try {
    // Register before spawn to close the fast-exit/coalesced-SIGCHLD race.
    // Installation through process.on also establishes a retaining disposition;
    // verify it rather than silently changing another runtime's global handler.
    let probe = (): void => {};
    stopObservation = observeExit(() => probe());
    const disposition = Buffer.alloc(darwin ? 16 : 152);
    if (k.sigaction(constants.signals.SIGCHLD, null, ptr(disposition)) < 0)
      throw nativeError(errno(k), "sigaction(SIGCHLD)");
    const flags = disposition.readUInt32LE(darwin ? 12 : 136);
    if (
      disposition.readBigUInt64LE(0) === 1n ||
      (flags & (darwin ? 0x20 : 2)) !== 0
    )
      throw new Error("SIGCHLD disposition does not retain root identity");
    // Bun's no-orphans broad waits run on the same JS/arming thread. There is
    // no await between verifying wait ownership and signalling a group below.
    check(k.posix_spawnattr_init(ptr(attr)), "spawnattr_init");
    attrReady = true;
    check(k.posix_spawn_file_actions_init(ptr(actions)), "spawn_actions_init");
    actionsReady = true;
    const empty = Buffer.alloc(darwin ? 4 : 128),
      defaults = Buffer.alloc(darwin ? 4 : 128);
    check(k.sigemptyset(ptr(empty)), "sigemptyset");
    check(k.sigfillset(ptr(defaults)), "sigfillset");
    check(k.posix_spawnattr_setsigmask(ptr(attr), ptr(empty)), "spawn_sigmask");
    check(
      k.posix_spawnattr_setsigdefault(ptr(attr), ptr(defaults)),
      "spawn_sigdefault",
    );
    check(
      k.posix_spawnattr_setflags(ptr(attr), (darwin ? 0x400 : 0x80) | 4 | 8),
      "spawn_flags",
    );
    check(
      k.posix_spawn_file_actions_addchdir_np(
        ptr(actions),
        ptr(cstring(options.cwd)),
      ),
      "spawn_chdir",
    );
    for (let n = 0; n < 3; n++) {
      const pipe = await createPipe(
        k,
        join(folder, String(n)),
        deadline,
        n === 0,
      );
      pipes.push(pipe);
      check(
        k.posix_spawn_file_actions_adddup2(ptr(actions), pipe.fd, n),
        "spawn_dup2",
      );
      check(
        k.posix_spawn_file_actions_addclose(ptr(actions), pipe.fd),
        "spawn_close",
      );
    }
    const [input, output, errors] = pipes;
    if (input === undefined || output === undefined || errors === undefined)
      throw new Error("missing POSIX stdio");
    const executable =
      isAbsolute(options.executable) || options.executable.includes("/")
        ? resolve(options.cwd, options.executable)
        : which.sync(options.executable, {
            nothrow: true,
            path: (options.env.PATH ?? "/usr/bin:/bin")
              .split(":")
              .map((entry) => resolve(options.cwd, entry))
              .join(":"),
          });
    if (typeof executable !== "string")
      throw nativeError(2, "spawn executable lookup");
    const args = [options.executable, ...options.args].map(cstring);
    const env = Object.entries(options.env).flatMap(([key, value]) =>
      value === undefined ? [] : [cstring(`${key}=${value}`)],
    );
    const pidSlot = new Int32Array(1);
    if (Date.now() >= deadline)
      throw new PosixLaunchTimeout("POSIX launch timeout");
    const executableCString = cstring(executable);
    const argv = vector(args),
      envp = vector(env);
    check(
      k.posix_spawn(
        ptr(pidSlot),
        ptr(executableCString),
        ptr(actions),
        ptr(attr),
        ptr(argv),
        ptr(envp),
      ),
      "posix_spawn",
    );
    const pid = pidSlot[0]!;
    observation.spawned(pid);
    let authority = true;
    let released = false;
    let evidence:
      Extract<OwnedProcessClose, { kind: "exited" | "signal" }> | undefined;
    let failure: unknown;
    let complete: (close: OwnedProcessClose) => void = () => {};
    const close = new Promise<OwnedProcessClose>((done) => {
      complete = done;
    });
    let drained = false;
    let settled = false;
    let rootSignalled = false;
    const signalGroup =
      testSignalGroup ??
      ((group: number, signal: "SIGTERM" | "SIGKILL") => {
        process.kill(-group, signal);
      });
    const exitObservation = stopObservation;
    const unobserve = exitObservation.stop;
    // A signal listener alone does not keep the event loop alive. This reference
    // does, even when a live root closes all stdio. It never polls native state.
    const reference = setInterval(() => {}, 0x3fffffff);
    const retire = (): void => {
      authority = false;
      input.socket.destroy();
    };
    const release = (): void => {
      if (released || evidence === undefined) return;
      retire();
      released = true;
      clearInterval(reference);
      unobserve();
      const status = new Int32Array(1);
      let result: number;
      do {
        result = k.waitpid(pid, ptr(status), 1);
      } while (result < 0 && errno(k) === 4);
      if (result !== pid)
        failure ??=
          result < 0
            ? nativeError(errno(k), "waitpid release")
            : new Error("native root was not waitable at release");
      observation.closed(
        evidence.kind === "exited" ? evidence.status : null,
        evidence.kind === "signal" ? evidence.signal : null,
      );
    };
    const finish = (): void => {
      // Native release outlives a failed close result when SIGKILL has not yet
      // reached a live root. Its later observation still retires and reaps it.
      if (settled) {
        if (failure !== undefined && evidence !== undefined) release();
        return;
      }
      if (failure !== undefined) {
        if (authority) {
          try {
            signalGroup(pid, "SIGKILL");
            rootSignalled ||= evidence === undefined;
            observation.killing("SIGKILL");
          } catch {
            /* Preserve the owning failure. */
          }
        }
        retire();
        output.socket.destroy();
        errors.socket.destroy();
        release();
        clearInterval(reference);
        exitObservation.unref();
        settled = true;
        complete({ kind: "cleanup-error", cause: failure });
      } else if (evidence !== undefined && drained) {
        release();
        output.socket.destroy();
        errors.socket.destroy();
        settled = true;
        complete(
          failure === undefined
            ? evidence
            : { kind: "cleanup-error", cause: failure },
        );
      }
    };
    probe = (): void => {
      if (released) return;
      const info = Buffer.alloc(darwin ? 104 : 128);
      let result: number;
      do {
        result = k.waitid(
          1,
          pid,
          ptr(info),
          4 | 1 | (darwin ? 0x20 : 0x01000000),
        );
      } while (result < 0 && errno(k) === 4);
      if (result !== 0) {
        const code = errno(k);
        // A foreign reaper destroys identity proof. No later signal or reap.
        retire();
        released = true;
        clearInterval(reference);
        unobserve();
        failure ??= nativeError(code, "waitid ownership");
        observation.closed(
          evidence?.kind === "exited" ? evidence.status : null,
          evidence?.kind === "signal" ? evidence.signal : null,
        );
      } else if (info.readInt32LE(darwin ? 12 : 16) === pid) {
        const status = info.readInt32LE(darwin ? 20 : 24);
        evidence ??=
          info.readInt32LE(8) === 1
            ? { kind: "exited", status }
            : {
                kind: "signal",
                signal:
                  signalNames.find(
                    (name) => constants.signals[name] === status,
                  ) ?? null,
              };
        unobserve();
      }
      finish();
    };
    void Promise.all(
      [output.socket, errors.socket].map((socket) =>
        finished(socket, { readable: true, writable: false, cleanup: true }),
      ),
    ).then(
      () => {
        drained = true;
        probe();
      },
      (cause: unknown) => {
        failure ??= cause;
        probe();
      },
    );
    probe();
    // Listener and native wait ownership now belong to this child.
    stopObservation = undefined;
    return {
      pid,
      stdin: input.socket,
      stdout: output.socket,
      stderr: errors.socket,
      close,
      active: () => authority,
      rootSignalled: () => rootSignalled,
      signal: (signal) => {
        if (!authority) return false;
        probe();
        if (!authority) return false;
        signalGroup(pid, signal);
        rootSignalled ||= evidence === undefined;
        observation.killing(signal);
        return true;
      },
      abandon: (cause) => {
        failure ??= cause;
        probe();
      },
    };
  } catch (cause) {
    for (const pipe of pipes) pipe.socket.destroy();
    throw cause;
  } finally {
    stopObservation?.stop();
    if (actionsReady) k.posix_spawn_file_actions_destroy(ptr(actions));
    if (attrReady) k.posix_spawnattr_destroy(ptr(attr));
    for (const pipe of pipes) k.close(pipe.fd);
    rmSync(folder, { recursive: true, force: true });
  }
}
