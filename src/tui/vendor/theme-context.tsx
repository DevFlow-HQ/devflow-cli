import {
  batch,
  createContext,
  createSignal,
  useContext,
  type ParentProps,
  type Accessor,
} from "solid-js";
import { createStore } from "solid-js/store";
import type { AppearancePreferences } from "../../application/projection-port.js";
import { DEFAULT_THEMES, resolveTheme, type Theme } from "./theme.js";

// Rebuilt against OpenCode packages/tui/src/context/theme.tsx at 1ead9e3d7f.
// Keep one reactive palette object for existing destructuring consumers. Secant
// owns local preview; Application owns saved Preferences (ADR 0037).
interface ThemeContext {
  readonly theme: Theme;
  readonly active: Accessor<AppearancePreferences>;
  apply(preferences: AppearancePreferences): void;
}
const ctx = createContext<ThemeContext>();
export function ThemeProvider(
  props: ParentProps<{ initial: AppearancePreferences }>,
) {
  const resolve = (pair: AppearancePreferences) =>
    resolveTheme(
      DEFAULT_THEMES[pair.theme] ?? DEFAULT_THEMES.everforest!,
      pair.appearance,
    );
  const [active, setActive] = createSignal(props.initial);
  const [theme, setTheme] = createStore(resolve(props.initial));
  const value: ThemeContext = {
    theme,
    active,
    apply(pair) {
      batch(() => {
        setActive(pair);
        setTheme(resolve(pair));
      });
    },
  };
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>;
}
export function useTheme(): ThemeContext {
  const value = useContext(ctx);
  if (!value) throw new Error("useTheme must be used within a ThemeProvider");
  return value;
}
