import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type { SpawnResult } from "../../src/process/process.js";
import {
  commandNode,
  RUNTIME_NAME,
  writeRoutingBundle,
} from "./commandBundle.js";
import { awaitSettled } from "./settleOperation.js";
import { makeTempDir } from "./tempDir.js";
import { storedProcess } from "./wiringDoubles.js";
import { spawnFailed, timedOut } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";

// m11-command-failure-evidence (#530): a `check` Command whose program the
// scripted Process cannot start, finds missing after Preflight, times out, or
// sees killed, followed by an `after` Command that shows whether the walk went on.

const sharedGit = createFakeGitProcess();

/** The failing Step's program: a bare name the scripted Process resolves. */
const TOOL = "vanishing-tool";

/** The `check` Command as the Bundle declares it. */
export const DECLARED_COMMAND = JSON.stringify({
  executable: TOOL,
  arguments: ["--check"],
});

/** A stdout tail past the 30,000-character bound and a short exact stderr. */
export const LONG_STDOUT = `dropped-${"y".repeat(29_997)}END`;
export const STDERR_TAIL = "still waiting\r\n\ttabbed é\n";

export type CommandFailure =
  | "spawn-failed"
  | "spawn-enoent"
  | "executable-missing"
  | "timed-out"
  | "killed";

function scripted(failure: CommandFailure): SpawnResult {
  switch (failure) {
    case "spawn-failed":
      return spawnFailed("EACCES");
    case "spawn-enoent":
      return spawnFailed("ENOENT");
    case "timed-out":
      return timedOut(LONG_STDOUT, STDERR_TAIL);
    case "killed":
      return { kind: "signal", signal: "SIGTERM" };
    case "executable-missing":
      throw new Error("a missing program never spawns");
  }
}

export interface CommandFailureRun {
  readonly wired: Wiring;
  readonly runId: string;
  readonly home: string;
  /** How many times each Step's Command spawned. */
  readonly spawns: { check: number; after: number };
  /** Shut this wiring down and open a fresh one over the same home. */
  reopen(): Promise<Wiring>;
}

/** Install, approve, and launch the two-Command Bundle, failing `check` with
 *  `failure` on every Attempt (it may retry once), and wait for the launch. */
export async function launchCommandFailure(
  t: TestContext,
  failure: CommandFailure,
): Promise<CommandFailureRun> {
  const workspace = makeTempDir("secant-command-failure-ws-");
  const home = makeTempDir("secant-command-failure-home-");
  const spawns = { check: 0, after: 0 };
  let resolved = 0;
  const process = storedProcess({
    git: sharedGit,
    script: {
      // Preflight resolves the program once; after it, a missing program is gone.
      resolutionHandler: (name) =>
        name === RUNTIME_NAME ||
        (name === TOOL &&
          (failure !== "executable-missing" || resolved++ === 0))
          ? { kind: "found", executable: name, prefixArgs: [] }
          : { kind: "not-found" },
      commandHandler: (options) => {
        if (options.executable === TOOL) {
          spawns.check++;
          return scripted(failure);
        }
        spawns.after++;
        return {
          kind: "exited",
          status: 0,
          text: new TextEncoder().encode("after\n"),
        };
      },
    },
  });
  const open = () =>
    wireApplication({ secantHome: home, launchCwd: workspace, process });
  let wired = open();
  t.after(async () => {
    await wired.shutdown();
    wired.runGroup.close();
    wired.catalog.close();
  });
  const bundle = writeRoutingBundle({
    id: `dev.secant.command-failure-${failure}`,
    routing: [
      {
        id: "check",
        kind: "command",
        retry: 1,
        produces: [
          { name: "verdict", type: "verdict" },
          { name: "log", type: "text" },
        ],
        command: { executable: TOOL, arguments: ["--check"] },
      },
      commandNode("after", "console.log('after')"),
    ],
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
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  const launched = await awaitSettled(wired.projectionPort, "op-launch");
  assert.equal(launched.status, "applied", JSON.stringify(launched));
  return {
    get wired() {
      return wired;
    },
    runId: admission.runId,
    home,
    spawns,
    async reopen() {
      await wired.shutdown();
      wired.runGroup.close();
      wired.catalog.close();
      wired = open();
      return wired;
    },
  };
}
