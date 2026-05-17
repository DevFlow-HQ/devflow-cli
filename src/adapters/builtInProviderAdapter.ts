import { createClaudeAdapter } from "./claudeAdapter.js";
import { createCodexAdapter } from "./codexAdapter.js";
import { createGeminiAdapter } from "./geminiAdapter.js";
import type {
  BuiltInProviderId,
  ProviderAdapter,
} from "./providerAdapter.js";

export function createBuiltInProviderAdapter(
  providerId: BuiltInProviderId,
): ProviderAdapter {
  switch (providerId) {
    case "claude":
      return createClaudeAdapter();
    case "gemini":
      return createGeminiAdapter();
    case "codex":
      return createCodexAdapter();
    default:
      throw new Error(`Built-in provider '${providerId}' is not wired yet.`);
  }
}
