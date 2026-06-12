import { createClaudeHookArtifacts } from "./claudeHookArtifacts.js";
import { normalizeClaudeHookPayload } from "./claudeHookEventSource.js";
import { resolveHookSocketPath } from "./hookSocketPath.js";
import { installClaudeHookSettings } from "./claudeHookSettings.js";
import {
  getClaudeHookDirectory,
  getScopedClaudeProviderHome,
  seedClaudeCredentials,
} from "./claudeProviderHome.js";
import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
  ProviderSessionLaunchError,
  ProviderSessionTranscriptCaptureError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
} from "./managedSessionAdapter.js";
import { createPhaseManager } from "./phaseManager.js";
import {
  hookSocketServer,
  type HookSocketServer,
  type HookSocketServerOptions,
} from "./hookSocketServer.js";
import {
  startPtyControlHarness,
  type PtyControlHarness,
  type OutputSink,
  type PtySpawner,
  type TerminalDimensions,
  type UserInput,
  type PtyGracefulExitCommand,
} from "./ptyControlHarness.js";
import {
  submitPtyPrompt,
  type UserInterruptState,
} from "./ptyManagedSessionRunner.js";
import type { ProviderIdentity } from "./providers.js";
import type { Logger } from "../logger.js";

export interface ClaudeHookDrivenSessionCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
  gracefulExitCommand?: PtyGracefulExitCommand;
  logger?: Logger;
}

export interface ClaudeHookDrivenSessionDependencies {
  ptySpawner?: PtySpawner;
  outputSink?: OutputSink;
  terminal?: TerminalDimensions;
  userInput?: UserInput;
  userInterrupt?: UserInterruptState;
  hookSocketServer?: (options?: HookSocketServerOptions) => HookSocketServer;
  firstEventTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  socketDrainMs?: number;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_SOCKET_DRAIN_MS = 250;

export async function runClaudeHookDrivenSession(
  command: ClaudeHookDrivenSessionCommand,
  input: ManagedProviderSessionInput,
  dependencies: ClaudeHookDrivenSessionDependencies = {},
): Promise<ManagedProviderSessionResult> {
  const server = (dependencies.hookSocketServer ?? hookSocketServer)({
    onError(error) {
      rejectEventCaptureFailure(error);
    },
    logger: command.logger,
  });
  const firstEventTimeoutMs =
    dependencies.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const cleanupTimeoutMs =
    dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const socketDrainMs = dependencies.socketDrainMs ?? DEFAULT_SOCKET_DRAIN_MS;
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const claudeConfigDirectory = getScopedClaudeProviderHome(input);
  const socketPath = resolveHookSocketPath(input);
  const artifacts = await createClaudeHookArtifacts({
    hookDirectory: getClaudeHookDirectory(claudeConfigDirectory),
  });

  let harness: PtyControlHarness | undefined;
  let rejectEventCaptureFailure: (error: unknown) => void = () => {};

  try {
    await seedClaudeCredentials({
      claudeConfigDirectory,
      environment,
      platform,
      homeDirectory: dependencies.homeDirectory,
    });
    await installClaudeHookSettings({
      configDirectory: claudeConfigDirectory,
      hookScriptPath: artifacts.hookScriptPath,
    });
  } catch (error) {
    throw new ProviderSessionLaunchError(command.provider, error);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionStarted = false;
    let phaseFinalized = false;
    let exitObserved = false;
    let successSettlementStarted = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;
    let firstEventTimer: NodeJS.Timeout | undefined;
    const pendingManagedPrompts = [input.initialPrompt];

    const manager = createPhaseManager({
      provider: command.provider,
      source: "hooks",
      structured: true,
      logger: command.logger,
      input,
      submitPrompt(prompt) {
        if (!harness) {
          throw new Error("Claude PTY is not available for prompt submission.");
        }

        submitPtyPrompt(harness, prompt);
        pendingManagedPrompts.push(prompt);
      },
      finalize() {
        phaseFinalized = true;

        if (exitObserved) {
          maybeResolve();
          return;
        }

        settleSuccess(async () => {
          if (!harness) {
            throw new Error("Claude PTY is not available for cleanup.");
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

    rejectEventCaptureFailure = (error: unknown): void => {
      const transcriptError = findTranscriptCaptureError(error);

      if (transcriptError) {
        rejectSession(transcriptError);
        return;
      }

      rejectSession(new ProviderSessionEventCaptureError(command.provider, error));
    };

    function clearTimers(): void {
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = undefined;
      }

    }

    async function stopSocket(): Promise<void> {
      await server.stop({ drainMs: socketDrainMs });
    }

    function resolveSession(result: ManagedProviderSessionResult): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      harness?.dispose();
      void stopSocket().then(() => resolve(result), reject);
    }

    function rejectSession(error: unknown): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      if (harness && !exitObserved && !successSettlementStarted) {
        void harness
          .shutdown({
            command: command.gracefulExitCommand,
            timeoutMs: cleanupTimeoutMs,
          })
          .catch(() => {});
      }

      harness?.dispose();

      void stopSocket()
        .catch(() => {})
        .finally(() => reject(error));
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

    async function emitSessionCompleted(): Promise<void> {
      try {
        await input.onProviderEvent?.({
          type: "session-completed",
          provider: command.provider,
          source: "hooks",
          structured: true,
          exitCode,
          signal,
        } satisfies ManagedProviderSessionEvent);
      } catch (error) {
        throw new ProviderSessionEventCaptureError(command.provider, error);
      }
    }


    async function handlePayload(payload: unknown): Promise<void> {
      let event = normalizeClaudeHookPayload(payload);

      if (!event) {
        return;
      }

      event = classifySubmittedUserMessageOrigin(event);

      if (!sessionStarted) {
        if (event.type !== "session-start") {
          throw new Error(
            "Claude hook stream emitted an event before SessionStart.",
          );
        }

        sessionStarted = true;
        if (firstEventTimer) {
          clearTimeout(firstEventTimer);
          firstEventTimer = undefined;
        }
      }

      await captureHookTranscript(event);
      await manager.handleEvent(event);
    }

    function classifySubmittedUserMessageOrigin(
      event: Parameters<typeof manager.handleEvent>[0],
    ): Parameters<typeof manager.handleEvent>[0] {
      if (event.type !== "submitted-user-message") {
        return event;
      }

      const pendingIndex = pendingManagedPrompts.indexOf(event.message);

      if (pendingIndex === -1) {
        return {
          ...event,
          origin: "human",
        };
      }

      pendingManagedPrompts.splice(pendingIndex, 1);

      return {
        ...event,
        origin: "managed",
      };
    }

    async function captureHookTranscript(
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

    void (async () => {
      try {
        await server.start(socketPath, handlePayload);
      } catch (error) {
        rejectSession(new ProviderSessionLaunchError(command.provider, error));
        return;
      }

      try {
        firstEventTimer = setTimeout(() => {
          rejectSession(
            new ProviderSessionEventCaptureError(
              command.provider,
              new Error(
                formatMissingSessionStartDiagnostic(
                  artifacts.hookScriptPath,
                  socketPath,
                ),
              ),
            ),
          );
        }, firstEventTimeoutMs);

        harness = startPtyControlHarness(
          {
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            cwd: input.workingDirectory,
            env: {
              ...environment,
              CLAUDE_CONFIG_DIR: claudeConfigDirectory,
              DEVFLOW_HOOK_IPC_PATH: socketPath,
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

              if (!sessionStarted) {
                rejectSession(
                  new IncompleteProviderSessionError({
                    provider: command.provider,
                    completionMarker: `${input.initialCompletionMarker} (Claude hook setup may have failed before SessionStart.)`,
                    exitCode,
                    signal,
                  }),
                );
                return;
              }

              if (!manager.isFinalized()) {
                setTimeout(() => {
                  rejectSession(
                    new IncompleteProviderSessionError({
                      provider: command.provider,
                      completionMarker: input.initialCompletionMarker,
                      exitCode,
                      signal,
                    }),
                  );
                }, socketDrainMs);
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
    })();
  });
}

function formatMissingSessionStartDiagnostic(
  hookScriptPath: string,
  socketPath: string,
): string {
  return [
    "Claude SessionStart hook did not arrive; hook setup may have failed.",
    "Check the run-scoped Claude settings.local.json for DevFlow hook entries,",
    "ensure Claude disabled hooks settings or managed policy are not blocking hooks,",
    `verify the hook script exists and can run at ${hookScriptPath},`,
    `and confirm the hook socket is reachable at ${socketPath}.`,
  ].join(" ");
}

function findTranscriptCaptureError(
  error: unknown,
): ProviderSessionTranscriptCaptureError | undefined {
  let current: unknown = error;

  while (current instanceof Error) {
    if (current instanceof ProviderSessionTranscriptCaptureError) {
      return current;
    }

    current = current.cause;
  }

  return undefined;
}
