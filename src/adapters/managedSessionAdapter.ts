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

export interface ManagedProviderSessionRepairConfig {
  completionMarker: string;
  renderPrompt(validationError: Error): string;
  mapFailure(validationError: Error): Error;
}

export interface ManagedProviderSessionInput {
  workingDirectory: string;
  initialPrompt: string;
  initialCompletionMarker: string;
  model?: string;
  validate(): Promise<void>;
  repair?: ManagedProviderSessionRepairConfig;
}

export interface ManagedProviderSessionResult {
  repairUsed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
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

export interface ManagedSessionAdapter {
  readonly provider: ProviderIdentity;
  detect(): Promise<ProviderDetectionResult>;
  runSession(
    input: ManagedProviderSessionInput,
  ): Promise<ManagedProviderSessionResult>;
}
