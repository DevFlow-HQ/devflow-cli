import { writeAgentBundle as authorAgentBundle } from "../helpers/agentBundle.js";
import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type PrepareOptions,
} from "../../src/harness/harness.js";
import type { OperationOutcome } from "../../src/application/projection-port.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
} from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// #214 through the Projection Port: an Agent Step's prompt names the Run's exact
// working area, Harness preparation is granted that directory and nothing
// covering the private Run Store, a Local planning file the agent writes there
// survives resume, deleting the Run removes it, and an unusable area is a typed
// Problem that halts the Run before any Turn.

const BUNDLE_ID = "dev.secant.working-area";

function script(kind: "completed" | "failed"): FakeScript {
  return {
    profile: fakeHarnessProfile({
      executable: "/usr/bin/claude",
      executableVersion: "1.2.3",
    }),
    turns: [
      {
        result:
          kind === "completed"
            ? {
                kind: "completed",
                detail: {
                  finalContent: "done",
                  effectiveModel: { known: false },
                  session: { state: "open" },
                },
              }
            : {
                kind: "failed",
                detail: {
                  failure: {
                    phase: "turn",
                    category: "native-failure",
                    possibleEffects: "possible",
                    diagnostics: "scripted failure",
                  },
                  effectiveModel: { known: false },
                  session: { state: "detached", coordinate: { opaque: "s" } },
                },
              },
      },
    ],
  };
}

/** An Adapter standing in for an agent: it records every prepare's writable
 *  directory and every Turn's input, and writes a Local planning file into the
 *  granted directory as its Turn starts. */
function planningAgent(kind: "completed" | "failed", file: string) {
  const inner = createFake(script(kind))();
  const granted: (string | undefined)[] = [];
  const inputs: string[] = [];
  const adapter: HarnessAdapter = ownPreparations({
    async prepare(options: PrepareOptions) {
      granted.push(options.writableDirectory);
      const prepared = await inner.prepare(options);
      if (!prepared.ok) return prepared;
      const harness = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          readDefaults: () => harness.readDefaults(),
          startTurn(request) {
            inputs.push(request.input.text);
            if (options.writableDirectory !== undefined) {
              writeFileSync(join(options.writableDirectory, file), file);
            }
            return harness.startTurn(request);
          },
          close: () => harness.close(),
        },
      };
    },
  });
  return { adapter, granted, inputs };
}

function writeBundle(kind: "agent" | "interactive-agent" = "agent"): string {
  const { folder } = authorAgentBundle({
    id: BUNDLE_ID,
    name: "Working Area",
    description: "One planning agent Step writing Local files.",
    prompt: {
      path: "prompts/plan.md",
      text: "Write the spec into {{run:working-area}} and nowhere else.\n",
    },
    routing: [
      {
        id: "plan",
        kind,
        ...(kind === "agent" ? { retry: 0 } : {}),
        session: "planning",
        prompt: { asset: "prompts/plan.md" },
      },
    ],
  });
  return folder;
}

function wire(
  t: TestContext,
  adapter: HarnessAdapter,
  home: string,
  workspace: string,
  process: ProcessAdapter,
): Wiring {
  setEnvironmentForTest(t, {
    [CLAUDE_CODE_EXECUTABLE_ENV]: globalThis.process.execPath,
  });
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process,
    harnessAdapter: adapter,
    supportsInteractiveTurns: true,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  return wired;
}

async function launch(
  t: TestContext,
  agent: ReturnType<typeof planningAgent>,
  options: {
    readonly kind?: "agent" | "interactive-agent";
    readonly beforeLaunch?: (wired: Wiring, digest: string) => void;
  } = {},
): Promise<{
  wired: Wiring;
  runId: string;
  home: string;
  workspace: string;
  process: ProcessAdapter;
}> {
  const home = makeTempDir("secant-working-area-home-");
  const workspace = makeTempDir("secant-working-area-ws-");
  const process = createFakeBundleProcess({
    executables: [globalThis.process.execPath],
  });
  const wired = wire(t, agent.adapter, home, workspace, process);
  assert.ok(
    wired.bundleManagement.build(writeBundle(options.kind), {
      noInstall: false,
    }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === BUNDLE_ID);
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  options.beforeLaunch?.(wired, entry.digest);
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: BUNDLE_ID },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: "claude-code",
      requestedModel: "fake-model",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  return { wired, runId: admission.runId, home, workspace, process };
}

function runState(wired: Wiring, runId: string): string {
  const read = wired.runGroup.readRun(runId);
  assert.ok(read.ok);
  return read.run.state;
}

function privateStoreFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === "run.db" || entry.name === "artifacts.git") {
      return [path];
    }
    return entry.isDirectory() ? privateStoreFiles(path) : [];
  });
}

test("[run-working-area] the agent is told and granted exactly the Run's working area, which survives resume and dies with the Run", async (t) => {
  const first = planningAgent("failed", "spec.md");
  const { wired, runId, home, workspace, process } = await launch(t, first);
  assert.equal(runState(wired, runId), "failed");

  // Preparation was granted one directory, and the prompt names it exactly.
  assert.equal(first.granted.length, 1);
  const area = first.granted[0];
  assert.ok(area !== undefined);
  assert.equal(first.inputs.length, 1);
  assert.ok(
    first.inputs[0].includes(`Write the spec into ${area} and nowhere else.`),
    first.inputs[0],
  );
  // The grant covers no private Run Store file and is not the Workspace.
  const privateFiles = privateStoreFiles(home);
  assert.ok(privateFiles.length > 0);
  for (const path of privateFiles) {
    assert.ok(relative(area, path).startsWith(".."), path);
  }
  assert.ok(relative(workspace, area).startsWith(".."));
  assert.equal(readFileSync(join(area, "spec.md"), "utf8"), "spec.md");
  assert.deepEqual(readdirSync(workspace), []);

  // Reopened and resumed, the same area is granted with the file intact.
  const second = planningAgent("completed", "ticket-1.md");
  const reopened = wire(t, second.adapter, home, workspace, process);
  const resume = reopened.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  await awaitSettled(reopened.projectionPort, resume.operationId);
  assert.equal(runState(reopened, runId), "succeeded");
  assert.deepEqual(second.granted, [area]);
  assert.ok(second.inputs[0].includes(area));
  assert.deepEqual(readdirSync(area).sort(), ["spec.md", "ticket-1.md"]);

  // Deleting the Run removes its Local files.
  const deleted = reopened.projectionPort.submit({
    operationId: "op-delete",
    operation: "delete-run",
    input: { runId },
  });
  assert.ok(deleted.admitted, JSON.stringify(deleted));
  await awaitSettled(reopened.projectionPort, deleted.operationId);
  assert.equal(existsSync(area), false);
});

test("[run-working-area] an unusable working area halts the Run with a typed Problem before any Turn", async (t) => {
  const first = planningAgent("failed", "spec.md");
  const { wired, runId, home, workspace, process } = await launch(t, first);
  const area = first.granted[0];
  assert.ok(area !== undefined);
  // Something other than a directory now occupies the area's path.
  rmSync(area, { recursive: true });
  writeFileSync(area, "squatter");

  const second = planningAgent("completed", "never.md");
  const reopened = wire(t, second.adapter, home, workspace, process);
  const resume = reopened.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  const settled: OperationOutcome = await awaitSettled(
    reopened.projectionPort,
    resume.operationId,
  );
  assert.equal(settled.status, "not-applied", JSON.stringify(settled));
  if (settled.status !== "not-applied") throw new Error("unreachable");
  assert.equal(settled.problem.code, "selected-harness-unavailable");
  assert.equal(settled.problem.details?.category, "working-area-unavailable");
  assert.equal(runState(reopened, runId), "halted");
  // No Harness was prepared and no Turn started.
  assert.deepEqual(second.granted, []);
  assert.deepEqual(second.inputs, []);
  assert.equal(readFileSync(area, "utf8"), "squatter");
  void wired;
});

function assertWorkingAreaRefusal(settled: OperationOutcome) {
  assert.equal(settled.status, "not-applied", JSON.stringify(settled));
  if (settled.status !== "not-applied") throw new Error("unreachable");
  assert.equal(settled.problem.code, "selected-harness-unavailable");
  assert.equal(settled.problem.details?.category, "working-area-unavailable");
}

test("m12-audit-working-area-boundary: launch refuses a linked working entry before Harness preparation or a Turn", async (t) => {
  const agent = planningAgent("completed", "never.md");
  const target = makeTempDir("secant-launch-working-target-");
  writeFileSync(join(target, "marker"), "outside");
  let linkedArea = "";
  const { wired, runId } = await launch(t, agent, {
    beforeLaunch(wired, digest) {
      // Seed the durable create receipt through the Store Interface. Launch's
      // replay must still validate the working area before preparing a Harness.
      const created = wired.runGroup.createRun({
        operationId: "op-launch",
        bundleSnapshotDigest: digest,
        launch: {},
        selectedHarness: "claude-code",
        modelChoice: { model: "fake-model" },
        at: new Date("2026-10-08T00:00:00Z"),
      });
      assert.equal(created.outcome, "created");
      if (created.outcome !== "created") throw new Error("unreachable");
      const owner = wired.runGroup.acquireRun(created.runId);
      assert.ok(owner);
      try {
        const area = owner.workingArea();
        assert.ok(area.ok);
        linkedArea = area.path;
        rmSync(linkedArea, { recursive: true });
        symlinkSync(target, linkedArea, "junction");
        owner.release();
      } finally {
        owner.close();
      }
    },
  });
  assertWorkingAreaRefusal(
    await awaitSettled(wired.projectionPort, "op-launch"),
  );
  assert.equal(runState(wired, runId), "halted");
  assert.deepEqual(agent.granted, []);
  assert.deepEqual(agent.inputs, []);
  assert.ok(lstatSync(linkedArea).isSymbolicLink());
  assert.equal(readFileSync(join(target, "marker"), "utf8"), "outside");
  assert.deepEqual(readdirSync(target), ["marker"]);
});

for (const destination of ["private parent", "external directory"]) {
  test(`m12-audit-working-area-boundary: resume refuses a working link to ${destination} before Harness preparation or a Turn`, async (t) => {
    const first = planningAgent("failed", "spec.md");
    const { runId, home, workspace, process } = await launch(t, first);
    const area = first.granted[0];
    assert.ok(area !== undefined);
    const target =
      destination === "private parent"
        ? dirname(area)
        : makeTempDir("secant-resume-working-target-");
    writeFileSync(join(target, "marker"), "preserved");
    rmSync(area, { recursive: true });
    symlinkSync(target, area, "junction");
    const second = planningAgent("completed", "never.md");
    const reopened = wire(t, second.adapter, home, workspace, process);
    const resume = reopened.projectionPort.submit({
      operationId: "op-resume-linked",
      operation: "resume-run",
      input: { runId },
    });
    assert.ok(resume.admitted, JSON.stringify(resume));
    assertWorkingAreaRefusal(
      await awaitSettled(reopened.projectionPort, resume.operationId),
    );
    assert.equal(runState(reopened, runId), "halted");
    assert.deepEqual(second.granted, []);
    assert.deepEqual(second.inputs, []);
    assert.ok(lstatSync(area).isSymbolicLink());
    assert.equal(realpathSync(area), realpathSync(target));
    assert.equal(readFileSync(join(target, "marker"), "utf8"), "preserved");
  });
}

test("m12-audit-working-area-boundary: an interactive reopen refuses a linked working entry before Harness preparation or a human Turn", async (t) => {
  const first = planningAgent("completed", "never-on-launch.md");
  const { wired, runId, home, workspace, process } = await launch(t, first, {
    kind: "interactive-agent",
  });
  assert.equal(runState(wired, runId), "blocked");
  assert.deepEqual(first.inputs, []);
  const area = first.granted[0];
  assert.ok(area !== undefined);
  await wired.close();
  const target = makeTempDir("secant-interactive-working-target-");
  writeFileSync(join(target, "marker"), "preserved");
  rmSync(area, { recursive: true });
  symlinkSync(target, area, "junction");
  const second = planningAgent("completed", "never.md");
  const reopened = wire(t, second.adapter, home, workspace, process);
  const send = reopened.projectionPort.submit({
    operationId: "op-interactive-linked",
    operation: "send-interactive-turn",
    input: { runId, stepId: "plan", text: "continue" },
  });
  assert.ok(send.admitted, JSON.stringify(send));
  assertWorkingAreaRefusal(
    await awaitSettled(reopened.projectionPort, send.operationId),
  );
  assert.equal(runState(reopened, runId), "halted");
  assert.deepEqual(second.granted, []);
  assert.deepEqual(second.inputs, []);
  assert.ok(lstatSync(area).isSymbolicLink());
  assert.equal(readFileSync(join(target, "marker"), "utf8"), "preserved");
  assert.deepEqual(readdirSync(target), ["marker"]);
});
