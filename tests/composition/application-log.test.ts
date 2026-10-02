import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ProjectionPort } from "../../src/application/projection-port.js";
import { withClients } from "../../src/composition/main.js";
import type { HarnessAdapter } from "../../src/harness/harness.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import { runHeadless } from "../../src/headless/headless.js";
import {
  ensureRuntimeOnPath,
  writeCommandBundle,
} from "../helpers/commandBundle.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { assertBase, home, io, readLog, WALL, type Home } from "./log-sink.js";
import {
  QUALIFICATION_PROFILE,
  qualificationAdapter,
  wiringProcess,
} from "../helpers/wiringDoubles.js";

// The Application's records in the operational log (#319): Harness qualification,
// launch preparation and Preflight, and Operation admission and outcome, written
// through the observer composition builds from the Secant invocation's log. Each
// test submits real Operations through the Projection Port with spawn-free
// Process and Harness doubles and reads back the JSONL. The stepping clock
// advances 125 ms per monotonic read, so each elapsed time is exact.

ensureRuntimeOnPath();

// The Application's own events. The invocation records (#318), the Run lifecycle
// (#320), and the Harness's phase records (#322) are asserted by their suites;
// each still reads the stepping clock, so a stage spanning them lasts longer.
const APPLICATION_EVENTS = new Set([
  "qualification-start",
  "qualification-result",
  "launch-preparation-start",
  "launch-preparation-settle",
  "preflight-start",
  "preflight-settle",
  "model-check-start",
  "model-check-settle",
  "operation-admission",
  "operation-outcome",
]);

/** The Application's records, without the base fields `assertBase` checks. */
function applicationRecords(folder: string) {
  const { records, text } = readLog(folder);
  assertBase(records);
  return {
    text,
    records: records
      .filter((record) => APPLICATION_EVENTS.has(String(record.event)))
      .map((record) => {
        const fields = { ...record };
        delete fields.time;
        delete fields.invocationId;
        return fields;
      }),
  };
}

/** A home whose Process resolves every command and whose Claude Code Harness
 *  qualifies with `adapter`. */
function wiredHome(adapter: HarnessAdapter = qualificationAdapter([])): Home {
  const h = home();
  return {
    ...h,
    overrides: {
      ...h.overrides,
      process: wiringProcess(),
      harnessAdapter: adapter,
      discoverClaudeCode: () => ({
        kind: "found",
        attempt: {
          source: "path",
          name: "claude",
          description: "PATH name 'claude'",
        },
      }),
    },
  };
}

/** A monotonic clock that moves only when the test advances it. An Operation's
 *  elapsed time is then exactly the time the test let pass between admission and
 *  outcome, however many Run or Harness records read the clock meanwhile; a
 *  synchronous stage reads 0 (the stepping clock times those). */
function frozenClock() {
  let reading = 1000;
  return {
    now: () => WALL,
    monotonic: () => reading,
    advance(ms: number) {
      reading += ms;
    },
  };
}

/** `h`'s overrides with the log reading `clock`. */
function withClock(h: Home, clock: ReturnType<typeof frozenClock>) {
  return { ...h.overrides, logSink: { ...h.overrides.logSink, clock } };
}

async function focusHarness(port: ProjectionPort): Promise<void> {
  const opened = port.openProjection({
    family: "harness-catalog",
    focus: { id: "claude-code" },
  });
  try {
    if (opened.snapshot.result.found) {
      const state = opened.snapshot.result.harness.qualification.state;
      if (state !== "not-checked") return;
    }
    await opened.updates[Symbol.asyncIterator]().next();
  } finally {
    opened.close();
  }
}

function approve(port: ProjectionPort, workspace: string): void {
  const admission = port.submit({
    operationId: "op-approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(admission.admitted);
}

const info = (fields: Record<string, unknown>) => ({
  level: "info",
  ...fields,
});

test("a Harness qualification writes a start and its Qualification state once per Secant invocation", async () => {
  const h = wiredHome();
  const status = await withClients(async (clients) => {
    await focusHarness(clients.projectionPort);
    // The held result answers a second focus: nothing is qualified, nothing written.
    await focusHarness(clients.projectionPort);
    return 0;
  }, h.overrides);
  assert.equal(status, 0);

  assert.deepEqual(applicationRecords(h.folder).records, [
    info({ event: "qualification-start", harness: "claude-code" }),
    info({
      event: "qualification-result",
      harness: "claude-code",
      status: "qualified",
      elapsedMs: 125,
    }),
  ]);
});

test("a not-ready Harness's result carries the typed failure and a translated cause, never its diagnostics", async () => {
  const cases: readonly {
    readonly adapter: HarnessAdapter;
    readonly failure: Record<string, unknown>;
    readonly message: string;
  }[] = [
    {
      adapter: {
        async prepare() {
          return {
            ok: false,
            failure: {
              phase: "prepare",
              category: "protocol-corruption",
              possibleEffects: "none",
              nativeCode: "E-NATIVE-7",
              diagnostics: "seeded-diagnostics-4be1",
              retryEvidence: "seeded-retry-evidence-9c2d",
              cause: new Error("invalid native response"),
            },
          };
        },
      },
      failure: {
        phase: "prepare",
        category: "protocol-corruption",
        possibleEffects: "none",
        nativeCode: "E-NATIVE-7",
      },
      message: "invalid native response",
    },
    {
      adapter: {
        async prepare() {
          throw new Error("prepare threw");
        },
      },
      failure: {
        phase: "prepare",
        category: "prepare-exception",
        possibleEffects: "none",
      },
      message: "prepare threw",
    },
  ];
  for (const failureCase of cases) {
    const h = wiredHome(failureCase.adapter);
    await withClients(async (clients) => {
      await focusHarness(clients.projectionPort);
      return 0;
    }, h.overrides);

    const { records, text } = applicationRecords(h.folder);
    assert.equal(records.length, 2);
    const { cause, ...result } = records[1]!;
    assert.deepEqual(result, {
      level: "warn",
      event: "qualification-result",
      harness: "claude-code",
      status: "not-ready",
      ...failureCase.failure,
      elapsedMs: 125,
    });
    const translated = cause as Record<string, unknown>;
    assert.equal(translated.type, "Error");
    assert.equal(translated.message, failureCase.message);
    assert.match(String(translated.stack), new RegExp(failureCase.message));
    assert.equal(text.includes("seeded-diagnostics-4be1"), false);
    assert.equal(text.includes("seeded-retry-evidence-9c2d"), false);
  }
});

test("a launch refused before any Run leaves launch-preparation and Preflight settlements and a refused admission", async () => {
  const h = wiredHome();
  const cmd = writeCommandBundle();
  await withClients(async (clients) => {
    assert.ok(
      clients.bundleManagement.build(cmd.folder, { noInstall: false }).ok,
    );
    approve(clients.projectionPort, h.overrides.launchCwd!);
    const admission = clients.projectionPort.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input: { bundle: { id: cmd.id }, launchInputs: {} },
    });
    assert.equal(admission.admitted, false);
    return 1;
  }, h.overrides);

  assert.deepEqual(applicationRecords(h.folder).records, [
    info({
      event: "operation-admission",
      operationId: "op-approve",
      operation: "approve-workspace",
      status: "admitted",
    }),
    info({
      event: "operation-outcome",
      operationId: "op-approve",
      operation: "approve-workspace",
      status: "applied",
      elapsedMs: 125,
    }),
    info({ event: "launch-preparation-start" }),
    info({ event: "preflight-start" }),
    info({ event: "preflight-settle", status: "passed", elapsedMs: 125 }),
    info({
      event: "launch-preparation-settle",
      status: "refused",
      codes: ["bundle-trust-required"],
      elapsedMs: 375,
    }),
    info({
      event: "operation-admission",
      operationId: "op-launch",
      operation: "launch-run",
      status: "not-admitted",
      code: "bundle-trust-required",
    }),
  ]);
});

test("headless `run launch` refused at its assessment leaves every finding's code and submits nothing", async () => {
  const h = wiredHome();
  const cmd = writeCommandBundle();
  const out = io();
  const status = await withClients(async (clients) => {
    assert.ok(
      clients.bundleManagement.build(cmd.folder, { noInstall: false }).ok,
    );
    return runHeadless(clients, ["run", "launch", cmd.id], out.io);
  }, h.overrides);
  assert.equal(status, 1);

  assert.deepEqual(applicationRecords(h.folder).records, [
    info({ event: "launch-preparation-start" }),
    info({ event: "preflight-start" }),
    info({ event: "preflight-settle", status: "passed", elapsedMs: 125 }),
    info({
      event: "launch-preparation-settle",
      status: "refused",
      codes: ["workspace-not-approved", "bundle-trust-required"],
      elapsedMs: 375,
    }),
  ]);
});

test("a launched Operation's admission and outcome share its id, and a replay is admitted without a second outcome", async () => {
  let runId = "";
  const h = wiredHome();
  const clock = frozenClock();
  const cmd = writeCommandBundle();
  await withClients(
    async (clients) => {
      const port = clients.projectionPort;
      assert.ok(
        clients.bundleManagement.build(cmd.folder, { noInstall: false }).ok,
      );
      approve(port, h.overrides.launchCwd!);
      const digest = port.openProjection({
        family: "bundle-catalog",
        focus: { id: cmd.id },
      });
      assert.ok(digest.snapshot.result.found);
      const trustDigest = digest.snapshot.result.bundle.digest;
      digest.close();
      const launch = {
        operationId: "op-launch",
        operation: "launch-run",
        input: { bundle: { id: cmd.id }, launchInputs: {}, trustDigest },
      } as const;
      const admitted = port.submit(launch);
      assert.ok(admitted.admitted && admitted.runId !== undefined);
      runId = admitted.runId;
      // The Run settles asynchronously, so its outcome is read after this.
      clock.advance(1500);
      assert.equal((await awaitSettled(port, "op-launch")).status, "applied");
      assert.ok(port.submit(launch).admitted);
      return 0;
    },
    withClock(h, clock),
  );

  const records = applicationRecords(h.folder).records;
  const launch = records.filter((record) => record.operationId === "op-launch");
  assert.deepEqual(launch, [
    info({
      event: "operation-admission",
      operationId: "op-launch",
      operation: "launch-run",
      runId,
      status: "admitted",
    }),
    info({
      event: "operation-outcome",
      operationId: "op-launch",
      operation: "launch-run",
      runId,
      status: "applied",
      elapsedMs: 1500,
    }),
    info({
      event: "operation-admission",
      operationId: "op-launch",
      operation: "launch-run",
      runId,
      status: "replayed",
    }),
  ]);
  // The launch's own preparation settled just before it was admitted.
  assert.deepEqual(records[records.indexOf(launch[0]!) - 1], {
    level: "info",
    event: "launch-preparation-settle",
    status: "passed",
    elapsedMs: 0,
  });
});

/** An Agent Bundle whose prompt carries `prompt`, installed through `build`. */
function writeAgentBundle(prompt: string): { folder: string; id: string } {
  const folder = makeTempDir("secant-applog-agent-");
  mkdirSync(join(folder, "prompts"));
  writeFileSync(join(folder, "prompts", "work.md"), `${prompt}\n`);
  const id = "dev.secant.applog-agent";
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id,
        version: "1.0.0",
        name: "Log Agent",
        description: "An Agent Bundle for the operational-log suite.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [{ path: "prompts/work.md", kind: "prompt" }],
      routing: [
        {
          id: "work",
          kind: "agent",
          session: "s",
          retry: 0,
          prompt: { asset: "prompts/work.md" },
        },
      ],
    }),
  );
  return { folder, id };
}

test("an assessment's model check is its own stage, and the qualification it needs nests inside it", async () => {
  const listed: HarnessAdapter = {
    async prepare(options) {
      const prepared = await qualificationAdapter([]).prepare(options);
      if (!prepared.ok) return prepared;
      return {
        ok: true,
        harness: {
          ...prepared.harness,
          profile: {
            ...QUALIFICATION_PROFILE,
            modelSelection: {
              at: "launch",
              declaration: { kind: "list", models: ["m1"] },
              evidence: "Launch model flag.",
            },
          },
        },
      };
    },
  };
  const h = wiredHome(listed);
  const agent = writeAgentBundle("Do the work.");
  await withClients(async (clients) => {
    const port = clients.projectionPort;
    assert.ok(
      clients.bundleManagement.build(agent.folder, { noInstall: false }).ok,
    );
    approve(port, h.overrides.launchCwd!);
    const focus = port.openProjection({
      family: "bundle-catalog",
      focus: { id: agent.id },
    });
    assert.ok(focus.snapshot.result.found);
    const trustDigest = focus.snapshot.result.bundle.digest;
    focus.close();
    const opened = port.openProjection({
      family: "launch-preparation",
      draft: {
        bundle: { id: agent.id },
        launchInputs: {},
        trustDigest,
        harness: "claude-code",
        requestedModel: "m9",
      },
    });
    try {
      assert.equal(opened.snapshot.status, "assessing");
      const update = await opened.updates[Symbol.asyncIterator]().next();
      assert.ok(update.value?.kind === "durable");
      assert.equal(update.value.snapshot.status, "not-ready");
    } finally {
      opened.close();
    }
    return 0;
  }, h.overrides);

  assert.deepEqual(applicationRecords(h.folder).records.slice(2), [
    info({ event: "launch-preparation-start" }),
    info({ event: "preflight-start" }),
    info({ event: "preflight-settle", status: "passed", elapsedMs: 125 }),
    info({
      event: "launch-preparation-settle",
      status: "passed",
      elapsedMs: 375,
    }),
    info({ event: "model-check-start", harness: "claude-code" }),
    info({ event: "qualification-start", harness: "claude-code" }),
    info({
      event: "qualification-result",
      harness: "claude-code",
      status: "qualified",
      elapsedMs: 125,
    }),
    info({
      event: "model-check-settle",
      harness: "claude-code",
      status: "refused",
      code: "requested-model-unavailable",
      elapsedMs: 375,
    }),
  ]);
});

test("seeded prompts, typed text, launch inputs, command arguments, and environment values never reach a record", async (t) => {
  const seeded = {
    prompt: "seeded-prompt-5a91",
    argument: "seeded-argument-77e0",
    input: "seeded-launch-input-c3f8",
    steer: "seeded-steer-text-2d6b",
    turn: "seeded-turn-text-90aa",
    gate: "seeded-gate-text-e41c",
    environment: "seeded-environment-value-0b7f",
  };
  setEnvironmentForTest(t, { SECANT_APPLOG_SEEDED: seeded.environment });
  const h = wiredHome();
  const cmd = writeCommandBundle({
    script: `console.log('${seeded.argument}')`,
    inputs: {
      note: { type: "text", description: "A note." },
      source: { type: "file", description: "A source file." },
    },
  });
  const agent = writeAgentBundle(seeded.prompt);
  const source = join(makeTempDir("secant-applog-input-"), "source.txt");
  writeFileSync(source, "source\n");
  await withClients(async (clients) => {
    const port = clients.projectionPort;
    assert.ok(
      clients.bundleManagement.build(cmd.folder, { noInstall: false }).ok,
    );
    assert.ok(
      clients.bundleManagement.build(agent.folder, { noInstall: false }).ok,
    );
    approve(port, h.overrides.launchCwd!);
    const digestOf = (id: string) => {
      const focus = port.openProjection({
        family: "bundle-catalog",
        focus: { id },
      });
      try {
        assert.ok(focus.snapshot.result.found);
        return focus.snapshot.result.bundle.digest;
      } finally {
        focus.close();
      }
    };
    const launched = port.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input: {
        bundle: { id: cmd.id },
        launchInputs: { note: seeded.input, source },
        trustDigest: digestOf(cmd.id),
      },
    });
    assert.ok(launched.admitted && launched.runId !== undefined);
    await awaitSettled(port, "op-launch");
    // A missing file refuses at Preflight; its value is in the Problem's prose only.
    assert.equal(
      port.submit({
        operationId: "op-missing-file",
        operation: "launch-run",
        input: {
          bundle: { id: cmd.id },
          launchInputs: { note: seeded.input, source: seeded.input },
          trustDigest: digestOf(cmd.id),
        },
      }).admitted,
      false,
    );
    const agentAssessment = port.openProjection({
      family: "launch-preparation",
      draft: {
        bundle: { id: agent.id },
        launchInputs: {},
        harness: "claude-code",
      },
    });
    agentAssessment.close();
    const runId = launched.runId;
    // None can apply: the Run has rested with no Turn, Step, or Gate open.
    const typed = [
      port.submit({
        operationId: "op-steer",
        operation: "steer-turn",
        input: { runId, turnId: "turn-1", text: seeded.steer },
      }),
      port.submit({
        operationId: "op-turn",
        operation: "send-interactive-turn",
        input: { runId, stepId: "step-1", text: seeded.turn },
      }),
      port.submit({
        operationId: "op-gate",
        operation: "answer-human-gate",
        input: {
          runId,
          gate: { runId, stepId: "gate", attemptId: "a-1", shape: "free-text" },
          text: seeded.gate,
        },
      }),
    ];
    for (const admission of typed) {
      if (admission.admitted) {
        const outcome = await awaitSettled(port, admission.operationId);
        assert.equal(outcome.status, "not-applied");
      }
    }
    return 0;
  }, h.overrides);

  const { records, text } = applicationRecords(h.folder);
  // Every submission above reached the log, so their absence below is evidence.
  const logged = new Set(records.map((record) => record.operationId));
  for (const id of [
    "op-launch",
    "op-missing-file",
    "op-steer",
    "op-turn",
    "op-gate",
  ]) {
    assert.ok(logged.has(id), `${id} reached the log`);
  }
  // The Preflight refusal carries its code at every stage, and only its code.
  const missing = records.findIndex(
    (record) => record.operationId === "op-missing-file",
  );
  assert.deepEqual(records.slice(missing - 3, missing + 1), [
    info({ event: "preflight-start" }),
    info({
      event: "preflight-settle",
      status: "refused",
      codes: ["launch-input-invalid"],
      elapsedMs: 125,
    }),
    info({
      event: "launch-preparation-settle",
      status: "refused",
      codes: ["launch-input-invalid"],
      elapsedMs: 375,
    }),
    info({
      event: "operation-admission",
      operationId: "op-missing-file",
      operation: "launch-run",
      status: "not-admitted",
      code: "launch-input-invalid",
    }),
  ]);
  for (const value of Object.values(seeded)) {
    assert.equal(text.includes(value), false, `${value} reached the log`);
  }
});

test("a resume runs Preflight again and settles it before the resumed Operation is admitted", async () => {
  let runId = "";
  const h = wiredHome();
  const clock = frozenClock();
  // The first Command cannot spawn, so the Run rests `failed`; the resumed one
  // passes.
  const base = wiringProcess();
  let failures = 1;
  const process: ProcessAdapter = {
    ...base,
    spawnCommand: (options) =>
      failures-- > 0
        ? Promise.resolve({ kind: "spawn-error" })
        : base.spawnCommand(options),
  };
  const cmd = writeCommandBundle({ retry: 0 });
  await withClients(
    async (clients) => {
      const port = clients.projectionPort;
      assert.ok(
        clients.bundleManagement.build(cmd.folder, { noInstall: false }).ok,
      );
      approve(port, h.overrides.launchCwd!);
      const focus = port.openProjection({
        family: "bundle-catalog",
        focus: { id: cmd.id },
      });
      assert.ok(focus.snapshot.result.found);
      const trustDigest = focus.snapshot.result.bundle.digest;
      focus.close();
      const launched = port.submit({
        operationId: "op-launch",
        operation: "launch-run",
        input: { bundle: { id: cmd.id }, launchInputs: {}, trustDigest },
      });
      assert.ok(launched.admitted && launched.runId !== undefined);
      runId = launched.runId;
      await awaitSettled(port, "op-launch");
      const resume = port.submit({
        operationId: "op-resume",
        operation: "resume-run",
        input: { runId: launched.runId },
      });
      assert.ok(resume.admitted, JSON.stringify(resume));
      clock.advance(1500);
      assert.equal((await awaitSettled(port, "op-resume")).status, "applied");
      return 0;
    },
    { ...withClock(h, clock), process },
  );

  const records = applicationRecords(h.folder).records;
  const resumed = records.findIndex(
    (record) => record.operationId === "op-resume",
  );
  assert.deepEqual(records.slice(resumed - 2), [
    info({ event: "preflight-start" }),
    info({ event: "preflight-settle", status: "passed", elapsedMs: 0 }),
    info({
      event: "operation-admission",
      operationId: "op-resume",
      operation: "resume-run",
      runId,
      status: "admitted",
    }),
    info({
      event: "operation-outcome",
      operationId: "op-resume",
      operation: "resume-run",
      runId,
      status: "applied",
      elapsedMs: 1500,
    }),
  ]);
});

test("the TUI's wiring difference leaves the Application's records unchanged for the same Operations", async () => {
  const script = async (h: Home) => {
    const cmd = writeCommandBundle();
    await withClients(async (clients) => {
      const port = clients.projectionPort;
      assert.ok(
        clients.bundleManagement.build(cmd.folder, { noInstall: false }).ok,
      );
      await focusHarness(port);
      approve(port, h.overrides.launchCwd!);
      port.submit({
        operationId: "op-refused",
        operation: "launch-run",
        input: { bundle: { id: cmd.id }, launchInputs: {} },
      });
      return 0;
    }, h.overrides);
    return applicationRecords(h.folder).records;
  };
  const headless = wiredHome();
  // The TUI wires the same Application through the same `wireApplication` with
  // the Secant invocation's log; it differs only in relaying interactive Turns.
  const tui = wiredHome();
  const tuiRecords = await script({
    ...tui,
    overrides: { ...tui.overrides, supportsInteractiveTurns: true },
  });
  const headlessRecords = await script(headless);
  assert.ok(headlessRecords.length > 0);
  assert.deepEqual(tuiRecords, headlessRecords);
});
