import {
  createClaudeAdapter,
  type ClaudeManagedSessionEventSource,
} from "./claudeAdapter.js";
import {
  buildTierResolutionTrace,
  emitAdapterTrace,
} from "./adapterTrace.js";
import type { CommandManagedSessionAdapterOptions } from "./commandManagedSessionAdapter.js";
import {
  createCodexAdapter,
  type CodexManagedSessionEventSource,
  type CodexAdapterOptions,
} from "./codexAdapter.js";
import { createGeminiAdapter } from "./geminiAdapter.js";
import { createOpenCodeAdapter } from "./opencodeAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";
import type { BuiltInProviderId } from "./providers.js";
import { NoopLogger } from "../logger.js";

export type BuiltInManagedSessionAdapterOptions =
  CommandManagedSessionAdapterOptions &
    Omit<CodexAdapterOptions, "eventSource"> & {
      claudeEventSource?: ClaudeManagedSessionEventSource;
      codexEventSource?: CodexManagedSessionEventSource;
    };

export function createBuiltInManagedSessionAdapter(
  providerId: BuiltInProviderId,
  options?: BuiltInManagedSessionAdapterOptions,
): ManagedSessionAdapter {
  const logger = options?.logger ?? NoopLogger;
  let adapter: ManagedSessionAdapter;

  switch (providerId) {
    case "claude":
      adapter = createClaudeAdapter({
        ...options,
        eventSource: options?.claudeEventSource,
      });
      break;
    case "gemini":
      adapter = createGeminiAdapter(options);
      break;
    case "codex":
      adapter = createCodexAdapter({
        ...options,
        eventSource: options?.codexEventSource,
      });
      break;
    case "opencode":
      adapter = createOpenCodeAdapter(options);
      break;
    default:
      throw new Error(`Built-in provider '${providerId}' is not wired yet.`);
  }

  if (adapter.capabilities !== undefined) {
    emitAdapterTrace(
      logger,
      buildTierResolutionTrace({
        provider: adapter.provider,
        tier: adapter.capabilities.eventSource,
        capabilities: adapter.capabilities,
      }),
    );
  }

  return adapter;
}
