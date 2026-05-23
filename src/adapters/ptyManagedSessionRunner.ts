import stripAnsi from "strip-ansi";
import pty from "node-pty";

import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionLaunchError,
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

export interface UserInterruptState {
  wasRequested(): boolean;
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
  userInterrupt?: UserInterruptState;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MARKER_BUFFER_LIMIT = 8192;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const SUBMIT = "\r";

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

export function submitPtyPrompt(
  processHandle: Pick<PtyProcess, "write">,
  prompt: string,
): void {
  processHandle.write(
    `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}${SUBMIT}`,
  );
}

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
  let processHandle: PtyProcess;

  try {
    processHandle = ptySpawner.spawn(command.executable, command.args, {
      cwd: input.workingDirectory,
      cols: terminal.columns ?? DEFAULT_COLUMNS,
      rows: terminal.rows ?? DEFAULT_ROWS,
    });
  } catch (error) {
    throw new ProviderSessionLaunchError(command.provider, error);
  }

  return new Promise((resolve, reject) => {
    let rollingOutput = "";
    let markerDetected = false;
    let waitingForRepair = false;
    let settled = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;

    function cleanup(): void {
      if (command.cleanupCommand) {
        processHandle.write(command.cleanupCommand);
      } else {
        processHandle.kill();
      }
    }

    function cleanupAfterValidationFailure(): void {
      try {
        cleanup();
      } catch {
        // Preserve the validation failure as the actionable error.
      }
    }

    function createResult(repairUsed: boolean): ManagedProviderSessionResult {
      return {
        repairUsed,
        exitCode,
        signal,
      };
    }

    function cleanupAfterValidOutput(): void {
      try {
        cleanup();
      } catch (error) {
        throw new ProviderSessionCleanupError(command.provider, error);
      }
    }

    function settle(
      callback: () => Promise<ManagedProviderSessionResult>,
    ): void {
      if (settled) {
        return;
      }

      settled = true;
      void callback().then(resolve, reject);
    }

    function handleInitialCompletion(): void {
      if (markerDetected) {
        return;
      }

      markerDetected = true;

      void (async () => {
        try {
          await input.validate();
        } catch (error: unknown) {
          if (!(error instanceof Error) || !input.repair) {
            cleanupAfterValidationFailure();
            settled = true;
            reject(error);
            return;
          }

          waitingForRepair = true;
          rollingOutput = "";
          submitPtyPrompt(processHandle, input.repair.renderPrompt(error));
          return;
        }

        try {
          cleanupAfterValidOutput();
        } catch (error) {
          settled = true;
          reject(error);
          return;
        }

        settled = true;
        resolve(createResult(false));
      })();
    }

    function handleRepairCompletion(): void {
      const repair = input.repair;

      if (!repair) {
        return;
      }

      waitingForRepair = false;
      settle(async () => {
        try {
          await input.validate();
        } catch (error) {
          cleanupAfterValidationFailure();
          throw repair.mapFailure(error as Error);
        }

        cleanupAfterValidOutput();
        return createResult(true);
      });
    }

    processHandle.onData((chunk) => {
      outputSink.write(chunk);

      if (settled) {
        return;
      }

      rollingOutput = (rollingOutput + stripAnsi(chunk)).slice(
        -markerBufferLimit,
      );

      if (waitingForRepair) {
        if (
          input.repair &&
          rollingOutput.includes(input.repair.completionMarker)
        ) {
          handleRepairCompletion();
        }
        return;
      }

      if (rollingOutput.includes(input.initialCompletionMarker)) {
        handleInitialCompletion();
      }
    });

    processHandle.onExit((event) => {
      exitCode = event.exitCode;
      signal = event.signal;

      if (markerDetected || settled) {
        return;
      }

      settle(async () => {
        if (dependencies.userInterrupt?.wasRequested()) {
          throw new InterruptedProviderSessionError({
            provider: command.provider,
            exitCode: event.exitCode,
            signal: event.signal,
          });
        }

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
