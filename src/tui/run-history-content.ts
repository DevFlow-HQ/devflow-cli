import { createSignal, onCleanup } from "solid-js";
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
    open(reference: HistoryTextReference): void {
      close();
      selected = reference;
      void load();
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
