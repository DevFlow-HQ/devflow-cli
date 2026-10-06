import { randomUUID } from "node:crypto";
import type { Accessor } from "solid-js";
import type {
  AppearancePreferences,
  PreferencesSnapshot,
  ProjectionPort,
} from "../application/projection-port.js";
import { followProjection } from "./follow.js";
import { submitAndSettle, type SettleOutcome } from "./submit-and-settle.js";

/** Saved values are followed, but active appearance is initialized only at launch. */
export interface PreferencesView {
  readonly snapshot: Accessor<PreferencesSnapshot>;
  save(preferences: AppearancePreferences): Accessor<SettleOutcome>;
}

export function createLivePreferencesView(
  port: ProjectionPort,
): PreferencesView {
  const snapshot = followProjection(() =>
    port.openProjection({ family: "preferences" }),
  );
  return {
    snapshot,
    save: (input) =>
      submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "change-preferences",
        input,
      }),
  };
}
