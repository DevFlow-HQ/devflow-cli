import { createCommandManagedSessionAdapter } from "./commandManagedSessionAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";

export function createOpenCodeAdapter(): ManagedSessionAdapter {
  return createCommandManagedSessionAdapter({
    providerId: "opencode",
    command: "opencode",
  });
}
