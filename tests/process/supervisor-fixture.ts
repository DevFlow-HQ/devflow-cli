#!/usr/bin/env bun
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createProcessAdapter } from "../../src/process/process.js";
import type { RunnerCase } from "../helpers/scenario-runner.js";
import { stage, withRunnerObserver } from "../helpers/standalone.js";
import { runSupervised } from "../helpers/supervisor.js";

// The runner supervisor's fixture program (#326, spec #313 S3). The supervisor
// conformance cases (supervisor-conformance.ts) run it under the real supervisor
// with a short bound, one fixture set per run, chosen by the first argument:
//
// - `fails`: a passing scenario, one that fails an assertion with an owned child
//   open, and one more, which proves the run resumes after a failure;
// - `async-timeout`: a scenario awaiting a Command child that outlives the bound;
// - `sync-block`: a scenario with an owned child open that then blocks its event
//   loop in a synchronous spawn. That child writes its own PID to the file the
//   second argument names, since a blocking spawn reports none.
//
// Every child holds forever, so only the supervisor's clean-up ends it.

const HOLD = "setInterval(()=>{},1000)";
const processAdapter = createProcessAdapter(withRunnerObserver());

async function launchHolder(): Promise<void> {
  const launched = await processAdapter.spawnOwnedProcess({
    role: "harness-runtime",
    executable: process.execPath,
    args: ["-e", HOLD],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5_000,
  });
  assert.ok(launched.ok, "the fixture's owned child launched");
}

function fixtures(mode: string | undefined, marker: string | undefined) {
  switch (mode) {
    case "fails":
      return [
        { name: "passes-before", body: () => {} },
        {
          name: "fails-with-open-child",
          body: async () => {
            await stage("launch holder", launchHolder);
            stage("assert", () =>
              assert.fail("the fixture's failing assertion"),
            );
          },
        },
        { name: "passes-after", body: () => {} },
      ];
    case "async-timeout":
      return [
        {
          name: "awaits-a-command",
          body: () =>
            stage("await command", () =>
              processAdapter.spawnCommand({
                role: "command",
                executable: process.execPath,
                args: ["-e", HOLD],
                cwd: process.cwd(),
                env: process.env,
                timeoutMs: 60_000,
                maxCaptureBytes: 1_024,
                truncationMarker: "",
              }),
            ),
        },
      ];
    case "sync-block":
      assert.ok(marker, "the sync-block fixture needs a PID marker path");
      return [
        {
          name: "blocks-in-a-sync-child",
          body: async () => {
            await stage("launch holder", launchHolder);
            stage("block in git", () =>
              processAdapter.spawnCommandSync({
                role: "git",
                executable: process.execPath,
                args: [
                  "-e",
                  `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));${HOLD}`,
                ],
                env: process.env,
                maxBufferBytes: 1_024,
              }),
            );
          },
        },
      ];
    default:
      throw new Error(`unknown supervisor fixture: ${mode}`);
  }
}

runSupervised({
  program: "supervisor-fixture",
  entry: fileURLToPath(import.meta.url),
  boundMs: 2_000,
  cases: (): RunnerCase[] => fixtures(process.argv[2], process.argv[3]),
});
