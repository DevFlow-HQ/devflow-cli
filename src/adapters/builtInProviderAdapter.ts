import { createCodexAdapter } from "./codexAdapter.js";
import type {
  BuiltInProviderId,
  ProviderAdapter,
} from "./providerAdapter.js";

export function createBuiltInProviderAdapter(
  providerId: BuiltInProviderId,
): ProviderAdapter {
  switch (providerId) {
    case "codex":
      return createCodexAdapter();
    default:
      throw new Error(`Built-in provider '${providerId}' is not wired yet.`);
  }
}
