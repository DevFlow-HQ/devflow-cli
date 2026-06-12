import pty from "node-pty";

import {
  buildPtyExitTrace,
  buildPtySpawnTrace,
  emitAdapterTrace,
} from "./adapterTrace.js";
import { ProviderSessionLaunchError } from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";
import { NoopLogger, type Logger } from "../logger.js";

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

export interface DisposablePtyListener {
  dispose(): void;
}

export interface PtyProcess {
  onData(listener: (data: string) => void): void | DisposablePtyListener;
  onExit(
    listener: (event: {
      exitCode: number;
      signal: NodeJS.Signals | null;
    }) => void,
  ): void | DisposablePtyListener;
  write(data: string): void;
  kill(): void;
  resize?(columns: number, rows: number): void;
}

export interface PtySpawner {
  spawn(
    executable: string,
    args: string[],
    options: PtySpawnOptions,
  ): PtyProcess;
}

export interface OutputSink {
  write(chunk: string): void;
}

export interface TerminalDimensions {
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): void;
  off?(event: "resize", listener: () => void): void;
  removeListener?(event: "resize", listener: () => void): void;
}

export interface UserInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(enabled: boolean): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off?(event: "data", listener: (chunk: Buffer | string) => void): void;
  removeListener?(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): void;
  resume?(): void;
  pause?(): void;
}

export interface PtyControlHarnessCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface PtyControlHarnessDependencies {
  ptySpawner?: PtySpawner;
  outputSink?: OutputSink;
  terminal?: TerminalDimensions;
  userInput?: UserInput;
}

export interface PtyControlHarnessHandlers {
  onOutput?(chunk: string): void;
  onUserInput?(chunk: string): void;
  onExit?(event: { exitCode: number; signal: NodeJS.Signals | null }): void;
}

export interface PtyGracefulExitCommand {
  text: string;
  submitKey: string;
  submitDelayMs?: number;
}

export interface PtyControlHarnessShutdownOptions {
  command?: PtyGracefulExitCommand;
  timeoutMs: number;
}

export interface PtyControlHarnessShutdownResult {
  forced: boolean;
}

export interface PtyControlHarness {
  write(data: string): void;
  kill(): void;
  shutdown(
    options: PtyControlHarnessShutdownOptions,
  ): Promise<PtyControlHarnessShutdownResult>;
  dispose(): void;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
export const DEFAULT_GRACEFUL_EXIT_SUBMIT_DELAY_MS = 100;

export async function submitGracefulExitCommand(
  writer: Pick<PtyProcess, "write">,
  command: PtyGracefulExitCommand,
): Promise<void> {
  writer.write(command.text);
  await delay(command.submitDelayMs ?? DEFAULT_GRACEFUL_EXIT_SUBMIT_DELAY_MS);
  writer.write(command.submitKey);
}

export const nodePtySpawner: PtySpawner = {
  spawn(executable, args, options) {
    const process = pty.spawn(executable, args, {
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: options.env,
      name: "xterm-256color",
    });

    return {
      onData(listener) {
        return process.onData(listener);
      },
      onExit(listener) {
        return process.onExit((event) => {
          listener({
            exitCode: event.exitCode,
            signal: null,
          });
        });
      },
      write(data) {
        process.write(data);
      },
      kill() {
        process.kill();
      },
      resize(columns, rows) {
        process.resize(columns, rows);
      },
    };
  },
};

export function startPtyControlHarness(
  command: PtyControlHarnessCommand,
  handlers: PtyControlHarnessHandlers,
  dependencies: PtyControlHarnessDependencies = {},
): PtyControlHarness {
  const ptySpawner = dependencies.ptySpawner ?? nodePtySpawner;
  const outputSink = dependencies.outputSink ?? process.stdout;
  const terminal = dependencies.terminal ?? process.stdout;
  const userInput = dependencies.userInput ?? process.stdin;
  const logger = command.logger ?? NoopLogger;
  let processHandle: PtyProcess;

  try {
    processHandle = ptySpawner.spawn(command.executable, command.args, {
      cwd: command.cwd,
      cols: terminal.columns ?? DEFAULT_COLUMNS,
      rows: terminal.rows ?? DEFAULT_ROWS,
      ...(command.env !== undefined ? { env: command.env } : {}),
    });
    emitAdapterTrace(
      logger,
      buildPtySpawnTrace({
        provider: command.provider,
        executable: command.executable,
        argumentCount: command.args.length,
      }),
    );
  } catch (error) {
    throw new ProviderSessionLaunchError(command.provider, error);
  }

  const disposers: Array<() => void> = [];
  let disposed = false;
  let exitObserved = false;
  const exitWaiters = new Set<() => void>();

  processHandle.onExit(() => {
    exitObserved = true;

    for (const resolve of [...exitWaiters]) {
      resolve();
    }

    exitWaiters.clear();
  });

  const dataSubscription = processHandle.onData((chunk) => {
    outputSink.write(chunk);
    handlers.onOutput?.(chunk);
  });
  addDisposable(disposers, dataSubscription);

  const exitSubscription = processHandle.onExit((event) => {
    emitAdapterTrace(
      logger,
      buildPtyExitTrace({
        provider: command.provider,
        exitCode: event.exitCode,
        signal: event.signal,
      }),
    );
    handlers.onExit?.(event);
  });
  addDisposable(disposers, exitSubscription);

  if (terminal.on) {
    const onResize = (): void => {
      processHandle.resize?.(
        terminal.columns ?? DEFAULT_COLUMNS,
        terminal.rows ?? DEFAULT_ROWS,
      );
    };

    terminal.on("resize", onResize);
    disposers.push(() => {
      if (terminal.off) {
        terminal.off("resize", onResize);
      } else {
        terminal.removeListener?.("resize", onResize);
      }
    });
  }

  if (userInput.isTTY) {
    const wasRaw = userInput.isRaw === true;
    const onData = (chunk: Buffer | string): void => {
      const forwardedChunk =
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      processHandle.write(forwardedChunk);
      handlers.onUserInput?.(forwardedChunk);
    };

    userInput.setRawMode?.(true);
    userInput.resume?.();
    userInput.on("data", onData);

    disposers.push(() => {
      if (userInput.off) {
        userInput.off("data", onData);
      } else {
        userInput.removeListener?.("data", onData);
      }

      if (!wasRaw) {
        userInput.setRawMode?.(false);
      }

      userInput.pause?.();
    });
  }

  return {
    write(data) {
      processHandle.write(data);
    },
    kill() {
      processHandle.kill();
    },
    async shutdown({ command, timeoutMs }) {
      if (exitObserved) {
        return { forced: false };
      }

      if (command !== undefined) {
        try {
          await submitGracefulExitCommand(processHandle, command);
        } catch {
          // Fall through to the force-kill backstop when graceful teardown cannot be submitted.
        }
      }

      if (await waitForExit(exitWaiters, () => exitObserved, timeoutMs)) {
        return { forced: false };
      }

      processHandle.kill();
      return { forced: true };
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      for (const dispose of [...disposers].reverse()) {
        dispose();
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForExit(
  exitWaiters: Set<() => void>,
  hasExited: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let timeout: NodeJS.Timeout | undefined;

    const resolveExited = (): void => {
      exitWaiters.delete(resolveExited);

      if (timeout) {
        clearTimeout(timeout);
      }

      resolve(true);
    };

    timeout = setTimeout(() => {
      exitWaiters.delete(resolveExited);
      resolve(false);
    }, timeoutMs);

    exitWaiters.add(resolveExited);

    if (hasExited()) {
      resolveExited();
    }
  });
}

function addDisposable(
  disposers: Array<() => void>,
  subscription: void | DisposablePtyListener,
): void {
  if (subscription) {
    disposers.push(() => subscription.dispose());
  }
}
