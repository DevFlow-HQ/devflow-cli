import semver from "semver";
import type { Problem } from "./projection-port.js";

// --- version facts ---------------------------------------------------------

export function engineRange(
  engine: string,
  engineVersion: string,
):
  | { readonly range: string; readonly satisfied: true }
  | {
      readonly range: string;
      readonly satisfied: false;
      readonly note: string;
    } {
  const floor = engine.slice(">=".length);
  // includePrerelease so a prerelease Secant build above the floor (e.g. an RC)
  // still satisfies the range; without it semver excludes every prerelease host.
  const satisfied = semver.satisfies(engineVersion, engine, {
    includePrerelease: true,
  });
  return satisfied
    ? { range: engine, satisfied: true }
    : {
        range: engine,
        satisfied: false,
        note: `needs Secant ≥ ${semver.major(floor)}.${semver.minor(floor)}`,
      };
}

/** Translate the shared range rule into an upgrade refusal. No dev exemption here. */
export function engineProblem(
  engine: string,
  engineVersion: string,
): Problem | undefined {
  const range = engineRange(engine, engineVersion);
  return range.satisfied
    ? undefined
    : {
        code: "engine-unsupported",
        explanation: range.note,
        remediation:
          "Upgrade Secant to a version that satisfies this Bundle's engine range, then try again.",
        possibleEffects: "none",
        correction: "bundle",
        details: { range: engine, engineVersion },
      };
}
