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

// Selectable MVP surface. Deferred built-ins stay wired above for adapter tests.
export const SUPPORTED_PROVIDER_IDS = [
  "claude",
  "codex",
] as const satisfies readonly BuiltInProviderId[];
export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

export function isBuiltInProviderId(
  providerId: string,
): providerId is BuiltInProviderId {
  return BUILT_IN_PROVIDER_IDS.includes(providerId as BuiltInProviderId);
}

export function isSupportedProviderId(
  providerId: string,
): providerId is BuiltInProviderId {
  return SUPPORTED_PROVIDER_IDS.includes(providerId as SupportedProviderId);
}

export function getBuiltInProviderIdentity(
  providerId: BuiltInProviderId,
): ProviderIdentity {
  const provider = BUILT_IN_PROVIDERS.find(
    (candidate) => candidate.id === providerId,
  );

  if (!provider) {
    throw new Error(`Unknown built-in provider '${providerId}'.`);
  }

  return provider;
}
