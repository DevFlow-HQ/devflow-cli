import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { DevFlowClock } from "./devflowState.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "critical";

export interface LogContext {
  runId?: string | null;
  stage?: string;
  err?: unknown;
  context?: Record<string, unknown>;
}

export interface Logger {
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  critical(msg: string, context?: LogContext): string;
}

export interface CreateLoggerOptions {
  repoLogsDirectory: string;
  homeLogsDirectory: string;
  clock: DevFlowClock;
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export const NoopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  critical: () => "err_noop",
};

export function createLogger(options: CreateLoggerOptions): Logger {
  const ensuredDirectories = new Set<string>();
  let startupDate: Date | undefined = options.clock.now();

  pruneOldDiagnosticLogs(options.repoLogsDirectory, startupDate);
  pruneOldDiagnosticLogs(options.homeLogsDirectory, startupDate);

  const write = (level: LogLevel, msg: string, context: LogContext = {}) => {
    const now = startupDate ?? options.clock.now();
    startupDate = undefined;
    const ref = level === "critical" ? createCorrelationRef() : undefined;
    const line = `${JSON.stringify(
      buildEntry({ level, msg, context, now, ref }),
    )}\n`;

    writeLine(
      options.repoLogsDirectory,
      line,
      now,
      ensuredDirectories,
      () =>
        writeLine(options.homeLogsDirectory, line, now, ensuredDirectories, () => {}),
    );

    return ref;
  };

  return {
    debug: (msg, context) => {
      write("debug", msg, context);
    },
    info: (msg, context) => {
      write("info", msg, context);
    },
    warn: (msg, context) => {
      write("warn", msg, context);
    },
    error: (msg, context) => {
      write("error", msg, context);
    },
    critical: (msg, context) => write("critical", msg, context) ?? "err_unknown",
  };
}

function buildEntry(input: {
  level: LogLevel;
  msg: string;
  context: LogContext;
  now: Date;
  ref?: string;
}): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    ts: input.now.toISOString(),
    level: input.level,
    runId: input.context.runId ?? null,
  };

  if (input.ref !== undefined) {
    entry.ref = input.ref;
  }

  if (input.context.stage !== undefined) {
    entry.stage = input.context.stage;
  }

  entry.msg = input.msg;

  if (
    (input.level === "error" || input.level === "critical") &&
    input.context.err !== undefined
  ) {
    entry.err = serializeError(input.context.err);
  }

  if (input.context.context !== undefined) {
    entry.context = input.context.context;
  }

  return entry;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

function writeLine(
  logsDirectory: string,
  line: string,
  now: Date,
  ensuredDirectories: Set<string>,
  onFailure: () => void,
) {
  try {
    if (!ensuredDirectories.has(logsDirectory)) {
      mkdirSync(logsDirectory, { recursive: true });
      ensuredDirectories.add(logsDirectory);
    }

    appendFileSync(join(logsDirectory, dailyLogFilename(now)), line, "utf8");
  } catch {
    onFailure();
  }
}

function dailyLogFilename(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");

  return `devflow-${year}-${month}-${day}.log`;
}

function createCorrelationRef(): string {
  return `err_${randomBytes(3).toString("hex")}`;
}

function pruneOldDiagnosticLogs(logsDirectory: string, now: Date) {
  try {
    const cutoffDay = localDayNumber(now) - 30;

    for (const filename of readdirSync(logsDirectory)) {
      const fileDay = diagnosticLogFilenameDay(filename);
      if (fileDay !== undefined && fileDay < cutoffDay) {
        unlinkSync(join(logsDirectory, filename));
      }
    }
  } catch {
    // Diagnostic logging must never surface filesystem failures to callers.
  }
}

function diagnosticLogFilenameDay(filename: string): number | undefined {
  const match = /^devflow-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(filename);
  if (match === null) {
    return undefined;
  }

  const [, year, month, day] = match;
  return utcDayNumber(Number(year), Number(month) - 1, Number(day));
}

function localDayNumber(date: Date): number {
  return utcDayNumber(date.getFullYear(), date.getMonth(), date.getDate());
}

function utcDayNumber(year: number, monthIndex: number, day: number): number {
  return Math.floor(Date.UTC(year, monthIndex, day) / 86_400_000);
}
