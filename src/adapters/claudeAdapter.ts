import { createCommandManagedSessionAdapter } from "./commandManagedSessionAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";

export function createClaudeAdapter(): ManagedSessionAdapter {
  return createCommandManagedSessionAdapter({
    providerId: "claude",
    command: "claude",
  });
}
