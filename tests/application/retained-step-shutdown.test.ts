import { readRun } from "./run-test-helpers.js";
import { writeAgentBundle as authorAgentBundle } from "../helpers/agentBundle.js";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
  type ApplicationHarnessRegistration,
  type RunInteractiveStep,
} from "../../src/application/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import type { RunGroup, RunOwner } from "../../src/run/store/store.js";
import { hostPlatform } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { wiringProcess } from "../helpers/wiringDoubles.js";
import { openFakeRunGroup as openRunGroup } from "../run/store/fake-git-process.js";

// Shutdown drains every Run resource this process retains (#385): an ordinary
// built Interactive Bundle runs over a real local Catalog and Run Store, while the
// opaque Step driver and each Run owner are counting doubles. Cleanup is asserted
// as literal close and release counts, never inferred from a resolved shutdown.

/** What the human's Turn text makes the injected Step driver do. */
type TurnScript =
  /** Return to the Step boundary, the Step still held. */
  | "wait"
  /** Throw a coordination fault mid-Turn, the Run already `running`. */
  | "fault"
  /** Work until the Run's controller fires, then throw. */
  | "work";

interface DriverCount {
  readonly runId: string;
  closes: number;
  /** The abort reason the driver's live Turn observed, if it was stopped. */
  stoppedBy?: unknown;
}

interface OwnerCount {
  readonly runId: string;
  releases: number;
  closes: number;
}

interface Fixture {
  readonly app: Application;
  readonly storeDir: string;
  readonly workspace: string;
  readonly drivers: DriverCount[];
  readonly owners: OwnerCount[];
  /** Resolves once a `work` Turn of that Run is in flight. */
  working(runId: string): Promise<void>;
  /** Ordered marks: a `work` Turn observing its stop, and shutdown resolving. */
  readonly events: string[];
  /** Run ids whose driver `close` throws. */
  readonly failingClose: Set<string>;
  /** Run ids whose owner `release` throws. */
  readonly failingRelease: Set<string>;
  /** Run ids whose `halted` state write is refused as fenced, or throws. */
  readonly failingHalt: Map<string, "fenced" | "throws">;
  /** A Run's driver `close` waits for its gate before returning. */
  readonly closeGates: Map<string, Promise<void>>;
  launch(operationId: string): Promise<string>;
  send(runId: string, text: TurnScript): string;
}

const registration: ApplicationHarnessRegistration = {
  choice: { id: "claude-code", name: "Claude Code", availability: "available" },
  inputRules: [],
  servedCapabilities: ["agent-turn", "interactive-turns"],
  discover: () => ({ kind: "found", source: "path", description: "fake" }),
  qualify: async () => ({
    ok: false,
    failure: {
      phase: "prepare",
      category: "not-scripted",
      possibleEffects: "none",
    },
  }),
};

function writeInteractiveBundle(): string {
  const { folder } = authorAgentBundle({
    id: "dev.secant.retained",
    name: "Retained",
    description: "One interactive Step.",
    prompt: { path: "prompts/chat.md", text: "Talk it through.\n" },
    routing: [
      {
        id: "chat",
        kind: "interactive-agent",
        session: "s",
        prompt: { asset: "prompts/chat.md" },
      },
    ],
  });
  return folder;
}

function fixture(t: TestContext): Fixture {
  const catalog = openCatalog(makeTempDir("secant-retained-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-retained-ws-"));
  catalog.approveWorkspace(workspace, new Date());
  const storeDir = makeTempDir("secant-retained-store-");
  const store = openRunGroup(storeDir, workspace);
  const owners: OwnerCount[] = [];
  const failingRelease = new Set<string>();
  const failingHalt = new Map<string, "fenced" | "throws">();
  const runGroup = {
    ...store,
    acquireRun(runId, options) {
      const owner = store.acquireRun(runId, options);
      if (owner === undefined) return undefined;
      const count: OwnerCount = { runId, releases: 0, closes: 0 };
      owners.push(count);
      return {
        ...owner,
        get record() {
          return owner.record;
        },
        writeState(state, restingCause) {
          const failing = state === "halted" && failingHalt.get(runId);
          if (failing === "throws") throw new Error("the halting write threw");
          if (failing === "fenced") return { ok: false, reason: "fenced" };
          return owner.writeState(state, restingCause);
        },
        release(): ReturnType<RunOwner["release"]> {
          count.releases += 1;
          if (failingRelease.has(runId)) {
            throw new Error(`releasing ${runId} failed`);
          }
          return owner.release();
        },
        close(): void {
          count.closes += 1;
          owner.close();
        },
      };
    },
  } satisfies RunGroup;
  const drivers: DriverCount[] = [];
  const events: string[] = [];
  const failingClose = new Set<string>();
  const closeGates = new Map<string, Promise<void>>();
  const started = new Map<string, () => void>();
  const working = new Map<string, Promise<void>>();
  const workingFor = (runId: string) => {
    let promise = working.get(runId);
    if (promise === undefined) {
      promise = new Promise<void>((resolve) => started.set(runId, resolve));
      working.set(runId, promise);
    }
    return promise;
  };
  const process = wiringProcess();
  const app = createApplication({
    catalog,
    process,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    supportsInteractiveTurns: true,
    harnessRegistry: [registration],
    runGroup,
    runExecution: ({ routing, owner, cancelSignal }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process,
        ...(cancelSignal !== undefined ? { cancelSignal } : {}),
      }),
    async prepareRunInteractiveStep({ owner }) {
      const count: DriverCount = { runId: owner.runId, closes: 0 };
      drivers.push(count);
      const interactiveStep: RunInteractiveStep = {
        steer: { available: false, evidence: "counting double" },
        async turn({ text, cancelSignal }) {
          const script = text as TurnScript;
          if (script === "wait") return { rest: "blocked" };
          if (script === "fault") {
            throw new Error("coordination fault: the Turn write was fenced");
          }
          workingFor(owner.runId);
          started.get(owner.runId)?.();
          await new Promise<void>((resolve) =>
            cancelSignal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          count.stoppedBy = cancelSignal?.reason;
          events.push(`stopped ${owner.runId}`);
          throw new Error("the stopped Turn unwound");
        },
        async close() {
          count.closes += 1;
          await closeGates.get(owner.runId);
          if (failingClose.has(owner.runId)) {
            throw new Error(`closing ${owner.runId}'s Step failed`);
          }
        },
      };
      return { ok: true, interactiveStep };
    },
  });
  // Each case shuts down itself; this repeat only covers a case that failed first.
  t.after(async () => {
    await app.shutdown().catch(() => undefined);
    runGroup.close();
  });
  const folder = writeInteractiveBundle();
  const built = app.bundleManagement.build(folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog
    .listEntries()
    .find((candidate) => candidate.id === "dev.secant.retained");
  assert.ok(entry);
  return {
    app,
    storeDir,
    workspace,
    drivers,
    owners,
    events,
    failingClose,
    failingRelease,
    failingHalt,
    closeGates,
    working: workingFor,
    async launch(operationId) {
      const admission = app.projectionPort.submit({
        operationId,
        operation: "launch-run",
        input: {
          bundle: { id: entry.id },
          launchInputs: {},
          trustDigest: entry.digest,
          harness: "claude-code",
          requestedModel: "alpha",
        },
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      assert.deepEqual(await awaitSettled(app.projectionPort, operationId), {
        status: "applied",
      });
      assert.equal(stateOf(app, admission.runId!), "blocked");
      return admission.runId!;
    },
    send(runId, text) {
      const operationId = `send-${runId}-${text}`;
      const admission = app.projectionPort.submit({
        operationId,
        operation: "send-interactive-turn",
        input: { runId, stepId: "chat", text },
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      return operationId;
    },
  };
}

function stateOf(app: Application, runId: string): string {
  return readRun(app.projectionPort, runId).state;
}

/** Leave a Run owned and idle with its Step held, its durable state `running`,
 *  after the injected driver threw a coordination fault mid-Turn and the halting
 *  write that rests such a Run (#528) was itself refused. */
async function faultedRun(
  f: Fixture,
  operationId: string,
  halt: "fenced" | "throws" = "fenced",
): Promise<string> {
  const runId = await f.launch(operationId);
  f.failingHalt.set(runId, halt);
  const outcome = await awaitSettled(
    f.app.projectionPort,
    f.send(runId, "fault"),
  );
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "run-execution-fault");
  }
  assert.equal(stateOf(f.app, runId), "running");
  return runId;
}

/** A Run resting `blocked` between human Turns, its Step held. */
async function waitingRun(f: Fixture, operationId: string): Promise<string> {
  const runId = await f.launch(operationId);
  await awaitSettled(f.app.projectionPort, f.send(runId, "wait"));
  assert.equal(stateOf(f.app, runId), "blocked");
  return runId;
}

/** A Run whose human Turn is in flight when shutdown begins. */
async function drivingRun(f: Fixture, operationId: string): Promise<string> {
  const runId = await f.launch(operationId);
  f.send(runId, "work");
  await f.working(runId);
  return runId;
}

function cleanup(f: Fixture, runId: string) {
  const drivers = f.drivers.filter((driver) => driver.runId === runId);
  const owners = f.owners.filter((owner) => owner.runId === runId);
  return {
    driverCloses: drivers.map((driver) => driver.closes),
    ownerReleases: owners.map((owner) => owner.releases),
    ownerCloses: owners.map((owner) => owner.closes),
  };
}

/** The Run as a fresh process's Store reconciles it. */
function reopened(t: TestContext, f: Fixture, runId: string) {
  const store = openRunGroup(f.storeDir, f.workspace);
  t.after(() => store.close());
  const read = store.readRun(runId);
  assert.ok(read.ok);
  const owner = store.acquireRun(runId);
  assert.ok(owner);
  const markers = owner
    .attemptLog()
    .filter((entry) => entry.outcome === "indeterminate").length;
  owner.close();
  return {
    state: read.run.state,
    live: store.listRuns().find((run) => run.runId === runId)?.live,
    markers,
  };
}

test("m11-execution-fault-rest: a Turn that faults mid-Step rests halted, closes its Step, and releases its owner at once", async (t) => {
  const f = fixture(t);
  const runId = await f.launch("launch-fault");
  const outcome = await awaitSettled(
    f.app.projectionPort,
    f.send(runId, "fault"),
  );
  assert.equal(outcome.status, "not-applied");
  assert.deepEqual(cleanup(f, runId), {
    driverCloses: [1],
    ownerReleases: [1],
    ownerCloses: [1],
  });
  assert.equal(stateOf(f.app, runId), "halted");

  // Shutdown has nothing left to drain for it.
  await f.app.shutdown();
  assert.deepEqual(cleanup(f, runId).driverCloses, [1]);
  assert.deepEqual(reopened(t, f, runId), {
    state: "halted",
    live: false,
    markers: 0,
  });
});

test("m11-execution-fault-rest: a halting write that throws keeps the owner and Step for reconciliation", async (t) => {
  const f = fixture(t);
  const runId = await faultedRun(f, "launch-fault", "throws");
  assert.deepEqual(cleanup(f, runId), {
    driverCloses: [0],
    ownerReleases: [0],
    ownerCloses: [0],
  });
  await f.app.shutdown();
  assert.deepEqual(reopened(t, f, runId), {
    state: "halted",
    live: false,
    markers: 1,
  });
});

test("retained-step-fault-shutdown", async (t) => {
  const f = fixture(t);
  const runId = await faultedRun(f, "launch-fault");
  // Before shutdown the faulted drive still holds the Step and the owner.
  assert.deepEqual(cleanup(f, runId), {
    driverCloses: [0],
    ownerReleases: [0],
    ownerCloses: [0],
  });

  // Concurrent and repeated shutdown share one cleanup.
  await Promise.all([f.app.shutdown(), f.app.shutdown()]);
  await f.app.shutdown();

  // The driver and the owner close exactly once. The `running` claim is left for
  // Store reconciliation: releasing it would strand an unowned `running` Run.
  assert.deepEqual(cleanup(f, runId), {
    driverCloses: [1],
    ownerReleases: [0],
    ownerCloses: [1],
  });
  assert.deepEqual(reopened(t, f, runId), {
    state: "halted",
    live: false,
    markers: 1,
  });
});

test("shutdown drains held, faulted, and driving Runs together, each once", async (t) => {
  const f = fixture(t);
  const waiting = await waitingRun(f, "launch-wait");
  const faulted = await faultedRun(f, "launch-fault");
  const driving = await drivingRun(f, "launch-work");

  const shutdown = f.app.shutdown().then(() => f.events.push("shutdown"));
  await Promise.all([shutdown, f.app.shutdown()]);
  await f.app.shutdown();

  // The live Turn was stopped with the shutdown reason and settled first.
  assert.deepEqual(f.events, [`stopped ${driving}`, "shutdown"]);
  assert.equal(
    f.drivers.find((driver) => driver.runId === driving)?.stoppedBy,
    "secant:process-signal",
  );
  // An interactive wait releases its claim and keeps its blocked rest.
  assert.deepEqual(cleanup(f, waiting), {
    driverCloses: [1],
    ownerReleases: [1],
    ownerCloses: [1],
  });
  // Work stopped mid-Turn, faulted or signalled, leaves its claim for the Store.
  for (const runId of [faulted, driving]) {
    assert.deepEqual(cleanup(f, runId), {
      driverCloses: [1],
      ownerReleases: [0],
      ownerCloses: [1],
    });
  }
  assert.deepEqual(reopened(t, f, waiting), {
    state: "blocked",
    live: false,
    markers: 0,
  });
  for (const runId of [faulted, driving]) {
    assert.deepEqual(reopened(t, f, runId), {
      state: "halted",
      live: false,
      markers: 1,
    });
  }
});

test("a failed Step close neither skips other drains nor passes silently", async (t) => {
  const f = fixture(t);
  const failing = await faultedRun(f, "launch-failing");
  const faulted = await faultedRun(f, "launch-fault");
  const driving = await drivingRun(f, "launch-work");
  f.failingClose.add(failing);

  await assert.rejects(f.app.shutdown(), {
    message: `closing ${failing}'s Step failed`,
  });
  // The failing Run's owner still closes, and the later Runs still drain.
  for (const runId of [failing, faulted, driving]) {
    assert.deepEqual(cleanup(f, runId), {
      driverCloses: [1],
      ownerReleases: [0],
      ownerCloses: [1],
    });
  }
  assert.equal(
    f.drivers.find((driver) => driver.runId === driving)?.stoppedBy,
    "secant:process-signal",
  );

  // Nothing is retained any more, so a repeated shutdown closes nothing twice.
  await f.app.shutdown();
  for (const runId of [failing, faulted, driving]) {
    assert.deepEqual(cleanup(f, runId).driverCloses, [1]);
    assert.deepEqual(cleanup(f, runId).ownerCloses, [1]);
  }
});

test("several failed drains reject together, and a failed release still closes its owner", async (t) => {
  const f = fixture(t);
  const failingClose = await faultedRun(f, "launch-failing-close");
  const failingRelease = await waitingRun(f, "launch-failing-release");
  const faulted = await faultedRun(f, "launch-fault");
  f.failingClose.add(failingClose);
  f.failingRelease.add(failingRelease);

  await assert.rejects(f.app.shutdown(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((cause: Error) => cause.message),
      [
        `closing ${failingClose}'s Step failed`,
        `releasing ${failingRelease} failed`,
      ],
    );
    return true;
  });
  assert.deepEqual(cleanup(f, failingRelease), {
    driverCloses: [1],
    ownerReleases: [1],
    ownerCloses: [1],
  });
  for (const runId of [failingClose, faulted]) {
    assert.deepEqual(cleanup(f, runId), {
      driverCloses: [1],
      ownerReleases: [0],
      ownerCloses: [1],
    });
  }
});

test("shutdown awaits a drain a cancel already began", async (t) => {
  const f = fixture(t);
  const runId = await waitingRun(f, "launch-wait");
  let open!: () => void;
  f.closeGates.set(
    runId,
    new Promise<void>((resolve) => {
      open = resolve;
    }),
  );
  const cancel = f.app.projectionPort.submit({
    operationId: "cancel",
    operation: "cancel-run",
    input: { runId },
  });
  assert.ok(cancel.admitted);
  // The cancel's drain now waits inside the Step's close, the Run marked done.
  assert.deepEqual(cleanup(f, runId).driverCloses, [1]);

  const shutdown = f.app.shutdown().then(() => f.events.push("shutdown"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.events.push("closed");
  open();
  await shutdown;

  assert.deepEqual(f.events, ["closed", "shutdown"]);
  assert.deepEqual(await awaitSettled(f.app.projectionPort, "cancel"), {
    status: "applied",
  });
  assert.deepEqual(cleanup(f, runId), {
    driverCloses: [1],
    ownerReleases: [1],
    ownerCloses: [1],
  });
  assert.deepEqual(reopened(t, f, runId), {
    state: "cancelled",
    live: false,
    markers: 0,
  });
});
