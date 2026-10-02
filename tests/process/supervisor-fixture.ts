#!/usr/bin/env bun
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
//   open, and one more, which proves the run resumes after a failure. The first
//   writes the scenario's temp folder to the file the second argument names;
// - `async-timeout`: a scenario awaiting a Command child that outlives the bound;
// - `passes-with-child`: a passing scenario that leaves an owned child open;
// - `setup-sync-block`: cases() blocks before registering any scenario;
// - `gap-sync-block` and `end-sync-block`: case-list reads block after a scenario;
// - `crash-between`: the next case's name getter crashes outside a scenario;
// - `sync-block`: a scenario with an owned child open that then blocks its event
//   loop in a synchronous spawn. That child writes its own PID to the file the
//   second argument names, since a blocking spawn reports none.
//
// Every child holds forever, so only the supervisor's clean-up ends it.

const HOLD = "setInterval(()=>{},1000)";
const processAdapter = createProcessAdapter(withRunnerObserver());

async function launchHolder(marker?: string): Promise<void> {
  const launched = await processAdapter.spawnOwnedProcess({
    role: "harness-runtime",
    executable: process.execPath,
    args: [
      "-e",
      (marker === undefined
        ? ""
        : `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));`) +
        "process.stdout.write('ready\\n');" +
        HOLD,
    ],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5_000,
  });
  assert.ok(launched.ok, "the fixture's owned child launched");
  const ready = await launched.process.stdout[Symbol.asyncIterator]().next();
  assert.equal(new TextDecoder().decode(ready.value), "ready\n");
}

function blockSync(marker: string, name: string): void {
  stage(name, () =>
    processAdapter.spawnCommandSync({
      role: "git",
      executable: process.execPath,
      args: [
        "-e",
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},String(process.pid)+'\\n');${HOLD}`,
      ],
      env: process.env,
      maxBufferBytes: 1_024,
    }),
  );
}

function fixtures(mode: string | undefined, marker: string | undefined) {
  switch (mode) {
    case "fails":
      assert.ok(marker, "the fails fixture needs a temp-folder marker path");
      return [
        { name: "passes-before", body: () => writeFileSync(marker, tmpdir()) },
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
            blockSync(marker, "block in git");
          },
        },
      ];
    case "passes-with-child":
      assert.ok(marker, "the passing fixture needs a PID marker path");
      return [
        { name: "passes-with-open-child", body: () => launchHolder(marker) },
      ];
    case "setup-sync-block":
      assert.ok(marker, "the setup fixture needs a PID marker path");
      blockSync(marker, "pre-scenario synchronous setup");
      return [];
    case "gap-sync-block":
      assert.ok(marker, "the gap fixture needs a PID marker path");
      return [
        { name: "passes-before-gap", body: () => {} },
        {
          get name(): string {
            blockSync(marker, "between-scenario synchronous work");
            return "unreachable";
          },
          body: () => {},
        },
      ];
    case "end-sync-block": {
      assert.ok(marker, "the end fixture needs a PID marker path");
      let finished = false;
      // The loop reads length again after recording the final scenario-end.
      // Block that read to exercise finalization outside the scenario's bound.
      return new Proxy(
        [
          {
            name: "passes-before-end",
            body: () => {
              finished = true;
            },
          },
        ],
        {
          get(list, key, receiver) {
            if (key === "length" && finished)
              blockSync(marker, "program-end synchronous work");
            return Reflect.get(list, key, receiver);
          },
        },
      );
    }
    case "crash-between":
      assert.ok(marker, "the crash fixture needs a PID marker path");
      return [
        { name: "passes-before-crash", body: () => launchHolder(marker) },
        {
          get name(): string {
            return stage("between-scenario crash", () => process.exit(23));
          },
          body: () => {},
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
