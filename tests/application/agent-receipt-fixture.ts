import { storedProcess } from "../helpers/wiringDoubles.js";
import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type TurnResult,
} from "../../src/harness/harness.js";
import type { OperationOutcome } from "../../src/application/projection-port.js";

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
export function receiptAgent(
  receipts: readonly (string | undefined | ((path: string) => void))[],
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
                if (typeof receipt === "function") receipt(path);
                else writeFileSync(path, receipt);
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

/** Publish a declared text output, then consume it, republish it, or finish. */
export function writeBundle(
  second: "consume" | "republish" | "none",
  publishRetry = 0,
  outputName = "spec-ref",
): {
  folder: string;
  id: string;
} {
  const folder = makeTempDir("secant-agent-receipt-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "publish.md"), "Publish the spec.\n");
  writeFileSync(
    join(folder, "prompts", "tickets.md"),
    `Slice the spec at {{artifact:${outputName}}}.\n`,
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
        produces: [{ name: outputName, type: "text" }],
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
                  requires: [outputName],
                  prompt: { asset: "prompts/tickets.md" },
                }
              : {
                  id: "republish",
                  kind: "agent",
                  retry: 0,
                  session: "planning",
                  prompt: { asset: "prompts/publish.md" },
                  produces: [{ name: outputName, type: "text" }],
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
export async function launch(
  t: TestContext,
  adapter: HarnessAdapter,
  bundle: { folder: string; id: string },
): Promise<{
  wired: Wiring;
  runId: string;
  launched: OperationOutcome;
  home: string;
  workspace: string;
}> {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const workspace = makeTempDir("secant-agent-receipt-ws-");
  const home = makeTempDir("secant-agent-receipt-home-");
  const wired = wireApplication({
    secantHome: home,
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
  return { wired, runId: admission.runId, launched, home, workspace };
}
