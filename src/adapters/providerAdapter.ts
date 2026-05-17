export const BUILT_IN_PROVIDERS = [
  { id: "claude", displayName: "Claude" },
  { id: "gemini", displayName: "Gemini" },
  { id: "codex", displayName: "Codex" },
  { id: "opencode", displayName: "OpenCode" },
] as const;

export const BUILT_IN_PROVIDER_IDS = BUILT_IN_PROVIDERS.map(
  (provider) => provider.id,
);

export type ProviderIdentity = (typeof BUILT_IN_PROVIDERS)[number];
export type BuiltInProviderId = ProviderIdentity["id"];

export type ProviderDetectionResult =
  | {
      isAvailable: true;
      executable: string;
    }
  | {
      isAvailable: false;
      reason: string;
    };

export interface ProviderRunInput {
  prompt: string;
  workingDirectory: string;
  model?: string;
}

export interface ProviderRunResult {
  success: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProviderAdapter {
  readonly provider: ProviderIdentity;
  detect(): Promise<ProviderDetectionResult>;
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
}
