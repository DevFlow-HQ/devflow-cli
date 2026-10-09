import { readRun } from "../application/run-test-helpers.js";

import { writeAgentBundle as authorAgentBundle } from "../helpers/agentBundle.js";
import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  wireApplication,
  withClients,
  type Wiring,
} from "../../src/composition/main.js";
import { buildBundle } from "../../src/bundle/bundle.js";
import {
  createClaudeCodeAdapter,
  type HarnessAdapter,
} from "../../src/harness/harness.js";
import type {
  ProcessAdapter,
  ProcessAdapterOptions,
} from "../../src/process/process.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import {
  ensureRuntimeOnPath,
  RUNTIME_NAME,
  writeCommandBundle,
} from "../helpers/commandBundle.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitRunRest, awaitSettled } from "../helpers/settleOperation.js";
import { fakeHarnessProfile, createFake } from "../harness/fake-adapter.js";
import {
  QUALIFICATION_DEFAULTS,
  QUALIFICATION_PROFILE,
  qualificationAdapter,
  wiringProcess,
  storedProcess,
} from "../helpers/wiringDoubles.js";

import { call, completed } from "../helpers/agentCompletion.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { home, readLog } from "./log-sink.js";
import {
  writeBundle,
  launch as launchLoggedRun,
  applied,
  semantic,
  agentStep,
  COMPLETED,
} from "../helpers/runLogFixture.js";

/** Await a submitted Run Operation's settled outcome (execution settles async). */
async function settled(wired: Wiring, operationId: string): Promise<void> {
  await awaitSettled(wired.projectionPort, operationId);
}

for (const harness of ["claude-code", "codex"] as const) {
  for (const assess of [false, true]) {
    test(`production ${harness} registration launches an opted-in Bundle, assessment=${assess}`, async (t) => {
      const discoveries = { "claude-code": 0, codex: 0 };
      const adapter = (name: string) =>
        createFake({
          profile: {
            ...fakeHarnessProfile(),
            harness: name,
            agentCalls: { available: true, evidence: "Scripted calls." },
          },
          turns: [
            { agentCalls: [call("Work is complete.")], result: completed },
          ],
        })();
      const discovery = (id: typeof harness) => () => {
        discoveries[id]++;
        return {
          kind: "found" as const,
          attempt: {
            source: "path" as const,
            name: id,
            description: "scripted",
          },
        };
      };
      const workspacePath = realpathSync.native(
        makeTempDir("secant-call-preflight-workspace-"),
      );
      const wired = wireApplication({
        secantHome: makeTempDir("secant-call-preflight-home-"),
        launchCwd: workspacePath,
        supportsInteractiveTurns: true,
        harnessAdapter: adapter("Claude Code"),
        codexHarnessAdapter: adapter("Codex"),
        discoverClaudeCode: discovery("claude-code"),
        discoverCodex: discovery("codex"),
        process: createFakeBundleProcess(),
      });
      t.after(async () => {
        await wired.shutdown();
        wired.runGroup.close();
        wired.catalog.close();
      });
      const bundle = writeBundle([
        {
          id: "work",
          kind: "interactive-agent",
          session: "s",
          entryTurn: true,
          agentCompletion: true,
          prompt: { asset: "prompts/work.md" },
        },
      ]);
      const built = wired.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
      assert.ok(entry);
      const port = wired.projectionPort;
      assert.ok(
        port.submit({
          operationId: "approve",
          operation: "approve-workspace",
          input: { path: workspacePath },
        }).admitted,
      );
      const input = {
        bundle: { id: entry.id },
        launchInputs: {},
        harness,
        trustDigest: entry.digest,
        requestedModel: "fake",
      };
      if (assess) {
        const view = port.openProjection({
          family: "launch-preparation",
          draft: input,
        });
        try {
          assert.deepEqual(view.snapshot.findings, []);
          assert.equal(view.snapshot.status, "assessing");
          let ready = false;
          for await (const update of view.updates) {
            if (update.kind !== "durable") continue;
            assert.equal(
              update.snapshot.status,
              "ready",
              JSON.stringify(update.snapshot.findings),
            );
            assert.deepEqual(update.snapshot.findings, []);
            ready = true;
            break;
          }
          assert.ok(ready, "Assessment must publish readiness.");
        } finally {
          view.close();
        }
        assert.deepEqual(wired.runGroup.listRuns(), []);
        assert.equal(
          wired.catalog.getTrustGrant(
            entry.digest,
            entry.installationGeneration,
          ),
          undefined,
        );
      }
      const admission = port.submit({
        operationId: "launch",
        operation: "launch-run",
        input,
      });
      assert.ok(admission.admitted, JSON.stringify(admission));
      assert.ok(admission.runId);
      assert.equal((await awaitSettled(port, "launch")).status, "applied");
      const run = port.openProjection({
        family: "run",
        runId: admission.runId,
      });
      try {
        assert.ok(run.snapshot.result.found);
        assert.equal(run.snapshot.result.run.selectedHarness, harness);
        assert.equal(run.snapshot.result.run.state, "succeeded");
        assert.equal(run.snapshot.result.run.completion, "agent-declared");
      } finally {
        run.close();
      }
      assert.equal(discoveries[harness], assess ? 2 : 1);
      assert.equal(
        discoveries[harness === "codex" ? "claude-code" : "codex"],
        0,
      );
    });
  }
}

test("Harness catalog qualification prepares, reads the Harness defaults, and immediately closes before publishing the profile", async (t) => {
  const workspace = realpathSync.native(makeTempDir("secant-wire-qualify-ws-"));
  const trace: string[] = [];
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-qualify-home-"),
    launchCwd: workspace,
    harnessAdapter: qualificationAdapter(trace),
    process: wiringProcess(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const opened = wired.projectionPort.openProjection({
    family: "harness-catalog",
    focus: { id: "claude-code" },
  });
  t.after(() => opened.close());
  const update = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(update.value && update.value.kind === "durable");
  assert.deepEqual(trace, [`prepare:${workspace}`, "defaults", "close"]);
  if (update.value?.kind !== "durable") throw new Error("unreachable");
  assert.equal(update.value.snapshot.result.found, true);
  if (!update.value.snapshot.result.found) throw new Error("unreachable");
  assert.equal(
    update.value.snapshot.result.harness.qualification.state,
    "qualified",
  );
  assert.equal(
    update.value.snapshot.result.harness.configurationPosture,
    QUALIFICATION_PROFILE.configurationPosture,
  );
  assert.deepEqual(
    update.value.snapshot.result.harness.harnessDefaults,
    QUALIFICATION_DEFAULTS,
  );
});

test("Harness catalog still closes the qualification when the defaults read throws, and reports it not-ready", async (t) => {
  const trace: string[] = [];
  const reads = qualificationAdapter(trace);
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-defaults-throw-home-"),
    launchCwd: makeTempDir("secant-wire-defaults-throw-ws-"),
    harnessAdapter: ownPreparations({
      async prepare(options) {
        const prepared = await reads.prepare(options);
        if (!prepared.ok) return prepared;
        return {
          ok: true,
          harness: {
            ...prepared.harness,
            async readDefaults() {
              throw new Error("defaults read threw");
            },
          },
        };
      },
    }),
    process: wiringProcess(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const opened = wired.projectionPort.openProjection({
    family: "harness-catalog",
    focus: { id: "claude-code" },
  });
  t.after(() => opened.close());
  const update = await opened.updates[Symbol.asyncIterator]().next();
  if (update.value?.kind !== "durable") throw new Error("expected a snapshot");
  assert.deepEqual(
    trace.map((entry) => entry.split(":", 1)[0]),
    ["prepare", "close"],
  );
  if (!update.value.snapshot.result.found) throw new Error("unreachable");
  const harness = update.value.snapshot.result.harness;
  assert.equal(harness.qualification.state, "not-ready");
  assert.equal(harness.harnessDefaults, undefined);
  assert.match(harness.unavailable?.explanation ?? "", /defaults read threw/);
});

test("Harness catalog reports an unclean immediate close as not-ready", async (t) => {
  const trace: string[] = [];
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-unclean-home-"),
    launchCwd: makeTempDir("secant-wire-unclean-ws-"),
    harnessAdapter: qualificationAdapter(trace, {
      clean: false,
      detail: "the qualification child could not be reaped",
      failure: {
        phase: "cleanup",
        category: "cleanup-timeout",
        possibleEffects: "possible",
        diagnostics: "The Harness process may still be exiting.",
      },
    }),
    process: wiringProcess(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const opened = wired.projectionPort.openProjection({
    family: "harness-catalog",
    focus: { id: "claude-code" },
  });
  t.after(() => opened.close());
  const update = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(update.value && update.value.kind === "durable");
  assert.deepEqual(
    trace.map((entry) => entry.split(":", 1)[0]),
    ["prepare", "defaults", "close"],
  );
  if (update.value?.kind !== "durable") throw new Error("unreachable");
  assert.equal(update.value.snapshot.result.found, true);
  if (!update.value.snapshot.result.found) throw new Error("unreachable");
  const harness = update.value.snapshot.result.harness;
  assert.equal(harness.qualification.state, "not-ready");
  assert.equal(harness.unavailable?.possibleEffects, "unknown");
  assert.match(harness.unavailable?.explanation ?? "", /still be exiting/);
  assert.equal(harness.diagnosticReference?.type, "harness-diagnostic");
});

const qualificationFailureCases: readonly {
  readonly name: string;
  readonly adapter: () => HarnessAdapter;
  readonly category: string;
  readonly possibleEffects: "none" | "unknown";
}[] = [
  {
    name: "typed prepare refusal",
    adapter: () =>
      ownPreparations({
        async prepare() {
          return {
            ok: false,
            failure: {
              phase: "prepare",
              category: "protocol-corruption",
              possibleEffects: "none",
              diagnostics: "The qualification response was invalid.",
              cause: new Error("invalid native response"),
            },
          };
        },
      }),
    category: "protocol-corruption",
    possibleEffects: "none",
  },
  {
    name: "thrown prepare",
    adapter: () =>
      ownPreparations({
        async prepare() {
          throw new Error("prepare threw");
        },
      }),
    category: "prepare-exception",
    possibleEffects: "none",
  },
  {
    name: "thrown close",
    adapter: () =>
      ownPreparations({
        async prepare() {
          return {
            ok: true,
            harness: {
              profile: QUALIFICATION_PROFILE,
              async readDefaults() {
                return QUALIFICATION_DEFAULTS;
              },
              startTurn() {
                throw new Error("qualification must not start a Turn");
              },
              async close() {
                throw new Error("close threw");
              },
            },
          };
        },
      }),
    category: "cleanup-exception",
    possibleEffects: "unknown",
  },
  {
    name: "unclean close without typed failure",
    adapter: () =>
      qualificationAdapter([], {
        clean: false,
        detail: "the Harness could not confirm cleanup",
      }),
    category: "cleanup",
    possibleEffects: "unknown",
  },
];

for (const failureCase of qualificationFailureCases) {
  test(`Harness catalog translates ${failureCase.name} to not-ready`, async (t) => {
    const wired = wireApplication({
      secantHome: makeTempDir("secant-wire-qualify-failure-home-"),
      launchCwd: makeTempDir("secant-wire-qualify-failure-ws-"),
      harnessAdapter: failureCase.adapter(),
      process: wiringProcess(),
    });
    t.after(() => {
      wired.runGroup.close();
      wired.catalog.close();
    });
    const opened = wired.projectionPort.openProjection({
      family: "harness-catalog",
      focus: { id: "claude-code" },
    });
    t.after(() => opened.close());
    const update = await opened.updates[Symbol.asyncIterator]().next();
    assert.ok(update.value && update.value.kind === "durable");
    if (update.value?.kind !== "durable") throw new Error("unreachable");
    assert.equal(update.value.snapshot.result.found, true);
    if (!update.value.snapshot.result.found) throw new Error("unreachable");
    const harness = update.value.snapshot.result.harness;
    assert.equal(harness.qualification.state, "not-ready");
    assert.equal(harness.unavailable?.details?.category, failureCase.category);
    assert.equal(
      harness.unavailable?.possibleEffects,
      failureCase.possibleEffects,
    );
    assert.equal("cause" in (harness.unavailable ?? {}), false);
  });
}

// The composition wiring suite (#74 A18): it constructs the Application through
// the one wiring path both roots take — against a temporary home, without a
// terminal — and asserts the engine version, host platform, and launch Workspace
// reach the Application. This is the test that would have caught A1: the TUI root
// omitting engineVersion/hostPlatform so the shell ran as 0.0.0-dev on
// platforms[0]. Because both roots call wireApplication and nothing else builds
// the Application, exercising it here guards both.

const proofBundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bundles",
  "test-repair-workflow",
);
const proofId = "dev.secant.test-repair";

/** Wire a fresh Application against a temporary home, seed it with the Proof
 *  Bundle (engine floor `>=0.1.0`, above the dev sentinel), and close on teardown. */
function seeded(
  t: TestContext,
  overrides: Parameters<typeof wireApplication>[0],
): Wiring {
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-home-"),
    launchCwd: makeTempDir("secant-wire-ws-"),
    process: wiringProcess(),
    ...overrides,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  assert.ok(wired.bundleManagement.build(proofBundle, { noInstall: false }).ok);
  return wired;
}

/** The Proof Bundle's focus as the Projection Port hands it to every client. */
function focusBundle(wired: Wiring) {
  const opened = wired.projectionPort.openProjection({
    family: "bundle-catalog",
    focus: { id: proofId },
  });
  try {
    assert.ok(
      opened.snapshot.result.found,
      JSON.stringify(opened.snapshot.result),
    );
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return opened.snapshot.result.bundle;
  } finally {
    opened.close();
  }
}

test("the wiring hands the Application the engine version, host platform, and launch Workspace", (t) => {
  const workspace = makeTempDir("secant-wire-launch-");
  const wired = seeded(t, {
    launchCwd: workspace,
    engineVersion: "9.9.9",
    hostPlatform: "linux",
  });

  // The launch Workspace: the raw cwd, canonicalised by the Application (A6).
  const ws = wired.projectionPort.openProjection({ family: "workspace" });
  assert.equal(ws.snapshot.path, realpathSync.native(workspace));
  ws.close();

  const bundle = focusBundle(wired);
  // engineVersion 9.9.9 reached the Application: it satisfies the 0.1.0 floor.
  // Had a root omitted it and defaulted to 0.0.0-dev — the A1 bug — this would
  // read false.
  assert.equal(bundle.engine.satisfied, true);
  // hostPlatform linux reached the Application: the Execution summary resolves
  // commands for linux, not platforms[0].
  assert.equal(bundle.executionSummary.platform, "linux");
});

test("m12-wiring-test-helpers: [execution-store-on-fake-process] wiring injects one Process into Preflight, the Run Store, and execution", async (t) => {
  ensureRuntimeOnPath();
  const workspace = makeTempDir("secant-wire-run-ws-");
  let processConstructions = 0;
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-run-home-"),
    launchCwd: workspace,
    processFactory: () => {
      processConstructions++;
      return wiringProcess();
    },
  });
  assert.equal(processConstructions, 1);
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const cmd = writeCommandBundle();
  assert.ok(wired.bundleManagement.build(cmd.folder, { noInstall: false }).ok);
  // Approve the launch Workspace through the Port (the raw cwd; the Application
  // canonicalises it), so the launch passes the approval gate.
  const approve = wired.projectionPort.submit({
    operationId: "op-approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approve.admitted);

  const entry = wired.catalog.listEntries()[0];
  assert.ok(entry);
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: cmd.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await settled(wired, "op-launch");

  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (opened.snapshot.result.found) {
      assert.equal(opened.snapshot.result.run.state, "succeeded");
    }
  } finally {
    opened.close();
  }
});

test("m12-wiring-test-helpers: the wiring's AssetResolver maps a Bundle's script asset to its file in the Catalog's tree so a Command can run it", async (t) => {
  ensureRuntimeOnPath();
  const workspace = makeTempDir("secant-wire-asset-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-asset-home-"),
    launchCwd: workspace,
    process: wiringProcess(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  // The Command runs `<runtime> {asset:check.js}`; only the composition-built
  // AssetResolver (a path join under the Catalog's digest-named asset tree)
  // makes that `{asset}` reference resolve to an on-disk path — the seam #81
  // left open.
  const cmd = writeCommandBundle({
    asset: { path: "check.js", content: "console.log('ran-from-asset')" },
  });
  assert.ok(wired.bundleManagement.build(cmd.folder, { noInstall: false }).ok);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const entry = wired.catalog.listEntries()[0];
  assert.ok(entry);
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: cmd.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId!;
  await settled(wired, "op-launch");

  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    assert.equal(opened.snapshot.result.run.state, "succeeded");
    const output = opened.snapshot.result.run.outputs.find(
      (o) => o.name === "output",
    );
    assert.ok(output);
    const read = wired.projectionPort.readResource(output.reference);
    assert.ok(read.found);
    if (read.found) assert.match(read.content, /ran-from-asset/);
  } finally {
    opened.close();
  }
});

test("the headless client and the TUI client render the same Port snapshot", async (t) => {
  // Defaults for engineVersion and hostPlatform, so both come from the process —
  // the production behaviour of both roots. The headless client and the TUI view
  // both read the focus snapshot the Port hands out (bundle-view seeds its signal
  // from it verbatim), so both show the same engine compatibility and platform.
  const wired = seeded(t, {});
  const shared = focusBundle(wired);

  const out: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: () => {},
    cwd: () => process.cwd(),
  };
  assert.equal(
    await runHeadless(
      {
        projectionPort: wired.projectionPort,
        bundleManagement: wired.bundleManagement,
      },
      ["bundle", "inspect", proofId, "--json"],
      io,
    ),
    0,
  );
  const headless = JSON.parse(out.join("")) as {
    engine: { range: string; satisfied: boolean };
    executionSummary: { platform: string };
  };

  assert.deepEqual(headless.engine, shared.engine);
  assert.equal(
    headless.executionSummary.platform,
    shared.executionSummary.platform,
  );
  // The dev sentinel does not satisfy the 0.1.0 floor, confirming the default
  // engine version flowed through rather than a value that trivially satisfies.
  assert.equal(shared.engine.satisfied, false);
});

// --- zero-copy Runs over the Catalog's derived asset tree (#100, A8) ---------

/** Wire a fresh home + Workspace, install a Command Bundle whose script asset
 *  prints its own on-disk path, and approve the Workspace. */
function assetFixture(t: TestContext) {
  ensureRuntimeOnPath();
  const home = makeTempDir("secant-wire-zc-home-");
  const workspace = makeTempDir("secant-wire-zc-ws-");
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: wiringProcess(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const cmd = writeCommandBundle({
    asset: { path: "check.js", content: "console.log(__filename)" },
  });
  assert.ok(wired.bundleManagement.build(cmd.folder, { noInstall: false }).ok);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const entry = wired.catalog.listEntries()[0]!;
  return { home, wired, cmd, entry };
}

/** Launch and return the Run's state plus its `output` text (the script's
 *  printed path), or the refusal Problem. */
async function launch(
  wired: Wiring,
  bundleId: string,
  digest: string,
  operationId: string,
): Promise<{ state: string; output: string } | { problemCode: string }> {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "launch-run",
    input: { bundle: { id: bundleId }, launchInputs: {}, trustDigest: digest },
  });
  if (!admission.admitted) return { problemCode: admission.problem.code };
  await settled(wired, operationId);
  const opened = wired.projectionPort.openProjection({
    family: "run",
    runId: admission.runId!,
  });
  try {
    assert.ok(opened.snapshot.result.found);
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    const run = opened.snapshot.result.run;
    const output = run.outputs.find((o) => o.name === "output");
    assert.ok(output);
    const read = wired.projectionPort.readResource(output.reference);
    assert.ok(read.found);
    return { state: run.state, output: read.found ? read.content.trim() : "" };
  } finally {
    opened.close();
  }
}

test("two launches of one digest copy nothing per Run and resolve the same asset path under the Catalog's tree", async (t) => {
  const { home, wired, cmd, entry } = assetFixture(t);
  const first = await launch(wired, cmd.id, entry.digest, "op-1");
  const second = await launch(wired, cmd.id, entry.digest, "op-2");
  assert.ok("state" in first && "state" in second);
  assert.equal(first.state, "succeeded");
  assert.equal(second.state, "succeeded");
  assert.equal(first.output, second.output);
  const root = wired.catalog.assetRoot(entry.digest);
  assert.ok(root !== undefined);
  assert.equal(
    realpathSync.native(first.output),
    realpathSync.native(join(root, "check.js")),
  );
  assert.ok(!existsSync(join(home, "run-assets")));
});

test("a tree deleted by hand is re-extracted at launch; deleted managed bytes refuse with bundle-bytes-missing", async (t) => {
  const { home, wired, cmd, entry } = assetFixture(t);
  const root = wired.catalog.assetRoot(entry.digest);
  assert.ok(root !== undefined);
  rmSync(root, { recursive: true, force: true });
  const relaunched = await launch(wired, cmd.id, entry.digest, "op-1");
  assert.ok("state" in relaunched);
  assert.equal(relaunched.state, "succeeded");
  assert.ok(existsSync(join(root, "check.js")));

  rmSync(join(home, "bundles", `${entry.digest}.wfb`));
  const refused = await launch(wired, cmd.id, entry.digest, "op-2");
  assert.deepEqual(refused, { problemCode: "bundle-bytes-missing" });
});

test("a legacy run-assets directory is swept once at open", (t) => {
  const home = makeTempDir("secant-wire-sweep-home-");
  mkdirSync(join(home, "run-assets", "run-1"), { recursive: true });
  writeFileSync(join(home, "run-assets", "run-1", "x.js"), "x");
  const wired = wireApplication({
    secantHome: home,
    launchCwd: makeTempDir("secant-wire-sweep-ws-"),
    process: wiringProcess(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  assert.ok(!existsSync(join(home, "run-assets")));
});

test("both roots ensure the Shipped Bundles at startup, and a later startup changes nothing", (t) => {
  const built = buildBundle(proofBundle, []);
  assert.ok(built.ok);
  const shippedBundleDir = makeTempDir("secant-wire-shipped-");
  writeFileSync(join(shippedBundleDir, "proof.wfb"), built.built.bytes);
  writeFileSync(join(shippedBundleDir, "notes.txt"), "not a Bundle");
  const home = makeTempDir("secant-wire-shipped-home-");
  const wire = (supportsInteractiveTurns: boolean) => {
    const wired = wireApplication({
      secantHome: home,
      launchCwd: makeTempDir("secant-wire-shipped-ws-"),
      engineVersion: "3.1.4",
      process: wiringProcess(),
      shippedBundleDir,
      supportsInteractiveTurns,
    });
    t.after(() => {
      wired.runGroup.close();
      wired.catalog.close();
    });
    return wired;
  };

  const tui = wire(true);
  assert.deepEqual(tui.startupNotices, []);
  const [entry] = tui.catalog.listEntries();
  assert.deepEqual(entry?.origin, { kind: "built-in", secantVersion: "3.1.4" });

  const headless = wire(false);
  assert.deepEqual(headless.startupNotices, []);
  assert.deepEqual(headless.catalog.listEntries(), [entry]);

  // No shipped directory (dev and tests): zero Shipped Bundles, nothing reported.
  const bare = wireApplication({
    secantHome: makeTempDir("secant-wire-bare-home-"),
    launchCwd: makeTempDir("secant-wire-bare-ws-"),
    process: wiringProcess(),
    shippedBundleDir: join(shippedBundleDir, "absent"),
  });
  t.after(() => {
    bare.runGroup.close();
    bare.catalog.close();
  });
  assert.deepEqual(bare.startupNotices, []);
  assert.equal(bare.catalog.countInstalledBundles(), 0);
});

for (const throwingRecord of [
  "qualification-",
  "harness-cleanup",
  "every",
] as const) {
  test(`throwing ${throwingRecord} records leave Projection opening and qualification successful`, async (t) => {
    const trace: string[] = [];
    const wired = wireApplication(
      {
        secantHome: makeTempDir("secant-wire-throw-home-"),
        launchCwd: makeTempDir("secant-wire-throw-ws-"),
        harnessAdapter: qualificationAdapter(trace),
        process: wiringProcess(),
      },
      {
        record(record) {
          if (
            throwingRecord === "every" ||
            record.event.startsWith(throwingRecord)
          )
            throw new Error("observer failed");
        },
      },
    );
    t.after(() => {
      wired.runGroup.close();
      wired.catalog.close();
    });
    const opened = wired.projectionPort.openProjection({
      family: "harness-catalog",
      focus: { id: "claude-code" },
    });
    t.after(() => opened.close());
    const update = await opened.updates[Symbol.asyncIterator]().next();
    assert.ok(update.value?.kind === "durable");
    assert.ok(update.value.snapshot.result.found);
    assert.equal(
      update.value.snapshot.result.harness.qualification.state,
      "qualified",
    );
    assert.deepEqual(
      trace.map((entry) => entry.split(":", 1)[0]),
      ["prepare", "defaults", "close"],
    );
  });
}

async function appliedObserverOperation(
  wired: Wiring,
  submission: Parameters<Wiring["projectionPort"]["submit"]>[0],
): Promise<void> {
  assert.ok(wired.projectionPort.submit(submission).admitted);
  const outcome = await awaitSettled(
    wired.projectionPort,
    submission.operationId,
  );
  assert.equal(outcome.status, "applied");
}

for (const kind of ["agent", "interactive-agent"] as const) {
  test(`throwing every log record preserves an ${kind} Run, its Turn result, and cleanup`, async (t) => {
    const workspace = makeTempDir("secant-throw-run-ws-");
    const bundleId = "dev.secant.observer";

    const { folder } = authorAgentBundle({
      id: bundleId,
      name: "Observer",
      description: "Observer failure regression.",
      prompt: { path: "work.md", text: "Do the work." },
      routing: [
        {
          id: "draft",
          kind,
          retry: 0,
          session: "planning",
          prompt: { asset: "work.md" },
        },
      ],
    });
    const wired = wireApplication(
      {
        secantHome: makeTempDir("secant-throw-run-home-"),
        supportsInteractiveTurns: true,
        launchCwd: workspace,
        process: wiringProcess(),
        harnessAdapter: createFake({
          profile: QUALIFICATION_PROFILE,
          turns: [
            {
              result: {
                kind: "completed",
                detail: {
                  effectiveModel: { known: false },
                  session: {
                    state: "detached",
                    coordinate: { opaque: "fake-session" },
                  },
                  usage: {
                    summary: "input 1, output 2 tokens",
                  },
                },
              },
            },
          ],
        })(),
      },
      {
        record() {
          throw new Error("observer failed");
        },
      },
    );
    t.after(async () => {
      await wired.shutdown();
      wired.runGroup.close();
      wired.catalog.close();
    });
    const built = wired.bundleManagement.build(folder, {
      noInstall: false,
    });
    assert.ok(built.ok);
    await appliedObserverOperation(wired, {
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    });
    const admission = wired.projectionPort.submit({
      operationId: "op-launch",
      operation: "launch-run",
      input: {
        bundle: { id: bundleId },
        launchInputs: {},
        trustDigest: built.report.digest,
        harness: "claude-code",
        requestedModel: "fake-model",
      },
    });
    assert.ok(admission.admitted, JSON.stringify(admission));
    assert.ok(admission.runId);
    const runId = admission.runId;
    const outcome = await awaitSettled(wired.projectionPort, "op-launch");
    assert.equal(outcome.status, "applied");
    if (kind === "interactive-agent") {
      assert.equal(readRun(wired.projectionPort, runId).state, "blocked");
      await appliedObserverOperation(wired, {
        operationId: "op-turn",
        operation: "send-interactive-turn",
        input: { runId, stepId: "draft", text: "do the work" },
      });
      assert.equal(
        (await awaitRunRest(wired.projectionPort, runId)).state,
        "blocked",
      );
      await appliedObserverOperation(wired, {
        operationId: "op-end",
        operation: "end-interactive-step",
        input: { runId, stepId: "draft" },
      });
    }
    const run = readRun(wired.projectionPort, runId);
    assert.equal(run.state, "succeeded");
    assert.deepEqual(
      run.timeline
        .filter(
          (event) =>
            event.event ===
            (kind === "agent" ? "attempt-settled" : "interactive-step-ended"),
        )
        .map((event) => event.detail),
      ["succeeded"],
    );
    assert.deepEqual(
      run.timeline
        .filter((event) => event.event === "turn-settled")
        .map((event) => event.detail),
      ["completed"],
    );
  });
}
for (const ownership of ["released", "held-elsewhere"] as const) {
  test(`cancelling a blocked Run whose prior owner is ${ownership} logs the committed rest`, async (t) => {
    const h = home();
    const overrides = {
      ...h.overrides,
      process: createFakeBundleProcess(),
      harnessAdapter: createFake({
        profile: fakeHarnessProfile(),
        turns: [{ result: COMPLETED }],
      })(),
      discoverClaudeCode: () => ({
        kind: "found" as const,
        attempt: {
          source: "path" as const,
          name: "claude",
          description: "fake",
        },
      }),
    };
    const first = wireApplication(overrides);
    t.after(async () => {
      await first.shutdown();
      first.runGroup.close();
      first.catalog.close();
    });
    const bundle = writeBundle([
      agentStep("draft", 0),
      {
        id: "gate",
        kind: "human-gate",
        shape: "approve-reject",
        message: "ok?",
      },
    ]);
    const built = first.bundleManagement.build(bundle.folder, {
      noInstall: false,
    });
    assert.ok(built.ok);
    await applied(first.projectionPort, {
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: overrides.launchCwd! },
    });
    const runId = launchLoggedRun(first.projectionPort, built.report.digest);
    await awaitSettled(first.projectionPort, "op-launch");
    if (ownership === "released") await first.shutdown();
    await withClients(async (clients) => {
      await applied(clients.projectionPort, {
        operationId: "op-cancel",
        operation: "cancel-run",
        input: { runId },
      });
      return 0;
    }, overrides);
    const records = readLog(h.folder).records;
    assert.deepEqual(
      records.filter((record) => record.event === "run-end").map(semantic),
      [{ event: "run-end", runId, outcome: "cancelled" }],
    );
    assert.deepEqual(
      records
        .filter((record) => record.operationId === "op-cancel")
        .map(semantic),
      [
        {
          event: "operation-admission",
          operationId: "op-cancel",
          operation: "cancel-run",
          runId,
          status: "admitted",
        },
        {
          event: "operation-outcome",
          operationId: "op-cancel",
          operation: "cancel-run",
          runId,
          status: "applied",
          elapsedMs: 125,
        },
      ],
    );
  });
}

test("a preparation failure on a fenced owner records the refusal without claiming a halted Run rest", async (t) => {
  const h = home();
  const observer = wireApplication(h.overrides);
  let replacement: ReturnType<typeof observer.runGroup.acquireRun>;
  let runId = "";
  let prepares = 0;
  t.after(async () => {
    replacement?.release();
    replacement?.close();
    await observer.shutdown();
    observer.runGroup.close();
    observer.catalog.close();
  });
  const adapter: HarnessAdapter = ownPreparations({
    prepare(options) {
      if (++prepares === 2) {
        replacement = observer.runGroup.acquireRun(runId, { takeover: true });
        assert.ok(replacement);
        return Promise.resolve({
          ok: false,
          failure: {
            phase: "prepare",
            category: "protocol-incompatible",
            possibleEffects: "none",
          },
        });
      }
      return createFake({
        profile: fakeHarnessProfile(),
        turns: [{ result: COMPLETED }],
      })().prepare(options);
    },
  });
  const bundle = writeBundle([
    agentStep("draft", 0),
    { id: "gate", kind: "human-gate", shape: "approve-reject", message: "ok?" },
    agentStep("apply", 0),
  ]);
  await withClients(
    async (clients) => {
      const built = clients.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok);
      const port = clients.projectionPort;
      await applied(port, {
        operationId: "op-approve",
        operation: "approve-workspace",
        input: { path: h.overrides.launchCwd! },
      });
      runId = launchLoggedRun(port, built.report.digest);
      await awaitSettled(port, "op-launch");
      const gate = readRun(port, runId).pendingGate?.gate;
      assert.ok(gate);
      assert.ok(
        port.submit({
          operationId: "op-continue",
          operation: "answer-human-gate",
          input: { runId, gate, answer: "continue" },
        }).admitted,
      );
      const outcome = await awaitSettled(port, "op-continue");
      assert.equal(outcome.status, "not-applied");
      if (outcome.status !== "not-applied") throw new Error("unreachable");
      assert.equal(outcome.problem.code, "selected-harness-unavailable");
      return 0;
    },
    {
      ...h.overrides,
      process: createFakeBundleProcess(),
      harnessAdapter: adapter,
      discoverClaudeCode: () => ({
        kind: "found",
        attempt: { source: "path", name: "claude", description: "fake" },
      }),
    },
  );
  const records = readLog(h.folder).records;
  assert.deepEqual(
    records
      .filter((record) => record.event === "run-end")
      .map((record) => [record.runId, record.outcome]),
    [[runId, "blocked"]],
  );
  const refusal = records.find(
    (record) =>
      record.event === "operation-outcome" &&
      record.operationId === "op-continue",
  );
  assert.equal(refusal?.runId, runId);
  assert.equal(refusal?.code, "selected-harness-unavailable");
});

// --- Run-scoped attribution (#333, audit A7) ------------------------------------

const OVERLAP_SESSION_ID = "33333333-3333-4333-8333-333333333333";

/** A Command Step then an Agent Step, both Runs of it sharing Session `s`. */
function writeOverlapBundle(): { folder: string; id: string } {
  const id = "dev.secant.overlap";
  const { folder } = authorAgentBundle({
    id: id,
    name: "Overlap",
    description: "Two overlapping Runs share one Session name.",
    prompt: { path: "work.md", text: "Do the work." },
    routing: [
      {
        id: "check",
        kind: "command",
        produces: [{ name: "output", type: "text" }],
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "console.log('checked')"],
        },
      },
      {
        id: "draft",
        kind: "agent",
        retry: 0,
        session: "s",
        prompt: { asset: "work.md" },
      },
    ],
  });
  return { folder, id };
}

/** The Claude Code stream one scripted Session child emits: init, then a
 *  completed result carrying usage. */
function claudeTurnFrames(): Uint8Array {
  const frames = [
    {
      type: "system",
      subtype: "init",
      session_id: OVERLAP_SESSION_ID,
      model: "scripted-model",
      tools: [],
      mcp_servers: [],
      claude_code_version: "2.1.234",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: OVERLAP_SESSION_ID,
      total_cost_usd: 0.001,
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  ];
  return new TextEncoder().encode(
    frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""),
  );
}

/** A Process factory every construction of which shares one fake Git and the
 *  Bundle's Command handlers, so only the observer it is given differs. Each
 *  Claude Code Session child is held at spawn until a second one is requested,
 *  so two Runs' Turns are live at once. */
function overlappingProcess() {
  const bundle = createFakeBundleProcess({ executables: ["claude"] });
  let arrivals = 0;
  let firstArrived!: () => void;
  const first = new Promise<void>((resolve) => {
    firstArrived = resolve;
  });
  let secondArrived!: () => void;
  const second = new Promise<void>((resolve) => {
    secondArrived = resolve;
  });
  const factory = (options: ProcessAdapterOptions): ProcessAdapter => {
    const scripted = createFakeProcess(
      {
        resolutionHandler: (name) => bundle.resolveExecutable(name),
        commandHandler: (spawn) =>
          spawn.role === "harness-probe"
            ? {
                kind: "exited",
                status: 0,
                text: new TextEncoder().encode("2.1.234 (Claude Code)"),
              }
            : bundle.spawnCommand(spawn),
        syncCommandHandler: (spawn) => bundle.spawnCommandSync(spawn),
      },
      options,
    );
    return {
      resolveExecutable: (name, resolve) =>
        scripted.resolveExecutable(name, resolve),
      spawnCommand: (spawn) => scripted.spawnCommand(spawn),
      spawnCommandSync: (spawn) => scripted.spawnCommandSync(spawn),
      async spawnOwnedProcess(spawn) {
        arrivals += 1;
        if (arrivals === 1) {
          firstArrived();
          await second;
        } else if (arrivals === 2) {
          secondArrived();
        }
        return createFakeProcess(
          {
            ownedProcesses: [
              {
                kind: "launched",
                stdinReplies: (bytes) => {
                  const frame = JSON.parse(new TextDecoder().decode(bytes));
                  if (frame.type === "user")
                    return [{ kind: "stdout", bytes: claudeTurnFrames() }];
                  if (frame.request?.subtype === "mcp_set_servers")
                    return [
                      {
                        kind: "stdout",
                        bytes: new TextEncoder().encode(
                          JSON.stringify({
                            type: "control_response",
                            response: {
                              subtype: "success",
                              request_id: frame.request_id,
                              response: {
                                added: Object.keys(frame.request.servers),
                                removed: [],
                                errors: {},
                              },
                            },
                          }) + "\n",
                        ),
                      },
                    ];
                  if (frame.request?.subtype !== "get_settings") return [];
                  return [
                    {
                      kind: "stdout",
                      bytes: new TextEncoder().encode(
                        JSON.stringify({
                          type: "control_response",
                          response: {
                            subtype: "success",
                            request_id: frame.request_id,
                            response: {
                              applied: { model: "fake-model", effort: "high" },
                            },
                          },
                        }) + "\n",
                      ),
                    },
                  ];
                },
                emissions: [
                  {
                    kind: "terminal",
                    trigger: "close-stdin",
                    close: { kind: "exited", status: 0 },
                  },
                ],
              },
            ],
          },
          options,
        ).spawnOwnedProcess(spawn);
      },
    };
  };
  return { factory, firstSessionRequested: first };
}

/** The usage summary a Run's records carry, so the attribution assertion does
 *  not restate the Adapter's own formatting. */
function usageSummary(records: readonly Record<string, unknown>[]): string {
  const usage = records.find((record) => record.event === "harness-usage");
  assert.equal(typeof usage?.summary, "string");
  return usage!.summary as string;
}

test("two overlapping Runs sharing one Session attribute every Harness and child record to their own Run", async () => {
  const { folder, overrides } = home();
  const workspace = overrides.launchCwd!;
  const scoped = overlappingProcess();
  const runIds: string[] = [];
  const status = await withClients(
    async (clients) => {
      const port = clients.projectionPort;
      const bundle = writeOverlapBundle();
      const built = clients.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok, JSON.stringify(built));
      await applied(port, {
        operationId: "op-approve",
        operation: "approve-workspace",
        input: { path: workspace },
      });
      const launch = (operationId: string) => {
        const admission = port.submit({
          operationId,
          operation: "launch-run",
          input: {
            bundle: { id: bundle.id },
            launchInputs: {},
            trustDigest: built.report.digest,
            harness: "claude-code",
            requestedModel: "fake-model",
          },
        });
        assert.ok(admission.admitted, JSON.stringify(admission));
        runIds.push(admission.runId!);
      };
      launch("op-launch-a");
      // The first Run's Turn is live (its Session child requested) before the
      // second Run launches, so the second prepares from the cached profile.
      await scoped.firstSessionRequested;
      launch("op-launch-b");
      await awaitSettled(port, "op-launch-a");
      await awaitSettled(port, "op-launch-b");
      for (const runId of runIds) {
        assert.equal((await awaitRunRest(port, runId)).state, "succeeded");
      }
      // Qualification after both Runs: its records belong to no Run.
      const opened = port.openProjection({
        family: "harness-catalog",
        focus: { id: "claude-code" },
      });
      await opened.updates[Symbol.asyncIterator]().next();
      opened.close();
      return 0;
    },
    {
      ...overrides,
      process: undefined,
      processFactory: scoped.factory,
      discoverClaudeCode: () => ({
        kind: "found",
        attempt: { source: "path", name: "claude", description: "fake" },
      }),
      harnessAdapter: createClaudeCodeAdapter({
        env: {},
        sessionId: () => OVERLAP_SESSION_ID,
      }),
    },
  );
  assert.equal(status, 0);

  const [runA, runB] = runIds as [string, string];
  const records = readLog(folder).records.map(semantic);
  const ofRun = (runId: string | undefined) =>
    records.filter((record) => record.runId === runId);
  const harness = (subset: readonly Record<string, unknown>[]) =>
    subset.filter((record) => String(record.event).startsWith("harness-"));
  const children = (subset: readonly Record<string, unknown>[], role: string) =>
    subset
      .filter((record) => record.childRole === role)
      .map((record) => record.event);

  // Both Runs launched their Session before either Session child spawned.
  const at = (predicate: (record: Record<string, unknown>) => boolean) =>
    records.findIndex(predicate);
  const launched = (runId: string) =>
    at(
      (r) =>
        r.event === "harness-phase-start" &&
        r.phase === "launch" &&
        r.runId === runId,
    );
  const firstSessionChild = at(
    (r) => r.event === "child-spawn" && r.childRole === "harness-runtime",
  );
  assert.ok(launched(runA) >= 0 && launched(runA) < firstSessionChild);
  assert.ok(launched(runB) >= 0 && launched(runB) < firstSessionChild);

  for (const runId of [runA, runB]) {
    const run = ofRun(runId);
    // The scripted child acknowledges attachment, then emits init after the prompt;
    // both launch and handshake records must belong to this Run.
    assert.deepEqual(
      harness(run).map(({ elapsedMs: _elapsed, ...rest }) => rest),
      [
        { event: "harness-phase-start", phase: "launch", session: "s" },
        {
          event: "harness-phase-end",
          phase: "launch",
          session: "s",
          status: "ok",
        },
        { event: "harness-phase-start", phase: "handshake", session: "s" },
        {
          event: "harness-phase-end",
          phase: "handshake",
          session: "s",
          status: "ok",
        },
        {
          event: "harness-usage",
          session: "s",
          summary: usageSummary(run),
        },
        { event: "harness-phase-start", phase: "cleanup" },
        { event: "harness-phase-end", phase: "cleanup", status: "ok" },
        {
          event: "harness-cleanup",
          status: "clean",
          sessions: [{ session: "s", availability: "detached" }],
        },
      ].map(({ event, ...fields }) => ({
        event,
        runId,
        harness: "claude-code",
        ...fields,
      })),
    );
    assert.deepEqual(children(run, "command"), ["child-spawn", "child-exit"]);
    assert.deepEqual(children(run, "harness-runtime"), [
      "child-spawn",
      "child-exit",
    ]);
    assert.ok(children(run, "git").length >= 2);
  }
  // Only the first Run probed the version; the second reused its cached profile.
  assert.deepEqual(children(ofRun(runA), "harness-probe"), [
    "child-spawn",
    "child-exit",
  ]);
  assert.deepEqual(
    records
      .filter((record) => record.childRole === "harness-probe")
      .map((record) => record.runId),
    [runA, runA],
  );
  // The settings-only qualification child belongs to the invocation, while
  // every Run child above retains its exact Run scope (#347).
  const qualificationChildren = records.filter(
    (record) =>
      String(record.event).startsWith("child-") &&
      record.runId !== runA &&
      record.runId !== runB,
  );
  assert.deepEqual(
    qualificationChildren.map(
      ({ childPid: _pid, elapsedMs: _elapsed, ...record }) => record,
    ),
    [
      { event: "child-spawn", childRole: "harness-runtime" },
      { event: "child-exit", childRole: "harness-runtime", exitStatus: 0 },
    ],
  );
  assert.equal(
    qualificationChildren[0]?.childPid,
    qualificationChildren[1]?.childPid,
  );
  // Qualification prepared the cached Harness and closed it, under no Run.
  assert.deepEqual(
    harness(ofRun(undefined)).map((record) => [record.event, record.phase]),
    [
      ["harness-phase-start", "cleanup"],
      ["harness-phase-end", "cleanup"],
      ["harness-cleanup", undefined],
      ["harness-preparation-cleanup", undefined],
      ["harness-preparation-cleanup", undefined],
    ],
  );
});

for (const harness of ["claude-code", "codex"] as const) {
  for (const kind of ["agent", "interactive-agent"] as const) {
    test(`m10-commands-and-input-rules: production ${harness} ${kind} admission uses its static rules`, async (t) => {
      const workspacePath = realpathSync.native(
        makeTempDir("secant-input-rule-workspace-"),
      );
      const adapter = createFake({
        profile: fakeHarnessProfile(),
        turns: harness === "codex" ? [{ result: completed }] : [],
      })();
      const wired = wireApplication({
        secantHome: makeTempDir("secant-input-rule-home-"),
        launchCwd: workspacePath,
        supportsInteractiveTurns: true,
        harnessAdapter: adapter,
        codexHarnessAdapter: adapter,
        process: createFakeBundleProcess(),
        discoverClaudeCode: () => ({
          kind: "found",
          attempt: { source: "path", name: "claude", description: "scripted" },
        }),
        discoverCodex: () => ({
          kind: "found",
          attempt: { source: "path", name: "codex", description: "scripted" },
        }),
      });
      t.after(async () => {
        await wired.shutdown();
        wired.runGroup.close();
        wired.catalog.close();
      });
      const folder = makeTempDir("secant-input-rule-bundle-");
      const id = "dev.secant.input-rule-test";
      writeFileSync(join(folder, "p.md"), "{{artifact:task}}");
      writeFileSync(
        join(folder, "manifest.json"),
        JSON.stringify({
          formatVersion: 1,
          bundle: {
            id,
            version: "1.0.0",
            name: "Input rules",
            description: "Ordinary authored Bundle.",
          },
          platforms: ["windows", "macos", "linux"],
          inputs: { task: { type: "text", description: "Task" } },
          assets: [{ path: "p.md", kind: "prompt" }],
          routing: [
            {
              id: "work",
              kind,
              session: "s",
              ...(kind === "interactive-agent" ? { entryTurn: true } : {}),
              requires: ["task"],
              prompt: { asset: "p.md" },
            },
          ],
        }),
      );
      const built = wired.bundleManagement.build(folder, { noInstall: false });
      assert.ok(built.ok, JSON.stringify(built));
      const port = wired.projectionPort;
      assert.ok(
        port.submit({
          operationId: "approve",
          operation: "approve-workspace",
          input: { path: workspacePath },
        }).admitted,
      );
      const launch = port.submit({
        operationId: "launch",
        operation: "launch-run",
        input: {
          bundle: { id },
          harness,
          requestedModel: "fake",
          launchInputs: { task: " \t/MODEL\nwork" },
          trustDigest: built.report.digest,
        },
      });
      assert.ok(launch.admitted && launch.runId, JSON.stringify(launch));
      await awaitSettled(port, "launch");
      const run = await awaitRunRest(port, launch.runId);
      assert.equal(
        run.state,
        kind === "interactive-agent"
          ? "blocked"
          : harness === "claude-code"
            ? "failed"
            : "succeeded",
      );
      assert.equal(
        run.timeline.filter((event) => event.event === "turn-started").length,
        harness === "codex" ? 1 : 0,
      );
      if (harness === "codex") {
        const reference = run.sessions?.[0]?.transcriptPage;
        assert.ok(reference);
        const transcript = port.readTranscript(reference);
        assert.ok(transcript.found && transcript.type === "transcript-page");
        assert.equal(transcript.entries[0]?.content, " \t/MODEL\nwork");
      }
    });
  }
}
test("m10-initial-preparation-ownership: headless completion closes both admissions before Run drain", async () => {
  const trace: string[] = [];
  const named = (name: string): HarnessAdapter => {
    const adapter = qualificationAdapter([]);
    return {
      prepare: (options) => adapter.prepare(options),
      close(options) {
        trace.push(`admission:${name}`);
        return adapter.close(options);
      },
    };
  };
  await withClients(
    () => {
      trace.push("command");
      return 0;
    },
    {
      secantHome: makeTempDir("secant-preparation-exit-"),
      launchCwd: process.cwd(),
      process: wiringProcess(),
      harnessAdapter: named("claude"),
      codexHarnessAdapter: named("codex"),
    },
  );
  assert.deepEqual(trace, ["command", "admission:claude", "admission:codex"]);
});

test("m10-audit-file-input-resolution: Command-only wiring supplies input types without preparing a Harness", async (t) => {
  const workspace = realpathSync.native(
    makeTempDir("secant-wire-input-workspace-"),
  );
  mkdirSync(join(workspace, "packages", "web"), { recursive: true });
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "a.ts"), "content");
  writeFileSync(join(workspace, "src", "b.ts"), "content");
  const commands: Parameters<ProcessAdapter["spawnCommand"]>[0][] = [];
  const executionProcess = storedProcess({
    script: {
      commandHandler: (request) => {
        commands.push(request);
        return { kind: "exited", status: 0, text: new Uint8Array() };
      },
    },
  });
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-input-home-"),
    launchCwd: workspace,
    process: executionProcess,
    harnessAdapter: ownPreparations({
      async prepare() {
        throw new Error("Command-only Runs need no Harness");
      },
    }),
    codexHarnessAdapter: ownPreparations({
      async prepare() {
        throw new Error("Command-only Runs need no Harness");
      },
    }),
  });
  t.after(() => wired.close());
  const folder = makeTempDir("secant-wire-input-bundle-");
  const id = "dev.secant.workspace-inputs";
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id,
        version: "1.0.0",
        name: "Workspace inputs",
        description: "Checks Workspace input resolution.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {
        target: { type: "file", description: "target" },
        docs: { type: "file-set", description: "docs" },
      },
      assets: [],
      routing: [
        {
          id: "read",
          kind: "command",
          requires: ["target", "docs"],
          command: {
            executable: "reader",
            arguments: [{ artifact: "target" }, { artifact: "docs" }],
            env: { TARGET: { artifact: "target" }, DOCS: { artifact: "docs" } },
            workingDirectory: "packages/web",
          },
        },
      ],
    }),
  );
  assert.ok(wired.bundleManagement.build(folder, { noInstall: false }).ok);
  const entry = wired.catalog.listEntries().find((entry) => entry.id === id);
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "approve-input-workspace",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const admission = wired.projectionPort.submit({
    operationId: "launch-inputs",
    operation: "launch-run",
    input: {
      bundle: { id },
      trustDigest: entry.digest,
      launchInputs: { target: "src/a.ts", docs: "src/a.ts\nsrc/b.ts" },
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  await settled(wired, "launch-inputs");
  const expectedFile = join(workspace, "src", "a.ts");
  const expectedSet = `${expectedFile}\n${join(workspace, "src", "b.ts")}`;
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0]?.args, [expectedFile, expectedSet]);
  assert.equal(commands[0]?.env?.TARGET, expectedFile);
  assert.equal(commands[0]?.env?.DOCS, expectedSet);
  assert.equal(commands[0]?.cwd, join(workspace, "packages", "web"));
});

for (const failure of ["missing", "json", "schema"] as const) {
  test(`m10-audit-token-ripgrep-listing: ${failure} helper manifest remains a search failure with its original cause`, async (t) => {
    const assets = makeTempDir("secant-rg-assets-");
    if (failure !== "missing")
      writeFileSync(
        join(assets, "manifest.json"),
        failure === "json"
          ? "{"
          : JSON.stringify({ version: null, targets: {} }),
      );
    const wired = wireApplication({
      secantHome: makeTempDir("secant-rg-state-"),
      launchCwd: makeTempDir("secant-rg-ws-"),
      process: storedProcess({ script: {} }),
      ripgrepAssetRoot: assets,
    });
    t.after(() => wired.close());
    const run = wired.runGroup.createRun({
      operationId: "manifest",
      bundleSnapshotDigest: "sha256:paths",
      launch: {},
      at: new Date(),
    });
    const result = await wired.projectionPort.searchWorkspacePaths({
      runId: run.runId,
      query: "",
    });
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert.ok(result.cause instanceof Error);
      if (failure === "missing")
        assert.equal("code" in result.cause && result.cause.code, "ENOENT");
      else
        assert.equal(
          result.cause.name,
          failure === "json" ? "SyntaxError" : "ZodError",
        );
    }
  });
}
