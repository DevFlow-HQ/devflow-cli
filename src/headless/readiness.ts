import type {
  ObserverEnd,
  OpenedProjection,
  Problem,
  ProjectionSnapshot,
} from "../application/projection-port.js";

/** Observe readiness until settled, reopening only a lagged subscription.
 * Each caller owns its readiness predicate and command-specific failure. */
export async function awaitReadiness<S extends ProjectionSnapshot>(params: {
  readonly open: () => OpenedProjection<S>;
  readonly settled: (snapshot: S) => boolean;
  readonly observationEnded: (reason: ObserverEnd | undefined) => Problem;
}): Promise<{ snapshot: S } | { problem: Problem }> {
  for (;;) {
    const view = params.open();
    try {
      if (params.settled(view.snapshot)) return { snapshot: view.snapshot };
      let end: ObserverEnd | undefined;
      for await (const update of view.updates) {
        if (update.kind === "durable" && params.settled(update.snapshot)) {
          return { snapshot: update.snapshot };
        }
        if (update.kind === "closed") {
          end = update.reason;
          break;
        }
      }
      if (end !== "observer-lagged")
        return { problem: params.observationEnded(end) };
    } finally {
      view.close();
    }
  }
}
