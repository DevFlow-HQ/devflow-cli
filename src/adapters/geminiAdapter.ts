import { createCommandManagedSessionAdapter } from "./commandManagedSessionAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";

export function createGeminiAdapter(): ManagedSessionAdapter {
  return createCommandManagedSessionAdapter({
    providerId: "gemini",
    command: "gemini",
  });
}
