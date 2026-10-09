import { writeAgentBundle } from "../helpers/agentBundle.js";
import { createFake, fakeHarnessProfile } from "../harness/fake-adapter.js";
import { heldRunPreparation } from "../harness/held-run-preparation.js";
import assert from "node:assert/strict";
import test from "node:test";
import { wireApplication, withClients } from "../../src/composition/main.js";
import type {
  HarnessAdapter,
  HarnessFailure,
} from "../../src/harness/harness.js";
import type {
  ChildFact,
  ProcessAdapterOptions,
} from "../../src/process/process.js";
import { ownPreparations } from "../harness/preparation-double.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  preparationClock,
  scriptedPreparation,
} from "../harness/scripted-preparation.js";
import {
  qualificationAdapter,
  storedProcess,
  wiringProcess,
} from "../helpers/wiringDoubles.js";
import {
  writeBundle,
  agentStep,
  launch,
  applied,
} from "../helpers/runLogFixture.js";
import { awaitSettled, awaitRunRest } from "../helpers/settleOperation.js";
import { home, readLog } from "./log-sink.js";

async function installAndLaunch(
  wired: Parameters<Parameters<typeof withClients>[0]>[0],
  workspace: string,
  routing: readonly unknown[],
) {
  const bundle = writeBundle(routing);
  const built = wired.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  await applied(wired.projectionPort, {
    operationId: "approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  if (
    routing.some(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        "kind" in step &&
        step.kind === "command",
    )
  ) {
    const receipt = wired.projectionPort.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input: {
        bundle: { id: bundle.id },
        launchInputs: {},
        trustDigest: built.report.digest,
      },
    });
    assert.ok(receipt.admitted, JSON.stringify(receipt));
    assert.ok(receipt.runId);
    return receipt.runId;
  }
  return launch(wired.projectionPort, built.report.digest);
}

test(`m10-audit-production-harness-parts-in-doubles: both Harness admissions close before a live Run begins draining`, async () => {
  const fixture = home();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const drain =
    Promise.withResolvers<import("../../src/process/process.js").SpawnResult>();
  const adapters = [qualificationAdapter([]), qualificationAdapter([])];
  const admissions: Promise<
    import("../../src/harness/harness.js").PrepareResult
  >[] = [];
  const runtime = storedProcess({
    script: {
      commandHandler(options) {
        entered.resolve();
        options.cancelSignal?.addEventListener(
          "abort",
          () => {
            for (const adapter of adapters)
              admissions.push(
                adapter.prepare({
                  workspace: process.cwd(),
                  process: createFakeProcess({}),
                }),
              );
            cancelled.resolve();
          },
          { once: true },
        );
        return drain.promise;
      },
    },
  });
  const wired = wireApplication({
    ...fixture.overrides,
    process: runtime,
    harnessAdapter: adapters[0],
    codexHarnessAdapter: adapters[1],
  });
  try {
    await installAndLaunch(wired, fixture.overrides.launchCwd!, [
      {
        id: "drain",
        kind: "command",
        command: { executable: "scripted-command", arguments: [] },
      },
    ]);
    await entered.promise;
    const shuttingDown = wired.shutdown();
    await cancelled.promise;
    const results = await Promise.all(admissions);
    assert.deepEqual(
      results.map((result) =>
        result.ok ? "admitted" : result.failure.category,
      ),
      ["preparation-closed", "preparation-closed"],
    );
    drain.resolve({ kind: "cancelled" });
    await shuttingDown;
  } finally {
    drain.resolve({ kind: "cancelled" });
    await wired.close();
  }
});

test(`m10-audit-production-harness-parts-in-doubles: composition shares exactly five seconds on the monotonic clock`, async () => {
  const fixture = home();
  const gates = [
    Promise.withResolvers<
      import("../../src/harness/harness.js").PrepareResult
    >(),
    Promise.withResolvers<
      import("../../src/harness/harness.js").PrepareResult
    >(),
  ];
  // Start at zero so reconstructing scheduled deadlines cannot add floating-point error.
  const clock = preparationClock();
  const deadlines: number[] = [];
  const adapters = gates.map((gate): HarnessAdapter => {
    const owned = ownPreparations({ prepare: () => gate.promise }, clock.clock);
    return {
      prepare: (options) => owned.prepare(options),
      close(options) {
        assert.ok(options?.monotonicDeadlineMs);
        deadlines.push(options.monotonicDeadlineMs);
        return owned.close(options);
      },
    };
  });
  const wired = wireApplication({
    ...fixture.overrides,
    process: wiringProcess(),
    harnessAdapter: adapters[0],
    codexHarnessAdapter: adapters[1],
  });
  const pending = adapters.map((adapter) =>
    adapter.prepare({
      workspace: process.cwd(),
      process: createFakeProcess({}),
    }),
  );
  try {
    const before = performance.now();
    const closing = wired.shutdown();
    const after = performance.now();
    assert.equal(deadlines.length, 2);
    assert.equal(deadlines[0], deadlines[1]);
    assert.ok(
      deadlines[0]! >= before + 5000 && deadlines[0]! <= after + 5000,
      "shared deadline is performance.now() + 5000, never wall-clock time",
    );
    assert.deepEqual(clock.scheduled(), [deadlines[0], deadlines[0]]);
    clock.advance(deadlines[0]!);
    await closing;
    assert.deepEqual(clock.scheduled(), []);
  } finally {
    clock.advance(Number.MAX_SAFE_INTEGER);
    for (const gate of gates)
      gate.resolve({
        ok: false,
        failure: {
          phase: "prepare",
          category: "preparation-cancelled",
          possibleEffects: "none",
        },
      });
    await Promise.all(pending);
    await wired.close();
  }
});

for (const cleanup of ["cleanup-timeout", "cleanup-error"] as const) {
  test(`m10-audit-production-harness-parts-in-doubles: failed Run preparation records ${cleanup} warnings before invocation end`, async () => {
    const fixture = home();
    const clock = preparationClock();
    const scripted = scriptedPreparation({
      cleanup:
        cleanup === "cleanup-error"
          ? { kind: cleanup, cause: new Error("cleanup failed") }
          : { kind: cleanup },
    });
    const failure: HarnessFailure = {
      phase: "prepare",
      category: "authentication",
      possibleEffects: "none",
      diagnostics: "Run startup refused",
    };
    const qualified = qualificationAdapter([]);
    let preparations = 0;
    const owned = ownPreparations(
      {
        async prepare(options) {
          if (++preparations === 1) return qualified.prepare(options);
          const spawned = await options.process.spawnOwnedProcess({
            role: "harness-runtime",
            executable: "scripted",
            args: [],
            cwd: options.workspace,
            env: {},
            launchTimeoutMs: 100,
          });
          assert.ok(spawned.ok);
          await spawned.process.closeStdin(0);
          // Independent final exit proves closure without erasing the failed receipt.
          await scripted.exit();
          return { ok: false, failure };
        },
      },
      clock.clock,
    );
    let runId = "";
    await withClients(
      async (wired) => {
        const catalog = wired.projectionPort.openProjection({
          family: "harness-catalog",
          focus: { id: "claude-code" },
        });
        await catalog.updates[Symbol.asyncIterator]().next();
        catalog.close();
        assert.equal(preparations, 1);
        runId = await installAndLaunch(wired, fixture.overrides.launchCwd!, [
          agentStep("work", 0),
        ]);
        const run = await awaitRunRest(wired.projectionPort, runId);
        assert.equal(run.state, "halted");
        return 0;
      },
      {
        ...fixture.overrides,
        process: {
          ...storedProcess(),
          spawnOwnedProcess: (options) =>
            scripted.process.spawnOwnedProcess(options),
        },
        harnessAdapter: owned,
      },
    );
    assert.equal(preparations, 2);
    const records = readLog(fixture.folder).records;
    assert.equal(
      records.some(
        (record) => record.event === "turn-start" && record.runId === runId,
      ),
      false,
      "failed preparation never starts a Turn",
    );
    const warning = records.find(
      (record) =>
        record.event === "harness-preparation-cleanup-failure" &&
        record.category === cleanup,
    );
    assert.ok(
      warning,
      "cleanup failure is retained separately from startup failure",
    );
    assert.equal(warning.level, "warn");
    assert.ok(records.indexOf(warning) < records.length - 1);
    assert.ok(
      records.some(
        (record) =>
          record.event === "harness-preparation-failure" &&
          record.category === "authentication",
      ),
    );
    assert.equal(records.at(-1)?.event, "invocation-end");
  });
}

test(`m10-audit-production-harness-parts-in-doubles: composition suppresses late Process facts after its bounded shutdown report`, async () => {
  const fixture = home();
  const records: { readonly event: string }[] = [];
  let observe: ProcessAdapterOptions["observeChild"];
  const { process: _process, ...overrides } = fixture.overrides;
  const wired = wireApplication(
    {
      ...overrides,
      processFactory(options) {
        observe = options.observeChild;
        return createFakeProcess({}, options);
      },
    },
    { record: (record) => records.push(record) },
  );
  try {
    assert.ok(observe);
    const fact: ChildFact = {
      kind: "exit",
      role: "harness-runtime",
      pid: 123,
      status: 0,
      elapsedMs: 1,
    };
    observe(fact);
    assert.ok(records.some((record) => record.event === "child-exit"));
    await wired.shutdown();
    const before = [...records];
    observe(fact);
    assert.deepEqual(
      records,
      before,
      "closed invocation sinks never see late child facts",
    );
  } finally {
    await wired.close();
  }
});

for (const primaryFailure of [false, true]) {
  test(`m10-audit-production-harness-parts-in-doubles: invocation cleanup warns after a ${primaryFailure ? "failed" : "successful"} client`, async () => {
    const fixture = home();
    const primary = new Error("client failed");
    const cleanup = new Error("shutdown failed");
    const adapter = qualificationAdapter([]);
    const operation = withClients(
      () => {
        if (primaryFailure) throw primary;
        return 0;
      },
      {
        ...fixture.overrides,
        process: wiringProcess(),
        harnessAdapter: {
          prepare: (options) => adapter.prepare(options),
          close: async (options) => {
            await adapter.close(options);
            throw cleanup;
          },
        },
      },
    );
    await assert.rejects(operation, (error: unknown) =>
      primaryFailure
        ? error === primary
        : error instanceof AggregateError && error.errors.includes(cleanup),
    );
    const records = readLog(fixture.folder).records;
    const warning = records.find(
      (record) => record.event === "invocation-cleanup-failure",
    );
    assert.ok(warning);
    assert.equal(warning.level, "warn");
    assert.ok(records.indexOf(warning) < records.length - 1);
    assert.equal(records.at(-1)?.event, "invocation-end");
  });
}

test("m10-audit-prepare-cancel-shutdown: cancel aborts held Run preparation and rests cancelled", async () => {
  const fixture = home();
  const preparation = heldRunPreparation();
  const wired = wireApplication({
    ...fixture.overrides,
    process: storedProcess(),
    harnessAdapter: preparation.adapter,
  });
  try {
    const runId = await installAndLaunch(wired, fixture.overrides.launchCwd!, [
      agentStep("work", 0),
    ]);
    const signal = await preparation.entered;
    assert.equal(signal.aborted, false);
    const cancel = wired.projectionPort.submit({
      operationId: "cancel",
      operation: "cancel-run",
      input: { runId },
    });
    assert.ok(cancel.admitted);
    assert.equal(
      signal.aborted,
      true,
      "cancel reaches preparation before its timeout or release",
    );
    assert.deepEqual(await awaitSettled(wired.projectionPort, "cancel"), {
      status: "applied",
    });
    assert.deepEqual(await awaitSettled(wired.projectionPort, "op-launch"), {
      status: "applied",
    });
    const view = await awaitRunRest(wired.projectionPort, runId);
    assert.equal(view.state, "cancelled");
    assert.equal(view.problem, undefined);
    assert.equal(wired.runGroup.listRuns()[0]?.live, false);
    assert.equal(view.sessions, undefined);
  } finally {
    preparation.fail();
    await wired.close();
  }
});

test("m10-audit-prepare-cancel-shutdown: shutdown retains the claim without a halted rest or Harness Problem until reopen", async () => {
  const fixture = home();
  const preparation = heldRunPreparation();
  const process = storedProcess();
  const overrides = {
    ...fixture.overrides,
    process,
    harnessAdapter: preparation.adapter,
  };
  const wired = wireApplication(overrides);
  let runId: string;
  try {
    runId = await installAndLaunch(wired, fixture.overrides.launchCwd!, [
      agentStep("work", 0),
    ]);
    const signal = await preparation.entered;
    const before = wired.runGroup.readRun(runId);
    assert.ok(before.ok);
    await wired.shutdown();
    assert.equal(signal.aborted, true);
    assert.deepEqual(await awaitSettled(wired.projectionPort, "op-launch"), {
      status: "applied",
    });
    const after = wired.runGroup.readRun(runId);
    assert.ok(after.ok);
    assert.equal(
      after.run.state,
      before.run.state,
      "shutdown writes no durable rest during preparation",
    );
    assert.notEqual(after.run.state, "halted");
    assert.equal(
      wired.runGroup.listRuns()[0]?.live,
      true,
      "the retained claim enables reconciliation",
    );
    const view = wired.projectionPort.openProjection({ family: "run", runId });
    try {
      assert.ok(view.snapshot.result.found);
      assert.equal(view.snapshot.result.run.problem, undefined);
    } finally {
      view.close();
    }
  } finally {
    preparation.fail();
    await wired.close();
  }
  const reopened = wireApplication({
    ...overrides,
    harnessAdapter: qualificationAdapter([]),
  });
  try {
    const view = await awaitRunRest(reopened.projectionPort, runId);
    assert.equal(view.state, "halted");
    assert.equal(view.problem, undefined);
    assert.equal(reopened.runGroup.listRuns()[0]?.live, false);
    assert.ok(
      view.actionOffers.some(
        (offer) => offer.action === "resume-run" && offer.available,
      ),
    );
  } finally {
    await reopened.close();
  }
});

test("m10-audit-prepare-cancel-shutdown: genuine preparation failure keeps its Harness Problem", async () => {
  const fixture = home();
  const preparation = heldRunPreparation();
  const wired = wireApplication({
    ...fixture.overrides,
    process: storedProcess(),
    harnessAdapter: preparation.adapter,
  });
  try {
    const runId = await installAndLaunch(wired, fixture.overrides.launchCwd!, [
      agentStep("work", 0),
    ]);
    const signal = await preparation.entered;
    preparation.fail();
    const outcome = await awaitSettled(wired.projectionPort, "op-launch");
    assert.equal(signal.aborted, false);
    assert.equal(outcome.status, "not-applied");
    if (outcome.status === "not-applied")
      assert.equal(outcome.problem.code, "selected-harness-unavailable");
    const run = await awaitRunRest(wired.projectionPort, runId);
    assert.equal(run.state, "halted");
    assert.equal(run.problem?.code, "selected-harness-unavailable");
    assert.equal(wired.runGroup.listRuns()[0]?.live, false);
  } finally {
    preparation.fail();
    await wired.close();
  }
});

test("m10-audit-prepare-cancel-shutdown: cancel reaches a reopened interactive Step's preparation", async () => {
  const fixture = home();
  const preparation = heldRunPreparation();
  const wired = wireApplication({
    ...fixture.overrides,
    process: storedProcess(),
    harnessAdapter: preparation.adapter,
  });
  try {
    const bundle = writeBundle([
      { ...agentStep("chat", 0), kind: "interactive-agent" },
    ]);
    const built = wired.bundleManagement.build(bundle.folder, {
      noInstall: false,
    });
    assert.ok(built.ok);
    const created = wired.runGroup.createRun({
      operationId: "seed",
      bundleSnapshotDigest: built.report.digest,
      launch: {},
      selectedHarness: "claude-code",
      modelChoice: { model: "fake-model" },
      at: new Date(),
    });
    assert.equal(created.outcome, "created");
    const owner = wired.runGroup.acquireRun(created.runId);
    assert.ok(owner);
    assert.ok(owner.writeState("blocked").ok);
    assert.ok(owner.release().ok);
    owner.close();
    const send = wired.projectionPort.submit({
      operationId: "send",
      operation: "send-interactive-turn",
      input: {
        runId: created.runId,
        stepId: "chat",
        text: "Continue the work",
      },
    });
    assert.ok(send.admitted, JSON.stringify(send));
    const signal = await preparation.entered;
    const cancel = wired.projectionPort.submit({
      operationId: "cancel",
      operation: "cancel-run",
      input: { runId: created.runId },
    });
    assert.ok(cancel.admitted);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await awaitSettled(wired.projectionPort, "cancel"), {
      status: "applied",
    });
    const view = await awaitRunRest(wired.projectionPort, created.runId);
    assert.equal(view.state, "cancelled");
    assert.equal(view.problem, undefined);
  } finally {
    preparation.fail();
    await wired.close();
  }
});

test("m10-audit-prepare-cancel-shutdown: a startup failure established before shutdown retains the Harness Problem", async () => {
  const fixture = home();
  const preparation = heldRunPreparation({
    phase: "prepare",
    category: "authentication",
    possibleEffects: "none",
    diagnostics: "Log in to the Harness",
  });
  const wired = wireApplication({
    ...fixture.overrides,
    process: storedProcess(),
    harnessAdapter: preparation.adapter,
  });
  try {
    const runId = await installAndLaunch(wired, fixture.overrides.launchCwd!, [
      agentStep("work", 0),
    ]);
    await preparation.entered;
    await wired.shutdown();
    const outcome = await awaitSettled(wired.projectionPort, "op-launch");
    assert.equal(outcome.status, "not-applied");
    if (outcome.status === "not-applied") {
      assert.equal(outcome.problem.code, "selected-harness-unavailable");
      assert.match(outcome.problem.explanation, /authentication/);
    }
    const run = wired.runGroup.readRun(runId);
    assert.ok(run.ok);
    assert.equal(run.run.state, "halted");
    assert.equal(wired.runGroup.listRuns()[0]?.live, false);
  } finally {
    preparation.fail();
    await wired.close();
  }
});

test("m10-audit-prepare-cancel-shutdown: delayed retained-Step cleanup cannot turn preparation cancellation into a Harness failure", async () => {
  const fixture = home();
  const preparation = heldRunPreparation();
  const closing = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let runPreparations = 0;
  const adapter = ownPreparations({
    async prepare(options) {
      if (options.writableDirectory === undefined || ++runPreparations > 1)
        return preparation.adapter.prepare(options);
      const prepared = await createFake({
        profile: fakeHarnessProfile(),
        turns: [],
      })().prepare(options);
      assert.ok(prepared.ok);
      return {
        ok: true,
        harness: {
          ...prepared.harness,
          async close() {
            closing.resolve();
            await release.promise;
            return prepared.harness.close();
          },
        },
      };
    },
  });
  const wired = wireApplication(
    {
      ...fixture.overrides,
      process: storedProcess(),
      harnessAdapter: adapter,
      supportsInteractiveTurns: true,
    },
    {
      record(record) {
        if (
          record.event === "operation-outcome" &&
          record.operationId === "second-launch"
        )
          settled.resolve();
      },
    },
  );
  try {
    await installAndLaunch(wired, fixture.overrides.launchCwd!, [
      { ...agentStep("chat", 0), kind: "interactive-agent" },
    ]);
    assert.deepEqual(await awaitSettled(wired.projectionPort, "op-launch"), {
      status: "applied",
    });
    const bundle = writeAgentBundle({
      id: "dev.secant.held-preparation",
      name: "Held preparation",
      description: "A Run awaiting Harness preparation",
      prompt: { path: "prompts/work.md", text: "Work" },
      routing: [agentStep("work", 0)],
    });
    const built = wired.bundleManagement.build(bundle.folder, {
      noInstall: false,
    });
    assert.ok(built.ok);
    const admission = wired.projectionPort.submit({
      operationId: "second-launch",
      operation: "launch-run",
      input: {
        bundle: { id: bundle.id },
        launchInputs: {},
        trustDigest: built.report.digest,
        harness: "claude-code",
        requestedModel: "fake-model",
      },
    });
    assert.ok(admission.admitted);
    assert.ok(admission.runId);
    await preparation.entered;
    const shuttingDown = wired.shutdown();
    await closing.promise;
    await settled.promise;
    assert.deepEqual(
      await awaitSettled(wired.projectionPort, "second-launch"),
      { status: "applied" },
    );
    const run = wired.runGroup.readRun(admission.runId);
    assert.ok(run.ok);
    assert.notEqual(run.run.state, "halted");
    assert.equal(
      wired.runGroup.listRuns().find((run) => run.runId === admission.runId)
        ?.live,
      true,
    );
    release.resolve();
    await shuttingDown;
  } finally {
    release.resolve();
    preparation.fail();
    await wired.close();
  }
});
