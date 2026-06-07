import stripAnsi from "strip-ansi";

import {
  buildCompletionMarkerMatchTrace,
  buildProviderEventTrace,
  emitAdapterTrace,
} from "./adapterTrace.js";
import {
  findMatchedCompletionMarker,
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
  ProviderSessionTranscriptCaptureError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
} from "./managedSessionAdapter.js";
import {
  startPtyControlHarness,
  type OutputSink,
  type PtyControlHarness,
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
  type TerminalDimensions,
  type UserInput,
} from "./ptyControlHarness.js";
import type { ProviderIdentity } from "./providers.js";
import { NoopLogger, type Logger } from "../logger.js";

export { nodePtySpawner } from "./ptyControlHarness.js";
export type {
  OutputSink,
  PtyProcess,
  PtySpawnOptions,
  PtySpawner,
  TerminalDimensions,
  UserInput,
} from "./ptyControlHarness.js";

export interface UserInterruptState {
  wasRequested(): boolean;
}

export interface PtyManagedSessionCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
  cleanupCommand?: string;
  markerBufferLimit?: number;
  logger?: Logger;
}

export interface PtyManagedSessionDependencies {
  ptySpawner?: PtySpawner;
  outputSink?: OutputSink;
  terminal?: TerminalDimensions;
  userInput?: UserInput;
  userInterrupt?: UserInterruptState;
}

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
  const logger = command.logger ?? NoopLogger;
  const markerBufferLimit =
    command.markerBufferLimit ?? DEFAULT_MARKER_BUFFER_LIMIT;

  return new Promise((resolve, reject) => {
    let harness: PtyControlHarness;
    let rollingOutput = "";
    let phaseMarkerDetected = false;
    let waitingForRepair = false;
    let settled = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;
    let activeContinuationIndex: number | null = null;
    let repairUsed = false;
    let matchedCompletionMarker: string | undefined;
    let abortIntentCurrent = false;
    let submittedUserMessageBuffer = "";
    let providerTranscriptStopped = false;
    let providerTranscriptRemainder = "";
    let cleanupPerformed = false;

    function cleanup(): void {
      if (cleanupPerformed) {
        return;
      }

      if (command.cleanupCommand) {
        harness.write(command.cleanupCommand);
      } else {
        harness.kill();
      }

      cleanupPerformed = true;
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

    function rejectEventCaptureFailure(error: unknown): void {
      if (settled) {
        return;
      }

      cleanupAfterValidationFailure();
      settled = true;
      rejectSession(
        new ProviderSessionEventCaptureError(command.provider, error),
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
      const matchedTranscriptMarker = findMatchedCompletionMarker(
        normalizedChunk,
        getActiveCompletionMarkerSet(),
      );
      const markerIndex =
        matchedTranscriptMarker === undefined
          ? -1
          : normalizedChunk.indexOf(matchedTranscriptMarker);
      const transcriptChunk =
        markerIndex === -1
          ? normalizedChunk
          : normalizedChunk.slice(0, markerIndex);

      if (markerIndex !== -1) {
        providerTranscriptStopped = true;
        const detectedCompletionMarker = matchedTranscriptMarker;

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
      return getActiveCompletionMarkerSet()?.completionMarker;
    }

    function getActiveCompletionMarkerSet():
      | {
          completionMarker: string;
          terminalCompletionMarker?: string;
        }
      | undefined {
      if (waitingForRepair) {
        const repairMarker = getActiveRepair()?.completionMarker;

        return repairMarker === undefined
          ? undefined
          : {
              completionMarker: repairMarker,
            };
      }

      const continuation = getActiveContinuation();

      if (continuation) {
        return {
          completionMarker: continuation.completionMarker,
        };
      }

      return {
        completionMarker: input.initialCompletionMarker,
        terminalCompletionMarker: input.initialTerminalCompletionMarker,
      };
    }

    function getActivePhaseId(): string | undefined {
      const activePhaseId =
        getActiveContinuation()?.phase?.id ??
        input.phase?.id ??
        getFallbackActivePhaseId();

      if (waitingForRepair) {
        return (
          getActiveRepair()?.phase?.id ??
          `${activePhaseId}:repair`
        );
      }

      return activePhaseId;
    }

    function getFallbackActivePhaseId(): string {
      if (activeContinuationIndex === null) {
        return "initial";
      }

      return `continuation-${activeContinuationIndex + 1}`;
    }

    async function emitProviderEvent(
      event: PtyProviderEventInput,
    ): Promise<void> {
      await emitProviderEventWithPhase(event, getActivePhaseId());
    }

    async function emitProviderEventWithPhase(
      event: PtyProviderEventInput,
      phaseId: string | undefined,
    ): Promise<void> {
      const onProviderEvent = input.onProviderEvent;
      const normalizedEvent = {
        ...event,
        provider: command.provider,
        source: "pty",
        structured: false,
        phaseId,
      } as ManagedProviderSessionEvent;

      if (!onProviderEvent) {
        return;
      }

      emitAdapterTrace(
        logger,
        buildProviderEventTrace({
          provider: command.provider,
          phaseId,
          source: "pty",
          structured: false,
          event: normalizedEvent,
        }),
      );

      try {
        await Promise.resolve(onProviderEvent(normalizedEvent));
      } catch (error) {
        rejectEventCaptureFailure(error);
      }
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
      void emitProviderEvent({
        type: "submitted-user-message",
        message,
        origin: "unknown",
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

    function emitManagedSubmittedUserMessage(message: string): void {
      void emitProviderEvent({
        type: "submitted-user-message",
        message,
        origin: "managed",
      });
    }

    function createResult(): ManagedProviderSessionResult {
      return {
        repairUsed,
        exitCode,
        signal,
        matchedCompletionMarker,
      };
    }

    function cleanupSessionListeners(): void {
      harness?.dispose();
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
      void callback().then(resolveSession, (error) => {
        rejectSession(error);
      });
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

    function recordAbortIntent(): void {
      abortIntentCurrent = true;
    }

    function clearAbortIntent(): void {
      abortIntentCurrent = false;
    }

    function observeForwardedUserInput(chunk: string): void {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          clearAbortIntent();
          captureSubmittedUserMessage(submittedUserMessageBuffer);
          submittedUserMessageBuffer = "";
          continue;
        }

        if (character === "\u0003") {
          if (abortIntentCurrent) {
            try {
              harness.kill();
            } finally {
              settle(async () => {
                throw createInterruptedError(null, "SIGINT");
              });
            }
            continue;
          }

          recordAbortIntent();
          continue;
        }

        clearAbortIntent();
        submittedUserMessageBuffer += character;
      }
    }

    function submitManagedPrompt(prompt: string): void {
      clearAbortIntent();
      submitPtyPrompt(harness, prompt);
      emitManagedSubmittedUserMessage(prompt);
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
            submitManagedPrompt(nextContinuation.prompt);
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

      void (async () => {
        await emitProviderEvent({
          type: "session-completed",
          exitCode,
          signal,
        });
        if (settled) {
          return;
        }

        settled = true;
        resolveSession(createResult());
      })();
    }

    function handlePhaseCompletion(completionMarker: string): void {
      if (phaseMarkerDetected) {
        return;
      }

      phaseMarkerDetected = true;
      matchedCompletionMarker = completionMarker;
      emitAdapterTrace(
        logger,
        buildCompletionMarkerMatchTrace({
          provider: command.provider,
          phaseId: getActivePhaseId(),
          source: "pty",
          structured: false,
          matchedMarker: completionMarker,
          isTerminalCompletionMarker:
            completionMarker === getActiveCompletionMarkerSet()?.terminalCompletionMarker,
        }),
      );

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
          phaseMarkerDetected = false;
          resumeProviderTranscriptCapture();
          rollingOutput = "";
          const repairPrompt = repair.renderPrompt(error);
          submitManagedPrompt(repairPrompt);
          return;
        }

        await emitProviderEvent({ type: "turn-completed" });
        if (settled) {
          return;
        }

        startNextContinuationOrComplete();
      })();
    }

    function handleRepairCompletion(): void {
      phaseMarkerDetected = true;
      const repair = getActiveRepair();
      const repairPhaseId = getActivePhaseId();

      if (!repair) {
        return;
      }

      void (async () => {
        try {
          await validateActivePhase();
        } catch (error) {
          cleanupAfterValidationFailure();
          settled = true;
          const mappedError = repair.mapFailure(error as Error);
          rejectSession(mappedError);
          return;
        }

        matchedCompletionMarker = repair.completionMarker;
        await emitProviderEventWithPhase(
          {
            type: "turn-completed",
          },
          repairPhaseId,
        );
        if (settled) {
          return;
        }

        waitingForRepair = false;
        repairUsed = true;
        startNextContinuationOrComplete();
      })();
    }

    harness = startPtyControlHarness(
      {
        provider: command.provider,
        executable: command.executable,
        args: command.args,
        cwd: input.workingDirectory,
        logger,
      },
      {
        onUserInput: observeForwardedUserInput,
        onOutput(chunk) {
          if (settled) {
            return;
          }

          captureProviderTranscriptChunk(chunk);

          if (settled) {
            return;
          }

          rollingOutput = (rollingOutput + stripAnsi(chunk)).slice(
            -markerBufferLimit,
          );

          if (waitingForRepair) {
            if (
              getActiveRepair() &&
              rollingOutput.includes(getActiveRepair()?.completionMarker ?? "")
            ) {
              emitAdapterTrace(
                logger,
                buildCompletionMarkerMatchTrace({
                  provider: command.provider,
                  phaseId: getActivePhaseId(),
                  source: "pty",
                  structured: false,
                  matchedMarker: getActiveRepair()?.completionMarker ?? "",
                  isTerminalCompletionMarker: false,
                }),
              );
              handleRepairCompletion();
            }
            return;
          }

          const activeCompletionMarker = findMatchedCompletionMarker(
            rollingOutput,
            getActiveCompletionMarkerSet(),
          );

          if (activeCompletionMarker !== undefined) {
            handlePhaseCompletion(activeCompletionMarker);
          }
        },
        onExit(event) {
          exitCode = event.exitCode;
          signal = event.signal;

          if (phaseMarkerDetected || settled) {
            return;
          }

          settle(async () => {
            if (
              abortIntentCurrent ||
              dependencies.userInterrupt?.wasRequested()
            ) {
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
        },
      },
      dependencies,
    );
    void emitProviderEvent({ type: "session-start" });
  });
}

function normalizeTranscriptChunk(chunk: string): string {
  return stripAnsi(chunk)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(CONTROL_CHARACTERS_EXCEPT_TRANSCRIPT_WHITESPACE, "");
}
