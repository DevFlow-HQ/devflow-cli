import {
  createClaudeAdapter,
  type ClaudeManagedSessionEventSource,
} from "./claudeAdapter.js";
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
  switch (providerId) {
    case "claude":
      return createClaudeAdapter({
        ...options,
        eventSource: options?.claudeEventSource,
      });
    case "gemini":
      return createGeminiAdapter(options);
    case "codex":
      return createCodexAdapter({
        ...options,
        eventSource: options?.codexEventSource,
      });
    case "opencode":
      return createOpenCodeAdapter(options);
    default:
      throw new Error(`Built-in provider '${providerId}' is not wired yet.`);
  }
}
