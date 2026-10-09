import { createRoot, createSignal, onCleanup, untrack } from "solid-js";
import type {
  HistoryContentRead,
  HistoryTextReference,
  ProjectionPort,
} from "../application/projection-port.js";

/** One demand-read portion, with no growing body, prefetch or cursor stack. */
export function createHistoryContentReader(
  deps: Pick<ProjectionPort, "readHistoryContent" | "releaseHistoryRead">,
) {
  const [state, setState] = createSignal<{
    readonly loading: boolean;
    readonly read?: HistoryContentRead;
  }>({ loading: false });
  let selected: HistoryTextReference | undefined;
  let abort = new AbortController();
  let generation = 0;
  let readId: string | undefined;
  let currentCursor: string | undefined;
  function close(): void {
    generation++;
    abort.abort();
    abort = new AbortController();
    if (readId !== undefined) deps.releaseHistoryRead(readId);
    readId = undefined;
    selected = undefined;
    currentCursor = undefined;
    setState({ loading: false });
  }
  async function load(continuation?: string): Promise<void> {
    if (!selected || state().loading) return;
    const reference = selected;
    const requestGeneration = ++generation;
    const signal = abort.signal;
    setState((previous) => ({ ...previous, loading: true }));
    const read = await deps.readHistoryContent({
      reference,
      continuation,
      signal,
    });
    if (requestGeneration !== generation || signal.aborted) {
      if (read.found) deps.releaseHistoryRead(read.readId);
      return;
    }
    if (read.found) readId = read.readId;
    currentCursor = continuation;
    setState({ loading: false, read });
  }
  onCleanup(close);
  return {
    state,
    /** `last` follows a growing value: it reads the final portion after the first. */
    open(
      reference: HistoryTextReference,
      from: "first" | "last" = "first",
    ): void {
      close();
      selected = reference;
      void load().then(() => {
        const read = state().read;
        if (from === "last" && selected === reference && read?.found)
          if (read.last !== undefined) void load(read.last);
      });
    },
    close,
    retry(): void {
      if (state().loading) return;
      if (readId) deps.releaseHistoryRead(readId);
      readId = undefined;
      // A failed initial read retries the same reference; a failed traversal restarts it.
      currentCursor = undefined;
      void load();
    },
    move(direction: "previous" | "next" | "first" | "last"): boolean {
      const current = state();
      if (current.loading) return true;
      if (!current.read?.found) {
        if (selected) {
          void load(currentCursor);
          return true;
        }
        return false;
      }
      const cursor = current.read[direction];
      if (cursor === undefined) return false;
      void load(cursor);
      return true;
    },
  };
}

type Reader = ReturnType<typeof createHistoryContentReader>;

/** At most `limit` keyed readers, one per wanted reference. A reader is released
 * when its key leaves the wanted set or names a different exact version. */
export function createHistoryContentReaders(
  deps: Pick<ProjectionPort, "readHistoryContent" | "releaseHistoryRead">,
  limit: number,
) {
  type Entry = {
    readonly reference: string;
    readonly reader: Reader;
    readonly dispose: () => void;
  };
  const [entries, setEntries] = createSignal<ReadonlyMap<string, Entry>>(
    new Map(),
  );
  onCleanup(() => {
    for (const entry of untrack(entries).values()) entry.dispose();
  });
  return {
    get: (key: string): Reader | undefined => entries().get(key)?.reader,
    sync(
      wanted: readonly {
        readonly key: string;
        readonly reference: HistoryTextReference;
        readonly from?: "first" | "last";
      }[],
    ): void {
      const kept = wanted.slice(0, limit);
      const previous = untrack(entries);
      const next = new Map(previous);
      for (const [key, entry] of next)
        if (
          !kept.some(
            (item) => item.key === key && item.reference.id === entry.reference,
          )
        ) {
          entry.dispose();
          next.delete(key);
        }
      for (const item of kept)
        if (!next.has(item.key))
          next.set(
            item.key,
            untrack(() =>
              createRoot((dispose) => {
                const reader = createHistoryContentReader(deps);
                reader.open(item.reference, item.from);
                return { reference: item.reference.id, reader, dispose };
              }),
            ),
          );
      if (
        next.size !== previous.size ||
        [...next].some(([key, entry]) => previous.get(key) !== entry)
      )
        setEntries(next);
    },
  };
}
