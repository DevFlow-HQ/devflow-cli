import fs from "fs-extra";

import {
  createCodexJsonlNormalizer,
  normalizeCodexJsonlRecordForProvider,
} from "./codexJsonlEventSource.js";
import {
  createCodexSessionLogLocator,
  locateCodexSessionLogForProvider,
  type SessionLogLocator,
  type SessionLogResumeLocation,
} from "./codexSessionLogLocator.js";
import {
  getScopedCodexProviderHome,
  seedCodexCredentials,
} from "./codexProviderHome.js";
import {
  createJsonlTailEventSource,
  type JsonlTailEventSource,
  type JsonlTailEventSourceOptions,
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
  type PtyGracefulExitCommand,
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
  gracefulExitCommand?: PtyGracefulExitCommand;
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
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  jsonlEventSourceFactory?: (
    options: JsonlTailEventSourceOptions,
  ) => JsonlTailEventSource;
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
  const environment = dependencies.environment ?? process.env;
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
  const jsonlEventSourceFactory =
    dependencies.jsonlEventSourceFactory ?? createJsonlTailEventSource;

  try {
    await seedCodexCredentials({
      codexHome,
      environment,
      homeDirectory: dependencies.homeDirectory,
    });
    await fs.ensureDir(codexHome);
  } catch (error) {
    throw new ProviderSessionLaunchError(command.provider, error);
  }

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
    let successSettlementStarted = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;
    let firstEventTimer: NodeJS.Timeout | undefined;
    let earlyExitDrainTimer: NodeJS.Timeout | undefined;
    let activeEventSource: JsonlTailEventSource | undefined;
    let postExitDrainActive = false;
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

        if (exitObserved) {
          maybeResolve();
          return;
        }

        settleSuccess(async () => {
          if (!harness) {
            throw new Error("Codex PTY is not available for cleanup.");
          }

          try {
            await harness.shutdown({
              command: command.gracefulExitCommand,
              timeoutMs: cleanupTimeoutMs,
            });
          } catch (error) {
            throw new ProviderSessionCleanupError(command.provider, error);
          }

          await emitSessionCompleted();
          return createResult();
        });
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
      if (harness && !exitObserved && !successSettlementStarted) {
        void harness
          .shutdown({
            command: command.gracefulExitCommand,
            timeoutMs: cleanupTimeoutMs,
          })
          .catch(() => {});
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
      if (!phaseFinalized || !exitObserved) {
        return;
      }

      settleSuccess(async () => {
        await emitSessionCompleted();
        return createResult();
      });
    }

    function settleSuccess(
      callback: () => Promise<ManagedProviderSessionResult>,
    ): void {
      if (settled || successSettlementStarted) {
        return;
      }

      successSettlementStarted = true;
      void callback().then(resolveSession, rejectSession);
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

    async function emitAttachedSessionStart(): Promise<void> {
      const event = normalizer.synthesizeSessionStart();

      if (event) {
        await manager.handleEvent(event);
      }
    }

    async function drainRecords(eventSource: JsonlTailEventSource): Promise<void> {
      const result = await eventSource.readNewRecords();

      if (settled) {
        return;
      }

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

    function startFileWatch(eventSource: JsonlTailEventSource): void {
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

    function startPostExitDrainLoop(): void {
      if (phaseFinalized || settled || earlyExitDrainTimer) {
        return;
      }

      earlyExitDrainTimer = setTimeout(() => {
        if (phaseFinalized || settled) {
          return;
        }

        rejectIncompleteSession();
      }, earlyExitDrainTimeoutMs);

      runPostExitDrainLoop();
    }

    function runPostExitDrainLoop(): void {
      if (postExitDrainActive || settled || phaseFinalized) {
        return;
      }

      postExitDrainActive = true;
      void (async () => {
        while (!settled && !phaseFinalized && earlyExitDrainTimer) {
          if (activeEventSource) {
            await drainRecords(activeEventSource);
          }

          if (phaseFinalized || settled) {
            break;
          }

          await delay(5);
        }
      })()
        .then(() => {
          if (phaseFinalized) {
            maybeResolve();
          }
        })
        .catch(rejectEventCaptureFailure)
        .finally(() => {
          postExitDrainActive = false;
        });
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
                startPostExitDrainLoop();
                return;
              }

              startPostExitDrainLoop();
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
      const eventSource = jsonlEventSourceFactory({
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
        startPostExitDrainLoop();
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isResumeLocation(
  location:
    | Awaited<ReturnType<typeof locateCodexSessionLogForProvider>>
    | SessionLogResumeLocation,
): location is SessionLogResumeLocation {
  return "startOffset" in location;
}
