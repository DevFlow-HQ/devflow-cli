import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChildFact,
  OwnedProcessClose,
  OwnedProcessOptions,
  ProcessInterruption,
  SpawnOptions,
} from "../../src/process/process.js";
import {
  registerProcessConformanceCases,
  type ProcessConformanceScenarios,
} from "./conformance.js";
import {
  createFakeProcess,
  type FakeOwnedProcessEmission,
} from "./fake-adapter.js";

const encoder = new TextEncoder();
const executable = "/fake/bin/runtime";
const missing = "missing-process-parity-executable";
const basicOwnedOptions: OwnedProcessOptions = {
  role: "harness-runtime",
  executable,
  args: [],
  cwd: "/fake/workspace",
  env: {},
  launchTimeoutMs: 1_000,
};
const basicCommandOptions: SpawnOptions = {
  role: "command",
  executable,
  args: [],
  cwd: undefined,
  env: {},
  timeoutMs: 1_000,
  maxCaptureBytes: 1_024,
  truncationMarker: "[truncated]",
};

function terminal(close: OwnedProcessClose): FakeOwnedProcessEmission {
  return { kind: "terminal", trigger: "automatic", close };
}

function interruptTerminal(
  interruption: ProcessInterruption,
  gracefulMs: number,
): FakeOwnedProcessEmission {
  return {
    kind: "terminal",
    trigger: "interrupt",
    interruption,
    expectedGracefulMs: gracefulMs,
  };
}

const scenarios: ProcessConformanceScenarios = {
  label: "fake",
  resolution: () => ({
    process: createFakeProcess({
      resolutions: [
        {
          name: executable,
          result: { kind: "found", executable, prefixArgs: [] },
        },
        { name: missing, result: { kind: "not-found" } },
      ],
    }),
    foundName: executable,
    foundExecutable: executable,
    missingName: missing,
  }),
  commandExit: () => ({
    process: createFakeProcess({
      commands: [
        {
          trigger: "immediate",
          result: {
            kind: "exited",
            status: 17,
            text: encoder.encode("outerr"),
          },
        },
      ],
    }),
    options: basicCommandOptions,
    status: 17,
    text: "outerr",
  }),
  commandCancellation: () => {
    const controller = new AbortController();
    return {
      process: createFakeProcess({
        commands: [{ trigger: "cancellation", result: { kind: "cancelled" } }],
      }),
      options: { ...basicCommandOptions, cancelSignal: controller.signal },
      cancel: () => controller.abort(),
    };
  },
  ownedExit: () => ({
    process: createFakeProcess({
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes: encoder.encode("out-") },
            { kind: "stderr", bytes: encoder.encode("err-") },
            { kind: "stdout", bytes: encoder.encode("one") },
            { kind: "stderr", bytes: encoder.encode("two") },
            terminal({ kind: "exited", status: 23 }),
          ],
        },
      ],
    }),
    options: basicOwnedOptions,
    stdout: "out-one",
    stderr: "err-two",
    status: 23,
  }),
  ownedSignal: () => ({
    process: createFakeProcess({
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            terminal(
              process.platform === "win32"
                ? { kind: "exited", status: 1 }
                : { kind: "signal", signal: "SIGTERM" },
            ),
          ],
        },
      ],
    }),
    options: basicOwnedOptions,
    terminalKind: process.platform === "win32" ? "exited" : "signal",
  }),
  gracefulInterruption: () => {
    const gracefulMs = 2_000;
    const interruption: ProcessInterruption = {
      close: { kind: "exited", status: 0 },
      escalated: process.platform === "win32",
    };
    return {
      process: createFakeProcess({
        ownedProcesses: [
          {
            kind: "launched",
            emissions: [
              { kind: "stdout", bytes: encoder.encode("ready\n") },
              interruptTerminal(interruption, gracefulMs),
            ],
          },
        ],
      }),
      options: basicOwnedOptions,
      ready: "ready",
      gracefulMs,
      escalated: interruption.escalated,
    };
  },
  forcedBoundInterruption: () => {
    const gracefulMs = 2_000;
    const interruption: ProcessInterruption = {
      close: { kind: "signal", signal: "SIGKILL" },
      escalated: true,
    };
    return {
      process: createFakeProcess({
        ownedProcesses: [
          {
            kind: "launched",
            emissions: [
              { kind: "stdout", bytes: encoder.encode("ready\n") },
              interruptTerminal(interruption, gracefulMs),
            ],
          },
        ],
      }),
      options: basicOwnedOptions,
      ready: "ready",
      gracefulMs,
      escalated: true,
    };
  },
  escalatingInterruption: () => {
    const gracefulMs = 50;
    const interruption: ProcessInterruption = {
      close: { kind: "signal", signal: "SIGKILL" },
      escalated: true,
    };
    return {
      process: createFakeProcess({
        ownedProcesses: [
          {
            kind: "launched",
            emissions: [
              { kind: "stdout", bytes: encoder.encode("ready\n") },
              interruptTerminal(interruption, gracefulMs),
            ],
          },
        ],
      }),
      options: basicOwnedOptions,
      ready: "ready",
      gracefulMs,
      escalated: true,
    };
  },
  treeCleanup: () => ({
    process: createFakeProcess({
      commands: [{ trigger: "immediate", result: { kind: "timeout" } }],
    }),
    options: basicCommandOptions,
  }),
  failures: () => ({
    process: createFakeProcess({
      resolutions: [{ name: missing, result: { kind: "not-found" } }],
      commands: [{ trigger: "immediate", result: { kind: "spawn-error" } }],
      ownedProcesses: [
        {
          kind: "launch-failure",
          failure: {
            ok: false,
            failure: { kind: "spawn-error", cause: new Error("not found") },
          },
        },
      ],
    }),
    missingName: missing,
    command: basicCommandOptions,
    owned: basicOwnedOptions,
  }),
};

registerProcessConformanceCases(scenarios, (name, body) => test(name, body));

test("fake process refuses output after a terminal result", () => {
  const fake = createFakeProcess({
    ownedProcesses: [
      {
        kind: "launched",
        emissions: [
          terminal({ kind: "exited", status: 0 }),
          { kind: "stdout", bytes: encoder.encode("late") },
        ],
      },
    ],
  });
  assert.throws(
    () => fake.spawnOwnedProcess(basicOwnedOptions),
    /emitted stdout after its terminal result/,
  );
});

test("fake process scripts synchronous command streams independently", () => {
  const fake = createFakeProcess({
    syncCommands: [
      {
        result: {
          kind: "exited",
          status: 17,
          stdout: encoder.encode("out"),
          stderr: encoder.encode("err"),
        },
      },
    ],
  });
  assert.deepEqual(
    fake.spawnCommandSync({
      role: "git",
      executable: "git",
      args: ["status"],
      env: {},
      maxBufferBytes: 1024,
    }),
    {
      kind: "exited",
      status: 17,
      stdout: encoder.encode("out"),
      stderr: encoder.encode("err"),
    },
  );
});

test("fake process reports each scripted child's facts as the real Adapter would", async () => {
  const facts: ChildFact[] = [];
  const fake = createFakeProcess(
    {
      commands: [
        { trigger: "immediate", result: { kind: "spawn-error" } },
        { trigger: "immediate", result: { kind: "cancelled" } },
      ],
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            interruptTerminal(
              { close: { kind: "signal", signal: "SIGKILL" }, escalated: true },
              50,
            ),
          ],
        },
        {
          kind: "launch-failure",
          failure: {
            ok: false,
            failure: {
              kind: "launch-timeout",
              cause: new Error("no spawn event"),
            },
          },
        },
      ],
    },
    { observeChild: (fact) => facts.push(fact) },
  );
  await fake.spawnCommand(basicCommandOptions);
  await fake.spawnCommand(basicCommandOptions);
  const launched = await fake.spawnOwnedProcess(basicOwnedOptions);
  if (!launched.ok) throw new Error("unreachable");
  await launched.process.interrupt(50);
  await fake.spawnOwnedProcess(basicOwnedOptions);

  const [, cancelled, interrupted, timedOut] = [40_000, 40_001, 40_002, 40_003];
  const settled = { elapsedMs: 12.6 };
  assert.deepEqual(facts, [
    { kind: "spawn-error", role: "command", ...settled },
    { kind: "spawn", role: "command", pid: cancelled },
    { kind: "cancellation", role: "command", pid: cancelled },
    {
      kind: "reap",
      role: "command",
      pid: cancelled,
      signal: "SIGTERM",
      ...settled,
    },
    { kind: "spawn", role: "harness-runtime", pid: interrupted },
    { kind: "cancellation", role: "harness-runtime", pid: interrupted },
    { kind: "kill-escalation", role: "harness-runtime", pid: interrupted },
    {
      kind: "reap",
      role: "harness-runtime",
      pid: interrupted,
      signal: "SIGKILL",
      ...settled,
    },
    { kind: "spawn", role: "harness-runtime", pid: timedOut },
    { kind: "timeout", role: "harness-runtime", pid: timedOut },
    {
      kind: "reap",
      role: "harness-runtime",
      pid: timedOut,
      signal: "SIGTERM",
      ...settled,
    },
  ]);
});

test("every spawn declares a caller role from the closed set", () => {
  const { role, ...roleless } = basicCommandOptions;
  assert.equal(role, "command");
  // @ts-expect-error -- a spawn without a role fails typecheck.
  const missing: SpawnOptions = roleless;
  // @ts-expect-error -- Process's own `where.exe` role is not a caller's.
  const lookup: SpawnOptions = { ...roleless, role: "executable-lookup" };
  // @ts-expect-error -- a free label could carry a Command's executable.
  const free: SpawnOptions = { ...roleless, role: "node" };
  assert.deepEqual(
    [missing, lookup, free].map((options) => options.role),
    [undefined, "executable-lookup", "node"],
  );
});

for (const containment of ["contained", "fallback"] as const) {
  test(`owned Process exposes ${containment} evidence without changing interruption`, async () => {
    const facts: ChildFact[] = [];
    const interruption = {
      close: { kind: "exited", status: 1 },
      escalated: true,
      containment,
    } satisfies ProcessInterruption;
    const adapter = createFakeProcess(
      {
        ownedProcesses: [
          {
            kind: "launched",
            containment,
            emissions: [interruptTerminal(interruption, 100)],
          },
        ],
      },
      { observeChild: (fact) => facts.push(fact) },
    );
    const launched = await adapter.spawnOwnedProcess(basicOwnedOptions);
    assert.ok(launched.ok);
    assert.equal(launched.containment?.kind, containment);
    assert.equal(await launched.process.interrupt(100), interruption);
    assert.equal(await launched.process.closed(), interruption.close);
    assert.deepEqual(facts[0], {
      kind: "spawn",
      role: "harness-runtime",
      pid: 40_000,
      containment,
      ...(containment === "fallback" ? { containmentCause: undefined } : {}),
    });
  });
}
