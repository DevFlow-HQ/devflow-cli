import fs from "fs-extra";

import {
  createClaudeJsonlNormalizer,
  normalizeClaudeJsonlRecordForProvider,
} from "./claudeJsonlEventSource.js";
import {
  createClaudeSessionLogLocator,
  getScopedClaudeProviderHome,
  locateClaudeSessionLogForProvider,
} from "./claudeSessionLogLocator.js";
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
  type OutputSink,
  type PtyProcess,
  type PtySpawner,
  type TerminalDimensions,
  type UserInterruptState,
} from "./ptyManagedSessionRunner.js";
import type { ProviderIdentity } from "./providers.js";
import type { SessionLogLocator } from "./codexSessionLogLocator.js";

export interface ClaudeJsonlSessionCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
}

export interface ClaudeJsonlSessionDependencies {
  ptySpawner?: PtySpawner;
  outputSink?: OutputSink;
  terminal?: TerminalDimensions;
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

export async function runClaudeJsonlSession(
  command: ClaudeJsonlSessionCommand,
  input: ManagedProviderSessionInput,
  dependencies: ClaudeJsonlSessionDependencies = {},
): Promise<ManagedProviderSessionResult> {
  const ptySpawner = dependencies.ptySpawner ?? nodePtySpawner;
  const outputSink = dependencies.outputSink ?? process.stdout;
  const terminal = dependencies.terminal ?? process.stdout;
  const claudeHome = getScopedClaudeProviderHome(input);
  const locator =
    dependencies.sessionLogLocator ??
    createClaudeSessionLogLocator({ claudeHome });
  const locatorTimeoutMs =
    dependencies.locatorTimeoutMs ?? DEFAULT_LOCATOR_TIMEOUT_MS;
  const firstEventTimeoutMs =
    dependencies.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const cleanupTimeoutMs =
    dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const earlyExitDrainTimeoutMs =
    dependencies.earlyExitDrainTimeoutMs ?? DEFAULT_EARLY_EXIT_DRAIN_TIMEOUT_MS;

  await fs.ensureDir(claudeHome);

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
        CLAUDE_CONFIG_DIR: claudeHome,
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
    let firstEventTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let earlyExitDrainTimer: NodeJS.Timeout | undefined;
    let activeEventSource:
      | ReturnType<typeof createJsonlTailEventSource>
      | undefined;
    const normalizer = createClaudeJsonlNormalizer();

    const manager = createPhaseManager({
      provider: command.provider,
      source: "jsonl",
      structured: true,
      input,
      submitPrompt() {
        throw new Error(
          "Claude JSONL continuation prompts are not implemented yet.",
        );
      },
      finalize() {
        phaseFinalized = true;
        maybeResolve();
        armCleanupTimer();
      },
    });

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
        const event = normalizeClaudeJsonlRecordForProvider({
          provider: command.provider,
          normalizer,
          record,
        });

        if (event) {
          await manager.handleEvent(event);
          markFirstEventObserved();
        }
      }
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

        rejectSession(
          new IncompleteProviderSessionError({
            provider: command.provider,
            completionMarker: input.initialCompletionMarker,
            exitCode,
            signal,
          }),
        );
      }, earlyExitDrainTimeoutMs);
    }

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
          `Claude JSONL stream did not produce a usable event within ${firstEventTimeoutMs}ms.`,
        ),
      );
    }, firstEventTimeoutMs);

    void (async () => {
      const location = await locateClaudeSessionLogForProvider({
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
      await drainRecords(eventSource);

      if (exitObserved && !phaseFinalized) {
        scheduleEarlyExitDrain();
        return;
      }

      startFileWatch(eventSource);
    })().catch(rejectEventCaptureFailure);
  });
}
