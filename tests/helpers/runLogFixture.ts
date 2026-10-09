import assert from "node:assert/strict";

import type { TurnResult } from "../../src/harness/harness.js";
import type { ProjectionPort } from "../../src/application/projection-port.js";

import { writeAgentBundle } from "./agentBundle.js";
import { awaitSettled } from "./settleOperation.js";

// Shared fixtures for Run lifecycle records and multi-Application ownership wiring.

// Payloads seeded into prompts, Turn input, transcript, and failure detail; none
// may reach the log.
export const SEEDED_PROMPT = "seeded-prompt-3f9a1c";
export const SEEDED_TEXT = "seeded-human-text-7b2e44";
export const SEEDED_CONTENT = "seeded-transcript-c0ffee";
export const SEEDED_DIAGNOSTICS = "seeded-diagnostics-51d0aa";
export const SEEDED_PARTIAL = "seeded-partial-output-9e8d7c";
export const SEEDED_COORDINATE = "seeded-coordinate-a1b2c3";

export const COMPLETED: TurnResult = {
  kind: "completed",
  detail: {
    effectiveModel: { known: false },
    session: { state: "detached", coordinate: { opaque: SEEDED_COORDINATE } },
  },
};

export function writeBundle(routing: readonly unknown[]): {
  folder: string;
  id: string;
} {
  return writeAgentBundle({
    id: "dev.secant.run-lifecycle-log",
    name: "Run Lifecycle Log",
    description: "A Bundle the operational-log lifecycle tests launch.",
    prompt: { path: "prompts/work.md", text: `${SEEDED_PROMPT}\n` },
    routing,
  });
}

export const agentStep = (id: string, retry: number) => ({
  id,
  kind: "agent",
  retry,
  session: "planning",
  prompt: { asset: "prompts/work.md" },
});

export function launch(port: ProjectionPort, digest: string): string {
  const admission = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.run-lifecycle-log" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "fake-model",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  return admission.runId;
}

export async function applied(
  port: ProjectionPort,
  submission: Parameters<ProjectionPort["submit"]>[0],
): Promise<void> {
  const admission = port.submit(submission);
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(port, submission.operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

/** A record with the base fields dropped, for exact comparison. */
export function semantic(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const { level: _level, time: _time, invocationId: _id, ...rest } = record;
  return rest;
}
