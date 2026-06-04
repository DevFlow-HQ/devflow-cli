import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
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

  const write = (level: LogLevel, msg: string, context: LogContext = {}) => {
    const now = options.clock.now();
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
