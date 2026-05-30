import type { ProviderIdentity } from "./providers.js";

export type ProviderDetectionResult =
  | {
      isAvailable: true;
      executable: string;
    }
  | {
      isAvailable: false;
      reason: string;
      debugReason?: string;
    };

export type ManagedProviderSessionControlTransport = "pty" | "api";
export type ManagedProviderSessionEventSource =
  | "pty"
  | "hooks"
  | "jsonl"
  | "api"
  | "logs";

export interface ManagedProviderSessionCapabilities {
  controlTransport: ManagedProviderSessionControlTransport;
  eventSource: ManagedProviderSessionEventSource;
  supportsProviderSessionId: boolean;
  supportsResume: boolean;
  classifiesSubmittedUserMessageOrigin: boolean;
}

export interface ManagedProviderSessionPhase {
  id: string;
  kind?: string;
  attempt?: number;
}

export type SubmittedUserMessageOrigin = "managed" | "human" | "unknown";

interface ManagedProviderSessionEventBase {
  provider: ProviderIdentity;
  source: ManagedProviderSessionEventSource;
  structured: boolean;
  phaseId?: string;
  providerSessionId?: string;
}

export type ManagedProviderSessionEvent =
  | (ManagedProviderSessionEventBase & {
      type: "session-start";
    })
  | (ManagedProviderSessionEventBase & {
      type: "submitted-user-message";
      message: string;
      origin: SubmittedUserMessageOrigin;
    })
  | (ManagedProviderSessionEventBase & {
      type: "turn-completed";
      assistantMessage?: string;
    })
  | (ManagedProviderSessionEventBase & {
      type: "session-completed";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    });

export type ManagedProviderSessionEventCallback = (
  event: ManagedProviderSessionEvent,
) => void | Promise<void>;

export interface ManagedProviderSessionRepairConfig {
  completionMarker: string;
  phase?: ManagedProviderSessionPhase;
  renderPrompt(validationError: Error): string;
  mapFailure(validationError: Error): Error;
}

export interface ManagedProviderSessionInput {
  workingDirectory: string;
  initialPrompt: string;
  initialCompletionMarker: string;
  model?: string;
  phase?: ManagedProviderSessionPhase;
  validate(): Promise<void>;
  repair?: ManagedProviderSessionRepairConfig;
  continuations?: ManagedProviderSessionContinuation[];
  transcript?: ManagedProviderSessionTranscriptCallbacks;
  onProviderEvent?: ManagedProviderSessionEventCallback;
}

export interface ManagedProviderSessionResumeInput
  extends ManagedProviderSessionInput {
  providerSessionId: string;
}

export interface ManagedProviderSessionContinuation {
  prompt: string;
  completionMarker: string;
  phase?: ManagedProviderSessionPhase;
  onStart?(): void | Promise<void>;
  validate(): Promise<void>;
  repair?: ManagedProviderSessionRepairConfig;
}

export interface ManagedProviderSessionResult {
  repairUsed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ManagedProviderSessionTranscriptCallbacks {
  onProviderOutput?(chunk: string): void | Promise<void>;
  onSubmittedUserMessage?(message: string): void | Promise<void>;
}

export class ManagedProviderSessionNotImplementedError extends Error {
  readonly provider: ProviderIdentity;

  constructor(provider: ProviderIdentity) {
    super(
      `Managed provider sessions are not implemented yet for provider "${provider.id}".`,
    );
    this.name = "ManagedProviderSessionNotImplementedError";
    this.provider = provider;
  }
}

export class IncompleteProviderSessionError extends Error {
  readonly provider: ProviderIdentity;
  readonly completionMarker: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(options: {
    provider: ProviderIdentity;
    completionMarker: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) {
    super(
      `Provider session for "${options.provider.id}" ended before completion marker "${options.completionMarker}" was observed.`,
    );
    this.name = "IncompleteProviderSessionError";
    this.provider = options.provider;
    this.completionMarker = options.completionMarker;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
  }
}

export class ProviderSessionLaunchError extends Error {
  readonly provider: ProviderIdentity;
  readonly cause: unknown;

  constructor(provider: ProviderIdentity, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : "Unknown launch failure";

    super(`Provider session for "${provider.id}" could not be launched: ${causeMessage}.`);
    this.name = "ProviderSessionLaunchError";
    this.provider = provider;
    this.cause = cause;
  }
}

export class InterruptedProviderSessionError extends Error {
  readonly provider: ProviderIdentity;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(options: {
    provider: ProviderIdentity;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) {
    super(`Provider session for "${options.provider.id}" was interrupted.`);
    this.name = "InterruptedProviderSessionError";
    this.provider = options.provider;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
  }
}

export class ProviderSessionCleanupError extends Error {
  readonly provider: ProviderIdentity;
  readonly cause: unknown;

  constructor(provider: ProviderIdentity, cause: unknown) {
    super(
      `Provider session for "${provider.id}" produced valid output but cleanup failed.`,
    );
    this.name = "ProviderSessionCleanupError";
    this.provider = provider;
    this.cause = cause;
  }
}

export class ProviderSessionTranscriptCaptureError extends Error {
  readonly provider: ProviderIdentity;
  readonly cause: unknown;

  constructor(provider: ProviderIdentity, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : "Unknown transcript capture failure";

    super(
      `Provider session for "${provider.id}" could not capture transcript content: ${causeMessage}.`,
    );
    this.name = "ProviderSessionTranscriptCaptureError";
    this.provider = provider;
    this.cause = cause;
  }
}

export class ProviderSessionEventCaptureError extends Error {
  readonly provider: ProviderIdentity;
  readonly cause: unknown;

  constructor(provider: ProviderIdentity, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : "Unknown event capture failure";

    super(
      `Provider session for "${provider.id}" could not capture provider events: ${causeMessage}.`,
    );
    this.name = "ProviderSessionEventCaptureError";
    this.provider = provider;
    this.cause = cause;
  }
}

export interface ManagedSessionAdapter {
  readonly provider: ProviderIdentity;
  readonly capabilities?: ManagedProviderSessionCapabilities;
  detect(): Promise<ProviderDetectionResult>;
  runSession(
    input: ManagedProviderSessionInput,
  ): Promise<ManagedProviderSessionResult>;
  resumeSession?(
    input: ManagedProviderSessionResumeInput,
  ): Promise<ManagedProviderSessionResult>;
}

export function canResumeManagedProviderSession(
  adapter: ManagedSessionAdapter,
): adapter is ManagedSessionAdapter & {
  readonly capabilities: ManagedProviderSessionCapabilities & {
    supportsProviderSessionId: true;
    supportsResume: true;
  };
  resumeSession(
    input: ManagedProviderSessionResumeInput,
  ): Promise<ManagedProviderSessionResult>;
} {
  return (
    adapter.capabilities?.supportsProviderSessionId === true &&
    adapter.capabilities.supportsResume === true &&
    typeof adapter.resumeSession === "function"
  );
}
