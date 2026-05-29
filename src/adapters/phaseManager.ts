import {
  type ManagedProviderSessionContinuation,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionEventSource,
  type ManagedProviderSessionInput,
  type ManagedProviderSessionRepairConfig,
} from "./managedSessionAdapter.js";
import type { ProviderIdentity } from "./providers.js";

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

export type PhaseManagerEventInput = DistributiveOmit<
  ManagedProviderSessionEvent,
  "provider" | "source" | "structured" | "phaseId"
>;

export type PhaseManagerState =
  | {
      type: "initial";
    }
  | {
      type: "continuation";
      index: number;
    }
  | {
      type: "repair";
      base:
        | {
            type: "initial";
          }
        | {
            type: "continuation";
            index: number;
          };
      attempt: number;
    }
  | {
      type: "finalized";
    };

export interface PhaseManagerOptions {
  provider: ProviderIdentity;
  source: ManagedProviderSessionEventSource;
  structured: boolean;
  input: ManagedProviderSessionInput;
  submitPrompt(prompt: string): void | Promise<void>;
  finalize(): void | Promise<void>;
}

export interface PhaseManager {
  handleEvent(event: PhaseManagerEventInput): Promise<void>;
  getState(): PhaseManagerState;
  isFinalized(): boolean;
  repairUsed(): boolean;
}

export function createPhaseManager(options: PhaseManagerOptions): PhaseManager {
  let state: PhaseManagerState = { type: "initial" };
  let usedRepair = false;

  async function handleEvent(event: PhaseManagerEventInput): Promise<void> {
    if (state.type === "finalized") {
      return;
    }

    const phaseId = getActivePhaseId(state, options.input);
    await emitProviderEvent(event, phaseId);

    if (
      event.type !== "turn-completed" ||
      event.assistantMessage === undefined
    ) {
      return;
    }

    const completionMarker = getActiveCompletionMarker(state, options.input);

    if (
      completionMarker === undefined ||
      !event.assistantMessage.includes(completionMarker)
    ) {
      return;
    }

    if (state.type === "repair") {
      await completeRepairPhase(state);
      return;
    }

    await completeActivePhase();
  }

  async function emitProviderEvent(
    event: PhaseManagerEventInput,
    phaseId: string | undefined,
  ): Promise<void> {
    await options.input.onProviderEvent?.({
      ...event,
      provider: options.provider,
      source: options.source,
      structured: options.structured,
      phaseId,
    } as ManagedProviderSessionEvent);
  }

  async function completeActivePhase(): Promise<void> {
    try {
      await validatePhase(state, options.input);
    } catch (error) {
      const repair = getActiveRepair(state, options.input);

      if (!(error instanceof Error) || !repair) {
        throw error;
      }

      const base = toRepairBaseState(state);
      const nextAttempt =
        state.type === "repair" && isSameBaseState(state.base, base)
          ? state.attempt + 1
          : 1;

      state = {
        type: "repair",
        base,
        attempt: nextAttempt,
      };
      usedRepair = true;

      await options.submitPrompt(repair.renderPrompt(error));
      return;
    }

    await advanceAfterSuccessfulValidation();
  }

  async function completeRepairPhase(
    repairState: Extract<PhaseManagerState, { type: "repair" }>,
  ): Promise<void> {
    const repair = getActiveRepair(repairState, options.input);

    if (!repair) {
      return;
    }

    try {
      await validatePhase(repairState, options.input);
    } catch (error) {
      throw repair.mapFailure(error as Error);
    }

    state = repairState.base;
    await advanceAfterSuccessfulValidation();
  }

  async function advanceAfterSuccessfulValidation(): Promise<void> {
    const nextContinuationIndex =
      state.type === "continuation" ? state.index + 1 : 0;
    const nextContinuation = options.input.continuations?.[nextContinuationIndex];

    if (!nextContinuation) {
      state = {
        type: "finalized",
      };
      await options.finalize();
      return;
    }

    state = {
      type: "continuation",
      index: nextContinuationIndex,
    };
    await nextContinuation.onStart?.();
    await options.submitPrompt(nextContinuation.prompt);
  }

  return {
    handleEvent,
    getState() {
      return state;
    },
    isFinalized() {
      return state.type === "finalized";
    },
    repairUsed() {
      return usedRepair;
    },
  };
}

function validatePhase(
  state: PhaseManagerState,
  input: ManagedProviderSessionInput,
): Promise<void> {
  const continuation = getActiveContinuation(state, input);

  if (continuation) {
    return continuation.validate();
  }

  return input.validate();
}

function getActiveContinuation(
  state: PhaseManagerState,
  input: ManagedProviderSessionInput,
): ManagedProviderSessionContinuation | undefined {
  const baseState = state.type === "repair" ? state.base : state;

  if (baseState.type !== "continuation") {
    return undefined;
  }

  return input.continuations?.[baseState.index];
}

function getActiveRepair(
  state: PhaseManagerState,
  input: ManagedProviderSessionInput,
): ManagedProviderSessionRepairConfig | undefined {
  return getActiveContinuation(state, input)?.repair ?? input.repair;
}

function getActiveCompletionMarker(
  state: PhaseManagerState,
  input: ManagedProviderSessionInput,
): string | undefined {
  if (state.type === "repair") {
    return getActiveRepair(state, input)?.completionMarker;
  }

  return (
    getActiveContinuation(state, input)?.completionMarker ??
    input.initialCompletionMarker
  );
}

function getActivePhaseId(
  state: PhaseManagerState,
  input: ManagedProviderSessionInput,
): string | undefined {
  if (state.type === "finalized") {
    return undefined;
  }

  if (state.type === "repair") {
    const basePhaseId = getBasePhaseId(state.base, input);
    const repair = getActiveRepair(state, input);

    return repair?.phase?.id ?? `${basePhaseId}:repair-${state.attempt}`;
  }

  return getBasePhaseId(state, input);
}

function getBasePhaseId(
  state: Exclude<PhaseManagerState, { type: "repair" } | { type: "finalized" }>,
  input: ManagedProviderSessionInput,
): string {
  if (state.type === "continuation") {
    return (
      input.continuations?.[state.index]?.phase?.id ??
      `continuation-${state.index + 1}`
    );
  }

  return input.phase?.id ?? "initial";
}

function toRepairBaseState(
  state: PhaseManagerState,
): Extract<PhaseManagerState, { type: "repair" }>["base"] {
  if (state.type === "continuation") {
    return {
      type: "continuation",
      index: state.index,
    };
  }

  return {
    type: "initial",
  };
}

function isSameBaseState(
  left: Extract<PhaseManagerState, { type: "repair" }>["base"],
  right: Extract<PhaseManagerState, { type: "repair" }>["base"],
): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "initial") {
    return true;
  }

  return right.type === "continuation" && left.index === right.index;
}
