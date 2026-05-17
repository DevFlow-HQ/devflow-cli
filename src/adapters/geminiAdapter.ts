import { createCommandProviderAdapter } from "./commandProviderAdapter.js";
import type { ProviderAdapter } from "./providerAdapter.js";

export function createGeminiAdapter(): ProviderAdapter {
  return createCommandProviderAdapter({
    providerId: "gemini",
    command: "gemini",
  });
}
