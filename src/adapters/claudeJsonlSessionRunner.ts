import fs from "fs-extra";

import {
  createClaudeJsonlNormalizer,
  normalizeClaudeJsonlRecordForProvider,
} from "./claudeJsonlEventSource.js";
import {
  createClaudeSessionLogLocator,
  locateClaudeSessionLogForProvider,
} from "./claudeSessionLogLocator.js";
import {
  getScopedClaudeProviderHome,
  seedClaudeCredentials,
} from "./claudeProviderHome.js";
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
  type PtySpawner,
  type TerminalDimensions,
  type UserInput,
  startPtyControlHarness,
  type PtyControlHarness,
} from "./ptyControlHarness.js";
import {
  submitPtyPrompt,
  type UserInterruptState,
} from "./ptyManagedSessionRunner.js";
import type { ProviderIdentity } from "./providers.js";
import type {
  SessionLogLocator,
  SessionLogResumeLocation,
} from "./codexSessionLogLocator.js";
import type { Logger } from "../logger.js";

export interface ClaudeJsonlSessionCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
  resumeProviderSessionId?: string;
  logger?: Logger;
}

export interface ClaudeJsonlSessionDependencies {
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
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

const DEFAULT_LOCATOR_TIMEOUT_MS = 30_000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_EARLY_EXIT_DRAIN_TIMEOUT_MS = 250;

export async function runClaudeJsonlSession(
  command: ClaudeJsonlSessionCommand,
  input: ManagedProviderSessionInput,
  dependencies: ClaudeJsonlSessionDependencies = {},
): Promise<ManagedProviderSessionResult> {
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const claudeHome = getScopedClaudeProviderHome(input);
  const locator =
    dependencies.sessionLogLocator ??
    createClaudeSessionLogLocator({ claudeHome, logger: command.logger });
  const locatorTimeoutMs =
    dependencies.locatorTimeoutMs ?? DEFAULT_LOCATOR_TIMEOUT_MS;
  const firstEventTimeoutMs =
    dependencies.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const cleanupTimeoutMs =
    dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const earlyExitDrainTimeoutMs =
    dependencies.earlyExitDrainTimeoutMs ?? DEFAULT_EARLY_EXIT_DRAIN_TIMEOUT_MS;

  try {
    await seedClaudeCredentials({
      claudeConfigDirectory: claudeHome,
      environment,
      platform,
      homeDirectory: dependencies.homeDirectory,
    });
    await fs.ensureDir(claudeHome);
  } catch (error) {
    throw new ProviderSessionLaunchError(command.provider, error);
  }

  const resumeProviderSessionId = command.resumeProviderSessionId;
  let snapshot;
  let resumeLocation: SessionLogResumeLocation | undefined;
  if (resumeProviderSessionId) {
    try {
      resumeLocation = await locator.locateResumeLog(resumeProviderSessionId, {
        timeoutMs: locatorTimeoutMs,
      });
    } catch (error) {
      throw new ProviderSessionEventCaptureError(command.provider, error);
    }
  } else {
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
    const normalizer = createClaudeJsonlNormalizer();
    const pendingManagedPromptEchoes: string[] = [input.initialPrompt];

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
        throw new Error("Claude PTY is not available for prompt submission.");
      }

      submitPtyPrompt(harness, prompt);
      pendingManagedPromptEchoes.push(prompt);
      const event = {
        type: "submitted-user-message" as const,
        message: prompt,
        origin: "managed" as const,
      };
      await captureJsonlTranscript(event);
      await manager.handleEvent(event);
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

    function maybeResolve(): void {
      if (!phaseFinalized || !exitObserved || settled) {
        return;
      }

      void emitSessionCompleted().then(
        () => resolveSession(createResult()),
        rejectEventCaptureFailure,
      );
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
              `Claude PTY did not exit within ${cleanupTimeoutMs}ms after JSONL finalization.`,
            ),
          ),
        );
      }, cleanupTimeoutMs);
    }

    function markFirstEventObserved(): void {
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = undefined;
      }
    }

    async function emitAttachedSessionStart(): Promise<void> {
      const event = normalizer.synthesizeSessionStart(resumeProviderSessionId);

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
        const event = normalizeClaudeJsonlRecordForProvider({
          provider: command.provider,
          normalizer,
          record,
        });
        const classifiedEvent = classifySubmittedUserMessageOrigin(event);

        if (classifiedEvent) {
          await captureJsonlTranscript(classifiedEvent);
          await manager.handleEvent(classifiedEvent);
          markFirstEventObserved();
        }
      }
    }

    async function captureJsonlTranscript(
      event: Parameters<typeof manager.handleEvent>[0],
    ): Promise<void> {
      try {
        if (event.type === "submitted-user-message") {
          await input.transcript?.onSubmittedUserMessage?.(event.message);
          return;
        }

        if (
          event.type === "turn-completed" &&
          event.assistantMessage !== undefined
        ) {
          await input.transcript?.onProviderOutput?.(event.assistantMessage);
        }
      } catch (error) {
        throw new ProviderSessionTranscriptCaptureError(
          command.provider,
          error,
        );
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
            ...environment,
            CLAUDE_CONFIG_DIR: claudeHome,
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
          `Claude JSONL stream did not produce a usable event within ${firstEventTimeoutMs}ms.`,
        ),
      );
    }, firstEventTimeoutMs);

    void (async () => {
      const location =
        resumeLocation ??
        (await locateClaudeSessionLogForProvider({
          provider: command.provider,
          locator,
          snapshot: snapshot!,
          timeoutMs: locatorTimeoutMs,
        }));
      const eventSource = createJsonlTailEventSource({
        filePath: location.filePath,
        startOffset: isResumeLocation(location)
          ? location.startOffset
          : undefined,
      });
      activeEventSource = eventSource;

      await emitAttachedSessionStart();
      await drainRecords(eventSource);

      if (exitObserved && !phaseFinalized) {
        scheduleEarlyExitDrain();
        return;
      }

      startFileWatch(eventSource);
    })().catch(rejectEventCaptureFailure);
  });
}

function isResumeLocation(
  location:
    | Awaited<ReturnType<typeof locateClaudeSessionLogForProvider>>
    | SessionLogResumeLocation,
): location is SessionLogResumeLocation {
  return "startOffset" in location;
}
