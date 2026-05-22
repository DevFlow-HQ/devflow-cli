import {
  createCommandManagedSessionAdapter,
  type CommandManagedSessionAdapterOptions,
} from "./commandManagedSessionAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";

export function createClaudeAdapter(
  options?: CommandManagedSessionAdapterOptions,
): ManagedSessionAdapter {
  return createCommandManagedSessionAdapter(
    {
      providerId: "claude",
      command: "claude",
      cleanupCommand: "/exit\n",
      buildArgs(input) {
        return [...(input.model ? ["--model", input.model] : []), input.initialPrompt];
      },
    },
    options,
  );
}
