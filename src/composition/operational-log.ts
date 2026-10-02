import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { translateCause } from "../harness/harness.js";
import {
  resolveHostContext,
  SECANT_LOG_DIR_ENV,
  type LogClock,
  type WiringOverrides,
} from "./wiring.js";

// The operational log (#318, spec #313): the maintainer's private, local JSONL
// record of one Secant invocation. Composition owns the sink — Pino, its
// configuration, the file, the Secant invocation id, and the single log-failure
// fallback — and no Module below composition imports Pino or this file. It is
// never Run truth, and the Projection never reads it.
//
// Pino writes through a synchronous destination with no transport and no worker
// thread: on the spec's Linux probe the asynchronous destination wrote nothing in
// a compiled binary that exits at once, and the file transport hung it. The file
// is opened here through `node:fs`, owner-only, so composition owns its lifetime
// and closes it synchronously.
//
// Each record is built from an allowlist of semantic fields; Pino's named-field
// redaction below is a second layer, never the control.

/** Which client the Secant invocation ran. */
type ClientKind = "tui" | "headless";

/** One Secant invocation's log, as its client entry holds it. */
export interface OperationalLog {
  /** The active file, or undefined once logging is disabled for the Secant
   *  invocation. */
  file(): string | undefined;
  /** Writes the failure record, its cause translated safely, and flushes. Only
   *  the first call writes: the TUI records a render failure before it drains
   *  live Runs, and the guard's own call then finds it written. */
  fatal(error: unknown): void;
  /** Writes the invocation-end record, flushes, and closes the file. Only the
   *  first call writes: the signal path ends the log before it re-raises. */
  end(exitStatus: number, signal?: NodeJS.Signals): void;
}

// The second layer: named fields no record should carry, censored if one ever
// does. The allowlist of fields each record is built from is the control.
const REDACTED_FIELDS = [
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
].flatMap((name) => [name, `*.${name}`]);

const PRODUCTION_CLOCK: LogClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
};

interface StartOptions {
  readonly client: ClientKind;
  readonly folder: string;
  readonly version: string;
  readonly platform: string;
  readonly clock: LogClock;
  /** The one fallback channel for a log-failure notice. */
  readonly notify: (text: string) => void;
}

/** Opens the Secant invocation's file and writes its start record. A failure to
 *  open or write is reported once through `notify` and disables logging; it never
 *  throws, so it cannot change an outcome or exit code. */
function startOperationalLog(options: StartOptions): OperationalLog {
  const { client, folder, version, platform, clock, notify } = options;
  const started = clock.monotonic();
  const invocationId = randomUUID();
  // A sortable UTC timestamp with no colons (Windows forbids them) and the PID.
  const name = `${clock.now().toISOString().replace(/[:.]/g, "-")}-${process.pid}.jsonl`;
  const path = join(folder, name);

  let fd: number | undefined;
  let logger: Logger | undefined;
  let destination: ReturnType<typeof pino.destination> | undefined;
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
    level: "info" | "fatal",
    record: Readonly<Record<string, unknown>>,
  ) => {
    if (!enabled || ended || logger === undefined) return;
    try {
      logger[level](record);
    } catch (error) {
      disable(error);
    }
  };
  // Every write is already synchronous, so this forces the bytes to disk. It
  // never runs after a failed write: sonic-boom's flushSync retries a buffered
  // write forever on a non-EAGAIN error.
  const flush = () => {
    if (!enabled || destination === undefined) return;
    try {
      destination.flushSync();
    } catch (error) {
      disable(error);
    }
  };

  try {
    // Owner-only where the OS supports it; Windows ignores the modes.
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    fd = openSync(path, "a", 0o600);
    const stream = pino.destination({ fd, sync: true });
    // A synchronous write failure is emitted here, inside the write call.
    stream.on("error", disable);
    destination = stream;
    logger = pino(
      {
        level: "info",
        // Replaces Pino's default base: no hostname, and the PID once, below.
        base: { invocationId },
        timestamp: () => `,"time":"${clock.now().toISOString()}"`,
        formatters: { level: (label) => ({ level: label }) },
        redact: { paths: REDACTED_FIELDS, censor: "[redacted]" },
      },
      stream,
    );
  } catch (error) {
    disable(error);
  }

  write("info", {
    event: "invocation-start",
    client,
    version,
    platform,
    pid: process.pid,
  });

  return {
    file: () => (enabled ? path : undefined),
    fatal(error) {
      if (failed) return;
      failed = true;
      write("fatal", {
        event: "invocation-failure",
        cause: translateCause(error),
      });
      flush();
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
      flush();
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
  body: (log: OperationalLog) => Promise<number>,
): Promise<number> {
  const context = resolveHostContext(overrides);
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
    clock: overrides.logSink?.clock ?? PRODUCTION_CLOCK,
    notify: (text) => (holding ? held.push(text) : stderr(text)),
  });
  active = log;
  const release = () => {
    holding = false;
    for (const text of held.splice(0)) stderr(text);
  };
  let status: number;
  try {
    status = await body(log);
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
