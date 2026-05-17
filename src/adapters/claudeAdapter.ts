import { createCommandProviderAdapter } from "./commandProviderAdapter.js";
import type { ProviderAdapter } from "./providerAdapter.js";

export function createClaudeAdapter(): ProviderAdapter {
  return createCommandProviderAdapter({
    providerId: "claude",
    command: "claude",
  });
}
