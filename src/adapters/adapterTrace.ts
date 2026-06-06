import {
  type ManagedProviderSessionCapabilities,
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
