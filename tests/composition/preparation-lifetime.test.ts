import assert from "node:assert/strict";
import test from "node:test";
import { launchTui, withClients } from "../../src/composition/main.js";
import type {
  HarnessAdapter,
  PrepareResult,
  PreparationCloseOptions,
} from "../../src/harness/harness.js";
import { makeFakeRenderer } from "../tui/renderer-fixture.js";
import { ownPreparations } from "../harness/preparation-double.js";
import {
  QUALIFICATION_DEFAULTS,
  QUALIFICATION_PROFILE,
  wiringProcess,
} from "../helpers/wiringDoubles.js";
import { home, readLog } from "./log-sink.js";
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
