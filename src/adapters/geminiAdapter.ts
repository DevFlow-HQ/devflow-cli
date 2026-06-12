import {
  createCommandManagedSessionAdapter,
  type CommandManagedSessionAdapterOptions,
} from "./commandManagedSessionAdapter.js";
import type { ManagedSessionAdapter } from "./managedSessionAdapter.js";

export function createGeminiAdapter(
  options?: CommandManagedSessionAdapterOptions,
): ManagedSessionAdapter {
  return createCommandManagedSessionAdapter(
    {
      providerId: "gemini",
      command: "gemini",
      gracefulExitCommand: { text: "/quit", submitKey: "\n" },
      buildArgs(input) {
        return [
          ...(input.model ? ["--model", input.model] : []),
          "--prompt-interactive",
          input.initialPrompt,
        ];
      },
    },
    options,
  );
}
