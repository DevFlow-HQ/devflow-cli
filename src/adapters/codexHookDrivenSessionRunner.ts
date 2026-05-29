import fs from "fs-extra";
import { join } from "node:path";

import {
  codexHookConfigToml,
  codexHookScript,
} from "./codexHookArtifacts.js";
import { normalizeCodexHookPayload } from "./codexHookEventSource.js";
import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
  ProviderSessionLaunchError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionResult,
} from "./managedSessionAdapter.js";
import { createPhaseManager } from "./phaseManager.js";
import {
  hookSocketServer,
  type HookSocketServerOptions,
  type HookSocketServer,
} from "./hookSocketServer.js";
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

export interface CodexHookDrivenSessionCommand {
  provider: ProviderIdentity;
  executable: string;
  args: string[];
}

export interface CodexHookDrivenSessionDependencies {
  ptySpawner?: PtySpawner;
  outputSink?: OutputSink;
  terminal?: TerminalDimensions;
  userInput?: UserInput;
  userInterrupt?: UserInterruptState;
  hookSocketServer?: (options?: HookSocketServerOptions) => HookSocketServer;
  firstEventTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  socketDrainMs?: number;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_SOCKET_DRAIN_MS = 250;

export async function runCodexHookDrivenSession(
  command: CodexHookDrivenSessionCommand,
  input: ManagedProviderSessionInput,
  dependencies: CodexHookDrivenSessionDependencies = {},
): Promise<ManagedProviderSessionResult> {
  const ptySpawner = dependencies.ptySpawner ?? nodePtySpawner;
  const outputSink = dependencies.outputSink ?? process.stdout;
  const terminal = dependencies.terminal ?? process.stdout;
  const userInput = dependencies.userInput ?? process.stdin;
  const server = (dependencies.hookSocketServer ?? hookSocketServer)({
    onError(error) {
      rejectEventCaptureFailure(error);
    },
  });
  const firstEventTimeoutMs =
    dependencies.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const cleanupTimeoutMs =
    dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const socketDrainMs = dependencies.socketDrainMs ?? DEFAULT_SOCKET_DRAIN_MS;
  const codexHome = getCodexHome(input);
  const hookScriptPath = join(codexHome, "hook.js");
  const socketPath = join(codexHome, "hook.sock");

  let processHandle: PtyProcess | undefined;
  let rejectEventCaptureFailure: (error: unknown) => void = () => {};

  await fs.ensureDir(codexHome);
  await fs.writeFile(
    join(codexHome, "config.toml"),
    codexHookConfigToml({ hookScriptPath }),
    "utf8",
  );
  await fs.writeFile(hookScriptPath, codexHookScript(), {
    encoding: "utf8",
    mode: 0o755,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionStarted = false;
    let phaseFinalized = false;
    let exitObserved = false;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;
    let cleanupUserInputBridge = (): void => {};
    let cleanupTerminalResize = (): void => {};
    let firstEventTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const pendingManagedPrompts = [input.initialPrompt];

    const manager = createPhaseManager({
      provider: command.provider,
      source: "hooks",
      structured: true,
      input,
      submitPrompt(prompt) {
        if (!processHandle) {
          throw new Error("Codex PTY is not available for prompt submission.");
        }

        submitPtyPrompt(processHandle, prompt);
        pendingManagedPrompts.push(prompt);
      },
      finalize() {
        phaseFinalized = true;
        maybeResolve();
        armCleanupTimer();
      },
    });

    rejectEventCaptureFailure = (error: unknown): void => {
      rejectSession(
        new ProviderSessionEventCaptureError(command.provider, error),
      );
    };

    function clearTimers(): void {
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = undefined;
      }

      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = undefined;
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

    async function stopSocket(): Promise<void> {
      await server.stop({ drainMs: socketDrainMs });
    }

    function resolveSession(result: ManagedProviderSessionResult): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      cleanupInteractiveInput();
      cleanupResizeListener();
      void stopSocket().then(() => resolve(result), reject);
    }

    function rejectSession(error: unknown): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      cleanupInteractiveInput();
      cleanupResizeListener();
      try {
        processHandle?.kill();
      } catch {
        // Preserve the original failure.
      }

      void stopSocket().then(() => reject(error), reject);
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
        rejectSession,
      );
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
        });
      } catch (error) {
        throw new ProviderSessionEventCaptureError(command.provider, error);
      }
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
              `Codex PTY did not exit within ${cleanupTimeoutMs}ms after hook finalization.`,
            ),
          ),
        );
      }, cleanupTimeoutMs);
    }

    async function handlePayload(payload: unknown): Promise<void> {
      let event = normalizeCodexHookPayload(payload);

      if (!event) {
        return;
      }

      event = classifySubmittedUserMessageOrigin(event);

      if (!sessionStarted) {
        if (event.type !== "session-start") {
          throw new Error(
            "Codex hook stream emitted an event before SessionStart.",
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
        return event;
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
    }

    function forwardInputChunk(chunk: string): void {
      for (const character of chunk) {
        if (character !== "\u0003") {
          processHandle?.write(character);
          continue;
        }

        processHandle?.write("\u0003");
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
        processHandle?.resize?.(
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

    void (async () => {
      try {
        await server.start(socketPath, handlePayload);
      } catch (error) {
        rejectSession(
          new ProviderSessionEventCaptureError(command.provider, error),
        );
        return;
      }

      try {
        firstEventTimer = setTimeout(() => {
          rejectSession(
            new ProviderSessionEventCaptureError(
              command.provider,
              new Error(
                "Codex SessionStart hook did not arrive; hook setup may have failed.",
              ),
            ),
          );
        }, firstEventTimeoutMs);

        processHandle = ptySpawner.spawn(command.executable, command.args, {
          cwd: input.workingDirectory,
          cols: terminal.columns ?? DEFAULT_COLUMNS,
          rows: terminal.rows ?? DEFAULT_ROWS,
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
            DEVFLOW_HOOK_IPC_PATH: socketPath,
          },
        });
      } catch (error) {
        rejectSession(new ProviderSessionLaunchError(command.provider, error));
        return;
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

        if (!sessionStarted) {
          rejectSession(
            new IncompleteProviderSessionError({
              provider: command.provider,
              completionMarker: `${input.initialCompletionMarker} (Codex hook setup may have failed before SessionStart.)`,
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
      });
    })();
  });
}

function getCodexHome(input: ManagedProviderSessionInput): string {
  const runId = input.phase?.id.split(":")[0] ?? "unscoped-codex-session";

  return join(input.workingDirectory, ".devflow", "runs", runId, ".codex");
}
