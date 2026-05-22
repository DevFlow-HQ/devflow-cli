import { createClaudeAdapter } from "./claudeAdapter.js";
import { createCodexAdapter } from "./codexAdapter.js";
import { createGeminiAdapter } from "./geminiAdapter.js";
import { createOpenCodeAdapter } from "./opencodeAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";
import type { BuiltInProviderId } from "./providers.js";

export function createBuiltInManagedSessionAdapter(
  providerId: BuiltInProviderId,
): ManagedSessionAdapter {
  switch (providerId) {
    case "claude":
      return createClaudeAdapter();
    case "gemini":
      return createGeminiAdapter();
    case "codex":
      return createCodexAdapter();
    case "opencode":
      return createOpenCodeAdapter();
    default:
      throw new Error(`Built-in provider '${providerId}' is not wired yet.`);
  }
}
