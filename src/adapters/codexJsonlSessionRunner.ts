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
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
} from "./managedSessionAdapter.js";
import { createPhaseManager } from "./phaseManager.js";
import {
  nodePtySpawner,
  submitPtyPrompt,
  type OutputSink,
  type PtyProcess,
  type PtySpawner,
  type TerminalDimensions,
  type UserInput,
  type UserInterruptState,
} from "./ptyManagedSessionRunner.js";
import type { ProviderIdentity } from "./providers.js";

export interface CodexJsonlSessionCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
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

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_LOCATOR_TIMEOUT_MS = 30_000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_EARLY_EXIT_DRAIN_TIMEOUT_MS = 250;

export async function runCodexJsonlSession(
  command: CodexJsonlSessionCommand,
  input: ManagedProviderSessionInput,
  dependencies: CodexJsonlSessionDependencies = {},
): Promise<ManagedProviderSessionResult> {
  const ptySpawner = dependencies.ptySpawner ?? nodePtySpawner;
  const outputSink = dependencies.outputSink ?? process.stdout;
  const terminal = dependencies.terminal ?? process.stdout;
  const userInput = dependencies.userInput ?? process.stdin;
  const codexHome = getScopedCodexProviderHome(input);
  const locator =
    dependencies.sessionLogLocator ??
    createCodexSessionLogLocator({ codexHome });
  const locatorTimeoutMs =
    dependencies.locatorTimeoutMs ?? DEFAULT_LOCATOR_TIMEOUT_MS;
  const firstEventTimeoutMs =
    dependencies.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const cleanupTimeoutMs =
    dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const earlyExitDrainTimeoutMs =
    dependencies.earlyExitDrainTimeoutMs ?? DEFAULT_EARLY_EXIT_DRAIN_TIMEOUT_MS;
  await fs.ensureDir(codexHome);

  let snapshot;
  try {
    snapshot = await locator.snapshot();
  } catch (error) {
    throw new ProviderSessionEventCaptureError(command.provider, error);
  }

  let processHandle: PtyProcess;
  try {
    processHandle = ptySpawner.spawn(command.executable, command.args, {
      cwd: input.workingDirectory,
      cols: terminal.columns ?? DEFAULT_COLUMNS,
      rows: terminal.rows ?? DEFAULT_ROWS,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    });
  } catch (error) {
    throw new ProviderSessionLaunchError(command.provider, error);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let phaseFinalized = false;
    let exitObserved = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;
    let cleanupUserInputBridge = (): void => {};
    let cleanupTerminalResize = (): void => {};
    let firstEventTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let earlyExitDrainTimer: NodeJS.Timeout | undefined;
    let activeEventSource:
      | ReturnType<typeof createJsonlTailEventSource>
      | undefined;
    const normalizer = createCodexJsonlNormalizer();

    const manager = createPhaseManager({
      provider: command.provider,
      source: "jsonl",
      structured: true,
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
      submitPtyPrompt(processHandle, prompt);
      await manager.handleEvent({
        type: "submitted-user-message",
        message: prompt,
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

    function cleanupInteractiveInput(): void {
      cleanupUserInputBridge();
      cleanupUserInputBridge = (): void => {};
    }

    function cleanupResizeListener(): void {
      cleanupTerminalResize();
      cleanupTerminalResize = (): void => {};
    }

    function resolveSession(result: ManagedProviderSessionResult): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      cleanupInteractiveInput();
      cleanupResizeListener();
      void activeEventSource?.close();
      resolve(result);
    }

    function rejectSession(error: unknown): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      cleanupInteractiveInput();
      cleanupResizeListener();
      void activeEventSource?.close();
      try {
        processHandle.kill();
      } catch {
        // Preserve the original failure.
      }
      reject(error);
    }

    function rejectEventCaptureFailure(error: unknown): void {
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

    function forwardInputChunk(chunk: string): void {
      for (const character of chunk) {
        processHandle.write(character);
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

        if (event) {
          await manager.handleEvent(event);
          markFirstEventObserved();
        } else if (isNativeSessionMetaRecord(record)) {
          markFirstEventObserved();
        }
      }
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

    setupUserInputBridge();
    setupTerminalResizeForwarding();

    processHandle.onData((chunk) => {
      outputSink.write(chunk);
    });

    processHandle.onExit((event) => {
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
    });

    firstEventTimer = setTimeout(() => {
      rejectEventCaptureFailure(
        new Error(
          `Codex JSONL stream did not produce a usable event within ${firstEventTimeoutMs}ms.`,
        ),
      );
    }, firstEventTimeoutMs);

    void (async () => {
      const location = await locateCodexSessionLogForProvider({
        provider: command.provider,
        locator,
        snapshot,
        timeoutMs: locatorTimeoutMs,
      });
      const eventSource = createJsonlTailEventSource({
        filePath: location.filePath,
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
}
