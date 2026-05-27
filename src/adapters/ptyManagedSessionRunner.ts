import stripAnsi from "strip-ansi";
import pty from "node-pty";

import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionLaunchError,
  ProviderSessionCleanupError,
  ProviderSessionTranscriptCaptureError,
  type ManagedProviderSessionEvent,
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

export interface UserInterruptState {
  wasRequested(): boolean;
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
  userInput?: UserInput;
  userInterrupt?: UserInterruptState;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MARKER_BUFFER_LIMIT = 8192;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const SUBMIT = "\r";
const CONTROL_CHARACTERS_EXCEPT_TRANSCRIPT_WHITESPACE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;
type PtyProviderEventInput = DistributiveOmit<
  ManagedProviderSessionEvent,
  "provider" | "source" | "structured" | "phaseId"
>;

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
      resize(columns, rows) {
        process.resize(columns, rows);
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
  const userInput = dependencies.userInput ?? process.stdin;
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
    let phaseMarkerDetected = false;
    let waitingForRepair = false;
    let settled = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;
    let activeContinuationIndex: number | null = null;
    let repairUsed = false;
    let interruptCount = 0;
    let interruptRequested = false;
    let submittedUserMessageBuffer = "";
    let providerTranscriptStopped = false;
    let providerTranscriptRemainder = "";
    let cleanupUserInputBridge = (): void => {};
    let cleanupTerminalResize = (): void => {};

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

    function rejectTranscriptCaptureFailure(error: unknown): void {
      if (settled) {
        return;
      }

      cleanupAfterValidationFailure();
      settled = true;
      rejectSession(
        new ProviderSessionTranscriptCaptureError(command.provider, error),
      );
    }

    function captureProviderTranscriptChunk(chunk: string): void {
      const onProviderOutput = input.transcript?.onProviderOutput;

      if (!onProviderOutput || providerTranscriptStopped || settled) {
        return;
      }

      const normalizedChunk = normalizeTranscriptChunk(
        providerTranscriptRemainder + chunk,
      );
      providerTranscriptRemainder = "";
      const activeCompletionMarker = getActiveCompletionMarker();
      const markerIndex =
        activeCompletionMarker === undefined
          ? -1
          : normalizedChunk.indexOf(activeCompletionMarker);
      const transcriptChunk =
        markerIndex === -1
          ? normalizedChunk
          : normalizedChunk.slice(0, markerIndex);

      if (markerIndex !== -1) {
        providerTranscriptStopped = true;
        const detectedCompletionMarker = activeCompletionMarker;

        if (detectedCompletionMarker === undefined) {
          return;
        }

        providerTranscriptRemainder = normalizedChunk.slice(
          markerIndex + detectedCompletionMarker.length,
        );
      }

      if (!transcriptChunk) {
        return;
      }

      try {
        void Promise.resolve(onProviderOutput(transcriptChunk)).catch(
          rejectTranscriptCaptureFailure,
        );
      } catch (error) {
        rejectTranscriptCaptureFailure(error);
      }
    }

    function captureAssistantMessageEvent(chunk: string): void {
      const normalizedChunk = normalizeTranscriptChunk(chunk);

      if (!normalizedChunk) {
        return;
      }

      emitProviderEvent({
        type: "assistant-message",
        content: normalizedChunk,
      });
    }

    function resumeProviderTranscriptCapture(): void {
      providerTranscriptStopped = false;
    }

    function getActiveContinuation():
      | NonNullable<ManagedProviderSessionInput["continuations"]>[number]
      | undefined {
      if (activeContinuationIndex === null) {
        return undefined;
      }

      return input.continuations?.[activeContinuationIndex];
    }

    function getActiveRepair() {
      return getActiveContinuation()?.repair ?? input.repair;
    }

    function getActiveCompletionMarker(): string | undefined {
      if (waitingForRepair) {
        return getActiveRepair()?.completionMarker;
      }

      return getActiveContinuation()?.completionMarker ?? input.initialCompletionMarker;
    }

    function getActivePhaseId(): string | undefined {
      return getActiveContinuation()?.phase?.id ?? input.phase?.id;
    }

    function emitProviderEvent(
      event: PtyProviderEventInput,
    ): void {
      const onProviderEvent = input.onProviderEvent;

      if (!onProviderEvent) {
        return;
      }

      void onProviderEvent({
        ...event,
        provider: command.provider,
        source: "pty",
        structured: false,
        phaseId: getActivePhaseId(),
      } as ManagedProviderSessionEvent);
    }

    async function validateActivePhase(): Promise<void> {
      const continuation = getActiveContinuation();

      if (continuation) {
        await continuation.validate();
        return;
      }

      await input.validate();
    }

    function captureSubmittedUserMessage(message: string): void {
      emitProviderEvent({
        type: "submitted-user-message",
        message,
      });

      const onSubmittedUserMessage = input.transcript?.onSubmittedUserMessage;

      if (!onSubmittedUserMessage || settled || providerTranscriptStopped) {
        return;
      }

      try {
        void Promise.resolve(onSubmittedUserMessage(message)).catch(
          rejectTranscriptCaptureFailure,
        );
      } catch (error) {
        rejectTranscriptCaptureFailure(error);
      }
    }

    function createResult(): ManagedProviderSessionResult {
      return {
        repairUsed,
        exitCode,
        signal,
      };
    }

    function cleanupInteractiveInput(): void {
      cleanupUserInputBridge();
      cleanupUserInputBridge = (): void => {};
    }

    function cleanupResizeListener(): void {
      cleanupTerminalResize();
      cleanupTerminalResize = (): void => {};
    }

    function cleanupSessionListeners(): void {
      cleanupInteractiveInput();
      cleanupResizeListener();
    }

    function resolveSession(result: ManagedProviderSessionResult): void {
      cleanupSessionListeners();
      resolve(result);
    }

    function rejectSession(error: unknown): void {
      cleanupSessionListeners();
      reject(error);
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
      void callback().then(resolveSession, rejectSession);
    }

    function createInterruptedError(
      interruptedExitCode: number | null,
      interruptedSignal: NodeJS.Signals | null,
    ): InterruptedProviderSessionError {
      return new InterruptedProviderSessionError({
        provider: command.provider,
        exitCode: interruptedExitCode,
        signal: interruptedSignal,
      });
    }

    function forwardInputChunk(chunk: string): void {
      let pending = "";

      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          if (pending) {
            processHandle.write(pending);
            pending = "";
          }

          processHandle.write(character);
          captureSubmittedUserMessage(submittedUserMessageBuffer);
          submittedUserMessageBuffer = "";
          continue;
        }

        if (character !== "\u0003") {
          pending += character;
          submittedUserMessageBuffer += character;
          continue;
        }

        if (pending) {
          processHandle.write(pending);
          pending = "";
        }

        interruptRequested = true;
        interruptCount += 1;

        if (interruptCount === 1) {
          processHandle.write("\u0003");
          continue;
        }

        try {
          processHandle.kill();
        } finally {
          settle(async () => {
            throw createInterruptedError(null, "SIGINT");
          });
        }
      }

      if (pending) {
        processHandle.write(pending);
      }
    }

    function setupUserInputBridge(): void {
      if (!userInput.isTTY) {
        return;
      }

      const wasRaw = userInput.isRaw === true;
      const onData = (chunk: Buffer | string): void => {
        forwardInputChunk(
          typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
      };

      userInput.setRawMode?.(true);
      userInput.resume?.();
      userInput.on("data", onData);

      cleanupUserInputBridge = () => {
        if (userInput.off) {
          userInput.off("data", onData);
        } else {
          userInput.removeListener?.("data", onData);
        }

        if (!wasRaw) {
          userInput.setRawMode?.(false);
        }

        userInput.pause?.();
      };
    }

    function setupTerminalResizeForwarding(): void {
      if (!terminal.on) {
        return;
      }

      const onResize = (): void => {
        processHandle.resize?.(
          terminal.columns ?? DEFAULT_COLUMNS,
          terminal.rows ?? DEFAULT_ROWS,
        );
      };

      terminal.on("resize", onResize);

      cleanupTerminalResize = () => {
        if (terminal.off) {
          terminal.off("resize", onResize);
        } else {
          terminal.removeListener?.("resize", onResize);
        }
      };
    }

    function startNextContinuationOrComplete(): void {
      const nextContinuationIndex =
        activeContinuationIndex === null ? 0 : activeContinuationIndex + 1;
      const nextContinuation = input.continuations?.[nextContinuationIndex];

      if (nextContinuation) {
        activeContinuationIndex = nextContinuationIndex;
        phaseMarkerDetected = false;
        waitingForRepair = false;
        rollingOutput = "";
        void Promise.resolve(nextContinuation.onStart?.())
          .then(() => {
            submitPtyPrompt(processHandle, nextContinuation.prompt);
          })
          .catch((error) => {
            settled = true;
            cleanupAfterValidationFailure();
            rejectSession(error);
          });
        return;
      }

      try {
        cleanupAfterValidOutput();
      } catch (error) {
        settled = true;
        rejectSession(error);
        return;
      }

      settled = true;
      resolveSession(createResult());
    }

    function handlePhaseCompletion(): void {
      if (phaseMarkerDetected) {
        return;
      }

      phaseMarkerDetected = true;

      void (async () => {
        try {
          await validateActivePhase();
        } catch (error: unknown) {
          const repair = getActiveRepair();

          if (!(error instanceof Error) || !repair) {
            cleanupAfterValidationFailure();
            settled = true;
            rejectSession(error);
            return;
          }

          waitingForRepair = true;
          resumeProviderTranscriptCapture();
          rollingOutput = "";
          submitPtyPrompt(processHandle, repair.renderPrompt(error));
          return;
        }

        startNextContinuationOrComplete();
      })();
    }

    function handleRepairCompletion(): void {
      const repair = getActiveRepair();

      if (!repair) {
        return;
      }

      waitingForRepair = false;
      void (async () => {
        try {
          await validateActivePhase();
        } catch (error) {
          cleanupAfterValidationFailure();
          settled = true;
          rejectSession(repair.mapFailure(error as Error));
          return;
        }

        repairUsed = true;
        startNextContinuationOrComplete();
      })();
    }

    setupUserInputBridge();
    setupTerminalResizeForwarding();
    emitProviderEvent({ type: "session-start" });

    processHandle.onData((chunk) => {
      outputSink.write(chunk);

      if (settled) {
        return;
      }

      captureProviderTranscriptChunk(chunk);
      captureAssistantMessageEvent(chunk);

      rollingOutput = (rollingOutput + stripAnsi(chunk)).slice(
        -markerBufferLimit,
      );

      if (waitingForRepair) {
        if (
          getActiveRepair() &&
          rollingOutput.includes(getActiveRepair()?.completionMarker ?? "")
        ) {
          handleRepairCompletion();
        }
        return;
      }

      const activeCompletionMarker = getActiveCompletionMarker();

      if (
        activeCompletionMarker !== undefined &&
        rollingOutput.includes(activeCompletionMarker)
      ) {
        handlePhaseCompletion();
      }
    });

    processHandle.onExit((event) => {
      exitCode = event.exitCode;
      signal = event.signal;

      if (phaseMarkerDetected || settled) {
        return;
      }

      settle(async () => {
        if (interruptRequested || dependencies.userInterrupt?.wasRequested()) {
          throw createInterruptedError(event.exitCode, event.signal);
        }

        throw new IncompleteProviderSessionError({
          provider: command.provider,
          completionMarker:
            getActiveCompletionMarker() ?? input.initialCompletionMarker,
          exitCode: event.exitCode,
          signal: event.signal,
        });
      });
    });
  });
}

function normalizeTranscriptChunk(chunk: string): string {
  return stripAnsi(chunk)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(CONTROL_CHARACTERS_EXCEPT_TRANSCRIPT_WHITESPACE, "");
}
