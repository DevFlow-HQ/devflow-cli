import stripAnsi from "strip-ansi";
import pty from "node-pty";

import {
  IncompleteProviderSessionError,
  ProviderSessionCleanupError,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
}

export interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(
    listener: (event: {
      exitCode: number;
      signal: NodeJS.Signals | null;
    }) => void,
  ): void;
  write(data: string): void;
  kill(): void;
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
}

export interface PtyManagedSessionCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
  cleanupCommand?: string;
  markerBufferLimit?: number;
}

export interface PtyManagedSessionDependencies {
  ptySpawner?: PtySpawner;
  outputSink?: OutputSink;
  terminal?: TerminalDimensions;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MARKER_BUFFER_LIMIT = 8192;

export const nodePtySpawner: PtySpawner = {
  spawn(executable, args, options) {
    const process = pty.spawn(executable, args, {
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
    });

    return {
      onData(listener) {
        process.onData(listener);
      },
      onExit(listener) {
        process.onExit((event) => {
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
    };
  },
};

export async function runPtyManagedSession(
  command: PtyManagedSessionCommand,
  input: ManagedProviderSessionInput,
  dependencies: PtyManagedSessionDependencies = {},
): Promise<ManagedProviderSessionResult> {
  const ptySpawner = dependencies.ptySpawner ?? nodePtySpawner;
  const outputSink = dependencies.outputSink ?? process.stdout;
  const terminal = dependencies.terminal ?? process.stdout;
  const markerBufferLimit =
    command.markerBufferLimit ?? DEFAULT_MARKER_BUFFER_LIMIT;
  const processHandle = ptySpawner.spawn(command.executable, command.args, {
    cwd: input.workingDirectory,
    cols: terminal.columns ?? DEFAULT_COLUMNS,
    rows: terminal.rows ?? DEFAULT_ROWS,
  });

  return new Promise((resolve, reject) => {
    let rollingOutput = "";
    let markerDetected = false;
    let settled = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;

    function settle(
      callback: () => Promise<ManagedProviderSessionResult>,
    ): void {
      if (settled) {
        return;
      }

      settled = true;
      void callback().then(resolve, reject);
    }

    processHandle.onData((chunk) => {
      outputSink.write(chunk);

      if (markerDetected || settled) {
        return;
      }

      rollingOutput = (rollingOutput + stripAnsi(chunk)).slice(
        -markerBufferLimit,
      );

      if (!rollingOutput.includes(input.initialCompletionMarker)) {
        return;
      }

      markerDetected = true;
      settle(async () => {
        await input.validate();

        try {
          if (command.cleanupCommand) {
            processHandle.write(command.cleanupCommand);
          } else {
            processHandle.kill();
          }
        } catch (error) {
          throw new ProviderSessionCleanupError(command.provider, error);
        }

        return {
          repairUsed: false,
          exitCode,
          signal,
        };
      });
    });

    processHandle.onExit((event) => {
      exitCode = event.exitCode;
      signal = event.signal;

      if (markerDetected || settled) {
        return;
      }

      settle(async () => {
        throw new IncompleteProviderSessionError({
          provider: command.provider,
          completionMarker: input.initialCompletionMarker,
          exitCode: event.exitCode,
          signal: event.signal,
        });
      });
    });
  });
}
