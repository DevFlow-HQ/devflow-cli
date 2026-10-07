import { readRun } from "./run-test-helpers.js";
import { storedProcess } from "../helpers/wiringDoubles.js";
import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type TurnResult,
} from "../../src/harness/harness.js";
import type {
  OperationOutcome,
  RunView,
} from "../../src/application/projection-port.js";

import { fakeHarnessProfile, createFake } from "../harness/fake-adapter.js";

import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// [agent-output-receipt] A generic Agent Step's required text output (#215), driven
// end to end through the shared Projection Port over the real Application and Run
// Store with the fake Harness Adapter. Success: the agent writes the receipt file
// its prompt names, the reference binds as a Run output, reads back through the
// Port, and substitutes into a later Step's prompt. Failure: a completed Turn with no
// receipt fails the Step and the Run, while the earlier binding stays readable; a
// receipt root the Store cannot prepare fails each Attempt before any Turn (#305).

const sharedGit = createFakeGitProcess();

const COMPLETED: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: "Published the spec.",
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

const RECEIPT_LINE =
  /Write the required output "spec-ref" as UTF-8 text to (.+) before you finish;/;

/** A fake Adapter whose Turns play the agent: Turn `n` writes `receipts[n]` to the
 *  receipt path its prompt names (nothing when undefined). Every Turn input is kept.
 *  `squatReceiptRoot` leaves a file where the granted working area's receipt root
 *  belongs, so only receipt preparation — not the area — is unusable. */
function receiptAgent(
  receipts: readonly (string | undefined)[],
  options: { readonly squatReceiptRoot?: boolean } = {},
): {
  adapter: HarnessAdapter;
  inputs: string[];
} {
  const inner = createFake({
    profile: fakeHarnessProfile({
      executable: "/usr/bin/claude",
      executableVersion: "1.2.3",
    }),
    turns: receipts.map(() => ({ result: COMPLETED })),
  })();
  const inputs: string[] = [];
  return {
    inputs,
    adapter: ownPreparations({
      async prepare(prepareOptions) {
        if (
          options.squatReceiptRoot === true &&
          prepareOptions.writableDirectory !== undefined
        ) {
          writeFileSync(
            join(prepareOptions.writableDirectory, ".receipts"),
            "squatter",
          );
        }
        const prepared = await inner.prepare(prepareOptions);
        if (!prepared.ok) return prepared;
        const harness = prepared.harness;
        return {
          ok: true,
          harness: {
            profile: harness.profile,
            readDefaults: () => harness.readDefaults(),
            startTurn(request) {
              const receipt = receipts[inputs.length];
              inputs.push(request.input.text);
              const path = RECEIPT_LINE.exec(request.input.text)?.[1];
              if (receipt !== undefined && path !== undefined) {
                writeFileSync(path, receipt);
              }
              return harness.startTurn(request);
            },
            close: () => harness.close(),
          },
        };
      },
    }),
  };
}

/** publish (produces spec-ref) → then either a consumer that reads spec-ref, a
 *  second producer that republishes spec-ref, or nothing. */
function writeBundle(
  second: "consume" | "republish" | "none",
  publishRetry = 0,
): {
  folder: string;
  id: string;
} {
  const folder = makeTempDir("secant-agent-receipt-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "publish.md"), "Publish the spec.\n");
  writeFileSync(
    join(folder, "prompts", "tickets.md"),
    "Slice the spec at {{artifact:spec-ref}}.\n",
  );
  const id = `dev.secant.agent-receipt-${second}`;
  const manifest = {
    formatVersion: 1,
    bundle: {
      id,
      version: "1.0.0",
      name: "Agent Receipt",
      description: "An Agent Step publishing a required text reference.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [
      { path: "prompts/publish.md", kind: "prompt" },
      { path: "prompts/tickets.md", kind: "prompt" },
    ],
    routing: [
      {
        id: "publish",
        kind: "agent",
        retry: publishRetry,
        session: "planning",
        prompt: { asset: "prompts/publish.md" },
        produces: [{ name: "spec-ref", type: "text" }],
      },
      ...(second === "none"
        ? []
        : [
            second === "consume"
              ? {
                  id: "tickets",
                  kind: "agent",
                  retry: 0,
                  session: "planning",
                  requires: ["spec-ref"],
                  prompt: { asset: "prompts/tickets.md" },
                }
              : {
                  id: "republish",
                  kind: "agent",
                  retry: 0,
                  session: "planning",
                  prompt: { asset: "prompts/publish.md" },
                  produces: [{ name: "spec-ref", type: "text" }],
                },
          ]),
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id };
}

/** Wire over a fresh home, install the Bundle, approve the Workspace, launch, and
 *  wait for the launch to settle. */
async function launch(
  t: TestContext,
  adapter: HarnessAdapter,
  bundle: { folder: string; id: string },
): Promise<{ wired: Wiring; runId: string; launched: OperationOutcome }> {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const workspace = makeTempDir("secant-agent-receipt-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-agent-receipt-home-"),
    launchCwd: workspace,
    process: storedProcess({ git: sharedGit }),
    harnessAdapter: adapter,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
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
      harness: "claude-code",
      requestedModel: "fake-model",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  const launched = await awaitSettled(wired.projectionPort, "op-launch");
  return { wired, runId: admission.runId, launched };
}

/** The text of the Run output `name` read back through the Port's resource read. */
function readOutput(wired: Wiring, run: RunView, name: string): string {
  const output = run.outputs.find((candidate) => candidate.name === name);
  assert.ok(output, `output ${name} is projected`);
  const read = wired.projectionPort.readResource(output.reference);
  assert.ok(read.found, JSON.stringify(read));
  return read.content;
}

test("[agent-output-receipt] a validated receipt binds the reference as a Run output a later prompt receives", async (t) => {
  // The consuming Step's Turn writes nothing; it declares no output.
  const consumer = receiptAgent([
    "https://github.com/example/repo/issues/12\n",
    undefined,
  ]);
  const { wired, runId } = await launch(
    t,
    consumer.adapter,
    writeBundle("consume"),
  );

  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(
    readOutput(wired, run, "spec-ref"),
    "https://github.com/example/repo/issues/12",
  );
  // The later Step's prompt carries the bound reference, not the agent's prose.
  assert.equal(consumer.inputs.length, 2);
  assert.equal(
    consumer.inputs[1],
    "Slice the spec at https://github.com/example/repo/issues/12.\n",
  );
});

test("[agent-output-receipt] a completed Turn with no receipt fails the Run and leaves the earlier binding intact", async (t) => {
  // The first producer writes its receipt; the second completes its Turn (claiming
  // publication in prose) but writes none.
  const agent = receiptAgent(["LOCAL:spec.md", undefined]);
  const { wired, runId } = await launch(
    t,
    agent.adapter,
    writeBundle("republish"),
  );

  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "failed");
  assert.equal(agent.inputs.length, 2);
  assert.equal(readOutput(wired, run, "spec-ref"), "LOCAL:spec.md");
  // The Turn completed; only the Step failed — the timeline keeps both facts.
  const settled = run.timeline.filter(
    (event) => event.event === "turn-settled",
  );
  assert.deepEqual(
    settled.map((event) => event.detail),
    ["completed", "completed"],
  );
  assert.deepEqual(
    run.timeline
      .filter((event) => event.event === "attempt-settled")
      .map((event) => event.detail),
    ["succeeded", "failed"],
  );
});

test("[agent-output-receipt] a receipt root the Store cannot prepare fails each Attempt before any Turn and binds nothing (#305)", async (t) => {
  const agent = receiptAgent(["never-written", "never-written"], {
    squatReceiptRoot: true,
  });
  const { wired, runId, launched } = await launch(
    t,
    agent.adapter,
    writeBundle("none", 1),
  );
  // The launch Operation itself applied; only the Run's Step failed.
  assert.equal(launched.status, "applied", JSON.stringify(launched));

  const run = readRun(wired.projectionPort, runId);
  // The existing failed-Attempt policy: retried within budget, then the Run fails.
  assert.equal(run.state, "failed");
  assert.deepEqual(
    run.timeline
      .filter((event) => event.event === "attempt-settled")
      .map((event) => event.detail),
    ["failed", "failed"],
  );
  // No Turn was sent or recorded, and no output was bound.
  assert.deepEqual(agent.inputs, []);
  assert.deepEqual(
    run.timeline.filter((event) => event.event.startsWith("turn-")),
    [],
  );
  assert.deepEqual(run.outputs, []);
  // The failed Attempts ran under the qualified Harness, so its identity projects.
  assert.equal(run.harness?.name, "Claude Code");
});
