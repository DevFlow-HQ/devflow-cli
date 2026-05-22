import {
  createCommandManagedSessionAdapter,
  type CommandManagedSessionAdapterOptions,
} from "./commandManagedSessionAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";

export function createOpenCodeAdapter(
  options?: CommandManagedSessionAdapterOptions,
): ManagedSessionAdapter {
  return createCommandManagedSessionAdapter(
    {
      providerId: "opencode",
      command: "opencode",
      cleanupCommand: "/exit\n",
      buildArgs(input) {
        return [
          ...(input.model ? ["--model", input.model] : []),
          "--prompt",
          input.initialPrompt,
        ];
      },
    },
    options,
  );
}
