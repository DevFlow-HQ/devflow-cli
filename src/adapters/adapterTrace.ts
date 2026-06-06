import {
  type ManagedProviderSessionCapabilities,
  type ManagedProviderSessionEventSource,
  type SubmittedUserMessageOrigin,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";
import { NoopLogger, type LogContext, type Logger } from "../logger.js";

export interface AdapterTrace {
  msg: string;
  context: LogContext;
}

interface AdapterTraceBase {
  provider: ProviderIdentity;
  phaseId?: string;
}

interface AdapterProviderEventTraceBase extends AdapterTraceBase {
  source: ManagedProviderSessionEventSource;
  structured: boolean;
}

export function buildTierResolutionTrace(
  input: AdapterTraceBase & {
    tier: ManagedProviderSessionCapabilities["eventSource"];
    capabilities: ManagedProviderSessionCapabilities;
  },
): AdapterTrace {
  return {
    msg: "adapter data-plane resolution",
    context: adapterLogContext(input, {
      tier: input.tier,
      eventSource: input.capabilities.eventSource,
      capabilities: input.capabilities,
    }),
  };
}

export function buildSubmittedUserMessageTrace(
  input: AdapterTraceBase & {
    event: {
      type: "submitted-user-message";
      message: string;
      origin: SubmittedUserMessageOrigin;
    };
    promptArgument?: string;
  },
): AdapterTrace {
  void input.promptArgument;

  return {
    msg: "adapter provider event submitted-user-message",
    context: adapterLogContext(input, {
      type: input.event.type,
      origin: input.event.origin,
      messageLength: input.event.message.length,
    }),
  };
}

export function buildTurnCompletedTrace(
  input: AdapterTraceBase & {
    event: {
      type: "turn-completed";
      assistantMessage?: string;
    };
    promptArgument?: string;
  },
): AdapterTrace {
  void input.promptArgument;

  return {
    msg: "adapter provider event turn-completed",
    context: adapterLogContext(input, {
      type: input.event.type,
      messageLength: input.event.assistantMessage?.length ?? 0,
    }),
  };
}

export function buildProviderEventTrace(
  input: AdapterProviderEventTraceBase & {
    event:
      | { type: "session-start" }
      | {
          type: "submitted-user-message";
          message: string;
          origin: SubmittedUserMessageOrigin;
        }
      | {
          type: "turn-completed";
          assistantMessage?: string;
        }
      | {
          type: "session-completed";
          exitCode: number | null;
          signal: NodeJS.Signals | null;
        };
  },
): AdapterTrace {
  return {
    msg: "adapter provider event forwarded",
    context: adapterLogContext(input, {
      type: input.event.type,
      source: input.source,
      structured: input.structured,
      ...providerEventMetadata(input.event),
    }),
  };
}

export function buildPtySpawnTrace(
  input: AdapterTraceBase & {
    executable: string;
    argumentCount: number;
    workingDirectory: string;
    promptArgument?: string;
  },
): AdapterTrace {
  void input.promptArgument;

  return {
    msg: "adapter pty process spawned",
    context: adapterLogContext(input, {
      executable: input.executable,
      argumentCount: input.argumentCount,
      workingDirectory: input.workingDirectory,
    }),
  };
}

export function buildPtyExitTrace(
  input: AdapterTraceBase & {
    exitCode: number;
    signal: NodeJS.Signals | null;
  },
): AdapterTrace {
  return {
    msg: "adapter pty process exit",
    context: adapterLogContext(input, {
      exitCode: input.exitCode,
      signal: input.signal,
    }),
  };
}

export function buildCompletionMarkerMatchTrace(
  input: AdapterProviderEventTraceBase & {
    matchedMarker: string;
    isTerminalCompletionMarker: boolean;
  },
): AdapterTrace {
  return {
    msg: "adapter completion marker matched",
    context: adapterLogContext(input, {
      source: input.source,
      structured: input.structured,
      matchedMarker: input.matchedMarker,
      isTerminalCompletionMarker: input.isTerminalCompletionMarker,
    }),
  };
}

export function buildTurnBoundaryMarkerMissTrace(
  input: AdapterProviderEventTraceBase,
): AdapterTrace {
  return {
    msg: "adapter turn boundary marker miss",
    context: adapterLogContext(input, {
      source: input.source,
      structured: input.structured,
    }),
  };
}

export function buildPhaseTransitionTrace(
  input: AdapterProviderEventTraceBase & {
    from: string;
    to: string;
    fromPhaseId?: string;
    toPhaseId?: string;
  },
): AdapterTrace {
  return {
    msg: "adapter phase transition",
    context: adapterLogContext(input, {
      source: input.source,
      structured: input.structured,
      from: input.from,
      to: input.to,
      ...(input.fromPhaseId !== undefined ? { fromPhaseId: input.fromPhaseId } : {}),
      ...(input.toPhaseId !== undefined ? { toPhaseId: input.toPhaseId } : {}),
    }),
  };
}

export function emitAdapterTrace(
  logger: Logger | undefined,
  trace: AdapterTrace,
): void {
  (logger ?? NoopLogger).debug(trace.msg, trace.context);
}

function adapterLogContext(
  input: AdapterTraceBase,
  metadata: Record<string, unknown>,
): LogContext {
  return {
    context: {
      providerId: input.provider.id,
      ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
      ...metadata,
    },
  };
}

function providerEventMetadata(
  event:
    | { type: "session-start" }
    | {
        type: "submitted-user-message";
        message: string;
        origin: SubmittedUserMessageOrigin;
      }
    | {
        type: "turn-completed";
        assistantMessage?: string;
      }
    | {
        type: "session-completed";
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      },
): Record<string, unknown> {
  if (event.type === "submitted-user-message") {
    return {
      origin: event.origin,
      messageLength: event.message.length,
    };
  }

  if (event.type === "session-completed") {
    return {
      exitCode: event.exitCode,
      signal: event.signal,
    };
  }

  return {};
}
