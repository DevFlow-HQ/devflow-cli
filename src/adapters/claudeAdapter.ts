import {
  createCommandManagedSessionAdapter,
  type CommandManagedSessionAdapterOptions,
} from "./commandManagedSessionAdapter.js";
import type {
  ManagedProviderSessionCapabilities,
  ManagedSessionAdapter,
} from "./managedSessionAdapter.js";

export type ClaudeManagedSessionEventSource = "pty" | "hooks";

export interface ClaudeAdapterOptions
  extends CommandManagedSessionAdapterOptions {
  eventSource?: ClaudeManagedSessionEventSource;
}

const CLAUDE_PTY_FALLBACK_CAPABILITIES: ManagedProviderSessionCapabilities = {
  controlTransport: "pty",
  eventSource: "pty",
  supportsProviderSessionId: false,
  supportsResume: false,
  classifiesSubmittedUserMessageOrigin: false,
};

const CLAUDE_HOOK_CAPABILITIES: ManagedProviderSessionCapabilities = {
  controlTransport: "pty",
  eventSource: "hooks",
  supportsProviderSessionId: true,
  supportsResume: false,
  classifiesSubmittedUserMessageOrigin: true,
};

export function createClaudeAdapter(
  options: ClaudeAdapterOptions = {},
): ManagedSessionAdapter {
  const adapter = createCommandManagedSessionAdapter(
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

  return {
    ...adapter,
    capabilities:
      options.eventSource === "hooks"
        ? CLAUDE_HOOK_CAPABILITIES
        : CLAUDE_PTY_FALLBACK_CAPABILITIES,
  };
}
