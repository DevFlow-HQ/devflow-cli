import {
  createContext,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type { SearchEntry } from "./command-search.js";

/** Action owners publish current commands. This catalog supplies discovery, not
 * admission: each action reads its current Action Offer when it runs. */
export interface AppCommand extends SearchEntry {
  readonly available?: boolean;
}
function createCatalog() {
  const [owners, setOwners] = createSignal<
    readonly Accessor<readonly AppCommand[]>[]
  >([]);
  let palette: () => void = () => {};
  let preempt: () => void = () => {};
  let retry: () => void = () => {};
  const all = () => {
    const order = [
      "start-run",
      "bundles",
      "previous-runs",
      "harnesses",
      "model",
      "effort",
      "end-step",
      "continue",
      "end-stage",
      "themes",
      "quit",
    ];
    return owners()
      .flatMap((owner) => owner())
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  };
  return {
    entries: () => all().filter((entry) => entry.available !== false),
    /** Known names own the draft even while their Offer is unavailable. */
    knownSlash(text: string) {
      const [word = ""] = text.trimStart().split(/\s/, 1);
      const name = word.toLowerCase();
      const entry = all().find(
        (entry) =>
          entry.slash !== undefined &&
          [entry.slash, ...(entry.aliases ?? [])].some(
            (slash) => name === `/${slash}`,
          ),
      );
      return entry === undefined
        ? undefined
        : {
            entry,
            arguments: text.trimStart().slice(word.length).trim().length > 0,
          };
    },
    register(owner: Accessor<readonly AppCommand[]>) {
      setOwners((all) => [...all, owner]);
      onCleanup(() => setOwners((all) => all.filter((item) => item !== owner)));
    },
    shell(actions: { palette(): void; preempt(): void; retry(): void }) {
      palette = actions.palette;
      preempt = actions.preempt;
      retry = actions.retry;
    },
    openPalette: () => palette(),
    preempt: () => preempt(),
    retry: () => retry(),
  };
}
const ctx = createContext<ReturnType<typeof createCatalog>>();
export function AppCommandsProvider(props: ParentProps) {
  return <ctx.Provider value={createCatalog()}>{props.children}</ctx.Provider>;
}
export function useAppCommands() {
  const value = useContext(ctx);
  if (!value) throw new Error("App commands need their provider");
  return value;
}
