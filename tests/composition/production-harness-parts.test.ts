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
import { awaitRunRest } from "../helpers/settleOperation.js";
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
