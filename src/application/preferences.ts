import { z } from "zod";
import type { OperationLedger } from "./operation-ledger.js";
import type { SubscriptionLifecycle } from "./subscription-lifecycle.js";
import type { UpdateStream } from "./update-stream.js";
import type { Catalog } from "../catalog/catalog.js";
import type {
  AppearancePreferences,
  ChangePreferencesInput,
  PreferencesSnapshot,
  Problem,
} from "./projection-port.js";

// Application owns the semantic vocabulary; presentation owns palette data.
const theme = z.enum([
  "aura",
  "ayu",
  "catppuccin",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "cobalt2",
  "dracula",
  "everforest",
  "flexoki",
  "gruvbox",
  "kanagawa",
  "matrix",
  "mercury",
  "nightowl",
  "nord",
  "one-dark",
  "osaka-jade",
  "palenight",
  "rosepine",
  "solarized",
  "synthwave84",
  "tokyonight",
  "vesper",
  "zenburn",
  "carbonfox",
]);
const appearance = z.enum(["dark", "light"]);
function resolvePreferences(
  values: Readonly<Record<string, string | undefined>>,
): AppearancePreferences {
  const parsedTheme = theme.safeParse(values.theme);
  const parsedAppearance = appearance.safeParse(values.appearance);
  return {
    theme: parsedTheme.success ? parsedTheme.data : "everforest",
    appearance: parsedAppearance.success ? parsedAppearance.data : "dark",
  };
}

function readPreferences(
  catalog: Pick<Catalog, "getPreference">,
): PreferencesSnapshot {
  const values: Record<string, string | undefined> = {};
  let notice: Problem | undefined;
  for (const key of ["theme", "appearance"]) {
    try {
      values[key] = catalog.getPreference(key);
    } catch (cause) {
      notice = {
        code: "preferences-read-failed",
        explanation:
          "Secant could not read saved appearance Preferences. Unreadable values use defaults.",
        remediation:
          "Retry `secant settings show` after repairing Preferences storage.",
        possibleEffects: "none",
        cause,
      };
    }
  }
  return {
    family: "preferences",
    preferences: resolvePreferences(values),
    supportedThemes: theme.options,
    ...(notice === undefined ? {} : { notice }),
    actionOffers: [{ action: "change-preferences" }],
  };
}

const patchSchema = z
  .strictObject({ theme: theme.optional(), appearance: appearance.optional() })
  .refine(
    (patch) => patch.theme !== undefined || patch.appearance !== undefined,
    { message: "Supply a theme or appearance." },
  );

export function createPreferences(deps: {
  readonly catalog: Catalog;
  readonly operations: OperationLedger;
  readonly subscriptions: SubscriptionLifecycle;
}) {
  const { catalog, operations, subscriptions } = deps;
  const observers = new Set<UpdateStream<PreferencesSnapshot>>();
  return {
    open(): import("./projection-port.js").OpenedProjection<PreferencesSnapshot> {
      const updates = subscriptions.open<PreferencesSnapshot>((updates) => {
        observers.add(updates);
        return () => {
          observers.delete(updates);
        };
      });
      return {
        snapshot: readPreferences(catalog),
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    },
    submit(operationId: string, input: ChangePreferencesInput) {
      return operations.submit(
        {
          operationId,
          operation: "change-preferences",
          replayKey: JSON.stringify([input.theme, input.appearance]),
        },
        () => {
          const parsed = patchSchema.safeParse(input);
          if (!parsed.success)
            return {
              admitted: false,
              problem: {
                code: "invalid-preferences",
                explanation:
                  "Supply at least one canonical theme identifier or lowercase dark/light appearance.",
                remediation:
                  "Use `secant settings set --theme <id> --appearance dark|light` with supported values.",
                possibleEffects: "none",
                fieldViolations: parsed.error.issues.map((issue) => ({
                  field: issue.path.join(".") || "preferences",
                  explanation: issue.message,
                })),
              },
            };
          const patch: Record<string, string> = {};
          if (parsed.data.theme !== undefined) patch.theme = parsed.data.theme;
          if (parsed.data.appearance !== undefined)
            patch.appearance = parsed.data.appearance;
          return {
            admitted: true,
            settle: () => {
              let snapshot: PreferencesSnapshot;
              try {
                snapshot = catalog.changePreferences(patch, (getPreference) =>
                  readPreferences({ getPreference }),
                );
              } catch (cause) {
                return {
                  status: "not-applied",
                  problem: {
                    code: "preferences-save-failed",
                    explanation:
                      "Secant could not save appearance Preferences. No Preferences were changed.",
                    remediation:
                      "Repair Preferences storage and retry with a new Operation id.",
                    possibleEffects: "none",
                    cause,
                  },
                };
              }
              for (const observer of observers)
                observer.push({ kind: "durable", snapshot });
              return {
                status: "applied",
                preferencesChange: snapshot.preferences,
              };
            },
          };
        },
      );
    },
  };
}
