import { readRun, requireOffer } from "./run-test-helpers.js";

import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessFailure,
} from "../../src/harness/harness.js";
import type {
  RunView,
  HarnessChoice,
} from "../../src/application/projection-port.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
} from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";

// Shared Application setup for the interactive-agent and headless client suites.
// All execution uses injected Process and Harness doubles.

/** One scripted Turn that completes and leaves the Session detached, so the next
 *  human Turn (and the following Agent Step) resumes the same Session. Every Turn
 *  the fake serves in this suite reuses it: a fresh prepared Harness per human Turn
 *  replays the same script entry, which is exactly the detached-resume path. */
export const COMPLETED_DETACHED: FakeScript["turns"][number] = {
  result: {
    kind: "completed",
    detail: {
      effectiveModel: { known: true, model: "fake-sonnet" },
      session: { state: "detached", coordinate: { opaque: "coord-s" } },
    },
  },
};

/** The default `interactive-agent (session "s") -> agent (session "s")` Routing. */
const DEFAULT_ROUTING: readonly unknown[] = [
  {
    id: "discuss",
    kind: "interactive-agent",
    session: "s",
    prompt: { asset: "prompts/discuss.md" },
  },
  {
    id: "apply",
    kind: "agent",
    session: "s",
    prompt: { asset: "prompts/apply.md" },
  },
];

/** Author a Bundle over `routing` (the interactive -> agent pair by default). */
export function writeInteractiveBundle(routing = DEFAULT_ROUTING): {
  folder: string;
  id: string;
} {
  const folder = makeTempDir("secant-interactive-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "discuss.md"), "Discuss the plan.\n");
  writeFileSync(join(folder, "prompts", "apply.md"), "Apply the plan.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.interactive-e2e",
      version: "1.0.0",
      name: "Interactive E2E",
      description: "An interactive-agent -> agent Bundle for the first Step.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [
      { path: "prompts/discuss.md", kind: "prompt" },
      { path: "prompts/apply.md", kind: "prompt" },
    ],
    routing,
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Wire the Application against a temporary home and the fake Adapter with the TUI's
 *  interactive-turn support, install the Bundle, approve the Workspace, and launch
 *  the Run to its first `blocked` rest at the interactive Step. */
export async function launchInteractive(
  t: TestContext,
  script: FakeScript | HarnessAdapter,
  counts?: {
    prepares: number;
    readonly closes: number[];
    readonly failureAfterLaunch?: HarnessFailure;
    /** Each Turn's `resume` coordinate, in start order (undefined = fresh). */
    readonly resumes?: (string | undefined)[];
    /** The script every prepare after the first serves (a fresh prepared fake
     *  otherwise replays the launch script from its first Turn). */
    readonly laterScript?: FakeScript;
  },
  routing?: readonly unknown[],
  harness: HarnessChoice["id"] = "claude-code",
  requestedModel = "fake-model",
): Promise<{ wired: Wiring; runId: string; run: RunView; home: string }> {
  // A resolvable executable so Preflight's Harness discovery passes; the fake
  // Adapter is what actually runs, never this path.
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });

  const workspace = makeTempDir("secant-interactive-ws-");
  const fake = "prepare" in script ? script : createFake(script)();
  const adapter: HarnessAdapter =
    counts === undefined
      ? fake
      : ownPreparations({
          async prepare(options) {
            counts.prepares += 1;
            if (
              counts.prepares > 1 &&
              counts.failureAfterLaunch !== undefined
            ) {
              return { ok: false, failure: counts.failureAfterLaunch };
            }
            const index = counts.closes.push(0) - 1;
            const prepared = await (
              counts.prepares > 1 && counts.laterScript !== undefined
                ? createFake(counts.laterScript)()
                : fake
            ).prepare(options);
            if (!prepared.ok) return prepared;
            const harness = prepared.harness;
            return {
              ok: true,
              harness: {
                profile: harness.profile,
                readDefaults: () => harness.readDefaults(),
                startTurn: (request) => {
                  counts.resumes?.push(request.resume?.opaque);
                  return harness.startTurn(request);
                },
                async close() {
                  counts.closes[index] = counts.closes[index]! + 1;
                  return harness.close();
                },
              },
            };
          },
        });
  const home = makeTempDir("secant-interactive-home-");
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    ...(harness === "claude-code"
      ? { harnessAdapter: adapter }
      : {
          codexHarnessAdapter: adapter,
          discoverCodex: () => ({
            kind: "found" as const,
            attempt: {
              source: "path" as const,
              name: "codex",
              description: "scripted Codex",
            },
          }),
        }),
    process: createFakeBundleProcess({ executables: [process.execPath] }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeInteractiveBundle(routing);
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);

  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
      harness,
      // The fake selects no model, so any Model choice is admitted.
      requestedModel,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  return { wired, runId, run: readRun(wired.projectionPort, runId), home };
}

export async function send(
  wired: Wiring,
  runId: string,
  operationId: string,
  stepId: string,
  text: string,
): Promise<void> {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "send-interactive-turn",
    input: { runId, stepId, text },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  // `applied` means the Turn was admitted; its result arrives on the Run (#290).
  await awaitRunRest(wired.projectionPort, runId);
}

/** A human Turn that stays live after admission until it is interrupted or the
 *  Harness closes, so a test can observe the window between admission and Turn end. */
export const BLOCKING_TURN: FakeScript["turns"][number] = {
  block: true,
  result: COMPLETED_DETACHED.result,
};

/** A blocking human Turn that an interrupt settles `interrupted`, its Session
 *  detached by `coord-interrupted` so the next Turn resumes it. */
export const INTERRUPTIBLE_TURN: FakeScript["turns"][number] = {
  ...BLOCKING_TURN,
  interruptResult: {
    kind: "interrupted",
    detail: {
      interruption: fakeHarnessProfile().interruption,
      session: {
        state: "detached",
        coordinate: { opaque: "coord-interrupted" },
      },
    },
  },
};

/** Send one human Turn that stays live, and return the Run read once admission
 *  settles the send applied, with the live Turn's interrupt and steer Offers. */
export async function sendLiveTurn(
  wired: Wiring,
  runId: string,
  operationId: string,
) {
  const sent = wired.projectionPort.submit({
    operationId,
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "work on this for a while" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  const live = readRun(wired.projectionPort, runId);
  assert.equal(live.state, "running");
  const interrupt = requireOffer(live, "interrupt-turn");
  const steer = requireOffer(live, "steer-turn");
  assert.ok(interrupt, JSON.stringify(live.actionOffers));
  assert.ok(steer, JSON.stringify(live.actionOffers));
  return { interrupt, steer };
}

/** Interrupt the live Turn, assert the interrupt applied, and return the Run's rest. */
export async function interruptTurn(
  wired: Wiring,
  runId: string,
  turnId: string,
  operationId: string,
) {
  const interrupted = wired.projectionPort.submit({
    operationId,
    operation: "interrupt-turn",
    input: { runId, turnId },
  });
  assert.ok(interrupted.admitted, JSON.stringify(interrupted));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  return awaitRunRest(wired.projectionPort, runId);
}

/** A human-controlled Repeat (#217): `repeat { control: human } [interactive
 *  implement]`. No Verdict, no Review checkpoint — only Continue opens the next
 *  iteration (confirmed End Stage, #218, exits). */
export function humanRepeatRouting(): readonly unknown[] {
  return [
    {
      repeat: {
        control: "human",
        steps: [
          {
            id: "implement",
            kind: "interactive-agent",
            session: "impl",
            prompt: { asset: "prompts/discuss.md" },
          },
        ],
      },
    },
  ];
}
