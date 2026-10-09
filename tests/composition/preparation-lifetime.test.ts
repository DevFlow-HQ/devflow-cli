import assert from "node:assert/strict";
import test from "node:test";
import { launchTui, withClients } from "../../src/composition/main.js";
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
} from "../../src/harness/harness.js";
import type {
  HarnessAdapter,
  PrepareResult,
  PreparationCloseOptions,
  HarnessDefaults,
  CleanupReport,
} from "../../src/harness/harness.js";
import { makeFakeRenderer } from "../tui/renderer-fixture.js";
import { ownPreparations } from "../harness/preparation-double.js";
import {
  QUALIFICATION_DEFAULTS,
  QUALIFICATION_PROFILE,
  wiringProcess,
} from "../helpers/wiringDoubles.js";
import { home, readLog } from "./log-sink.js";
import {
  preparationClock,
  scriptedPreparation,
} from "../harness/scripted-preparation.js";
import { openCatalog } from "../../src/catalog/catalog.js";

function lifetimeHome() {
  const fixture = home();
  return {
    ...fixture,
    overrides: { ...fixture.overrides, process: wiringProcess() },
  };
}

function qualified(trace: string[]) {
  return ownPreparations({
    async prepare() {
      trace.push("prepare");
      return {
        ok: true,
        harness: {
          profile: QUALIFICATION_PROFILE,
          readDefaults: async () => QUALIFICATION_DEFAULTS,
          startTurn: () => {
            throw new Error("no Turn");
          },
          close: async () => {
            trace.push("prepared-close");
            return { clean: true, detail: "closed" };
          },
        },
      };
    },
  });
}

for (const failure of [false, true]) {
  test(`m10-initial-preparation-ownership: headless qualification-only ${failure ? "error" : "return"} records cleanup before invocation end`, async () => {
    const { folder, overrides } = lifetimeHome();
    const trace: string[] = [];
    const original = new Error("command failed");
    const operation = withClients(
      async ({ projectionPort }) => {
        const focus = projectionPort.openProjection({
          family: "harness-catalog",
          focus: { id: "claude-code" },
        });
        const update = await focus.updates[Symbol.asyncIterator]().next();
        assert.equal(update.value?.kind, "durable");
        focus.close();
        if (failure) throw original;
        return 0;
      },
      { ...overrides, harnessAdapter: qualified(trace) },
    );
    if (failure) await assert.rejects(operation, (error) => error === original);
    else assert.equal(await operation, 0);
    assert.deepEqual(trace, ["prepare", "prepared-close"]);
    const records = readLog(folder).records;
    const reports = records.filter(
      (record) => record.event === "harness-preparation-cleanup",
    );
    assert.equal(reports.length, 2);
    assert.ok(reports.every((report) => report.status === "closed"));
    assert.equal(records.at(-1)?.event, "invocation-end");
    assert.ok(records.indexOf(reports[0]!) < records.length - 1);
  });
}

test("m10-initial-preparation-ownership: one closed Projection does not cancel shared qualification", async () => {
  const { overrides } = lifetimeHome();
  const gate = Promise.withResolvers<PrepareResult>();
  let prepares = 0;
  let signal: AbortSignal | undefined;
  const adapter = ownPreparations({
    prepare(options) {
      prepares++;
      signal = options.signal;
      return gate.promise;
    },
  });
  await withClients(
    async ({ projectionPort }) => {
      const first = projectionPort.openProjection({
        family: "harness-catalog",
        focus: { id: "claude-code" },
      });
      const second = projectionPort.openProjection({
        family: "harness-catalog",
        focus: { id: "claude-code" },
      });
      first.close();
      assert.equal(signal?.aborted, false);
      gate.resolve(
        await qualified([]).prepare({
          workspace: process.cwd(),
          process: overrides.process!,
        }),
      );
      const update = await second.updates[Symbol.asyncIterator]().next();
      assert.equal(update.value?.kind, "durable");
      assert.equal(prepares, 1);
      second.close();
      return 0;
    },
    { ...overrides, harnessAdapter: adapter },
  );
  assert.equal(
    signal?.aborted,
    false,
    "success transfers exclusively before shutdown",
  );
});

for (const route of ["quit", "mount-failure", "renderer-failure"] as const) {
  test(`m10-initial-preparation-ownership: TUI ${route} closes both Adapters and tears down once`, async () => {
    const { folder, overrides } = lifetimeHome();
    const trace: string[] = [];
    const deadlines: number[] = [];
    const make = (name: string): HarnessAdapter => {
      const adapter = qualified(trace);
      return {
        prepare: (options) => adapter.prepare(options),
        close(options: PreparationCloseOptions = {}) {
          assert.ok(options.monotonicDeadlineMs);
          deadlines.push(options.monotonicDeadlineMs);
          trace.push(`admission:${name}`);
          return adapter.close(options);
        },
      };
    };
    const port = makeFakeRenderer().port;
    const error = new Error(route);
    const run = launchTui({
      ...overrides,
      harnessAdapter: make("claude"),
      codexHarnessAdapter: make("codex"),
      terminal: { interactive: true, legacyConsole: () => false },
      createRenderer: async () => {
        if (route === "renderer-failure") throw error;
        return {
          port: {
            ...port,
            destroy: () => {
              trace.push("destroy");
            },
          },
          stdin: {
            release: () => {
              trace.push("stdin-release");
            },
          },
          mount: async (options) => {
            const focus = options.projectionPort.openProjection({
              family: "harness-catalog",
              focus: { id: "claude-code" },
            });
            await focus.updates[Symbol.asyncIterator]().next();
            focus.close();
            if (route === "mount-failure") throw error;
            options.exit();
          },
        };
      },
    });
    if (route === "quit") assert.equal(await run, 0);
    else await assert.rejects(run, (reason) => reason === error);
    assert.equal(deadlines.length, 2);
    assert.equal(
      deadlines[0],
      deadlines[1],
      "both admissions receive the same deadline",
    );
    const admissions = trace.filter((entry) => entry.startsWith("admission:"));
    assert.deepEqual(admissions, ["admission:claude", "admission:codex"]);
    if (route !== "renderer-failure") {
      assert.equal(trace.filter((entry) => entry === "destroy").length, 1);
      assert.equal(
        trace.filter((entry) => entry === "stdin-release").length,
        1,
      );
      assert.ok(
        trace.indexOf("admission:codex") < trace.indexOf("stdin-release"),
      );
    }
    const records = readLog(folder).records;
    assert.equal(
      records.filter((record) => record.event === "harness-preparation-cleanup")
        .length,
      2,
    );
    assert.equal(records.at(-1)?.event, "invocation-end");
  });
}

test("m10-initial-preparation-ownership: partial construction closes created Adapters and stores without replacing the primary failure", async () => {
  const { folder, overrides } = lifetimeHome();
  const trace: string[] = [];
  const error = new Error("Application construction failed");
  const adapter = (name: string): HarnessAdapter => {
    const base = qualified(trace);
    return {
      prepare: (options) => base.prepare(options),
      close(options) {
        trace.push(name);
        return base.close(options);
      },
    };
  };
  await assert.rejects(
    withClients(async () => 0, {
      ...overrides,
      harnessAdapter: adapter("claude"),
      codexHarnessAdapter: adapter("codex"),
      get supportsInteractiveTurns(): boolean {
        throw error;
      },
    }),
    (reason) => reason === error,
  );
  assert.deepEqual(trace, ["claude", "codex"]);
  assert.equal(
    readLog(folder).records.filter(
      (record) => record.event === "harness-preparation-cleanup",
    ).length,
    2,
  );
  const catalog = openCatalog(overrides.secantHome!);
  catalog.close();
});

test("m10-audit-preparation-lifetime-bounds: held defaults close and record cleanup before invocation end", async () => {
  const { folder, overrides } = lifetimeHome();
  const entered = Promise.withResolvers<void>();
  const defaults = Promise.withResolvers<HarnessDefaults>();
  const closed = Promise.withResolvers<void>();
  let closes = 0;
  const base = qualified([]);
  const adapter = ownPreparations({
    async prepare(options) {
      const prepared = await base.prepare(options);
      assert.ok(prepared.ok);
      return {
        ok: true,
        harness: {
          ...prepared.harness,
          readDefaults() {
            entered.resolve();
            return defaults.promise;
          },
          async close() {
            closes++;
            closed.resolve();
            return prepared.harness.close();
          },
        },
      };
    },
  });
  try {
    assert.equal(
      await withClients(
        async ({ projectionPort }) => {
          projectionPort.openProjection({
            family: "harness-catalog",
            focus: { id: "claude-code" },
          });
          await entered.promise;
          return 0;
        },
        { ...overrides, harnessAdapter: adapter },
      ),
      0,
    );
    assert.equal(closes, 1);
    const records = readLog(folder).records;
    const cleanups = records.filter(
      (record) => record.event === "harness-cleanup",
    );
    assert.equal(cleanups.length, 1);
    assert.equal(cleanups[0]?.status, "clean");
    assert.equal(records.at(-1)?.event, "invocation-end");
    assert.ok(records.indexOf(cleanups[0]!) < records.length - 1);
  } finally {
    defaults.resolve(QUALIFICATION_DEFAULTS);
    await closed.promise;
  }
});

test("m10-audit-preparation-lifetime-bounds: a handoff after admission closes skips defaults and closes once", async () => {
  const { folder, overrides } = lifetimeHome();
  const entered = Promise.withResolvers<void>();
  const handoff = Promise.withResolvers<PrepareResult>();
  const base = qualified([]);
  const success = await base.prepare({
    workspace: process.cwd(),
    process: overrides.process!,
  });
  assert.ok(success.ok);
  let reads = 0;
  let closes = 0;
  const adapter: HarnessAdapter = {
    prepare() {
      entered.resolve();
      return handoff.promise;
    },
    async close() {
      handoff.resolve({
        ok: true,
        harness: {
          ...success.harness,
          async readDefaults() {
            reads++;
            return QUALIFICATION_DEFAULTS;
          },
          async close() {
            closes++;
            return success.harness.close();
          },
        },
      });
      return { status: "closed", preparations: [] };
    },
  };
  assert.equal(
    await withClients(
      async ({ projectionPort }) => {
        projectionPort.openProjection({
          family: "harness-catalog",
          focus: { id: "claude-code" },
        });
        await entered.promise;
        return 0;
      },
      { ...overrides, harnessAdapter: adapter },
    ),
    0,
  );
  assert.equal(reads, 0);
  assert.equal(closes, 1);
  const records = readLog(folder).records;
  assert.equal(
    records.filter((record) => record.event === "harness-cleanup").length,
    1,
  );
  assert.equal(records.at(-1)?.event, "invocation-end");
});

test("m10-audit-preparation-lifetime-bounds: a logged qualification failure is absent from the shutdown report", async () => {
  const { folder, overrides } = lifetimeHome();
  await withClients(
    async ({ projectionPort }) => {
      const focus = projectionPort.openProjection({
        family: "harness-catalog",
        focus: { id: "claude-code" },
      });
      const update = await focus.updates[Symbol.asyncIterator]().next();
      assert.equal(update.value?.kind, "durable");
      focus.close();
      return 0;
    },
    {
      ...overrides,
      harnessAdapter: createClaudeCodeAdapter({ env: {}, platform: "aix" }),
    },
  );
  const records = readLog(folder).records;
  assert.equal(
    records.filter(
      (record) =>
        record.event === "qualification-result" &&
        record.category === "unsupported-platform",
    ).length,
    1,
  );
  assert.equal(
    records.filter((record) => record.event === "harness-preparation-failure")
      .length,
    0,
  );
  const report = records.find(
    (record) =>
      record.event === "harness-preparation-cleanup" &&
      record.harness === "claude-code",
  );
  assert.equal(report?.preparations, 0);
});

test("m10-audit-preparation-lifetime-bounds: retained cleanup failures do not repeat observed startup failures", async () => {
  const { folder, overrides } = lifetimeHome();
  const clock = preparationClock();
  const scripted = scriptedPreparation({
    failure: "authentication",
    cleanup: { kind: "cleanup-timeout" },
  });
  const adapter = createCodexAdapter({
    env: {},
    cleanupTimeoutMs: 0,
    preparationClock: clock.clock,
  });
  await withClients(
    async ({ projectionPort }) => {
      const focus = projectionPort.openProjection({
        family: "harness-catalog",
        focus: { id: "codex" },
      });
      const update = await focus.updates[Symbol.asyncIterator]().next();
      assert.equal(update.value?.kind, "durable");
      focus.close();
      await scripted.exit();
      return 0;
    },
    { ...overrides, process: scripted.process, codexHarnessAdapter: adapter },
  );
  const records = readLog(folder).records;
  assert.equal(
    records.filter(
      (record) =>
        record.event === "qualification-result" &&
        record.category === "authentication",
    ).length,
    1,
  );
  assert.equal(
    records.filter(
      (record) =>
        record.event === "harness-preparation-failure" &&
        record.category === "authentication",
    ).length,
    0,
  );
  assert.equal(
    records.filter(
      (record) =>
        record.event === "harness-preparation-cleanup-failure" &&
        record.category === "cleanup-timeout",
    ).length,
    1,
  );
  assert.equal(records.at(-1)?.event, "invocation-end");
});

for (const dispatch of ["timer", "late-receipt"] as const) {
  test(`m10-audit-preparation-lifetime-bounds: ${dispatch} qualification deadline records unresolved cleanup once before invocation end`, async () => {
    const { folder, overrides } = lifetimeHome();
    const clock = preparationClock();
    const entered = Promise.withResolvers<void>();
    const defaults = Promise.withResolvers<HarnessDefaults>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<CleanupReport>();
    const cleanupFinished = Promise.withResolvers<void>();
    const base = qualified([]);
    const adapter = ownPreparations(
      {
        async prepare(options) {
          const prepared = await base.prepare(options);
          assert.ok(prepared.ok);
          return {
            ok: true,
            harness: {
              ...prepared.harness,
              readDefaults() {
                entered.resolve();
                return defaults.promise;
              },
              async close() {
                cleanupStarted.resolve();
                const report = await cleanup.promise;
                cleanupFinished.resolve();
                return report;
              },
            },
          };
        },
      },
      clock.clock,
    );
    const configured = {
      ...overrides,
      harnessAdapter: adapter,
      qualificationClock: clock.clock,
    };
    const invocation = withClients(async ({ projectionPort }) => {
      projectionPort.openProjection({
        family: "harness-catalog",
        focus: { id: "claude-code" },
      });
      await entered.promise;
      return 0;
    }, configured);
    try {
      await cleanupStarted.promise;
      assert.deepEqual(clock.scheduled(), [5000]);
      if (dispatch === "timer") clock.advance(5000);
      else {
        clock.elapse(5001);
        cleanup.resolve({ clean: true, detail: "post-deadline close" });
      }
      assert.equal(await invocation, 0);
      const before = readLog(folder).text;
      const records = readLog(folder).records;
      const observations = records.filter(
        (record) => record.event === "harness-cleanup",
      );
      assert.equal(observations.length, 1);
      assert.equal(observations[0]?.status, "unclean");
      assert.equal(
        observations[0]?.category,
        "qualification-cleanup-unresolved",
      );
      assert.equal(records.at(-1)?.event, "invocation-end");
      assert.ok(records.indexOf(observations[0]!) < records.length - 1);
      cleanup.resolve({ clean: true, detail: "late close" });
      defaults.resolve(QUALIFICATION_DEFAULTS);
      await cleanupFinished.promise;
      await invocation;
      assert.equal(
        readLog(folder).text,
        before,
        "late cleanup cannot rewrite the deadline observation or use the closed sink",
      );
    } finally {
      cleanup.resolve({ clean: true, detail: "closed" });
      defaults.resolve(QUALIFICATION_DEFAULTS);
      await invocation;
    }
  });
}
