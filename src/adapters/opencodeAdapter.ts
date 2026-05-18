import { createCommandProviderAdapter } from "./commandProviderAdapter.js";
import type { ProviderAdapter } from "./providerAdapter.js";

export function createOpenCodeAdapter(): ProviderAdapter {
  return createCommandProviderAdapter({
    providerId: "opencode",
    command: "opencode",
  });
}
