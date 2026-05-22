import Enquirer from "enquirer";

import {
  discoverBuiltInProviders,
  type DiscoveredProvider,
  type ProviderDiscoveryResult,
} from "./adapters/providerDiscovery.js";
import {
  BUILT_IN_PROVIDERS,
  getBuiltInProviderIdentity,
  isBuiltInProviderId,
  type BuiltInProviderId,
} from "./adapters/providers.js";
import {
  createDevFlowState,
  type DevFlowState,
} from "./devflowState.js";

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
  devFlowState?: DevFlowState;
  stdout?: BootstrapWriter;
  explicitProviderId?: string;
  savedProviderId?: BuiltInProviderId;
  discoverProviders?: () => Promise<ProviderDiscoveryResult>;
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

export class UnsupportedProviderError extends Error {
  constructor(providerId: string) {
    super(
      `Unsupported provider: ${providerId}. Supported providers: ${BUILT_IN_PROVIDERS.map((provider) => formatProviderLabel(provider.id)).join(", ")}.`,
    );
    this.name = "UnsupportedProviderError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(
    source: "requested" | "saved",
    providerId: BuiltInProviderId,
    reason: string,
  ) {
    const sourceLabel =
      source === "requested" ? "Requested provider" : "Saved default provider";

    super(
      `${sourceLabel} ${formatProviderLabel(providerId)} is currently unavailable: ${reason}.`,
    );
    this.name = "ProviderUnavailableError";
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

function resolveAvailableDiscoveredProvider(
  discovery: ProviderDiscoveryResult,
  providerId: BuiltInProviderId,
  source: "requested" | "saved",
): BuiltInProviderId {
  const discoveredProvider = discovery.providers.find(
    (provider) => provider.provider.id === providerId,
  );

  if (!discoveredProvider || !discoveredProvider.isAvailable) {
    throw new ProviderUnavailableError(
      source,
      providerId,
      discoveredProvider?.reason ?? "Not installed",
    );
  }

  return providerId;
}

async function saveDefaultProvider(
  devFlowState: DevFlowState,
  providerId: BuiltInProviderId,
  stdout?: BootstrapWriter,
): Promise<void> {
  await devFlowState.config.save({ defaultProvider: providerId });

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
  const promptForProviderSelection =
    options.promptForProviderSelection ?? defaultPromptForProviderSelection;
  const devFlowState =
    options.devFlowState ?? createDevFlowState({ projectRoot: options.projectRoot });

  if (options.explicitProviderId) {
    if (!isBuiltInProviderId(options.explicitProviderId)) {
      throw new UnsupportedProviderError(options.explicitProviderId);
    }

    const discovery = await discoverProviders();
    return resolveAvailableDiscoveredProvider(
      discovery,
      options.explicitProviderId,
      "requested",
    );
  }

  if (options.savedProviderId) {
    const discovery = await discoverProviders();
    return resolveAvailableDiscoveredProvider(
      discovery,
      options.savedProviderId,
      "saved",
    );
  }

  const discovery = await discoverProviders();

  if (discovery.summary.availabilityStatus === "none") {
    throw new NoSupportedProvidersInstalledError();
  }

  if (
    discovery.summary.availabilityStatus === "single" &&
    discovery.summary.recommendedProviderId
  ) {
    await saveDefaultProvider(
      devFlowState,
      discovery.summary.recommendedProviderId,
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
    devFlowState,
    selectedProviderId,
    options.stdout,
  );

  return selectedProviderId;
}
