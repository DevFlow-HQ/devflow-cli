import type { ProcessLaunchContainment } from "../process/process.js";
import type { HarnessContainmentObserver } from "./harness.js";

/** Normalize launch evidence without exposing the native acquisition cause. */
export function reportContainment(
  observer: HarnessContainmentObserver | undefined,
  evidence: ProcessLaunchContainment | undefined,
  session?: string,
): void {
  if (evidence === undefined) return;
  try {
    observer?.({
      kind: evidence.kind,
      ...(session === undefined ? {} : { session }),
    });
  } catch {
    // Observation never changes a Harness outcome.
  }
}
