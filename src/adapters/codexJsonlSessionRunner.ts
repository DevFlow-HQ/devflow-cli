import fs from "fs-extra";

import {
  createCodexJsonlNormalizer,
  normalizeCodexJsonlRecordForProvider,
} from "./codexJsonlEventSource.js";
import {
  createCodexSessionLogLocator,
  getScopedCodexProviderHome,
  locateCodexSessionLogForProvider,
  type SessionLogLocator,
  type SessionLogResumeLocation,
} from "./codexSessionLogLocator.js";
import {
  createJsonlTailEventSource,
  type JsonlTailReadResult,
} from "./jsonlTailEventSource.js";
import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
  ProviderSessionLaunchError,
  ProviderSessionTranscriptCaptureError,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
} from "./managedSessionAdapter.js";
import { createPhaseManager } from "./phaseManager.js";
import {
  type OutputSink,
  type PtyControlHarness,
  type PtySpawner,
  type TerminalDimensions,
  type UserInput,
  startPtyControlHarness,
} from "./ptyControlHarness.js";
import {
  submitPtyPrompt,
  type UserInterruptState,
} from "./ptyManagedSessionRunner.js";
import type { ProviderIdentity } from "./providers.js";
import type { Logger } from "../logger.js";

export interface CodexJsonlSessionCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
  resumeProviderSessionId?: string;
  logger?: Logger;
}

export interface CodexJsonlSessionDependencies {
  ptySpawner?: PtySpawner;
  outputSink?: OutputSink;
  terminal?: TerminalDimensions;
  userInput?: UserInput;
  userInterrupt?: UserInterruptState;
  sessionLogLocator?: SessionLogLocator;
  locatorTimeoutMs?: number;
  firstEventTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  earlyExitDrainTimeoutMs?: number;
}

const DEFAULT_LOCATOR_TIMEOUT_MS = 30_000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_EARLY_EXIT_DRAIN_TIMEOUT_MS = 250;

export async function runCodexJsonlSession(
  command: CodexJsonlSessionCommand,
  input: ManagedProviderSessionInput,
  dependencies: CodexJsonlSessionDependencies = {},
): Promise<ManagedProviderSessionResult> {
  const codexHome = getScopedCodexProviderHome(input);
  const locator =
    dependencies.sessionLogLocator ??
    createCodexSessionLogLocator({ codexHome, logger: command.logger });
  const locatorTimeoutMs =
    dependencies.locatorTimeoutMs ?? DEFAULT_LOCATOR_TIMEOUT_MS;
  const firstEventTimeoutMs =
    dependencies.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const cleanupTimeoutMs =
    dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const earlyExitDrainTimeoutMs =
    dependencies.earlyExitDrainTimeoutMs ?? DEFAULT_EARLY_EXIT_DRAIN_TIMEOUT_MS;
  await fs.ensureDir(codexHome);

  const resumeProviderSessionId = command.resumeProviderSessionId;
  let snapshot;
  if (!resumeProviderSessionId) {
    try {
      snapshot = await locator.snapshot();
    } catch (error) {
      throw new ProviderSessionEventCaptureError(command.provider, error);
    }
  }

  return new Promise((resolve, reject) => {
    let harness: PtyControlHarness | undefined;
    let settled = false;
    let phaseFinalized = false;
    let exitObserved = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;
    let firstEventTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let earlyExitDrainTimer: NodeJS.Timeout | undefined;
    let activeEventSource:
      | ReturnType<typeof createJsonlTailEventSource>
      | undefined;
    const normalizer = createCodexJsonlNormalizer();
    const pendingManagedPromptEchoes: string[] = [];

    const manager = createPhaseManager({
      provider: command.provider,
      source: "jsonl",
      structured: true,
      logger: command.logger,
      input,
      submitPrompt(prompt) {
        return submitManagedPrompt(prompt);
      },
      finalize() {
        phaseFinalized = true;
        maybeResolve();
        armCleanupTimer();
      },
    });

    async function submitManagedPrompt(prompt: string): Promise<void> {
      if (!harness) {
        throw new Error("Codex PTY is not available for prompt submission.");
      }

      submitPtyPrompt(harness, prompt);
      pendingManagedPromptEchoes.push(prompt);
      await manager.handleEvent({
        type: "submitted-user-message",
        message: prompt,
        origin: "managed",
      });
    }

    function clearTimers(): void {
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = undefined;
      }

      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = undefined;
      }

      if (earlyExitDrainTimer) {
        clearTimeout(earlyExitDrainTimer);
        earlyExitDrainTimer = undefined;
      }
    }

    function resolveSession(result: ManagedProviderSessionResult): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      harness?.dispose();
      void activeEventSource?.close();
      resolve(result);
    }

    function rejectSession(error: unknown): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      void activeEventSource?.close();
      try {
        harness?.kill();
      } catch {
        // Preserve the original failure.
      }
      harness?.dispose();
      reject(error);
    }

    function rejectEventCaptureFailure(error: unknown): void {
      if (error instanceof ProviderSessionTranscriptCaptureError) {
        rejectSession(error);
        return;
      }

      rejectSession(
        error instanceof ProviderSessionEventCaptureError
          ? error
          : new ProviderSessionEventCaptureError(command.provider, error),
      );
    }

    function createResult(): ManagedProviderSessionResult {
      return {
        repairUsed: manager.repairUsed(),
        exitCode,
        signal,
        matchedCompletionMarker: manager.matchedCompletionMarker(),
      };
    }

    function maybeResolve(): void {
      if (!phaseFinalized || !exitObserved || settled) {
        return;
      }

      void emitSessionCompleted().then(
        () => resolveSession(createResult()),
        rejectEventCaptureFailure,
      );
    }

    function getActiveCompletionMarker(): string {
      const state = manager.getState();

      if (state.type === "continuation") {
        return (
          input.continuations?.[state.index]?.completionMarker ??
          input.initialCompletionMarker
        );
      }

      if (state.type === "repair") {
        const continuation =
          state.base.type === "continuation"
            ? input.continuations?.[state.base.index]
            : undefined;
        const repair = continuation?.repair ?? input.repair;

        return repair?.completionMarker ?? input.initialCompletionMarker;
      }

      return input.initialCompletionMarker;
    }

    function rejectIncompleteSession(): void {
      rejectSession(
        new IncompleteProviderSessionError({
          provider: command.provider,
          completionMarker: getActiveCompletionMarker(),
          exitCode,
          signal,
        }),
      );
    }

    function markFirstEventObserved(): void {
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = undefined;
      }
    }

    async function emitSessionCompleted(): Promise<void> {
      await input.onProviderEvent?.({
        type: "session-completed",
        provider: command.provider,
        source: "jsonl",
        structured: true,
        exitCode,
        signal,
      });
    }

    function armCleanupTimer(): void {
      if (exitObserved || cleanupTimer || settled) {
        return;
      }

      cleanupTimer = setTimeout(() => {
        rejectSession(
          new ProviderSessionCleanupError(
            command.provider,
            new Error(
              `Codex PTY did not exit within ${cleanupTimeoutMs}ms after JSONL finalization.`,
            ),
          ),
        );
      }, cleanupTimeoutMs);
    }

    async function emitAttachedSessionStart(): Promise<void> {
      const event = normalizer.synthesizeSessionStart();

      if (event) {
        await manager.handleEvent(event);
      }
    }

    async function drainRecords(
      eventSource: ReturnType<typeof createJsonlTailEventSource>,
    ): Promise<void> {
      const result = await eventSource.readNewRecords();
      await handleReadResult(result);
    }

    async function handleReadResult(
      result: JsonlTailReadResult,
    ): Promise<void> {
      for (const record of result.records) {
        const event = normalizeCodexJsonlRecordForProvider({
          provider: command.provider,
          normalizer,
          record,
        });
        const classifiedEvent = classifySubmittedUserMessageOrigin(event);

        if (classifiedEvent) {
          await manager.handleEvent(classifiedEvent);
          markFirstEventObserved();
        } else if (isNativeSessionMetaRecord(record)) {
          markFirstEventObserved();
        }
      }
    }

    function classifySubmittedUserMessageOrigin(
      event: Parameters<typeof manager.handleEvent>[0] | undefined,
    ): Parameters<typeof manager.handleEvent>[0] | undefined {
      if (event?.type !== "submitted-user-message") {
        return event;
      }

      const pendingIndex = pendingManagedPromptEchoes.indexOf(event.message);

      if (pendingIndex !== -1) {
        pendingManagedPromptEchoes.splice(pendingIndex, 1);
        return undefined;
      }

      return {
        ...event,
        origin: "human",
      };
    }

    function isNativeSessionMetaRecord(
      record: unknown,
    ): record is { type: "session_meta"; payload: { id: string } } {
      return (
        typeof record === "object" &&
        record !== null &&
        "type" in record &&
        record.type === "session_meta" &&
        "payload" in record &&
        typeof record.payload === "object" &&
        record.payload !== null &&
        "id" in record.payload &&
        typeof record.payload.id === "string"
      );
    }

    function startFileWatch(
      eventSource: ReturnType<typeof createJsonlTailEventSource>,
    ): void {
      if (settled || manager.isFinalized()) {
        return;
      }

      eventSource.watch(
        async (result) => {
          if (settled || manager.isFinalized()) {
            return;
          }

          await handleReadResult(result);
        },
        rejectEventCaptureFailure,
      );
    }

    function scheduleEarlyExitDrain(): void {
      if (phaseFinalized || settled || earlyExitDrainTimer) {
        return;
      }

      earlyExitDrainTimer = setTimeout(() => {
        if (phaseFinalized || settled) {
          return;
        }

        rejectIncompleteSession();
      }, earlyExitDrainTimeoutMs);
    }

    try {
      harness = startPtyControlHarness(
        {
          provider: command.provider,
          executable: command.executable,
          args: command.args,
          cwd: input.workingDirectory,
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
          },
          logger: command.logger,
        },
        {
          onExit(event) {
            exitObserved = true;
            exitCode = event.exitCode;
            signal = event.signal;

            if (dependencies.userInterrupt?.wasRequested()) {
              rejectSession(
                new InterruptedProviderSessionError({
                  provider: command.provider,
                  exitCode,
                  signal,
                }),
              );
              return;
            }

            if (!phaseFinalized) {
              if (activeEventSource) {
                void drainRecords(activeEventSource)
                  .then(() => {
                    if (phaseFinalized) {
                      maybeResolve();
                      return;
                    }

                    scheduleEarlyExitDrain();
                  })
                  .catch(rejectEventCaptureFailure);
                return;
              }

              scheduleEarlyExitDrain();
              return;
            }

            maybeResolve();
          },
        },
        {
          ptySpawner: dependencies.ptySpawner,
          outputSink: dependencies.outputSink,
          terminal: dependencies.terminal,
          userInput: dependencies.userInput,
        },
      );
    } catch (error) {
      rejectSession(
        error instanceof ProviderSessionLaunchError
          ? error
          : new ProviderSessionLaunchError(command.provider, error),
      );
      return;
    }

    firstEventTimer = setTimeout(() => {
      rejectEventCaptureFailure(
        new Error(
          `Codex JSONL stream did not produce a usable event within ${firstEventTimeoutMs}ms.`,
        ),
      );
    }, firstEventTimeoutMs);

    void (async () => {
      const location = resumeProviderSessionId
        ? await locateResumeLogForProvider(resumeProviderSessionId)
        : await locateCodexSessionLogForProvider({
            provider: command.provider,
            locator,
            snapshot: snapshot!,
            timeoutMs: locatorTimeoutMs,
          });
      const eventSource = createJsonlTailEventSource({
        filePath: location.filePath,
        startOffset: isResumeLocation(location)
          ? location.startOffset
          : undefined,
      });
      activeEventSource = eventSource;

      await emitAttachedSessionStart();
      await submitManagedPrompt(input.initialPrompt);
      await drainRecords(eventSource);

      if (exitObserved && !phaseFinalized) {
        scheduleEarlyExitDrain();
        return;
      }

      startFileWatch(eventSource);
    })().catch(rejectEventCaptureFailure);
  });

  async function locateResumeLogForProvider(providerSessionId: string) {
    try {
      return await locator.locateResumeLog(providerSessionId);
    } catch (error) {
      throw new ProviderSessionEventCaptureError(command.provider, error);
    }
  }
}

function isResumeLocation(
  location:
    | Awaited<ReturnType<typeof locateCodexSessionLogForProvider>>
    | SessionLogResumeLocation,
): location is SessionLogResumeLocation {
  return "startOffset" in location;
}
