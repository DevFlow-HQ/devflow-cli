import { createBuiltInProviderAdapter } from "./builtInProviderAdapter.js";
import {
  BUILT_IN_PROVIDERS,
  type BuiltInProviderId,
  type ProviderAdapter,
  type ProviderDetectionResult,
  type ProviderIdentity,
} from "./providerAdapter.js";

export type DiscoveredProvider =
  | {
      provider: ProviderIdentity;
      isAvailable: true;
      executable: string;
    }
  | {
      provider: ProviderIdentity;
      isAvailable: false;
      reason: string;
    };

export type InstalledProvider = Extract<DiscoveredProvider, { isAvailable: true }>;

export interface ProviderDiscoverySummary {
  availabilityStatus: "none" | "single" | "multiple";
  installedProviderCount: number;
  recommendedProviderId?: BuiltInProviderId;
}

export interface ProviderDiscoveryResult {
  providers: DiscoveredProvider[];
  installedProviders: InstalledProvider[];
  summary: ProviderDiscoverySummary;
}

export interface DiscoverBuiltInProvidersOptions {
  createAdapter?: (providerId: BuiltInProviderId) => ProviderAdapter;
}

function toDiscoveredProvider(
  provider: ProviderIdentity,
  detection: ProviderDetectionResult,
): DiscoveredProvider {
  if (detection.isAvailable) {
    return {
      provider,
      isAvailable: true,
      executable: detection.executable,
    };
  }

  return {
    provider,
    isAvailable: false,
    reason: detection.reason,
  };
}

function buildSummary(installedProviders: InstalledProvider[]): ProviderDiscoverySummary {
  if (installedProviders.length === 0) {
    return {
      availabilityStatus: "none",
      installedProviderCount: 0,
    };
  }

  if (installedProviders.length === 1) {
    return {
      availabilityStatus: "single",
      installedProviderCount: 1,
      recommendedProviderId: installedProviders[0].provider.id,
    };
  }

  return {
    availabilityStatus: "multiple",
    installedProviderCount: installedProviders.length,
  };
}

export async function discoverBuiltInProviders(
  options: DiscoverBuiltInProvidersOptions = {},
): Promise<ProviderDiscoveryResult> {
  const createAdapter = options.createAdapter ?? createBuiltInProviderAdapter;

  const providers = await Promise.all(
    BUILT_IN_PROVIDERS.map(async (provider) => {
      const detection = await createAdapter(provider.id).detect();
      return toDiscoveredProvider(provider, detection);
    }),
  );

  const installedProviders = providers.filter(
    (provider): provider is InstalledProvider => provider.isAvailable,
  );

  return {
    providers,
    installedProviders,
    summary: buildSummary(installedProviders),
  };
}
