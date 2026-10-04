import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type StdioOptions,
} from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  launchContained,
  type ContainedChild,
  type ContainmentFailureStage,
} from "./windows-containment.js";
import which from "which";

// The process Module owns the "owned child process" mechanics that a Command step
// and a Harness both need: it resolves a Command's authored executable to
// something spawnable directly (never through a shell), spawns it with piped
// stdio, leads it into its own process group off Windows, and reaps the whole tree
// on a timeout or cancel — SIGTERM→SIGKILL on POSIX, `taskkill /T /F` on Windows.
//
// It imports nothing from other Modules and reaches the OS only through
// `node:child_process`, the primary `which` PATH walk, and the Windows-only
// `where.exe` fallback. Windows owned launches use the private `bun:ffi`
// containment file named in ADR 0030. Run execution, Application
// (Preflight), and the Harness Module are its callers, so their precondition
// checks and their spawns agree by construction (A40, D1).

// --- Executable resolution --------------------------------------------------

/**
 * How a Command's authored executable resolves on this host to something spawnable
 * directly, never through a shell (#21). This is the one executable resolver this
 * Module owns and exports; Preflight consumes it so its precondition check and this
 * Module's spawn agree by construction (A40, D1).
 *
 * - `found`: spawn `executable` with `prefixArgs` ahead of the Command's own
 *   arguments. A native binary resolves to itself with no prefix. An npm-style
 *   Windows `.cmd` shim resolves to its real target — `node` plus the script the
 *   shim wraps — so it runs without `cmd.exe` (cross-spawn is rejected precisely
 *   because it routes `.cmd` through `cmd.exe`).
 * - `not-found`: nothing on PATH satisfies the name, or a shim's own interpreter is
 *   unresolvable.
 * - `unsupported-shim`: a Windows `.cmd`/`.bat` that is not an npm-style node shim;
 *   Preflight refuses it and asks the author to name the interpreter.
 *
 * Growth limit (D16): the shim parser recognises only the npm `%_prog%` template.
 * A pnpm, yarn-berry, or Bun shim, or a `.ps1`/`.bat` wrapper, falls to
 * `unsupported-shim` rather than gaining a branch here. The hand-rolled parser is
 * kept over a library because none parses a shim (`cmd-shim` only writes them) and
 * cross-spawn was rejected for routing `.cmd` through `cmd.exe` (#21); a second
 * shim format that must actually run is the trigger to revisit that call, not a
 * reason to keep adding branches.
 */
export type ExecutableResolution =
  | {
      readonly kind: "found";
      readonly executable: string;
      readonly prefixArgs: readonly string[];
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "unsupported-shim"; readonly path: string };

/** The PATH walk and the host platform are the two external facts resolution
 *  depends on; both are injectable adapters (testing.md) so the Windows shim path
 *  is exercised on any OS. Production passes neither. */
export interface ResolveExecutableOptions {
  /** Override PATH the walk searches (the real `which` still decides the match). */
  readonly path?: string;
  /** Override the host platform that gates the `.cmd`/`.bat` shim rule. */
  readonly platform?: NodeJS.Platform;
  /** Replace the PATH walk entirely, so the shim rule is testable without PATHEXT. */
  readonly resolve?: (name: string) => string | undefined;
  /** Replace the Windows fallback's raw `where.exe` stdout. When `resolve`
   *  replaces the PATH walk and this is omitted, the fallback stays disabled. */
  readonly resolveWindowsFallback?: (name: string) => string | undefined;
}

/** The single PATH walk in `src/` (D1): `which` resolves the name to an absolute
 *  path, checking the executable bit (POSIX) and PATHEXT (Windows), so a
 *  non-executable file earlier on PATH never satisfies resolution. */
function walkPath(
  name: string,
  options: ResolveExecutableOptions,
): string | undefined {
  if (options.resolve !== undefined) return options.resolve(name);
  const result = which.sync(name, {
    nothrow: true,
    ...(options.path !== undefined ? { path: options.path } : {}),
  });
  return typeof result === "string" ? result : undefined;
}

/** Windows Store/MSIX App Execution Aliases are AppExecLink reparse points.
 *  libuv stat cannot read them, so `which` skips paths the OS can spawn. The
 *  built-in `where.exe` observes the same alias lookup CreateProcess uses. */
function resolveWindowsFallback(
  name: string,
  options: ResolveExecutableOptions,
  notify: Notify,
): string | undefined {
  const output =
    options.resolveWindowsFallback !== undefined
      ? options.resolveWindowsFallback(name)
      : options.resolve === undefined
        ? runWhere(name, options.path, notify)
        : undefined;
  if (output === undefined) return undefined;
  const firstMatch = output.split(/\r?\n/, 1)[0]?.trim();
  return firstMatch === undefined || firstMatch.length === 0
    ? undefined
    : firstMatch;
}

function runWhere(
  name: string,
  path: string | undefined,
  notify: Notify,
): string | undefined {
  const watch = new ChildWatch(notify, "executable-lookup");
  watch.starting();
  const result = spawnSync("where.exe", [name], {
    encoding: "utf8",
    windowsHide: true,
    ...(path !== undefined ? { env: { ...process.env, PATH: path } } : {}),
  });
  watch.returned(result);
  // This is a best-effort positive probe after the primary resolver already
  // missed. An unavailable/blocked where.exe and a non-zero no-match result both
  // supply no spawnable path, matching `which.sync({ nothrow: true })` above.
  if (result.error !== undefined || result.status !== 0) return undefined;
  return result.stdout;
}

function resolveExecutablePath(
  name: string,
  options: ResolveExecutableOptions,
  platform: NodeJS.Platform,
  notify: Notify,
): string | undefined {
  const resolved = walkPath(name, options);
  if (resolved !== undefined || platform !== "win32") return resolved;
  return resolveWindowsFallback(name, options, notify);
}

function resolveExecutableWithNode(
  name: string,
  options: ResolveExecutableOptions,
  notify: Notify,
): ExecutableResolution {
  const platform = options.platform ?? process.platform;
  const resolved = resolveExecutablePath(name, options, platform, notify);
  if (resolved === undefined) return { kind: "not-found" };
  if (platform === "win32") {
    const ext = extname(resolved).toLowerCase();
    if (ext === ".cmd" || ext === ".bat") {
      return resolveWindowsShim(resolved, options, notify);
    }
  }
  return { kind: "found", executable: resolved, prefixArgs: [] };
}

/** Resolve a Windows `.cmd`/`.bat` to its real target. An npm-style node shim
 *  (`cmd-shim`) is resolved to `node` plus the script it wraps and spawned
 *  directly; anything else is `unsupported-shim` (Preflight refuses it). */
function resolveWindowsShim(
  shimPath: string,
  options: ResolveExecutableOptions,
  notify: Notify,
): ExecutableResolution {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return { kind: "unsupported-shim", path: shimPath };
  }
  const target = parseNpmCmdShim(text, dirname(shimPath));
  if (target === undefined) return { kind: "unsupported-shim", path: shimPath };
  // The shim's own interpreter must itself resolve on PATH, or the real target
  // cannot run — that is a not-found, not an unsupported shim.
  const interpreter = resolveExecutablePath(
    target.interpreter,
    options,
    "win32",
    notify,
  );
  if (interpreter === undefined) return { kind: "not-found" };
  return {
    kind: "found",
    executable: interpreter,
    prefixArgs: [target.script],
  };
}

/** Parse an npm `cmd-shim` `.cmd`: it sets `_prog` to its interpreter (a colocated
 *  binary in the `IF EXIST` branch, else the bare name on PATH in the `ELSE`
 *  branch) and invokes it on a `%dp0%`-relative script. Returns the bare
 *  interpreter name to resolve on PATH and the absolute script path, or undefined
 *  for any `.cmd`/`.bat` that is not this npm-style interpreter-plus-script shape. */
function parseNpmCmdShim(
  text: string,
  shimDir: string,
): { interpreter: string; script: string } | undefined {
  // The program-invocation line runs `"%_prog%" "<script>" %*`.
  const invocation = text
    .split(/\r?\n/)
    .find((line) => line.includes("%_prog%"));
  if (invocation === undefined) return undefined;
  const quoted = [...invocation.matchAll(/"([^"]*)"/g)].map(
    (match) => match[1]!,
  );
  const scriptToken = quoted.find(
    (token) => /%dp0%/i.test(token) && /\.[cm]?js$/i.test(token),
  );
  if (scriptToken === undefined) return undefined;
  // The interpreter is the `_prog` value that is a bare PATH name — the `ELSE`
  // branch — not the `%dp0%`-relative colocated one. Its absence means this is not
  // an npm-style shim, so it is refused rather than run through a shell.
  const interpreter = [...text.matchAll(/SET\s+"?_prog=([^"\r\n]+)"?/gi)]
    .map((match) => match[1]!.replace(/"$/, "").trim())
    .find((value) => value.length > 0 && !/%dp0%/i.test(value));
  if (interpreter === undefined) return undefined;
  return { interpreter, script: expandDp0(scriptToken, shimDir) };
}

/** Expand a `%dp0%`-relative shim token to an absolute path under the shim's
 *  directory, joining on either separator so the result is a host-native path. */
function expandDp0(token: string, shimDir: string): string {
  const relative = token.replace(/^%dp0%/i, "");
  const segments = relative.split(/[\\/]+/).filter((segment) => segment.length);
  return join(shimDir, ...segments);
}

// --- Child facts --------------------------------------------------------------

/** What a caller's spawn is for: the Preflight worktree probe and the Artifact
 *  repository spawn `git`, a Command step spawns `command`, a Harness version or
 *  schema probe spawns `harness-probe`, and a Harness's long-lived process is
 *  `harness-runtime`. Every caller declares one. The set is closed because a free
 *  label could carry a Command's executable or arguments, which the operational
 *  log excludes: the closed set is part of that privacy control. A role names a
 *  child's purpose, never which Harness owns it. */
type SpawnRole = "git" | "command" | "harness-probe" | "harness-runtime";

/** A child's role in a fact: its caller's declared role, or one of the two this
 *  Module assigns its own spawns and no caller can declare — the Windows
 *  `where.exe` fallback (`executable-lookup`) and `taskkill` (`tree-kill`). */
type ChildRole = SpawnRole | "executable-lookup" | "tree-kill";

/** One observed lifecycle fact of a child this Module spawned. Arguments,
 *  environment, and output never cross. Every child reports at most one
 *  settlement: `spawn-error` (it never ran), `exit` (it ended without a kill from
 *  Secant), or `reap` (it ended after Secant killed it). An asynchronous child
 *  that never ran reports only `spawn-error`; every other child reports `spawn`
 *  first. A child with no settlement was still running when Secant stopped
 *  watching.
 *
 *  - `spawn`: emitted before a synchronous spawn blocks, so a hang inside it still
 *    names the child; the PID is known only once it returns, on the settlement.
 *    An asynchronous spawn carries its PID here.
 *  - `spawn-error`: the child never ran. `code` is the native error code alone,
 *    never the message, syscall, or stack, which carry the executable.
 *  - A synchronous child killed for overrunning its buffer bound is a `reap`.
 *  - `timeout`: a bound Secant set expired, and Secant starts killing the tree.
 *  - `cancellation`: the caller cancelled or interrupted the child, and Secant
 *    starts killing the tree.
 *  - `kill-escalation`: Secant force-killed the tree — SIGKILL after SIGTERM off
 *    Windows; on Windows every kill is `taskkill /T /F`, so it follows the first.
 *  - `exit` and `reap` carry the exit status, or the signal that ended it.
 *
 *  `elapsedMs` is monotonic time since the spawn call. */
type WindowsContainment = "contained" | "fallback";

export type ChildFact =
  | ({
      readonly kind: "spawn";
      readonly role: ChildRole;
      readonly pid?: number;
    } & (
      | { readonly containment?: never; readonly containmentCause?: never }
      | { readonly containment: "contained"; readonly containmentCause?: never }
      | { readonly containment: "fallback"; readonly containmentCause: unknown }
    ))
  | {
      readonly kind: "spawn-error";
      readonly role: ChildRole;
      readonly code?: string;
      readonly elapsedMs: number;
    }
  | {
      readonly kind: "timeout" | "cancellation" | "kill-escalation";
      readonly role: ChildRole;
      readonly pid: number;
    }
  | {
      readonly kind: "exit" | "reap";
      readonly role: ChildRole;
      readonly pid?: number;
      readonly status?: number;
      readonly signal?: NodeJS.Signals;
      readonly elapsedMs: number;
    };

/** Options for the real Adapter. Production composition passes its operational
 *  log's observer; omitted, no fact is reported. An observer that throws is
 *  ignored, so a fact can never change a Process outcome. */
export interface ProcessAdapterOptions {
  readonly observeChild?: (fact: ChildFact) => void;
  /** Test-only containment failure; never wired by production composition. */
  readonly testWindowsContainmentFailure?: ContainmentFailureStage;
  /** Test-only gate simulating a member whose process handle signals late. */
  readonly testWindowsContainmentMemberGap?: {
    readonly onWait: () => void;
    readonly release: Promise<void>;
  };
}

/** The guarded observer every spawn path reports through. */
type Notify = (fact: ChildFact) => void;

function guardedObserver(options: ProcessAdapterOptions): Notify {
  const observe = options.observeChild;
  if (observe === undefined) return () => {};
  return (fact) => {
    try {
      observe(fact);
    } catch {
      // A fact is evidence about a child, never part of its outcome.
    }
  };
}

/** One child's facts. It holds what each fact needs — the role, the PID once
 *  known, the spawn time, and whether Secant killed or force-killed the tree —
 *  so every spawn and kill path reports alike, and it reports one settlement at
 *  most. */
class ChildWatch {
  private readonly started = performance.now();
  private pid: number | undefined;
  private killed = false;
  private escalated = false;
  private settled = false;

  constructor(
    private readonly notify: Notify,
    private readonly role: ChildRole,
    private readonly containment?: ProcessLaunchContainment,
  ) {}

  /** A synchronous spawn is about to block; its PID is not known yet. */
  starting(): void {
    this.notify({ kind: "spawn", role: this.role });
  }

  /** An asynchronous spawn returned a running child. */
  spawned(pid: number): void {
    this.pid = pid;
    this.notify({
      kind: "spawn",
      role: this.role,
      pid,
      ...(this.containment === undefined
        ? {}
        : this.containment.kind === "contained"
          ? { containment: "contained" as const }
          : {
              containment: "fallback" as const,
              containmentCause: this.containment.cause,
            }),
    });
  }

  /** A synchronous spawn returned: it failed to start, or its child ended. A
   *  child that overran its buffer bound ran and was killed for it, so its error
   *  arrives with a PID and it is reaped. */
  returned(result: {
    readonly pid?: number;
    readonly error?: Error;
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
  }): void {
    const ran = result.pid !== undefined && result.pid > 0;
    if (result.error !== undefined && !ran) {
      this.failed(result.error);
      return;
    }
    this.pid = result.pid;
    if (result.error !== undefined) this.killed = true;
    this.closed(result.status, result.signal);
  }

  failed(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    this.notify({
      kind: "spawn-error",
      role: this.role,
      ...(typeof code === "string" ? { code } : {}),
      elapsedMs: this.elapsed(),
    });
  }

  /** Secant's own bound expired, or its caller cancelled: the kill follows. */
  stopping(reason: "timeout" | "cancellation"): void {
    if (this.pid === undefined || this.settled) return;
    this.notify({ kind: reason, role: this.role, pid: this.pid });
  }

  /** A kill was sent to the live tree. On Windows every kill is forced. */
  killing(signal: "SIGTERM" | "SIGKILL"): void {
    this.killed = true;
    const forced = signal === "SIGKILL" || process.platform === "win32";
    if (!forced || this.escalated || this.pid === undefined) return;
    this.escalated = true;
    this.notify({ kind: "kill-escalation", role: this.role, pid: this.pid });
  }

  /** Watches the `taskkill` a Windows kill spawns, in this Module's own role. */
  treeKill(killer: ChildProcess): void {
    watchChild(killer, this.notify, "tree-kill");
  }

  closed(status: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    this.settled = true;
    this.notify({
      kind: this.killed ? "reap" : "exit",
      role: this.role,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      ...(status !== null ? { status } : {}),
      ...(status === null && signal !== null ? { signal } : {}),
      elapsedMs: this.elapsed(),
    });
  }

  private elapsed(): number {
    return performance.now() - this.started;
  }
}

/** Whether a spawned child has not yet been seen to exit. */
function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Starts watching an asynchronous child: its spawn fact as soon as it has a
 *  PID, a spawn error if it never ran, and its close. */
function watchChild(
  child: ChildProcess,
  notify: Notify,
  role: ChildRole,
  containment?: ProcessLaunchContainment,
): ChildWatch {
  const watch = new ChildWatch(notify, role, containment);
  if (child.pid !== undefined) watch.spawned(child.pid);
  child.once("error", (error) => {
    if (child.pid === undefined) watch.failed(error);
  });
  child.once("close", (code, signal) => watch.closed(code, signal));
  return watch;
}

// --- Direct spawn with tree reaping -----------------------------------------

/** What became of one spawned Command. `timeout` and `cancelled` are our own
 *  aborts (we killed the group); `signal` is a death by an outside signal we did
 *  not cause; `spawn-error` is a child that never ran. */
export type SpawnResult =
  | {
      readonly kind: "exited";
      readonly status: number;
      readonly text: Uint8Array;
    }
  | { readonly kind: "spawn-error" }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "signal" };

export interface SpawnOptions {
  readonly role: SpawnRole;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** The caller's streaming byte cap on captured output: past it, chunks are
   *  dropped (the counter keeps running) and `truncationMarker` is appended, so a
   *  runaway Command cannot exhaust memory (D3). The cap is the caller's policy;
   *  this Module only enforces the value it is given. */
  readonly maxCaptureBytes: number;
  readonly truncationMarker: string;
  readonly cancelSignal?: AbortSignal;
}

/** One bounded synchronous child used by storage mechanics that must complete
 * before their enclosing SQLite transaction can be decided. Unlike Command-step
 * capture, stdout and stderr stay separate because callers interpret each stream. */
export interface SpawnSyncOptions {
  readonly role: SpawnRole;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input?: Uint8Array;
  readonly maxBufferBytes: number;
}

export type SpawnSyncResult =
  | {
      readonly kind: "exited";
      readonly status: number;
      readonly stdout: Uint8Array;
      readonly stderr: Uint8Array;
    }
  | { readonly kind: "signal" }
  | { readonly kind: "spawn-error"; readonly cause: unknown };

// After an abort (timeout or cancel) the group gets SIGTERM, then SIGKILL if a
// child is still alive this long later — long enough for a well-behaved child to
// flush and exit, short enough to bound a hang (D2, #21).
const KILL_ESCALATION_MS = 3000;

// --- Long-lived owned process ----------------------------------------------

/** One owned lifetime observation. Successful exit/signal observations follow
 * output draining. Windows detects root exit on its handle and releases the job
 * before draining; cleanup errors and timeouts do not prove a complete drain. */
export type OwnedProcessClose =
  | { readonly kind: "exited"; readonly status: number }
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "spawn-error"; readonly cause: unknown }
  | { readonly kind: "cleanup-error"; readonly cause: unknown }
  | { readonly kind: "cleanup-timeout" };

export interface OwnedProcessOptions {
  readonly role: SpawnRole;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Maximum time to observe either the child `spawn` event or a spawn error. */
  readonly launchTimeoutMs: number;
}

/** A graceful stop attempt: the close observation, and whether a forced kill was
 * needed. Off Windows `escalated: false` means the process stopped on SIGTERM and
 * `escalated: true` means SIGKILL followed. Windows has no graceful stage (see
 * `safeInterrupt`): a live child is force-killed outright and reported
 * `escalated: true`; only a child already gone reports `false`.
 * A caller distinguishing a confirmed graceful stop from a force-kill needs this
 * evidence because a close observation alone cannot express the distinction. */
export type ProcessInterruption = {
  readonly close: OwnedProcessClose;
  readonly escalated: boolean;
  readonly containment?: WindowsContainment;
};

/** A directly spawned child whose pipe and process-tree lifecycle remains owned
 * by this Module. Consumers see byte streams and ordered writes, never the
 * platform child-process object. */
export interface OwnedProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  writeStdin(bytes: Uint8Array): Promise<void>;
  /** Close stdin first, then bound the wait and escalate through the process
   * tree. Repeated calls return the same close observation. */
  closeStdin(timeoutMs: number): Promise<OwnedProcessClose>;
  /** Off Windows: SIGTERM the tree, wait up to `gracefulMs` for it to close, and if
   * it does not, SIGKILL within the same bound and report `escalated: true`. On
   * Windows: terminate the contained job, or `taskkill /T /F` for a fallback,
   * at once and report `escalated: true` for a live child. Process proves cleanup,
   * never native Harness interruption. Repeated calls return the same result. */
  interrupt(gracefulMs: number): Promise<ProcessInterruption>;
  closed(): Promise<OwnedProcessClose>;
}

export type ProcessLaunchContainment =
  | { readonly kind: "contained" }
  | { readonly kind: "fallback"; readonly cause: unknown };

export type SpawnOwnedProcessResult =
  | {
      readonly ok: true;
      readonly process: OwnedProcess;
      readonly containment?: ProcessLaunchContainment;
    }
  | {
      readonly ok: false;
      readonly failure:
        | Extract<OwnedProcessClose, { kind: "spawn-error" }>
        | { readonly kind: "launch-timeout"; readonly cause: Error };
    };

/** The Process Module's owned Interface. Callers receive normalized resolution,
 * command, and long-lived process outcomes without observing a platform child. */
export interface ProcessAdapter {
  resolveExecutable(
    name: string,
    options?: ResolveExecutableOptions,
  ): ExecutableResolution;
  spawnCommand(options: SpawnOptions): Promise<SpawnResult>;
  spawnCommandSync(options: SpawnSyncOptions): SpawnSyncResult;
  spawnOwnedProcess(
    options: OwnedProcessOptions,
  ): Promise<SpawnOwnedProcessResult>;
}

/** Construct the real Node-compatible implementation behind the Process Seam. */
export function createProcessAdapter(
  options: ProcessAdapterOptions = {},
): ProcessAdapter {
  return new NodeProcessAdapter(
    guardedObserver(options),
    options.testWindowsContainmentFailure,
    options.testWindowsContainmentMemberGap,
  );
}

class NodeProcessAdapter implements ProcessAdapter {
  constructor(
    private readonly notify: Notify,
    private readonly containmentFailure?: ContainmentFailureStage,
    private readonly containmentMemberGap?: ProcessAdapterOptions["testWindowsContainmentMemberGap"],
  ) {}

  resolveExecutable(
    name: string,
    options: ResolveExecutableOptions = {},
  ): ExecutableResolution {
    return resolveExecutableWithNode(name, options, this.notify);
  }

  spawnCommand(options: SpawnOptions): Promise<SpawnResult> {
    return spawnCommandWithNode(options, this.notify);
  }

  spawnCommandSync(options: SpawnSyncOptions): SpawnSyncResult {
    return spawnCommandSyncWithNode(options, this.notify);
  }

  spawnOwnedProcess(
    options: OwnedProcessOptions,
  ): Promise<SpawnOwnedProcessResult> {
    return spawnOwnedProcess(
      options,
      this.notify,
      this.containmentFailure,
      this.containmentMemberGap,
    );
  }
}

function spawnCommandSyncWithNode(
  options: SpawnSyncOptions,
  notify: Notify,
): SpawnSyncResult {
  // Reported before the call blocks, so a hang inside it still names the child.
  const watch = new ChildWatch(notify, options.role);
  watch.starting();
  const result = spawnSync(options.executable, [...options.args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: options.env,
    input: options.input === undefined ? undefined : Buffer.from(options.input),
    maxBuffer: options.maxBufferBytes,
    windowsHide: true,
  });
  watch.returned(result);
  if (result.error !== undefined) {
    return { kind: "spawn-error", cause: result.error };
  }
  if (result.status === null) return { kind: "signal" };
  return {
    kind: "exited",
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Select contained Windows launch behind the unchanged owned Interface. */
async function spawnOwnedProcess(
  options: OwnedProcessOptions,
  notify: Notify,
  failAt: ContainmentFailureStage | undefined,
  memberGap: ProcessAdapterOptions["testWindowsContainmentMemberGap"],
): Promise<SpawnOwnedProcessResult> {
  if (process.platform !== "win32")
    return spawnOwnedProcessWithNode(options, notify);
  // Match Node's case-insensitive environment selection before both resolution
  // and CreateProcessW. Undefined keys are omitted, rather than shadowing a value.
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const key of Object.keys(withoutBunTestWorker(options.env)).sort()) {
    const value = options.env[key];
    if (value === undefined || seen.has(key.toUpperCase())) continue;
    seen.add(key.toUpperCase());
    env[key] = value;
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const hasExecutablePath =
    isAbsolute(options.executable) || /[\\/]/.test(options.executable);
  // A bare executable without a child PATH stays on the existing spawn route.
  // Do not start where.exe for a PATH lookup the child environment cannot supply.
  if (pathKey === undefined && !hasExecutablePath)
    return spawnOwnedProcessWithNode(options, notify, {
      kind: "fallback",
      cause: new Error("Windows containment target could not be resolved"),
    });
  const target = hasExecutablePath
    ? {
        kind: "found" as const,
        executable: resolve(options.cwd, options.executable),
        prefixArgs: [],
      }
    : resolveExecutableWithNode(
        options.executable,
        {
          path:
            pathKey === undefined
              ? ""
              : (env[pathKey] ?? "")
                  .split(";")
                  .map((entry) => resolve(options.cwd, entry))
                  .join(";"),
        },
        notify,
      );
  if (target.kind !== "found")
    return spawnOwnedProcessWithNode(options, notify, {
      kind: "fallback",
      cause: new Error("Windows containment target could not be resolved"),
    });
  const resolved = {
    ...options,
    executable: resolve(options.cwd, target.executable),
    args: [...target.prefixArgs, ...options.args],
    env,
  };
  const result = await launchContained(resolved, failAt, memberGap);
  if (result.kind === "fallback")
    return spawnOwnedProcessWithNode(resolved, notify, result);
  const watch = new ChildWatch(notify, options.role, { kind: "contained" });
  if (result.kind === "failed") {
    watch.failed(result.cause);
    return { ok: false, failure: { kind: "spawn-error", cause: result.cause } };
  }
  watch.spawned(result.child.pid);
  void result.child.close.then((close) => {
    if (close.kind === "exited") watch.closed(close.status, null);
    else watch.closed(null, null);
  });
  return {
    ok: true,
    containment: { kind: "contained" },
    process: new ManagedOwnedProcess(
      { kind: "contained", child: result.child },
      watch,
      "contained",
    ),
  };
}

/** Spawn a long-lived child with pipe backpressure and tree-owned cleanup. On
 * Windows, `overlapped` pipes avoid synchronous handle semantics; elsewhere
 * ordinary pipes are used. */
function spawnOwnedProcessWithNode(
  options: OwnedProcessOptions,
  notify: Notify,
  containment?: ProcessLaunchContainment,
): Promise<SpawnOwnedProcessResult> {
  const pipe: "pipe" | "overlapped" =
    process.platform === "win32" ? "overlapped" : "pipe";
  const stdio: StdioOptions = [pipe, pipe, pipe];
  let child: ChildProcess;
  try {
    child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: withoutBunTestWorker(options.env),
      stdio,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    new ChildWatch(notify, options.role).failed(error);
    return Promise.resolve({
      ok: false,
      failure: {
        kind: "spawn-error",
        cause: error,
      },
    });
  }
  const watch = watchChild(child, notify, options.role, containment);

  return new Promise((resolve) => {
    let decided = false;
    const finish = (result: SpawnOwnedProcessResult): void => {
      if (decided) return;
      decided = true;
      clearTimeout(launchTimeout);
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
      resolve(result);
    };
    const onError = (error: Error): void => {
      finish({
        ok: false,
        failure: { kind: "spawn-error", cause: error },
      });
    };
    const onSpawn = (): void => {
      finish({
        ok: true,
        ...(containment === undefined ? {} : { containment }),
        process: new ManagedOwnedProcess(
          { kind: "node", child: child as ChildProcessWithoutNullStreams },
          watch,
          containment?.kind,
        ),
      });
    };
    const launchTimeout = setTimeout(() => {
      if (decided) return;
      decided = true;
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
      // A late child error must still be observed after this function gives up
      // ownership of the launch result. Tree reaping remains best-effort here;
      // no Turn content has been submitted yet.
      child.on("error", () => {});
      watch.stopping("timeout");
      void reapTimedOutLaunch(child, watch).finally(() => {
        resolve({
          ok: false,
          failure: {
            kind: "launch-timeout",
            cause: new Error(
              `process did not emit spawn within ${options.launchTimeoutMs}ms`,
            ),
          },
        });
      });
    }, options.launchTimeoutMs);
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

async function reapTimedOutLaunch(
  child: ChildProcess,
  watch: ChildWatch,
): Promise<void> {
  const closed = new Promise<true>((resolve) =>
    child.once("close", () => resolve(true)),
  );
  try {
    killGroup(child, "SIGTERM", watch);
    if ((await settleWithin(closed, KILL_ESCALATION_MS)) === true) return;
    killGroup(child, "SIGKILL", watch);
    await settleWithin(closed, KILL_ESCALATION_MS);
  } catch {
    // The launch result remains a typed timeout. Cleanup evidence cannot replace
    // that pre-submission result, and there is no process handle safe to expose.
  }
}

type OwnedChild =
  | { readonly kind: "node"; readonly child: ChildProcessWithoutNullStreams }
  | { readonly kind: "contained"; readonly child: ContainedChild };

/** Own the shared write, interruption, and cleanup-bound policy once. The
 * private child variants supply Node events or Windows handle observations. */
class ManagedOwnedProcess implements OwnedProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  private readonly closePromise: Promise<OwnedProcessClose>;
  private shutdownPromise: Promise<OwnedProcessClose> | undefined;
  private interruptPromise: Promise<ProcessInterruption> | undefined;

  constructor(
    private readonly child: OwnedChild,
    private readonly watch: ChildWatch,
    private readonly containment?: WindowsContainment,
  ) {
    this.stdout = child.child.stdout;
    this.stderr = child.child.stderr;
    if (child.kind === "contained") {
      this.closePromise = child.child.close;
      return;
    }
    const nodeChild = child.child;
    this.closePromise = new Promise((resolve) => {
      // Once `spawn` succeeded, only `close` proves the process ended and both
      // output pipes drained. Retain a later error until that close observation,
      // but never mistake the error event itself for lifecycle completion.
      let processError: Error | undefined;
      nodeChild.on("error", (error) => {
        processError = error;
      });
      nodeChild.once("close", (code, signal) => {
        if (processError !== undefined) {
          resolve({ kind: "cleanup-error", cause: processError });
          return;
        }
        if (code === null) resolve({ kind: "signal", signal });
        else resolve({ kind: "exited", status: code });
      });
    });
  }

  writeStdin(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      let callbackComplete = false;
      let drained = true;
      const finish = (): void => {
        if (callbackComplete && drained) resolve();
      };
      const accepted = this.child.child.stdin.write(bytes, (error) => {
        if (error) {
          reject(error);
          return;
        }
        callbackComplete = true;
        finish();
      });
      if (!accepted) {
        drained = false;
        this.child.child.stdin.once("drain", () => {
          drained = true;
          finish();
        });
      }
    });
  }

  closeStdin(timeoutMs: number): Promise<OwnedProcessClose> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownPromise = this.safeShutdown(timeoutMs);
    return this.shutdownPromise;
  }

  interrupt(gracefulMs: number): Promise<ProcessInterruption> {
    if (this.interruptPromise !== undefined) return this.interruptPromise;
    this.interruptPromise = this.safeInterrupt(gracefulMs);
    return this.interruptPromise;
  }

  closed(): Promise<OwnedProcessClose> {
    return this.closePromise;
  }

  private alive(): boolean {
    return this.child.kind === "contained"
      ? this.child.child.alive()
      : alive(this.child.child);
  }

  private kill(signal: "SIGTERM" | "SIGKILL"): void {
    if (this.child.kind === "contained") {
      if (this.child.child.terminate()) this.watch.killing(signal);
    } else killGroup(this.child.child, signal, this.watch);
  }

  /** Graceful signal, bounded wait, then a forced escalation if it did not stop.
   * The two stages share `gracefulMs`: the process gets the whole bound to exit on
   * the graceful signal, and the same bound again to die once force-killed. */
  private async safeInterrupt(
    gracefulMs: number,
  ): Promise<ProcessInterruption> {
    try {
      if (process.platform === "win32") {
        // No graceful stage on Windows (#127 A6, amended 2026-09-18). Windows'
        // polite close (`taskkill` without `/F`) reaches only a window, and every
        // child this Module spawns runs `windowsHide: true`, so none can observe
        // it; a graceful wait could never change the outcome, only delay it. A
        // live child is force-killed at once and reported escalated. A contained
        // child uses job termination, a fallback uses taskkill. Native Harness
        // confirmation is separate evidence owned by the Harness Adapter.
        // A child already gone was not killed by us: not escalated.
        const live = this.alive();
        if (live) this.watch.stopping("cancellation");
        this.kill("SIGKILL");
        const forced = await settleWithin(this.closePromise, gracefulMs);
        return {
          close: forced ?? { kind: "cleanup-timeout" },
          escalated: live,
          containment: this.containment,
        };
      }
      if (this.alive()) this.watch.stopping("cancellation");
      this.kill("SIGTERM");
      const graceful = await settleWithin(this.closePromise, gracefulMs);
      if (graceful !== undefined) return { close: graceful, escalated: false };
      this.kill("SIGKILL");
      const forced = await settleWithin(this.closePromise, gracefulMs);
      return { close: forced ?? { kind: "cleanup-timeout" }, escalated: true };
    } catch (error) {
      return {
        close: { kind: "cleanup-error", cause: error },
        escalated: true,
        ...(this.containment === undefined
          ? {}
          : { containment: this.containment }),
      };
    }
  }

  private async shutdown(timeoutMs: number): Promise<OwnedProcessClose> {
    const deadline = Date.now() + timeoutMs;
    const stageTimeout = (stagesRemaining: number): number =>
      Math.max(0, Math.floor((deadline - Date.now()) / stagesRemaining));
    this.child.child.stdin.end();

    const firstWait = await settleWithin(this.closePromise, stageTimeout(3));
    if (firstWait !== undefined) return firstWait;
    // The process did not close within its share of the cleanup bound. One that
    // exited but whose pipes are still held open is not killed, so no timeout.
    if (this.alive()) this.watch.stopping("timeout");
    this.kill("SIGTERM");

    const secondWait = await settleWithin(this.closePromise, stageTimeout(2));
    if (secondWait !== undefined) return secondWait;
    this.kill("SIGKILL");

    const finalWait = await settleWithin(this.closePromise, stageTimeout(1));
    return finalWait ?? { kind: "cleanup-timeout" };
  }

  private async safeShutdown(timeoutMs: number): Promise<OwnedProcessClose> {
    try {
      return await this.shutdown(timeoutMs);
    } catch (error) {
      return {
        kind: "cleanup-error",
        cause: error,
      };
    }
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  // Unlike boundedCodexExchange (typed rejection) and AbortSignal.timeout (active abort), settleWithin only bounds observation and returns undefined.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const result = await Promise.race([promise, elapsed]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

/**
 * Spawn a resolved Command target directly (never a shell), stream its output
 * under a byte cap, and settle to a typed SpawnResult. On POSIX the child is
 * detached so it leads its own process group; a timeout or cancel aborts, and the
 * whole group is killed — `kill(-pid, SIGTERM)` on POSIX, escalating to SIGKILL
 * after a grace period, and `taskkill /T /F` outright on Windows — so a grandchild
 * holding stdout open cannot outlive its parent (D2, #21). stdin is closed so a
 * command that reads it gets EOF rather than hanging.
 */
function spawnCommandWithNode(
  options: SpawnOptions,
  notify: Notify,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    // Unlike boundedCodexExchange (typed rejection) and settleWithin (undefined observation), AbortSignal.timeout actively aborts the command process tree.
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const abort =
      options.cancelSignal !== undefined
        ? AbortSignal.any([timeoutSignal, options.cancelSignal])
        : timeoutSignal;

    const child = spawn(options.executable, [...options.args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: withoutBunTestWorker(options.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // A detached POSIX child leads its own process group, so `kill(-pid, ...)`
      // reaches every descendant. Windows has no process groups; taskkill /T walks
      // the tree instead, so detaching there would only orphan the child.
      detached: process.platform !== "win32",
    });
    const watch = watchChild(child, notify, options.role);
    // Stream stdout then stderr under a shared cap: past it, chunks are dropped and
    // a marker is appended (D3). Buffers preserve the "stdout first" ordering the
    // synchronous path had, without holding unbounded output in memory.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    const collect = (into: Buffer[], chunk: Buffer): void => {
      const remaining = options.maxCaptureBytes - captured;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        into.push(chunk.subarray(0, remaining));
        captured = options.maxCaptureBytes;
        truncated = true;
      } else {
        into.push(chunk);
        captured += chunk.length;
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));

    let escalation: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      watch.stopping(
        options.cancelSignal?.aborted ? "cancellation" : "timeout",
      );
      killGroup(child, "SIGTERM", watch);
      escalation = setTimeout(
        () => killGroup(child, "SIGKILL", watch),
        KILL_ESCALATION_MS,
      );
      escalation.unref?.();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      if (escalation !== undefined) clearTimeout(escalation);
      abort.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", () => finish({ kind: "spawn-error" }));
    // `close` fires after the process exited and its stdio streams closed, so all
    // captured output is in hand — and, with the group killed, only once a
    // grandchild holding stdout open has died too.
    child.on("close", (code) => {
      // Attribute the exit. On POSIX our kill delivers a signal (a null exit code),
      // so a real exit code proves the child exited on its own — trust it even if an
      // abort fired in the same tick, closing the natural-exit-vs-timeout race there.
      // On Windows `taskkill /F` yields exit code 1, so a killed child has a non-null
      // code; there the abort flag is the only signal that we killed it.
      const killedByUs = process.platform === "win32" || code === null;
      if (killedByUs && options.cancelSignal?.aborted) {
        return finish({ kind: "cancelled" });
      }
      if (killedByUs && timeoutSignal.aborted)
        return finish({ kind: "timeout" });
      if (code === null) return finish({ kind: "signal" });
      let text = Buffer.concat([...stdoutChunks, ...stderrChunks]);
      if (truncated) {
        text = Buffer.concat([text, Buffer.from(options.truncationMarker)]);
      }
      finish({ kind: "exited", status: code, text });
    });
  });
}

/** Bun's test coordinator marks its workers in the inherited environment. A
 * directly spawned child belongs to this Module, not to that coordinator. */
function withoutBunTestWorker(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.BUN_TEST_WORKER_ID;
  delete childEnv.JEST_WORKER_ID;
  return childEnv;
}

/** Signal a spawned child and everything under it. On POSIX the negative pid
 *  targets the whole process group (the child was detached to lead one). On
 *  Windows both signals are `taskkill /T /F`: the polite form (no `/F`) only
 *  reaches a window, and a `windowsHide: true` child has none, so a graceful
 *  request would be sent into the void (#127 A6, verified on a Windows desktop
 *  2026-09-18). A not-found error means the child had already exited between the
 *  liveness check and the kill — swallow it (D2). */
function killGroup(
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
  watch: ChildWatch,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (!alive(child)) return;
  if (process.platform === "win32") {
    killWindowsTree(pid, signal, watch);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  watch.killing(signal);
}

/** Windows cleanup for Node children, including uncontained owned fallbacks. */
function killWindowsTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  watch: ChildWatch,
): void {
  watch.killing(signal);
  const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  watch.treeKill(killer);
  killer.on("error", () => {});
}
