import {
  createCommandManagedSessionAdapter,
  type CommandManagedSessionAdapterOptions,
} from "./commandManagedSessionAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";

export function createCodexAdapter(
  options?: CommandManagedSessionAdapterOptions,
): ManagedSessionAdapter {
  return createCommandManagedSessionAdapter(
    {
      providerId: "codex",
      command: "codex",
      cleanupCommand: "/quit\n",
      buildArgs(input) {
        return [...(input.model ? ["--model", input.model] : []), input.initialPrompt];
      },
    },
    options,
  );
}
