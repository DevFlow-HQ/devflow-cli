import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessProfile, TurnResult } from "../../src/harness/harness.js";
import type {
  ProjectionPort,
  RunView,
} from "../../src/application/projection-port.js";
import { makeTempDir } from "./tempDir.js";
import { awaitSettled } from "./settleOperation.js";

// Shared fixtures for Run lifecycle records and multi-Application ownership wiring.

export function profile(): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "fake-claude",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: false, evidence: "scripted fake" },
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    modelObservation: { available: true, evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

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
    finalContent: SEEDED_CONTENT,
    effectiveModel: { known: false },
    session: { state: "detached", coordinate: { opaque: SEEDED_COORDINATE } },
  },
};

export function writeBundle(routing: readonly unknown[]): {
  folder: string;
  id: string;
} {
  const folder = makeTempDir("secant-runlog-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "work.md"), `${SEEDED_PROMPT}\n`);
  const id = "dev.secant.run-lifecycle-log";
  const manifest = {
    formatVersion: 1,
    bundle: {
      id,
      version: "1.0.0",
      name: "Run Lifecycle Log",
      description: "A Bundle the operational-log lifecycle tests launch.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/work.md", kind: "prompt" }],
    routing,
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  return { folder, id };
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

export function readRun(port: ProjectionPort, runId: string): RunView {
  const opened = port.openProjection({ family: "run", runId });
  try {
    if (!opened.snapshot.result.found) throw new Error("the Run is not found");
    return opened.snapshot.result.run;
  } finally {
    opened.close();
  }
}

/** A record with the base fields dropped, for exact comparison. */
export function semantic(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const { level: _level, time: _time, invocationId: _id, ...rest } = record;
  return rest;
}
