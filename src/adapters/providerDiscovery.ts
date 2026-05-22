import { createBuiltInProviderAdapter } from "./builtInProviderAdapter.js";
import {
  BUILT_IN_PROVIDERS,
  type BuiltInProviderId,
  type ProviderIdentity,
} from "./providers.js";
import {
  type ProviderAdapter,
  type ProviderDetectionResult,
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
      debugReason?: string;
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

export const UNSUPPORTED_PROVIDER_REASON =
  "This provider is not supported yet by DevFlow.";

const UNAVAILABLE_PROVIDER_REASON = "This provider is currently unavailable.";

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
    ...(detection.debugReason === undefined
      ? {}
      : { debugReason: detection.debugReason }),
  };
}

function toUnavailableProviderFromFailure(
  provider: ProviderIdentity,
  error: unknown,
): DiscoveredProvider {
  const debugReason = error instanceof Error ? error.message : String(error);
  const reason = debugReason.includes("is not wired yet")
    ? UNSUPPORTED_PROVIDER_REASON
    : UNAVAILABLE_PROVIDER_REASON;

  return {
    provider,
    isAvailable: false,
    reason,
    ...(debugReason.length === 0 ? {} : { debugReason }),
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
      try {
        const detection = await createAdapter(provider.id).detect();
        return toDiscoveredProvider(provider, detection);
      } catch (error) {
        return toUnavailableProviderFromFailure(provider, error);
      }
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
