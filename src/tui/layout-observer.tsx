import { createContext, useContext, type ParentProps } from "solid-js";

/** Measurement hook for the presentation layouts, including offscreen rows. */
export type LayoutObserver = (event: {
  /** `history-row-at` counts row-at-line lookups; its `id` is the line. */
  readonly kind: "history" | "transcript" | "inspection" | "history-row-at";
  readonly id: string;
  readonly width: number;
}) => void;

const LayoutContext = createContext<LayoutObserver>(() => {});

export function LayoutObserverProvider(
  props: ParentProps<{ observer: LayoutObserver | undefined }>,
) {
  return (
    <LayoutContext.Provider value={props.observer ?? (() => {})}>
      {props.children}
    </LayoutContext.Provider>
  );
}

export function useLayoutObserver(): LayoutObserver {
  return useContext(LayoutContext);
}
