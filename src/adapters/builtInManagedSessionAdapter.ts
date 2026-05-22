import { createClaudeAdapter } from "./claudeAdapter.js";
import type { CommandManagedSessionAdapterOptions } from "./commandManagedSessionAdapter.js";
import { createCodexAdapter } from "./codexAdapter.js";
import { createGeminiAdapter } from "./geminiAdapter.js";
import { createOpenCodeAdapter } from "./opencodeAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";
import type { BuiltInProviderId } from "./providers.js";

export function createBuiltInManagedSessionAdapter(
  providerId: BuiltInProviderId,
  options?: CommandManagedSessionAdapterOptions,
): ManagedSessionAdapter {
  switch (providerId) {
    case "claude":
      return createClaudeAdapter(options);
    case "gemini":
      return createGeminiAdapter(options);
    case "codex":
      return createCodexAdapter(options);
    case "opencode":
      return createOpenCodeAdapter(options);
    default:
      throw new Error(`Built-in provider '${providerId}' is not wired yet.`);
  }
}
