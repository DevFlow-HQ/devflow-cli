import assert from "node:assert/strict";
import type { RegisterConformanceCase } from "./conformance.js";
import { createClaudeCodeAdapter } from "../../src/harness/harness.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  createCodexAdapter,
  type HarnessAdapter,
  type HarnessPhaseFact,
} from "../../src/harness/harness.js";
import { createFake } from "./fake-adapter.js";
import { QUALIFICATION_PROFILE } from "../helpers/wiringDoubles.js";
import {
  preparationClock,
  scriptedPreparation,
} from "./scripted-preparation.js";

export function registerPreparationOwnership(
  test: RegisterConformanceCase,
): void {
  test("m10-initial-preparation-ownership: close refuses new preparation as a value", async () => {
    const adapter = createClaudeCodeAdapter({ env: {} });
    const report = await adapter.close();
    assert.equal(report.status, "closed");
    assert.strictEqual(await adapter.close(), report);
    const prepared = await adapter.prepare({
      workspace: process.cwd(),
      process: createFakeProcess({}),
    });
    assert.equal(prepared.ok, false);
    if (prepared.ok) throw new Error("shutdown admitted preparation");
    assert.equal(prepared.failure.category, "preparation-closed");
  });

  test("m10-initial-preparation-ownership: pending acquisition remains unresolved and cannot hand off late", async () => {
    const probe =
      Promise.withResolvers<
        import("../../src/process/process.js").SpawnResult
      >();
    const entered = Promise.withResolvers<void>();
    const adapter = createClaudeCodeAdapter({ env: {} });
    const preparation = adapter.prepare({
      workspace: process.cwd(),
      process: createFakeProcess({
        resolutionHandler: () => ({
          kind: "found",
          executable: process.execPath,
          prefixArgs: [],
        }),
        commandHandler: () => {
          entered.resolve();
          return probe.promise;
        },
      }),
    });
    await entered.promise;
    const report = await adapter.close({
      monotonicDeadlineMs: performance.now(),
    });
    assert.equal(report.status, "unresolved");
    assert.deepEqual(report.preparations[0]?.unresolved, [
      { kind: "preparation-pending" },
    ]);
    probe.resolve({
      kind: "exited",
      status: 0,
      text: new TextEncoder().encode("2.1.100"),
    });
    const result = await preparation;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("late handoff");
    assert.equal(result.failure.category, "preparation-cancelled");
    assert.strictEqual(await adapter.close(), report);
    assert.equal(report.status, "unresolved");
  });

  for (const name of ["claude", "codex", "fake"] as const) {
    const factory = (): HarnessAdapter =>
      name === "claude"
        ? createClaudeCodeAdapter({ env: {} })
        : name === "codex"
          ? createCodexAdapter({ env: {}, cleanupTimeoutMs: 0 })
          : createFake({ profile: QUALIFICATION_PROFILE, turns: [] })();
    test(`m10-initial-preparation-ownership: ${name} refuses after close and memoizes its immutable report`, async () => {
      const adapter = factory();
      const closing = adapter.close();
      assert.strictEqual(adapter.close(), closing);
      const result = await adapter.prepare({
        workspace: process.cwd(),
        process: createFakeProcess({}),
      });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("admitted after close");
      assert.equal(result.failure.category, "preparation-closed");
      const report = await closing;
      assert.equal(report.status, "closed");
      assert.ok(Object.isFrozen(report));
      assert.ok(Object.isFrozen(report.preparations));
    });
    test(`m10-initial-preparation-ownership: ${name} cancellation is dedicated and success transfers exclusively`, async () => {
      const adapter = factory();
      const cancel = new AbortController();
      cancel.abort();
      const cancelled = await adapter.prepare({
        workspace: process.cwd(),
        process: createFakeProcess({}),
        signal: cancel.signal,
      });
      assert.equal(cancelled.ok, false);
      if (cancelled.ok) throw new Error("cancelled handoff");
      assert.equal(cancelled.failure.category, "preparation-cancelled");
      const scripted = scriptedPreparation();
      const success = await adapter.prepare({
        workspace: process.cwd(),
        process: scripted.process,
      });
      assert.ok(success.ok);

      const report = await adapter.close();
      assert.equal(report.status, "closed");
      assert.deepEqual(
        scripted.closes,
        [],
        "Adapter never cleans up a transferred resource",
      );
      assert.equal((await success.harness.close()).clean, true);
      assert.equal(scripted.closes.length, name === "codex" ? 1 : 0);
    });
  }

  for (const category of ["authentication", "protocol"] as const) {
    for (const cleanup of [
      { kind: "cleanup-timeout" },
      {
        kind: "cleanup-error",
        cause: new Error("scripted stdin cleanup error"),
      },
    ] as const) {
      for (const finalExit of ["before", "after", "never"] as const) {
        test(`m10-initial-preparation-ownership: Codex ${category}/${cleanup.kind}, final exit ${finalExit} deadline`, async () => {
          const clock = preparationClock();
          const adapter = createCodexAdapter({
            preparationClock: clock.clock,
            env: {},
            cleanupTimeoutMs: 0,
          });
          const scripted = scriptedPreparation({ failure: category, cleanup });
          const failed = await adapter.prepare({
            workspace: process.cwd(),
            process: scripted.process,
          });
          assert.equal(failed.ok, false);
          if (failed.ok) throw new Error("failed startup handed off");
          assert.equal(
            failed.failure.category,
            category === "protocol" ? "protocol-incompatible" : category,
          );
          assert.doesNotMatch(
            failed.failure.diagnostics ?? "",
            /Cleanup ended/,
          );
          if (category === "protocol")
            assert.ok(failed.failure.cause instanceof Error);
          if (category === "authentication")
            assert.equal(failed.failure.cause, undefined);
          assert.ok(
            scripted.closedReads() > 0,
            "owner observes independent final exit",
          );

          if (finalExit === "before") await scripted.exit();
          const closing = adapter.close();
          assert.strictEqual(
            adapter.close({ monotonicDeadlineMs: 99999 }),
            closing,
          );
          if (finalExit !== "before") {
            assert.deepEqual(clock.scheduled(), [5000]);
            clock.advance(5000);
          }
          const report = await closing;
          assert.equal(
            report.status,
            finalExit === "before" ? "closed" : "unresolved",
          );
          assert.equal(
            report.preparations[0]?.startupFailure?.category,
            failed.failure.category,
          );
          assert.ok(
            report.preparations[0]?.cleanupFailures.some(
              (failure) => failure.category === cleanup.kind,
            ),
          );
          assert.ok(
            report.preparations[0]?.cleanupFailures.some(
              (failure) => failure.category === "diagnostic-drain",
            ),
          );
          assert.deepEqual(
            report.preparations[0]?.unresolved,
            finalExit === "before"
              ? []
              : [{ kind: "closure-unconfirmed", resource: 1 }],
          );
          const snapshot = JSON.stringify(report);
          if (finalExit === "after") await scripted.exit();
          assert.equal(JSON.stringify(report), snapshot);
          assert.strictEqual(await adapter.close(), report);
          assert.equal(
            scripted.closes.length,
            1,
            "cached cleanup receipt never restarts cleanup",
          );
          // Release this synthetic resource after checking the no-final-exit report.
          if (finalExit === "never") await scripted.exit();
        });
      }
    }
  }

  test("m10-initial-preparation-ownership: late acquired Codex child enters cleanup and never reaches closed observers", async () => {
    const clock = preparationClock();
    const acquisition = Promise.withResolvers<void>();
    const scripted = scriptedPreparation({ acquisition: acquisition.promise });
    const adapter = createCodexAdapter({
      preparationClock: clock.clock,
      env: {},
      cleanupTimeoutMs: 0,
    });
    const phases: HarnessPhaseFact[] = [];
    const pending = adapter.prepare({
      workspace: process.cwd(),
      process: scripted.process,
      phases: (fact) => phases.push(fact),
    });
    await scripted.acquired;

    const closing = adapter.close();
    clock.advance(5000);
    const report = await closing;
    assert.equal(report.status, "unresolved");
    assert.deepEqual(report.preparations[0]?.unresolved, [
      { kind: "preparation-pending" },
    ]);
    const count = phases.length;
    acquisition.resolve();
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("late acquisition handed off");
    assert.equal(result.failure.category, "preparation-cancelled");
    assert.equal(phases.length, count);
    assert.deepEqual(scripted.closes, [0]);
    assert.strictEqual(await adapter.close(), report);
  });

  test("m10-initial-preparation-ownership: cancellation wins at the native success boundary", async () => {
    const cancel = new AbortController();
    const scripted = scriptedPreparation({ onModelList: () => cancel.abort() });
    const adapter = createCodexAdapter({ env: {}, cleanupTimeoutMs: 0 });
    const result = await adapter.prepare({
      workspace: process.cwd(),
      process: scripted.process,
      signal: cancel.signal,
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("cancellation lost handoff");
    assert.equal(result.failure.category, "preparation-cancelled");
    assert.equal(scripted.closes.length, 1);
    assert.equal((await adapter.close()).status, "closed");
  });

  for (const native of ["claude", "codex"] as const) {
    test(`m10-initial-preparation-ownership: ${native} concurrent preparation and cache hits keep Process and cancellation scopes independent`, async () => {
      const adapter =
        native === "codex"
          ? createCodexAdapter({ env: {}, cleanupTimeoutMs: 0 })
          : createClaudeCodeAdapter({ env: {} });
      const gate =
        Promise.withResolvers<
          import("../../src/process/process.js").SpawnResult
        >();
      const entered = Promise.withResolvers<void>();
      const abort = new AbortController();
      const first = adapter.prepare({
        workspace: process.cwd(),
        signal: abort.signal,
        process: createFakeProcess({
          resolutionHandler: () => ({
            kind: "found",
            executable: process.execPath,
            prefixArgs: [],
          }),
          commandHandler: () => {
            entered.resolve();
            return gate.promise;
          },
        }),
      });
      await entered.promise;
      const next = scriptedPreparation();
      const phases: HarnessPhaseFact[] = [];
      const second = await adapter.prepare({
        workspace: process.cwd(),
        process: next.process,
        phases: (fact) => phases.push(fact),
      });
      assert.ok(second.ok);
      abort.abort();
      gate.resolve({
        kind: "exited",
        status: 0,
        text: new TextEncoder().encode("0.160.0"),
      });
      assert.equal((await first).ok, false);
      const cached = scriptedPreparation();
      const third = await adapter.prepare({
        workspace: process.cwd(),
        process: cached.process,
      });
      assert.ok(third.ok);
      await adapter.close();
      assert.deepEqual(next.closes, []);
      assert.deepEqual(cached.closes, []);
      assert.equal((await second.harness.close()).clean, true);
      assert.equal((await third.harness.close()).clean, true);
      assert.ok(
        phases.some((fact) => fact.phase === "cleanup"),
        "handoff retains its own reporting scope",
      );
    });
  }

  test("m10-initial-preparation-ownership: all Adapters share one deadline, including late acquisition", async () => {
    const clock = preparationClock(100);
    const gates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const adapters = gates.map(() =>
      createCodexAdapter({
        preparationClock: clock.clock,
        env: {},
        cleanupTimeoutMs: 5000,
      }),
    );
    const scripts = gates.map((gate) =>
      scriptedPreparation({ acquisition: gate.promise }),
    );
    const pending = adapters.map((adapter, index) =>
      adapter.prepare({
        workspace: process.cwd(),
        process: scripts[index]!.process,
      }),
    );
    await Promise.all(scripts.map((script) => script.acquired));

    const closing = adapters.map((adapter) =>
      adapter.close({ monotonicDeadlineMs: 5100 }),
    );
    assert.deepEqual(clock.scheduled(), [5100, 5100]);
    clock.advance(5100);
    const reports = await Promise.all(closing);
    assert.ok(reports.every((report) => report.status === "unresolved"));
    for (const gate of gates) gate.resolve();
    assert.ok((await Promise.all(pending)).every((result) => !result.ok));
    assert.deepEqual(
      scripts.map((script) => script.closes),
      [[0], [0]],
    );
    assert.deepEqual(clock.scheduled(), []);
  });
  test("m10-initial-preparation-ownership: an exit queued after deadline cannot enter the deadline snapshot", async () => {
    const clock = preparationClock();
    const adapter = createCodexAdapter({
      preparationClock: clock.clock,
      env: {},
      cleanupTimeoutMs: 0,
    });
    const scripted = scriptedPreparation({
      failure: "authentication",
      cleanup: { kind: "cleanup-timeout" },
    });
    assert.equal(
      (
        await adapter.prepare({
          workspace: process.cwd(),
          process: scripted.process,
        })
      ).ok,
      false,
    );

    const closing = adapter.close();
    clock.advance(5001);
    await scripted.exitNow();
    const report = await closing;
    assert.equal(report.status, "unresolved");
    assert.deepEqual(report.preparations[0]?.unresolved, [
      { kind: "closure-unconfirmed", resource: 1 },
    ]);
  });
  test("m10-initial-preparation-ownership: delayed timer dispatch cannot admit a post-deadline exit", async () => {
    const clock = preparationClock();
    const adapter = createCodexAdapter({
      env: {},
      cleanupTimeoutMs: 0,
      preparationClock: clock.clock,
    });
    const scripted = scriptedPreparation({
      failure: "authentication",
      cleanup: { kind: "cleanup-timeout" },
    });
    assert.equal(
      (
        await adapter.prepare({
          workspace: process.cwd(),
          process: scripted.process,
        })
      ).ok,
      false,
    );
    const closing = adapter.close();
    clock.elapse(5001);
    await scripted.exitNow();
    const report = await closing;
    assert.equal(report.status, "unresolved");
    assert.deepEqual(report.preparations[0]?.unresolved, [
      { kind: "closure-unconfirmed", resource: 1 },
    ]);
  });
}
