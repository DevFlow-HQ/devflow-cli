import Enquirer from "enquirer";

import {
  discoverBuiltInProviders,
  type DiscoveredProvider,
  type ProviderDiscoveryResult,
} from "./adapters/providerDiscovery.js";
import {
  BUILT_IN_PROVIDERS,
  getBuiltInProviderIdentity,
  type BuiltInProviderId,
} from "./adapters/providerAdapter.js";
import {
  persistRepoConfig,
  type PersistRepoConfigOptions,
} from "./repoConfig.js";

const PROVIDER_SELECTION_MESSAGE = "Select a default provider";

export interface BootstrapWriter {
  write(chunk: string): void;
}

export interface ProviderSelectionChoice {
  value: BuiltInProviderId;
  label: string;
  disabled: boolean;
  unavailableReason?: string;
}

export interface PromptForProviderSelectionOptions {
  message: string;
  choices: ProviderSelectionChoice[];
}

export interface ResolveBootstrapProviderOptions {
  projectRoot: string;
  stdout?: BootstrapWriter;
  discoverProviders?: () => Promise<ProviderDiscoveryResult>;
  persistRepoConfig?: (options: PersistRepoConfigOptions) => Promise<void>;
  promptForProviderSelection?: (
    options: PromptForProviderSelectionOptions,
  ) => Promise<BuiltInProviderId | undefined>;
}

export class NoSupportedProvidersInstalledError extends Error {
  constructor() {
    super(
      `No supported providers are currently installed. Install one of the supported providers and run DevFlow again: ${BUILT_IN_PROVIDERS.map((provider) => formatProviderLabel(provider.id)).join(", ")}.`,
    );
    this.name = "NoSupportedProvidersInstalledError";
  }
}

export class ProviderSetupCancelledError extends Error {
  constructor() {
    super("Provider setup was cancelled before a default was saved.");
    this.name = "ProviderSetupCancelledError";
  }
}

function formatProviderLabel(providerId: BuiltInProviderId): string {
  const provider = getBuiltInProviderIdentity(providerId);
  return `${provider.displayName} (${provider.id})`;
}

function createProviderSelectionChoices(
  providers: DiscoveredProvider[],
): ProviderSelectionChoice[] {
  return providers.map((provider) => ({
    value: provider.provider.id,
    label: formatProviderLabel(provider.provider.id),
    disabled: !provider.isAvailable,
    ...(provider.isAvailable
      ? {}
      : { unavailableReason: provider.reason }),
  }));
}

async function saveDefaultProvider(
  projectRoot: string,
  providerId: BuiltInProviderId,
  persistConfig: (options: PersistRepoConfigOptions) => Promise<void>,
  stdout?: BootstrapWriter,
): Promise<void> {
  await persistConfig({
    projectRoot,
    config: { defaultProvider: providerId },
  });

  stdout?.write(`Saved default provider: ${formatProviderLabel(providerId)}.\n`);
}

async function defaultPromptForProviderSelection(
  options: PromptForProviderSelectionOptions,
): Promise<BuiltInProviderId | undefined> {
  try {
    const answer = await Enquirer.prompt<{ providerId: BuiltInProviderId }>({
      type: "select",
      name: "providerId",
      message: options.message,
      choices: options.choices.map((choice) => ({
        name: choice.value,
        message: choice.label,
        disabled: choice.disabled ? (choice.unavailableReason ?? true) : false,
      })),
    });

    return answer.providerId;
  } catch (error) {
    if (error === "") {
      return undefined;
    }

    if (error instanceof Error && /cancelled/i.test(error.message)) {
      return undefined;
    }

    throw error;
  }
}

export async function resolveBootstrapProvider(
  options: ResolveBootstrapProviderOptions,
): Promise<BuiltInProviderId> {
  const discoverProviders =
    options.discoverProviders ?? discoverBuiltInProviders;
  const persistConfig = options.persistRepoConfig ?? persistRepoConfig;
  const promptForProviderSelection =
    options.promptForProviderSelection ?? defaultPromptForProviderSelection;
  const discovery = await discoverProviders();

  if (discovery.summary.availabilityStatus === "none") {
    throw new NoSupportedProvidersInstalledError();
  }

  if (
    discovery.summary.availabilityStatus === "single" &&
    discovery.summary.recommendedProviderId
  ) {
    await saveDefaultProvider(
      options.projectRoot,
      discovery.summary.recommendedProviderId,
      persistConfig,
      options.stdout,
    );
    return discovery.summary.recommendedProviderId;
  }

  const selectedProviderId = await promptForProviderSelection({
    message: PROVIDER_SELECTION_MESSAGE,
    choices: createProviderSelectionChoices(discovery.providers),
  });

  if (!selectedProviderId) {
    throw new ProviderSetupCancelledError();
  }

  await saveDefaultProvider(
    options.projectRoot,
    selectedProviderId,
    persistConfig,
    options.stdout,
  );

  return selectedProviderId;
}
