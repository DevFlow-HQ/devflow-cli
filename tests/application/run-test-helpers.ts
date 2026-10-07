import assert from "node:assert/strict";
import type {
  ActionOffer,
  ProjectionPort,
  RunView,
} from "../../src/application/projection-port.js";

/** Read Run truth without retaining a temporary Projection. */
export function readRun(port: ProjectionPort, runId: string): RunView {
  const opened = port.openProjection({ family: "run", runId });
  try {
    const snapshot = opened.snapshot;
    assert.ok(snapshot.result.found, JSON.stringify(snapshot));
    return snapshot.result.run;
  } finally {
    opened.close();
  }
}

/** Optional lookup for polling and tests that deliberately assert absence. */
export function findOffer<A extends ActionOffer["action"]>(
  run: RunView,
  action: A,
): Extract<ActionOffer, { action: A }> | undefined {
  return run.actionOffers.find(
    (offer): offer is Extract<ActionOffer, { action: A }> =>
      offer.action === action,
  );
}

/** A required Offer carries the observed Run into its failure diagnostic. */
export function requireOffer<A extends ActionOffer["action"]>(
  run: RunView,
  action: A,
): Extract<ActionOffer, { action: A }> {
  const offer = findOffer(run, action);
  assert.ok(offer, `Expected ${action} Offer: ${JSON.stringify(run)}`);
  return offer;
}
