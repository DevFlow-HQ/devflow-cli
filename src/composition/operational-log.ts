import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  statSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Problem } from "../application/projection-port.js";
import { translateCause, type SafeCause } from "../harness/harness.js";
import {
  resolveHostContext,
  SECANT_LOG_DIR_ENV,
  type LogClock,
  type WiringOverrides,
} from "./wiring.js";

// The operational log (#318, spec #313): the maintainer's private, local JSONL
// record of one Secant invocation. Composition owns the writer, the file, the
// Secant invocation id, and the single log-failure fallback. It is never Run
// truth, and the Projection never reads it.
//
// The writer surface is frozen by spec: one file per invocation, no rotation,
// transport, or worker. Builtin serialization and synchronous writes keep every
// record on disk before blocking work or termination (#328).
// Each record is built from an allowlist of semantic fields; the named-field
// scrub below is a second layer, never the control.

/** Which client the Secant invocation ran: a shell surface, or a standalone
 *  runner program (`runner-log.ts`). */
type ClientKind = "tui" | "headless" | "runner";

/** One lifecycle record an observer mapping built: the event name and the
 *  allowlisted semantic fields it copied one by one, never a caller's object
 *  passed through. */
export interface OperationalRecord {
  readonly event: string;
  readonly [field: string]:
    | string
    | number
    | boolean
    | SafeCause
    | readonly string[]
    | readonly Readonly<Record<string, string>>[];
}

// The detail checkpoints (#325): each Preflight check, each Run Store write Run
// execution makes, and each Harness handshake step (a phase record carrying a
// `step`). Their owners report them every time; mapped to `debug`, they are
// written only when the detail switch is on.
const DETAIL_EVENTS = new Set([
  "preflight-check-start",
  "preflight-check-settle",
  "store-write-start",
  "store-write-end",
]);

/** Each event's level, mapped here so no observer chooses one: a detail
 *  checkpoint is debug; a failed Harness phase, an unclean Harness cleanup, a
 *  not-ready Harness qualification, a child that never ran, timed out, or
 *  needed a force kill, initial-preparation or invocation cleanup failures,
 *  unresolved preparation cleanup, and a failed runner scenario or stage warn;
 *  every other record is info. */
function recordLevel(record: OperationalRecord): "debug" | "info" | "warn" {
  if (DETAIL_EVENTS.has(record.event) || "step" in record) return "debug";
  switch (record.event) {
    case "turn-event-refused":
    case "child-spawn-error":
    case "child-timeout":
    case "child-kill-escalation":
      return "warn";
    case "qualification-result":
      return record.status === "not-ready" ? "warn" : "info";
    case "harness-phase-end":
      return record.status === "failed" ? "warn" : "info";
    case "harness-preparation-failure":
    case "harness-preparation-cleanup-failure":
    case "invocation-cleanup-failure":
      return "warn";
    case "harness-preparation-cleanup":
      return record.status === "closed" ? "info" : "warn";
    case "harness-cleanup":
      return record.status === "clean" ? "info" : "warn";
    case "runner-scenario-end":
    case "runner-stage-end":
      return record.status === "failed" ? "warn" : "info";
    default:
      return "info";
  }
}

/** One Secant invocation's log, as its client entry holds it. */
export interface OperationalLog {
  /** The active file, or undefined once logging is disabled for the Secant
   *  invocation. */
  file(): string | undefined;
  /** Writes one lifecycle record. The level follows from the record's event,
   *  never the caller (`recordLevel`). Like every write, it stops silently after
   *  `end` or a log failure. */
  record(record: OperationalRecord): void;
  /** Writes the failure record synchronously, its cause translated safely. Only
   *  the first call writes: the TUI records a render failure before it drains
   *  live Runs, and the guard's own call then finds it written. */
  fatal(error: unknown): void;
  /** Writes the invocation-end record synchronously and closes the file. Only the
   *  first call writes: the signal path ends the log before it re-raises. */
  end(exitStatus: number, signal?: NodeJS.Signals): void;
}

// The second layer: named fields no record should carry, censored if one ever
// does. The allowlist of fields each record is built from is the control.
const REDACTED_FIELDS = new Set([
  "prompt",
  "text",
  "input",
  "args",
  "argv",
  "env",
  "token",
  "secret",
  "password",
  "authorization",
]);

const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LOG_FILE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+\.jsonl$/;

/** Startup housekeeping, separate from log writes: only matching regular files
 *  strictly older than 30 days are removed, without following links or recursing.
 *  An unreadable folder or a failed stat/delete is silent and retried next startup. */
function pruneOperationalLogs(folder: string, now: Date): void {
  const cutoff = now.getTime() - LOG_RETENTION_MS;
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!LOG_FILE_NAME.test(entry)) continue;
    const path = join(folder, entry);
    try {
      const file = lstatSync(path);
      if (file.isFile() && file.mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // A locked/unreadable file or a racing delete never changes startup.
    }
  }
}

interface StartOptions {
  readonly client: ClientKind;
  readonly folder: string;
  readonly version: string;
  readonly platform: string;
  readonly clock: LogClock;
  /** Whether detail records are written: detail-off drops them before reading
   *  the clock or serializing any fields. */
  readonly detail: boolean;
  /** The one fallback channel for a log-failure notice. */
  readonly notify: (text: string) => void;
}

/** Opens the Secant invocation's file and writes its start record. A failure to
 *  open or write is reported once through `notify` and disables logging; it never
 *  throws, so it cannot change an outcome or exit code. */
function startOperationalLog(options: StartOptions): OperationalLog {
  const { client, folder, version, platform, clock, detail, notify } = options;
  const started = clock.monotonic();
  const invocationId = randomUUID();
  // A sortable UTC timestamp with no colons (Windows forbids them) and the PID.
  const name = `${clock.now().toISOString().replace(/[:.]/g, "-")}-${process.pid}.jsonl`;
  const path = join(folder, name);

  let fd: number | undefined;
  let enabled = true;
  let ended = false;
  let failed = false;

  const close = () => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      // Already closed or never usable: nothing more to release.
    }
    fd = undefined;
  };
  const disable = (error: unknown) => {
    if (!enabled) return;
    enabled = false;
    close();
    const code = translateCause(error).code;
    notify(
      `Notice [operational-log-unavailable]: Secant could not write its operational log${code === undefined ? "" : ` (${code})`}, so the rest of this Secant invocation is not logged.\n`,
    );
    notify(
      `Remediation: Make ${folder} writable, or set ${SECANT_LOG_DIR_ENV} to a writable folder.\n`,
    );
  };
  const write = (
    level: "debug" | "info" | "warn" | "fatal",
    record: Readonly<Record<string, unknown>>,
  ) => {
    if (!enabled || ended || fd === undefined || (level === "debug" && !detail))
      return;
    try {
      const line = JSON.stringify(
        { level, time: clock.now().toISOString(), invocationId, ...record },
        (key, value: unknown) =>
          REDACTED_FIELDS.has(key) ? "[redacted]" : value,
      );
      const bytes = Buffer.from(`${line}\n`, "utf8");
      // A short write advances through this finite record. Zero progress or an
      // error disables logging; no failed write is retried or left to flush.
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written === 0)
          throw new Error("Operational log write made no progress");
        offset += written;
      }
    } catch (error) {
      disable(error);
    }
  };

  // Prune before opening: the new file's real mtime can be stale against a
  // future injected clock. Prune failures never disable logging or add a notice.
  pruneOperationalLogs(folder, clock.now());
  try {
    // Owner-only where the OS supports it; Windows ignores the modes.
    mkdirSync(folder, {
      recursive: true,
      mode: process.platform === "win32" ? undefined : 0o700,
    });
    fd = openSync(path, "a", process.platform === "win32" ? undefined : 0o600);
  } catch (error) {
    disable(error);
  }

  write("info", {
    event: "invocation-start",
    client,
    version,
    platform,
    pid: process.pid,
    ...(detail ? { detail: true } : {}),
  });

  return {
    file: () => (enabled ? path : undefined),
    record: (record) => write(recordLevel(record), record),
    fatal(error) {
      if (failed) return;
      failed = true;
      write("fatal", {
        event: "invocation-failure",
        cause: translateCause(error),
      });
    },
    end(exitStatus, signal) {
      if (ended) return;
      write("info", {
        event: "invocation-end",
        client,
        version,
        platform,
        exitStatus,
        ...(signal !== undefined ? { signal } : {}),
        elapsedMs: Math.round(clock.monotonic() - started),
      });
      ended = true;
      close();
    },
  };
}

// The active Secant invocation's log: one per process, read by the CLI host's
// fatal catch through `describeFatal`.
let active: OperationalLog | undefined;

/** Runs one Secant invocation of `client` under its operational log: starts the
 *  sink before `body` wires anything, writes the end record with the exit status
 *  `body` returns, and on a throw writes and flushes the failure record before
 *  rethrowing to the CLI host. The TUI's log-failure notices wait until `body`
 *  has restored the terminal; headless prints them on stderr at once, never on
 *  stdout. */
export async function runSecantInvocation(
  client: ClientKind,
  overrides: WiringOverrides,
  body: (
    log: OperationalLog,
    startupNotices: readonly Problem[],
  ) => Promise<number>,
): Promise<number> {
  const context = resolveHostContext(overrides);
  const startupNotices: Problem[] = [];
  if (process.platform !== "win32" && context.hostPlatform !== "windows") {
    try {
      mkdirSync(context.secantHome, { recursive: true, mode: 0o700 });
      (overrides.chmodHome ?? chmodSync)(context.secantHome, 0o700);
      if ((statSync(context.secantHome).mode & 0o777) !== 0o700) {
        throw new Error(
          "The filesystem did not apply owner-only home permissions.",
        );
      }
    } catch (cause) {
      startupNotices.push({
        code: "secant-home-not-private",
        explanation:
          "Secant could not make its home owner-only; other local users may be able to read your Runs.",
        remediation:
          "Use a SECANT_HOME you own on a filesystem that supports POSIX permissions.",
        possibleEffects: "none",
        cause,
      });
    }
  }
  const stderr =
    overrides.logSink?.stderr ??
    ((text: string) => void process.stderr.write(text));
  const held: string[] = [];
  let holding = client === "tui";
  const log = startOperationalLog({
    client,
    folder: context.logFolder,
    version: context.engineVersion,
    // Secant's platform name; an unsupported OS has none, so its own name stands.
    platform: context.hostPlatform ?? process.platform,
    clock: context.logClock,
    detail: context.logDetail,
    notify: (text) => (holding ? held.push(text) : stderr(text)),
  });
  active = log;
  const release = () => {
    holding = false;
    for (const text of held.splice(0)) stderr(text);
  };
  let status: number;
  try {
    status = await body(log, startupNotices);
  } catch (error) {
    release();
    log.fatal(error);
    log.end(1);
    throw error;
  }
  release();
  log.end(status);
  return status;
}

/** The CLI host's fatal stderr text. When the failure record reached the active
 *  operational log, the message names that file and leaves the stack there;
 *  otherwise the stack is the only record, so it is printed. */
export function describeFatal(error: unknown): string {
  const file = active?.file();
  if (file === undefined) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    return `${message}\n`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message}\nThe operational log for this Secant invocation is at ${file}\n`;
}
