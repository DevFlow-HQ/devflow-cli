import type { ProjectionSnapshot } from "./projection-port.js";
import { UpdateStream } from "./update-stream.js";

/** Application-wide lifetime of opened streams, independent of their producers. */
export class SubscriptionLifecycle {
  private readonly streams = new Set<Pick<UpdateStream, "end">>();

  open<S extends ProjectionSnapshot = ProjectionSnapshot>(
    subscribe?: (updates: UpdateStream<S>) => () => void,
  ): UpdateStream<S> {
    let unsubscribe: (() => void) | undefined;
    const updates = new UpdateStream<S>(() => {
      this.streams.delete(updates);
      unsubscribe?.();
      unsubscribe = undefined;
    });
    this.streams.add(updates);
    unsubscribe = subscribe?.(updates);
    return updates;
  }

  shutdown(): void {
    for (const updates of this.streams) updates.end("application-shutdown");
  }
}
