import { createCommandManagedSessionAdapter } from "./commandManagedSessionAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";

export function createCodexAdapter(): ManagedSessionAdapter {
  return createCommandManagedSessionAdapter({
    providerId: "codex",
    command: "codex",
  });
}
